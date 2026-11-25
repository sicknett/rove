import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The id map is module state: each test loads a fresh copy over its own stored document and
// its own answers from TMDB and PublicMetaDB.
let storedMap: unknown = null;
const written: unknown[] = [];
const tmdbApi = {
  hasTmdb: vi.fn(() => true),
  externalIds: vi.fn(async (_kind: string, _id: number): Promise<{ imdb_id?: string | null } | null> => null),
  findByImdb: vi.fn(async (_imdb: string): Promise<{ id: number; kind: 'movie' | 'tv' } | null> => null),
};
const pmdbApi = {
  imdbFor: vi.fn(async (): Promise<string | null> => null),
  lookupTmdb: vi.fn(async (): Promise<{ id: number; mediaType?: 'movie' | 'tv' } | null> => null),
};

vi.mock('../lib/native', () => ({
  docs: { read: vi.fn(async () => storedMap), write: vi.fn(async () => undefined) },
  debouncedWriter: () => ({ save: (v: unknown) => void written.push(JSON.parse(JSON.stringify(v))), flush: async () => undefined }),
}));
vi.mock('../meta/tmdb', () => tmdbApi);
vi.mock('./pmdb', () => ({ pmdb: pmdbApi }));

async function fresh() {
  vi.resetModules();
  return import('./idmap');
}

beforeEach(() => {
  storedMap = null;
  written.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
  for (const fn of [...Object.values(tmdbApi), ...Object.values(pmdbApi)]) fn.mockClear();
  tmdbApi.hasTmdb.mockReturnValue(true);
  tmdbApi.externalIds.mockResolvedValue(null);
  tmdbApi.findByImdb.mockResolvedValue(null);
  pmdbApi.imdbFor.mockResolvedValue(null);
  pmdbApi.lookupTmdb.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('metaIdFor', () => {
  it('does not remember a lookup that failed', async () => {
    const map = await fresh();
    tmdbApi.externalIds.mockRejectedValueOnce(new Error('offline'));
    expect(await map.metaIdFor(693, 'tv')).toBe('tmdb:693');
    // Nothing negative went to disk, and the title is still unknown rather than "has none".
    expect(written).toEqual([]);
    expect(map.canonicalNow('tmdb:693', 'series')).toBe('tmdb:693');
    // Not asked again straight away (a pull looks up hundreds of titles)...
    expect(await map.metaIdFor(693, 'tv')).toBe('tmdb:693');
    expect(tmdbApi.externalIds).toHaveBeenCalledTimes(1);
    // ...but a few minutes later it is, and the answer sticks.
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    tmdbApi.externalIds.mockResolvedValueOnce({ imdb_id: 'tt0903747' });
    expect(await map.metaIdFor(693, 'tv')).toBe('tt0903747');
    expect(map.canonicalNow('tmdb:693', 'series')).toBe('tt0903747');
    expect(written.at(-1)).toEqual({ toImdb: { 'tv:693': 'tt0903747' }, toTmdb: { tt0903747: { id: 693, kind: 'tv' } } });
  });

  it('asks again later about a title neither service knows', async () => {
    const map = await fresh();
    tmdbApi.externalIds.mockResolvedValue({ imdb_id: null });
    expect(await map.metaIdFor(5, 'movie', 'key')).toBe('tmdb:5');
    expect(pmdbApi.imdbFor).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    expect(await map.metaIdFor(5, 'movie', 'key')).toBe('tmdb:5');
    expect(pmdbApi.imdbFor).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6 * 3600 * 1000);
    pmdbApi.imdbFor.mockResolvedValueOnce('tt0000005');
    expect(await map.metaIdFor(5, 'movie', 'key')).toBe('tt0000005');
    expect(written.some((d) => JSON.stringify(d).includes('null'))).toBe(false);
  });

  it('treats "known to have none" from an older file as unknown', async () => {
    storedMap = { toImdb: { 'tv:1': null, 'tv:2': 'tt0000002' }, toTmdb: { tt0000009: null } };
    const map = await fresh();
    await map.loadIdMap();
    expect(map.canonicalNow('tmdb:2', 'series')).toBe('tt0000002');
    expect(map.canonicalNow('tmdb:1', 'series')).toBe('tmdb:1');
    tmdbApi.externalIds.mockResolvedValueOnce({ imdb_id: 'tt0000001' });
    expect(await map.metaIdFor(1, 'tv')).toBe('tt0000001');
    tmdbApi.findByImdb.mockResolvedValueOnce({ id: 9, kind: 'movie' });
    expect(await map.tmdbFor('tt0000009', 'movie')).toEqual({ id: 9, kind: 'movie' });
  });

  it('keeps movie and show numbers apart', async () => {
    const map = await fresh();
    tmdbApi.externalIds.mockImplementation(async (kind: string) => ({ imdb_id: kind === 'movie' ? 'tt0000111' : 'tt0000222' }));
    expect(await map.canonicalId('tmdb:693', 'movie')).toBe('tt0000111');
    expect(await map.canonicalId('tmdb:693', 'series')).toBe('tt0000222');
    expect(map.canonicalNow('tmdb:693', 'movie')).toBe('tt0000111');
    expect(map.canonicalNow('tmdb:693', 'series')).toBe('tt0000222');
    // Ids that are not `tmdb:` titles are their own history id.
    expect(await map.canonicalId('tt0000333', 'movie')).toBe('tt0000333');
    expect(map.canonicalNow('srv:a:b', 'movie')).toBe('srv:a:b');
  });
});

describe('tmdbFor', () => {
  it('learns both directions from one answer and tells listeners', async () => {
    const map = await fresh();
    const heard = vi.fn();
    map.onIdMapChange(heard);
    tmdbApi.findByImdb.mockResolvedValueOnce({ id: 1396, kind: 'tv' });
    expect(await map.tmdbFor('tt0903747:1:2', 'series')).toEqual({ id: 1396, kind: 'tv' });
    // History kept under `tmdb:1396` can now move to the IMDb id.
    expect(map.canonicalNow('tmdb:1396', 'series')).toBe('tt0903747');
    expect(heard).toHaveBeenCalled();
    expect(await map.tmdbFor('tt0903747', 'series')).toEqual({ id: 1396, kind: 'tv' });
    expect(tmdbApi.findByImdb).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failure as "no TMDB id"', async () => {
    const map = await fresh();
    tmdbApi.findByImdb.mockRejectedValueOnce(new Error('offline'));
    expect(await map.tmdbFor('tt0000007', 'movie')).toBeNull();
    expect(written).toEqual([]);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    tmdbApi.findByImdb.mockResolvedValueOnce({ id: 7, kind: 'movie' });
    expect(await map.tmdbFor('tt0000007', 'movie')).toEqual({ id: 7, kind: 'movie' });
  });
});

describe('alternateId', () => {
  it('gives the same video under the other id family', async () => {
    const map = await fresh();
    map.rememberMapping('tt0903747', { id: 1396, kind: 'tv' });
    expect(await map.alternateId('tmdb:1396:3:15', 'series')).toBe('tt0903747:3:15');
    expect(await map.alternateId('tt0903747:3:15', 'series')).toBe('tmdb:1396:3:15');
    expect(await map.alternateId('tt0903747', 'series')).toBe('tmdb:1396');
    expect(await map.alternateId('kitsu:1:5', 'series')).toBeNull();
    tmdbApi.externalIds.mockResolvedValue({ imdb_id: null });
    expect(await map.alternateId('tmdb:2', 'movie')).toBeNull();
  });
});

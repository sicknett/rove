// The rows end to end, against a made-up TMDB: a history goes in, the board comes out, and
// every request is counted.

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, unknown>();

vi.mock('../lib/native', () => ({
  NetworkError: class extends Error {},
  nativeFetch: vi.fn(async () => {
    throw new Error('no network in tests');
  }),
  docs: {
    read: vi.fn(async (name: string) => structuredClone(stored.get(name) ?? null)),
    write: vi.fn(async (name: string, value: unknown) => void stored.set(name, structuredClone(value))),
    remove: vi.fn(async (name: string) => void stored.delete(name)),
  },
  secrets: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
}));
vi.mock('../ui/toast', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../meta/tmdb', () => ({ tmdb: vi.fn(), hasTmdb: () => true, findByImdb: vi.fn(), externalIds: vi.fn() }));
vi.mock('../tracking/idmap', () => ({
  canonicalNow: (id: string) => id,
  onIdMapChange: () => () => undefined,
  rememberMapping: vi.fn(),
  // The id map knows nothing here, so every lookup goes to TMDB's /find (findByImdb).
  tmdbFor: vi.fn(async () => null),
  loadIdMap: async () => undefined,
}));

const { tmdb, findByImdb } = await import('../meta/tmdb');
const { useHistory } = await import('../state/history');
const { useHomeLayout } = await import('../state/homeLayout');
const { useProfiles } = await import('../state/profiles');
const { flushCache } = await import('./cache');
const { resetRecs, TASTE_TTL, useRecs } = await import('./engine');
const { candidateKey } = await import('./rank');
const { recipeFor, SMART, SMART_KEYS } = await import('./recipes');
type WatchedEntry = import('../state/history').WatchedEntry;
type LibraryItem = import('../state/history').LibraryItem;
type BoardRow = import('./engine').BoardRow;

const ask = vi.mocked(tmdb);
const find = vi.mocked(findByImdb);

const DAY = 24 * 3600 * 1000;
const NOW = new Date(2026, 10, 25, 12).getTime();
/** The rows the engine works out (the watchlist row reads the watchlist itself). */
const ROWS = SMART_KEYS.filter((k) => recipeFor(k));

// ---------- A made-up TMDB ----------

type Raw = Record<string, unknown>;
const raw = (id: number, kind: 'movie' | 'tv'): Raw => ({ id, media_type: kind, [kind === 'movie' ? 'title' : 'name']: `${kind} ${id}`, poster_path: `/${id}.jpg`, vote_average: 7.5, vote_count: 800, popularity: 40, genre_ids: [18] });
const list = (kind: 'movie' | 'tv', from: number, count = 20) => Array.from({ length: count }, (_, i) => raw(from + i, kind));
const SEED_GENRES: Record<string, { id: number; name: string }[]> = { movie: [{ id: 878, name: 'Science Fiction' }], tv: [{ id: 80, name: 'Crime' }] };

/** Requests that get no answer, and discover queries that find next to nothing. */
let fails: (path: string) => boolean = () => false;
let thin: (params: Record<string, string>) => boolean = () => false;
/** Every discover query has titles of its own, so rows only overlap where the test makes them. */
const discoverBase = new Map<string, number>();

async function answer(path: string, params: Record<string, string> = {}): Promise<unknown> {
  if (fails(path)) throw new Error('HTTP 503');
  let m: RegExpExecArray | null;
  if ((m = /^\/(movie|tv)\/(\d+)$/.exec(path))) {
    const kind = m[1] as 'movie' | 'tv';
    const id = Number(m[2]);
    // Seed 11 recommends titles 1100–1119 and is similar to 1150–1169.
    return { id, [kind === 'movie' ? 'title' : 'name']: `Seed ${id}`, original_language: 'en', genres: SEED_GENRES[kind], recommendations: { results: list(kind, id * 100) }, similar: { results: list(kind, id * 100 + 50) } };
  }
  if ((m = /^\/trending\/(all|movie|tv)\/week$/.exec(path))) {
    const page = Number(params.page ?? 1);
    // The week's films are 9000…, its shows 9500…; "all" has ten of each a page.
    if (m[1] === 'all') return { results: [...list('movie', 9000 + (page - 1) * 10, 10), ...list('tv', 9500 + (page - 1) * 10, 10)] };
    return { results: list(m[1] as 'movie' | 'tv', (m[1] === 'movie' ? 9000 : 9500) + (page - 1) * 20) };
  }
  if ((m = /^\/discover\/(movie|tv)$/.exec(path))) {
    const { page, ...rest } = params;
    const name = m[1] + JSON.stringify(Object.entries(rest).sort());
    if (!discoverBase.has(name)) discoverBase.set(name, 20000 + discoverBase.size * 1000);
    return { results: list(m[1] as 'movie' | 'tv', discoverBase.get(name)! + (Number(page ?? 1) - 1) * 20, thin(params) ? 3 : 20) };
  }
  throw new Error(`unexpected request ${path}`);
}

const asked = () => ask.mock.calls.map((c) => c[0] as string);
const askedFor = (prefix: string) => asked().filter((p) => p.startsWith(prefix)).length;

// ---------- A history ----------

const film = (id: string, daysAgo: number, tmdbId?: number): WatchedEntry => ({ key: id, metaId: id, type: 'movie', at: NOW - daysAgo * DAY, tmdbId });
const episodes = (id: string, count: number, daysAgo: number, tmdbId?: number): WatchedEntry[] =>
  Array.from({ length: count }, (_, i) => ({ key: `${id}:1:${i + 1}`, metaId: id, type: 'series' as const, season: 1, episode: i + 1, at: NOW - daysAgo * DAY, tmdbId }));

function setHistory(watched: WatchedEntry[], library: LibraryItem[] = []) {
  useHistory.setState({ loaded: true, progress: {}, watched: Object.fromEntries(watched.map((w) => [w.key, w])), library: Object.fromEntries(library.map((l) => [l.metaId, l])), cards: {} });
}

/**
 * Three films and two shows watched lately (the seeds); a film watched long ago that the first
 * seed recommends (movie 1101); another one, known to history by its IMDb id only (movie 1102);
 * and a show on the watchlist that a seed recommends (tv 2101).
 */
const REGULAR: WatchedEntry[] = [film('tt11', 1, 11), film('tt12', 3, 12), film('tt13', 5), ...episodes('tt21', 8, 2, 21), ...episodes('tt22', 5, 10, 22), film('tt91', 400, 1101), film('tt92', 500)];
const WATCHLIST: LibraryItem[] = [{ metaId: 'tmdb:2101', type: 'series', addedAt: NOW - 900 * DAY }];

const board = () => useRecs.getState().board;
const shown = (key: string) => board()[key]?.items.map(candidateKey) ?? [];
const statusOf = (key: string) => board()[key]?.status;
const settled = (rows = ROWS) => vi.waitFor(() => expect(rows.filter((k) => !board()[k] || board()[k].status === 'pending')).toEqual([]));

/** Opens Home: the profile's saved recommendations are read, every row comes near the screen. */
async function openHome() {
  useRecs.getState().bind(new QueryClient());
  await useRecs.getState().load('p1');
  for (const key of ROWS) useRecs.getState().setNear(key, true);
  useRecs.getState().visit();
  await settled();
}

/** ROVE is closed and started again: what is in memory is gone, what was saved is not. */
function restart() {
  flushCache();
  resetRecs();
  ask.mockClear();
  find.mockClear();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  stored.clear();
  discoverBase.clear();
  fails = () => false;
  thin = () => false;
  resetRecs();
  ask.mockReset();
  ask.mockImplementation(answer as typeof tmdb);
  find.mockReset();
  find.mockImplementation(async (imdb: string) => (imdb === 'tt13' ? { id: 13, kind: 'movie' as const } : imdb === 'tt92' ? { id: 1102, kind: 'movie' as const } : null));
  useProfiles.setState({ loaded: true, activeId: 'p1', profiles: [{ id: 'p1', name: 'Me', color: '#fff', createdAt: 0 }] });
  useHomeLayout.setState({ loaded: true, items: SMART_KEYS.map((key, order) => ({ key, enabled: true, order })) });
  setHistory(REGULAR, WATCHLIST);
});

afterEach(() => {
  flushCache();
  vi.useRealTimers();
});

describe('a Home visit', () => {
  it('fills every row, with no title in two rows and nothing the profile has seen', async () => {
    await openHome();
    expect(ROWS.map((k) => `${k}: ${statusOf(k)}`)).toEqual(ROWS.map((k) => `${k}: ready`));

    const all = ROWS.flatMap(shown);
    expect(new Set(all).size).toBe(all.length);

    // Watched (by TMDB number, and by the IMDb id that was looked up), on the watchlist, or a seed itself.
    for (const seen of ['movie:1101', 'movie:1102', 'tv:2101', 'movie:11', 'movie:13', 'tv:21']) expect(all).not.toContain(seen);
    // Those titles were there to recommend: their neighbours are shown.
    expect(all).toContain('movie:1100');
    expect(all).toContain('movie:1103');

    // The charts are the charts; Trending has what they do not show.
    expect(shown(SMART.top10Movies)).toEqual(Array.from({ length: 10 }, (_, i) => `movie:${9000 + i}`));
    expect(shown(SMART.top10Shows)).toEqual(Array.from({ length: 10 }, (_, i) => `tv:${9500 + i}`));
    expect(shown(SMART.trending)).toHaveLength(20);
    expect(shown(SMART.trending).every((k) => Number(k.split(':')[1]) % 500 >= 10)).toBe(true);

    for (const key of ROWS) expect(shown(key).length).toBeLessThanOrEqual(recipeFor(key)!.limit);
  });

  it('builds the taste profile from the strongest titles and saves it', async () => {
    await openHome();
    const { taste, because, tmdbOf } = useRecs.getState().doc;
    // Films and shows apart, strongest first; the long-ago films are not seeds.
    expect(taste!.seeds.map((s) => `${s.kind}:${s.id}`)).toEqual(['movie:11', 'movie:12', 'movie:13', 'tv:21', 'tv:22']);
    expect(taste!.seeds.map((s) => s.name)).toEqual(['Seed 11', 'Seed 12', 'Seed 13', 'Seed 21', 'Seed 22']);
    expect(taste!.genres.map((g) => `${g.kind}:${g.name}`).sort()).toEqual(['movie:Science Fiction', 'tv:Crime']);
    expect(taste!.languages).toEqual(['en']);
    // The newest title first, and a show beside the film.
    expect(because!.picks[0]).toMatchObject({ kind: 'movie', id: 11 });
    expect(because!.picks[1].kind).toBe('tv');
    expect(because!.picks).toHaveLength(3);
    // History titles without a TMDB number were looked up once, for good.
    expect(tmdbOf).toEqual({ tt13: 'movie:13', tt92: 'movie:1102' });
    expect(stored.get('recs-p1')).toMatchObject({ taste: { fingerprint: taste!.fingerprint }, because: { picks: because!.picks } });
  });

  it('asks TMDB a bounded number of times cold, and not at all when it comes back', async () => {
    await openHome();
    // One request per seed (five here, twelve at most), four for Trending and the two charts,
    // two for New releases, two pages for each genre row, two for Hidden gems.
    expect(askedFor('/movie/') + askedFor('/tv/')).toBe(5);
    expect(askedFor('/trending/')).toBe(4);
    expect(askedFor('/discover/')).toBe(8);
    expect(ask).toHaveBeenCalledTimes(17);
    const before = ROWS.map(shown);

    // Looking at Home again later in the same session.
    ask.mockClear();
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    for (const key of ROWS) useRecs.getState().setNear(key, false);
    for (const key of ROWS) useRecs.getState().setNear(key, true);
    useRecs.getState().visit();
    await settled();
    expect(ask).not.toHaveBeenCalled();
    expect(ROWS.map(shown)).toEqual(before);

    // Starting ROVE again an hour later: the saved profile and the saved answers are still good.
    restart();
    vi.setSystemTime(NOW + 3600 * 1000);
    await openHome();
    expect(ask).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(ROWS.map(shown)).toEqual(before);
  });

  it('asks again only for what has gone stale', async () => {
    await openHome();
    restart();
    vi.setSystemTime(NOW + TASTE_TTL + 3600 * 1000);
    await openHome();
    // Seven hours on: trending is asked for again; seeds (a day) and discover (half a day) are not.
    expect(asked().every((p) => p.startsWith('/trending/'))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it('loads only the rows near the screen, and the rows above them', async () => {
    useRecs.getState().bind(new QueryClient());
    await useRecs.getState().load('p1');
    useRecs.getState().setNear(SMART.topPicks, true);
    useRecs.getState().visit();
    await settled([SMART.topPicks]);
    expect(askedFor('/discover/')).toBe(0);
    // The charts are asked for with the first row: what they show is kept out of it.
    expect(askedFor('/trending/')).toBe(2);
    expect(statusOf(SMART.hiddenGems)).toBe('pending');

    // New releases comes near: Trending and the "Because" rows above it choose first, so they load too.
    useRecs.getState().setNear(SMART.newReleases, true);
    await settled([SMART.trending, SMART.because2, SMART.newReleases]);
    expect(askedFor('/trending/')).toBe(4);
    expect(askedFor('/discover/')).toBe(2);
    expect(statusOf(SMART.genre1)).toBe('pending');
  });
});

describe('a new profile', () => {
  it('has the general rows and none of the personal ones', async () => {
    setHistory([]);
    await openHome();
    const by = (status: BoardRow['status']) => ROWS.filter((k) => statusOf(k) === status);
    expect(by('ready')).toEqual([SMART.trending, SMART.top10Movies, SMART.newReleases, SMART.top10Shows]);
    expect(by('none')).toEqual([SMART.topPicks, SMART.because1, SMART.because2, SMART.genre1, SMART.because3, SMART.genre2, SMART.hiddenGems]);
    expect(ask).toHaveBeenCalledTimes(6);
    const discover = ask.mock.calls.filter((c) => (c[0] as string).startsWith('/discover/')).map((c) => c[1] as Record<string, string>);
    expect(discover.some((p) => 'with_genres' in p || 'with_original_language' in p)).toBe(false);
    expect(useRecs.getState().doc.taste).toBeNull();
  });
});

describe('rows that come up short or fail', () => {
  it('shows no row for a recipe that finds fewer than eight titles', async () => {
    thin = (params) => params.sort_by === 'vote_count.desc';
    await openHome();
    // Three films and three shows: six gems are not a row.
    expect(statusOf(SMART.hiddenGems)).toBe('none');
    expect(statusOf(SMART.genre1)).toBe('ready');
  });

  it('says so when TMDB does not answer, holds nothing else up, and loads on "Try again"', async () => {
    fails = (path) => path === '/trending/all/week';
    await openHome();
    expect(statusOf(SMART.trending)).toBe('error');
    expect(statusOf(SMART.newReleases)).toBe('ready');
    expect(statusOf(SMART.top10Movies)).toBe('ready');

    fails = () => false;
    useRecs.getState().retry(SMART.trending);
    await vi.waitFor(() => expect(statusOf(SMART.trending)).toBe('ready'));
    expect(shown(SMART.trending)).toHaveLength(20);
  });

  it('keeps the personal rows away, without a spinner that never ends, when no seed can be read', async () => {
    fails = (path) => /^\/(movie|tv)\//.test(path);
    await openHome();
    expect(useRecs.getState().tasteStatus).toBe('failed');
    expect(statusOf(SMART.topPicks)).toBe('none');
    expect(statusOf(SMART.trending)).toBe('ready');
    expect(useRecs.getState().doc.taste).toBeNull();
  });
});

describe('Not interested', () => {
  it('takes a title out of every row for good, and Undo puts it back', async () => {
    await openHome();
    const row = SMART.because1;
    const before = shown(row);
    const gone = board()[row].items[0];
    useRecs.getState().hide(gone);
    expect(ROWS.flatMap(shown)).not.toContain(candidateKey(gone));
    // The row is still full: its next best moved up.
    expect(shown(row)).toHaveLength(20);
    expect(shown(row).slice(0, 19)).toEqual(before.slice(1));

    // Still out after a restart.
    restart();
    await openHome();
    expect(ROWS.flatMap(shown)).not.toContain(candidateKey(gone));
    expect(useRecs.getState().doc.hidden[candidateKey(gone)]).toMatchObject({ name: gone.name });

    useRecs.getState().unhide(candidateKey(gone));
    expect(shown(row)).toEqual(before);
    expect((stored.get('recs-p1') as { hidden: object }).hidden).toEqual({});
  });
});

describe('"Because you watched"', () => {
  const picks = () => useRecs.getState().doc.because!.picks.map((p) => `${p.kind}:${p.id}`);

  it('keeps its titles all day, and chooses again the next', async () => {
    await openHome();
    const today = picks();
    expect(today[0]).toBe('movie:11');

    // A film is finished in the afternoon: the profile is worked out again, the rows stay.
    setHistory([...REGULAR, film('tt14', 0, 14)], WATCHLIST);
    vi.setSystemTime(NOW + 4 * 3600 * 1000);
    useRecs.getState().visit();
    await vi.waitFor(() => expect(useRecs.getState().doc.taste!.seeds.some((s) => s.id === 14)).toBe(true));
    expect(picks()).toEqual(today);

    // Tomorrow it has the first row.
    vi.setSystemTime(NOW + DAY);
    useRecs.getState().visit();
    await vi.waitFor(() => expect(picks()[0]).toBe('movie:14'));
    expect(picks()).toHaveLength(3);
  });
});

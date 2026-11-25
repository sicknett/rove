import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each test sets the answers by URL; requests are recorded for checking bodies.
const routes: [RegExp, (req: { url: string; method?: string; body?: string }) => { status?: number; body: unknown }][] = [];
const calls: { url: string; method?: string; body?: unknown }[] = [];

vi.mock('../../lib/native', () => ({
  NetworkError: class extends Error {},
  // The id map (used by the PublicMetaDB adapter) keeps its document here.
  docs: { read: vi.fn(async () => null), write: vi.fn(async () => undefined) },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
  nativeFetch: vi.fn(async (req: { url: string; method?: string; body?: string }) => {
    calls.push({ url: req.url, method: req.method, body: req.body ? JSON.parse(req.body) : undefined });
    const hit = routes.find(([re]) => re.test(req.url));
    const r = hit ? hit[1](req) : { status: 404, body: {} };
    return { status: r.status ?? 200, url: req.url, headers: {}, body: JSON.stringify(r.body) };
  }),
}));

vi.stubEnv('VITE_TRAKT_CLIENT_ID', 'trakt-id');
vi.stubEnv('VITE_SIMKL_CLIENT_ID', 'simkl-id');

const { traktAdapter } = await import('./trakt');
const { simklAdapter } = await import('./simkl');
const { mdblistAdapter } = await import('./mdblist');
const { pmdbAdapter } = await import('./pmdb');

beforeEach(() => {
  routes.length = 0;
  calls.length = 0;
});

const history = { progress: {}, watched: {} };

describe('Trakt', () => {
  const account = { provider: 'trakt' as const, accessToken: 'tok' };

  it('maps progress, watched and watchlist, and drops plays from before a rewatch', async () => {
    routes.push(
      [/playback\/movies/, () => ({ body: [{ id: 7, progress: 50, paused_at: '2026-01-02T00:00:00Z', type: 'movie', movie: { title: 'M', runtime: 100, ids: { imdb: 'tt1', tmdb: 11 } } }] })],
      [/playback\/episodes/, () => ({ body: [{ id: 8, progress: 25, paused_at: '2026-01-03T00:00:00Z', type: 'episode', episode: { season: 1, number: 2, ids: {} }, show: { title: 'S', ids: { imdb: 'tt2' } } }] })],
      [/watched\/movies/, () => ({ body: [{ last_watched_at: '2025-05-01T00:00:00Z', movie: { ids: { imdb: 'tt3' } } }] })],
      [
        /watched\/shows/,
        () => ({
          body: [
            {
              reset_at: '2025-06-01T00:00:00Z',
              show: { ids: { imdb: 'tt2' } },
              seasons: [{ number: 1, episodes: [{ number: 1, last_watched_at: '2025-07-01T00:00:00Z' }, { number: 2, last_watched_at: '2025-01-01T00:00:00Z' }] }],
            },
          ],
        }),
      ],
      [/watchlist\/movies/, () => ({ body: [{ listed_at: '2025-01-01T00:00:00Z', movie: { title: 'W', year: 2020, ids: { tmdb: 99 } } }] })],
      [/watchlist\/shows/, () => ({ body: [] })],
    );
    const r = await traktAdapter.pull(account);
    const movie = r.progress.find((p) => p.metaId === 'tt1')!;
    expect(movie.durationS).toBe(6000);
    expect(movie.positionS).toBe(3000);
    expect(movie.estimated).toBe(false);
    const ep = r.progress.find((p) => p.metaId === 'tt2')!;
    expect(ep.key).toBe('tt2:1:2');
    expect(ep.estimated).toBe(true);
    expect(r.watched.map((w) => w.key).sort()).toEqual(['tt2:1:1', 'tt3']);
    expect(r.watchlist).toEqual([expect.objectContaining({ metaId: 'tmdb:99', type: 'movie', name: 'W', year: '2020' })]);
  });

  it('sends a resume point as a pause scrobble, never past the watched threshold', async () => {
    routes.push([/scrobble\/pause/, () => ({ status: 201, body: {} })]);
    const h = { progress: { 'tt1:1:2': { key: 'tt1:1:2', metaId: 'tt1', type: 'series' as const, season: 1, episode: 2, positionS: 2650, durationS: 2700, updatedAt: 1 } }, watched: {} };
    await expect(traktAdapter.push(account, { op: 'resume', key: 'tt1:1:2' } as never, h)).resolves.toBe('synced');
    const body = calls.find((c) => c.url.includes('scrobble'))!.body as { progress: number; show: unknown; episode: unknown };
    expect(body.progress).toBe(79);
    expect(body.show).toEqual({ ids: { imdb: 'tt1' } });
    expect(body.episode).toEqual({ season: 1, number: 2 });
  });

  it('skips titles it cannot identify', async () => {
    const h = { progress: { 'srv:a:b': { key: 'srv:a:b', metaId: 'srv:a:b', type: 'movie' as const, positionS: 10, durationS: 100, updatedAt: 1 } }, watched: {} };
    await expect(traktAdapter.push(account, { op: 'resume', key: 'srv:a:b' } as never, h)).resolves.toBe('skip');
    expect(calls).toHaveLength(0);
  });
});

describe('a bad answer is not an empty history', () => {
  const account = { provider: 'trakt' as const, accessToken: 'tok' };
  const ok = (): [RegExp, () => { body: unknown }][] => [
    [/playback\/movies/, () => ({ body: [] })],
    [/playback\/episodes/, () => ({ body: [] })],
    [/watched\/movies/, () => ({ body: [] })],
    [/watched\/shows/, () => ({ body: [] })],
    [/watchlist\/movies/, () => ({ body: [] })],
    [/watchlist\/shows/, () => ({ body: [] })],
  ];

  it('fails the pull when a list comes back as something else', async () => {
    // A gateway's HTML page with a 200, and an error object where a list belongs.
    routes.push([/watched\/shows/, () => ({ body: '<html>Service unavailable</html>' })], ...ok());
    await expect(traktAdapter.pull(account)).rejects.toMatchObject({ kind: 'retry' });
    routes.length = 0;
    routes.push([/watched\/movies/, () => ({ body: { error: 'try later' } })], ...ok());
    await expect(traktAdapter.pull(account)).rejects.toMatchObject({ kind: 'retry' });
  });

  it('syncs history without the watchlist when only that fails, and says so', async () => {
    routes.push([/watchlist\/shows/, () => ({ status: 404, body: {} })], ...ok());
    const r = await traktAdapter.pull(account);
    expect(r.watchlist).toBeUndefined();
    expect(r.incomplete).toEqual(['watchlist']);
    routes.length = 0;
    routes.push(...ok());
    const whole = await traktAdapter.pull(account);
    expect(whole.watchlist).toEqual([]);
    expect(whole.incomplete).toEqual([]);
  });
});

describe('PublicMetaDB', () => {
  const account = { provider: 'pmdb' as const, apiKey: 'pm-key' };
  const resume = { id: 'r1', tmdb_id: 693, media_type: 'tv', season: 3, episode: 15, position_ms: 600000, runtime_ms: 3000000, updated: '2026-01-01T00:00:00Z' };
  const seen = (season: number, episode: number) => ({ tmdb_id: 693, media_type: 'tv', season, episode, watched_at: '2025-12-01T00:00:00Z' });
  const mappings: [RegExp, () => { status?: number; body: unknown }][] = [
    [/mappings\?tmdb_id=693/, () => ({ body: { imdb_id: 'tt0903747' } })],
    [/mappings/, () => ({ status: 404, body: {} })],
  ];

  it('reads every page, under IMDb ids where they map, and keeps the TMDB id', async () => {
    routes.push(
      ...mappings,
      [/\/resume\?/, () => ({ body: { items: [resume], total: 1, totalPages: 1 } })],
      [/\/watched\?page=1/, () => ({ body: { items: [seen(3, 13), seen(3, 14)], total: 3, perPage: 2 } })],
      [/\/watched\?page=2/, () => ({ body: { items: [seen(3, 12)], total: 3, perPage: 2 } })],
      [/\/lists\/L\/items/, () => ({ body: { items: [{ tmdb_id: 5, media_type: 'movie', title: 'Film' }] } })],
      [/\/lists\?/, () => ({ body: { lists: [{ id: 'L', type: 'watchlist' }] } })],
    );
    const r = await pmdbAdapter.pull(account);
    expect(r.progress).toEqual([expect.objectContaining({ key: 'tt0903747:3:15', metaId: 'tt0903747', tmdbId: 693, positionS: 600, durationS: 3000 })]);
    expect(r.watched.map((w) => w.key).sort()).toEqual(['tt0903747:3:12', 'tt0903747:3:13', 'tt0903747:3:14']);
    // No IMDb id for this one (yet): it stays under its TMDB id, with the type it has there.
    expect(r.watchlist).toEqual([expect.objectContaining({ metaId: 'tmdb:5', type: 'movie', tmdbId: 5 })]);
    expect(r.incomplete).toEqual([]);
  });

  it('fails the pull on a body that is not a page, instead of reading it as empty', async () => {
    routes.push(...mappings, [/\/resume\?/, () => ({ body: { items: [resume] } })], [/\/watched\?/, () => ({ body: '<html>Bad gateway</html>' })]);
    await expect(pmdbAdapter.pull(account)).rejects.toMatchObject({ kind: 'retry' });
  });

  it('marks a list incomplete when fewer items arrive than it counts, or the watchlist cannot be read', async () => {
    routes.push(
      ...mappings,
      [/\/resume\?/, () => ({ body: { items: [resume], total: 1 } })],
      [/\/watched\?page=1/, () => ({ body: { items: [seen(3, 13)], total: 40, totalPages: 1 } })],
      [/\/lists\?/, () => ({ status: 404, body: {} })],
    );
    const r = await pmdbAdapter.pull(account);
    expect(r.incomplete).toEqual(['watched', 'watchlist']);
    expect(r.watchlist).toBeUndefined();
  });

  it('keeps a change whose title has no TMDB id yet, and skips what can never have one', async () => {
    routes.push([/mappings/, () => ({ status: 404, body: {} })]);
    const entry = (metaId: string) => ({ key: metaId, metaId, type: 'movie' as const, positionS: 10, durationS: 100, updatedAt: 1 });
    const h = { progress: { tt0000001: entry('tt0000001'), 'srv:a:b': entry('srv:a:b') }, watched: {} };
    await expect(pmdbAdapter.push(account, { op: 'resume', key: 'tt0000001', at: 1 }, h)).resolves.toBe('unmapped');
    await expect(pmdbAdapter.push(account, { op: 'resume', key: 'srv:a:b', at: 1 }, h)).resolves.toBe('skip');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('Simkl', () => {
  const account = { provider: 'simkl' as const, accessToken: 'tok' };

  it('reads completed titles, watched episodes and plan-to-watch', async () => {
    routes.push(
      [
        /all-items/,
        () => ({
          body: {
            movies: [
              { status: 'completed', last_watched_at: '2025-01-01T00:00:00Z', movie: { ids: { imdb: 'tt5' } } },
              { status: 'plantowatch', movie: { title: 'Later', ids: { tmdb: 42 } } },
            ],
            shows: [{ status: 'watching', show: { ids: { imdb: 'tt6' } }, seasons: [{ number: 2, episodes: [{ number: 3, watched_at: '2025-02-01T00:00:00Z' }] }] }],
          },
        }),
      ],
      [/sync\/playback/, () => ({ body: [] })],
    );
    const r = await simklAdapter.pull(account);
    expect(r.watched.map((w) => w.key).sort()).toEqual(['tt5', 'tt6:2:3']);
    expect(r.watchlist).toEqual([expect.objectContaining({ metaId: 'tmdb:42', type: 'movie' })]);
    // The app id rides on every request.
    expect(calls[0].url).toContain('client_id=simkl-id');
  });
});

describe('MDBList', () => {
  const account = { provider: 'mdblist' as const, apiKey: 'k' };

  it('pages through watched history and nests episodes in the show', async () => {
    let page = 0;
    routes.push(
      [
        /sync\/watched\?/,
        () =>
          page++ === 0
            ? { body: { movies: [{ last_watched_at: '2025-01-01T00:00:00Z', movie: { ids: { imdb: 'tt7' } } }], episodes: [], pagination: { has_more: true } } }
            : { body: { movies: [], episodes: [{ watched_at: '2025-01-02T00:00:00Z', episode: { season: 1, number: 4 }, show: { ids: { imdb: 'tt8' } } }], pagination: { has_more: false } } },
      ],
      [/sync\/playback/, () => ({ body: [] })],
      [/watchlist\/items/, () => ({ body: { movies: [{ title: 'X', ids: { imdb: 'tt9' }, mediatype: 'movie' }], shows: [] } })],
      [/scrobble\/pause/, () => ({ body: {} })],
    );
    const r = await mdblistAdapter.pull(account);
    expect(r.watched.map((w) => w.key).sort()).toEqual(['tt7', 'tt8:1:4']);
    expect(r.watchlist?.[0]).toEqual(expect.objectContaining({ metaId: 'tt9', type: 'movie' }));
    expect(calls.every((c) => c.url.includes('apikey=k'))).toBe(true);

    const h = { ...history, progress: { 'tt8:1:5': { key: 'tt8:1:5', metaId: 'tt8', type: 'series' as const, season: 1, episode: 5, positionS: 300, durationS: 1200, updatedAt: 1 } } };
    await mdblistAdapter.push(account, { op: 'resume', key: 'tt8:1:5' } as never, h);
    const body = calls.find((c) => c.url.includes('scrobble/pause'))!.body;
    expect(body).toEqual({ show: { ids: { imdb: 'tt8' }, season: { number: 1, episode: { number: 5 } } }, progress: 25 });
  });

  it('reports a refused key as a sign-in problem', async () => {
    routes.push([/./, () => ({ status: 401, body: {} })]);
    await expect(mdblistAdapter.pull(account)).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});

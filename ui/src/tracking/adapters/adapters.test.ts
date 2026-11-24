import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each test sets the answers by URL; requests are recorded for checking bodies.
const routes: [RegExp, (req: { url: string; method?: string; body?: string }) => { status?: number; body: unknown }][] = [];
const calls: { url: string; method?: string; body?: unknown }[] = [];

vi.mock('../../lib/native', () => ({
  NetworkError: class extends Error {},
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const routes: [RegExp, () => { status?: number; body: unknown }][] = [];
const calls: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }[] = [];

vi.mock('../lib/native', () => ({
  NetworkError: class extends Error {},
  docs: { read: vi.fn(async () => ({ id: 'rove-test-device' })), write: vi.fn(async () => undefined) },
  secrets: { read: vi.fn(async () => null), write: vi.fn(async () => undefined) },
  nativeFetch: vi.fn(async (req: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: req.body ? JSON.parse(req.body) : undefined });
    const hit = routes.find(([re]) => re.test(req.url));
    const r = hit ? hit[1]() : { status: 404, body: {} };
    return { status: r.status ?? 200, url: req.url, headers: {}, body: JSON.stringify(r.body) };
  }),
}));

const { jellyfinAdapter } = await import('./jellyfin');
const { plexAdapter } = await import('./plex');
const { serverStreams, serverAsAddon } = await import('./index');
const { useServers } = await import('./store');

const jf = { id: 'j1', kind: 'jellyfin' as const, name: 'Den', url: 'http://nas:8096', token: 'T', userId: 'U', enabled: true, addedAt: 1 };
const emby = { ...jf, id: 'e1', kind: 'emby' as const, name: 'Emby' };
const plex = { id: 'p1', kind: 'plex' as const, name: 'Plex', url: 'http://nas:32400', token: 'PT', enabled: true, addedAt: 1 };

beforeEach(() => {
  routes.length = 0;
  calls.length = 0;
  useServers.setState({ servers: [jf, emby, plex], loaded: true });
});

describe('Jellyfin', () => {
  it('uses the IMDb id as the title id, and a server id when there is none', async () => {
    routes.push([
      /\/Items\?/,
      () => ({
        body: {
          Items: [
            { Id: 'a', Name: 'Known', Type: 'Movie', ProductionYear: 2020, ProviderIds: { Imdb: 'tt100' }, ImageTags: { Primary: 'p' } },
            { Id: 'b', Name: 'Home video', Type: 'Movie' },
          ],
        },
      }),
    ]);
    const items = await jellyfinAdapter.items(jf, 'lib', 0, 50);
    expect(items.map((i) => i.id)).toEqual(['tt100', 'srv:j1:b']);
    expect(items[0].poster).toBe('http://nas:8096/Items/a/Images/Primary?maxHeight=600&quality=90&tag=p');
    // Jellyfin takes the user as a parameter and the token in the Authorization header.
    expect(calls[0].url).toContain('userId=U');
    expect(calls[0].headers?.Authorization).toContain('Token="T"');
  });

  it('keeps the user in the path and the token in X-Emby headers on Emby', async () => {
    routes.push([/\/emby\/Users\/U\/Items\?/, () => ({ body: { Items: [] } })]);
    await jellyfinAdapter.items(emby, 'lib', 0, 50);
    expect(calls[0].url.startsWith('http://nas:8096/emby/Users/U/Items?')).toBe(true);
    expect(calls[0].headers?.['X-Emby-Token']).toBe('T');
  });

  it('finds an episode by IMDb id and offers it as a direct-play source', async () => {
    routes.push(
      [/IncludeItemTypes=Movie%2CSeries&Fields=ProviderIds/, () => ({ body: { Items: [{ Id: 'show1', Name: 'S', Type: 'Series', ProviderIds: { Imdb: 'tt200' } }] } })],
      [/\/Shows\/show1\/Episodes/, () => ({ body: { Items: [{ Id: 'ep12', Name: 'E', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 2 }] } })],
      [
        /\/Items\/ep12\?/,
        () => ({ body: { Id: 'ep12', Name: 'E', Type: 'Episode', MediaSources: [{ Id: 'ms1', Size: 2 * 1024 ** 3, Path: 'D:\\TV\\S01E02.mkv', MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 }, { Type: 'Audio', Codec: 'eac3' }] }] } }),
      ],
    );
    const streams = await serverStreams(jf, 'series', 'tt200:1:2');
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('http://nas:8096/Videos/ep12/stream?static=true&mediaSourceId=ms1&ApiKey=T');
    expect(streams[0].addonId).toBe('server:j1');
    expect(streams[0].behaviorHints?.serverItemId).toBe('ep12');
    expect(streams[0].title).toContain('4K');
    expect(streams[0].behaviorHints?.filename).toBe('S01E02.mkv');
  });

  it('reports progress in ticks with one play session', async () => {
    routes.push([/Sessions/, () => ({ status: 204, body: '' })]);
    await jellyfinAdapter.report(jf, 'x', 'start', 10, 100);
    await jellyfinAdapter.report(jf, 'x', 'progress', 20.5, 100);
    const [start, progress] = calls.map((c) => c.body as { PositionTicks: number; PlaySessionId: string });
    expect(progress.PositionTicks).toBe(205_000_000);
    expect(progress.PlaySessionId).toBe(start.PlaySessionId);
  });
});

describe('Plex', () => {
  it('maps guids to IMDb ids and builds tokened image and file links', async () => {
    routes.push(
      [/\/library\/sections\/1\/all/, () => ({ body: { MediaContainer: { Metadata: [{ ratingKey: '55', type: 'movie', title: 'Film', year: 2001, thumb: '/library/metadata/55/thumb/1', Guid: [{ id: 'imdb://tt300' }, { id: 'tmdb://9' }] }] } } })],
      [
        /\/library\/metadata\/55$/,
        () => ({ body: { MediaContainer: { Metadata: [{ ratingKey: '55', type: 'movie', title: 'Film', Media: [{ id: 1, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac', Part: [{ key: '/library/parts/9/file.mkv', file: '/m/Film.mkv', size: 1024 ** 3 }] }] }] } } }),
      ],
    );
    const items = await plexAdapter.items(plex, '1', 0, 50);
    expect(items[0].id).toBe('tt300');
    expect(items[0].poster).toContain('X-Plex-Token=PT');
    expect(calls[0].headers?.['X-Plex-Container-Size']).toBe('50');
    const streams = await plexAdapter.streams(plex, '55');
    expect(streams[0].url).toBe('http://nas:32400/library/parts/9/file.mkv?X-Plex-Token=PT');
    expect(streams[0].title).toContain('1080p');
  });
});

describe('the server list', () => {
  it('puts a removed server back under its own id and in its place', () => {
    const store = useServers.getState();
    store.remove('e1');
    expect(useServers.getState().servers.map((s) => s.id)).toEqual(['j1', 'p1']);
    store.restore(emby, 1);
    expect(useServers.getState().servers.map((s) => s.id)).toEqual(['j1', 'e1', 'p1']);
    // Once is enough.
    store.restore(emby, 0);
    expect(useServers.getState().servers).toHaveLength(3);
  });

  it('knows a Plex server by its machine id, whatever address it was reached at', () => {
    useServers.setState({ servers: [{ ...plex, machineId: 'M1' }], loaded: true });
    const again = useServers.getState().add({ kind: 'plex', name: 'Plex', url: 'https://remote.example:32400', token: 'PT2', machineId: 'M1' });
    expect(again.id).toBe('p1');
    expect(useServers.getState().servers).toHaveLength(1);
    expect(useServers.getState().servers[0].url).toBe('https://remote.example:32400');
    // A different machine is a different server.
    useServers.getState().add({ kind: 'plex', name: 'Other', url: 'http://nas:32400', token: 'PT3', machineId: 'M2' });
    expect(useServers.getState().servers).toHaveLength(2);
  });

  it('looks for a Plex server at its other addresses when the saved one stops answering', async () => {
    useServers.setState({
      servers: [{ ...plex, url: 'http://old:32400', machineId: 'M1', connections: [{ uri: 'http://old:32400', local: true, relay: false }, { uri: 'http://new:32400', local: false, relay: false }] }],
      loaded: true,
    });
    routes.push(
      [/^http:\/\/old:32400/, () => ({ status: 503, body: {} })],
      [/plex\.tv\/api\/v2\/resources/, () => ({ status: 401, body: {} })],
      [/^http:\/\/new:32400\/identity/, () => ({ body: { MediaContainer: { machineIdentifier: 'M1' } } })],
      [/^http:\/\/new:32400\/library\/sections/, () => ({ body: { MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] } } })],
    );
    const libraries = await useServers.getState().refresh('p1');
    expect(libraries).toEqual([{ id: '1', name: 'Movies', type: 'movie' }]);
    expect(useServers.getState().servers[0].url).toBe('http://new:32400');
    expect(useServers.getState().servers[0].libraries).toEqual(libraries);
  });
});

describe('servers as catalog sources', () => {
  it('offers continue, recently added, each library and a search catalog', () => {
    const a = serverAsAddon({ ...jf, libraries: [{ id: 'L', name: 'Movies', type: 'movie' }] });
    expect(a.manifest.catalogs.map((c) => c.id)).toEqual(['resume', 'recent', 'lib_L', 'search']);
    expect(a.manifest.catalogs.find((c) => c.id === 'search')?.showInHome).toBe(false);
  });
});

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

describe('collections and playlists as lists', () => {
  // Servers of their own, so the IMDb index other tests filled is not in play.
  const den = { ...jf, id: 'j2' };
  const embyDen = { ...emby, id: 'e2' };
  const lounge = { ...plex, id: 'p2', libraries: [{ id: '1', name: 'Movies', type: 'movie' as const }, { id: '2', name: 'Shows', type: 'series' as const }] };

  it('lists Jellyfin box sets and video playlists, collections first, without music playlists', async () => {
    routes.push([
      /\/Items\?/,
      () => ({
        body: {
          Items: [
            { Id: 'pl1', Name: 'Friday night', Type: 'Playlist', MediaType: 'Video', ChildCount: 4 },
            { Id: 'bs1', Name: 'Alien Collection', Type: 'BoxSet', ChildCount: 6, ImageTags: { Primary: 'p' } },
            { Id: 'pl2', Name: 'Running mix', Type: 'Playlist', MediaType: 'Audio' },
            { Id: 'm1', Name: 'A movie', Type: 'Movie' },
          ],
        },
      }),
    ]);
    const lists = await jellyfinAdapter.lists(den);
    expect(lists).toEqual([
      { id: 'bs1', kind: 'collection', name: 'Alien Collection', itemCount: 6, poster: 'http://nas:8096/Items/bs1/Images/Primary?maxHeight=600&quality=90&tag=p' },
      { id: 'pl1', kind: 'playlist', name: 'Friday night', itemCount: 4, poster: undefined },
    ]);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('IncludeItemTypes')).toBe('BoxSet,Playlist');
    expect(url.searchParams.get('Recursive')).toBe('true');
    expect(url.searchParams.get('userId')).toBe('U');
  });

  it('reads a box set as its children, page by page, until the server’s count is reached', async () => {
    routes.push([/\/Items\?/, () => ({ body: { Items: [{ Id: 'a', Name: 'Alien', Type: 'Movie', ProviderIds: { Imdb: 'tt0078748' } }, { Id: 'b', Name: 'Home cut', Type: 'Movie' }], TotalRecordCount: 5 } })]);
    const first = await jellyfinAdapter.listItems(den, { id: 'bs1', kind: 'collection' }, 0, 2);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/Items');
    expect([url.searchParams.get('ParentId'), url.searchParams.get('StartIndex'), url.searchParams.get('Limit')]).toEqual(['bs1', '0', '2']);
    expect(first.items.map((i) => i.id)).toEqual(['tt0078748', 'srv:j2:b']);
    expect(first.next).toBe(2);
    // The last page: what was skipped plus what came is all there is.
    expect((await jellyfinAdapter.listItems(den, { id: 'bs1', kind: 'collection' }, 3, 2)).next).toBeNull();
  });

  it('reads a playlist through its own call, with episodes standing for their show once', async () => {
    routes.push(
      [
        /\/Playlists\/pl1\/Items/,
        () => ({
          body: {
            Items: [
              { Id: 'e1', Name: 'Pilot', Type: 'Episode', SeriesId: 'show9', SeriesName: 'The Show', SeriesPrimaryImageTag: 't' },
              { Id: 'e2', Name: 'Second', Type: 'Episode', SeriesId: 'show9', SeriesName: 'The Show' },
              { Id: 'm', Name: 'Film', Type: 'Movie', ProviderIds: { Imdb: 'tt5' } },
            ],
            TotalRecordCount: 3,
          },
        }),
      ],
      // The index that gives a show standing in for its episodes its IMDb id.
      [/IncludeItemTypes=Movie%2CSeries&Fields=ProviderIds/, () => ({ body: { Items: [{ Id: 'show9', Name: 'The Show', Type: 'Series', ProviderIds: { Imdb: 'tt900' } }] } })],
    );
    const page = await jellyfinAdapter.listItems({ ...den, id: 'j3' }, { id: 'pl1', kind: 'playlist' }, 0, 50);
    expect(calls[0].url.startsWith('http://nas:8096/Playlists/pl1/Items?userId=U&StartIndex=0&Limit=50')).toBe(true);
    expect(page.items.map((i) => [i.id, i.type])).toEqual([['tt900', 'series'], ['tt5', 'movie']]);
    expect(page.next).toBeNull();
  });

  it('asks Emby under /emby with the user in the path, and goes by page size when no count comes', async () => {
    routes.push([/\/emby\//, () => ({ body: { Items: [{ Id: 'a', Name: 'A', Type: 'Movie' }, { Id: 'b', Name: 'B', Type: 'Movie' }] } })]);
    const page = await jellyfinAdapter.listItems(embyDen, { id: 'bs1', kind: 'collection' }, 0, 2);
    expect(calls[0].url.startsWith('http://nas:8096/emby/Users/U/Items?ParentId=bs1')).toBe(true);
    expect(page.next).toBe(2);
    await jellyfinAdapter.listItems(embyDen, { id: 'pl1', kind: 'playlist' }, 0, 50);
    const playlist = calls.find((c) => c.url.includes('/Playlists/'))!;
    expect(playlist.url.startsWith('http://nas:8096/emby/Playlists/pl1/Items?userId=U')).toBe(true);
    expect(playlist.headers?.['X-Emby-Token']).toBe('T');
  });

  it('lists Plex collections of every library and its video playlists', async () => {
    routes.push(
      [/\/library\/sections\/1\/collections/, () => ({ body: { MediaContainer: { Metadata: [{ ratingKey: '900', type: 'collection', subtype: 'movie', title: 'Pixar', childCount: '27', thumb: '/library/collections/900/composite/1' }] } } })],
      // One library not answering does not hide the rest.
      [/\/library\/sections\/2\/collections/, () => ({ status: 500, body: {} })],
      [/\/playlists\?/, () => ({ body: { MediaContainer: { Metadata: [{ ratingKey: '77', type: 'playlist', playlistType: 'video', title: 'Background', leafCount: 3, composite: '/playlists/77/composite/9' }, { ratingKey: '78', type: 'playlist', playlistType: 'audio', title: 'Music' }] } } })],
    );
    const lists = await plexAdapter.lists(lounge);
    expect(lists.map((l) => [l.id, l.kind, l.name, l.itemCount])).toEqual([['900', 'collection', 'Pixar', 27], ['77', 'playlist', 'Background', 3]]);
    expect(lists[1].poster).toContain('X-Plex-Token=PT');
    expect(calls.some((c) => c.url === 'http://nas:32400/playlists?playlistType=video')).toBe(true);
  });

  it('reads a Plex collection page by page, falling back to the older path', async () => {
    const film = (key: string, imdb: string) => ({ ratingKey: key, type: 'movie', title: `Film ${key}`, Guid: [{ id: `imdb://${imdb}` }] });
    routes.push([/\/library\/collections\/900\/items/, () => ({ body: { MediaContainer: { size: 2, totalSize: 3, Metadata: [film('1', 'tt1'), film('2', 'tt2')] } } })]);
    const first = await plexAdapter.listItems(lounge, { id: '900', kind: 'collection' }, 0, 2);
    expect(calls[0].url).toBe('http://nas:32400/library/collections/900/items?includeGuids=1');
    expect(calls[0].headers).toMatchObject({ 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '2' });
    expect(first.items.map((i) => i.id)).toEqual(['tt1', 'tt2']);
    expect(first.next).toBe(2);

    // A server from before `/items` answers 404 there and has the same under `/children`.
    routes.length = 0;
    calls.length = 0;
    routes.push([/\/library\/collections\/900\/children/, () => ({ body: { MediaContainer: { size: 1, totalSize: 3, Metadata: [film('3', 'tt3')] } } })]);
    const last = await plexAdapter.listItems(lounge, { id: '900', kind: 'collection' }, 2, 2);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/library/collections/900/items', '/library/collections/900/children']);
    expect(last.items.map((i) => i.id)).toEqual(['tt3']);
    expect(last.next).toBeNull();
  });

  it('reads a Plex playlist, and without a total goes by whether the page was full', async () => {
    routes.push([/\/playlists\/77\/items/, () => ({ body: { MediaContainer: { Metadata: [{ ratingKey: '5', type: 'movie', title: 'One', Guid: [{ id: 'imdb://tt5' }] }, { ratingKey: '6', type: 'clip', title: 'A clip' }] } } })]);
    const page = await plexAdapter.listItems(lounge, { id: '77', kind: 'playlist' }, 0, 2);
    expect(page.items.map((i) => i.id)).toEqual(['tt5']);
    // Two items came for a page of two (one of them not a title): there may be more.
    expect(page.next).toBe(2);
    expect((await plexAdapter.listItems(lounge, { id: '77', kind: 'playlist' }, 0, 50)).next).toBeNull();
  });
});

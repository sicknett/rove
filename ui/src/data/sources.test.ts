import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/native', () => ({
  NetworkError: class extends Error {},
  nativeFetch: vi.fn(async () => ({ status: 404, url: '', headers: {}, body: '{}' })),
  docs: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  secrets: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
  freezeWrites: () => undefined,
}));

// A build with ROVE's Trakt app id and no TMDB key of its own, whatever the env file holds.
vi.stubEnv('VITE_TRAKT_CLIENT_ID', 'trakt-id');
vi.stubEnv('VITE_TMDB_API_KEY', '');

const { blockerMessage, firstSourcePage, nextSourcePage, sourceBlocker, sourceLabel, sourceOrigin, sourceProviderName } = await import('./sources');
const { useTracker } = await import('../tracking/sync');
const { useKeys } = await import('../state/keys');
const { useServers } = await import('../servers/store');
type SourcePage = import('./sources').SourcePage;

const server = { id: 's1', kind: 'jellyfin' as const, name: 'Den', url: 'http://nas', token: 't', userId: 'u', enabled: true, addedAt: 1 };
const page = (ids: string[], param: number, next?: number | null): SourcePage => ({ items: ids.map((id) => ({ id, type: 'movie', name: id })), param, next });

beforeEach(() => {
  useTracker.setState({ account: null });
  useKeys.setState({ tmdbApiKey: null, mdblistApiKey: null });
  useServers.setState({ servers: [], loaded: true });
});

describe('why a source cannot be read', () => {
  const publicList = { provider: 'trakt', traktListId: 35016391, mediaType: 'TV' };
  const watchlist = { provider: 'trakt', traktKind: 'watchlist' };
  const mdb = { provider: 'mdblist', mdblistId: 4 };
  const boxSet = { provider: 'server', serverId: 's1', serverListId: 'c1', serverListKind: 'collection' };

  it('reads a public Trakt list with no one signed in, and asks for the account only for its own things', () => {
    expect(sourceBlocker(publicList)).toBeNull();
    expect(sourceBlocker(watchlist)).toBe('trakt-signin');
    expect(sourceBlocker({ provider: 'trakt', traktUser: 'me', traktSlug: '55' })).toBe('trakt-signin');
    expect(sourceBlocker({ provider: 'trakt', traktUser: 'sean', traktSlug: 'machete' })).toBeNull();
    expect(blockerMessage('trakt-signin')).toMatchObject({ title: 'Sign in to Trakt', section: 'accounts' });

    // Another tracker connected is still not a Trakt account.
    useTracker.setState({ account: { provider: 'simkl', accessToken: 'x' } });
    expect(sourceBlocker(watchlist)).toBe('trakt-signin');
    useTracker.setState({ account: { provider: 'trakt', accessToken: 'tok', username: 'sean' } });
    expect(sourceBlocker(watchlist)).toBeNull();
  });

  it('needs an MDBList key: a connected MDBList tracker’s, or one saved for lists', () => {
    expect(sourceBlocker(mdb)).toBe('mdblist-key');
    expect(blockerMessage('mdblist-key')).toMatchObject({ title: 'Add an MDBList key', section: 'accounts' });
    useKeys.setState({ mdblistApiKey: 'k' });
    expect(sourceBlocker(mdb)).toBeNull();
    useKeys.setState({ mdblistApiKey: null });
    useTracker.setState({ account: { provider: 'mdblist', apiKey: 'k2' } });
    expect(sourceBlocker(mdb)).toBeNull();
  });

  it('tells a server that is switched off from one that is gone', () => {
    expect(sourceBlocker(boxSet)).toBe('server-gone');
    useServers.setState({ servers: [{ ...server, enabled: false }] });
    expect(sourceBlocker(boxSet)).toBe('server-off');
    expect(blockerMessage('server-off')).toMatchObject({ title: 'This server is switched off', section: 'servers' });
    useServers.setState({ servers: [server] });
    expect(sourceBlocker(boxSet)).toBeNull();
  });

  it('keeps the reasons it already gave', () => {
    expect(sourceBlocker({ provider: 'tmdb', tmdbSourceType: 'LIST', tmdbId: 1 })).toBe('tmdb-key');
    expect(sourceBlocker({ provider: 'addon', addonId: 'missing', type: 'movie', catalogId: 'top' })).toBe('addon');
    expect(sourceBlocker({ provider: 'letterboxd' })).toBe('provider');
    expect(blockerMessage('provider').title).toBe('This source is not supported');
  });

  it('says a build without the Trakt app id cannot read Trakt lists, signed in or not', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_TRAKT_CLIENT_ID', '');
    const bare = await import('./sources');
    expect(bare.sourceBlocker(publicList)).toBe('trakt-app');
    expect(bare.sourceBlocker(watchlist)).toBe('trakt-app');
    expect(bare.blockerMessage('trakt-app').title).toBe('Trakt lists need ROVE’s Trakt app id in this build');
    // Nothing in Settings gives a build its app id.
    expect(bare.blockerMessage('trakt-app').section).toBeUndefined();
    vi.stubEnv('VITE_TRAKT_CLIENT_ID', 'trakt-id');
  });
});

describe('naming a source', () => {
  it('uses its title, else says what kind of list it is and where it comes from', () => {
    useServers.setState({ servers: [server] });
    expect(sourceLabel({ provider: 'trakt', traktListId: 1, title: 'AMC+' })).toBe('AMC+');
    expect(sourceLabel({ provider: 'trakt', traktListId: 1 })).toBe('Trakt list');
    expect(sourceLabel({ provider: 'trakt', traktKind: 'watchlist' })).toBe('Trakt watchlist');
    expect(sourceLabel({ provider: 'mdblist', mdblistId: 4 })).toBe('MDBList list');
    expect(sourceLabel({ provider: 'server', serverId: 's1', serverListId: 'p', serverListKind: 'playlist' })).toBe('Playlist · Den');
    expect(sourceOrigin({ provider: 'trakt', traktListId: 35016391 })).toBe('Trakt · list 35016391');
    expect(sourceOrigin({ provider: 'trakt', traktUser: 'me', traktSlug: '55' })).toBe('Trakt · your list');
    expect(sourceOrigin({ provider: 'mdblist', mdblistKind: 'watchlist' })).toBe('MDBList · your watchlist');
    expect(sourceOrigin({ provider: 'server', serverId: 's1', serverListId: 'c' })).toBe('Den · collection');
    expect(sourceOrigin({ provider: 'tmdb', tmdbSourceType: 'LIST', tmdbId: 8 })).toBe('TMDB · list 8');
    expect([{ provider: 'trakt' }, { provider: 'mdblist' }, { provider: 'server', serverId: 's1' }, { provider: 'tmdb' }, {}].map(sourceProviderName)).toEqual(['Trakt', 'MDBList', 'Den', 'TMDB', 'The addon']);
  });
});

describe('paging a source', () => {
  it('starts numbered pages at 1 and skipped-title sources at 0', () => {
    expect([{ provider: 'tmdb' }, { provider: 'trakt', traktListId: 1 }, { provider: 'mdblist', mdblistId: 1 }, { provider: 'server', serverId: 's', serverListId: 'c' }, { provider: 'addon' }].map(firstSourcePage)).toEqual([1, 1, 0, 0, 0]);
  });

  it('follows what a list says comes next, and stops when it says nothing does', () => {
    const first = page(['a', 'b'], 1, 2);
    expect(nextSourcePage('trakt', first, [first])).toBe(2);
    const last = page(['c'], 2, null);
    expect(nextSourcePage('trakt', last, [first, last])).toBeUndefined();
    // MDBList and servers count titles: the next page starts after the ones that came.
    const mdb = page(['a', 'b'], 0, 40);
    expect(nextSourcePage('mdblist', mdb, [mdb])).toBe(40);
    // A page whose titles were all unusable still leads on to the next.
    const empty = page([], 40, 80);
    expect(nextSourcePage('mdblist', empty, [mdb, empty])).toBe(80);
  });

  it('ends a list that sends nothing new, however much more it claims to have', () => {
    const first = page(['a', 'b'], 1, 2);
    const again = page(['b', 'a'], 2, 3);
    expect(nextSourcePage('trakt', again, [first, again])).toBeUndefined();
    expect(nextSourcePage('mdblist', again, [first, again])).toBeUndefined();
    // One new title is enough to go on.
    const some = page(['b', 'c'], 2, 3);
    expect(nextSourcePage('trakt', some, [first, some])).toBe(3);
  });

  it('lets a server list go on past a page of episodes of shows already seen', () => {
    const first = page(['tt1', 'tt2'], 0, 50);
    const sameShows = page(['tt2'], 50, 100);
    expect(nextSourcePage('server', sameShows, [first, sameShows])).toBe(100);
    const done = page(['tt2'], 100, null);
    expect(nextSourcePage('server', done, [first, sameShows, done])).toBeUndefined();
  });

  it('does not follow a list for ever', () => {
    const pages = Array.from({ length: 60 }, (_, i) => page([`t${i}`], i + 1, i + 2));
    expect(nextSourcePage('trakt', pages[58], pages.slice(0, 59))).toBe(60);
    expect(nextSourcePage('trakt', pages[59], pages)).toBeUndefined();
  });

  it('pages TMDB and addon catalogs as before', () => {
    const t = page(['a'], 1);
    expect(nextSourcePage('tmdb', t, [t])).toBe(2);
    expect(nextSourcePage('tmdb', page(['z'], 20), [t, page(['z'], 20)])).toBeUndefined();
    const a = page(['a', 'b'], 0);
    expect(nextSourcePage('addon', a, [a])).toBe(2);
    const repeat = page(['a', 'b'], 2);
    expect(nextSourcePage('addon', repeat, [a, repeat])).toBeUndefined();
    expect(nextSourcePage('addon', page([], 2), [a, page([], 2)])).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const saved: unknown[] = [];
vi.mock('../lib/native', () => ({
  NetworkError: class extends Error {},
  nativeFetch: vi.fn(),
  docs: {
    read: async (n: string) => (store.has(n) ? structuredClone(store.get(n)) : null),
    write: async (n: string, v: unknown) => void store.set(n, structuredClone(v)),
    remove: async (n: string) => void store.delete(n),
  },
  secrets: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  debouncedWriter: () => ({ save: (v: unknown) => void saved.push(v), flush: async () => undefined }),
}));

// This file runs as a build without ROVE's Trakt app id, whatever the build's own env file
// holds (the last test loads a build that has one).
vi.stubEnv('VITE_TRAKT_CLIENT_ID', '');
const { canShowSource, cleanCollections, parseCollections, restoreDefaultLists, shownCollections, sourceKey, useCollections, withHiddenCollectionKeys } = await import('./collections');
type Collection = import('./collections').Collection;
type CollectionSource = import('./collections').CollectionSource;

const tmdb = { provider: 'tmdb', tmdbSourceType: 'LIST', tmdbId: 1, mediaType: 'MOVIE' };
const addon = { provider: 'addon', addonId: 'a', type: 'movie', catalogId: 'top' };
const trakt = { provider: 'trakt', traktListId: 9, mediaType: 'TV', sortBy: 'rank', sortHow: 'asc', title: 'AMC+' };
const trakt2 = { ...trakt, traktListId: 10, title: 'MGM+' };
const unknown = { provider: 'letterboxd', listId: 'x' } as CollectionSource;

/** A small stand-in for the shipped set: Trakt lists next to TMDB and addon sources. */
const shipped = (): Collection[] => [
  {
    id: 'mixed',
    title: 'Mixed',
    folders: [
      { id: 'f1', title: 'Both', sources: [tmdb, trakt, addon] },
      { id: 'f2', title: 'Trakt only', sources: [trakt] },
      { id: 'f3', title: 'Fine', sources: [tmdb] },
    ],
  },
  { id: 'awards', title: 'Awards', folders: [{ id: 'f4', title: 'Winners', sources: [trakt, trakt2] }] },
  { id: 'kept', title: 'Kept', folders: [{ id: 'f5', title: 'Plain', sources: [tmdb] }] },
];

/** What the first cleaning pass left of the shipped set in a saved profile. */
const cleanedByFirstPass = (): Collection[] => [
  {
    id: 'mixed',
    title: 'Mixed',
    folders: [
      { id: 'f1', title: 'Both', sources: [tmdb, addon], catalogSources: [] },
      { id: 'f3', title: 'Fine', sources: [tmdb] },
    ],
  },
  { id: 'kept', title: 'Kept', folders: [{ id: 'f5', title: 'Plain', sources: [tmdb] }] },
];

const noTrakt = (s: CollectionSource) => s.provider !== 'trakt';
const ids = (list: { id: string }[]) => list.map((x) => x.id);

beforeEach(() => {
  store.clear();
  saved.length = 0;
  useCollections.setState({ loaded: false, collections: [], saved: [], lists: [] });
});

afterEach(() => vi.unstubAllGlobals());

describe('cleanCollections', () => {
  it('keeps Trakt, MDBList and server lists, and drops only what ROVE has no reader for', () => {
    const list: Collection[] = [
      {
        id: 'c',
        title: 'C',
        folders: [
          { id: 'a', title: 'Lists', sources: [trakt, { provider: 'mdblist', mdblistId: 5 }, { provider: 'server', serverId: 's', serverListId: 'x' }, { provider: 'trakt', traktKind: 'watchlist' }] },
          { id: 'b', title: 'Unknown and broken', sources: [unknown, { provider: 'trakt' }, { provider: 'addon', addonId: 'a' }, { provider: 'mdblist' }, { provider: 'server', serverId: 's' }] },
          { id: 'd', title: 'One of each', sources: [tmdb, unknown] },
        ],
      },
      { id: 'gone', title: 'Nothing readable', folders: [{ id: 'e', title: 'E', sources: [unknown] }] },
    ];
    const out = cleanCollections(list);
    expect(ids(out)).toEqual(['c']);
    expect(ids(out[0].folders)).toEqual(['a', 'd']);
    expect(out[0].folders[0].sources).toHaveLength(4);
    expect(out[0].folders[1].sources).toEqual([tmdb]);
  });

  it('changes nothing in the shipped kind of set, and says so by returning the same list', () => {
    const list = shipped();
    expect(cleanCollections(list)).toBe(list);
  });

  it('leaves the user’s own empty folders and collections alone', () => {
    const own: Collection[] = [
      { id: 'new', title: 'New collection', folders: [] },
      { id: 'wip', title: 'In progress', folders: [{ id: 'f', title: 'New folder', sources: [] }] },
    ];
    expect(cleanCollections(own)).toBe(own);
    expect(shownCollections(own, noTrakt)).toBe(own);
  });

  it('reads older catalogSources and keeps them', () => {
    const old: Collection[] = [{ id: 'c', title: 'Old', folders: [{ id: 'f', title: 'F', catalogSources: [{ addonId: 'a', type: 'movie', catalogId: 'top' }] }] }];
    expect(cleanCollections(old)).toBe(old);
  });

  it('keeps Trakt lists in what is imported or seeded', () => {
    expect(ids(parseCollections({ collections: shipped() }))).toEqual(['mixed', 'awards', 'kept']);
    expect(ids(parseCollections(shipped()[1]))).toEqual(['awards']);
  });
});

describe('what a build without the Trakt app id shows', () => {
  it('hides Trakt sources, then folders and collections left with nothing, and removes none of it', () => {
    const list = shipped();
    const before = structuredClone(list);
    const out = shownCollections(list, noTrakt);
    expect(ids(out)).toEqual(['mixed', 'kept']);
    expect(ids(out[0].folders)).toEqual(['f1', 'f3']);
    expect(out[0].folders[0].sources).toEqual([tmdb, addon]);
    expect(list).toEqual(before);
    // A collection with nothing hidden is the saved object itself.
    expect(out[1]).toBe(list[2]);
  });

  it('shows everything, as the same list, when the build can show Trakt', () => {
    const list = shipped();
    expect(shownCollections(list, () => true)).toBe(list);
  });

  it('is what this build does by default: a Trakt list cannot be shown without the app id', () => {
    expect(canShowSource(trakt)).toBe(false);
    expect(canShowSource(tmdb)).toBe(true);
    expect(canShowSource({ provider: 'mdblist', mdblistId: 1 })).toBe(true);
    expect(ids(shownCollections(shipped()))).toEqual(['mixed', 'kept']);
  });

  it('gives screens the shown collections and keeps all of them saved', () => {
    useCollections.getState().replaceAll(shipped());
    const s = useCollections.getState();
    expect(ids(s.collections)).toEqual(['mixed', 'kept']);
    expect(ids(s.saved)).toEqual(['mixed', 'awards', 'kept']);
    expect(saved.at(-1)).toMatchObject({ collections: s.saved });
  });

  it('moves folders and collections among the shown ones, leaving hidden ones where they are', () => {
    const s = useCollections.getState();
    s.replaceAll(shipped());
    // f3 is the second folder on screen; moved first, it lands before f1, and f2 stays put.
    s.moveFolder('mixed', 'f3', 0);
    expect(ids(useCollections.getState().saved[0].folders)).toEqual(['f3', 'f1', 'f2']);
    // "Kept" is the second collection on screen; moved first, the hidden one keeps its place.
    s.move('kept', 0);
    expect(ids(useCollections.getState().saved)).toEqual(['kept', 'mixed', 'awards']);
    s.move('kept', 5);
    expect(ids(useCollections.getState().saved)).toEqual(['mixed', 'kept', 'awards']);
  });

  it('undoes a delete with what was saved, hidden lists included', () => {
    const s = useCollections.getState();
    s.replaceAll(shipped());
    // Screens hold the shown copies: these are what an Undo hands back.
    const shownCollection = useCollections.getState().collections[0];
    const shownFolder = shownCollection.folders[0];
    expect(shownFolder.sources).toEqual([tmdb, addon]);

    const removed = s.removeFolder('mixed', 'f1');
    s.restoreFolder('mixed', shownFolder, 0);
    expect(removed?.sources).toEqual([tmdb, trakt, addon]);
    expect(useCollections.getState().saved[0].folders[0].sources).toEqual([tmdb, trakt, addon]);

    s.remove('mixed');
    s.merge([shownCollection]);
    const back = useCollections.getState().saved.find((c) => c.id === 'mixed')!;
    expect(ids(back.folders)).toEqual(['f1', 'f2', 'f3']);
  });

  it('tells Home’s layout about hidden collections at their saved places', () => {
    useCollections.getState().replaceAll(shipped());
    expect(withHiddenCollectionKeys(['continue_watching', 'collection_mixed', 'collection_kept'])).toEqual(['continue_watching', 'collection_mixed', 'collection_awards', 'collection_kept']);
    const all = ['continue_watching', 'collection_mixed', 'collection_awards', 'collection_kept'];
    expect(withHiddenCollectionKeys(all)).toBe(all);
  });
});

describe('restoreDefaultLists', () => {
  it('puts back the Trakt lists, folders and collections the first pass removed, where they shipped', () => {
    const out = restoreDefaultLists(cleanedByFirstPass(), shipped());
    expect(ids(out)).toEqual(['mixed', 'awards', 'kept']);
    expect(ids(out[0].folders)).toEqual(['f1', 'f2', 'f3']);
    expect(out[0].folders[0].sources).toEqual([tmdb, trakt, addon]);
    expect(out[1]).toEqual(shipped()[1]);
  });

  it('does it once: a second run changes nothing and duplicates nothing', () => {
    const once = restoreDefaultLists(cleanedByFirstPass(), shipped());
    expect(restoreDefaultLists(once, shipped())).toBe(once);
    // Collections the pass never touched are the same too.
    const untouched = shipped();
    expect(restoreDefaultLists(untouched, shipped())).toBe(untouched);
  });

  it('does not bring back what the user removed', () => {
    const mine = cleanedByFirstPass();
    // "Fine" and "Kept" survived the first pass, so only the user can have removed them.
    mine[0].folders = mine[0].folders.filter((f) => f.id !== 'f3');
    const out = restoreDefaultLists(mine.filter((c) => c.id !== 'kept'), shipped());
    expect(ids(out)).toEqual(['mixed', 'awards']);
    expect(ids(out[0].folders)).toEqual(['f1', 'f2']);
  });

  it('leaves the user’s own collections, folders, edits and order as they are', () => {
    const own: Collection = { id: 'own', title: 'My lists', folders: [{ id: 'o1', title: 'Mine', sources: [addon] }] };
    const mine = cleanedByFirstPass();
    const extra = { provider: 'tmdb', tmdbSourceType: 'COMPANY', tmdbId: 7, mediaType: 'movie' };
    mine[0].folders = [
      { id: 'u1', title: 'Added by me', sources: [addon] },
      { id: 'f3', title: 'Fine' /* moved up */, sources: [tmdb] },
      { id: 'f1', title: 'Renamed', coverImageUrl: 'https://x/cover.jpg', sources: [extra, addon, tmdb] },
    ];
    const out = restoreDefaultLists([own, ...mine], shipped());
    expect(out[0]).toBe(own);
    const mixed = out.find((c) => c.id === 'mixed')!;
    // The user's folder and order stay; the removed folder comes back after the one it followed.
    expect(ids(mixed.folders)).toEqual(['u1', 'f3', 'f1', 'f2']);
    const f1 = mixed.folders.find((f) => f.id === 'f1')!;
    expect(f1).toMatchObject({ title: 'Renamed', coverImageUrl: 'https://x/cover.jpg' });
    // Their sources keep their order; the Trakt list goes back after the source it shipped after.
    expect(f1.sources).toEqual([extra, addon, tmdb, trakt]);
  });

  it('does not add a list the folder already has', () => {
    const mine = cleanedByFirstPass();
    mine[0].folders[0].sources = [trakt, tmdb];
    const out = restoreDefaultLists(mine, shipped());
    expect(out[0].folders[0].sources!.filter((s) => sourceKey(s) === sourceKey(trakt))).toHaveLength(1);
  });

  it('leaves a profile with none of the shipped collections alone', () => {
    const own: Collection[] = [{ id: 'own', title: 'My lists', folders: [{ id: 'o1', title: 'Mine', sources: [addon] }] }];
    expect(restoreDefaultLists(own, shipped())).toBe(own);
  });
});

describe('loading a profile', () => {
  const serveShipped = () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => shipped() }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('gives collections cleaned by the first pass their shipped lists back, once', async () => {
    const fetchMock = serveShipped();
    store.set('collections-none', { collections: cleanedByFirstPass() });
    await useCollections.getState().load();
    expect(fetchMock).toHaveBeenCalledWith('/defaults/collections.json');
    expect(ids(useCollections.getState().saved)).toEqual(['mixed', 'awards', 'kept']);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ defaultsRestored: true });

    // The next start reads what was written: nothing is fetched, merged or written again, and
    // a folder the user deletes from here on stays deleted.
    const doc = structuredClone(saved[0]) as { collections: Collection[] };
    doc.collections[0].folders = doc.collections[0].folders.filter((f) => f.id !== 'f2');
    store.set('collections-none', doc);
    saved.length = 0;
    fetchMock.mockClear();
    await useCollections.getState().load();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ids(useCollections.getState().saved[0].folders)).toEqual(['f1', 'f3']);
    expect(saved).toHaveLength(0);
  });

  it('tries again next time when the shipped file cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.set('collections-none', { collections: cleanedByFirstPass() });
    await useCollections.getState().load();
    expect(ids(useCollections.getState().saved)).toEqual(['mixed', 'kept']);
    // Not marked as done, and nothing was written.
    expect(saved).toHaveLength(0);
  });

  it('drops only unreadable sources from what was saved, and writes only when something changed', async () => {
    serveShipped();
    const mine: Collection[] = [{ id: 'own', title: 'Mine', folders: [{ id: 'o1', title: 'Both', sources: [trakt, unknown] }] }];
    store.set('collections-none', { collections: mine, defaultsRestored: true });
    await useCollections.getState().load();
    expect(useCollections.getState().saved[0].folders[0].sources).toEqual([trakt]);
    expect(saved).toHaveLength(1);

    store.set('collections-none', saved[0]);
    saved.length = 0;
    await useCollections.getState().load();
    expect(saved).toHaveLength(0);
  });

  it('has nothing to restore in a new profile, and marks it so', async () => {
    const fetchMock = serveShipped();
    await useCollections.getState().load();
    expect(fetchMock).not.toHaveBeenCalled();
    useCollections.getState().replaceAll(shipped());
    expect(saved.at(-1)).toMatchObject({ defaultsRestored: true });
  });
});

describe('lists as rows on Home', () => {
  it('keeps them with the collections, and puts a removed one back in its place under its id', async () => {
    const s = useCollections.getState();
    const [a, b, c] = s.addLists([
      { title: 'Watchlist', source: { provider: 'trakt', traktKind: 'watchlist' } },
      { title: 'Top movies', source: { provider: 'mdblist', mdblistId: 4 } },
      { title: 'Box sets', source: { provider: 'server', serverId: 's1', serverListId: 'c1', serverListKind: 'collection' } },
    ]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(saved.at(-1)).toMatchObject({ lists: [{ title: 'Watchlist' }, { title: 'Top movies' }, { title: 'Box sets' }] });

    const removed = s.removeList(b.id)!;
    expect(ids(useCollections.getState().lists)).toEqual([a.id, c.id]);
    s.restoreList(removed.row, removed.index);
    s.restoreList(removed.row, 0);
    expect(ids(useCollections.getState().lists)).toEqual([a.id, b.id, c.id]);

    // They come back with the profile; one no reader exists for does not.
    store.set('collections-none', { collections: [], lists: [...useCollections.getState().lists, { id: 'x', title: 'Odd', source: unknown, addedAt: 1 }] });
    await useCollections.getState().load();
    expect(ids(useCollections.getState().lists)).toEqual([a.id, b.id, c.id]);
  });
});

describe('telling sources apart', () => {
  it('gives each list its own key (Trakt lists used to share one)', () => {
    const keys = [trakt, trakt2, { ...trakt, mediaType: 'MOVIE' }, { ...trakt, sortBy: 'popularity', sortHow: 'desc' }, { provider: 'trakt', traktUser: 'me', traktSlug: '9' }, { provider: 'trakt', traktKind: 'watchlist' }, { provider: 'mdblist', mdblistId: 9 }, { provider: 'mdblist', mdblistUser: 'u', mdblistSlug: 'top' }, { provider: 'server', serverId: 's', serverListId: '9', serverListKind: 'playlist' }, { provider: 'server', serverId: 's', serverListId: '9', serverListKind: 'collection' }, tmdb, addon].map(sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
    // The label is not part of it.
    expect(sourceKey({ ...trakt, title: 'Other name' })).toBe(sourceKey(trakt));
  });
});

describe('a build that has the Trakt app id', () => {
  it('shows the Trakt lists the other build kept hidden, with no migration', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_TRAKT_CLIENT_ID', 'trakt-id');
    const withApp = await import('./collections');
    expect(withApp.canShowSource(trakt)).toBe(true);
    const list = shipped();
    expect(withApp.shownCollections(list)).toBe(list);
    vi.stubEnv('VITE_TRAKT_CLIENT_ID', '');
  });
});

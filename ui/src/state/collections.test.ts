import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const saved: unknown[] = [];
vi.mock('../lib/native', () => ({
  docs: {
    read: async (n: string) => (store.has(n) ? structuredClone(store.get(n)) : null),
    write: async (n: string, v: unknown) => void store.set(n, structuredClone(v)),
    remove: async (n: string) => void store.delete(n),
  },
  secrets: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  debouncedWriter: () => ({ save: (v: unknown) => void saved.push(v), flush: async () => undefined }),
}));

const { cleanCollections, parseCollections, useCollections } = await import('./collections');
type Collection = import('./collections').Collection;

const tmdb = { provider: 'tmdb', tmdbSourceType: 'LIST', tmdbId: 1, mediaType: 'MOVIE' };
const addon = { provider: 'addon', addonId: 'a', type: 'movie', catalogId: 'top' };
const trakt = { provider: 'trakt', traktListId: 9, mediaType: 'TV' };

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
  { id: 'awards', title: 'Awards', folders: [{ id: 'f4', title: 'Winners', sources: [trakt, trakt] }] },
];

beforeEach(() => {
  store.clear();
  saved.length = 0;
});

describe('cleanCollections', () => {
  it('drops sources ROVE cannot show, then folders and collections left with nothing', () => {
    const out = cleanCollections(shipped());
    expect(out.map((c) => c.id)).toEqual(['mixed']);
    expect(out[0].folders.map((f) => f.id)).toEqual(['f1', 'f3']);
    expect(out[0].folders[0].sources).toEqual([tmdb, addon]);
  });

  it('leaves the user’s own empty folders and collections alone', () => {
    const own: Collection[] = [
      { id: 'new', title: 'New collection', folders: [] },
      { id: 'wip', title: 'In progress', folders: [{ id: 'f', title: 'New folder', sources: [] }] },
    ];
    expect(cleanCollections(own)).toBe(own);
  });

  it('changes nothing the second time, and says so by returning the same list', () => {
    const once = cleanCollections(shipped());
    expect(cleanCollections(once)).toBe(once);
  });

  it('reads older catalogSources and keeps them', () => {
    const old: Collection[] = [{ id: 'c', title: 'Old', folders: [{ id: 'f', title: 'F', catalogSources: [{ addonId: 'a', type: 'movie', catalogId: 'top' }] }] }];
    expect(cleanCollections(old)).toBe(old);
  });
});

describe('importing and loading', () => {
  it('cleans what is imported or seeded', () => {
    expect(parseCollections({ collections: shipped() }).map((c) => c.id)).toEqual(['mixed']);
    expect(parseCollections(shipped()[1])).toEqual([]);
  });

  it('cleans collections saved earlier once, and writes only when something changed', async () => {
    store.set('collections-none', { collections: shipped() });
    await useCollections.getState().load();
    expect(useCollections.getState().collections.map((c) => c.id)).toEqual(['mixed']);
    expect(saved).toHaveLength(1);

    store.set('collections-none', saved[0]);
    saved.length = 0;
    await useCollections.getState().load();
    expect(useCollections.getState().collections[0].folders.map((f) => f.id)).toEqual(['f1', 'f3']);
    expect(saved).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const answers: Record<string, unknown> = {};
vi.mock('../lib/native', () => ({
  NetworkError: class extends Error {},
  nativeFetch: vi.fn(async (req: { url: string }) => {
    const hit = Object.keys(answers).find((k) => req.url.includes(k));
    return { status: hit ? 200 : 404, url: req.url, headers: {}, body: JSON.stringify(hit ? answers[hit] : {}) };
  }),
  docs: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  secrets: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
  freezeWrites: () => undefined,
}));

vi.stubEnv('VITE_TRAKT_CLIENT_ID', 'trakt-id');
vi.stubEnv('VITE_TMDB_API_KEY', '');

const { importAsFolders, importAsRows } = await import('./importing');
const { mdblistChoice, traktChoice } = await import('./providers');
const { listRowKey, useCollections } = await import('../state/collections');
const { CONTINUE_KEY, useHomeLayout } = await import('../state/homeLayout');
const { useKeys } = await import('../state/keys');

const amc = traktChoice({ id: 35016391, name: 'AMC+', itemCount: 40 });
const top = mdblistChoice({ id: 4, name: 'Top movies' });

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  useCollections.setState({ loaded: true, collections: [], saved: [], lists: [] });
  useHomeLayout.setState({ loaded: true, heroEnabled: true, items: [] });
  useKeys.setState({ tmdbApiKey: null, mdblistApiKey: 'k' });
});

describe('importing lists as rows on Home', () => {
  it('adds each list once, right under Continue Watching, and not to the banner', () => {
    useHomeLayout.getState().ensure([CONTINUE_KEY, 'addon:movie:top', 'collection_c1']);
    const first = importAsRows([amc, top]);
    expect(first).toMatchObject({ added: 2, skipped: 0 });
    const lists = useCollections.getState().lists;
    expect(lists.map((l) => [l.title, l.source.provider])).toEqual([['AMC+', 'trakt'], ['Top movies', 'mdblist']]);
    const order = [...useHomeLayout.getState().items].sort((a, b) => a.order - b.order);
    expect(order.map((i) => i.key)).toEqual([CONTINUE_KEY, listRowKey(lists[0].id), listRowKey(lists[1].id), 'addon:movie:top', 'collection_c1']);
    expect(order.filter((i) => i.key.startsWith('list_')).every((i) => i.enabled && !i.hero)).toBe(true);

    // The same list again is left as it is.
    expect(importAsRows([amc])).toMatchObject({ added: 0, skipped: 1 });
    expect(useCollections.getState().lists).toHaveLength(2);
  });
});

describe('importing lists as folders', () => {
  it('makes a folder per list in an existing collection, skipping lists it already has', () => {
    const c = useCollections.getState().create('Streaming');
    expect(importAsFolders([amc, top], { collectionId: c.id })).toMatchObject({ added: 2, skipped: 0, collectionId: c.id, title: 'Streaming' });
    const folders = useCollections.getState().saved[0].folders;
    expect(folders.map((f) => [f.title, f.sources?.[0].provider, f.sources?.[0].title])).toEqual([['AMC+', 'trakt', 'AMC+'], ['Top movies', 'mdblist', 'Top movies']]);
    expect(importAsFolders([amc], { collectionId: c.id })).toMatchObject({ added: 0, skipped: 1 });
    expect(useCollections.getState().saved[0].folders).toHaveLength(2);
  });

  it('makes a new collection when asked, and gives a folder its list’s first poster as cover', async () => {
    answers['/lists/4/items'] = { movies: [{ id: 1, rank: 1, title: 'A', imdb_id: 'tt1', mediatype: 'movie', poster: 'https://img.example/a.jpg' }], shows: [] };
    const r = importAsFolders([top], { title: 'My lists' });
    expect(r).toMatchObject({ added: 1, title: 'My lists' });
    expect(useCollections.getState().saved.map((c) => c.title)).toEqual(['My lists']);
    await vi.waitFor(() => expect(useCollections.getState().saved[0].folders[0].coverImageUrl).toBe('https://img.example/a.jpg'));
  });
});

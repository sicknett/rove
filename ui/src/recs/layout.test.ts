// How the rows made from history join the Home layout (state/homeLayout).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/native', () => ({
  docs: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  secrets: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
}));
vi.mock('../meta/tmdb', () => ({ tmdb: vi.fn() }));

const { CONTINUE_KEY, FOR_YOU_KEY, isSmartKey, useHomeLayout } = await import('../state/homeLayout');
const { recipeFor, SMART, SMART_KEYS, WATCHLIST_ROW } = await import('./recipes');

const layout = () => useHomeLayout.getState();
const keys = () => [...layout().items].sort((a, b) => a.order - b.order).map((i) => i.key);

beforeEach(() => useHomeLayout.setState({ loaded: true, heroEnabled: true, items: [] }));

describe('the rows made for you, in the Home layout', () => {
  it('are all keyed the way the layout tells them apart', () => {
    expect(SMART_KEYS.every(isSmartKey)).toBe(true);
    expect(new Set(SMART_KEYS).size).toBe(SMART_KEYS.length);
    // Every key has a recipe, except the watchlist row, which reads the watchlist.
    expect(SMART_KEYS.filter((k) => !recipeFor(k))).toEqual([WATCHLIST_ROW.key]);
  });

  it('first appear in a streaming service\'s order: personal and general rows in turn', () => {
    expect(SMART_KEYS).toEqual([
      SMART.topPicks,
      SMART.because1,
      SMART.trending,
      SMART.top10Movies,
      SMART.because2,
      SMART.newReleases,
      SMART.top10Shows,
      SMART.genre1,
      SMART.because3,
      SMART.genre2,
      SMART.hiddenGems,
      SMART.watchlist,
    ]);
  });

  it('join a Home that is already laid out right after Continue Watching, in that order', () => {
    layout().ensure([CONTINUE_KEY, FOR_YOU_KEY, 'a:movie:top', 'a:series:top', 'collection_x']);
    layout().ensure([CONTINUE_KEY, FOR_YOU_KEY, ...SMART_KEYS, 'a:movie:top', 'a:series:top', 'collection_x'], SMART_KEYS);
    expect(keys()).toEqual([CONTINUE_KEY, ...SMART_KEYS, FOR_YOU_KEY, 'a:movie:top', 'a:series:top', 'collection_x']);
    expect(layout().items.filter((i) => isSmartKey(i.key)).every((i) => i.enabled)).toBe(true);
  });

  it('never feed the banner, and leave it the catalog rows it had without them', () => {
    const starred = () => layout().items.filter((i) => i.hero).map((i) => i.key);
    layout().ensure([CONTINUE_KEY, 'a:movie:top', 'a:series:top', 'a:movie:new']);
    const without = starred();
    expect(without).not.toEqual([]);

    useHomeLayout.setState({ items: [] });
    layout().ensure([CONTINUE_KEY, ...SMART_KEYS, 'a:movie:top', 'a:series:top', 'a:movie:new'], SMART_KEYS);
    expect(starred()).toEqual(without);
  });

  it('keep their place when they are switched off and on, and come back to the top on a reset', () => {
    const all = [CONTINUE_KEY, ...SMART_KEYS, 'a:movie:top'];
    layout().ensure(all, SMART_KEYS);
    layout().moveRow(SMART.hiddenGems, 1, keys());
    layout().setRow(SMART.trending, { enabled: false });
    expect(keys().slice(0, 3)).toEqual([CONTINUE_KEY, SMART.hiddenGems, SMART.topPicks]);
    // The rows going away (the master switch) and coming back changes nothing: they are not "new" again.
    layout().ensure([CONTINUE_KEY, 'a:movie:top']);
    layout().ensure(all, SMART_KEYS);
    expect(keys().slice(0, 3)).toEqual([CONTINUE_KEY, SMART.hiddenGems, SMART.topPicks]);
    expect(layout().items.find((i) => i.key === SMART.trending)!.enabled).toBe(false);

    layout().reset(all, SMART_KEYS);
    expect(keys()).toEqual([CONTINUE_KEY, ...SMART_KEYS, 'a:movie:top']);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/native', () => ({
  docs: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  secrets: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
}));

const { CONTINUE_KEY, useHomeLayout } = await import('./homeLayout');

const keys = () =>
  [...useHomeLayout.getState().items].sort((a, b) => a.order - b.order).map((i) => i.key);

beforeEach(() => useHomeLayout.setState({ loaded: true, heroEnabled: true, items: [] }));

describe('Home layout', () => {
  it('puts Continue Watching first, then pinned collections, then the rest', () => {
    useHomeLayout.getState().ensure(['a:movie:top', CONTINUE_KEY, 'collection_x'], ['collection_x']);
    expect(keys()).toEqual([CONTINUE_KEY, 'collection_x', 'a:movie:top']);
  });

  it('resets to every row that exists, switched on, in the default order', () => {
    const layout = useHomeLayout.getState();
    layout.ensure([CONTINUE_KEY, 'a:movie:top', 'collection_x'], ['collection_x']);
    layout.setRow('a:movie:top', { enabled: false, customTitle: 'Mine' });
    layout.moveRow('a:movie:top', 0, keys());
    layout.setHeroEnabled(false);

    layout.reset([CONTINUE_KEY, 'a:movie:top', 'collection_x'], ['collection_x']);
    const now = useHomeLayout.getState();
    // Not an empty Home: the rows are back at once.
    expect(keys()).toEqual([CONTINUE_KEY, 'collection_x', 'a:movie:top']);
    expect(now.items.every((i) => i.enabled && !i.customTitle)).toBe(true);
    expect(now.heroEnabled).toBe(true);
  });
});

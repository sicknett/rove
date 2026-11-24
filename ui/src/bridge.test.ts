import { describe, expect, it, vi } from 'vitest';

describe('bridge', () => {
  it('delivers every shell message to every listener', async () => {
    let shellHandler: ((m: unknown) => void) | null = null;
    vi.stubGlobal('window', { rove: { platform: 'windows', send: vi.fn(), subscribe: (fn: (m: unknown) => void) => ((shellHandler = fn), () => undefined) } });
    const { subscribe } = await import('./bridge');
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    subscribe(b);
    shellHandler!({ t: 'closing' });
    offA();
    shellHandler!({ t: 'closing' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

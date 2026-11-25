import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./native', () => ({
  NetworkError: class extends Error {},
  nativeFetch: vi.fn(async (req: { url: string }) => {
    await new Promise((r) => setTimeout(r, 20));
    return { status: 200, url: req.url, headers: {}, body: JSON.stringify({ ok: req.url }) };
  }),
}));

import { getJson } from './http';
import { nativeFetch, NetworkError } from './native';

describe('getJson', () => {
  afterEach(() => vi.mocked(nativeFetch).mockClear());

  it('shares one request, and one caller giving up does not fail the others', async () => {
    const abort = new AbortController();
    const first = getJson('https://a.example/x', { ttlMs: 1000, signal: abort.signal });
    const second = getJson('https://a.example/x', { ttlMs: 1000, signal: new AbortController().signal });
    abort.abort();
    await expect(first).rejects.toThrow();
    await expect(second).resolves.toEqual({ ok: 'https://a.example/x' });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    // Cached now.
    await expect(getJson('https://a.example/x', { ttlMs: 1000 })).resolves.toEqual({ ok: 'https://a.example/x' });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not ask again after a timeout, but does after another network failure', async () => {
    const fail = (message: string) => () => Promise.reject(new NetworkError(message, 'https://slow.example/'));
    vi.mocked(nativeFetch).mockImplementation(fail('https://slow.example/: Network Error: timed out reading response'));
    await expect(getJson('https://slow.example/')).rejects.toThrow('timed out');
    expect(nativeFetch).toHaveBeenCalledTimes(1);

    vi.mocked(nativeFetch).mockClear();
    vi.mocked(nativeFetch).mockImplementation(fail('connection reset'));
    await expect(getJson('https://flaky.example/', { retries: 1 })).rejects.toThrow('connection reset');
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });
});

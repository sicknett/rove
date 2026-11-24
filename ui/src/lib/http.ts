// JSON over the shell's fetch, with in-flight de-duplication, a memory cache, retries with
// backoff for flaky networks and rate limits, and Stremio's cacheMaxAge honoured.

import { nativeFetch, NetworkError, type NativeRequest } from './native';

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly body: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_CACHE = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface JsonOptions extends Omit<NativeRequest, 'url'> {
  /** Cache the parsed result this long (GET only). A body `cacheMaxAge` (seconds) can extend it. */
  ttlMs?: number;
  retries?: number;
  /** Key for the cache when the URL alone is not enough (e.g. it carries no auth). */
  cacheKey?: string;
  signal?: AbortSignal;
}

function retryAfterMs(headers: Record<string, string>): number | null {
  const v = headers['retry-after'];
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function requestJson<T>(url: string, opts: JsonOptions): Promise<T> {
  const retries = opts.retries ?? 2;
  let attempt = 0;
  for (;;) {
    try {
      const res = await nativeFetch({ url, method: opts.method, headers: opts.headers, body: opts.body, timeoutMs: opts.timeoutMs }, opts.signal);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = retryAfterMs(res.headers) ?? 800 * 2 ** attempt;
        if (wait <= 15000) {
          attempt++;
          await sleep(wait);
          continue;
        }
      }
      if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, url, res.body.slice(0, 400));
      if (!res.body.trim()) return null as T;
      try {
        return JSON.parse(res.body) as T;
      } catch {
        throw new HttpError(res.status, url, 'not JSON');
      }
    } catch (e) {
      if (e instanceof NetworkError && attempt < retries && !opts.signal?.aborted) {
        attempt++;
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw e;
    }
  }
}

/** Waits for `promise`, but gives up (only for this caller) when `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e) => (signal.removeEventListener('abort', onAbort), reject(e)),
    );
  });
}

export async function getJson<T>(url: string, opts: JsonOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const key = opts.cacheKey ?? url;
  if (method !== 'GET' || !opts.ttlMs) return requestJson<T>(url, opts);

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  let shared = inflight.get(key) as Promise<T> | undefined;
  if (!shared) {
    // A shared request is never cancelled by one caller: another may still want it.
    shared = requestJson<T>(url, { ...opts, signal: undefined })
      .then((value) => {
        let ttl = opts.ttlMs!;
        const maxAge = (value as { cacheMaxAge?: unknown } | null)?.cacheMaxAge;
        if (typeof maxAge === 'number' && maxAge > 0) ttl = Math.max(ttl, Math.min(maxAge * 1000, 24 * 3600 * 1000));
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
        cache.set(key, { expires: Date.now() + ttl, value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, shared);
  }
  return untilAborted(shared, opts.signal);
}

export function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/** Runs `tasks` with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

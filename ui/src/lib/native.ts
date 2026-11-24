// Calls into ROVE's shell service (shell/src/api.rs). Outside the shell (vite dev in a browser)
// requests go straight out with fetch and documents live in localStorage, so the interface can
// still be worked on, minus anything CORS blocks.

import { inShell } from '../bridge';

export interface NativeResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface NativeRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export class NetworkError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export async function nativeFetch(req: NativeRequest, signal?: AbortSignal): Promise<NativeResponse> {
  if (!inShell) {
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, url: res.url, headers, body: await res.text() };
  }
  const res = await fetch('/__api/fetch', { method: 'POST', body: JSON.stringify(req), signal });
  const data = (await res.json()) as Partial<NativeResponse> & { error?: string };
  if (data.error) throw new NetworkError(data.error, req.url);
  return data as NativeResponse;
}

async function readDoc<T>(kind: 'store' | 'secret', name: string): Promise<T | null> {
  if (!inShell) {
    try {
      const raw = localStorage.getItem(`rove.${kind}.${name}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }
  const res = await fetch(`/__api/${kind}/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not read ${name} (${res.status})`);
  return (await res.json()) as T;
}

let frozen = false;

/** After a backup restore, until the page reloads: ignore every save. */
export function freezeWrites() {
  frozen = true;
}

async function writeDoc(kind: 'store' | 'secret', name: string, value: unknown): Promise<void> {
  if (frozen) return;
  const body = JSON.stringify(value);
  if (!inShell) {
    try {
      localStorage.setItem(`rove.${kind}.${name}`, body);
    } catch {
      /* storage full or blocked: lasts for this run only */
    }
    return;
  }
  const res = await fetch(`/__api/${kind}/${encodeURIComponent(name)}`, { method: 'PUT', body });
  if (!res.ok) throw new Error(`could not save ${name} (${res.status})`);
}

async function deleteDoc(kind: 'store' | 'secret', name: string): Promise<void> {
  if (frozen) return;
  if (!inShell) {
    localStorage.removeItem(`rove.${kind}.${name}`);
    return;
  }
  await fetch(`/__api/${kind}/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export const docs = {
  read: <T>(name: string) => readDoc<T>('store', name),
  write: (name: string, value: unknown) => writeDoc('store', name, value),
  remove: (name: string) => deleteDoc('store', name),
};

/** Encrypted for this Windows user: addon links, API keys. */
export const secrets = {
  read: <T>(name: string) => readDoc<T>('secret', name),
  write: (name: string, value: unknown) => writeDoc('secret', name, value),
  remove: (name: string) => deleteDoc('secret', name),
};

/**
 * Saves a document at most once per `delayMs`, always writing the latest value; `flush` writes
 * now (used before the app closes or a profile switches).
 */
export function debouncedWriter(write: (value: unknown) => Promise<void>, delayMs = 600) {
  let timer: number | undefined;
  let pending: { value: unknown } | null = null;
  let last: Promise<void> = Promise.resolve();
  const run = (): Promise<void> => {
    timer = undefined;
    if (!pending) return last;
    const { value } = pending;
    pending = null;
    last = write(value).catch((e) => console.error('save failed', e));
    return last;
  };
  return {
    save(value: unknown) {
      pending = { value };
      if (timer === undefined) timer = window.setTimeout(run, delayMs);
    },
    /** Writes anything pending now; resolves when it is on disk. */
    flush(): Promise<void> {
      if (timer !== undefined) window.clearTimeout(timer);
      return run();
    },
  };
}


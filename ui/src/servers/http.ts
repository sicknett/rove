// HTTP for media servers (through the shell, so LAN servers and self-signed setups behave like
// any other request), plus ROVE's per-install device id that servers list sessions under.

import { docs, nativeFetch, NetworkError } from '../lib/native';

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

export interface ServerRequest {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  headers?: Record<string, string>;
  json?: unknown;
  timeoutMs?: number;
  /** Name used in error messages. */
  service?: string;
}

export async function serverFetch<T = unknown>(req: ServerRequest): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  let body: string | undefined;
  if (req.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.json);
  }
  const name = req.service ?? 'The server';
  let res;
  try {
    res = await nativeFetch({ url: req.url, method: req.method ?? 'GET', headers, body, timeoutMs: req.timeoutMs ?? 20000 });
  } catch (e) {
    throw new ServerError(e instanceof NetworkError && /timed? ?out/i.test(e.message) ? `${name} took too long to answer.` : `${name} could not be reached.`);
  }
  if (res.status === 401 || res.status === 403) throw new ServerError(`${name} did not accept the sign-in.`, res.status);
  if (res.status >= 400) throw new ServerError(`${name} answered HTTP ${res.status}.`, res.status);
  const text = res.body.trim();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Without a trailing slash; http:// added when no scheme was typed. */
export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

let deviceId: string | null = null;

export async function roveDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  const saved = await docs.read<{ id: string }>('device').catch(() => null);
  if (saved?.id) return (deviceId = saved.id);
  const id = `rove-${crypto.randomUUID()}`;
  await docs.write('device', { id }).catch(() => undefined);
  return (deviceId = id);
}

/** Memoised per key for `ttlMs`; failures are not cached. */
export function cached<T>(ttlMs: number) {
  const store = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = load();
    store.set(key, { at: Date.now(), value });
    value.catch(() => store.delete(key));
    return value;
  };
}

export const sizeLabel = (bytes?: number) => {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};

export function resolutionLabel(width?: number, height?: number): string {
  const w = width ?? 0;
  const h = height ?? 0;
  if (w >= 3200 || h >= 2000) return '4K';
  if (w >= 1800 || h >= 1000) return '1080p';
  if (w >= 1200 || h >= 700) return '720p';
  if (h > 0) return `${h}p`;
  return '';
}

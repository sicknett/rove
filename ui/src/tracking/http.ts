// HTTP for trackers: JSON or form bodies, errors mapped to TrackerError, Retry-After honoured,
// and writes spaced out where a service limits them (Trakt allows one write per second).

import { nativeFetch, NetworkError } from '../lib/native';
import { TrackerError } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastWrite = new Map<string, number>();

export interface TrackerRequest {
  service: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  /** Minimum gap between writes to this service, ms. */
  writeGapMs?: number;
}

export interface TrackerResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export async function trackerFetch<T = unknown>(req: TrackerRequest): Promise<TrackerResponse<T>> {
  const write = req.method !== 'GET';
  if (write && req.writeGapMs) {
    const wait = req.writeGapMs - (Date.now() - (lastWrite.get(req.service) ?? 0));
    if (wait > 0) await sleep(wait);
    lastWrite.set(req.service, Date.now());
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  let body: string | undefined;
  if (req.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.json);
  } else if (req.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(req.form).toString();
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await nativeFetch({ url: req.url, method: req.method, headers, body, timeoutMs: 30000 });
    } catch (e) {
      if (e instanceof NetworkError && attempt < 2) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw new TrackerError('retry', `Could not reach ${req.service}.`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const ra = Number(res.headers['retry-after']);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** attempt;
      if (wait <= 20000) {
        await sleep(wait);
        continue;
      }
      throw new TrackerError('retry', `${req.service} asked to slow down.`, res.status, Date.now() + wait);
    }
    let data: unknown = null;
    if (res.body.trim()) {
      try {
        data = JSON.parse(res.body);
      } catch {
        data = res.body;
      }
    }
    if (res.status === 401 || res.status === 403) throw new TrackerError('unauthorized', `${req.service} did not accept the sign-in.`, res.status);
    if (res.status === 429 || res.status >= 500) throw new TrackerError('retry', `${req.service} answered HTTP ${res.status}.`, res.status);
    if (res.status >= 400) {
      const err = new TrackerError('rejected', `${req.service} refused it (HTTP ${res.status}).`, res.status);
      (err as TrackerError & { data?: unknown }).data = data;
      throw err;
    }
    // What is read from a tracker is JSON. Anything else with a 2xx is some gateway's page, and
    // taking it for "nothing there" would look like the history had been deleted.
    if (req.method === 'GET' && typeof data === 'string') throw new TrackerError('retry', `${req.service} sent an answer that could not be read.`, res.status);
    return { status: res.status, data: data as T, headers: res.headers };
  }
}

/** A list a tracker was asked for. Anything but an array (an error object, an empty body) is a failed read, never an empty list. */
export function listOf<T>(data: T[] | null | undefined, service: string): T[] {
  if (Array.isArray(data)) return data;
  throw new TrackerError('retry', `${service} sent an answer that could not be read.`);
}

/**
 * Resume points go to Trakt, Simkl and MDBList as a "pause" at a percentage, capped here: past
 * 80 % those services may count a scrobble as watched. Whether a pause really does has not been
 * checked against each API, so the cap stays; a position pulled back at the cap is recognised as
 * ours (PullResult.resumeCap) instead of replacing the exact local one.
 */
export const SCROBBLE_CAP_PERCENT = 79;

/** External ids for a title as trackers want them. */
export function idsFor(metaId: string, tmdbId?: number): { imdb?: string; tmdb?: number } {
  const base = metaId.split(':').length > 1 && /^tmdb:/i.test(metaId) ? metaId : metaId.split(':')[0];
  const out: { imdb?: string; tmdb?: number } = {};
  if (/^tt\d+$/.test(base)) out.imdb = base;
  const tm = /^tmdb:(\d+)/i.exec(metaId);
  if (tm) out.tmdb = Number(tm[1]);
  else if (tmdbId) out.tmdb = tmdbId;
  return out;
}

/** ROVE's id for a title a tracker returned: IMDb first, else TMDB. Null when neither. */
export function metaIdFromIds(ids: Record<string, unknown> | undefined): string | null {
  if (!ids) return null;
  const imdb = (ids.imdb ?? ids.imdbid ?? ids.imdb_id) as string | undefined;
  if (typeof imdb === 'string' && /^tt\d+$/.test(imdb)) return imdb;
  const tmdb = Number(ids.tmdb ?? ids.tmdbid ?? ids.tmdb_id);
  if (Number.isFinite(tmdb) && tmdb > 0) return `tmdb:${tmdb}`;
  return null;
}

export function tmdbFromIds(ids: Record<string, unknown> | undefined): number | undefined {
  const n = Number(ids?.tmdb ?? ids?.tmdbid ?? ids?.tmdb_id);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const timeOf = (s: unknown) => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
};

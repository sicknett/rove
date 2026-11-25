// PublicMetaDB external API (https://publicmetadb.com/api/external, Bearer API key).
// Requests go one at a time with a short gap; 429/5xx honour Retry-After; network errors retry.

import { nativeFetch, NetworkError } from '../lib/native';

const BASE = 'https://publicmetadb.com/api/external';
const MIN_GAP_MS = 60;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export class PmdbError extends Error {
  constructor(readonly status: number, readonly body = '', readonly retryAt?: number) {
    super(`PublicMetaDB request failed (HTTP ${status})`);
    this.name = 'PmdbError';
  }
  get unauthorized() {
    return this.status === 401 || this.status === 403;
  }
  get conflict() {
    return this.status === 409;
  }
}

export interface PmdbPage<T> {
  items: T[];
  total?: number;
  page?: number;
  perPage?: number;
  totalPages?: number;
}

export interface PmdbResume {
  id: string;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  season?: number | null;
  episode?: number | null;
  position_ms: number;
  runtime_ms: number;
  progress?: number;
  created?: string;
  updated?: string;
  title?: string;
  poster?: string;
}

export interface PmdbWatched {
  id?: string;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  season?: number | null;
  episode?: number | null;
  watched_at?: string;
}

export interface PmdbTarget {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  season?: number;
  episode?: number;
}

export interface PmdbList {
  id: string;
  name?: string;
  description?: string;
  is_public?: boolean;
  type?: 'watchlist' | 'custom' | string;
  item_count?: number;
}

export interface PmdbListItem {
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  added_at?: string;
  title?: string;
  poster?: string;
}

/** One community skip record; every time is milliseconds and may be null. */
export interface PmdbSkip {
  intro_start_ms?: number | null;
  intro_end_ms?: number | null;
  credits_start_ms?: number | null;
  credits_end_ms?: number | null;
  source?: string;
}

/**
 * PublicMetaDB timestamps are not uniformly ISO-8601: a space can replace `T`, the zone can be
 * missing (read as UTC), or they arrive as epoch seconds/milliseconds. Null when unusable.
 */
export function parsePmdbTime(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return text.length >= 13 ? n : n * 1000;
  }
  let iso = text.replace(' ', 'T');
  if (iso.length === 10) iso += 'T00:00:00Z';
  if (iso.length < 12 || iso[10] !== 'T') return null;
  const time = iso.slice(11);
  if (!/[zZ]$|[+-]\d\d(:?\d\d)?$/.test(time)) iso += 'Z';
  const ms = Date.parse(iso.replace('z', 'Z'));
  return Number.isFinite(ms) ? ms : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

/** Serialises requests with a minimum gap, the way the API's per-IP limits want. */
function gated<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

async function request(apiKey: string, method: 'GET' | 'POST' | 'DELETE', path: string, query: Record<string, string | number> = {}, body?: unknown): Promise<string> {
  if (!apiKey) throw new PmdbError(401, 'no key');
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  let attempt = 0;
  let netFailures = 0;
  for (;;) {
    let res;
    try {
      res = await gated(() =>
        nativeFetch({
          url,
          method,
          headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          timeoutMs: 30000,
        }),
      );
    } catch (e) {
      if (e instanceof NetworkError && netFailures < 3) {
        netFailures++;
        await sleep(500 * 2 ** (netFailures - 1));
        continue;
      }
      throw e;
    }
    if (RETRY_STATUSES.has(res.status) && attempt < 3) {
      const ra = Number(res.headers['retry-after']);
      const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt;
      if (backoff > 15000) throw new PmdbError(res.status, res.body.slice(0, 300), Date.now() + backoff);
      await sleep(backoff);
      attempt++;
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new PmdbError(res.status, res.body.slice(0, 300));
    return res.body;
  }
}

const parse = <T>(text: string, fallback: T): T => {
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/**
 * A page of the user's history. Anything but a JSON object with an `items` list is a failed
 * request (a gateway's error page, a cut-off body): reading it as "no items" would make the
 * sync believe the history was deleted.
 */
function parsePage<T>(text: string): PmdbPage<T> {
  let page: unknown;
  try {
    page = JSON.parse(text);
  } catch {
    throw new PmdbError(502, 'not JSON');
  }
  const items = Array.isArray(page) ? page : (page as PmdbPage<T> | null)?.items;
  if (!Array.isArray(items)) throw new PmdbError(502, 'no item list');
  return Array.isArray(page) ? { items } : { ...(page as PmdbPage<T>), items };
}

export const pmdb = {
  async validate(apiKey: string): Promise<boolean> {
    try {
      await request(apiKey, 'GET', '/lists', { page: 1, perPage: 1 });
      return true;
    } catch (e) {
      if (e instanceof PmdbError && e.unauthorized) return false;
      throw e;
    }
  },

  async resumePage(apiKey: string, page: number, perPage = 100) {
    return parsePage<PmdbResume>(await request(apiKey, 'GET', '/resume', { page, perPage }));
  },

  async watchedPage(apiKey: string, page: number, perPage = 100) {
    return parsePage<PmdbWatched>(await request(apiKey, 'GET', '/watched', { page, perPage }));
  },

  async saveResume(apiKey: string, t: PmdbTarget, positionMs: number, runtimeMs: number) {
    const movie = t.mediaType === 'movie';
    const body = {
      tmdb_id: t.tmdbId,
      media_type: t.mediaType,
      season: movie ? 0 : t.season ?? 0,
      episode: movie ? 0 : t.episode ?? 0,
      position_ms: Math.round(positionMs),
      runtime_ms: Math.round(runtimeMs),
    };
    return parse<{ action?: string; reason?: string }>(await request(apiKey, 'POST', '/resume', {}, body), {});
  },

  async deleteResume(apiKey: string, id: string) {
    await request(apiKey, 'DELETE', `/resume/${encodeURIComponent(id)}`);
  },

  async markWatched(apiKey: string, t: PmdbTarget, at: number) {
    const body: Record<string, unknown> = { tmdb_id: t.tmdbId, media_type: t.mediaType, watched_at: new Date(at).toISOString() };
    if (t.mediaType === 'tv') {
      body.season = t.season ?? 0;
      body.episode = t.episode ?? 0;
    }
    await request(apiKey, 'POST', '/watched', {}, body);
  },

  async unmarkWatched(apiKey: string, t: PmdbTarget) {
    const q: Record<string, string | number> = { tmdb_id: t.tmdbId, media_type: t.mediaType };
    if (t.mediaType === 'tv') {
      if (t.season !== undefined) q.season = t.season;
      if (t.episode !== undefined) q.episode = t.episode;
    }
    try {
      await request(apiKey, 'DELETE', '/watched', q);
    } catch (e) {
      if (!(e instanceof PmdbError && e.status === 404)) throw e;
    }
  },

  async lists(apiKey: string): Promise<PmdbList[]> {
    const res = parse<{ lists?: PmdbList[]; items?: PmdbList[] } | PmdbList[] | null>(await request(apiKey, 'GET', '/lists', { page: 1, perPage: 100 }), null);
    const lists = Array.isArray(res) ? res : res?.lists ?? res?.items;
    if (!Array.isArray(lists)) throw new PmdbError(502, 'no lists');
    return lists;
  },

  /** Every item of a list. Throws rather than return part of it. */
  async listItems(apiKey: string, listId: string): Promise<PmdbListItem[]> {
    const out: PmdbListItem[] = [];
    for (let page = 1; page <= 20; page++) {
      const { items } = parsePage<PmdbListItem>(await request(apiKey, 'GET', `/lists/${encodeURIComponent(listId)}/items`, { page, perPage: 500 }));
      out.push(...items);
      if (items.length < 500) return out;
    }
    throw new PmdbError(502, 'list too long');
  },

  async addListItem(apiKey: string, listId: string, tmdbId: number, mediaType: 'movie' | 'tv') {
    await request(apiKey, 'POST', `/lists/${encodeURIComponent(listId)}/items`, {}, { tmdb_id: tmdbId, media_type: mediaType });
  },

  /** Items are removed by their TMDB id. */
  async removeListItem(apiKey: string, listId: string, tmdbId: number) {
    try {
      await request(apiKey, 'DELETE', `/lists/${encodeURIComponent(listId)}/items/${tmdbId}`);
    } catch (e) {
      if (!(e instanceof PmdbError && e.status === 404)) throw e;
    }
  },

  async skips(apiKey: string, t: PmdbTarget): Promise<PmdbSkip[]> {
    const q: Record<string, string | number> = { tmdb_id: t.tmdbId, media_type: t.mediaType };
    if (t.mediaType === 'tv') {
      q.season = t.season ?? 1;
      q.episode = t.episode ?? 1;
    }
    try {
      const res = parse<{ skip_timestamps?: PmdbSkip[] }>(await request(apiKey, 'GET', '/skips', q), {});
      return res.skip_timestamps ?? [];
    } catch {
      return [];
    }
  },

  /** imdb/tvdb/mal/anilist/kitsu id -> TMDB id. */
  async lookupTmdb(apiKey: string, idType: string, idValue: string): Promise<{ id: number; mediaType?: 'movie' | 'tv' } | null> {
    try {
      const text = await request(apiKey, 'GET', '/mappings/lookup', { id_type: idType, id_value: idValue });
      return findTmdbId(parse(text, null));
    } catch (e) {
      if (e instanceof PmdbError && e.status === 404) return null;
      throw e;
    }
  },

  async imdbFor(apiKey: string, tmdbId: number, mediaType: 'movie' | 'tv'): Promise<string | null> {
    try {
      const text = await request(apiKey, 'GET', '/mappings', { tmdb_id: tmdbId, media_type: mediaType });
      return findImdbId(parse(text, null));
    } catch (e) {
      if (e instanceof PmdbError && e.status === 404) return null;
      throw e;
    }
  },
};

/** Finds a TMDB id (and media type if present) anywhere in a mapping payload of loose shape. */
export function findTmdbId(v: unknown, depth = 0): { id: number; mediaType?: 'movie' | 'tv' } | null {
  if (v === null || v === undefined || depth > 4) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findTmdbId(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(o)) {
      if (/^(tmdb_id|themoviedb_id)$/i.test(k) && Number(val) > 0) {
        const t = (o.media_type ?? o.mediaType) as string | undefined;
        return { id: Number(val), mediaType: t === 'movie' || t === 'tv' ? t : undefined };
      }
    }
    for (const val of Object.values(o)) {
      const r = findTmdbId(val, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

export function findImdbId(v: unknown, depth = 0): string | null {
  if (v === null || v === undefined || depth > 4) return null;
  const isImdb = (s: unknown): s is string => typeof s === 'string' && /^tt\d+$/.test(s);
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findImdbId(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.id_type === 'string' && /imdb/i.test(o.id_type) && isImdb(o.id_value)) return o.id_value;
    for (const [k, val] of Object.entries(o)) if (/imdb/i.test(k) && isImdb(val)) return val;
    for (const val of Object.values(o)) {
      const r = findImdbId(val, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

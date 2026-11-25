// IMDb <-> TMDB id mapping, remembered on disk. Addons speak IMDb ids; PublicMetaDB speaks TMDB.
// TMDB's /find answers first when a TMDB key is set; PublicMetaDB's own mappings otherwise.
//
// History is kept under one id per title: the IMDb id whenever this map knows it (canonicalNow,
// canonicalId), the id as given otherwise. Only mappings that were found are remembered. A
// lookup that failed or found nothing is asked again later: a title stuck on its `tmdb:` id
// never lines up with the cards addons send.

import { useSyncExternalStore } from 'react';
import { episodeId, isImdbId, parseId, tmdbTitleNumber } from '../addons/ids';
import { debouncedWriter, docs } from '../lib/native';
import { externalIds, findByImdb, hasTmdb } from '../meta/tmdb';
import { pmdb } from './pmdb';

type Kind = 'movie' | 'tv';
type TitleType = 'movie' | 'series';

export interface TmdbRef {
  id: number;
  kind: Kind;
}

interface IdMapDoc {
  /** "movie:603" -> "tt0133093" */
  toImdb: Record<string, string>;
  /** "tt0133093" -> { id, kind } */
  toTmdb: Record<string, TmdbRef>;
}

/** Both services answered and neither knows the title: ask again after this long. */
const NOT_FOUND_RETRY_MS = 6 * 3600 * 1000;
/** A lookup failed (offline, rate limit, server error): ask again after this long. */
const FAILED_RETRY_MS = 60 * 1000;
/** Id namespaces PublicMetaDB can map to TMDB. */
const PMDB_NAMESPACES = new Set(['imdb', 'tvdb', 'mal', 'anilist', 'kitsu']);

let doc: IdMapDoc = { toImdb: {}, toTmdb: {} };
let loading: Promise<void> | null = null;
/** The profile's PublicMetaDB key, when it has one: used when a caller passes none. */
let mappingKey: string | null = null;
/** Lookups that came back empty, by key, with the time they may be tried again. Never saved. */
const misses = new Map<string, number>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
const writer = debouncedWriter((v) => docs.write('idmap', v), 2000);

const kindOf = (type: TitleType): Kind => (type === 'movie' ? 'movie' : 'tv');

export function loadIdMap(): Promise<void> {
  loading ??= (async () => {
    const stored = await docs.read<{ toImdb?: Record<string, string | null>; toTmdb?: Record<string, TmdbRef | null> }>('idmap').catch(() => null);
    // Files from before kept "known to have none" as null. Those are unknown now, and asked again.
    const keep = <T>(map: Record<string, T | null> | undefined) => Object.fromEntries(Object.entries(map ?? {}).filter(([, v]) => v !== null && v !== undefined)) as Record<string, T>;
    doc = { toImdb: { ...keep(stored?.toImdb), ...doc.toImdb }, toTmdb: { ...keep(stored?.toTmdb), ...doc.toTmdb } };
    listeners.forEach((l) => l());
  })();
  return loading;
}

/** The PublicMetaDB key lookups fall back to (set by the tracker store for the active profile). */
export function setIdMapKey(key: string | null) {
  mappingKey = key;
}

/** Calls `fn` whenever a mapping is learned; returns the way to stop. */
export function onIdMapChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Records that an IMDb id and a TMDB title are the same thing. */
export function rememberMapping(imdb: string, tmdb: TmdbRef) {
  if (!isImdbId(imdb) || !(tmdb.id > 0)) return;
  const key = `${tmdb.kind}:${tmdb.id}`;
  let learned = false;
  // The first answer stays: an episode's own IMDb id can lead to the show's TMDB id too.
  if (!doc.toImdb[key]) {
    doc.toImdb[key] = imdb;
    learned = true;
  }
  if (!doc.toTmdb[imdb]) {
    doc.toTmdb[imdb] = tmdb;
    learned = true;
  }
  if (!learned) return;
  writer.save(doc);
  listeners.forEach((l) => l());
}

export function flushIdMap() {
  return writer.flush();
}

function missed(key: string) {
  const until = misses.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  misses.delete(key);
  return false;
}

/** One lookup per key at a time: a pull and a screen asking for the same title share it. */
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** TMDB id for an addon id (`tt…`, `tmdb:…`, `kitsu:…`), or null when nothing maps it (yet). */
export async function tmdbFor(metaId: string, type: TitleType, apiKey?: string | null): Promise<TmdbRef | null> {
  await loadIdMap();
  const base = parseId(metaId).base;
  const tm = /^tmdb:(\d+)$/i.exec(base);
  if (tm) return { id: Number(tm[1]), kind: kindOf(type) };
  if (doc.toTmdb[base]) return doc.toTmdb[base];
  const imdb = isImdbId(base);
  const [ns, value] = imdb ? ['imdb', base] : base.split(':');
  const key = apiKey ?? mappingKey;
  const viaTmdb = imdb && hasTmdb();
  const viaPmdb = !!key && !!value && PMDB_NAMESPACES.has(ns);
  if (!viaTmdb && !viaPmdb) return null;
  const missKey = `tmdb<${base}`;
  if (missed(missKey)) return null;
  return once(missKey, async () => {
    let found: TmdbRef | null = null;
    // A request that fails says nothing about the title: it is asked again soon. Only an
    // answer of "no such title" from every service that could be asked rests for hours.
    let failed = false;
    if (viaTmdb) {
      try {
        found = await findByImdb(base);
      } catch {
        failed = true;
      }
    }
    if (!found && viaPmdb) {
      try {
        const r = await pmdb.lookupTmdb(key!, ns, value);
        if (r) found = { id: r.id, kind: r.mediaType ?? kindOf(type) };
      } catch {
        failed = true;
      }
    }
    if (!found) {
      misses.set(missKey, Date.now() + (failed ? FAILED_RETRY_MS : NOT_FOUND_RETRY_MS));
      return null;
    }
    if (imdb) rememberMapping(base, found);
    else if (!doc.toTmdb[base]) {
      doc.toTmdb[base] = found;
      writer.save(doc);
    }
    return found;
  });
}

/** The id addons know a TMDB title by: IMDb when it maps, `tmdb:<id>` otherwise. */
export async function metaIdFor(tmdbId: number, kind: Kind, apiKey?: string | null): Promise<string> {
  await loadIdMap();
  const mapKey = `${kind}:${tmdbId}`;
  const fallback = `tmdb:${tmdbId}`;
  if (doc.toImdb[mapKey]) return doc.toImdb[mapKey];
  const key = apiKey ?? mappingKey;
  const viaTmdb = hasTmdb();
  if (!viaTmdb && !key) return fallback;
  const missKey = `imdb<${mapKey}`;
  if (missed(missKey)) return fallback;
  return once(missKey, async () => {
    let imdb: string | null = null;
    let failed = false;
    if (viaTmdb) {
      try {
        const ids = await externalIds(kind, tmdbId);
        if (ids?.imdb_id && isImdbId(ids.imdb_id)) imdb = ids.imdb_id;
      } catch {
        failed = true;
      }
    }
    if (!imdb && key) {
      try {
        imdb = await pmdb.imdbFor(key, tmdbId, kind);
      } catch {
        failed = true;
      }
    }
    if (!imdb) {
      misses.set(missKey, Date.now() + (failed ? FAILED_RETRY_MS : NOT_FOUND_RETRY_MS));
      return fallback;
    }
    rememberMapping(imdb, { id: tmdbId, kind });
    // rememberMapping keeps an earlier answer for this TMDB title, if there was one.
    return doc.toImdb[mapKey] ?? imdb;
  });
}

/**
 * The id history is kept under, from what is known right now (no request): the IMDb id for a
 * `tmdb:<n>` title the map knows, the id itself for everything else. Movie 693 and show 693
 * are different TMDB titles, hence the type.
 */
export function canonicalNow(metaId: string, type: TitleType): string {
  const n = tmdbTitleNumber(metaId);
  if (n === null) return metaId;
  return doc.toImdb[`${kindOf(type)}:${n}`] ?? `tmdb:${n}`;
}

/**
 * The same, asking TMDB or PublicMetaDB when the map does not know yet. Never fails: without a
 * mapping (or after `timeoutMs`, while the lookup carries on) the id comes back as given.
 */
export async function canonicalId(metaId: string, type: TitleType, opts: { apiKey?: string | null; timeoutMs?: number } = {}): Promise<string> {
  const n = tmdbTitleNumber(metaId);
  if (n === null) return metaId;
  const lookup = metaIdFor(n, kindOf(type), opts.apiKey).catch(() => `tmdb:${n}`);
  if (!opts.timeoutMs) return lookup;
  return Promise.race([lookup, new Promise<string>((resolve) => setTimeout(() => resolve(canonicalNow(metaId, type)), opts.timeoutMs))]);
}

/**
 * The same title or video under the other id family (`tmdb:…` <-> IMDb), episode parts kept.
 * For addons that accept only one of the two. Null when the title does not map.
 */
export async function alternateId(id: string, type: TitleType, apiKey?: string | null): Promise<string | null> {
  const p = parseId(id);
  const n = tmdbTitleNumber(p.base);
  let other: string | null = null;
  if (n !== null) {
    const imdb = await metaIdFor(n, kindOf(type), apiKey).catch(() => '');
    if (isImdbId(imdb)) other = imdb;
  } else if (isImdbId(p.base)) {
    const ref = await tmdbFor(p.base, type, apiKey).catch(() => null);
    if (ref) other = `tmdb:${ref.id}`;
  }
  if (!other) return null;
  if (p.season !== undefined && p.episode !== undefined) return episodeId(other, p.season, p.episode);
  return p.episode !== undefined ? `${other}:${p.episode}` : other;
}

/** canonicalNow for a component: re-renders when the mapping is learned. */
export function useCanonicalId(metaId: string, type: TitleType): string {
  return useSyncExternalStore(onIdMapChange, () => canonicalNow(metaId, type));
}

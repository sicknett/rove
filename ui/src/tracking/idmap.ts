// IMDb <-> TMDB id mapping, remembered on disk. Addons speak IMDb ids; PublicMetaDB speaks TMDB.
// TMDB's /find answers first when a TMDB key is set; PublicMetaDB's own mappings otherwise.

import { parseId } from '../addons/ids';
import { debouncedWriter, docs } from '../lib/native';
import { externalIds, findByImdb, hasTmdb } from '../meta/tmdb';
import { pmdb } from './pmdb';

interface IdMapDoc {
  /** "movie:603" -> "tt0133093" (null: known to have none) */
  toImdb: Record<string, string | null>;
  /** "tt0133093" -> { id, kind } */
  toTmdb: Record<string, { id: number; kind: 'movie' | 'tv' } | null>;
}

let doc: IdMapDoc = { toImdb: {}, toTmdb: {} };
let loaded = false;
const writer = debouncedWriter((v) => docs.write('idmap', v), 2000);

export async function loadIdMap() {
  if (loaded) return;
  const stored = await docs.read<IdMapDoc>('idmap').catch(() => null);
  doc = { toImdb: stored?.toImdb ?? {}, toTmdb: stored?.toTmdb ?? {} };
  loaded = true;
}

function remember(imdb: string | null, tmdb: { id: number; kind: 'movie' | 'tv' } | null, tmdbKey?: string) {
  if (tmdbKey) doc.toImdb[tmdbKey] = imdb;
  if (imdb) doc.toTmdb[imdb] = tmdb;
  writer.save(doc);
}

export function flushIdMap() {
  return writer.flush();
}

/** TMDB id for an addon id (`tt…`, `tmdb:…`, `kitsu:…`), or null when nothing maps it. */
export async function tmdbFor(metaId: string, type: 'movie' | 'series', apiKey?: string | null): Promise<{ id: number; kind: 'movie' | 'tv' } | null> {
  await loadIdMap();
  const base = parseId(metaId).base;
  const tm = /^tmdb:(\d+)$/i.exec(base);
  if (tm) return { id: Number(tm[1]), kind: type === 'movie' ? 'movie' : 'tv' };
  if (base in doc.toTmdb) return doc.toTmdb[base];
  let found: { id: number; kind: 'movie' | 'tv' } | null = null;
  if (/^tt\d+$/.test(base) && hasTmdb()) found = await findByImdb(base).catch(() => null);
  if (!found && apiKey) {
    const [ns, value] = base.includes(':') ? base.split(':') : ['imdb', base];
    const r = await pmdb.lookupTmdb(apiKey, ns === 'tt' ? 'imdb' : ns, value).catch(() => null);
    if (r) found = { id: r.id, kind: r.mediaType ?? (type === 'movie' ? 'movie' : 'tv') };
  }
  if (found || /^tt\d+$/.test(base)) remember(base, found);
  return found;
}

/** The id addons know a TMDB title by: IMDb when it maps, `tmdb:<id>` otherwise. */
export async function metaIdFor(tmdbId: number, kind: 'movie' | 'tv', apiKey?: string | null): Promise<string> {
  await loadIdMap();
  const key = `${kind}:${tmdbId}`;
  const known = doc.toImdb[key];
  if (known) return known;
  if (known === null) return `tmdb:${tmdbId}`;
  let imdb: string | null = null;
  if (hasTmdb()) imdb = (await externalIds(kind, tmdbId).catch(() => null))?.imdb_id ?? null;
  if (!imdb && apiKey) imdb = await pmdb.imdbFor(apiKey, tmdbId, kind).catch(() => null);
  remember(imdb, imdb ? { id: tmdbId, kind } : null, key);
  return imdb ?? `tmdb:${tmdbId}`;
}

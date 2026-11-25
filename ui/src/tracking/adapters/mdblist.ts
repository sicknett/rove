// MDBList (api.mdblist.com): API key; watched history, playback progress and watchlist.
// The sync endpoints are marked beta by MDBList, so responses are read defensively.

import { watchKey } from '../../addons/ids';
import type { ProgressEntry, WatchedEntry } from '../../state/history';
import { idsFor, metaIdFromIds, SCROBBLE_CAP_PERCENT, timeOf, tmdbFromIds, trackerFetch } from '../http';
import { TrackerError, type PullResult, type TitleRef, type TrackerAccount, type TrackerAdapter, type WatchlistEntry } from '../types';

const API = 'https://api.mdblist.com';
type Ids = Record<string, unknown>;

function call<T>(account: TrackerAccount, method: 'GET' | 'POST', path: string, json?: unknown) {
  if (!account.apiKey) throw new TrackerError('unauthorized', 'No MDBList key');
  const sep = path.includes('?') ? '&' : '?';
  return trackerFetch<T>({ service: 'MDBList', method, url: `${API}${path}${sep}apikey=${encodeURIComponent(account.apiKey)}`, json, writeGapMs: 300 });
}

export async function mdblistValidate(apiKey: string): Promise<boolean> {
  try {
    await call({ provider: 'mdblist', apiKey }, 'GET', '/sync/last_activities');
    return true;
  } catch (e) {
    if (e instanceof TrackerError && e.kind === 'unauthorized') return false;
    throw e;
  }
}

const playbackIds = new Map<string, number>();

/** Episode payload in MDBList's shape: the episode nests inside the show. */
function scrobbleBody(t: { metaId: string; type: 'movie' | 'series'; season?: number; episode?: number; tmdbId?: number }) {
  const ids = idsFor(t.metaId, t.tmdbId);
  if (!ids.imdb && !ids.tmdb) return null;
  if (t.type === 'movie') return { movie: { ids } };
  return { show: { ids, season: { number: t.season ?? 1, episode: { number: t.episode ?? 1 } } } };
}

function watchedBody(t: { metaId: string; type: 'movie' | 'series'; season?: number; episode?: number; tmdbId?: number }, at?: number) {
  const ids = idsFor(t.metaId, t.tmdbId);
  if (!ids.imdb && !ids.tmdb) return null;
  const watched_at = at ? new Date(at).toISOString() : undefined;
  if (t.type === 'movie') return { movies: [{ ids, ...(watched_at ? { watched_at } : {}) }] };
  return { shows: [{ ids, seasons: [{ number: t.season ?? 1, episodes: [{ number: t.episode ?? 1, ...(watched_at ? { watched_at } : {}) }] }] }] };
}

interface WatchedPage {
  movies?: { last_watched_at?: string; movie?: { ids?: Ids } }[];
  episodes?: { last_watched_at?: string; watched_at?: string; episode?: { season?: number; number?: number; season_number?: number; episode_number?: number; ids?: Ids }; show?: { ids?: Ids } }[];
  pagination?: { has_more?: boolean };
}

export const mdblistAdapter: TrackerAdapter = {
  id: 'mdblist',
  name: 'MDBList',

  async pull(account) {
    const incomplete: NonNullable<PullResult['incomplete']> = [];
    const watched: WatchedEntry[] = [];
    const MAX_PAGES = 20;
    for (let offset = 0, page = 0; page < MAX_PAGES; page++) {
      const { data } = await call<WatchedPage>(account, 'GET', `/sync/watched?limit=5000&offset=${offset}`);
      // An empty body is a failed read, not an empty history.
      if (!data || typeof data !== 'object') throw new TrackerError('retry', 'MDBList sent an answer that could not be read.');
      for (const m of data?.movies ?? []) {
        const metaId = metaIdFromIds(m.movie?.ids);
        if (metaId) watched.push({ key: metaId, metaId, type: 'movie', at: timeOf(m.last_watched_at), tmdbId: tmdbFromIds(m.movie?.ids), synced: true });
      }
      for (const e of data?.episodes ?? []) {
        const metaId = metaIdFromIds(e.show?.ids);
        const season = e.episode?.season ?? e.episode?.season_number;
        const number = e.episode?.number ?? e.episode?.episode_number;
        if (!metaId || season === undefined || number === undefined) continue;
        watched.push({ key: watchKey(metaId, season, number), metaId, type: 'series', season, episode: number, at: timeOf(e.last_watched_at ?? e.watched_at), tmdbId: tmdbFromIds(e.show?.ids), synced: true });
      }
      const got = (data?.movies?.length ?? 0) + (data?.episodes?.length ?? 0);
      if (!data?.pagination?.has_more || !got) break;
      offset += got;
      // More to come than this reads: what is missing from the list is not missing from the account.
      if (page === MAX_PAGES - 1) incomplete.push('watched');
    }

    playbackIds.clear();
    const progress: ProgressEntry[] = [];
    // Without the playback list the rest still syncs; local resume points are then left alone.
    const playback = await call<{ id: number; progress: number; paused_at?: string; type: string; movie?: { ids?: Ids; title?: string }; show?: { ids?: Ids; title?: string }; episode?: { season?: number; number?: number } }[]>(account, 'GET', '/sync/playback').catch(() => null);
    if (!Array.isArray(playback?.data)) incomplete.push('progress');
    for (const p of Array.isArray(playback?.data) ? playback.data : []) {
      const isMovie = p.type === 'movie';
      const metaId = metaIdFromIds(isMovie ? p.movie?.ids : p.show?.ids);
      if (!metaId) continue;
      const season = isMovie ? undefined : p.episode?.season;
      const episode = isMovie ? undefined : p.episode?.number;
      const key = watchKey(metaId, season, episode);
      playbackIds.set(key, p.id);
      const durationS = isMovie ? 6600 : 2700;
      progress.push({ key, metaId, type: isMovie ? 'movie' : 'series', season, episode, positionS: (p.progress / 100) * durationS, durationS, estimated: true, updatedAt: timeOf(p.paused_at), tmdbId: tmdbFromIds(isMovie ? p.movie?.ids : p.show?.ids), name: isMovie ? p.movie?.title : p.show?.title, synced: true });
    }

    const watchlist: WatchlistEntry[] = [];
    const WATCHLIST_LIMIT = 1000;
    const wl = await call<unknown>(account, 'GET', `/watchlist/items?limit=${WATCHLIST_LIMIT}&unified=true`).catch(() => null);
    const listRead = !!wl && !!wl.data && typeof wl.data === 'object';
    const items = !listRead ? [] : Array.isArray(wl.data) ? wl.data : [...((wl.data as { movies?: unknown[] })?.movies ?? []), ...((wl.data as { shows?: unknown[] })?.shows ?? [])];
    // Not read, or as long as the limit (so possibly cut off): nothing is removed locally on its word.
    if (!listRead || items.length >= WATCHLIST_LIMIT) incomplete.push('watchlist');
    for (const raw of items as { mediatype?: string; type?: string; title?: string; release_year?: number; ids?: Ids; imdb_id?: string; tmdb_id?: number; id?: number }[]) {
      const ids = raw.ids ?? { imdb: raw.imdb_id, tmdb: raw.tmdb_id ?? raw.id };
      const metaId = metaIdFromIds(ids);
      if (!metaId) continue;
      const kind = (raw.mediatype ?? raw.type ?? '').toLowerCase();
      watchlist.push({ metaId, type: kind === 'movie' ? 'movie' : 'series', name: raw.title, year: raw.release_year ? String(raw.release_year) : undefined, tmdbId: tmdbFromIds(ids) });
    }
    return { progress, watched, watchlist: listRead ? watchlist : undefined, counts: { resume: progress.length, watched: watched.length }, incomplete, resumeCap: SCROBBLE_CAP_PERCENT / 100 };
  },

  async push(account, op, h) {
    if (op.op === 'resume') {
      const e = h.progress[op.key];
      const b = e && scrobbleBody(e);
      if (!b) return 'skip';
      await call(account, 'POST', '/scrobble/pause', { ...b, progress: Math.min(SCROBBLE_CAP_PERCENT, Math.max(1, (e.positionS / e.durationS) * 100)) });
      return 'synced';
    }
    if (op.op === 'watched') {
      const w = h.watched[op.key];
      const b = w && watchedBody(w, w.at);
      if (!b) return 'skip';
      await call(account, 'POST', '/sync/watched', b);
      const pid = playbackIds.get(op.key);
      if (pid) {
        await call(account, 'POST', '/scrobble/clear', { id: pid }).catch(() => undefined);
        playbackIds.delete(op.key);
      }
      return 'synced';
    }
    if (op.op === 'unwatched') {
      const b = watchedBody(op);
      if (!b) return 'skip';
      await call(account, 'POST', '/sync/watched/remove', b);
      return 'synced';
    }
    const pid = playbackIds.get(op.key);
    if (!pid) return 'skip';
    await call(account, 'POST', '/scrobble/clear', { id: pid }).catch(() => undefined);
    playbackIds.delete(op.key);
    return 'synced';
  },

  async watchlistAdd(account, t: TitleRef) {
    const ids = idsFor(t.metaId, t.tmdbId);
    await call(account, 'POST', '/watchlist/items/add', t.type === 'movie' ? { movies: [ids] } : { shows: [ids] });
  },

  async watchlistRemove(account, t: TitleRef) {
    const ids = idsFor(t.metaId, t.tmdbId);
    await call(account, 'POST', '/watchlist/items/remove', t.type === 'movie' ? { movies: [ids] } : { shows: [ids] });
  },
};

// ---------- Lists ----------
//
// Everything here takes the API key itself, so lists work with the key of a connected MDBList
// tracker or with one kept only for lists. Paths and parameters follow MDBList's API reference
// (api.mdblist.com/docs, the Lists group); where it leaves a response shape open (the unified
// item list, the paging object) the answer is read defensively.

/** An MDBList list as the pickers show it. */
export interface MdbList {
  id: number;
  name: string;
  slug?: string;
  owner?: string;
  description?: string;
  /** `movie` or `show`; empty for a list of both. */
  mediatype?: string;
  itemCount?: number;
  likes?: number;
}

interface RawMdbList {
  id?: number;
  name?: string;
  slug?: string | null;
  user_name?: string;
  description?: string | null;
  mediatype?: string | null;
  items?: number | null;
  likes?: number | null;
}

function mdbListFrom(l: RawMdbList | null | undefined): MdbList | null {
  const id = Number(l?.id);
  if (!l || !l.name || !(id > 0)) return null;
  return { id, name: l.name, slug: l.slug || undefined, owner: l.user_name || undefined, description: l.description || undefined, mediatype: l.mediatype || undefined, itemCount: l.items ?? undefined, likes: l.likes ?? undefined };
}

async function mdbLists(apiKey: string, path: string): Promise<MdbList[]> {
  const { data } = await call<RawMdbList[] | { lists?: RawMdbList[] }>({ provider: 'mdblist', apiKey }, 'GET', path);
  const raw = Array.isArray(data) ? data : data?.lists;
  // Anything but a list of lists is a failed read, not "no lists".
  if (!Array.isArray(raw)) throw new TrackerError('retry', 'MDBList sent an answer that could not be read.');
  return raw.map(mdbListFrom).filter((l): l is MdbList => !!l);
}

/** The lists of the account the key belongs to. */
export const mdblistMyLists = (apiKey: string) => mdbLists(apiKey, '/lists/user');

/** MDBList's most popular public lists, in the order of its Top Lists page. */
export const mdblistTopLists = (apiKey: string, limit = 40) => mdbLists(apiKey, `/lists/top?limit=${limit}`);

/** Public lists by name. */
export const mdblistSearchLists = (apiKey: string, query: string, limit = 40) => mdbLists(apiKey, `/lists/search?query=${encodeURIComponent(query)}&limit=${limit}`);

/** What identifies a list to read: its number, its owner and slug, or the key's own watchlist. */
export interface MdbListRef {
  id?: number;
  user?: string;
  slug?: string;
  watchlist?: boolean;
}

/**
 * A list from what a user pasted: an mdblist.com link (`/lists/<user>/<slug>`), a bare number, or
 * `user/slug`. Null when it is none of these.
 */
export function parseMdblistLink(text: string): MdbListRef | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return { id: Number(t) };
  const path = t.replace(/^https?:\/\/[^/]*mdblist\.com/i, '').split(/[?#]/)[0];
  const linked = /^\/?lists\/([^/]+)\/([^/]+)/i.exec(path);
  if (linked) return { user: decodeURIComponent(linked[1]), slug: decodeURIComponent(linked[2]) };
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(t);
  return bare ? { user: bare[1], slug: bare[2] } : null;
}

const refPath = (ref: MdbListRef) => (ref.id ? `/lists/${ref.id}` : ref.user && ref.slug ? `/lists/${encodeURIComponent(ref.user)}/${encodeURIComponent(ref.slug)}` : null);

/** A list's name, number and size, for a pasted link. Null when MDBList has no such list. */
export async function mdblistListInfo(apiKey: string, ref: MdbListRef): Promise<MdbList | null> {
  const path = refPath(ref);
  if (!path) return null;
  try {
    const { data } = await call<RawMdbList | RawMdbList[]>({ provider: 'mdblist', apiKey }, 'GET', path);
    // Older answers wrap the one list in an array.
    return mdbListFrom(Array.isArray(data) ? data[0] : data);
  } catch (e) {
    if (e instanceof TrackerError && e.status === 404) return null;
    throw e;
  }
}

/** Orders MDBList sorts list items by. */
const MDB_SORTS = new Set(['rank', 'score', 'usort', 'score_average', 'released', 'releasedigital', 'imdbrating', 'imdbvotes', 'last_air_date', 'imdbpopular', 'tmdbpopular', 'rogerebert', 'rtomatoes', 'rtaudience', 'metacritic', 'myanimelist', 'letterrating', 'lettervotes', 'budget', 'revenue', 'runtime', 'title', 'sort_title', 'added', 'random']);

export interface MdbItemsQuery {
  /** Movies only or shows only; both when left out. */
  media?: 'movie' | 'show';
  sortBy?: string;
  sortHow?: string;
  /** How many titles came before this page. */
  offset: number;
  limit: number;
}

export interface MdbListTitle {
  metaId: string;
  type: 'movie' | 'series';
  name: string;
  year?: number;
  tmdbId?: number;
  /** A link or a TMDB image path, as MDBList sent it (asked for with `append_to_response=poster`). */
  poster?: string;
}

interface RawMdbItem {
  id?: number;
  rank?: number | null;
  title?: string;
  mediatype?: string;
  release_year?: number | null;
  imdb_id?: string | null;
  tmdb_id?: number | null;
  ids?: Ids;
  poster?: string | null;
}

interface MdbItemsAnswer {
  movies?: RawMdbItem[];
  shows?: RawMdbItem[];
  items?: RawMdbItem[];
  pagination?: { next_cursor?: string | null; has_more?: boolean };
  next_cursor?: string | null;
}

/**
 * MDBList pages a list with a cursor it hands out with each page (skipping by count is the older
 * way, still answered). The cursor for the page after `offset` titles is remembered here; a page
 * asked for without one (the first, or after a restart) goes by count.
 */
const cursors = new Map<string, string>();

/**
 * One page of a list's movies and shows. `next` is the `offset` of the page after this one, or
 * null when this was the last: by what MDBList said (a cursor, its `X-Has-More` header), else by
 * whether this page came back full. Titles with neither an IMDb nor a TMDB id are left out; they
 * still count towards `next`.
 */
export async function mdblistListItems(apiKey: string, ref: MdbListRef, q: MdbItemsQuery): Promise<{ items: MdbListTitle[]; next: number | null }> {
  const base = ref.watchlist ? '/watchlist' : refPath(ref);
  if (!base) return { items: [], next: null };
  const sortBy = q.sortBy?.toLowerCase();
  const params = new URLSearchParams({ limit: String(q.limit), unified: 'true', append_to_response: 'poster' });
  if (q.media) params.set('mediatype', q.media);
  if (sortBy && MDB_SORTS.has(sortBy)) {
    params.set('sort', sortBy);
    params.set('order', q.sortHow?.toLowerCase() === 'desc' ? 'desc' : 'asc');
  }
  const pageKey = `${apiKey.length}:${base}?${params}`;
  const cursor = q.offset ? cursors.get(`${pageKey}@${q.offset}`) : undefined;
  if (cursor) params.set('cursor', cursor);
  else if (q.offset) params.set('offset', String(q.offset));

  const res = await call<RawMdbItem[] | MdbItemsAnswer>({ provider: 'mdblist', apiKey }, 'GET', `${base}/items?${params}`);
  const data = res.data;
  if (!data || typeof data !== 'object') throw new TrackerError('retry', 'MDBList sent an answer that could not be read.');
  let raw: RawMdbItem[];
  if (Array.isArray(data)) raw = data;
  else if (Array.isArray(data.items)) raw = data.items;
  else {
    raw = [...(data.movies ?? []), ...(data.shows ?? [])];
    // Movies and shows come apart; their rank on the list puts them back in its order.
    if (raw.every((r) => typeof r.rank === 'number')) raw.sort((a, b) => a.rank! - b.rank!);
  }

  const items: MdbListTitle[] = [];
  for (const r of raw) {
    const ids = r.ids ?? { imdb: r.imdb_id, tmdb: r.tmdb_id ?? r.id };
    const metaId = metaIdFromIds(ids);
    const kind = (r.mediatype ?? q.media ?? '').toLowerCase();
    if (!metaId || !r.title || (kind !== 'movie' && kind !== 'show')) continue;
    items.push({ metaId, type: kind === 'movie' ? 'movie' : 'series', name: r.title, year: r.release_year ?? undefined, tmdbId: tmdbFromIds(ids), poster: typeof r.poster === 'string' && r.poster ? r.poster : undefined });
  }

  const paging = Array.isArray(data) ? undefined : data;
  const next = paging?.pagination?.next_cursor ?? paging?.next_cursor ?? undefined;
  if (next) cursors.set(`${pageKey}@${q.offset + raw.length}`, next);
  const header = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-has-more')?.[1];
  const said = header !== undefined ? /^(true|1)$/i.test(header.trim()) : paging?.pagination?.has_more;
  const more = next ? true : said ?? raw.length >= q.limit;
  return { items, next: more && raw.length ? q.offset + raw.length : null };
}

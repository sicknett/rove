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

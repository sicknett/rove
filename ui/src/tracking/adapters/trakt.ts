// Trakt (api.trakt.tv, API v2): device sign-in, playback progress, watched history, watchlist.
// ROVE's Trakt app id comes from the build (VITE_TRAKT_CLIENT_ID). Trakt apps no longer have a
// secret: sign-in and token renewal send the app id only, and go to Trakt's sign-in host.

import { watchKey } from '../../addons/ids';
import type { ProgressEntry, WatchedEntry } from '../../state/history';
import { idsFor, listOf, metaIdFromIds, SCROBBLE_CAP_PERCENT, timeOf, tmdbFromIds, trackerFetch } from '../http';
import { TrackerError, type PullResult, type TitleRef, type TrackerAccount, type TrackerAdapter, type WatchlistEntry } from '../types';

const API = 'https://api.trakt.tv';
/** Every `/oauth/…` request goes here, not to the API host. */
const AUTH = 'https://auth.trakt.tv';
/** The redirect address registered for ROVE's Trakt app; token renewal has to name it exactly. */
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
export const TRAKT_CLIENT_ID = (import.meta.env.VITE_TRAKT_CLIENT_ID as string | undefined)?.trim() || '';

type Ids = Record<string, unknown>;

function call<T>(account: TrackerAccount | null, method: 'GET' | 'POST' | 'DELETE', path: string, json?: unknown) {
  if (!TRAKT_CLIENT_ID) throw new TrackerError('unauthorized', 'This build of ROVE has no Trakt app id.');
  return trackerFetch<T>({
    service: 'Trakt',
    method,
    url: `${path.startsWith('/oauth/') ? AUTH : API}${path}`,
    json,
    writeGapMs: 1100,
    headers: {
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID,
      'User-Agent': `ROVE/${__APP_VERSION__}`,
      ...(account?.accessToken ? { Authorization: `Bearer ${account.accessToken}` } : {}),
    },
  });
}

// ---------- Sign-in (device code) ----------

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalS: number;
  expiresAt: number;
}

export async function traktStartDevice(): Promise<DeviceCode> {
  const { data } = await call<{ device_code: string; user_code: string; verification_url: string; interval: number; expires_in: number }>(null, 'POST', '/oauth/device/code', { client_id: TRAKT_CLIENT_ID });
  return { deviceCode: data.device_code, userCode: data.user_code, verificationUrl: data.verification_url, intervalS: data.interval || 5, expiresAt: Date.now() + data.expires_in * 1000 };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

function accountFrom(t: TokenResponse, username?: string): TrackerAccount {
  return { provider: 'trakt', accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: (t.created_at * 1000 || Date.now()) + t.expires_in * 1000, username };
}

/** Waits for the user to approve the code. Resolves with the account, or null if it expired or was denied. */
export async function traktPollDevice(code: DeviceCode, signal: AbortSignal): Promise<TrackerAccount | null> {
  let interval = code.intervalS * 1000;
  while (Date.now() < code.expiresAt && !signal.aborted) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      const { data } = await call<TokenResponse>(null, 'POST', '/oauth/device/token', { code: code.deviceCode, client_id: TRAKT_CLIENT_ID });
      const acc = accountFrom(data);
      const me = await call<{ user?: { username?: string } }>(acc, 'GET', '/users/settings').catch(() => null);
      return { ...acc, username: me?.data?.user?.username };
    } catch (e) {
      if (!(e instanceof TrackerError)) throw e;
      if (e.status === 400) continue; // still waiting
      if (e.status === 429) {
        interval += 1000;
        continue;
      }
      return null; // 404 bad code, 409 used, 410 expired, 418 denied
    }
  }
  return null;
}

// ---------- Mapping ----------

interface Playback {
  id: number;
  progress: number;
  paused_at: string;
  type: 'movie' | 'episode';
  movie?: { title?: string; runtime?: number; ids: Ids };
  episode?: { season: number; number: number; title?: string; runtime?: number; ids: Ids };
  show?: { title?: string; ids: Ids };
}

/** Trakt playback ids by watch key, for clearing progress. */
const playbackIds = new Map<string, number>();

function body(t: { metaId: string; type: 'movie' | 'series'; season?: number; episode?: number; tmdbId?: number }) {
  const ids = idsFor(t.metaId, t.tmdbId);
  if (!ids.imdb && !ids.tmdb) return null;
  if (t.type === 'movie') return { movie: { ids } };
  return { show: { ids }, episode: { season: t.season ?? 1, number: t.episode ?? 1 } };
}

function historyBody(t: { metaId: string; type: 'movie' | 'series'; season?: number; episode?: number; tmdbId?: number }, at?: number) {
  const ids = idsFor(t.metaId, t.tmdbId);
  if (!ids.imdb && !ids.tmdb) return null;
  const watched_at = at ? new Date(at).toISOString() : undefined;
  if (t.type === 'movie') return { movies: [{ ids, ...(watched_at ? { watched_at } : {}) }] };
  if (t.season === undefined || t.episode === undefined) return { shows: [{ ids }] };
  return { shows: [{ ids, seasons: [{ number: t.season, episodes: [{ number: t.episode, ...(watched_at ? { watched_at } : {}) }] }] }] };
}

export const traktAdapter: TrackerAdapter = {
  id: 'trakt',
  name: 'Trakt',

  async pull(account) {
    const [movies, episodes, watchedMovies, watchedShows, wlMovies, wlShows] = await Promise.all([
      call<Playback[]>(account, 'GET', '/sync/playback/movies?extended=full'),
      call<Playback[]>(account, 'GET', '/sync/playback/episodes?extended=full'),
      call<{ plays?: number; last_watched_at: string; movie: { ids: Ids } }[]>(account, 'GET', '/sync/watched/movies'),
      call<{ reset_at?: string | null; show: { ids: Ids }; seasons?: { number: number; episodes: { number: number; plays?: number; last_watched_at: string }[] }[] }[]>(account, 'GET', '/sync/watched/shows'),
      // The watchlist is extra: when it cannot be read, history still syncs and the local list is left alone.
      call<{ listed_at: string; movie: { title?: string; year?: number; ids: Ids } }[]>(account, 'GET', '/sync/watchlist/movies/added/desc').catch(() => null),
      call<{ listed_at: string; show: { title?: string; year?: number; ids: Ids } }[]>(account, 'GET', '/sync/watchlist/shows/added/desc').catch(() => null),
    ]);
    const incomplete: NonNullable<PullResult['incomplete']> = [];
    const listRead = Array.isArray(wlMovies?.data) && Array.isArray(wlShows?.data);
    if (!listRead) incomplete.push('watchlist');

    playbackIds.clear();
    const progress: ProgressEntry[] = [];
    for (const p of [...listOf(movies.data, 'Trakt'), ...listOf(episodes.data, 'Trakt')]) {
      const isMovie = p.type === 'movie';
      const metaId = metaIdFromIds(isMovie ? p.movie?.ids : p.show?.ids);
      if (!metaId) continue;
      const season = isMovie ? undefined : p.episode?.season;
      const episode = isMovie ? undefined : p.episode?.number;
      const key = watchKey(metaId, season, episode);
      playbackIds.set(key, p.id);
      const runtimeMin = isMovie ? p.movie?.runtime : p.episode?.runtime;
      const durationS = runtimeMin ? runtimeMin * 60 : isMovie ? 6600 : 2700;
      progress.push({
        key,
        metaId,
        type: isMovie ? 'movie' : 'series',
        season,
        episode,
        positionS: (p.progress / 100) * durationS,
        durationS,
        estimated: !runtimeMin,
        updatedAt: timeOf(p.paused_at),
        tmdbId: tmdbFromIds(isMovie ? p.movie?.ids : p.show?.ids),
        name: isMovie ? p.movie?.title : p.show?.title,
        episodeTitle: p.episode?.title,
        synced: true,
      });
    }

    const watched: WatchedEntry[] = [];
    // More than one play of the latest episode tells Continue Watching the show is being rewatched.
    const again = (plays: number | undefined) => (plays && plays > 1 ? { plays } : {});
    for (const m of listOf(watchedMovies.data, 'Trakt')) {
      const metaId = metaIdFromIds(m.movie.ids);
      if (metaId) watched.push({ key: metaId, metaId, type: 'movie', at: timeOf(m.last_watched_at), tmdbId: tmdbFromIds(m.movie.ids), synced: true, ...again(m.plays) });
    }
    for (const s of listOf(watchedShows.data, 'Trakt')) {
      const metaId = metaIdFromIds(s.show.ids);
      if (!metaId) continue;
      const resetAt = timeOf(s.reset_at);
      for (const season of s.seasons ?? [])
        for (const ep of season.episodes) {
          const at = timeOf(ep.last_watched_at);
          // A rewatch started: earlier plays no longer count as watched.
          if (resetAt && at < resetAt) continue;
          watched.push({ key: watchKey(metaId, season.number, ep.number), metaId, type: 'series', season: season.number, episode: ep.number, at, tmdbId: tmdbFromIds(s.show.ids), synced: true, ...again(ep.plays) });
        }
    }

    const watchlist: WatchlistEntry[] = [];
    for (const w of (listRead && wlMovies?.data) || []) {
      const metaId = metaIdFromIds(w.movie.ids);
      if (metaId) watchlist.push({ metaId, type: 'movie', name: w.movie.title, year: w.movie.year ? String(w.movie.year) : undefined, tmdbId: tmdbFromIds(w.movie.ids), addedAt: timeOf(w.listed_at) || undefined });
    }
    for (const w of (listRead && wlShows?.data) || []) {
      const metaId = metaIdFromIds(w.show.ids);
      if (metaId) watchlist.push({ metaId, type: 'series', name: w.show.title, year: w.show.year ? String(w.show.year) : undefined, tmdbId: tmdbFromIds(w.show.ids), addedAt: timeOf(w.listed_at) || undefined });
    }
    return { progress, watched, watchlist: listRead ? watchlist : undefined, counts: { resume: progress.length, watched: watched.length }, incomplete, resumeCap: SCROBBLE_CAP_PERCENT / 100 };
  },

  async push(account, op, h) {
    if (op.op === 'resume') {
      const e = h.progress[op.key];
      const b = e && body(e);
      if (!b) return 'skip';
      // A pause scrobble stores the playback position without marking anything watched.
      await call(account, 'POST', '/scrobble/pause', { ...b, progress: Math.min(SCROBBLE_CAP_PERCENT, Math.max(1, (e.positionS / e.durationS) * 100)) });
      return 'synced';
    }
    if (op.op === 'watched') {
      const w = h.watched[op.key];
      const b = w && historyBody(w, w.at);
      if (!b) return 'skip';
      await call(account, 'POST', '/sync/history', b);
      const pid = playbackIds.get(op.key);
      if (pid) {
        await call(account, 'DELETE', `/sync/playback/${pid}`).catch(() => undefined);
        playbackIds.delete(op.key);
      }
      return 'synced';
    }
    if (op.op === 'unwatched') {
      const b = historyBody(op);
      if (!b) return 'skip';
      await call(account, 'POST', '/sync/history/remove', b);
      return 'synced';
    }
    const pid = playbackIds.get(op.key);
    if (!pid) return 'skip';
    await call(account, 'DELETE', `/sync/playback/${pid}`).catch((e) => {
      if (!(e instanceof TrackerError && e.status === 404)) throw e;
    });
    playbackIds.delete(op.key);
    return 'synced';
  },

  async watchlistAdd(account, t: TitleRef) {
    const ids = idsFor(t.metaId, t.tmdbId);
    await call(account, 'POST', '/sync/watchlist', t.type === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] });
  },

  async watchlistRemove(account, t: TitleRef) {
    const ids = idsFor(t.metaId, t.tmdbId);
    await call(account, 'POST', '/sync/watchlist/remove', t.type === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] });
  },

  async refresh(account) {
    if (!account.refreshToken) return account;
    const { data } = await call<TokenResponse>(null, 'POST', '/oauth/token', {
      refresh_token: account.refreshToken,
      client_id: TRAKT_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      grant_type: 'refresh_token',
    });
    // Trakt's refresh tokens work once: the new pair replaces the old one at once.
    return { ...accountFrom(data, account.username) };
  },
};

// ---------- Lists ----------
//
// Reading a public list needs ROVE's app id only, so these work with no Trakt account connected
// (and with another tracker connected). The account's own things (its watchlist, its lists that
// are not public, the lists it liked) need its token as well. Paths and shapes follow Trakt's
// API reference (Lists, Users and Search groups).

/** A Trakt list as the pickers show it. */
export interface TraktList {
  id: number;
  slug?: string;
  name: string;
  description?: string;
  itemCount?: number;
  likes?: number;
  /** The owner's display name and slug, when Trakt sent them (it leaves them out of "my lists"). */
  owner?: string;
  ownerSlug?: string;
  /** `public`, `private`, `link` or `friends`. Only public lists can be read without the owner's sign-in. */
  privacy?: string;
}

interface RawList {
  name?: string;
  description?: string | null;
  privacy?: string;
  item_count?: number;
  likes?: number;
  ids?: { trakt?: number; slug?: string };
  user?: { username?: string; name?: string; ids?: { slug?: string } };
}

function listFrom(l: RawList | null | undefined): TraktList | null {
  const id = Number(l?.ids?.trakt);
  if (!l || !l.name || !(id > 0)) return null;
  return {
    id,
    slug: l.ids?.slug,
    name: l.name,
    description: l.description || undefined,
    itemCount: l.item_count,
    likes: l.likes,
    owner: l.user?.name || l.user?.username,
    ownerSlug: l.user?.ids?.slug,
    privacy: l.privacy,
  };
}

const lists = (raw: (RawList | null | undefined)[]) => raw.map(listFrom).filter((l): l is TraktList => !!l);

/** The signed-in account's own lists. */
export async function traktMyLists(account: TrackerAccount): Promise<TraktList[]> {
  const { data } = await call<RawList[]>(account, 'GET', '/users/me/lists');
  return lists(listOf(data, 'Trakt'));
}

/** Lists the signed-in account liked, most recent first. */
export async function traktLikedLists(account: TrackerAccount, limit = 50): Promise<TraktList[]> {
  const { data } = await call<{ type?: string; list?: RawList }[]>(account, 'GET', `/users/me/likes/lists?page=1&limit=${limit}`);
  return lists(listOf(data, 'Trakt').map((x) => x.list));
}

/** Trakt's popular or trending public lists. */
export async function traktPublicLists(kind: 'popular' | 'trending', limit = 30): Promise<TraktList[]> {
  const { data } = await call<{ list?: RawList }[]>(null, 'GET', `/lists/${kind}?page=1&limit=${limit}`);
  return lists(listOf(data, 'Trakt').map((x) => x.list));
}

/** Public lists whose name or description matches. */
export async function traktSearchLists(query: string, limit = 30): Promise<TraktList[]> {
  const { data } = await call<{ type?: string; list?: RawList }[]>(null, 'GET', `/search/list?query=${encodeURIComponent(query)}&page=1&limit=${limit}`);
  return lists(listOf(data, 'Trakt').map((x) => x.list));
}

/** What identifies a list to read: its number, its owner and slug, or the account's watchlist. */
export interface TraktListRef {
  id?: number;
  user?: string;
  slug?: string;
  watchlist?: boolean;
}

/** Whether reading it takes the account's token: the watchlist and lists addressed as `me`. */
export const traktRefNeedsAccount = (ref: TraktListRef) => !!ref.watchlist || (!ref.id && ref.user === 'me');

/**
 * A list from what a user pasted: a trakt.tv link (`/lists/55`, `/users/sean/lists/some-slug`),
 * a bare number, or `owner/slug`. Null when it is none of these.
 */
export function parseTraktListLink(text: string): TraktListRef | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return { id: Number(t) };
  const path = t.replace(/^https?:\/\/[^/]*trakt\.tv/i, '').split(/[?#]/)[0];
  const byUser = /^\/?users\/([^/]+)\/lists\/([^/]+)/i.exec(path);
  if (byUser) return { user: decodeURIComponent(byUser[1]), slug: decodeURIComponent(byUser[2]) };
  const byId = /^\/?lists\/(\d+)\b/i.exec(path);
  if (byId) return { id: Number(byId[1]) };
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(t);
  return bare ? { user: bare[1], slug: bare[2] } : null;
}

/** A list's name and size, for a pasted link. Null when Trakt has no such public list. */
export async function traktListInfo(ref: TraktListRef, account?: TrackerAccount | null): Promise<TraktList | null> {
  const path = ref.id ? `/lists/${ref.id}` : ref.user && ref.slug ? `/users/${encodeURIComponent(ref.user)}/lists/${encodeURIComponent(ref.slug)}` : null;
  if (!path) return null;
  try {
    const { data } = await call<RawList>(traktRefNeedsAccount(ref) ? account ?? null : null, 'GET', path);
    return listFrom(data);
  } catch (e) {
    if (e instanceof TrackerError && e.status === 404) return null;
    throw e;
  }
}

/** Orders Trakt sorts list items by. Collection files also say `original`: the list's own order. */
const LIST_SORTS = new Set(['rank', 'added', 'title', 'released', 'runtime', 'popularity', 'random', 'percentage', 'imdb_rating', 'tmdb_rating', 'rt_tomatometer', 'rt_audience', 'metascore', 'votes', 'imdb_votes', 'tmdb_votes', 'my_rating', 'watched', 'collected']);

export interface TraktItemsQuery {
  /** Movies only or shows only; both when left out. */
  media?: 'movie' | 'show';
  sortBy?: string;
  sortHow?: string;
  /** 1-based. */
  page: number;
  limit: number;
}

/** A title on a Trakt list, with what `extended=full` adds. */
export interface TraktListTitle {
  metaId: string;
  type: 'movie' | 'series';
  name: string;
  year?: number;
  tmdbId?: number;
  overview?: string;
  /** Trakt's own rating, 0 to 10. */
  rating?: number;
  genres?: string[];
}

interface RawTitle {
  title?: string;
  year?: number | null;
  ids?: Ids;
  overview?: string | null;
  rating?: number | null;
  genres?: string[] | null;
}

/**
 * One page of a list's movies and shows, in the list's own order unless a sort is asked for.
 * Seasons, episodes and people on a list are left out, as are titles with neither an IMDb nor a
 * TMDB id. `next` is the page after this one, or null when this was the last: by Trakt's page
 * count when it sent one, else by whether this page came back full.
 */
export async function traktListItems(ref: TraktListRef, q: TraktItemsQuery, account?: TrackerAccount | null): Promise<{ items: TraktListTitle[]; next: number | null }> {
  // The watchlist names its types in the plural and has `all`; lists take `movie`, `show` or both.
  const base = ref.watchlist
    ? `/users/me/watchlist/${q.media ? `${q.media}s` : 'all'}`
    : ref.id
      ? `/lists/${ref.id}/items/${q.media ?? 'movie,show'}`
      : `/users/${encodeURIComponent(ref.user ?? '')}/lists/${encodeURIComponent(ref.slug ?? '')}/items/${q.media ?? 'movie,show'}`;
  const sortBy = q.sortBy?.toLowerCase();
  const sort = sortBy && LIST_SORTS.has(sortBy) ? `/${sortBy}/${q.sortHow?.toLowerCase() === 'desc' ? 'desc' : 'asc'}` : '';
  const needsAccount = traktRefNeedsAccount(ref);
  if (needsAccount && !account?.accessToken) throw new TrackerError('unauthorized', 'Sign in to Trakt to read this list.');
  // A public list is read without the token: one that has run out must not stand in its way.
  const res = await call<{ type?: string; movie?: RawTitle; show?: RawTitle }[]>(needsAccount ? account ?? null : null, 'GET', `${base}${sort}?page=${q.page}&limit=${q.limit}&extended=full`);
  const raw = listOf(res.data, 'Trakt');
  const items: TraktListTitle[] = [];
  for (const it of raw) {
    const title = it.type === 'movie' ? it.movie : it.type === 'show' ? it.show : undefined;
    const metaId = metaIdFromIds(title?.ids);
    if (!title?.title || !metaId) continue;
    items.push({
      metaId,
      type: it.type === 'movie' ? 'movie' : 'series',
      name: title.title,
      year: title.year ?? undefined,
      tmdbId: tmdbFromIds(title.ids),
      overview: title.overview || undefined,
      rating: title.rating || undefined,
      genres: title.genres ?? undefined,
    });
  }
  const pages = Number(Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-pagination-page-count')?.[1]);
  const more = Number.isFinite(pages) && pages > 0 ? q.page < pages : raw.length >= q.limit;
  return { items, next: more && raw.length ? q.page + 1 : null };
}

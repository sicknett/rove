// Trakt (api.trakt.tv, API v2): device sign-in, playback progress, watched history, watchlist.
// ROVE's Trakt app id and secret come from the build (VITE_TRAKT_CLIENT_ID / _SECRET).

import { watchKey } from '../../addons/ids';
import type { ProgressEntry, WatchedEntry } from '../../state/history';
import { idsFor, metaIdFromIds, timeOf, tmdbFromIds, trackerFetch } from '../http';
import { TrackerError, type TitleRef, type TrackerAccount, type TrackerAdapter, type WatchlistEntry } from '../types';

const API = 'https://api.trakt.tv';
export const TRAKT_CLIENT_ID = (import.meta.env.VITE_TRAKT_CLIENT_ID as string | undefined)?.trim() || '';
const TRAKT_CLIENT_SECRET = (import.meta.env.VITE_TRAKT_CLIENT_SECRET as string | undefined)?.trim() || '';

type Ids = Record<string, unknown>;

function call<T>(account: TrackerAccount | null, method: 'GET' | 'POST' | 'DELETE', path: string, json?: unknown) {
  if (!TRAKT_CLIENT_ID) throw new TrackerError('unauthorized', 'This build of ROVE has no Trakt app id.');
  return trackerFetch<T>({
    service: 'Trakt',
    method,
    url: `${API}${path}`,
    json,
    writeGapMs: 1100,
    headers: {
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID,
      'User-Agent': 'ROVE/0.1',
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
      const { data } = await call<TokenResponse>(null, 'POST', '/oauth/device/token', { code: code.deviceCode, client_id: TRAKT_CLIENT_ID, client_secret: TRAKT_CLIENT_SECRET });
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
      call<{ last_watched_at: string; movie: { ids: Ids } }[]>(account, 'GET', '/sync/watched/movies'),
      call<{ reset_at?: string | null; show: { ids: Ids }; seasons?: { number: number; episodes: { number: number; last_watched_at: string }[] }[] }[]>(account, 'GET', '/sync/watched/shows'),
      call<{ listed_at: string; movie: { title?: string; year?: number; ids: Ids } }[]>(account, 'GET', '/sync/watchlist/movies/added/desc').catch(() => ({ data: [] })),
      call<{ listed_at: string; show: { title?: string; year?: number; ids: Ids } }[]>(account, 'GET', '/sync/watchlist/shows/added/desc').catch(() => ({ data: [] })),
    ]);

    playbackIds.clear();
    const progress: ProgressEntry[] = [];
    for (const p of [...(movies.data ?? []), ...(episodes.data ?? [])]) {
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
    for (const m of watchedMovies.data ?? []) {
      const metaId = metaIdFromIds(m.movie.ids);
      if (metaId) watched.push({ key: metaId, metaId, type: 'movie', at: timeOf(m.last_watched_at), tmdbId: tmdbFromIds(m.movie.ids), synced: true });
    }
    for (const s of watchedShows.data ?? []) {
      const metaId = metaIdFromIds(s.show.ids);
      if (!metaId) continue;
      const resetAt = timeOf(s.reset_at);
      for (const season of s.seasons ?? [])
        for (const ep of season.episodes) {
          const at = timeOf(ep.last_watched_at);
          // A rewatch started: earlier plays no longer count as watched.
          if (resetAt && at < resetAt) continue;
          watched.push({ key: watchKey(metaId, season.number, ep.number), metaId, type: 'series', season: season.number, episode: ep.number, at, tmdbId: tmdbFromIds(s.show.ids), synced: true });
        }
    }

    const watchlist: WatchlistEntry[] = [];
    for (const w of wlMovies.data ?? []) {
      const metaId = metaIdFromIds(w.movie.ids);
      if (metaId) watchlist.push({ metaId, type: 'movie', name: w.movie.title, year: w.movie.year ? String(w.movie.year) : undefined, addedAt: timeOf(w.listed_at) || undefined });
    }
    for (const w of wlShows.data ?? []) {
      const metaId = metaIdFromIds(w.show.ids);
      if (metaId) watchlist.push({ metaId, type: 'series', name: w.show.title, year: w.show.year ? String(w.show.year) : undefined, addedAt: timeOf(w.listed_at) || undefined });
    }
    return { progress, watched, watchlist, counts: { resume: progress.length, watched: watched.length } };
  },

  async push(account, op, h) {
    if (op.op === 'resume') {
      const e = h.progress[op.key];
      const b = e && body(e);
      if (!b) return 'skip';
      // A pause scrobble stores the playback position without marking anything watched.
      await call(account, 'POST', '/scrobble/pause', { ...b, progress: Math.min(79, Math.max(1, (e.positionS / e.durationS) * 100)) });
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
      client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    });
    return { ...accountFrom(data, account.username) };
  },
};

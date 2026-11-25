// Simkl (api.simkl.com): device sign-in (OAuth2, falling back to the older PIN flow), watched
// history, playback progress, plan-to-watch as the watchlist. App id from VITE_SIMKL_CLIENT_ID.

import { watchKey } from '../../addons/ids';
import type { ProgressEntry, WatchedEntry } from '../../state/history';
import { idsFor, metaIdFromIds, SCROBBLE_CAP_PERCENT, timeOf, tmdbFromIds, trackerFetch } from '../http';
import { TrackerError, type PullResult, type TitleRef, type TrackerAccount, type TrackerAdapter, type WatchlistEntry } from '../types';

const API = 'https://api.simkl.com';
export const SIMKL_CLIENT_ID = (import.meta.env.VITE_SIMKL_CLIENT_ID as string | undefined)?.trim() || '';
const APP = { 'app-name': 'rove', 'app-version': '0.1' };

type Ids = Record<string, unknown>;

function url(path: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams({ client_id: SIMKL_CLIENT_ID, ...APP, ...params });
  return `${API}${path}${path.includes('?') ? '&' : '?'}${q}`;
}

function call<T>(account: TrackerAccount | null, method: 'GET' | 'POST' | 'DELETE', path: string, json?: unknown, params?: Record<string, string>) {
  if (!SIMKL_CLIENT_ID) throw new TrackerError('unauthorized', 'This build of ROVE has no Simkl app id.');
  return trackerFetch<T>({
    service: 'Simkl',
    method,
    url: url(path, params),
    json,
    writeGapMs: 500,
    headers: { 'User-Agent': 'rove/0.1', 'simkl-api-key': SIMKL_CLIENT_ID, ...(account?.accessToken ? { Authorization: `Bearer ${account.accessToken}` } : {}) },
  });
}

// ---------- Sign-in ----------

export interface SimklCode {
  /** OAuth2 device code, or null for the PIN flow. */
  deviceCode: string | null;
  userCode: string;
  verificationUrl: string;
  intervalS: number;
  expiresAt: number;
}

export async function simklStartDevice(): Promise<SimklCode> {
  try {
    const { data } = await trackerFetch<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number }>({
      service: 'Simkl',
      method: 'POST',
      url: `${API}/oauth2/device`,
      form: { client_id: SIMKL_CLIENT_ID, scope: 'media:read media:write' },
    });
    return { deviceCode: data.device_code, userCode: data.user_code, verificationUrl: data.verification_uri_complete ?? data.verification_uri, intervalS: data.interval || 5, expiresAt: Date.now() + data.expires_in * 1000 };
  } catch (e) {
    // Older Simkl apps only have the PIN flow.
    if (!(e instanceof TrackerError) || e.status !== 400) throw e;
    const { data } = await call<{ user_code: string; verification_url?: string; verification_uri?: string; expires_in: number; interval: number }>(null, 'GET', '/oauth/pin', undefined, { redirect: '' });
    return { deviceCode: null, userCode: data.user_code, verificationUrl: data.verification_url ?? data.verification_uri ?? 'https://simkl.com/pin', intervalS: data.interval || 5, expiresAt: Date.now() + (data.expires_in || 900) * 1000 };
  }
}

export async function simklPollDevice(code: SimklCode, signal: AbortSignal): Promise<TrackerAccount | null> {
  let interval = code.intervalS * 1000;
  while (Date.now() < code.expiresAt && !signal.aborted) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      if (code.deviceCode) {
        const { data } = await trackerFetch<{ access_token: string; refresh_token?: string; expires_in?: number }>({
          service: 'Simkl',
          method: 'POST',
          url: `${API}/oauth2/token`,
          form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: SIMKL_CLIENT_ID, device_code: code.deviceCode },
        });
        return { provider: 'simkl', accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined };
      }
      const { data } = await call<{ result: string; access_token?: string }>(null, 'GET', `/oauth/pin/${encodeURIComponent(code.userCode)}`);
      if (data.result === 'OK' && data.access_token) return { provider: 'simkl', accessToken: data.access_token };
    } catch (e) {
      if (!(e instanceof TrackerError)) throw e;
      const err = (e as TrackerError & { data?: { error?: string } }).data?.error;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') {
        interval += 5000;
        continue;
      }
      if (e.status === 400 && !err) continue;
      return null;
    }
  }
  return null;
}

// ---------- Mapping ----------

interface AllItems {
  movies?: { status: string; last_watched_at?: string; added_to_watchlist_at?: string; movie: { title?: string; year?: number; ids: Ids } }[];
  shows?: { status: string; last_watched_at?: string; added_to_watchlist_at?: string; show: { title?: string; year?: number; ids: Ids }; seasons?: { number: number; episodes: { number: number; watched_at?: string }[] }[] }[];
  anime?: AllItems['shows'];
}

interface Playback {
  id: number;
  progress: number;
  paused_at: string;
  type: 'movie' | 'episode';
  movie?: { title?: string; ids: Ids; runtime?: number };
  show?: { title?: string; ids: Ids };
  anime?: { title?: string; ids: Ids };
  episode?: { season: number; number: number; title?: string };
}

const playbackIds = new Map<string, number>();

function itemBody(t: { metaId: string; type: 'movie' | 'series'; season?: number; episode?: number; tmdbId?: number }) {
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

export const simklAdapter: TrackerAdapter = {
  id: 'simkl',
  name: 'Simkl',

  async pull(account) {
    const [all, playback] = await Promise.all([
      call<AllItems>(account, 'GET', '/sync/all-items/', undefined, { extended: 'full', episode_watched_at: 'yes' }),
      // Without the playback list the rest still syncs; local resume points are then left alone.
      call<Playback[]>(account, 'GET', '/sync/playback').catch(() => null),
    ]);
    const incomplete: NonNullable<PullResult['incomplete']> = [];
    if (!Array.isArray(playback?.data)) incomplete.push('progress');
    const watched: WatchedEntry[] = [];
    const watchlist: WatchlistEntry[] = [];
    for (const m of all.data?.movies ?? []) {
      const metaId = metaIdFromIds(m.movie.ids);
      if (!metaId) continue;
      if (m.status === 'completed') watched.push({ key: metaId, metaId, type: 'movie', at: timeOf(m.last_watched_at), tmdbId: tmdbFromIds(m.movie.ids), synced: true });
      if (m.status === 'plantowatch') watchlist.push({ metaId, type: 'movie', name: m.movie.title, year: m.movie.year ? String(m.movie.year) : undefined, tmdbId: tmdbFromIds(m.movie.ids), addedAt: timeOf(m.added_to_watchlist_at) || undefined });
    }
    for (const s of [...(all.data?.shows ?? []), ...(all.data?.anime ?? [])]) {
      const metaId = metaIdFromIds(s.show.ids);
      if (!metaId) continue;
      if (s.status === 'plantowatch') watchlist.push({ metaId, type: 'series', name: s.show.title, year: s.show.year ? String(s.show.year) : undefined, tmdbId: tmdbFromIds(s.show.ids), addedAt: timeOf(s.added_to_watchlist_at) || undefined });
      for (const season of s.seasons ?? [])
        for (const ep of season.episodes) {
          watched.push({ key: watchKey(metaId, season.number, ep.number), metaId, type: 'series', season: season.number, episode: ep.number, at: timeOf(ep.watched_at ?? s.last_watched_at), tmdbId: tmdbFromIds(s.show.ids), synced: true });
        }
    }
    playbackIds.clear();
    const progress: ProgressEntry[] = [];
    for (const p of Array.isArray(playback?.data) ? playback.data : []) {
      const isMovie = p.type === 'movie';
      const owner = isMovie ? p.movie : p.show ?? p.anime;
      const metaId = metaIdFromIds(owner?.ids);
      if (!metaId) continue;
      const season = isMovie ? undefined : p.episode?.season;
      const episode = isMovie ? undefined : p.episode?.number;
      const key = watchKey(metaId, season, episode);
      playbackIds.set(key, p.id);
      const durationS = isMovie && p.movie?.runtime ? p.movie.runtime * 60 : isMovie ? 6600 : 2700;
      progress.push({
        key,
        metaId,
        type: isMovie ? 'movie' : 'series',
        season,
        episode,
        positionS: (p.progress / 100) * durationS,
        durationS,
        estimated: !(isMovie && p.movie?.runtime),
        updatedAt: timeOf(p.paused_at),
        tmdbId: tmdbFromIds(owner?.ids),
        name: owner?.title,
        episodeTitle: p.episode?.title,
        synced: true,
      });
    }
    return { progress, watched, watchlist, counts: { resume: progress.length, watched: watched.length }, incomplete, resumeCap: SCROBBLE_CAP_PERCENT / 100 };
  },

  async push(account, op, h) {
    if (op.op === 'resume') {
      const e = h.progress[op.key];
      const b = e && itemBody(e);
      if (!b) return 'skip';
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
    await call(account, 'DELETE', `/sync/playback/${pid}`).catch(() => undefined);
    playbackIds.delete(op.key);
    return 'synced';
  },

  async watchlistAdd(account, t: TitleRef) {
    const ids = idsFor(t.metaId, t.tmdbId);
    await call(account, 'POST', '/sync/add-to-list', { to: 'plantowatch', ...(t.type === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] }) });
  },

  async watchlistRemove(account, t: TitleRef) {
    const ids = idsFor(t.metaId, t.tmdbId);
    await call(account, 'POST', '/sync/history/remove', t.type === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] });
  },

  async refresh(account) {
    if (!account.refreshToken) return account;
    const { data } = await trackerFetch<{ access_token: string; refresh_token?: string; expires_in?: number }>({
      service: 'Simkl',
      method: 'POST',
      url: `${API}/oauth2/token`,
      form: { grant_type: 'refresh_token', client_id: SIMKL_CLIENT_ID, refresh_token: account.refreshToken },
    });
    return { ...account, accessToken: data.access_token, refreshToken: data.refresh_token ?? account.refreshToken, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined };
  },
};

// Jellyfin, Emby and Silo (which speaks Jellyfin's API). Sign in with a username and password or,
// on Jellyfin and Silo, Quick Connect. Playback is direct play of the original file; progress is
// reported to the server so its own resume points and watched marks stay right.

import type { Meta, Stream, Video } from '../addons/types';
import { cached, resolutionLabel, roveDeviceId, ServerError, serverFetch, sizeLabel } from './http';
import { serverItemId, type MediaServer, type PlaybackReport, type ServerAdapter, type ServerItemPreview, type ServerKind, type ServerLibrary, type ServerList } from './types';

const VERSION = '0.1';
const TICKS = 10_000_000;

type Base = Pick<MediaServer, 'kind' | 'url'> & Partial<Pick<MediaServer, 'token' | 'userId' | 'name'>>;

const isEmby = (s: Base) => s.kind === 'emby';
const prefix = (s: Base) => (isEmby(s) ? `${s.url}/emby` : s.url);

async function headers(s: Base): Promise<Record<string, string>> {
  const device = await roveDeviceId();
  const auth = `MediaBrowser Client="ROVE", Device="Windows", DeviceId="${device}", Version="${VERSION}"${s.token ? `, Token="${s.token}"` : ''}`;
  if (isEmby(s)) return { 'X-Emby-Authorization': auth, ...(s.token ? { 'X-Emby-Token': s.token } : {}) };
  return { Authorization: auth };
}

async function call<T>(s: Base, method: 'GET' | 'POST' | 'DELETE', path: string, json?: unknown, timeoutMs?: number): Promise<T> {
  return serverFetch<T>({ url: `${prefix(s)}${path}`, method, json, headers: await headers(s), service: s.name || 'The server', timeoutMs });
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') out.set(k, String(v));
  return out.toString();
};

/** User-scoped paths differ: Jellyfin 10.9+ takes userId as a parameter, Emby keeps it in the path. */
function userPath(s: MediaServer, jellyfin: string, emby: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (isEmby(s)) return `/Users/${s.userId}${emby}?${q(params)}`;
  return `${jellyfin}?${q({ userId: s.userId, ...params })}`;
}

// ---------- Sign-in ----------

export interface PublicInfo {
  name: string;
  kind: ServerKind;
  version?: string;
  quickConnect: boolean;
}

/** Checks the address and finds out what is running there. */
export async function probeServer(url: string, kind: ServerKind): Promise<PublicInfo> {
  const tryInfo = (base: Base) => call<{ ServerName?: string; ProductName?: string; Version?: string }>(base, 'GET', '/System/Info/Public', undefined, 8000);
  let info: { ServerName?: string; ProductName?: string; Version?: string } | null = null;
  let actual: ServerKind = kind;
  try {
    info = await tryInfo({ kind, url });
  } catch {
    // Emby answers under /emby; Jellyfin at the root.
    const other: ServerKind = kind === 'emby' ? 'jellyfin' : 'emby';
    info = await tryInfo({ kind: other, url }).catch(() => null);
    if (!info) throw new ServerError(`Nothing answered at ${url}. Check the address and port (Jellyfin and Emby use 8096 by default).`);
    if (kind !== 'silo') actual = other;
  }
  if (typeof info !== 'object' || !info) throw new ServerError(`${url} is not a Jellyfin or Emby server.`);
  if (kind !== 'silo' && kind !== 'emby' && /emby/i.test(info.ProductName ?? '')) actual = 'emby';
  let quickConnect = false;
  if (actual !== 'emby') quickConnect = await call<boolean>({ kind: actual, url }, 'GET', '/QuickConnect/Enabled', undefined, 8000).then((v) => v === true || String(v) === 'true').catch(() => false);
  return { name: info.ServerName || 'Media server', kind: actual, version: info.Version, quickConnect };
}

interface AuthResult {
  AccessToken: string;
  User: { Id: string; Name: string };
}

export async function signInWithPassword(url: string, kind: ServerKind, username: string, password: string, name: string): Promise<Omit<MediaServer, 'id' | 'addedAt' | 'enabled'>> {
  const r = await call<AuthResult>({ kind, url, name }, 'POST', '/Users/AuthenticateByName', { Username: username, Pw: password });
  if (!r?.AccessToken) throw new ServerError(`${name} did not accept that username and password.`);
  return { kind, url, name, token: r.AccessToken, userId: r.User.Id, userName: r.User.Name };
}

export interface QuickConnectCode {
  code: string;
  done: Promise<Omit<MediaServer, 'id' | 'addedAt' | 'enabled'> | null>;
  cancel: () => void;
}

/** Quick Connect: the user approves the code in the server's web app (Profile → Quick Connect). */
export async function startQuickConnect(url: string, kind: ServerKind, name: string): Promise<QuickConnectCode> {
  const base: Base = { kind, url, name };
  const init = await call<{ Secret: string; Code: string }>(base, 'POST', '/QuickConnect/Initiate');
  let stopped = false;
  const done = (async () => {
    const until = Date.now() + 10 * 60 * 1000;
    while (!stopped && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      if (stopped) return null;
      const state = await call<{ Authenticated?: boolean }>(base, 'GET', `/QuickConnect/Connect?${q({ secret: init.Secret })}`).catch(() => null);
      if (state?.Authenticated) {
        const r = await call<AuthResult>(base, 'POST', '/Users/AuthenticateWithQuickConnect', { Secret: init.Secret });
        return { kind, url, name, token: r.AccessToken, userId: r.User.Id, userName: r.User.Name };
      }
    }
    return null;
  })();
  return { code: init.Code, done, cancel: () => (stopped = true) };
}

// ---------- Items ----------

interface Item {
  Id: string;
  Name: string;
  Type: string;
  ProductionYear?: number;
  PremiereDate?: string;
  Overview?: string;
  CommunityRating?: number;
  OfficialRating?: string;
  Genres?: string[];
  RunTimeTicks?: number;
  ProviderIds?: Record<string, string>;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  SeriesId?: string;
  SeriesName?: string;
  SeriesPrimaryImageTag?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  UserData?: { PlayedPercentage?: number; PlaybackPositionTicks?: number; Played?: boolean; LastPlayedDate?: string };
  MediaSources?: MediaSource[];
  People?: { Name: string; Role?: string; Type?: string; Id?: string; PrimaryImageTag?: string }[];
  Studios?: { Name: string }[];
  CollectionType?: string;
  /** On a playlist: `Video` or `Audio`. */
  MediaType?: string;
  ChildCount?: number;
}

interface MediaSource {
  Id: string;
  Name?: string;
  Path?: string;
  Container?: string;
  Size?: number;
  Bitrate?: number;
  MediaStreams?: { Type: string; Codec?: string; Width?: number; Height?: number; Language?: string; DisplayTitle?: string; Channels?: number; VideoRangeType?: string; VideoRange?: string }[];
}

const FIELDS = 'ProviderIds,Overview,Genres,PremiereDate,CommunityRating,OfficialRating,RunTimeTicks';

function image(s: MediaServer, id: string, kind: 'Primary' | 'Backdrop' | 'Logo' | 'Thumb', tag?: string, size = 'maxHeight=600') {
  return `${prefix(s)}/Items/${id}/Images/${kind}${kind === 'Backdrop' ? '/0' : ''}?${size}&quality=90${tag ? `&tag=${tag}` : ''}`;
}

/** ROVE's id for a server title: its IMDb id when the server knows it, so it joins addon data. */
function idOf(s: MediaServer, it: Item) {
  const imdb = it.ProviderIds?.Imdb ?? it.ProviderIds?.IMDB;
  return imdb && /^tt\d+$/.test(imdb) ? imdb : serverItemId(s.id, it.Id);
}

function preview(s: MediaServer, it: Item): ServerItemPreview | null {
  // Episodes stand for their show.
  if (it.Type === 'Episode' && it.SeriesId) {
    return {
      id: serverItemId(s.id, it.SeriesId),
      type: 'series',
      name: it.SeriesName ?? it.Name,
      poster: it.SeriesPrimaryImageTag ? image(s, it.SeriesId, 'Primary', it.SeriesPrimaryImageTag) : undefined,
      serverItemId: it.SeriesId,
      progress: it.UserData?.PlayedPercentage ? it.UserData.PlayedPercentage / 100 : undefined,
    };
  }
  if (it.Type !== 'Movie' && it.Type !== 'Series') return null;
  const backdropTag = it.BackdropImageTags?.[0];
  return {
    id: idOf(s, it),
    type: it.Type === 'Movie' ? 'movie' : 'series',
    name: it.Name,
    poster: it.ImageTags?.Primary ? image(s, it.Id, 'Primary', it.ImageTags.Primary) : undefined,
    background: backdropTag ? image(s, it.Id, 'Backdrop', backdropTag, 'maxWidth=1920') : undefined,
    logo: it.ImageTags?.Logo ? image(s, it.Id, 'Logo', it.ImageTags.Logo, 'maxWidth=800') : undefined,
    description: it.Overview,
    releaseInfo: it.ProductionYear ? String(it.ProductionYear) : undefined,
    year: it.ProductionYear,
    imdbRating: it.CommunityRating ? it.CommunityRating.toFixed(1) : undefined,
    genres: it.Genres,
    serverItemId: it.Id,
    progress: it.UserData?.PlayedPercentage ? it.UserData.PlayedPercentage / 100 : undefined,
  };
}

const previews = (s: MediaServer, items: Item[] | undefined) => {
  const seen = new Set<string>();
  const out: ServerItemPreview[] = [];
  for (const it of items ?? []) {
    const p = preview(s, it);
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
};

interface ImdbIndex {
  /** `movie:tt…` / `series:tt…` → server item id */
  byImdb: Map<string, string>;
  /** server item id → IMDb id */
  byItem: Map<string, string>;
}

/** Every movie and show on the server by IMDb id (and back). Rebuilt every 10 minutes. */
const indexCache = cached<ImdbIndex>(10 * 60 * 1000);
function imdbIndex(s: MediaServer) {
  return indexCache(s.id, async () => {
    const r = await call<{ Items: Item[] }>(s, 'GET', userPath(s, '/Items', '/Items', { Recursive: true, IncludeItemTypes: 'Movie,Series', Fields: 'ProviderIds', EnableImages: false, EnableUserData: false }), undefined, 60000);
    const index: ImdbIndex = { byImdb: new Map(), byItem: new Map() };
    for (const it of r?.Items ?? []) {
      const imdb = it.ProviderIds?.Imdb ?? it.ProviderIds?.IMDB;
      if (!imdb || !/^tt\d+$/.test(imdb)) continue;
      index.byImdb.set(`${it.Type === 'Movie' ? 'movie' : 'series'}:${imdb}`, it.Id);
      index.byItem.set(it.Id, imdb);
    }
    return index;
  });
}

/** Shows that stood in for an episode get their IMDb id, so they open the same title page. */
async function unify(s: MediaServer, items: ServerItemPreview[]) {
  if (!items.some((p) => p.id.startsWith('srv:'))) return items;
  const index = await imdbIndex(s).catch(() => null);
  if (!index) return items;
  const seen = new Set<string>();
  return items
    .map((p) => {
      const imdb = p.id.startsWith('srv:') ? index.byItem.get(p.serverItemId) : undefined;
      return imdb ? { ...p, id: imdb } : p;
    })
    .filter((p) => !seen.has(p.id) && !!seen.add(p.id));
}

const episodesCache = cached<Item[]>(5 * 60 * 1000);
function episodesOf(s: MediaServer, seriesId: string) {
  return episodesCache(`${s.id}:${seriesId}`, async () => {
    const r = await call<{ Items: Item[] }>(s, 'GET', `/Shows/${seriesId}/Episodes?${q({ userId: s.userId, Fields: 'Overview,PremiereDate,RunTimeTicks', EnableImages: true })}`);
    return r?.Items ?? [];
  });
}

function streamFor(s: MediaServer, itemId: string, src: MediaSource, many: boolean): Stream {
  const video = src.MediaStreams?.find((m) => m.Type === 'Video');
  const audio = src.MediaStreams?.find((m) => m.Type === 'Audio');
  const res = resolutionLabel(video?.Width, video?.Height);
  const hdr = video?.VideoRangeType && video.VideoRangeType !== 'SDR' ? video.VideoRangeType : video?.VideoRange === 'HDR' ? 'HDR' : '';
  const key = isEmby(s) ? 'api_key' : 'ApiKey';
  const url = `${prefix(s)}/Videos/${itemId}/stream?${q({ static: true, mediaSourceId: src.Id, [key]: s.token })}`;
  const parts = [res, hdr, video?.Codec?.toUpperCase(), audio?.Codec?.toUpperCase(), sizeLabel(src.Size)].filter(Boolean);
  return {
    url,
    name: `${s.name}${res ? `\n${res}` : ''}`,
    title: `${many && src.Name ? `${src.Name}\n` : ''}${parts.join(' · ')}`,
    behaviorHints: { filename: src.Path?.split(/[\\/]/).pop(), videoSize: src.Size, mediaSourceId: src.Id, notWebReady: true },
  };
}

/** Play session per item, so progress reports line up with the start report. */
const sessions = new Map<string, string>();

export const jellyfinAdapter: ServerAdapter = {
  kind: 'jellyfin',

  async libraries(s) {
    const r = await call<{ Items: Item[] }>(s, 'GET', userPath(s, '/UserViews', '/Views'));
    return (r?.Items ?? [])
      .filter((v) => !v.CollectionType || ['movies', 'tvshows', 'mixed', 'homevideos'].includes(v.CollectionType))
      .map<ServerLibrary>((v) => ({ id: v.Id, name: v.Name, type: v.CollectionType === 'movies' ? 'movie' : v.CollectionType === 'tvshows' ? 'series' : 'mixed' }));
  },

  async items(s, libraryId, offset, limit) {
    const r = await call<{ Items: Item[] }>(
      s,
      'GET',
      userPath(s, '/Items', '/Items', { ParentId: libraryId, Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated,SortName', SortOrder: 'Descending', StartIndex: offset, Limit: limit, Fields: FIELDS, ImageTypeLimit: 1, EnableImageTypes: 'Primary,Backdrop,Logo' }),
    );
    return previews(s, r?.Items);
  },

  async recentlyAdded(s, limit) {
    const r = await call<Item[]>(s, 'GET', userPath(s, '/Items/Latest', '/Items/Latest', { Limit: limit, IncludeItemTypes: 'Movie,Series', Fields: FIELDS, GroupItems: true }));
    return unify(s, previews(s, Array.isArray(r) ? r : []));
  },

  async resume(s, limit) {
    const r = await call<{ Items: Item[] }>(s, 'GET', userPath(s, '/UserItems/Resume', '/Items/Resume', { Limit: limit, MediaTypes: 'Video', Fields: FIELDS }));
    return unify(s, previews(s, r?.Items));
  },

  async search(s, query, limit) {
    const r = await call<{ Items: Item[] }>(s, 'GET', userPath(s, '/Items', '/Items', { searchTerm: query, Recursive: true, IncludeItemTypes: 'Movie,Series', Limit: limit, Fields: FIELDS }));
    return previews(s, r?.Items);
  },

  async lists(s) {
    const r = await call<{ Items: Item[] }>(s, 'GET', userPath(s, '/Items', '/Items', { Recursive: true, IncludeItemTypes: 'BoxSet,Playlist', SortBy: 'SortName', SortOrder: 'Ascending', Fields: 'ChildCount', ImageTypeLimit: 1, EnableImageTypes: 'Primary' }));
    const out: ServerList[] = [];
    for (const it of r?.Items ?? []) {
      // Music playlists have nothing ROVE can show.
      if (it.Type !== 'BoxSet' && !(it.Type === 'Playlist' && it.MediaType !== 'Audio')) continue;
      out.push({ id: it.Id, kind: it.Type === 'BoxSet' ? 'collection' : 'playlist', name: it.Name, itemCount: it.ChildCount, poster: it.ImageTags?.Primary ? image(s, it.Id, 'Primary', it.ImageTags.Primary) : undefined });
    }
    // Collections first; within each group the server's order by name stays.
    return [...out.filter((l) => l.kind === 'collection'), ...out.filter((l) => l.kind === 'playlist')];
  },

  async listItems(s, list, offset, limit) {
    const page = { StartIndex: offset, Limit: limit, Fields: FIELDS, ImageTypeLimit: 1, EnableImageTypes: 'Primary,Backdrop,Logo' };
    // A box set's titles are its children; a playlist has its own call, which keeps its order.
    const path = list.kind === 'playlist' ? `/Playlists/${list.id}/Items?${q({ userId: s.userId, ...page })}` : userPath(s, '/Items', '/Items', { ParentId: list.id, ...page });
    const r = await call<{ Items: Item[]; TotalRecordCount?: number }>(s, 'GET', path);
    const raw = r?.Items ?? [];
    const end = offset + raw.length;
    const more = typeof r?.TotalRecordCount === 'number' ? end < r.TotalRecordCount : raw.length >= limit;
    return { items: await unify(s, previews(s, raw)), next: more && raw.length ? end : null };
  },

  async meta(s, itemId) {
    const it = await call<Item>(s, 'GET', userPath(s, `/Items/${itemId}`, `/Items/${itemId}`, { Fields: `${FIELDS},People,Studios` }));
    const p = it && preview(s, it);
    if (!it || !p) return null;
    const meta: Meta = {
      ...p,
      id: serverItemId(s.id, it.Id),
      released: it.PremiereDate,
      runtime: it.RunTimeTicks ? `${Math.round(it.RunTimeTicks / TICKS / 60)} min` : undefined,
      cast: it.People?.filter((x) => x.Type === 'Actor').map((x) => x.Name),
      director: it.People?.filter((x) => x.Type === 'Director').map((x) => x.Name),
      app_extras: {
        certification: it.OfficialRating,
        cast: it.People?.filter((x) => x.Type === 'Actor')
          .slice(0, 30)
          .map((x) => ({ name: x.Name, character: x.Role, photo: x.Id && x.PrimaryImageTag ? image(s, x.Id, 'Primary', x.PrimaryImageTag, 'maxHeight=300') : undefined })),
      },
      imdb_id: it.ProviderIds?.Imdb,
      moviedb_id: it.ProviderIds?.Tmdb ? Number(it.ProviderIds.Tmdb) : undefined,
    };
    if (it.Type === 'Series') {
      const eps = await episodesOf(s, it.Id);
      meta.videos = eps
        .filter((e) => e.IndexNumber !== undefined)
        .map<Video>((e) => ({
          id: serverItemId(s.id, e.Id),
          title: e.Name,
          season: e.ParentIndexNumber ?? 1,
          episode: e.IndexNumber,
          released: e.PremiereDate,
          overview: e.Overview,
          thumbnail: e.ImageTags?.Primary ? image(s, e.Id, 'Primary', e.ImageTags.Primary, 'maxWidth=640') : undefined,
          runtime: e.RunTimeTicks ? Math.round(e.RunTimeTicks / TICKS / 60) : undefined,
        }));
    }
    return meta;
  },

  async findByImdb(s, imdbId, type, season, episode) {
    const index = await imdbIndex(s);
    const id = index.byImdb.get(`${type}:${imdbId}`);
    if (!id) return null;
    if (type === 'movie') return id;
    if (season === undefined || episode === undefined) return null;
    const eps = await episodesOf(s, id);
    return eps.find((e) => (e.ParentIndexNumber ?? 1) === season && e.IndexNumber === episode)?.Id ?? null;
  },

  async streams(s, itemId) {
    const it = await call<Item>(s, 'GET', userPath(s, `/Items/${itemId}`, `/Items/${itemId}`, { Fields: 'MediaSources' }));
    const sources = it?.MediaSources ?? [];
    return sources.map((src) => streamFor(s, itemId, src, sources.length > 1));
  },

  async report(s, itemId, what, positionS, durationS) {
    let session = sessions.get(itemId);
    if (!session || what === 'start') {
      session = crypto.randomUUID().replace(/-/g, '');
      sessions.set(itemId, session);
    }
    const body = { ItemId: itemId, PlaySessionId: session, PositionTicks: Math.round(positionS * TICKS), RunTimeTicks: durationS > 0 ? Math.round(durationS * TICKS) : undefined, IsPaused: what === 'pause', CanSeek: true, PlayMethod: 'DirectPlay' };
    const path: Record<PlaybackReport, string> = { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress', pause: '/Sessions/Playing/Progress', stop: '/Sessions/Playing/Stopped' };
    await call(s, 'POST', path[what], body);
    if (what === 'stop') sessions.delete(itemId);
  },

  async setWatched(s, itemId, watched) {
    await call(s, watched ? 'POST' : 'DELETE', userPath(s, `/UserPlayedItems/${itemId}`, `/PlayedItems/${itemId}`));
  },
};


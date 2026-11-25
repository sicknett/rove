// Plex. Sign in through plex.tv with a PIN (the user approves ROVE in the browser), then pick one
// of the account's servers; ROVE finds an address that answers (local first, relay last).
// Playback is direct play of the file; the timeline is reported so Plex keeps resume points.

import type { Meta, Stream, Video } from '../addons/types';
import { cached, resolutionLabel, roveDeviceId, ServerError, serverFetch, sizeLabel } from './http';
import { serverItemId, type MediaServer, type PlaybackReport, type ServerAdapter, type ServerItemPreview, type ServerLibrary } from './types';

const PLEX_TV = 'https://plex.tv/api/v2';

async function plexHeaders(token?: string): Promise<Record<string, string>> {
  return {
    'X-Plex-Product': 'ROVE',
    'X-Plex-Version': '0.1',
    'X-Plex-Client-Identifier': await roveDeviceId(),
    'X-Plex-Platform': 'Windows',
    'X-Plex-Device': 'Windows',
    'X-Plex-Device-Name': 'ROVE',
    ...(token ? { 'X-Plex-Token': token } : {}),
  };
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') out.set(k, String(v));
  return out.toString();
};

async function pms<T>(s: Pick<MediaServer, 'url' | 'token' | 'name'>, path: string, opts: { method?: 'GET' | 'PUT' | 'POST' | 'DELETE'; timeoutMs?: number; page?: { start: number; size: number } } = {}): Promise<T> {
  const headers = await plexHeaders(s.token);
  if (opts.page) {
    headers['X-Plex-Container-Start'] = String(opts.page.start);
    headers['X-Plex-Container-Size'] = String(opts.page.size);
  }
  return serverFetch<T>({ url: `${s.url}${path}`, method: opts.method, headers, service: s.name || 'Plex', timeoutMs: opts.timeoutMs });
}

// ---------- Sign-in ----------

export interface PlexPin {
  code: string;
  authUrl: string;
  /** Resolves with the plex.tv account token, or null if it expired or was cancelled. */
  done: Promise<string | null>;
  cancel: () => void;
}

export async function startPlexSignIn(): Promise<PlexPin> {
  const headers = await plexHeaders();
  const pin = await serverFetch<{ id: number; code: string; expiresIn?: number }>({ url: `${PLEX_TV}/pins?strong=true`, method: 'POST', headers, service: 'Plex' });
  const authUrl = `https://app.plex.tv/auth#?${q({ clientID: headers['X-Plex-Client-Identifier'], code: pin.code, 'context[device][product]': 'ROVE' })}`;
  let stopped = false;
  const done = (async () => {
    const until = Date.now() + (pin.expiresIn ?? 900) * 1000;
    while (!stopped && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      if (stopped) return null;
      const state = await serverFetch<{ authToken?: string | null }>({ url: `${PLEX_TV}/pins/${pin.id}`, headers, service: 'Plex' }).catch(() => null);
      if (state?.authToken) return state.authToken;
    }
    return null;
  })();
  return { code: pin.code, authUrl, done, cancel: () => (stopped = true) };
}

interface Resource {
  name: string;
  clientIdentifier: string;
  provides: string;
  owned?: boolean;
  accessToken?: string;
  connections?: { uri: string; local: boolean; relay: boolean; protocol: string }[];
}

export interface PlexServerChoice {
  name: string;
  machineId: string;
  owned: boolean;
  token: string;
  connections: { uri: string; local: boolean; relay: boolean }[];
}

export async function plexServers(accountToken: string): Promise<PlexServerChoice[]> {
  const list = await serverFetch<Resource[]>({ url: `${PLEX_TV}/resources?includeHttps=1&includeRelay=1`, headers: await plexHeaders(accountToken), service: 'Plex' });
  return (list ?? [])
    .filter((r) => r.provides.split(',').includes('server'))
    .map((r) => ({ name: r.name, machineId: r.clientIdentifier, owned: !!r.owned, token: r.accessToken ?? accountToken, connections: (r.connections ?? []).map(({ uri, local, relay }) => ({ uri, local, relay })) }));
}

/** The first address of the server that answers: on this network, then direct remote, then relay. */
export async function pickConnection(choice: PlexServerChoice): Promise<string> {
  const order = [...choice.connections].sort((a, b) => Number(b.local) - Number(a.local) || Number(a.relay) - Number(b.relay));
  const tries = order.map((c, i) =>
    new Promise<string>((resolve, reject) => {
      // Give closer addresses a head start.
      setTimeout(() => {
        pms<{ MediaContainer?: { machineIdentifier?: string } }>({ url: c.uri.replace(/\/+$/, ''), token: choice.token, name: choice.name }, '/identity', { timeoutMs: 6000 })
          .then((r) => (r?.MediaContainer?.machineIdentifier === choice.machineId || !r?.MediaContainer ? resolve(c.uri.replace(/\/+$/, '')) : reject(new Error('other server'))))
          .catch(reject);
      }, i * 400);
    }),
  );
  try {
    return await Promise.any(tries);
  } catch {
    throw new ServerError(`${choice.name} did not answer on any of its addresses. Is it running and signed in to Plex?`);
  }
}

/**
 * A Plex server answers at different addresses on different networks (at home, away, through
 * Plex's relay), so the one saved when it was added stops working when the PC or the server
 * moves. Finds one that answers now: from plex.tv's current list when the saved token is good
 * there (a server owner's is), else among the addresses saved with the server.
 */
export async function resolvePlexAddress(s: MediaServer): Promise<Pick<MediaServer, 'url' | 'connections'>> {
  const listed = s.machineId ? (await plexServers(s.token).catch(() => [])).find((c) => c.machineId === s.machineId) : undefined;
  const connections = listed?.connections ?? s.connections ?? [];
  if (!s.machineId || !connections.length) throw new ServerError(`${s.name} could not be reached.`);
  const url = await pickConnection({ name: s.name, machineId: s.machineId, owned: true, token: s.token, connections });
  return { url, connections };
}

// ---------- Items ----------

interface PlexItem {
  ratingKey: string;
  key?: string;
  type: string;
  title: string;
  year?: number;
  summary?: string;
  thumb?: string;
  art?: string;
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  grandparentThumb?: string;
  grandparentArt?: string;
  parentIndex?: number;
  index?: number;
  originallyAvailableAt?: string;
  duration?: number;
  viewOffset?: number;
  audienceRating?: number;
  rating?: number;
  contentRating?: string;
  addedAt?: number;
  Guid?: { id: string }[];
  Genre?: { tag: string }[];
  Role?: { tag: string; role?: string; thumb?: string }[];
  Director?: { tag: string }[];
  Image?: { type: string; url: string }[];
  Media?: PlexMedia[];
}

interface PlexMedia {
  id: number;
  videoResolution?: string;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  bitrate?: number;
  container?: string;
  videoDynamicRange?: string;
  Part?: { key: string; file?: string; size?: number }[];
}

type Container<T = PlexItem> = { MediaContainer?: { Metadata?: T[]; Directory?: { key: string; title: string; type: string }[]; Hub?: { type: string; Metadata?: PlexItem[] }[]; size?: number } };

function photo(s: MediaServer, path: string | undefined, w: number, h: number) {
  if (!path) return undefined;
  return `${s.url}/photo/:/transcode?${q({ width: w, height: h, minSize: 1, upscale: 1, url: path, 'X-Plex-Token': s.token })}`;
}

const imdbOf = (it: PlexItem) => it.Guid?.map((g) => /^imdb:\/\/(tt\d+)/.exec(g.id)?.[1]).find(Boolean);
const tmdbOf = (it: PlexItem) => {
  const id = it.Guid?.map((g) => /^tmdb:\/\/(\d+)/.exec(g.id)?.[1]).find(Boolean);
  return id ? Number(id) : undefined;
};

function preview(s: MediaServer, it: PlexItem): ServerItemPreview | null {
  if (it.type === 'episode' && it.grandparentRatingKey) {
    return {
      id: serverItemId(s.id, it.grandparentRatingKey),
      type: 'series',
      name: it.grandparentTitle ?? it.title,
      poster: photo(s, it.grandparentThumb, 342, 513),
      background: photo(s, it.grandparentArt, 1920, 1080),
      serverItemId: it.grandparentRatingKey,
      progress: it.viewOffset && it.duration ? it.viewOffset / it.duration : undefined,
    };
  }
  if (it.type !== 'movie' && it.type !== 'show') return null;
  const imdb = imdbOf(it);
  const logo = it.Image?.find((i) => i.type === 'clearLogo')?.url;
  return {
    id: imdb ?? serverItemId(s.id, it.ratingKey),
    type: it.type === 'movie' ? 'movie' : 'series',
    name: it.title,
    poster: photo(s, it.thumb, 342, 513),
    background: photo(s, it.art, 1920, 1080),
    logo: logo ? photo(s, logo, 800, 310) : undefined,
    description: it.summary,
    releaseInfo: it.year ? String(it.year) : undefined,
    year: it.year,
    imdbRating: it.audienceRating ? it.audienceRating.toFixed(1) : it.rating ? it.rating.toFixed(1) : undefined,
    genres: it.Genre?.map((g) => g.tag),
    serverItemId: it.ratingKey,
    progress: it.viewOffset && it.duration ? it.viewOffset / it.duration : undefined,
  };
}

function previews(s: MediaServer, items: PlexItem[] | undefined) {
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
}

interface ImdbIndex {
  byImdb: Map<string, string>;
  byItem: Map<string, string>;
}

const indexCache = cached<ImdbIndex>(10 * 60 * 1000);
function imdbIndex(s: MediaServer) {
  return indexCache(s.id, async () => {
    const sections = await plexAdapter.libraries(s);
    const index: ImdbIndex = { byImdb: new Map(), byItem: new Map() };
    for (const lib of sections) {
      const r = await pms<Container>(s, `/library/sections/${lib.id}/all?${q({ includeGuids: 1, excludeFields: 'summary,tagline' })}`, { timeoutMs: 60000 });
      for (const it of r?.MediaContainer?.Metadata ?? []) {
        const imdb = imdbOf(it);
        if (!imdb) continue;
        index.byImdb.set(`${it.type === 'movie' ? 'movie' : 'series'}:${imdb}`, it.ratingKey);
        index.byItem.set(it.ratingKey, imdb);
      }
    }
    return index;
  });
}

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

const leavesCache = cached<PlexItem[]>(5 * 60 * 1000);
function episodesOf(s: MediaServer, showKey: string) {
  return leavesCache(`${s.id}:${showKey}`, async () => (await pms<Container>(s, `/library/metadata/${showKey}/allLeaves`))?.MediaContainer?.Metadata ?? []);
}

function streamFor(s: MediaServer, m: PlexMedia, many: boolean): Stream | null {
  const part = m.Part?.[0];
  if (!part) return null;
  const res = resolutionLabel(m.width, m.height) || (m.videoResolution ? (/^\d+$/.test(m.videoResolution) ? `${m.videoResolution}p` : m.videoResolution.toUpperCase()) : '');
  const hdr = m.videoDynamicRange && m.videoDynamicRange !== 'SDR' ? m.videoDynamicRange : '';
  const parts = [res, hdr, m.videoCodec?.toUpperCase(), m.audioCodec?.toUpperCase(), sizeLabel(part.size)].filter(Boolean);
  const file = part.file?.split(/[\\/]/).pop();
  return {
    url: `${s.url}${part.key}?${q({ 'X-Plex-Token': s.token })}`,
    name: `${s.name}${res ? `\n${res}` : ''}`,
    title: `${many && file ? `${file}\n` : ''}${parts.join(' · ')}`,
    behaviorHints: { filename: file, videoSize: part.size, notWebReady: true },
  };
}

export const plexAdapter: ServerAdapter = {
  kind: 'plex',

  async libraries(s) {
    const r = await pms<Container>(s, '/library/sections');
    return (r?.MediaContainer?.Directory ?? [])
      .filter((d) => d.type === 'movie' || d.type === 'show')
      .map<ServerLibrary>((d) => ({ id: d.key, name: d.title, type: d.type === 'movie' ? 'movie' : 'series' }));
  },

  async items(s, libraryId, offset, limit) {
    const r = await pms<Container>(s, `/library/sections/${libraryId}/all?${q({ sort: 'addedAt:desc', includeGuids: 1 })}`, { page: { start: offset, size: limit } });
    return previews(s, r?.MediaContainer?.Metadata);
  },

  async recentlyAdded(s, limit) {
    const libs = await plexAdapter.libraries(s);
    const pages = await Promise.all(
      libs.map((l) => pms<Container>(s, `/library/sections/${l.id}/all?${q({ sort: 'addedAt:desc', includeGuids: 1 })}`, { page: { start: 0, size: limit } }).catch(() => null)),
    );
    const all = pages.flatMap((p) => p?.MediaContainer?.Metadata ?? []).sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    return previews(s, all).slice(0, limit);
  },

  async resume(s, limit) {
    const r = await pms<Container>(s, `/hubs/continueWatching?${q({ includeGuids: 1, count: limit })}`).catch(() => null);
    const items = r?.MediaContainer?.Hub?.flatMap((h) => h.Metadata ?? []) ?? r?.MediaContainer?.Metadata ?? [];
    return unify(s, previews(s, items));
  },

  async search(s, query, limit) {
    const r = await pms<Container>(s, `/hubs/search?${q({ query, limit, includeGuids: 1 })}`);
    const items = (r?.MediaContainer?.Hub ?? []).filter((h) => h.type === 'movie' || h.type === 'show').flatMap((h) => h.Metadata ?? []);
    return previews(s, items);
  },

  async meta(s, itemId) {
    const r = await pms<Container>(s, `/library/metadata/${itemId}?${q({ includeGuids: 1 })}`);
    const it = r?.MediaContainer?.Metadata?.[0];
    const p = it && preview(s, it);
    if (!it || !p) return null;
    const meta: Meta = {
      ...p,
      id: serverItemId(s.id, it.ratingKey),
      released: it.originallyAvailableAt,
      runtime: it.duration ? `${Math.round(it.duration / 60000)} min` : undefined,
      cast: it.Role?.map((x) => x.tag),
      director: it.Director?.map((x) => x.tag),
      app_extras: { certification: it.contentRating, cast: it.Role?.slice(0, 30).map((x) => ({ name: x.tag, character: x.role, photo: x.thumb })) },
      imdb_id: imdbOf(it),
      moviedb_id: tmdbOf(it),
    };
    if (it.type === 'show') {
      meta.videos = (await episodesOf(s, it.ratingKey)).map<Video>((e) => ({
        id: serverItemId(s.id, e.ratingKey),
        title: e.title,
        season: e.parentIndex ?? 1,
        episode: e.index,
        released: e.originallyAvailableAt,
        overview: e.summary,
        thumbnail: photo(s, e.thumb, 640, 360),
        runtime: e.duration ? Math.round(e.duration / 60000) : undefined,
      }));
    }
    return meta;
  },

  async findByImdb(s, imdbId, type, season, episode) {
    const index = await imdbIndex(s);
    const key = index.byImdb.get(`${type}:${imdbId}`);
    if (!key) return null;
    if (type === 'movie') return key;
    if (season === undefined || episode === undefined) return null;
    return (await episodesOf(s, key)).find((e) => (e.parentIndex ?? 1) === season && e.index === episode)?.ratingKey ?? null;
  },

  async streams(s, itemId) {
    const r = await pms<Container>(s, `/library/metadata/${itemId}`);
    const media = r?.MediaContainer?.Metadata?.[0]?.Media ?? [];
    return media.map((m) => streamFor(s, m, media.length > 1)).filter((x): x is Stream => !!x);
  },

  async report(s, itemId, what, positionS, durationS) {
    const state: Record<PlaybackReport, string> = { start: 'playing', progress: 'playing', pause: 'paused', stop: 'stopped' };
    await pms(s, `/:/timeline?${q({ ratingKey: itemId, key: `/library/metadata/${itemId}`, state: state[what], time: Math.round(positionS * 1000), duration: durationS > 0 ? Math.round(durationS * 1000) : undefined })}`);
  },

  async setWatched(s, itemId, watched) {
    await pms(s, `/:/${watched ? 'scrobble' : 'unscrobble'}?${q({ identifier: 'com.plexapp.plugins.library', key: itemId })}`);
  },
};

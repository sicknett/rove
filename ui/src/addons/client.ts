// Talking to installed addons: which addon answers which request, and the requests themselves.

import { getJson, HttpError } from '../lib/http';
import { alternateId } from '../tracking/idmap';
import { idMatchesPrefixes, isImdbId, parseId, tmdbTitleNumber } from './ids';
import { addonBase, useAddons } from './store';
import { activeProfile } from '../state/profiles';
import type { InstalledAddon, Manifest, ManifestCatalog, ManifestExtra, Meta, MetaPreview, SourcedStream, Stream, SubtitleRef } from './types';
import { isServerAddon, serverAsAddon, serverCatalog, serverMeta, serversFor, serverStreams } from '../servers';
import { useServers } from '../servers/store';

export type Resource = 'catalog' | 'meta' | 'stream' | 'subtitles' | 'addon_catalog';

interface ResourceSpec {
  types?: string[];
  idPrefixes?: string[];
}

function resourceSpec(manifest: Manifest, resource: Resource): ResourceSpec | null {
  for (const r of manifest.resources) {
    if (typeof r === 'string') {
      if (r === resource) return { types: manifest.types, idPrefixes: manifest.idPrefixes };
    } else if (r.name === resource) {
      return { types: r.types ?? manifest.types, idPrefixes: r.idPrefixes ?? manifest.idPrefixes };
    }
  }
  return null;
}

/** Kids profiles never use addons that mark themselves as adult. */
function allowedForProfile(addon: InstalledAddon): boolean {
  return !(activeProfile()?.kids && addon.manifest.behaviorHints?.adult);
}

export function provides(addon: InstalledAddon, resource: Resource): boolean {
  return !!resourceSpec(addon.manifest, resource) && !(addon.disabledResources ?? []).includes(resource);
}

/** Enabled addons that answer `resource` for this type and id, in the user's order. */
export function addonsFor(resource: Resource, type: string, id?: string): InstalledAddon[] {
  return useAddons.getState().addons.filter((addon) => {
    if (!addon.enabled || !allowedForProfile(addon) || (addon.disabledResources ?? []).includes(resource)) return false;
    const spec = resourceSpec(addon.manifest, resource);
    if (!spec) return false;
    if (spec.types && spec.types.length && !spec.types.includes(type)) return false;
    // idPrefixes do not apply to catalogs.
    if (resource !== 'catalog' && id && !idMatchesPrefixes(id, spec.idPrefixes)) return false;
    return true;
  });
}

function extraString(extra: Record<string, string | number | undefined>): string {
  return Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

export function resourceUrl(addon: InstalledAddon, resource: Resource, type: string, id: string, extra: Record<string, string | number | undefined> = {}) {
  const e = extraString(extra);
  return `${addonBase(addon.url)}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${e ? `/${e}` : ''}.json`;
}

// ---------- Catalogs ----------

export function catalogExtras(catalog: ManifestCatalog): ManifestExtra[] {
  const extras: ManifestExtra[] = catalog.extra ?? [
    ...(catalog.extraSupported ?? []).map((name) => ({ name, isRequired: (catalog.extraRequired ?? []).includes(name) })),
  ];
  return extras;
}

export function catalogNeeds(catalog: ManifestCatalog) {
  return catalogExtras(catalog).filter((e) => e.isRequired).map((e) => e.name);
}

export function catalogSupports(catalog: ManifestCatalog, name: string) {
  return catalogExtras(catalog).some((e) => e.name === name);
}

export function genreOptions(catalog: ManifestCatalog): string[] {
  return catalogExtras(catalog).find((e) => e.name === 'genre')?.options ?? catalog.genres ?? [];
}

/**
 * Whether this addon's catalogs may be shown at all: it is switched on, its catalogs are not
 * switched off, and the profile may use it (Kids). Everything that lists or fetches catalogs asks
 * here: Home, the banner, Discover, Search, "See all" and collection folders.
 */
export function canBrowse(addon: InstalledAddon): boolean {
  return addon.enabled && provides(addon, 'catalog') && allowedForProfile(addon);
}

/** Live channels: ROVE has no page or player for them, so their catalogs and items are left out. */
const LIVE_TYPES = new Set(['tv', 'channel', 'events']);

export function canOpenType(type: string | undefined): boolean {
  return !type || !LIVE_TYPES.has(type);
}

/** Catalogs that can sit on Home: no required extras, and not hidden by the addon. */
export function homeCatalogs(addon: InstalledAddon): ManifestCatalog[] {
  if (!canBrowse(addon)) return [];
  return addon.manifest.catalogs.filter((c) => catalogNeeds(c).length === 0 && c.showInHome !== false && canOpenType(c.type));
}

/** The stable key a catalog row uses for layout. */
export function catalogKey(addon: InstalledAddon | { manifest: { id: string } }, catalog: { type: string; id: string }) {
  return `${addon.manifest.id}:${catalog.type}:${catalog.id}`;
}

export async function fetchCatalog(
  addon: InstalledAddon,
  catalog: Pick<ManifestCatalog, 'type' | 'id'>,
  extra: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
): Promise<MetaPreview[]> {
  if (isServerAddon(addon)) return serverCatalog(addon, catalog.id, extra);
  const url = resourceUrl(addon, 'catalog', catalog.type, catalog.id, extra);
  const res = await getJson<{ metas?: MetaPreview[] }>(url, { ttlMs: 10 * 60 * 1000, timeoutMs: 25000, signal });
  return (res?.metas ?? []).filter((m) => m && m.id && m.name && canOpenType(m.type));
}

/** The installed addon (or media server) with this id, whether or not it is in use. */
export function findAddon(addonId: string): InstalledAddon | undefined {
  if (addonId.startsWith('server:')) {
    const s = useServers.getState().servers.find((x) => `server:${x.id}` === addonId);
    return s ? serverAsAddon(s) : undefined;
  }
  return useAddons.getState().addons.find((a) => a.manifest.id === addonId);
}

/** The addon (or media server) to fetch a catalog from: `findAddon`, when `canBrowse` allows it. */
export function catalogAddon(addonId: string): InstalledAddon | undefined {
  const addon = findAddon(addonId);
  return addon && canBrowse(addon) ? addon : undefined;
}

// ---------- Meta ----------

/**
 * The other id family (`tmdb:…` for an IMDb id and the reverse) for the same title or video, when
 * some addon would take it for this resource. Null when none would, or the title does not map.
 */
async function otherFamilyId(resource: Resource, type: string, id: string): Promise<string | null> {
  const base = parseId(id).base;
  const probe = tmdbTitleNumber(base) !== null ? 'tt0' : isImdbId(base) ? 'tmdb:0' : null;
  // Asked only when it can help: the lookup may need the network. Media servers take IMDb ids.
  const takers = addonsFor(resource, type, probe ?? '').length + (resource === 'stream' && probe ? serversFor(probe).length : 0);
  if (!probe || takers === 0) return null;
  return alternateId(id, type === 'movie' ? 'movie' : 'series').catch(() => null);
}

/**
 * The first metadata addon (in the user's order) that knows this title. History may hold a title
 * under a `tmdb:` id while the installed addons take only IMDb ids (or the reverse): when no addon
 * has it under the id given, it is asked for under the other one. The metadata then carries that
 * addon's ids; callers keep using their own id for history.
 *
 * Null means no addon has the title. When none has it and at least one did not answer, that
 * error is thrown instead: a failed request must not be remembered as "no such title".
 */
export async function fetchMeta(type: string, id: string, signal?: AbortSignal): Promise<Meta | null> {
  // Titles only a media server has come from that server.
  if (id.startsWith('srv:')) return serverMeta(id);
  let failure: unknown;
  const ask = async (asId: string): Promise<Meta | null> => {
    for (const addon of addonsFor('meta', type, asId)) {
      try {
        const res = await getJson<{ meta?: Meta }>(resourceUrl(addon, 'meta', type, asId), { ttlMs: 6 * 3600 * 1000, timeoutMs: 20000, signal });
        if (res?.meta && res.meta.id) return { ...res.meta, type: res.meta.type || type };
      } catch (e) {
        if (signal?.aborted) throw e;
        // An addon answers 404 for a title it does not have: that is an answer, not a failure.
        if (!(e instanceof HttpError && e.status === 404)) failure ??= e;
      }
    }
    return null;
  };
  const found = await ask(id);
  if (found) return found;
  const other = await otherFamilyId('meta', type, id);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const again = other ? await ask(other) : null;
  if (again) return again;
  if (failure) throw failure;
  return null;
}

// ---------- Streams ----------

/** Every stream addon at once; `onAddon` fires as each one answers (or fails). */
export async function fetchStreams(
  type: string,
  id: string,
  onAddon: (addon: InstalledAddon, streams: SourcedStream[] | null, error?: unknown) => void,
  signal?: AbortSignal,
): Promise<SourcedStream[]> {
  let candidates = id.startsWith('srv:') ? [] : addonsFor('stream', type, id);
  const all: SourcedStream[] = [];
  let servers = type === 'movie' || type === 'series' ? serversFor(id) : [];
  // Nothing takes this id as it is (a `tmdb:` id with addons that want IMDb, or the reverse): ask
  // for the same video under its other id. Play buttons have normally done this already
  // (player/launch.ts streamableVideoId), since the session counts the takers before it searches.
  if (!candidates.length && !servers.length && !id.startsWith('srv:') && (type === 'movie' || type === 'series')) {
    const other = await otherFamilyId('stream', type, id);
    if (other) {
      id = other;
      candidates = addonsFor('stream', type, other);
      servers = serversFor(other);
    }
  }
  await Promise.all([
    ...servers.map(async (server) => {
      try {
        const streams = await serverStreams(server, type as 'movie' | 'series', id);
        all.push(...streams);
        onAddon(serverAsAddon(server), streams);
      } catch (e) {
        onAddon(serverAsAddon(server), null, e);
      }
    }),
    ...candidates.map(async (addon) => {
      try {
        const res = await getJson<{ streams?: Stream[] }>(resourceUrl(addon, 'stream', type, id), { ttlMs: 5 * 60 * 1000, timeoutMs: 45000, retries: 1, signal });
        const streams = (res?.streams ?? []).map((s, rank) => ({ ...s, addonId: addon.manifest.id, addonName: addon.manifest.name, rank }));
        all.push(...streams);
        onAddon(addon, streams);
      } catch (e) {
        onAddon(addon, null, e);
      }
    }),
  ]);
  return all;
}

/** Addons and media servers that will be asked for this video's sources. */
export function streamAddonCount(type: string, id: string) {
  const servers = type === 'movie' || type === 'series' ? serversFor(id).length : 0;
  return (id.startsWith('srv:') ? 0 : addonsFor('stream', type, id).length) + servers;
}

// ---------- Subtitles ----------

export async function fetchSubtitles(
  type: string,
  id: string,
  hints: { videoHash?: string; videoSize?: number; filename?: string } = {},
  signal?: AbortSignal,
): Promise<(SubtitleRef & { addonName: string })[]> {
  const candidates = addonsFor('subtitles', type, id);
  const results = await Promise.all(
    candidates.map(async (addon) => {
      try {
        const res = await getJson<{ subtitles?: SubtitleRef[] }>(resourceUrl(addon, 'subtitles', type, id, hints), { ttlMs: 30 * 60 * 1000, timeoutMs: 20000, retries: 1, signal });
        return (res?.subtitles ?? []).filter((s) => s?.url).map((s) => ({ ...s, addonName: addon.manifest.name }));
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

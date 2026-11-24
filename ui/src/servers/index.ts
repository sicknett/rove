// Media servers wired into the rest of ROVE: metadata for server-only items, server copies as
// sources next to addon sources, search, and playback reports back to the server.

import { parseId } from '../addons/ids';
import type { InstalledAddon, ManifestCatalog, Meta, MetaPreview, SourcedStream } from '../addons/types';
import { enabledServers, serverById } from './store';
import { jellyfinAdapter } from './jellyfin';
import { plexAdapter } from './plex';
import { parseServerId, type MediaServer, type PlaybackReport, type ServerAdapter, type ServerItemPreview, type ServerKind } from './types';

const adapters: Partial<Record<ServerKind, ServerAdapter>> = { jellyfin: jellyfinAdapter, emby: jellyfinAdapter, silo: jellyfinAdapter, plex: plexAdapter };

export function registerServerAdapter(a: ServerAdapter, ...also: ServerKind[]) {
  adapters[a.kind] = a;
  for (const k of also) adapters[k] = a;
}

export function serverAdapter(kind: ServerKind): ServerAdapter {
  const a = adapters[kind];
  if (!a) throw new Error(`${kind} is not supported`);
  return a;
}

/**
 * Servers look like addons to the rest of ROVE: rows for Home (continue, recently added, each
 * library), a search catalog, and sources for the picker.
 */
export function serverAsAddon(s: MediaServer): InstalledAddon {
  const catalogs: ManifestCatalog[] = [
    { type: 'movie', id: 'resume', name: `Continue on ${s.name}` },
    { type: 'movie', id: 'recent', name: `Recently added on ${s.name}` },
    ...(s.libraries ?? []).map((l) => ({ type: l.type === 'series' ? 'series' : 'movie', id: `lib_${l.id}`, name: `${l.name} · ${s.name}` })),
    { type: 'movie', id: 'search', name: s.name, showInHome: false, extra: [{ name: 'search', isRequired: true }] },
  ];
  return {
    url: `server:${s.id}`,
    enabled: s.enabled,
    addedAt: s.addedAt,
    manifest: { id: `server:${s.id}`, name: s.name, version: '', types: ['movie', 'series'], resources: ['catalog', 'stream'], catalogs },
  };
}

export const isServerAddon = (a: { url: string }) => a.url.startsWith('server:');

const PAGE = 50;

/** A server "catalog" page: `resume`, `recent`, `lib_<id>` or `search`. */
export async function serverCatalog(addon: InstalledAddon, catalogId: string, extra: Record<string, string | number | undefined>): Promise<MetaPreview[]> {
  const server = serverById(addon.url.slice('server:'.length));
  if (!server) return [];
  const a = serverAdapter(server.kind);
  const skip = Number(extra.skip) || 0;
  if (catalogId === 'search') return extra.search ? a.search(server, String(extra.search), PAGE) : [];
  if (catalogId === 'resume') return skip ? [] : a.resume(server, 40);
  if (catalogId === 'recent') return skip ? [] : a.recentlyAdded(server, 40);
  if (catalogId.startsWith('lib_')) return a.items(server, catalogId.slice(4), skip, PAGE);
  return [];
}

export function isServerStream(s: { addonId: string }) {
  return s.addonId.startsWith('server:');
}

export async function serverMeta(id: string): Promise<Meta | null> {
  const ref = parseServerId(id);
  const server = ref && serverById(ref.serverId);
  if (!ref || !server) return null;
  return serverAdapter(server.kind).meta(server, ref.itemId).catch(() => null);
}

/** Servers that could have this video: the one it came from, or every server for IMDb ids. */
export function serversFor(videoId: string): MediaServer[] {
  const ref = parseServerId(videoId);
  if (ref) return enabledServers().filter((s) => s.id === ref.serverId);
  return /^tt\d+/.test(videoId) ? enabledServers() : [];
}

/** Direct-play sources from one server for a video (a `srv:` id, or an IMDb title/episode). */
export async function serverStreams(server: MediaServer, type: 'movie' | 'series', videoId: string): Promise<SourcedStream[]> {
  const adapter = serverAdapter(server.kind);
  let itemId: string | null;
  const ref = parseServerId(videoId);
  if (ref) itemId = ref.itemId;
  else {
    const p = parseId(videoId);
    itemId = await adapter.findByImdb(server, p.base, type, p.season, p.episode);
  }
  if (!itemId) return [];
  const streams = await adapter.streams(server, itemId);
  return streams.map((s, rank) => ({
    ...s,
    addonId: `server:${server.id}`,
    addonName: server.name,
    rank,
    behaviorHints: { ...s.behaviorHints, serverId: server.id, serverItemId: itemId },
  }));
}

export async function searchServers(query: string, limit = 30): Promise<ServerItemPreview[]> {
  const results = await Promise.all(enabledServers().map((s) => serverAdapter(s.kind).search(s, query, limit).catch(() => [] as ServerItemPreview[])));
  return results.flat();
}

/** Tells the server about playback of one of its items (resume point, watched). */
export async function reportToServer(stream: SourcedStream, what: PlaybackReport, positionS: number, durationS: number) {
  const serverId = stream.behaviorHints?.serverId as string | undefined;
  const itemId = stream.behaviorHints?.serverItemId as string | undefined;
  const server = serverId ? serverById(serverId) : undefined;
  if (!server || !itemId) return;
  await serverAdapter(server.kind).report(server, itemId, what, positionS, durationS).catch((e) => console.warn('server report failed', e));
}

export function serverName(id: string) {
  return serverById(id)?.name ?? 'Server';
}

// Media servers (Jellyfin, Emby, Silo, Plex) as sources next to addons.
//
// Server items carry their IMDb id as ROVE's id when the server knows it, so a title is one title
// whether it comes from an addon or a server: one page, one Continue Watching entry, one tracker
// history. Items with no IMDb id use `srv:<serverId>:<itemId>`.

import type { Meta, MetaPreview, Stream } from '../addons/types';

/** Silo speaks Jellyfin's API, so it shares that adapter. */
export type ServerKind = 'jellyfin' | 'emby' | 'silo' | 'plex';

export const SERVER_KIND_NAMES: Record<ServerKind, string> = { jellyfin: 'Jellyfin', emby: 'Emby', silo: 'Silo', plex: 'Plex' };

export interface MediaServer {
  id: string;
  kind: ServerKind;
  name: string;
  /** Base address, e.g. https://jellyfin.example.com or http://192.168.1.10:32400 */
  url: string;
  token: string;
  userId?: string;
  userName?: string;
  /** Plex: the server's machine identifier. */
  machineId?: string;
  /**
   * Plex: every address the server was listed under when it was added (this network, remote,
   * relay). `url` is the one that answered; the others are tried when it stops answering.
   */
  connections?: { uri: string; local: boolean; relay: boolean }[];
  /** Movie and show libraries, refreshed when ROVE starts. */
  libraries?: ServerLibrary[];
  enabled: boolean;
  addedAt: number;
}

export interface ServerLibrary {
  id: string;
  name: string;
  type: 'movie' | 'series' | 'mixed';
}

export interface ServerItemPreview extends MetaPreview {
  /** The item on the server, for playback and reporting. */
  serverItemId: string;
  /** 0..1 when the server has a resume point. */
  progress?: number;
}

export type PlaybackReport = 'start' | 'progress' | 'pause' | 'stop';

export interface ServerAdapter {
  kind: ServerKind;
  libraries(s: MediaServer): Promise<ServerLibrary[]>;
  /** One page of a library, newest additions first by default. */
  items(s: MediaServer, libraryId: string, offset: number, limit: number): Promise<ServerItemPreview[]>;
  recentlyAdded(s: MediaServer, limit: number): Promise<ServerItemPreview[]>;
  /** The server's own continue watching (resume points). */
  resume(s: MediaServer, limit: number): Promise<ServerItemPreview[]>;
  search(s: MediaServer, query: string, limit: number): Promise<ServerItemPreview[]>;
  /** Full details for a server-only item (`srv:` ids), with episodes for shows. */
  meta(s: MediaServer, itemId: string): Promise<Meta | null>;
  /** The server's own item for a title or episode identified by IMDb id, if it has it. */
  findByImdb(s: MediaServer, imdbId: string, type: 'movie' | 'series', season?: number, episode?: number): Promise<string | null>;
  /** Direct-play streams for an item (one per version/file). */
  streams(s: MediaServer, itemId: string): Promise<Stream[]>;
  report(s: MediaServer, itemId: string, what: PlaybackReport, positionS: number, durationS: number): Promise<void>;
  setWatched(s: MediaServer, itemId: string, watched: boolean): Promise<void>;
}

export function serverItemId(serverId: string, itemId: string) {
  return `srv:${serverId}:${itemId}`;
}

export function parseServerId(id: string): { serverId: string; itemId: string } | null {
  const m = /^srv:([^:]+):(.+)$/.exec(id);
  return m ? { serverId: m[1], itemId: m[2] } : null;
}

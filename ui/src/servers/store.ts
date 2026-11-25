// Connected media servers, shared by every profile. Tokens are stored encrypted.

import { create } from 'zustand';
import { secrets } from '../lib/native';
import type { MediaServer, ServerLibrary } from './types';
// index imports this store too; serverAdapter is only used after both have loaded.
import { serverAdapter } from './index';
import { resolvePlexAddress } from './plex';

const DOC = 'servers';

interface ServersState {
  loaded: boolean;
  servers: MediaServer[];
  load: () => Promise<void>;
  add: (s: Omit<MediaServer, 'id' | 'addedAt' | 'enabled'>) => MediaServer;
  update: (id: string, patch: Partial<MediaServer>) => void;
  remove: (id: string) => void;
  /**
   * Puts a removed server back as it was, where it was. Under its own id: Home rows, their
   * layout and titles opened from it are all tied to that id.
   */
  restore: (server: MediaServer, index: number) => void;
  /**
   * Reads the server's libraries again and saves them when they changed. A Plex server that
   * does not answer is first looked for at its other addresses. Rejects when it stays unreachable.
   */
  refresh: (id: string) => Promise<ServerLibrary[]>;
}

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The same server signed in to again. A Plex server is known by its machine id (its address
 * differs from network to network); the others by address and user.
 */
function sameServer(a: Pick<MediaServer, 'kind' | 'url' | 'userId' | 'machineId'>, b: Pick<MediaServer, 'kind' | 'url' | 'userId' | 'machineId'>) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'plex' && a.machineId && b.machineId) return a.machineId === b.machineId;
  return a.url === b.url && a.userId === b.userId;
}

export const useServers = create<ServersState>((set, get) => {
  const save = () => secrets.write(DOC, { version: 1, servers: get().servers }).catch((e) => console.error(e));
  return {
    loaded: false,
    servers: [],
    async load() {
      const doc = await secrets.read<{ servers: MediaServer[] }>(DOC).catch(() => null);
      set({ loaded: true, servers: doc?.servers ?? [] });
      // Libraries change on the server; pick up new ones in the background.
      for (const s of get().servers.filter((x) => x.enabled)) void get().refresh(s.id).catch(() => undefined);
    },
    add(s) {
      // Signing in to the same server again replaces it, in place and under the same id.
      const existing = get().servers.find((x) => sameServer(x, s));
      const server: MediaServer = { ...s, libraries: s.libraries ?? existing?.libraries, id: existing?.id ?? newId(), addedAt: existing?.addedAt ?? Date.now(), enabled: true };
      set({ servers: existing ? get().servers.map((x) => (x.id === server.id ? server : x)) : [...get().servers, server] });
      void save();
      return server;
    },
    restore(server, index) {
      const servers = [...get().servers];
      if (servers.some((x) => x.id === server.id || sameServer(x, server))) return;
      servers.splice(Math.max(0, Math.min(servers.length, index)), 0, server);
      set({ servers });
      void save();
    },
    async refresh(id) {
      let server = get().servers.find((x) => x.id === id);
      if (!server) throw new Error('That server was removed.');
      let libraries: ServerLibrary[];
      try {
        libraries = await serverAdapter(server.kind).libraries(server);
      } catch (e) {
        // Plex: the saved address may belong to another network. Find one that answers here.
        const found = server.kind === 'plex' ? await resolvePlexAddress(server).catch(() => null) : null;
        if (!found) throw e;
        get().update(id, found);
        server = { ...server, ...found };
        libraries = await serverAdapter(server.kind).libraries(server);
      }
      const now = get().servers.find((x) => x.id === id);
      if (now && JSON.stringify(now.libraries) !== JSON.stringify(libraries)) get().update(id, { libraries });
      return libraries;
    },
    update(id, patch) {
      set({ servers: get().servers.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
      void save();
    },
    remove(id) {
      set({ servers: get().servers.filter((s) => s.id !== id) });
      void save();
    },
  };
});

export function serverById(id: string): MediaServer | undefined {
  return useServers.getState().servers.find((s) => s.id === id);
}

export function enabledServers(): MediaServer[] {
  return useServers.getState().servers.filter((s) => s.enabled);
}

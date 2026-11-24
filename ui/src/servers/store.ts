// Connected media servers, shared by every profile. Tokens are stored encrypted.

import { create } from 'zustand';
import { secrets } from '../lib/native';
import type { MediaServer } from './types';
// index imports this store too; serverAdapter is only used after both have loaded.
import { serverAdapter } from './index';

const DOC = 'servers';

interface ServersState {
  loaded: boolean;
  servers: MediaServer[];
  load: () => Promise<void>;
  add: (s: Omit<MediaServer, 'id' | 'addedAt' | 'enabled'>) => MediaServer;
  update: (id: string, patch: Partial<MediaServer>) => void;
  remove: (id: string) => void;
}

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const useServers = create<ServersState>((set, get) => {
  const save = () => secrets.write(DOC, { version: 1, servers: get().servers }).catch((e) => console.error(e));
  return {
    loaded: false,
    servers: [],
    async load() {
      const doc = await secrets.read<{ servers: MediaServer[] }>(DOC).catch(() => null);
      set({ loaded: true, servers: doc?.servers ?? [] });
      // Libraries change on the server; pick up new ones in the background.
      for (const s of get().servers.filter((x) => x.enabled)) {
        void serverAdapter(s.kind)
          .libraries(s)
          .then((libraries) => {
            const now = get().servers.find((x) => x.id === s.id);
            if (now && JSON.stringify(now.libraries) !== JSON.stringify(libraries)) get().update(s.id, { libraries });
          })
          .catch(() => undefined);
      }
    },
    add(s) {
      // Signing in to the same server again replaces it.
      const existing = get().servers.find((x) => x.kind === s.kind && x.url === s.url && x.userId === s.userId);
      const server: MediaServer = { ...s, id: existing?.id ?? newId(), addedAt: existing?.addedAt ?? Date.now(), enabled: true };
      set({ servers: [...get().servers.filter((x) => x.id !== server.id), server] });
      void save();
      return server;
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

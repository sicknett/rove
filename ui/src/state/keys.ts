// API keys for services, encrypted at rest. The TMDB key is shared by every profile; each
// profile has its own PublicMetaDB key (see tracking/pmdb-account.ts).

import { create } from 'zustand';
import { secrets } from '../lib/native';

const DOC = 'keys';

/** ROVE's own TMDB key, set at build time (ui/.env.local, VITE_TMDB_API_KEY). Used when the user has none. */
export const BUILT_IN_TMDB_KEY: string | null = (import.meta.env.VITE_TMDB_API_KEY as string | undefined)?.trim() || null;

/** The key requests use: the user's own, else ROVE's built-in one. */
export function effectiveTmdbKey(): string | null {
  return useKeys.getState().tmdbApiKey ?? BUILT_IN_TMDB_KEY;
}

interface KeysState {
  loaded: boolean;
  tmdbApiKey: string | null;
  load: () => Promise<void>;
  setTmdbApiKey: (key: string | null) => Promise<void>;
}

export const useKeys = create<KeysState>((set, get) => ({
  loaded: false,
  tmdbApiKey: null,
  async load() {
    const doc = await secrets.read<{ tmdbApiKey?: string | null }>(DOC).catch(() => null);
    set({ loaded: true, tmdbApiKey: doc?.tmdbApiKey ?? null });
  },
  async setTmdbApiKey(key) {
    const value = key?.trim() || null;
    set({ tmdbApiKey: value });
    await secrets.write(DOC, { tmdbApiKey: get().tmdbApiKey });
  },
}));

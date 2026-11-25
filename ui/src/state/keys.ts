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

/**
 * A short fingerprint of the key in use, for cache keys: answers fetched with one key (or
 * refused for it) are not reused after the key changes. It is not the key and cannot be turned
 * back into it.
 */
export function tmdbKeyId(key: string | null = effectiveTmdbKey()): string {
  if (!key) return 'none';
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
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

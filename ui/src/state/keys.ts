// API keys for services, encrypted at rest. The TMDB key is shared by every profile; each
// profile has its own PublicMetaDB key (see tracking/pmdb-account.ts). The AI assistant's
// provider, key and model live here too, shared by every profile like the TMDB key.

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

export type AiProviderId = 'claude' | 'gemini' | 'openai';

/** The connected AI assistant (see ai/). None saved means it is off and nothing is ever sent. */
export interface AiSettings {
  provider: AiProviderId;
  /** Empty only for an OpenAI-compatible server that needs none (a local one). */
  apiKey: string;
  model: string;
  /** OpenAI-compatible only: where `chat/completions` lives, without a trailing slash. */
  baseUrl?: string;
}

/** A saved assistant with anything missing or malformed counts as none. */
function readAi(v: unknown): AiSettings | null {
  const a = v as Partial<AiSettings> | null | undefined;
  if (!a || typeof a !== 'object') return null;
  if (a.provider !== 'claude' && a.provider !== 'gemini' && a.provider !== 'openai') return null;
  if (typeof a.apiKey !== 'string' || typeof a.model !== 'string' || !a.model) return null;
  if (a.provider === 'openai' ? typeof a.baseUrl !== 'string' || !a.baseUrl : !a.apiKey) return null;
  return { provider: a.provider, apiKey: a.apiKey, model: a.model, baseUrl: a.provider === 'openai' ? a.baseUrl : undefined };
}

interface KeysState {
  loaded: boolean;
  tmdbApiKey: string | null;
  /**
   * An MDBList key kept only for reading lists, for when MDBList is not the profile's tracker
   * (a connected MDBList tracker's own key is used first, see lists/providers.ts).
   */
  mdblistApiKey: string | null;
  ai: AiSettings | null;
  load: () => Promise<void>;
  setTmdbApiKey: (key: string | null) => Promise<void>;
  setMdblistApiKey: (key: string | null) => Promise<void>;
  /** Saves the assistant, or with null forgets it and its key. */
  setAi: (ai: AiSettings | null) => Promise<void>;
}

/** The whole document, every time: a save that left a field out would delete it from the file. */
const saved = (s: KeysState) => ({ tmdbApiKey: s.tmdbApiKey, mdblistApiKey: s.mdblistApiKey, ai: s.ai });

export const useKeys = create<KeysState>((set, get) => ({
  loaded: false,
  tmdbApiKey: null,
  mdblistApiKey: null,
  ai: null,
  async load() {
    const doc = await secrets.read<{ tmdbApiKey?: string | null; mdblistApiKey?: string | null; ai?: unknown }>(DOC).catch(() => null);
    set({ loaded: true, tmdbApiKey: doc?.tmdbApiKey ?? null, mdblistApiKey: doc?.mdblistApiKey ?? null, ai: readAi(doc?.ai) });
  },
  async setMdblistApiKey(key) {
    set({ mdblistApiKey: key?.trim() || null });
    await secrets.write(DOC, saved(get()));
  },
  async setTmdbApiKey(key) {
    const value = key?.trim() || null;
    set({ tmdbApiKey: value });
    await secrets.write(DOC, saved(get()));
  },
  async setAi(ai) {
    set({ ai: readAi(ai) });
    await secrets.write(DOC, saved(get()));
  },
}));

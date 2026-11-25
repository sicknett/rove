// The AI assistant: one small interface over three kinds of provider (Claude, Gemini, anything
// that speaks OpenAI's chat completions). An assistant only ever suggests titles by name; ROVE
// finds each one on TMDB itself (resolve.ts), so a made-up title never reaches the screen.

import type { AiProviderId, AiSettings } from '../state/keys';

export type { AiProviderId, AiSettings };

export interface Suggestion {
  title: string;
  /** Release year (a series: the year it first aired), when the assistant gave a believable one. */
  year?: number;
  type: 'movie' | 'series';
  /** One short sentence on why it fits. */
  reason: string;
}

/** A title from the profile's history, as it is described to the assistant. */
export interface TasteTitle {
  name: string;
  year?: string;
  type: 'movie' | 'series';
  /** Series: how many episodes were watched (a sign of how much it was liked). */
  episodes?: number;
}

export type SuggestRequest =
  /** Search → Ask: the user's own words. */
  | { kind: 'ask'; text: string; kids?: boolean }
  /** Home → For you: recommendations from what the profile watched. */
  | { kind: 'for-you'; watched: TasteTitle[]; watchlist: TasteTitle[]; kids?: boolean };

/**
 * Why an assistant could not answer, in a form the interface can act on. `message` is written
 * for the user and never contains the key.
 */
export type AiErrorKind =
  /** The provider refused the key. */
  | 'auth'
  /** The account has no credit, or billing is not set up. */
  | 'billing'
  /** The model name is unknown to the provider, or the key may not use it. */
  | 'model'
  /** Too many requests, or a quota is used up. */
  | 'rate-limit'
  /** The provider declined to answer this request. */
  | 'refusal'
  /** The answer was cut off before it was complete. */
  | 'truncated'
  /** The provider could not be reached, or took too long. */
  | 'network'
  /** The provider failed on its side (overloaded, server error). */
  | 'server'
  /** An answer came back, but not in the agreed shape. */
  | 'bad-response'
  /** The provider rejected the request itself (a setting it does not support). */
  | 'request';

export class AiError extends Error {
  constructor(readonly kind: AiErrorKind, message: string) {
    super(message);
    this.name = 'AiError';
  }
}

export interface Assistant {
  /** Titles for a request, best first. Empty when the assistant had none to offer. */
  suggest(request: SuggestRequest, signal?: AbortSignal): Promise<Suggestion[]>;
  /**
   * Asks the provider whether it accepts the key (and knows the model) without spending
   * anything. Resolves when it does; rejects with an AiError saying what is wrong.
   */
  check(signal?: AbortSignal): Promise<void>;
}

export const aborted = () => new DOMException('Aborted', 'AbortError');

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : (e as { name?: string } | null)?.name === 'AbortError';
}

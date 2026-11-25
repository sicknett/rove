// The assistant the user connected in Settings → Accounts, if any. Nothing in ROVE talks to an
// AI provider except through `assistantFor`, and only with settings the user saved.

import { useKeys } from '../state/keys';
import { gemini } from './gemini';
import { openAiCompatible, openAiName } from './openai';
import type { AiSettings, Assistant } from './types';

export function assistantFor(settings: AiSettings): Assistant {
  // Anthropic's client library is large and only needed once Claude is actually asked something,
  // so it is loaded then, not when the app starts.
  if (settings.provider === 'claude') {
    const real = () => import('./claude').then((m) => m.claude(settings));
    return { suggest: async (request, signal) => (await real()).suggest(request, signal), check: async (signal) => (await real()).check(signal) };
  }
  if (settings.provider === 'gemini') return gemini(settings);
  return openAiCompatible(settings);
}

/** Who answers, as the interface names it: Claude, Gemini, or the host of the address given. */
export function assistantName(settings: AiSettings): string {
  if (settings.provider === 'claude') return 'Claude';
  if (settings.provider === 'gemini') return 'Gemini';
  return openAiName(settings.baseUrl);
}

/** The connected assistant's settings; null while none is connected. */
export const useAssistantSettings = () => useKeys((s) => s.ai);

export const assistantSettings = () => useKeys.getState().ai;

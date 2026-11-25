// The assistant the user connected in Settings → Accounts, if any. Nothing in ROVE talks to an
// AI provider except through `assistantFor`, and only with settings the user saved.

import { useKeys } from '../state/keys';
import { claude } from './claude';
import { gemini } from './gemini';
import { openAiCompatible, openAiName } from './openai';
import type { AiSettings, Assistant } from './types';

export function assistantFor(settings: AiSettings): Assistant {
  if (settings.provider === 'claude') return claude(settings);
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

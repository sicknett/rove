// Claude, through Anthropic's own client library. Requests are billed to the user's API account.

import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { buildPrompt, parseSuggestions, SUGGESTIONS_SCHEMA } from './prompt';
import { shellFetch, TIMEOUT_MS } from './transport';
import { AiError, aborted, type AiSettings, type Assistant } from './types';

export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';

export const CLAUDE_MODELS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', detail: 'The best picks' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', detail: 'Half the price of Opus' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', detail: 'Fastest, and a fraction of the price' },
];

/**
 * Models whose safety classifiers Anthropic can back up with another model: when one of these
 * declines a request by mistake, the API answers from its recommended fallback in the same call
 * instead of returning the refusal. Haiku 5.5 has no such fallback.
 */
const WITH_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Room for the model's thinking as well as the list; a request without streaming should stay near this. */
const MAX_TOKENS = 16000;

function client(apiKey: string) {
  return new Anthropic({
    apiKey,
    // ROVE's page is the app's own window, not a website: the key is the user's, kept encrypted
    // on this PC, and goes only to Anthropic.
    dangerouslyAllowBrowser: true,
    fetch: shellFetch,
    timeout: TIMEOUT_MS,
    // One more try for a busy moment; more would leave the user waiting minutes on a dead line.
    maxRetries: 1,
  });
}

/** What went wrong, for the user. Most specific class first: every one below extends APIError. */
function explain(e: unknown, model: string, signal?: AbortSignal): Error {
  if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) return aborted();
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AiError('auth', 'Anthropic did not accept the API key. Copy it again from the Anthropic Console.');
  if (e instanceof Anthropic.PaymentRequiredError) return new AiError('billing', 'Your Anthropic account has a billing problem. Check its credit in the Anthropic Console.');
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError('auth', 'This Anthropic key is not allowed to do that. Check the key and its workspace in the Anthropic Console.');
  if (e instanceof Anthropic.NotFoundError) return new AiError('model', `Your Anthropic account cannot use ${model}. Pick another model in Settings → Accounts.`);
  if (e instanceof Anthropic.RateLimitError) return new AiError('rate-limit', 'Anthropic is turning requests away: the key hit its rate limit or its spend limit. Wait a minute and try again.');
  if (e instanceof Anthropic.BadRequestError) return new AiError('request', 'Anthropic rejected the request. If it keeps happening, check your account’s credit in the Anthropic Console.');
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AiError('network', 'Claude took too long to answer. Try again.');
  if (e instanceof Anthropic.APIConnectionError) return new AiError('network', 'Anthropic could not be reached. Check your connection and try again.');
  if (e instanceof Anthropic.InternalServerError) return new AiError('server', 'Anthropic is overloaded or having trouble right now. Try again in a moment.');
  if (e instanceof Anthropic.APIError) return new AiError('server', `Anthropic answered with an error (${e.status ?? 'no status'}). Try again.`);
  return new AiError('network', 'Claude could not be asked. Try again.');
}

export function claude(settings: AiSettings): Assistant {
  const api = client(settings.apiKey);
  const model = settings.model;
  return {
    async suggest(request, signal) {
      const { system, user } = buildPrompt(request);
      const params = {
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user' as const, content: user }],
        // A short list is a small task: low effort keeps it quick and cheap. The schema makes the
        // reply JSON of exactly this shape (structured outputs).
        output_config: { effort: 'low' as const, format: jsonSchemaOutputFormat(SUGGESTIONS_SCHEMA) },
      };
      let message: Anthropic.Message | Anthropic.Beta.BetaMessage;
      try {
        message = WITH_FALLBACK.has(model)
          ? await api.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
          : await api.messages.create(params, { signal });
      } catch (e) {
        throw explain(e, model, signal);
      }
      // Before the content is read: a refusal has none (or part of one), and a reply that ran
      // out of room is JSON cut off in the middle.
      if (message.stop_reason === 'refusal') throw new AiError('refusal', 'Claude declined this request. Try wording it differently.');
      if (message.stop_reason === 'max_tokens') throw new AiError('truncated', 'Claude’s answer was cut off before it finished. Try again, or ask for something narrower.');
      let text = '';
      for (const block of message.content) if (block.type === 'text') text += block.text;
      if (!text.trim()) throw new AiError('bad-response', 'Claude answered without any titles. Try again.');
      return parseSuggestions(text);
    },

    async check(signal) {
      try {
        // Free: it reads the model's description, which fails for a refused key (401) and for a
        // model the account cannot use (404).
        await api.models.retrieve(model, undefined, { signal });
      } catch (e) {
        throw explain(e, model, signal);
      }
    },
  };
}

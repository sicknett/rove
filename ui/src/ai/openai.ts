// Anything that speaks OpenAI's chat completions: OpenAI itself, OpenRouter, Groq, or a server
// on this PC or network (Ollama, LM Studio, llama.cpp). The user gives the address and the model.

import { buildPrompt, parseSuggestions, SHAPE_IN_WORDS, SUGGESTIONS_SCHEMA } from './prompt';
import { quote, requestJson, type JsonReply } from './transport';
import { AiError, type AiSettings, type Assistant } from './types';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-6.2-sol';

/** The address as requests use it: no trailing slash, and not the full endpoint when that was pasted. */
export function openAiBaseUrl(input: string): string {
  return input
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
}

const hostOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** This PC or the home network: where a key-less server over plain http is normal. */
function isLocal(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.localhost') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/** What is wrong with an address before anything is sent to it, or null when it can be used. */
export function baseUrlProblem(baseUrl: string, apiKey: string): string | null {
  const host = hostOf(baseUrl);
  if (!host || !/^https?:\/\//i.test(baseUrl)) return 'Enter the full address, starting with https:// (or http:// for a server on this PC).';
  // Over plain http a key can be read by anything between this PC and the server.
  if (/^http:\/\//i.test(baseUrl) && apiKey && !isLocal(host)) return 'Use an https:// address: over plain http the key could be read on the way.';
  return null;
}

/** The name shown for this connection: the service's host, since the user typed the address. */
export function openAiName(baseUrl: string | undefined): string {
  return hostOf(baseUrl ?? '').replace(/^(api|www)\./, '') || 'OpenAI-compatible server';
}

interface OpenAiError {
  error?: { message?: unknown; code?: unknown; type?: unknown } | string;
}

interface OpenAiReply {
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | { type?: string; text?: string }[] | null; refusal?: string | null };
  }[];
}

function explain(reply: JsonReply, settings: AiSettings): AiError {
  const name = openAiName(settings.baseUrl);
  const err = (reply.json as OpenAiError | null)?.error;
  const said = quote(typeof err === 'string' ? err : err?.message, settings.apiKey);
  const code = typeof err === 'object' && err ? String(err.code ?? err.type ?? '') : '';
  const tail = said ? ` It said: ${said}` : '';
  const { status } = reply;
  if (status === 401 || status === 403) return new AiError('auth', `${name} did not accept the API key.${tail}`);
  // OpenAI answers 429 when the account is out of credit, as well as for its rate limits.
  if (status === 402 || code === 'insufficient_quota') return new AiError('billing', `The account at ${name} is out of credit.${tail}`);
  if (status === 404) return new AiError('model', `${name} has no model named ${settings.model} at that address. Check both in Settings → Accounts.${tail}`);
  if (status === 429) return new AiError('rate-limit', `${name} is turning requests away for now (rate limit). Wait a minute and try again.`);
  if (status >= 500) return new AiError('server', `${name} is overloaded or having trouble right now. Try again in a moment.`);
  return new AiError('request', `${name} rejected the request (${status}).${tail}`);
}

export function openAiCompatible(settings: AiSettings): Assistant {
  const base = openAiBaseUrl(settings.baseUrl ?? OPENAI_DEFAULT_BASE_URL);
  const name = openAiName(base);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const ask = (system: string, user: string, response_format: unknown, signal?: AbortSignal) =>
    requestJson(
      name,
      {
        url: `${base}/chat/completions`,
        method: 'POST',
        headers,
        json: { model: settings.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format },
      },
      signal,
    );

  return {
    async suggest(request, signal) {
      const { system, user } = buildPrompt(request);
      // First with the schema enforced (structured outputs). Servers and models that do not have
      // that refuse the request as invalid; they are asked once more for plain JSON, with the
      // shape spelled out in words.
      let reply = await ask(system, user, { type: 'json_schema', json_schema: { name: 'suggestions', strict: true, schema: SUGGESTIONS_SCHEMA } }, signal);
      if (reply.status === 400 || reply.status === 422) {
        const plain = await ask(`${system}\n\n${SHAPE_IN_WORDS}`, user, { type: 'json_object' }, signal);
        // Refused again: the first refusal is the one that says what is really wrong.
        if (plain.status >= 200 && plain.status < 300) reply = plain;
      }
      if (reply.status < 200 || reply.status >= 300) throw explain(reply, settings);
      const choice = (reply.json as OpenAiReply | null)?.choices?.[0];
      if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new AiError('refusal', 'The assistant declined this request. Try wording it differently.');
      if (choice?.finish_reason === 'length') throw new AiError('truncated', 'The assistant’s answer was cut off before it finished. Try again, or ask for something narrower.');
      const content = choice?.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
      if (!text.trim()) throw new AiError('bad-response', `${name} answered without any titles. Try again.`);
      return parseSuggestions(text);
    },

    async check(signal) {
      const problem = baseUrlProblem(base, settings.apiKey);
      if (problem) throw new AiError('request', problem);
      const auth: Record<string, string> = settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
      // OpenRouter lists its models to anyone, so that says nothing about a key; this address
      // of theirs describes the key itself.
      const url = hostOf(base).endsWith('openrouter.ai') ? `${base}/key` : `${base}/models`;
      const reply = await requestJson(name, { url, headers: auth }, signal);
      if (reply.status === 404) throw new AiError('request', `No OpenAI-compatible API answers at that address. It usually ends in /v1.`);
      if (reply.status < 200 || reply.status >= 300) throw explain(reply, settings);
    },
  };
}

// Gemini, over Google's Generative Language API (`models.generateContent`). A key from Google AI
// Studio is free for the Flash models; on that free tier Google may use what is sent to improve
// its products, which the settings card says.

import { buildPrompt, parseSuggestions, SUGGESTIONS_SCHEMA } from './prompt';
import { quote, requestJson, type JsonReply } from './transport';
import { AiError, type AiSettings, type Assistant } from './types';

const API = 'https://generativelanguage.googleapis.com/v1beta';

/** Stable, and on the free tier. */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

/** A model name as the API path takes it: people paste `models/gemini-…` from Google's lists. */
export const geminiModel = (name: string) => name.trim().replace(/^models\//i, '');

interface GeminiError {
  error?: { code?: number; message?: string; status?: string; details?: { reason?: string }[] };
}

interface GeminiReply {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

function explain(reply: JsonReply, model: string, apiKey: string): AiError {
  const err = (reply.json as GeminiError | null)?.error;
  const said = quote(err?.message, apiKey);
  const { status } = reply;
  // A key Google does not know is a 400 with this reason, not a 401.
  if (err?.details?.some((d) => d.reason === 'API_KEY_INVALID') || status === 401) return new AiError('auth', 'Google did not accept the API key. Copy it again from Google AI Studio.');
  if (status === 403) return new AiError('auth', `Google will not let this key use the Gemini API.${said ? ` It said: ${said}` : ''}`);
  if (status === 404) return new AiError('model', `Google does not know a model named ${model}. Check the name in Settings → Accounts.`);
  if (status === 429) return new AiError('rate-limit', 'Gemini’s limit for this key is used up for now (the free tier allows only so many requests a minute and a day). Try again later.');
  if (status >= 500) return new AiError('server', 'Gemini is overloaded or having trouble right now. Try again in a moment.');
  return new AiError('request', `Google rejected the request (${status}).${said ? ` It said: ${said}` : ''}`);
}

export function gemini(settings: AiSettings): Assistant {
  const model = geminiModel(settings.model);
  // The key goes in a header: a URL ends up in logs and error text.
  const headers = { 'x-goog-api-key': settings.apiKey, 'Content-Type': 'application/json' };
  return {
    async suggest(request, signal) {
      const { system, user } = buildPrompt(request);
      const reply = await requestJson(
        'Gemini',
        {
          url: `${API}/models/${encodeURIComponent(model)}:generateContent`,
          method: 'POST',
          headers,
          json: {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            // JSON held to the schema. This is the current form; `responseSchema` is deprecated.
            generationConfig: { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SUGGESTIONS_SCHEMA } } },
          },
        },
        signal,
      );
      if (reply.status < 200 || reply.status >= 300) throw explain(reply, model, settings.apiKey);
      const data = reply.json as GeminiReply | null;
      const candidate = data?.candidates?.[0];
      // The request itself was blocked: there is no candidate to read.
      if (!candidate && data?.promptFeedback?.blockReason) throw new AiError('refusal', 'Gemini declined this request. Try wording it differently.');
      const reason = candidate?.finishReason;
      if (reason === 'MAX_TOKENS') throw new AiError('truncated', 'Gemini’s answer was cut off before it finished. Try again, or ask for something narrower.');
      // Anything but a normal stop (SAFETY, RECITATION, PROHIBITED_CONTENT, …) is Gemini holding the answer back.
      if (reason && reason !== 'STOP') throw new AiError('refusal', 'Gemini declined this request. Try wording it differently.');
      // Thought summaries come as parts too; the answer is the rest.
      const text = (candidate?.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      if (!text.trim()) throw new AiError('bad-response', 'Gemini answered without any titles. Try again.');
      return parseSuggestions(text);
    },

    async check(signal) {
      // Free: the model's description. A refused key fails here, and so does a model name Google does not know.
      const reply = await requestJson('Google', { url: `${API}/models/${encodeURIComponent(model)}`, headers: { 'x-goog-api-key': settings.apiKey } }, signal);
      if (reply.status < 200 || reply.status >= 300) throw explain(reply, model, settings.apiKey);
    },
  };
}

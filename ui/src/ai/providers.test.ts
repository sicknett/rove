// Each provider against a mocked network: what it sends (and must not send), how it reads an
// answer, and how a refusal, a cut-off answer, a malformed one and the usual errors come out.
// Claude runs through the real client library; only the shell's fetch underneath is replaced.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/native', () => ({
  NetworkError: class NetworkError extends Error {
    constructor(message: string, readonly url: string) {
      super(message);
    }
  },
  nativeFetch: vi.fn(),
}));

import { nativeFetch, NetworkError, type NativeRequest } from '../lib/native';
import { claude } from './claude';
import { gemini } from './gemini';
import { baseUrlProblem, openAiBaseUrl, openAiCompatible } from './openai';
import { SHAPE_IN_WORDS } from './prompt';
import { AiError, isAbort, type AiErrorKind } from './types';

const net = vi.mocked(nativeFetch);
const KEY = 'test-key-123456';
const PICKS = { suggestions: [{ title: 'Heat', year: 1995, type: 'movie', reason: 'A patient, precise heist film.' }] };
const ASK = { kind: 'ask', text: '90s heist movies with a twist' } as const;

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, url: '', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const answers = (...list: ReturnType<typeof reply>[]) => list.forEach((r) => net.mockResolvedValueOnce(r));
const sent = (i = 0) => net.mock.calls[i][0] as NativeRequest;
const sentBody = (i = 0) => JSON.parse(sent(i).body!) as Record<string, any>;

async function failure(run: Promise<unknown>): Promise<AiErrorKind> {
  const e = await run.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AiError);
  // Whatever goes wrong, the key is never part of what the user is shown.
  expect((e as AiError).message).not.toContain(KEY);
  return (e as AiError).kind;
}

// With braces: a function returned from beforeEach is run as the test's cleanup, and mockReset
// returns the mock itself.
beforeEach(() => {
  net.mockReset();
});

describe('Claude', () => {
  const message = (over: Record<string, unknown> = {}) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(PICKS) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...over,
  });
  const opus = () => claude({ provider: 'claude', apiKey: KEY, model: 'claude-opus-5-5' });
  // Told not to wait before its one retry, so the tests do not either.
  const NOW = { 'retry-after-ms': '1' };

  it('asks Opus for structured output at low effort, with the refusal fallback', async () => {
    answers(reply(200, message()));
    await expect(opus().suggest(ASK)).resolves.toEqual(PICKS.suggestions);

    const req = sent();
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.method).toBe('POST');
    // The key travels in a header (which one is the library's business), never in the body.
    expect(Object.values(req.headers!).some((v) => v.includes(KEY))).toBe(true);
    expect(req.body).not.toContain(KEY);
    expect(req.timeoutMs).toBe(90_000);
    expect(req.headers!['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    const body = sentBody();
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(16000);
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.properties.suggestions.type).toBe('array');
    expect(body.messages).toEqual([{ role: 'user', content: ASK.text }]);
    expect(typeof body.system).toBe('string');
    // Not accepted by the current models: sampling settings, a thinking switch, forced tools, a prefilled answer.
    for (const gone of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools', 'betas', 'stream']) expect(body, gone).not.toHaveProperty(gone);
  });

  it('gives Sonnet the fallback too, and Haiku none (it has no fallback model)', async () => {
    answers(reply(200, message({ model: 'claude-sonnet-5-5' })), reply(200, message({ model: 'claude-haiku-5-5' })));
    await claude({ provider: 'claude', apiKey: KEY, model: 'claude-sonnet-5-5' }).suggest(ASK);
    await claude({ provider: 'claude', apiKey: KEY, model: 'claude-haiku-5-5' }).suggest(ASK);
    expect(sentBody(0).fallbacks).toBe('default');
    expect(sent(1).url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent(1).headers!['anthropic-beta']).toBeUndefined();
    expect(sentBody(1)).not.toHaveProperty('fallbacks');
    expect(sentBody(1).output_config.effort).toBe('low');
  });

  it('reads the text that follows a fallback, skipping blocks that are not text', async () => {
    const content = [
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: JSON.stringify(PICKS) },
    ];
    answers(reply(200, message({ model: 'claude-opus-4-8', content })));
    await expect(opus().suggest(ASK)).resolves.toEqual(PICKS.suggestions);
  });

  it('reports a refusal, a cut-off answer and a malformed one as what they are', async () => {
    answers(reply(200, message({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: null, explanation: null } })));
    expect(await failure(opus().suggest(ASK))).toBe('refusal');

    answers(reply(200, message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"suggestions":[{"title":"He' }] })));
    expect(await failure(opus().suggest(ASK))).toBe('truncated');

    answers(reply(200, message({ content: [{ type: 'text', text: 'Here are some films.' }] })));
    expect(await failure(opus().suggest(ASK))).toBe('bad-response');

    answers(reply(200, message({ content: [] })));
    expect(await failure(opus().suggest(ASK))).toBe('bad-response');
  });

  it('turns API errors into plain reasons', async () => {
    const apiError = (type: string) => ({ type: 'error', error: { type, message: `details mentioning ${KEY}` } });
    answers(reply(401, apiError('authentication_error')));
    expect(await failure(opus().suggest(ASK))).toBe('auth');
    answers(reply(402, apiError('billing_error')));
    expect(await failure(opus().suggest(ASK))).toBe('billing');
    answers(reply(404, apiError('not_found_error')));
    expect(await failure(opus().suggest(ASK))).toBe('model');
    answers(reply(400, apiError('invalid_request_error')));
    expect(await failure(opus().suggest(ASK))).toBe('request');

    // Rate limits and a busy service are tried once more, then reported.
    net.mockReset();
    answers(reply(429, apiError('rate_limit_error'), NOW), reply(429, apiError('rate_limit_error'), NOW));
    expect(await failure(opus().suggest(ASK))).toBe('rate-limit');
    expect(net).toHaveBeenCalledTimes(2);

    net.mockReset();
    answers(reply(529, apiError('overloaded_error'), NOW), reply(200, message()));
    await expect(opus().suggest(ASK)).resolves.toEqual(PICKS.suggestions);
  });

  it('says when Anthropic cannot be reached', async () => {
    net.mockRejectedValue(new NetworkError('connection reset', 'https://api.anthropic.com/v1/messages'));
    expect(await failure(opus().suggest(ASK))).toBe('network');
  });

  it('stops when the ask is cancelled', async () => {
    const stop = new AbortController();
    // A request that stays open until it is cancelled, as a slow answer would.
    let opened!: () => void;
    const open = new Promise<void>((resolve) => (opened = resolve));
    net.mockImplementationOnce(
      (_req, signal) =>
        new Promise((_, reject) => {
          signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          opened();
        }),
    );
    const run = opus().suggest(ASK, stop.signal).catch((err: unknown) => err);
    await open;
    stop.abort();
    expect(isAbort(await run)).toBe(true);
    // Not tried again: the user asked for it to stop.
    expect(net).toHaveBeenCalledTimes(1);
  });

  it('checks a key by reading the model, which costs nothing', async () => {
    answers(reply(200, { id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }));
    await expect(opus().check()).resolves.toBeUndefined();
    expect(sent().url).toBe('https://api.anthropic.com/v1/models/claude-opus-5-5');
    expect(sent().method).toBe('GET');

    answers(reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    expect(await failure(opus().check())).toBe('auth');
    answers(reply(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-opus-5-5' } }));
    expect(await failure(opus().check())).toBe('model');
  });
});

describe('Gemini', () => {
  const flash = () => gemini({ provider: 'gemini', apiKey: KEY, model: 'models/gemini-3.8-flash' });
  const candidate = (parts: unknown[], finishReason = 'STOP') => ({ candidates: [{ content: { role: 'model', parts }, finishReason }] });

  it('asks for JSON held to the schema, with the key in a header and never in the address', async () => {
    answers(reply(200, candidate([{ text: 'weighing options', thought: true }, { text: JSON.stringify(PICKS) }])));
    await expect(flash().suggest(ASK)).resolves.toEqual(PICKS.suggestions);

    const req = sent();
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(req.url).not.toContain(KEY);
    expect(req.headers!['x-goog-api-key']).toBe(KEY);
    const body = sentBody();
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: ASK.text }] }]);
    expect(typeof body.systemInstruction.parts[0].text).toBe('string');
    expect(body.generationConfig.responseFormat.text.mimeType).toBe('APPLICATION_JSON');
    expect(body.generationConfig.responseFormat.text.schema.required).toEqual(['suggestions']);
    // The deprecated way of asking for JSON is not sent alongside the current one.
    expect(body.generationConfig).not.toHaveProperty('responseSchema');
  });

  it('reports a blocked request, a held-back answer, a cut-off one and a malformed one', async () => {
    answers(reply(200, { promptFeedback: { blockReason: 'SAFETY' } }));
    expect(await failure(flash().suggest(ASK))).toBe('refusal');
    answers(reply(200, candidate([], 'SAFETY')));
    expect(await failure(flash().suggest(ASK))).toBe('refusal');
    answers(reply(200, candidate([{ text: '{"suggestions":[{"ti' }], 'MAX_TOKENS')));
    expect(await failure(flash().suggest(ASK))).toBe('truncated');
    answers(reply(200, candidate([{ text: 'I would suggest Heat.' }])));
    expect(await failure(flash().suggest(ASK))).toBe('bad-response');
    answers(reply(200, {}));
    expect(await failure(flash().suggest(ASK))).toBe('bad-response');
    answers(reply(200, '<html>gateway</html>'));
    expect(await failure(flash().suggest(ASK))).toBe('bad-response');
  });

  it('turns API errors into plain reasons', async () => {
    // What Google really answers for a key it does not know: a 400, not a 401.
    const badKey = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } };
    answers(reply(400, badKey));
    expect(await failure(flash().suggest(ASK))).toBe('auth');
    answers(reply(403, { error: { code: 403, message: `Key ${KEY} was reported as leaked.`, status: 'PERMISSION_DENIED' } }));
    expect(await failure(flash().suggest(ASK))).toBe('auth');
    answers(reply(404, { error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } }));
    expect(await failure(flash().suggest(ASK))).toBe('model');
    answers(reply(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }));
    expect(await failure(flash().suggest(ASK))).toBe('rate-limit');
    answers(reply(503, { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }));
    expect(await failure(flash().suggest(ASK))).toBe('server');
    answers(reply(400, { error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } }));
    expect(await failure(flash().suggest(ASK))).toBe('request');
    net.mockRejectedValueOnce(new NetworkError('timed out reading response', ''));
    expect(await failure(flash().suggest(ASK))).toBe('network');
  });

  it('checks a key and a model name without generating anything', async () => {
    answers(reply(200, { name: 'models/gemini-3.8-flash' }));
    await expect(flash().check()).resolves.toBeUndefined();
    expect(sent().url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash');
    expect(sent().method ?? 'GET').toBe('GET');
    expect(sent().headers!['x-goog-api-key']).toBe(KEY);
    answers(reply(400, { error: { code: 400, details: [{ reason: 'API_KEY_INVALID' }] } }));
    expect(await failure(flash().check())).toBe('auth');
  });
});

describe('OpenAI-compatible', () => {
  const settings = { provider: 'openai', apiKey: KEY, model: 'gpt-6.2-sol', baseUrl: 'https://api.openai.com/v1' } as const;
  const openai = (over: { apiKey?: string; model?: string; baseUrl?: string } = {}) => openAiCompatible({ ...settings, ...over });
  const choice = (message: Record<string, unknown>, finish_reason = 'stop') => ({ choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }] });

  it('asks chat completions for the schema', async () => {
    answers(reply(200, choice({ content: JSON.stringify(PICKS) })));
    await expect(openai().suggest(ASK)).resolves.toEqual(PICKS.suggestions);
    const req = sent();
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers!.Authorization).toBe(`Bearer ${KEY}`);
    const body = sentBody();
    expect(body.model).toBe('gpt-6.2-sol');
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1].content).toBe(ASK.text);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(net).toHaveBeenCalledTimes(1);
  });

  it('falls back to plain JSON on a server without schemas, with the shape in words', async () => {
    answers(reply(400, { error: { message: 'response_format json_schema is not supported' } }), reply(200, choice({ content: `Sure:\n\`\`\`json\n${JSON.stringify(PICKS)}\n\`\`\`` })));
    await expect(openai({ baseUrl: 'http://localhost:11434/v1/', apiKey: '' }).suggest(ASK)).resolves.toEqual(PICKS.suggestions);
    expect(net).toHaveBeenCalledTimes(2);
    expect(sent(1).url).toBe('http://localhost:11434/v1/chat/completions');
    // A local server with no key gets no Authorization header at all.
    expect(sent(1).headers).not.toHaveProperty('Authorization');
    expect(sentBody(1).response_format).toEqual({ type: 'json_object' });
    expect(sentBody(1).messages[0].content).toContain(SHAPE_IN_WORDS);
  });

  it('keeps the first refusal when plain JSON is refused as well', async () => {
    answers(reply(400, { error: { message: 'model is required' } }), reply(400, { error: { message: 'model is required' } }));
    expect(await failure(openai().suggest(ASK))).toBe('request');
  });

  it('reports a refusal, a filtered answer, a cut-off one and a malformed one', async () => {
    answers(reply(200, choice({ content: null, refusal: 'I can’t help with that.' })));
    expect(await failure(openai().suggest(ASK))).toBe('refusal');
    answers(reply(200, choice({ content: '' }, 'content_filter')));
    expect(await failure(openai().suggest(ASK))).toBe('refusal');
    answers(reply(200, choice({ content: '{"suggestions":[{"tit' }, 'length')));
    expect(await failure(openai().suggest(ASK))).toBe('truncated');
    answers(reply(200, choice({ content: 'You could try Heat (1995).' })));
    expect(await failure(openai().suggest(ASK))).toBe('bad-response');
    answers(reply(200, { object: 'list' }));
    expect(await failure(openai().suggest(ASK))).toBe('bad-response');
  });

  it('turns API errors into plain reasons, without repeating the key', async () => {
    answers(reply(401, { error: { message: `Incorrect API key provided: ${KEY}.`, code: 'invalid_api_key' } }));
    expect(await failure(openai().suggest(ASK))).toBe('auth');
    answers(reply(429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }));
    expect(await failure(openai().suggest(ASK))).toBe('billing');
    answers(reply(429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }));
    expect(await failure(openai().suggest(ASK))).toBe('rate-limit');
    answers(reply(404, { error: { message: 'The model `nope` does not exist', code: 'model_not_found' } }));
    expect(await failure(openai().suggest(ASK))).toBe('model');
    answers(reply(502, 'Bad gateway'));
    expect(await failure(openai().suggest(ASK))).toBe('server');
  });

  it('checks the key where the service can tell: its model list, or OpenRouter’s key address', async () => {
    answers(reply(200, { data: [] }));
    await expect(openai().check()).resolves.toBeUndefined();
    expect(sent().url).toBe('https://api.openai.com/v1/models');
    expect(sent().headers!.Authorization).toBe(`Bearer ${KEY}`);

    net.mockReset();
    answers(reply(401, { error: { message: 'Missing Authentication header', code: 401 } }));
    expect(await failure(openai({ baseUrl: 'https://openrouter.ai/api/v1' }).check())).toBe('auth');
    expect(sent().url).toBe('https://openrouter.ai/api/v1/key');

    answers(reply(404, 'Not Found'));
    expect(await failure(openai({ baseUrl: 'https://api.openai.com' }).check())).toBe('request');
  });

  it('will not send a key over plain http to another machine', async () => {
    expect(await failure(openai({ baseUrl: 'http://example.com/v1' }).check())).toBe('request');
    expect(net).not.toHaveBeenCalled();
    expect(baseUrlProblem('http://example.com/v1', KEY)).toMatch(/https/);
    expect(baseUrlProblem('http://localhost:1234/v1', KEY)).toBeNull();
    expect(baseUrlProblem('http://192.168.1.20:8080/v1', '')).toBeNull();
    expect(baseUrlProblem('api.openai.com/v1', KEY)).toMatch(/full address/);
    expect(openAiBaseUrl(' https://api.groq.com/openai/v1/chat/completions/ ')).toBe('https://api.groq.com/openai/v1');
  });
});

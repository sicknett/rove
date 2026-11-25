// How assistant requests leave ROVE. Like every other request they go through the shell
// (lib/native nativeFetch): in the packaged app the page cannot call another host itself.

import { nativeFetch, type NativeRequest } from '../lib/native';
import { AiError, aborted, isAbort } from './types';

/**
 * The shell waits 45 s for an answer unless told otherwise, and two minutes at most. A model
 * that thinks before a list of twenty titles can take most of a minute.
 */
export const TIMEOUT_MS = 90_000;

/** Headers that describe the bytes on the wire, not the text the shell hands back. */
const WIRE_ONLY = new Set(['content-encoding', 'content-length', 'transfer-encoding']);
/** A Response with one of these may not carry a body at all. */
const BODILESS = new Set([204, 205, 304]);

/**
 * `fetch` for a client library that wants one (the Anthropic SDK), carried by the shell. The
 * shell answers with the whole body as text, so there is no streaming: fine for one JSON reply.
 */
export const shellFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
  const body = init?.body;
  if (body != null && typeof body !== 'string') throw new TypeError('only text request bodies can be sent');
  const method = (init?.method ?? 'GET').toUpperCase() as NonNullable<NativeRequest['method']>;
  const res = await nativeFetch({ url, method, headers, body: body ?? undefined, timeoutMs: TIMEOUT_MS }, init?.signal ?? undefined);
  const out = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (WIRE_ONLY.has(name.toLowerCase())) continue;
    try {
      out.set(name, value);
    } catch {
      /* a header the page may not hold: the caller does not need it */
    }
  }
  // Response refuses a status outside 200-599; nothing useful arrives with one anyway.
  const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
  return new Response(BODILESS.has(status) ? null : res.body, { status, headers: out });
};

export interface JsonReply {
  status: number;
  /** The parsed body, or null when it was not JSON. */
  json: unknown;
}

/**
 * One JSON request to a provider without a client library. Any status comes back as an answer
 * (the caller explains it in the provider's terms); only "no answer at all" throws, as a
 * `network` AiError naming `who`.
 */
export async function requestJson(who: string, req: Omit<NativeRequest, 'timeoutMs'> & { json?: unknown }, signal?: AbortSignal): Promise<JsonReply> {
  if (signal?.aborted) throw aborted();
  const { json, ...rest } = req;
  try {
    const res = await nativeFetch({ ...rest, body: json === undefined ? rest.body : JSON.stringify(json), timeoutMs: TIMEOUT_MS }, signal);
    let parsed: unknown = null;
    try {
      parsed = res.body.trim() ? JSON.parse(res.body) : null;
    } catch {
      /* an error page, or a proxy's own text */
    }
    return { status: res.status, json: parsed };
  } catch (e) {
    if (signal?.aborted || isAbort(e)) throw aborted();
    const slow = e instanceof Error && /timed? ?out/i.test(e.message);
    throw new AiError('network', slow ? `${who} took too long to answer. Try again.` : `${who} could not be reached. Check your connection and try again.`);
  }
}

/** A provider's own words about an error, safe to show: one line, and never the key. */
export function quote(message: unknown, apiKey: string): string {
  if (typeof message !== 'string') return '';
  let text = message.replace(/\s+/g, ' ').trim();
  if (apiKey) text = text.split(apiKey).join('your key');
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

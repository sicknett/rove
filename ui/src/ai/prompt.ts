// What every provider is asked, and how its answer is read. The providers differ only in how
// the request travels; the instructions, the reply schema and the validation are the same.

import { AiError, type SuggestRequest, type Suggestion, type TasteTitle } from './types';

/** The reply every provider is held to (structured output where the provider has it). */
export const SUGGESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The title as it is commonly known in English' },
          year: { type: 'integer', description: 'Year first released; for a series, the year its first episode aired' },
          type: { type: 'string', enum: ['movie', 'series'] },
          reason: { type: 'string', description: 'One short sentence on why it fits. No spoilers.' },
        },
        required: ['title', 'year', 'type', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
} as const;

/**
 * The same shape in words, for servers that can only promise "some JSON" and not a schema
 * (the OpenAI-compatible fallback).
 */
export const SHAPE_IN_WORDS =
  'Reply with one JSON object and nothing else, in exactly this shape: {"suggestions":[{"title":"...","year":1999,"type":"movie","reason":"..."}]}. "type" is "movie" or "series".';

/** A request is the user's own words: long enough for a real description, short enough to stay one. */
export const MAX_ASK_LENGTH = 400;

const WHO = `You are the recommendation assistant inside ROVE, a desktop app for watching films and TV series. You are helping one person decide what to watch.

Suggest only real films and TV series that have already been released. For each, give the title as it is commonly known in English, the year it was first released (for a series, the year its first episode aired), and whether it is a movie or a series. Never list the same title twice.

For each suggestion, write one short sentence saying why it fits. No spoilers.

The shape of your reply is fixed by the output schema: fill it in and add nothing else.`;

const ASK = `The person describes what they are in the mood for in their own words. Suggest 12 to 20 titles that fit, best matches first. Take what they ask for literally: a decade, a running time, a mood, a language, "like X but funnier". When they name a title as a reference point, leave that title itself out. If fewer than 12 titles honestly fit, return fewer rather than padding the list.`;

const FOR_YOU = `You are given what this person watched recently, most recent first, and what is on their watchlist. Recommend 20 titles they are likely to enjoy next, best first. Recommend nothing from either list: they have seen the first, and already plan to watch the second. Stay close to what they clearly like, with a few picks that stretch it a little, and favour titles they are less likely to have seen already over the most obvious ones. Where it helps, let the reason point to something they watched.`;

const KIDS = 'This profile belongs to a child. Suggest only titles suitable for children.';

function describe(t: TasteTitle): string {
  const what = t.type === 'movie' ? 'movie' : t.episodes && t.episodes > 1 ? `series, ${t.episodes} episodes watched` : 'series';
  return `- ${t.name}${t.year ? ` (${t.year})` : ''}, ${what}`;
}

/** The two messages a provider sends: standing instructions, and this request. */
export function buildPrompt(request: SuggestRequest, now = new Date()): { system: string; user: string } {
  // Models do not know the date; "already released" and "new this year" need it.
  const today = `Today is ${now.toISOString().slice(0, 10)}.`;
  const system = [WHO, request.kind === 'ask' ? ASK : FOR_YOU, request.kids ? KIDS : null, today].filter(Boolean).join('\n\n');
  if (request.kind === 'ask') return { system, user: request.text.trim().slice(0, MAX_ASK_LENGTH) };
  const parts = [`Watched recently:\n${request.watched.map(describe).join('\n')}`];
  if (request.watchlist.length) parts.push(`On the watchlist:\n${request.watchlist.map(describe).join('\n')}`);
  return { system, user: parts.join('\n\n') };
}

const MAX_SUGGESTIONS = 24;
const MAX_REASON = 200;
/** The first films are from 1888; nothing "already released" is further out than next year. */
const FIRST_YEAR = 1888;

function readType(v: unknown): Suggestion['type'] | null {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (t === 'movie' || t === 'film') return 'movie';
  if (t === 'series' || t === 'tv' || t === 'show' || t === 'tv series' || t === 'tv show' || t === 'miniseries') return 'series';
  return null;
}

function readYear(v: unknown, now: Date): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim().slice(0, 4)) : NaN;
  return Number.isInteger(n) && n >= FIRST_YEAR && n <= now.getFullYear() + 1 ? n : undefined;
}

function readReason(v: unknown): string {
  const text = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (text.length <= MAX_REASON) return text;
  const cut = text.slice(0, MAX_REASON);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_REASON - 40)).replace(/[\s,;:.]+$/, '')}…`;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Servers without a JSON mode wrap the object in a code fence or a sentence: take what is
    // between the first opening and the last closing bracket.
    const start = trimmed.search(/[{[]/);
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (start < 0 || end <= start) throw new Error('not JSON');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * Reads a provider's reply text into suggestions. Entries that are not usable (no title, a type
 * that is neither a movie nor a series) are dropped and repeats removed; a year that cannot be
 * right is forgotten, since the title can still be found without it. Throws `bad-response` when
 * the text is not the agreed JSON at all.
 */
export function parseSuggestions(text: string, now = new Date()): Suggestion[] {
  let data: unknown;
  try {
    data = parseJson(text);
  } catch {
    throw new AiError('bad-response', 'The assistant answered, but not in a form ROVE can read. Try again.');
  }
  const list = Array.isArray(data) ? data : (data as { suggestions?: unknown } | null)?.suggestions;
  if (!Array.isArray(list)) throw new AiError('bad-response', 'The assistant answered, but not in a form ROVE can read. Try again.');
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const item = raw as { title?: unknown; year?: unknown; type?: unknown; reason?: unknown } | null;
    const title = typeof item?.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '';
    const type = readType(item?.type);
    if (!title || title.length > 200 || !type) continue;
    const year = readYear(item?.year, now);
    const key = `${title.toLowerCase()}|${type}|${year ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, year, type, reason: readReason(item?.reason) });
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

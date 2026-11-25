// Search over everything in Settings (see catalog.ts). Every word typed has to be found in a
// control's label, its extra search words, the heading it sits under, or its hint; the best fits
// come first. (A section's own name finds the section, not every control in it.) Spelling variants and everyday words ("captions", "colour", "subs") are understood,
// a word may be cut short ("subt"), and one slip in a longer word is forgiven.

import { ENTRIES, SECTIONS, type SectionId, type SettingEntry } from './catalog';

export interface SearchResult {
  /** A control's id, or `section:<id>` for a whole section. */
  id: string;
  section: SectionId;
  sectionLabel: string;
  label: string;
  hint?: string;
  /** Where on the page: the heading, and whether it is under Advanced. Empty for a section. */
  group?: string;
  advanced?: boolean;
  /** The control to bring into view. None for a section: its page opens at the top. */
  entry?: SettingEntry;
}

/** Lower case, no accents, no punctuation: "Auto-play “Next”" → "auto play next". */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words that mean the same thing here. A typed word matches wherever any of its group would. */
const SAME: string[][] = [
  ['subtitles', 'subtitle', 'captions', 'caption', 'cc', 'subs', 'sub'],
  ['colour', 'color', 'colours', 'colors'],
  ['normalise', 'normalize'],
  ['favourite', 'favorite'],
  ['artefacts', 'artifacts'],
  ['licence', 'license'],
  ['autoplay', 'autostart'],
  ['backup', 'backups'],
  ['update', 'updates', 'upgrade'],
  ['delete', 'erase', 'wipe'],
];
const ALTERNATIVES = new Map<string, string[]>();
for (const group of SAME) for (const word of group) ALTERNATIVES.set(word, group);

/** The forms of a typed word worth looking for: itself, its synonyms, and its singular. */
function forms(token: string): string[] {
  const out = new Set<string>([token, ...(ALTERNATIVES.get(token) ?? [])]);
  if (token.length > 3 && token.endsWith('s')) out.add(token.slice(0, -1));
  return [...out];
}

/** A field's words, plus each neighbouring pair run together ("back up" is found by "backup"). */
function wordsOf(text: string | undefined): string[] {
  if (!text) return [];
  const words = fold(text).split(' ').filter(Boolean);
  const pairs = words.slice(1).map((w, i) => words[i] + w);
  return [...words, ...pairs];
}

/** Whether two words are one typing slip apart: a wrong, missing, extra or swapped letter. */
export function oneSlipApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    // One wrong letter, or two neighbours swapped.
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

interface Indexed {
  result: SearchResult;
  /** Fields from the most telling to the least, each with what a match in it is worth. */
  fields: { words: string[]; whole: number; start: number }[];
  /** How many words the label has: between equal fits, the shorter label is more about the query. */
  size: number;
  order: number;
}

function indexOf(result: SearchResult, texts: { label: string; keywords?: string; place?: string; hint?: string }, order: number): Indexed {
  return {
    result,
    order,
    size: fold(texts.label).split(' ').length,
    fields: [
      { words: wordsOf(texts.label), whole: 100, start: 80 },
      { words: wordsOf(texts.keywords), whole: 60, start: 50 },
      { words: wordsOf(texts.place), whole: 34, start: 28 },
      { words: wordsOf(texts.hint), whole: 20, start: 14 },
    ],
  };
}

function buildIndex(): Indexed[] {
  const label = new Map(SECTIONS.map((s) => [s.id, s.label]));
  const sections = SECTIONS.map((s, i) => indexOf({ id: `section:${s.id}`, section: s.id, sectionLabel: s.label, label: s.label }, { label: s.label, keywords: s.keywords }, i));
  const controls = ENTRIES.map((e, i) =>
    indexOf(
      { id: e.id, section: e.section, sectionLabel: label.get(e.section)!, label: e.label, hint: e.hint, group: e.group, advanced: e.advanced, entry: e },
      { label: e.label, keywords: e.keywords, place: `${e.group}${e.advanced ? ' advanced' : ''}`, hint: e.hint },
      SECTIONS.length + i,
    ),
  );
  return [...sections, ...controls];
}

let index: Indexed[] | null = null;

/** What one typed word is worth against one item: 0 when it is nowhere in it. */
function scoreToken(token: string, item: Indexed): number {
  const wanted = forms(token);
  let best = 0;
  for (const f of item.fields) {
    for (const w of f.words) {
      for (const t of wanted) {
        if (w === t) best = Math.max(best, f.whole);
        else if (w.startsWith(t)) best = Math.max(best, f.start);
      }
    }
    if (best >= f.whole) return best;
  }
  if (best) return best;
  // Nothing fits as typed: allow one slip in a longer word, in labels and search words only.
  if (token.length >= 5) {
    for (const f of item.fields.slice(0, 2)) if (f.words.some((w) => w.length >= 5 && oneSlipApart(w, token))) return 8;
  }
  return 0;
}

/** The settings that fit `query`, best first. Empty for an empty query. */
export function searchSettings(query: string, limit = 14): SearchResult[] {
  const tokens = fold(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  index ??= buildIndex();
  const hits: { item: Indexed; score: number; named: boolean }[] = [];
  for (const item of index) {
    let total = 0;
    let named = true;
    for (const t of tokens) {
      const s = scoreToken(t, item);
      if (!s) {
        total = 0;
        break;
      }
      total += s;
      // Found in the label itself (a whole word or its start), not only in the words around it.
      named &&= s >= 80;
    }
    if (total) hits.push({ item, score: total, named });
  }
  // Best fit first; between equals, everyday settings before advanced ones; then, when the label
  // itself holds the query, the label that says least besides it ("Back up" before "Put sign-ins
  // and keys in the backup"); then page order.
  const brevity = (h: (typeof hits)[number]) => (h.named ? h.item.size : 0);
  hits.sort((a, b) => b.score - a.score || Number(!!a.item.result.advanced) - Number(!!b.item.result.advanced) || brevity(a) - brevity(b) || a.item.order - b.item.order);
  return hits.slice(0, limit).map((h) => h.item.result);
}

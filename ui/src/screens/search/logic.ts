// What Search works out without asking anyone: how typed text is read, which answers may still
// be shown, how results from TMDB, addons and the profile's own history are merged, ordered and
// ranked. Nothing here touches a store or the network, so it is tested as it is (logic.test.ts).

import { titleKey } from '../../addons/ids';
import type { MetaPreview } from '../../addons/types';
import type { HistoryDoc } from '../../state/history';
import { hitKey, plainText, type PersonHit, type TitleHit } from '../shared/hits';

// ---------- The text ----------

/** A search starts at this many characters: one letter matches half of everything. */
export const MIN_QUERY = 2;

/** Text as it is searched for: no space at either end, one between words. */
export const tidy = (text: string) => text.trim().replace(/\s+/g, ' ');

export interface QueryRead {
  /** The tidied text. */
  text: string;
  /** An id typed instead of a name: `tt0133093` or `tmdb:603`, lower case. */
  id?: string;
  /**
   * A year at the end ("dune 2021") and the words before it. TMDB finds nothing for a name with
   * the year in it, so such text is also searched as that name in that year. It stays a guess:
   * "Wonder Woman 1984" is a title, which is why the text as typed is always searched too.
   */
  year?: number;
  base?: string;
}

export function readQuery(input: string, thisYear: number): QueryRead {
  const text = tidy(input);
  const id = /^(tt\d{5,}|tmdb:\d+)$/i.exec(text)?.[1].toLowerCase();
  if (id) return { text, id };
  const m = /^(.*\S)\s+\(?((?:19|20)\d{2})\)?$/.exec(text);
  const year = m ? Number(m[2]) : 0;
  // Nothing was released before film existed, or is listed much further ahead than next year.
  if (m && year >= 1900 && year <= thisYear + 2 && m[1].length >= MIN_QUERY) return { text, year, base: m[1] };
  return { text };
}

// ---------- Stale answers ----------

/**
 * Whether what is on show may be shown for what is in the box. While the box holds other text
 * than the query that was last sent off (a pause in typing sends it), results belong to the older
 * text and are held back: an old query's results are never shown under a new one.
 */
export const isSettled = (boxText: string, query: string) => tidy(boxText) === query;

/** An answer, kept only when it is for the query now asked: anything else is dropped as if it never came. */
export function forQuery<T extends { query: string }>(answer: T | undefined, query: string): T | undefined {
  return answer && answer.query === query ? answer : undefined;
}

/**
 * For work that overlaps itself (opening an id while another is typed): each start gets a check
 * that says whether it is still the newest. An older call that finishes late finds it is not,
 * and does nothing.
 */
export function latestOnly() {
  let newest = 0;
  return {
    start(): () => boolean {
      const mine = ++newest;
      return () => mine === newest;
    },
    /** Makes every call started so far stale. */
    cancel() {
      newest++;
    },
  };
}

// ---------- Names ----------

const ARTICLE = /^(?:the|a|an) (?=.)/;
/** A name as it is matched: plain text without a leading article, so "godfather" is "The Godfather". */
const bare = (s: string | undefined) => plainText(s).replace(ARTICLE, '');

/** Every word typed starts some word of the name ("tom han" → "Tom Hanks", "nolan" → "Christopher Nolan"). */
function wordsStart(query: string, name: string): boolean {
  const words = name.split(' ');
  return query.split(' ').every((q) => words.some((w) => w.startsWith(q)));
}

/**
 * How well typed text names something, best of the names given: 3 the whole name, 2 its start,
 * 1.5 the starts of its words, 1 somewhere inside it, 0.3 none of these (TMDB matched it on a
 * translated or alternative title).
 */
export function matchQuality(query: string, ...names: (string | undefined)[]): number {
  const q = bare(query);
  if (!q) return 0;
  let best = 0;
  for (const raw of names) {
    const n = bare(raw);
    if (!n) continue;
    best = Math.max(best, n === q ? 3 : n.startsWith(q) ? 2 : wordsStart(q, n) ? 1.5 : n.includes(q) ? 1 : 0.3);
  }
  return best;
}

// ---------- Merging and ordering ----------

/**
 * The two readings of text that ends in a year, as one list. What the text as typed found leads
 * (it is what was asked for) and more pages follow it; the name-in-that-year reading fills in
 * behind, or stands alone when the text as typed found nothing (`byYear`).
 */
export function mergeReads(asTyped: TitleHit[], inYear: TitleHit[] | null): { hits: TitleHit[]; byYear: boolean } {
  if (!inYear?.length) return { hits: asTyped, byYear: false };
  if (!asTyped.length) return { hits: inYear, byYear: true };
  const have = new Set(asTyped.map(hitKey));
  return { hits: [...asTyped, ...inYear.filter((h) => !have.has(hitKey(h)))], byYear: false };
}

export type Sort = 'relevance' | 'popularity' | 'newest' | 'rating';

/** A score from fewer votes than this says little: such titles go after the rated ones. */
const RATED_FROM = 20;

/** Titles in the order asked for. Relevance is the order they came in (TMDB's own); ties keep it. */
export function sortHits(hits: TitleHit[], sort: Sort): TitleHit[] {
  if (sort === 'relevance') return hits;
  const by: Record<Exclude<Sort, 'relevance'>, (a: TitleHit, b: TitleHit) => number> = {
    popularity: (a, b) => b.popularity - a.popularity,
    // Undated titles last.
    newest: (a, b) => (b.date ?? '').localeCompare(a.date ?? ''),
    rating: (a, b) => Number(b.votes >= RATED_FROM) - Number(a.votes >= RATED_FROM) || b.rating - a.rating,
  };
  return hits.map((h, i) => ({ h, i })).sort((a, b) => by[sort](a.h, b.h) || a.i - b.i).map((x) => x.h);
}

/** Addon results in the same orders, from what a catalog card carries. Popularity is not on it: that keeps the addon's order. */
export function sortPreviews(items: MetaPreview[], sort: Sort): MetaPreview[] {
  if (sort === 'relevance' || sort === 'popularity') return items;
  const value = (m: MetaPreview) => (sort === 'newest' ? previewYear(m) ?? 0 : Number(m.imdbRating) || 0);
  return items.map((m, i) => ({ m, i })).sort((a, b) => value(b.m) - value(a.m) || a.i - b.i).map((x) => x.m);
}

/** The year on a catalog card: `2021`, or the first of `2019-2022`. */
function previewYear(m: MetaPreview): number | undefined {
  const y = /(?:19|20)\d{2}/.exec(String(m.releaseInfo ?? m.year ?? ''))?.[0];
  return y ? Number(y) : undefined;
}

/**
 * Addon search results by type, each title once however many addons sent it, movies then shows
 * then the rest in the order they first came.
 */
export function groupByType(lists: (MetaPreview[] | undefined)[]): [string, MetaPreview[]][] {
  const map = new Map<string, MetaPreview[]>();
  const seen = new Set<string>();
  for (const list of lists) {
    for (const m of list ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const group = map.get(m.type) ?? [];
      group.push(m);
      map.set(m.type, group);
    }
  }
  const rank = (t: string) => (t === 'movie' ? 0 : t === 'series' ? 1 : 2);
  return [...map.entries()].map((e, i) => ({ e, i })).sort((a, b) => rank(a.e[0]) - rank(b.e[0]) || a.i - b.i).map((x) => x.e);
}

/**
 * Addon results without the titles TMDB already found: the same kind and name, and the same year
 * give or take one (addons and TMDB disagree about premieres) or no year on the card. They come
 * under different ids (`tt…` here, `tmdb:…` there), so the name is all there is to go by.
 */
export function withoutKnown(items: MetaPreview[], hits: TitleHit[]): MetaPreview[] {
  if (!hits.length) return items;
  const known = new Map<string, (number | undefined)[]>();
  for (const h of hits) {
    for (const name of [h.name, h.original]) {
      if (!name) continue;
      const key = `${h.type}|${plainText(name)}`;
      known.set(key, [...(known.get(key) ?? []), h.year ? Number(h.year) : undefined]);
    }
  }
  return items.filter((m) => {
    const years = known.get(`${m.type}|${plainText(m.name)}`);
    if (!years) return true;
    const year = previewYear(m);
    return !(year === undefined || years.some((y) => y === undefined || Math.abs(y - year) <= 1));
  });
}

// ---------- The best match ----------

export type TopHit = { kind: 'title'; hit: TitleHit } | { kind: 'person'; person: PersonHit };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Only the first few of each list can be the best match: TMDB's order is already by relevance. */
const TOP_CANDIDATES = 6;

/**
 * How much a matching name is trusted, 0.15 to 1, from how known the thing is. Thousands of
 * obscure entries share a name with something famous; a perfect match on one of those is worth
 * less than a near match on the famous one. A title counts as known by its votes, or by its
 * popularity when it is too new to have any.
 */
const knownTitle = (h: TitleHit) => clamp(Math.max(Math.log10(1 + h.votes) / 3, Math.log10(1 + h.popularity) / 2), 0.15, 1);
const knownPerson = (p: PersonHit) => clamp(Math.log10(1 + p.popularity), 0.15, 1);

function titleScore(q: QueryRead, h: TitleHit, index: number): number {
  const match = Math.max(matchQuality(q.text, h.name, h.original), q.base ? matchQuality(q.base, h.name, h.original) : 0);
  const inYear = q.year && h.year === String(q.year) ? 60 : 0;
  return match * 100 * knownTitle(h) + Math.log10(1 + h.popularity) * 25 + Math.log10(1 + h.votes) * 10 + inYear - index * 2;
}

function personScore(q: QueryRead, p: PersonHit, index: number): number {
  return matchQuality(q.text, p.name) * 100 * knownPerson(p) + Math.log10(1 + p.popularity) * 40 - index * 2;
}

/**
 * The one result to feature: the movie, show or person the text most likely means. A name match
 * counts most, weighed by how known the match is; popularity and votes break ties, and each
 * list's own order counts a little. Null when there is nothing to choose from.
 */
export function topHit(q: QueryRead, movies: TitleHit[], shows: TitleHit[], people: PersonHit[]): TopHit | null {
  let best: { score: number; top: TopHit } | null = null;
  const offer = (score: number, top: TopHit) => {
    if (!best || score > best.score) best = { score, top };
  };
  for (const list of [movies, shows]) list.slice(0, TOP_CANDIDATES).forEach((hit, i) => offer(titleScore(q, hit, i), { kind: 'title', hit }));
  people.slice(0, TOP_CANDIDATES).forEach((person, i) => offer(personScore(q, person, i), { kind: 'person', person }));
  return (best as { score: number; top: TopHit } | null)?.top ?? null;
}

// ---------- The profile's own titles ----------

export interface OwnTitle {
  metaId: string;
  type: 'movie' | 'series';
  name: string;
  poster?: string;
  year?: string;
  /** Why it is the profile's: being watched, on the watchlist, or watched. The first that applies. */
  where: 'progress' | 'watchlist' | 'watched';
  /** When that last happened. */
  at: number;
}

export const WHERE_LABEL: Record<OwnTitle['where'], string> = { progress: 'In progress', watchlist: 'On your Watchlist', watched: 'Watched' };

/**
 * Every title the profile has a history with, once each: what is on the watchlist, what has a
 * resume point, what has been watched. Titles history holds no name for cannot be matched and
 * are left out.
 */
export function ownTitles(h: Pick<HistoryDoc, 'library' | 'progress' | 'watched' | 'cards'>): OwnTitle[] {
  const out = new Map<string, OwnTitle>();
  const put = (metaId: string, type: 'movie' | 'series', where: OwnTitle['where'], at: number, card: { name?: string; poster?: string; year?: string }) => {
    const key = titleKey(metaId, type);
    const kept = h.cards[key];
    const had = out.get(key);
    const name = card.name ?? kept?.name ?? had?.name;
    if (!name) return;
    out.set(key, { metaId, type, name, poster: card.poster ?? kept?.poster ?? had?.poster, year: card.year ?? kept?.year ?? had?.year, where, at: Math.max(at, had?.at ?? 0) });
  };
  // Weakest reason first: a later one replaces it.
  for (const w of Object.values(h.watched)) put(w.metaId, w.type, 'watched', w.at, {});
  for (const l of Object.values(h.library)) put(l.metaId, l.type, 'watchlist', l.addedAt, l);
  for (const p of Object.values(h.progress)) put(p.metaId, p.type, 'progress', p.updatedAt, p);
  return [...out.values()];
}

/** The profile's titles whose name the text matches: names that start with it first, then the most recent. */
export function matchOwn(query: string, own: OwnTitle[], limit = 20): OwnTitle[] {
  const q = plainText(query);
  if (q.length < MIN_QUERY) return [];
  const lead = (t: OwnTitle) => Number(bare(t.name).startsWith(bare(query)));
  return own
    .filter((t) => {
      const n = plainText(t.name);
      return n.includes(q) || wordsStart(q, n);
    })
    .sort((a, b) => lead(b) - lead(a) || b.at - a.at)
    .slice(0, limit);
}

// ---------- Recent searches ----------

export const RECENT_KEPT = 12;

/** `list` with `query` put first; the same text in other capitals counts as the same search. */
export function addRecent(list: string[], query: string, kept = RECENT_KEPT): string[] {
  const q = tidy(query);
  if (!q) return list;
  return [q, ...list.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, kept);
}

export const removeRecent = (list: string[], query: string) => list.filter((r) => r.toLowerCase() !== query.toLowerCase());

// Ranking, and what happens between rows: blending several seeds' recommendations into one
// list, ordering a discover page by rating and popularity together, keeping one title out of
// several rows, and choosing which titles get a "Because you watched" row today. All pure.

import { refKey, STRONG_DEPTH, type Kind } from './taste';

/** A title TMDB suggested, reduced to what ranking and a poster card need. */
export interface Candidate {
  id: number;
  kind: Kind;
  name: string;
  /** TMDB image paths (`/abc.jpg`), not URLs: they are saved with the cached lists. */
  poster?: string;
  backdrop?: string;
  /** Release or first air date, `YYYY-MM-DD`. */
  date?: string;
  rating: number;
  votes: number;
  popularity: number;
  genres: number[];
}

export const candidateKey = (c: Pick<Candidate, 'kind' | 'id'>) => refKey(c.kind, c.id);

/** A row with fewer titles than this is not shown: two posters under a heading look broken. */
export const MIN_ROW = 8;
/** Cards in a row; "See all" has the rest. */
export const ROW_LIMIT = 20;
export const TOP_TEN = 10;

/**
 * A rating that does not trust a handful of votes: pulled towards an ordinary 6.5 until a few
 * hundred people have voted. An 8.9 from 12 votes ranks under a 7.8 from 4,000.
 */
export function steadyRating(c: Pick<Candidate, 'rating' | 'votes'>, prior = 300): number {
  const votes = Math.max(0, c.votes);
  return (votes * c.rating + prior * 6.5) / (votes + prior);
}

/** 0 for a 5 or worse, 1 for a 9 or better. */
const quality = (c: Candidate) => Math.min(1, Math.max(0, (steadyRating(c) - 5) / 4));
/** 0 with no votes, 1 from ten thousand. */
const confidence = (c: Candidate) => Math.min(1, Math.log10(Math.max(0, c.votes) + 1) / 4);

/**
 * One list from several seeds' recommendations ("Top picks"). A title scores once for every
 * seed that recommends it: the seed's weight, less the further down that seed's list it stands.
 * The seeds that agree on a title add up, so how many point at it counts most; among titles
 * one seed suggests, the stronger seeds' first suggestions lead. Rating and vote count then
 * move titles within reach of each other (a well-rated title gains up to half its score again),
 * and settle ties.
 *
 * One seed may not fill the list: of every `window` titles (a row's worth), a seed brings a
 * share at most, unless other seeds point at the same title. Otherwise the strongest seed's
 * recommendations would be the whole row, and its own "Because you watched" row would be left
 * with nothing.
 */
export function blendTopPicks(sources: { weight: number; items: Candidate[] }[], limit = 60, window = ROW_LIMIT): Candidate[] {
  const top = Math.max(...sources.map((s) => s.weight), 0);
  if (!(top > 0)) return [];
  const scored = new Map<string, { c: Candidate; support: number; seeds: number; lead: number; best: number }>();
  sources.forEach((s, n) => {
    const weight = s.weight / top;
    if (!(weight > 0)) return;
    const seen = new Set<string>();
    s.items.forEach((c, i) => {
      const key = candidateKey(c);
      if (seen.has(key)) return;
      seen.add(key);
      const part = weight * (1 - 0.5 * (i / Math.max(1, s.items.length)));
      const e = scored.get(key) ?? { c, support: 0, seeds: 0, lead: n, best: 0 };
      e.support += part;
      e.seeds++;
      // The seed that speaks loudest for the title is the one whose share it counts against.
      if (part > e.best) (e.best = part), (e.lead = n);
      scored.set(key, e);
    });
  });
  const score = (e: { c: Candidate; support: number }) => e.support * (1 + 0.5 * quality(e.c)) + 0.1 * quality(e.c) * confidence(e.c);
  let rest = [...scored.values()].sort((a, b) => score(b) - score(a) || b.c.votes - a.c.votes || a.c.id - b.c.id);
  const speaking = sources.filter((s) => s.weight > 0 && s.items.length).length;
  const share = Math.ceil(window / Math.min(Math.max(speaking, 1), 4));
  const out: Candidate[] = [];
  while (rest.length && out.length < limit) {
    const used = new Map<number, number>();
    const later: typeof rest = [];
    let taken = 0;
    for (const e of rest) {
      const mine = used.get(e.lead) ?? 0;
      if (taken < window && out.length < limit && (e.seeds > 1 || mine < share)) {
        out.push(e.c);
        taken++;
        if (e.seeds === 1) used.set(e.lead, mine + 1);
      } else later.push(e);
    }
    if (!taken) break;
    rest = later;
  }
  return out;
}

/**
 * A discover page ordered by rating and popularity together (the genre rows): TMDB sorts by one
 * or the other, and either alone gives this week's noise or a list of classics.
 */
export function rankByBlend(items: Candidate[], ratingShare = 0.6): Candidate[] {
  const maxPop = Math.max(...items.map((c) => c.popularity), 1);
  const pop = (c: Candidate) => Math.log1p(Math.max(0, c.popularity)) / Math.log1p(maxPop);
  const score = (c: Candidate) => ratingShare * quality(c) + (1 - ratingShare) * pop(c);
  return [...items].sort((a, b) => score(b) - score(a) || a.id - b.id);
}

/** High rating first, without trusting a rating a few dozen votes made ("Hidden gems"). */
export function rankByRating(items: Candidate[]): Candidate[] {
  return [...items].sort((a, b) => steadyRating(b, 80) - steadyRating(a, 80) || a.id - b.id);
}

/** Lists taken in turns (movies and shows in one row), each keeping its own order; repeats dropped. */
export function interleave(...lists: Candidate[][]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of lists) {
      const c = l[i];
      if (!c || seen.has(candidateKey(c))) continue;
      seen.add(candidateKey(c));
      out.push(c);
    }
  }
  return out;
}

export function uniqueCandidates(items: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return items.filter((c) => (seen.has(candidateKey(c)) ? false : (seen.add(candidateKey(c)), true)));
}

// ---------- Across rows ----------

export interface RowFeed {
  key: string;
  /**
   * What the row's recipe found, best first, already without what the profile has seen:
   * `pending` while it loads, `none` when the recipe does not apply, `error` when it failed.
   */
  items: Candidate[] | 'pending' | 'none' | 'error';
  /** Most cards the row shows. */
  limit: number;
  /** With fewer than this the row is not shown. */
  min: number;
  /**
   * A chart (Top 10): it shows its ranking whatever the rows above it show, since a chart with
   * holes where other rows took titles would not be a chart. What it shows is kept out of every
   * other row instead, wherever the chart stands on Home.
   */
  chart?: boolean;
}

export type RowResult = { status: 'ready'; items: Candidate[] } | { status: 'pending' | 'none' | 'error' };

/**
 * What each row shows, given all of them from the top of Home down. The charts choose first;
 * then a title goes to the first row that has it, and rows further down show their next best
 * instead. A row left with fewer than its minimum is not shown at all, and then keeps nothing
 * from the rows under it.
 *
 * A row cannot be settled before the charts and the rows above it have loaded (they choose
 * first), so it stays `pending` until they have. One that failed or does not apply holds
 * nothing up.
 */
export function assignRows(feeds: RowFeed[]): Map<string, RowResult> {
  const out = new Map<string, RowResult>();
  const taken = new Set<string>();
  let waiting = false;
  for (const f of feeds) {
    if (!f.chart) continue;
    if (f.items === 'pending') {
      waiting = true;
      out.set(f.key, { status: 'pending' });
    } else if (f.items === 'none' || f.items === 'error') out.set(f.key, { status: f.items });
    else if (f.items.length < f.min) out.set(f.key, { status: 'none' });
    else {
      const shown = f.items.slice(0, f.limit);
      for (const c of shown) taken.add(candidateKey(c));
      out.set(f.key, { status: 'ready', items: shown });
    }
  }
  for (const f of feeds) {
    if (f.chart) continue;
    if (f.items === 'none' || f.items === 'error') {
      out.set(f.key, { status: f.items });
      continue;
    }
    if (f.items === 'pending' || waiting) {
      waiting = true;
      out.set(f.key, { status: 'pending' });
      continue;
    }
    const free = f.items.filter((c) => !taken.has(candidateKey(c))).slice(0, f.limit);
    if (free.length < f.min) {
      out.set(f.key, { status: 'none' });
      continue;
    }
    for (const c of free) taken.add(candidateKey(c));
    out.set(f.key, { status: 'ready', items: free });
  }
  return out;
}

// ---------- "Because you watched" ----------

export interface SeedRef {
  kind: Kind;
  id: number;
  name?: string;
}

const DAY_MS = 24 * 3600 * 1000;

/** A number that changes at local midnight. */
export function dayNumber(now: number, timezoneOffsetMin = new Date(now).getTimezoneOffset()): number {
  return Math.floor((now - timezoneOffsetMin * 60 * 1000) / DAY_MS);
}

/** How many recently watched titles take turns at the rows. */
export const BECAUSE_POOL = 6;

/**
 * The titles that get a "Because you watched" row on a given day. From the most recently watched
 * strong seeds: the newest of them always has the first row; the others take turns at the rest,
 * a different pair each day, with a show next to a film where there is one of each. The same day
 * always gives the same answer, so the rows do not change between two looks at Home.
 *
 * `kept` is what the day already started with: those stay where they are, and only empty places
 * are filled (a first title watched in the afternoon gets its row without moving the others).
 */
export function pickBecause(seeds: (SeedRef & { depth: number; at: number; watched: boolean })[], day: number, count = 3, kept: SeedRef[] = []): SeedRef[] {
  const same = (a: SeedRef, b: SeedRef) => a.kind === b.kind && a.id === b.id;
  const picks: SeedRef[] = kept.slice(0, count);
  const pool = seeds
    .filter((s) => s.watched && s.depth >= STRONG_DEPTH)
    .sort((a, b) => b.at - a.at || b.depth - a.depth || a.id - b.id)
    .slice(0, BECAUSE_POOL);
  const take = (s: SeedRef | undefined) => {
    if (s && picks.length < count && !picks.some((p) => same(p, s))) picks.push({ kind: s.kind, id: s.id, name: s.name });
  };
  take(pool[0]);
  const rest = pool.slice(1);
  if (!rest.length) return picks;
  const turn = ((day % rest.length) + rest.length) % rest.length;
  const turned = [...rest.slice(turn), ...rest.slice(0, turn)];
  // A film and a show side by side, where the history has both.
  const lead = picks[0];
  take(turned.find((s) => lead && s.kind !== lead.kind && !picks.some((p) => same(p, s))));
  for (const s of turned) take(s);
  return picks;
}

// From a suggested title to a real one. The assistant only gives a name, a year and a type;
// TMDB decides whether that title exists and which one it is. A suggestion that does not match
// anything there is dropped, so nothing invented or misremembered turns into a card.

import { pool } from '../lib/http';
import { searchTitles, tmdbImage, type TmdbKind, type TmdbSearchItem } from '../meta/tmdb';
import type { MediaType } from '../state/history';
import { metaIdFor } from '../tracking/idmap';
import { aborted, type Suggestion } from './types';

/** A resolved suggestion: what a poster card needs, and why it was suggested. */
export interface AiCard {
  /** The IMDb id when the id map has it (what addons and history speak), `tmdb:<id>` otherwise. */
  metaId: string;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  year?: string;
  rating?: string;
  tmdbId: number;
  reason: string;
}

/** A title reduced to what has to agree: case, accents, punctuation and a leading article do not. */
export function normTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

const yearOf = (r: TmdbSearchItem) => Number((r.release_date ?? r.first_air_date ?? '').slice(0, 4)) || undefined;

/**
 * The search result that is the suggested title, or null when none is.
 *
 * The name has to agree, in English or in its original language. With a year given, the
 * result's has to be within one of it (a festival year against a release year); a different
 * year is a different film of the same name, such as a remake. Among equals TMDB's order stands,
 * which puts the best known first.
 *
 * `shortForm` also accepts the suggestion as the start of a longer title ("Birdman" for "Birdman
 * or (The Unexpected Virtue of Ignorance)"), in the very same year only. It is a last resort
 * (see `find`): a spin-off begins with its parent's name too.
 */
export function pickMatch(results: TmdbSearchItem[], want: { title: string; year?: number }, shortForm = false): TmdbSearchItem | null {
  const name = normTitle(want.title);
  if (!name) return null;
  let best: TmdbSearchItem | null = null;
  let bestScore = 0;
  for (const r of results) {
    const names = [r.title, r.name, r.original_title, r.original_name].filter((n): n is string => !!n).map(normTitle);
    const exact = names.includes(name);
    const partial = shortForm && !exact && names.some((n) => n.startsWith(`${name} `) || name.startsWith(`${n} `));
    if (!exact && !partial) continue;
    const year = yearOf(r);
    let score: number;
    if (want.year === undefined) {
      if (!exact) continue;
      score = 1;
    } else {
      // Undated on TMDB: unreleased, or too obscure to tell apart by name alone.
      if (year === undefined) continue;
      const off = Math.abs(year - want.year);
      if (off > (exact ? 1 : 0)) continue;
      score = (exact ? 4 : 2) + (off === 0 ? 1 : 0);
    }
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/** The title on TMDB, and whether it is a movie or a show there (the assistant can have that wrong). */
async function find(s: Suggestion): Promise<{ item: TmdbSearchItem; kind: TmdbKind } | null> {
  const kind: TmdbKind = s.type === 'movie' ? 'movie' : 'tv';
  // With the year first: for a common name the right film may not be on the first page without it.
  const dated = s.year ? await searchTitles(kind, s.title, s.year) : [];
  // Then without: the year can be one off, and TMDB's year filter is exact.
  const item = pickMatch(dated, s) ?? pickMatch(await searchTitles(kind, s.title), s);
  if (item) return { item, kind };
  // The rest needs a year to hold a looser match to.
  if (!s.year) return null;
  // A miniseries called a movie, or the other way round.
  const other: TmdbKind = kind === 'movie' ? 'tv' : 'movie';
  const swapped = pickMatch(await searchTitles(other, s.title, s.year), s);
  if (swapped) return { item: swapped, kind: other };
  // Last, the suggestion as the short form of a longer title. After the other type on purpose:
  // "Chernobyl" (2019) called a movie is the series of exactly that name, not the film
  // "Chernobyl: Zone of Exclusion. Finale" of the same year.
  const longer = pickMatch(dated, s, true);
  return longer ? { item: longer, kind } : null;
}

export async function resolveSuggestion(s: Suggestion): Promise<AiCard | null> {
  const found = await find(s);
  if (!found) return null;
  const { item, kind } = found;
  const date = item.release_date ?? item.first_air_date;
  // Never fails: without a mapping the title keeps its `tmdb:` id.
  const metaId = await metaIdFor(item.id, kind).catch(() => `tmdb:${item.id}`);
  return {
    metaId,
    type: kind === 'movie' ? 'movie' : 'series',
    name: (kind === 'movie' ? item.title : item.name) ?? s.title,
    poster: tmdbImage(item.poster_path, 'w342'),
    background: tmdbImage(item.backdrop_path, 'w1280'),
    year: date?.slice(0, 4) || undefined,
    rating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
    tmdbId: item.id,
    reason: s.reason,
  };
}

/**
 * Looks every suggestion up, a few at a time, keeping the assistant's order. `failed` counts
 * lookups TMDB did not answer: with no cards at all, that is the difference between "none of
 * these exist" and "TMDB could not be asked".
 */
export async function resolveSuggestions(list: Suggestion[], signal?: AbortSignal): Promise<{ cards: AiCard[]; failed: number }> {
  let failed = 0;
  const found = await pool(list, 4, async (s) => {
    if (signal?.aborted) return null;
    try {
      return await resolveSuggestion(s);
    } catch {
      failed++;
      return null;
    }
  });
  if (signal?.aborted) throw aborted();
  const cards: AiCard[] = [];
  const seen = new Set<string>();
  for (const card of found) {
    // Two suggestions can be one title (a remake's name with the original's year, say).
    if (!card || seen.has(`${card.type}:${card.tmdbId}`)) continue;
    seen.add(`${card.type}:${card.tmdbId}`);
    cards.push(card);
  }
  return { cards, failed };
}

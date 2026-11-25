// What the rows are made from: the few kinds of TMDB request the recipes use, each as a "source"
// with a name (its cache key), how long its answer stays good, and how to fetch it. A source is
// fetched once however many rows read it: all twelve seeds feed Top picks, and three of the same
// answers feed the "Because you watched" rows.

import { tmdb, type TmdbListItem } from '../meta/tmdb';
import type { Candidate } from './rank';
import type { Genre, Kind } from './taste';

const HOUR = 3600 * 1000;
/** A title's recommendations change slowly. */
export const SEED_TTL = 24 * HOUR;
/** "This week" on TMDB is recomputed daily; a few hours keeps a long session current. */
export const TRENDING_TTL = 6 * HOUR;
export const DISCOVER_TTL = 12 * HOUR;

export interface SourceSpec<T = unknown> {
  /** Names the request: two specs with one key are the same request. */
  key: string;
  ttlMs: number;
  fetch: () => Promise<T>;
}

/** A list item as the list endpoints send it (meta/tmdb's TmdbListItem names the art and dates). */
interface RawItem extends TmdbListItem {
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  adult?: boolean;
}

/** TMDB's Family and Kids genres: what a Kids profile is shown. */
export const KID_GENRES = [10751, 10762];
export const kidSafe = (c: Candidate) => c.genres.some((g) => KID_GENRES.includes(g));

/** Null for what cannot be a card: people, adult titles, and titles with no name or no poster. */
export function toCandidate(raw: RawItem, fallback: Kind): Candidate | null {
  if (raw.media_type === 'person' || raw.adult) return null;
  const kind: Kind = raw.media_type === 'movie' || raw.media_type === 'tv' ? raw.media_type : fallback;
  const name = kind === 'movie' ? raw.title ?? raw.name : raw.name ?? raw.title;
  if (!name || !raw.poster_path || !(raw.id > 0)) return null;
  return {
    id: raw.id,
    kind,
    name,
    poster: raw.poster_path,
    backdrop: raw.backdrop_path ?? undefined,
    date: (kind === 'movie' ? raw.release_date : raw.first_air_date) || undefined,
    rating: raw.vote_average ?? 0,
    votes: raw.vote_count ?? 0,
    popularity: raw.popularity ?? 0,
    genres: raw.genre_ids ?? [],
  };
}

const candidates = (items: RawItem[] | undefined, fallback: Kind) => (items ?? []).map((i) => toCandidate(i, fallback)).filter((c): c is Candidate => !!c);

/** What one request about a seed gives: its name and genres, and the titles TMDB recommends after it. */
export interface SeedBundle {
  kind: Kind;
  id: number;
  name?: string;
  genres: Genre[];
  /** The language it was made in (`en`, `ko`), as TMDB has it. */
  language?: string;
  /** TMDB's recommendations, best first: what people who liked the seed also liked. */
  recs: Candidate[];
  /** Titles alike by genre and keyword. Weaker than recommendations: used to fill a short list only. */
  similar: Candidate[];
}

/**
 * One request per seed: its details with recommendations and similar titles appended. The
 * genres feed the taste profile, the lists feed Top picks and "Because you watched".
 */
export function seedSource(kind: Kind, id: number): SourceSpec<SeedBundle> {
  return {
    key: `seed:${kind}:${id}`,
    ttlMs: SEED_TTL,
    async fetch() {
      const d = await tmdb<{ title?: string; name?: string; genres?: Genre[]; original_language?: string; recommendations?: { results?: RawItem[] }; similar?: { results?: RawItem[] } }>(
        `/${kind}/${id}`,
        { append_to_response: 'recommendations,similar' },
        SEED_TTL,
      );
      // Null is "TMDB does not know this id": a seed with nothing to say, not a failure.
      return { kind, id, name: (kind === 'movie' ? d?.title : d?.name) ?? undefined, genres: d?.genres ?? [], language: d?.original_language || undefined, recs: candidates(d?.recommendations?.results, kind), similar: candidates(d?.similar?.results, kind) };
    },
  };
}

/** What is trending this week: everything, or one type. 20 a page. */
export function trendingSource(scope: 'all' | Kind, page = 1): SourceSpec<Candidate[]> {
  return {
    key: `trending:${scope}:${page}`,
    ttlMs: TRENDING_TTL,
    async fetch() {
      const r = await tmdb<{ results?: RawItem[] }>(`/trending/${scope}/week`, { page: String(page) }, TRENDING_TTL);
      return candidates(r?.results, scope === 'tv' ? 'tv' : 'movie');
    },
  };
}

/** One page of /discover. `params` are TMDB's own names; adult titles are always left out. */
export function discoverSource(kind: Kind, params: Record<string, string>, page = 1): SourceSpec<Candidate[]> {
  const all: Record<string, string> = { include_adult: 'false', ...params, page: String(page) };
  const name = Object.keys(all)
    .sort()
    .map((k) => `${k}=${all[k]}`)
    .join('&');
  return {
    key: `discover:${kind}:${name}`,
    ttlMs: DISCOVER_TTL,
    async fetch() {
      const r = await tmdb<{ results?: RawItem[] }>(`/discover/${kind}`, all, DISCOVER_TTL);
      return candidates(r?.results, kind);
    },
  };
}

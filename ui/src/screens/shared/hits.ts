// A title or a person as TMDB's search, trending and discover lists send them, in the shape the
// Search and Discover screens work with. Nothing here asks for anything.

import type { MetaPreview } from '../../addons/types';
import type { TmdbPersonHit, TmdbTitleHit } from '../../meta/tmdb';
import { isKidGenre, type Kind } from './genres';

export interface TitleHit {
  tmdbId: number;
  kind: Kind;
  /** ROVE's own word for the kind, as cards and routes use it. */
  type: 'movie' | 'series';
  name: string;
  /** The title in its original language, when it differs. */
  original?: string;
  /** `YYYY-MM-DD`: the release, or the first episode. */
  date?: string;
  year?: string;
  rating: number;
  votes: number;
  popularity: number;
  /** TMDB image paths, not links: the size is picked where they are drawn. */
  poster?: string;
  backdrop?: string;
  overview?: string;
  genres: number[];
}

/** Null for what cannot be shown: adult titles, people, and anything without a name. */
export function toTitleHit(raw: TmdbTitleHit, fallback: Kind): TitleHit | null {
  if (raw.adult || raw.media_type === 'person' || !(raw.id > 0)) return null;
  const kind: Kind = raw.media_type === 'movie' || raw.media_type === 'tv' ? raw.media_type : fallback;
  const name = (kind === 'movie' ? raw.title ?? raw.name : raw.name ?? raw.title)?.trim();
  if (!name) return null;
  const original = (kind === 'movie' ? raw.original_title : raw.original_name)?.trim();
  const date = (kind === 'movie' ? raw.release_date : raw.first_air_date) || undefined;
  return {
    tmdbId: raw.id,
    kind,
    type: kind === 'movie' ? 'movie' : 'series',
    name,
    original: original && original !== name ? original : undefined,
    date,
    year: date?.slice(0, 4),
    rating: raw.vote_average ?? 0,
    votes: raw.vote_count ?? 0,
    popularity: raw.popularity ?? 0,
    poster: raw.poster_path ?? undefined,
    backdrop: raw.backdrop_path ?? undefined,
    overview: raw.overview || undefined,
    genres: raw.genre_ids ?? [],
  };
}

export const titleHits = (raw: TmdbTitleHit[] | undefined, fallback: Kind): TitleHit[] => (raw ?? []).map((r) => toTitleHit(r, fallback)).filter((h): h is TitleHit => !!h);

export const hitKey = (h: Pick<TitleHit, 'kind' | 'tmdbId'>) => `${h.kind}:${h.tmdbId}`;

/** Each title once, the first time it comes. */
export function uniqueHits(hits: TitleHit[]): TitleHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(hitKey(h)) && seen.add(hitKey(h)));
}

/** What a Kids profile may be shown: titles TMDB files under Family or Kids. */
export const kidSafe = (h: TitleHit) => h.genres.some(isKidGenre);

export interface PersonHit {
  id: number;
  name: string;
  /** TMDB image path. */
  photo?: string;
  /** What they are known for doing: Acting, Directing, Writing. */
  department?: string;
  popularity: number;
  knownFor: TitleHit[];
}

/** Null for adult performers and entries without a name. */
export function toPersonHit(raw: TmdbPersonHit): PersonHit | null {
  if (raw.adult || !(raw.id > 0) || !raw.name?.trim()) return null;
  return {
    id: raw.id,
    name: raw.name.trim(),
    photo: raw.profile_path ?? undefined,
    department: raw.known_for_department || undefined,
    popularity: raw.popularity ?? 0,
    knownFor: titleHits(raw.known_for, 'movie'),
  };
}

export const personHits = (raw: TmdbPersonHit[] | undefined): PersonHit[] => (raw ?? []).map(toPersonHit).filter((p): p is PersonHit => !!p);

/**
 * Whether a person is known for something many people have seen: one of their best known titles
 * has a thousand votes. TMDB's trending people are ranked by visits to their pages, which
 * performers of adult-adjacent films lead; a page that offers people unasked shows these only.
 */
export const wellKnown = (p: PersonHit) => p.knownFor.some((k) => k.votes >= 1000);

const IMG = 'https://image.tmdb.org/t/p';

/** A TMDB image path as a link at one of TMDB's widths. */
export const hitImage = (path: string | undefined, size: 'w185' | 'w342' | 'w780' | 'w1280') => (path ? `${IMG}/${size}${path}` : undefined);

/** A hit as the poster grid and rows take titles. Its id is `tmdb:<n>`, which title pages and Play resolve. */
export function hitPreview(h: TitleHit): MetaPreview {
  return {
    id: `tmdb:${h.tmdbId}`,
    type: h.type,
    name: h.name,
    poster: hitImage(h.poster, 'w342'),
    background: hitImage(h.backdrop, 'w1280'),
    releaseInfo: h.year,
    imdbRating: h.rating ? h.rating.toFixed(1) : undefined,
    description: h.overview,
  };
}

/**
 * Text as names are compared: lower case, accents and punctuation gone, one space between words.
 * "Amélie", "amelie" and "AMELIE!" are the same name.
 */
export function plainText(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

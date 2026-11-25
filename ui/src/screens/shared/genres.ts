// TMDB's genres, for Search (genre tiles, the facts of a featured title) and Discover (the genre
// filter). The two lists are written here instead of being asked for: TMDB has not changed a
// number in them in years, and a list that is here costs no request and is there at once.

export type Kind = 'movie' | 'tv';

export interface Genre {
  id: number;
  name: string;
}

export const MOVIE_GENRES: Genre[] = [
  { id: 28, name: 'Action' },
  { id: 12, name: 'Adventure' },
  { id: 16, name: 'Animation' },
  { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' },
  { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' },
  { id: 10751, name: 'Family' },
  { id: 14, name: 'Fantasy' },
  { id: 36, name: 'History' },
  { id: 27, name: 'Horror' },
  { id: 10402, name: 'Music' },
  { id: 9648, name: 'Mystery' },
  { id: 10749, name: 'Romance' },
  { id: 878, name: 'Science Fiction' },
  { id: 53, name: 'Thriller' },
  { id: 10770, name: 'TV Movie' },
  { id: 10752, name: 'War' },
  { id: 37, name: 'Western' },
];

export const TV_GENRES: Genre[] = [
  { id: 10759, name: 'Action & Adventure' },
  { id: 16, name: 'Animation' },
  { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' },
  { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' },
  { id: 10751, name: 'Family' },
  { id: 10762, name: 'Kids' },
  { id: 9648, name: 'Mystery' },
  { id: 10763, name: 'News' },
  { id: 10764, name: 'Reality' },
  { id: 10765, name: 'Sci-Fi & Fantasy' },
  { id: 10766, name: 'Soap' },
  { id: 10767, name: 'Talk' },
  { id: 10768, name: 'War & Politics' },
  { id: 37, name: 'Western' },
];

export const genresOf = (kind: Kind): Genre[] => (kind === 'tv' ? TV_GENRES : MOVIE_GENRES);

const NAMES: Record<Kind, Map<number, string>> = {
  movie: new Map(MOVIE_GENRES.map((g) => [g.id, g.name])),
  tv: new Map(TV_GENRES.map((g) => [g.id, g.name])),
};

export const genreName = (kind: Kind, id: number): string | undefined => NAMES[kind].get(id);

/** The names of a title's genres, in TMDB's order, leaving out numbers neither list has. */
export function genreNames(kind: Kind, ids: number[] | undefined, limit = 3): string[] {
  return (ids ?? [])
    .map((id) => genreName(kind, id) ?? genreName(kind === 'tv' ? 'movie' : 'tv', id))
    .filter((n): n is string => !!n)
    .slice(0, limit);
}

/** Movie genres that shows keep under another number, and the reverse. */
const MOVIE_TO_TV: Record<number, number> = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
const TV_TO_MOVIE: Record<number, number> = { 10759: 28, 10765: 878, 10768: 10752, 10762: 10751 };

/**
 * Chosen genres carried over to the other kind: the same genre where both have it, its nearest
 * relative where the number differs (Action → Action & Adventure), dropped where there is none
 * (Horror has no show genre). Lowest number first, each once.
 */
export function genresForKind(ids: number[], to: Kind): number[] {
  const map = to === 'tv' ? MOVIE_TO_TV : TV_TO_MOVIE;
  const out = new Set<number>();
  for (const id of ids) {
    const there = NAMES[to].has(id) ? id : map[id];
    if (there !== undefined && NAMES[to].has(there)) out.add(there);
  }
  return [...out].sort((a, b) => a - b);
}

/** TMDB's Family (movies) and Kids (shows) genres: what a Kids profile is kept to. */
export const KID_GENRE: Record<Kind, number> = { movie: 10751, tv: 10762 };
const KID_GENRES = new Set([10751, 10762]);
export const isKidGenre = (id: number) => KID_GENRES.has(id);

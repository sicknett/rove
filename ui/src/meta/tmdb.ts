// TMDB: logo art, cast, recommendations, trailers, certifications and IMDb/TMDB id mapping.
// Works with a v3 API key or a v4 read token; without one these return null and the
// interface falls back to what the metadata addon gives. Null also means TMDB does not know the
// id (404). Anything else that goes wrong (no answer, a refused key, a rate limit) throws, so it
// is tried again later instead of being remembered as "TMDB has nothing".

import { getJson, HttpError } from '../lib/http';
import { effectiveTmdbKey } from '../state/keys';

const API = 'https://api.themoviedb.org/3';
export const IMG = 'https://image.tmdb.org/t/p';

export type TmdbKind = 'movie' | 'tv';

export function tmdbImage(path: string | null | undefined, size: 'w92' | 'w185' | 'w300' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original' | 'h632' = 'w500') {
  return path ? `${IMG}/${size}${path}` : undefined;
}

export function hasTmdb() {
  return !!effectiveTmdbKey();
}

/** A v4 read token is a JWT and goes in a header; a v3 key goes in the query. */
function auth(key: string): { query: Record<string, string>; headers?: Record<string, string> } {
  return key.startsWith('eyJ') ? { query: {}, headers: { Authorization: `Bearer ${key}` } } : { query: { api_key: key } };
}

export async function tmdb<T>(path: string, params: Record<string, string> = {}, ttlMs = 12 * 3600 * 1000): Promise<T | null> {
  const key = effectiveTmdbKey()?.trim();
  if (!key) return null;
  const { query, headers } = auth(key);
  const url = `${API}${path}?${new URLSearchParams({ language: 'en-US', ...params, ...query })}`;
  const cacheParams = new URLSearchParams({ language: 'en-US', ...params });
  try {
    return await getJson<T>(url, { ttlMs, cacheKey: `tmdb:${path}?${cacheParams}`, headers, timeoutMs: 15000 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Asks TMDB whether it accepts `key`, before it is saved. False means TMDB refused it; a throw
 * means TMDB could not be asked (offline, or it is down), which says nothing about the key.
 */
export async function checkTmdbKey(key: string): Promise<boolean> {
  const { query, headers } = auth(key.trim());
  try {
    await getJson(`${API}/configuration?${new URLSearchParams(query)}`, { headers, timeoutMs: 15000, retries: 1 });
    return true;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 404)) return false;
    throw e;
  }
}

export interface TmdbFindResult {
  id: number;
  kind: TmdbKind;
}

export async function findByImdb(imdbId: string): Promise<TmdbFindResult | null> {
  const res = await tmdb<{ movie_results?: { id: number }[]; tv_results?: { id: number }[] }>(`/find/${imdbId}`, { external_source: 'imdb_id' }, 7 * 24 * 3600 * 1000);
  if (res?.movie_results?.[0]) return { id: res.movie_results[0].id, kind: 'movie' };
  if (res?.tv_results?.[0]) return { id: res.tv_results[0].id, kind: 'tv' };
  return null;
}

export async function externalIds(kind: TmdbKind, id: number): Promise<{ imdb_id?: string | null; tvdb_id?: number | null } | null> {
  return tmdb(`/${kind}/${id}/external_ids`, {}, 7 * 24 * 3600 * 1000);
}

interface TmdbImage {
  file_path: string;
  iso_639_1: string | null;
  vote_average: number;
  width: number;
}

export interface TmdbDetails {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  tagline?: string;
  runtime?: number;
  episode_run_time?: number[];
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  genres?: { id: number; name: string }[];
  backdrop_path?: string | null;
  poster_path?: string | null;
  number_of_seasons?: number;
  status?: string;
  images?: { logos?: TmdbImage[]; backdrops?: TmdbImage[] };
  credits?: {
    cast?: { id: number; name: string; character?: string; profile_path?: string | null; order?: number }[];
    crew?: { id: number; name: string; job?: string; profile_path?: string | null }[];
  };
  videos?: { results?: { key: string; site: string; type: string; name: string; official?: boolean; iso_639_1?: string }[] };
  recommendations?: { results?: TmdbListItem[] };
  similar?: { results?: TmdbListItem[] };
  external_ids?: { imdb_id?: string | null };
  release_dates?: { results?: { iso_3166_1: string; release_dates: { certification: string; type: number }[] }[] };
  content_ratings?: { results?: { iso_3166_1: string; rating: string }[] };
  seasons?: { season_number: number; name: string; episode_count: number; poster_path?: string | null; air_date?: string }[];
}

export interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  media_type?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
}

export async function details(kind: TmdbKind, id: number): Promise<TmdbDetails | null> {
  return tmdb<TmdbDetails>(`/${kind}/${id}`, {
    append_to_response: `images,credits,videos,recommendations,external_ids,${kind === 'movie' ? 'release_dates' : 'content_ratings'}`,
    include_image_language: 'en,null',
  });
}

export interface TmdbEpisode {
  episode_number: number;
  season_number: number;
  name?: string;
  overview?: string;
  still_path?: string | null;
  air_date?: string;
  runtime?: number;
  vote_average?: number;
}

export async function season(tvId: number, n: number): Promise<{ episodes?: TmdbEpisode[] } | null> {
  return tmdb(`/tv/${tvId}/season/${n}`, {}, 6 * 3600 * 1000);
}

export async function images(kind: TmdbKind, id: number): Promise<{ logos?: TmdbImage[]; backdrops?: TmdbImage[] } | null> {
  return tmdb(`/${kind}/${id}/images`, { include_image_language: 'en,null' }, 7 * 24 * 3600 * 1000);
}

/** The best English (or language-free) logo, as a PNG URL. */
export function bestLogo(logos: TmdbImage[] | undefined, size: 'w500' | 'original' = 'w500'): string | undefined {
  if (!logos?.length) return undefined;
  const ranked = [...logos].sort((a, b) => {
    const lang = (x: TmdbImage) => (x.iso_639_1 === 'en' ? 2 : x.iso_639_1 === null ? 1 : 0);
    return lang(b) - lang(a) || b.vote_average - a.vote_average || b.width - a.width;
  });
  const pick = ranked.find((l) => !l.file_path.endsWith('.svg')) ?? ranked[0];
  return tmdbImage(pick.file_path, size);
}

/** A backdrop without text (language-free), best rated; the default one only when none exist. */
export function bestBackdrop(d: TmdbDetails | null, size: 'w1280' | 'original' = 'original'): string | undefined {
  const textless = (d?.images?.backdrops ?? []).filter((b) => b.iso_639_1 === null).sort((a, b) => b.vote_average - a.vote_average || b.width - a.width);
  return tmdbImage(textless[0]?.file_path ?? d?.backdrop_path, size);
}

export function certification(d: TmdbDetails | null, region = 'US'): string | undefined {
  if (!d) return undefined;
  const fromMovie = d.release_dates?.results?.find((r) => r.iso_3166_1 === region)?.release_dates?.find((x) => x.certification)?.certification;
  const fromTv = d.content_ratings?.results?.find((r) => r.iso_3166_1 === region)?.rating;
  return (fromMovie || fromTv || undefined)?.trim() || undefined;
}

export function trailerKey(d: TmdbDetails | null): string | undefined {
  const vids = d?.videos?.results?.filter((v) => v.site === 'YouTube') ?? [];
  const pick =
    vids.find((v) => v.type === 'Trailer' && v.official && v.iso_639_1 === 'en') ??
    vids.find((v) => v.type === 'Trailer') ??
    vids.find((v) => v.type === 'Teaser');
  return pick?.key;
}

/** TMDB id for any content id we see: `tmdb:` ids directly, IMDb ids through /find. */
export async function resolveTmdb(id: string, type: string): Promise<TmdbFindResult | null> {
  const m = /^tmdb:(\d+)/i.exec(id);
  if (m) return { id: Number(m[1]), kind: type === 'movie' ? 'movie' : 'tv' };
  const imdb = /^(tt\d+)/.exec(id)?.[1];
  if (imdb) return findByImdb(imdb);
  return null;
}

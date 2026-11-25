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
/**
 * The same TMDB picture at another width. Cards ask for one near the size they are drawn at: a
 * banner-sized picture in a card costs several times the download, memory and decode time.
 * Pictures from anywhere else come back unchanged.
 */
export function tmdbResized(url: string | null | undefined, size: 'w342' | 'w500' | 'w780' | 'w1280'): string | undefined {
  return url ? url.replace(/(image\.tmdb\.org\/t\/p\/)(?:original|w1280)\//, `$1${size}/`) : undefined;
}

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

/** A /search result: a list item, with the title in its original language as well. */
export interface TmdbSearchItem extends TmdbListItem {
  original_title?: string;
  original_name?: string;
}

/**
 * Titles matching a name: one page, in TMDB's own order (closest and best known first). `year`
 * keeps a movie search to films released that year, and a show search to shows that first
 * aired in it. Empty without a TMDB key.
 */
export async function searchTitles(kind: TmdbKind, query: string, year?: number): Promise<TmdbSearchItem[]> {
  const params: Record<string, string> = { query, include_adult: 'false' };
  if (year) params[kind === 'movie' ? 'year' : 'first_air_date_year'] = String(year);
  const res = await tmdb<{ results?: TmdbSearchItem[] }>(`/search/${kind}`, params, 24 * 3600 * 1000);
  return res?.results ?? [];
}

// ---------- Search and Discover ----------

/**
 * `tmdb`, for a caller that may stop waiting for the answer (a search whose text has moved on).
 * Giving up does not stop the request itself: it is shared with whoever else asked, and its
 * answer is still kept, so typing the same thing again is answered at once. The cache key is the
 * one `tmdb` uses, so the two share answers.
 */
export async function tmdbAsk<T>(path: string, params: Record<string, string>, opts: { signal?: AbortSignal; ttlMs?: number } = {}): Promise<T | null> {
  const key = effectiveTmdbKey()?.trim();
  if (!key) return null;
  const { query, headers } = auth(key);
  const url = `${API}${path}?${new URLSearchParams({ language: 'en-US', ...params, ...query })}`;
  const cacheParams = new URLSearchParams({ language: 'en-US', ...params });
  try {
    return await getJson<T>(url, { ttlMs: opts.ttlMs ?? 12 * 3600 * 1000, cacheKey: `tmdb:${path}?${cacheParams}`, headers, timeoutMs: 15000, signal: opts.signal });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/** One page of a TMDB list, with how much there is in all. */
export interface TmdbPage<T> {
  page: number;
  totalPages: number;
  totalResults: number;
  results: T[];
}

interface RawPage<T> {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: T[];
}

const asPage = <T>(r: RawPage<T> | null, page: number): TmdbPage<T> => ({ page: r?.page ?? page, totalPages: r?.total_pages ?? 0, totalResults: r?.total_results ?? 0, results: r?.results ?? [] });

/** A title as search, trending and discover send it: a list item with what ranking needs. */
export interface TmdbTitleHit extends TmdbSearchItem {
  popularity?: number;
  vote_count?: number;
  genre_ids?: number[];
  original_language?: string;
  adult?: boolean;
}

/** A person as search and trending send them. `known_for` is up to three of their titles. */
export interface TmdbPersonHit {
  id: number;
  name: string;
  profile_path?: string | null;
  known_for_department?: string;
  popularity?: number;
  adult?: boolean;
  known_for?: TmdbTitleHit[];
}

const SEARCH_TTL = 30 * 60 * 1000;

/**
 * One page of titles matching a name, in TMDB's own order, with the page count. `year` keeps a
 * movie search to films released that year and a show search to shows that first aired in it.
 * An empty page without a TMDB key.
 */
export async function searchTitlePage(kind: TmdbKind, query: string, page = 1, opts: { year?: number; signal?: AbortSignal } = {}): Promise<TmdbPage<TmdbTitleHit>> {
  const params: Record<string, string> = { query, include_adult: 'false', page: String(page) };
  if (opts.year) params[kind === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = String(opts.year);
  return asPage(await tmdbAsk<RawPage<TmdbTitleHit>>(`/search/${kind}`, params, { signal: opts.signal, ttlMs: SEARCH_TTL }), page);
}

/** One page of people matching a name, best known first. */
export async function searchPeoplePage(query: string, page = 1, signal?: AbortSignal): Promise<TmdbPage<TmdbPersonHit>> {
  return asPage(await tmdbAsk<RawPage<TmdbPersonHit>>('/search/person', { query, include_adult: 'false', page: String(page) }, { signal, ttlMs: SEARCH_TTL }), page);
}

/**
 * Movies and shows trending this week, most talked about first. Asked for exactly as the Home rows
 * made from history ask (recs/sources.ts), so whichever screen comes first pays for both.
 */
export async function trendingTitles(signal?: AbortSignal): Promise<TmdbTitleHit[]> {
  const r = await tmdbAsk<RawPage<TmdbTitleHit>>('/trending/all/week', { page: '1' }, { signal, ttlMs: 6 * 3600 * 1000 });
  return (r?.results ?? []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv');
}

/** People trending this week. */
export async function trendingPeople(signal?: AbortSignal): Promise<TmdbPersonHit[]> {
  const r = await tmdbAsk<RawPage<TmdbPersonHit>>('/trending/person/week', {}, { signal, ttlMs: 12 * 3600 * 1000 });
  return r?.results ?? [];
}

/**
 * One page of /discover, with the totals. `params` are TMDB's own names and carry the page
 * (meta/tmdbSources.ts `discoverRequest` writes them for a saved filter set).
 */
export async function discoverPage(kind: TmdbKind, params: Record<string, string>, signal?: AbortSignal): Promise<TmdbPage<TmdbTitleHit>> {
  return asPage(await tmdbAsk<RawPage<TmdbTitleHit>>(`/discover/${kind}`, params, { signal }), Number(params.page) || 1);
}

/** A service titles can be watched on, as TMDB (from JustWatch) lists it for a country. */
export interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
  display_priority?: number;
  /** Country code -> where the service ranks there (lower is bigger). */
  display_priorities?: Record<string, number>;
}

/** The services that carry movies (or shows) in a country, the biggest there first. */
export async function watchProviders(kind: TmdbKind, region: string, signal?: AbortSignal): Promise<TmdbProvider[]> {
  const r = await tmdbAsk<{ results?: TmdbProvider[] }>(`/watch/providers/${kind}`, { watch_region: region }, { signal, ttlMs: 24 * 3600 * 1000 });
  const rank = (p: TmdbProvider) => p.display_priorities?.[region] ?? p.display_priority ?? 9999;
  return [...(r?.results ?? [])].sort((a, b) => rank(a) - rank(b));
}

/** The countries TMDB has watch providers for. */
export async function watchRegions(signal?: AbortSignal): Promise<{ iso_3166_1: string; english_name: string }[]> {
  const r = await tmdbAsk<{ results?: { iso_3166_1: string; english_name: string }[] }>('/watch/providers/regions', {}, { signal, ttlMs: 7 * 24 * 3600 * 1000 });
  return r?.results ?? [];
}

// ---------- Card art ----------

/** What a card needs of a title: its name and pictures, as full image links. */
export interface TmdbArt {
  id: number;
  kind: TmdbKind;
  name?: string;
  poster?: string;
  background?: string;
  logo?: string;
  year?: string;
}

interface ArtFields {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  images?: { logos?: TmdbImage[] };
}

const ART_TTL_MS = 7 * 24 * 3600 * 1000;

function asArt(kind: TmdbKind, d: ArtFields): TmdbArt {
  return {
    id: d.id,
    kind,
    name: (kind === 'movie' ? d.title ?? d.name : d.name ?? d.title) || undefined,
    poster: tmdbImage(d.poster_path, 'w342'),
    background: tmdbImage(d.backdrop_path, 'w1280'),
    logo: bestLogo(d.images?.logos),
    year: (kind === 'movie' ? d.release_date : d.first_air_date)?.slice(0, 4) || undefined,
  };
}

/**
 * A title's name, poster and backdrop by its TMDB number: one small request, nothing appended.
 * `logo` asks for its logo art as well (still one request, a larger answer). Null when TMDB has
 * no such title or there is no key; throws when TMDB could not be asked (see `tmdb`).
 */
export async function titleArt(kind: TmdbKind, id: number, opts: { logo?: boolean } = {}): Promise<TmdbArt | null> {
  const d = await tmdb<ArtFields>(`/${kind}/${id}`, opts.logo ? { append_to_response: 'images', include_image_language: 'en,null' } : {}, ART_TTL_MS);
  return d ? asArt(kind, { ...d, id: d.id ?? id }) : null;
}

/**
 * The same for an IMDb id, read from the /find answer itself: the request `findByImdb` makes (and
 * shares the cached answer of) already carries the name and pictures. `prefer` picks between a
 * movie and a show when the id matches both. No logo: /find does not list them.
 */
export async function titleArtByImdb(imdbId: string, prefer: TmdbKind): Promise<TmdbArt | null> {
  const res = await tmdb<{ movie_results?: ArtFields[]; tv_results?: ArtFields[] }>(`/find/${imdbId}`, { external_source: 'imdb_id' }, ART_TTL_MS);
  const movie = res?.movie_results?.[0];
  const tv = res?.tv_results?.[0];
  const kind: TmdbKind | null = prefer === 'movie' ? (movie ? 'movie' : tv ? 'tv' : null) : tv ? 'tv' : movie ? 'movie' : null;
  if (!kind) return null;
  return asArt(kind, (kind === 'movie' ? movie : tv)!);
}

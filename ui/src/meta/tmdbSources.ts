// Collection folders whose source is TMDB (lists, collections, companies, networks, discover
// queries, people). Items come back as `tmdb:<id>` previews, which metadata addons such as
// AIOMetadata resolve.

import type { MetaPreview } from '../addons/types';
import type { CollectionSource } from '../state/collections';
import { tmdb, tmdbImage, type TmdbListItem } from './tmdb';

function preview(item: TmdbListItem, fallbackKind: 'movie' | 'tv'): MetaPreview | null {
  const kind = item.media_type === 'tv' || item.media_type === 'movie' ? item.media_type : fallbackKind;
  if (item.media_type === 'person') return null;
  const name = item.title ?? item.name;
  if (!name) return null;
  const date = item.release_date ?? item.first_air_date;
  return {
    id: `tmdb:${item.id}`,
    type: kind === 'movie' ? 'movie' : 'series',
    name,
    poster: tmdbImage(item.poster_path, 'w342'),
    background: tmdbImage(item.backdrop_path, 'w1280'),
    releaseInfo: date?.slice(0, 4),
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
    description: item.overview,
  };
}

/** Collection filter names and the /discover/movie parameters they stand for. */
const FILTER_PARAMS: Record<string, string> = {
  withGenres: 'with_genres',
  withoutGenres: 'without_genres',
  releaseDateGte: 'primary_release_date.gte',
  releaseDateLte: 'primary_release_date.lte',
  voteAverageGte: 'vote_average.gte',
  voteAverageLte: 'vote_average.lte',
  voteCountGte: 'vote_count.gte',
  voteCountLte: 'vote_count.lte',
  withRuntimeGte: 'with_runtime.gte',
  withRuntimeLte: 'with_runtime.lte',
  certificationCountry: 'certification_country',
  certificationLte: 'certification.lte',
  withOriginalLanguage: 'with_original_language',
  withOriginCountry: 'with_origin_country',
  withKeywords: 'with_keywords',
  withoutKeywords: 'without_keywords',
  withCompanies: 'with_companies',
  withoutCompanies: 'without_companies',
  withNetworks: 'with_networks',
  year: 'year',
  watchRegion: 'watch_region',
  withWatchProviders: 'with_watch_providers',
  withoutWatchProviders: 'without_watch_providers',
};

/** /discover/tv names a few of them differently; a movie name it does not know is ignored. */
function tvParam(name: string): string {
  if (name === 'year') return 'first_air_date_year';
  return name.replace('primary_release_date', 'first_air_date');
}

/** One page (1-based) of a TMDB collection source. */
export async function fetchTmdbSource(source: CollectionSource, page = 1): Promise<MetaPreview[]> {
  const media = (source.mediaType ?? '').toLowerCase();
  const kind: 'movie' | 'tv' = media === 'tv' || media === 'series' ? 'tv' : 'movie';
  const sort = source.sortBy && source.sortBy !== 'original' ? source.sortBy : undefined;
  const id = source.tmdbId;
  const map = (items: TmdbListItem[] | undefined, k = kind) => (items ?? []).map((i) => preview(i, k)).filter((x): x is MetaPreview => !!x);

  switch ((source.tmdbSourceType ?? '').toUpperCase()) {
    case 'LIST': {
      const r = await tmdb<{ items?: TmdbListItem[] }>(`/list/${id}`, { page: String(page) });
      return map(r?.items);
    }
    case 'COLLECTION': {
      if (page > 1) return [];
      const r = await tmdb<{ parts?: TmdbListItem[] }>(`/collection/${id}`);
      return map((r?.parts ?? []).sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? '')), 'movie');
    }
    case 'COMPANY': {
      const r = await tmdb<{ results?: TmdbListItem[] }>(`/discover/${kind}`, { with_companies: String(id), page: String(page), sort_by: sort ?? 'popularity.desc' });
      return map(r?.results);
    }
    case 'NETWORK': {
      const r = await tmdb<{ results?: TmdbListItem[] }>(`/discover/tv`, { with_networks: String(id), page: String(page), sort_by: sort ?? 'popularity.desc' });
      return map(r?.results, 'tv');
    }
    case 'PERSON':
    case 'DIRECTOR': {
      const crew = source.tmdbSourceType?.toUpperCase() === 'DIRECTOR';
      const r = await tmdb<{ results?: TmdbListItem[] }>(`/discover/${kind}`, { [crew ? 'with_crew' : 'with_cast']: String(id), page: String(page), sort_by: sort ?? 'popularity.desc' });
      return map(r?.results);
    }
    case 'DISCOVER':
    default: {
      const params: Record<string, string> = { page: String(page), sort_by: sort ?? 'popularity.desc' };
      for (const [k, v] of Object.entries(source.filters ?? {})) {
        if (v === null || v === undefined || v === '') continue;
        const name = FILTER_PARAMS[k];
        if (!name) continue;
        params[kind === 'tv' ? tvParam(name) : name] = resolveFilterValue(v);
      }
      const r = await tmdb<{ results?: TmdbListItem[] }>(`/discover/${kind}`, params);
      return map(r?.results);
    }
  }
}

/**
 * A filter value as TMDB is sent it. A date may be written from today (`today`, `today-30d`), so a
 * saved "new this month" stays this month's: it is turned into a date when the request is made.
 * Everything else goes as it is.
 */
export function resolveFilterValue(value: string | number, now = Date.now()): string {
  const m = /^today(?:-(\d+)d)?$/.exec(String(value));
  if (!m) return String(value);
  const d = new Date(now);
  d.setDate(d.getDate() - Number(m[1] ?? 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The /discover request a DISCOVER source stands for: which kind, and the parameters in the order
 * `fetchTmdbSource` writes them (the answer cache is keyed by them as written, so Discover asking
 * for a page's totals and a Home row asking for its titles are one request).
 */
export function discoverRequest(source: CollectionSource, page = 1, now = Date.now()): { kind: 'movie' | 'tv'; params: Record<string, string> } {
  const media = (source.mediaType ?? '').toLowerCase();
  const kind: 'movie' | 'tv' = media === 'tv' || media === 'series' ? 'tv' : 'movie';
  const sort = source.sortBy && source.sortBy !== 'original' ? source.sortBy : undefined;
  const params: Record<string, string> = { page: String(page), sort_by: sort ?? 'popularity.desc' };
  for (const [k, v] of Object.entries(source.filters ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    const name = FILTER_PARAMS[k];
    if (!name) continue;
    params[kind === 'tv' ? tvParam(name) : name] = resolveFilterValue(v, now);
  }
  return { kind, params };
}

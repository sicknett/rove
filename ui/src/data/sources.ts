// Items for one collection source, page by page, whether it is an addon catalog or TMDB.

import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchCatalog, findAddon } from '../addons/client';
import type { MetaPreview } from '../addons/types';
import { useAddons } from '../addons/store';
import { fetchTmdbSource } from '../meta/tmdbSources';
import type { CollectionSource } from '../state/collections';
import { BUILT_IN_TMDB_KEY, useKeys } from '../state/keys';

export function sourceKey(s: CollectionSource) {
  return (s.provider ?? 'addon') === 'tmdb'
    ? `tmdb:${s.tmdbSourceType}:${s.tmdbId}:${s.mediaType}:${s.sortBy}:${JSON.stringify(s.filters ?? {})}`
    : `addon:${s.addonId}:${s.type}:${s.catalogId}:${s.genre ?? ''}`;
}

export function sourceLabel(s: CollectionSource): string {
  if (s.title) return s.title;
  if ((s.provider ?? '').toLowerCase() === 'trakt') return 'Trakt list';
  if ((s.provider ?? 'addon') === 'tmdb') return s.tmdbSourceType ? s.tmdbSourceType[0] + s.tmdbSourceType.slice(1).toLowerCase() : 'TMDB';
  const addon = s.addonId ? findAddon(s.addonId) : undefined;
  const cat = addon?.manifest.catalogs.find((c) => c.id === s.catalogId && c.type === s.type);
  return [cat?.name ?? s.catalogId, s.genre].filter(Boolean).join(' · ') || 'Catalog';
}

/** One page of a source: 1-based pages for TMDB, a `skip` offset for addon catalogs. */
export async function fetchSourcePage(source: CollectionSource, page: number, signal?: AbortSignal): Promise<MetaPreview[]> {
  const provider = (source.provider ?? 'addon').toLowerCase();
  if (provider === 'tmdb') return fetchTmdbSource(source, page || 1);
  if (provider !== 'addon') return [];
  const addon = source.addonId ? findAddon(source.addonId) : undefined;
  if (!addon || !source.type || !source.catalogId) return [];
  return fetchCatalog(addon, { type: source.type, id: source.catalogId }, { genre: source.genre ?? undefined, skip: page || undefined }, signal);
}

export function useSourceItems(source: CollectionSource | undefined, enabled = true) {
  const addonsLoaded = useAddons((s) => s.loaded);
  const hasTmdb = useKeys((s) => !!(s.tmdbApiKey ?? BUILT_IN_TMDB_KEY));
  const isTmdb = (source?.provider ?? 'addon') === 'tmdb';
  return useInfiniteQuery({
    queryKey: ['source', source ? sourceKey(source) : 'none'],
    initialPageParam: isTmdb ? 1 : 0,
    queryFn: async ({ pageParam, signal }): Promise<{ items: MetaPreview[]; param: number }> => {
      if (!source) return { items: [], param: pageParam };
      return { items: await fetchSourcePage(source, pageParam, signal), param: pageParam };
    },
    getNextPageParam: (last, pages) => {
      if (!last.items.length) return undefined;
      if (isTmdb) return last.param < 20 ? last.param + 1 : undefined;
      const seen = pages.reduce((n, p) => n + p.items.length, 0);
      return seen > last.param ? seen : undefined;
    },
    enabled: enabled && !!source && (isTmdb ? hasTmdb : addonsLoaded),
    staleTime: 20 * 60 * 1000,
  });
}

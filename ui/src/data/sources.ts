// Items for one collection source, page by page, whether it is an addon catalog or TMDB.

import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { catalogAddon, catalogNeeds, fetchCatalog, findAddon, genreOptions } from '../addons/client';
import type { ManifestCatalog, MetaPreview } from '../addons/types';
import { useAddons } from '../addons/store';
import { fetchTmdbSource } from '../meta/tmdbSources';
import { useServers } from '../servers/store';
import type { CollectionSource } from '../state/collections';
import { BUILT_IN_TMDB_KEY, effectiveTmdbKey, tmdbKeyId, useKeys } from '../state/keys';

const providerOf = (s: CollectionSource) => (s.provider ?? 'addon').toLowerCase();

export function sourceKey(s: CollectionSource) {
  return providerOf(s) === 'tmdb'
    ? `tmdb:${s.tmdbSourceType}:${s.tmdbId}:${s.mediaType}:${s.sortBy}:${JSON.stringify(s.filters ?? {})}`
    : `addon:${s.addonId}:${s.type}:${s.catalogId}:${s.genre ?? ''}`;
}

export function sourceLabel(s: CollectionSource): string {
  if (s.title) return s.title;
  if (providerOf(s) === 'trakt') return 'Trakt list';
  if (providerOf(s) === 'tmdb') return s.tmdbSourceType ? s.tmdbSourceType[0] + s.tmdbSourceType.slice(1).toLowerCase() : 'TMDB';
  const addon = s.addonId ? findAddon(s.addonId) : undefined;
  const cat = addon?.manifest.catalogs.find((c) => c.id === s.catalogId && c.type === s.type);
  return [cat?.name ?? s.catalogId, s.genre].filter(Boolean).join(' · ') || 'Catalog';
}

/**
 * Why a source cannot be fetched at all, or null when it can: a provider ROVE has no reader for,
 * TMDB without a key, or an addon that is not installed, is switched off, or is not for this
 * profile.
 */
export function sourceBlocker(s: CollectionSource): 'provider' | 'tmdb-key' | 'addon' | null {
  const provider = providerOf(s);
  if (provider === 'tmdb') return effectiveTmdbKey() ? null : 'tmdb-key';
  if (provider !== 'addon') return 'provider';
  return s.addonId && s.type && s.catalogId && catalogAddon(s.addonId) ? null : 'addon';
}

/**
 * The genre to ask an addon catalog for. Collection files also use `genre` as a tab's label
 * ("All", "Movies", "Up Next"), so only a genre the catalog really offers is sent as a filter. A
 * catalog that cannot be read without a genre gets its first one.
 */
function genreFor(catalog: ManifestCatalog | undefined, wanted: string | null | undefined): string | undefined {
  if (!catalog) return undefined;
  const options = genreOptions(catalog);
  const offered = wanted ? options.find((g) => g.toLowerCase() === wanted.toLowerCase()) : undefined;
  return offered ?? (catalogNeeds(catalog).includes('genre') ? options[0] : undefined);
}

/** One page of a source: 1-based pages for TMDB, a `skip` offset for addon catalogs. */
export async function fetchSourcePage(source: CollectionSource, page: number, signal?: AbortSignal): Promise<MetaPreview[]> {
  const provider = providerOf(source);
  if (provider === 'tmdb') return fetchTmdbSource(source, page || 1);
  if (provider !== 'addon') return [];
  const addon = source.addonId ? catalogAddon(source.addonId) : undefined;
  if (!addon || !source.type || !source.catalogId) return [];
  const catalog = addon.manifest.catalogs.find((c) => c.id === source.catalogId && c.type === source.type);
  return fetchCatalog(addon, { type: source.type, id: source.catalogId }, { genre: genreFor(catalog, source.genre), skip: page || undefined }, signal);
}

export function useSourceItems(source: CollectionSource | undefined, enabled = true) {
  const addonsLoaded = useAddons((s) => s.loaded);
  const addons = useAddons((s) => s.addons);
  const servers = useServers((s) => s.servers);
  const tmdbKey = useKeys((s) => s.tmdbApiKey ?? BUILT_IN_TMDB_KEY);
  const isTmdb = !!source && providerOf(source) === 'tmdb';
  // Whether the source can be fetched right now. It is part of the query's key, so what an addon
  // gave is not shown on once that addon is switched off, and TMDB is asked again after a new key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo(() => (!source ? 'none' : isTmdb ? tmdbKeyId(tmdbKey) : sourceBlocker(source) ? 'off' : 'on'), [source, isTmdb, tmdbKey, addons, servers]);
  return useInfiniteQuery({
    queryKey: ['source', source ? sourceKey(source) : 'none', state],
    initialPageParam: isTmdb ? 1 : 0,
    queryFn: async ({ pageParam, signal }): Promise<{ items: MetaPreview[]; param: number }> => {
      if (!source) return { items: [], param: pageParam };
      return { items: await fetchSourcePage(source, pageParam, signal), param: pageParam };
    },
    getNextPageParam: (last, pages) => {
      if (!last.items.length) return undefined;
      // A source that ignores paging sends the same titles again: that is the end.
      const earlier = new Set(pages.slice(0, -1).flatMap((p) => p.items.map((m) => m.id)));
      if (pages.length > 1 && last.items.every((m) => earlier.has(m.id))) return undefined;
      if (isTmdb) return last.param < 20 ? last.param + 1 : undefined;
      const seen = pages.reduce((n, p) => n + p.items.length, 0);
      return seen > last.param ? seen : undefined;
    },
    enabled: enabled && !!source && (isTmdb ? !!tmdbKey : addonsLoaded && state === 'on'),
    staleTime: 20 * 60 * 1000,
  });
}

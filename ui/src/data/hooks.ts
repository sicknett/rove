// Data for screens, cached with TanStack Query.

import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { fetchCatalog, fetchMeta, findAddon } from '../addons/client';
import { parseId } from '../addons/ids';
import type { Meta, MetaPreview, Video } from '../addons/types';
import { useAddons } from '../addons/store';
import { bestBackdrop, bestLogo, certification, details, resolveTmdb, trailerKey, type TmdbDetails } from '../meta/tmdb';
import { BUILT_IN_TMDB_KEY, useKeys } from '../state/keys';
import { useHistory, type MediaType } from '../state/history';
import { deriveContinue, type ContinueItem, type EpisodeRef } from '../library/continue';
import { serverAsAddon } from '../servers';
import { useServers } from '../servers/store';

export const HOUR = 3600 * 1000;

export function asMediaType(type: string): MediaType {
  return type === 'movie' ? 'movie' : 'series';
}

/** A title's metadata from the user's metadata addons. */
export function useMeta(type: string, id: string | undefined) {
  const addonsLoaded = useAddons((s) => s.loaded);
  const addonCount = useAddons((s) => s.addons.length);
  return useQuery({
    queryKey: ['meta', type, id, addonCount],
    queryFn: ({ signal }) => fetchMeta(type, id!, signal),
    enabled: !!id && addonsLoaded,
    staleTime: 6 * HOUR,
    gcTime: 12 * HOUR,
  });
}

export interface Enriched {
  tmdbId?: number;
  kind?: 'movie' | 'tv';
  details?: TmdbDetails | null;
  logo?: string;
  backdrop?: string;
  certification?: string;
  trailer?: string;
}

/** TMDB extras for a title: logo art, cast, recommendations, certification, trailer. */
export function useTmdb(type: string, id: string | undefined) {
  const key = useKeys((s) => s.tmdbApiKey ?? BUILT_IN_TMDB_KEY);
  return useQuery({
    queryKey: ['tmdb', type, id ? parseId(id).base : undefined, !!key],
    queryFn: async (): Promise<Enriched> => {
      const ref = await resolveTmdb(parseId(id!).base, type);
      if (!ref) return {};
      const d = await details(ref.kind, ref.id);
      return {
        tmdbId: ref.id,
        kind: ref.kind,
        details: d,
        logo: bestLogo(d?.images?.logos),
        backdrop: bestBackdrop(d),
        certification: certification(d),
        trailer: trailerKey(d),
      };
    },
    enabled: !!id && !!key,
    staleTime: 24 * HOUR,
    gcTime: 24 * HOUR,
  });
}

/** One catalog, page by page (Stremio's `skip`). */
export function useCatalog(addonId: string, type: string, catalogId: string, extra: Record<string, string | undefined> = {}, enabled = true) {
  const fromAddons = useAddons((s) => s.addons.find((a) => a.manifest.id === addonId));
  const server = useServers((s) => (addonId.startsWith('server:') ? s.servers.find((x) => `server:${x.id}` === addonId) : undefined));
  const addon = useMemo(() => fromAddons ?? (server ? serverAsAddon(server) : undefined), [fromAddons, server]);
  return useInfiniteQuery({
    queryKey: ['catalog', addonId, type, catalogId, extra, addon?.url.length],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const a = addon ?? findAddon(addonId);
      if (!a) return { items: [] as MetaPreview[], skip: pageParam };
      const items = await fetchCatalog(a, { type, id: catalogId }, { ...extra, skip: pageParam || undefined }, signal);
      return { items, skip: pageParam };
    },
    getNextPageParam: (last, pages) => {
      if (!last.items.length) return undefined;
      // A source that ignores paging sends the same titles again: that is the end.
      const earlier = new Set(pages.slice(0, -1).flatMap((p) => p.items.map((m) => m.id)));
      if (last.items.every((m) => earlier.has(m.id))) return undefined;
      const seen = pages.reduce((n, p) => n + p.items.length, 0);
      return seen > last.skip ? seen : undefined;
    },
    enabled: enabled && !!addon,
    staleTime: 15 * 60 * 1000,
    gcTime: HOUR,
  });
}

/** Flattens catalog pages, dropping repeats some addons send across pages. */
export function flatItems(pages: { items: MetaPreview[] }[] | undefined): MetaPreview[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: MetaPreview[] = [];
  for (const p of pages) for (const m of p.items) if (!seen.has(m.id)) seen.add(m.id), out.push(m);
  return out;
}

export function episodesOf(meta: Meta | null | undefined): EpisodeRef[] {
  return (meta?.videos ?? [])
    .map((v: Video): EpisodeRef | null => {
      const season = v.season ?? (v.id ? parseId(v.id).season : undefined);
      const episode = v.episode ?? v.number ?? (v.id ? parseId(v.id).episode : undefined);
      if (season === undefined || episode === undefined) return null;
      return { id: v.id, season, episode, released: v.released, title: v.name ?? v.title, thumbnail: v.thumbnail };
    })
    .filter((x): x is EpisodeRef => !!x);
}

export interface ContinueCard extends ContinueItem {
  name?: string;
  poster?: string;
  background?: string;
  logo?: string;
}

/** Continue Watching, with the series metadata it needs fetched (most recent first). */
export function useContinueWatching(limit = 40): { items: ContinueCard[]; loading: boolean } {
  const progress = useHistory((s) => s.progress);
  const watched = useHistory((s) => s.watched);
  const dismissed = useHistory((s) => s.dismissed);
  const cards = useHistory((s) => s.cards);
  const addonsLoaded = useAddons((s) => s.loaded);

  // Series that need an episode list: everything with watched episodes.
  const seriesIds = useMemo(() => {
    const latest = new Map<string, number>();
    for (const w of Object.values(watched)) if (w.type === 'series') latest.set(w.metaId, Math.max(latest.get(w.metaId) ?? 0, w.at));
    return [...latest.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  }, [watched, limit]);

  const metaQueries = useQueries({
    queries: seriesIds.map((id) => ({
      queryKey: ['meta', 'series', id, 'cw'],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchMeta('series', id, signal),
      enabled: addonsLoaded,
      staleTime: 3 * HOUR,
      gcTime: 6 * HOUR,
    })),
  });

  const episodes = useMemo(() => {
    const map = new Map<string, EpisodeRef[] | null>();
    seriesIds.forEach((id, i) => {
      const q = metaQueries[i];
      if (q.isSuccess) map.set(id, q.data ? episodesOf(q.data) : null);
      else if (q.isError) map.set(id, null);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesIds, metaQueries.map((q) => q.dataUpdatedAt + (q.isError ? 1 : 0)).join(',')]);

  const result = useMemo(() => deriveContinue({ progress, watched, dismissed, episodes }), [progress, watched, dismissed, episodes]);

  // Remember art from fetched metadata so the row is complete on the next start.
  useEffect(() => {
    seriesIds.forEach((id, i) => {
      const m = metaQueries[i]?.data;
      if (m) useHistory.getState().rememberCard(id, 'series', { name: m.name, poster: m.poster, background: m.background, logo: m.logo, year: m.releaseInfo });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaQueries.map((q) => q.dataUpdatedAt).join(',')]);

  const items = useMemo(
    () =>
      result.items.slice(0, limit).map((it) => {
        const c = cards[it.metaId];
        const p = progress[it.key];
        return { ...it, name: c?.name ?? p?.name, poster: c?.poster ?? p?.poster, background: c?.background ?? p?.background, logo: c?.logo ?? p?.logo };
      }),
    [result, cards, progress, limit],
  );

  const loading = result.needEpisodes.length > 0 && metaQueries.some((q) => q.isLoading);
  return { items, loading };
}

/** Movies (and shows) with a resume point but no card art yet: fetch it once. */
export function useCardArt(items: { metaId: string; type: MediaType; name?: string; poster?: string }[]) {
  const addonsLoaded = useAddons((s) => s.loaded);
  const missing = items.filter((i) => !i.poster || !i.name).slice(0, 30);
  const queries = useQueries({
    queries: missing.map((i) => ({
      queryKey: ['meta', i.type, i.metaId, 'art'],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchMeta(i.type, i.metaId, signal),
      enabled: addonsLoaded,
      staleTime: 12 * HOUR,
    })),
  });
  useEffect(() => {
    missing.forEach((i, idx) => {
      const m = queries[idx]?.data;
      if (m) useHistory.getState().rememberCard(i.metaId, i.type, { name: m.name, poster: m.poster, background: m.background, logo: m.logo, year: m.releaseInfo });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((q) => q.dataUpdatedAt).join(',')]);
}

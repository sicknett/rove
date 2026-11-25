// What Search asks for. Every request here is switched by `enabled`: Search stays mounted behind
// other screens, and a hidden Search asks for nothing.
//
// A settled query makes at most: 2 TMDB title searches (movies, shows; 4 when the text ends in a
// year, which is searched both ways), 1 TMDB person search, and 1 request per addon search
// catalog and connected media server. More pages come only when a single kind is being looked at
// and its grid is scrolled (or "More results" is pressed), up to MAX_TITLE_PAGES of 20.

import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { canBrowse, canOpenType, catalogExtras, catalogSupports, fetchCatalog } from '../../addons/client';
import type { InstalledAddon, ManifestCatalog, MetaPreview } from '../../addons/types';
import { searchPeoplePage, searchTitlePage, trendingPeople, trendingTitles } from '../../meta/tmdb';
import { isServerAddon } from '../../servers';
import type { Kind } from '../shared/genres';
import { personHits, titleHits, uniqueHits, wellKnown, type PersonHit, type TitleHit } from '../shared/hits';
import { useTmdbKeyId } from '../shared/parts';
import { forQuery, mergeReads, type QueryRead } from './logic';

const MINUTE = 60 * 1000;
export const MAX_TITLE_PAGES = 5;
export const MAX_PEOPLE_PAGES = 3;

export interface TitlePage {
  /** The text this page answers. Results are only ever shown for the text they answer. */
  query: string;
  page: number;
  totalPages: number;
  hits: TitleHit[];
  /** The text as typed found nothing and the name-in-that-year reading did: later pages follow that reading. */
  byYear: boolean;
}

interface TitleParam {
  page: number;
  byYear: boolean;
}

export function useTitleSearch(kind: Kind, read: QueryRead, enabled: boolean) {
  const keyId = useTmdbKeyId();
  return useInfiniteQuery({
    queryKey: ['search', 'tmdb', kind, read.text, keyId],
    initialPageParam: { page: 1, byYear: false } as TitleParam,
    queryFn: async ({ pageParam, signal }): Promise<TitlePage> => {
      const { page, byYear } = pageParam;
      const inYear = () => searchTitlePage(kind, read.base!, page, { year: read.year, signal });
      if (page > 1) {
        const r = await (byYear ? inYear() : searchTitlePage(kind, read.text, page, { signal }));
        return { query: read.text, page, totalPages: r.totalPages, hits: titleHits(r.results, kind), byYear };
      }
      // The second reading is a guess: when it fails, the text as typed still stands.
      const [typed, year] = await Promise.all([searchTitlePage(kind, read.text, 1, { signal }), read.year && read.base ? inYear().catch(() => null) : null]);
      const merged = mergeReads(titleHits(typed.results, kind), year ? titleHits(year.results, kind) : null);
      return { query: read.text, page: 1, totalPages: merged.byYear ? year!.totalPages : typed.totalPages, hits: merged.hits, byYear: merged.byYear };
    },
    getNextPageParam: (last): TitleParam | undefined => (last.page < Math.min(last.totalPages, MAX_TITLE_PAGES) ? { page: last.page + 1, byYear: last.byYear } : undefined),
    enabled: enabled && !!keyId,
    staleTime: 10 * MINUTE,
  });
}

export interface PeoplePage {
  query: string;
  page: number;
  totalPages: number;
  people: PersonHit[];
}

export function usePeopleSearch(read: QueryRead, enabled: boolean) {
  const keyId = useTmdbKeyId();
  return useInfiniteQuery({
    queryKey: ['search', 'tmdb', 'person', read.text, keyId],
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }): Promise<PeoplePage> => {
      const r = await searchPeoplePage(read.text, pageParam, signal);
      return { query: read.text, page: pageParam, totalPages: r.totalPages, people: personHits(r.results) };
    },
    getNextPageParam: (last) => (last.page < Math.min(last.totalPages, MAX_PEOPLE_PAGES) ? last.page + 1 : undefined),
    enabled: enabled && !!keyId,
    staleTime: 10 * MINUTE,
  });
}

/** Every page's titles for the query now asked, each once. Pages that answer other text count for nothing. */
export const titlesOf = (pages: TitlePage[] | undefined, query: string): TitleHit[] => uniqueHits((pages ?? []).filter((p) => forQuery(p, query)).flatMap((p) => p.hits));

/** The same for people, those with a photo first: the ones without are the least known, whatever their place. */
export function peopleOf(pages: PeoplePage[] | undefined, query: string): PersonHit[] {
  const seen = new Set<number>();
  const all = (pages ?? []).filter((p) => forQuery(p, query)).flatMap((p) => p.people).filter((p) => !seen.has(p.id) && seen.add(p.id));
  return [...all.filter((p) => p.photo), ...all.filter((p) => !p.photo)];
}

// ---------- Addon search catalogs and media servers ----------

export interface SearchTarget {
  addon: InstalledAddon;
  catalog: ManifestCatalog;
}

/** The catalogs that can be searched: addon catalogs with a `search` extra, and each media server's. */
export function searchTargets(addons: InstalledAddon[]): SearchTarget[] {
  const out: SearchTarget[] = [];
  for (const addon of addons.filter(canBrowse)) {
    for (const catalog of addon.manifest.catalogs) {
      if (!catalogSupports(catalog, 'search') || !canOpenType(catalog.type)) continue;
      const otherRequired = catalogExtras(catalog).filter((e) => e.isRequired && e.name !== 'search');
      if (otherRequired.length) continue;
      out.push({ addon, catalog });
    }
  }
  return out;
}

export interface TargetResult {
  target: SearchTarget;
  /** From a media server, not an addon. */
  server: boolean;
  items: MetaPreview[] | undefined;
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

export function useCatalogSearch(targets: SearchTarget[], query: string, enabled: boolean): TargetResult[] {
  const results = useQueries({
    queries: targets.map((t) => ({
      queryKey: ['search', t.addon.manifest.id, t.catalog.type, t.catalog.id, query],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchCatalog(t.addon, t.catalog, { search: query }, signal),
      enabled,
      staleTime: 10 * MINUTE,
    })),
  });
  return targets.map((target, i) => {
    const r = results[i];
    return { target, server: isServerAddon(target.addon), items: r?.data, loading: !!r && r.isLoading, failed: !!r?.isError, retry: () => void r?.refetch() };
  });
}

// ---------- Before anything is typed ----------

/** Trending titles and people, for the page before anything is typed: two requests, kept for hours. */
export function useTrending(enabled: boolean) {
  const keyId = useTmdbKeyId();
  const titles = useQuery({
    queryKey: ['search', 'trending', 'titles', keyId],
    queryFn: async ({ signal }) => titleHits(await trendingTitles(signal), 'movie'),
    enabled: enabled && !!keyId,
    staleTime: 60 * MINUTE,
  });
  const people = useQuery({
    queryKey: ['search', 'trending', 'people', keyId],
    queryFn: async ({ signal }) => {
      const seen = new Set<number>();
      return personHits(await trendingPeople(signal)).filter((p) => p.photo && wellKnown(p) && !seen.has(p.id) && seen.add(p.id));
    },
    enabled: enabled && !!keyId,
    staleTime: 6 * 60 * MINUTE,
  });
  return { titles, people };
}

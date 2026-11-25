// Everything Search has found for one query, gathered from its sources into the lists the
// results page draws: TMDB movies, shows and people, media servers, the profile's own titles, and
// what addon search catalogs add to those.

import { useMemo } from 'react';
import type { MetaPreview } from '../../addons/types';
import { useCatalogSources } from '../../servers/useSources';
import { useHistory } from '../../state/history';
import type { PersonHit, TitleHit } from '../shared/hits';
import { kidSafe } from '../shared/hits';
import { peopleOf, searchTargets, titlesOf, useCatalogSearch, usePeopleSearch, useTitleSearch } from './data';
import { groupByType, matchOwn, ownTitles, topHit, withoutKnown, type OwnTitle, type QueryRead, type TopHit } from './logic';

export interface SearchModel {
  read: QueryRead;
  movies: ReturnType<typeof useTitleSearch>;
  shows: ReturnType<typeof useTitleSearch>;
  people: ReturnType<typeof usePeopleSearch>;
  movieHits: TitleHit[];
  showHits: TitleHit[];
  peopleHits: PersonHit[];
  /** Matches on the user's own media servers, each once. */
  serverItems: MetaPreview[];
  serversLoading: boolean;
  /** The one server's name when there is only one, for the section's title. */
  serverName?: string;
  /** What addon search catalogs found that TMDB did not, by type. Everything they found when there is no TMDB key. */
  addonGroups: [string, MetaPreview[]][];
  addonsLoading: boolean;
  /** Watchlist and history titles the text names. Matched in the app: no request. */
  own: OwnTitle[];
  /** The result to feature. Null until TMDB's three answers are in, and when they hold nothing. */
  top: TopHit | null;
  /** TMDB is still being asked (the best match waits for all of it). */
  tmdbLoading: boolean;
  /** Something is still being asked. */
  loading: boolean;
  /** Nothing at all was found, by anyone. Only meaningful once `loading` is false. */
  empty: boolean;
  /** Who did not answer, by name. */
  failed: string[];
  retry: () => void;
  /** Some addon or server can be searched. */
  hasTargets: boolean;
}

/**
 * `live` is false while Search is hidden, while the box holds other text than `read` (a pause in
 * typing settles it), and when there is nothing to search for: nothing is asked then. What was
 * already answered for this query stays available.
 */
export function useSearchModel(read: QueryRead, live: boolean, opts: { kids: boolean }): SearchModel {
  const sources = useCatalogSources();
  const targets = useMemo(() => searchTargets(sources), [sources]);
  // An id is opened, not searched for by name: TMDB has no title called tt0133093.
  const byName = live && !read.id;
  const movies = useTitleSearch('movie', read, byName);
  const shows = useTitleSearch('tv', read, byName);
  // People are left out for a Kids profile: their pages list everything they have made.
  const people = usePeopleSearch(read, byName && !opts.kids);
  const catalogs = useCatalogSearch(targets, read.text, live);
  // These two change when the user changes them. Resume points change every few seconds while
  // something plays, so they are read when the query changes instead of being listened to.
  const library = useHistory((s) => s.library);
  const watched = useHistory((s) => s.watched);

  const keep = opts.kids ? kidSafe : () => true;
  const movieHits = useMemo(() => titlesOf(movies.data?.pages, read.text).filter(keep), [movies.data, read.text, opts.kids]); // eslint-disable-line react-hooks/exhaustive-deps
  const showHits = useMemo(() => titlesOf(shows.data?.pages, read.text).filter(keep), [shows.data, read.text, opts.kids]); // eslint-disable-line react-hooks/exhaustive-deps
  const peopleHits = useMemo(() => (opts.kids ? [] : peopleOf(people.data?.pages, read.text)), [people.data, read.text, opts.kids]);

  const stamp = catalogs.map((c) => `${c.items?.length ?? '-'}${c.failed ? '!' : ''}`).join(',');
  const { serverItems, addonGroups } = useMemo(() => {
    const seen = new Set<string>();
    const fromServers = catalogs.filter((c) => c.server).flatMap((c) => c.items ?? []).filter((m) => !seen.has(m.id) && seen.add(m.id));
    const known = [...movieHits, ...showHits];
    const groups = groupByType(catalogs.filter((c) => !c.server).map((c) => c.items))
      .map(([type, items]): [string, MetaPreview[]] => [type, withoutKnown(items, known)])
      .filter(([, items]) => items.length > 0);
    return { serverItems: fromServers, addonGroups: groups };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, read.text, movieHits, showHits]);

  const own = useMemo(() => {
    const h = useHistory.getState();
    return matchOwn(read.text, ownTitles({ library, watched, progress: h.progress, cards: h.cards }));
  }, [read.text, library, watched]);

  const tmdbLoading = movies.isLoading || shows.isLoading || people.isLoading;
  const top = useMemo(() => (tmdbLoading ? null : topHit(read, movieHits, showHits, peopleHits)), [tmdbLoading, read, movieHits, showHits, peopleHits]);

  const servers = catalogs.filter((c) => c.server);
  const addons = catalogs.filter((c) => !c.server);
  const loading = tmdbLoading || catalogs.some((c) => c.loading);
  const tmdbFailed = [movies, shows, people].some((q) => q.isError && !q.data);
  const failed = [...new Set([...(tmdbFailed ? ['TMDB'] : []), ...catalogs.filter((c) => c.failed).map((c) => c.target.addon.manifest.name)])];
  const retry = () => {
    for (const q of [movies, shows, people]) if (q.isError) void q.refetch();
    for (const c of catalogs) if (c.failed) c.retry();
  };

  return {
    read,
    movies,
    shows,
    people,
    movieHits,
    showHits,
    peopleHits,
    serverItems,
    serversLoading: servers.some((c) => c.loading),
    serverName: servers.length === 1 ? servers[0].target.addon.manifest.name : undefined,
    addonGroups,
    addonsLoading: addons.some((c) => c.loading),
    own,
    top,
    tmdbLoading,
    loading,
    empty: !movieHits.length && !showHits.length && !peopleHits.length && !serverItems.length && !addonGroups.length && !own.length,
    failed,
    retry,
    hasTargets: targets.length > 0,
  };
}

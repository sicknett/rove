// Items for one collection source, page by page: an addon catalog, a TMDB source, or a list
// from Trakt, MDBList or a media server.

import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { catalogAddon, catalogNeeds, fetchCatalog, findAddon, genreOptions } from '../addons/client';
import { titleKey } from '../addons/ids';
import type { ManifestCatalog, MetaPreview } from '../addons/types';
import { useAddons } from '../addons/store';
import { fetchListPage, mdblistKey, TRAKT_NEEDS_APP_ID, traktAccount } from '../lists/providers';
import { firstListPage, listProviderOf, traktRef } from '../lists/read';
import { fetchTmdbSource } from '../meta/tmdbSources';
import { serverById, useServers } from '../servers/store';
import { sourceKey, type CollectionSource } from '../state/collections';
import { useHistory, type TitleCard } from '../state/history';
import { BUILT_IN_TMDB_KEY, effectiveTmdbKey, tmdbKeyId, useKeys } from '../state/keys';
import { TRAKT_CLIENT_ID, traktRefNeedsAccount } from '../tracking/adapters/trakt';
import { canonicalNow } from '../tracking/idmap';
import { useTracker } from '../tracking/sync';
import { asMediaType, useCardArt } from './hooks';

export { sourceKey };

const providerOf = (s: CollectionSource) => (s.provider ?? 'addon').toLowerCase();

export function sourceLabel(s: CollectionSource): string {
  if (s.title) return s.title;
  const provider = providerOf(s);
  if (provider === 'trakt') return s.traktKind === 'watchlist' ? 'Trakt watchlist' : 'Trakt list';
  if (provider === 'mdblist') return s.mdblistKind === 'watchlist' ? 'MDBList watchlist' : 'MDBList list';
  if (provider === 'server') return `${s.serverListKind === 'playlist' ? 'Playlist' : 'Collection'}${s.serverId && serverById(s.serverId) ? ` · ${serverById(s.serverId)!.name}` : ''}`;
  if (provider === 'tmdb') return s.tmdbSourceType ? s.tmdbSourceType[0] + s.tmdbSourceType.slice(1).toLowerCase() : 'TMDB';
  const addon = s.addonId ? findAddon(s.addonId) : undefined;
  const cat = addon?.manifest.catalogs.find((c) => c.id === s.catalogId && c.type === s.type);
  return [cat?.name ?? s.catalogId, s.genre].filter(Boolean).join(' · ') || 'Catalog';
}

/** Where a source comes from, for the line under its name in the folder editor. */
export function sourceOrigin(s: CollectionSource): string {
  const provider = providerOf(s);
  if (provider === 'tmdb') return `TMDB · ${s.tmdbSourceType?.toLowerCase() ?? 'source'} ${s.tmdbId ?? ''}`.trim();
  if (provider === 'trakt') return s.traktKind === 'watchlist' ? 'Trakt · your watchlist' : s.traktListId ? `Trakt · list ${s.traktListId}` : s.traktUser === 'me' ? 'Trakt · your list' : `Trakt · ${s.traktUser}/${s.traktSlug}`;
  if (provider === 'mdblist') return s.mdblistKind === 'watchlist' ? 'MDBList · your watchlist' : s.mdblistId ? `MDBList · list ${s.mdblistId}` : `MDBList · ${s.mdblistUser}/${s.mdblistSlug}`;
  if (provider === 'server') return `${(s.serverId && serverById(s.serverId)?.name) || 'Media server'} · ${s.serverListKind === 'playlist' ? 'playlist' : 'collection'}`;
  if (provider === 'addon') return `Addon · ${(s.addonId && findAddon(s.addonId)?.manifest.name) || s.addonId}`;
  return s.provider ?? 'Source';
}

/** Who is asked for a source's titles, for "… did not answer". */
export function sourceProviderName(s: CollectionSource): string {
  const provider = providerOf(s);
  if (provider === 'tmdb') return 'TMDB';
  if (provider === 'trakt') return 'Trakt';
  if (provider === 'mdblist') return 'MDBList';
  if (provider === 'server') return (s.serverId && serverById(s.serverId)?.name) || 'The server';
  return 'The addon';
}

export type SourceBlocker ='provider' | 'tmdb-key' | 'addon' | 'trakt-app' | 'trakt-signin' | 'mdblist-key' | 'server-off' | 'server-gone';

/**
 * Why a source cannot be fetched at all, or null when it can: a provider ROVE has no reader for;
 * TMDB without a key; an addon that is not installed, is switched off, or is not for this
 * profile; a Trakt list in a build without ROVE's Trakt app id, or one that belongs to an account
 * that is not signed in; an MDBList list with no key; a server list whose server is switched off
 * or gone.
 */
export function sourceBlocker(s: CollectionSource): SourceBlocker | null {
  const provider = providerOf(s);
  if (provider === 'tmdb') return effectiveTmdbKey() ? null : 'tmdb-key';
  if (provider === 'trakt') {
    if (!TRAKT_CLIENT_ID) return 'trakt-app';
    // Public lists are read with the app id alone; the account's own things need the account.
    return traktRefNeedsAccount(traktRef(s)) && !traktAccount() ? 'trakt-signin' : null;
  }
  if (provider === 'mdblist') return mdblistKey() ? null : 'mdblist-key';
  if (provider === 'server') {
    const server = s.serverId ? serverById(s.serverId) : undefined;
    return !server || !s.serverListId ? 'server-gone' : server.enabled ? null : 'server-off';
  }
  if (provider !== 'addon') return 'provider';
  return s.addonId && s.type && s.catalogId && catalogAddon(s.addonId) ? null : 'addon';
}

/** A blocker in words: a title, a sentence, and the Settings section that puts it right (if one does). */
export function blockerMessage(why: SourceBlocker): { title: string; text: string; section?: 'accounts' | 'addons' | 'servers' } {
  switch (why) {
    case 'tmdb-key':
      return { title: 'This needs a TMDB key', text: 'Add one in Settings → Accounts.', section: 'accounts' };
    case 'addon':
      return { title: 'The addon for this catalog is not available', text: 'It is not installed, or it is switched off in Settings → Addons.', section: 'addons' };
    case 'trakt-app':
      return { title: TRAKT_NEEDS_APP_ID, text: 'This build was made without one, so it cannot ask Trakt for lists. The list stays saved and shows in a build that has it.' };
    case 'trakt-signin':
      return { title: 'Sign in to Trakt', text: 'This is a Trakt account’s own list or watchlist. Connect Trakt in Settings → Accounts to read it.', section: 'accounts' };
    case 'mdblist-key':
      return { title: 'Add an MDBList key', text: 'MDBList lists are read with your MDBList API key. Add it under Import lists, or connect MDBList in Settings → Accounts.', section: 'accounts' };
    case 'server-off':
      return { title: 'This server is switched off', text: 'Switch it on in Settings → Media servers to see its lists.', section: 'servers' };
    case 'server-gone':
      return { title: 'This list’s server is no longer connected', text: 'Connect it again in Settings → Media servers.', section: 'servers' };
    default:
      return { title: 'This source is not supported', text: 'ROVE shows addon catalogs, TMDB sources and lists from Trakt, MDBList and media servers. This source is none of them.' };
  }
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

/** What a source's first page is asked for with: 1 where pages are numbered, 0 where titles are skipped. */
export function firstSourcePage(source: CollectionSource): number {
  const list = listProviderOf(source);
  return list ? firstListPage(list) : providerOf(source) === 'tmdb' ? 1 : 0;
}

export interface SourcePage {
  items: MetaPreview[];
  /** What this page was asked for with. */
  param: number;
  /** From a list: what the page after this one is asked for with, or null when this was the last. */
  next?: number | null;
}

/**
 * One page of a source: 1-based pages for TMDB and Trakt, a count of titles to skip for addon
 * catalogs, MDBList and servers. 0 always means the first page.
 */
export async function readSourcePage(source: CollectionSource, page: number, signal?: AbortSignal): Promise<SourcePage> {
  const provider = providerOf(source);
  if (provider === 'tmdb') return { items: await fetchTmdbSource(source, page || 1), param: page };
  if (listProviderOf(source)) return { ...(await fetchListPage(source, page)), param: page };
  if (provider !== 'addon') return { items: [], param: page };
  const addon = source.addonId ? catalogAddon(source.addonId) : undefined;
  if (!addon || !source.type || !source.catalogId) return { items: [], param: page };
  const catalog = addon.manifest.catalogs.find((c) => c.id === source.catalogId && c.type === source.type);
  return { items: await fetchCatalog(addon, { type: source.type, id: source.catalogId }, { genre: genreFor(catalog, source.genre), skip: page || undefined }, signal), param: page };
}

/** The titles of one page of a source (see readSourcePage). */
export async function fetchSourcePage(source: CollectionSource, page: number, signal?: AbortSignal): Promise<MetaPreview[]> {
  return (await readSourcePage(source, page, signal)).items;
}

/** A list is not followed further than this many pages (2,400 titles from Trakt or MDBList). */
const MAX_LIST_PAGES = 60;

/**
 * What to ask for after `last`, or undefined at the end. A page with nothing new on it (a source
 * that ignores paging sends the same titles again) is the end for everything but a server list,
 * where a full page of episodes can stand for shows already seen. A list says itself what comes
 * next; TMDB is followed for 20 pages; an addon catalog while it keeps giving titles.
 */
export function nextSourcePage(provider: string, last: SourcePage, pages: SourcePage[]): number | undefined {
  if (provider !== 'server' && pages.length > 1 && last.items.length) {
    const earlier = new Set(pages.slice(0, -1).flatMap((p) => p.items.map((m) => m.id)));
    if (last.items.every((m) => earlier.has(m.id))) return undefined;
  }
  if (last.next !== undefined) return last.next === null || pages.length >= MAX_LIST_PAGES ? undefined : last.next;
  if (!last.items.length) return undefined;
  if (provider === 'tmdb') return last.param < 20 ? last.param + 1 : undefined;
  const seen = pages.reduce((n, p) => n + p.items.length, 0);
  return seen > last.param ? seen : undefined;
}

const NO_CARDS: Record<string, TitleCard> = {};
const NO_ART: { metaId: string; type: 'movie' | 'series'; name?: string; poster?: string }[] = [];

export function useSourceItems(source: CollectionSource | undefined, enabled = true) {
  const addonsLoaded = useAddons((s) => s.loaded);
  const addons = useAddons((s) => s.addons);
  const servers = useServers((s) => s.servers);
  const tmdbKey = useKeys((s) => s.tmdbApiKey ?? BUILT_IN_TMDB_KEY);
  const savedMdblistKey = useKeys((s) => s.mdblistApiKey);
  const tracker = useTracker((s) => s.account);
  const provider = source ? providerOf(source) : 'none';
  const isTmdb = provider === 'tmdb';
  // Whether the source can be fetched right now, and as whom. It is part of the query's key, so
  // what an addon gave is not shown on once that addon is switched off, TMDB is asked again after
  // a new key, and one account's watchlist is never shown for another.
  const state = useMemo(() => {
    if (!source) return 'none';
    if (isTmdb) return tmdbKeyId(tmdbKey);
    if (sourceBlocker(source)) return 'off';
    if (provider === 'mdblist') return `on:${tmdbKeyId(mdblistKey())}`;
    if (provider === 'trakt' && traktRefNeedsAccount(traktRef(source))) return `on:${traktAccount()?.username ?? 'me'}`;
    return 'on';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, isTmdb, provider, tmdbKey, savedMdblistKey, tracker, addons, servers]);

  // Trakt and MDBList titles whose poster TMDB could not give: the metadata addons are asked,
  // what they send is remembered with the other cards, and it is put on the titles here.
  const lacksArt = provider === 'trakt' || provider === 'mdblist';
  const cards = useHistory((s) => (lacksArt ? s.cards : NO_CARDS));
  const select = useCallback(
    (data: InfiniteData<SourcePage, number>): InfiniteData<SourcePage, number> => {
      if (!lacksArt) return data;
      const fill = (m: MetaPreview): MetaPreview => {
        if (m.poster) return m;
        const type = asMediaType(m.type);
        const card = cards[titleKey(canonicalNow(m.id, type), type)];
        return card?.poster ? { ...m, poster: card.poster, background: m.background ?? card.background } : m;
      };
      return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map(fill) })) };
    },
    [lacksArt, cards],
  );

  const q = useInfiniteQuery({
    queryKey: ['source', source ? sourceKey(source) : 'none', state],
    initialPageParam: source ? firstSourcePage(source) : 0,
    queryFn: async ({ pageParam, signal }): Promise<SourcePage> => {
      if (!source) return { items: [], param: pageParam };
      return readSourcePage(source, pageParam, signal);
    },
    getNextPageParam: (last, pages) => nextSourcePage(provider, last, pages),
    select,
    enabled: enabled && !!source && (isTmdb ? !!tmdbKey : (provider !== 'addon' || addonsLoaded) && state !== 'off' && state !== 'none'),
    staleTime: 20 * 60 * 1000,
  });

  const missing = useMemo(
    () => (lacksArt ? (q.data?.pages ?? []).flatMap((p) => p.items.filter((m) => !m.poster).map((m) => ({ metaId: m.id, type: asMediaType(m.type), name: m.name, poster: m.poster }))) : NO_ART),
    [lacksArt, q.data],
  );
  useCardArt(missing);
  return q;
}

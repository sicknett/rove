// Reads one page of a list source (Trakt, MDBList or a media server) as ordinary cards. What
// it needs from the app (the Trakt account, the MDBList key, the server) is handed in, so the
// reading itself can be checked without the stores; providers.ts supplies it.

import { serverAdapter } from '../servers';
import type { MediaServer } from '../servers/types';
import type { CollectionSource } from '../state/collections';
import { mdblistListItems, type MdbListRef } from '../tracking/adapters/mdblist';
import { traktListItems, type TraktListRef } from '../tracking/adapters/trakt';
import type { TrackerAccount } from '../tracking/types';
import { posterLink, withTmdbArt } from './art';
import type { ListPage, ListProviderId } from './types';

export interface ListContext {
  /** The profile's Trakt account, when Trakt is its tracker. Public lists are read without it. */
  trakt: TrackerAccount | null;
  mdblistKey: string | null;
  server: (id: string) => MediaServer | undefined;
}

/** Titles asked for at a time from Trakt and MDBList; a server page is a little larger. */
export const LIST_PAGE = 40;
const SERVER_PAGE = 50;

export function listProviderOf(s: CollectionSource): ListProviderId | null {
  const p = (s.provider ?? 'addon').toLowerCase();
  return p === 'trakt' || p === 'mdblist' || p === 'server' ? p : null;
}

/** Trakt counts pages from 1; MDBList and servers are asked by how many titles came before. */
export const firstListPage = (provider: ListProviderId) => (provider === 'trakt' ? 1 : 0);

/** Collection files say `TV` or `MOVIE`; without either a list gives both. */
export function mediaOf(s: CollectionSource): 'movie' | 'show' | undefined {
  const m = (s.mediaType ?? '').toLowerCase();
  if (/^(tv|series|shows?)$/.test(m)) return 'show';
  return /^movies?$/.test(m) ? 'movie' : undefined;
}

export function traktRef(s: CollectionSource): TraktListRef {
  if (Number(s.traktListId) > 0) return { id: Number(s.traktListId) };
  if (s.traktUser && s.traktSlug) return { user: s.traktUser, slug: s.traktSlug };
  return { watchlist: s.traktKind === 'watchlist' };
}

export function mdblistRef(s: CollectionSource): MdbListRef {
  if (Number(s.mdblistId) > 0) return { id: Number(s.mdblistId) };
  if (s.mdblistUser && s.mdblistSlug) return { user: s.mdblistUser, slug: s.mdblistSlug };
  return { watchlist: s.mdblistKind === 'watchlist' };
}

/**
 * One page of a list source. `page` is the first page (see firstListPage) or the `next` of the
 * page before. Throws when the list cannot be read; a source that is not a list gives nothing.
 */
export async function readListPage(source: CollectionSource, page: number, ctx: ListContext): Promise<ListPage> {
  const provider = listProviderOf(source);
  if (provider === 'trakt') {
    const r = await traktListItems(traktRef(source), { media: mediaOf(source), sortBy: source.sortBy, sortHow: source.sortHow, page: page || 1, limit: LIST_PAGE }, ctx.trakt);
    const items = r.items.map((t) => ({
      id: t.metaId,
      type: t.type,
      name: t.name,
      releaseInfo: t.year ? String(t.year) : undefined,
      description: t.overview,
      imdbRating: t.rating ? t.rating.toFixed(1) : undefined,
      genres: t.genres,
      tmdbId: t.tmdbId,
    }));
    return { items: await withTmdbArt(items), next: r.next };
  }
  if (provider === 'mdblist') {
    if (!ctx.mdblistKey) return { items: [], next: null };
    const r = await mdblistListItems(ctx.mdblistKey, mdblistRef(source), { media: mediaOf(source), sortBy: source.sortBy, sortHow: source.sortHow, offset: page || 0, limit: LIST_PAGE });
    const items = r.items.map((t) => ({ id: t.metaId, type: t.type, name: t.name, releaseInfo: t.year ? String(t.year) : undefined, poster: posterLink(t.poster), tmdbId: t.tmdbId }));
    return { items: await withTmdbArt(items), next: r.next };
  }
  if (provider === 'server') {
    const server = source.serverId ? ctx.server(source.serverId) : undefined;
    if (!server || !server.enabled || !source.serverListId) return { items: [], next: null };
    return serverAdapter(server.kind).listItems(server, { id: source.serverListId, kind: source.serverListKind === 'playlist' ? 'playlist' : 'collection' }, page || 0, SERVER_PAGE);
  }
  return { items: [], next: null };
}

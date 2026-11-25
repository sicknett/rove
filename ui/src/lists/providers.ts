// Where lists come from, as the app is set up right now: which providers can be used (and what
// is missing when one cannot), what each offers to pick from, and the reading of a list's
// titles with the profile's Trakt account, MDBList key and servers.

import { useMemo } from 'react';
import { serverAdapter } from '../servers';
import { serverById, useServers } from '../servers/store';
import { SERVER_KIND_NAMES, type MediaServer, type ServerList } from '../servers/types';
import { sourceKey, type CollectionSource } from '../state/collections';
import { useKeys } from '../state/keys';
import { mdblistListInfo, mdblistMyLists, mdblistSearchLists, mdblistTopLists, parseMdblistLink, type MdbList } from '../tracking/adapters/mdblist';
import { parseTraktListLink, TRAKT_CLIENT_ID, traktLikedLists, traktListInfo, traktMyLists, traktPublicLists, traktSearchLists, type TraktList } from '../tracking/adapters/trakt';
import { useTracker } from '../tracking/sync';
import type { TrackerAccount } from '../tracking/types';
import { readListPage, type ListContext } from './read';
import type { ListChoice, ListPage, ListProviderId } from './types';

export const LIST_PROVIDERS: ListProviderId[] = ['trakt', 'mdblist', 'server'];
export const LIST_PROVIDER_NAMES: Record<ListProviderId, string> = { trakt: 'Trakt', mdblist: 'MDBList', server: 'Media servers' };

/** The sentence shown wherever a Trakt list cannot be read because the build has no app id. */
export const TRAKT_NEEDS_APP_ID = 'Trakt lists need ROVE’s Trakt app id in this build';

/** The profile's Trakt account, when Trakt is the tracker it is signed in to. */
export function traktAccount(): TrackerAccount | null {
  const a = useTracker.getState().account;
  return a?.provider === 'trakt' && a.accessToken ? a : null;
}

/** The MDBList key lists are read with: a connected MDBList tracker's, else the one saved for lists. */
export function mdblistKey(): string | null {
  const a = useTracker.getState().account;
  return (a?.provider === 'mdblist' && a.apiKey) || useKeys.getState().mdblistApiKey || null;
}

export function listContext(): ListContext {
  return { trakt: traktAccount(), mdblistKey: mdblistKey(), server: serverById };
}

/** One page of a list source, read with what the profile has connected. */
export function fetchListPage(source: CollectionSource, page: number): Promise<ListPage> {
  return readListPage(source, page, listContext());
}

// ---------- What can be used ----------

export interface ListSetup {
  /** Whether this build carries ROVE's Trakt app id. */
  traktApp: boolean;
  tracker: TrackerAccount | null;
  /** The MDBList key saved for lists (not a tracker's). */
  savedMdblistKey: string | null;
  servers: MediaServer[];
}

export interface ListProviderStatus {
  id: ListProviderId;
  name: string;
  /** Lists can be browsed and picked from it. */
  ready: boolean;
  /** Its state in two or three words, for under its name. */
  summary: string;
  /** When it is not ready: what is missing, in a few words. */
  missing?: string;
  /** What is missing or limited, in a sentence. */
  hint?: string;
  /** The Settings section where that is put right, when there is one. */
  section?: 'accounts' | 'servers';
}

export function listProviderStatus(id: ListProviderId, setup: ListSetup): ListProviderStatus {
  const name = LIST_PROVIDER_NAMES[id];
  if (id === 'trakt') {
    if (!setup.traktApp) return { id, name, ready: false, summary: 'Not in this build', missing: TRAKT_NEEDS_APP_ID, hint: 'This build was made without one, so it cannot ask Trakt for anything. No setting changes that.' };
    if (setup.tracker?.provider === 'trakt') return { id, name, ready: true, summary: 'Signed in', hint: setup.tracker.username ? `Signed in as ${setup.tracker.username}` : 'Signed in' };
    return { id, name, ready: true, summary: 'Public lists', hint: 'Public lists only. Sign in to Trakt for your watchlist, your own lists and the lists you liked.', section: 'accounts' };
  }
  if (id === 'mdblist') {
    if (setup.tracker?.provider === 'mdblist' && setup.tracker.apiKey) return { id, name, ready: true, summary: 'Connected', hint: 'Using the key of your connected MDBList account' };
    if (setup.savedMdblistKey) return { id, name, ready: true, summary: 'Key saved', hint: 'Using the MDBList key saved for lists' };
    return { id, name, ready: false, summary: 'Needs a key', missing: 'Add an MDBList key', hint: 'MDBList reads lists with your API key (mdblist.com → Preferences → API Access). Paste it here, or connect MDBList as your tracker in Settings → Accounts.', section: 'accounts' };
  }
  if (!setup.servers.length) return { id, name, ready: false, summary: 'None connected', missing: 'Connect a media server', hint: 'Collections and playlists from Jellyfin, Emby, Silo or Plex can be lists here.', section: 'servers' };
  if (!setup.servers.some((s) => s.enabled)) return { id, name, ready: false, summary: 'Switched off', missing: setup.servers.length > 1 ? 'Your media servers are switched off' : 'This server is switched off', hint: 'Switch it on in Settings → Media servers.', section: 'servers' };
  const on = setup.servers.filter((s) => s.enabled).length;
  return { id, name, ready: true, summary: on === 1 ? '1 server' : `${on} servers` };
}

/** Every list provider with its state, kept current as accounts, keys and servers change. */
export function useListProviders(): { setup: ListSetup; providers: ListProviderStatus[] } {
  const tracker = useTracker((s) => s.account);
  const savedMdblistKey = useKeys((s) => s.mdblistApiKey);
  const servers = useServers((s) => s.servers);
  return useMemo(() => {
    const setup: ListSetup = { traktApp: !!TRAKT_CLIENT_ID, tracker, savedMdblistKey, servers };
    return { setup, providers: LIST_PROVIDERS.map((id) => listProviderStatus(id, setup)) };
  }, [tracker, savedMdblistKey, servers]);
}

// ---------- What each offers ----------

export interface ListSection {
  id: string;
  label: string;
  /** A ready list to pick from, a search by name, or a pasted link. */
  kind: 'browse' | 'search' | 'link';
  /** For a search or a link: what goes in the field. */
  placeholder?: string;
  /** Said when the section has nothing. */
  empty?: string;
}

export function listSections(id: ListProviderId, setup: ListSetup): ListSection[] {
  if (id === 'trakt') {
    const mine: ListSection[] = setup.tracker?.provider === 'trakt'
      ? [
          { id: 'mine', label: 'Yours', kind: 'browse', empty: 'Your Trakt account has no lists yet.' },
          { id: 'liked', label: 'Liked', kind: 'browse', empty: 'You have not liked any lists on Trakt.' },
        ]
      : [];
    return [
      ...mine,
      { id: 'popular', label: 'Popular', kind: 'browse', empty: 'Trakt sent no lists.' },
      { id: 'trending', label: 'Trending', kind: 'browse', empty: 'Trakt sent no lists.' },
      { id: 'search', label: 'Search', kind: 'search', placeholder: 'Search Trakt lists by name' },
      { id: 'link', label: 'Paste a link', kind: 'link', placeholder: 'trakt.tv/users/…/lists/… or a list number' },
    ];
  }
  if (id === 'mdblist') {
    return [
      { id: 'mine', label: 'Yours', kind: 'browse', empty: 'Your MDBList account has no lists yet.' },
      { id: 'top', label: 'Top lists', kind: 'browse', empty: 'MDBList sent no lists.' },
      { id: 'search', label: 'Search', kind: 'search', placeholder: 'Search MDBList lists by name' },
      { id: 'link', label: 'Paste a link', kind: 'link', placeholder: 'mdblist.com/lists/user/list-name' },
    ];
  }
  return setup.servers
    .filter((s) => s.enabled)
    .map((s) => ({ id: s.id, label: s.name || SERVER_KIND_NAMES[s.kind], kind: 'browse' as const, empty: `${s.name || 'This server'} has no collections or video playlists.` }));
}

const count = (n: number | undefined, one: string, many: string) => (n === undefined ? undefined : `${n.toLocaleString()} ${n === 1 ? one : many}`);
const line = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' · ') || undefined;
const choice = (title: string, detail: string | undefined, source: CollectionSource): ListChoice => ({ key: sourceKey(source), title, detail, source: { ...source, title } });

export function traktChoice(l: TraktList, own = false): ListChoice {
  // A list of the account's that is not public can only be read as that account.
  const source: CollectionSource = own && l.privacy && l.privacy !== 'public' ? { provider: 'trakt', traktUser: 'me', traktSlug: String(l.id) } : { provider: 'trakt', traktListId: l.id };
  return choice(l.name, line(own ? (l.privacy && l.privacy !== 'public' ? 'Private' : 'Public') : l.owner, count(l.itemCount, 'title', 'titles'), !own && count(l.likes, 'like', 'likes')), source);
}

export function mdblistChoice(l: MdbList, own = false): ListChoice {
  const kind = l.mediatype === 'movie' ? 'Movies' : l.mediatype === 'show' ? 'Shows' : undefined;
  return choice(l.name, line(!own && l.owner, kind, count(l.itemCount, 'title', 'titles'), !own && count(l.likes, 'like', 'likes')), { provider: 'mdblist', mdblistId: l.id });
}

export function serverChoice(server: MediaServer, l: ServerList): ListChoice {
  return choice(l.name, line(l.kind === 'playlist' ? 'Playlist' : 'Collection', count(l.itemCount, 'item', 'items')), { provider: 'server', serverId: server.id, serverListId: l.id, serverListKind: l.kind });
}

const TRAKT_WATCHLIST = () => choice('Trakt watchlist', 'What you saved to watch on Trakt', { provider: 'trakt', traktKind: 'watchlist' });
const MDBLIST_WATCHLIST = () => choice('MDBList watchlist', 'What you saved to watch on MDBList', { provider: 'mdblist', mdblistKind: 'watchlist' });

/** The lists of one section. `query` is the text of a search section. Throws when they cannot be read. */
export async function loadLists(id: ListProviderId, section: string, query = ''): Promise<ListChoice[]> {
  if (id === 'trakt') {
    const account = traktAccount();
    if (section === 'mine') return account ? [TRAKT_WATCHLIST(), ...(await traktMyLists(account)).map((l) => traktChoice(l, true))] : [];
    if (section === 'liked') return account ? (await traktLikedLists(account)).map((l) => traktChoice(l)) : [];
    if (section === 'search') return query.trim() ? (await traktSearchLists(query.trim())).map((l) => traktChoice(l)) : [];
    return (await traktPublicLists(section === 'trending' ? 'trending' : 'popular')).map((l) => traktChoice(l));
  }
  if (id === 'mdblist') {
    const key = mdblistKey();
    if (!key) return [];
    if (section === 'mine') return [MDBLIST_WATCHLIST(), ...(await mdblistMyLists(key)).map((l) => mdblistChoice(l, true))];
    if (section === 'search') return query.trim() ? (await mdblistSearchLists(key, query.trim())).map((l) => mdblistChoice(l)) : [];
    return (await mdblistTopLists(key)).map((l) => mdblistChoice(l));
  }
  const server = serverById(section);
  if (!server || !server.enabled) return [];
  return (await serverAdapter(server.kind).lists(server)).map((l) => serverChoice(server, l));
}

/**
 * The list a pasted link (or number, or `owner/name`) points to. Throws with words for the user
 * when the text is not a list link or the provider has no such list.
 */
export async function findListByLink(id: ListProviderId, text: string): Promise<ListChoice> {
  if (id === 'trakt') {
    const ref = parseTraktListLink(text);
    if (!ref) throw new Error('That is not a Trakt list link. It looks like trakt.tv/users/name/lists/list-name.');
    const found = await traktListInfo(ref, traktAccount());
    if (!found) throw new Error('Trakt has no public list at that link.');
    return traktChoice(found);
  }
  if (id === 'mdblist') {
    const key = mdblistKey();
    const ref = parseMdblistLink(text);
    if (!ref || !key) throw new Error('That is not an MDBList link. It looks like mdblist.com/lists/user/list-name.');
    const found = await mdblistListInfo(key, ref);
    if (!found) throw new Error('MDBList has no list at that link.');
    return mdblistChoice(found);
  }
  throw new Error('Server lists are picked from the server, not from a link.');
}

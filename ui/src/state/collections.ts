// Collections: named groups of folders, each folder a set of sources (addon catalogs, TMDB, and
// lists from Trakt, MDBList or a media server), plus lists that are rows of their own on Home.
// The model is Nuvio's, so Kaptain's collection JSON and Nuvio exports load directly.

import { create } from 'zustand';
import { debouncedWriter, docs } from '../lib/native';
import { TRAKT_CLIENT_ID } from '../tracking/adapters/trakt';
import { profileDoc } from './profiles';

export interface CollectionSource {
  provider?: 'addon' | 'tmdb' | 'trakt' | 'mdblist' | 'server' | string;
  addonId?: string;
  type?: string;
  catalogId?: string;
  genre?: string | null;
  tmdbSourceType?: 'LIST' | 'COLLECTION' | 'COMPANY' | 'NETWORK' | 'DISCOVER' | 'PERSON' | 'DIRECTOR' | string;
  title?: string;
  tmdbId?: number;
  mediaType?: string;
  sortBy?: string;
  /** With `sortBy`, for Trakt and MDBList lists: `asc` or `desc`. */
  sortHow?: string;
  filters?: Record<string, string | number | null | undefined>;
  /** Trakt: a public list by its number (the form collection files carry). */
  traktListId?: number;
  /** Trakt: a list by its owner and slug. The owner `me` is the account that is signed in. */
  traktUser?: string;
  traktSlug?: string;
  /** Trakt: the signed-in account's watchlist. */
  traktKind?: 'watchlist' | string;
  /** MDBList: a list by its number, by owner and slug (as in its link), or the key's own watchlist. */
  mdblistId?: number;
  mdblistUser?: string;
  mdblistSlug?: string;
  mdblistKind?: 'watchlist' | string;
  /** A media server's collection (box set) or playlist. */
  serverId?: string;
  serverListId?: string;
  serverListKind?: 'collection' | 'playlist' | string;
}

export interface CollectionFolder {
  id: string;
  title: string;
  coverImageUrl?: string | null;
  focusGifUrl?: string | null;
  coverEmoji?: string | null;
  tileShape?: string;
  hideTitle?: boolean;
  sources?: CollectionSource[];
  catalogSources?: { addonId: string; type: string; catalogId: string; genre?: string | null }[];
  heroBackdropUrl?: string | null;
  titleLogoUrl?: string | null;
}

export interface Collection {
  id: string;
  title: string;
  backdropImageUrl?: string | null;
  pinToTop?: boolean;
  viewMode?: 'TABBED_GRID' | 'ROWS' | 'FOLLOW_LAYOUT' | string;
  showAllTab?: boolean;
  folders: CollectionFolder[];
}

/** A list that is a row of posters on Home by itself (Home layout key `list_<id>`). */
export interface ListRow {
  id: string;
  title: string;
  source: CollectionSource;
  addedAt: number;
}

export const LIST_ROW_PREFIX = 'list_';
export const listRowKey = (id: string) => `${LIST_ROW_PREFIX}${id}`;

/** Sources in the newer `sources` form, filling in older `catalogSources`. */
export function folderSources(f: CollectionFolder): CollectionSource[] {
  if (f.sources?.length) return f.sources;
  return (f.catalogSources ?? []).map((c) => ({ provider: 'addon', addonId: c.addonId, type: c.type, catalogId: c.catalogId, genre: c.genre }));
}

const providerOf = (s: CollectionSource) => (s.provider ?? 'addon').toLowerCase();

/**
 * What makes two sources the same source: the provider and what it is asked for, not the label.
 * It is also the cache key their titles are kept under.
 */
export function sourceKey(s: CollectionSource): string {
  switch (providerOf(s)) {
    case 'tmdb':
      return `tmdb:${s.tmdbSourceType}:${s.tmdbId}:${s.mediaType}:${s.sortBy}:${JSON.stringify(s.filters ?? {})}`;
    case 'trakt':
      return `trakt:${s.traktListId ?? (s.traktUser && s.traktSlug ? `${s.traktUser}/${s.traktSlug}` : s.traktKind ?? '')}:${s.mediaType ?? ''}:${s.sortBy ?? ''}:${s.sortHow ?? ''}`;
    case 'mdblist':
      return `mdblist:${s.mdblistId ?? (s.mdblistUser && s.mdblistSlug ? `${s.mdblistUser}/${s.mdblistSlug}` : s.mdblistKind ?? '')}:${s.mediaType ?? ''}:${s.sortBy ?? ''}:${s.sortHow ?? ''}`;
    case 'server':
      return `server:${s.serverId}:${s.serverListKind ?? 'collection'}:${s.serverListId}`;
    default:
      return `addon:${s.addonId}:${s.type}:${s.catalogId}:${s.genre ?? ''}`;
  }
}

/**
 * Whether ROVE has a reader for this source at all: a provider it knows, with the fields that
 * reader needs. Says nothing about whether it can be fetched right now (an addon may be missing,
 * an account signed out); screens say that where the source is shown (see sourceBlocker).
 */
export function canReadSource(s: CollectionSource): boolean {
  switch (providerOf(s)) {
    case 'tmdb':
      return true;
    case 'addon':
      return !!s.addonId && !!s.catalogId && !!s.type;
    case 'trakt':
      return Number(s.traktListId) > 0 || (!!s.traktUser && !!s.traktSlug) || s.traktKind === 'watchlist';
    case 'mdblist':
      return Number(s.mdblistId) > 0 || (!!s.mdblistUser && !!s.mdblistSlug) || s.mdblistKind === 'watchlist';
    case 'server':
      return !!s.serverId && !!s.serverListId;
    default:
      return false;
  }
}

/**
 * Whether this build of ROVE can show the source. Trakt lists need ROVE's Trakt app id, which a
 * build may lack; nothing the user does in the app changes that, so such sources are not offered
 * anywhere. They stay in the saved collections (see shownCollections) for a build that has it.
 */
export function canShowSource(s: CollectionSource): boolean {
  if (!canReadSource(s)) return false;
  return providerOf(s) !== 'trakt' || !!TRAKT_CLIENT_ID;
}

/**
 * One collection without the sources `drop` names, the folders that had sources and are left
 * with none, or null when it had folders and is left with none. A folder or a collection that
 * was empty to begin with is the user's own work in progress and stays. Returns the collection
 * itself when nothing goes. `link` is told which copy stands for which original.
 */
function withoutSources(c: Collection, drop: (s: CollectionSource) => boolean, link?: (copy: object, original: object) => void): Collection | null {
  const folders: CollectionFolder[] = [];
  for (const f of c.folders) {
    const sources = folderSources(f);
    const kept = sources.filter((s) => !drop(s));
    if (kept.length === sources.length) folders.push(f);
    else if (kept.length) {
      const copy = { ...f, sources: kept, catalogSources: [] };
      link?.(copy, f);
      folders.push(copy);
    }
  }
  if (folders.length === c.folders.length && folders.every((f, i) => f === c.folders[i])) return c;
  if (!folders.length) return null;
  const copy = { ...c, folders };
  link?.(copy, c);
  return copy;
}

/** `list` with each collection put through `each`; the same array when none of them changed. */
function mapKept(list: Collection[], each: (c: Collection) => Collection | null): Collection[] {
  const out: Collection[] = [];
  let changed = false;
  for (const c of list) {
    const kept = each(c);
    if (kept !== c) changed = true;
    if (kept) out.push(kept);
  }
  return changed ? out : list;
}

/**
 * Drops what ROVE has no reader for (see canReadSource): such sources, then folders that had
 * sources and are left with none, then collections that had folders and are left with none.
 * Returns the same array when there is nothing to drop, so a caller can tell whether anything
 * changed.
 *
 * Trakt lists are kept whether or not this build can show them: what a build lacks is hidden when
 * collections are shown (shownCollections), not deleted from what is saved.
 */
export function cleanCollections(list: Collection[]): Collection[] {
  return mapKept(list, (c) => withoutSources(c, (s) => !canReadSource(s)));
}

/**
 * A shown copy of a collection or folder (one with sources left out) → the saved one it stands
 * for. Screens hand back the objects they were given (to undo a delete, to put a folder back);
 * through this the store finds what is really saved, hidden sources included.
 */
const savedOf = new WeakMap<object, object>();
const savedForm = <T extends object>(shown: T): T => (savedOf.get(shown) as T | undefined) ?? shown;
const linkToSaved = (copy: object, original: object) => void savedOf.set(copy, original);
/** Saved collection → how it is shown, so a collection that did not change keeps its shown copy. */
const shownOf = new WeakMap<Collection, { shown: Collection | null }>();

/**
 * Saved collections as screens show them: without the sources this build cannot show, the
 * folders that leaves with nothing, and the collections that leaves with no folders (the same
 * steps as cleanCollections). Nothing is removed from what is saved. Returns the same array when
 * nothing is hidden.
 */
export function shownCollections(saved: Collection[], canShow?: (s: CollectionSource) => boolean): Collection[] {
  if (canShow) return mapKept(saved, (c) => withoutSources(c, (s) => !canShow(s), linkToSaved));
  return mapKept(saved, (c) => {
    let hit = shownOf.get(c);
    if (!hit) shownOf.set(c, (hit = { shown: withoutSources(c, (s) => !canShowSource(s), linkToSaved) }));
    return hit.shown;
  });
}

/**
 * Accepts a collection array, `{collections:[…]}`, or a single collection, and keeps the parts
 * ROVE has a reader for (see cleanCollections). Everything imported or seeded comes through here.
 */
export function parseCollections(input: unknown): Collection[] {
  const raw = Array.isArray(input) ? input : (input as { collections?: unknown[] })?.collections ?? (input && typeof input === 'object' && 'folders' in (input as object) ? [input] : []);
  return cleanCollections(
    (raw as Collection[])
      .filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string')
      .map((c) => ({ ...c, folders: (c.folders ?? []).filter((f) => f && f.id && f.title) })),
  );
}

// ---------- Putting back what an earlier build removed ----------

/** The rule of the first cleaning pass, which kept addon catalogs and TMDB sources only. */
const keptByFirstPass = (s: CollectionSource) => providerOf(s) === 'tmdb' || (providerOf(s) === 'addon' && !!s.addonId && !!s.catalogId && !!s.type);
/** What that pass removed and ROVE now has a reader for (in the shipped set: Trakt lists). */
const takenByFirstPass = (s: CollectionSource) => !keptByFirstPass(s) && canReadSource(s);
/** A folder that pass removed whole: it had sources and kept none of them. */
const folderTaken = (f: CollectionFolder) => folderSources(f).length > 0 && !folderSources(f).some(keptByFirstPass);
/** A collection that pass removed whole: it had folders and every one of them went. */
const collectionTaken = (c: Collection) => c.folders.length > 0 && c.folders.every(folderTaken);

/**
 * `current` with `item` where the shipped order has it: after the nearest shipped item before it
 * that is still there, else before the nearest one after it, else at the end. The user's own
 * items and their order are left as they are.
 */
function placeAsShipped<T>(current: T[], item: T, shipped: T[], same: (a: T, b: T) => boolean): T[] {
  const at = shipped.findIndex((x) => same(x, item));
  const out = [...current];
  for (let i = at - 1; i >= 0; i--) {
    const j = out.findIndex((x) => same(x, shipped[i]));
    if (j >= 0) return out.splice(j + 1, 0, item), out;
  }
  for (let i = at + 1; i < shipped.length; i++) {
    const j = out.findIndex((x) => same(x, shipped[i]));
    if (j >= 0) return out.splice(j, 0, item), out;
  }
  out.push(item);
  return out;
}

/**
 * The first cleaning pass deleted Trakt lists from saved collections, with the folders and
 * collections that consisted of nothing else. This gives a profile that has the shipped
 * collections those parts back from the shipped file, matched by collection and folder id:
 *
 * - a shipped collection that is missing comes back only if that pass would have removed it whole
 *   (every folder Trakt only). One it would have kept is missing because the user deleted it.
 * - in a shipped collection that is still there, a missing folder comes back only if that pass
 *   would have removed it whole. Any other missing folder was removed by the user.
 * - in a shipped folder that is still there, the Trakt lists it shipped with come back unless the
 *   folder already has that list. Its other sources, name, cover and order are not touched.
 *
 * Collections and folders that are not in the shipped file are the user's own and are not looked
 * at, and a profile with none of the shipped collections is left alone. Returns the same array
 * when there is nothing to put back.
 */
export function restoreDefaultLists(saved: Collection[], shipped: Collection[]): Collection[] {
  const shippedIds = new Set(shipped.map((c) => c.id));
  if (!saved.some((c) => shippedIds.has(c.id))) return saved;
  const sameId = (a: { id: string }, b: { id: string }) => a.id === b.id;
  const sameSource = (a: CollectionSource, b: CollectionSource) => sourceKey(a) === sourceKey(b);
  let out = saved;
  for (const d of shipped) {
    const mine = out.find((c) => c.id === d.id);
    if (!mine) {
      if (collectionTaken(d)) out = placeAsShipped(out, d, shipped, sameId);
      continue;
    }
    let folders = mine.folders;
    for (const df of d.folders) {
      const folder = folders.find((f) => f.id === df.id);
      if (!folder) {
        if (folderTaken(df)) folders = placeAsShipped(folders, df, d.folders, sameId);
        continue;
      }
      const shippedSources = folderSources(df);
      const had = folderSources(folder);
      let sources = had;
      for (const s of shippedSources) if (takenByFirstPass(s) && !sources.some((x) => sameSource(x, s))) sources = placeAsShipped(sources, s, shippedSources, sameSource);
      if (sources !== had) folders = folders.map((f) => (f === folder ? { ...f, sources, catalogSources: [] } : f));
    }
    if (folders !== mine.folders) out = out.map((c) => (c === mine ? { ...c, folders } : c));
  }
  return out;
}

async function shippedCollections(): Promise<Collection[]> {
  const res = await fetch('/defaults/collections.json');
  if (!res.ok) throw new Error(`default collections: HTTP ${res.status}`);
  return parseCollections(await res.json());
}

// ---------- The store ----------

interface CollectionsDoc {
  collections: Collection[];
  lists?: ListRow[];
  /** Set once restoreDefaultLists has run for this profile (or there was nothing for it to do). */
  defaultsRestored?: boolean;
}

interface CollectionsState {
  loaded: boolean;
  /**
   * The collections screens show: `saved` without what this build cannot show (shownCollections).
   * Positions passed to `move`, `moveFolder` and `restoreFolder` count these.
   */
  collections: Collection[];
  /** Everything kept for the profile, including sources only another build can show. */
  saved: Collection[];
  /** Lists that are rows of their own on Home, in the order they were added. */
  lists: ListRow[];
  load: () => Promise<void>;
  replaceAll: (c: Collection[]) => void;
  merge: (c: Collection[]) => number;
  remove: (id: string) => void;
  move: (id: string, to: number) => void;
  create: (title: string) => Collection;
  update: (id: string, patch: Partial<Omit<Collection, 'id' | 'folders'>>) => void;
  addFolder: (collectionId: string, folder: Omit<CollectionFolder, 'id'>) => CollectionFolder;
  updateFolder: (collectionId: string, folderId: string, patch: Partial<Omit<CollectionFolder, 'id'>>) => void;
  removeFolder: (collectionId: string, folderId: string) => CollectionFolder | undefined;
  moveFolder: (collectionId: string, folderId: string, to: number) => void;
  restoreFolder: (collectionId: string, folder: CollectionFolder, index: number) => void;
  /** Adds lists as Home rows and returns the new rows. */
  addLists: (lists: { title: string; source: CollectionSource }[]) => ListRow[];
  /** Takes a list row off Home. Returns it with its place, for `restoreList`. */
  removeList: (id: string) => { row: ListRow; index: number } | undefined;
  /** Puts a removed list row back under its own id (its place on Home is tied to it). */
  restoreList: (row: ListRow, index: number) => void;
}

const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Folders' sources in the newer form, so editing never has to deal with `catalogSources`. */
function normalized(f: CollectionFolder): CollectionFolder {
  return f.sources?.length || !f.catalogSources?.length ? f : { ...f, sources: folderSources(f), catalogSources: [] };
}

const folderShown = (f: CollectionFolder) => !folderSources(f).length || folderSources(f).some(canShowSource);
const collectionShown = (c: Collection) => !c.folders.length || c.folders.some(folderShown);

/**
 * `rest` with `item` put at position `to` among the items that are shown. Items that are hidden
 * keep their places, so they are where they were when a later build shows them.
 */
function placeAmongShown<T>(rest: T[], item: T, to: number, shown: (x: T) => boolean): T[] {
  const visible = rest.filter(shown);
  const before = visible[Math.max(0, to)];
  const index = before ? rest.indexOf(before) : visible.length ? rest.indexOf(visible[visible.length - 1]) + 1 : rest.length;
  const out = [...rest];
  out.splice(index, 0, item);
  return out;
}

/**
 * Home's row keys with the collections this build hides put in at their saved places. Home's
 * layout is told about these too (they are never drawn), so a collection that a later build can
 * show appears where the collection set has it instead of at the bottom of Home.
 */
export function withHiddenCollectionKeys(keys: string[]): string[] {
  const all = useCollections.getState().saved.map((c) => `collection_${c.id}`);
  let out = keys;
  for (const key of all) if (!out.includes(key)) out = placeAsShipped(out, key, all, (a, b) => a === b);
  return out;
}

/** Where a removed folder sat among all of its collection's folders, for putting it back. */
const removedFrom = new WeakMap<CollectionFolder, number>();

let writer = debouncedWriter((v) => docs.write(profileDoc('collections'), v), 800);

export const useCollections = create<CollectionsState>((set, get) => {
  /** Whether the shipped lists were put back for this profile; saved with the collections. */
  let defaultsRestored = true;
  const write = () => writer.save({ collections: get().saved, lists: get().lists, defaultsRestored } satisfies CollectionsDoc);
  const commit = (saved: Collection[]) => {
    set({ saved, collections: shownCollections(saved) });
    write();
  };
  const commitLists = (lists: ListRow[]) => {
    set({ lists });
    write();
  };
  const inCollection = (collectionId: string, change: (c: Collection) => Collection) => commit(get().saved.map((c) => (c.id === collectionId ? change(c) : c)));

  return {
    loaded: false,
    collections: [],
    saved: [],
    lists: [],
    async load() {
      writer.flush();
      const name = profileDoc('collections');
      writer = debouncedWriter((v) => docs.write(name, v), 800);
      const doc = await docs.read<CollectionsDoc>(name).catch(() => null);
      const stored = doc?.collections ?? [];
      // Collections saved by earlier builds came from the same files as imports do: the same pass
      // runs on them. It changes nothing once they are clean, and then nothing is written.
      const saved = cleanCollections(stored);
      const lists = (doc?.lists ?? []).filter((l) => l && typeof l.id === 'string' && l.source && canReadSource(l.source));
      // A profile with no collections has nothing an earlier build could have taken from it.
      defaultsRestored = !!doc?.defaultsRestored || !saved.length;
      set({ loaded: true, saved, collections: shownCollections(saved), lists });
      if (saved !== stored) write();
      if (defaultsRestored) return;
      try {
        const shipped = await shippedCollections();
        // Another profile was opened while the file loaded: this one is done the next time.
        if (profileDoc('collections') !== name) return;
        defaultsRestored = true;
        // On what is saved now, not on what was read before the wait.
        commit(restoreDefaultLists(get().saved, shipped));
      } catch (e) {
        console.warn('shipped collections could not be read; lists an earlier build removed are put back next time', e);
      }
    },
    replaceAll: (c) => commit(c),
    merge(c) {
      const byId = new Map(get().saved.map((x) => [x.id, x]));
      for (const x of c) byId.set(x.id, savedForm(x));
      commit([...byId.values()]);
      return c.length;
    },
    remove: (id) => commit(get().saved.filter((c) => c.id !== id)),
    create(title) {
      const c: Collection = { id: uid('c'), title: title.trim() || 'New collection', pinToTop: false, viewMode: 'TABBED_GRID', showAllTab: true, folders: [] };
      commit([...get().saved, c]);
      return c;
    },
    update(id, patch) {
      inCollection(id, (c) => ({ ...c, ...patch }));
    },
    addFolder(collectionId, folder) {
      const f: CollectionFolder = { ...folder, id: uid('f') };
      inCollection(collectionId, (c) => ({ ...c, folders: [...c.folders, f] }));
      return f;
    },
    updateFolder(collectionId, folderId, patch) {
      inCollection(collectionId, (c) => ({ ...c, folders: c.folders.map((f) => (f.id === folderId ? { ...normalized(f), ...patch } : f)) }));
    },
    removeFolder(collectionId, folderId) {
      const folders = get().saved.find((c) => c.id === collectionId)?.folders ?? [];
      const removed = folders.find((f) => f.id === folderId);
      if (removed) removedFrom.set(removed, folders.indexOf(removed));
      inCollection(collectionId, (c) => ({ ...c, folders: c.folders.filter((f) => f.id !== folderId) }));
      return removed;
    },
    moveFolder(collectionId, folderId, to) {
      inCollection(collectionId, (c) => {
        const folder = c.folders.find((f) => f.id === folderId);
        return folder ? { ...c, folders: placeAmongShown(c.folders.filter((f) => f !== folder), folder, to, folderShown) } : c;
      });
    },
    restoreFolder(collectionId, folder, index) {
      const back = savedForm(folder);
      // Exactly where it was taken from when that is known (hidden folders around it included),
      // else at `index` among the shown ones.
      const at = removedFrom.get(back);
      inCollection(collectionId, (c) => {
        if (c.folders.some((f) => f.id === back.id)) return c;
        if (at === undefined) return { ...c, folders: placeAmongShown(c.folders, back, index, folderShown) };
        const folders = [...c.folders];
        folders.splice(Math.min(at, folders.length), 0, back);
        return { ...c, folders };
      });
    },
    move(id, to) {
      const item = get().saved.find((c) => c.id === id);
      if (item) commit(placeAmongShown(get().saved.filter((c) => c !== item), item, to, collectionShown));
    },
    addLists(lists) {
      const rows = lists.map<ListRow>((l) => ({ id: uid('l'), title: l.title.trim() || 'List', source: l.source, addedAt: Date.now() }));
      commitLists([...get().lists, ...rows]);
      return rows;
    },
    removeList(id) {
      const index = get().lists.findIndex((l) => l.id === id);
      if (index < 0) return undefined;
      const row = get().lists[index];
      commitLists(get().lists.filter((l) => l.id !== id));
      return { row, index };
    },
    restoreList(row, index) {
      if (get().lists.some((l) => l.id === row.id)) return;
      const lists = [...get().lists];
      lists.splice(Math.max(0, Math.min(lists.length, index)), 0, row);
      commitLists(lists);
    },
  };
});

/**
 * A profile's first start: the collections ROVE ships with (public/defaults/collections.json)
 * fill Home. Once per profile, so rows the user deletes stay deleted.
 */
export async function seedDefaultCollections() {
  const flag = profileDoc('collections-seeded');
  if (await docs.read<boolean>(flag).catch(() => null)) return;
  if (useCollections.getState().saved.length === 0) {
    try {
      const parsed = await shippedCollections();
      if (parsed.length) useCollections.getState().replaceAll(parsed);
    } catch (e) {
      console.warn('default collections could not be loaded', e);
      return;
    }
  }
  await docs.write(flag, true);
}

export function flushCollections() {
  return writer.flush();
}

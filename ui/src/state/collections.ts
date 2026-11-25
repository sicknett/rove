// Collections: named groups of folders, each folder a set of catalogs (from addons or TMDB).
// The model is Nuvio's, so Kaptain's collection JSON and Nuvio exports load directly.

import { create } from 'zustand';
import { debouncedWriter, docs } from '../lib/native';
import { profileDoc } from './profiles';

export interface CollectionSource {
  provider?: 'addon' | 'tmdb' | 'trakt' | string;
  addonId?: string;
  type?: string;
  catalogId?: string;
  genre?: string | null;
  tmdbSourceType?: 'LIST' | 'COLLECTION' | 'COMPANY' | 'NETWORK' | 'DISCOVER' | 'PERSON' | 'DIRECTOR' | string;
  title?: string;
  tmdbId?: number;
  mediaType?: string;
  sortBy?: string;
  filters?: Record<string, string | number | null | undefined>;
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

/** Sources in the newer `sources` form, filling in older `catalogSources`. */
export function folderSources(f: CollectionFolder): CollectionSource[] {
  if (f.sources?.length) return f.sources;
  return (f.catalogSources ?? []).map((c) => ({ provider: 'addon', addonId: c.addonId, type: c.type, catalogId: c.catalogId, genre: c.genre }));
}

/** Sources ROVE has a reader for: addon catalogs and TMDB. (Collection files also carry Trakt lists.) */
export function canShowSource(s: CollectionSource): boolean {
  const provider = (s.provider ?? 'addon').toLowerCase();
  return provider === 'tmdb' || (provider === 'addon' && !!s.addonId && !!s.catalogId && !!s.type);
}

/**
 * Drops what ROVE cannot show: sources from other providers, then folders that had sources and
 * are left with none, then collections that had folders and are left with none. A folder or a
 * collection that was empty to begin with is the user's own work in progress and stays. Returns
 * the same array when there is nothing to drop, so a caller can tell whether anything changed.
 */
export function cleanCollections(list: Collection[]): Collection[] {
  let changed = false;
  const out: Collection[] = [];
  for (const c of list) {
    const folders: CollectionFolder[] = [];
    for (const f of c.folders) {
      const sources = folderSources(f);
      const kept = sources.filter(canShowSource);
      if (kept.length === sources.length) folders.push(f);
      else if (kept.length) folders.push({ ...f, sources: kept, catalogSources: [] });
    }
    if (folders.length === c.folders.length && folders.every((f, i) => f === c.folders[i])) out.push(c);
    else {
      changed = true;
      if (folders.length) out.push({ ...c, folders });
    }
  }
  return changed ? out : list;
}

/**
 * Accepts a collection array, `{collections:[…]}`, or a single collection, and keeps the parts
 * ROVE can show (see cleanCollections). Everything imported or seeded comes through here.
 */
export function parseCollections(input: unknown): Collection[] {
  const raw = Array.isArray(input) ? input : (input as { collections?: unknown[] })?.collections ?? (input && typeof input === 'object' && 'folders' in (input as object) ? [input] : []);
  return cleanCollections(
    (raw as Collection[])
      .filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string')
      .map((c) => ({ ...c, folders: (c.folders ?? []).filter((f) => f && f.id && f.title) })),
  );
}

interface CollectionsState {
  loaded: boolean;
  collections: Collection[];
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
}

const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Folders' sources in the newer form, so editing never has to deal with `catalogSources`. */
function normalized(f: CollectionFolder): CollectionFolder {
  return f.sources?.length || !f.catalogSources?.length ? f : { ...f, sources: folderSources(f), catalogSources: [] };
}

let writer = debouncedWriter((v) => docs.write(profileDoc('collections'), v), 800);

export const useCollections = create<CollectionsState>((set, get) => {
  const commit = (collections: Collection[]) => {
    set({ collections });
    writer.save({ collections });
  };
  return {
    loaded: false,
    collections: [],
    async load() {
      writer.flush();
      const name = profileDoc('collections');
      writer = debouncedWriter((v) => docs.write(name, v), 800);
      const doc = await docs.read<{ collections: Collection[] }>(name).catch(() => null);
      const saved = doc?.collections ?? [];
      // Collections saved before imports were cleaned came from the same files: the same pass
      // runs on them. It changes nothing once they are clean, and then nothing is written.
      const collections = cleanCollections(saved);
      set({ loaded: true, collections });
      if (collections !== saved) writer.save({ collections });
    },
    replaceAll: (c) => commit(c),
    merge(c) {
      const byId = new Map(get().collections.map((x) => [x.id, x]));
      for (const x of c) byId.set(x.id, x);
      commit([...byId.values()]);
      return c.length;
    },
    remove: (id) => commit(get().collections.filter((c) => c.id !== id)),
    create(title) {
      const c: Collection = { id: uid('c'), title: title.trim() || 'New collection', pinToTop: false, viewMode: 'TABBED_GRID', showAllTab: true, folders: [] };
      commit([...get().collections, c]);
      return c;
    },
    update(id, patch) {
      commit(get().collections.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    },
    addFolder(collectionId, folder) {
      const f: CollectionFolder = { ...folder, id: uid('f') };
      commit(get().collections.map((c) => (c.id === collectionId ? { ...c, folders: [...c.folders, f] } : c)));
      return f;
    },
    updateFolder(collectionId, folderId, patch) {
      commit(
        get().collections.map((c) =>
          c.id === collectionId ? { ...c, folders: c.folders.map((f) => (f.id === folderId ? { ...normalized(f), ...patch } : f)) } : c,
        ),
      );
    },
    removeFolder(collectionId, folderId) {
      const removed = get().collections.find((c) => c.id === collectionId)?.folders.find((f) => f.id === folderId);
      commit(get().collections.map((c) => (c.id === collectionId ? { ...c, folders: c.folders.filter((f) => f.id !== folderId) } : c)));
      return removed;
    },
    moveFolder(collectionId, folderId, to) {
      commit(
        get().collections.map((c) => {
          if (c.id !== collectionId) return c;
          const list = [...c.folders];
          const from = list.findIndex((f) => f.id === folderId);
          if (from < 0) return c;
          const [f] = list.splice(from, 1);
          list.splice(Math.max(0, Math.min(list.length, to)), 0, f);
          return { ...c, folders: list };
        }),
      );
    },
    restoreFolder(collectionId, folder, index) {
      commit(
        get().collections.map((c) => {
          if (c.id !== collectionId || c.folders.some((f) => f.id === folder.id)) return c;
          const list = [...c.folders];
          list.splice(Math.min(index, list.length), 0, folder);
          return { ...c, folders: list };
        }),
      );
    },
    move(id, to) {
      const list = [...get().collections];
      const from = list.findIndex((c) => c.id === id);
      if (from < 0) return;
      const [x] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(list.length, to)), 0, x);
      commit(list);
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
  if (useCollections.getState().collections.length === 0) {
    try {
      const res = await fetch('/defaults/collections.json');
      const parsed = parseCollections(await res.json());
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

// Turning chosen lists into rows on Home or folders in a collection.

import { fetchSourcePage, firstSourcePage } from '../data/sources';
import { folderSources, listRowKey, sourceKey, useCollections, type CollectionSource } from '../state/collections';
import { useHomeLayout } from '../state/homeLayout';
import type { ListChoice } from './types';

export interface ImportResult {
  added: number;
  /** Lists that were already there and were left as they are. */
  skipped: number;
}

/**
 * Adds each list as a row of its own on Home, right under Continue Watching: a row added by hand
 * should be seen, and the end of a long Home is not. A list that already has a row is skipped.
 */
export function importAsRows(lists: ListChoice[]): ImportResult & { ids: string[] } {
  const store = useCollections.getState();
  const have = new Set(store.lists.map((l) => sourceKey(l.source)));
  const fresh = lists.filter((c) => !have.has(c.key));
  const rows = fresh.length ? store.addLists(fresh.map((c) => ({ title: c.title, source: c.source }))) : [];
  const keys = rows.map((r) => listRowKey(r.id));
  // Home adds new rows to its layout at the end when it next draws; these are placed now.
  if (keys.length && useHomeLayout.getState().loaded) useHomeLayout.getState().ensure(keys, keys);
  return { added: rows.length, skipped: lists.length - rows.length, ids: rows.map((r) => r.id) };
}

/** A picture link that can be kept in a collection: not one that carries a server's sign-in. */
const keepable = (url: string | undefined) => !!url && /^https?:\/\//i.test(url) && !/[?&](x-plex-token|api_?key|token)=/i.test(url);

/** Gives a folder with no cover the poster of its list's first title. Quietly does nothing when that cannot be had. */
async function fillCover(collectionId: string, folderId: string, source: CollectionSource) {
  const items = await fetchSourcePage(source, firstSourcePage(source)).catch(() => []);
  const poster = items.map((m) => m.poster).find(keepable);
  if (!poster) return;
  const store = useCollections.getState();
  const folder = store.saved.find((c) => c.id === collectionId)?.folders.find((f) => f.id === folderId);
  if (folder && !folder.coverImageUrl) store.updateFolder(collectionId, folderId, { coverImageUrl: poster });
}

/**
 * Adds each list as a folder (with the list as its one source) to a collection: an existing one,
 * or a new one made with `title`. A list the collection already has a folder for is skipped.
 */
export function importAsFolders(lists: ListChoice[], target: { collectionId: string } | { title: string }): ImportResult & { collectionId: string; title: string } {
  const store = useCollections.getState();
  const existing = 'collectionId' in target ? store.saved.find((c) => c.id === target.collectionId) : undefined;
  const collection = existing ?? store.create('title' in target ? target.title : 'Lists');
  const have = new Set(collection.folders.flatMap((f) => folderSources(f).map(sourceKey)));
  let added = 0;
  for (const c of lists) {
    if (have.has(c.key)) continue;
    const folder = store.addFolder(collection.id, { title: c.title, coverImageUrl: null, tileShape: 'poster', hideTitle: false, sources: [c.source], catalogSources: [] });
    void fillCover(collection.id, folder.id, c.source);
    added++;
  }
  return { added, skipped: lists.length - added, collectionId: collection.id, title: collection.title };
}

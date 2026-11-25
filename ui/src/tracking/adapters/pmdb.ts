// PublicMetaDB as a tracker: TMDB-keyed resume points, watched history and watchlist.

import { pool } from '../../lib/http';
import { isImdbId, parseId, watchKey } from '../../addons/ids';
import type { ProgressEntry, WatchedEntry } from '../../state/history';
import { flushIdMap, metaIdFor, tmdbFor } from '../idmap';
import { parsePmdbTime, pmdb, PmdbError, type PmdbListItem, type PmdbPage, type PmdbResume, type PmdbTarget, type PmdbWatched } from '../pmdb';
import { TrackerError, type PullResult, type PushResult, type TitleRef, type TrackerAccount, type TrackerAdapter, type WatchlistEntry } from '../types';

/** PMDB resume ids by our watch key, from the last pull: needed to delete or replace one. */
const resumeIds = new Map<string, string>();
let watchlistId: string | null | undefined;

function key(account: TrackerAccount) {
  if (!account.apiKey) throw new TrackerError('unauthorized', 'No PublicMetaDB key');
  return account.apiKey;
}

/** PMDB failures as the engine understands them. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PmdbError) {
      if (e.unauthorized) throw new TrackerError('unauthorized', 'PublicMetaDB no longer accepts this key.', e.status);
      if (e.status >= 400 && e.status < 500 && e.status !== 429) throw new TrackerError('rejected', `PublicMetaDB refused it (HTTP ${e.status}).`, e.status);
      throw new TrackerError('retry', `PublicMetaDB answered HTTP ${e.status}.`, e.status, e.retryAt);
    }
    throw new TrackerError('retry', 'Could not reach PublicMetaDB.');
  }
}

async function targetFor(item: { metaId: string; type: 'movie' | 'series'; season?: number; episode?: number; tmdbId?: number }, apiKey: string): Promise<PmdbTarget | null> {
  const t = item.tmdbId ? { id: item.tmdbId, kind: item.type === 'movie' ? ('movie' as const) : ('tv' as const) } : await tmdbFor(item.metaId, item.type, apiKey);
  if (!t) return null;
  return t.kind === 'movie' ? { tmdbId: t.id, mediaType: 'movie' } : { tmdbId: t.id, mediaType: 'tv', season: item.season ?? 1, episode: item.episode ?? 1 };
}

/** No TMDB id for this title: worth another try for an IMDb id (the lookup may have failed), final for anything else. */
const noTarget = (item: { metaId: string }): PushResult => (isImdbId(parseId(item.metaId).base) ? 'unmapped' : 'skip');

/** The id of the account's watchlist, or null when it has none. Throws when the lists cannot be read. */
async function listId(apiKey: string): Promise<string | null> {
  if (watchlistId !== undefined) return watchlistId;
  const lists = await pmdb.lists(apiKey);
  watchlistId = lists.find((l) => l.type === 'watchlist')?.id ?? null;
  return watchlistId;
}

/**
 * Every page of one of the account's lists. `complete` is false when the page limit ended it
 * early or fewer items arrived than the API counts: the sync then removes nothing on its word.
 */
async function allPages<T>(fetchPage: (page: number) => Promise<PmdbPage<T>>, maxPages: number, perPage = 100): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(page);
    items.push(...res.items);
    const size = res.perPage ?? perPage;
    const pages = res.totalPages ?? (res.total !== undefined ? Math.ceil(res.total / size) : undefined);
    // Without a page count, a page that is not full is the last one.
    const last = pages !== undefined ? page >= pages : res.items.length < size;
    if (!res.items.length || last) return { items, complete: res.total === undefined || items.length >= res.total };
  }
  return { items, complete: false };
}

export const pmdbAdapter: TrackerAdapter = {
  id: 'pmdb',
  name: 'PublicMetaDB',

  async pull(account) {
    const apiKey = key(account);
    return guard(async () => {
      const incomplete: NonNullable<PullResult['incomplete']> = [];
      const resumePages = await allPages<PmdbResume>((page) => pmdb.resumePage(apiKey, page), 20);
      const resume = resumePages.items;
      if (!resumePages.complete) incomplete.push('progress');
      const watchedPages = await allPages<PmdbWatched>((page) => pmdb.watchedPage(apiKey, page), 100);
      const watched = watchedPages.items;
      if (!watchedPages.complete) incomplete.push('watched');
      // The watchlist is extra: when it cannot be read the history still syncs, and the local
      // watchlist is left as it is.
      let wlItems: PmdbListItem[] | null = null;
      try {
        watchlistId = undefined;
        const wlId = await listId(apiKey);
        if (wlId) wlItems = await pmdb.listItems(apiKey, wlId);
      } catch (e) {
        if (e instanceof PmdbError && e.unauthorized) throw e;
        incomplete.push('watchlist');
      }

      // One id lookup per title, a few at a time.
      const titles = new Map<string, { id: number; kind: 'movie' | 'tv' }>();
      for (const x of [...resume, ...watched, ...(wlItems ?? [])]) titles.set(`${x.media_type}:${x.tmdb_id}`, { id: x.tmdb_id, kind: x.media_type });
      const metaIds = new Map<string, string>();
      await pool([...titles.entries()], 6, async ([k, t]) => {
        metaIds.set(k, await metaIdFor(t.id, t.kind, apiKey));
      });
      void flushIdMap();

      resumeIds.clear();
      const progress: ProgressEntry[] = [];
      for (const r of resume) {
        const metaId = metaIds.get(`${r.media_type}:${r.tmdb_id}`)!;
        const movie = r.media_type === 'movie';
        const season = movie ? undefined : r.season ?? 1;
        const episode = movie ? undefined : r.episode ?? 1;
        const k = watchKey(metaId, season, episode);
        resumeIds.set(k, r.id);
        if (!(r.runtime_ms > 0)) continue;
        progress.push({
          key: k,
          metaId,
          type: movie ? 'movie' : 'series',
          season,
          episode,
          positionS: r.position_ms / 1000,
          durationS: r.runtime_ms / 1000,
          updatedAt: parsePmdbTime(r.updated) ?? parsePmdbTime(r.created) ?? 0,
          tmdbId: r.tmdb_id,
          name: r.title,
          poster: r.poster,
          synced: true,
        });
      }
      const watchedEntries: WatchedEntry[] = watched.map((w) => {
        const metaId = metaIds.get(`${w.media_type}:${w.tmdb_id}`)!;
        const movie = w.media_type === 'movie';
        const season = movie ? undefined : w.season ?? undefined;
        const episode = movie ? undefined : w.episode ?? undefined;
        return { key: watchKey(metaId, season, episode), metaId, type: movie ? 'movie' : 'series', season, episode, at: parsePmdbTime(w.watched_at) ?? 0, tmdbId: w.tmdb_id, synced: true };
      });
      const watchlist: WatchlistEntry[] | undefined = wlItems?.map((it) => ({
        metaId: metaIds.get(`${it.media_type}:${it.tmdb_id}`)!,
        type: it.media_type === 'movie' ? 'movie' : 'series',
        name: it.title,
        poster: it.poster,
        tmdbId: it.tmdb_id,
        addedAt: Date.parse(it.added_at ?? '') || undefined,
      }));
      return { progress, watched: watchedEntries, watchlist, counts: { resume: resume.length, watched: watched.length }, incomplete };
    });
  },

  async push(account, op, h) {
    const apiKey = key(account);
    return guard(async () => {
      if (op.op === 'resume') {
        const e = h.progress[op.key];
        if (!e) return 'skip';
        const target = await targetFor(e, apiKey);
        if (!target) return noTarget(e);
        try {
          const res = await pmdb.saveResume(apiKey, target, e.positionS * 1000, e.durationS * 1000);
          if (res.action === 'completed') await pmdb.markWatched(apiKey, target, Date.now());
        } catch (err) {
          if (!(err instanceof PmdbError && err.conflict)) throw err;
          // A resume point exists under another id: replace it once.
          const existing = resumeIds.get(op.key);
          if (existing) await pmdb.deleteResume(apiKey, existing);
          await pmdb.saveResume(apiKey, target, e.positionS * 1000, e.durationS * 1000);
        }
        return 'synced';
      }
      if (op.op === 'watched') {
        const w = h.watched[op.key];
        if (!w) return 'skip';
        const target = await targetFor(w, apiKey);
        if (!target) return noTarget(w);
        await pmdb.markWatched(apiKey, target, w.at);
        const rid = resumeIds.get(op.key);
        if (rid) {
          await pmdb.deleteResume(apiKey, rid).catch(() => undefined);
          resumeIds.delete(op.key);
        }
        return 'synced';
      }
      if (op.op === 'unwatched') {
        const target = await targetFor(op, apiKey);
        if (!target) return noTarget(op);
        await pmdb.unmarkWatched(apiKey, target);
        return 'synced';
      }
      const rid = resumeIds.get(op.key);
      if (!rid) return 'skip';
      await pmdb.deleteResume(apiKey, rid).catch((e) => {
        if (!(e instanceof PmdbError && e.status === 404)) throw e;
      });
      resumeIds.delete(op.key);
      return 'synced';
    });
  },

  async watchlistAdd(account, t: TitleRef) {
    const apiKey = key(account);
    return guard(async (): Promise<PushResult> => {
      const id = await listId(apiKey);
      if (!id) return 'skip';
      const target = await targetFor(t, apiKey);
      if (!target) return noTarget(t);
      await pmdb.addListItem(apiKey, id, target.tmdbId, target.mediaType);
      return 'synced';
    });
  },

  async watchlistRemove(account, t: TitleRef) {
    const apiKey = key(account);
    return guard(async (): Promise<PushResult> => {
      const id = await listId(apiKey);
      if (!id) return 'skip';
      const target = await targetFor(t, apiKey);
      if (!target) return noTarget(t);
      await pmdb.removeListItem(apiKey, id, target.tmdbId);
      return 'synced';
    });
  },
};

export function resetPmdbCaches() {
  resumeIds.clear();
  watchlistId = undefined;
}

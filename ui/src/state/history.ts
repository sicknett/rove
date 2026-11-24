// What each profile has watched and how far: resume points, watched marks, the local watchlist,
// and titles removed from Continue Watching. Changes also go into an outbox that the tracker
// sync (tracking/sync.ts) sends to PublicMetaDB.

import { create } from 'zustand';
import { watchKey } from '../addons/ids';
import { debouncedWriter, docs } from '../lib/native';
import { profileDoc } from './profiles';

export type MediaType = 'movie' | 'series';

export interface TitleCard {
  name?: string;
  poster?: string;
  background?: string;
  logo?: string;
  year?: string;
}

export interface ProgressEntry extends TitleCard {
  key: string;
  metaId: string;
  type: MediaType;
  season?: number;
  episode?: number;
  /** The addon video id the stream was requested with (`tt…:1:2`). */
  videoId?: string;
  positionS: number;
  durationS: number;
  updatedAt: number;
  /**
   * The tracker gave only a percentage, so the running time here is a guess: resume by share of
   * the video, and do not show minutes left.
   */
  estimated?: boolean;
  episodeTitle?: string;
  still?: string;
  tmdbId?: number;
  /** Came from or went to the tracker; a synced entry the tracker no longer has was finished elsewhere. */
  synced?: boolean;
}

export interface WatchedEntry {
  key: string;
  metaId: string;
  type: MediaType;
  season?: number;
  episode?: number;
  at: number;
  tmdbId?: number;
  synced?: boolean;
}

export interface LibraryItem extends TitleCard {
  metaId: string;
  type: MediaType;
  addedAt: number;
}

export type OutboxOp =
  | { op: 'resume'; key: string; at: number }
  | { op: 'watched'; key: string; at: number }
  | { op: 'unwatched'; key: string; metaId: string; type: MediaType; season?: number; episode?: number; tmdbId?: number; at: number }
  | { op: 'clear-resume'; key: string; metaId: string; type: MediaType; season?: number; episode?: number; tmdbId?: number; at: number };

interface HistoryDoc {
  version: 1;
  progress: Record<string, ProgressEntry>;
  watched: Record<string, WatchedEntry>;
  library: Record<string, LibraryItem>;
  /** metaId -> when it was removed from Continue Watching. Newer activity brings it back. */
  dismissed: Record<string, number>;
  /** metaId -> card art, so rows show instantly on start. */
  cards: Record<string, TitleCard & { type: MediaType }>;
  outbox: OutboxOp[];
}

const empty = (): HistoryDoc => ({ version: 1, progress: {}, watched: {}, library: {}, dismissed: {}, cards: {}, outbox: [] });

/** Under this share of a title nothing is kept (an accidental start). */
export const MIN_RESUME_PERCENT = 2;
/** At or past this share a title counts as watched. */
export const WATCHED_PERCENT = 90;

interface HistoryState extends HistoryDoc {
  loaded: boolean;
  load: () => Promise<void>;
  /** Saves a playback position; marks watched and clears the resume point past the threshold. */
  /**
   * Saves a playback position; marks watched and clears the resume point past the threshold.
   * `sync: false` keeps it local (frequent saves while playing); the tracker gets it on the next
   * call with `sync: true` (pause, stop, every few minutes).
   */
  recordProgress: (entry: Omit<ProgressEntry, 'key' | 'updatedAt'> & { updatedAt?: number }, opts?: { sync?: boolean }) => 'saved' | 'watched' | 'ignored';
  markWatched: (items: { metaId: string; type: MediaType; season?: number; episode?: number; tmdbId?: number }[], at?: number) => void;
  unmarkWatched: (items: { metaId: string; type: MediaType; season?: number; episode?: number; tmdbId?: number }[]) => void;
  clearProgress: (key: string) => void;
  dismiss: (metaId: string) => void;
  undismiss: (metaId: string) => void;
  toggleLibrary: (item: Omit<LibraryItem, 'addedAt'>) => boolean;
  setLibrary: (items: Record<string, LibraryItem>) => void;
  rememberCard: (metaId: string, type: MediaType, card: TitleCard) => void;
  /** Applies a tracker pull. Local changes newer than the pull win. */
  applyRemote: (remote: { progress: ProgressEntry[]; watched: WatchedEntry[] }, pulledAt: number) => void;
  takeOutbox: () => OutboxOp[];
  requeue: (ops: OutboxOp[]) => void;
  markSynced: (keys: { progress?: string[]; watched?: string[] }) => void;
  clearAll: () => void;
}

let writer = debouncedWriter((v) => docs.write(profileDoc('history'), v), 800);

function snapshot(s: HistoryState): HistoryDoc {
  return { version: 1, progress: s.progress, watched: s.watched, library: s.library, dismissed: s.dismissed, cards: s.cards, outbox: s.outbox };
}

export const useHistory = create<HistoryState>((set, get) => {
  const commit = (patch: Partial<HistoryDoc>) => {
    set(patch);
    writer.save(snapshot(get()));
  };

  return {
    ...empty(),
    loaded: false,

    async load() {
      writer.flush();
      const name = profileDoc('history');
      writer = debouncedWriter((v) => docs.write(name, v), 800);
      const doc = await docs.read<HistoryDoc>(name).catch(() => null);
      set({ ...empty(), ...(doc ?? {}), loaded: true });
    },

    recordProgress(input, opts = {}) {
      const sync = opts.sync ?? true;
      const { durationS, positionS } = input;
      if (!(durationS > 0) || !Number.isFinite(positionS)) return 'ignored';
      const percent = (positionS / durationS) * 100;
      const key = watchKey(input.metaId, input.season, input.episode);
      const at = input.updatedAt ?? Date.now();
      if (percent >= WATCHED_PERCENT) {
        const progress = { ...get().progress };
        delete progress[key];
        const watched = { ...get().watched, [key]: { key, metaId: input.metaId, type: input.type, season: input.season, episode: input.episode, at, tmdbId: input.tmdbId } };
        const outbox = [...get().outbox.filter((o) => o.key !== key), { op: 'watched' as const, key, at }];
        commit({ progress, watched, outbox });
        return 'watched';
      }
      if (percent < MIN_RESUME_PERCENT) return 'ignored';
      const previous = get().progress[key];
      const entry: ProgressEntry = { ...previous, ...input, key, updatedAt: at, synced: previous?.synced };
      const outbox = sync ? [...get().outbox.filter((o) => !(o.key === key && o.op === 'resume')), { op: 'resume' as const, key, at }] : get().outbox;
      const dismissed = { ...get().dismissed };
      delete dismissed[input.metaId];
      commit({ progress: { ...get().progress, [key]: entry }, outbox, dismissed });
      return 'saved';
    },

    markWatched(items, at = Date.now()) {
      const watched = { ...get().watched };
      const progress = { ...get().progress };
      const outbox = [...get().outbox];
      for (const it of items) {
        const key = watchKey(it.metaId, it.season, it.episode);
        watched[key] = { key, metaId: it.metaId, type: it.type, season: it.season, episode: it.episode, at, tmdbId: it.tmdbId };
        delete progress[key];
        outbox.push({ op: 'watched', key, at });
      }
      commit({ watched, progress, outbox: dedupeOutbox(outbox) });
    },

    unmarkWatched(items) {
      const watched = { ...get().watched };
      const outbox = [...get().outbox];
      const at = Date.now();
      for (const it of items) {
        const key = watchKey(it.metaId, it.season, it.episode);
        const had = watched[key];
        delete watched[key];
        outbox.push({ op: 'unwatched', key, metaId: it.metaId, type: it.type, season: it.season, episode: it.episode, tmdbId: it.tmdbId ?? had?.tmdbId, at });
      }
      commit({ watched, outbox: dedupeOutbox(outbox) });
    },

    clearProgress(key) {
      const entry = get().progress[key];
      if (!entry) return;
      const progress = { ...get().progress };
      delete progress[key];
      const outbox = [...get().outbox, { op: 'clear-resume' as const, key, metaId: entry.metaId, type: entry.type, season: entry.season, episode: entry.episode, tmdbId: entry.tmdbId, at: Date.now() }];
      commit({ progress, outbox: dedupeOutbox(outbox) });
    },

    dismiss(metaId) {
      commit({ dismissed: { ...get().dismissed, [metaId]: Date.now() } });
    },

    undismiss(metaId) {
      const dismissed = { ...get().dismissed };
      delete dismissed[metaId];
      commit({ dismissed });
    },

    setLibrary(items) {
      commit({ library: items });
    },

    toggleLibrary(item) {
      const library = { ...get().library };
      const had = !!library[item.metaId];
      if (had) delete library[item.metaId];
      else library[item.metaId] = { ...item, addedAt: Date.now() };
      commit({ library });
      return !had;
    },

    rememberCard(metaId, type, card) {
      const prev = get().cards[metaId];
      const next = { ...prev, ...Object.fromEntries(Object.entries(card).filter(([, v]) => v)), type };
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
      commit({ cards: { ...get().cards, [metaId]: next } });
    },

    applyRemote(remote, pulledAt) {
      const s = get();
      const pendingKeys = new Set(s.outbox.map((o) => o.key));
      const progress: Record<string, ProgressEntry> = {};
      // Local entries the tracker never had, or that changed since: keep.
      for (const [k, e] of Object.entries(s.progress)) {
        if (!e.synced || pendingKeys.has(k) || e.updatedAt > pulledAt) progress[k] = e;
      }
      for (const r of remote.progress) {
        const local = s.progress[r.key];
        if (local && (pendingKeys.has(r.key) || local.updatedAt > r.updatedAt)) continue;
        progress[r.key] = { ...local, ...r, ...pickCard(local), synced: true };
      }
      const watched: Record<string, WatchedEntry> = {};
      for (const [k, w] of Object.entries(s.watched)) {
        if (!w.synced || pendingKeys.has(k) || w.at > pulledAt) watched[k] = w;
      }
      for (const r of remote.watched) {
        const pendingUnwatch = s.outbox.some((o) => o.key === r.key && o.op === 'unwatched');
        if (pendingUnwatch) continue;
        watched[r.key] = { ...r, synced: true };
        // A title watched elsewhere has no resume point any more.
        if (progress[r.key] && progress[r.key].updatedAt <= r.at) delete progress[r.key];
      }
      commit({ progress, watched });
    },

    takeOutbox() {
      const ops = get().outbox;
      if (ops.length) commit({ outbox: [] });
      return ops;
    },

    requeue(ops) {
      if (!ops.length) return;
      commit({ outbox: dedupeOutbox([...ops, ...get().outbox]) });
    },

    markSynced({ progress: pk = [], watched: wk = [] }) {
      const progress = { ...get().progress };
      const watched = { ...get().watched };
      for (const k of pk) if (progress[k]) progress[k] = { ...progress[k], synced: true };
      for (const k of wk) if (watched[k]) watched[k] = { ...watched[k], synced: true };
      commit({ progress, watched });
    },

    clearAll() {
      commit(empty());
    },
  };
});

function pickCard(e?: ProgressEntry): Partial<ProgressEntry> {
  if (!e) return {};
  const { name, poster, background, logo, episodeTitle, still, videoId } = e;
  return Object.fromEntries(Object.entries({ name, poster, background, logo, episodeTitle, still, videoId }).filter(([, v]) => v !== undefined));
}

/** The latest op per key wins, except that a watch and an unwatch cancel into the newer one. */
export function dedupeOutbox(ops: OutboxOp[]): OutboxOp[] {
  const last = new Map<string, OutboxOp>();
  for (const op of ops) {
    const prev = last.get(op.key);
    if (!prev || op.at >= prev.at) last.set(op.key, op);
  }
  return [...last.values()].sort((a, b) => a.at - b.at);
}

export function flushHistory() {
  return writer.flush();
}

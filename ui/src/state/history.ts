// What each profile has watched and how far: resume points, watched marks, the local watchlist,
// and titles removed from Continue Watching. Changes also go into an outbox that the tracker
// sync (tracking/sync.ts) sends to the profile's tracker.
//
// Every title is kept under one id: its IMDb id whenever the id map (tracking/idmap.ts) knows
// it, the id it came with otherwise. Writes are put under that id here, whatever id the caller
// has; entries stored under a `tmdb:` id move over once the mapping is learned (rekey).

import { create } from 'zustand';
import { titleKey, tmdbTitleNumber, watchKey } from '../addons/ids';
import { debouncedWriter, docs } from '../lib/native';
import { canonicalNow, loadIdMap, onIdMapChange } from '../tracking/idmap';
import { toast } from '../ui/toast';
import { profileDoc, useProfiles } from './profiles';

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
  /** Times watched, when more than once is known: the latest mark of a show being watched again. */
  plays?: number;
}

export interface LibraryItem extends TitleCard {
  metaId: string;
  type: MediaType;
  addedAt: number;
  tmdbId?: number;
  /** On the tracker's watchlist too (it came from there, or the add was sent). */
  synced?: boolean;
}

/** How often sending an op has failed; the sync gives up on it after a few. */
interface Tried {
  tries?: number;
}

/** A change to progress or watched marks, waiting to go to the tracker. */
export type HistoryOp = (
  | { op: 'resume'; key: string; at: number }
  | { op: 'watched'; key: string; at: number }
  | { op: 'unwatched'; key: string; metaId: string; type: MediaType; season?: number; episode?: number; tmdbId?: number; at: number }
  | { op: 'clear-resume'; key: string; metaId: string; type: MediaType; season?: number; episode?: number; tmdbId?: number; at: number }
) &
  Tried;

/** A watchlist add or removal waiting to go to the tracker. Its key is `list:<title key>`. */
export type ListOp = { op: 'list-add' | 'list-remove'; key: string; metaId: string; type: MediaType; tmdbId?: number; name?: string; at: number } & Tried;

export type OutboxOp = HistoryOp | ListOp;

export const isListOp = (op: OutboxOp): op is ListOp => op.op === 'list-add' || op.op === 'list-remove';

export interface HistoryDoc {
  version: 1;
  progress: Record<string, ProgressEntry>;
  watched: Record<string, WatchedEntry>;
  /** Title key (see addons/ids titleKey) -> watchlist item. */
  library: Record<string, LibraryItem>;
  /** Title key -> when it was removed from Continue Watching. Newer activity brings it back. */
  dismissed: Record<string, number>;
  /** Title key -> card art, so rows show instantly on start. */
  cards: Record<string, TitleCard & { type: MediaType }>;
  outbox: OutboxOp[];
}

const empty = (): HistoryDoc => ({ version: 1, progress: {}, watched: {}, library: {}, dismissed: {}, cards: {}, outbox: [] });

/** Under this share of a title nothing is kept (an accidental start). */
export const MIN_RESUME_PERCENT = 2;
/** At or past this share a title counts as watched. */
export const WATCHED_PERCENT = 90;
/** Back under this share, a title that was just finished is being watched again from the start. */
const RESTART_PERCENT = 10;
/** Saves made while playing reach the disk at most this often; everything else is written at once. */
const LAZY_SAVE_MS = 30000;
/** A tracker that stores a percentage gives back a position this close (share of the video) to ours. */
const SAME_POSITION_SHARE = 0.01;
/**
 * Two marks of one title further apart than this are two viewings. Closer together they are the
 * same one recorded twice (a mark at the threshold and another at the end; rows a tracker kept
 * from saves a few seconds apart).
 */
const REPEAT_GAP_MS = 6 * 3600 * 1000;

type WatchRef = { metaId: string; type: MediaType; season?: number; episode?: number; tmdbId?: number };

/** What a tracker pull hands over (tracking/types PullResult has the same parts). */
export interface RemoteHistory {
  progress: ProgressEntry[];
  watched: WatchedEntry[];
  /** Parts that failed or were cut short: what they list is merged in, nothing is removed for being absent. */
  incomplete?: ('progress' | 'watched' | 'watchlist')[];
  /** The tracker holds no position past this share of a title (see tracking/types PullResult). */
  resumeCap?: number;
}

interface HistoryState extends HistoryDoc {
  loaded: boolean;
  /**
   * The history file exists but could not be read. The store then starts empty and writes
   * nothing, so the file is still there for the next start.
   */
  readOnly: boolean;
  load: () => Promise<void>;
  /**
   * Saves a playback position; marks watched and clears the resume point past the threshold.
   * `sync: false` keeps it local (frequent saves while playing); the tracker gets it on the next
   * call with `sync: true` (pause, stop, every few minutes). Calling it again with nothing new
   * does nothing: past the threshold the title is marked and queued once per viewing.
   */
  recordProgress: (entry: Omit<ProgressEntry, 'key' | 'updatedAt'> & { updatedAt?: number }, opts?: { sync?: boolean }) => 'saved' | 'watched' | 'ignored';
  markWatched: (items: WatchRef[], at?: number) => void;
  unmarkWatched: (items: WatchRef[]) => void;
  clearProgress: (key: string) => void;
  /** Hides a title from Continue Watching until there is newer activity. Pass the type: `tmdb:` ids need it. */
  dismiss: (metaId: string, type?: MediaType) => void;
  undismiss: (metaId: string, type?: MediaType) => void;
  toggleLibrary: (item: Omit<LibraryItem, 'addedAt'>) => boolean;
  setLibrary: (items: Record<string, LibraryItem>) => void;
  rememberCard: (metaId: string, type: MediaType, card: TitleCard) => void;
  /** Applies a tracker pull. Local changes newer than the pull win. */
  applyRemote: (remote: RemoteHistory, pulledAt: number) => void;
  /**
   * After a push attempt. `done` ops leave the outbox (sent, or given up on); `failed` ones stay
   * and count a try; `synced` keys are flagged as known to the tracker. An op replaced by a
   * newer change to the same key in the meantime is left alone.
   */
  settleOutbox: (result: { done?: OutboxOp[]; failed?: OutboxOp[]; synced?: { progress?: string[]; watched?: string[]; library?: string[] } }) => void;
  /** Moves entries kept under a `tmdb:` id to the IMDb id the id map knows by now. True when anything moved. */
  rekey: () => boolean;
  /** Forgets which entries the tracker has: on connecting another account, or none, so its pull removes nothing. */
  forgetTracker: () => void;
  clearAll: () => void;
}

let writer = debouncedWriter((v) => docs.write(profileDoc('history'), v), 800);
/** False until a load has read the profile's history (or found there is none yet): no writes before. */
let writable = false;
/**
 * The profile whose history is in the store. Once another profile is picked (or this one is left
 * or deleted) nothing more is written for it: the store still holds its data until the next load,
 * and a late change must not put a deleted profile's file back.
 */
let loadedFor: string | null = null;
let lazyTimer: ReturnType<typeof setTimeout> | undefined;
let loadSeq = 0;
/** Watch keys marked watched by playback during this run: the mark is not repeated on every save. */
const finished = new Set<string>();
/** The position last queued for the tracker, by watch key: an unchanged one is not queued again. */
const queued = new Map<string, number>();

function snapshot(s: HistoryState): HistoryDoc {
  return { version: 1, progress: s.progress, watched: s.watched, library: s.library, dismissed: s.dismissed, cards: s.cards, outbox: s.outbox };
}

/** A stored document with anything missing or malformed replaced by empty. */
function readDoc(doc: Partial<HistoryDoc> | null | undefined): HistoryDoc {
  const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {});
  return { version: 1, progress: obj(doc?.progress), watched: obj(doc?.watched), library: obj(doc?.library), dismissed: obj(doc?.dismissed), cards: obj(doc?.cards), outbox: Array.isArray(doc?.outbox) ? doc.outbox : [] };
}

/** Without the keys whose value is undefined, so a spread does not blank what is already known. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const sameOp = (a: OutboxOp, b: OutboxOp) => a.op === b.op && a.key === b.key && a.at === b.at;
const listKey = (title: string) => `list:${title}`;

export const useHistory = create<HistoryState>((set, get) => {
  /** `lazy`: for position saves while playing, which can wait for the next periodic write. */
  const commit = (patch: Partial<HistoryDoc>, lazy = false) => {
    set(patch);
    if (!writable || useProfiles.getState().activeId !== loadedFor) return;
    if (lazy) {
      lazyTimer ??= setTimeout(() => {
        lazyTimer = undefined;
        if (writable && useProfiles.getState().activeId === loadedFor) writer.save(snapshot(get()));
      }, LAZY_SAVE_MS);
      return;
    }
    if (lazyTimer !== undefined) {
      clearTimeout(lazyTimer);
      lazyTimer = undefined;
    }
    writer.save(snapshot(get()));
  };

  return {
    ...empty(),
    loaded: false,
    readOnly: false,

    async load() {
      // The profile being left gets its pending changes first, in its own file.
      await flushHistory();
      const seq = ++loadSeq;
      writable = false;
      finished.clear();
      queued.clear();
      set({ ...empty(), loaded: false, readOnly: false });
      const profile = useProfiles.getState().activeId;
      const name = profileDoc('history', profile);
      let stored: Partial<HistoryDoc> | null = null;
      let unreadable = false;
      try {
        // A file that is missing reads as null; one that exists but cannot be read throws.
        stored = await docs.read<HistoryDoc>(name);
      } catch (e) {
        unreadable = true;
        console.error(`History (${name}) could not be read. Nothing is saved over it during this run.`, e);
      }
      await loadIdMap().catch(() => undefined);
      if (seq !== loadSeq) return;
      writer = debouncedWriter((v) => docs.write(name, v), 800);
      const doc = readDoc(stored);
      const moved = unreadable ? null : rekeyHistory(doc, canonicalNow);
      set({ ...(moved?.doc ?? doc), loaded: true, readOnly: unreadable });
      loadedFor = profile;
      writable = !unreadable;
      if (moved && writable) writer.save(snapshot(get()));
      if (unreadable) toast.error('Your watch history could not be read. It is left untouched: what you watch now is not saved until ROVE restarts and can read it.');
    },

    recordProgress(input, opts = {}) {
      const sync = opts.sync ?? true;
      const { durationS, positionS } = input;
      if (!(durationS > 0) || !Number.isFinite(positionS)) return 'ignored';
      const percent = (positionS / durationS) * 100;
      const metaId = canonicalNow(input.metaId, input.type);
      const key = watchKey(metaId, input.season, input.episode);
      const at = input.updatedAt ?? Date.now();
      const s = get();
      if (percent >= WATCHED_PERCENT) {
        const mark = s.watched[key];
        const lingering = s.progress[key];
        // Marked earlier in this viewing (or by a save moments ago, before a restart): once is enough.
        const sameViewing = !!mark && (finished.has(key) || (at >= mark.at && at - mark.at < durationS * 1000));
        if (sameViewing) {
          finished.add(key);
          // A seek back left a resume point behind: it goes again, without a second watched mark.
          if (lingering) {
            const progress = { ...s.progress };
            delete progress[key];
            let outbox = s.outbox.filter((o) => !(o.key === key && o.op === 'resume'));
            if (lingering.synced && !outbox.some((o) => o.key === key)) outbox = [...outbox, { op: 'clear-resume', key, metaId, type: lingering.type, season: lingering.season, episode: lingering.episode, tmdbId: lingering.tmdbId, at }];
            queued.delete(key);
            commit({ progress, outbox });
          }
          return 'watched';
        }
        const progress = { ...s.progress };
        delete progress[key];
        // A mark that was already there, from another day: the title is being watched again.
        const plays = mark ? (mark.plays ?? 1) + 1 : undefined;
        const entry: WatchedEntry = { key, metaId, type: input.type, season: input.season, episode: input.episode, at, tmdbId: input.tmdbId ?? mark?.tmdbId ?? tmdbTitleNumber(input.metaId) ?? undefined, ...(plays ? { plays } : {}) };
        const outbox = [...s.outbox.filter((o) => o.key !== key), { op: 'watched' as const, key, at }];
        finished.add(key);
        queued.delete(key);
        commit({ progress, watched: { ...s.watched, [key]: entry }, outbox });
        return 'watched';
      }
      if (percent < RESTART_PERCENT) finished.delete(key);
      if (percent < MIN_RESUME_PERCENT) return 'ignored';
      const previous = s.progress[key];
      const same = !!previous && !previous.estimated && Math.abs(previous.positionS - positionS) < 1 && Math.abs(previous.durationS - durationS) < 1;
      const sent = queued.get(key);
      const queue = sync && !(same && (s.outbox.some((o) => o.key === key && o.op === 'resume') || (sent !== undefined && Math.abs(sent - positionS) < 1)));
      // Nothing moved since the last save (paused, or a second save on the way out): no write.
      if (same && !queue) return 'saved';
      const patch: Partial<HistoryDoc> = {};
      if (!same) {
        // A position from the player is exact: a tracker's estimate does not outlive it.
        const entry: ProgressEntry = { ...previous, ...defined(input), metaId, type: input.type, positionS, durationS, key, updatedAt: at, synced: previous?.synced, estimated: input.estimated || undefined, tmdbId: input.tmdbId ?? previous?.tmdbId ?? tmdbTitleNumber(input.metaId) ?? undefined };
        patch.progress = { ...s.progress, [key]: entry };
      }
      if (queue) {
        patch.outbox = [...s.outbox.filter((o) => !(o.key === key && o.op === 'resume')), { op: 'resume' as const, key, at }];
        queued.set(key, positionS);
      }
      const title = titleKey(metaId, input.type);
      if (title in s.dismissed) {
        const dismissed = { ...s.dismissed };
        delete dismissed[title];
        patch.dismissed = dismissed;
      }
      commit(patch, !sync);
      return 'saved';
    },

    markWatched(items, at = Date.now()) {
      const watched = { ...get().watched };
      const progress = { ...get().progress };
      const outbox = [...get().outbox];
      let marked = 0;
      for (const it of items) {
        const metaId = canonicalNow(it.metaId, it.type);
        const key = watchKey(metaId, it.season, it.episode);
        const prev = watched[key];
        // Playback marked it a moment ago (past the threshold, then again at the credits or the
        // end), in this run or just before a restart: the mark and its date stand, and the
        // tracker is not sent a second play.
        if (prev && (finished.has(key) || (at >= prev.at && at - prev.at < REPEAT_GAP_MS))) continue;
        marked++;
        // Marking what is already marked is watching it again; callers that mark many at once
        // leave out the ones already watched.
        const plays = prev ? (prev.plays ?? 1) + 1 : undefined;
        watched[key] = { key, metaId, type: it.type, season: it.season, episode: it.episode, at, tmdbId: it.tmdbId ?? prev?.tmdbId ?? tmdbTitleNumber(it.metaId) ?? undefined, ...(plays ? { plays } : {}) };
        delete progress[key];
        queued.delete(key);
        outbox.push({ op: 'watched', key, at });
      }
      if (marked) commit({ watched, progress, outbox: dedupeOutbox(outbox) });
    },

    unmarkWatched(items) {
      const watched = { ...get().watched };
      const outbox = [...get().outbox];
      const at = Date.now();
      for (const it of items) {
        const metaId = canonicalNow(it.metaId, it.type);
        const key = watchKey(metaId, it.season, it.episode);
        const had = watched[key];
        delete watched[key];
        finished.delete(key);
        outbox.push({ op: 'unwatched', key, metaId, type: it.type, season: it.season, episode: it.episode, tmdbId: it.tmdbId ?? had?.tmdbId ?? tmdbTitleNumber(it.metaId) ?? undefined, at });
      }
      commit({ watched, outbox: dedupeOutbox(outbox) });
    },

    clearProgress(key) {
      const entry = get().progress[key];
      if (!entry) return;
      const progress = { ...get().progress };
      delete progress[key];
      queued.delete(key);
      const outbox = [...get().outbox, { op: 'clear-resume' as const, key, metaId: entry.metaId, type: entry.type, season: entry.season, episode: entry.episode, tmdbId: entry.tmdbId, at: Date.now() }];
      commit({ progress, outbox: dedupeOutbox(outbox) });
    },

    dismiss(metaId, type) {
      const key = type ? titleKey(canonicalNow(metaId, type), type) : metaId;
      commit({ dismissed: { ...get().dismissed, [key]: Date.now() } });
    },

    undismiss(metaId, type) {
      const key = type ? titleKey(canonicalNow(metaId, type), type) : metaId;
      if (!(key in get().dismissed)) return;
      const dismissed = { ...get().dismissed };
      delete dismissed[key];
      commit({ dismissed });
    },

    setLibrary(items) {
      commit({ library: items });
    },

    toggleLibrary(item) {
      const metaId = canonicalNow(item.metaId, item.type);
      const title = titleKey(metaId, item.type);
      const library = { ...get().library };
      const had = library[title];
      const at = Date.now();
      const tmdbId = item.tmdbId ?? had?.tmdbId ?? tmdbTitleNumber(item.metaId) ?? undefined;
      if (had) delete library[title];
      else library[title] = { ...defined(item), metaId, type: item.type, tmdbId, synced: undefined, addedAt: at };
      // The tracker hears about it through the outbox, so a change made offline is not lost.
      const op: ListOp = { op: had ? 'list-remove' : 'list-add', key: listKey(title), metaId, type: item.type, tmdbId, name: item.name ?? had?.name, at };
      commit({ library, outbox: dedupeOutbox([...get().outbox, op]) });
      return !had;
    },

    rememberCard(metaId, type, card) {
      const key = titleKey(canonicalNow(metaId, type), type);
      const prev = get().cards[key];
      const next = { ...prev, ...Object.fromEntries(Object.entries(card).filter(([, v]) => v)), type };
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
      commit({ cards: { ...get().cards, [key]: next } });
    },

    applyRemote(remote, pulledAt) {
      const s = get();
      const pendingKeys = new Set(s.outbox.map((o) => o.key));
      const partial = new Set(remote.incomplete ?? []);
      const outbox = [...s.outbox];

      const progress: Record<string, ProgressEntry> = {};
      // Local entries the tracker never had, or that changed since: keep. So is everything when
      // the tracker's list did not arrive whole: absence from it proves nothing.
      for (const [k, e] of Object.entries(s.progress)) {
        if (!e.synced || pendingKeys.has(k) || e.updatedAt > pulledAt || partial.has('progress')) progress[k] = e;
      }
      for (const given of remote.progress) {
        const r = underCanonicalId(given);
        const local = s.progress[r.key];
        // A change to this key made here and not sent yet stands (a newer position, or its removal).
        if (pendingKeys.has(r.key)) continue;
        if (local && !(local.estimated && !r.estimated) && (samePosition(local, r) || cappedEcho(local, r, remote.resumeCap))) {
          // The tracker has our position, rounded to a percentage or capped: the exact one stays.
          progress[r.key] = { ...local, tmdbId: local.tmdbId ?? r.tmdbId, synced: true };
          continue;
        }
        if (local && local.updatedAt > r.updatedAt) {
          // Watched further here than the tracker knows (saves while playing stay local for a
          // few minutes): keep ours and send it.
          progress[r.key] = local;
          outbox.push({ op: 'resume', key: r.key, at: Date.now() });
          continue;
        }
        progress[r.key] = { ...local, ...r, ...pickCard(local), estimated: r.estimated || undefined, synced: true };
      }

      const watched: Record<string, WatchedEntry> = {};
      for (const [k, w] of Object.entries(s.watched)) {
        if (!w.synced || pendingKeys.has(k) || w.at > pulledAt || partial.has('watched')) watched[k] = w;
      }
      const pendingMarks = new Set(s.outbox.filter((o) => o.op === 'unwatched' || o.op === 'watched').map((o) => o.key));
      // Some trackers list every play of a title, not one row per title: the dates seen per key.
      const dates = new Map<string, { first: number; last: number }>();
      for (const given of remote.watched) {
        const r = underCanonicalId(given);
        // A mark or unmark made here and not sent yet stands.
        if (pendingMarks.has(r.key)) continue;
        const seen = dates.get(r.key) ?? { first: Infinity, last: 0 };
        if (r.at > 0) {
          seen.first = Math.min(seen.first, r.at);
          seen.last = Math.max(seen.last, r.at);
        }
        dates.set(r.key, seen);
        const local = s.watched[r.key];
        // The latest date counts. A play well after another one (in the tracker's rows, or after
        // the mark known here) is the title being watched again, which Continue Watching needs
        // to know to offer the next episode of a rewatch.
        const at = seen.last || local?.at || 0;
        const again = seen.last - seen.first > REPEAT_GAP_MS || (!!local && local.at > 0 && seen.last - local.at > REPEAT_GAP_MS);
        const plays = Math.max(r.plays ?? 1, local?.plays ?? 1, again ? (local?.plays ?? 1) + 1 : 1);
        watched[r.key] = { ...r, at, synced: true, ...(plays > 1 ? { plays } : {}) };
        // A title watched elsewhere has no resume point any more.
        if (progress[r.key] && progress[r.key].updatedAt <= at) delete progress[r.key];
      }
      commit({ progress, watched, outbox: outbox.length === s.outbox.length ? s.outbox : dedupeOutbox(outbox) });
    },

    settleOutbox({ done = [], failed = [], synced = {} }) {
      const s = get();
      const outbox = s.outbox
        .filter((o) => !done.some((d) => sameOp(d, o)))
        .map((o) => (failed.some((f) => sameOp(f, o)) ? { ...o, tries: (o.tries ?? 0) + 1 } : o));
      const patch: Partial<HistoryDoc> = { outbox };
      const flag = <T extends { synced?: boolean }>(all: Record<string, T>, keys: string[] | undefined): Record<string, T> | undefined => {
        const hit = (keys ?? []).filter((k) => all[k] && !all[k].synced);
        if (!hit.length) return undefined;
        const next = { ...all };
        for (const k of hit) next[k] = { ...next[k], synced: true };
        return next;
      };
      const progress = flag(s.progress, synced.progress);
      const watched = flag(s.watched, synced.watched);
      const library = flag(s.library, synced.library);
      if (progress) patch.progress = progress;
      if (watched) patch.watched = watched;
      if (library) patch.library = library;
      commit(patch);
    },

    rekey() {
      const moved = rekeyHistory(snapshot(get()), canonicalNow);
      if (!moved) return false;
      for (const [from, to] of moved.keys) {
        if (finished.delete(from)) finished.add(to);
        const sent = queued.get(from);
        if (sent !== undefined) {
          queued.delete(from);
          queued.set(to, sent);
        }
      }
      commit(moved.doc);
      return true;
    },

    forgetTracker() {
      const s = get();
      const clear = <T extends { synced?: boolean }>(all: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.synced ? { ...v, synced: undefined } : v]));
      commit({ progress: clear(s.progress), watched: clear(s.watched), library: clear(s.library) });
    },

    clearAll() {
      finished.clear();
      queued.clear();
      commit(empty());
    },
  };
});

// A mapping learned anywhere (a pull, a title page, starting playback) moves the entries it
// concerns to their IMDb id shortly after. Several arrive together during a pull.
let rekeyTimer: ReturnType<typeof setTimeout> | undefined;
onIdMapChange(() => {
  rekeyTimer ??= setTimeout(() => {
    rekeyTimer = undefined;
    useHistory.getState().rekey();
  }, 250);
});

function pickCard(e?: ProgressEntry): Partial<ProgressEntry> {
  if (!e) return {};
  const { name, poster, background, logo, episodeTitle, still, videoId } = e;
  return Object.fromEntries(Object.entries({ name, poster, background, logo, episodeTitle, still, videoId }).filter(([, v]) => v !== undefined));
}

function samePosition(a: ProgressEntry, b: ProgressEntry) {
  if (!(a.durationS > 0) || !(b.durationS > 0)) return false;
  return Math.abs(a.positionS / a.durationS - b.positionS / b.durationS) <= SAME_POSITION_SHARE;
}

/** `r` is what a tracker that caps positions at `cap` gives back for `local`, which it was sent. */
function cappedEcho(local: ProgressEntry, r: ProgressEntry, cap: number | undefined) {
  if (cap === undefined || !local.synced || !(local.durationS > 0) || !(r.durationS > 0)) return false;
  return local.positionS / local.durationS > cap && Math.abs(r.positionS / r.durationS - cap) <= SAME_POSITION_SHARE;
}

/** A tracker's entry under the id history uses for its title. */
function underCanonicalId<T extends { key: string; metaId: string; type: MediaType; season?: number; episode?: number; tmdbId?: number }>(e: T): T {
  const metaId = canonicalNow(e.metaId, e.type);
  if (metaId === e.metaId) return e;
  return { ...e, metaId, key: watchKey(metaId, e.season, e.episode), tmdbId: e.tmdbId ?? tmdbTitleNumber(e.metaId) ?? undefined };
}

/** The title id and, for `tmdb:` ids, the type inside a title key (see addons/ids titleKey). */
function splitTitleKey(key: string): { metaId: string; type?: MediaType } {
  const m = /^(tmdb:\d+)@(movie|series)$/i.exec(key);
  return m ? { metaId: m[1], type: m[2] as MediaType } : { metaId: key };
}

/**
 * Moves everything kept under a `tmdb:` id to the id `canonical` gives for it (the IMDb id once
 * the mapping is known; the same id back while it is not, and the entry stays where it is).
 * Where both forms already hold an entry for the same thing, the newer one is kept. The TMDB
 * number stays on each entry, since trackers are sent that. Per-title records (watchlist, card
 * art, dismissals) are also put under their title key, which older files keyed by the bare id.
 * Returns null when nothing changes; otherwise the new document and the watch keys that moved.
 */
export function rekeyHistory(doc: HistoryDoc, canonical: (metaId: string, type: MediaType) => string): { doc: HistoryDoc; keys: Map<string, string> } | null {
  let changed = false;
  const keys = new Map<string, string>();
  const moveTo = (metaId: string, type: MediaType): string | null => {
    if (tmdbTitleNumber(metaId) === null) return null;
    const to = canonical(metaId, type);
    return to && to !== metaId ? to : null;
  };

  // Entries already under their final id go in first, so they win a tie with one moving in.
  const split = <T extends { metaId: string; type: MediaType }>(all: Record<string, T>) => {
    const stay: T[] = [];
    const move: [T, string][] = [];
    for (const e of Object.values(all)) {
      const to = moveTo(e.metaId, e.type);
      if (to) move.push([e, to]);
      else stay.push(e);
    }
    return { stay, move };
  };

  const progress: Record<string, ProgressEntry> = {};
  const p = split(doc.progress);
  for (const e of p.stay) progress[e.key] = e;
  for (const [e, to] of p.move) {
    const key = watchKey(to, e.season, e.episode);
    keys.set(e.key, key);
    const moved: ProgressEntry = { ...e, key, metaId: to, tmdbId: e.tmdbId ?? tmdbTitleNumber(e.metaId) ?? undefined };
    const there = progress[key];
    const [keep, drop] = !there || moved.updatedAt > there.updatedAt ? [moved, there] : [there, moved];
    progress[key] = { ...pickCard(drop), ...keep, tmdbId: keep.tmdbId ?? drop?.tmdbId };
    changed = true;
  }

  const watched: Record<string, WatchedEntry> = {};
  const w = split(doc.watched);
  for (const e of w.stay) watched[e.key] = e;
  for (const [e, to] of w.move) {
    const key = watchKey(to, e.season, e.episode);
    keys.set(e.key, key);
    const moved: WatchedEntry = { ...e, key, metaId: to, tmdbId: e.tmdbId ?? tmdbTitleNumber(e.metaId) ?? undefined };
    const there = watched[key];
    const [keep, drop] = !there || moved.at > there.at ? [moved, there] : [there, moved];
    const plays = Math.max(keep.plays ?? 1, drop?.plays ?? 1);
    watched[key] = { ...keep, tmdbId: keep.tmdbId ?? drop?.tmdbId, synced: keep.synced || drop?.synced || undefined, ...(plays > 1 ? { plays } : {}) };
    changed = true;
  }

  const library: Record<string, LibraryItem> = {};
  const libraryMoves: [string, LibraryItem][] = [];
  for (const [k, item] of Object.entries(doc.library)) {
    const to = moveTo(item.metaId, item.type);
    const key = titleKey(to ?? item.metaId, item.type);
    if (key === k) library[k] = item;
    else libraryMoves.push([key, to ? { ...item, metaId: to, tmdbId: item.tmdbId ?? tmdbTitleNumber(item.metaId) ?? undefined } : item]);
  }
  for (const [key, item] of libraryMoves) {
    const there = library[key];
    const [keep, drop] = !there || item.addedAt > there.addedAt ? [item, there] : [there, item];
    library[key] = { ...drop, ...keep, name: keep.name ?? drop?.name, poster: keep.poster ?? drop?.poster, synced: keep.synced || drop?.synced || undefined };
    changed = true;
  }

  const cards: HistoryDoc['cards'] = {};
  const cardMoves: [string, HistoryDoc['cards'][string]][] = [];
  for (const [k, card] of Object.entries(doc.cards)) {
    const { metaId } = splitTitleKey(k);
    const key = titleKey(moveTo(metaId, card.type) ?? metaId, card.type);
    if (key === k) cards[k] = card;
    else cardMoves.push([key, card]);
  }
  for (const [key, card] of cardMoves) {
    cards[key] = { ...defined(card), ...defined(cards[key] ?? {}), type: card.type };
    changed = true;
  }

  const dismissed: Record<string, number> = {};
  for (const [k, at] of Object.entries(doc.dismissed)) {
    const { metaId, type } = splitTitleKey(k);
    // A bare `tmdb:` key from an older file does not say which type it hid: every type in use.
    const types: MediaType[] = type ? [type] : tmdbTitleNumber(metaId) === null ? [] : typesOf(doc, metaId);
    const targets = types.length ? types.map((t) => titleKey(moveTo(metaId, t) ?? metaId, t)) : [k];
    for (const key of targets) {
      dismissed[key] = Math.max(dismissed[key] ?? 0, at);
      if (key !== k) changed = true;
    }
  }

  let outbox = doc.outbox;
  if (changed || doc.outbox.some((o) => 'metaId' in o && moveTo(o.metaId, o.type))) {
    outbox = dedupeOutbox(
      doc.outbox.map((o): OutboxOp => {
        if (!('metaId' in o)) return keys.has(o.key) ? { ...o, key: keys.get(o.key)! } : o;
        const to = moveTo(o.metaId, o.type);
        if (!to) return o;
        const tmdbId = o.tmdbId ?? tmdbTitleNumber(o.metaId) ?? undefined;
        if (isListOp(o)) return { ...o, metaId: to, tmdbId, key: listKey(titleKey(to, o.type)) };
        return { ...o, metaId: to, tmdbId, key: watchKey(to, o.season, o.episode) };
      }),
    );
    changed = true;
  }

  return changed ? { doc: { version: 1, progress, watched, library, dismissed, cards, outbox }, keys } : null;
}

/** The types (movie, series) a title id has entries under. */
function typesOf(doc: HistoryDoc, metaId: string): MediaType[] {
  const types = new Set<MediaType>();
  for (const e of Object.values(doc.progress)) if (e.metaId === metaId) types.add(e.type);
  for (const e of Object.values(doc.watched)) if (e.metaId === metaId) types.add(e.type);
  return [...types];
}

/** Titles still kept under a `tmdb:` id, each once: the ones whose IMDb id is worth asking for. */
export function unmappedTitles(doc: Pick<HistoryDoc, 'progress' | 'watched' | 'library'>): { metaId: string; type: MediaType }[] {
  const out = new Map<string, { metaId: string; type: MediaType }>();
  for (const all of [doc.progress, doc.watched, doc.library] as Record<string, { metaId: string; type: MediaType }>[]) {
    for (const e of Object.values(all)) {
      if (tmdbTitleNumber(e.metaId) !== null) out.set(titleKey(e.metaId, e.type), { metaId: e.metaId, type: e.type });
    }
  }
  return [...out.values()];
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

/** Writes anything pending now, including position saves still waiting for their periodic write. */
export function flushHistory() {
  if (lazyTimer !== undefined) {
    clearTimeout(lazyTimer);
    lazyTimer = undefined;
    if (writable) writer.save(snapshot(useHistory.getState()));
  }
  return writer.flush();
}

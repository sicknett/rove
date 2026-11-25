// Home's "For you" row: recommendations from what the profile watched. The assistant is asked at
// most once a day (and when the user picks Refresh); in between, the answer is read from a
// per-profile document, so opening Home never costs a request.

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { titleKey } from '../addons/ids';
import { docs } from '../lib/native';
import { hasTmdb } from '../meta/tmdb';
import { useHistory, type HistoryDoc, type MediaType } from '../state/history';
import { activeProfile, profileDoc, useProfiles } from '../state/profiles';
import { canonicalNow } from '../tracking/idmap';
import { assistantFor, assistantSettings, useAssistantSettings } from './index';
import { resolveSuggestions, type AiCard } from './resolve';
import { AiError, isAbort, type TasteTitle } from './types';

const DAY_MS = 24 * 3600 * 1000;
/** After a refresh that failed, Home waits this long before it asks again by itself. */
const RETRY_AFTER_FAILURE_MS = 3600 * 1000;
/** How much history the assistant is shown: enough to read a taste, small enough to stay cheap. */
const WATCHED_SHOWN = 40;
const WATCHLIST_SHOWN = 15;
/** With less than this to go on, recommendations would be guesses. */
const MIN_TITLES = 3;
/** A resume point this far in counts as watching the title, not as trying it. */
const ENGAGED_SHARE = 0.5;

export interface ForYouCache {
  version: 1;
  /** When the items were fetched; 0 when no refresh has succeeded yet. */
  at: number;
  /** When a refresh last failed, if that was after `at`. */
  failedAt?: number;
  items: AiCard[];
}

/**
 * Whether Home may ask the assistant by itself: when there is no answer yet, or the one there
 * is a day old. Not within the hour after a failure, so a broken key or an empty quota is not
 * hit again on every visit. A clock set back makes the answer look newer than now: that counts
 * as old.
 */
export function refreshDue(cache: Pick<ForYouCache, 'at' | 'failedAt'> | null, now: number): boolean {
  if (!cache) return true;
  if (cache.failedAt && now >= cache.failedAt && now - cache.failedAt < RETRY_AFTER_FAILURE_MS) return false;
  return !cache.at || now < cache.at || now - cache.at >= DAY_MS;
}

type History = Pick<HistoryDoc, 'progress' | 'watched' | 'library' | 'cards'>;

/**
 * What the assistant is told about a profile's taste: the titles watched most recently (finished,
 * or at least half way through), newest first, and the newest of the watchlist. Titles ROVE has
 * no name for are left out: an id means nothing to the assistant.
 */
export function tasteFrom(h: History): { watched: TasteTitle[]; watchlist: TasteTitle[] } {
  const seen = new Map<string, { type: MediaType; at: number; episodes: Set<string>; name?: string; year?: string }>();
  const note = (metaId: string, type: MediaType, at: number, season?: number, episode?: number, name?: string, year?: string) => {
    const key = titleKey(metaId, type);
    const entry = seen.get(key) ?? { type, at: 0, episodes: new Set<string>() };
    entry.at = Math.max(entry.at, at);
    if (season !== undefined && episode !== undefined) entry.episodes.add(`${season}:${episode}`);
    const card = h.cards[key];
    entry.name ??= card?.name ?? name ?? h.library[key]?.name;
    entry.year ??= card?.year ?? year ?? h.library[key]?.year;
    seen.set(key, entry);
  };
  for (const w of Object.values(h.watched)) note(w.metaId, w.type, w.at, w.season, w.episode);
  for (const p of Object.values(h.progress)) {
    if (p.durationS > 0 && p.positionS / p.durationS >= ENGAGED_SHARE) note(p.metaId, p.type, p.updatedAt, p.season, p.episode, p.name, p.year);
  }
  const title = (e: { type: MediaType; name?: string; year?: string; episodes?: Set<string> }): TasteTitle => ({
    name: e.name!,
    year: e.year?.slice(0, 4),
    type: e.type,
    episodes: e.type === 'series' && e.episodes?.size ? e.episodes.size : undefined,
  });
  const watched = [...seen.values()]
    .filter((e) => !!e.name)
    .sort((a, b) => b.at - a.at)
    .slice(0, WATCHED_SHOWN)
    .map(title);
  const watchlist = Object.entries(h.library)
    .filter(([key, item]) => !!item.name && !seen.has(key))
    .sort(([, a], [, b]) => b.addedAt - a.addedAt)
    .slice(0, WATCHLIST_SHOWN)
    .map(([, item]) => title(item));
  return { watched, watchlist };
}

/**
 * Every title the profile already has something on (watched, started, or on the watchlist), by
 * title key. The assistant only sees the newest part of the history, so what it recommends is
 * checked against all of it here.
 */
export function knownTitles(h: Pick<HistoryDoc, 'progress' | 'watched' | 'library'>): Set<string> {
  const keys = new Set<string>(Object.keys(h.library));
  for (const w of Object.values(h.watched)) keys.add(titleKey(w.metaId, w.type));
  for (const p of Object.values(h.progress)) keys.add(titleKey(p.metaId, p.type));
  return keys;
}

/** The history key of a card, from the id map as it is now (a `tmdb:` card may have learned its IMDb id). */
const cardKey = (c: AiCard) => titleKey(canonicalNow(c.metaId, c.type), c.type);

interface ForYouState {
  /** The profile the rest belongs to; null until one has loaded. */
  profileId: string | null;
  cache: ForYouCache | null;
  status: 'idle' | 'loading' | 'error';
  /** Why the last refresh failed, for the row. */
  error: string | null;
  /** Reads the profile's saved answer. Asks nobody. */
  load: (profileId: string) => Promise<void>;
  /**
   * Asks the assistant for a new list when one is due, or right away with `force` (the user
   * picked Refresh). Does nothing without a connected assistant, or with too little history.
   */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
}

let running: AbortController | null = null;

const readCache = (v: unknown): ForYouCache | null => {
  const c = v as Partial<ForYouCache> | null;
  if (!c || typeof c !== 'object' || !Array.isArray(c.items)) return null;
  return { version: 1, at: typeof c.at === 'number' ? c.at : 0, failedAt: typeof c.failedAt === 'number' ? c.failedAt : undefined, items: c.items.filter((i) => !!i && typeof i.metaId === 'string' && typeof i.name === 'string') };
};

/** Enough watched or planned to recommend from. */
export const enoughHistory = (taste: { watched: TasteTitle[]; watchlist: TasteTitle[] }) => taste.watched.length + taste.watchlist.length >= MIN_TITLES;

export const useForYou = create<ForYouState>((set, get) => ({
  profileId: null,
  cache: null,
  status: 'idle',
  error: null,

  async load(profileId) {
    if (get().profileId === profileId) return;
    running?.abort();
    running = null;
    set({ profileId: null, cache: null, status: 'idle', error: null });
    const cache = readCache(await docs.read(profileDoc('foryou', profileId)).catch(() => null));
    // Another profile was picked while this one was being read.
    if (useProfiles.getState().activeId !== profileId) return;
    set({ profileId, cache });
  },

  async refresh({ force = false } = {}) {
    const settings = assistantSettings();
    const profileId = get().profileId;
    if (!settings || !profileId || profileId !== useProfiles.getState().activeId) return;
    if (running && !force) return;
    if (!force && !refreshDue(get().cache, Date.now())) return;
    const history = useHistory.getState();
    if (!history.loaded) return;
    const taste = tasteFrom(history);
    if (!enoughHistory(taste)) return;
    // Without TMDB no suggestion can be turned into a title: said before the assistant is paid to answer.
    if (!hasTmdb()) return set({ status: 'error', error: 'Recommendations need a TMDB key to look titles up. Add one in Settings → Accounts.' });

    running?.abort();
    const run = new AbortController();
    running = run;
    set({ status: 'loading', error: null });
    const current = () => running === run && get().profileId === profileId;
    const save = (cache: ForYouCache) => docs.write(profileDoc('foryou', profileId), cache).catch((e) => console.error('for you: save failed', e));
    try {
      const suggestions = await assistantFor(settings).suggest({ kind: 'for-you', ...taste, kids: !!activeProfile()?.kids }, run.signal);
      const { cards, failed } = await resolveSuggestions(suggestions, run.signal);
      if (!current()) return;
      if (!cards.length) throw new AiError('bad-response', failed ? 'TMDB did not answer, so the recommendations could not be looked up.' : 'The assistant had no recommendations this time.');
      const known = knownTitles(useHistory.getState());
      const cache: ForYouCache = { version: 1, at: Date.now(), items: cards.filter((c) => !known.has(cardKey(c))) };
      set({ cache, status: 'idle', error: null });
      void save(cache);
    } catch (e) {
      if (!current()) return;
      if (isAbort(e)) return set({ status: 'idle' });
      // The answer already there stays on show; only the time of the failure is added to it.
      const cache: ForYouCache = { version: 1, at: get().cache?.at ?? 0, items: get().cache?.items ?? [], failedAt: Date.now() };
      set({ cache, status: 'error', error: e instanceof AiError ? e.message : 'The recommendations could not be refreshed.' });
      void save(cache);
    } finally {
      if (running === run) running = null;
    }
  },
}));

/**
 * The row's data for the active profile. `near` is whether the row has come near the screen:
 * until then nothing is asked for (the row may sit far down a long Home).
 */
export function useForYouRow(near: boolean) {
  const profileId = useProfiles((s) => s.activeId);
  const connected = !!useAssistantSettings();
  const historyLoaded = useHistory((s) => s.loaded);
  const watched = useHistory((s) => s.watched);
  const progress = useHistory((s) => s.progress);
  const library = useHistory((s) => s.library);
  const cards = useHistory((s) => s.cards);
  const state = useForYou();
  const ready = !!profileId && state.profileId === profileId;

  useEffect(() => {
    if (profileId) void useForYou.getState().load(profileId);
  }, [profileId]);

  useEffect(() => {
    if (near && ready && connected && historyLoaded) void useForYou.getState().refresh();
  }, [near, ready, connected, historyLoaded]);

  // A recommendation watched (or put on the watchlist) since it was made leaves the row.
  const items = useMemo(() => {
    const known = knownTitles({ watched, progress, library });
    return (ready ? state.cache?.items ?? [] : []).filter((c) => !known.has(cardKey(c)));
  }, [ready, state.cache, watched, progress, library]);

  const hasHistory = useMemo(() => enoughHistory(tasteFrom({ watched, progress, library, cards })), [watched, progress, library, cards]);

  /** A list has been fetched at some point (it may have emptied since, as its titles were watched). */
  const answered = ready && !!state.cache?.at;
  // A failure from an earlier run of the app, with nothing to show in its place: the reason was
  // not kept, but the row should not look as if it were still loading.
  const failedEarlier = ready && state.status === 'idle' && !answered && !!state.cache?.failedAt;
  const error = ready && state.status === 'error' ? state.error : failedEarlier ? 'Recommendations could not be fetched last time.' : null;

  return {
    items,
    loading: ready && state.status === 'loading',
    error,
    /** False while there is too little watched to recommend from. */
    hasHistory,
    answered,
    /** The first list has not been asked for yet (the row is not near the screen, or is about to ask). */
    waiting: ready && connected && hasHistory && !answered && !error,
    /** Still reading the saved answer: nothing to say yet. */
    pending: !ready || !historyLoaded,
    /** The user asking for a new list now. Resolves when the attempt is over, whichever way it went. */
    refresh: () => useForYou.getState().refresh({ force: true }),
  };
}

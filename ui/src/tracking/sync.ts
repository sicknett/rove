// Keeps a profile's local history in step with the tracker it chose (PublicMetaDB, Trakt, Simkl
// or MDBList). History is always kept locally; the tracker gets every change through the outbox,
// with retries and backoff, and its own history is pulled in every few minutes.

import { create } from 'zustand';
import { titleKey, tmdbTitleNumber } from '../addons/ids';
import { pool } from '../lib/http';
import { secrets } from '../lib/native';
import { profileDoc, useProfiles } from '../state/profiles';
import { isListOp, unmappedTitles, useHistory, type LibraryItem, type ListOp, type OutboxOp } from '../state/history';
import { adapterFor } from './adapters';
import { resetPmdbCaches } from './adapters/pmdb';
import { canonicalId, canonicalNow, setIdMapKey } from './idmap';
import { TrackerError, type PullResult, type PushResult, type TrackerAccount, type TrackerAdapter, type TrackerId, type WatchlistEntry } from './types';

export type SyncState = 'off' | 'idle' | 'syncing' | 'error' | 'unauthorized';

interface TrackerState {
  account: TrackerAccount | null;
  /** The PublicMetaDB key when PublicMetaDB is the tracker (it also feeds id mapping and skip times). */
  apiKey: string | null;
  state: SyncState;
  message: string | null;
  lastSyncAt: number | null;
  counts: { resume: number; watched: number } | null;
  load: () => Promise<void>;
  /** Saves a signed-in account (checked by the caller) and syncs. */
  setAccount: (account: TrackerAccount) => Promise<void>;
  disconnect: () => Promise<void>;
}

const DOC = () => profileDoc('tracker');

let running: Promise<void> | null = null;
/** A sync asked for while one was running: it runs right after (a full one wins over a push). */
let again: 'full' | 'push' | null = null;
let pushTimer: number | undefined;
let pullTimer: number | undefined;
let backoffMs = 0;
/**
 * Counts up whenever the profile or its tracker account changes. A sync started before the
 * change checks it after every wait and stops, so it never writes one profile's (or one
 * account's) data into another.
 */
let generation = 0;
const PULL_EVERY_MS = 10 * 60 * 1000;
/** After this many failed sends, with the tracker otherwise answering, a change is given up on. */
const MAX_TRIES = 6;
/** A list this long that the tracker suddenly reports as empty is taken as a bad answer, not as cleared. */
const SUSPICIOUS_EMPTY = 10;

/** A different profile, account or no account from here on: what was running or waiting is void. */
function changedAccount(apiKey: string | null) {
  generation++;
  backoffMs = 0;
  again = null;
  window.clearTimeout(pushTimer);
  resetPmdbCaches();
  setIdMapKey(apiKey);
}

/** What tells two accounts of one tracker apart, when anything does. */
const identity = (a: TrackerAccount) => a.apiKey ?? a.username ?? null;

export const useTracker = create<TrackerState>((set, get) => ({
  account: null,
  apiKey: null,
  state: 'off',
  message: null,
  lastSyncAt: null,
  counts: null,

  async load() {
    let account = await secrets.read<TrackerAccount>(DOC()).catch(() => null);
    if (!account) {
      // Profiles from before tracker choice kept a PublicMetaDB key on its own.
      const old = await secrets.read<{ apiKey?: string }>(profileDoc('pmdb')).catch(() => null);
      if (old?.apiKey) {
        account = { provider: 'pmdb', apiKey: old.apiKey };
        await secrets.write(DOC(), account);
        await secrets.remove(profileDoc('pmdb'));
      }
    }
    const apiKey = account?.provider === 'pmdb' ? account.apiKey ?? null : null;
    changedAccount(apiKey);
    set({ account, apiKey, state: account ? 'idle' : 'off', message: null, counts: null, lastSyncAt: null });
  },

  async setAccount(account) {
    const before = get().account;
    await secrets.write(DOC(), account);
    // "Synced" means "this account has it". Another account (or tracker) has none of it, and its
    // first pull must not take what it lacks for removed.
    const sameAccount = !!before && before.provider === account.provider && identity(before) !== null && identity(before) === identity(account);
    if (!sameAccount) useHistory.getState().forgetTracker();
    const apiKey = account.provider === 'pmdb' ? account.apiKey ?? null : null;
    changedAccount(apiKey);
    set({ account, apiKey, state: 'idle', message: null, counts: null });
    void syncNow();
  },

  async disconnect() {
    await secrets.remove(DOC());
    useHistory.getState().forgetTracker();
    changedAccount(null);
    set({ account: null, apiKey: null, state: 'off', message: null, counts: null, lastSyncAt: null });
  },
}));

export function trackerName(id: TrackerId | undefined) {
  return id ? adapterFor(id).name : 'No tracker';
}

/**
 * The account with a token that still works. Tokens are renewed in their last hour (Trakt's now
 * last a day, so "a day ahead" would renew on every sync and burn through refresh tokens).
 */
async function freshAccount(stale: () => boolean): Promise<TrackerAccount | null> {
  const account = useTracker.getState().account;
  if (!account) return null;
  const adapter = adapterFor(account.provider);
  if (!adapter.refresh || !account.expiresAt || account.expiresAt - Date.now() > 3600 * 1000) return account;
  const expired = account.expiresAt <= Date.now();
  try {
    const renewed = await adapter.refresh(account);
    if (stale()) return null;
    await secrets.write(DOC(), renewed);
    useTracker.setState({ account: renewed });
    return renewed;
  } catch (e) {
    // The current token is good for a while yet: carry on with it and renew next time.
    if (!expired) return account;
    // The tracker refused the refresh token (revoked, or already used): only signing in again helps.
    if (e instanceof TrackerError && e.kind === 'rejected') throw new TrackerError('unauthorized', `${adapter.name} did not renew the sign-in.`, e.status);
    throw e;
  }
}

interface PushReport {
  sent: number;
  /** Not sent, worth another try. */
  failed: OutboxOp[];
  /** Could not be matched to a title on the tracker (no id mapping yet). */
  unmatched: OutboxOp[];
  /** Refused by the tracker and dropped. */
  refused: number;
  /** The tracker could not be reached (or asked to slow down), so the rest was not attempted. */
  stopped: boolean;
}

/** A watchlist add or removal, through the adapter's watchlist calls. */
async function pushListOp(adapter: TrackerAdapter, account: TrackerAccount, op: ListOp): Promise<PushResult> {
  const call = op.op === 'list-add' ? adapter.watchlistAdd : adapter.watchlistRemove;
  if (!call) return 'skip';
  const result = await call.call(adapter, account, { metaId: op.metaId, type: op.type, tmdbId: op.tmdbId, name: op.name });
  return result ?? 'synced';
}

/**
 * Sends the outbox, one change at a time. A change leaves the outbox only once the tracker has
 * it (or refused it), so closing the app in the middle loses nothing. One that fails stays for
 * the next run and does not hold up the others; when the tracker cannot be reached at all the
 * rest is not attempted.
 */
async function pushOutbox(account: TrackerAccount, stale: () => boolean): Promise<PushReport> {
  const adapter = adapterFor(account.provider);
  const report: PushReport = { sent: 0, failed: [], unmatched: [], refused: 0, stopped: false };
  const sig = (o: OutboxOp) => `${o.op}|${o.key}|${o.at}`;
  for (const op of useHistory.getState().outbox) {
    if (stale()) return report;
    const h = useHistory.getState();
    // Replaced by a newer change to the same key since this run began: that one goes next run.
    if (!h.outbox.some((o) => sig(o) === sig(op))) continue;
    try {
      const result = isListOp(op) ? await pushListOp(adapter, account, op) : await adapter.push(account, op, { progress: h.progress, watched: h.watched });
      if (stale()) return report;
      if (result === 'unmapped') {
        report.unmatched.push(op);
        continue;
      }
      const synced = result !== 'synced' ? undefined : op.op === 'resume' ? { progress: [op.key] } : op.op === 'watched' ? { watched: [op.key] } : op.op === 'list-add' ? { library: [op.key.slice('list:'.length)] } : undefined;
      useHistory.getState().settleOutbox({ done: [op], synced });
      report.sent++;
    } catch (e) {
      if (stale()) return report;
      if (e instanceof TrackerError && e.kind === 'unauthorized') throw e;
      if (e instanceof TrackerError && e.kind === 'rejected') {
        console.warn(`${adapter.name} refused a change; dropping it`, op.op, op.key, e.status);
        useHistory.getState().settleOutbox({ done: [op] });
        report.refused++;
        continue;
      }
      // No answer at all (offline, or told to slow down): the rest would fare no better.
      if (!(e instanceof TrackerError) || e.status === undefined || e.status === 429) {
        report.stopped = true;
        break;
      }
      report.failed.push(op);
    }
  }
  return report;
}

/**
 * The tracker's watchlist merged into the local one. Local-only additions stay, a removal not
 * sent yet stays removed, and a title this tracker had before but no longer lists was removed
 * there (only believed when its whole list arrived).
 */
function mergeWatchlist(items: WatchlistEntry[], complete: boolean) {
  const h = useHistory.getState();
  const local = h.library;
  const pending = new Map(h.outbox.filter(isListOp).map((o) => [o.key, o.op]));
  const next: Record<string, LibraryItem> = {};
  for (const it of items) {
    if (!it.metaId) continue;
    const metaId = canonicalNow(it.metaId, it.type);
    const key = titleKey(metaId, it.type);
    if (pending.get(`list:${key}`) === 'list-remove') continue;
    const prev = local[key];
    // What is known here (art, the year, when it was added) stays; the tracker fills the gaps.
    next[key] = {
      ...it,
      ...prev,
      metaId,
      name: prev?.name ?? it.name,
      poster: prev?.poster ?? it.poster,
      tmdbId: prev?.tmdbId ?? it.tmdbId ?? tmdbTitleNumber(it.metaId) ?? undefined,
      addedAt: prev?.addedAt ?? it.addedAt ?? Date.now(),
      synced: true,
    };
  }
  const listed = Object.keys(next).length;
  const hadSynced = Object.values(local).filter((i) => i.synced).length;
  const believeAbsence = complete && !(listed === 0 && hadSynced >= SUSPICIOUS_EMPTY);
  for (const [key, item] of Object.entries(local)) {
    if (key in next) continue;
    const removedThere = believeAbsence && item.synced && !pending.has(`list:${key}`);
    if (!removedThere) next[key] = item;
  }
  // Most pulls change nothing: no write, and no re-render of every card, for those.
  const same = Object.keys(next).length === Object.keys(local).length && Object.entries(next).every(([k, v]) => local[k] && JSON.stringify(local[k]) === JSON.stringify(v));
  if (!same) h.setLibrary(next);
}

/** A pull with the parts that look wrong marked incomplete, so nothing local is removed on their word. */
function guarded(remote: PullResult): PullResult {
  const h = useHistory.getState();
  const incomplete = new Set(remote.incomplete ?? []);
  const synced = (all: Record<string, { synced?: boolean }>) => Object.values(all).filter((e) => e.synced).length;
  if (remote.watched.length === 0 && synced(h.watched) >= SUSPICIOUS_EMPTY) incomplete.add('watched');
  if (remote.progress.length === 0 && synced(h.progress) >= SUSPICIOUS_EMPTY) incomplete.add('progress');
  return incomplete.size ? { ...remote, incomplete: [...incomplete] } : remote;
}

let resolving = false;

/**
 * Asks for the IMDb id of every title still kept under a `tmdb:` id, a few at a time, in the
 * background. Each answer moves that title's entries over (the history store listens to the id
 * map). A title that gets no answer stays exactly as it is and is asked about again later.
 */
export async function resolveHistoryIds(): Promise<void> {
  if (resolving) return;
  resolving = true;
  const gen = generation;
  try {
    const titles = unmappedTitles(useHistory.getState());
    await pool(titles, 4, async (t) => {
      if (gen === generation) await canonicalId(t.metaId, t.type);
    });
    if (gen === generation) useHistory.getState().rekey();
  } catch (e) {
    console.warn('id lookup for history failed', e);
  } finally {
    resolving = false;
  }
}

async function run(kind: 'full' | 'push') {
  const gen = generation;
  const profile = useProfiles.getState().activeId;
  // The profile id changes the moment another profile is picked, before its data has loaded.
  const stale = () => gen !== generation || profile !== useProfiles.getState().activeId;
  const first = useTracker.getState().account;
  if (!first) return;
  const name = trackerName(first.provider);
  useTracker.setState({ state: 'syncing', message: null });
  try {
    const account = await freshAccount(stale);
    if (!account || stale()) return;
    const report = await pushOutbox(account, stale);
    if (stale()) return;
    // The pull goes ahead whatever the push did: one change that keeps failing must not stop
    // everything the tracker has from arriving.
    let pulled = false;
    if (kind === 'full') {
      const pulledAt = Date.now();
      const remote = guarded(await adapterFor(account.provider).pull(account));
      if (stale()) return;
      const h = useHistory.getState();
      // The pull has just looked up the IMDb id of every title: local entries move there first,
      // so both sides meet under the same key.
      h.rekey();
      h.applyRemote(remote, pulledAt);
      if (remote.watchlist) mergeWatchlist(remote.watchlist, !remote.incomplete?.includes('watchlist'));
      useTracker.setState({ counts: remote.counts });
      pulled = true;
      void resolveHistoryIds();
    }
    // The tracker answered (a pull, or another change went through), so what failed is about the
    // change itself: count the try, and give up on a change that has used all of them.
    let spent: OutboxOp[] = [];
    if (pulled || report.sent > 0) {
      const tried = [...report.failed, ...report.unmatched];
      spent = tried.filter((o) => (o.tries ?? 0) + 1 >= MAX_TRIES);
      if (spent.length) console.warn(`${name}: giving up on ${spent.length} change(s) that could not be sent`, spent.map((o) => `${o.op} ${o.key}`));
      useHistory.getState().settleOutbox({ failed: tried.filter((o) => !spent.includes(o)), done: spent });
    }
    const waiting = report.failed.filter((o) => !spent.includes(o)).length;
    if (report.stopped) throw new TrackerError('retry', `Changes are waiting to be sent to ${name}.`);
    if (waiting > 0) throw new TrackerError('retry', `${waiting} change(s) could not be sent to ${name}.`);
    backoffMs = 0;
    const notes = [
      report.unmatched.length ? `${report.unmatched.length} change(s) could not be matched to a title on ${name} and were not sent.` : null,
      report.refused ? `${name} refused ${report.refused} change(s).` : null,
    ].filter(Boolean);
    useTracker.setState({ state: 'idle', lastSyncAt: Date.now(), message: notes.length ? notes.join(' ') : null });
  } catch (e) {
    if (stale()) return;
    if (e instanceof TrackerError && e.kind === 'unauthorized') {
      useTracker.setState({ state: 'unauthorized', message: `${name} no longer accepts this sign-in. Connect again in Settings → Accounts.` });
      return;
    }
    const wait = e instanceof TrackerError && e.retryAt ? Math.max(30000, e.retryAt - Date.now()) : 0;
    backoffMs = Math.min(Math.max(wait, backoffMs ? backoffMs * 2 : 30000), 15 * 60 * 1000);
    const message = e instanceof TrackerError ? e.message : `Could not reach ${name}.`;
    useTracker.setState({ state: 'error', message: `${message} Retrying in ${Math.round(backoffMs / 1000)} s.` });
    window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => void syncNow(), backoffMs);
  }
}

/**
 * Pull and push now. While a run is going the request is noted and runs right after it, so
 * "Sync now" during a push still pulls, and a change made mid-run is not left waiting.
 */
export function syncNow(kind: 'full' | 'push' = 'full'): Promise<void> {
  if (running) {
    if (kind === 'full' || !again) again = kind;
    return running;
  }
  running = run(kind).finally(() => {
    running = null;
    const next = again;
    again = null;
    if (next && useTracker.getState().account) void syncNow(next);
  });
  return running;
}

/** Starts background sync for the active profile; returns a stop function. */
export function startSync(): () => void {
  const sig = (o: OutboxOp) => `${o.op}|${o.key}|${o.at}`;
  let seen = new Set(useHistory.getState().outbox.map(sig));
  const unsub = useHistory.subscribe((s, prev) => {
    if (s.outbox === prev.outbox) return;
    // Only a new change starts a push. Changes leaving the outbox as they are sent do not.
    const fresh = s.outbox.some((o) => !seen.has(sig(o)));
    seen = new Set(s.outbox.map(sig));
    if (fresh && useTracker.getState().account) {
      window.clearTimeout(pushTimer);
      pushTimer = window.setTimeout(() => void syncNow('push'), 4000);
    }
  });
  // History written before every title had one id: look the rest up now, without holding anything up.
  void resolveHistoryIds();
  const tick = () => {
    if (useTracker.getState().account && document.visibilityState !== 'hidden') void syncNow('full');
  };
  pullTimer = window.setInterval(tick, PULL_EVERY_MS);
  const firstTick = window.setTimeout(tick, 1500);
  const onFocus = () => {
    const last = useTracker.getState().lastSyncAt ?? 0;
    if (Date.now() - last > 3 * 60 * 1000) tick();
  };
  window.addEventListener('focus', onFocus);
  return () => {
    unsub();
    window.clearInterval(pullTimer);
    window.clearTimeout(pushTimer);
    window.clearTimeout(firstTick);
    window.removeEventListener('focus', onFocus);
  };
}

/** Which profile the tracker state belongs to, for screens that show it. */
export function trackerProfileId() {
  return useProfiles.getState().activeId;
}

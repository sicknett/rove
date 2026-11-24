// Keeps a profile's local history in step with the tracker it chose (PublicMetaDB, Trakt, Simkl
// or MDBList). History is always kept locally; the tracker gets every change through the outbox,
// with retries and backoff, and its own history is pulled in every few minutes.

import { create } from 'zustand';
import { secrets } from '../lib/native';
import { profileDoc, useProfiles } from '../state/profiles';
import { useHistory, type LibraryItem, type OutboxOp } from '../state/history';
import { adapterFor } from './adapters';
import { resetPmdbCaches } from './adapters/pmdb';
import { TrackerError, type TrackerAccount, type TrackerId, type WatchlistEntry } from './types';

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

export const useTracker = create<TrackerState>((set) => ({
  account: null,
  apiKey: null,
  state: 'off',
  message: null,
  lastSyncAt: null,
  counts: null,

  async load() {
    resetPmdbCaches();
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
    set({ account, apiKey: account?.provider === 'pmdb' ? account.apiKey ?? null : null, state: account ? 'idle' : 'off', message: null, counts: null, lastSyncAt: null });
  },

  async setAccount(account) {
    await secrets.write(DOC(), account);
    resetPmdbCaches();
    set({ account, apiKey: account.provider === 'pmdb' ? account.apiKey ?? null : null, state: 'idle', message: null, counts: null });
    void syncNow();
  },

  async disconnect() {
    await secrets.remove(DOC());
    resetPmdbCaches();
    set({ account: null, apiKey: null, state: 'off', message: null, counts: null, lastSyncAt: null });
  },
}));

export function trackerName(id: TrackerId | undefined) {
  return id ? adapterFor(id).name : 'No tracker';
}

let running: Promise<void> | null = null;
let pushTimer: number | undefined;
let pullTimer: number | undefined;
let backoffMs = 0;
const PULL_EVERY_MS = 10 * 60 * 1000;

/** A token that expires within a day is renewed first. */
async function freshAccount(): Promise<TrackerAccount | null> {
  const account = useTracker.getState().account;
  if (!account) return null;
  const adapter = adapterFor(account.provider);
  if (adapter.refresh && account.expiresAt && account.expiresAt - Date.now() < 24 * 3600 * 1000) {
    const renewed = await adapter.refresh(account);
    await secrets.write(DOC(), renewed);
    useTracker.setState({ account: renewed });
    return renewed;
  }
  return account;
}

async function pushOutbox(account: TrackerAccount) {
  const adapter = adapterFor(account.provider);
  const ops = useHistory.getState().takeOutbox();
  if (!ops.length) return;
  const failed: OutboxOp[] = [];
  const synced = { progress: [] as string[], watched: [] as string[] };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      const s = useHistory.getState();
      const result = await adapter.push(account, op, { progress: s.progress, watched: s.watched });
      if (result === 'synced') {
        if (op.op === 'resume') synced.progress.push(op.key);
        if (op.op === 'watched') synced.watched.push(op.key);
      }
    } catch (e) {
      if (e instanceof TrackerError && e.kind === 'unauthorized') {
        useHistory.getState().requeue(ops.slice(i));
        throw e;
      }
      if (e instanceof TrackerError && e.kind === 'rejected') {
        console.warn(`${adapter.name} refused a change; dropping it`, op.op, e.status);
        continue;
      }
      failed.push(op);
    }
  }
  useHistory.getState().markSynced(synced);
  if (failed.length) {
    useHistory.getState().requeue(failed);
    throw new TrackerError('retry', `${failed.length} change(s) could not be sent to ${adapter.name}.`);
  }
}

/** The tracker's watchlist merged into the local one (local-only additions stay). */
function mergeWatchlist(items: WatchlistEntry[]) {
  const local = useHistory.getState().library;
  const next: Record<string, LibraryItem> = { ...local };
  for (const it of items) {
    if (!it.metaId) continue;
    const prev = local[it.metaId];
    next[it.metaId] = { ...prev, ...it, name: prev?.name ?? it.name, poster: prev?.poster ?? it.poster, addedAt: prev?.addedAt ?? it.addedAt ?? Date.now() };
  }
  useHistory.getState().setLibrary(next);
}

async function run(kind: 'full' | 'push') {
  if (!useTracker.getState().account) return;
  const name = trackerName(useTracker.getState().account?.provider);
  useTracker.setState({ state: 'syncing', message: null });
  try {
    const account = await freshAccount();
    if (!account) return;
    await pushOutbox(account);
    if (kind === 'full') {
      const pulledAt = Date.now();
      const remote = await adapterFor(account.provider).pull(account);
      useHistory.getState().applyRemote(remote, pulledAt);
      if (remote.watchlist) mergeWatchlist(remote.watchlist);
      useTracker.setState({ counts: remote.counts });
    }
    backoffMs = 0;
    useTracker.setState({ state: 'idle', lastSyncAt: Date.now(), message: null });
  } catch (e) {
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

/** Pull and push now (or join the run already going). */
export function syncNow(kind: 'full' | 'push' = 'full'): Promise<void> {
  if (running) return running;
  running = run(kind).finally(() => {
    running = null;
  });
  return running;
}

/** Starts background sync for the active profile; returns a stop function. */
export function startSync(): () => void {
  let lastOutbox = useHistory.getState().outbox.length;
  const unsub = useHistory.subscribe((s) => {
    if (s.outbox.length > 0 && s.outbox.length !== lastOutbox && useTracker.getState().account) {
      window.clearTimeout(pushTimer);
      pushTimer = window.setTimeout(() => void syncNow('push'), 4000);
    }
    lastOutbox = s.outbox.length;
  });
  const tick = () => {
    if (useTracker.getState().account && document.visibilityState !== 'hidden') void syncNow('full');
  };
  pullTimer = window.setInterval(tick, PULL_EVERY_MS);
  window.setTimeout(tick, 1500);
  const onFocus = () => {
    const last = useTracker.getState().lastSyncAt ?? 0;
    if (Date.now() - last > 3 * 60 * 1000) tick();
  };
  window.addEventListener('focus', onFocus);
  return () => {
    unsub();
    window.clearInterval(pullTimer);
    window.clearTimeout(pushTimer);
    window.removeEventListener('focus', onFocus);
  };
}

/** Which profile the tracker state belongs to, for screens that show it. */
export function trackerProfileId() {
  return useProfiles.getState().activeId;
}

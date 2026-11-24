// What every tracker (PublicMetaDB, Trakt, Simkl, MDBList) provides to the sync engine.

import type { LibraryItem, MediaType, OutboxOp, ProgressEntry, WatchedEntry } from '../state/history';

export type TrackerId = 'pmdb' | 'trakt' | 'simkl' | 'mdblist';

/** Stored encrypted per profile. Only the fields a tracker needs are set. */
export interface TrackerAccount {
  provider: TrackerId;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  username?: string;
}

export type TrackerErrorKind = 'unauthorized' | 'retry' | 'rejected';

export class TrackerError extends Error {
  constructor(
    readonly kind: TrackerErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

export type WatchlistEntry = Omit<LibraryItem, 'addedAt'> & { addedAt?: number };

export interface PullResult {
  progress: ProgressEntry[];
  watched: WatchedEntry[];
  /** When the tracker has a watchlist, its items (merged into the local one). */
  watchlist?: WatchlistEntry[];
  counts: { resume: number; watched: number };
}

export interface HistoryView {
  progress: Record<string, ProgressEntry>;
  watched: Record<string, WatchedEntry>;
}

export interface TitleRef {
  metaId: string;
  type: MediaType;
  tmdbId?: number;
  name?: string;
}

export interface TrackerAdapter {
  id: TrackerId;
  name: string;
  /** Everything the tracker knows, mapped onto ROVE's ids. */
  pull(account: TrackerAccount): Promise<PullResult>;
  /** Sends one local change. 'skip' when it does not apply (e.g. nothing to delete). Throws TrackerError. */
  push(account: TrackerAccount, op: OutboxOp, history: HistoryView): Promise<'synced' | 'skip'>;
  watchlistAdd?(account: TrackerAccount, title: TitleRef): Promise<void>;
  watchlistRemove?(account: TrackerAccount, title: TitleRef): Promise<void>;
  /** Renews an expiring token; returns the updated account. */
  refresh?(account: TrackerAccount): Promise<TrackerAccount>;
}

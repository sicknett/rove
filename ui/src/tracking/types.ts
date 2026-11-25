// What every tracker (PublicMetaDB, Trakt, Simkl, MDBList) provides to the sync engine.

import type { HistoryOp, LibraryItem, MediaType, ProgressEntry, WatchedEntry } from '../state/history';

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
  /** When the tracker has a watchlist and it could be read, its items (merged into the local one). */
  watchlist?: WatchlistEntry[];
  counts: { resume: number; watched: number };
  /**
   * Parts that failed or were cut short. What they do list is still merged in, but nothing local
   * is removed for being absent from them: a bad answer must not read as "deleted elsewhere".
   */
  incomplete?: ('progress' | 'watched' | 'watchlist')[];
  /**
   * Set by trackers whose resume points are sent capped at this share of the title (0..1): a
   * pulled position sitting at the cap can stand for a local one further along.
   */
  resumeCap?: number;
}

/**
 * What became of one change: sent; nothing to send (`skip`, e.g. nothing to delete, or a title
 * the tracker cannot hold); or `unmapped`, the title has no id the tracker knows yet, which may
 * change, so the change is kept and tried again.
 */
export type PushResult = 'synced' | 'skip' | 'unmapped';

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
  /** Sends one local change to progress or watched marks. Throws TrackerError. */
  push(account: TrackerAccount, op: HistoryOp, history: HistoryView): Promise<PushResult>;
  /** Watchlist changes; resolving with nothing means sent. */
  watchlistAdd?(account: TrackerAccount, title: TitleRef): Promise<PushResult | void>;
  watchlistRemove?(account: TrackerAccount, title: TitleRef): Promise<PushResult | void>;
  /** Renews an expiring token; returns the updated account. */
  refresh?(account: TrackerAccount): Promise<TrackerAccount>;
}

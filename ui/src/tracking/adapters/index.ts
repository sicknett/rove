// Every tracker ROVE can sync with.

import type { TrackerAdapter, TrackerId } from '../types';
import { mdblistAdapter } from './mdblist';
import { pmdbAdapter } from './pmdb';
import { SIMKL_CLIENT_ID, simklAdapter } from './simkl';
import { TRAKT_CLIENT_ID, traktAdapter } from './trakt';

const ADAPTERS: Record<TrackerId, TrackerAdapter | undefined> = {
  pmdb: pmdbAdapter,
  trakt: traktAdapter,
  simkl: simklAdapter,
  mdblist: mdblistAdapter,
};

export const TRACKER_IDS: TrackerId[] = ['pmdb', 'trakt', 'simkl', 'mdblist'];

export function adapterFor(id: TrackerId): TrackerAdapter {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`Tracker ${id} is not available`);
  return a;
}

export function registerAdapter(a: TrackerAdapter) {
  ADAPTERS[a.id] = a;
}

/** Whether this build can sign in to the tracker (Trakt and Simkl need ROVE's app ids). */
export function trackerAvailable(id: TrackerId): boolean {
  if (id === 'trakt') return !!TRAKT_CLIENT_ID;
  if (id === 'simkl') return !!SIMKL_CLIENT_ID;
  return !!ADAPTERS[id];
}

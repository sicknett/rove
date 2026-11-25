// What is in effect right now, in a line per section: which tracker is connected and when it
// last synced, how many addons there are and whether any failed, which assistant, whether an
// update is waiting. Shown under a section's heading, and as a dot beside its name when
// something there needs attention.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useAddons } from '../../addons/store';
import { assistantName } from '../../ai';
import { useUpdate } from '../../lib/update';
import { useServers } from '../../servers/store';
import { BUILT_IN_TMDB_KEY, useKeys } from '../../state/keys';
import { useProfiles } from '../../state/profiles';
import { trackerName, useTracker } from '../../tracking/sync';
import type { SectionId } from './catalog';
import { ago, count } from './format';

export interface SectionStatus {
  text: string;
  /** Something here wants the user: the reason, said aloud beside the section's name. */
  attention?: string;
}

/** How the last "Refresh all" went, kept while the app runs so the page can still say so later. */
export const useAddonRefresh = create<{ failed: string[]; at: number | null; report: (failed: string[]) => void }>((set) => ({
  failed: [],
  at: null,
  report: (failed) => set({ failed, at: Date.now() }),
}));

/** ", 2 switched off", ", all switched off", or for the only one there is, ", switched off". */
const switchedOff = (off: number, of: number) => (!off ? '' : off < of ? `, ${off} switched off` : of === 1 ? ', switched off' : ', all switched off');

/** Re-renders now and then, so "12 min ago" does not stand still. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

export function useSectionStatuses(): Partial<Record<SectionId, SectionStatus>> {
  const now = useNow(30000);
  const tracker = useTracker();
  const ai = useKeys((s) => s.ai);
  const ownTmdbKey = useKeys((s) => !!s.tmdbApiKey);
  const addons = useAddons((s) => s.addons);
  const addonsUnreadable = useAddons((s) => s.loadFailed);
  const refresh = useAddonRefresh();
  const servers = useServers((s) => s.servers);
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const update = useUpdate();

  const out: Partial<Record<SectionId, SectionStatus>> = {};

  // Accounts: the tracker, the assistant, the TMDB key.
  {
    const name = trackerName(tracker.account?.provider);
    let attention: string | undefined;
    let tracking: string;
    if (!tracker.account) tracking = 'No tracker connected';
    else if (tracker.state === 'unauthorized') {
      tracking = `${name} no longer accepts the sign-in`;
      attention = tracking;
    } else if (tracker.state === 'syncing') tracking = `${name} is syncing`;
    else if (tracker.state === 'error') tracking = `${name} could not be reached, trying again`;
    else tracking = `${name}${tracker.account.username ? ` as ${tracker.account.username}` : ''}, ${tracker.lastSyncAt ? `synced ${ago(tracker.lastSyncAt, now)}` : 'not synced yet'}`;
    const assistant = ai ? `${assistantName(ai)} assistant` : 'no AI assistant';
    const tmdb = ownTmdbKey ? 'your TMDB key' : BUILT_IN_TMDB_KEY ? 'ROVE’s TMDB key' : 'no TMDB key';
    out.accounts = { text: `${tracking} · ${assistant} · ${tmdb}`, attention };
  }

  // Addons: how many, how many are off, and who did not answer the last refresh.
  if (addonsUnreadable) out.addons = { text: 'Your addons could not be loaded', attention: 'Your addons could not be loaded' };
  else if (!addons.length) out.addons = { text: 'No addons yet' };
  else {
    const off = addons.filter((a) => !a.enabled).length;
    // Only addons that are still installed: one removed since is nobody's problem any more.
    const failed = refresh.failed.filter((n) => addons.some((a) => a.manifest.name === n));
    const parts = [`${count(addons.length, 'addon')}${switchedOff(off, addons.length)}`];
    if (failed.length) parts.push(`${failed.join(', ')} did not answer the last refresh (${ago(refresh.at, now)})`);
    else if (refresh.at) parts.push(`${addons.length === 1 ? 'it' : 'all'} answered the last refresh (${ago(refresh.at, now)})`);
    out.addons = { text: parts.join(' · '), attention: failed.length ? `${failed.join(', ')} did not answer` : undefined };
  }

  // Media servers.
  if (servers.length) {
    const off = servers.filter((s) => !s.enabled).length;
    const libraries = servers.filter((s) => s.enabled).reduce((n, s) => n + (s.libraries?.length ?? 0), 0);
    out.servers = { text: `${count(servers.length, 'server')}${switchedOff(off, servers.length)} · ${count(libraries, 'library', 'libraries')} on Home` };
  }

  // Profiles: who is open, once there is more than one to tell apart.
  if (profiles.length > 1) {
    const open = profiles.find((p) => p.id === activeId);
    out.profiles = { text: `${count(profiles.length, 'profile')}${open ? ` · ${open.name} is open` : ''}` };
  }

  // About: where the update check stands (the page itself shows the version).
  if (update.status === 'available' && update.release) out.about = { text: `Version ${update.release.version} is available`, attention: `Version ${update.release.version} is available` };
  else if (update.status === 'downloading' || update.status === 'installing') out.about = { text: 'Updating' };
  else if (update.status === 'checking') out.about = { text: 'Checking for updates' };
  else if (update.status === 'error') out.about = { text: 'The last update check failed' };
  else if (update.status === 'current') out.about = { text: 'Up to date' };

  return out;
}

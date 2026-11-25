// A ROVE backup: everything needed to set up another PC the same way. Addons, profiles and each
// profile's settings, home layout, collections and track choices; API keys only when asked for
// (the file is then as sensitive as the keys): tracker sign-ins, media servers, TMDB key. Addon
// links are always in it, and a link can carry its addon's configuration (keys included), so no
// backup is free of secrets. Watch history is not included: the tracker carries it between devices.

import { docs, freezeWrites, secrets } from './native';
import { useProfiles, type Profile } from '../state/profiles';
import type { InstalledAddon } from '../addons/types';

const FORMAT = 'rove-backup';

const PER_PROFILE = ['settings', 'home', 'collections', 'tracks', 'searches'] as const;

export interface Backup {
  format: typeof FORMAT;
  version: 1;
  createdAt: string;
  addons: Pick<InstalledAddon, 'url' | 'enabled' | 'disabledResources' | 'manifest' | 'addedAt'>[];
  profiles: { profiles: Profile[]; autoOpenLast?: boolean };
  perProfile: Record<string, Partial<Record<(typeof PER_PROFILE)[number], unknown>> & { pmdbKey?: string; tracker?: unknown }>;
  /** The whole keys document: TMDB key, MDBList key, the AI assistant's provider and key. */
  keys?: { tmdbApiKey?: string | null; mdblistApiKey?: string | null; ai?: unknown };
  servers?: unknown;
  /** On a setup shared with a code (see share.ts): the name of the profile that shared it. */
  sharedBy?: string;
}

export async function makeBackup(includeKeys: boolean): Promise<Backup> {
  const addonsDoc = await secrets.read<{ addons: InstalledAddon[] }>('addons');
  const profilesDoc = (await docs.read<{ profiles: Profile[]; autoOpenLast?: boolean }>('profiles')) ?? { profiles: useProfiles.getState().profiles };
  const perProfile: Backup['perProfile'] = {};
  for (const p of profilesDoc.profiles) {
    const entry: Backup['perProfile'][string] = {};
    for (const name of PER_PROFILE) {
      const v = await docs.read(`${name}-${p.id}`).catch(() => null);
      if (v !== null) entry[name] = v;
    }
    if (includeKeys) {
      const tracker = await secrets.read(`tracker-${p.id}`).catch(() => null);
      if (tracker) entry.tracker = tracker;
      const k = await secrets.read<{ apiKey?: string }>(`pmdb-${p.id}`).catch(() => null);
      if (k?.apiKey) entry.pmdbKey = k.apiKey;
    }
    perProfile[p.id] = entry;
  }
  const backup: Backup = {
    format: FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    addons: (addonsDoc?.addons ?? []).map(({ url, enabled, disabledResources, manifest, addedAt }) => ({ url, enabled, disabledResources, manifest, addedAt })),
    profiles: { profiles: profilesDoc.profiles, autoOpenLast: profilesDoc.autoOpenLast },
    perProfile,
  };
  if (includeKeys) {
    const keys = await secrets.read<{ tmdbApiKey?: string | null; mdblistApiKey?: string | null; ai?: unknown }>('keys').catch(() => null);
    backup.keys = { tmdbApiKey: keys?.tmdbApiKey ?? null, mdblistApiKey: keys?.mdblistApiKey ?? null, ai: keys?.ai ?? null };
    const servers = await secrets.read('servers').catch(() => null);
    if (servers) backup.servers = servers;
  }
  return backup;
}

type SaveWindow = Window & { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }> }> };

/** Asks where to save, then writes the file. False when the user cancelled. */
export async function saveBackup(includeKeys: boolean): Promise<boolean> {
  const data = JSON.stringify(await makeBackup(includeKeys), null, 2);
  const name = `ROVE backup ${new Date().toISOString().slice(0, 10)}.json`;
  const w = window as SaveWindow;
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'ROVE backup', accept: { 'application/json': ['.json'] } }] });
      const stream = await handle.createWritable();
      await stream.write(data);
      await stream.close();
      return true;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return false;
      throw e;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

export interface RestoreSummary {
  addons: number;
  profiles: number;
  keys: boolean;
}

export function readBackup(text: string): Backup {
  const b = JSON.parse(text) as Backup;
  if (b?.format !== FORMAT || b.version !== 1 || !Array.isArray(b.addons) || !b.profiles?.profiles) throw new Error('This is not a ROVE backup.');
  return b;
}

/** Replaces this PC's setup with the backup's. Watch history on this PC is kept. */
export async function restoreBackup(b: Backup): Promise<RestoreSummary> {
  // Anything still waiting to save goes first, so it cannot land on top of the restore.
  const { flushAll } = await import('../state/flushAll');
  await flushAll();
  await secrets.write('addons', { version: 1, addons: b.addons });
  await docs.write('profiles', { profiles: b.profiles.profiles, lastActiveId: b.profiles.profiles[0]?.id, autoOpenLast: b.profiles.autoOpenLast ?? true });
  for (const [id, entry] of Object.entries(b.perProfile ?? {})) {
    for (const name of PER_PROFILE) if (entry[name] !== undefined) await docs.write(`${name}-${id}`, entry[name]);
    if (entry.tracker) await secrets.write(`tracker-${id}`, entry.tracker);
    else if (entry.pmdbKey) await secrets.write(`pmdb-${id}`, { apiKey: entry.pmdbKey });
  }
  // Every key the backup holds goes back; one it does not hold is left as it is on this PC.
  if (b.keys && (b.keys.tmdbApiKey || b.keys.mdblistApiKey || b.keys.ai)) {
    const here = await secrets.read<Record<string, unknown>>('keys').catch(() => null);
    await secrets.write('keys', {
      ...(here ?? {}),
      ...(b.keys.tmdbApiKey ? { tmdbApiKey: b.keys.tmdbApiKey } : {}),
      ...(b.keys.mdblistApiKey ? { mdblistApiKey: b.keys.mdblistApiKey } : {}),
      ...(b.keys.ai ? { ai: b.keys.ai } : {}),
    });
  }
  if (b.servers) await secrets.write('servers', b.servers);
  await docs.write('onboarded', true);
  // The page reloads next; nothing from the old setup may save over the restored files.
  freezeWrites();
  return { addons: b.addons.length, profiles: b.profiles.profiles.length, keys: !!b.keys };
}

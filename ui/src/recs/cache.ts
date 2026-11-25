// TMDB's answers for the rows, kept on disk per profile, so starting ROVE does not ask for all
// of them again: a list fetched an hour ago is still shown, and still counts as fresh, after a
// restart. Nothing here is precious. If the file is lost the rows are fetched once more.

import { docs } from '../lib/native';
import { profileDoc } from '../state/profiles';

interface Entry {
  at: number;
  value: unknown;
}

interface CacheDoc {
  version: 1;
  entries: Record<string, Entry>;
}

/** Nothing older than this is written back: its source has been fetched again, or is no longer used. */
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
/** A Home visit reads about 25 sources; this leaves room for yesterday's seeds and genres. */
const MAX_ENTRIES = 120;
const SAVE_DELAY_MS = 3000;

let entries = new Map<string, Entry>();
let docName: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Reads a profile's saved answers. A file that cannot be read is an empty cache. */
export async function loadCache(profileId: string): Promise<void> {
  // The profile being left gets what was waiting, in its own file.
  flushCache();
  const name = profileDoc('recs-cache', profileId);
  docName = null;
  entries = new Map();
  const doc = await docs.read<CacheDoc>(name).catch(() => null);
  const next = new Map<string, Entry>();
  if (doc && typeof doc === 'object' && doc.entries && typeof doc.entries === 'object') {
    for (const [key, e] of Object.entries(doc.entries)) if (e && typeof e.at === 'number' && e.value !== undefined) next.set(key, e);
  }
  entries = next;
  docName = name;
}

/** A saved answer, whatever its age (the caller knows how long each kind stays good). */
export function peekCache(key: string): Entry | undefined {
  return entries.get(key);
}

function save() {
  if (!docName) return;
  const now = Date.now();
  const kept = [...entries.entries()]
    .filter(([, e]) => now - e.at < MAX_AGE_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_ENTRIES);
  entries = new Map(kept);
  docs.write(docName, { version: 1, entries: Object.fromEntries(kept) } satisfies CacheDoc).catch((e) => console.error('recommendations: cache not saved', e));
}

/** Writes what is waiting now. */
export function flushCache() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  save();
}

/** Keeps an answer. Written a moment later, so the 25 answers of one Home visit are one write. */
export function putCache(key: string, value: unknown) {
  entries.set(key, { at: Date.now(), value });
  if (!docName || timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    save();
  }, SAVE_DELAY_MS);
}

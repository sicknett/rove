// In-app updates. The page finds out whether a newer release exists and shows it. What "update"
// then does depends on the build (shell/src/update.rs):
// - a code-signed build installs it itself: the shell downloads the Setup, checks it against the
//   release signature, and runs it as the app closes;
// - any other build opens the download page, and the user runs the Setup. (An unsigned program
//   that fetches and starts an installer is quarantined by Windows Defender as a dropper.)

import { create } from 'zustand';
import { inShell, send } from '../bridge';
import { nativeFetch } from './native';

/** Where releases are published. The shell only accepts downloads from this repository's releases. */
export const RELEASES_REPO = 'sicknett/rove';
const FEED = `https://github.com/${RELEASES_REPO}/releases/latest/download/latest.json`;
/** Where a person downloads the newest Setup. */
export const DOWNLOAD_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`;

export interface Release {
  version: string;
  /** What changed, a few plain lines. */
  notes?: string;
  url: string;
  sha256: string;
  signature: string;
}

/** Whether version `a` is newer than `b` (both `major.minor.patch`). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export function parseRelease(value: unknown): Release | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const ok = typeof v.version === 'string' && /^\d+\.\d+\.\d+$/.test(v.version) && typeof v.url === 'string' && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(v.sha256) && typeof v.signature === 'string';
  if (!ok) return null;
  return { version: v.version as string, url: v.url as string, sha256: v.sha256 as string, signature: v.signature as string, notes: typeof v.notes === 'string' ? v.notes : undefined };
}

/** The latest published release, or null when none has been published yet. Throws when it cannot tell. */
export async function latestRelease(signal?: AbortSignal): Promise<Release | null> {
  const res = await nativeFetch({ url: FEED, timeoutMs: 15000 }, signal);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new Error(`The update server answered ${res.status}.`);
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    throw new Error('The update information could not be read.');
  }
  const release = parseRelease(body);
  if (!release) throw new Error('The update information could not be read.');
  return release;
}

type Status = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

interface UpdateState {
  status: Status;
  current: string;
  release: Release | null;
  error: string | null;
  /** When the last successful check finished. */
  checkedAt: number | null;
  received: number;
  total: number;
  /** This build installs updates itself; otherwise the Update button opens the download page. */
  selfUpdate: boolean;
  /** Looks for a newer release. Quiet checks (at start) keep errors to themselves. */
  check: (quiet?: boolean) => Promise<void>;
  /** Downloads and checks the Setup, then installs it and reopens ROVE. */
  install: () => Promise<void>;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  status: 'idle',
  current: __APP_VERSION__,
  release: null,
  error: null,
  checkedAt: null,
  received: 0,
  total: 0,
  selfUpdate: false,

  async check(quiet = false) {
    const s = get().status;
    if (s === 'checking' || s === 'downloading' || s === 'installing') return;
    if (!quiet) set({ status: 'checking', error: null });
    if (inShell) {
      void fetch('/__api/update/progress')
        .then((r) => r.json() as Promise<{ selfUpdate?: boolean }>)
        .then((p) => set({ selfUpdate: !!p.selfUpdate }))
        .catch(() => undefined);
    }
    try {
      const release = await latestRelease();
      if (release && isNewer(release.version, get().current)) set({ status: 'available', release, error: null, checkedAt: Date.now() });
      else set({ status: 'current', release: null, error: null, checkedAt: Date.now() });
    } catch (e) {
      if (!quiet) set({ status: 'error', error: e instanceof Error ? e.message : 'Could not check for updates.' });
    }
  },

  async install() {
    const { release, status, selfUpdate } = get();
    if (!release || status === 'downloading' || status === 'installing') return;
    if (!inShell) return set({ status: 'error', error: 'Updates install from the ROVE app, not from a browser.' });
    // The user downloads and runs the Setup; it installs over this copy and keeps everything.
    if (!selfUpdate) return send({ t: 'open-external', url: DOWNLOAD_PAGE });
    set({ status: 'downloading', error: null, received: 0, total: 0 });
    const poll = window.setInterval(() => {
      void fetch('/__api/update/progress')
        .then((r) => r.json() as Promise<{ received: number; total: number }>)
        .then((p) => set({ received: p.received, total: p.total }))
        .catch(() => undefined);
    }, 400);
    try {
      const res = await fetch('/__api/update/download', { method: 'POST', body: JSON.stringify(release) });
      const out = (await res.json()) as { ok: boolean; error?: string };
      if (!out.ok) throw new Error(out.error ?? 'The update could not be downloaded.');
      set({ status: 'installing' });
      // The app saves everything, closes, and Setup opens it again when it is done.
      send({ t: 'install-update' });
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : 'The update could not be downloaded.' });
    } finally {
      window.clearInterval(poll);
    }
  },
}));

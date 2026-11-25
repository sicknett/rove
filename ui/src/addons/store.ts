// Installed addons, shared by every profile. Their links can hold configuration secrets, so the
// list is kept in the encrypted store and never logged.

import { create } from 'zustand';
import { getJson } from '../lib/http';
import { debouncedWriter, secrets } from '../lib/native';
import type { InstalledAddon, Manifest } from './types';

const DOC = 'addons';
const writer = debouncedWriter((v) => secrets.write(DOC, v), 300);

/** Accepts `stremio://` links and links without `/manifest.json`. */
export function normalizeManifestUrl(input: string): string {
  let url = input.trim();
  if (url.startsWith('stremio://')) url = `https://${url.slice('stremio://'.length)}`;
  if (!/^https?:\/\//i.test(url)) throw new Error('An addon link starts with https://');
  url = url.replace(/\/+$/, '');
  if (!/\/manifest\.json$/i.test(url)) url = `${url}/manifest.json`;
  return url;
}

export function addonBase(url: string) {
  return url.replace(/\/manifest\.json$/i, '');
}

/** A short, safe label for an addon link (host only), for messages and logs. */
export function addonHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return 'addon';
  }
}

function validManifest(m: unknown): m is Manifest {
  const x = m as Manifest;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && Array.isArray(x.resources);
}

export async function fetchManifest(url: string): Promise<Manifest> {
  const manifest = await getJson<Manifest>(url, { timeoutMs: 20000, retries: 1 });
  if (!validManifest(manifest)) throw new Error('That link did not return an addon manifest.');
  return { ...manifest, catalogs: manifest.catalogs ?? [], types: manifest.types ?? [] };
}

/**
 * The link is new, but an installed addon has the same manifest id (the same addon, configured
 * again). Two of them would answer for each other's catalogs and rows, so the caller offers to
 * replace the installed one: `add(link, { replace: true })`.
 */
export class AddonConflict extends Error {
  constructor(
    readonly existing: InstalledAddon,
    readonly manifest: Manifest,
  ) {
    super(`${existing.manifest.name} is already installed.`);
    this.name = 'AddonConflict';
  }
}

/** Shown wherever addons are listed or added while the saved list cannot be read. */
export const ADDONS_UNREADABLE = 'Your saved addons could not be read, so nothing is changed. Try again, or restart ROVE.';

interface AddonState {
  loaded: boolean;
  /**
   * The saved list exists but could not be read. The list in memory is empty then and is never
   * saved, or it would replace the real one; `load` again to retry.
   */
  loadFailed: boolean;
  addons: InstalledAddon[];
  load: () => Promise<void>;
  add: (input: string, opts?: { replace?: boolean }) => Promise<InstalledAddon>;
  addMany: (urls: string[], enabled?: Record<string, boolean>) => Promise<{ added: number; failed: string[] }>;
  remove: (url: string) => void;
  /** Puts a removed addon back where it was, as it was (no request needed). False if it is installed again already. */
  restore: (addon: InstalledAddon, index: number) => boolean;
  move: (url: string, to: number) => void;
  setEnabled: (url: string, enabled: boolean) => void;
  toggleResource: (url: string, resource: string) => void;
  /** Fetches every manifest again; `failed` names the addons that did not answer. */
  refreshManifests: () => Promise<{ failed: string[] }>;
}

function persist(addons: InstalledAddon[]) {
  if (useAddons.getState().loadFailed) return;
  writer.save({ version: 1, addons });
}

export const useAddons = create<AddonState>((set, get) => ({
  loaded: false,
  loadFailed: false,
  addons: [],

  async load() {
    let doc: { addons: InstalledAddon[] } | null;
    try {
      // Null when nothing is saved yet; a throw when the file is there but cannot be read.
      doc = await secrets.read<{ addons: InstalledAddon[] }>(DOC);
    } catch (e) {
      console.error('addons could not be read', e);
      set({ addons: [], loaded: true, loadFailed: true });
      return;
    }
    set({ addons: doc?.addons ?? [], loaded: true, loadFailed: false });
    // Manifests change when an addon is reconfigured; refresh quietly after start.
    void get().refreshManifests();
  },

  async add(input, opts = {}) {
    // One more try at reading the saved list first; without it, adding would replace that list.
    if (get().loadFailed) await get().load();
    if (get().loadFailed) throw new Error(ADDONS_UNREADABLE);
    const url = normalizeManifestUrl(input);
    if (get().addons.some((a) => a.url === url)) throw new Error('That addon is already installed.');
    const manifest = await fetchManifest(url);
    // Checked again after the wait: the same link can be submitted twice before the first answers.
    const now = get().addons;
    const same = now.find((a) => a.url === url);
    if (same) return same;
    const twin = now.find((a) => a.manifest.id === manifest.id);
    if (twin && !opts.replace) throw new AddonConflict(twin, manifest);
    // A replacement keeps the place and the switches of the one it replaces.
    const addon: InstalledAddon = twin ? { ...twin, url, manifest } : { url, manifest, enabled: true, addedAt: Date.now() };
    const addons = twin ? now.map((a) => (a === twin ? addon : a)) : [...now, addon];
    set({ addons });
    persist(addons);
    return addon;
  },

  async addMany(urls, enabled = {}) {
    if (get().loadFailed) return { added: 0, failed: urls.map(addonHost) };
    const failed: string[] = [];
    const existing = new Set(get().addons.map((a) => a.url));
    const fresh: InstalledAddon[] = [];
    await Promise.all(
      urls.map(async (raw, i) => {
        try {
          const url = normalizeManifestUrl(raw);
          if (existing.has(url)) return;
          const manifest = await fetchManifest(url);
          fresh[i] = { url, manifest, enabled: enabled[raw] ?? enabled[url] ?? true, addedAt: Date.now() + i };
        } catch {
          failed.push(addonHost(raw));
        }
      }),
    );
    // One addon per link and per manifest id, counting what was installed while these loaded.
    const addons = [...get().addons];
    let added = 0;
    for (const a of fresh.filter(Boolean)) {
      if (addons.some((x) => x.url === a.url || x.manifest.id === a.manifest.id)) continue;
      addons.push(a);
      added++;
    }
    set({ addons });
    persist(addons);
    return { added, failed };
  },

  remove(url) {
    const addons = get().addons.filter((a) => a.url !== url);
    set({ addons });
    persist(addons);
  },

  restore(addon, index) {
    const addons = [...get().addons];
    if (get().loadFailed || addons.some((a) => a.url === addon.url || a.manifest.id === addon.manifest.id)) return false;
    addons.splice(Math.max(0, Math.min(addons.length, index)), 0, addon);
    set({ addons });
    persist(addons);
    return true;
  },

  move(url, to) {
    const list = [...get().addons];
    const from = list.findIndex((a) => a.url === url);
    if (from < 0) return;
    const [item] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, item);
    set({ addons: list });
    persist(list);
  },

  setEnabled(url, enabled) {
    const addons = get().addons.map((a) => (a.url === url ? { ...a, enabled } : a));
    set({ addons });
    persist(addons);
  },

  toggleResource(url, resource) {
    const addons = get().addons.map((a) => {
      if (a.url !== url) return a;
      const off = new Set(a.disabledResources ?? []);
      if (off.has(resource)) off.delete(resource);
      else off.add(resource);
      return { ...a, disabledResources: [...off] };
    });
    set({ addons });
    persist(addons);
  },

  async refreshManifests() {
    const failed: string[] = [];
    const byUrl = new Map<string, Manifest>();
    await Promise.all(
      get().addons.map(async (a) => {
        try {
          byUrl.set(a.url, await fetchManifest(a.url));
        } catch {
          failed.push(a.manifest.name);
        }
      }),
    );
    // Keep any edits made while the refresh ran, and save only when a manifest really changed.
    let changed = false;
    const addons = get().addons.map((a) => {
      const manifest = byUrl.get(a.url);
      if (!manifest || JSON.stringify(manifest) === JSON.stringify(a.manifest)) return a;
      changed = true;
      return { ...a, manifest };
    });
    if (changed) {
      set({ addons });
      persist(addons);
    }
    return { failed };
  },
}));

export function flushAddons() {
  return writer.flush();
}

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

interface AddonState {
  loaded: boolean;
  addons: InstalledAddon[];
  load: () => Promise<void>;
  add: (input: string) => Promise<InstalledAddon>;
  addMany: (urls: string[], enabled?: Record<string, boolean>) => Promise<{ added: number; failed: string[] }>;
  remove: (url: string) => void;
  move: (url: string, to: number) => void;
  setEnabled: (url: string, enabled: boolean) => void;
  toggleResource: (url: string, resource: string) => void;
  refreshManifests: () => Promise<void>;
}

function persist(addons: InstalledAddon[]) {
  writer.save({ version: 1, addons });
}

export const useAddons = create<AddonState>((set, get) => ({
  loaded: false,
  addons: [],

  async load() {
    const doc = await secrets.read<{ addons: InstalledAddon[] }>(DOC).catch(() => null);
    set({ addons: doc?.addons ?? [], loaded: true });
    // Manifests change when an addon is reconfigured; refresh quietly after start.
    void get().refreshManifests();
  },

  async add(input) {
    const url = normalizeManifestUrl(input);
    if (get().addons.some((a) => a.url === url)) throw new Error('That addon is already installed.');
    const manifest = await fetchManifest(url);
    const addon: InstalledAddon = { url, manifest, enabled: true, addedAt: Date.now() };
    const addons = [...get().addons, addon];
    set({ addons });
    persist(addons);
    return addon;
  },

  async addMany(urls, enabled = {}) {
    const failed: string[] = [];
    let added = 0;
    const existing = new Set(get().addons.map((a) => a.url));
    const fresh: InstalledAddon[] = [];
    await Promise.all(
      urls.map(async (raw, i) => {
        try {
          const url = normalizeManifestUrl(raw);
          if (existing.has(url)) return;
          const manifest = await fetchManifest(url);
          fresh[i] = { url, manifest, enabled: enabled[raw] ?? enabled[url] ?? true, addedAt: Date.now() + i };
          added++;
        } catch {
          failed.push(addonHost(raw));
        }
      }),
    );
    const addons = [...get().addons, ...fresh.filter(Boolean)];
    set({ addons });
    persist(addons);
    return { added, failed };
  },

  remove(url) {
    const addons = get().addons.filter((a) => a.url !== url);
    set({ addons });
    persist(addons);
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
    const current = get().addons;
    const refreshed = await Promise.all(
      current.map(async (a) => {
        try {
          return { ...a, manifest: await fetchManifest(a.url) };
        } catch {
          return a;
        }
      }),
    );
    // Keep any edits made while the refresh ran.
    const byUrl = new Map(refreshed.map((a) => [a.url, a.manifest]));
    const addons = get().addons.map((a) => ({ ...a, manifest: byUrl.get(a.url) ?? a.manifest }));
    set({ addons });
    persist(addons);
  },
}));

export function flushAddons() {
  return writer.flush();
}

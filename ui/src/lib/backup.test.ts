import { describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('./native', () => {
  const kind = (k: string) => ({
    read: async (n: string) => (store.has(`${k}:${n}`) ? structuredClone(store.get(`${k}:${n}`)) : null),
    write: async (n: string, v: unknown) => void store.set(`${k}:${n}`, structuredClone(v)),
    remove: async (n: string) => void store.delete(`${k}:${n}`),
  });
  return { docs: kind('doc'), secrets: kind('secret'), freezeWrites: () => undefined, debouncedWriter: () => ({ save() {}, flush: async () => undefined }) };
});
vi.mock('../state/flushAll', () => ({ flushAll: async () => undefined }));

import { makeBackup, readBackup, restoreBackup } from './backup';

describe('ROVE backup', () => {
  it('round-trips addons, profiles and per-profile settings; keys only when asked', async () => {
    store.set('secret:addons', { addons: [{ url: 'https://a.example/manifest.json', enabled: true, manifest: { id: 'a', name: 'A', version: '1', types: [], resources: [], catalogs: [] }, addedAt: 1 }] });
    store.set('doc:profiles', { profiles: [{ id: 'p1', name: 'Me', color: '#fff', createdAt: 1 }] });
    store.set('doc:settings-p1', { audio: { delayMs: 150 } });
    store.set('doc:home-p1', { heroEnabled: false, items: [] });
    store.set('secret:pmdb-p1', { apiKey: 'pm-secret' });
    store.set('secret:keys', { tmdbApiKey: 'tmdb-secret' });

    const without = await makeBackup(false);
    expect(JSON.stringify(without)).not.toContain('secret');
    const withKeys = readBackup(JSON.stringify(await makeBackup(true)));

    store.clear();
    const summary = await restoreBackup(withKeys);
    expect(summary).toEqual({ addons: 1, profiles: 1, keys: true });
    expect(store.get('doc:settings-p1')).toEqual({ audio: { delayMs: 150 } });
    expect(store.get('doc:home-p1')).toEqual({ heroEnabled: false, items: [] });
    expect(store.get('secret:pmdb-p1')).toEqual({ apiKey: 'pm-secret' });
    expect(store.get('secret:keys')).toEqual({ tmdbApiKey: 'tmdb-secret' });
    expect(store.get('doc:onboarded')).toBe(true);
  });

  it('refuses files that are not backups', () => {
    expect(() => readBackup('{"hello":1}')).toThrow('not a ROVE backup');
  });
});

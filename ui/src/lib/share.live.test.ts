// A check against the real services, with a made-up setup. It is skipped unless asked for,
// because it uploads to them:
//
//   ROVE_SHARE_LIVE=1 npx vitest run src/lib/share.live.test.ts
//
// Each copy it uploads is deleted again before the test ends. privatebin.net takes one upload a
// minute from an address, so running this twice in a row fails there the second time.

import { describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const sizes: { url: string; sent: number; received: number }[] = [];

vi.mock('./native', () => {
  const kind = (k: string) => ({
    read: async (n: string) => (store.has(`${k}:${n}`) ? structuredClone(store.get(`${k}:${n}`)) : null),
    write: async (n: string, v: unknown) => void store.set(`${k}:${n}`, structuredClone(v)),
    remove: async (n: string) => void store.delete(`${k}:${n}`),
  });
  // What the shell's fetch does for the page: text out, text back, redirects followed.
  const nativeFetch = async (req: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body });
    const body = await res.text();
    sizes.push({ url: req.url, sent: req.body?.length ?? 0, received: body.length });
    return { status: res.status, url: res.url, headers: {}, body };
  };
  return { docs: kind('doc'), secrets: kind('secret'), nativeFetch, freezeWrites: () => undefined, debouncedWriter: () => ({ save() {}, flush: async () => undefined }) };
});
vi.mock('../state/flushAll', () => ({ flushAll: async () => undefined }));

import { applyShare, checkSharedBackup, createShare, fetchShare, makeShareBackup, SHARE_HOSTS, ShareError, stopSharing } from './share';
import { randomBytes, toBase64 } from './shareSeal';
import { useProfiles } from '../state/profiles';

const word = (n: number) => toBase64(randomBytes(n)).replace(/[+/=]/g, 'x');

/** Made-up collections about as large as the ones ROVE ships with: 1.6 MB of JSON. */
function madeUpCollections() {
  const collections: unknown[] = [];
  let size = 0;
  while (size < 1_600_000) {
    const c = {
      id: `collection-${word(9)}`,
      title: `Collection ${collections.length}`,
      viewMode: 'TABBED_GRID',
      folders: Array.from({ length: 12 }, (_, f) => ({
        id: `folder-${word(9)}`,
        title: `Folder ${f}`,
        tileShape: 'POSTER',
        coverImageUrl: `https://images.example/t/p/w500/${word(20)}.jpg`,
        heroBackdropUrl: `https://images.example/t/p/original/${word(20)}.jpg`,
        sources: [{ provider: 'tmdb', tmdbSourceType: 'DISCOVER', mediaType: 'movie', sortBy: 'popularity.desc', filters: { with_genres: String(f), with_companies: word(4) } }],
      })),
    };
    collections.push(c);
    size += JSON.stringify(c).length;
  }
  return collections;
}

function madeUpPc() {
  store.clear();
  store.set('secret:addons', {
    addons: Array.from({ length: 6 }, (_, i) => ({
      url: `https://addon${i}.example/${word(24)}/manifest.json`,
      enabled: true,
      manifest: { id: `example.addon${i}`, name: `Example ${i}`, version: '1.0.0', types: ['movie', 'series'], resources: ['catalog', 'meta', 'stream'], catalogs: Array.from({ length: 30 }, (_, c) => ({ type: 'movie', id: `cat-${c}`, name: `Catalog ${c}` })) },
      addedAt: 1 + i,
    })),
  });
  const profiles = [
    { id: 'p1', name: 'Test Person', color: '#9eb7a4', createdAt: 1, image: `data:image/jpeg;base64,${toBase64(randomBytes(24_000))}` },
    { id: 'p2', name: 'Second', color: '#cbb48f', createdAt: 2 },
  ];
  store.set('doc:profiles', { profiles, autoOpenLast: true });
  store.set('doc:settings-p1', { audio: { delayMs: 150 }, appearance: { accent: 'sage' } });
  store.set('doc:home-p1', { heroEnabled: true, items: Array.from({ length: 40 }, (_, i) => ({ key: `row-${i}`, on: true })) });
  store.set('doc:collections-p1', { collections: madeUpCollections(), lists: [] });
  store.set('doc:collections-p2', { collections: madeUpCollections().slice(0, 20), lists: [] });
  useProfiles.setState({ profiles, activeId: 'p1' });
}

const live = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ROVE_SHARE_LIVE;

describe.skipIf(!live)('sharing through the real services', () => {
  for (const host of SHARE_HOSTS) {
    it(
      `keeps, returns and deletes a made-up setup at ${host.name}`,
      async () => {
        madeUpPc();
        const expected = checkSharedBackup(await makeShareBackup(false));
        const others = SHARE_HOSTS.filter((h) => h !== host).map((h) => [h, h.maxCipherChars] as const);
        sizes.length = 0;
        let made;
        try {
          // Only this service fits, so this is the one that gets it.
          others.forEach(([h]) => (h.maxCipherChars = 0));
          made = await createShare(false);
        } finally {
          others.forEach(([h, max]) => (h.maxCipherChars = max));
        }
        try {
          expect(made.host).toBe(host);
          const days = (made.expiresAt - Date.now()) / 86_400_000;
          console.log(`${host.name}: uploaded ${sizes[0].sent} characters for a setup of ${JSON.stringify(expected).length}; the service keeps it ${days.toFixed(2)} days; code ${made.code}`);
          expect(sizes[0].sent).toBeLessThan(host.maxCipherChars);
          expect(days).toBeGreaterThan(host.keep.seconds / 86_400 - 0.01);
          expect(days).toBeLessThanOrEqual(host.keep.seconds / 86_400);

          // Another PC, with nothing on it but the code.
          store.clear();
          const got = await fetchShare(made.code);
          expect(got.host).toBe(host);
          expect(got.backup).toEqual({ ...expected, createdAt: got.backup.createdAt });
          expect(got.summary).toMatchObject({ addons: 6, profiles: ['Test Person', 'Second'], keys: false, sharedBy: 'Test Person' });
          await applyShare(got);
          expect(store.get('doc:collections-p1')).toEqual(expected.perProfile.p1.collections);
          expect(store.get('secret:addons')).toEqual({ version: 1, addons: expected.addons });
        } finally {
          await stopSharing(made);
        }
        const after = await fetchShare(made.code).catch((e: unknown) => e);
        expect(after).toBeInstanceOf(ShareError);
        expect((after as ShareError).problem).toBe('gone');
      },
      120_000,
    );
  }
});

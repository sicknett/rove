import { beforeEach, describe, expect, it, vi } from 'vitest';

// The documents of one PC, and a stand-in for the services that hold shared copies. The stand-in
// answers the way a PrivateBin does: always HTTP 200, with `status` 0 or 1 in the JSON.
const store = new Map<string, unknown>();
interface Kept {
  body: { v: number; adata: unknown; ct: string; meta: { expire: string } };
  token: string;
}
const kept = new Map<string, Kept>();
const requests: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
const service = {
  /** Hosts that refuse new copies, with what they say. */
  refuse: new Map<string, string>(),
  /** Changes an answer before it is returned. */
  tamper: null as null | ((answer: Record<string, unknown>, url: string) => unknown),
  /** Where answers claim to come from, when not the address that was asked. */
  answerFrom: null as string | null,
  offline: false,
  /** How long copies are said to have left, when not the period that was asked for. */
  ttl: null as number | null,
};
const PERIODS: Record<string, number> = { '1day': 86_400, '3day': 259_200, '1week': 604_800 };
let nextId = 1;

vi.mock('./native', () => {
  const kind = (k: string) => ({
    read: async (n: string) => (store.has(`${k}:${n}`) ? structuredClone(store.get(`${k}:${n}`)) : null),
    write: async (n: string, v: unknown) => void store.set(`${k}:${n}`, structuredClone(v)),
    remove: async (n: string) => void store.delete(`${k}:${n}`),
  });
  const nativeFetch = async (req: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
    requests.push({ url: req.url, method: req.method ?? 'GET', headers: req.headers ?? {}, body: req.body });
    if (service.offline) throw new Error('dns error');
    const url = new URL(req.url);
    let answer: Record<string, unknown>;
    if (req.method === 'POST') {
      const body = JSON.parse(req.body ?? '{}');
      if (body.pasteid) {
        const k = `${url.origin}/${body.pasteid}`;
        if (kept.get(k)?.token === body.deletetoken) {
          kept.delete(k);
          answer = { status: 0, id: body.pasteid };
        } else answer = { status: 1, message: 'Wrong deletion token. Document was not deleted.' };
      } else if (service.refuse.has(url.host)) {
        answer = { status: 1, message: service.refuse.get(url.host) };
      } else {
        const id = (nextId++).toString(16).padStart(16, '0');
        const token = 'ab'.repeat(32);
        kept.set(`${url.origin}/${id}`, { body, token });
        answer = { status: 0, id, url: `/?${id}`, deletetoken: token };
      }
    } else {
      const found = kept.get(`${url.origin}/${url.search.slice(1)}`);
      answer = found ? { status: 0, id: url.search.slice(1), v: 2, adata: found.body.adata, ct: found.body.ct, meta: { time_to_live: service.ttl ?? PERIODS[found.body.meta.expire] }, comments: [] } : { status: 1, message: 'Document does not exist, has expired or has been deleted.' };
    }
    const changed = service.tamper ? service.tamper(answer, req.url) : answer;
    return { status: 200, url: service.answerFrom ?? req.url, headers: {}, body: typeof changed === 'string' ? changed : JSON.stringify(changed) };
  };
  return { docs: kind('doc'), secrets: kind('secret'), nativeFetch, freezeWrites: () => undefined, debouncedWriter: () => ({ save() {}, flush: async () => undefined }) };
});
vi.mock('../state/flushAll', () => ({ flushAll: async () => undefined }));

import { readBackup } from './backup';
import { applyShare, checkSharedBackup, createShare, fetchShare, makeShareBackup, MAX_ANSWER_CHARS, profilesReplaced, SHARE_HOSTS, ShareError, shareMessage, stopSharing, summarise, sealingKey } from './share';
import { formatShareCode, parseShareCode } from './shareCode';
import { randomBytes, seal, SealError, toBase64 } from './shareSeal';
import { useProfiles } from '../state/profiles';

const [FIRST, SECOND] = SHARE_HOSTS;

/** Everything on this made-up PC that must never be in a setup shared without keys. */
const SECRETS = ['TRACKER-ACCESS-TOKEN', 'TRACKER-REFRESH-TOKEN', 'PMDB-API-KEY', 'TMDB-API-KEY', 'MDBLIST-API-KEY', 'AI-API-KEY', 'SERVER-ACCESS-TOKEN', 'SERVER-PASSWORD'];
/** And what stays on the PC even when keys are shared. */
const PRIVATE = ['4821', 'a film I searched for', 'tt0111161', 'C:\\\\Users\\\\Someone\\\\player.exe', 'Someone'];

function fillThisPc() {
  store.clear();
  store.set('secret:addons', {
    addons: [
      { url: 'https://streams.example/CONFIG-IN-LINK/manifest.json', enabled: true, manifest: { id: 'streams', name: 'Streams', version: '1', types: [], resources: [], catalogs: [] }, addedAt: 1 },
      { url: 'https://meta.example/manifest.json', enabled: false, disabledResources: ['catalog'], manifest: { id: 'meta', name: 'Meta', version: '2', types: [], resources: [], catalogs: [] }, addedAt: 2 },
    ],
  });
  store.set('doc:profiles', {
    profiles: [
      { id: 'p1', name: 'Sam', color: '#9eb7a4', pin: '4821', image: 'data:image/jpeg;base64,AAAA', createdAt: 1 },
      { id: 'pkids', name: 'Kids', color: '#cbb48f', kids: true, createdAt: 2 },
    ],
    lastActiveId: 'p1',
    autoOpenLast: false,
  });
  store.set('doc:settings-p1', { audio: { delayMs: 150 }, sources: { autoPlay: 'first', externalPlayer: 'C:\\Users\\Someone\\player.exe' } });
  store.set('doc:home-p1', { heroEnabled: false, items: ['a', 'b'] });
  store.set('doc:collections-p1', { collections: [{ id: 'c1', title: 'One', folders: [] }, { id: 'c2', title: 'Two', folders: [] }], lists: [] });
  store.set('doc:collections-pkids', { collections: [{ id: 'c3', title: 'Three', folders: [] }] });
  store.set('doc:searches-p1', ['a film I searched for']);
  store.set('doc:tracks-p1', { tt0111161: { audioLang: 'eng' } });
  store.set('doc:history-p1', { items: ['never part of a backup'] });
  store.set('secret:tracker-p1', { provider: 'trakt', accessToken: 'TRACKER-ACCESS-TOKEN', refreshToken: 'TRACKER-REFRESH-TOKEN' });
  store.set('secret:pmdb-pkids', { apiKey: 'PMDB-API-KEY' });
  store.set('secret:keys', { tmdbApiKey: 'TMDB-API-KEY', mdblistApiKey: 'MDBLIST-API-KEY', ai: { provider: 'openai', apiKey: 'AI-API-KEY', model: 'm' } });
  store.set('secret:servers', { servers: [{ id: 's1', kind: 'jellyfin', url: 'https://jelly.example', token: 'SERVER-ACCESS-TOKEN', password: 'SERVER-PASSWORD' }] });
  useProfiles.setState({ profiles: (store.get('doc:profiles') as { profiles: never[] }).profiles, activeId: 'p1' });
}

const problemOf = async (run: Promise<unknown>) => {
  try {
    await run;
    return null;
  } catch (e) {
    if (e instanceof ShareError || e instanceof SealError) return e.problem;
    throw e;
  }
};

beforeEach(() => {
  fillThisPc();
  kept.clear();
  requests.length = 0;
  service.refuse.clear();
  service.tamper = null;
  service.answerFrom = null;
  service.offline = false;
  service.ttl = null;
});

describe('what a code carries', () => {
  it('has no sign-in, no key and no personal traces when keys are off', async () => {
    const text = JSON.stringify(await makeShareBackup(false));
    for (const secret of [...SECRETS, ...PRIVATE]) expect(text, secret).not.toContain(secret);
    const b = readBackup(text);
    expect(b.keys).toBeUndefined();
    expect(b.servers).toBeUndefined();
    for (const entry of Object.values(b.perProfile)) {
      expect(entry.tracker).toBeUndefined();
      expect(entry.pmdbKey).toBeUndefined();
      expect(entry.searches).toBeUndefined();
      expect(entry.tracks).toBeUndefined();
    }
    expect(b.profiles.profiles.some((p) => 'pin' in p)).toBe(false);
    expect(summarise(b).keys).toBe(false);
    // The setup itself is all there: it is still a backup, and restores as one.
    expect(b.addons.map((a) => a.url)).toEqual(['https://streams.example/CONFIG-IN-LINK/manifest.json', 'https://meta.example/manifest.json']);
    expect(b.profiles.profiles.map((p) => p.name)).toEqual(['Sam', 'Kids']);
    expect(b.perProfile.p1.settings).toEqual({ audio: { delayMs: 150 }, sources: { autoPlay: 'first' } });
    expect(b.perProfile.p1.home).toEqual({ heroEnabled: false, items: ['a', 'b'] });
    expect(b.sharedBy).toBe('Sam');
  });

  it('has the sign-ins and keys when asked, and still not the personal traces', async () => {
    const b = await makeShareBackup(true);
    const text = JSON.stringify(b);
    for (const secret of SECRETS) expect(text, secret).toContain(secret);
    for (const trace of PRIVATE) expect(text, trace).not.toContain(trace);
    expect(summarise(b)).toMatchObject({ addons: 2, profiles: ['Sam', 'Kids'], collections: 3, keys: true, sharedBy: 'Sam' });
  });

  it('does not sign a setup with the name every first profile has', async () => {
    useProfiles.setState({ profiles: [{ id: 'p1', name: 'Me', color: '#fff', createdAt: 1 }], activeId: 'p1' });
    expect((await makeShareBackup(false)).sharedBy).toBeUndefined();
  });
});

describe('making and using a code', () => {
  it('uploads only ciphertext, and the code opens it on another PC', async () => {
    const made = await createShare(false);
    expect(made.host).toBe(FIRST);
    expect(made.code).toMatch(/^1A[0-9A-Z]{3}(-[0-9A-Z]{5}){8}$/);
    expect(made.summary).toMatchObject({ addons: 2, profiles: ['Sam', 'Kids'], collections: 3, keys: false });
    // The service was told how long to keep it, and the code's end is what the service reports.
    expect(made.expiresAt - Date.now()).toBeGreaterThan(604_700 * 1000);
    expect(made.expiresAt - Date.now()).toBeLessThanOrEqual(604_800 * 1000);

    const upload = requests[0];
    expect(upload.method).toBe('POST');
    expect(upload.url).toBe('https://paste.unredacted.org/');
    expect(upload.headers['X-Requested-With']).toBe('JSONHttpRequest');
    const sent = JSON.parse(upload.body ?? '') as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['adata', 'ct', 'meta', 'v']);
    expect(sent.meta).toEqual({ expire: '1week' });
    // Nothing that left the PC says anything about the setup, or holds the key.
    const key = parseShareCode(made.code).key;
    const left = requests.map((r) => r.url + JSON.stringify(r.headers) + (r.body ?? '')).join('\n');
    for (const plain of ['streams.example', 'CONFIG-IN-LINK', '"profiles"', '"Sam"', 'rove-backup', toBase64(key), made.code]) expect(left, plain).not.toContain(plain);
    expect(left).not.toContain(Array.from(key, (b) => b.toString(16).padStart(2, '0')).join(''));

    // The other PC: nothing saved there yet.
    const before = requests.length;
    store.clear();
    const got = await fetchShare(made.code.toLowerCase().replace(/-/g, ' '));
    expect(requests.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([`GET https://paste.unredacted.org/?${made.id}`]);
    expect(got.host).toBe(FIRST);
    expect(got.summary).toEqual(made.summary);
    expect(got.expiresAt).not.toBeNull();
    // Fetching changes nothing on the PC.
    expect(store.size).toBe(0);

    const summary = await applyShare(got);
    expect(summary).toEqual({ addons: 2, profiles: 2, keys: false });
    expect((store.get('secret:addons') as { addons: { url: string }[] }).addons.map((a) => a.url)).toEqual(['https://streams.example/CONFIG-IN-LINK/manifest.json', 'https://meta.example/manifest.json']);
    expect((store.get('doc:profiles') as { profiles: { name: string }[] }).profiles.map((p) => p.name)).toEqual(['Sam', 'Kids']);
    expect(store.get('doc:home-p1')).toEqual({ heroEnabled: false, items: ['a', 'b'] });
    expect((store.get('doc:collections-p1') as { collections: unknown[] }).collections).toHaveLength(2);
    expect(store.get('doc:onboarded')).toBe(true);
    expect([...store.keys()].filter((k) => /tracker|pmdb|keys|servers|searches|tracks|history/.test(k))).toEqual([]);
  });

  it('brings the sign-ins and keys across when they were included, for one day', async () => {
    const made = await createShare(true);
    expect(JSON.parse(requests[0].body ?? '').meta).toEqual({ expire: '1day' });
    expect(made.summary.keys).toBe(true);
    for (const r of requests) for (const secret of SECRETS) expect(r.body ?? '').not.toContain(secret);
    store.clear();
    await applyShare(await fetchShare(made.code));
    expect(store.get('secret:tracker-p1')).toMatchObject({ accessToken: 'TRACKER-ACCESS-TOKEN' });
    expect(store.get('secret:pmdb-pkids')).toEqual({ apiKey: 'PMDB-API-KEY' });
    expect(store.get('secret:keys')).toMatchObject({ tmdbApiKey: 'TMDB-API-KEY', mdblistApiKey: 'MDBLIST-API-KEY' });
    expect(store.get('secret:servers')).toBeTruthy();
  });

  it('replaces the setup on a PC that has one, as restoring a backup does', async () => {
    const made = await createShare(false);
    store.clear();
    store.set('secret:addons', { addons: [{ url: 'https://old.example/manifest.json', enabled: true, manifest: { id: 'old', name: 'Old' }, addedAt: 1 }] });
    store.set('doc:profiles', { profiles: [{ id: 'p1', name: 'Me', color: '#fff', createdAt: 1 }, { id: 'pmine', name: 'Robin', color: '#fff', createdAt: 2 }] });
    store.set('doc:history-p1', { items: ['mine'] });
    store.set('secret:keys', { tmdbApiKey: 'MY-OWN-KEY' });
    const got = await fetchShare(made.code);
    // Said before anything changes: Robin is not in the setup, the first profile is (same id).
    expect(profilesReplaced(got, [{ id: 'p1', name: 'Me' }, { id: 'pmine', name: 'Robin' }])).toEqual(['Robin']);
    await applyShare(got);
    expect((store.get('secret:addons') as { addons: { url: string }[] }).addons.map((a) => a.url)).not.toContain('https://old.example/manifest.json');
    expect((store.get('doc:profiles') as { profiles: { name: string }[] }).profiles.map((p) => p.name)).toEqual(['Sam', 'Kids']);
    // Watch history and, with no keys in the code, this PC's own keys are left alone.
    expect(store.get('doc:history-p1')).toEqual({ items: ['mine'] });
    expect(store.get('secret:keys')).toEqual({ tmdbApiKey: 'MY-OWN-KEY' });
  });

  it('goes to the second service when the first does not take the copy', async () => {
    service.refuse.set('paste.unredacted.org', 'Please wait 10 seconds between each post.');
    const made = await createShare(false);
    expect(made.host).toBe(SECOND);
    expect(made.code.startsWith('1B')).toBe(true);
    expect(JSON.parse(requests[1].body ?? '').meta).toEqual({ expire: '3day' });
    expect((await fetchShare(made.code)).host).toBe(SECOND);
    expect(requests.at(-1)?.url).toBe(`https://privatebin.net/?${made.id}`);
  });

  it('says what the service said when neither takes it', async () => {
    service.refuse.set('paste.unredacted.org', 'Please wait 10 seconds between each post.');
    service.refuse.set('privatebin.net', 'Please wait 60 seconds between each post.');
    const failed = await createShare(false).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ShareError);
    expect(shareMessage(failed)).toBe('privatebin.net did not take the copy. It said: “Please wait 60 seconds between each post.”');
    expect(kept.size).toBe(0);
  });

  it('does not leave a copy behind that could not be read back', async () => {
    service.tamper = (answer) => (typeof answer.ct === 'string' ? { ...answer, ct: answer.ct.slice(0, -8) + 'AAAAAAA=' } : answer);
    expect(await problemOf(createShare(false))).toBe('damaged');
    expect(kept.size).toBe(0);
  });

  it('does not leave a copy where it would be kept longer than was asked', async () => {
    // Both services have dropped "one day" and keep everything a week.
    service.ttl = 604_800;
    const failed = await createShare(true).catch((e: unknown) => e);
    expect(shareMessage(failed)).toBe('privatebin.net would keep the copy longer than ROVE asked for, so it was deleted there again.');
    expect(requests.filter((r) => r.method === 'POST' && r.body?.includes('"ct"'))).toHaveLength(2);
    expect(kept.size).toBe(0);
    // Without keys a week is what the first service is asked for.
    expect((await createShare(false)).host).toBe(FIRST);
  });

  it('refuses a setup too large for every service before uploading anything', async () => {
    const limits = SHARE_HOSTS.map((h) => h.maxCipherChars);
    try {
      SHARE_HOSTS.forEach((h) => (h.maxCipherChars = 200));
      const failed = await createShare(false).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(ShareError);
      expect((failed as ShareError).problem).toBe('too-large');
      expect(shareMessage(failed)).toContain('Use Back up instead');
      expect(requests).toHaveLength(0);
      // Too large for the first only: the second gets it.
      SECOND.maxCipherChars = limits[1];
      expect((await createShare(false)).host).toBe(SECOND);
    } finally {
      SHARE_HOSTS.forEach((h, i) => (h.maxCipherChars = limits[i]));
    }
  });

  it('stops sharing when asked: the code no longer works', async () => {
    const made = await createShare(false);
    await stopSharing(made);
    expect(kept.size).toBe(0);
    expect(await problemOf(fetchShare(made.code))).toBe('gone');
    expect(await problemOf(stopSharing(made))).toBe('refused');
  });
});

describe('a code that does not work', () => {
  it('never asks anywhere but the two services, whatever the code is', async () => {
    for (let n = 0; n < 60; n++) {
      const id = Array.from(randomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
      await fetchShare(formatShareCode({ host: n % 2 ? 'A' : 'B', id, key: randomBytes(16) })).catch(() => undefined);
    }
    expect(requests).toHaveLength(60);
    for (const r of requests) {
      expect(r.url).toMatch(/^https:\/\/(paste\.unredacted\.org|privatebin\.net)\/\?[0-9a-f]{16}$/);
      expect(r.method).toBe('GET');
      expect(r.body).toBeUndefined();
    }
  });

  it('is told apart from a mistyped one before anything is fetched', async () => {
    const made = await createShare(false);
    const before = requests.length;
    const mistyped = made.code.slice(0, 9) + (made.code[9] === '7' ? '8' : '7') + made.code.slice(10);
    for (const bad of ['', 'hello', mistyped, made.code.slice(0, -3), `2${made.code.slice(1)}`]) {
      const failed = await fetchShare(bad).catch((e: unknown) => e);
      expect(shareMessage(failed), bad).not.toBe('Something went wrong. Nothing on this PC was changed.');
    }
    // A service this ROVE does not know: a newer ROVE made the code.
    const { id, key } = parseShareCode(made.code);
    expect(await problemOf(fetchShare(formatShareCode({ host: 'Z', id, key })))).toBe('newer');
    expect(requests).toHaveLength(before);
  });

  it('says so when the copy ran out or was deleted', async () => {
    const made = await createShare(false);
    kept.clear();
    const failed = await fetchShare(made.code).catch((e: unknown) => e);
    expect((failed as ShareError).problem).toBe('gone');
    expect(shareMessage(failed)).toContain('nothing at paste.unredacted.org for this code any more');
  });

  it('says so when the service cannot be reached', async () => {
    const made = await createShare(false);
    service.offline = true;
    expect(await problemOf(fetchShare(made.code))).toBe('network');
    expect(await problemOf(createShare(false))).toBe('network');
  });

  it('does not open a copy that was changed where it is kept', async () => {
    const made = await createShare(false);
    const other = await seal(JSON.stringify(await makeShareBackup(false)), randomBytes(32));
    for (const tamper of [
      (a: Record<string, unknown>) => ({ ...a, ct: (a.ct as string).replace(/^.{4}/, 'AAAA') }),
      // Someone else's perfectly good copy, put in its place.
      (a: Record<string, unknown>) => ({ ...a, adata: other.adata, ct: other.ct }),
      (a: Record<string, unknown>) => ({ ...a, adata: [[...(a.adata as unknown[][])[0].slice(0, 2), 1, 256, 128, 'aes', 'gcm', 'zlib'], 'plaintext', 0, 0] }),
      (a: Record<string, unknown>) => ({ status: 0, id: a.id }),
    ]) {
      service.tamper = tamper;
      expect(await problemOf(fetchShare(made.code))).toBe('damaged');
    }
  });

  it('does not read an answer that is too large, or one that is not from the service', async () => {
    const made = await createShare(false);
    service.tamper = (a) => ({ ...a, ct: 'A'.repeat(MAX_ANSWER_CHARS) });
    expect(await problemOf(fetchShare(made.code))).toBe('too-large');
    service.tamper = null;
    service.answerFrom = 'https://elsewhere.example/?x';
    expect(await problemOf(fetchShare(made.code))).toBe('refused');
    service.answerFrom = null;
    service.tamper = () => '<html>Checking your browser…</html>';
    expect(await problemOf(fetchShare(made.code))).toBe('refused');
    service.tamper = null;
    expect(await problemOf(fetchShare(made.code))).toBeNull();
  });

  it('does not accept something that opens but is not a ROVE setup', async () => {
    const put = async (text: string) => {
      const secret = randomBytes(16);
      const sealed = await seal(text, await sealingKey(secret));
      const id = (nextId++).toString(16).padStart(16, '0');
      kept.set(`https://paste.unredacted.org/${id}`, { body: { v: 2, ...sealed, meta: { expire: '1week' } }, token: 't' });
      return formatShareCode({ host: 'A', id, key: secret });
    };
    const good = await makeShareBackup(false);
    expect(await problemOf(fetchShare(await put(JSON.stringify(good))))).toBeNull();
    const bad: unknown[] = [
      { hello: 1 },
      'just text',
      { ...good, version: 2 },
      { ...good, profiles: { profiles: [] } },
      { ...good, profiles: { profiles: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: 'N', color: '#fff', createdAt: 1 })) } },
      { ...good, profiles: { profiles: [{ id: '../../x', name: 'N', color: '#fff', createdAt: 1 }] } },
      { ...good, profiles: { profiles: [{ id: 'p1', name: '', color: '#fff', createdAt: 1 }] } },
      { ...good, profiles: { profiles: [{ id: 'p1', name: 'A', color: '#fff' }, { id: 'p1', name: 'B', color: '#fff' }] } },
      { ...good, addons: [{ url: 'file:///C:/Windows/win.ini', enabled: true, manifest: { id: 'x', name: 'X' }, addedAt: 1 }] },
      { ...good, addons: [{ url: 'javascript:alert(1)', enabled: true, manifest: { id: 'x', name: 'X' }, addedAt: 1 }] },
      { ...good, addons: [{ url: 'https://ok.example/manifest.json', enabled: true }] },
      { ...good, addons: ['https://ok.example/manifest.json'] },
      { ...good, perProfile: [] },
    ];
    for (const b of bad) expect(await problemOf(fetchShare(await put(typeof b === 'string' ? b : JSON.stringify(b)))), JSON.stringify(b).slice(0, 80)).toBe('not-a-setup');
    expect(store.get('doc:onboarded')).toBeUndefined();
  });

  it('takes out what a code must not set on this PC', async () => {
    const sent = await makeShareBackup(true);
    const hostile = {
      ...sent,
      sharedBy: `  ${'x'.repeat(200)}`,
      profiles: { profiles: [{ id: 'p1', name: 'Sam', color: '#fff', createdAt: 1, pin: '0000', image: 'https://tracker.example/pixel.png' }] },
      perProfile: { p1: { settings: { sources: { autoPlay: 'first', externalPlayer: 'C:\\Windows\\System32\\cmd.exe' } } }, stranger: { settings: {} }, '../../escape': { home: {} } },
    };
    const clean = checkSharedBackup(readBackup(JSON.stringify(hostile)));
    expect(clean.profiles.profiles).toEqual([{ id: 'p1', name: 'Sam', color: '#fff', createdAt: 1 }]);
    expect(Object.keys(clean.perProfile)).toEqual(['p1']);
    expect(clean.perProfile.p1.settings).toEqual({ sources: { autoPlay: 'first' } });
    expect(clean.sharedBy).toHaveLength(60);
    // A photo that is a picture, not an address, stays.
    const photo = checkSharedBackup(readBackup(JSON.stringify(sent)));
    expect(photo.profiles.profiles[0].image).toBe('data:image/jpeg;base64,AAAA');
  });
});

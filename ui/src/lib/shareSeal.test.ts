import { describe, expect, it } from 'vitest';
import { fromBase64, randomBytes, seal, SealError, toBase64, unseal, type Sealed } from './shareSeal';

const MAX = 48 * 1024 * 1024;

const problemOf = async (run: Promise<unknown>) => {
  try {
    await run;
    return null;
  } catch (e) {
    if (e instanceof SealError) return e.problem;
    throw e;
  }
};

const copy = (s: Sealed): Sealed => JSON.parse(JSON.stringify(s)) as Sealed;

describe('sealing a setup', () => {
  it('opens again with the same key, and only with it', async () => {
    const key = randomBytes(32);
    const text = JSON.stringify({ title: 'Colour: “Amélie” – 日本語 ✓', list: [1, 2, 3] });
    const sealed = await seal(text, key);
    expect(await unseal(copy(sealed), key, MAX)).toBe(text);
    expect(await problemOf(unseal(sealed, randomBytes(32), MAX))).toBe('damaged');
  });

  it('writes nothing readable: not the text, not the key', async () => {
    const key = randomBytes(32);
    const text = 'https://addon.example/SECRET-CONFIG-TOKEN/manifest.json '.repeat(40);
    const sealed = await seal(text, key);
    const sent = JSON.stringify(sealed);
    expect(sent).not.toContain('SECRET');
    expect(sent).not.toContain('addon.example');
    expect(sent).not.toContain(toBase64(key));
    expect(new TextDecoder().decode(fromBase64(sealed.ct))).not.toContain('SECRET');
    // AES-256-GCM, a 128-bit tag, PBKDF2 with 100,000 rounds, compressed.
    expect(sealed.adata[0].slice(2)).toEqual([100000, 256, 128, 'aes', 'gcm', 'zlib']);
    expect(fromBase64(sealed.adata[0][0])).toHaveLength(16);
    expect(fromBase64(sealed.adata[0][1])).toHaveLength(8);
  });

  it('uses a new salt and nonce every time', async () => {
    const key = randomBytes(32);
    const a = await seal('the same text', key);
    const b = await seal('the same text', key);
    expect(a.adata[0][0]).not.toBe(b.adata[0][0]);
    expect(a.adata[0][1]).not.toBe(b.adata[0][1]);
    expect(a.ct).not.toBe(b.ct);
  });

  it('notices any change to the ciphertext', async () => {
    const key = randomBytes(32);
    const sealed = await seal('x'.repeat(5000) + JSON.stringify({ a: 1 }), key);
    const bytes = fromBase64(sealed.ct);
    for (const at of [0, 1, Math.floor(bytes.length / 2), bytes.length - 17, bytes.length - 1]) {
      const changed = bytes.slice();
      changed[at] ^= 1;
      expect(await problemOf(unseal({ ...sealed, ct: toBase64(changed) }, key, MAX)), `byte ${at}`).toBe('damaged');
    }
    expect(await problemOf(unseal({ ...sealed, ct: toBase64(bytes.slice(0, -1)) }, key, MAX))).toBe('damaged');
    expect(await problemOf(unseal({ ...sealed, ct: toBase64(new Uint8Array([...bytes, 0])) }, key, MAX))).toBe('damaged');
    expect(await problemOf(unseal({ ...sealed, ct: '' }, key, MAX))).toBe('damaged');
    expect(await problemOf(unseal({ ...sealed, ct: 'not base64 !!' }, key, MAX))).toBe('damaged');
    expect(await problemOf(unseal({ adata: sealed.adata }, key, MAX))).toBe('damaged');
  });

  it('notices any change to the parameters beside it', async () => {
    const key = randomBytes(32);
    const sealed = await seal('some text', key);
    const change = (edit: (s: Sealed) => void) => {
      const c = copy(sealed);
      edit(c);
      return problemOf(unseal(c, key, MAX));
    };
    // Another nonce or salt of the right size: only the authentication can tell.
    expect(await change((s) => (s.adata[0][0] = toBase64(randomBytes(16))))).toBe('damaged');
    expect(await change((s) => (s.adata[0][1] = toBase64(randomBytes(8))))).toBe('damaged');
    // "Not compressed" would hand the compressed bytes out as text, if the flag were not authenticated.
    expect(await change((s) => (s.adata[0][7] = 'none'))).toBe('damaged');
  });

  it('accepts no parameters but the ones ROVE writes', async () => {
    const key = randomBytes(32);
    const sealed = await seal('some text', key);
    const refused = async (edit: (a: unknown[][]) => void) => {
      const c = copy(sealed) as unknown as { adata: unknown[][]; ct: string };
      edit(c.adata);
      return problemOf(unseal(c, key, MAX));
    };
    expect(await refused((a) => (a[0][2] = 1))).toBe('damaged');
    // Billions of rounds would hang the app: refused before any work is done.
    const started = Date.now();
    expect(await refused((a) => (a[0][2] = 2_000_000_000))).toBe('damaged');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await refused((a) => (a[0][3] = 128))).toBe('damaged');
    expect(await refused((a) => (a[0][4] = 96))).toBe('damaged');
    expect(await refused((a) => (a[0][5] = 'des'))).toBe('damaged');
    expect(await refused((a) => (a[0][6] = 'ctr'))).toBe('damaged');
    expect(await refused((a) => (a[0][7] = 'lzma'))).toBe('damaged');
    expect(await refused((a) => (a[0][0] = toBase64(randomBytes(12))))).toBe('damaged');
    expect(await refused((a) => (a[0][0] = 5))).toBe('damaged');
    expect(await refused((a) => a[0].push('extra'))).toBe('damaged');
    expect(await refused((a) => ((a as unknown[])[1] = 'markdown'))).toBe('damaged');
    expect(await refused((a) => ((a as unknown[])[3] = 1))).toBe('damaged');
    expect(await problemOf(unseal({ adata: 'nonsense', ct: sealed.ct }, key, MAX))).toBe('damaged');
    expect(await problemOf(unseal({ adata: null, ct: sealed.ct }, key, MAX))).toBe('damaged');
  });

  it('stops unpacking at the size cap', async () => {
    const key = randomBytes(32);
    // Five megabytes that compress to a few kilobytes: the cap has to count what comes out.
    const text = 'a'.repeat(5 * 1024 * 1024);
    const sealed = await seal(text, key);
    expect(sealed.ct.length).toBeLessThan(20_000);
    expect(await problemOf(unseal(sealed, key, 1024 * 1024))).toBe('too-large');
    expect(await unseal(sealed, key, 6 * 1024 * 1024)).toHaveLength(text.length);
    // And before unpacking: ciphertext that is itself over the cap.
    const noise = toBase64(randomBytes(60_000));
    expect(await problemOf(unseal(await seal(noise, key), key, 10_000))).toBe('too-large');
  });

  it('opens only text sealed the way ROVE seals it', async () => {
    const key = randomBytes(32);
    const sealed = await seal('text', key);
    expect(await unseal(sealed, key, MAX)).toBe('text');
    expect(await seal('', key).then((s) => unseal(s, key, MAX))).toBe('');
    await expect(seal('text', randomBytes(16))).rejects.toThrow();
  });

  it('keeps a setup the size of a real one small enough to send', async () => {
    // Made-up collections, about as large as the ones ROVE ships with (1.6 MB of JSON), with
    // random image addresses so they compress no better than real ones.
    const id = (n: number) => toBase64(randomBytes(n)).replace(/[+/=]/g, 'x');
    const collections: unknown[] = [];
    let size = 0;
    while (size < 1_600_000) {
      const c = {
        id: `collection-${id(9)}`,
        title: `Collection ${collections.length}`,
        viewMode: 'TABBED_GRID',
        folders: Array.from({ length: 12 }, (_, f) => ({
          id: `folder-${id(9)}`,
          title: `Folder ${f}`,
          tileShape: 'POSTER',
          coverImageUrl: `https://images.example/t/p/w500/${id(20)}.jpg`,
          heroBackdropUrl: `https://images.example/t/p/original/${id(20)}.jpg`,
          sources: [{ provider: 'tmdb', tmdbSourceType: 'DISCOVER', mediaType: 'movie', sortBy: 'popularity.desc', filters: { with_genres: String(f), with_companies: id(4) } }],
        })),
      };
      collections.push(c);
      size += JSON.stringify(c).length;
    }
    const text = JSON.stringify({ collections });
    const key = randomBytes(32);
    const sealed = await seal(text, key);
    expect(text.length).toBeGreaterThan(1_600_000);
    // Under a quarter of privatebin.net's limit, the smaller of the two services.
    expect(sealed.ct.length).toBeLessThan(475_000);
    expect(await unseal(sealed, key, MAX)).toBe(text);
  });
});

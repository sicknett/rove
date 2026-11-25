// Sealing a shared setup before it leaves the PC, and opening one that came back.
//
// The text is compressed, then encrypted with AES-256-GCM (Web Crypto) under a random 256-bit
// key that is only ever written into the share code. The sealed form is the one PrivateBin
// services store (their "version 2" documents), because those services are where the copy is
// kept: the key is stretched with PBKDF2 and a random salt, and the parameters travel beside the
// ciphertext and are authenticated with it, so changing either is noticed.

const ITERATIONS = 100_000;
const IV_BYTES = 16;
const SALT_BYTES = 8;

/** `[[iv, salt, iterations, key bits, tag bits, cipher, mode, compression], format, discussion, burn]` */
export type SealParams = [[string, string, number, number, number, string, string, string], string, number, number];

export interface Sealed {
  adata: SealParams;
  /** The ciphertext, base 64. */
  ct: string;
}

export type SealProblem = 'damaged' | 'too-large';

export class SealError extends Error {
  constructor(readonly problem: SealProblem, message: string) {
    super(message);
    this.name = 'SealError';
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decompresses, giving up as soon as more than `maxBytes` have come out. */
async function inflate(bytes: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SealError('too-large', 'What is inside is larger than a ROVE setup can be.');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function aesKey(key: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', key, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const utf8 = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

export async function seal(text: string, key: Uint8Array): Promise<Sealed> {
  if (key.length !== 32) throw new Error('a key is 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const salt = randomBytes(SALT_BYTES);
  const adata: SealParams = [[toBase64(iv), toBase64(salt), ITERATIONS, 256, 128, 'aes', 'gcm', 'zlib'], 'plaintext', 0, 0];
  const plain = await deflate(utf8(JSON.stringify({ paste: text })));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(JSON.stringify(adata)), tagLength: 128 }, await aesKey(new Uint8Array(key), salt, ITERATIONS), plain);
  return { adata, ct: toBase64(new Uint8Array(ct)) };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The parameters as this ROVE writes them, or null. What came back from a service is not
 * trusted: only these exact choices are accepted, so nothing it sends can ask for a weaker
 * cipher or for hours of key stretching.
 */
function readParams(adata: unknown): { iv: Uint8Array<ArrayBuffer>; salt: Uint8Array<ArrayBuffer>; compressed: boolean } | null {
  if (!Array.isArray(adata) || adata.length !== 4 || !Array.isArray(adata[0]) || adata[0].length !== 8) return null;
  const [iv, salt, iterations, keyBits, tagBits, cipher, mode, compression] = adata[0] as unknown[];
  if (typeof iv !== 'string' || typeof salt !== 'string' || !BASE64.test(iv) || !BASE64.test(salt) || iv.length > 32 || salt.length > 32) return null;
  if (iterations !== ITERATIONS || keyBits !== 256 || tagBits !== 128 || cipher !== 'aes' || mode !== 'gcm') return null;
  if (compression !== 'zlib' && compression !== 'none') return null;
  if (adata[1] !== 'plaintext' || adata[2] !== 0 || adata[3] !== 0) return null;
  const ivBytes = fromBase64(iv);
  const saltBytes = fromBase64(salt);
  if (ivBytes.length !== IV_BYTES || saltBytes.length !== SALT_BYTES) return null;
  return { iv: ivBytes, salt: saltBytes, compressed: compression === 'zlib' };
}

const DAMAGED = 'The copy this code points at could not be opened: it is damaged, or it is not the one this code was made for.';

/**
 * Opens a sealed text. Throws a SealError when the parameters are not ROVE's, when the key does
 * not fit or a single bit was changed (AES-GCM checks every byte, parameters included), or when
 * what comes out is larger than `maxPlainBytes`.
 */
export async function unseal(sealed: { adata?: unknown; ct?: unknown }, key: Uint8Array, maxPlainBytes: number): Promise<string> {
  const params = readParams(sealed.adata);
  if (!params || typeof sealed.ct !== 'string' || !BASE64.test(sealed.ct)) throw new SealError('damaged', DAMAGED);
  let plain: Uint8Array<ArrayBuffer>;
  try {
    const aes = await aesKey(new Uint8Array(key), params.salt, ITERATIONS);
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: params.iv, additionalData: utf8(JSON.stringify(sealed.adata)), tagLength: 128 }, aes, fromBase64(sealed.ct)));
  } catch {
    throw new SealError('damaged', DAMAGED);
  }
  if (plain.length > maxPlainBytes) throw new SealError('too-large', 'What is inside is larger than a ROVE setup can be.');
  // From here on the bytes are ones the holder of the key wrote.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(params.compressed ? await inflate(plain, maxPlainBytes) : plain);
  } catch (e) {
    if (e instanceof SealError) throw e;
    throw new SealError('damaged', DAMAGED);
  }
  let paste: unknown;
  try {
    paste = (JSON.parse(text) as { paste?: unknown })?.paste;
  } catch {
    throw new SealError('damaged', DAMAGED);
  }
  if (typeof paste !== 'string') throw new SealError('damaged', DAMAGED);
  return paste;
}

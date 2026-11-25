// The code a shared setup travels as. It says which service holds the encrypted copy, which
// copy it is there, and carries the key that opens it. Nothing else knows the key.
//
//   1A9F3-K2…  (45 letters and digits, shown in nine groups of five)
//   │└ which service holds the copy (see SHARE_HOSTS in share.ts)
//   └ the format's version
//   then 39 characters for the copy's id (8 bytes) and the secret (16 random bytes) that the
//   encryption key is made from (share.ts),
//   then 4 check characters, so a mistyped code is caught before anything is fetched.
//
// The alphabet is Crockford's base 32: no I, L, O or U, and upper or lower case mean the same,
// so a code survives being read out or retyped. A typed I or L counts as 1 and an O as 0.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CODE_VERSION = '1';
const ID_BYTES = 8;
/** The secret a code carries: 128 random bits, which is what the copy's secrecy rests on. */
export const KEY_BYTES = 16;
const BODY_CHARS = Math.ceil(((ID_BYTES + KEY_BYTES) * 8) / 5);
const CHECK_CHARS = 4;
/** Letters and digits in a code, without the hyphens. */
export const CODE_LENGTH = 2 + BODY_CHARS + CHECK_CHARS;

export interface ShareCode {
  /** One character naming the service that holds the copy. */
  host: string;
  /** The copy's id there: 16 lower-case hex digits. */
  id: string;
  /** The secret the copy's encryption key is made from (KEY_BYTES of it). */
  key: Uint8Array;
}

export type CodeProblem = 'empty' | 'characters' | 'newer' | 'length' | 'mistyped';

/** A code that cannot be used, with a sentence that says why. */
export class ShareCodeError extends Error {
  constructor(readonly problem: CodeProblem, message: string) {
    super(message);
    this.name = 'ShareCodeError';
  }
}

function toBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let held = 0;
  for (const b of bytes) {
    held = (held << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(held >> bits) & 31];
    }
    held &= (1 << bits) - 1;
  }
  if (bits) out += ALPHABET[(held << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const ch of text) {
    held = (held << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 255;
      held &= (1 << bits) - 1;
    }
  }
  return out;
}

/** CRC-32 of the characters before it, cut to 20 bits: four characters of the alphabet. */
function checkOf(text: string): string {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i);
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  let out = '';
  for (let shift = 15; shift >= 0; shift -= 5) out += ALPHABET[(crc >>> shift) & 31];
  return out;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** What was typed, as the characters a code is made of: no spaces or hyphens, look-alikes mapped. */
export function tidyCode(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s\-–—_.:]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** Groups of five with hyphens, as codes are shown. */
export function groupCode(code: string): string {
  return code.replace(/(.{5})(?=.)/g, '$1-');
}

export function formatShareCode({ host, id, key }: ShareCode): string {
  if (host.length !== 1 || !ALPHABET.includes(host)) throw new Error('a host is one character of the code alphabet');
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('an id is 16 hex digits');
  if (key.length !== KEY_BYTES) throw new Error(`a key is ${KEY_BYTES} bytes`);
  const bytes = new Uint8Array(ID_BYTES + KEY_BYTES);
  for (let i = 0; i < ID_BYTES; i++) bytes[i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
  bytes.set(key, ID_BYTES);
  const body = CODE_VERSION + host + toBase32(bytes);
  return groupCode(body + checkOf(body));
}

/**
 * Reads a typed or pasted code. Throws a ShareCodeError that says what is wrong with it. The id
 * that comes out is rebuilt from the code's bytes, so it is always 16 hex digits and nothing a
 * code says can end up as anything else in an address.
 */
export function parseShareCode(text: string): ShareCode {
  const code = tidyCode(text);
  if (!code) throw new ShareCodeError('empty', 'Enter the code you were given.');
  if ([...code].some((ch) => !ALPHABET.includes(ch))) {
    throw new ShareCodeError('characters', 'A code is made of letters and digits only, without the letter U. Check it against the one you were given.');
  }
  // The version comes first: a later format may be longer or shorter than this one.
  if (code[0] !== CODE_VERSION) {
    throw new ShareCodeError('newer', 'This ROVE cannot read that code. If it was typed correctly it was made by a newer ROVE: update this one and try again.');
  }
  if (code.length !== CODE_LENGTH) {
    throw new ShareCodeError('length', `A code has ${CODE_LENGTH} letters and digits. This one has ${code.length}: ${code.length < CODE_LENGTH ? 'some of it is missing' : 'there is something extra in it'}.`);
  }
  const body = code.slice(0, -CHECK_CHARS);
  if (checkOf(body) !== code.slice(-CHECK_CHARS)) {
    throw new ShareCodeError('mistyped', 'That code has a mistake in it: a wrong or swapped character. Check it against the one you were given.');
  }
  const bytes = fromBase32(body.slice(2));
  return { host: code[1], id: hex(bytes.subarray(0, ID_BYTES)), key: bytes.slice(ID_BYTES) };
}

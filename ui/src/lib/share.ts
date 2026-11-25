// Sharing a setup with a code: one ROVE makes a code, a friend types it into theirs and gets
// the same addons, profiles, settings, Home layout and collections.
//
// What travels is a ROVE backup (backup.ts), sealed on this PC (shareSeal.ts) and kept for a few
// days by a public PrivateBin service: a pastebin whose whole purpose is holding text it cannot
// read. The service sees ciphertext, a size and an IP address. The key is only in the code
// (shareCode.ts), so whoever has the code can read the copy, and nobody else can.
//
// A code can only ever make ROVE talk to the services listed here: it names one by a single
// character, and the copy's id is rebuilt from the code's bytes as 16 hex digits.

import { makeBackup, readBackup, restoreBackup, type Backup } from './backup';
import { nativeFetch } from './native';
import { formatShareCode, KEY_BYTES, parseShareCode, ShareCodeError } from './shareCode';
import { randomBytes, seal, SealError, unseal, type Sealed } from './shareSeal';
import { MAX_PROFILES, useProfiles } from '../state/profiles';

export interface ShareHost {
  /** The character that names it in a code. Never reuse one: codes already given out point at it. */
  letter: string;
  /** How the interface names it. */
  name: string;
  /** Where its PrivateBin answers. */
  url: string;
  /** How long a copy is kept: the service's own name for the period, and its length. */
  keep: { id: string; seconds: number };
  /** The same for a copy with sign-ins and keys in it, which should not lie around. */
  keepWithKeys: { id: string; seconds: number };
  /** The largest ciphertext (base 64 characters) sent to it, under what it was seen to accept. */
  maxCipherChars: number;
}

const DAY = 86_400;

/**
 * In the order they are tried. Both were checked with made-up data in November 2026:
 * paste.unredacted.org refuses more than 10 MiB and offers a day or a week; privatebin.net, the
 * PrivateBin project's own service, took 2 MB and refused 4 MB, and offers three days at most.
 * A service asked for a period it does not offer uses its own default, so the time a code
 * really has left is read back from the service, never assumed.
 */
export const SHARE_HOSTS: ShareHost[] = [
  { letter: 'A', name: 'paste.unredacted.org', url: 'https://paste.unredacted.org/', keep: { id: '1week', seconds: 7 * DAY }, keepWithKeys: { id: '1day', seconds: DAY }, maxCipherChars: 8_000_000 },
  { letter: 'B', name: 'privatebin.net', url: 'https://privatebin.net/', keep: { id: '3day', seconds: 3 * DAY }, keepWithKeys: { id: '1day', seconds: DAY }, maxCipherChars: 1_900_000 },
];

/** An answer from a service larger than this is not read, let alone decrypted. */
export const MAX_ANSWER_CHARS = 12 * 1024 * 1024;
/** A setup that unpacks to more than this is refused. Real ones are a few megabytes. */
export const MAX_SETUP_BYTES = 48 * 1024 * 1024;

export type ShareProblem = 'network' | 'refused' | 'gone' | 'too-large' | 'newer' | 'not-a-setup';

/** Sharing or using a code failed, with a sentence for the user. */
export class ShareError extends Error {
  constructor(readonly problem: ShareProblem, message: string) {
    super(message);
    this.name = 'ShareError';
  }
}

/** A sentence for whatever went wrong while making or using a code. */
export function shareMessage(e: unknown): string {
  if (e instanceof ShareError || e instanceof ShareCodeError || e instanceof SealError) return e.message;
  return 'Something went wrong. Nothing on this PC was changed.';
}

// ---------- What is shared ----------

export interface ShareSummary {
  addons: number;
  /** Profile names, in order. */
  profiles: string[];
  collections: number;
  /** Whether sign-ins or API keys are inside. */
  keys: boolean;
  sharedBy: string | null;
  /** When it was made (ms), if it says. */
  createdAt: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function summarise(b: Backup): ShareSummary {
  let collections = 0;
  let keys = !!(b.keys?.tmdbApiKey || b.keys?.mdblistApiKey || b.keys?.ai || b.servers);
  for (const entry of Object.values(b.perProfile ?? {})) {
    const doc = entry.collections;
    const list = Array.isArray(doc) ? doc : isObject(doc) && Array.isArray(doc.collections) ? doc.collections : [];
    collections += list.length;
    if (entry.tracker || entry.pmdbKey) keys = true;
  }
  const made = Date.parse(b.createdAt);
  return { addons: b.addons.length, profiles: b.profiles.profiles.map((p) => p.name), collections, keys, sharedBy: b.sharedBy ?? null, createdAt: Number.isNaN(made) ? null : made };
}

/** Takes the external player out of a profile's settings: it is a program's path on one PC. */
function withoutExternalPlayer(settings: unknown): unknown {
  if (!isObject(settings) || !isObject(settings.sources) || !('externalPlayer' in settings.sources)) return settings;
  const { externalPlayer: _dropped, ...sources } = settings.sources;
  return { ...settings, sources };
}


/**
 * The 256-bit key a copy is sealed under, made from the secret its code carries. The code stays
 * short enough to pass on (the secret is 128 random bits), and the cipher still gets a full key.
 */
export async function sealingKey(secret: Uint8Array): Promise<Uint8Array> {
  const label = new TextEncoder().encode('ROVE setup share key 1');
  const input = new Uint8Array(label.length + secret.length);
  input.set(label);
  input.set(secret, label.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/**
 * The backup a code carries. It is the backup Settings → Data saves, without what belongs to
 * this PC and its people rather than to the setup: profile PINs, recent searches, the audio and
 * subtitle choices remembered per show (they name what was watched), and the external player's
 * path. Sign-ins and keys are in it only when asked for. Addon links always are, and a link can
 * carry its addon's configuration, keys included: that is how the friend gets the same addons.
 */
export async function makeShareBackup(includeKeys: boolean): Promise<Backup> {
  const b = await makeBackup(includeKeys);
  b.profiles = { ...b.profiles, profiles: b.profiles.profiles.map(({ pin: _pin, ...p }) => p) };
  for (const entry of Object.values(b.perProfile)) {
    delete entry.searches;
    delete entry.tracks;
    if (entry.settings !== undefined) entry.settings = withoutExternalPlayer(entry.settings);
  }
  const { profiles, activeId } = useProfiles.getState();
  const name = profiles.find((p) => p.id === activeId)?.name.trim();
  // "Me" is the name every first profile starts with: it says nothing about who is sharing.
  if (name && name !== 'Me') b.sharedBy = name.slice(0, 60);
  return b;
}

const NOT_A_SETUP = 'The code opened, but what it holds is not a setup this ROVE can use. It may have been made by a newer ROVE: update this one and try again.';
const PROFILE_ID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Checks a setup that came from someone else, beyond what a backup file gets, and takes out what
 * a code has no business setting on this PC: a PIN (it would lock the profile with a number only
 * the sender knows), a profile photo that is a web address, and the external player (a program
 * this PC would then start). Throws when the profiles or addons are not what ROVE saves.
 */
export function checkSharedBackup(b: Backup): Backup {
  function fail(): never {
    throw new ShareError('not-a-setup', NOT_A_SETUP);
  }
  const profiles = b.profiles.profiles;
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > MAX_PROFILES) fail();
  const ids = new Set<string>();
  const cleanProfiles = profiles.map((p) => {
    if (!isObject(p) || typeof p.id !== 'string' || !PROFILE_ID.test(p.id) || ids.has(p.id)) fail();
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60 || typeof p.color !== 'string' || p.color.length > 40) fail();
    ids.add(p.id);
    const { pin: _pin, image, ...rest } = p;
    return typeof image === 'string' && image.startsWith('data:image/') ? { ...rest, image } : rest;
  });
  for (const a of b.addons) {
    if (!isObject(a) || typeof a.url !== 'string' || !/^https?:\/\//i.test(a.url) || !isObject(a.manifest)) fail();
    if (typeof a.manifest.id !== 'string' || typeof a.manifest.name !== 'string') fail();
  }
  if (b.perProfile !== undefined && !isObject(b.perProfile)) fail();
  const perProfile: Backup['perProfile'] = {};
  for (const [id, entry] of Object.entries(b.perProfile ?? {})) {
    // Documents for a profile the setup does not have would be written and never used.
    if (!ids.has(id) || !isObject(entry)) continue;
    perProfile[id] = entry.settings === undefined ? entry : { ...entry, settings: withoutExternalPlayer(entry.settings) };
  }
  const sharedBy = typeof b.sharedBy === 'string' && b.sharedBy.trim() ? b.sharedBy.trim().slice(0, 60) : undefined;
  return { ...b, profiles: { ...b.profiles, profiles: cleanProfiles }, perProfile, sharedBy };
}

// ---------- Talking to a service ----------

interface Answer {
  status?: unknown;
  message?: unknown;
  id?: unknown;
  deletetoken?: unknown;
  adata?: unknown;
  ct?: unknown;
  meta?: unknown;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

async function ask(host: ShareHost, query: string, body: string | undefined, signal?: AbortSignal): Promise<Answer> {
  let res;
  try {
    res = await nativeFetch(
      {
        url: host.url + query,
        method: body === undefined ? 'GET' : 'POST',
        // The first header is how a PrivateBin service is asked for JSON rather than its page.
        headers: { 'X-Requested-With': 'JSONHttpRequest', Accept: 'application/json', 'Accept-Language': 'en', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body,
        timeoutMs: 90_000,
      },
      signal,
    );
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ShareError('network', `${host.name} could not be reached. Check the internet connection and try again.`);
  }
  // Wherever the service may have sent the request on to, an answer from anywhere else is not its answer.
  let from = '';
  try {
    from = new URL(res.url).origin;
  } catch {
    /* not an address at all */
  }
  if (from !== new URL(host.url).origin) throw new ShareError('refused', `${host.name} sent the request somewhere else, so its answer was not used.`);
  if (res.body.length > MAX_ANSWER_CHARS) throw new ShareError('too-large', `${host.name} sent back more than a ROVE setup can be, so it was not opened.`);
  if (res.status === 413) throw new ShareError('too-large', `This setup is too large for ${host.name}.`);
  let answer: unknown;
  try {
    answer = JSON.parse(res.body);
  } catch {
    answer = null;
  }
  if (res.status < 200 || res.status > 299 || !isObject(answer)) {
    throw new ShareError('refused', `${host.name} did not answer as expected (HTTP ${res.status}). Try again in a few minutes.`);
  }
  return answer;
}

const saidBy = (a: Answer) => (typeof a.message === 'string' && a.message.length < 200 ? ` It said: “${a.message}”` : '');

async function upload(host: ShareHost, sealed: Sealed, expire: string, signal?: AbortSignal): Promise<{ id: string; deleteToken: string | null }> {
  const a = await ask(host, '', JSON.stringify({ v: 2, adata: sealed.adata, ct: sealed.ct, meta: { expire } }), signal);
  if (a.status !== 0 || typeof a.id !== 'string' || !/^[0-9a-f]{16}$/.test(a.id)) {
    throw new ShareError('refused', `${host.name} did not take the copy.${saidBy(a)}`);
  }
  return { id: a.id, deleteToken: typeof a.deletetoken === 'string' && /^[0-9a-f]{16,128}$/.test(a.deletetoken) ? a.deletetoken : null };
}

async function download(host: ShareHost, id: string, signal?: AbortSignal): Promise<{ sealed: { adata: unknown; ct: unknown }; secondsLeft: number | null }> {
  const a = await ask(host, `?${id}`, undefined, signal);
  // A PrivateBin service gives one answer for a copy it never had, one that ran out and one that was deleted.
  if (a.status !== 0) throw new ShareError('gone', `There is nothing at ${host.name} for this code any more. Codes stop working after a few days, or when the person who made one stops sharing. Ask them for a new one.`);
  const left = isObject(a.meta) ? a.meta.time_to_live : null;
  return { sealed: { adata: a.adata, ct: a.ct }, secondsLeft: typeof left === 'number' && Number.isFinite(left) && left > 0 ? left : null };
}

/** Deletes the copy a code points at, so the code stops working now. */
export async function stopSharing(share: Pick<CreatedShare, 'host' | 'id' | 'deleteToken'>, signal?: AbortSignal): Promise<void> {
  if (!share.deleteToken) throw new ShareError('refused', `${share.host.name} gave no way to delete the copy early. It is deleted when the code runs out.`);
  const a = await ask(share.host, '', JSON.stringify({ pasteid: share.id, deletetoken: share.deleteToken }), signal);
  if (a.status !== 0) throw new ShareError('refused', `${share.host.name} did not delete the copy.${saidBy(a)}`);
}

// ---------- Making and using a code ----------

export interface CreatedShare {
  code: string;
  host: ShareHost;
  id: string;
  /** Lets this ROVE delete the copy early. Kept in memory only. */
  deleteToken: string | null;
  /** When the service deletes the copy (ms). */
  expiresAt: number;
  summary: ShareSummary;
}

const megabytes = (chars: number) => `${(chars / 1_000_000).toFixed(1)} MB`;

/**
 * Seals this PC's setup, hands the sealed copy to the first service that takes it, reads it back
 * the way the friend's ROVE will, and returns the code. Nothing is uploaded that the read-back
 * did not prove can be opened again.
 */
export async function createShare(includeKeys: boolean, signal?: AbortSignal): Promise<CreatedShare> {
  const backup = await makeShareBackup(includeKeys);
  const text = JSON.stringify(backup);
  const secret = randomBytes(KEY_BYTES);
  const key = await sealingKey(secret);
  const sealed = await seal(text, key);
  const hosts = SHARE_HOSTS.filter((h) => sealed.ct.length <= h.maxCipherChars);
  if (!hosts.length) {
    const most = Math.max(...SHARE_HOSTS.map((h) => h.maxCipherChars));
    throw new ShareError('too-large', `This setup is too large to share with a code: ${megabytes(sealed.ct.length)} once sealed, and the most a code can carry is ${megabytes(most)}. Use Back up instead and send the file.`);
  }
  let failure: unknown;
  for (const host of hosts) {
    const keep = includeKeys ? host.keepWithKeys : host.keep;
    try {
      const { id, deleteToken } = await upload(host, sealed, keep.id, signal);
      try {
        const back = await download(host, id, signal);
        if ((await unseal(back.sealed, key, MAX_SETUP_BYTES)) !== text) throw new ShareError('refused', `${host.name} did not keep the copy as it was sent.`);
        // A service that no longer offers the period asked for falls back to its own, which may be far longer.
        if (back.secondsLeft !== null && back.secondsLeft > keep.seconds + 3600) throw new ShareError('refused', `${host.name} would keep the copy longer than ROVE asked for, so it was deleted there again.`);
        return { code: formatShareCode({ host: host.letter, id, key: secret }), host, id, deleteToken, expiresAt: Date.now() + (back.secondsLeft ?? keep.seconds) * 1000, summary: summarise(backup) };
      } catch (e) {
        // A copy that cannot be read back is of no use to anyone: it does not stay.
        if (deleteToken) await stopSharing({ host, id, deleteToken }).catch(() => undefined);
        throw e;
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      failure = e;
    }
  }
  throw failure;
}

export interface FetchedShare {
  backup: Backup;
  summary: ShareSummary;
  host: ShareHost;
  /** When the code stops working (ms), when the service says. */
  expiresAt: number | null;
}

/** Fetches and opens the setup a code points at. Changes nothing on this PC. */
export async function fetchShare(codeText: string, signal?: AbortSignal): Promise<FetchedShare> {
  const code = parseShareCode(codeText);
  const host = SHARE_HOSTS.find((h) => h.letter === code.host);
  if (!host) throw new ShareError('newer', 'This code points at a service this ROVE does not know. It was made by a newer ROVE: update this one and try again.');
  const { sealed, secondsLeft } = await download(host, code.id, signal);
  const text = await unseal(sealed, await sealingKey(code.key), MAX_SETUP_BYTES);
  let backup: Backup;
  try {
    backup = checkSharedBackup(readBackup(text));
  } catch {
    throw new ShareError('not-a-setup', NOT_A_SETUP);
  }
  return { backup, summary: summarise(backup), host, expiresAt: secondsLeft === null ? null : Date.now() + secondsLeft * 1000 };
}

/**
 * Replaces this PC's setup with a fetched one, exactly as restoring a backup does (the page has
 * to reload afterwards). Only ever called after the user saw what is inside and said yes.
 */
export const applyShare = (share: FetchedShare) => restoreBackup(share.backup);

/** Profiles on this PC that the setup does not have: they go, and what they watched goes out of sight with them. */
export function profilesReplaced(share: FetchedShare, here: { id: string; name: string }[]): string[] {
  const kept = new Set(share.backup.profiles.profiles.map((p) => p.id));
  return here.filter((p) => !kept.has(p.id)).map((p) => p.name);
}

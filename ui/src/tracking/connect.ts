// Signing in to each tracker. Each returns once the account is saved and the first sync started.

import { mdblistValidate } from './adapters/mdblist';
import { simklPollDevice, simklStartDevice } from './adapters/simkl';
import { traktPollDevice, traktStartDevice } from './adapters/trakt';
import { pmdb } from './pmdb';
import { useTracker } from './sync';
import type { TrackerAccount } from './types';

export async function connectPmdb(apiKey: string) {
  const key = apiKey.trim();
  if (!(await pmdb.validate(key))) throw new Error('PublicMetaDB did not accept that key.');
  await useTracker.getState().setAccount({ provider: 'pmdb', apiKey: key });
}

export async function connectMdblist(apiKey: string) {
  const key = apiKey.trim();
  if (!(await mdblistValidate(key))) throw new Error('MDBList did not accept that key.');
  await useTracker.getState().setAccount({ provider: 'mdblist', apiKey: key });
}

/** A short code the user types on the tracker's site, and a wait for them to approve it. */
export interface DeviceSignIn {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  /** Resolves true once signed in, false if the code expired or was refused. */
  done: Promise<boolean>;
  cancel: () => void;
}

export async function startDeviceSignIn(provider: 'trakt' | 'simkl'): Promise<DeviceSignIn> {
  const ctrl = new AbortController();
  let wait: Promise<TrackerAccount | null>;
  let info: { userCode: string; verificationUrl: string; expiresAt: number };
  if (provider === 'trakt') {
    const code = await traktStartDevice();
    info = code;
    wait = traktPollDevice(code, ctrl.signal);
  } else {
    const code = await simklStartDevice();
    info = code;
    wait = simklPollDevice(code, ctrl.signal);
  }
  const done = wait.then(async (account) => {
    if (!account || ctrl.signal.aborted) return false;
    await useTracker.getState().setAccount(account);
    return true;
  });
  return { ...info, done, cancel: () => ctrl.abort() };
}

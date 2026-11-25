// Signs a release for the in-app updater and writes dist/latest.json.
//   node tools/sign-release.mjs <version> <setup.exe> <download url> [notes file]
// The private key stays on the publisher's PC: %USERPROFILE%\.rove\update-signing-key.pem, or the
// file named by ROVE_UPDATE_KEY. Its public half is in shell/src/update.rs (RELEASE_KEY); the app
// refuses any update whose signature that key does not confirm.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [version, setup, url, notesFile] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !setup || !url) {
  console.error('usage: node tools/sign-release.mjs <version> <setup.exe> <download url> [notes file]');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keyPath = process.env.ROVE_UPDATE_KEY || join(homedir(), '.rove', 'update-signing-key.pem');
let key;
try {
  key = createPrivateKey(readFileSync(keyPath));
} catch {
  console.error(`The release signing key was not found at ${keyPath}. Without it this release cannot be installed by the Update button.`);
  process.exit(1);
}

// The app must be able to check this release: the key in the shell has to be this key's public half.
const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
const publicHex = der.subarray(der.length - 32).toString('hex');
const embedded = /RELEASE_KEY: &str = "([0-9a-f]{64})"/.exec(readFileSync(join(root, 'shell', 'src', 'update.rs'), 'utf8'))?.[1];
if (embedded !== publicHex) {
  console.error('This signing key does not match RELEASE_KEY in shell/src/update.rs; installed copies would refuse the update.');
  process.exit(1);
}

const sha256 = createHash('sha256').update(readFileSync(setup)).digest('hex');
const text = Buffer.from(`ROVE update\n${version}\n${sha256}`);
const signature = sign(null, text, key).toString('hex');
if (!verify(null, text, createPublicKey(key), Buffer.from(signature, 'hex'))) {
  console.error('The signature did not verify.');
  process.exit(1);
}

const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : undefined;
const out = join(root, 'dist', 'latest.json');
writeFileSync(out, `${JSON.stringify({ version, notes, url, sha256, signature }, null, 2)}\n`);
console.log(`signed ${version}: ${out}`);

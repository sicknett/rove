//! In-app updates: downloads a newer Setup from ROVE's releases, checks it, and hands it to the
//! app to run on the way out.
//!
//! Nothing downloaded is trusted because of where it came from. The page says which version it
//! wants; this module only accepts a file from the releases of [`REPO`], whose SHA-256 matches and
//! whose (version, hash) pair carries a signature made with the release key. The matching public
//! key is below; the private key never leaves the publisher's PC. A compromised download host can
//! therefore not make ROVE run something else.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Where releases are published: `https://github.com/<REPO>/releases`.
pub const REPO: &str = "sicknett/rove";

/// Ed25519 public key of the release signing key (raw, hex).
const RELEASE_KEY: &str = "e9fa9a69c3aebd65ce12ac09b075b0e7bb5ce2c374ea7f6250895f2a14fdeb54";

/// A Setup is about 36 MB; anything far beyond that is not one.
const MAX_SIZE: u64 = 400 * 1024 * 1024;

static RECEIVED: AtomicU64 = AtomicU64::new(0);
static TOTAL: AtomicU64 = AtomicU64::new(0);
/// The checked Setup waiting to be run, with its version.
static READY: Mutex<Option<(String, PathBuf)>> = Mutex::new(None);
/// One download at a time.
static BUSY: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
pub struct Wanted {
    version: String,
    url: String,
    sha256: String,
    signature: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// What the release key signs: the version and the file's hash, so neither can be swapped.
pub fn signed_text(version: &str, sha256: &str) -> String {
    format!("ROVE update\n{version}\n{}", sha256.to_ascii_lowercase())
}

fn signature_ok(key_hex: &str, version: &str, sha256: &str, signature_hex: &str) -> bool {
    let (Some(key), Some(sig)) = (unhex(key_hex), unhex(signature_hex)) else { return false };
    let Ok(key) = <[u8; 32]>::try_from(key.as_slice()) else { return false };
    let (Ok(key), Ok(sig)) = (VerifyingKey::from_bytes(&key), Signature::from_slice(&sig)) else { return false };
    key.verify_strict(signed_text(version, sha256).as_bytes(), &sig).is_ok()
}

/// Versions are `major.minor.patch`; anything else is refused (the value ends up in a file name).
fn version_ok(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()))
}

fn url_ok(url: &str) -> bool {
    url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) && !url.contains("..") && url.ends_with(".exe")
}

/// Downloads and checks the Setup the page asked for. Blocks until done.
pub fn download(dir: &Path, agent: &ureq::Agent, wanted: &Wanted) -> Result<(), String> {
    let Ok(_one) = BUSY.try_lock() else { return Err("An update is already downloading.".into()) };
    if !version_ok(&wanted.version) || !url_ok(&wanted.url) {
        return Err("That is not a ROVE release.".into());
    }
    // Checked before a single byte is fetched: an unsigned release is never downloaded.
    if !signature_ok(RELEASE_KEY, &wanted.version, &wanted.sha256, &wanted.signature) {
        log::warn!("update {}: the release signature does not match", wanted.version);
        return Err("This update is not signed by ROVE's release key, so it was not downloaded.".into());
    }
    if let Some((version, path)) = READY.lock().unwrap().as_ref() {
        if version == &wanted.version && path.is_file() {
            return Ok(());
        }
    }

    let folder = dir.join("updates");
    // Old downloads are of no use once a newer one is wanted.
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not make room for the update: {e}"))?;
    let part = folder.join("download.part");
    let target = folder.join(format!("ROVE-Setup-{}.exe", wanted.version));

    RECEIVED.store(0, Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    log::info!("update {}: downloading", wanted.version);
    let response = agent
        .get(&wanted.url)
        .timeout(Duration::from_secs(15 * 60))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("The download failed (HTTP {code})."),
            ureq::Error::Transport(t) => format!("The download failed: {}", t.kind()),
        })?;
    let total = response.header("content-length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    if total > MAX_SIZE {
        return Err("The download is far larger than a ROVE Setup.".into());
    }
    TOTAL.store(total, Ordering::Relaxed);

    let mut reader = response.into_reader().take(MAX_SIZE + 1);
    let mut file = std::fs::File::create(&part).map_err(|e| format!("Could not save the update: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut received = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("The download was interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| format!("Could not save the update: {e}"))?;
        received += n as u64;
        RECEIVED.store(received, Ordering::Relaxed);
    }
    drop(file);
    if received > MAX_SIZE {
        let _ = std::fs::remove_file(&part);
        return Err("The download is far larger than a ROVE Setup.".into());
    }
    let got = hex(&hasher.finalize());
    if !got.eq_ignore_ascii_case(&wanted.sha256) {
        let _ = std::fs::remove_file(&part);
        log::warn!("update {}: the file does not match its published hash", wanted.version);
        return Err("The downloaded file does not match the release, so it was thrown away.".into());
    }
    std::fs::rename(&part, &target).map_err(|e| format!("Could not save the update: {e}"))?;
    log::info!("update {}: downloaded and checked ({received} bytes)", wanted.version);
    *READY.lock().unwrap() = Some((wanted.version.clone(), target));
    Ok(())
}

/// Bytes received and expected for the download in flight, and the version that is ready to install.
pub fn progress() -> (u64, u64, Option<String>) {
    let ready = READY.lock().unwrap().as_ref().filter(|(_, p)| p.is_file()).map(|(v, _)| v.clone());
    (RECEIVED.load(Ordering::Relaxed), TOTAL.load(Ordering::Relaxed), ready)
}

/// The checked Setup, if one is waiting.
pub fn ready() -> Option<PathBuf> {
    READY.lock().unwrap().as_ref().map(|(_, p)| p.clone()).filter(|p| p.is_file())
}

/// Starts the Setup as the app leaves. It waits for this copy to be gone, installs over it without
/// questions, and opens ROVE again (see `installer\rove.iss`, the UPDATE parameter).
///
/// Only the update marker is passed: Setup turns itself quiet. An unsigned program that starts an
/// installer with "silent" switches reads as a dropper to Windows Defender's machine-learning
/// check, which then blocks ROVE itself (seen on 2026-11-25, Trojan:Win32/Bearfoos.A!ml).
pub fn run_setup(setup: &Path) {
    match std::process::Command::new(setup).arg("/UPDATE=1").spawn() {
        Ok(_) => log::info!("update: Setup started"),
        Err(e) => log::error!("update: Setup could not be started: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A key pair made for these tests only.
    const TEST_KEY: &str = "03bdb1cb9e01730b734bedc5fbae13e0844f0932feab457caa527b0f66775265";
    const TEST_SIG: &str = "9a84d9c9b6c94c41dc9b2c0d75c0af72dd2b80d7ee56ee76529981a89ea547f048f1b5137a82bba52052215303c7ca0bcfdf9ddfa4c1304f3b3999ae7f2ff201";

    #[test]
    fn accepts_only_release_urls() {
        assert!(url_ok("https://github.com/sicknett/rove/releases/download/v0.2.0/ROVE-Setup-0.2.0.exe"));
        assert!(!url_ok("https://github.com/someone/rove/releases/download/v0.2.0/ROVE-Setup-0.2.0.exe"));
        assert!(!url_ok("http://github.com/sicknett/rove/releases/download/v0.2.0/ROVE-Setup-0.2.0.exe"));
        assert!(!url_ok("https://github.com/sicknett/rove/releases/download/../../evil/x.exe"));
        assert!(!url_ok("https://github.com/sicknett/rove/releases/download/v0.2.0/notes.txt"));
    }

    #[test]
    fn versions_are_three_numbers() {
        assert!(version_ok("0.2.0") && version_ok("12.0.345"));
        assert!(!version_ok("0.2") && !version_ok("0.2.0-beta") && !version_ok("..\\x") && !version_ok("1.2.x"));
    }

    #[test]
    fn a_wrong_or_malformed_signature_is_refused() {
        let sha = "ab".repeat(32);
        assert!(signature_ok(TEST_KEY, "0.2.0", &sha, TEST_SIG));
        // The same signature does not cover another version or another file.
        assert!(!signature_ok(TEST_KEY, "0.2.1", &sha, TEST_SIG));
        assert!(!signature_ok(TEST_KEY, "0.2.0", &"cd".repeat(32), TEST_SIG));
        assert!(!signature_ok(TEST_KEY, "0.2.0", &sha, &"00".repeat(64)));
        assert!(!signature_ok("zz", "0.2.0", &sha, &"00".repeat(64)));
        assert!(!signature_ok(RELEASE_KEY, "0.2.0", &sha, &"00".repeat(64)));
    }
}

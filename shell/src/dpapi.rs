//! Encryption tied to this Windows user account (DPAPI), for addon links and API keys at rest.

use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

/// Extra entropy so other programs using DPAPI for this user cannot open ROVE's blobs by accident.
const ENTROPY: &[u8] = b"ROVE desktop secrets v1";

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
}

fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    // SAFETY: DPAPI filled `out` with a LocalAlloc'd buffer of cbData bytes, freed here.
    unsafe {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as HLOCAL);
        v
    }
}

pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
    let input = blob(plain);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
    };
    (ok != 0).then(|| take(out))
}

pub fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
    let input = blob(sealed);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
    };
    (ok != 0).then(|| take(out))
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        let sealed = super::protect(b"{\"k\":\"secret\"}").unwrap();
        assert!(!sealed.windows(6).any(|w| w == b"secret"));
        assert_eq!(super::unprotect(&sealed).unwrap(), b"{\"k\":\"secret\"}");
    }
}

use super::{Result, SECRET_ERROR};
use zeroize::Zeroizing;

#[cfg(windows)]
fn crypt(input: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len().try_into().map_err(|_| SECRET_ERROR)?,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI owns output until LocalFree. No LOCAL_MACHINE flag: only this Windows user can decrypt.
    let succeeded = unsafe {
        if decrypt {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if succeeded == 0 {
        return Err(SECRET_ERROR.into());
    }
    if output.cbData == 0 || output.pbData.is_null() {
        if !output.pbData.is_null() {
            unsafe {
                LocalFree(output.pbData as *mut _);
            }
        }
        return Err(SECRET_ERROR.into());
    }
    let bytes = unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
    let copied = Zeroizing::new(bytes.to_vec());
    use zeroize::Zeroize;
    bytes.zeroize();
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(copied)
}
#[cfg(not(windows))]
fn crypt(_input: &[u8], _decrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    Err("此版本仅支持 Windows 安全密钥存储。".into())
}
// An encrypted version marker and checksum also reject corrupted plaintext returned by DPAPI.
pub fn protect(input: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    use sha2::{Digest, Sha256};
    let mut envelope = Zeroizing::new(Vec::from(&b"WAB-API-KEY-1\0"[..]));
    envelope.extend_from_slice(&Sha256::digest(input));
    envelope.extend_from_slice(input);
    crypt(&envelope, false)
}
pub fn unprotect(input: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    use sha2::{Digest, Sha256};
    let envelope = crypt(input, true)?;
    const PREFIX: &[u8] = b"WAB-API-KEY-1\0";
    let offset = PREFIX.len() + 32;
    if envelope.len() <= offset || !envelope.starts_with(PREFIX) {
        return Err(SECRET_ERROR.into());
    }
    let plain = &envelope[offset..];
    if Sha256::digest(plain)[..] != envelope[PREFIX.len()..offset] {
        return Err(SECRET_ERROR.into());
    }
    Ok(Zeroizing::new(plain.to_vec()))
}

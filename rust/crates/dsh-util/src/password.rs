//! Argon2id 密码哈希（Go `util.HashPassword/VerifyPassword` 等价）。

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
use base64::Engine;
use rand::RngCore;
use subtle::ConstantTimeEq;

const ARGON_MEMORY: u32 = 64 * 1024; // 64MB
const ARGON_ITERATIONS: u32 = 3;
const ARGON_PARALLELISM: u32 = 2;
const ARGON_KEY_LEN: usize = 32;
const ARGON_SALT_LEN: usize = 16;

/// HashPassword 用 argon2id 哈希密码并返回 "$argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>"。
pub fn hash_password(pw: &str) -> Result<String, anyhow::Error> {
    let mut salt = vec![0u8; ARGON_SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let params = Params::new(ARGON_MEMORY, ARGON_ITERATIONS, ARGON_PARALLELISM, Some(ARGON_KEY_LEN))
        .map_err(|e| anyhow::anyhow!("argon2 params: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut hash = vec![0u8; ARGON_KEY_LEN];
    argon
        .hash_password_into(pw.as_bytes(), &salt, &mut hash)
        .map_err(|e| anyhow::anyhow!("argon2 hash: {e}"))?;
    Ok(format!(
        "$argon2id$v=19$m={},t={},p={}${}${}",
        ARGON_MEMORY,
        ARGON_ITERATIONS,
        ARGON_PARALLELISM,
        B64.encode(&salt),
        B64.encode(&hash)
    ))
}

/// VerifyPassword 校验明文密码是否与 argon2id 哈希匹配。
/// 畸形哈希返回 false；参数上限防止超大内存/CPU 分配（审计 L2）。
pub fn verify_password(hash: &str, pw: &str) -> bool {
    let parts: Vec<&str> = hash.split('$').collect();
    // $argon2id$v=19$m=...,t=...,p=...$salt$hash
    if parts.len() != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
        return false;
    }
    let salt = match B64.decode(parts[4]) {
        Ok(s) if !s.is_empty() => s,
        _ => return false,
    };
    let want = match B64.decode(parts[5]) {
        Ok(w) if !w.is_empty() => w,
        _ => return false,
    };
    let (mem, iter, par) = match parse_params(parts[3]) {
        Some(p) => p,
        None => return false,
    };
    if iter <= 0 || par <= 0 || mem <= 0 || iter > 10 || par > 16 || mem > 1024 * 1024 {
        return false;
    }
    let params = match Params::new(mem, iter, par, Some(want.len())) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut got = vec![0u8; want.len()];
    if argon.hash_password_into(pw.as_bytes(), &salt, &mut got).is_err() {
        return false;
    }
    got.ct_eq(&want).into()
}

fn parse_params(s: &str) -> Option<(u32, u32, u32)> {
    let mut mem = 0u32;
    let mut iter = 0u32;
    let mut par = 0u32;
    for kv in s.split(',') {
        let mut parts = kv.split('=');
        let k = parts.next()?;
        let v = parts.next()?;
        match k {
            "m" => mem = v.parse().ok()?,
            "t" => iter = v.parse().ok()?,
            "p" => par = v.parse().ok()?,
            _ => return None,
        }
    }
    Some((mem, iter, par))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_round_trip() {
        let hash = hash_password("S3cret!pw").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password(&hash, "S3cret!pw"));
        assert!(!verify_password(&hash, "wrong"));
        assert!(!verify_password(&hash, ""));
    }

    #[test]
    fn hash_salt_random() {
        let h1 = hash_password("same").unwrap();
        let h2 = hash_password("same").unwrap();
        assert_ne!(h1, h2);
    }

    #[test]
    fn verify_malformed() {
        for h in [
            "",
            "plain",
            "$argon2id$v=19$x$y",
            "$argon2id$v=19$m=1,t=0,p=1$c2FsdA$aGFzaA",
        ] {
            assert!(!verify_password(h, "x"), "accepted malformed hash {h:?}");
        }
    }
}

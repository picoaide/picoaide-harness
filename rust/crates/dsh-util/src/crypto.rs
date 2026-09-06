//! AES-GCM 加密与 master key 管理（Go `util.Encrypt/Decrypt/EnsureMasterKey` 等价）。

use aes_gcm::aead::consts::U12;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::aes::{Aes128, Aes192, Aes256};
use aes_gcm::{AesGcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// EncPrefix 标记 AES-GCM 加密值："enc:v1:<base64(nonce+ciphertext)>"。
pub const ENC_PREFIX: &str = "enc:v1:";

const MASTER_KEY_ENV: &str = "PICOAI_MASTER_KEY";

// 进程级 master key 文件路径（GetMasterKey 读取；Go 中为包级变量）。
static MASTER_KEY_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// EnsureMasterKey 返回 master key：环境变量优先，否则写 dataDir/master.key（0600）。
/// 与 Go 语义一致：32 字节随机密钥，O_EXCL 独占创建，并发首启只允许一方写成功。
pub fn ensure_master_key(data_dir: &str) -> Result<Vec<u8>, anyhow::Error> {
    if let Ok(k) = std::env::var(MASTER_KEY_ENV) {
        return parse_key(&k);
    }
    let path = Path::new(data_dir).join("master.key");
    if let Ok(b) = std::fs::read(&path) {
        let _ = MASTER_KEY_FILE.set(path);
        return parse_key_bytes(&b);
    }
    let mut key = vec![0u8; 32];
    OsRng.fill_bytes(&mut key);
    std::fs::create_dir_all(data_dir)?;
    std::fs::set_permissions(data_dir, std::fs::Permissions::from_mode(0o700))?;
    // O_EXCL 独占创建（同一路径只允许一方写成功）
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut f) => {
            f.write_all(&key)?;
            let _ = MASTER_KEY_FILE.set(path);
            Ok(key)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let b = std::fs::read(&path)?;
            let _ = MASTER_KEY_FILE.set(path);
            parse_key_bytes(&b)
        }
        Err(e) => Err(e.into()),
    }
}

/// GetMasterKey 从环境变量或 EnsureMasterKey 写出的文件读取 master key。
pub fn get_master_key() -> Result<Vec<u8>, anyhow::Error> {
    if let Ok(k) = std::env::var(MASTER_KEY_ENV) {
        return parse_key(&k);
    }
    match MASTER_KEY_FILE.get() {
        Some(path) => {
            let b = std::fs::read(path)?;
            parse_key_bytes(&b)
        }
        None => anyhow::bail!("master key not initialized"),
    }
}

fn parse_key_bytes(b: &[u8]) -> Result<Vec<u8>, anyhow::Error> {
    match b.len() {
        16 | 24 | 32 => Ok(b.to_vec()),
        n => anyhow::bail!("master key must be 16/24/32 bytes, got {n}"),
    }
}

fn parse_key(s: &str) -> Result<Vec<u8>, anyhow::Error> {
    parse_key_bytes(s.as_bytes())
}

/// 支持 16/24/32 字节 AES 密钥（与 Go 一致）。
enum AnyAead {
    Aes128(Box<AesGcm<Aes128, U12>>),
    Aes192(Box<AesGcm<Aes192, U12>>),
    Aes256(Box<AesGcm<Aes256, U12>>),
}

impl AnyAead {
    fn new(key: &[u8]) -> Result<Self, aes_gcm::Error> {
        match key.len() {
            16 => Ok(AnyAead::Aes128(Box::new(
                AesGcm::<Aes128, U12>::new_from_slice(key).map_err(|_| aes_gcm::Error)?,
            ))),
            24 => Ok(AnyAead::Aes192(Box::new(
                AesGcm::<Aes192, U12>::new_from_slice(key).map_err(|_| aes_gcm::Error)?,
            ))),
            32 => Ok(AnyAead::Aes256(Box::new(
                AesGcm::<Aes256, U12>::new_from_slice(key).map_err(|_| aes_gcm::Error)?,
            ))),
            _ => Err(aes_gcm::Error),
        }
    }
    fn encrypt(&self, nonce: &Nonce<U12>, plaintext: &[u8]) -> Result<Vec<u8>, aes_gcm::Error> {
        match self {
            AnyAead::Aes128(c) => c.encrypt(nonce, plaintext),
            AnyAead::Aes192(c) => c.encrypt(nonce, plaintext),
            AnyAead::Aes256(c) => c.encrypt(nonce, plaintext),
        }
    }
    fn decrypt(&self, nonce: &Nonce<U12>, ct: &[u8]) -> Result<Vec<u8>, aes_gcm::Error> {
        match self {
            AnyAead::Aes128(c) => c.decrypt(nonce, ct),
            AnyAead::Aes192(c) => c.decrypt(nonce, ct),
            AnyAead::Aes256(c) => c.decrypt(nonce, ct),
        }
    }
}

/// Encrypt 用 AES-GCM 加密，返回 "enc:v1:<base64(nonce||ciphertext)>"。
pub fn encrypt(key: &[u8], plaintext: &str) -> String {
    let cipher = AnyAead::new(key).expect("key length validated by EnsureMasterKey/GetMasterKey");
    let mut nonce_bytes = vec![0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .expect("AES-GCM encryption");
    let mut combined = nonce_bytes.clone();
    combined.extend_from_slice(&ciphertext);
    format!("{}{}", ENC_PREFIX, B64.encode(combined))
}

/// Decrypt 逆转 Encrypt；畸形/篡改/非加密值返回错误。
pub fn decrypt(key: &[u8], s: &str) -> Result<String, anyhow::Error> {
    let cipher = AnyAead::new(key).map_err(|e| anyhow::anyhow!("aes: {e}"))?;
    if !s.starts_with(ENC_PREFIX) {
        anyhow::bail!("not an encrypted value");
    }
    let raw = B64.decode(&s[ENC_PREFIX.len()..]).map_err(|e| anyhow::anyhow!("base64: {e}"))?;
    if raw.len() <= 12 {
        anyhow::bail!("ciphertext too short");
    }
    let (nonce, ct) = raw.split_at(12);
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| anyhow::anyhow!("decrypt failed"))?;
    Ok(String::from_utf8(pt)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    // 环境变量测试与文件测试互斥（进程级 env 并行修改竞态，2026-09 修复）
    static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn crypto_round_trip() {
        let key: Vec<u8> = (0u8..32).collect();
        let ct = encrypt(&key, "hello 世界");
        assert!(ct.starts_with("enc:v1:"));
        let pt = decrypt(&key, &ct).unwrap();
        assert_eq!(pt, "hello 世界");
        // nonce 随机 → 同一明文两次不同密文
        assert_ne!(encrypt(&key, "hello"), encrypt(&key, "hello"));
        // 错误密钥拒绝
        let other: Vec<u8> = (100u8..132).collect();
        assert!(decrypt(&other, &ct).is_err());
        // 垃圾密文拒绝
        assert!(decrypt(&key, "enc:v1:!!!not-base64!!!").is_err());
        assert!(decrypt(&key, "no-prefix").is_err());
        // 篡改密文拒绝
        let raw = B64.decode(&ct[ENC_PREFIX.len()..]).unwrap();
        let mut tampered = raw.clone();
        tampered[12] ^= 0xff;
        assert!(decrypt(&key, &format!("enc:v1:{}", B64.encode(tampered))).is_err());
        // 16/24 字节密钥可用
        for n in [16usize, 24] {
            let k: Vec<u8> = (0u8..n as u8).collect();
            let c = encrypt(&k, "x");
            let p = decrypt(&k, &c).unwrap();
            assert_eq!(p, "x");
        }
    }

    #[test]
    fn ensure_master_key_file() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("picoaide-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let key = ensure_master_key(dir.to_str().unwrap()).unwrap();
        assert_eq!(key.len(), 32);
        let meta = std::fs::metadata(dir.join("master.key")).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        let dmeta = std::fs::metadata(&dir).unwrap();
        assert_eq!(dmeta.permissions().mode() & 0o777, 0o700);
        // 幂等
        let key2 = ensure_master_key(dir.to_str().unwrap()).unwrap();
        assert_eq!(key, key2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_master_key_env() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        // 环境变量优先：不写文件
        unsafe { std::env::set_var(MASTER_KEY_ENV, "0123456789abcdef0123456789abcdef") }
        let dir = std::env::temp_dir().join("picoaide-env-test");
        let _ = std::fs::remove_dir_all(&dir);
        let key = ensure_master_key(dir.to_str().unwrap()).unwrap();
        assert_eq!(key, b"0123456789abcdef0123456789abcdef");
        assert!(!dir.join("master.key").exists());
        unsafe { std::env::remove_var(MASTER_KEY_ENV); }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_master_key_uninitialized() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        unsafe { std::env::remove_var(MASTER_KEY_ENV); }
        assert!(get_master_key().is_err());
    }
}

//! PicoAide 服务端通用工具库（Rust 版 util 包）。
//!
//! 对应 Go `server/internal/util`：加密/密码哈希/路径安全/版本比较。

pub mod crypto;
pub mod password;
pub mod semver;
pub mod updatecheck;

pub use crypto::{decrypt, encrypt, ensure_master_key, get_master_key, ENC_PREFIX};
pub use password::{hash_password, verify_password};
pub use semver::compare_semver;

/// SafePathSegment 报告字符串是否可作为单个路径段：非空、无分隔符、非 "." 或 ".."。
pub fn safe_path_segment(s: &str) -> bool {
    if s.is_empty() || s == "." || s == ".." {
        return false;
    }
    !s.contains(['/', '\\'])
}

/// PresetIDPattern 匹配 agent preset id（下游 dsh-agent-presets 的 PRESET_ID 约定）。
pub const PRESET_ID_PATTERN: &str = r"^[a-z0-9][a-z0-9-]*$";

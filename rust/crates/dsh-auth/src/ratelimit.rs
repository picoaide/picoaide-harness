//! 登录限流（Go `serverauth/ratelimit.go` 逻辑等价，去掉 gin 依赖）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// LoginLimiter 滑动窗口登录限流。
pub struct LoginLimiter {
    inner: Mutex<Inner>,
    max_attempts: usize,
    window: Duration,
}

struct Inner {
    attempts: HashMap<String, Vec<Instant>>,
    max_entries: usize,
    last_sweep: Instant,
}

impl LoginLimiter {
    /// new 创建限流器（默认 10 次/5min；PICOAI_LOGIN_MAX_ATTEMPTS 覆盖）。
    pub fn new(max_attempts: Option<usize>) -> Self {
        let max = match std::env::var("PICOAI_LOGIN_MAX_ATTEMPTS") {
            Ok(v) => v.parse::<usize>().ok().filter(|n| *n > 0).unwrap_or(10),
            Err(_) => 10,
        };
        let max_attempts = max_attempts.unwrap_or(max);
        LoginLimiter {
            inner: Mutex::new(Inner {
                attempts: HashMap::new(),
                max_entries: 10_000,
                last_sweep: Instant::now(),
            }),
            max_attempts,
            window: Duration::from_secs(300),
        }
    }

    /// allow 记录一次尝试；报告是否可继续。表满时驱逐最早窗口起始的 key。
    pub fn allow(&self, key: &str) -> bool {
        let mut inner = self.inner.lock().expect("limiter lock");
        let now = Instant::now();
        let cutoff = now.checked_sub(self.window).unwrap_or(now);

        // 全局清扫摊销：每分钟至多一次
        if now.duration_since(inner.last_sweep) >= Duration::from_secs(60) {
            let mut to_delete = Vec::new();
            for (k, times) in inner.attempts.iter_mut() {
                times.retain(|t| *t > cutoff);
                if times.is_empty() {
                    to_delete.push(k.clone());
                }
            }
            for k in to_delete {
                inner.attempts.remove(&k);
            }
            inner.last_sweep = now;
        }

        let times = inner.attempts.entry(key.to_string()).or_default();
        times.retain(|t| *t > cutoff);
        if times.len() >= self.max_attempts {
            return false;
        }
        if times.is_empty() && inner.attempts.len() >= inner.max_entries {
            // 表满：驱逐最早窗口起始的 key（拒绝新 key 会放大 DoS）
            let mut victim: Option<String> = None;
            let mut oldest: Option<Instant> = None;
            for (k, ts) in inner.attempts.iter() {
                if let Some(first) = ts.first() {
                    if oldest.map(|o| first < &o).unwrap_or(true) {
                        victim = Some(k.clone());
                        oldest = Some(*first);
                    }
                }
            }
            if let Some(v) = victim {
                inner.attempts.remove(&v);
            }
        }
        let times = inner.attempts.get_mut(key).unwrap();
        times.push(now);
        true
    }

    /// reset 清空全部状态（测试用）。
    pub fn reset(&self) {
        let mut inner = self.inner.lock().expect("limiter lock");
        inner.attempts.clear();
        inner.last_sweep = Instant::now();
    }
}

/// LoginKey 从连接 IP+用户名构建限流键（RemoteAddr 安全默认）。
pub fn login_key(remote_addr: &str, username: &str) -> String {
    let host = remote_addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(remote_addr);
    format!("{host}|{username}")
}

/// LoginAllowed 双桶校验：ip|username（防单 IP 爆破）+ username（防账号级 DoS）。
pub fn login_allowed(limiter: &LoginLimiter, remote_addr: &str, username: &str) -> bool {
    limiter.allow(&login_key(remote_addr, username)) && limiter.allow(&format!("u:{username}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sliding_window_limits() {
        let limiter = LoginLimiter::new(Some(3));
        for _ in 0..3 {
            assert!(limiter.allow("a|user"));
        }
        assert!(!limiter.allow("a|user"));
        // 另一 key 不受影响
        assert!(limiter.allow("b|user"));
    }

    #[test]
    fn login_key_and_double_bucket() {
        let limiter = LoginLimiter::new(Some(2));
        // 单 IP 单用户 2 次后双桶都满
        assert!(login_allowed(&limiter, "1.2.3.4:1234", "alice"));
        assert!(login_allowed(&limiter, "1.2.3.4:1234", "alice"));
        assert!(!login_allowed(&limiter, "1.2.3.4:1234", "alice"));
    }
}

//! 内存令牌桶限流器(每用户每分钟,对应 Go `rateLimiter`/`bucket`/
//! `newRateLimiter`/`allow`;有界桶表 + 惰性清理 + 满员驱逐最旧)。
//!
//! 时间由调用方注入(`allow_at`),便于确定性测试;`allow` 用真实时钟。

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 默认每用户每分钟限流次数。
pub const DEFAULT_RATE_LIMIT: i64 = 60;

/// 桶表默认上限(活跃用户数)。
pub const DEFAULT_BUCKET_CAP: usize = 10_000;

/// 桶表满员时,清理超过 1 小时未活动的桶。
pub const BUCKET_STALE: Duration = Duration::from_secs(3600);

/// 单个用户桶。
#[derive(Debug, Clone, Copy)]
pub struct Bucket {
    pub tokens: f64,
    pub last: Instant,
}

/// 每用户令牌桶限流器(线程安全)。
pub struct RateLimiter {
    buckets: Mutex<BTreeMap<i64, Bucket>>,
    max: usize,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimiter {
    /// 新建限流器(桶表容量 10000,与 Go `newRateLimiter` 一致)。
    pub fn new() -> Self {
        Self::with_max(DEFAULT_BUCKET_CAP)
    }

    /// 带桶表容量上限的构造(测试用)。
    pub fn with_max(max: usize) -> Self {
        Self {
            buckets: Mutex::new(BTreeMap::new()),
            max,
        }
    }

    /// 桶表容量上限。
    pub fn max(&self) -> usize {
        self.max
    }

    /// 真实时钟入口。
    pub fn allow(&self, user_id: i64, rate: i64) -> bool {
        self.allow_at(user_id, rate, Instant::now())
    }

    /// 核心逻辑(对应 Go `allow`):
    /// 1. 桶表 >= 上限时,先清理超过 1 小时的陈旧桶;
    /// 2. 无该用户桶:若仍满员,驱逐 last 最旧的桶(有界表不硬拒新用户);
    ///    新桶初始 tokens = rate;
    /// 3. 按 elapsed * rate / 60s 补充 tokens(封顶 rate);
    /// 4. tokens < 1 拒绝,否则扣 1 放行。
    ///
    /// `rate` 为每分钟令牌数。
    pub fn allow_at(&self, user_id: i64, rate: i64, now: Instant) -> bool {
        let rate = rate.max(0) as f64;
        let mut buckets = self.buckets.lock().expect("rate limiter poisoned");
        if buckets.len() >= self.max {
            // 惰性清理:仅当表满时扫陈旧桶
            let stale: Vec<i64> = buckets
                .iter()
                .filter(|(_, b)| now.duration_since(b.last) > BUCKET_STALE)
                .map(|(id, _)| *id)
                .collect();
            for id in stale {
                buckets.remove(&id);
            }
        }
        let b = match buckets.get_mut(&user_id) {
            Some(b) => b,
            None => {
                if buckets.len() >= self.max {
                    // 满员驱逐最旧条目(审计 2026-L19):大量活跃用户时
                    // 新用户不被硬拒,过期桶优先让位
                    let victim = buckets
                        .iter()
                        .min_by_key(|(_, b)| b.last)
                        .map(|(id, _)| *id);
                    let Some(victim) = victim else {
                        return false;
                    };
                    buckets.remove(&victim);
                }
                buckets.insert(user_id, Bucket { tokens: rate, last: now });
                buckets.get_mut(&user_id).unwrap()
            }
        };
        let elapsed = now.duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * rate / 60.0).min(rate);
        b.last = now;
        if b.tokens < 1.0 {
            return false;
        }
        b.tokens -= 1.0;
        true
    }

    /// 当前活跃桶数(观测用)。
    pub fn len(&self) -> usize {
        self.buckets.lock().expect("rate limiter poisoned").len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_allows_exactly_rate_per_minute() {
        let l = RateLimiter::with_max(10);
        let t0 = Instant::now();
        // rate=60:同一时刻正好放行 60 次
        for i in 0..60 {
            assert!(l.allow_at(1, 60, t0), "burst {i} should pass");
        }
        assert!(!l.allow_at(1, 60, t0), "61st must be blocked");
    }

    #[test]
    fn sliding_window_refills_over_time() {
        let l = RateLimiter::with_max(10);
        let t0 = Instant::now();
        for _ in 0..60 {
            assert!(l.allow_at(7, 60, t0));
        }
        assert!(!l.allow_at(7, 60, t0));
        // 30s 后补充 30 个令牌 → 又有 30 次可放行
        let t1 = t0 + Duration::from_secs(30);
        for i in 0..30 {
            assert!(l.allow_at(7, 60, t1), "refill {i} should pass");
        }
        assert!(!l.allow_at(7, 60, t1));
        // 60s 后:距上次补充只过了 30s,补充 30 个令牌(上限 rate,不累计超发)
        let t2 = t0 + Duration::from_secs(60);
        for i in 0..30 {
            assert!(l.allow_at(7, 60, t2), "refill {i} at t2 should pass");
        }
        assert!(!l.allow_at(7, 60, t2));
    }

    #[test]
    fn evicts_oldest_when_full() {
        let l = RateLimiter::with_max(2);
        let t0 = Instant::now();
        assert!(l.allow_at(1, 10, t0));
        assert!(l.allow_at(2, 10, t0 + Duration::from_millis(1)));
        // 满员:驱逐 last 最旧的用户 1,新用户 3 不被硬拒
        assert!(l.allow_at(3, 10, t0 + Duration::from_millis(2)), "new user must not be hard-refused");
        assert_eq!(l.len(), 2);
        // 用户 1 已被驱逐:再次调用会重建(不再命中旧桶)
        assert!(l.allow_at(1, 10, t0 + Duration::from_millis(3)));
        assert_eq!(l.len(), 2);
    }

    #[test]
    fn stale_buckets_cleaned_when_full() {
        let l = RateLimiter::with_max(1);
        let t0 = Instant::now();
        assert!(l.allow_at(1, 5, t0));
        // 2 小时后:陈旧桶先清理,再放行新用户
        let t1 = t0 + Duration::from_secs(7200);
        assert!(l.allow_at(2, 5, t1));
        assert_eq!(l.len(), 1);
        // 表满但无陈旧、非满员驱逐路径(用户 2 刚活动)不可行于 max=1
        // 新用户 3:驱逐最后活动的用户 2
        let t2 = t0 + Duration::from_secs(7300);
        assert!(l.allow_at(3, 5, t2));
        assert_eq!(l.len(), 1);
    }
}

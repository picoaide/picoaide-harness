//! 用量域（Go `serverstore/usage.go` 等价）——峰值窗口/成本/月度统计/聚合。

use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Datelike, Timelike, Utc};
use serde_json::Value;
use sqlx::Row;

/// PeakWindow 高峰窗口（北京时间）。
#[derive(Debug, Clone, Default)]
pub struct PeakWindow {
    pub start: String,
    pub end: String,
    pub weekdays: Vec<i32>,
}

/// parse_hhmm 解析 "HH:MM" → 自午夜分钟数；非法返回 None。
fn parse_hhmm(s: &str) -> Option<i32> {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return None;
    }
    for i in [0usize, 1, 3, 4] {
        if !b[i].is_ascii_digit() {
            return None;
        }
    }
    let hh = (b[0] - b'0') as i32 * 10 + (b[1] - b'0') as i32;
    let mm = (b[3] - b'0') as i32 * 10 + (b[4] - b'0') as i32;
    if hh > 23 || mm > 59 {
        return None;
    }
    Some(hh * 60 + mm)
}

/// ParsePeakWindows 解析 settings 值；非法或空 → 空（无峰谷价）。
pub fn parse_peak_windows(v: &str) -> Vec<PeakWindow> {
    if v.is_empty() {
        return Vec::new();
    }
    let raw: Vec<Value> = match serde_json::from_str(v) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for r in raw {
        let start = r.get("start").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let end = r.get("end").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let (sm, em) = match (parse_hhmm(&start), parse_hhmm(&end)) {
            (Some(s), Some(e)) => (s, e),
            _ => return Vec::new(), // 整体非法即视为未配置
        };
        if sm >= em {
            return Vec::new();
        }
        let mut w = PeakWindow {
            start,
            end,
            weekdays: Vec::new(),
        };
        if let Some(days) = r.get("weekdays").and_then(|x| x.as_array()) {
            let mut seen = std::collections::HashSet::new();
            for d in days {
                if let Some(n) = d.as_i64() {
                    if (1..=7).contains(&n) && seen.insert(n) {
                        w.weekdays.push(n as i32);
                    }
                }
            }
        }
        out.push(w);
    }
    out
}

/// beijing_minutes 返回 now 的北京时间分钟数（UTC+8，无 DST）。
fn beijing_minutes(now: DateTime<Utc>) -> i32 {
    let bj = now + chrono::Duration::hours(8);
    bj.hour() as i32 * 60 + bj.minute() as i32
}

/// beijing_weekday 北京时间星期（1=周一…7=周日）。
fn beijing_weekday(now: DateTime<Utc>) -> i32 {
    let bj = now + chrono::Duration::hours(8);
    // chrono: weekday() 0=Mon..6=Sun → 转 1..7 (1=Mon)
    match bj.weekday() {
        chrono::Weekday::Mon => 1,
        chrono::Weekday::Tue => 2,
        chrono::Weekday::Wed => 3,
        chrono::Weekday::Thu => 4,
        chrono::Weekday::Fri => 5,
        chrono::Weekday::Sat => 6,
        chrono::Weekday::Sun => 7,
    }
}

/// in_peak_window 判断 now 是否处于任一高峰窗口（按北京时间）。
fn in_peak_window(now: DateTime<Utc>, windows: &[PeakWindow]) -> bool {
    let mins = beijing_minutes(now);
    let wd = beijing_weekday(now);
    for w in windows {
        let start = parse_hhmm(&w.start).unwrap_or(0);
        let end = parse_hhmm(&w.end).unwrap_or(0);
        let day_ok = w.weekdays.is_empty() || w.weekdays.contains(&wd);
        if mins >= start && mins < end && day_ok {
            return true;
        }
    }
    false
}

/// cost_of_at 按模型定价计算时刻 now 的费用（元），应用低谷折扣。
pub fn cost_of_at(
    now: DateTime<Utc>,
    prompt_tokens: i64,
    completion_tokens: i64,
    cache_tokens: i64,
    input_per_1m: f64,
    output_per_1m: f64,
    cache_input_per_1m: f64,
    offpeak: f64,
    windows: &[PeakWindow],
) -> f64 {
    let mut cache_tokens = cache_tokens;
    if cache_tokens < 0 {
        cache_tokens = 0;
    }
    if cache_tokens > prompt_tokens {
        cache_tokens = prompt_tokens;
    }
    let cache_price = if cache_input_per_1m > 0.0 { cache_input_per_1m } else { input_per_1m };
    let miss_tokens = prompt_tokens - cache_tokens;
    let base = (miss_tokens as f64) / 1e6 * input_per_1m
        + (cache_tokens as f64) / 1e6 * cache_price
        + (completion_tokens as f64) / 1e6 * output_per_1m;
    // offpeak factor
    let factor = if offpeak > 0.0 && offpeak < 1.0 && !windows.is_empty() && !in_peak_window(now, windows) {
        offpeak
    } else {
        1.0
    };
    base * factor
}

/// RecordUsage 插入 chat 用量行。
pub async fn record_usage(
    pool: &sqlx::PgPool,
    user_id: i64,
    model: &str,
    prompt_tokens: i64,
    completion_tokens: i64,
) -> Result<i64, StoreError> {
    record_usage_kind(pool, user_id, model, prompt_tokens, completion_tokens, "chat").await
}

/// RecordUsageKind 插入指定 kind 的用量行。
pub async fn record_usage_kind(
    pool: &sqlx::PgPool,
    user_id: i64,
    model: &str,
    prompt_tokens: i64,
    completion_tokens: i64,
    kind: &str,
) -> Result<i64, StoreError> {
    record_usage_kind_cached(pool, user_id, model, prompt_tokens, completion_tokens, 0, kind).await
}

/// RecordUsageKindCached 带缓存命中数的记录。
pub async fn record_usage_kind_cached(
    pool: &sqlx::PgPool,
    user_id: i64,
    model: &str,
    prompt_tokens: i64,
    completion_tokens: i64,
    cache_tokens: i64,
    kind: &str,
) -> Result<i64, StoreError> {
    let now = Utc::now();
    // 模型价格
    let (in_p, out_p, offpeak) = crate::gateway::model_prices(pool, model).await;
    let cache_in = crate::gateway::model_cache_price(pool, model).await;
    let windows = crate::settings::get_setting(pool, "usage.peak_windows")
        .await
        .ok()
        .and_then(|(v, ok)| if ok { Some(parse_peak_windows(&v)) } else { None })
        .unwrap_or_default();
    let cost = cost_of_at(now, prompt_tokens, completion_tokens, cache_tokens, in_p, out_p, cache_in, offpeak, &windows);
    let row = sqlx::query(
        "INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, cache_prompt_tokens, kind, cost, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(user_id as i32)
    .bind(model)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .bind(cache_tokens)
    .bind(kind)
    .bind(cost)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok(row.get("id"))
}

/// UpdateUsageTokens 回填 token 数并重算 cost（按行 created_at 计价）。
pub async fn update_usage_tokens(
    pool: &sqlx::PgPool,
    id: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
) -> Result<(), StoreError> {
    let row = sqlx::query("SELECT model, created_at FROM usage WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?
        .ok_or(StoreError::NotFound)?;
    let model: String = row.get("model");
    let created_at: DateTime<Utc> = row.get("created_at");
    let (in_p, out_p, offpeak) = crate::gateway::model_prices(pool, &model).await;
    let cache_in = crate::gateway::model_cache_price(pool, &model).await;
    let windows = crate::settings::get_setting(pool, "usage.peak_windows")
        .await
        .ok()
        .and_then(|(v, ok)| if ok { Some(parse_peak_windows(&v)) } else { None })
        .unwrap_or_default();
    let cost = cost_of_at(created_at, prompt_tokens, completion_tokens, 0, in_p, out_p, cache_in, offpeak, &windows);
    sqlx::query("UPDATE usage SET prompt_tokens = $1, completion_tokens = $2, cache_prompt_tokens = $3, cost = $4 WHERE id = $5")
        .bind(prompt_tokens)
        .bind(completion_tokens)
        .bind(0i64)
        .bind(cost)
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// DeleteUsage 删除用量行（丢掉无法回填的 pending 行）。
pub async fn delete_usage(pool: &sqlx::PgPool, id: i64) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM usage WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// CleanupPendingUsage 删除早于 cutoff 的零 token chat/search 行。
pub async fn cleanup_pending_usage(pool: &sqlx::PgPool, cutoff: DateTime<Utc>) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM usage WHERE kind IN ('chat','search') AND prompt_tokens = 0 AND completion_tokens = 0 AND created_at < $1")
        .bind(cutoff)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// month_start 返回当月第一刻（本地时区口径——用 UTC 近似，PG created_at 是 TIMESTAMPTZ）。
fn month_start() -> DateTime<Utc> {
    let now = Utc::now();
    DateTime::from_timestamp(0, 0).unwrap() + chrono::Duration::days(0) // placeholder
}

/// UserMonthlyUsage 用户本月 tokens（零 token pending 行不计）。
pub async fn user_monthly_usage(pool: &sqlx::PgPool, user_id: i64) -> Result<i64, StoreError> {
    let total: i64 = sqlx::query_scalar(
        "SELECT (COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0))::bigint FROM usage WHERE user_id = $1 AND created_at >= date_trunc('month', now())",
    )
    .bind(user_id as i32)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok(total)
}

/// UserMonthlyUsageBatch 一次查询返回一批用户本月用量。
pub async fn user_monthly_usage_batch(
    pool: &sqlx::PgPool,
    user_ids: &[i64],
) -> Result<std::collections::HashMap<i64, i64>, StoreError> {
    let mut out = std::collections::HashMap::new();
    if user_ids.is_empty() {
        return Ok(out);
    }
    let mut sql = String::from(
        "SELECT user_id, (COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0))::bigint AS t FROM usage WHERE created_at >= date_trunc('month', now()) AND user_id IN (",
    );
    for (i, _) in user_ids.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        sql.push_str(&format!("${}", i + 1));
    }
    sql.push_str(") GROUP BY user_id");
    let mut q = sqlx::query(&sql);
    for id in user_ids {
        q = q.bind(*id as i32);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    for r in rows {
        out.insert(r.get::<i32, _>("user_id") as i64, r.get("t"));
    }
    Ok(out)
}

/// EffectiveQuota 用户月度 token 配额（0=不限；admin 恒 0）。
pub async fn effective_quota(pool: &sqlx::PgPool, user: &crate::users::User) -> Result<i64, StoreError> {
    if user.is_admin {
        return Ok(0);
    }
    if let Some(q) = user.quota_tokens {
        return Ok(q);
    }
    let (v, ok) = crate::settings::get_setting(pool, "usage.monthly_quota").await?;
    if !ok {
        return Ok(0);
    }
    match v.trim().parse::<i64>() {
        Ok(n) if n >= 0 => Ok(n),
        _ => Ok(0),
    }
}

/// UserMonthlyCost 用户本月费用（元）。
pub async fn user_monthly_cost(pool: &sqlx::PgPool, user_id: i64) -> Result<f64, StoreError> {
    let total: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(cost),0) FROM usage WHERE user_id = $1 AND created_at >= date_trunc('month', now())",
    )
    .bind(user_id as i32)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok(total)
}

/// EffectiveMoneyQuota 用户月度金额配额（0=不限；admin 恒 0）。
pub async fn effective_money_quota(pool: &sqlx::PgPool, user: &crate::users::User) -> Result<f64, StoreError> {
    if user.is_admin {
        return Ok(0.0);
    }
    if let Some(q) = user.quota_money {
        return Ok(q);
    }
    let (v, ok) = crate::settings::get_setting(pool, "usage.monthly_quota_money").await?;
    if !ok {
        return Ok(0.0);
    }
    match v.trim().parse::<f64>() {
        Ok(n) if n >= 0.0 => Ok(n),
        _ => Ok(0.0),
    }
}

/// MonthUsageByUser 用户当月 tokens+成本。
#[derive(Debug, Clone, Default)]
pub struct MonthUsageByUser {
    pub tokens: i64,
    pub cost: f64,
}

/// MonthUsageByUsers 一次查询返回一批用户当月用量。
pub async fn month_usage_by_users(
    pool: &sqlx::PgPool,
    user_ids: &[i64],
) -> Result<std::collections::HashMap<i64, MonthUsageByUser>, StoreError> {
    let mut out = std::collections::HashMap::new();
    if user_ids.is_empty() {
        return Ok(out);
    }
    let mut sql = String::from(
        "SELECT user_id, (COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0))::bigint AS t, COALESCE(SUM(cost),0) AS c FROM usage WHERE created_at >= date_trunc('month', now()) AND user_id IN (",
    );
    for (i, _) in user_ids.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        sql.push_str(&format!("${}", i + 1));
    }
    sql.push_str(") GROUP BY user_id");
    let mut q = sqlx::query(&sql);
    for id in user_ids {
        q = q.bind(*id as i32);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    for r in rows {
        out.insert(
            r.get::<i32, _>("user_id") as i64,
            MonthUsageByUser {
                tokens: r.get("t"),
                cost: r.get("c"),
            },
        );
    }
    Ok(out)
}

/// UserUsageSummary 员工用量概览。
#[derive(Debug, Clone, Default)]
pub struct UsageSummary {
    pub monthly_usage: i64,
    pub monthly_cost: f64,
    pub today_usage: i64,
    pub today_cost: f64,
    pub yesterday_usage: i64,
    pub yesterday_cost: f64,
    pub total_usage: i64,
    pub total_cost: f64,
}

/// UserUsageSummary 一次取齐员工用量概览。
pub async fn user_usage_summary(pool: &sqlx::PgPool, user_id: i64) -> Result<UsageSummary, StoreError> {
    let monthly_usage = user_monthly_usage(pool, user_id).await?;
    let monthly_cost = user_monthly_cost(pool, user_id).await?;
    let today = user_day_usage_cost(pool, user_id, Utc::now()).await?;
    let yesterday = user_day_usage_cost(pool, user_id, Utc::now() - chrono::Duration::days(1)).await?;
    let total = user_total_usage_cost(pool, user_id).await?;
    Ok(UsageSummary {
        monthly_usage,
        monthly_cost,
        today_usage: today.0,
        today_cost: today.1,
        yesterday_usage: yesterday.0,
        yesterday_cost: yesterday.1,
        total_usage: total.0,
        total_cost: total.1,
    })
}

/// user_day_usage_cost 返回指定日（本地时区，UTC 近似）tokens 与费用。
pub async fn user_day_usage_cost(
    pool: &sqlx::PgPool,
    user_id: i64,
    day: DateTime<Utc>,
) -> Result<(i64, f64), StoreError> {
    let start = DateTime::from_timestamp(
        day.timestamp() / 86400 * 86400,
        0,
    )
    .unwrap();
    let end = start + chrono::Duration::days(1);
    let row = sqlx::query(
        "SELECT (COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0))::bigint, COALESCE(SUM(cost),0) FROM usage WHERE user_id = $1 AND created_at >= $2 AND created_at < $3",
    )
    .bind(user_id as i32)
    .bind(start)
    .bind(end)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok((row.get(0), row.get(1)))
}

/// user_total_usage_cost 返回用户全历史 tokens 与费用。
pub async fn user_total_usage_cost(pool: &sqlx::PgPool, user_id: i64) -> Result<(i64, f64), StoreError> {
    let row = sqlx::query(
        "SELECT (COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0))::bigint, COALESCE(SUM(cost),0) FROM usage WHERE user_id = $1",
    )
    .bind(user_id as i32)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok((row.get(0), row.get(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_peak_windows_cases() {
        // 空
        assert!(parse_peak_windows("").is_empty());
        // 合法
        let w = parse_peak_windows(r#"[{"start":"09:00","end":"18:00"}]"#);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].start, "09:00");
        // 非法整体 → 空
        assert!(parse_peak_windows(r#"[{"start":"25:00","end":"18:00"}]"#).is_empty());
        assert!(parse_peak_windows("not-json").is_empty());
        // weekdays
        let w = parse_peak_windows(r#"[{"start":"09:00","end":"18:00","weekdays":[1,2,2,9]}]"#);
        assert_eq!(w[0].weekdays, vec![1, 2]);
    }

    #[test]
    fn cost_formula() {
        // 高峰窗口 09:00-18:00；非高峰(20:00) 折扣 0.5
        let windows = parse_peak_windows(r#"[{"start":"09:00","end":"18:00"}]"#);
        // 构造一个 20:00 时刻（UTC+8 = 20:00 → UTC 12:00）
        let offpeak_now = DateTime::parse_from_rfc3339("2026-09-06T12:00:00Z").unwrap().with_timezone(&Utc);
        let cost = cost_of_at(offpeak_now, 1_000_000, 500_000, 100_000, 1.0, 2.0, 0.5, 0.5, &windows);
        // 未命中 900k * 1.0/1e6 + cache 100k*0.5/1e6 + 500k*2.0/1e6 = 0.9 + 0.05 + 1.0 = 1.95; *0.5 = 0.975
        assert!((cost - 0.975).abs() < 1e-9, "cost={cost}");
        // 高峰时刻(UTC 02:00 = 北京 10:00) → 无折扣
        let peak_now = DateTime::parse_from_rfc3339("2026-09-06T02:00:00Z").unwrap().with_timezone(&Utc);
        let peak_cost = cost_of_at(peak_now, 1_000_000, 500_000, 100_000, 1.0, 2.0, 0.5, 0.5, &windows);
        assert!((peak_cost - 1.95).abs() < 1e-9, "peak_cost={peak_cost}");
    }

    #[tokio::test]
    async fn usage_record_and_summary() {
        let pool = crate::testutil::new_test_db().await;
        let uid = crate::users::create_user(
            &pool,
            &crate::users::User {
                username: "usage".into(),
                source: "local".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let id = record_usage(&pool, uid, "deepseek-chat", 1000, 500).await.unwrap();
        assert!(id > 0);
        let m = user_monthly_usage(&pool, uid).await.unwrap();
        assert_eq!(m, 1500);
        let cost = user_monthly_cost(&pool, uid).await.unwrap();
        assert!(cost >= 0.0);
        // 删除后归零
        delete_usage(&pool, id).await.unwrap();
        let m = user_monthly_usage(&pool, uid).await.unwrap();
        assert_eq!(m, 0);
    }
}

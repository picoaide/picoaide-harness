//! 测试基础设施（Go `NewTestDB` 等价）：创建独立临时库 + 应用迁移 + 清理。
//!
//! 依赖环境变量 PG_DSN_TEST（如 `postgres://postgres:postgres@127.0.0.1:5432/postgres`），
//! 缺省为本地开发 PG。无 PG 时测试跳过（与 Go requireTestPG 语义一致）。

use sqlx::postgres::PgPool;
use sqlx::postgres::PgPoolOptions;
use chrono::Datelike;

/// PgTestDSN 返回 PostgreSQL 测试 DSN 模板（PG_DSN_TEST 覆盖）。
pub fn pg_test_dsn() -> String {
    std::env::var("PG_DSN_TEST").unwrap_or_else(|_| {
        "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable".to_string()
    })
}

/// random_suffix 生成 6 位随机后缀（临时库名去碰撞）。
fn random_suffix(n: usize) -> String {
    use rand::RngCore;
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/// new_test_db 创建一个独立临时库（picoaide_test_<rand>），应用迁移，返回连接池。
/// 无 PG 时返回 None（测试应跳过）。
pub async fn try_new_test_db() -> Option<PgPool> {
    let dsn = pg_test_dsn();
    // 连 admin 库（postgres）探测
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(&dsn)
        .await
        .ok()?;
    let db_name = format!("picoaide_test_{}", random_suffix(6));
    let quoted = db_name.replace('"', "\"\"");
    sqlx::query(&format!(r#"CREATE DATABASE "{}""#, quoted))
        .execute(&admin)
        .await
        .ok()?;

    // 连临时库
    let mut url = url::Url::parse(&dsn).ok()?;
    url.set_path(&format!("/{db_name}"));
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(url.as_str())
        .await
        .ok()?;

    // 应用迁移
    if let Err(e) = crate::migrate::apply_migrations(&pool).await {
        let _ = sqlx::query(&format!(r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#, quoted))
            .execute(&admin)
            .await;
        panic!("apply migrations: {e}");
    }

    // 预建 2026-01 起至当前+6月的 usage 分区与 usage_daily 分区
    // （等价 Go ensureTestPartitions，覆盖测试硬编码月份）。
    if let Err(e) = ensure_test_partitions(&pool).await {
        panic!("ensure test partitions: {e}");
    }

    Some(pool)
}

/// ensure_usage_partition 幂等创建某月的 usage 分区（Go ensureUsagePartition 等价）。
pub async fn ensure_usage_partition(pool: &PgPool, month: chrono::DateTime<chrono::Utc>) -> anyhow::Result<()> {
    let y = month.year();
    let m = month.month();
    let key = format!("{y}{m:02}");
    let start = format!("{y}-{m:02}-01");
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let end = format!("{ny}-{nm:02}-01");
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS usage_{key} PARTITION OF usage FOR VALUES FROM ('{start}') TO ('{end}')"
    );
    sqlx::query(&sql).execute(pool).await?;
    Ok(())
}

/// ensure_test_partitions 预建历史+未来分区（Go ensureTestPartitions 等价）。
async fn ensure_test_partitions(pool: &PgPool) -> anyhow::Result<()> {
    let start = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap().with_timezone(&chrono::Utc);
    let end = chrono::Utc::now() + chrono::Duration::days(183);
    let mut m = start;
    while m <= end {
        ensure_usage_partition(pool, m).await?;
        // usage_daily 年分区
        let y = m.year();
        let sql = format!(
            "CREATE TABLE IF NOT EXISTS usage_daily_{y} PARTITION OF usage_daily FOR VALUES FROM ('{y}-01-01') TO ('{}-01-01')",
            y + 1
        );
        sqlx::query(&sql).execute(pool).await?;
        m = if m.month() == 12 {
            chrono::DateTime::from_timestamp(
                m.timestamp() + chrono::Duration::days(31).num_seconds(),
                0,
            ).unwrap()
        } else {
            // 下一月:加一个月天数的近似(用 chrono Months)
            m + chrono::Months::new(1)
        };
    }
    Ok(())
}

/// new_test_db 便捷封装（不跳过，直接 panic）。
pub async fn new_test_db() -> PgPool {
    try_new_test_db()
        .await
        .expect("postgres unavailable: set PG_DSN_TEST or start local PG")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn new_test_db_works() {
        let pool = new_test_db().await;
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(n > 0);
        pool.close().await;
    }
}

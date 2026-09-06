//! 测试基础设施（Go `NewTestDB` 等价）：创建独立临时库 + 应用迁移 + 清理。
//!
//! 依赖环境变量 PG_DSN_TEST（如 `postgres://postgres:postgres@127.0.0.1:5432/postgres`），
//! 缺省为本地开发 PG。无 PG 时测试跳过（与 Go requireTestPG 语义一致）。

use sqlx::postgres::PgPool;
use sqlx::postgres::PgPoolOptions;

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

    Some(pool)
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

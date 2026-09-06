//! 数据库连接管理（Go `serverstore.Open` 等价）。

use sqlx::postgres::{PgPool, PgPoolOptions};
/// DriverName 标识底层 SQL 后端（仅 PostgreSQL）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriverName {
    Pg,
}

/// DBConfig 选择 Open 的后端。
#[derive(Debug, Clone)]
pub struct DbConfig {
    pub driver: DriverName,
    pub dsn: String,
}

impl DbConfig {
    pub fn pg(dsn: impl Into<String>) -> Self {
        Self {
            driver: DriverName::Pg,
            dsn: dsn.into(),
        }
    }
}

/// Open 打开指定后端的连接池并验证连通性。
pub async fn open(cfg: DbConfig) -> anyhow::Result<PgPool> {
    match cfg.driver {
        DriverName::Pg => {
            let pool = PgPoolOptions::new()
                .max_connections(10)
                .connect(&cfg.dsn)
                .await?;
            Ok(pool)
        }
    }
}

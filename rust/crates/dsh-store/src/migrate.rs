//! 迁移执行器（Go `serverstore.ApplyMigrations` 等价）。

use sqlx::postgres::PgPool;

/// migration 表示一条迁移（version + 文件名 + SQL 文本）。
#[derive(Debug, Clone)]
pub struct Migration {
    pub version: i64,
    pub name: String,
    pub sql: String,
}

/// migrations_dir 指向本 crate 内嵌的迁移目录（编译期拷贝自 Go migrations-pg/）。
const MIGRATIONS_DIR: &str = "migrations-pg";

/// migrations_dir_path 用 CARGO_MANIFEST_DIR 定位（cargo test 从任意 cwd 运行均正确）。
fn migrations_dir_path() -> std::path::PathBuf {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.join(MIGRATIONS_DIR)
}

/// migrationsFor 返回按版本升序的迁移集合（编译期嵌入）。
pub fn migrations_for() -> Vec<Migration> {
    let dir = migrations_dir_path();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("migrations dir embedded") {
        let e = entry.expect("read entry");
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".sql") {
            continue;
        }
        let prefix = name.splitn(2, '_').next().unwrap_or("");
        let version: i64 = match prefix.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let sql = std::fs::read_to_string(e.path()).expect("read migration");
        out.push(Migration {
            version,
            name,
            sql,
        });
    }
    out.sort_by_key(|m| m.version);
    out
}

/// latestMigration 返回当前迁移最高版本号。
pub fn latest_migration() -> i64 {
    migrations_for()
        .last()
        .map(|m| m.version)
        .unwrap_or(0)
}

/// ApplyMigrations 创建 schema_migrations 表并应用全部未执行迁移，每个迁移独立事务。幂等。
pub async fn apply_migrations(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT now()
        )",
    )
    .execute(pool)
    .await?;

    let applied: Vec<i32> = sqlx::query_scalar("SELECT version FROM schema_migrations")
        .fetch_all(pool)
        .await?;
    let mut applied_set = std::collections::HashSet::new();
    for v in applied {
        applied_set.insert(v as i64);
    }

    for m in migrations_for() {
        if applied_set.contains(&m.version) {
            continue;
        }
        let mut tx = pool.begin().await?;
        if !m.sql.trim().is_empty() {
            if let Err(e) = sqlx::raw_sql(&m.sql).execute(&mut *tx).await {
                tx.rollback().await?;
                anyhow::bail!("migration {:04} {}: {}", m.version, m.name, e);
            }
        }
        sqlx::query("INSERT INTO schema_migrations (version) VALUES ($1)")
            .bind(m.version)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(())
}

/// 供测试覆盖迁移集合的钩子（替代 Go testMigrationHook，本 crate 内测试用）。
#[cfg(test)]
pub(crate) mod test_hook {
    use super::*;
    use std::sync::Mutex;

    static HOOK: Mutex<Option<Vec<Migration>>> = Mutex::new(None);

    pub fn set(migrations: Vec<Migration>) {
        *HOOK.lock().unwrap() = Some(migrations);
    }

    pub fn clear() {
        *HOOK.lock().unwrap() = None;
    }

    pub fn get() -> Vec<Migration> {
        HOOK.lock()
            .unwrap()
            .as_ref()
            .cloned()
            .unwrap_or_else(migrations_for)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn apply_migrations_creates_schema() {
        let pool = crate::testutil::new_test_db().await;
        apply_migrations(&pool).await.unwrap();
        let version: i32 = sqlx::query_scalar(
            "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(version as i64, latest_migration());
        // 幂等
        apply_migrations(&pool).await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, migrations_for().len() as i64);
    }
}

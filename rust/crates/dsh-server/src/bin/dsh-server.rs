//! PicoAide Rust 服务端入口（Go `cmd/server/main.go` 等价）。
//!
//! 启动：参数解析 → DB 迁移 → bootstrap admin → axum HTTP 服务。

use picoaide_dsh_server::router::AppState;
use picoaide_dsh_store::{migrate, open, DbConfig};
use std::sync::Arc;

/// 命令参数（环境变量 DSH_* 解析，等价 Go flag）。
#[derive(Debug, Clone)]
pub struct ServerArgs {
    pub addr: String,
    pub data_dir: String,
    pub pg_dsn: String,
    pub bootstrap_admin: String,
}

impl ServerArgs {
    pub fn from_env() -> Self {
        ServerArgs {
            addr: std::env::var("DSH_ADDR").unwrap_or_else(|_| ":8080".to_string()),
            data_dir: std::env::var("DSH_DATA").unwrap_or_else(|_| "./data".to_string()),
            pg_dsn: std::env::var("DSH_PG_DSN")
                .or_else(|_| std::env::var("PG_DSN"))
                .unwrap_or_default(),
            bootstrap_admin: std::env::var("DSH_BOOTSTRAP_ADMIN").unwrap_or_default(),
        }
    }
}

#[tokio::main]
async fn main() {
    let args = ServerArgs::from_env();
    if let Err(e) = run(args).await {
        eprintln!("startup error: {e}");
        std::process::exit(1);
    }
}

/// run 启动服务端（迁移 → bootstrap → 监听）。
async fn run(args: ServerArgs) -> anyhow::Result<()> {
    if args.pg_dsn.is_empty() {
        anyhow::bail!("DSH_PG_DSN / PG_DSN required");
    }
    let pool = open(DbConfig::pg(&args.pg_dsn)).await?;
    migrate::apply_migrations(&pool).await?;
    if !args.bootstrap_admin.is_empty() {
        picoaide_dsh_auth::bootstrap_admin::ensure_bootstrap_admin(&pool, &args.bootstrap_admin).await?;
    }
    let state = Arc::new(AppState { pool });
    let app = picoaide_dsh_server::router::build_router(state.clone());
    let app = app.with_state(state.clone());
    let app = app.nest_service("/admin", picoaide_dsh_server::router::webadmin_router());
    tracing::info!("listening on {}", args.addr);
    let listener = tokio::net::TcpListener::bind(&args.addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_defaults() {
        let a = ServerArgs {
            addr: ":8080".into(),
            data_dir: "./data".into(),
            pg_dsn: "postgres://x".into(),
            bootstrap_admin: "".into(),
        };
        assert_eq!(a.addr, ":8080");
    }
}

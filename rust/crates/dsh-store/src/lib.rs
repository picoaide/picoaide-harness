//! PicoAide 数据层（Go `serverstore` 等价）。
//!
//! 包含：数据库连接、迁移、DAO（用户/部门/组/网关/用量/授权等）。

pub mod audit;
pub mod connectors;
pub mod db;
pub mod departments;
pub mod effective;
pub mod errors;
pub mod gateway;
pub mod grants;
pub mod groups;
pub mod settings;
pub mod tokens;
pub mod migrate;
pub mod testutil;
pub mod users;

pub use db::{open, DbConfig, DriverName};
pub use errors::StoreError;
pub use migrate::{apply_migrations, latest_migration};

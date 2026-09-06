//! PicoAide 数据层（Go `serverstore` 等价）。
//!
//! 包含：数据库连接、迁移、DAO（用户/部门/组/网关/用量/授权等）。

pub mod db;
pub mod migrate;
#[cfg(test)]
pub mod testutil;

pub use db::{open, DbConfig, DriverName};
pub use migrate::{apply_migrations, latest_migration};

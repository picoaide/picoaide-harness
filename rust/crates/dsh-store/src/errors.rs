//! 数据层错误（Go `serverstore` errors.go 等价）。

use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum StoreError {
    #[error("not found")]
    NotFound,
    #[error("duplicate")]
    Duplicate,
    #[error("conflict")]
    Conflict,
    #[error("too many pending submissions")]
    TooManyPending,
    #[error("invalid value")]
    Validation,
    #[error("cannot delete the last admin")]
    LastAdmin,
    #[error("department in use")]
    DepartmentInUse,
    /// 带原始 sqlx 消息的数据库错误（便于诊断；调用方可再 match）。
    #[error("database: {0}")]
    Database(String),
}

/// 将 sqlx 错误映射为 StoreError（保留其他错误）。
pub fn map_db_error(e: sqlx::Error) -> StoreError {
    match e {
        sqlx::Error::RowNotFound => StoreError::NotFound,
        _ => {
            let msg = e.to_string();
            if is_unique_violation(&msg) {
                StoreError::Duplicate
            } else if msg.contains("23502") || msg.contains("not-null") {
                StoreError::Validation
            } else {
                StoreError::Database(msg)
            }
        }
    }
}

fn is_unique_violation(msg: &str) -> bool {
    msg.contains("SQLSTATE 23505")
        || msg.contains("23505")
        || msg.contains("UNIQUE")
        || msg.contains("unique constraint")
        || msg.contains("duplicate key")
}

/// 判定是否为唯一约束冲突（与 Go isUniqueViolation 一致）。
pub fn is_unique_violation_str(msg: &str) -> bool {
    is_unique_violation(msg)
}

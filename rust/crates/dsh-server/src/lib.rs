//! PicoAide HTTP 服务端（Go `cmd/server` + `router` 等价）。

pub mod error;
pub mod healthz;
pub mod marketplace;
pub mod namespace;
pub mod agent_share_service;
pub mod shared_skills_service;
pub mod skillmanifest;

pub use error::{error_body, write_json_error, ErrorBody, ErrorResponse, ERROR_INTERNAL};

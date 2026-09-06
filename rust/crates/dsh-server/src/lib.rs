//! PicoAide HTTP 服务端（Go `cmd/server` + `router` 等价）。

pub mod error;
pub mod handlers;
pub mod llm_gateway_service;
pub mod healthz;
pub mod marketplace;
pub mod namespace;
pub mod bootstrap_service;
pub mod brand_service;
pub mod capabilities_service;
pub mod connector_service;
pub mod reports_service;
pub mod router;
pub mod agent_share_service;
pub mod shared_skills_service;
pub mod telemetry_service;
pub mod skillmanifest;

pub use error::{error_body, write_json_error, ErrorBody, ErrorResponse, ERROR_INTERNAL};

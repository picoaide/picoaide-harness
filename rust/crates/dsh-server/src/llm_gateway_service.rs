//! LLM 网关服务层（Go `internal/llmgateway` 的 handler 核心等价）。
//!
//! 组合：dsh-llm 的 http_proxy（协议注入/usage 解析/配额判定）+
//! dsh-store 的 gateway（provider 路由/模型匹配）+ usage 记录。

use picoaide_dsh_llm::http_proxy::{HttpClient, Proxy, ProxyResult, QuotaState, DeptBudgetState, quota_blocked};
use picoaide_dsh_store::errors::StoreError;
use picoaide_dsh_store::gateway::{GatewayProvider, list_gateway_providers};
use picoaide_dsh_store::usage::{record_usage_kind_cached, update_usage_tokens};
use serde_json::{json, Value};
use sqlx::PgPool;

/// LlmGatewayService LLM 网关服务。
#[derive(Clone)]
pub struct LlmGatewayService {
    pub pool: PgPool,
}

impl LlmGatewayService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// forward_chat 非流式 chat/completions 转发（返回代理结果 + 记录 usage）。
    pub async fn forward_chat<C: HttpClient>(
        &self,
        model: &str,
        body: &[u8],
        client: C,
    ) -> Result<Value, StoreError> {
        // 模型匹配 provider
        let providers = list_gateway_providers(&self.pool).await?;
        let ups: Vec<picoaide_dsh_llm::match_::Upstream> = providers
            .iter()
            .map(|p| picoaide_dsh_llm::match_::Upstream {
                name: p.name.clone(),
                base_url: p.base_url.clone(),
                api_key: p.api_key_enc.clone(),
                models: p.models.clone(),
                channel: p.channel.clone(),
                protocol: p.protocol.clone(),
            })
            .collect();
        let up = picoaide_dsh_llm::match_::match_model(&ups, model).ok_or(StoreError::NotFound)?;
        let url = picoaide_dsh_llm::protocol::upstream_url_for(&up.base_url, "/chat/completions");
        let proxy = Proxy { client };
        let result = proxy
            .proxy(&url, &std::collections::HashMap::new(), body)
            .await
            .map_err(|e| StoreError::Validation)?;
        if result.status < 200 || result.status >= 300 {
            return Ok(json!({ "status": result.status, "body": String::from_utf8_lossy(&result.body) }));
        }
        // 记录 usage（user=0 占位，token 从响应提取）
        if let Some((pt, ct, cache)) = picoaide_dsh_llm::http_proxy::parse_usage_from_body(&result.body) {
            let _ = record_usage_kind_cached(&self.pool, 0, model, pt, ct, cache, "chat").await;
        }
        Ok(json!({ "status": result.status, "body": String::from_utf8_lossy(&result.body) }))
    }

    /// models 列出启用模型（v1/models）。
    pub async fn models(&self) -> Result<Value, StoreError> {
        let models = picoaide_dsh_store::gateway::list_admin_models(&self.pool).await?;
        let items: Vec<Value> = models
            .iter()
            .filter(|m| m.provider_enabled)
            .map(|m| json!({ "id": m.name }))
            .collect();
        Ok(json!({ "data": items }))
    }

    /// quota 判定（服务层包装，数值来自 store 聚合）。
    pub async fn check_quota(&self, user: &picoaide_dsh_store::users::User, budgets: &[DeptBudgetState]) -> Result<(bool, String), StoreError> {
        let tokens = picoaide_dsh_store::usage::user_monthly_usage(&self.pool, user.id).await?;
        let cost = picoaide_dsh_store::usage::user_monthly_cost(&self.pool, user.id).await?;
        let token_quota = picoaide_dsh_store::usage::effective_quota(&self.pool, user).await?;
        let money_quota = picoaide_dsh_store::usage::effective_money_quota(&self.pool, user).await?;
        let q = QuotaState {
            is_admin: user.is_admin,
            dept_budgets: budgets.to_vec(),
            my_tokens: tokens,
            my_cost: cost,
            token_quota,
            money_quota,
        };
        Ok(quota_blocked(&q))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn gateway_models_empty() {
        let pool = new_test_db().await;
        let svc = LlmGatewayService::new(pool);
        let r = svc.models().await.unwrap();
        assert!(r["data"].is_array());
    }

    #[tokio::test]
    async fn quota_admin_exempt() {
        let pool = new_test_db().await;
        let svc = LlmGatewayService::new(pool.clone());
        let uid = picoaide_dsh_store::users::create_user(
            &pool,
            &picoaide_dsh_store::users::User {
                username: "admin".into(),
                source: "local".into(),
                is_admin: true,
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let u = picoaide_dsh_store::users::get_user_by_id(&pool, uid).await.unwrap();
        let (blocked, _) = svc.check_quota(&u, &[]).await.unwrap();
        assert!(!blocked);
    }
}

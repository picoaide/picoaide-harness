//! LLM 网关 HTTP 代理核心（Go `llmgateway/handler.go` 的纯逻辑等价）。
//!
//! 包含：上游响应/SSE 处理、配额数值判定、长响应防护。
//! 实际 HTTP 请求经 [`HttpClient`] trait 抽象（测试 mock）。

use std::collections::HashMap;
use std::pin::Pin;

/// 最大上游响应字节数（防护：超大响应拒绝）。
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// HttpClient 抽象（测试用 mock；生产用 reqwest 适配器）。
#[async_trait::async_trait]
pub trait HttpClient: Send + Sync {
    /// 发送原始请求体到上游，返回 (status, body)。
    async fn post(&self, url: &str, headers: &HashMap<String, String>, body: &[u8]) -> Result<(u16, Vec<u8>), String>;
}

/// ProxyResult 一次代理处理的结果。
#[derive(Debug, Clone, Default)]
pub struct ProxyResult {
    pub status: u16,
    pub body: Vec<u8>,
}

/// parse_usage_from_body 从（非流式）响应体提取 usage（prompt/completion/cache）。
/// 返回 None 表示无 usage 字段（上游忽略用量）。
pub fn parse_usage_from_body(body: &[u8]) -> Option<(i64, i64, i64)> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let usage = v.get("usage")?;
    let prompt = usage.get("prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    let completion = usage.get("completion_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    let cache = usage
        .get("prompt_cache_hit_tokens")
        .or_else(|| usage.get("cache_hit_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    Some((prompt, completion, cache))
}

/// extract_sse_usage 从 SSE 文本流中提取最后一个 usage chunk（data: {...}）。
/// 返回 (prompt, completion, cache)。
pub fn extract_sse_usage(body: &str) -> Option<(i64, i64, i64)> {
    let mut result = None;
    for line in body.lines() {
        let line = line.trim();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(u) = v.get("usage") {
                    let prompt = u.get("prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
                    let completion = u.get("completion_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
                    let cache = u
                        .get("prompt_cache_hit_tokens")
                        .or_else(|| u.get("cache_hit_tokens"))
                        .and_then(|x| x.as_i64())
                        .unwrap_or(0);
                    result = Some((prompt, completion, cache));
                }
            }
        }
    }
    result
}

/// QuotaState 配额判定输入（数值化，与 DB 无关）。
#[derive(Debug, Clone, Default)]
pub struct QuotaState {
    pub is_admin: bool,
    /// 部门预算链：[{name, budget, tree_cost}]。
    pub dept_budgets: Vec<DeptBudgetState>,
    /// 本人本月 tokens/cost。
    pub my_tokens: i64,
    pub my_cost: f64,
    /// 用户 token 配额（0=不限）。
    pub token_quota: i64,
    /// 用户金额配额（0=不限）。
    pub money_quota: f64,
}

/// DeptBudgetState 部门预算状态。
#[derive(Debug, Clone, Default)]
pub struct DeptBudgetState {
    pub name: String,
    pub budget: f64,
    pub tree_cost: f64,
}

/// MONEY_EPSILON 金额比较容差（对应 Go moneyEpsilon）。
pub const MONEY_EPSILON: f64 = 0.005;

/// quota_blocked 配额拦截判定（Go quotaBlocked 纯逻辑等价）。
/// 返回 (blocked, message)。
pub fn quota_blocked(q: &QuotaState) -> (bool, String) {
    if q.is_admin {
        return (false, String::new());
    }
    // 1) 部门预算链：任一部门树内成本合计超限即拦截
    for b in &q.dept_budgets {
        if b.tree_cost >= b.budget - MONEY_EPSILON {
            return (true, format!("部门「{}」本月费用预算已用尽", b.name));
        }
    }
    // 2) 用户金额配额
    if q.money_quota > 0.0 && q.my_cost >= q.money_quota - MONEY_EPSILON {
        return (true, "本月费用配额已用尽".to_string());
    }
    // 3) 用户 token 配额
    if q.token_quota > 0 && q.my_tokens >= q.token_quota {
        return (true, "本月流量配额已用尽".to_string());
    }
    (false, String::new())
}

/// Proxy 代理核心：发送到上游并处理响应。
pub struct Proxy<C: HttpClient> {
    pub client: C,
}

impl<C: HttpClient> Proxy<C> {
    /// proxy 发送请求到上游 URL，返回状态/响应体。
    /// 超长响应拒绝（Err）。
    pub async fn proxy(&self, url: &str, headers: &HashMap<String, String>, body: &[u8]) -> Result<ProxyResult, String> {
        let (status, resp_body) = self.client.post(url, headers, body).await?;
        if resp_body.len() > MAX_RESPONSE_BYTES {
            return Err("upstream response too large".to_string());
        }
        Ok(ProxyResult { status, body: resp_body })
    }
}

// ---- 测试用 mock ----

pub struct MockHttpClient {
    pub responses: HashMap<String, (u16, Vec<u8>)>,
    pub calls: std::sync::Mutex<usize>,
}

impl MockHttpClient {
    pub fn new() -> Self {
        MockHttpClient {
            responses: HashMap::new(),
            calls: std::sync::Mutex::new(0),
        }
    }
}

#[async_trait::async_trait]
impl HttpClient for MockHttpClient {
    async fn post(&self, url: &str, _headers: &HashMap<String, String>, _body: &[u8]) -> Result<(u16, Vec<u8>), String> {
        *self.calls.lock().unwrap() += 1;
        match self.responses.get(url) {
            Some((s, b)) => Ok((*s, b.clone())),
            None => Err("mock: no response".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_usage_from_body_ok() {
        let body = br#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}"#;
        let u = parse_usage_from_body(body).unwrap();
        assert_eq!(u, (100, 50, 0));
        // 无 usage
        assert!(parse_usage_from_body(br#"{"choices":[]}"#).is_none());
    }

    #[test]
    fn sse_usage_extract() {
        let sse = "data: {\"choices\":[]}\n\ndata: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"prompt_cache_hit_tokens\":3}}\n\ndata: [DONE]\n";
        let u = extract_sse_usage(sse).unwrap();
        assert_eq!(u, (10, 5, 3));
        // 无 usage 行
        assert!(extract_sse_usage("data: {\"choices\":[]}\ndata: [DONE]").is_none());
        // 空 body
        assert!(extract_sse_usage("").is_none());
    }

    #[test]
    fn quota_admin_unlimited() {
        let q = QuotaState { is_admin: true, ..Default::default() };
        assert_eq!(quota_blocked(&q).0, false);
    }

    #[test]
    fn quota_token_overflow() {
        let q = QuotaState { my_tokens: 1000, token_quota: 1000, ..Default::default() };
        let (blocked, msg) = quota_blocked(&q);
        assert!(blocked);
        assert!(msg.contains("流量配额"));
        // 未到
        let q2 = QuotaState { my_tokens: 999, token_quota: 1000, ..Default::default() };
        assert_eq!(quota_blocked(&q2).0, false);
    }

    #[test]
    fn quota_money_overflow() {
        let q = QuotaState { my_cost: 9.995, money_quota: 10.0, ..Default::default() };
        let (b, _) = quota_blocked(&q);
        assert!(b);
    }

    #[test]
    fn quota_dept_budget() {
        let q = QuotaState {
            dept_budgets: vec![DeptBudgetState { name: "研发".into(), budget: 100.0, tree_cost: 99.995 }],
            ..Default::default()
        };
        let (b, msg) = quota_blocked(&q);
        assert!(b);
        assert!(msg.contains("研发"));
        // 未超
        let q2 = QuotaState {
            dept_budgets: vec![DeptBudgetState { name: "研发".into(), budget: 100.0, tree_cost: 50.0 }],
            ..Default::default()
        };
        assert_eq!(quota_blocked(&q2).0, false);
    }

    #[tokio::test]
    async fn proxy_with_mock() {
        let mut resp = HashMap::new();
        resp.insert("https://up/v1/chat/completions".to_string(), (200, b"{\"ok\":true}".to_vec()));
        let client = MockHttpClient { responses: resp, calls: std::sync::Mutex::new(0) };
        let p = Proxy { client };
        let r = p.proxy("https://up/v1/chat/completions", &HashMap::new(), b"{}").await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"{\"ok\":true}");
        // 超长拒绝
        let mut resp2 = HashMap::new();
        resp2.insert("https://up/big".to_string(), (200, vec![0u8; MAX_RESPONSE_BYTES + 1]));
        let client2 = MockHttpClient { responses: resp2, calls: std::sync::Mutex::new(0) };
        let p2 = Proxy { client: client2 };
        assert!(p2.proxy("https://up/big", &HashMap::new(), b"{}").await.is_err());
    }
}

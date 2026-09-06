//! 请求体变换与渠道/协议映射(纯逻辑,对应 Go `llmgateway/handler.go` 与
//! `channels/*` 的纯函数部分)。
//!
//! JSON 一律用 `serde_json::Value`;错误一律 `anyhow::Result`。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// DeepSeek 官方 OpenAI 兼容端点。
pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
/// DeepSeek 官方模型表:上下文 1M、输出 384K。
pub const DEEPSEEK_CONTEXT_LEN: i64 = 1_048_576;
pub const DEEPSEEK_MAX_OUTPUT: i64 = 393_216;

/// 从模型 default_params JSON 读取 max_output。
/// `Ok((v, true))` = 字段存在且非零;`Ok((0, false))` = 无字段/为零;
/// `Err(..)` = JSON 解析失败。
pub fn max_output_from_default_params(params: &str) -> anyhow::Result<(i64, bool)> {
    if params.is_empty() {
        return Ok((0, false));
    }
    #[derive(serde::Deserialize, Default)]
    struct P {
        #[serde(default)]
        #[serde(rename = "max_output")]
        max_output: i64,
    }
    let p: P = serde_json::from_str(params)?;
    if p.max_output <= 0 {
        return Ok((0, false));
    }
    Ok((p.max_output, true))
}

/// apply_max_tokens_default:客户端未传 max_tokens 时,从模型
/// default_params.max_output 注入。无 default_params/解析失败时原样返回。
/// 支持 max_completion_tokens 模型的同语义双键(审计 2026-L17)。
///
/// 返回值 `Cow::Borrowed(raw)` 表示请求体未被修改(原样透传)。
pub fn apply_max_tokens_default<'a>(raw: &'a [u8], default_params: &str) -> anyhow::Result<std::borrow::Cow<'a, [u8]>> {
    let mut body: Value = serde_json::from_slice(raw)?;
    let map = body
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("request body is not a JSON object"))?;
    if map.contains_key("max_tokens") || map.contains_key("max_completion_tokens") {
        return Ok(std::borrow::Cow::Borrowed(raw));
    }
    let (v, ok) = max_output_from_default_params(default_params)?;
    if !ok {
        return Ok(std::borrow::Cow::Borrowed(raw));
    }
    map.insert("max_tokens".into(), json!(v));
    let out = serde_json::to_vec(&body)?;
    Ok(std::borrow::Cow::Owned(out))
}

/// apply_stream_usage_request 向流式 chat 请求注入
/// `stream_options.include_usage=true`(P1-1 计量缺口)。
///
/// 规则(与 Go 一致):
/// - 非流式请求(stream != true)原样返回;
/// - 客户端已显式设置 include_usage=false → 尊重,原样返回;
/// - 已设置 include_usage=true → 合并(无重复注入);
/// - 无 stream_options 或 stream_options 非对象 → 整体替换为
///   `{"include_usage": true}`。
pub fn apply_stream_usage_request<'a>(raw: &'a [u8]) -> anyhow::Result<std::borrow::Cow<'a, [u8]>> {
    let mut body: Value = serde_json::from_slice(raw)?;
    let map = body
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("request body is not a JSON object"))?;
    let stream = matches!(map.get("stream"), Some(Value::Bool(true)));
    if !stream {
        return Ok(std::borrow::Cow::Borrowed(raw));
    }
    if let Some(opts) = map.get_mut("stream_options") {
        if let Value::Object(m) = opts {
            if let Some(Value::Bool(false)) = m.get("include_usage") {
                // 客户端显式关闭:respect,不注入
                return Ok(std::borrow::Cow::Borrowed(raw));
            }
            m.insert("include_usage".into(), Value::Bool(true));
            let out = serde_json::to_vec(&body)?;
            return Ok(std::borrow::Cow::Owned(out));
        }
        // stream_options 非对象:Go 语义为整体替换
    }
    map.insert("stream_options".into(), json!({"include_usage": true}));
    let out = serde_json::to_vec(&body)?;
    Ok(std::borrow::Cow::Owned(out))
}

/// apply_channel_overrides 深合并 overrides 进请求体,并删除 remove_keys
/// 中的顶层键(对应 Go `applyChannelOverrides`)。
pub fn apply_channel_overrides(raw: &[u8], overrides: &Value, remove_keys: &[&str]) -> anyhow::Result<Vec<u8>> {
    let mut body: Value = serde_json::from_slice(raw)?;
    let map = body
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("request body is not a JSON object"))?;
    for k in remove_keys {
        map.remove(*k);
    }
    deep_merge(&mut body, overrides);
    Ok(serde_json::to_vec(&body)?)
}

/// deep_merge 将 src 合并进 dst(嵌套对象递归合并,标量覆盖,数组整体替换)。
/// 对应 Go `deepMerge`。
pub fn deep_merge(dst: &mut Value, src: &Value) {
    let (Some(src_map), Some(dst_map)) = (src.as_object(), dst.as_object_mut()) else {
        // src 非对象:Go 语义下循环只处理 src 的 map 键,非对象 src 无效果;
        // dst 非对象时 Go type-assert 失败、整键保持原值。此处两者都安全返回。
        return;
    };
    let keys: Vec<&String> = src_map.keys().collect();
    for k in keys {
        let sv = &src_map[k];
        match (sv, dst_map.get(k)) {
            (Value::Object(_), Some(Value::Object(_))) => {
                let child = dst_map.get_mut(k).unwrap();
                deep_merge(child, sv);
            }
            _ => {
                dst_map.insert(k.clone(), sv.clone());
            }
        }
    }
}

/// upstream_url 把上游 base URL 与 OpenAI chat 端点拼接。
/// base 可能带或不带 /v1 前缀(管理端两种填法都接受)。
pub fn upstream_url(base: &str) -> String {
    upstream_url_for(base, "/chat/completions")
}

/// upstream_url_for 把 base URL 与任意 OpenAI 端点(/chat/completions、
/// /embeddings、/messages)拼接,容忍带/不带 /v1 前缀。
pub fn upstream_url_for(base: &str, endpoint: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}{endpoint}")
    } else {
        format!("{base}/v1{endpoint}")
    }
}

/// anthropic_base_url 推导 Anthropic 兼容端点基址(对应 Go `anthropicBaseURL`):
/// - protocol == "both":BaseURL 是 OpenAI 端点,Anthropic 端点 = {BaseURL}/anthropic/v1
///   (DeepSeek 官方布局);若 BaseURL 已含 /anthropic,尊重原样。
/// - protocol == "anthropic":BaseURL 即管理员填写的 Anthropic 端点,原样返回。
pub fn anthropic_base_url(base: &str, protocol: &str) -> String {
    let base = base.trim_end_matches('/');
    if protocol != "both" {
        return base.to_string();
    }
    if base.contains("/anthropic") {
        base.to_string()
    } else {
        format!("{base}/anthropic/v1")
    }
}

/// 单个模型信息(对应 Go `channels.ModelInfo`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
}

/// parse_oai_models 解析 OpenAI 兼容 GET /models 响应(纯逻辑,对应 Go
/// `ParseOAIModels`):非 JSON 或 data 字段类型错误 → Err。
pub fn parse_oai_models(body: &[u8]) -> anyhow::Result<Vec<ModelInfo>> {
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(default)]
        data: Vec<Item>,
    }
    #[derive(serde::Deserialize)]
    struct Item {
        id: String,
    }
    let resp: Resp = serde_json::from_slice(body)?;
    Ok(resp
        .data
        .into_iter()
        .map(|m| ModelInfo { id: m.id.clone(), display_name: m.id })
        .collect())
}

/// 渠道请求覆盖:overrides 深合并进请求体,remove_keys 从请求体删除。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelOverrides {
    pub overrides: Value,
    pub remove_keys: Vec<String>,
}

/// 渠道接口(对应 Go `channels.Channel` 的纯逻辑部分;HTTP fetch 由调用方注入)。
pub trait Channel: Send + Sync {
    fn name(&self) -> &'static str;
    fn base_url(&self) -> &'static str;
    /// 模型感知的请求覆盖;返回 None 表示该模型无需覆盖(如 reasoner)。
    fn request_overrides(&self, model_id: &str) -> Option<ChannelOverrides>;
    /// 能力预设(FetchModels 响应无值时的兜底):(context_len, max_output)。
    fn default_caps(&self) -> (i64, i64);
    /// 拉取模型列表:fetch_fn(url) -> body,None 时用默认端点构造。
    /// 纯逻辑:URL 构造 + 响应解析;网络由 fetch_fn 承担。
    fn fetch_models(
        &self,
        api_key: &str,
        fetch_fn: &dyn Fn(&str) -> anyhow::Result<Vec<u8>>,
    ) -> anyhow::Result<Vec<ModelInfo>> {
        let _ = api_key;
        let body = fetch_fn(&format!("{}/models", self.base_url()))?;
        parse_oai_models(&body)
    }
}

/// DeepSeek 渠道:官方 OpenAI 兼容 API。
pub struct DeepSeek;

impl Channel for DeepSeek {
    fn name(&self) -> &'static str {
        "deepseek"
    }
    fn base_url(&self) -> &'static str {
        DEEPSEEK_BASE_URL
    }
    /// 强制思考模式 max;思考模式不支持 4 个采样参数,删除。
    /// reasoner 系列不接受 reasoning_effort(上游 400),对其返回无操作。
    fn request_overrides(&self, model_id: &str) -> Option<ChannelOverrides> {
        deepseek_request_overrides(model_id)
    }
    fn default_caps(&self) -> (i64, i64) {
        (DEEPSEEK_CONTEXT_LEN, DEEPSEEK_MAX_OUTPUT)
    }
}

/// deepseek_request_overrides:非 reasoner 模型返回
/// {thinking:{type:enabled}, reasoning_effort:max} + 4 个采样键删除;
/// 含 "reasoner"(大小写不敏感)返回 None。
pub fn deepseek_request_overrides(model_id: &str) -> Option<ChannelOverrides> {
    if model_id.to_lowercase().contains("reasoner") {
        return None;
    }
    Some(ChannelOverrides {
        overrides: json!({
            "thinking": {"type": "enabled"},
            "reasoning_effort": "max",
        }),
        remove_keys: vec![
            "temperature".into(),
            "top_p".into(),
            "presence_penalty".into(),
            "frequency_penalty".into(),
        ],
    })
}

/// channel_request_overrides:按渠道名取请求覆盖(未知渠道返回 None,调用方跳过)。
pub fn channel_request_overrides(channel: &str, model_id: &str) -> Option<ChannelOverrides> {
    get_channel(channel).and_then(|c| c.request_overrides(model_id))
}

fn registry() -> &'static Mutex<HashMap<String, Arc<dyn Channel>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<dyn Channel>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert("deepseek".into(), Arc::new(DeepSeek) as Arc<dyn Channel>);
        Mutex::new(m)
    })
}

/// register 注册渠道(与 Go `channels.Register` 对应)。
pub fn register(c: Arc<dyn Channel>) {
    registry()
        .lock()
        .expect("channel registry poisoned")
        .insert(c.name().to_string(), c);
}

/// get 按名取渠道(与 Go `channels.Get` 对应)。
pub fn get_channel(name: &str) -> Option<Arc<dyn Channel>> {
    registry().lock().expect("channel registry poisoned").get(name).cloned()
}

/// all_channels 返回已注册渠道名(排序,与 Go `channels.All` 对应)。
pub fn all_channels() -> Vec<String> {
    let mut names: Vec<String> = registry()
        .lock()
        .expect("channel registry poisoned")
        .keys()
        .cloned()
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use serde_json::Map;
    use super::*;

    fn as_map(v: &Value) -> &Map<String, Value> {
        v.as_object().expect("object")
    }

    #[test]
    fn max_tokens_inject_from_default_params() {
        let body = br#"{"model":"m","messages":[{"role":"user","content":"hi"}]}"#;
        let out = apply_max_tokens_default(body, r#"{"context_length":1048576,"max_output":393216}"#).unwrap();
        let m: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(as_map(&m)["max_tokens"], json!(393216));
    }

    #[test]
    fn max_tokens_skip_when_client_present() {
        // 客户端传了 max_tokens → 原样
        let body = br#"{"model":"m","max_tokens":100}"#;
        let out = apply_max_tokens_default(body, r#"{"max_output":393216}"#).unwrap();
        assert!(matches!(&out, std::borrow::Cow::Borrowed(b) if *b == body));
        // 客户端传了 max_completion_tokens(同语义双键)→ 原样
        let body2 = br#"{"model":"m","max_completion_tokens":64}"#;
        let out2 = apply_max_tokens_default(body2, r#"{"max_output":393216}"#).unwrap();
        assert!(matches!(&out2, std::borrow::Cow::Borrowed(b) if *b == body2));
        // 无 default_params → 原样
        let out3 = apply_max_tokens_default(body, "").unwrap();
        assert!(matches!(&out3, std::borrow::Cow::Borrowed(b) if *b == body));
    }

    #[test]
    fn stream_usage_inject_and_preserve() {
        // 无 stream_options → 注入
        let out = apply_stream_usage_request(br#"{"model":"m","stream":true}"#).unwrap();
        let m: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(as_map(&m)["stream_options"], json!({"include_usage": true}));

        // 非流式 → 原样(stream_options 不得泄漏进 JSON 模式)
        let non = br#"{"model":"m","messages":[]}"#;
        let out2 = apply_stream_usage_request(non).unwrap();
        assert!(matches!(&out2, std::borrow::Cow::Borrowed(b) if *b == non));

        // 显式 include_usage=false → 尊重
        let exf = br#"{"model":"m","stream":true,"stream_options":{"include_usage":false}}"#;
        let out3 = apply_stream_usage_request(exf).unwrap();
        assert!(matches!(&out3, std::borrow::Cow::Borrowed(b) if *b == exf));

        // 已显式 true → 合并不重复
        let ext = br#"{"model":"m","stream":true,"stream_options":{"include_usage":true}}"#;
        let out4 = apply_stream_usage_request(ext).unwrap();
        let m4: Value = serde_json::from_slice(&out4).unwrap();
        assert_eq!(as_map(&m4)["stream_options"], json!({"include_usage": true}));
    }

    #[test]
    fn channel_overrides_deep_merge_and_remove() {
        let body = br#"{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.7}"#;
        let ov = json!({"thinking": {"type": "enabled"}, "reasoning_effort": "max"});
        let out = apply_channel_overrides(body, &ov, &["temperature"]).unwrap();
        let m: Value = serde_json::from_slice(&out).unwrap();
        let map = as_map(&m);
        assert_eq!(map["reasoning_effort"], json!("max"));
        assert!(!map.contains_key("temperature"));
        assert_eq!(map["thinking"], json!({"type": "enabled"}));
        // messages 保留
        assert_eq!(map["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn deep_merge_nested_recurse_and_scalar_overwrite() {
        let mut dst: Value = json!({
            "a": {"b": {"c": 1}, "keep": "x"},
            "list": [1, 2],
            "scalar": 1,
        });
        let src: Value = json!({
            "a": {"b": {"d": 2}, "other": "y"},   // b 递归合并,keep 保留
            "list": [3],                          // 数组整体替换(Go 语义)
            "scalar": 2,                          // 标量覆盖
            "new": {"nested": true},              // 深拷贝新增
        });
        deep_merge(&mut dst, &src);
        let map = as_map(&dst);
        assert_eq!(map["a"], json!({"b": {"c": 1, "d": 2}, "keep": "x", "other": "y"}));
        assert_eq!(map["list"], json!([3]));
        assert_eq!(map["scalar"], json!(2));
        assert_eq!(map["new"], json!({"nested": true}));
    }

    #[test]
    fn upstream_url_for_with_and_without_v1() {
        assert_eq!(upstream_url_for("https://api.deepseek.com", "/chat/completions"),
                   "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(upstream_url_for("https://api.deepseek.com/", "/chat/completions"),
                   "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(upstream_url_for("https://example.com/v1", "/embeddings"),
                   "https://example.com/v1/embeddings");
        assert_eq!(upstream_url_for("https://example.com/v1/", "/messages"),
                   "https://example.com/v1/messages");
        assert_eq!(upstream_url("https://x"), "https://x/v1/chat/completions");
    }

    #[test]
    fn anthropic_base_url_mapping() {
        // both:开放 OpenAI base → /anthropic/v1 推导;已含 /anthropic 尊重原样
        assert_eq!(anthropic_base_url("https://api.deepseek.com", "both"),
                   "https://api.deepseek.com/anthropic/v1");
        assert_eq!(anthropic_base_url("https://gateway.example/anthropic", "both"),
                   "https://gateway.example/anthropic");
        // anthropic:原样返回
        assert_eq!(anthropic_base_url("https://api.anthropic.com", "anthropic"),
                   "https://api.anthropic.com");
    }

    #[test]
    fn deepseek_overrides_model_aware() {
        let ov = deepseek_request_overrides("deepseek-v4-flash").unwrap();
        assert_eq!(ov.overrides, json!({"thinking": {"type": "enabled"}, "reasoning_effort": "max"}));
        assert_eq!(ov.remove_keys, vec!["temperature", "top_p", "presence_penalty", "frequency_penalty"]);
        // reasoner:无操作(大小写不敏感)
        assert_eq!(deepseek_request_overrides("deepseek-reasoner-v2"), None);
        assert_eq!(deepseek_request_overrides("DeepSeek-V4-REASONER"), None);
    }

    #[test]
    fn channel_registry_and_parse_oai_models() {
        let names = all_channels();
        assert!(names.contains(&"deepseek".to_string()));
        let ch = get_channel("deepseek").expect("deepseek registered");
        assert_eq!(ch.base_url(), DEEPSEEK_BASE_URL);
        assert_eq!(ch.default_caps(), (DEEPSEEK_CONTEXT_LEN, DEEPSEEK_MAX_OUTPUT));
        assert!(get_channel("nope").is_none());

        // ParseOAIModels
        let ms = parse_oai_models(br#"{"object":"list","data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}"#).unwrap();
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[0].id, "deepseek-v4-flash");
        assert_eq!(ms[0].display_name, "deepseek-v4-flash");
        assert_eq!(ms[1].id, "deepseek-v4-pro");
        // 畸形:非 JSON / data 类型错误 / id 类型错误 → Err
        assert!(parse_oai_models(b"{oops").is_err());
        assert!(parse_oai_models(br#"{"data":{"id":"x"}}"#).is_err());
        assert!(parse_oai_models(br#"{"data":[{"id":7}]}"#).is_err());
    }

    #[test]
    fn deepseek_fetch_models_uses_injected_fetch_fn() {
        let used = std::sync::Mutex::new(String::new());
        let ds = DeepSeek;
        let ms = ds
            .fetch_models("k", &|url: &str| {
                *used.lock().unwrap() = url.to_string();
                Ok(br#"{"object":"list","data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}"#.to_vec())
            })
            .unwrap();
        assert_eq!(*used.lock().unwrap(), "https://api.deepseek.com/models");
        assert_eq!(ms.len(), 2);
    }
}

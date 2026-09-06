//! 模型路由匹配(纯逻辑,对应 Go `llmgateway/upstream.go` 的去重与匹配部分;
//! DB/缓存部分留在服务端,不在本 crate)。

use std::collections::HashSet;

/// 一个启用中的 LLM provider(OpenAI 兼容或 Anthropic 兼容)。
/// 对应 Go `Upstream`(DB 加载后的值对象)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upstream {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub channel: String,
    pub protocol: String,
}

/// merge_model_names 把 b 的名字追加进 a,去重且保序。
/// 对应 Go `mergeModelNames`(provider.models JSON 列与 models 表合并)。
pub fn merge_model_names(a: &[String], b: &[String]) -> Vec<String> {
    if b.is_empty() {
        return a.to_vec();
    }
    let mut seen: HashSet<&String> = HashSet::with_capacity(a.len() + b.len());
    let mut out = Vec::with_capacity(a.len() + b.len());
    for n in a.iter().chain(b.iter()) {
        if seen.insert(n) {
            out.push(n.clone());
        }
    }
    out
}

/// protocol_matches 报告 provider 协议是否匹配请求协议:
/// - 请求协议为空("")= 任意,恒匹配;
/// - provider 为 "both"(0044)= 与任何协议请求都匹配(openai 与 anthropic 路由);
/// - 其余精确匹配。
pub fn protocol_matches(provider_protocol: &str, requested: &str) -> bool {
    if requested.is_empty() {
        return true;
    }
    provider_protocol == "both" || provider_protocol == requested
}

/// match_models_by_protocol 返回服务 model_name 的所有 provider(保持传入顺序),
/// protocol 为空表示任意协议。对应 Go `MatchModelsByProtocol` 的纯匹配部分。
pub fn match_models_by_protocol(ups: &[Upstream], model_name: &str, protocol: &str) -> Vec<Upstream> {
    ups.iter()
        .filter(|u| protocol_matches(&u.protocol, protocol) && u.models.iter().any(|m| m == model_name))
        .cloned()
        .collect()
}

/// match_model 取第一个服务 model_name 的 provider;无匹配返回 None
/// (对应 Go `MatchModel`,其 ErrNotFound 语义由调用方从 None 映射)。
pub fn match_model(ups: &[Upstream], model_name: &str) -> Option<Upstream> {
    match_models_by_protocol(ups, model_name, "").into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(name: &str, models: &[&str], protocol: &str) -> Upstream {
        Upstream {
            name: name.into(),
            base_url: format!("http://{name}"),
            api_key: format!("sk-{name}"),
            models: models.iter().map(|s| s.to_string()).collect(),
            channel: String::new(),
            protocol: protocol.into(),
        }
    }

    #[test]
    fn match_model_by_name_and_order() {
        let ups = vec![
            up("a", &["m1", "m2"], "openai"),
            up("b", &["m3"], "openai"),
            up("c", &["m1"], "both"),
        ];
        // 模型名匹配 provider 列表
        assert_eq!(match_model(&ups, "m2").unwrap().name, "a");
        assert_eq!(match_model(&ups, "m3").unwrap().name, "b");
        // m1 两个 provider 都服务:按候选顺序返回(失败故障转移)
        let all = match_models_by_protocol(&ups, "m1", "");
        assert_eq!(all.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), vec!["a", "c"]);
        // 无匹配
        assert!(match_model(&ups, "nope").is_none());
    }

    #[test]
    fn match_by_protocol_and_both() {
        let ups = vec![
            up("openai-only", &["m1"], "openai"),
            up("anthropic-only", &["m1"], "anthropic"),
            up("dual", &["m1"], "both"),
        ];
        // openai 路由
        let o = match_models_by_protocol(&ups, "m1", "openai");
        assert_eq!(o.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), vec!["openai-only", "dual"]);
        // anthropic 路由
        let a = match_models_by_protocol(&ups, "m1", "anthropic");
        assert_eq!(a.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), vec!["anthropic-only", "dual"]);
        // 空协议 = 任意
        assert_eq!(match_models_by_protocol(&ups, "m1", "").len(), 3);
        // 未知协议(防御):只匹配 both
        let u = match_models_by_protocol(&ups, "m1", "gemini");
        assert_eq!(u.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["dual"]);
    }

    #[test]
    fn merge_model_names_dedup_preserves_order() {
        let a = vec!["m1".to_string(), "m2".to_string()];
        let b = vec!["m2".to_string(), "m3".to_string(), "m1".to_string()];
        assert_eq!(merge_model_names(&a, &b), vec!["m1", "m2", "m3"]);
        // 空 b 返回 a 副本
        assert_eq!(merge_model_names(&a, &[]), a);
        // 全空
        assert!(merge_model_names(&[], &[]).is_empty());
    }

    #[test]
    fn protocol_matches_semantics() {
        assert!(protocol_matches("openai", "")); // 任意
        assert!(protocol_matches("openai", "openai"));
        assert!(!protocol_matches("openai", "anthropic"));
        assert!(protocol_matches("both", "openai"));
        assert!(protocol_matches("both", "anthropic"));
        assert!(protocol_matches("both", "whatever"));
    }
}

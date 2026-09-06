//! PicoAide LLM 网关纯函数库(Rust 版 llmgateway 纯逻辑)。
//!
//! 对应 Go `server/internal/llmgateway` 的纯函数部分:
//! - `protocol`   : 请求体变换(max_tokens 注入 / stream_options / 渠道 override /
//!                   deepMerge / upstream URL 拼接 / 渠道判定与协议映射)
//! - `ratelimit`  : 内存令牌桶限流器(每用户每分钟)
//! - `match`      : 模型名 ↔ provider 列表匹配(upstream 路由纯逻辑)
//! - 本文件       : usage 解析 / 密钥脱敏 / 空闲超时读行
//!
//! 全部为无 DB、无 HTTP 的纯逻辑,行为契约对齐 Go 实现与测试。

pub mod match_;
pub mod protocol;
pub mod ratelimit;

pub use match_::{match_model, match_models_by_protocol, merge_model_names, protocol_matches, Upstream};
pub use protocol::{
    anthropic_base_url, apply_channel_overrides, apply_max_tokens_default,
    apply_stream_usage_request, channel_request_overrides, deep_merge,
    deepseek_request_overrides, max_output_from_default_params, parse_oai_models,
    upstream_url, upstream_url_for, ChannelOverrides, ModelInfo, DEEPSEEK_BASE_URL,
    DEEPSEEK_CONTEXT_LEN, DEEPSEEK_MAX_OUTPUT,
};
pub use ratelimit::{Bucket, RateLimiter, DEFAULT_RATE_LIMIT};

use std::borrow::Cow;
use std::io::BufRead;

/// 脱敏密钥的最小长度阈值:过短的字符串(如单个字母)遍布正常响应内容,
/// 替换会破坏响应且几乎没有泄露价值;真实 API key(sk- 前缀等)远长于此。
pub const MIN_REDACT_SECRET_LEN: usize = 8;

/// 一次 chat 调用的 token 计量结果(对应 Go parseUsage 返回的四元组)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsageTokens {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_hit_tokens: i64,
}

/// parse_usage 从 chat completion 响应提取 token 计数:完整 JSON 体(非流式)
/// 或携带 usage 的 SSE "data:" 行均可。
///
/// 返回 `Ok(None)` = 无 usage(空行 / `[DONE]` / 无 usage 字段);
/// `Ok(Some(..))` = 提取成功;`Err(..)` = JSON 解析失败。
///
/// cache_hit 优先取 `prompt_cache_hit_tokens`;仅报 miss 时用
/// `prompt_tokens - prompt_cache_miss_tokens` 推算(0029/0030 缓存计费)。
pub fn parse_usage(raw: &[u8]) -> anyhow::Result<Option<UsageTokens>> {
    let data = raw.strip_prefix(b"data:").unwrap_or(raw);
    let data = data.trim_ascii();
    if data.is_empty() || data == b"[DONE]" {
        return Ok(None);
    }
    #[derive(serde::Deserialize)]
    struct Chunk {
        #[serde(default)]
        usage: Option<Usage>,
    }
    #[derive(serde::Deserialize, Default)]
    struct Usage {
        #[serde(default)]
        prompt_tokens: i64,
        #[serde(default)]
        completion_tokens: i64,
        #[serde(default)]
        prompt_cache_hit_tokens: i64,
        #[serde(default)]
        prompt_cache_miss_tokens: i64,
    }
    let chunk: Chunk = serde_json::from_slice(data)?;
    let Some(u) = chunk.usage else {
        return Ok(None);
    };
    let mut cache_hit = u.prompt_cache_hit_tokens;
    if cache_hit <= 0 && u.prompt_cache_miss_tokens > 0 {
        cache_hit = u.prompt_tokens - u.prompt_cache_miss_tokens;
        if cache_hit < 0 {
            cache_hit = 0;
        }
    }
    Ok(Some(UsageTokens {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        cache_hit_tokens: cache_hit,
    }))
}

/// redact_secrets 把 raw 中出现的每个 secret 替换为 `***`(仅替换长度 >= 8
/// 的密钥)。无匹配时返回原 slice(零分配);有匹配返回新 buffer。
///
/// 用途:上游(恶意/被攻陷/异常)在响应体或响应头中回显服务端持有的官方
/// key 时,客户端不得看到——网关是 key 的唯一持有者与最终责任方。
pub fn redact_secrets<'a>(raw: &'a [u8], secrets: &[&str]) -> Cow<'a, [u8]> {
    if raw.is_empty() {
        return Cow::Borrowed(raw);
    }
    let mut out: Cow<'_, [u8]> = Cow::Borrowed(raw);
    for s in secrets {
        if s.len() < MIN_REDACT_SECRET_LEN || out.is_empty() {
            continue;
        }
        let needle = s.as_bytes();
        if !subslice_contains(&out, needle) {
            continue;
        }
        out = Cow::Owned(replace_all(&out, needle, b"***"));
    }
    out
}

/// subslice_contains 判断 haystack 是否包含 needle 子串(字节精确匹配)。
fn subslice_contains(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    hay.windows(needle.len()).any(|w| w == needle)
}

/// replace_all 把 haystack 中所有 needle 非重叠出现替换为 repl。
fn replace_all(hay: &[u8], needle: &[u8], repl: &[u8]) -> Vec<u8> {
    debug_assert!(!needle.is_empty());
    let mut out = Vec::with_capacity(hay.len());
    let mut i = 0;
    while i < hay.len() {
        if hay[i..].starts_with(needle) {
            out.extend_from_slice(repl);
            i += needle.len();
        } else {
            out.push(hay[i]);
            i += 1;
        }
    }
    out
}

/// redact_header_value 对单个响应头值做与 redact_secrets 相同的脱敏。
pub fn redact_header_value(value: &str, secrets: &[&str]) -> String {
    match redact_secrets(value.as_bytes(), secrets) {
        Cow::Borrowed(_) => value.to_string(),
        Cow::Owned(v) => String::from_utf8_lossy(&v).into_owned(),
    }
}

/// 空闲超时读行错误。
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReadLineError {
    /// idle 窗口内没有任何字节到达。
    #[error("upstream stream idle timeout")]
    Idle,
}

/// read_line_with_idle 读一行(含末尾换行),idle 窗口内无数据到达则以
/// `ReadLineError::Idle` 返回(对应 Go 的 errStreamIdleTimeout)。
///
/// 返回 `(line, eof)`:`eof=true` 表示已到达流末尾(无更多数据,line 可能
/// 是换行前的遗留内容)。`idle` 为零时长时退化为阻塞读。
///
/// 注意:超时返回后,读线程会在后台继续阻塞直到数据到达或被显式释放
/// (调用方负责关闭底层流,与 Go 语义一致)。
pub fn read_line_with_idle<R>(mut r: R, idle: std::time::Duration) -> Result<(String, bool), ReadLineError>
where
    R: BufRead + Send + 'static,
{
    if idle.is_zero() {
        return read_line_blocking(&mut r);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let n = r.read_line(&mut line).unwrap_or(0);
        let eof = n == 0;
        let _ = tx.send((line, eof));
    });
    rx.recv_timeout(idle).map_err(|_| ReadLineError::Idle)
}

fn read_line_blocking<R: BufRead>(r: &mut R) -> Result<(String, bool), ReadLineError> {
    let mut line = String::new();
    let n = r.read_line(&mut line).unwrap_or(0);
    Ok((line, n == 0))
}

#[allow(unused)] // 与 Go minRedactSecretLen 同名常量对齐,供文档引用
const _: usize = MIN_REDACT_SECRET_LEN;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn parse_usage_full_body_and_sse_line() {
        // 非流式完整 JSON 体
        let body = br#"{"id":"x","usage":{"prompt_tokens":8,"completion_tokens":3}}"#;
        let u = parse_usage(body).unwrap().unwrap();
        assert_eq!(u, UsageTokens { prompt_tokens: 8, completion_tokens: 3, cache_hit_tokens: 0 });

        // SSE "data:" 行(Go 流式路径)
        let line = b"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n";
        let u = parse_usage(line).unwrap().unwrap();
        assert_eq!(u, UsageTokens { prompt_tokens: 10, completion_tokens: 5, cache_hit_tokens: 0 });
    }

    #[test]
    fn parse_usage_cache_hit_and_miss_fallback() {
        // 直接命中
        let hit = br#"data: {"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}"#;
        let u = parse_usage(hit).unwrap().unwrap();
        assert_eq!(u.cache_hit_tokens, 80);

        // 仅 miss → 用 prompt - miss 推算
        let fallback = br#"{"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_cache_miss_tokens":30}}"#;
        let u = parse_usage(fallback).unwrap().unwrap();
        assert_eq!(u.cache_hit_tokens, 70);
    }

    #[test]
    fn parse_usage_none_and_malformed() {
        assert_eq!(parse_usage(b"").unwrap(), None);
        assert_eq!(parse_usage(b"data: [DONE]").unwrap(), None);
        assert_eq!(parse_usage(br#"{"choices":[]}"#).unwrap(), None);
        assert!(parse_usage(b"data: {oops").is_err());
    }

    #[test]
    fn redact_secrets_replaces_long_only() {
        let raw = br#"{"content":"key sk-abc123456789 leaked here"}"#;
        let out = redact_secrets(raw, &["sk-abc123456789"]);
        let out = String::from_utf8_lossy(&out);
        assert!(!out.contains("sk-abc123456789"));
        assert!(out.contains("***"));
        assert!(out.contains("key "));

        // 短于阈值不替换(避免误伤正常内容)
        assert_eq!(redact_secrets(b"a tiny xyz", &["tiny"]), Cow::Borrowed(&b"a tiny xyz"[..]));

        // 无匹配返回原 slice
        assert_eq!(redact_secrets(b"no secrets here", &["sk-abcdefgh"]), Cow::Borrowed(&b"no secrets here"[..]));

        // 头部值脱敏
        let v = redact_header_value("x-echo: sk-aaabbbcccdd", &["sk-aaabbbcccdd"]);
        assert!(!v.contains("sk-aaabbbcccdd"));
        assert!(v.contains("***"));
    }

    #[test]
    fn read_line_with_idle_normal_and_timeout() {
        // 正常:直接读到整行
        let cur = std::io::Cursor::new(b"hello\n".to_vec());
        let (line, eof) = read_line_with_idle(cur, std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(line, "hello\n");
        assert!(!eof);

        // 超时:读线程阻塞在 gate 上(fill_buf 等待 release),idle 窗口内无数据
        struct Gate {
            release: Option<std::sync::mpsc::Receiver<()>>,
        }
        impl Read for Gate {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                Ok(0)
            }
        }
        impl BufRead for Gate {
            fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
                if let Some(rx) = self.release.take() {
                    let _ = rx.recv(); // 阻塞直到被释放
                }
                Ok(&[])
            }
            fn consume(&mut self, _: usize) {}
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let g = Gate { release: Some(rx) };
        let res = read_line_with_idle(g, std::time::Duration::from_millis(30));
        assert_eq!(res, Err(ReadLineError::Idle));
        tx.send(()).unwrap(); // 释放后台线程
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

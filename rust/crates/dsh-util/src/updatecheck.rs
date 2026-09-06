//! 版本检查:查询 GitHub Releases API 的 latest 稳定版本,与当前版本做
//! 严格 SemVer 比较,并带 TTL 缓存与 singleflight 合并(Go
//! `server/internal/updatecheck` 的等价移植)。
//!
//! 与桌面客户端(`packages/host/desktop/src/update-checker.ts`)共享同一
//! release 源与同一套严格 SemVer 比较规则,保证两端对「是否有更新」的
//! 判断一致。任何获取/解析失败都以 [`UpdateCheckError`] 返回,调用方应
//! 静默降级(版本检查失败绝不影响服务器信息页展示)。
//!
//! 注意:本模块的 [`compare_semver`] 与 `crate::semver::compare_semver`
//! (通用版本比较)语义不同——本模块按 Go 语义要求「双方必须都是
//! canonical stable SemVer」,任一非法输入视为相等(0),build 元数据按
//! 字符串参与比较;通用比较器则做数字 run 拆分,非法输入按字节序回退。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

/// GitHub 仓库(公开 release 的归属仓库)。
pub const RELEASE_REPOSITORY: &str = "picoaide/picoaide-harness";

/// 返回最新稳定 release 的公开端点。
pub const VERSION_ENDPOINT: &str =
    "https://api.github.com/repos/picoaide/picoaide-harness/releases/latest";

/// 接收的最大响应体字节数(镜像桌面客户端 MAX_VERSION_RESPONSE_BYTES)。
pub const MAX_RESPONSE_BODY: usize = 256 * 1024;

/// 整个请求(DNS + TLS + 头 + 体)的硬超时。
pub const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(8);

/// 缓存结果的有效期:版本检查是低频、低频变化的数据,缓存 6 小时足以让
/// 「每次打开服务器信息页」都不打外网 API(无外网环境尤其重要——首次
/// 失败后会周期性重试,而不是每次请求都卡 8 秒)。
pub const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// 等待并发检查完成的最长时间(覆盖底层 8s 超时)。
const CONCURRENT_WAIT_TIMEOUT: Duration = Duration::from_secs(12);

/// 版本检查不可用错误(Go `ErrUnavailable` 哨兵等价)。
///
/// 任何获取/解析 release 信息的失败路径都会得到本错误(消息各异),调用
/// 方据此静默降级(没有人会因为版本检查失败而停止工作)。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("version check unavailable: {0}")]
pub struct UpdateCheckError(String);

impl UpdateCheckError {
    /// 构造不可用错误(Go `fmt.Errorf("%w: ...", ErrUnavailable)` 等价)。
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    /// 错误正文(不含 "version check unavailable: " 前缀)。
    pub fn message(&self) -> &str {
        &self.0
    }

    /// 本类型即「版本检查不可用」的哨兵:所有实例恒为 true
    /// (Go 侧 `errors.Is(err, ErrUnavailable)` 匹配语义)。
    pub fn is_unavailable(&self) -> bool {
        true
    }
}

/// 一次成功检查的结果(Go `updatecheck.Result` 等价)。
///
/// JSON 字段名与 Go 结构体的 `json` tag 完全一致。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateCheckResult {
    /// 服务端当前运行的版本(可能为 "dev")。
    pub current: String,
    /// 最新稳定 release 版本(canonical,无 v 前缀)。
    pub latest: String,
    /// Latest > Current(严格 SemVer)时为 true。
    pub update_available: bool,
    /// GitHub release 页链接(供运维查看)。
    pub release_url: String,
    /// 检查时刻的 RFC3339 时间戳(UTC)。
    pub checked_at: String,
}

/// HTTP 传输抽象:发起 GET 并返回 (状态码, 响应体)。
///
/// 生产实现是 [`ReqwestTransport`];测试用 mock 直接返回预设响应、不触网。
/// 实现应保证响应体有界(内存安全),[`Checker::check`] 会二次校验
/// [`MAX_RESPONSE_BODY`]。
pub trait HttpTransport: Send + Sync {
    /// GET `endpoint`,携带 `Accept: <accept>` 头。
    fn fetch<'a>(
        &'a self,
        endpoint: &'a str,
        accept: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(u16, Vec<u8>), UpdateCheckError>> + Send + 'a>>;
}

/// 基于 reqwest(rustls)的生产传输:整个请求受 [`HTTP_CLIENT_TIMEOUT`] 约束。
#[derive(Debug)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// 构造带超时的生产客户端(Go `New()` 等价)。
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(HTTP_CLIENT_TIMEOUT)
            .build()
            .expect("reqwest client with rustls backend must build");
        Self { client }
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for ReqwestTransport {
    fn fetch<'a>(
        &'a self,
        endpoint: &'a str,
        accept: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(u16, Vec<u8>), UpdateCheckError>> + Send + 'a>>
    {
        Box::pin(async move {
            let resp = self
                .client
                .get(endpoint)
                .header(reqwest::header::ACCEPT, accept)
                .send()
                .await
                .map_err(|e| UpdateCheckError::unavailable(format!("{e}")))?;
            let status = resp.status().as_u16();
            let mut resp = resp;
            let mut body: Vec<u8> = Vec::with_capacity(64 * 1024);
            while let Some(chunk) = resp
                .chunk()
                .await
                .map_err(|e| UpdateCheckError::unavailable(format!("{e}")))?
            {
                body.extend_from_slice(&chunk);
                if body.len() > MAX_RESPONSE_BODY {
                    return Err(UpdateCheckError::unavailable("response too large"));
                }
            }
            Ok((status, body))
        })
    }
}

/// 单次检查器:携带可注入的 HTTP 传输与端点(测试用 mock / 本地端点)。
pub struct Checker<T: HttpTransport = ReqwestTransport> {
    transport: T,
    endpoint: String,
}

impl Checker<ReqwestTransport> {
    /// 生产构造:默认端点 [`VERSION_ENDPOINT`] + 超时客户端(Go `New()` 等价)。
    pub fn new() -> Self {
        Self::with_endpoint(VERSION_ENDPOINT)
    }

    /// 覆盖端点(测试),传输仍为生产客户端。
    pub fn with_endpoint(endpoint: impl Into<String>) -> Self {
        Self::with_transport(ReqwestTransport::new(), endpoint)
    }
}

impl Default for Checker<ReqwestTransport> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: HttpTransport> Checker<T> {
    /// 注入自定义传输与端点(测试/宿主适配)。
    pub fn with_transport(transport: T, endpoint: impl Into<String>) -> Self {
        Self {
            transport,
            endpoint: endpoint.into(),
        }
    }

    /// 当前端点。
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// 查询 release 端点并与 current 比较。
    ///
    /// `current` 是服务端运行中的版本;非 SemVer 值(如 "dev")一律不上报
    /// 更新(本地构建不应打扰运维)。失败返回 [`UpdateCheckError`](服务
    /// 不可达 / 非 200 / 响应过大 / JSON 非法 / tag 非法),调用方应静默
    /// 降级。
    pub async fn check(&self, current: &str) -> Result<UpdateCheckResult, UpdateCheckError> {
        let (status, body) = self
            .transport
            .fetch(&self.endpoint, "application/json")
            .await?;
        if status != 200 {
            return Err(UpdateCheckError::unavailable(format!("http {status}")));
        }
        if body.len() > MAX_RESPONSE_BODY {
            return Err(UpdateCheckError::unavailable("response too large"));
        }
        let payload: ReleasePayload = serde_json::from_slice(&body)
            .map_err(|e| UpdateCheckError::unavailable(format!("{e}")))?;
        let latest = parse_canonical_stable(&payload.tag_name);
        if latest.is_empty() {
            return Err(UpdateCheckError::unavailable(format!(
                "invalid tag {:?}",
                payload.tag_name
            )));
        }

        let update_available = parse_canonical_stable_valid(current)
            .map(|cur| compare_semver(&latest, &cur) > 0)
            .unwrap_or(false);

        Ok(UpdateCheckResult {
            current: current.to_string(),
            latest,
            update_available,
            release_url: payload.html_url,
            checked_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        })
    }
}

/// GitHub releases/latest 响应载荷(只取所需字段;缺字段与 Go 一致地容忍)。
#[derive(Debug, Deserialize)]
struct ReleasePayload {
    #[serde(default, rename = "tag_name")]
    tag_name: String,
    #[serde(default, rename = "html_url")]
    html_url: String,
}

#[derive(Debug)]
struct CacheState {
    /// 最近一次成功结果;TTL 过期后仍保留(失败刷新时返回旧值给等待者)。
    cached: Option<UpdateCheckResult>,
    /// 最近一次成功写入时刻。
    checked_at: Option<Instant>,
    /// 进行中的检查通知(Some = 有领导者在跑,None = 空闲)。
    inflight: Option<Arc<tokio::sync::Notify>>,
}

impl CacheState {
    fn new() -> Self {
        Self {
            cached: None,
            checked_at: None,
            inflight: None,
        }
    }
}

/// 包装 [`Checker`] 并缓存最近一次成功结果(TTL 内直接返回)。
/// 并发安全:多个并发请求共享一次底层检查(singleflight 语义)。
pub struct CachedChecker<T: HttpTransport = ReqwestTransport> {
    inner: Checker<T>,
    ttl: Duration,
    state: tokio::sync::Mutex<CacheState>,
}

impl CachedChecker<ReqwestTransport> {
    /// 生产构造:共享默认端点与超时客户端(Go `NewCached()` 等价)。
    pub fn new() -> Self {
        Self::from_checker(Checker::new())
    }
}

impl Default for CachedChecker<ReqwestTransport> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: HttpTransport> CachedChecker<T> {
    /// 从已有检查器构造(测试注入 mock 传输)。
    pub fn from_checker(inner: Checker<T>) -> Self {
        Self {
            inner,
            ttl: CACHE_TTL,
            state: tokio::sync::Mutex::new(CacheState::new()),
        }
    }

    /// 返回缓存结果(未过期)或并发触发一次真实检查。
    ///
    /// 缓存未命中/已过期时只有第一个调用者发起网络请求,其余等待同一个
    /// 结果(Notify 合并);底层失败时返回错误但不缓存失败(下次重试),
    /// 已过期的旧值仍保留供等待者取用。
    pub async fn check(&self, current: &str) -> Result<UpdateCheckResult, UpdateCheckError> {
        // 快路径:未过期的缓存直接返回(Go: cached != nil && since < TTL)。
        {
            let st = self.state.lock().await;
            if let (Some(res), Some(at)) = (&st.cached, st.checked_at) {
                if at.elapsed() < self.ttl {
                    return Ok(res.clone());
                }
            }
        }

        let mut st = self.state.lock().await;
        if let Some(notify) = st.inflight.clone() {
            // 已有并发检查在跑:持锁注册等待者(enable 以完成注册),然后
            // 等待完成(最多 12s,覆盖底层 8s 超时)。注册与领导者
            // notify_waiters 都发生在同一把锁内,不会丢失唤醒。
            let mut notified = Box::pin(notify.notified_owned());
            let _ = notified.as_mut().enable();
            drop(st);

            if tokio::time::timeout(CONCURRENT_WAIT_TIMEOUT, notified)
                .await
                .is_err()
            {
                return Err(UpdateCheckError::unavailable("concurrent check timed out"));
            }
            let st = self.state.lock().await;
            return match &st.cached {
                Some(res) => Ok(res.clone()),
                None => Err(UpdateCheckError::unavailable("concurrent check failed")),
            };
        }

        // 成为领导者:发起真实检查。
        let notify = Arc::new(tokio::sync::Notify::new());
        st.inflight = Some(notify.clone());
        drop(st);

        let out = self.inner.check(current).await;

        let mut st = self.state.lock().await;
        st.inflight = None;
        if let Ok(res) = &out {
            st.cached = Some(res.clone());
            st.checked_at = Some(Instant::now());
        }
        notify.notify_waiters();
        out
    }
}

/// ParseCanonicalStable 解析 canonical stable SemVer(允许小写 "v" 前缀,
/// 前缀被剥离);预发布版本被拒绝(releases/latest 不会返回它们)。
/// build 元数据保留在结果中(与 Go 行为一致)。
pub fn parse_canonical_stable(tag: &str) -> String {
    let v = tag.strip_prefix('v').unwrap_or(tag);
    if is_stable_semver(v) {
        v.to_string()
    } else {
        String::new()
    }
}

/// ParseCanonicalStableValid 是 [`parse_canonical_stable`] 的合法性信号版。
pub fn parse_canonical_stable_valid(version: &str) -> Option<String> {
    let canonical = parse_canonical_stable(version);
    if canonical.is_empty() {
        None
    } else {
        Some(canonical)
    }
}

/// IsStableSemVer 报告 v 是否为严格 stable SemVer(M.m.p,无预发布;
/// 允许 build 元数据与 "v" 前缀,均在验证前剥离)。
pub fn is_stable_semver(version: &str) -> bool {
    let core = version.split('+').next().unwrap_or(version);
    let core = core.strip_prefix('v').unwrap_or(core);
    if core.contains('-') {
        // 预发布存在 → 非 stable
        return false;
    }
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| is_numeric(p) && !(p.len() > 1 && p.starts_with('0')))
}

fn is_numeric(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// CompareSemVer 按严格 SemVer 优先级比较 M.m.p 三元组(数值比较,
/// 无前导零溢出问题),返回 -1/0/1。
///
/// 双方都必须是 canonical stable SemVer(允许 v 前缀与 build 元数据);
/// 任一非法输入视为相等(0)。与 `crate::semver::compare_semver` 不同:
/// 后者接受任意近似版本并做 run 拆分,非法输入按字节序回退;本函数按
/// Go `util.CompareSemVer` 语义实现。
pub fn compare_semver(left: &str, right: &str) -> i32 {
    let (lc, rc) = match (
        parse_canonical_stable_valid(left),
        parse_canonical_stable_valid(right),
    ) {
        (Some(l), Some(r)) => (l, r),
        _ => return 0,
    };
    let lt: Vec<&str> = lc.split('.').collect();
    let rt: Vec<&str> = rc.split('.').collect();
    // is_stable_semver 保证 canonical 在 '+' 前恰有 3 个点分段;build 元数据
    // 可含点,故 split 可能多于 3 段——与 Go 一致,只比较前 3 段(多余的
    // build 段不影响优先级)。少于 3 段不可达(校验保证)。
    for i in 0..3 {
        let l = lt[i];
        let r = rt[i];
        if l.len() != r.len() {
            return if l.len() < r.len() { -1 } else { 1 };
        }
        if l != r {
            return if l < r { -1 } else { 1 };
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Mock 传输:记录命中次数,按预设处理器返回响应,可加延迟(扩大并发
    /// 竞速窗口)。完全不触网。
    struct MockTransport {
        hits: AtomicUsize,
        delay: Duration,
        handler: Arc<
            dyn Fn(&str, &str) -> Result<(u16, Vec<u8>), UpdateCheckError> + Send + Sync,
        >,
    }

    impl MockTransport {
        fn new(
            handler: impl Fn(&str, &str) -> Result<(u16, Vec<u8>), UpdateCheckError>
                + Send
                + Sync
                + 'static,
        ) -> Self {
            Self {
                hits: AtomicUsize::new(0),
                delay: Duration::ZERO,
                handler: Arc::new(handler),
            }
        }

        fn with_delay(mut self, delay: Duration) -> Self {
            self.delay = delay;
            self
        }

        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
    }

    impl HttpTransport for MockTransport {
        fn fetch<'a>(
            &'a self,
            endpoint: &'a str,
            accept: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<(u16, Vec<u8>), UpdateCheckError>> + Send + 'a>>
        {
            let handler = self.handler.clone();
            let delay = self.delay;
            Box::pin(async move {
                self.hits.fetch_add(1, Ordering::SeqCst);
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                (handler)(
                    endpoint,
                    accept,
                )
            })
        }
    }

    fn ok_body(byte: &[u8]) -> Result<(u16, Vec<u8>), UpdateCheckError> {
        Ok((200, byte.to_vec()))
    }

    fn mock_checker(
        handler: impl Fn(&str, &str) -> Result<(u16, Vec<u8>), UpdateCheckError>
            + Send
            + Sync
            + 'static,
    ) -> Checker<MockTransport> {
        Checker::with_transport(MockTransport::new(handler), "http://mock.local")
    }

    #[tokio::test]
    async fn check_reports_update_available() {
        let c = mock_checker(|_, accept| {
            assert_eq!(accept, "application/json");
            ok_body(br#"{"tag_name":"v2.6.0","html_url":"https://github.com/picoaide/picoaide-harness/releases/tag/v2.6.0"}"#)
        });
        let res = c.check("2.5.1").await.unwrap();
        assert_eq!(res.latest, "2.6.0");
        assert!(res.update_available);
        assert_eq!(res.current, "2.5.1");
        assert_eq!(
            res.release_url,
            "https://github.com/picoaide/picoaide-harness/releases/tag/v2.6.0"
        );
        assert!(!res.checked_at.is_empty());
    }

    #[tokio::test]
    async fn check_up_to_date() {
        let c = mock_checker(|_, _| ok_body(br#"{"tag_name":"v2.5.1"}"#));
        let res = c.check("2.5.1").await.unwrap();
        assert!(!res.update_available);
        assert_eq!(res.latest, "2.5.1");
    }

    #[tokio::test]
    async fn check_unavailable_on_http_500() {
        let c = mock_checker(|_, _| Ok((500, Vec::new())));
        let err = c.check("2.5.1").await.unwrap_err();
        assert!(err.is_unavailable());
        assert!(err.to_string().contains("unavailable"));
        assert!(err.message().contains("http 500"));
    }

    #[tokio::test]
    async fn check_invalid_tag_errors() {
        let c = mock_checker(|_, _| ok_body(br#"{"tag_name":"not-a-version"}"#));
        let err = c.check("2.5.1").await.unwrap_err();
        assert!(err.is_unavailable());
        assert!(err.message().contains("invalid tag"));
    }

    #[tokio::test]
    async fn check_invalid_json_errors() {
        let c = mock_checker(|_, _| ok_body(b"{oops"));
        assert!(c.check("2.5.1").await.is_err());
    }

    #[tokio::test]
    async fn dev_current_never_updates() {
        let c = mock_checker(|_, _| ok_body(br#"{"tag_name":"v99.0.0"}"#));
        let res = c.check("dev").await.unwrap();
        assert!(!res.update_available, "dev build should never report update");
        assert_eq!(res.current, "dev");
    }

    #[tokio::test]
    async fn response_too_large_refused() {
        let mut body = Vec::with_capacity(MAX_RESPONSE_BODY + 64);
        body.extend_from_slice(br#"{"tag_name":"v9.9.9","pad":""#);
        body.extend(std::iter::repeat(b'x').take(MAX_RESPONSE_BODY));
        body.extend_from_slice(b"\"}");
        let c = mock_checker(move |_, _| Ok((200, body.clone())));
        let err = c.check("2.5.1").await.unwrap_err();
        assert!(err.is_unavailable());
        assert!(err.message().contains("response too large"));
    }

    #[tokio::test]
    async fn malformed_endpoint_fails_without_network() {
        let c = Checker::with_transport(ReqwestTransport::new(), "://bad-url");
        let err = c.check("2.5.1").await.unwrap_err();
        assert!(err.is_unavailable());
    }

    #[tokio::test]
    async fn defaults_are_sane() {
        let c = Checker::new();
        assert_eq!(c.endpoint(), VERSION_ENDPOINT);
        let _cached = CachedChecker::new();
    }

    #[test]
    fn compare_semver_matches_go_cases() {
        let cases: &[(&str, &str, i32)] = &[
            ("2.5.1", "2.5.1", 0),
            ("2.5.1", "2.5.2", -1),
            ("2.5.2", "2.5.1", 1),
            ("2.5.9", "2.6.0", -1),
            ("2.9.0", "2.10.0", -1),
            ("2.10.0", "2.9.0", 1),
            ("10.0.0", "9.9.9", 1),
            ("1.0.0", "v1.0.0", 0), // v prefix stripped
            ("dev", "2.5.1", 0),    // invalid → equal
        ];
        for (l, r, want) in cases {
            assert_eq!(compare_semver(l, r), *want, "compare_semver({l:?}, {r:?})");
            assert_eq!(compare_semver(r, l), -*want, "compare_semver({r:?}, {l:?})");
        }
    }

    #[test]
    fn compare_semver_build_metadata_follows_go_behavior() {
        // Go 的 ParseCanonicalStable 只校验 '+' 前的核心但把含 build 的
        // 整串返回;CompareSemVer 按 '.' 切分后逐段(长度优先)比较,第 3
        // 段 "1+build" vs "1" 长度不同 → 非相等 —— 忠实于 Go 的逐段字符串
        // 比较行为(与桌面端 strict SemVer 忽略 build 不同,此处以 Go 为准)。
        assert_eq!(compare_semver("2.5.1+build", "2.5.1"), 1);
        assert_eq!(compare_semver("2.5.1", "2.5.1+build"), -1);
        // "1+build"(len 7) > "2"(len 1) 在第 3 段即分出。
        assert_eq!(compare_semver("2.5.1+build", "2.5.2"), 1);
        assert_eq!(compare_semver("2.5.2", "2.5.1+build"), -1);
    }

    #[test]
    fn is_stable_semver_matches_go_cases() {
        let cases: &[(&str, bool)] = &[
            ("2.5.1", true),
            ("2.5.1-rc.1", false),
            ("2.5", false),
            ("2.5.1.4", false),
            ("02.5.1", false),
            ("2.5.01", false),
            ("", false),
            ("v2.5.1", true),
            ("2.5.1+build", true),
        ];
        for (inp, want) in cases {
            assert_eq!(is_stable_semver(inp), *want, "is_stable_semver({inp:?})");
        }
    }

    #[test]
    fn parse_canonical_stable_matches_go_cases() {
        assert_eq!(parse_canonical_stable("v2.5.1"), "2.5.1");
        assert_eq!(parse_canonical_stable("2.5.1"), "2.5.1");
        assert_eq!(parse_canonical_stable("v2.5.1-rc.1"), "");
        assert_eq!(
            parse_canonical_stable_valid("v2.5.1"),
            Some("2.5.1".to_string())
        );
        assert_eq!(parse_canonical_stable_valid("dev"), None);
    }

    #[test]
    fn result_json_uses_go_field_names() {
        let r = UpdateCheckResult {
            current: "2.5.1".into(),
            latest: "2.6.0".into(),
            update_available: true,
            release_url: "https://x".into(),
            checked_at: "2026-09-06T00:00:00Z".into(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["current"], "2.5.1");
        assert_eq!(v["latest"], "2.6.0");
        assert_eq!(v["update_available"], true);
        assert_eq!(v["release_url"], "https://x");
        assert_eq!(v["checked_at"], "2026-09-06T00:00:00Z");
    }

    #[tokio::test]
    async fn cached_check_ttl_hits_once() {
        let checker = CachedChecker::from_checker(mock_checker(|_, _| {
            ok_body(br#"{"tag_name":"v2.6.0"}"#)
        }));
        let first = checker.check("2.5.1").await.unwrap();
        assert!(first.update_available);
        let second = checker.check("2.5.1").await.unwrap();
        assert_eq!(second.latest, first.latest);
        assert_eq!(
            checker.inner.transport.hits(),
            1,
            "second call must be served from cache"
        );
    }

    #[tokio::test]
    async fn cached_singleflight_shares_one_network_request() {
        let mock = MockTransport::new(|_, _| ok_body(br#"{"tag_name":"v2.6.0"}"#))
            .with_delay(Duration::from_millis(30)); // widen the race window
        let checker = Arc::new(CachedChecker::from_checker(Checker::with_transport(
            mock,
            "http://mock.local",
        )));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let c = checker.clone();
            handles.push(tokio::spawn(async move { c.check("2.5.1").await }));
        }
        for h in handles {
            let res = h.await.unwrap().unwrap();
            assert!(res.update_available);
        }
        assert_eq!(
            checker.inner.transport.hits(),
            1,
            "singleflight: one network hit for all concurrent callers"
        );
    }

    #[tokio::test]
    async fn cached_concurrent_failure_errors_everyone_and_nothing_cached() {
        let checker = Arc::new(CachedChecker::from_checker(mock_checker(|_, _| {
            Ok((500, Vec::new()))
        })));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let c = checker.clone();
            handles.push(tokio::spawn(async move { c.check("2.5.1").await }));
        }
        for h in handles {
            let err = h.await.unwrap();
            assert!(err.is_err(), "every waiter must observe the failure");
            assert!(err.unwrap_err().is_unavailable());
        }
        // 失败不缓存:后续检查重试(仍失败)。
        let err = checker.check("2.5.1").await.unwrap_err();
        assert!(err.is_unavailable());
    }

    #[tokio::test]
    async fn cached_failure_is_not_cached_and_stale_kept() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = hits.clone();
        let checker = CachedChecker::from_checker(mock_checker(move |_, _| {
            if hits2.fetch_add(1, Ordering::SeqCst) == 0 {
                ok_body(br#"{"tag_name":"v2.6.0"}"#)
            } else {
                Ok((500, Vec::new()))
            }
        }));
        let first = checker.check("2.5.1").await.unwrap();
        assert_eq!(first.latest, "2.6.0");

        // 强制 TTL 过期以触发刷新。
        {
            let mut st = checker.state.lock().await;
            st.checked_at = Some(Instant::now() - CACHE_TTL - Duration::from_secs(60));
        }

        let err = checker.check("2.5.1").await.unwrap_err();
        assert!(
            err.is_unavailable(),
            "refresh should fail loud (caller degrades)"
        );

        // 旧值(过期)仍保留在内部,失败本身不缓存 → 之后会重试。
        {
            let st = checker.state.lock().await;
            assert_eq!(st.cached.as_ref().unwrap().latest, "2.6.0");
        }
        assert!(hits.load(Ordering::SeqCst) >= 2, "refresh attempted");
    }

    #[tokio::test]
    async fn cached_ttl_expiry_refreshes() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = hits.clone();
        let checker = CachedChecker::from_checker(mock_checker(move |_, _| {
            hits2.fetch_add(1, Ordering::SeqCst);
            ok_body(br#"{"tag_name":"v2.6.0"}"#)
        }));
        assert!(checker.check("2.5.1").await.unwrap().update_available);
        {
            let mut st = checker.state.lock().await;
            st.checked_at = Some(Instant::now() - CACHE_TTL - Duration::from_secs(60));
        }
        // 过期后再次检查 → 再次触网并正常返回。
        assert!(checker.check("2.5.1").await.unwrap().update_available);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }
}

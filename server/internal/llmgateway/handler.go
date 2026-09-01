package llmgateway

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// defaultRateLimit is the default per-user requests per minute.
const defaultRateLimit = 60

// maxChatBody caps the chat completions request body (memory guard; typical
// requests are a few hundred KB even with long context).
const maxChatBody = 16 << 20

// maxUpstreamBody caps a non-stream upstream response body (C-8); oversized
// responses are refused with 502 instead of being buffered unboundedly.
// Test-injectable.
var maxUpstreamBody = 32 << 20

// STREAM_IDLE_TIMEOUT is the max gap between upstream SSE chunks before the
// stream is treated as hung and terminated.
const STREAM_IDLE_TIMEOUT = 90 * time.Second

// streamIdleTimeout is test-injectable, defaulting to STREAM_IDLE_TIMEOUT.
var streamIdleTimeout = STREAM_IDLE_TIMEOUT

// errStreamIdleTimeout is returned by readLineWithIdle when no upstream data
// arrived within the idle window.
var errStreamIdleTimeout = errors.New("upstream stream idle timeout")

// API holds gateway dependencies.
type API struct {
	DB     *sql.DB
	client *http.Client // non-stream requests (bounded timeout)
	sse    *http.Client // streaming requests (lifecycle = request context)
	rl     *rateLimiter
	conc   *concurrencyMeter // 按模型 in-flight 计数(2026-08-31)
}

// handleChatCompletions proxies /v1/chat/completions to the matching upstream.
func (a *API) handleChatCompletions(c *gin.Context) {
	user := serverauth.CurrentUser(c)
	if user == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxChatBody)
	raw, err := io.ReadAll(c.Request.Body)
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "VALIDATION", "请求体过大")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	var req struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || req.Model == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体缺少 model 字段")
		return
	}

	if !a.rl.allow(user.ID, a.rateLimitPerMinute()) {
		serverauth.WriteError(c, http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁,请稍后再试")
		return
	}
	if blocked, msg := a.quotaBlocked(user); blocked {
		serverauth.WriteError(c, http.StatusTooManyRequests, "QUOTA_EXCEEDED", msg)
		return
	}

	ups, err := MatchModelsByProtocol(a.DB, req.Model, "openai")
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "模型路由查询失败")
		return
	}
	if len(ups) == 0 {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "模型不存在或不可用")
		return
	}

	// max_tokens 默认值注入依据(模型维度,与候选无关,提前读取)
	defaultParams, _ := serverstore.ModelDefaultParams(a.DB, req.Model)

	// 并发计量(2026-08-31):模型已确认,记录 in-flight;done 在所有退出
	// 路径执行(defer,含 panic/流中断)。
	done := a.conc.begin(req.Model)
	defer done()

	// streaming path: insert a pending usage row first, backfilled on the
	// final SSE chunk; a client disconnect leaves it pending (no rollback).
	var usageID int64
	if req.Stream {
		usageID, err = serverstore.RecordUsage(a.DB, user.ID, req.Model, 0, 0)
		if err != nil {
			log.Printf("gateway: record pending usage: %v", err)
		}
	}

	// 故障转移:按序尝试每个 provider(连接失败/5xx/首字节超时 → 下一个)。
	// 单 provider 失败即返回,不重试(避免重复计费);4xx 由 forward 原样返回。
	// 渠道 override 与 max_tokens 注入按候选独立计算(从原始 body 出发):
	// failover 时第二个 provider 不得收到首个 provider 的渠道参数污染。
	var resp *http.Response
	var respSecrets []string // 成功 provider 的官方 key(响应脱敏用)
	for i := range ups {
		body := raw
		if ups[i].Channel != "" {
			if ch, ok := channels.Get(ups[i].Channel); ok {
				ov, rm := ch.RequestOverrides(req.Model)
				if raw2, err := applyChannelOverrides(body, ov, rm); err == nil {
					body = raw2
				}
			}
		}
		if defaultParams != "" {
			if raw2, err := applyMaxTokensDefault(body, defaultParams); err == nil {
				body = raw2
			}
		}
		// P1-1 (metering): every streaming request must ask the upstream for
		// usage in the final SSE chunk, otherwise the pending usage row can
		// never be backfilled and metering is silently bypassed.
		if req.Stream {
			if raw2, err := applyStreamUsageRequest(body); err == nil {
				body = raw2
			}
		}
		resp, err = a.forward(c, &ups[i], body, req.Stream)
		if err == nil {
			respSecrets = []string{ups[i].APIKey}
			break
		}
		log.Printf("gateway: model %s provider %q failed: %v", safeModelForLog(req.Model), ups[i].Name, err)
	}
	if resp == nil {
		// C-9: no provider succeeded; the pending usage row can never be
		// backfilled, so drop it instead of inflating aggregates.
		if usageID > 0 {
			if err := serverstore.DeleteUsage(a.DB, usageID); err != nil {
				log.Printf("gateway: delete pending usage: %v", err)
			}
		}
		// 5#11: fixed text — never echo upstream error details to clients
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游服务不可用")
		return
	}
	if req.Stream {
		a.serveStream(c, resp, usageID, respSecrets)
		return
	}
	a.serveJSON(c, resp, user.ID, req.Model, respSecrets)
}

// maxOutputFromDefaultParams 从模型 default_params JSON 读取 max_output。
// ok=false 表示 JSON 里没有该字段;解析失败返回 err。
func maxOutputFromDefaultParams(params string) (int64, bool, error) {
	if params == "" {
		return 0, false, nil
	}
	var p struct {
		MaxOutput int64 `json:"max_output"`
	}
	if err := json.Unmarshal([]byte(params), &p); err != nil {
		return 0, false, err
	}
	if p.MaxOutput == 0 {
		return 0, false, nil
	}
	return p.MaxOutput, true, nil
}

// applyMaxTokensDefault:客户端未传 max_tokens 时,从模型 default_params.max_output 注入。
// 无 default_params/解析失败时原样返回。支持 max_completion_tokens 模型的同语义双键
// (审计2026-L17:注入 max_tokens 与既有 max_completion_tokens 冲突)。
func applyMaxTokensDefault(raw []byte, defaultParams string) ([]byte, error) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return raw, err
	}
	if _, ok := body["max_tokens"]; ok {
		return raw, nil
	}
	if _, ok := body["max_completion_tokens"]; ok {
		return raw, nil
	}
	v, ok, err := maxOutputFromDefaultParams(defaultParams)
	if err != nil || !ok {
		return raw, nil
	}
	body["max_tokens"] = v
	return json.Marshal(body)
}

// applyStreamUsageRequest injects stream_options.include_usage=true into a
// streaming chat request (P1-1, metering gap). Without it, upstreams omit the
// final usage chunk in SSE responses by default, so the streaming path could
// never backfill tokens — quota/budget enforcement was silently bypassed for
// every streamed conversation. Only adds the option when the caller did not
// already set it (a client-supplied stream_options is preserved).
func applyStreamUsageRequest(raw []byte) ([]byte, error) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return raw, err
	}
	stream, _ := body["stream"].(bool)
	if !stream {
		return raw, nil
	}
	if opts, ok := body["stream_options"]; ok {
		// Already present: merge include_usage=true unless it is explicitly
		// disabled by the client (respect an explicit false).
		if m, isMap := opts.(map[string]any); isMap {
			if v, has := m["include_usage"]; has {
				if b, isBool := v.(bool); isBool && !b {
					return raw, nil
				}
			}
			m["include_usage"] = true
			return json.Marshal(body)
		}
	}
	body["stream_options"] = map[string]any{"include_usage": true}
	return json.Marshal(body)
}

// applyChannelOverrides 深合并 overrides 进请求体,并删除 removeKeys 中的键。
func applyChannelOverrides(raw []byte, overrides map[string]any, removeKeys []string) ([]byte, error) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return raw, err
	}
	for _, k := range removeKeys {
		delete(body, k)
	}
	deepMerge(body, overrides)
	return json.Marshal(body)
}

// deepMerge 将 src 合并进 dst(嵌套 map 递归合并,标量覆盖)。
func deepMerge(dst, src map[string]any) {
	for k, v := range src {
		if sv, ok := v.(map[string]any); ok {
			if dv, ok := dst[k].(map[string]any); ok {
				deepMerge(dv, sv)
				continue
			}
			cp := map[string]any{}
			deepMerge(cp, sv)
			dst[k] = cp
			continue
		}
		dst[k] = v
	}
}

// upstreamURL joins an upstream base URL with the OpenAI chat endpoint.
// Base URLs may or may not carry the /v1 prefix (admin enters either form).
func upstreamURL(base string) string {
	return upstreamURLFor(base, "/chat/completions")
}

// upstreamURLFor joins a base URL with an OpenAI endpoint (/chat/completions,
// /embeddings), tolerating bases with or without the /v1 prefix.
func upstreamURLFor(base, endpoint string) string {
	base = strings.TrimSuffix(base, "/")
	if strings.HasSuffix(base, "/v1") {
		return base + endpoint
	}
	return base + "/v1" + endpoint
}

// forward sends the raw body to the upstream, replacing Authorization with
// the upstream key. It makes exactly one attempt: failover lives in the
// caller's candidate loop, so a repeated call only happens on a different
// provider (re-sending to the same one could double-bill). 4xx responses are
// returned as-is (client error, no failover); connection errors, 5xx and
// header timeouts return an error, which the caller treats as failover-eligible.
func (a *API) forward(c *gin.Context, up *Upstream, raw []byte, stream bool) (*http.Response, error) {
	url := upstreamURL(up.BaseURL)
	client := a.client
	if stream {
		client = a.sse
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+up.APIKey)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 500 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	return resp, nil
}

// nonStreamBodyTimeout bounds reading a non-stream upstream body once headers
// arrived (审计2026-M11:全量 client.Timeout 会截断长报告生成;这里只限 body 读)
var nonStreamBodyTimeout = 10 * time.Minute

// passHeaders 是透传给客户端的上游响应头白名单:其余头(Set-Cookie/Server/
// hop-by-hop 等)一律丢弃(审计2026-L10)
var passHeaders = map[string]bool{
	"Content-Type":          true,
	"Retry-After":           true,
	"X-Request-Id":          true,
	"X-RateLimit-Limit":     true,
	"X-RateLimit-Remaining": true,
}

// minRedactSecretLen 是脱敏密钥的最小长度阈值:过短的字符串(如单个字母)
// 遍布正常响应内容,替换会破坏响应且几乎没有泄露价值;真实 API key
// (sk- 前缀等)远长于此。
const minRedactSecretLen = 8

// redactSecrets 把 raw 中出现的每个 secret 替换为 `***`(仅替换长度 >= 8
// 的密钥)。无匹配时返回原 slice(零分配);有匹配返回新 slice。
// 用途:上游(恶意/被攻陷/异常)在响应体或响应头中回显服务端持有的官方
// key 时,客户端不得看到——网关是 key 的唯一持有者与最终责任方。
func redactSecrets(raw []byte, secrets []string) []byte {
	if len(raw) == 0 {
		return raw
	}
	out := raw
	for _, s := range secrets {
		if len(s) < minRedactSecretLen || len(out) == 0 {
			continue
		}
		if bytes.Index(out, []byte(s)) < 0 {
			continue
		}
		out = bytes.ReplaceAll(out, []byte(s), []byte("***"))
	}
	return out
}

// redactHeaderValue 对单个响应头值做与 redactSecrets 相同的脱敏。
func redactHeaderValue(value string, secrets []string) string {
	redacted := redactSecrets([]byte(value), secrets)
	if len(redacted) == len(value) {
		return value
	}
	return string(redacted)
}

// serveJSON passes a non-stream upstream response through and records usage.
// secrets: 本次请求使用的上游官方 key——上游若在响应中回显,透传前脱敏。
func (a *API) serveJSON(c *gin.Context, resp *http.Response, userID int64, model string, secrets []string) {
	defer resp.Body.Close()
	type readResult struct {
		body []byte
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		b, e := io.ReadAll(io.LimitReader(resp.Body, int64(maxUpstreamBody)+1))
		ch <- readResult{b, e}
	}()
	var body []byte
	var err error
	select {
	case r := <-ch:
		body, err = r.body, r.err
	case <-time.After(nonStreamBodyTimeout):
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游响应超时")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "读取上游响应失败")
		return
	}
	if len(body) > maxUpstreamBody {
		// C-8: refuse oversized responses instead of buffering them
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游响应过大")
		return
	}
	body = redactSecrets(body, secrets)
	if pt, ct, cch, ok, _ := parseUsage(body); ok {
		if _, err := serverstore.RecordUsageKindCached(a.DB, userID, model, pt, ct, cch, "chat"); err != nil {
			log.Printf("gateway: record usage: %v", err)
		}
	}
	c.Status(resp.StatusCode)
	for k, vv := range resp.Header {
		if !passHeaders[k] {
			continue
		}
		for _, v := range vv {
			c.Writer.Header().Add(k, redactHeaderValue(v, secrets))
		}
	}
	c.Writer.Write(body)
}

// serveStream passes an SSE response through line by line, preserving
// "data:" lines and "[DONE]", and backfills the pending usage row from the
// final chunk's "usage" field. Rows that can never be backfilled are deleted
// (C-9): upstream 4xx, client disconnect, write failure. secrets: 上游官方
// key,用于响应行/头脱敏。
func (a *API) serveStream(c *gin.Context, resp *http.Response, usageID int64, secrets []string) {
	defer resp.Body.Close()
	// upstream 4xx: no SSE to stream, the pending row is dropped
	if resp.StatusCode >= 400 {
		if usageID > 0 {
			if err := serverstore.DeleteUsage(a.DB, usageID); err != nil {
				log.Printf("gateway: delete pending usage: %v", err)
			}
		}
		c.Status(resp.StatusCode)
		for k, vv := range resp.Header {
			if !passHeaders[k] {
				continue
			}
			for _, v := range vv {
				c.Writer.Header().Add(k, redactHeaderValue(v, secrets))
			}
		}
		// 4xx body 限小读,透传前脱敏(错误体同样可能回显 key)
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		c.Writer.Write(redactSecrets(errBody, secrets))
		return
	}
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.WriteHeader(resp.StatusCode)
	fl, _ := c.Writer.(http.Flusher)
	br := bufio.NewReader(resp.Body)
	clientGone := false
	idleTimedOut := false
	lineEOF := false
	backfilled := false // usage row received real tokens (must not be dropped)

	// 2026-08-31 性能优化:原 readLineWithIdle 每行创建 goroutine+channel+
	// NewTimer(2000 并发流 × 2000 行/流 ≈ 800 万次分配,timer 调度在万级
	// 活跃 timer 下显著退化——实测服务端每流 26s→52s,吞吐腰斩)。
	// 改为:单读 goroutine 常驻循环读行(零 per-line goroutine),
	// idle 超时用一个共享 ticker 每 1s 检查(零 per-line timer)。
	type lineRes struct {
		line string
		err  error
	}
	lines := make(chan lineRes, 64)
	readGone := make(chan struct{})
	go func() {
		defer close(readGone)
		for {
			l, e := br.ReadString('\n')
			select {
			case lines <- lineRes{l, e}:
			case <-c.Request.Context().Done():
				return
			}
			if e != nil {
				return
			}
		}
	}()
	// idle 检查:每 1s 看一次"距上次收到行的间隔",超过 streamIdleTimeout 即超时。
	// 复用全局 ticker 不可行(每流独立计时应复位),用每流单 ticker(仅 1 个/流,
	// 非每行) + lastLineAt 判定。
	idleTick := time.NewTicker(time.Second)
	defer idleTick.Stop()
	lastLineAt := time.Now()

	for {
		// 5#9/5#10: stop pumping once the client context is gone
		if c.Request.Context().Err() != nil {
			clientGone = true
			break
		}
		select {
		case r := <-lines:
			lastLineAt = time.Now()
			if len(r.line) > 0 {
				line := string(redactSecrets([]byte(r.line), secrets))
				if s := strings.TrimSpace(line); strings.HasPrefix(s, "data:") {
					if strings.Contains(s, `"usage"`) {
						if pt, ct, cch, ok, perr := parseUsage([]byte(s)); perr != nil {
							log.Printf("gateway: parse usage line: %v", perr)
						} else if ok && usageID > 0 {
							if uerr := serverstore.UpdateUsageTokensCached(a.DB, usageID, pt, ct, cch); uerr != nil {
								log.Printf("gateway: backfill usage: %v", uerr)
							} else if pt+ct > 0 {
								backfilled = true
							}
						}
					}
				}
				if _, werr := c.Writer.WriteString(line); werr != nil {
					clientGone = true
					break
				}
				if fl != nil {
					fl.Flush()
				}
			}
			if r.err != nil { // EOF / 上游关闭
				lineEOF = true
			}
		case <-idleTick.C:
			if time.Since(lastLineAt) > streamIdleTimeout {
				idleTimedOut = true
				log.Printf("gateway: stream idle timeout after %v, terminating", streamIdleTimeout)
				fmt.Fprintf(c.Writer, "data: %s\n\n", `{"error":{"code":"UPSTREAM","message":"上游响应空闲超时"}}`)
				if fl != nil {
					fl.Flush()
				}
			}
		case <-c.Request.Context().Done():
			clientGone = true
		}
		if clientGone || idleTimedOut || lineEOF {
			break
		}
	}
	// 等待读 goroutine 退出(defer resp.Body.Close 释放阻塞读)
	select {
	case <-readGone:
	case <-time.After(time.Second):
	}
	// idle 超时与客户端断开时,从未回填的 pending 行必须清除(否则计量虚增
	// 一小时);已回填真实 token 的行不得删除,否则真实用量从统计中丢失。
	if (clientGone || idleTimedOut) && usageID > 0 && !backfilled {
		if err := serverstore.DeleteUsage(a.DB, usageID); err != nil {
			log.Printf("gateway: delete pending usage: %v", err)
		}
	}
}

// readLineWithIdle reads a line, failing with errStreamIdleTimeout if no
// bytes arrive within idle. A blocked read goroutine is released by the
// caller's deferred resp.Body.Close() once this returns.
// 2026-08-31 性能优化:每行创建 goroutine+channel+timer 在 2000 并发长流下
// 开销极大(400 万次分配)。缓冲 channel 复用——但 bufio 阻塞读仍需 goroutine;
// 见 serveStream 的 readLineCh 单 goroutine 模式批量读行(原实现保留此函数
// 供 messages 路径等使用,其行频率低)。
func readLineWithIdle(br *bufio.Reader, idle time.Duration) (string, error) {
	if idle <= 0 {
		return br.ReadString('\n')
	}
	type lineRes struct {
		line string
		err  error
	}
	ch := make(chan lineRes, 1)
	go func() {
		l, e := br.ReadString('\n')
		ch <- lineRes{l, e}
	}()
	timer := time.NewTimer(idle)
	defer timer.Stop()
	select {
	case r := <-ch:
		return r.line, r.err
	case <-timer.C:
		return "", errStreamIdleTimeout
	}
}

// parseUsage extracts token counts from a chat completion response: a full
// JSON body (non-stream) or an SSE "data:" line carrying usage.
// 返回 cacheHit 为缓存命中的输入 token(DeepSeek prompt_cache_hit_tokens,
// 0029/0030 缓存计费);0 = 未报告/未命中。
func parseUsage(raw []byte) (pt, ct, cacheHit int64, ok bool, err error) {
	data := bytes.TrimSpace(bytes.TrimPrefix(raw, []byte("data:")))
	if len(data) == 0 || bytes.Equal(data, []byte("[DONE]")) {
		return 0, 0, 0, false, nil
	}
	var chunk struct {
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			PromptCacheHit   int64 `json:"prompt_cache_hit_tokens"`
			PromptCacheMiss  int64 `json:"prompt_cache_miss_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil {
		return 0, 0, 0, false, err
	}
	if chunk.Usage == nil {
		return 0, 0, 0, false, nil
	}
	// 兼容两种上游:优先 prompt_cache_hit_tokens;仅有 miss 时用 prompt-miss 推算。
	cacheHit = chunk.Usage.PromptCacheHit
	if cacheHit <= 0 && chunk.Usage.PromptCacheMiss > 0 {
		cacheHit = chunk.Usage.PromptTokens - chunk.Usage.PromptCacheMiss
		if cacheHit < 0 {
			cacheHit = 0
		}
	}
	return chunk.Usage.PromptTokens, chunk.Usage.CompletionTokens, cacheHit, true, nil
}

// rateLimitPerMinute reads the configurable per-user limit from settings.
func (a *API) rateLimitPerMinute() int {
	v, ok, err := serverstore.GetSetting(a.DB, "gateway.rate_limit")
	if err != nil || !ok {
		return defaultRateLimit
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 {
		return defaultRateLimit
	}
	return n
}

// 审计修复 2026-P (M3): 金额比较容差——usage.cost 为 REAL(float64),
// 多次累加存在分钱级舍入误差;临界点误拦(差几分钱即 429)或漏拦都用
// 半厘(0.005 元)容差规避,与「计量即金钱」的记账边界一致。
const moneyEpsilon = 0.005

// quotaBlocked reports whether the user has exhausted their calendar-month
// token, money, or department budget quota (429 QUOTA_EXCEEDED at the caller).
// Admins are always exempt; 0 quota means unlimited.
// 审计修复 2026-P (M1): 查询失败改为 fail-closed——计费强制路径上 DB 瞬时
// 故障若放行超限请求,后台可能被刷出无限费用;改为拒绝并记日志。
// 2026-08-31 查询优化:原实现 6 次串行 DB 查询(部门成员+预算+用户用量×3),
// 改为 1 次 MonthUsageByUsers 批量取用户+部门成员用量,减少热路径 DB 往返。
func (a *API) quotaBlocked(user *serverstore.User) (bool, string) {
	if user.IsAdmin {
		return false, ""
	}

	// 1) 部门预算链路(仅需 groupID/name/budget,不查用量)
	budgets, err := serverstore.EffectiveDeptBudget(a.DB, user.ID)
	if err != nil {
		log.Printf("gateway: dept budget lookup error (fail-closed): %v", err)
		return true, "部门预算校验暂不可用,请稍后再试"
	}

	// 2) 收集需要查用量的用户集合:本人 + 各部门树成员(用户与部门共用一次查询)
	memberIDs := map[int64]bool{user.ID: true}
	for _, b := range budgets {
		ids, err := serverstore.DeptMemberIDs(a.DB, b.GroupID)
		if err != nil {
			log.Printf("gateway: dept member lookup error (fail-closed): %v", err)
			return true, "部门预算校验暂不可用,请稍后再试"
		}
		for _, id := range ids {
			memberIDs[id] = true
		}
	}
	ids := make([]int64, 0, len(memberIDs))
	for id := range memberIDs {
		ids = append(ids, id)
	}
	usages, err := serverstore.MonthUsageByUsers(a.DB, ids)
	if err != nil {
		log.Printf("gateway: usage lookup error (fail-closed): %v", err)
		return true, "配额校验暂不可用,请稍后再试"
	}

	// 3) 部门预算:任一部门树内成本合计超限即拦截
	for _, b := range budgets {
		total := 0.0
		ids, err := serverstore.DeptMemberIDs(a.DB, b.GroupID)
		if err != nil {
			log.Printf("gateway: dept member lookup error (fail-closed): %v", err)
			return true, "部门预算校验暂不可用,请稍后再试"
		}
		for _, id := range ids {
			total += usages[id].Cost
		}
		if total >= b.Budget-moneyEpsilon {
			return true, "部门「" + b.Name + "」本月费用预算已用尽"
		}
	}

	// 4) 用户金额配额
	moneyQuota, err := serverstore.EffectiveMoneyQuota(a.DB, user)
	if err != nil {
		log.Printf("gateway: money quota lookup error (fail-closed): %v", err)
		return true, "金额配额校验暂不可用,请稍后再试"
	}
	myUsage := usages[user.ID]
	if moneyQuota > 0 && myUsage.Cost >= moneyQuota-moneyEpsilon {
		return true, "本月费用配额已用尽"
	}

	// 5) 用户 token 配额
	quota, err := serverstore.EffectiveQuota(a.DB, user)
	if err != nil {
		log.Printf("gateway: quota lookup error (fail-closed): %v", err)
		return true, "配额校验暂不可用,请稍后再试"
	}
	if quota > 0 && myUsage.Tokens >= quota {
		return true, "本月流量配额已用尽"
	}
	return false, ""
}

// deptBudgetBlocked reports whether any department budget on the user's
// inheritance chain (归属部门 + 祖先链) has been exhausted. A department
// budget caps the whole subtree's monthly cost, so every member of the tree
// is blocked once it is exceeded. Admins are exempt.
// 审计修复 2026-P (M1): fail-closed——预算查询失败拒绝请求(不免费放行)。
func (a *API) deptBudgetBlocked(user *serverstore.User) (bool, string) {
	if user.IsAdmin {
		return false, ""
	}
	budgets, err := serverstore.EffectiveDeptBudget(a.DB, user.ID)
	if err != nil {
		log.Printf("gateway: dept budget lookup error (fail-closed): %v", err)
		return true, "部门预算校验暂不可用,请稍后再试"
	}
	if len(budgets) == 0 {
		return false, ""
	}
	for _, b := range budgets {
		used, err := serverstore.DeptMonthlyCost(a.DB, b.GroupID)
		if err != nil {
			log.Printf("gateway: dept cost lookup error (fail-closed): %v", err)
			return true, "部门预算校验暂不可用,请稍后再试"
		}
		// 金额比较带容差(审计修复 2026-P M3):float64 舍入误差不误拦临界点
		if used >= b.Budget-moneyEpsilon {
			return true, "部门「" + b.Name + "」本月费用预算已用尽"
		}
	}
	return false, ""
}

// moneyQuotaBlocked reports whether the user has exhausted their
// calendar-month money quota (yuan, 0022).
// 审计修复 2026-P (M1): fail-closed——金额配额查询失败拒绝请求。
func (a *API) moneyQuotaBlocked(user *serverstore.User) (bool, string) {
	quota, err := serverstore.EffectiveMoneyQuota(a.DB, user)
	if err != nil {
		log.Printf("gateway: money quota lookup error (fail-closed): %v", err)
		return true, "金额配额校验暂不可用,请稍后再试"
	}
	if quota <= 0 {
		return false, ""
	}
	used, err := serverstore.UserMonthlyCost(a.DB, user.ID)
	if err != nil {
		log.Printf("gateway: money usage lookup error (fail-closed): %v", err)
		return true, "金额配额校验暂不可用,请稍后再试"
	}
	// 金额比较带容差(审计修复 2026-P M3)
	if used >= quota-moneyEpsilon {
		return true, "本月费用配额已用尽"
	}
	return false, ""
}

// rateLimiter is a per-user token bucket with bounded map and lazy cleanup.
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[int64]*bucket
	max     int
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{buckets: map[int64]*bucket{}, max: 10000}
}

// allow reports whether the user may proceed; rate is tokens per minute.
func (l *rateLimiter) allow(userID int64, rate int) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) >= l.max {
		for id, b := range l.buckets {
			if now.Sub(b.last) > time.Hour {
				delete(l.buckets, id)
			}
		}
	}
	b, ok := l.buckets[userID]
	if !ok {
		if len(l.buckets) >= l.max {
			// 满员驱逐最旧条目(与登录限流器一致,审计2026-L19):
			// 大量活跃用户时新用户不被硬拒,过期桶优先让位
			var victimID int64
			var oldest time.Time
			for id, b := range l.buckets {
				if victimID == 0 || b.last.Before(oldest) {
					victimID, oldest = id, b.last
				}
			}
			if victimID == 0 {
				return false
			}
			delete(l.buckets, victimID)
		}
		b = &bucket{tokens: float64(rate), last: now}
		l.buckets[userID] = b
	}
	b.tokens = math.Min(float64(rate), b.tokens+now.Sub(b.last).Seconds()*float64(rate)/60.0)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

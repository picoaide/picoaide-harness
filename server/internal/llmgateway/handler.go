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

	ups, err := MatchModels(a.DB, req.Model)
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
		resp, err = a.forward(c, &ups[i], body, req.Stream)
		if err == nil {
			break
		}
		log.Printf("gateway: model %s provider %s failed: %v", req.Model, ups[i].Name, err)
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
		a.serveStream(c, resp, usageID)
		return
	}
	a.serveJSON(c, resp, user.ID, req.Model)
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

// serveJSON passes a non-stream upstream response through and records usage.
func (a *API) serveJSON(c *gin.Context, resp *http.Response, userID int64, model string) {
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
	if pt, ct, ok, _ := parseUsage(body); ok {
		if _, err := serverstore.RecordUsage(a.DB, userID, model, pt, ct); err != nil {
			log.Printf("gateway: record usage: %v", err)
		}
	}
	c.Status(resp.StatusCode)
	for k, vv := range resp.Header {
		if !passHeaders[k] {
			continue
		}
		for _, v := range vv {
			c.Writer.Header().Add(k, v)
		}
	}
	c.Writer.Write(body)
}

// serveStream passes an SSE response through line by line, preserving
// "data:" lines and "[DONE]", and backfills the pending usage row from the
// final chunk's "usage" field. Rows that can never be backfilled are deleted
// (C-9): upstream 4xx, client disconnect, write failure.
func (a *API) serveStream(c *gin.Context, resp *http.Response, usageID int64) {
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
				c.Writer.Header().Add(k, v)
			}
		}
		io.Copy(c.Writer, resp.Body)
		return
	}
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.WriteHeader(resp.StatusCode)
	fl, _ := c.Writer.(http.Flusher)
	br := bufio.NewReader(resp.Body)
	clientGone := false
	idleTimedOut := false
	backfilled := false // usage row received real tokens (must not be dropped)
	for {
		// 5#9/5#10: stop pumping once the client context is gone
		if c.Request.Context().Err() != nil {
			clientGone = true
			break
		}
		line, err := readLineWithIdle(br, streamIdleTimeout)
		if len(line) > 0 {
			if s := strings.TrimSpace(line); strings.HasPrefix(s, "data:") {
				if pt, ct, ok, perr := parseUsage([]byte(s)); perr != nil {
					log.Printf("gateway: parse usage line: %v", perr)
				} else if ok && usageID > 0 {
					if uerr := serverstore.UpdateUsageTokens(a.DB, usageID, pt, ct); uerr != nil {
						log.Printf("gateway: backfill usage: %v", uerr)
					} else if pt+ct > 0 {
						backfilled = true
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
		if err != nil { // EOF, client disconnect, or idle timeout
			if errors.Is(err, errStreamIdleTimeout) {
				idleTimedOut = true
				log.Printf("gateway: stream idle timeout after %v, terminating", streamIdleTimeout)
				fmt.Fprintf(c.Writer, "data: %s\n\n", `{"error":{"code":"UPSTREAM","message":"上游响应空闲超时"}}`)
				if fl != nil {
					fl.Flush()
				}
			}
			break
		}
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
func parseUsage(raw []byte) (pt, ct int64, ok bool, err error) {
	data := bytes.TrimSpace(bytes.TrimPrefix(raw, []byte("data:")))
	if len(data) == 0 || bytes.Equal(data, []byte("[DONE]")) {
		return 0, 0, false, nil
	}
	var chunk struct {
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil {
		return 0, 0, false, err
	}
	if chunk.Usage == nil {
		return 0, 0, false, nil
	}
	return chunk.Usage.PromptTokens, chunk.Usage.CompletionTokens, true, nil
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

// quotaBlocked reports whether the user has exhausted their calendar-month
// token, money, or department budget quota (429 QUOTA_EXCEEDED at the caller).
// Admins are always exempt; 0 quota means unlimited. Lookup failures degrade
// open (fail-open), matching the rate-limiter's fail-open behaviour.
func (a *API) quotaBlocked(user *serverstore.User) (bool, string) {
	if blocked, msg := a.deptBudgetBlocked(user); blocked {
		return true, msg
	}
	if blocked, msg := a.moneyQuotaBlocked(user); blocked {
		return true, msg
	}
	quota, err := serverstore.EffectiveQuota(a.DB, user)
	if err != nil {
		log.Printf("gateway: quota lookup: %v", err)
		return false, ""
	}
	if quota <= 0 {
		return false, ""
	}
	used, err := serverstore.UserMonthlyUsage(a.DB, user.ID)
	if err != nil {
		log.Printf("gateway: usage lookup: %v", err)
		return false, ""
	}
	if used >= quota {
		return true, "本月流量配额已用尽"
	}
	return false, ""
}

// deptBudgetBlocked reports whether any department budget on the user's
// inheritance chain (归属部门 + 祖先链) has been exhausted. A department
// budget caps the whole subtree's monthly cost, so every member of the tree
// is blocked once it is exceeded. Admins are exempt. Fail-open on errors.
func (a *API) deptBudgetBlocked(user *serverstore.User) (bool, string) {
	if user.IsAdmin {
		return false, ""
	}
	budgets, err := serverstore.EffectiveDeptBudget(a.DB, user.ID)
	if err != nil {
		log.Printf("gateway: dept budget lookup: %v", err)
		return false, ""
	}
	if len(budgets) == 0 {
		return false, ""
	}
	for _, b := range budgets {
		used, err := serverstore.DeptMonthlyCost(a.DB, b.GroupID)
		if err != nil {
			log.Printf("gateway: dept cost lookup: %v", err)
			return false, ""
		}
		if used >= b.Budget {
			return true, "部门「" + b.Name + "」本月费用预算已用尽"
		}
	}
	return false, ""
}

// moneyQuotaBlocked reports whether the user has exhausted their
// calendar-month money quota (yuan, 0022). Fail-open on lookup errors.
func (a *API) moneyQuotaBlocked(user *serverstore.User) (bool, string) {
	quota, err := serverstore.EffectiveMoneyQuota(a.DB, user)
	if err != nil {
		log.Printf("gateway: money quota lookup: %v", err)
		return false, ""
	}
	if quota <= 0 {
		return false, ""
	}
	used, err := serverstore.UserMonthlyCost(a.DB, user.ID)
	if err != nil {
		log.Printf("gateway: money usage lookup: %v", err)
		return false, ""
	}
	if used >= quota {
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

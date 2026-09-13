package llmgateway

import (
	"bufio"
	"bytes"
	"context"
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

// maxStreamLineBytes caps a single upstream SSE line (P2-8): a stream line has
// no newline until the upstream decides to send one, so an unterminated line
// must not be buffered unboundedly (实测 24MiB 无换行行 → +18MiB 堆). On
// overflow the stream is terminated instead of growing the buffer.
// Test-injectable.
var maxStreamLineBytes = 1 << 20

// errStreamLineTooLong is returned when one upstream stream line exceeds
// maxStreamLineBytes; the caller must terminate that stream.
var errStreamLineTooLong = errors.New("upstream stream line too long")

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
		serverauth.WriteError(c, http.StatusTooManyRequests, "BALANCE_EXHAUSTED", msg)
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
	// 写不进去就拒绝(不调用上游):usageID=0 一路跑下去整条流没有计量痕迹。
	var usageID int64
	if req.Stream {
		var ok bool
		if usageID, ok = a.beginStreamUsage(c, user.ID, req.Model, billingKindChat); !ok {
			return
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
	a.serveJSON(c, resp, user.ID, req.Model, respSecrets, billingKindChat)
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
	// F4: 流式请求的 context 与客户端断开解耦 —— 客户端断线后 serveStream
	// 仍会 drain 上游直到拿到 usage chunk,否则按已转发内容估算计费;若沿用
	// 客户端 context,取消会让上游停止、用量永远拿不到(免费漏洞)。
	reqCtx := c.Request.Context()
	if stream {
		reqCtx = context.WithoutCancel(reqCtx)
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(raw))
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
// kind: 端点标识(计费 kind,见 billingKind*),不再硬编码 "chat"。
func (a *API) serveJSON(c *gin.Context, resp *http.Response, userID int64, model string, secrets []string, kind string) {
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
	// N2(审计 r3 第四轮):非流式交付**任何**形态都要有账 —— 上游 usage 缺失 /
	// null / 空对象 / 只有 total_tokens(未知字段)时,此前直接跳过 RecordUsage,
	// 内容 200 交付却零落账(embeddings 同族)。现在与流式**同源**兜底:
	// 缺/0 的 completion 侧按已交付字节估算(estimateCompletionFallback,与
	// settleStreamFallback 同一个实现,带业务上限 maxEstimatedCompletionTokens),
	// prompt 侧不估算(响应字节推不出输入),一次交付永远只落一行。
	//
	// 4xx(含 4xx 错误体里**带 usage 对象**的形态)一律不落账、不扣费 —— 与
	// 流式 4xx 同源(P2,审计 r5 §1 缺口 1)。此前条件是 `delivered || uok`,
	// uok 让"上游 400 + 错误体带 usage"照扣:同一个上游 400,stream=true 零扣费、
	// stream=false 扣全额,计费取决于客户端用哪种模式;上游(或中转)只要在**未
	// 交付**的失败响应里塞一个 usage 就能收费。5xx 在 forward 层已 failover/丢弃。
	pt, ct, cch, _, perr := parseUsage(body)
	if perr != nil {
		// 解析失败不是"没有用量":留痕便于定位上游报文异常。
		log.Printf("gateway: parse usage from json body: %v", perr)
	}
	if resp.StatusCode < 400 {
		var estimated bool
		ct, estimated = estimateCompletionFallback(pt, ct, int64(len(body)))
		if _, err := serverstore.RecordUsageKindCachedEstimated(a.DB, userID, model, pt, ct, cch, kind, estimated); err != nil {
			// FIX-05 + G5b(审计 r3):**任何**结算失败都不得交付 —— 事务已回滚,
			// 继续 200 交付就是"上游花了钱、账上一分没扣"的无限免费调用。
			// 余额不足 → 429 BALANCE_EXHAUSTED;其它错误 → 503 METERING_FAILED。
			rejectSettlementFailure(c, err, kind+" json")
			return
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
// streamDrainTimeout 是客户端断开后继续 drain 上游的最长时间(F4):
// 在拿到真实 usage chunk 与不过度占用上游资源之间折中。
const streamDrainTimeout = 2 * time.Minute

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
	lineTooLong := false
	lineEOF := false
	var forwardedBytes int64
	// reportedPT/CT/cache 是上游**回报过的**用量:按侧取最大值合并(上游可能
	// 分段/累积上报,后续更小的值或显式 0 不得把已上报的用量抹掉 —— 与
	// anthropic 流式的"非零覆盖"同一语义;每收到一条 usage 行就幂等回填,
	// 流中断也不会丢已上报的部分)。
	var reportedPT, reportedCT, reportedCache int64

	// 读行 goroutine(单 goroutine 常驻,零 per-line 分配)。stopRead 用于
	// 主循环提前退出时解除阻塞;客户端断开**不**停止读取(F4:继续 drain
	// 上游直到拿到 usage chunk,否则按已转发内容估算,不允许白嫖)。
	type lineRes struct {
		line string
		err  error
	}
	lines := make(chan lineRes, 64)
	readGone := make(chan struct{})
	stopRead := make(chan struct{})
	go func() {
		defer close(readGone)
		for {
			l, e := readLineBounded(br, maxStreamLineBytes)
			select {
			case lines <- lineRes{l, e}:
			case <-stopRead:
				return
			}
			if e != nil {
				return
			}
		}
	}()
	defer close(stopRead)

	// idle 检查:每 1s 看一次"距上次收到行的间隔",超过 streamIdleTimeout
	// 即超时(上游挂死保护,客户端断开后的 drain 也受此约束)。
	idleTick := time.NewTicker(time.Second)
	defer idleTick.Stop()
	lastLineAt := time.Now()
	// F4:客户端断开后的 drain 上限,防止上游长时间占资源。
	drainDeadline := time.Time{}

	for {
		if !clientGone && c.Request.Context().Err() != nil {
			clientGone = true
			drainDeadline = time.Now().Add(streamDrainTimeout)
		}
		if clientGone && !drainDeadline.IsZero() && time.Now().After(drainDeadline) {
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
							if pt > reportedPT {
								reportedPT = pt
							}
							if ct > reportedCT {
								reportedCT = ct
							}
							if cch > reportedCache {
								reportedCache = cch
							}
							if uerr := updateUsageTokensSettled(a.DB, usageID, reportedPT, reportedCT, reportedCache, false); uerr != nil {
								// FIX-05 + G5b:流式回填结算失败 —— SSE 头已发,
								// 状态码改不了;写一条 error 事件后**终止泵送**,
								// 不能继续 200 把余下内容白送出去。
								if !clientGone {
									abortSettlementFailureStream(c, fl, uerr, "chat stream backfill")
								} else {
									log.Printf("gateway: settlement failed after client gone: usage=%d err=%v", usageID, uerr)
								}
								return
							}
						}
					}
				}
				forwardedBytes += int64(len(line))
				if !clientGone {
					if _, werr := c.Writer.WriteString(line); werr != nil {
						clientGone = true
						drainDeadline = time.Now().Add(streamDrainTimeout)
					} else if fl != nil {
						fl.Flush()
					}
				}
			}
			if r.err != nil {
				if errors.Is(r.err, errStreamLineTooLong) {
					// P2-8: 单行超过上限——不回传半行,直接中断该流。
					lineTooLong = true
					log.Printf("gateway: upstream stream line exceeds %d bytes, terminating", maxStreamLineBytes)
					if !clientGone {
						fmt.Fprintf(c.Writer, "data: %s\n\n", `{"error":{"code":"UPSTREAM","message":"上游响应单行过大"}}`)
						if fl != nil {
							fl.Flush()
						}
					}
				} else { // EOF / 上游关闭
					lineEOF = true
				}
			}
		case <-idleTick.C:
			if time.Since(lastLineAt) > streamIdleTimeout {
				idleTimedOut = true
				log.Printf("gateway: stream idle timeout after %v, terminating", streamIdleTimeout)
				if !clientGone {
					fmt.Fprintf(c.Writer, "data: %s\n\n", `{"error":{"code":"UPSTREAM","message":"上游响应空闲超时"}}`)
					if fl != nil {
						fl.Flush()
					}
				}
			}
		case <-c.Request.Context().Done():
			if !clientGone {
				clientGone = true
				drainDeadline = time.Now().Add(streamDrainTimeout)
			}
		}
		if lineEOF || idleTimedOut || lineTooLong {
			break
		}
	}
	// 等待读 goroutine 退出(defer resp.Body.Close 释放阻塞读)
	select {
	case <-readGone:
	case <-time.After(time.Second):
	}
	// 结算:
	//   - 上游回报的用量已在收到 usage 行时幂等回填(计费已完成);
	//   - **只要有一侧缺失/为 0**(含"只回报了输入侧":pt>0 且 ct==0 —— N1,
	//     审计 r3 第四轮)就走 fallback:由 settleStreamFallback 内部只补
	//     completion 那一半(已上报的 pt/cache 原样带出,**绝不**被估算覆盖);
	//   - 完全没有任何内容(连接失败/4xx 分支之外) → 删除 pending。
	// 估算与回填走 settleStreamFallback(与 anthropic 流式**同一个实现**)。
	if usageID > 0 && (reportedPT <= 0 || reportedCT <= 0) {
		if _, serr := settleStreamFallback(a.DB, usageID, forwardedBytes, reportedPT, reportedCT, reportedCache); serr != nil {
			// FIX-05 + G5b:收尾结算失败同样不能静默 —— 内容虽然已全部转发,
			// 但客户端若还在读必须看到失败信号(不能当成"反正流结束了")。
			if !clientGone {
				abortSettlementFailureStream(c, fl, serr, "chat stream estimated")
			} else {
				log.Printf("gateway: estimated settlement failed after client gone: usage=%d forwarded=%d err=%v",
					usageID, forwardedBytes, serr)
			}
		}
	}
}
func readLineBounded(br *bufio.Reader, max int) (string, error) {
	var buf []byte
	for {
		chunk, err := br.ReadSlice('\n')
		buf = append(buf, chunk...)
		if len(buf) > max {
			return "", errStreamLineTooLong
		}
		switch {
		case errors.Is(err, bufio.ErrBufferFull):
			continue // 行内还有数据,继续读下一块
		case err != nil:
			return string(buf), err
		default:
			return string(buf), nil
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
// P2-8:内部走 readLineBounded,单行超过 maxStreamLineBytes 时返回
// errStreamLineTooLong(调用方中断该流),不再无上限累积。
func readLineWithIdle(br *bufio.Reader, idle time.Duration) (string, error) {
	if idle <= 0 {
		return readLineBounded(br, maxStreamLineBytes)
	}
	type lineRes struct {
		line string
		err  error
	}
	ch := make(chan lineRes, 1)
	go func() {
		l, e := readLineBounded(br, maxStreamLineBytes)
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

// clampTokensNonNeg 把上游回报的 token 计数钳到非负。
// P0-B(审计 2026-09-12):上游响应体可控(第三方中转 / 明文 http 上游的
// MITM / 上游自身 bug),负 token 会让计费算出**负费用**,结算侧再把它当成
// "费用向下修正"记成 refund → 员工余额凭空增加。解析边界是第一道入口。
func clampTokensNonNeg(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

// satAddTokensNonNeg 是 token 计数的**饱和加法**:溢出时取上限而不是回绕。
// G5a(审计 2026-09-13):Anthropic 的总输入 = input + cache_read + cache_creation
// 三个 int64 相加,逐项 clamp 只保证每一项非负,**求和本身仍会溢出** ——
// MaxInt64 + 1 回绕成 MinInt64,再被 clampTokensNonNeg 归零,于是上游声称
// 9.2e18 输入 token 的响应计费 ¥0(巨额用量反而免费)。取上限后金额会大到
// 结算侧直接拒绝(或按真实天价扣),绝不会变成 0。
//
// 只在正向溢出上取上限:入参都已 clamp 到非负,负向分支仅为防御性完整。
func satAddTokensNonNeg(a, b int64) int64 {
	if b > 0 && a > math.MaxInt64-b {
		log.Printf("gateway: token count overflow saturated at MaxInt64 (a=%d b=%d)", a, b)
		return math.MaxInt64
	}
	if b < 0 && a < math.MinInt64-b {
		return math.MinInt64
	}
	return a + b
}

// usageTokenDetails 是上游 usage 里的 "*_tokens_details" 明细对象。
// N3(审计 r3 第四轮):OpenAI Chat 的 prompt_tokens_details 与 Responses 的
// input_tokens_details **共用这一份结构**(同一个缓存字段 cached_tokens),
// 不再各写一份匿名结构。
type usageTokenDetails struct {
	CachedTokens *int64 `json:"cached_tokens"`
}

// usageFields 是上游 usage 对象的**两套字段名**视图:
//   - OpenAI Chat Completions:prompt_tokens / completion_tokens /
//     prompt_cache_hit_tokens / prompt_cache_miss_tokens /
//     prompt_tokens_details.cached_tokens;
//   - OpenAI Responses:input_tokens / output_tokens /
//     input_tokens_details.cached_tokens。
//
// 用指针区分"字段缺失"与"显式 0":字段缺失时回落到另一套字段名,显式 0
// 保持原语义(chat 的 0 不会被 Responses 字段覆盖)。
type usageFields struct {
	PromptTokens     *int64 `json:"prompt_tokens"`
	CompletionTokens *int64 `json:"completion_tokens"`
	PromptCacheHit   *int64 `json:"prompt_cache_hit_tokens"`
	PromptCacheMiss  *int64 `json:"prompt_cache_miss_tokens"`

	InputTokens  *int64 `json:"input_tokens"`
	OutputTokens *int64 `json:"output_tokens"`

	// 缓存明细:两套字段名都映射到同一个结构(同一份实现)。
	PromptTokensDetails *usageTokenDetails `json:"prompt_tokens_details"`
	InputTokensDetails  *usageTokenDetails `json:"input_tokens_details"`
}

// detailsCachedTokens 从缓存明细里取命中数(唯一实现,两个字段名共用):
// 先 chat 的 prompt_tokens_details,再 Responses 的 input_tokens_details;
// 都没有该键 → ok=false(与"显式 0"区分开)。
func (u *usageFields) detailsCachedTokens() (int64, bool) {
	for _, d := range []*usageTokenDetails{u.PromptTokensDetails, u.InputTokensDetails} {
		if d != nil && d.CachedTokens != nil {
			return *d.CachedTokens, true
		}
	}
	return 0, false
}

// usageValue 取两套字段名里"有值的那个":chat 字段**正值**优先(保持既有语义
// 不变),缺失或 0 时回落到 Responses 字段名;两者都不可用 → 0(与"字段缺失即
// 0"的旧语义一致)。
//
// P2(审计 r5 §1 缺口 3):此前是"primary 非 nil 就采信",于是
// `{"prompt_tokens":0,"input_tokens":5000}` 取 0 —— 而 prompt 侧**不估算**
// (响应字节推不出输入),整个输入侧免费;上游可控时这是稳定的少收通道。
// 现在:primary>0 才优先,0/缺失/负值都回落另一套字段名;两者都 ≤0 才是 0。
// 两套字段名同时给正值时仍以 chat 字段为准(既有语义不变)。
func usageValue(primary, fallback *int64) int64 {
	if primary != nil && *primary > 0 {
		return *primary
	}
	if fallback != nil && *fallback > 0 {
		return *fallback
	}
	return 0
}

// parseUsage extracts token counts from a chat completion / Responses response:
// a full JSON body (non-stream) or an SSE "data:" line carrying usage.
// 返回 cacheHit 为缓存命中的输入 token(DeepSeek prompt_cache_hit_tokens,
// 0029/0030 缓存计费);0 = 未报告/未命中。
//
// G7(审计 2026-09-13,P0):此前只认 chat 字段名(prompt_tokens/completion_tokens),
// 上游按 **Responses 官方字段名**(input_tokens/output_tokens)上报时 tokens=0、
// cost=0 —— /v1/responses 整条路径零计费。现在同一个解析器兼容两套字段名,
// 并支持 Responses 流式事件里 usage 嵌在 `response.usage` 的形状
// (response.completed),以及两套缓存明细字段(cached_tokens)。
//
// 语义边界(审计 r3 第四轮核对):`total_tokens` 单字段不算任何一侧的用量
// (不拆成 pt/ct,避免凭空多扣);两套字段名同时存在时 chat 优先;显式 0 与
// 缺失都返回 0(由计费侧的字节估算兜底决定是否补 —— 见 fallbackCompletionTokens)。
func parseUsage(raw []byte) (pt, ct, cacheHit int64, ok bool, err error) {
	data := bytes.TrimSpace(bytes.TrimPrefix(raw, []byte("data:")))
	if len(data) == 0 || bytes.Equal(data, []byte("[DONE]")) {
		return 0, 0, 0, false, nil
	}
	var chunk struct {
		Usage    *usageFields `json:"usage"`
		Response *struct {
			Usage *usageFields `json:"usage"`
		} `json:"response"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil {
		return 0, 0, 0, false, err
	}
	u := chunk.Usage
	if u == nil && chunk.Response != nil {
		// Responses 流式事件(data: {"type":"response.completed","response":{…,"usage":{…}}})
		u = chunk.Response.Usage
	}
	if u == nil {
		return 0, 0, 0, false, nil
	}
	pt = usageValue(u.PromptTokens, u.InputTokens)
	ct = usageValue(u.CompletionTokens, u.OutputTokens)
	// 缓存命中:优先 chat 的 prompt_cache_hit_tokens;仅有 miss 时用 prompt-miss
	// 推算(原有语义);两者都缺时用明细对象的 cached_tokens —— OpenAI Chat 的
	// prompt_tokens_details.cached_tokens 与 Responses 的
	// input_tokens_details.cached_tokens 走**同一份**取值实现(N3,审计 r3
	// 第四轮:此前只认 Responses 那一套 ⇒ 第三方中转的缓存命中按全价多扣)。
	switch {
	case u.PromptCacheHit != nil && *u.PromptCacheHit > 0:
		cacheHit = *u.PromptCacheHit
	case u.PromptCacheMiss != nil && *u.PromptCacheMiss > 0:
		cacheHit = pt - *u.PromptCacheMiss
	default:
		if cached, has := u.detailsCachedTokens(); has {
			cacheHit = cached
		}
	}
	// P0-B:负值一律归零(计费侧 costOfAt 另有一层,纵深防御)。
	return clampTokensNonNeg(pt), clampTokensNonNeg(ct), clampTokensNonNeg(cacheHit), true, nil
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

// quotaBlocked 报告该用户是否应被网关拦截,以及可解释的原因。
//
// 2026-09-11 收敛:唯一的"钱"闸门 = **账户余额**(存量、消费即扣、同事务)。
// 部门预算 / 员工金额配额 / 员工 token 配额全部下线(设计文档
// docs/planning/2026-09-11-balance-quota-consolidation.md):
// 多套并行的额度机制互相打架(充了钱仍被配额拦住),且只有余额是可对账的。
//
// 规则(仅一条):闸门开启 且 已开通余额账户 且 分位口径余额 <= 0 → 拒绝。
// 未开通余额账户的用户不受余额闸门约束(存量部署开启闸门不会误拦全员)。
// 查询失败一律 fail-closed(计费强制路径上 DB 瞬时故障不得放行)。
func (a *API) quotaBlocked(user *serverstore.User) (bool, string) {
	if user.IsAdmin {
		return false, "" // 管理员豁免
	}
	return serverstore.BalanceBlocked(a.DB, user)
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

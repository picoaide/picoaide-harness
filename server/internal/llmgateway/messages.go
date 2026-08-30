package llmgateway

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxMessagesBody caps the Anthropic Messages request body (search requests
// are small; the chat cap is already 16MB, keep the same margin policy).
const maxMessagesBody = 16 << 20

// anthropicUsage parses token counts from an Anthropic Messages response body
// (non-stream) or one SSE "data:" line (stream). Returns
// (inputTokens, outputTokens, cacheReadTokens, ok, err).
// 兼容两种 usage 位置(Anthropic 流式):message_start 事件把 usage 嵌在
// message.usage,message_delta 事件放在顶层 usage。
func anthropicUsage(raw []byte) (pt, ct, cache int64, ok bool, err error) {
	data := bytes.TrimSpace(bytes.TrimPrefix(raw, []byte("data:")))
	if len(data) == 0 || bytes.Equal(data, []byte("[DONE]")) {
		return 0, 0, 0, false, nil
	}
	var chunk struct {
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
		Message *struct {
			Usage *struct {
				InputTokens              int64 `json:"input_tokens"`
				OutputTokens             int64 `json:"output_tokens"`
				CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
				CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil {
		return 0, 0, 0, false, err
	}
	var u *struct {
		InputTokens              int64 `json:"input_tokens"`
		OutputTokens             int64 `json:"output_tokens"`
		CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	}
	if chunk.Usage != nil {
		u = chunk.Usage
	} else if chunk.Message != nil {
		u = chunk.Message.Usage
	}
	if u == nil {
		return 0, 0, 0, false, nil
	}
	// Anthropic cache credit: cache_read 按缓存命中的输入价计费(与 OpenAI
	// prompt_cache_hit_tokens 同语义);cache_creation 按输入价计费,两者不叠加。
	cache = u.CacheReadInputTokens
	return u.InputTokens, u.OutputTokens, cache, true, nil
}

// serveAnthropicJSON passes a non-stream Anthropic Messages response through
// and records usage (kind "search" so admin usage pages can split it).
// secrets: 本次请求使用的上游官方 key(响应回显脱敏)。
func (a *API) serveAnthropicJSON(c *gin.Context, resp *http.Response, userID int64, model string, secrets []string) {
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
	if pt, ct, cache, ok, _ := anthropicUsage(body); ok {
		if _, err := serverstore.RecordUsageKindCached(a.DB, userID, model, pt, ct, cache, "search"); err != nil {
			log.Printf("gateway: record anthropic usage: %v", err)
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

// serveAnthropicStream passes an Anthropic SSE response through line by line,
// backfilling the pending usage row from the message's usage fields.
// Anthropic 流式 usage 是分散的:input_tokens 只在 message_start 出现,
// output_tokens 在 message_delta 出现(累积语义),因此按行合并(非零覆盖)
// 再回填,不能像 OpenAI 那样整行覆盖。secrets: 上游官方 key(行/头脱敏)。
func (a *API) serveAnthropicStream(c *gin.Context, resp *http.Response, usageID int64, secrets []string) {
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
	backfilled := false
	var pt, ct, cache int64
	for {
		// 5#9/5#10: stop pumping once the client context is gone
		if c.Request.Context().Err() != nil {
			clientGone = true
			break
		}
		line, err := readLineWithIdle(br, streamIdleTimeout)
		if len(line) > 0 {
			line = string(redactSecrets([]byte(line), secrets))
			if s := strings.TrimSpace(line); strings.HasPrefix(s, "data:") {
				if lpt, lct, lcache, ok, perr := anthropicUsage([]byte(s)); perr != nil {
					log.Printf("gateway: parse anthropic usage line: %v", perr)
				} else if ok {
					if lpt > 0 {
						pt = lpt
					}
					if lct > 0 {
						ct = lct
					}
					if lcache > 0 {
						cache = lcache
					}
					if usageID > 0 {
						if uerr := serverstore.UpdateUsageTokensCached(a.DB, usageID, pt, ct, cache); uerr != nil {
							log.Printf("gateway: backfill anthropic usage: %v", uerr)
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
		if err != nil {
			if errors.Is(err, errStreamIdleTimeout) {
				idleTimedOut = true
				log.Printf("gateway: anthropic stream idle timeout after %v, terminating", streamIdleTimeout)
				fmt.Fprintf(c.Writer, "data: %s\n\n", `{"error":{"code":"UPSTREAM","message":"上游响应空闲超时"}}`)
				if fl != nil {
					fl.Flush()
				}
			}
			break
		}
	}
	if (clientGone || idleTimedOut) && usageID > 0 && !backfilled {
		if err := serverstore.DeleteUsage(a.DB, usageID); err != nil {
			log.Printf("gateway: delete pending anthropic usage: %v", err)
		}
	}
}

// handleMessages proxies /v1/messages (Anthropic-compatible) to the matching
// Anthropic-protocol upstream with per-user rate limiting, quota checks and
// usage metering. This is the web_search server-side path: the client never
// sees the upstream API key.
func (a *API) handleMessages(c *gin.Context) {
	user := serverauth.CurrentUser(c)
	if user == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMessagesBody)
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

	ups, err := MatchModelsByProtocol(a.DB, req.Model, "anthropic")
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "模型路由查询失败")
		return
	}
	// 官方 Anthropic 兼容语义(api-docs.deepseek.com/guides/anthropic_api):
	// claude-* 模型名(Anthropic SDK)自动映射到默认模型——官方映射到
	// deepseek-v4-pro/flash; 服务端按自己的模型目录取 gateway.default_model
	// 或首个启用模型。其他未知模型保持 404(严格默认拒绝,不自动 fallback)。
	if len(ups) == 0 && strings.HasPrefix(req.Model, "claude-") {
		if mapped, ok := resolveAnthropicModel(a.DB, req.Model); ok {
			ups, err = MatchModelsByProtocol(a.DB, mapped, "anthropic")
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "模型路由查询失败")
				return
			}
			if len(ups) > 0 {
				// 用映射后的模型名做计量/审计(与上游一致)。
				req.Model = mapped
			}
		}
	}
	if len(ups) == 0 {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "模型不存在或不可用")
		return
	}

	// streaming path: insert a pending usage row first, backfilled on the
	// final SSE chunk; a client disconnect leaves it pending (no rollback).
	// kind=search 与其他渠道区分,且被 CleanupPendingUsage 兜底清理。
	var usageID int64
	if req.Stream {
		usageID, err = serverstore.RecordUsageKind(a.DB, user.ID, req.Model, 0, 0, "search")
		if err != nil {
			log.Printf("gateway: record pending anthropic usage: %v", err)
		}
	}

	// Failover across Anthropic-protocol providers (same policy as chat).
	var resp *http.Response
	var respSecrets []string // 成功 provider 的官方 key(响应脱敏用)
	for i := range ups {
		resp, err = a.forwardAnthropic(c, &ups[i], raw, req.Stream)
		if err == nil {
			respSecrets = []string{ups[i].APIKey}
			break
		}
		log.Printf("gateway: anthropic model %q provider %q failed: %v",
			req.Model, ups[i].Name, err)
	}
	if resp == nil {
		if usageID > 0 {
			if err := serverstore.DeleteUsage(a.DB, usageID); err != nil {
				log.Printf("gateway: delete pending anthropic usage: %v", err)
			}
		}
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游服务不可用")
		return
	}
	if req.Stream {
		a.serveAnthropicStream(c, resp, usageID, respSecrets)
		return
	}
	a.serveAnthropicJSON(c, resp, user.ID, req.Model, respSecrets)
}

// anthropicBaseURL 推导 Anthropic 兼容端点基址:
//   - both(0044):provider 的 BaseURL 是 OpenAI 端点(如 https://api.deepseek.com),
//     Anthropic 端点 = {BaseURL}/anthropic/v1(DeepSeek 官方布局);
//     若 BaseURL 已含 /anthropic(显式填了 Anthropic 端点),尊重原样。
//   - anthropic(0043):BaseURL 即管理员填写的 Anthropic 端点,原样返回
//     (不推导——单 anthropic 协议的上游 base_url 就应是实际端点)。
func anthropicBaseURL(base, protocol string) string {
	base = strings.TrimSuffix(base, "/")
	if protocol != "both" {
		return base
	}
	if strings.Contains(base, "/anthropic") {
		return base
	}
	return base + "/anthropic/v1"
}

// forwardAnthropic sends the raw body to an Anthropic-compatible upstream,
// replacing every credential header with the upstream key. The client's
// `x-api-key` / `authorization` / `anthropic-version` are dropped: only the
// upstream key the server owns is sent, so a client can never inject its own
// credential or version drift on a proxied search.
func (a *API) forwardAnthropic(c *gin.Context, up *Upstream, raw []byte, stream bool) (*http.Response, error) {
	url := upstreamURLFor(anthropicBaseURL(up.BaseURL, up.Protocol), "/messages")
	client := a.client
	if stream {
		client = a.sse
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	// Anthropic 兼容上游:官方 DeepSeek 期望 x-api-key;代理可能期望 Bearer。
	// 发送 header 保留原始 anthropic-version(客户端携带),key 仅用服务端持有值。
	req.Header.Set("x-api-key", up.APIKey)
	req.Header.Set("authorization", "Bearer "+up.APIKey)
	if v := c.GetHeader("anthropic-version"); v != "" {
		req.Header.Set("anthropic-version", v)
	}
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

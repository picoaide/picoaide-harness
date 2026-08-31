package llmgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxFIMBody caps the FIM completion request body (memory guard; typical
// prefix/suffix prompts are far below this).
const maxFIMBody = 16 << 20

// handleCompletions proxies the DeepSeek FIM Completion (Beta) endpoint
// (/completions and OpenAI-compatible /v1/completions) to the matching
// upstream. FIM requests carry `prompt` (with optional prefix/suffix) rather
// than `messages`; the upstream protocol is openai (DeepSeek official FIM).
// Mirrors handleChatCompletions: auth → rate limit → quota → model match →
// failover forward, with the same metering/usage semantics.
func (a *API) handleCompletions(c *gin.Context) {
	user := serverauth.CurrentUser(c)
	if user == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxFIMBody)
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
		Prompt string `json:"prompt"`
		Stream bool   `json:"stream"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || req.Model == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体缺少 model 字段")
		return
	}
	// FIM 是补全语义: prompt 必填(可以是 prefix 或 prefix+suffix, 官方 Beta)。
	if req.Prompt == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体缺少 prompt 字段")
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

	defaultParams, _ := serverstore.ModelDefaultParams(a.DB, req.Model)

	// 并发计量(2026-08-31):FIM 也计入对应模型并发。
	done := a.conc.begin(req.Model)
	defer done()

	var usageID int64
	if req.Stream {
		usageID, err = serverstore.RecordUsage(a.DB, user.ID, req.Model, 0, 0)
		if err != nil {
			log.Printf("gateway: record pending usage: %v", err)
		}
	}

	var resp *http.Response
	var respSecrets []string
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
		if req.Stream {
			if raw2, err := applyStreamUsageRequest(body); err == nil {
				body = raw2
			}
		}
		resp, err = a.forwardEndpoint(c, &ups[i], body, req.Stream, "/completions")
		if err == nil {
			respSecrets = []string{ups[i].APIKey}
			break
		}
		log.Printf("gateway: model %q provider %q FIM failed: %v", req.Model, ups[i].Name, err)
	}
	if resp == nil {
		if usageID > 0 {
			if err := serverstore.DeleteUsage(a.DB, usageID); err != nil {
				log.Printf("gateway: delete pending usage: %v", err)
			}
		}
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游服务不可用")
		return
	}
	if req.Stream {
		a.serveStream(c, resp, usageID, respSecrets)
		return
	}
	a.serveJSON(c, resp, user.ID, req.Model, respSecrets)
}

// forwardEndpoint forwards raw body to an upstream OpenAI-style endpoint
// (/chat/completions, /completions, /responses). It is forward() with a
// selectable endpoint suffix.
func (a *API) forwardEndpoint(c *gin.Context, up *Upstream, raw []byte, stream bool, endpoint string) (*http.Response, error) {
	url := upstreamURLFor(up.BaseURL, endpoint)
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

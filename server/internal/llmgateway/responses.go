package llmgateway

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxResponsesBody caps the Responses API request body (memory guard).
const maxResponsesBody = 16 << 20

// handleResponses proxies the DeepSeek Responses API endpoint
// (/responses, OpenAI SDK uses /v1/responses) to the matching upstream.
// Responses requests carry `input`/`instructions` instead of `messages`;
// the upstream protocol is openai. Mirrors handleChatCompletions with the
// same auth/rate-limit/quota/failover/metering semantics.
func (a *API) handleResponses(c *gin.Context) {
	user := serverauth.CurrentUser(c)
	if user == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxResponsesBody)
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
		Input  any    `json:"input"`
		Stream bool   `json:"stream"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || req.Model == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体缺少 model 字段")
		return
	}
	if req.Input == nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体缺少 input 字段")
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
		resp, err = a.forwardEndpoint(c, &ups[i], body, req.Stream, "/responses")
		if err == nil {
			respSecrets = []string{ups[i].APIKey}
			break
		}
		log.Printf("gateway: model %q provider %q responses failed: %v", req.Model, ups[i].Name, err)
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

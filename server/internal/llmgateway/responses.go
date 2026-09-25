package llmgateway

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxResponsesBody caps the Responses API request body (memory guard).
// 2026-09-22 与 chat 同口径提到 64MiB(见 maxChatBody 注释)。
const maxResponsesBody = 64 << 20

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
	raw, ok := readRequestBody(c, maxResponsesBody)
	if !ok {
		return
	}
	// 出站体加工(2026-09-22):校验 file_id 引用归属 + 注入官方 `user`
	// (create-response 的顶层字段,2026-09-22 审计 F 路 P1-1 修正:此前误按
	// "官方无该字段"处理,实际只查了 `user_id` 这个名字)。
	// raw 保持**客户端原始字节**(计量侧按它估算 prompt),转发用 outbound。
	outbound, ok := prepareOutboundBody(c, a.DB, user.ID, raw, identityResponses)
	if !ok {
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
	if blocked, msg := a.balanceAdmissionBlocked(user, req.Model, raw, "responses"); blocked {
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

	defaultParams, _ := serverstore.ModelDefaultParams(a.DB, req.Model)

	// 并发计量(2026-08-31):Responses API 也计入对应模型并发。
	done := a.conc.begin(req.Model)
	defer done()

	var usageID int64
	if req.Stream {
		var ok bool
		if usageID, ok = a.beginStreamUsage(c, user.ID, req.Model, billingKindResponses); !ok {
			return
		}
	}

	var resp *http.Response
	var respSecrets []string
	var chosenProviderID int64 // 实际命中的 provider(计费取价用,P1-6)
	for i := range ups {
		body := outbound
		if ups[i].Channel != "" {
			if ch, ok := channels.Get(ups[i].Channel); ok {
				ov, rm := ch.RequestOverrides(req.Model)
				if raw2, err := a.applyChannelOverrides(body, ov, rm); err == nil {
					body = raw2
				} else if a.rejectBusyBodyEdit(c, usageID, err) {
					return
				}
			}
		}
		if defaultParams != "" {
			if raw2, err := a.applyMaxTokensDefault(body, defaultParams); err == nil {
				body = raw2
			} else if a.rejectBusyBodyEdit(c, usageID, err) {
				return
			}
		}
		if req.Stream {
			if raw2, err := a.applyStreamUsageRequest(body); err == nil {
				body = raw2
			} else if a.rejectBusyBodyEdit(c, usageID, err) {
				return
			}
		}
		resp, err = a.forwardEndpoint(c, &ups[i], body, req.Stream, "/responses")
		if a.rejectForwardError(c, usageID, err) {
			return
		}
		if err == nil {
			respSecrets = []string{ups[i].APIKey}
			chosenProviderID = ups[i].ID
			if usageID > 0 {
				if serr := serverstore.SetUsageProvider(a.DB, usageID, ups[i].ID); serr != nil {
					log.Printf("gateway: bind usage %d to provider %d failed: %v", usageID, ups[i].ID, serr)
				}
			}
			break
		}
		log.Printf("gateway: model %s provider %q responses failed: %v", safeModelForLog(req.Model), ups[i].Name, err)
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
		a.serveStream(c, resp, usageID, respSecrets, raw, promptEstimateCapForModel(a.DB, req.Model))
		return
	}
	a.serveJSON(c, resp, user.ID, chosenProviderID, req.Model, respSecrets, billingKindResponses, raw)
}

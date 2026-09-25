package llmgateway

import (
	"bytes"
	"context"
	"encoding/json"
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
// prefix/suffix prompts are far below this). 2026-09-22 与 chat 同口径提到
// 64MiB(见 maxChatBody 注释);读预算与失败分类见 read_budget.go。
const maxFIMBody = 64 << 20

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
	raw, ok := readRequestBody(c, maxFIMBody)
	if !ok {
		return
	}
	// 出站体加工(2026-09-22):校验 file_id 引用归属 + 按端点注入平台 user_id。
	// raw 保持**客户端原始字节**(计量侧按它估算 prompt),转发用 outbound。
	outbound, ok := prepareOutboundBody(c, a.DB, user.ID, raw, identityNone)
	if !ok {
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
	// R16C-02 + R17A-06：钱闸门（含"未定价模型"）唯一出口 —— 命中即写响应并返回，
	// 被拒请求绝不转发上游。
	// 同源估量（R19A-S1-01）。
	if a.rejectBalanceAdmission(c, user, req.Model, admissionTokensFromBody(raw), "completions", "openai") {
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
		var ok bool
		if usageID, ok = a.beginStreamUsage(c, user.ID, req.Model, billingKindCompletions); !ok {
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
		resp, err = a.forwardEndpoint(c, &ups[i], body, req.Stream, "/completions")
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
		log.Printf("gateway: model %s provider %q FIM failed: %v", safeModelForLog(req.Model), ups[i].Name, err)
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
	a.serveJSON(c, resp, user.ID, chosenProviderID, req.Model, respSecrets, billingKindCompletions, raw)
}

// forwardEndpoint forwards raw body to an upstream OpenAI-style endpoint
// (/chat/completions, /completions, /responses). It is forward() with a
// selectable endpoint suffix.
func (a *API) forwardEndpoint(c *gin.Context, up *Upstream, body outboundBody, stream bool, endpoint string) (*http.Response, error) {
	// P0-4 服务端侧第二道闸门：出站请求体剔除上游 DSH 私有扩展字段（见 sanitize.go）。
	// 净化走统一往返（同一内存闸门 + 同一编码器口径），失败 fail-closed：
	// 不是 JSON 对象 ⇒ errOutboundBodyNotJSON（400）；闸门打满 ⇒ errBodyParseBusy（503）。
	clean, err := sanitizeOutboundBody(a.db(), []byte(body))
	if err != nil {
		return nil, err
	}
	url := upstreamURLFor(up.BaseURL, endpoint)
	client := a.client
	if stream {
		client = a.sse
	}
	// G-04(审计 2026-09-23):流式请求的 context 必须与客户端断开解耦 ——
	// 与 forward()(chat,handler.go)及 forwardAnthropic()(messages.go)**同一份
	// 口径**。沿用 c.Request.Context() 时客户端断连会立刻取消上游请求,上游
	// 永远不回 usage chunk ⇒ 只剩 4 字节/token 的估算(实测输入侧 1234→12),
	// 断在正文之前更是整笔零落账;同一条流走 /v1/chat/completions 却如实计费。
	// drain 的上限仍由 serveStream 的 streamDrainTimeout(2min)与 idle 看门狗
	// (streamIdleTimeout)兜住,不会无界进行。
	reqCtx := c.Request.Context()
	if stream {
		reqCtx = context.WithoutCancel(reqCtx)
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(clean))
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

package llmgateway

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxEmbedBody caps the embeddings request body (batch of texts).
const maxEmbedBody = 4 << 20

// embedRequest is the OpenAI-compatible embeddings body. Input accepts a
// single string or an array of strings.
type embedRequest struct {
	Model string          `json:"model"`
	Input json.RawMessage `json:"input"`
}

// parseInputs normalizes the OpenAI input field (string or []string).
func parseInputs(raw json.RawMessage) ([]string, error) {
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return []string{single}, nil
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return nil, err
	}
	return many, nil
}

type embedItem struct {
	Index     int       `json:"index"`
	Embedding []float32 `json:"embedding"`
}

type embedResponse struct {
	Data  []embedItem `json:"data"`
	Model string      `json:"model"`
	Usage struct {
		PromptTokens int64 `json:"prompt_tokens"`
		TotalTokens  int64 `json:"total_tokens"`
	} `json:"usage"`
}

// Embedder embeds texts through the same model routing as chat
// completions (per-channel failover), for in-process consumers. One
// Embedder per server; cheap to construct.
type Embedder struct {
	db     *sql.DB
	client *http.Client
}

func NewEmbedder(db *sql.DB) *Embedder {
	return &Embedder{db: db, client: &http.Client{Timeout: 60 * time.Second}}
}

// Embed returns one vector per input text (order preserved). Failover:
// providers serving the model are tried in order until one succeeds with
// a well-formed response; 4xx errors stop the chain (client error), 5xx
// and transport errors move on. The returned token count is the upstream
// usage when reported, else 0.
func (e *Embedder) Embed(ctx context.Context, model string, texts []string) ([][]float32, int64, error) {
	ups, err := MatchModelsByProtocol(e.db, model, "openai")
	if err != nil {
		return nil, 0, err
	}
	if len(ups) == 0 {
		return nil, 0, errors.New("embedding model 未配置或不可用")
	}
	inputJSON, err := json.Marshal(texts)
	if err != nil {
		return nil, 0, err
	}
	body, err := json.Marshal(embedRequest{Model: model, Input: inputJSON})
	if err != nil {
		return nil, 0, err
	}
	var lastErr error
	for i := range ups {
		lastErr = nil // a fresh provider must not inherit a previous failure
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURLFor(ups[i].BaseURL, "/embeddings"), bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+ups[i].APIKey)
		resp, err := e.client.Do(req)
		if err != nil {
			lastErr = err
			log.Printf("gateway: embed model %s provider %q failed: %v", safeModelForLog(model), ups[i].Name, err)
			continue
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, int64(maxUpstreamBody)))
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			return nil, 0, fmt.Errorf("embedding upstream %d", resp.StatusCode)
		}
		if resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("embedding upstream %d", resp.StatusCode)
			log.Printf("gateway: embed model %s provider %q: %d", safeModelForLog(model), ups[i].Name, resp.StatusCode)
			continue
		}
		var er embedResponse
		if err := json.Unmarshal(raw, &er); err != nil {
			lastErr = err
			continue
		}
		if len(er.Data) != len(texts) {
			lastErr = fmt.Errorf("embedding count %d != input %d", len(er.Data), len(texts))
			continue
		}
		dims := -1
		out := make([][]float32, len(er.Data))
		for _, item := range er.Data {
			if item.Index < 0 || item.Index >= len(out) {
				lastErr = fmt.Errorf("embedding index %d out of range", item.Index)
				continue
			}
			if dims == -1 {
				dims = len(item.Embedding)
			}
			if len(item.Embedding) != dims {
				lastErr = errors.New("embedding dims inconsistent within one response")
				continue
			}
			out[item.Index] = item.Embedding
		}
		if lastErr != nil {
			continue
		}
		return out, er.Usage.TotalTokens, nil
	}
	return nil, 0, lastErr
}

// handleEmbeddings proxies /v1/embeddings to the matching upstream with
// per-user rate limiting and usage metering (client-facing route).
func (a *API) handleEmbeddings(c *gin.Context) {
	user := serverauth.CurrentUser(c)
	if user == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxEmbedBody)
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
		Model string          `json:"model"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || req.Model == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体缺少 model 字段")
		return
	}
	inputs, err := parseInputs(req.Input)
	if err != nil || len(inputs) == 0 {
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
	// 并发计量(2026-08-31):embedding 也计入对应模型并发。
	done := a.conc.begin(req.Model)
	defer done()
	vecs, tokens, err := NewEmbedder(a.DB).Embed(c.Request.Context(), req.Model, inputs)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游服务不可用")
		return
	}
	if _, err := serverstore.RecordUsageKind(a.DB, user.ID, req.Model, tokens, 0, "embedding"); err != nil {
		log.Printf("gateway: record embed usage: %v", err)
	}
	c.JSON(http.StatusOK, gin.H{
		"object": "list",
		"data": func() []gin.H {
			out := make([]gin.H, len(vecs))
			for i, v := range vecs {
				out[i] = gin.H{"object": "embedding", "index": i, "embedding": v}
			}
			return out
		}(),
		"model": req.Model,
		"usage": gin.H{"prompt_tokens": tokens, "total_tokens": tokens},
	})
}

package channels

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"time"
)

// ModelInfo 是从上游拉取的单个模型信息。长度字段 0 表示未知,用渠道预设兜底。
type ModelInfo struct {
	ID          string
	DisplayName string
	ContextLen  int64
	MaxOutput   int64
}

type Channel interface {
	Name() string
	BaseURL() string
	// GET /models,解析 OpenAI 兼容 data[];fetchFn 可注入便于测试
	FetchModels(ctx context.Context, apiKey string, fetchFn func(url string) ([]byte, error)) ([]ModelInfo, error)
	// 请求体覆盖:overrides 深合并进请求体,removeKeys 从请求体删除
	RequestOverrides(modelID string) (overrides map[string]any, removeKeys []string)
	// 能力预设(FetchModels 响应无值时的兜底)
	DefaultModelCaps() (contextLen, maxOutput int64)
}

var registry = map[string]Channel{}

// Register 由各渠道包 init() 调用。
func Register(c Channel) { registry[c.Name()] = c }

// Get 按名取渠道。
func Get(name string) (Channel, bool) { c, ok := registry[name]; return c, ok }

// All 返回已注册渠道名(排序)。
func All() []string {
	names := make([]string, 0, len(registry))
	for n := range registry {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// HTTPFetch 默认 fetchFn:GET url + Bearer key,返回响应体。ctx 控制取消,client 带超时。
func HTTPFetch(ctx context.Context, url, apiKey string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("upstream status " + resp.Status)
	}
	// 模型列表响应有上限:恶意/异常上游不得把无限响应体灌进服务端内存
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

type oaiModelsResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// ParseOAIModels 解析 OpenAI 兼容 /models 响应。
func ParseOAIModels(body []byte) ([]ModelInfo, error) {
	var resp oaiModelsResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	out := make([]ModelInfo, 0, len(resp.Data))
	for _, m := range resp.Data {
		out = append(out, ModelInfo{ID: m.ID, DisplayName: m.ID})
	}
	return out, nil
}

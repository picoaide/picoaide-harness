package channels

import (
	"context"
	"strings"
)

// DeepSeek 渠道:官方 OpenAI 兼容 API。
type DeepSeek struct{}

func init() { Register(DeepSeek{}) }

func (DeepSeek) Name() string    { return "deepseek" }
func (DeepSeek) BaseURL() string { return "https://api.deepseek.com" }

// FetchModels:GET https://api.deepseek.com/models,解析 OpenAI 兼容响应。
// deepseek /models 只返回 id/owned_by,不含长度字段(已实测),长度走预设。
func (d DeepSeek) FetchModels(ctx context.Context, apiKey string, fetchFn func(url string) ([]byte, error)) ([]ModelInfo, error) {
	f := fetchFn
	if f == nil {
		f = func(url string) ([]byte, error) { return HTTPFetch(ctx, url, apiKey) }
	}
	body, err := f(d.BaseURL() + "/models")
	if err != nil {
		return nil, err
	}
	return ParseOAIModels(body)
}

// RequestOverrides:强制思考模式 max;思考模式不支持 4 个采样参数,删除。
// 模型感知:reasoner 系列不接受 reasoning_effort(上游 400),对其返回 no-op;
// 自定义 baseURL 的兼容模型可经任意其它渠道名接入,deepseek 渠道只覆盖官方模型。
func (d DeepSeek) RequestOverrides(modelID string) (map[string]any, []string) {
	if strings.Contains(strings.ToLower(modelID), "reasoner") {
		return nil, nil
	}
	return map[string]any{
		"thinking":         map[string]any{"type": "enabled"},
		"reasoning_effort": "max",
	}, []string{"temperature", "top_p", "presence_penalty", "frequency_penalty"}
}

// DefaultModelCaps:上下文 1M、输出 384K(deepseek 官方模型表)。
func (d DeepSeek) DefaultModelCaps() (int64, int64) { return 1048576, 393216 }

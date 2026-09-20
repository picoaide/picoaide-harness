package llmgateway

import (
	"bytes"
	"encoding/json"
	"log"
)

// upstreamExtensionPrefix 是上游 DSH 私有请求体扩展字段的前缀。
//
// P0-4（2026-09-20 DSH 0.1.6 升级审计）：上游 0.1.6 起 `session-log-deepseek`
// 插件**默认开启**（`packages/session/session-log-deepseek/src/index.ts:39`），
// 它通过 `ctx.deepseekLlmApiExtensions.register('dsh_session_log', …)` 往每个带
// 会话的 LLM 请求体顶层塞一份**会话日志后缀**（会话正文 / 工具参数与结果 / 工作区
// 路径）。而本网关把请求体**逐字节转发**给客户配置的供应商 ⇒ 不做剔除就是
// 「会话原文出境」，企业客户不可接受。
//
// 两道闸门（缺一不可，深度防御）：
//  1. 客户端侧：桌面 profile 里 `session-log-deepseek` 行 `disabled: true`
//     （`packages/host/desktop/cordis.patch.yml`）—— 治本，但只对**我们发的**客户端
//     生效，且下一版升级若忘了就会复发（上游默认值就是 `true`）。
//  2. 服务端侧（本文件）：出站请求体里这一族字段一律剔除 —— 不管客户端是哪一版、
//     怎么配的，会话正文都不会离开客户边界。
//
// 为什么按**前缀**而不是列一个键名：0.1.6 这个字段是**默认开启、无声新增**的
// （rc.2 完全没有），只钉 `dsh_session_log` 一个名字意味着上游下次再加一个同族
// 字段又要重新踩一遍。判据是「顶层键以 `dsh_` 开头的都不是模型输入」——依据是
// 上游自己的 README：该字段「is a sibling of the DeepSeek request's model-input
// fields and is not inserted into messages, the system prompt, or tool schemas」
// （`session-log-deepseek/README.md:55`）。OpenAI Chat Completions / Completions /
// Responses 与 Anthropic Messages 四个契约里都没有 `dsh_` 前缀的顶层字段。
//
// 认账残留（2026-09-20）：若上游改用**别的前缀**引入同类字段（例如
// `deepseek_session_log`），本函数抓不到 —— 那时要靠客户端侧闸门 + 升级审计的
// 「上游新增默认行」清单兜住（本次就是靠审计发现的）。
const upstreamExtensionPrefix = "dsh_"

// stripUpstreamExtensions 剔除出站请求体顶层的上游私有扩展字段。
//
// 语义边界（**故意保守**，因为转发与计费是主路径、净化只是附带动作）：
//   - 只删**顶层**键；不动 `messages`/`input`/`tools`/`system` 等契约字段，
//     也不动嵌套结构里同名的字符串（那不是上游的扩展面）；
//   - 请求体不含该前缀时**原样返回同一段字节**（零重编码：网关的既有语义是
//     "逐字节转发"，不能因为净化而改变正常的字节形态与键序）；
//   - 非 JSON 对象 / 解析失败时原样返回并报错，由调用方决定怎么记日志 ——
//     绝不因为净化动作让一个合法请求失败。
//
// 返回 (可能被净化的体, 是否发生剔除, 错误)。
func stripUpstreamExtensions(raw []byte) ([]byte, bool, error) {
	if !bytes.Contains(raw, []byte(upstreamExtensionPrefix)) {
		return raw, false, nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return raw, false, err
	}
	removed := make([]string, 0, 1)
	for key := range body {
		if len(key) >= len(upstreamExtensionPrefix) && key[:len(upstreamExtensionPrefix)] == upstreamExtensionPrefix {
			delete(body, key)
			removed = append(removed, key)
		}
	}
	if len(removed) == 0 {
		// 前缀只出现在值里（例如某条消息的正文）—— 保持原字节。
		return raw, false, nil
	}
	out, err := json.Marshal(body)
	if err != nil {
		return raw, false, err
	}
	// 剔除是**安全事件**：留一条可检索的日志（键名不是秘密，值才是，值不落日志）。
	log.Printf("gateway: stripped %d upstream request extension field(s) from outbound body: %v", len(removed), removed)
	return out, true, nil
}

// sanitizeOutboundBody 是三个转发入口（forward / forwardEndpoint /
// forwardAnthropic）共用的净化包装：剔除失败只记日志、不改转发语义。
//
// 三个入口都必须调用它 —— 覆盖 `/v1/chat/completions`、`/v1/completions`、
// `/v1/responses`、`/v1/messages` 四条出站路径（`/v1/embeddings` 的请求体是
// 服务端自己拼的 `{model,input}`，没有客户端透传面，故不经过这里）。
// 防漏判据在 `sanitize_test.go` 的 `TestEveryForwardHelperSanitizesOutboundBody`
// （扫描源码：任何 `bytes.NewReader(raw)` 所在函数都必须调用本函数）。
func sanitizeOutboundBody(raw []byte) []byte {
	out, stripped, err := stripUpstreamExtensions(raw)
	if err != nil {
		// 解析失败 = 这段体不是 JSON 对象（真·非法请求会在下游被供应商拒绝）。
		// 这里只留痕，不改变既有语义。
		log.Printf("gateway: outbound body left unsanitized (not a JSON object): %v", err)
		return raw
	}
	if !stripped {
		return raw
	}
	return out
}

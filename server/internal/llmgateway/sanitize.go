package llmgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
)

// errOutboundBodyNotJSON：最后一道闸门发现出站体**不是 JSON 对象**（解析失败/是数组
// 或标量）。调用方必须 fail-closed（400），绝不"解析不了就原样放行"。
//
// 审计 2026-09-22 F 路 P0-1 的教训：整条链上任何一个 fail-open 的闸门都会变成绕过
// 全部校验的入口 —— `{"junk":1e999, …他人 file_id…}` 让 map 解析失败，而结构体解析
// 容忍未知字段，于是 file_id 归属、user_id 覆盖、`dsh_` 剔除三处同时被跳过。聊天类
// 端点在更早处（prepareOutboundBody）已经做过同样的合法性判定，这里返回该错误意味着
// **上游闸门与本地判定不一致**（编程错误或中间重编码 bug），属不可达但必须显式处理。
var errOutboundBodyNotJSON = errors.New("outbound body is not a JSON object")

// upstreamExtensionPrefix 是上游 DSH 私有请求体扩展字段的前缀。
//
// P0-4（2026-09-20 DSH 0.1.6 升级审计）：上游 0.1.6 起 `session-log-deepseek`
// 插件**默认开启**（`packages/session/session-log-deepseek/src/index.ts:39`），
// 它通过 `ctx.deepseekLlmApiExtensions.register('dsh_session_log', …)` 往每个带
// 会话的 LLM 请求体顶层塞一份**会话日志后缀**（会话正文 / 工具参数与结果 / 工作区
// 路径）。而本网关把请求体转发给客户配置的供应商（聊天类端点会先经
// prepareOutboundBody 重编码：注入 user_id + 校验 file_id 归属；其余端点仍按
// 原始字节转发）⇒ 不做剔除就是
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
//     "不改变语义"的最小动作；2026-09-22 起聊天类端点在**本函数之前**已按
//     prepareOutboundBody 统一重编码一次，键序不再是原始形态，但同一输入每轮
//     产出同样的字节，前缀缓存（KVCache）不受影响）；
//   - 非 JSON 对象 / 解析失败时原样返回并报错，由调用方决定怎么处置 —— 本函数
//     只如实报告，是否 fail-closed 由 sanitizeOutboundBody 与转发入口决定。
//
// 返回 (可能被净化的体, 是否发生剔除, 错误)。
func stripUpstreamExtensions(raw []byte) ([]byte, bool, error) {
	if !bytes.Contains(raw, []byte(upstreamExtensionPrefix)) {
		return raw, false, nil
	}
	// 必须与出站加工侧同口径（`Decoder.UseNumber()`）：普通 Unmarshal 会把数字解成
	// float64，于是**合法 JSON**（如 `{"temperature":1e400,"dsh_x":1}`）在这里报
	// "cannot unmarshal number"，被 fail-closed 的调用方误判成"请求体不是合法 JSON"
	// 而 400 —— 审计 2026-09-22 R4 N-1 实测（同一份体不带 `dsh_` 字样时 200）。
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil || body == nil {
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
// forwardAnthropic）共用的净化包装。
//
// 三个入口都必须调用它 —— 覆盖 `/v1/chat/completions`、`/v1/completions`、
// `/v1/responses`、`/v1/messages` 四条出站路径（`/v1/embeddings` 的客户端体
// **从不转发**：出站体由服务端按解析后的 input 自建）。
// 防漏判据在 `sanitize_test.go` 的 `TestEveryForwardHelperSanitizesOutboundBody`
// （扫描源码：任何构造上游请求的函数都必须调用本函数，或登记在带理由的允许清单里）。
//
// ok=false 表示"无法确认这是 JSON 对象" ⇒ 调用方必须 400 收口（见
// errOutboundBodyNotJSON）。2026-09-22 审计 F 路 P0-1 之前这里是"解析失败即原样
// 转发"，那是一个 fail-open 闸门。
func sanitizeOutboundBody(raw []byte) ([]byte, bool) {
	out, stripped, err := stripUpstreamExtensions(raw)
	if err != nil {
		// 解析失败 = 这段体不是 JSON 对象。**不再原样放行**：留痕并 fail-closed。
		log.Printf("gateway: outbound body rejected (not a JSON object): %v", err)
		return nil, false
	}
	if !stripped {
		return raw, true
	}
	return out, true
}

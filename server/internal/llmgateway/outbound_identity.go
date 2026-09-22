package llmgateway

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 出站请求体加工：按员工注入 user_id + 校验 file_id 引用归属（2026-09-22）
// ---------------------------------------------------------------------------
//
// 网关此前把请求体**逐字节**转发（只在出站前剔 `dsh_` 私有字段，见 sanitize.go）。
// 这在多租户语义下有两个洞：
//
//  1. **file_id 没有归属校验**。Files API 的文件落在**同一个上游账号**（全组织共用
//     一个 provider key）。若某员工知道了别人上传的 `file_id`（列表接口已按归属过滤、
//     检索/删除也会 404，但 id 仍可能通过截图、日志、对话粘贴泄漏），他只要在自己的
//     聊天请求里引用这个 id，上游就会把**别人的图片**当作本次对话的输入读进去 ——
//     归属台账只挡了 /files 三个入口，没挡聊天引用。这里在出站前把请求体里所有
//     `file_id` 引用逐个按归属校验：不属于调用者 ⇒ 直接 404（与"不存在"同形），
//     根本不发往上游。
//
//  2. **user_id 从不注入**。官方用它做 KVCache / 调度 / 内容安全三重隔离
//     （api-docs.deepseek.com/quick_start/rate_limit §user_id Isolation），且明确
//     "Do not include user privacy information"。我们既不注入也不覆盖 ⇒ 全公司落进
//     上游同一个"空 user_id"隔离域，KVCache 不按人隔离（官方原话就是 privacy
//     management）。现在按员工注入稳定标识 `u<users.id>`（内部主键，非用户名/邮箱
//     等隐私信息，满足官方 `[a-zA-Z0-9\-_]+` ≤512 的形状要求），并**覆盖**客户端
//     自带的值 —— 否则第三方客户端可以伪造他人身份做 KVCache 投毒/隔离逃逸。
//     Anthropic 形态写在 `metadata.user_id`（官方 Anthropic 兼容的口径）。
//
// 成本控制：只有两个动作都需要解析请求体，所以合成**一次** parse + 一次 marshal。
// 这与既有路径同口径（applyStreamUsageRequest 对每个流式请求都会重编码一次）；
// 重编码是确定性的（Go map → 键排序），同一份输入每轮产出同样的字节，因此不会
// 破坏上游的前缀缓存（KVCache）命中。

// platformUserID 返回注入给上游的员工标识：`u<users.id>`。
// 不含用户名/邮箱/部门等隐私信息；长度远小于官方 512 上限。
func platformUserID(userID int64) string {
	return "u" + strconv.FormatInt(userID, 10)
}

// outboundIdentity 决定要不要、以什么形状注入平台侧 user_id。
//
// 只对**官方文档明确支持** user_id 的两个端点上注入：
//   - OpenAI 兼容 Chat Completions（官方 rate_limit 页给出顶层 `user_id` 示例）；
//   - Anthropic 兼容 Messages（官方示例用 `metadata.user_id`）。
//
// `/completions`(FIM) 与 `/responses` 的文档没有这个字段，注入未文档化字段属
// 未经证实的行为改变 —— 这两条路径设为 identityNone（**仍然做 file_id 归属校验**，
// 归属校验只拒不放，不改变正常请求的语义）。
type outboundIdentity int

const (
	identityNone outboundIdentity = iota
	identityOpenAI
	identityAnthropic
)

// prepareOutboundBody 是聊天类入口共用的出站体加工：
// ① 校验所有 file_id 引用归属调用者（不通过 ⇒ 已写 404，返回 ok=false）；
// ② 按 mode 注入/覆盖平台侧 user_id。
//
// 请求体不是合法 JSON 对象时**原样返回**（与 sanitize.go 同口径：净化/加工动作
// 绝不能让一个原本合法的请求变成失败，非法请求交给下游按它自己的规则拒）。
func prepareOutboundBody(c *gin.Context, db *sql.DB, userID int64, raw []byte, mode outboundIdentity) ([]byte, bool) {
	if c == nil {
		return raw, true
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return raw, true
	}
	if !fileReferencesOwned(c, db, userID, body) {
		return nil, false
	}
	if mode != identityNone {
		setPlatformUserID(body, userID, mode == identityAnthropic)
	}
	out, err := json.Marshal(body)
	if err != nil {
		return raw, true
	}
	return out, true
}

// setPlatformUserID 写入平台侧员工标识：OpenAI 形态用顶层 `user_id`，
// Anthropic 形态用 `metadata.user_id`（两者都覆盖客户端自带值）。
func setPlatformUserID(body map[string]any, userID int64, anthropic bool) {
	id := platformUserID(userID)
	if !anthropic {
		body["user_id"] = id
		return
	}
	meta, ok := body["metadata"].(map[string]any)
	if !ok {
		meta = map[string]any{}
		body["metadata"] = meta
	}
	meta["user_id"] = id
}

// fileReferencesOwned 校验请求体里出现的每个 `file_id` 引用都属于调用者。
// 未登记 / 他人的 id ⇒ 写 404 并返回 false；形状非法同样按"不存在"处理。
func fileReferencesOwned(c *gin.Context, db *sql.DB, userID int64, node any) bool {
	refs := map[string]struct{}{}
	collectFileRefs(node, refs)
	if len(refs) == 0 {
		return true
	}
	for id := range refs {
		if !validGatewayFileID(id) {
			log.Printf("gateway: reject request referencing a malformed file id (user=%d)", userID)
			writeFileNotFound(c)
			return false
		}
		owned, err := serverstore.GatewayFileOwnedBy(db, id, userID)
		if err != nil {
			log.Printf("gateway: check file ownership failed (user=%d): %v", userID, err)
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取文件归属失败")
			return false
		}
		if !owned {
			// 与 /files 的"不存在"同形：不泄露该 id 是否存在、属于谁。
			log.Printf("gateway: reject request referencing a file id not owned by the caller (user=%d)", userID)
			writeFileNotFound(c)
			return false
		}
	}
	return true
}

// schemaOnlyKeys 是被跳过、不参与 file_id 引用收集的子树键。
//
// 为什么：工具/函数/结构化输出的 **schema 定义**里可以合法出现 `file_id` 字符串
// （属性默认值、examples、enum 等），而链路两端都不会把 schema 当文件引用去解析
// （上游只解析消息/输入内容里的引用）。不跳过就会把"schema 里带示例 id"的正常请求
// 误判成越权引用 —— 而本平台客户大量使用 MCP 工具（现场单个会话 300+ 个工具定义）。
// 跳过是**收窄误报**，不是放宽安全：消息/输入内容里的引用（`type:file|image|
// input_image|document` 等）仍在扫描范围内。
var schemaOnlyKeys = map[string]bool{
	"tools":           true,
	"functions":       true,
	"function":        true,
	"response_format": true,
	"tool_choice":     true,
}

// collectFileRefs 递归收集 `file_id` 键下的非空字符串值（跳过 schema 子树）。
//
// 只认**键名为 `file_id` 的字符串值**：工具调用参数/消息正文里的 `file_id` 文本是
// 普通字符串内容（例如 assistant.tool_calls[].function.arguments 本身就是一段
// JSON 字符串），不会被当引用 —— 既不漏挡真实引用，也不误伤正文。
func collectFileRefs(node any, out map[string]struct{}) {
	switch v := node.(type) {
	case map[string]any:
		for k, child := range v {
			if schemaOnlyKeys[k] {
				continue
			}
			if k == "file_id" {
				if s, ok := child.(string); ok && s != "" {
					out[s] = struct{}{}
				}
			}
			collectFileRefs(child, out)
		}
	case []any:
		for _, child := range v {
			collectFileRefs(child, out)
		}
	}
}

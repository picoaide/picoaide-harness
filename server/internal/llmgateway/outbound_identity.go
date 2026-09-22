package llmgateway

import (
	"bytes"
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

// ---------------------------------------------------------------------------
// 角色化 body 类型：把"客户端原始字节"与"出站字节"变成编译期不可互换
// ---------------------------------------------------------------------------
//
// 两条不变量靠**类型**而不是靠评审纪律保证（审计 2026-09-22 F 路 M1/M3/M4/M5/M12
// 变异全部只被源码字符串守卫挡着，新增路径/改名即静默失效）：
//
//	clientBody   —— readRequestBody 的产物，只允许用于 ①解析字段 ②计量估算
//	outboundBody —— prepareOutboundBody 的产物，只允许用于发给上游
//
// 于是"把 raw 转发出去"或"拿 outbound 计费"都变成编译错误；字面量与
// `[]byte("…")` 这类无名类型临时值仍可直接传参（测试与内置体不受影响）。
type clientBody []byte

type outboundBody []byte

// outboundIdentity 决定要不要、以什么形状注入平台侧 user_id。
//
// 只对**官方文档明确支持**该字段的端点注入：
//   - OpenAI 兼容 Chat Completions（官方 rate_limit 页给出顶层 `user_id` 示例）；
//   - OpenAI 兼容 Responses（官方 create-response 文档的顶层 `user`，字符集
//     `[a-zA-Z0-9\-_]`、≤512，用途同样是内容安全/KVCache/调度隔离），
//     **审计 2026-09-22 F 路 P1-1 修正**：此前按"官方没有该字段"处理是错的，
//     当时只查了 `user_id` 这个名字；
//   - Anthropic 兼容 Messages（官方示例用 `metadata.user_id`）。
//
// `/completions`(FIM) 的官方文档没有用户标识字段（只有 prompt/echo/…），注入未文档化
// 字段属未经证实的行为改变 ⇒ identityNone（**仍然做 file_id 归属校验**，归属校验
// 只拒不放，不改变正常请求的语义）。
type outboundIdentity int

const (
	identityNone outboundIdentity = iota
	identityOpenAI
	identityResponses
	identityAnthropic
)

// topLevelUserKey 返回该模式注入的**顶层**键名；空串表示不写顶层键
// （identityNone 不注入、identityAnthropic 写 metadata 子对象）。
func topLevelUserKey(mode outboundIdentity) string {
	switch mode {
	case identityOpenAI:
		return "user_id"
	case identityResponses:
		return "user"
	}
	return ""
}

// maxFileRefsPerRequest 单个请求允许引用的 file_id 数量上限。
//
// 归属校验的 DB 往返已经批量成一次，这条上限挡的是另外两件事：①`IN (...)` 的
// 参数个数（PG 上限 65535，64MiB 体足够塞进十万个 id，撞上去就是 500 而非干净的
// 拒绝）；②上游对"一条消息引用几百个文件"也没有实际用法。真实会话是个位数量级。
const maxFileRefsPerRequest = 256

// prepareOutboundBody 是聊天类入口共用的出站体加工：
// ① 校验所有 file_id 引用归属调用者（不通过 ⇒ 已写 404，返回 ok=false）；
// ② 按 mode 注入/覆盖平台侧 user_id。
//
// 失败语义（2026-09-22 审计 G-1 修正）：请求体**不是合法 JSON 对象时直接 400**，
// 不再"解析失败就原样放行"。原口径（照抄 sanitize.go 的"净化不改转发语义"）留下了
// 一个实测可用的绕过：`{"junk":1e999, …他人 file_id…}` 让 map 解析失败、而结构体解析
// （skip() 容忍未知字段）成功 ⇒ 闸门被整体跳过、他人 file_id 与伪造 user_id 一起出境。
// 聊天类端点的契约本就要求 JSON 对象，本地 400 与上游的拒绝等价，且 fail-closed。
//
// 内存（审计 G-2）：大请求体的解析/重编码放大明显（map[string]any 约 4×，HTML 转义
// 还会让输出膨胀 ~1.9×），所以有**零重编码快路径**：见 fastPathUserID。
func prepareOutboundBody(c *gin.Context, db *sql.DB, userID int64, raw clientBody, mode outboundIdentity) (outboundBody, bool) {
	if c == nil {
		return outboundBody(raw), true
	}
	// 快路径：大体积、无需校验引用、也没有客户端自带的 user_id 要覆盖时，
	// 只在末尾追加平台 user_id（不改动原有字节）。
	if out, ok := fastPathUserID(raw, userID, mode); ok {
		return out, true
	}
	if !json.Valid(raw) {
		writeInvalidBody(c, "请求体不是合法 JSON")
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // 保全大整数精度（float64 会让 >2^53 的整数在重编码时漂移）
	var body map[string]any
	if err := dec.Decode(&body); err != nil || body == nil {
		writeInvalidBody(c, "请求体必须是 JSON 对象")
		return nil, false
	}
	if !fileReferencesOwned(c, db, userID, body) {
		return nil, false
	}
	if mode == identityNone {
		// 没有任何改动 ⇒ 原字节返回（避免无谓的重编码）。
		return outboundBody(raw), true
	}
	if !setPlatformUserID(c, body, userID, mode) {
		return nil, false
	}
	var buf bytes.Buffer
	buf.Grow(len(raw) + 32)
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // 正文里的 < > & 不再被转成 \u003c（输出膨胀 ~1.9× 的来源）
	if err := enc.Encode(body); err != nil {
		return outboundBody(raw), true
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), true
}

// writeInvalidBody 统一的"请求体不合法"响应（fail-closed 的本地拒绝）。
func writeInvalidBody(c *gin.Context, msg string) {
	serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", msg)
}

// fastPathUserID 是零重编码快路径：把平台 user_id 追加到 JSON 对象末尾
// （JSON 允许重复键，取后者 ⇒ 覆盖客户端自带值；且原有字节逐字保留，前缀缓存最友好）。
//
// 只在**完全可判定**的前提下走：写顶层键的模式、体积够大（小体解析很便宜，不值得特判）、
// 语法合法、是对象、且正文里没有任何 `file_id` 字样、也没有 `"<键名>":` 出现（客户端
// 自带该键时留给定式覆盖路径处理，避免把"重复键"这种非常规形态交给上游），也没有
// `\u` 转义（`"file\u005fid"` 这种键名要靠解析才能认出，见到 `\u` 一律走慢路径）。
func fastPathUserID(raw []byte, userID int64, mode outboundIdentity) (outboundBody, bool) {
	key := topLevelUserKey(mode)
	if key == "" || len(raw) < fastPathMinBytes {
		return nil, false
	}
	if bytes.Contains(raw, []byte("file_id")) {
		return nil, false
	}
	// 键名 + 冒号：Responses 的 `user` 与正文里的 `"role":"user"` 必须区分开，
	// 所以比对 `"user":` 而不是裸 `user`（后者在每条消息里都有，快路径会永不命中）。
	if bytes.Contains(raw, []byte(`"`+key+`":`)) {
		return nil, false
	}
	if bytes.Contains(raw, []byte(`\u`)) {
		return nil, false
	}
	if !json.Valid(raw) {
		return nil, false
	}
	end := len(raw)
	for end > 0 {
		switch raw[end-1] {
		case ' ', '\t', '\n', '\r':
			end--
			continue
		}
		break
	}
	if end == 0 || raw[end-1] != '}' {
		return nil, false
	}
	start := 0
	for start < end && (raw[start] == ' ' || raw[start] == '\t' || raw[start] == '\n' || raw[start] == '\r') {
		start++
	}
	if start >= end || raw[start] != '{' || raw[start+1] == '}' {
		return nil, false
	}
	out := make([]byte, 0, end+32)
	out = append(out, raw[:end-1]...)
	out = append(out, ',', '"')
	out = append(out, key...)
	out = append(out, '"', ':', '"')
	out = append(out, platformUserID(userID)...)
	out = append(out, '"', '}')
	out = append(out, raw[end:]...)
	return out, true
}

// fastPathMinBytes 是启用快路径的体量门槛：低于它的请求解析成本可忽略，
// 走统一慢路径以免特判分支过多。
const fastPathMinBytes = 64 << 10

// setPlatformUserID 写入平台侧员工标识并**覆盖**客户端自带值：
// OpenAI Chat 形态用顶层 `user_id`，Responses 形态用顶层 `user`，
// Anthropic 形态用 `metadata.user_id`。
//
// 返回 false 表示已写出错响应（fail-closed，不再继续转发）。当前唯一的失败面是
// Anthropic 的 `metadata` 存在但不是 JSON 对象：旧实现会把它整个替换成新对象、
// **静默丢弃客户端原值**（审计 2026-09-22 F 路 P2-7）；官方口径里 metadata 就是对象，
// 本地 400 与上游的拒绝等价，比悄悄改写正文更可信。
func setPlatformUserID(c *gin.Context, body map[string]any, userID int64, mode outboundIdentity) bool {
	id := platformUserID(userID)
	if key := topLevelUserKey(mode); key != "" {
		body[key] = id
		return true
	}
	if mode != identityAnthropic {
		return true
	}
	meta, exists := body["metadata"]
	if !exists || meta == nil {
		body["metadata"] = map[string]any{"user_id": id}
		return true
	}
	obj, ok := meta.(map[string]any)
	if !ok {
		writeInvalidBody(c, "metadata 必须是 JSON 对象")
		return false
	}
	obj["user_id"] = id
	return true
}

// fileReferencesOwned 校验请求体里出现的每个 `file_id` 引用都属于调用者。
// 未登记 / 他人的 id ⇒ 写 404 并返回 false；形状非法同样按"不存在"处理。
// 归属判定一次问清（批量 IN），并把引用数压在上限内。
func fileReferencesOwned(c *gin.Context, db *sql.DB, userID int64, node any) bool {
	refs := map[string]struct{}{}
	collectFileRefs(node, refs)
	if len(refs) == 0 {
		return true
	}
	if len(refs) > maxFileRefsPerRequest {
		log.Printf("gateway: reject request with too many file references (user=%d refs=%d)", userID, len(refs))
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
			"单次请求引用的文件过多（上限 256 个）")
		return false
	}
	ids := make([]string, 0, len(refs))
	for id := range refs {
		if !validGatewayFileID(id) {
			log.Printf("gateway: reject request referencing a malformed file id (user=%d)", userID)
			writeFileNotFound(c, id)
			return false
		}
		ids = append(ids, id)
	}
	owned, err := serverstore.GatewayFilesOwnedBy(db, ids, userID)
	if err != nil {
		log.Printf("gateway: check file ownership failed (user=%d): %v", userID, err)
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取文件归属失败")
		return false
	}
	for _, id := range ids {
		if _, ok := owned[id]; !ok {
			// 与 /files 的"不存在"同形：不泄露该 id 是否存在、属于谁。
			log.Printf("gateway: reject request referencing a file id not owned by the caller (user=%d)", userID)
			writeFileNotFound(c, id)
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

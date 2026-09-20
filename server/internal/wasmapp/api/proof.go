package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/appproof"
)

// 客户端持有性证明的传输层（契约 §20.1 / §23.1）。
//
// 分工：**本文件**只做"HTTP 形状 + 错误分层 + 会话键"，密码学与一次性表全在
// `internal/wasmapp/appproof`（密钥环 / 签发 / 验签 / nonce / jti 去重）。
//
// 三个端点共享同一套校验，顺序**冻结**（§20.1）：
//
//	签发 proof：BearerAuth → 安装签名（§23.1）→ 签发
//	request   ：BearerAuth → app-proof → 信封/Host 形态 → Origin（非幂等）
//	open      ：BearerAuth → app-proof → 版本查询/计数（§5.1b）
//
// ⚠️ `open` 端点**同样要求 proof**（R2S-6 订正）：否则被盗 bearer 可以刷 open、
// 探测版本与标题、并且把打开计数刷成任意值。

// proofHeader 是 proof 的携带头名（契约 §20.1）。
//
// 与 envelope 头白名单无关：它是**平台与协议 handler 之间**的头（不进应用信封），
// 因此不在 `clientRequestHeaders` 那张表里 —— 两张表的消费者不同，合并会让
// "应用能看到什么"与"平台看到什么"重新缠在一起（见 clientreq.go 的注释）。
const proofHeader = "X-Pico-App-Proof"

// appProofIsIdempotent 判定**应用请求**是否幂等（只有非幂等才做 jti 去重，契约 §23.1）。
//
// ⚠️ 判据是"这次**应用请求**（信封里的 `method`）是否幂等"，**不是**外层 HTTP 方法：
// 信封端点 `POST /…/:app_id/request` 自身**恒为 POST**，而客户端的 proof 是
// **按出站复用**的（`app-proof.ts`：同一 token+serverURL 下缓存到 TTL 结束，
// 只有 401 才 `invalidate()` 重签）。若按外层 POST 判定，则客户端缓存的 proof 在
// **第二次写请求**上必然撞 `proof_replayed` ⇒ 每次写都要先吃一次 401 再重签
// （功能可用但每次写都多一个往返，且日志里全是"重放"噪音）。
//
// 取"读"的三种方法（GET/HEAD/OPTIONS/TRACE）与 `edge.IsIdempotent` **同口径**，
// 未知/缺失的方法**保守按非幂等**处理（消费 jti）—— 窥探失败时宁可多消费一次，
// 也不能把一次写请求当成读放过重放。
func appProofIsIdempotent(method string) bool {
	_, ok := proofJTIExemptMethods[strings.ToUpper(strings.TrimSpace(method))]
	return ok
}

// proofJTIExemptMethods 是幂等方法的封闭集合（见 appProofIsIdempotent 的注释）。
var proofJTIExemptMethods = map[string]struct{}{
	http.MethodGet: {}, http.MethodHead: {}, http.MethodOptions: {}, http.MethodTrace: {},
}

// bearerHashFor 返回 bearer 的 SHA-256（hex，全量）。
//
// 用途：proof 的 bearer 绑定（`Claims.BH`）。**不用** trimmed 版本：proof 是
// 长期存在（TTL 内）的凭据，绑定值的熵越足越好，而截断只对"会话键"有意义。
func bearerHashFor(c *gin.Context) string {
	if c == nil {
		return ""
	}
	raw, _ := c.Get(serverauth.CtxTokenKey)
	s, _ := raw.(string)
	if strings.TrimSpace(s) == "" {
		return ""
	}
	return serverstore.TokenHash(s)
}

// sessionKeyFor 返回**会话键**（契约 §8.2：bearer 的 SHA-256 前 16 字节 hex）。
//
// ⚠️ 该键原本是服务端 `aichat`"在手令牌"的会话维度（R1-SRV-5）；`ai.chat` 已随
// 总纲 §21 彻底删除 ⇒ 服务端不再有在手令牌，键**不再被任何服务端判定读取**。
// 保留它只有两个理由，都是契约事实：①§8.2 冻结了 `ServeClientRequest(..., sessionKey)`
// 这条显式传参的签名；②`serverauth.SessionKey` 仍是"吊销侧与请求侧同源"的唯一实现，
// 删掉调用点会让它失去唯一调用方。键的输入是 bearer 本身 ⇒ 登出/改密/禁用（都会吊销
// bearer）让下一次请求自然换键。
//
// ⚠️ 派生**只有一处实现**（`serverauth.SessionKey`）：吊销侧按同一个函数算键，
// 两边算错一边就等于"吊销了一个不存在的键"，而且**完全静默**（没有任何报错）。
func sessionKeyFor(c *gin.Context) string {
	if c == nil {
		return ""
	}
	raw, _ := c.Get(serverauth.CtxTokenKey)
	s, _ := raw.(string)
	if strings.TrimSpace(s) == "" {
		return ""
	}
	return serverauth.SessionKey(s)
}

// appProofIssue 是 `POST /api/client/v2/apps/wasm/proof`（契约 §20.1/§23.1）。
//
// 入参：`{install_id, public_key, nonce, ts, signature}`（DisallowUnknownFields）。
// 出参：`{proof, expires_at}`。
//
// 为什么入参里没有 `app_id`：proof 绑 app_id，但那由**签发时的路由参数**决定 ——
// 契约是 `POST …/apps/wasm/proof`（无 app_id 段），客户端为每个要打开的应用各取
// 一张 proof（宿主在打开前惰性签发，见 §23.1「惰性签发」）。因此 app_id 由请求体
// 显式给出但**必须**过 registry 校验（它是绑定的输入，不是可信身份）。
func (h *Handlers) appProofIssue(c *gin.Context) {
	user, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	if h.opt.Proof == nil {
		h.admissionFailed(c, "", user, http.StatusUnauthorized, apperr.CodeProofRequired, "持有性证明未装配")
		writeErr(c, apperr.New(apperr.CodeProofRequired, "平台未启用应用持有性证明").
			WithHint("这是平台装配问题；请联系平台管理员升级服务端"))
		return
	}
	var body struct {
		InstallID string `json:"install_id"`
		PublicKey string `json:"public_key"`
		Nonce     string `json:"nonce"`
		TS        int64  `json:"ts"`
		Signature string `json:"signature"`
		AppID     string `json:"app_id"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxProofRequestBytes)
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeErr(c, apperr.New(apperr.CodeValidation, "签发请求不是合法 JSON").
			WithDetail("reason", "decode_failed").
			WithHint(`形如 {"install_id":"…","public_key":"<base64 ed25519>","nonce":"…","ts":<unix 秒>,"signature":"<base64>","app_id":"<app_id>"}`))
		return
	}
	appID := strings.ToLower(strings.TrimSpace(body.AppID))
	if aerr := h.validateAppID(appID); aerr != nil {
		writeErr(c, aerr)
		return
	}
	res, err := h.opt.Proof.Issue(c.Request, user.ID, bearerHashFor(c), appID, appproof.InstallRequest{
		InstallID: body.InstallID,
		PublicKey: body.PublicKey,
		Nonce:     body.Nonce,
		TS:        body.TS,
		Signature: body.Signature,
	})
	if err != nil {
		e := proofIssueError(err)
		h.admissionFailed(c, appID, user, e.Status(), e.Code, "签发持有性证明失败")
		writeErr(c, e)
		return
	}
	c.JSON(http.StatusOK, gin.H{"proof": res.Proof, "expires_at": res.ExpiresAt})
}

// maxProofRequestBytes 是签发请求的体积上限（公钥 44B + 签名 88B + 三个标识，
// 1 KiB 已有两个数量级余量；上限存在的意义只是"别让未认证面成为内存放大器"）。
const maxProofRequestBytes = 1 << 10

// proofIssueError 把 appproof 的错误分类映射成对外码（契约 §20.1 的字面值）。
//
// 判定顺序：**先解码类、再语义类**。原因（相邻缺陷，2026-09-20 本机实测）：公钥按
// SPKI/DER（44 字节）发上来时旧实现回 `signature_invalid`（"安装签名校验失败"），
// 对接方会照着 hint 去查**签名消息**拼装 —— 而病根是公钥编码。两个解码类各自有
// 独立 reason（`invalid_public_key` / `signature_malformed`），且**只有真的验签不过**
// 才报 `signature_invalid`。
func proofIssueError(err error) *apperr.Error {
	switch {
	case errors.Is(err, appproof.ErrKeyMalformed):
		return apperr.New(apperr.CodeProofMismatch, "安装公钥不合法").
			WithDetail("reason", "invalid_public_key").
			WithHint("public_key 必须是 **raw Ed25519 32 字节**的标准 base64（44 字节 = SPKI/DER 包装，" +
				"PEM 文本也不行）；对公钥做任何包装都会被拒")
	case errors.Is(err, appproof.ErrSignatureMalformed):
		return apperr.New(apperr.CodeProofMismatch, "安装签名不合法").
			WithDetail("reason", "signature_malformed").
			WithHint("signature 必须是 **raw Ed25519 64 字节**的标准 base64（不要带 PEM/ASN.1 包装）；" +
				"缺失或纯空白也走这一档 —— 空签名不是「验签不过」，别去查签名消息的拼装")
	case errors.Is(err, appproof.ErrTimestampMalformed):
		return apperr.New(apperr.CodeProofMismatch, "安装签名的时间戳不合法").
			WithDetail("reason", "invalid_timestamp").
			WithHint("ts 必须是**正整数**的 unix 秒（客户端取当前时间）；ts=0/负数/缺失都走这一档，" +
				"重新取当前时间再签名即可")
	case errors.Is(err, appproof.ErrReplayed):
		return apperr.New(apperr.CodeProofReplayed, "安装签名已被使用过（nonce 重放）").
			WithDetail("reason", "nonce_replayed").
			WithHint("nonce 必须一次性：每次签发请求都要新生成一个")
	case errors.Is(err, appproof.ErrExpired):
		return apperr.New(apperr.CodeProofExpired, "安装签名的时间戳超出允许窗口").
			WithDetail("reason", "timestamp_skew").
			WithHint("重新取当前时间后再签名（客户端与服务器时钟漂移不得超过 5 分钟）")
	case errors.Is(err, appproof.ErrMismatch):
		return apperr.New(apperr.CodeProofMismatch, "安装公钥与已注册的不一致").
			WithDetail("reason", "install_key_mismatch").
			WithHint("同一 install_id 必须始终使用同一把私钥；换机/重装请换 install_id")
	default:
		return apperr.New(apperr.CodeProofMismatch, "安装签名校验失败").
			WithDetail("reason", "signature_invalid").
			WithHint("请确认签名覆盖的是 appproof-install-v1 五段消息（install_id/nonce/ts/serverURL）")
	}
}

// requireProof 校验 `X-Pico-App-Proof` 并（非幂等请求时）消费 jti。
//
// 返回 false 表示已经写好错误响应，调用方必须立刻 return。
//
// 顺序（契约 §20.1：BearerAuth → app-proof → …）：
//  1. 缺头 ⇒ 401 `proof_required`；
//  2. 验签 + 过期 + 绑定（user/bearer/serverURL/app_id）⇒ 401
//     `proof_expired` / `proof_mismatch`；
//  3. **非幂等**请求消费 jti ⇒ 401 `proof_replayed`。
//
// 为什么缺头是"required"而不是"mismatch"：客户端的正确反应不同 ——
// required ⇒ 惰性签发（§23.1），mismatch ⇒ 清掉内存 proof 重新签发并报警；
// 合并成一个码会让"第一次打开"与"环境不符"变成同一件事。
//
// jtiExempt 由调用方给出**语义上的幂等性**（不是"外层 HTTP 方法"）：
//   - `open`：恒 false（它每次都要计数，天然是状态变更）；
//   - `request`：取信封里的**应用方法**（见 appProofIsIdempotent 的注释）。
//
// 两个端点共用这一个实现（R1-L1-1 的纪律：不存在两份判据）。
func (h *Handlers) requireProof(c *gin.Context, appID string, user *serverstore.User, jtiExempt bool) bool {
	if h.opt.Proof == nil {
		// 未装配 ⇒ fail-closed。这是**装配事故**（生产必须注入），因此仍回 401 而不是
		// 放行：宁可应用打不开（可诊断），也不能让"配置漏了"变成"无证明也能进"。
		h.admissionFailed(c, appID, user, http.StatusUnauthorized, apperr.CodeProofRequired, "持有性证明未装配")
		writeErr(c, apperr.New(apperr.CodeProofRequired, "平台未启用应用持有性证明").
			WithHint("这是平台装配问题；请联系平台管理员升级服务端"))
		return false
	}
	token := strings.TrimSpace(c.GetHeader(proofHeader))
	if token == "" {
		h.admissionFailed(c, appID, user, http.StatusUnauthorized, apperr.CodeProofRequired, "缺少持有性证明")
		writeErr(c, apperr.New(apperr.CodeProofRequired, "缺少持有性证明").
			WithDetail("header", proofHeader).
			WithHint("先调用 POST /api/client/v2/apps/wasm/proof 取一份短时证明（同一 Bearer）"))
		return false
	}
	claims, err := h.opt.Proof.Verify(c.Request, token, user.ID, bearerHashFor(c), appID)
	if err != nil {
		var e *apperr.Error
		switch {
		case errors.Is(err, appproof.ErrExpired):
			e = apperr.New(apperr.CodeProofExpired, "持有性证明已过期").
				WithDetail("reason", "expired").
				WithHint("重新签发一份证明（客户端应在过期前静默续签）")
		case errors.Is(err, appproof.ErrMismatch):
			e = apperr.New(apperr.CodeProofMismatch, "持有性证明与本次请求不符").
				WithDetail("reason", "binding_mismatch").
				WithHint("证明绑定 (用户, bearer, 安装, 服务端地址, 应用)；换账号/换服务端/换应用都要重新签发")
		default:
			e = apperr.New(apperr.CodeProofMismatch, "持有性证明不可验证").
				WithDetail("reason", "malformed_or_signature").
				WithHint("证明必须由本平台签发；本地缓存/手工构造的值一律无效")
		}
		h.admissionFailed(c, appID, user, e.Status(), e.Code, "持有性证明校验失败")
		writeErr(c, e)
		return false
	}
	if !jtiExempt {
		if !h.opt.Proof.ConsumeJTI(claims) {
			h.admissionFailed(c, appID, user, http.StatusUnauthorized, apperr.CodeProofReplayed, "持有性证明重放")
			writeErr(c, apperr.New(apperr.CodeProofReplayed, "该证明已用于另一次非幂等请求").
				WithDetail("reason", "jti_replayed").
				WithHint("非幂等请求必须各自签发新的证明（同一张证明的 jti 只用一次）"))
			return false
		}
	}
	return true
}

// requestIDHeader 是关联标识的头名（OPS-6：客户端看到的 id 必须与服务端日志对得上）。
const requestIDHeader = "X-Request-Id"

// requestID 返回本次请求的关联标识（OPS-6 可观测性的关联键）。
//
// 优先取调用方带的 `X-Request-Id`（代理/客户端可以贯通它），否则生成一个。
// 它同时**回写**到响应头：排障时"客户端看到的 id"与"服务端日志里的 id"必须能对齐，
// 否则这条日志在有并发流量的真实环境里没有用处。
func requestID(c *gin.Context) string {
	if c == nil {
		return ""
	}
	if v := strings.TrimSpace(c.GetHeader(requestIDHeader)); v != "" && len(v) <= 64 && isSafeRequestID(v) {
		c.Header(requestIDHeader, v)
		return v
	}
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	id := hex.EncodeToString(buf)
	c.Header(requestIDHeader, id)
	return id
}

func isSafeRequestID(s string) bool {
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9',
			ch == '-', ch == '_', ch == '.':
		default:
			return false
		}
	}
	return true
}

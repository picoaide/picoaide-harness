// 客户端专属访问模型（2026-09-19 决策）的**传输层**：把桌面客户端本机代理的
// JSON 信封还原成一次应用请求，交给 appserver 的共用管线执行，再把响应编码回去。
//
// 决策与架构：docs/decisions/2026-09-19-wasm-client-internal-origin.md。
//
// 分工（这条边界不要挪）：
//   - **本文件**：认证结果的转交、信封的形状与体积校验、Host 这类"谁在说话"的
//     传输层判据、响应编码（Set-Cookie 整条丢弃）；
//   - **appserver.ServeClientRequest**：身份投影 + 准入 + 静态资源 + wasm 执行
//     （与旧应用子域路径共用 serveApp，不复制任何业务逻辑），以及 Origin 自源判据
//     （checkClientOrigin，判据住在管线里而不是传输层）；
//   - **internal/router**：路由与认证中间件的唯一声明处。
//
// # 错误分层（契约 §5.1 的两张表，R1-SRV-7 订正）
//
// 本入口的失败**分两层**，客户端按"外层优先"分流；实现里每一处写错误的地方都
// 必须能对应到下面某一行，不允许出现"第三层"（例如把应用语义塞进 4xx 的传输层码）：
//
//	【传输层 = 外层 HTTP 状态 + 平台错误信封】——"这次调用本身"失败了
//	  401 AUTH_REQUIRED      缺令牌（BearerAuth 中间件）
//	  401 AUTH_FAILED        令牌无效/过期/被吊销（BearerAuth 中间件）
//	  401 proof_required     缺 X-Pico-App-Proof（§20.1）
//	  401 proof_expired      proof 过期
//	  401 proof_mismatch     proof 绑定不符（含结构/签名不可验证）
//	  401 proof_replayed     非幂等请求的 jti 重放
//	  403 FORBIDDEN          审计账号
//	  400 VALIDATION         信封形态 / host 形态 / 头白名单 / path-query 非法
//	  413 BODY_TOO_LARGE     信封或应用请求体超上限
//	  429 RATE_LIMITED       平台限流（本入口目前不产生）
//	  503                    平台关停中
//
//	【应用管线 = 内层信封 status + 平台错误信封】——"这个应用"失败了
//	  200 以外的语义全在内层（`{"status":…}`）：404 NOT_FOUND（应用不存在/未登记/
//	  软删/冻结）、410（已下架，code 复用 NOT_FOUND）、403 FORBIDDEN（跨源写）、
//	  502/504（运行时无响应/超时）、500 RUNTIME_OUTPUT_OVERRUN。
//
// 为什么两层要分开写：应用**自己**的 404（页面没找到）与"应用不存在"的 404 在
// 同一个数字上，但调用方的修法完全相反 —— 外层 404 ⇒ 改 app_id/重新登记；
// 内层 404 ⇒ 改应用路由。把两层混在一起，排障只能靠猜。
//
// 为什么 Host 必须逐字符校验（本文件最要紧的一条）：应用侧的跨源写防护
// （appserver.checkClientOrigin）把 `Origin` 与**由 app_id 推导的自身源**比较，
// 而合成请求的 Host 就是那次推导的输入。如果 Host 可以被调用方随意指定，
// `Origin` 校验就退化成"调用方说自己是谁就是谁"。
// 因此 Host 只能是 `picoaide-app://<app_id>` 或裸 `<app_id>`
// （app_id 来自**路由路径**，绝不从 Host 反向解析）。
package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/appserver"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// maxClientEnvelopeBytes 是信封的请求体上限。
//
// 推导（不引入新的平台数值）：应用请求体上限 `limits.AppRequestBodyMaxBytes` 经
// base64 膨胀 4/3，再留 64 KiB 给方法/路径/头等元数据 ⇒ 信封上限由既有限额派生，
// 而**应用请求体**的权威判据仍是 limits.AppRequestBodyMaxBytes（解码后再判一次）。
const maxClientEnvelopeBytes = limits.AppRequestBodyMaxBytes*4/3 + 64<<10

// maxClientPathBytes / maxClientQueryBytes / maxClientHeaderBytes 是信封各字段的
// 长度上限。它们是**传输层**的输入约束（防单字段撑爆内存），不是应用语义限额。
const (
	maxClientPathBytes      = 4096
	maxClientQueryBytes     = 4096
	maxClientHeaderBytes    = 8 << 10
	maxClientHeaderCount    = 24
	maxClientHeaderNameSize = 64
)

// clientRequestEnvelope 是本机代理送来的请求信封。
//
// 字段设计的三条理由：
//   - `host` 必须显式带（它决定应用的 origin/跨源写判据），且被逐字符校验；
//   - `query` 是**原始串**（不解析成 map）：重编码会改变 `%2F`/`+` 这类字节，
//     应用按原样收到的查询串才与浏览器里的一致；
//   - `headers` 是白名单 map（应用只被平台暴露 content-type/accept/accept-language，
//     见 appserver.frameHeaderAllowlist），逐项限量。
type clientRequestEnvelope struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   string            `json:"query"`
	Host    string            `json:"host"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// clientResponseEnvelope 是本机代理拿到的响应信封。
//
// `headers` 用 http.Header（多值，Set-Cookie 可重复出现）；`truncated` 只在
// 传输层兜底截断时为 true —— 应用响应体的**权威**上限是
// limits.AppResponseBodyMaxBytes，由 appserver.writeAppResponse 判定并整单失败
// （绝不返回半个响应），因此正常路径下 truncated 恒为 false。
//
// ⚠️ **`truncated` 键必须总是出现**（契约 §5.1 / R1-SRV-11 / SEC-10，所以这里
// **不能**有 `omitempty`）：它是客户端判断"这份响应不可信"的唯一信号，而
// "键缺失"与"键为 false"在客户端的解析里必须是两件事 —— 一旦省略，老客户端
// 会把"平台没告诉我"当成"没截断"从而把半个页面当成功渲染。
//
// 客户端的处置是**冻结**的：`truncated:true` ⇒ 一律按 502 /
// `INVALID_PLATFORM_RESPONSE` 处理并渲染错误页（不得按成功渲染、不得静默重试）。
type clientResponseEnvelope struct {
	Status    int         `json:"status"`
	Headers   http.Header `json:"headers"`
	Body      string      `json:"body"`
	Truncated bool        `json:"truncated"`
}

// 请求头白名单（clientRequestHeaders）的**定义**已搬到 headerspec.go —— 它是跨端
// 契约的单一真源，并与生成物 wasm-app-headers.json 同源（见那里的长注释）。

// clientAllowedMethods 是信封允许的方法。OPTIONS 保留（应用可自行处理预检语义，
// 平台不做 CORS —— 本机 origin 下的请求都是同源）。
var clientAllowedMethods = map[string]struct{}{
	http.MethodGet: {}, http.MethodHead: {}, http.MethodPost: {},
	http.MethodPut: {}, http.MethodPatch: {}, http.MethodDelete: {},
	http.MethodOptions: {},
}

// clientRequest 是**唯一**应用请求入口（员工 bearer 必需）：
// `POST /api/client/v2/apps/wasm/:app_id/request`（契约 §4.1）。
//
// 无匿名面：未持员工令牌的请求在路由中间件（serverauth.BearerAuth）就被 401 挡下，
// 根本进不到本函数；进入本函数后的身份即平台权威身份。
//
// 准入顺序（契约 §5.1，**冻结**）：
//
//	① BearerAuth（路由中间件）—— 身份只来自 bearer；
//	② **app-proof**（本函数，`X-Pico-App-Proof`）—— 持有性证明；
//	③ 信封形态（方法/path/query/host/头白名单/体积，serveClientRequest）；
//	④ Origin（非幂等，管线内的 checkClientOrigin）。
//
// ⚠️ 第 ② 步**必须在信封之前**、且**不能省**（R1-L1-1，P0）：`Origin` 是协议 handler
// **合成**的，服务端无法把"应用页发起"与"攻击者自报"区分开 ⇒ 只靠 Origin 时，
// 任何拿到 bearer 的第三方都能直接驱动应用（读写应用库、调平台能力）。proof 绑
// `(user_id, bearer hash, install_id, serverURL, app_id, exp, jti)`，是与 `open`
// 端点**同一个**实现（`requireProof`），不存在两份判据。
func (h *Handlers) clientRequest(c *gin.Context) {
	user, aerr := h.currentUser(c)
	if aerr != nil {
		h.admissionFailed(c, "", nil, aerr.Status(), aerr.Code, "request: 身份不可用")
		writeErr(c, aerr)
		return
	}
	appID := strings.ToLower(strings.TrimSpace(c.Param("app_id")))
	if aerr := h.validateAppID(appID); aerr != nil {
		h.admissionFailed(c, appID, user, aerr.Status(), aerr.Code, "request: app_id 非法")
		writeErr(c, aerr)
		return
	}
	// 持有性证明：缺 ⇒ proof_required；过期 ⇒ proof_expired；绑定/结构/签名不符 ⇒
	// proof_mismatch；**非幂等**请求的 jti 重放 ⇒ proof_replayed（幂等请求不查 jti）。
	// 客户端的重签分流按 `proof_` 前缀（见 L2 的 handler.ts），因此这四个码的字面值
	// 是跨端契约。
	//
	// 幂等性取**信封里的应用方法**（不是外层 POST）：客户端的 proof 在 TTL 内按出站
	// 复用，按外层 POST 判定会让"第二次写请求"必然撞 proof_replayed（每次写多吃一个
	// 401 往返）。因此先缓冲请求体、宽松窥探 method，再做证明校验 —— 校验顺序仍是
	// 契约的 BearerAuth → app-proof → 信封形态（窥探不构成任何"接受"决定：解析失败
	// 一律保守按非幂等处理）。
	raw, aerr := readClientEnvelopeBody(c)
	if aerr != nil {
		h.admissionFailed(c, appID, user, aerr.Status(), aerr.Code, "request: 信封体积超限")
		writeErr(c, aerr)
		return
	}
	var peek struct {
		Method string `json:"method"`
	}
	// 宽松解析：只读一个字段，任何形状问题都留给下面的严格解码去报（这里只影响
	// "是否消费 jti"这一个判定）。
	_ = json.Unmarshal(raw, &peek)
	if !h.requireProof(c, appID, user, appProofIsIdempotent(peek.Method)) {
		return
	}
	// 复原请求体供严格解码（DisallowUnknownFields）使用。
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	h.serveClientRequest(c, appID, user)
}

// serveClientRequest 是入口的实现：校验信封 → 合成请求 → 共用管线 → 编码响应。
//
// appID 由调用方（clientRequest）传入：它已经过 validateAppID，并且是 proof 绑定的
// 输入 —— 两处各自从路由参数再解析一次会让"proof 校验用的 app_id"与"管线执行的
// app_id"存在两套归一化路径（当前两者逐字节相同，但没有任何东西保证将来也是）。
func (h *Handlers) serveClientRequest(c *gin.Context, appID string, user *serverstore.User) {
	if h.opt.ServeClientRequest == nil {
		writeErr(c, apperr.New(apperr.CodeInternal, "客户端访问通道未装配").
			WithHint("平台缺少 appserver 的客户端请求处理器；请联系平台管理员"))
		return
	}

	// 请求体已在 clientRequest 里按 maxClientEnvelopeBytes 缓冲并复原（见那里的注释：
	// 为了在 proof 校验之前窥探应用方法）；这里只做严格解码。
	var env clientRequestEnvelope
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeErr(c, apperr.New(apperr.CodeBodyTooLarge, "请求信封超过上限").
				WithDetail("max_bytes", int64(maxClientEnvelopeBytes)).
				WithHint("应用 API 请求体上限由平台固定；大文件请走能力中心的上传通道"))
			return
		}
		writeErr(c, apperr.New(apperr.CodeValidation, "请求信封不是合法 JSON").
			WithDetail("reason", "decode_failed").
			WithHint(`信封形如 {"method":"GET","path":"/","query":"","host":"picoaide-app://<app_id>","headers":{},"body":"<base64>"}`))
		return
	}

	req, aerr := h.buildClientRequest(c, appID, env)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}

	rec := &clientCaptureWriter{header: http.Header{}, limit: limits.AppResponseBodyMaxBytes}
	// sessionKey 显式传参（契约 §8.2 / R1-SRV-5）：客户端模式下没有应用会话行，
	// 该键自 W4（服务端 ai.chat 删除）起不再被服务端任何判定读取，仅作为 §8.2
	// 冻结契约的显式传参保留 —— 见 proof.go 的 sessionKeyFor 注释。
	h.opt.ServeClientRequest(rec, req, appID, user, sessionKeyFor(c))

	// 版本头（契约 §5.1 / R1-DAT-12）：管线把它写在**成功响应**的应用响应头上
	// （appserver.versionHeaderWriter），这里把它同时提到外层 HTTP 响应 ——
	// 协议 handler 不必解析信封体就能拿到缓存键；客户端仍会按"只剔逐跳头"的规则
	// 把信封里的同名头透传给应用页（两边同值，不冲突）。
	if v := rec.header.Get(edge.AppVersionHeader); v != "" {
		c.Header(edge.AppVersionHeader, v)
	}

	c.JSON(http.StatusOK, clientResponseEnvelope{
		Status:    rec.statusCode(),
		Headers:   clientResponseHeaders(rec.header),
		Body:      base64.StdEncoding.EncodeToString(rec.body.Bytes()),
		Truncated: rec.truncated,
	})
}

// validateAppID 的规则真源是 registry（handlers.go 的 validateAppID），本文件直接
// 复用它 —— 见 serveClientRequest。

// clientAppScheme / clientAppOrigin 是本包读取**渠道参数化 scheme** 的唯一入口。
//
// 兜底到 appserver 的默认值（官方取值）：未注入 = 本地最小装配/单元测试，
// 行为与改造前逐字节一致；生产装配必须注入（见 Options.AppScheme/AppOrigin）。
func (h *Handlers) clientAppScheme() string {
	if s := strings.TrimSpace(h.opt.AppScheme); s != "" {
		return s
	}
	return appserver.ClientScheme
}

func (h *Handlers) clientAppOrigin(appID string) string {
	if h.opt.AppOrigin != nil {
		return h.opt.AppOrigin(appID)
	}
	return appserver.PicoaideAppOrigin(appID)
}

// buildClientRequest 把信封还原成一次合成请求。
//
// 合成请求的每个字段都只来自**被校验过的**信封内容：Host（应用 origin 的来源）、
// 方法、路径+原始查询串、白名单头、base64 体。请求上下文沿用 gin 的请求上下文
// （取消/超时随调用方断开而传播到 wasm 执行与 DB）。
func (h *Handlers) buildClientRequest(c *gin.Context, appID string, env clientRequestEnvelope) (*http.Request, *apperr.Error) {
	method := strings.ToUpper(strings.TrimSpace(env.Method))
	if _, ok := clientAllowedMethods[method]; !ok {
		return nil, apperr.New(apperr.CodeValidation, "请求方法不受支持").
			WithDetail("method", env.Method).
			WithHint("方法取 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS 之一")
	}

	host, aerr := h.clientHostFor(appID, env.Host)
	if aerr != nil {
		return nil, aerr
	}

	rawPath := env.Path
	if rawPath == "" || !strings.HasPrefix(rawPath, "/") {
		return nil, apperr.New(apperr.CodeValidation, "path 必须是以 / 开头的相对路径").
			WithDetail("path", clip(rawPath)).
			WithHint("信封里的 path 是浏览器请求的路径部分（不含 scheme/host）；应用入口是 /")
	}
	if len(rawPath) > maxClientPathBytes || hasBadPathBytes(rawPath) {
		return nil, apperr.New(apperr.CodeValidation, "path 非法或过长").
			WithDetail("max_bytes", maxClientPathBytes).
			WithHint("path 不得含控制字符、反斜杠、片段（#）或 .. 段")
	}
	if len(env.Query) > maxClientQueryBytes || strings.ContainsAny(env.Query, "#\r\n\x00") {
		return nil, apperr.New(apperr.CodeValidation, "query 非法或过长").
			WithDetail("max_bytes", maxClientQueryBytes).
			WithHint("query 是**原始**查询串（不含前导 ?）；不得含 # 或控制字符")
	}

	target := rawPath
	if env.Query != "" {
		target += "?" + env.Query
	}
	u, perr := url.Parse(target)
	if perr != nil || u.Scheme != "" || u.Host != "" {
		return nil, apperr.New(apperr.CodeValidation, "path/query 不是合法的相对 URL").
			WithDetail("reason", "parse_failed").
			WithHint("不得在 path 里塞绝对 URL（含 scheme://host）")
	}
	// 合成请求的 scheme/host：客户端模型的自身源是 `<app scheme>://<app_id>`，
	// 因此 URL.Scheme 取**本部署生效的**应用 origin scheme（渠道参数化，见
	// Options.AppScheme；未注入 ⇒ appserver.ClientScheme 的等价行为），
	// Host 只放主机部分（app_id）。appserver 的 selfOrigin 按 (scheme, host)
	// 组装自身源 —— 只允许那一个构造点。
	u.Scheme = h.clientAppScheme()
	u.Host = host

	headers, aerr := clientHeaders(env.Headers)
	if aerr != nil {
		return nil, aerr
	}

	var body []byte
	if env.Body != "" {
		decoded, derr := base64.StdEncoding.DecodeString(env.Body)
		if derr != nil {
			return nil, apperr.New(apperr.CodeValidation, "body 不是合法的 base64").
				WithDetail("field", "body").
				WithHint("body 用标准 base64 编码；空体传空串")
		}
		if int64(len(decoded)) > limits.AppRequestBodyMaxBytes {
			return nil, apperr.New(apperr.CodeBodyTooLarge, "应用 API 请求体超过上限").
				WithDetail("size", len(decoded)).
				WithDetail("max_bytes", limits.AppRequestBodyMaxBytes).
				WithHint("把大请求拆小，或用 db.* 在宿主侧分页处理")
		}
		body = decoded
	}

	req := &http.Request{
		Method:        method,
		URL:           u,
		Host:          host,
		Header:        headers,
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
		// RemoteAddr 是匿名限流（步骤⑥）的输入：如实取平台看到的对端地址，
		// 绝不用信封里的字段（那是调用方自报的）。
		RemoteAddr: c.Request.RemoteAddr,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
	}
	return req.WithContext(c.Request.Context()), nil
}

// readClientEnvelopeBody 按信封上限缓冲请求体。
//
// 为什么先缓冲：`requireProof` 需要知道**应用方法**（幂等与否决定要不要消费 jti），
// 而那个字段在信封体里，且校验顺序要求 proof 早于任何"接受"决定。缓冲 + 宽松窥探
// 同时满足两者；体积上限仍由 maxClientEnvelopeBytes（唯一真源）把关。
func readClientEnvelopeBody(c *gin.Context) ([]byte, *apperr.Error) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxClientEnvelopeBytes)
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, apperr.New(apperr.CodeBodyTooLarge, "请求信封超过上限").
				WithDetail("max_bytes", int64(maxClientEnvelopeBytes)).
				WithHint("应用 API 请求体上限由平台固定；大文件请走能力中心的上传通道")
		}
		return nil, apperr.New(apperr.CodeValidation, "读取请求信封失败").
			WithDetail("reason", "read_failed").
			WithHint("请求体在读取过程中被中断（连接断开/传输错误）")
	}
	return raw, nil
}

// clientHostFor 校验并归一化信封里的 Host。
//
// 唯一允许的形态（app_id 来自**路由**，绝不从 Host 反解，契约 §4.2）：
//
//	picoaide-app://<app_id>   规范形态（app_id 小写，与 registry 同一套归一化规则）
//	<app_id>                  裸标识简写（协议 handler 可以省掉 scheme）
//
// 其它一切形态一律 400 VALIDATION：任意域名/IP、旧草稿的 `<app_id>.app.localhost`、
// 带端口（`picoaide-app://<app_id>:8080`）、带路径/查询/片段/凭据（`…/x`、`…?a=1`、
// `user@…`、末尾斜杠）、大小写不符的 app_id —— 见文件头"为什么 Host 必须逐字符校验"。
//
// 端口被明确拒绝而不是忽略：本模型的 origin 是 `picoaide-app://<app_id>`（**没有端口
// 这一维**），放行端口等于承认两个不同的 origin 都算"自身源"。
//
// 返回值是**规范主机部分**（= app_id）：合成请求的 `URL.Scheme` 另由
// appserver.ClientScheme 给出，`http.Request.Host` 只放主机（不放整个 origin）——
// 自身源由 appserver.selfOrigin 按 scheme + host 组装，只允许有一个构造点。
func (h *Handlers) clientHostFor(appID, raw string) (string, *apperr.Error) {
	host := strings.ToLower(strings.TrimSpace(raw))
	if host == "" {
		return "", apperr.New(apperr.CodeValidation, "缺少 host").
			WithDetail("field", "host").
			WithHint("host 是应用 origin 的规范形态，形如 " + h.clientAppOrigin(appID) +
				"（也可以只写 " + appID + "）")
	}
	if host != appID && host != h.clientAppOrigin(appID) {
		detail := "host 与应用不匹配"
		if strings.ContainsAny(host, "/?#@") || strings.Contains(host, ":") {
			detail = "host 形态非法"
		}
		return "", apperr.New(apperr.CodeValidation, detail).
			WithDetail("host", clip(host)).
			WithDetail("app_id", appID).
			WithHint("host 只接受 " + h.clientAppOrigin(appID) + " 或裸 " + appID +
				"（app_id 来自路由路径；不接受域名、IP、端口、路径、查询、凭据）")
	}
	return appID, nil
}

// clientHeaders 校验并复制白名单请求头。
func clientHeaders(raw map[string]string) (http.Header, *apperr.Error) {
	out := http.Header{}
	if len(raw) > maxClientHeaderCount {
		return nil, apperr.New(apperr.CodeValidation, "请求头条数超过上限").
			WithDetail("count", len(raw)).
			WithDetail("max", maxClientHeaderCount).
			WithHint("本机代理只转发应用用得到的头（见平台文档的头白名单）")
	}
	for name, value := range raw {
		key := strings.ToLower(strings.TrimSpace(name))
		if key == "" || len(key) > maxClientHeaderNameSize {
			return nil, apperr.New(apperr.CodeValidation, "请求头名非法").
				WithDetail("name", clip(name))
		}
		if _, ok := clientRequestHeaders[key]; !ok {
			return nil, apperr.New(apperr.CodeValidation, "请求头不在白名单内").
				WithDetail("name", key).
				WithHint("白名单：" + EnvelopeHeaderHint())
		}
		if len(value) > maxClientHeaderBytes || strings.ContainsAny(value, "\r\n\x00") {
			return nil, apperr.New(apperr.CodeValidation, "请求头值非法或过长").
				WithDetail("name", key).
				WithDetail("max_bytes", maxClientHeaderBytes)
		}
		out.Set(key, value)
	}
	return out, nil
}

// clientResponseHeaders 复制响应头：逐跳头与 `Content-Length` 剔除，
// **`Set-Cookie` 整条丢弃**（契约 §4.2）。
//
// 为什么不只是剥 Domain：自定义协议下 Cookie 语义**完全不可用**（契约 §3 的实测：
// `document.cookie` 恒为空、`Set-Cookie` 不落盘）。把 Cookie 交给一个不会存它的
// 浏览器只会制造"平台以为会话种下了、应用却永远读不到"的假象；而任何形状的
// Set-Cookie 在客户端链路上都是纯攻击面。应用状态请存应用库。
func clientResponseHeaders(src http.Header) http.Header {
	out := http.Header{}
	for name, values := range src {
		key := strings.ToLower(name)
		if hopByHopHeaders[key] || key == "content-length" || key == "set-cookie" {
			continue
		}
		for _, v := range values {
			out.Add(name, v)
		}
	}
	return out
}

// hopByHopHeaders 是 RFC 7230 §6.1 的逐跳头（不经代理转发）。
var hopByHopHeaders = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-authenticate": true,
	"proxy-authorization": true, "te": true, "trailer": true,
	"transfer-encoding": true, "upgrade": true,
}

// hasBadPathBytes 判定 path 里的非法字节：控制字符、反斜杠、片段、`..` 段。
//
// `..` 段一律拒（而不是归一化后放行）：归一化会让"应用看到的路径"与
// "浏览器地址栏里的路径"不一致，而路径是应用路由的一部分。
func hasBadPathBytes(p string) bool {
	if strings.ContainsAny(p, "\\#\x00") {
		return true
	}
	for i := 0; i < len(p); i++ {
		if p[i] < 0x20 || p[i] == 0x7f {
			return true
		}
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// clip 截断用于错误回显的调用方输入（避免把超长/畸形内容原样回显）。
func clip(s string) string {
	const max = 64
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// clientCaptureWriter 是一次应用响应的捕获器（状态 + 头 + 有界响应体）。
//
// 有界的原因：应用响应体的权威上限是 limits.AppResponseBodyMaxBytes，由
// appserver.writeAppResponse 判定（超限整单失败，绝不返回半个响应）。本捕获器是
// **传输层兜底** —— 万一将来某条分支绕过了那个判定，也不能让本机代理收下一个
// 无上限的响应；命中时置 truncated（调用方据此可判"这次响应不可信"）。
type clientCaptureWriter struct {
	header    http.Header
	status    int
	body      bytes.Buffer
	limit     int64
	truncated bool
}

func (w *clientCaptureWriter) Header() http.Header { return w.header }

func (w *clientCaptureWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *clientCaptureWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	room := w.limit - int64(w.body.Len())
	if room <= 0 {
		w.truncated = true
		return len(p), nil
	}
	if int64(len(p)) > room {
		_, _ = w.body.Write(p[:room])
		w.truncated = true
		return len(p), nil
	}
	_, _ = w.body.Write(p)
	return len(p), nil
}

// statusCode 返回捕获到的状态码（未写头即 200 —— 与 net/http 的缺省一致）。
func (w *clientCaptureWriter) statusCode() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

// 确保 *clientCaptureWriter 满足 http.ResponseWriter（编译期断言）。
var _ http.ResponseWriter = (*clientCaptureWriter)(nil)

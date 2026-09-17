package llmgateway

// ---------------------------------------------------------------------------
// 错误上报「发送测试事件」(P0-4,决策 D3:由服务端 Go 代发)
//
// 为什么由服务端代发而不是浏览器直发(PLAN §3.3):
//   - browser 直发会把 DSN 交给浏览器网络栈,还要为第三方放开 CSP
//     `connect-src`(2026-09-11 那次 CSP 放行已经踩过一次);
//   - 浏览器里 DNS/连接/TLS 失败全被 CORS 抹平成 "Failed to fetch",
//     **给不出可读原因**,而 AC3 要求区分 DNS/CONNECT/TLS/TIMEOUT/HTTP_4XX/5XX;
//   - 服务端已有现成范式 `POST /api/server/admin/auth/test` 与统一出站护栏。
//
// **必须写清的局限**(审计一定会打这条,所以自己先说):本结果证明的是
// **服务端视角**的连通性 —— 员工桌面的出口防火墙/DNS/代理可能不同。所以
// 响应体里带 `note` 明确标注,webadmin 文案也必须标注;客户端侧的正面证据
// 由 P1-3 的「客户端上报状态」提供。
//
// 安全说明(防下一轮审计误判 SSRF):这是**管理员显式动作 + PermGatewayWrite
// 权限受控**的出站请求,请求体固定且**不含任何服务端机密**(只有 DSN 里的
// public key,本来就是给客户端用的)。`util.SafeOutboundTransport()` 有意
// **允许私网** —— 内网自建 GlitchTip 是产品主场景;它仍然会拦截链路本地 /
// 云 metadata(DNS rebinding 复检)。
//
// 2026-09-17 独立审计(R1–R6)后的三处收紧与两条明确接受:
//   - R1/R3:失败详情(目标响应体前 300B、含内网 IP 的 dial 错误)**不再回显**给
//     调用方,只进服务端日志 —— 否则管理员可借本端点做内网端口扫描 + 读横幅。
//     返回体保留 kind/http_status/endpoint/elapsed_ms,诊断力不受影响
//     (webadmin 本来也只渲染 message + detail.kind)。
//   - R4:3xx 单列 HTTP_3XX(本客户端不跟随重定向)。
//   - R5:每次自检写一条审计(error_reporting_test),留下"谁在什么时候探测了哪里"。
//   - R2(无频率限制)/R6(代理部署下目标由代理二次解析):**接受**。前者要求
//     super_admin + CSRF 且单次出站有 8s 上限、无放大效应;后者是全部出站共有
//     的环境属性(netguard.go 的代理路径注释已说明),不单独在本端点解决。
// ---------------------------------------------------------------------------

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/x509"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// errorReportingTestTimeout 是测试事件出站请求的总超时。包级变量以便测试
// 调小(超时用例不必真等 8 秒)。
var errorReportingTestTimeout = 8 * time.Second

// errorReportingTestClient 便于测试注入假 transport(永不真发网络请求)。
var errorReportingTestClient = func() *http.Client {
	return &http.Client{
		Timeout:   errorReportingTestTimeout,
		Transport: util.SafeOutboundTransport(),
		// 不跟随重定向:测试事件只需要一次 POST;跟随会把 public key 带到
		// 未经校验的重定向目标(与 netguard 的代理路径复检同源取向)。
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// errorReportingFailureKinds 是 AC3 要求可区分的失败类别。
const (
	ErrorReportingKindDNS     = "DNS"
	ErrorReportingKindConnect = "CONNECT"
	ErrorReportingKindTLS     = "TLS"
	ErrorReportingKindTimeout = "TIMEOUT"
	// ErrorReportingKindHTTP3xx:本端点**不跟随重定向**(见 errorReportingTestClient),
	// 3xx 说明 DSN 指向了会跳转的地址 —— 单列一类,而不是落进"不应出现"的
	// UNKNOWN(2026-09-17 独立审计 R4:此前 302 被归为 UNKNOWN)。
	ErrorReportingKindHTTP3xx = "HTTP_3XX"
	ErrorReportingKindHTTP4xx = "HTTP_4XX"
	ErrorReportingKindHTTP5xx = "HTTP_5XX"
	// ErrorReportingKindUnknown 兜底(不应出现;出现即说明分类漏了一种)。
	ErrorReportingKindUnknown = "UNKNOWN"
)

// errorReportingServerPerspectiveNote 必须在成功与失败响应里都出现。
const errorReportingServerPerspectiveNote = "本结果由服务端发起,证明服务端到上报地址可达;员工客户端的网络环境可能不同"

// classifyErrorReportingFailure 把底层错误映射为 AC3 的六类之一。
func classifyErrorReportingFailure(err error, status int) string {
	if status >= 500 {
		return ErrorReportingKindHTTP5xx
	}
	if status >= 400 {
		return ErrorReportingKindHTTP4xx
	}
	if status >= 300 {
		return ErrorReportingKindHTTP3xx
	}
	if err == nil {
		return ErrorReportingKindUnknown
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrorReportingKindTimeout
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return ErrorReportingKindDNS
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return ErrorReportingKindTimeout
	}
	var certErr *x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	var certInvalid x509.CertificateInvalidError
	if errors.As(err, &certErr) || errors.As(err, &hostErr) || errors.As(err, &certInvalid) {
		return ErrorReportingKindTLS
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "server misbehaving"):
		return ErrorReportingKindDNS
	case strings.Contains(msg, "tls"), strings.Contains(msg, "x509"), strings.Contains(msg, "certificate"):
		return ErrorReportingKindTLS
	case strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "network is unreachable"),
		strings.Contains(msg, "no route to host"),
		strings.Contains(msg, "connection reset"),
		strings.Contains(msg, "connect:"):
		return ErrorReportingKindConnect
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return ErrorReportingKindConnect
	}
	return ErrorReportingKindUnknown
}

// randomEventID 生成 32 位十六进制 event_id(Sentry 协议要求)。
func randomEventID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// 极端情况:退化为时间戳填充,仍然满足 32 hex 形状。
		now := time.Now().UnixNano()
		for i := range buf {
			buf[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(buf)
}

// errorReportingTestResult 是一次代发的结果(成功/失败共用)。
type errorReportingTestResult struct {
	OK         bool
	Kind       string
	Message    string
	HTTPStatus int
	EventID    string
	Endpoint   string
	ElapsedMS  int64
	Detail     string
}

// sendErrorReportingTestEvent 由服务端向 DSN 推导出的 store 端点发一条最小事件。
func sendErrorReportingTestEvent(ctx context.Context, inspection ErrorReportingDSN, release string) errorReportingTestResult {
	eventID := randomEventID()
	body, err := json.Marshal(map[string]any{
		"event_id":  eventID,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"level":     "error",
		"platform":  "other",
		"release":   release,
		"message":   "PicoAide 管理端连通性自检",
		"tags":      map[string]string{"picoaide.source": "webadmin-test-event"},
	})
	if err != nil {
		return errorReportingTestResult{Kind: ErrorReportingKindUnknown, Message: "构造测试事件失败", Detail: err.Error(), Endpoint: inspection.StoreEndpoint}
	}

	reqCtx, cancel := context.WithTimeout(ctx, errorReportingTestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, inspection.StoreEndpoint, bytes.NewReader(body))
	if err != nil {
		return errorReportingTestResult{Kind: ErrorReportingKindUnknown, Message: "构造请求失败", Detail: err.Error(), Endpoint: inspection.StoreEndpoint}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Sentry-Auth", fmt.Sprintf(
		"Sentry sentry_version=7, sentry_key=%s, sentry_client=picoaide-server/%s",
		inspection.PublicKey, release,
	))

	// 保存时不做 DNS 解析(内网域名/离线部署),所以出站前必须复检目标
	// (链路本地/云 metadata 一律拒绝;私网放行)。
	if err := util.CheckOutboundTarget(reqCtx, inspection.Host); err != nil {
		kind := classifyErrorReportingFailure(err, 0)
		return errorReportingTestResult{
			Kind:     kind,
			Message:  errorReportingFailureMessage(kind),
			Detail:   err.Error(),
			Endpoint: inspection.StoreEndpoint,
		}
	}

	started := time.Now()
	resp, err := errorReportingTestClient().Do(req)
	elapsed := time.Since(started).Milliseconds()
	if err != nil {
		kind := classifyErrorReportingFailure(err, 0)
		return errorReportingTestResult{
			Kind:      kind,
			Message:   errorReportingFailureMessage(kind),
			Detail:    err.Error(),
			Endpoint:  inspection.StoreEndpoint,
			ElapsedMS: elapsed,
		}
	}
	defer resp.Body.Close()
	// 读取上限:响应体只用于诊断,不信任其体量。
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		kind := classifyErrorReportingFailure(nil, resp.StatusCode)
		detail := strings.TrimSpace(string(raw))
		if len(detail) > 300 {
			detail = detail[:300]
		}
		return errorReportingTestResult{
			Kind:       kind,
			Message:    fmt.Sprintf("上报服务返回 HTTP %d", resp.StatusCode),
			HTTPStatus: resp.StatusCode,
			Detail:     detail,
			Endpoint:   inspection.StoreEndpoint,
			ElapsedMS:  elapsed,
		}
	}
	// GlitchTip/Sentry 正常返回 {"event_id":"…"};缺失不影响"可达"结论。
	return errorReportingTestResult{
		OK:         true,
		HTTPStatus: resp.StatusCode,
		EventID:    eventID,
		Endpoint:   inspection.StoreEndpoint,
		ElapsedMS:  elapsed,
	}
}

func errorReportingFailureMessage(kind string) string {
	switch kind {
	case ErrorReportingKindDNS:
		return "无法解析上报服务域名(DNS 失败)"
	case ErrorReportingKindConnect:
		return "无法连接上报服务(连接被拒绝/不可达)"
	case ErrorReportingKindTLS:
		return "上报服务的 TLS 证书校验失败"
	case ErrorReportingKindTimeout:
		return fmt.Sprintf("连接上报服务超时(>%s)", errorReportingTestTimeout)
	case ErrorReportingKindHTTP3xx:
		return "上报服务要求重定向(本端点不跟随重定向,请让 DSN 直接指向 store 端点)"
	case ErrorReportingKindHTTP4xx:
		return "上报服务拒绝了测试事件(HTTP 4xx,通常是 DSN 公钥或项目 ID 不对)"
	case ErrorReportingKindHTTP5xx:
		return "上报服务内部错误(HTTP 5xx)"
	}
	return "上报测试事件失败"
}

// testErrorReporting 是 `POST /api/server/admin/gateway/error-reporting/test`
// 的 handler:管理员点一下就知道链路通不通,失败给可读原因(AC3)。
func testErrorReporting(c *gin.Context, db *sql.DB) {
	var req struct {
		DSN *string `json:"dsn"`
	}
	// 请求体可为空(缺省用已保存的 DSN);空体不算错误。
	//
	// SG-3(r3v 复核,2026-09-17)把「字段缺省」的口径写死:`dsn` 是 `*string`,
	// JSON **null 与字段缺省同义** —— 两者都表示"调用方没有给出 DSN",于是都回落
	// 到库里已保存的那条(文档化的例外原样保留:缺省字段 / 空体 = 用已保存的 DSN)。
	// 与 `""` 的不对称是**刻意**的:`""` 是一个显式的、作为 DSN 非法的值(它的
	// 语义只能是"用空 DSN"),静默回落会把另一条 DSN 的结论当成它的结论;
	// 而 JSON null 是"这个可选字段没有值"的标准写法(Go 侧 `*string` 只区分
	// nil/非 nil,区分 null 与缺省需要额外的 RawMessage 解码,换不来产品价值)。
	// 两种形状的结论都由 errorreporting_test_event_test.go 冻结。
	//
	// SG-3(审计 2026-09-17,r2 server-gateway P3):**坏体**必须与空体分开 ——
	// 此前忽略绑定错误,截断 JSON(`{"dsn":`)会被静默丢弃、改用库里**另一条**
	// DSN 发探测并回 200 ok:true,调用方据此判定"我要测的那条通了"(假绿,而
	// 本端点存在的全部意义就是给管理员可信的连通性结论);`{"dsn":123}` 更怪
	// ——encoding/json 对 *string 先分配指针再解码失败,req.DSN 成了"非 nil 的
	// 空串",于是回一条与事实相反的 400「尚未配置错误上报 DSN」。口径与
	// telemetry handler 一致:请求体不是合法 JSON ⇒ 400 VALIDATION。
	if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, io.EOF) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误(需要 JSON 对象,dsn 为可选字符串)")
		return
	}

	raw := ""
	if req.DSN != nil {
		// 显式给出但为空 ≠ 字段缺省:前者是调用方明确要求"用空 DSN",必须报错,
		// 不能悄悄回落到库里的值(否则同样是把另一条 DSN 的结果当成它的结论)。
		raw = *req.DSN
		if strings.TrimSpace(raw) == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "dsn 不能为空(省略该字段才会使用已保存的 DSN)")
			return
		}
	} else if v, _, err := serverstore.GetSetting(db, "web.error_reporting_dsn"); err == nil {
		raw = v
	}
	if strings.TrimSpace(raw) == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "尚未配置错误上报 DSN,无法发送测试事件")
		return
	}
	inspection := InspectErrorReportingDSN(raw)
	if inspection.Rejected() {
		// 保存前校验与测试事件共用同一规则(P0-1 的校验器);不发任何网络请求。
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", inspection.Message)
		return
	}

	release := serverauth.BuildVersion()
	if release == "" {
		release = "dev"
	}
	result := sendErrorReportingTestEvent(c.Request.Context(), inspection, release)
	// R5(审计 2026-09-17):这是"能让服务端向任意管理员指定地址发请求"的动作,
	// 必须留痕(谁、什么时候、探测了哪个主机、结果如何)。
	auditDetail := fmt.Sprintf("endpoint=%s kind=%s", result.Endpoint, result.Kind)
	if result.OK {
		auditDetail = fmt.Sprintf("endpoint=%s ok http=%d", result.Endpoint, result.HTTPStatus)
	}
	_ = serverstore.AuditLog(db, auditActor(c), "error_reporting_test", auditDetail)
	if !result.OK {
		// R1/R3(审计 2026-09-17):原始失败详情(含目标响应体片段与 dial 到的内网
		// IP)**只进服务端日志**,不回显给调用方 —— 否则本端点可被当作内网端口
		// 扫描器 + 横幅读取器。诊断力由 kind/message/http_status/elapsed_ms 承担。
		log.Printf("error-reporting test event failed: kind=%s endpoint=%s status=%d: %s",
			result.Kind, result.Endpoint, result.HTTPStatus, result.Detail)
		detail := gin.H{
			"kind":     result.Kind,
			"endpoint": result.Endpoint,
			"note":     errorReportingServerPerspectiveNote,
		}
		if result.HTTPStatus != 0 {
			detail["http_status"] = result.HTTPStatus
		}
		if result.ElapsedMS > 0 {
			detail["elapsed_ms"] = result.ElapsedMS
		}
		c.JSON(http.StatusBadGateway, gin.H{
			"error":  gin.H{"code": "UPSTREAM", "message": result.Message},
			"detail": detail,
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":          true,
		"event_id":    result.EventID,
		"http_status": result.HTTPStatus,
		"endpoint":    result.Endpoint,
		"elapsed_ms":  result.ElapsedMS,
		// PLAN §3.3 的局限必须在返回体里说清(D3)。
		"note": errorReportingServerPerspectiveNote,
	})
}

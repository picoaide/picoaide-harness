// Package session 实现 WASM 应用平台的**员工浏览器会话**（R16）与**一次性换票**（R12）。
//
// 设计依据（唯一基线 docs/planning/2026-09-17-wasm-app-platform.md）：
//   - §4.7      应用子域会话 = 一次性换票（code 单次、60 s、绑 (user, app)）；
//     Cookie host-only + HttpOnly + Secure（fail-closed）+ SameSite；
//     换票端点 POST + `Origin == 主站源` + `next` 白名单；签发写审计
//   - §6.1      链路①–⑤：子域无 Cookie ⇒ 302 主站换票 ⇒ 302 回子域 ⇒ 兑换 ⇒ 干净 URL
//   - §10.4     第 39/40/41/42/43/46/49 项
//   - §15.1     第 3 条（SameSite=Strict + Origin 自身源）、第 8 条（帧内 user 由宿主构造）、
//     第 12 条（换票端点 POST + Origin + next 白名单）
//   - §13       「员工浏览器会话（R16）不存在（picoaide_session 是管理员专属）」
//
// # 为什么主站要自己再做一个登录页
//
// 员工面此前只有 Bearer（桌面客户端），主站没有任何"浏览器会话"：
// `picoaide_session` 是**管理员专属**（serverauth/admin.go），账密登录只签发
// `api_tokens`。应用子域是浏览器直访的 HTML/JS 宿主，需要一个**浏览器 Cookie 会话**，
// 因此本包负责：注入式登录页（无外部资源）+ 员工会话表（0070）+ 换票端点 +
// 应用子域 Cookie 兑换。密码校验**不重复造**：由 Options.Auth 注入 serverauth 的
// 既有 provider 链（local/LDAP，顺序与客户端面一致）。
//
// # 数值来源
//
// 会话/票的有效期一律取自 `limits`（TicketTTL 60 s / AppSessionTTL 8 h），
// 与全平台"数值单一真源"口径一致。本包只额外定义两类**输入形状**常量
// （next 长度上限 512、表单体上限）——它们是 §4.7 对请求形状的规定，不是平台容量旋钮，
// 且 `limits` 包在本模块被冻结（不得修改）；已在交付说明里标注该边界。
package session

import (
	"database/sql"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// logError 是内部错误的落点（与 clientrelease.logWarn 同形，测试可替换以静音）。
var logError = log.Printf

const (
	// EmployeeCookieName 是主站员工浏览器会话 Cookie 名。
	//
	// **host-only**：绝不设 Domain —— 否则 Cookie 会发往全部应用子域，
	// 且任何子域都能为父域写同名 Cookie（Cookie 注入）；这是 §4.7 与
	// key-memory「主站会话 Cookie 绝不能设 Domain=.基域」的落地。
	EmployeeCookieName = "picoaide_emp"
	// AppCookieName 是应用子域会话 Cookie 名。每个 `<app_id>.<基域>` 各自一份
	// （host-only 天然不共享），因此同一员工在不同应用里有不同会话，
	// 一个应用被下架/吊销不影响另一个（§4.7 / §10.4 第 40 项）。
	AppCookieName = "picoaide_app"

	// MaxNextLen 是换票/登录 `next` 参数的字节上限（§4.7：非法回落 `/`）。
	MaxNextLen = 512
	// maxFormBytes 是登录/换票表单体上限。**数值唯一真源在 limits**（§5.5）：
	// 这里只做别名，不要在别处另写一个数字。
	maxFormBytes = limits.SessionMaxFormBytes
	// maxUsernameLen / maxPasswordLen 与客户端面登录同口径（serverauth/handler.go
	// 的 128/1024）：不能让一个多 MB 的"用户名"打到 provider。
	maxUsernameLen = limits.SessionMaxUsernameBytes
	maxPasswordLen = limits.SessionMaxPasswordBytes
	// tokenBytes 是会话 Cookie 明文的随机字节数（32 ⇒ 64 hex，与换票 code 同量级）。
	tokenBytes = 32
)

// Options 是 Manager 的依赖。
type Options struct {
	// DB 是平台 PostgreSQL 连接（员工/应用会话表见迁移 0070）。
	DB *sql.DB
	// BaseDomain 是应用基域（用于拼 `<app_id>.<BaseDomain>` 换票回跳）。
	//
	// 可带 scheme 前缀：`https://apps.example.com` 或 `http://127.0.0.1:8080`。
	// 不带 scheme 时按 **https** 处理（§4.7「必须拼 https」）；带 scheme 时
	// 以配置为准 —— 明文部署（本地开发/内网 http）只能靠显式写 `http://` 打开，
	// 否则会出现"https 回跳到只有 http 的端口"这种静默失败。
	// 空 = 未启用应用子域（与 edge.HostGate 同语义：此时 /app-ticket 一律 404）。
	BaseDomain string
	// MainOrigin 是主站源（如 `https://harness.example.com`）。
	//
	// 空 = 按请求推导（edge.SelfOrigin）。非空时它同时是**断言**：请求自身的源
	// 必须与之相等，否则拒 —— 因为员工会话 Cookie 是 host-only，换票只能在
	// 签发它的那个源上完成（别名主机上 POST 会被挡，这是有意的 fail-closed）。
	//
	// 比较两侧都过 `edge.NormalizeOrigin`（小写、去尾斜杠、**默认端口省略、
	// 非默认端口保留**）：配置里多写一个 `:443` 不会让断言恒不成立，
	// 而 `https://h:8443` 这种非默认端口部署也不会被误判成跨源（FIX-26）。
	MainOrigin string
	// AppIDExtraReserved 是**部署期注入**的企业既有主机名（§4.1），
	// 与 appserver.Options.AppIDExtraReserved 同源（同一个环境变量：
	// `PICOAI_APPS_EXTRA_RESERVED`）。
	//
	// 换票端点的 `app` 参数与子域路由**必须同一套 app_id 规则**（§4.7 第 3 条），
	// 否则会出现"子域 404、换票却成功"的分叉状态。空 = 该维度校验跳过
	//（安全上仍然成立：其余规则来自 registry 的常量表）。
	AppIDExtraReserved []string
	// Auth 复用 serverauth 的 provider 链（local/LDAP）；由 main.go 注入。
	//
	// 契约：返回 `users` 行的 id。`userID <= 0` 时 Manager 按 username 从
	// `users` 表解析 —— 这样 main.go 只需注入 serverauth.AuthenticatePassword
	// （它返回 UserInfo，不含本地行 id），无需在本模块重复实现"认证 + 建号"。
	Auth func(username, password string) (username2 string, userID int64, err error)
	// Audit 写审计（§4.9）。高频动作（换票签发/兑换、会话吊销）本包**异步**调用
	// （§4.9 明写"高频项 fire-and-forget + 失败计数"），登录/登出同步调用。
	Audit func(username, action, detail string)
	// Now 注入时钟（测试用）；nil = time.Now。
	Now func() time.Time

	// ProductName 是登录页显示的产品名（来自渠道配置）。
	//
	// 空 = 不显示产品名。**故意不设默认值**：AGENTS.md 规定对外文案来自渠道配置，
	// 在代码里硬编码厂商名会让渠道部署显示错误的品牌（2026-09-10 起的既有教训）。
	ProductName string

	// Throttle 是**可选**的登录失败预算（账号级 + 单 IP 级）。
	//
	// ⚠️ 生产部署**必须**注入：员工浏览器登录页是与客户端面 /auth/login
	// **并列的第二个密码入口**，不注入就等于这个入口没有爆破防护
	// （同一份账号密码、同一套 provider，防护却只覆盖另一个入口）。
	// main.go 注入的是 serverauth 的三个导出方法，两处入口共享同一份预算。
	//
	// nil = 不限流（仅用于测试；生产装配见 cmd/server/wasmapp.go）。
	Throttle LoginThrottle

	// OnAppSessionRevoked 可选：某应用子域会话被吊销时回调（key = 应用会话 id 的
	// 十进制字符串，与 Manager.SessionKey 同值）。main.go 用它调
	// aichat.Client.RevokeSession 丢掉该会话在内存里的在手令牌。
	//
	// nil = 不回调：**DB 层吊销不受影响**（§10.4 第 46 项在 SQL 层就已成立），
	// 只是 aichat 的内存令牌要等自然过期（≤ limits.AITokenTTL）。
	OnAppSessionRevoked func(appSessionKey string)
}

// LoginThrottle 是登录失败预算的三个动作（由 serverauth 提供实现）。
type LoginThrottle interface {
	// Allow 返回本次尝试是否在预算内；false ⇒ 调用方回 429 且**不**做认证。
	Allow(username, host string) bool
	// Failure 记一次失败（用户名或密码错、账号不可用等）。
	Failure(username, host string)
	// Success 认证成功后清空预算。
	Success(username, host string)
}

// Employee 是主站员工浏览器会话解析出的身份。
type Employee struct {
	// ID 是 users.id。
	ID int64
	// SessionID 是 employee_sessions.id。
	SessionID   int64
	Username    string
	DisplayName string
	Dept        string
	ExpiresAt   time.Time
}

// Manager 持有员工会话与换票的全部状态。
//
// 并发安全：DB 由 sql.DB 保证；票务状态在 ticketStore 内用互斥量保护。
// R20（单实例部署）允许票务用内存态 —— 多副本会让"票在 A 签发、B 兑换"静默失败，
// 因此启动自检由 main.go 负责（§15.1 第 9 条），本包不引入外部存储。
type Manager struct {
	opt     Options
	now     func() time.Time
	tickets *ticketStore
}

// New 构造 Manager。DB 为 nil 时只有纯函数路径可用（测试与形状校验），
// 会话相关的处理函数会返回 500 —— 不 panic，避免一个装配遗漏变成启动崩溃。
func New(opt Options) *Manager {
	m := &Manager{opt: opt, now: opt.Now, tickets: newTicketStore()}
	if m.now == nil {
		m.now = time.Now
	}
	return m
}

// --- 与请求相关的判定：全部按请求解析，绝不在模块级冻结 ---

// secureRequest 判定本次请求是否 https（Cookie 的 Secure fail-closed 判据）。
//
// 复用 edge.SelfOrigin 的 scheme 判定（TLS → X-Forwarded-Proto → http），
// 保证与"应用子域自身源"完全同一套口径（§15.1 第 3 条）。
// 非 https 时本包**不签发任何 Cookie**（§10.4 第 49 项）：宁可让登录页报错，
// 也不静默下发一个可被明文网络嗅探的会话。
func (m *Manager) secureRequest(r *http.Request) bool {
	return strings.HasPrefix(edge.SelfOrigin(r), "https://")
}

// mainOrigin 返回本次请求应当满足的"主站源"。
//
// 配置值走 `edge.NormalizeOrigin`（默认端口省略、非默认端口保留），与请求侧
// `edge.SelfOrigin` 完全同一套规范化 —— 否则 `MainOrigin=https://h:443` 会让
// 后面那条"请求源必须等于配置"的断言恒不成立（永久 403，FIX-26）。
func (m *Manager) mainOrigin(r *http.Request) string {
	if s := strings.TrimSpace(m.opt.MainOrigin); s != "" {
		if norm := edge.NormalizeOrigin(s); norm != "" {
			return norm
		}
		// 配置写了但解析不出源（例如漏了 scheme）：按请求推导，并且下面
		// checkMainOrigin 会用原始配置做一次 fail-closed 断言 + 日志。
		return edge.SelfOrigin(r)
	}
	return edge.SelfOrigin(r)
}

// configuredMainOrigin 返回规范化后的配置主站源（空 = 未配置或解析不出）。
func (m *Manager) configuredMainOrigin() string {
	return edge.NormalizeOrigin(m.opt.MainOrigin)
}

// checkMainOrigin 校验非幂等请求来自主站自身（§4.7 / §15.1 第 12 条）。
//
// 语义与 edge.CheckOrigin 一致（Origin 必须等于自身源；缺失时用 Referer 前缀兜底；
// 两者都缺 ⇒ 拒），差别只有一处：期望的源可由配置固定（MainOrigin），并且在
// MainOrigin 非空时**额外断言请求自身的源等于它**。
//
// ⚠️ 部署提醒（口径已定，写在这里避免踩）：MainOrigin 一旦配置就是**严格断言** ——
// 若站点可通过多个主机名访问（反代别名/内外双域名），别名主机上的登录与换票会被
// 403 挡住（员工会话 Cookie 是 host-only，别名主机本来也没有那份 Cookie）。
// 多域名部署请**留空 MainOrigin**，让本函数按请求推导主站源（每个主机名各自一份
// 浏览器会话，这正是 host-only 的语义）。断言失败会落一条日志，便于当场定位。
//
// 为什么不用一次性 token：本端点由主站自己的页面同源 POST 发起，Origin/Referer
// 是浏览器强制写入、页面脚本无法伪造的字段；而一次性 token 需要额外的服务端状态
// 与页面注入，收益为零（攻击者若能读页面就已有 XSS，token 也一并泄露）。
// §4.7 对换票端点本身就是这个要求（"POST + Origin == 主站源"）。
func (m *Manager) checkMainOrigin(r *http.Request) bool {
	want := m.mainOrigin(r)
	if want == "" {
		return false
	}
	if cfg := m.configuredMainOrigin(); cfg != "" {
		if self := edge.SelfOrigin(r); !strings.EqualFold(self, cfg) {
			logError("pico-wasm-session: 请求源 %s 与配置的 MainOrigin %s 不一致，已拒绝"+
				"（多域名/别名部署请留空 MainOrigin 以按请求推导）", self, cfg)
			return false
		}
	}
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		// 与"自身源"同一套规范化（默认端口省略、非默认端口保留）后再比：
		// 浏览器在非默认端口上发的 Origin 带端口，两侧都规范化才不会把同源判成跨源。
		// 先过一次形态闸：Origin 必须是**源**，带路径/query/userinfo 或 "null"
		// （sandboxed iframe / data: 文档）一律拒 —— 不能靠"截到源再比"来猜。
		if !edge.IsOriginShaped(origin) {
			return false
		}
		norm := edge.NormalizeOrigin(origin)
		if norm == "" {
			return false
		}
		return strings.EqualFold(norm, want)
	}
	ref := strings.TrimSpace(r.Header.Get("Referer"))
	if ref == "" {
		return false
	}
	low := strings.ToLower(ref)
	return strings.HasPrefix(low, want+"/") || strings.EqualFold(strings.TrimSuffix(low, "/"), want)
}

// sanitizeNext 把 `next` 规范化成**同基域相对路径**，非法一律回落 `/`（§4.7 原话）。
//
// 确切规则（两道：先校验原串，再校验"一次百分号解码后"的串，任一不过即回落 `/`）：
//
//  1. 非空、长度 ≤ MaxNextLen、必须以 `/` 开头；
//  2. 不含 `//`（挡协议相对形态 `//evil.com`）；
//  3. 不含 `\`（浏览器把 `\` 当 `/` 处理 ⇒ `/\evil.com` 等价于 `//evil.com`）；
//  4. 不含 `:`（挡 `https://evil.com`、`javascript:`、`data:` 等一切带 scheme 的形态）；
//  5. 不含 `#`（fragment 会让我们拼的 `ticket=` 落到片段里而失效）；
//  6. 不含控制字符（< 0x20、0x7F）—— CR/LF 就是响应头注入（Location 拆分）；
//     原串里还额外禁止**字面空格**（URL 里不该出现裸空格），但 `%20` 解码出的空格
//     是允许的：最终 Location 用的是原串，空格只以 `%20` 出现在线路上。
//  7. 一次解码必须成功，且解码后的串同样满足 1–6（此处放宽"字面空格"一条）。
//
// 明确决定的容忍度（逐条写清，避免日后被"顺手放宽"）：
//   - `//evil.com`、`https://evil.com`、`javascript:`、`/\evil.com` ⇒ **拒**（回落 `/`）；
//   - `/%2F%2Fevil.com` ⇒ 解码后 `//evil.com` ⇒ **拒**；
//   - `/a?x=//evil.com` ⇒ 原串含 `//` ⇒ **拒**。我们**不**把 query 拆出来单独判定：
//     `//` 出现在 query 里本身不会造成本层的重定向，但"路径 + query 一起白名单"
//     是唯一好解释、好测、不随下游解析器差异漂移的口径；代价只是应用不能把含
//     `//`/`:` 的 URL 直接放进 next（应自行改用其它承载方式）。
//   - **二次编码（`%252F%252F…`）放行**：我们只解码一次做校验，**绝不用解码后的值
//     构造 Location**（Location 一律由原串拼出），所以二次编码在本层不可能改变目标
//     主机；下游若自己再解码一次，那是应用在自己源上的行为。
//   - `/a/b?x=1`、`/dash%20board`（一次编码）⇒ 正常放行（登录跳转会把 next 嵌进
//     /login 的 query，必须容忍一次编码，否则带转义的应用路径会在登录后被丢掉）。
//
// 合法返回值只可能是"以 `/` 开头、无 `//`、无 `:`、无 `\`、无 `#`、无控制字符"的短串，
// 因此把它拼在 `https://<app>.<基域>` 之后**不可能**改变目标主机。
func sanitizeNext(raw string) string {
	if !validNext(raw, true) {
		return "/"
	}
	dec, err := url.PathUnescape(raw)
	if err != nil || !validNext(dec, false) {
		return "/"
	}
	return raw
}

// validNext 是 sanitizeNext 的单串判定（原串与一次解码后的串共用同一份规则；
// literal=true 表示这是**原串**，连字面空格也拒）。
func validNext(s string, literal bool) bool {
	if s == "" || len(s) > MaxNextLen || s[0] != '/' {
		return false
	}
	if strings.Contains(s, "//") || strings.ContainsAny(s, "\\:#") {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x20 || c == 0x7f {
			return false
		}
		if literal && c == ' ' {
			return false
		}
	}
	return true
}

// sanitizeAppID 是**外部传入** app_id 的唯一入口（域名标签，§4.1 + §10.5 第 52/53 项）：
// 校验通过返回原串，否则返回空串（调用方按 404 处理）。
//
// 规则唯一真源是 registry：`CheckAppIDShape`（大小写敏感：只允许小写字母/数字/
// 单连字符 + 长度闸，顺带挡住空白与控制字符）→ `ValidateAppID`（纯数字 / `xn--` /
// 保留字 / 部署期注入的企业既有主机名）。
//
// 为什么**不**做"小写/去空白"的宽容归一化（与旧实现的关键差别）：
//
//	宽容化会把 `REAL-APP`、`app:8443`、`a.b.example.com` 这类形态**静默改写成另一个
//	app_id**，而调用方随后用"未归一化的原串"做跳转/比对 —— 结果是一张绑错应用的票、
//	一个 404 的死链，或者连 `url.Parse` 都失败的 `Location`。这些都是"看起来成功、
//	实际永远到不了"的失败形态，比直接拒绝危险得多。
//
// 服务端自己解析出来的主机标签（HostGate 已保证形态）不走本函数，见 lookupAppID。
func sanitizeAppID(raw string) string {
	if registry.CheckAppIDShape(raw) != nil || registry.ValidateAppID(raw, nil) != nil {
		return ""
	}
	return raw
}

// lookupAppID 校验**服务端解析出来**的 app 标识（HostGate 的第一级标签、
// appserver 逐请求传入的 appID）：先剥端口/尾部点等主机名杂质、按域名规则小写，
// 再过同一套业务规则（保留字、企业既有主机名）。
//
// 与 sanitizeAppID 共用同一个 registry：**业务规则只有一份**，
// 两条入口不可能漂移出不同答案。
func (m *Manager) lookupAppID(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if i := strings.IndexByte(s, ':'); i >= 0 {
		// 主机名形态（`<app>.<基域>:8443`）：端口与域名标签无关，剥掉。
		s = s[:i]
	}
	s = strings.TrimSuffix(s, ".")
	if registry.ValidateAppID(s, m.opt.AppIDExtraReserved) != nil {
		return "", false
	}
	return s, true
}

// ParseBaseDomain 把 Options.BaseDomain 拆成 (scheme, host)。
// 空串 ⇒ ("", "")，表示未启用应用子域。
func ParseBaseDomain(raw string) (scheme, host string) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", ""
	}
	scheme = "https" // §4.7：必须拼 https；只有显式写 scheme 才能改成 http。
	if i := strings.Index(s, "://"); i >= 0 {
		if sc := strings.ToLower(s[:i]); sc == "http" || sc == "https" {
			scheme = sc
		}
		s = s[i+3:]
	}
	s = strings.TrimSuffix(s, "/")
	s = strings.ToLower(strings.TrimSuffix(s, "."))
	return scheme, s
}

// AppOrigin 返回某应用的源（`scheme://<app_id>.<基域>`）。空 = 未启用应用子域。
func (m *Manager) AppOrigin(appID string) string {
	scheme, host := ParseBaseDomain(m.opt.BaseDomain)
	if scheme == "" || host == "" || appID == "" {
		return ""
	}
	return scheme + "://" + appID + "." + host
}

// --- 审计 ---

// audit 同步写审计（登录/登出这类低频动作）。
func (m *Manager) audit(username, action, detail string) {
	if m.opt.Audit == nil {
		return
	}
	m.callAudit(username, action, detail)
}

// auditAsync 异步写审计（§4.9：换票签发/兑换、会话吊销属于高频项，
// 必须 fire-and-forget —— 审计写路径最坏 25 s，同步会拖死换票链路）。
func (m *Manager) auditAsync(username, action, detail string) {
	if m.opt.Audit == nil {
		return
	}
	go m.callAudit(username, action, detail)
}

// callAudit 是审计回调的**唯一调用点**，负责 panic 隔离。
//
// 为什么审计崩了不能让请求崩：注入的回调由 main.go 提供（生产是
// serverstore.AuditLog，不会 panic），但"审计异常不得阻断认证"是与既有代码一致的
// 语义（serverauth 全程 `_ = serverstore.AuditLog(...)`）。若不隔离，异步
// goroutine 里的 panic 会直接终止整个进程。
// 代价（认账）：回调 panic 时该条审计丢失，只留一条 error 日志。
func (m *Manager) callAudit(username, action, detail string) {
	defer func() {
		if rec := recover(); rec != nil {
			logError("pico-wasm-session: audit callback panicked (action=%s): %v", action, rec)
		}
	}()
	m.opt.Audit(username, action, detail)
}

// notifyAppSessionRevoked 通知外部（aichat 内存令牌）某应用会话已失效。
func (m *Manager) notifyAppSessionRevoked(key string) {
	if m.opt.OnAppSessionRevoked == nil || key == "" {
		return
	}
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				logError("pico-wasm-session: OnAppSessionRevoked panicked: %v", rec)
			}
		}()
		m.opt.OnAppSessionRevoked(key)
	}()
}

// clientIP 取请求来源 IP（仅审计/会话列表用，不参与鉴权）。
func clientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	return host
}

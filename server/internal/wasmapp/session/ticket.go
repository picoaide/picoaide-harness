package session

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===== 一次性换票（§4.7 换票端点 + §6.1 链路①–⑤）=====
//
// 为什么是「GET 渲染确认页 → 同源 POST → 同源跳板页」这三步（本模块最容易看不懂的一处）：
//
//	应用子域发现没有有效 Cookie 时，只能对浏览器下发 **302**（§6.1 ①），
//	而浏览器跟随 302 只能用 **GET** —— 它无法替页面发一个 POST。
//	可 §4.7 又硬性要求换票端点是 **POST + `Origin == 主站源`**（防登录 CSRF）：
//	GET 换票等于任何第三方页面用 <img>/<iframe>/<a> 就能替受害者换出一张票。
//	两者靠"主站自己的一个页面"接上：GET /app-ticket 只渲染一个**自动提交的表单**
//	（不签发任何东西），由这个页面发起对 /app-ticket 的 POST —— 此时浏览器写入的
//	Origin 就是主站源本身（同源表单提交），既满足 §4.7，又不给第三方页面任何入口。
//
//	第三步是**跨源那一跳**：POST 成功后要把浏览器送到应用子域，但换票页的 CSP 是
//	`form-action 'self'`，而 CSP3 会检查重定向链上的每一个 URL ⇒ 用 `302` 直接跳跨源
//	会被浏览器整单拦下（服务端连 POST 都收不到，2026-09-19 线上 P0）。
//	因此 POST 返回的是**同源跳板页**，跨源导航由页面自己完成（脚本/meta/链接，见
//	ticketRedirectTmpl 的长注释）—— **表单始终只提交到同源，CSP 无需放宽**。
//
// 一句话：**GET 把浏览器带到主站，POST 在"确有主站源"的前提下签发票，
// 跳板页把票交给应用子域。**

// ticket 是一次性换票的载荷：绑 (user, app)，不绑具体路径 ——
// next 只是"换完票回哪儿"，与凭据本身无关。
type ticket struct {
	userID            int64
	appID             string
	employeeSessionID int64
	expiresAt         time.Time
	// nonce 是**签发这张票的那次 POST** 同时写进浏览器 Cookie 的随机值
	// （Cookie 名 = `TicketNonceCookieName + "_" + code 摘要`，见 ticketNonceCookieNameFor：
	// 每张在途票各持一份，互不覆盖）。兑换时必须逐字节匹配 —— 这是"票 + 浏览器"的绑定
	// （R1-sec-1）：票在 URL 里，任何拿到 URL 的浏览器都能把 code 交上来，但只有
	// **签发那一刻确实收到了这张票**的浏览器才持有 nonce。
	//
	// 空串是一个**明确的降级标记**：本部署被显式声明"无法下发 nonce"（配置的对外地址与
	// 应用基域不同域，且**内嵌方**在装配时打开了 Go 字段 Options.AllowTicketWithoutNonce
	// —— 运维面没有这个开关，见 ticketNonceRemedyAlignOrigin）—— 这张票只剩
	// Sec-Fetch 判据，每次签发/兑换都会 ERROR 留痕；**兑换侧对空 nonce 默认一律拒**
	// （见 RedeemTicket），因此这种票只在显式降级部署里可兑换。
	nonce string
}

// ticketSweepInterval 是过期票清理的时间节流（见 ticketStore.issue）。
const ticketSweepInterval = 5 * time.Second

// ticketStore 是票务的内存态。
//
// R20（单实例部署）明确允许内存态：多副本会让"票在 A 签发、B 兑换"静默失败，
// 因此单实例的启动自检由 main.go 负责（§15.1 第 9 条），本包不引入外部存储。
//
// 容量上界 = 签发速率 × limits.TicketTTL（60 s）—— 每次签发顺带清理过期条目
// （按 ticketSweepInterval 节流，避免 O(n²)），不额外引入"最多 N 张票"这种旋钮。
// 且签发本身要求有效员工会话，匿名请求拿不到票。
type ticketStore struct {
	mu        sync.Mutex
	m         map[string]ticket
	lastSweep time.Time
}

func newTicketStore() *ticketStore { return &ticketStore{m: map[string]ticket{}} }

func (s *ticketStore) issue(code string, t ticket, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.Sub(s.lastSweep) >= ticketSweepInterval {
		for k, v := range s.m {
			if !now.Before(v.expiresAt) {
				delete(s.m, k)
			}
		}
		s.lastSweep = now
	}
	s.m[code] = t
}

// consume 是**单次消费的 CAS**：在锁内完成"取 → 校验 → 删"，因此同一个 code 的
// 并发兑换只有一个 goroutine 能看到条目并成功返回（其余拿到 ok=false）。
//
// 跨应用（t.appID != appID）**不消费**：票绑 (user, app)（§10.4 第 40 项），
// 但错误的 app 不应该有权把票烧掉 —— 否则任何能看到 code 的人（例如通过
// Referer 泄漏拿到它）都能让合法用户的跳转失败，而他什么也得不到。
// 不消费的语义仍然安全：不匹配的 appID 永远无法通过这一关。
func (s *ticketStore) consume(code, appID string, now time.Time) (ticket, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.m[code]
	if !ok {
		return ticket{}, false
	}
	if !now.Before(t.expiresAt) {
		delete(s.m, code)
		return ticket{}, false
	}
	if t.appID != appID {
		return ticket{}, false
	}
	delete(s.m, code)
	return t, true
}

// len 返回在途票数（测试/诊断用）。
func (s *ticketStore) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// TicketPage 渲染换票确认页（GET /app-ticket）。
//
// **只渲染表单，不签发任何东西**：不查库、不下发 Cookie、不发 code。
// 唯一的形态校验是 app_id 合法性（空/超长/非法字符/保留字直接 404），避免把一个
// 明显无意义的表单渲染给用户；"应用是否存在"留给 POST（登录后）判定，这样未登录
// 用户无法用这个 GET 探测应用是否存在。
//
// 校验规则与 POST **完全同一份**（sanitizeAppID + registry.ValidateAppID）：
// 两条入口给出不同答案会让攻击者用 GET 探测出"哪些形态会被 POST 接受"。
func (m *Manager) TicketPage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writePage(w, http.StatusMethodNotAllowed, loginHTML(localeOf(r), loginView{
			Error: copyFor(localeOf(r)).ErrMethod, ShowForm: false,
		}))
		return
	}
	lang := localeOf(r)
	if _, host := ParseBaseDomain(m.baseDomain()); host == "" {
		// 未启用应用子域（与 edge.HostGate 同语义：BaseDomain 为空 ⇒ 无应用）
		edge.WriteAppNotFound(w, r, "")
		return
	}
	appID := sanitizeAppID(r.URL.Query().Get("app"))
	if appID == "" {
		edge.WriteAppNotFound(w, r, "")
		return
	}
	writePage(w, http.StatusOK, ticketHTML(lang, ticketView{
		Title:   m.ticketTitle(lang),
		Product: strings.TrimSpace(m.opt.ProductName),
		App:     appID,
		Next:    sanitizeNext(r.URL.Query().Get("next")),
	}))
}

// TicketSubmit 签发票并返回**同源跳板页**（POST /app-ticket）。
//
// 校验顺序（§4.7，任一不满足即拒）：
//  0. **必须 https**（fail-closed：明文下换出的票永远兑换不出来，见下方注释）；
//  1. `Origin == 主站源`（缺失时用 `Referer` 前缀兜底；两者都缺 ⇒ 拒）；
//  2. 必须有有效员工会话（未登录 ⇒ 302 `/login?next=…`，登录后自动回到这里）；
//  3. `app` 必须**先过形态与业务规则校验**（sanitizeAppID + registry.ValidateAppID，
//     与子域路由同一套规则），再过"存在且 kind=wasm_app 且未删除"的库查找
//     （用 §4.8 主机名反查**同一个** serverstore 函数 ⇒ 查不到就 404，
//     且与子域路由同口径，不泄露是否存在）；
//  4. `next` 必须是同基域相对路径（sanitizeNext，非法回落 `/`）。
//
// 通过后：32 字节 crypto/rand 的 code（hex）、TTL limits.TicketTTL（60 s）、
// 内存态单次消费、绑 (user, app)、异步写审计，然后 **200 + 跳板页**，
// 由页面把浏览器送到 `<scheme>://<app_id>.<基域><next>?ticket=<code>`。
//
// 同时下发 **nonce Cookie**（R1-sec-1，2026-09-19）：票因此是"URL 里的 code +
// 浏览器 Cookie 里的 nonce"两半，nonce 值随票存进票记录，兑换时必须匹配
// （见 RedeemTicket）。**这是"主站 → 应用子域"这条合法链路能成立的关键**：
// nonce 的 Domain 写成应用基域，浏览器在跳板页导航到 `<app>.<基域>` 时会自动带上它
// —— 而任何"把链接发给别人"的路径都不会带上（对方的浏览器没有这个 Cookie）。
// Cookie 名带本票 code 的摘要（ticketNonceCookieNameFor）⇒ **多张在途票各持一份**，
// 同一浏览器同时开两个应用时先签发的那张照样能兑换（2026-09-19 第二轮审计 §1.4 / P3）。
//
// ⚠️ **能不能下发 nonce 由服务端配置决定，且请求方改不了**（R1-sec-1 回归审计 P0）：
// 判定见 ticketNonceDecision（只看 Options.MainOriginResolver/BaseDomain，**绝不看 r.Host**）。
// 对外地址未配置 ⇒ 按应用基域推导主站源并照常下发（现网形态，功能不受影响，info 留痕）；
// 对外地址配成与基域不同域 ⇒ 500 + ERROR 日志 + 审计（fail-closed）；只有**内嵌方**在
// 装配时显式打开 Go 字段 `Options.AllowTicketWithoutNonce` 才允许签"没有 nonce"的票
// （运维没有这个配置面 ⇒ 对运维而言**唯一**实际可做的动作是把对外地址配成与应用基域同域，
// 见 ticketNonceRemedyAlignOrigin）。**部署约束**：要拿到完整
// 防护，对外地址必须与应用基域同域（唯一实际可用形态，理由见 ticketNonceDecision）；
// 管理端配置基域时未校验这一点（见报告 §未覆盖 U-1）。
//
// ⚠️ 两条残留（不假装解决，详见报告 temp/wasm-review-r1/fix-sec1b.md）：
//   - **地址栏粘贴**：那是"浏览器发起、无 initiator"的顶层导航（`Sec-Fetch-Site: none`），
//     Strict Cookie 照样会发送、Sec-Fetch 也区分不出 ⇒ 该形态只能靠 nonce 挡；nonce
//     不可用时（显式降级部署）这条路径仍然可通。
//   - **兄弟应用可伪造 Domain Cookie**：应用子域能跑作者自己的 JS，见本文件下方 nonce 段落。
//
// ⚠️ 为什么不是 302（2026-09-19 线上 P0，真实 Chromium 复现）：
//
//	CSP3 的 `form-action` 不只管"提交到哪"，它**遍历整个重定向链上的每一个 URL**
//	（Chromium 实测：同源 302 放行、跨源 302 被拦）。本页的 POST 是同源 `/app-ticket`，
//	而签发后要落到**跨源**的应用子域 —— 于是 `302` 让浏览器把这次提交整体拦掉：
//	`Sending form data to 'https://<基域>/app-ticket' violates "form-action 'self'"`
//	服务端**从未收到那次 POST**，用户停在换票页。跳板页把跨源那一跳从"表单提交的一部分"
//	变成"页面自己发起的顶层导航"（`location.replace` / meta refresh / 链接），
//	三者都不受 `form-action` 约束 —— 因此**不需要**放宽 CSP（`form-action 'self'` 原样保留：
//	表单永远只提交到同源 `/app-ticket`）。
//
// HTTP 语义变化（要认账）：旧实现是 302，POST/Redirect/GET 天然成立；现在 POST 返回 200 页面，
// 因此**刷新会重复提交**（多签一张票、多一条 `app_ticket_issue` 审计）。影响已被压到最小：
// `writePage` 的 `Cache-Control: no-store` + 跳板页的 `location.replace` 让这一页几乎不会
// 成为"用户手动刷新"的对象；重复签发也不构成安全问题 —— 每张票仍是一次性、60 s、绑 (user, app)，
// 且 POST 本身要求有效员工会话 + 同源 Origin（第三方页面无法替用户触发）。
// 因此这里**不引入**额外的"已签发集合/防重放"（那会新增一份带 TTL 的状态，却不改变任何安全属性）。
func (m *Manager) TicketSubmit(w http.ResponseWriter, r *http.Request) {
	// 未启用应用子域（BaseDomain 为空）⇒ 换票端点与 TicketPage 同语义：**不存在**。
	//
	// 必须放在**最前面**（先于任何 writePage）：writePage 会先把 Content-Type 定成
	// text/html，之后即使 edge.WriteAppNotFound 写的是 JSON 信封，客户端拿到的也是
	// HTML 头 + JSON 体。也正因为"先写了 HTML 头"，主站的 404 与子域的 404 会变成
	// 同一份字节（审计探针的"逐字节相同 ⇒ 回落主站"判据因此误报）。
	// 与 appserver 的 `mainOrigin == ""` 分支同一口径：功能未启用时明确 404，
	// 而不是假装走到了应用查找。
	// baseHost 是应用基域的主机名（`<app_id>.<baseHost>` 就是应用子域）。后面签发 nonce
	// Cookie 时还要用它（Domain 属性必须写它，见 ticketNonceCookie），所以这里
	// 解析一次而不是丢弃。
	_, baseHost := ParseBaseDomain(m.baseDomain())
	if baseHost == "" {
		edge.WriteAppNotFound(w, r, "")
		return
	}
	lang := localeOf(r)
	if r.Method != http.MethodPost {
		writePage(w, http.StatusMethodNotAllowed, loginHTML(lang, loginView{
			Error: copyFor(lang).ErrMethod, ShowForm: false,
		}))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		writePage(w, http.StatusBadRequest, loginHTML(lang, loginView{
			Error: copyFor(lang).ErrForbidden, ShowForm: false,
		}))
		return
	}
	// app 先过**形态与业务规则**（§4.1 + §10.5 第 52/53 项，规则唯一真源 = registry）。
	//
	// 为什么必须拒而不是"宽容归一化"：`real-app.evil.example.com` 会让库反查把
	// 第一级标签当成 real-app 而**命中真应用**，于是签出一张绑 `real-app` 的票、
	// 却把用户 302 到 `real-app.evil.example.com.<基域>`（HostGate 一律 404）——
	// 用户拿到死链，那张票也永远兑换不了；`real-app:8443` 更直接让 Location
	// 连 url.Parse 都失败（`invalid port ":8443.apps.example.com" after host`）。
	// 非法参数一律与子域同口径 404（不签发、不重定向）。
	appID := sanitizeAppID(r.PostFormValue("app"))
	if appID == "" {
		edge.WriteAppNotFound(w, r, appID)
		return
	}
	// next 先净化（纯函数，不产生拒绝）：非法一律 `/`，且绝不因为 next 非法而拒整单 ——
	// 这正是 §4.7 的"非法回落 /"。
	next := sanitizeNext(r.PostFormValue("next"))

	// 0) 必须 https。明文连接下换出的票**永远兑换不出来**（RedeemTicket 是 fail-closed：
	// 非 https 不签发 Secure Cookie），照常 302 只会让用户"换票 → 兑换失败 → 再换票"
	// 地空转一圈（浏览器最终报重定向过多）。所以这里直接给可读错误，不静默 302 ——
	// 与 appserver 的 RequiresLogin 分支同一口径。
	if !m.secureRequest(r) {
		m.renderLogin(w, r, http.StatusForbidden, loginView{
			Insecure: true,
			ShowForm: false,
		})
		return
	}

	// 1) Origin / Referer 必须是主站源。
	if !m.checkMainOrigin(r) {
		// 与 LoginSubmit 同一条修复（2026-09-19 P0）：来源校验失败**仍然渲染
		// 登录表单**。这是用户投诉"根本没有地方输入账号密码"的**第一现场** ——
		// 换票页加载即自动提交本 POST，被拒后旧实现只给一行报错、没有任何输入框。
		// next 指回换票端点：用户重新输入账号密码后会自动把换票流程走完，
		// 而不是停在这一页。
		writePage(w, http.StatusForbidden, loginHTML(lang, loginView{
			Error:    copyFor(lang).ErrOriginRejected,
			Next:     ticketLoginNext(appID, next),
			ShowForm: true,
		}))
		return
	}

	// 2) 必须先有有效员工会话。
	emp, ok := m.CurrentEmployee(r)
	if !ok {
		m.redirectToLogin(w, r, appID, next)
		return
	}

	// 3) 应用必须存在（kind=wasm_app 且未软删）—— 查不到就 404，与 §4.8 主机名反查同口径。
	if !m.appExists(r.Context(), appID) {
		edge.WriteAppNotFound(w, r, appID)
		return
	}

	// 4) next 已净化。签发票。
	//
	// 票是**两半**：URL 里的 code（给应用子域）与浏览器 Cookie 里的 nonce（给"是不是
	// 签发那一刻的那只浏览器"）。两半都匹配才兑换 —— 只有 code 的链接（转发/粘贴/钓鱼）
	// 换不出会话（R1-sec-1）。nonce 必须与票**同一次响应**下发、同寿命、同一次性。
	//
	// ⚠️ "能不能下发 nonce"是**部署级**判定、只读服务端配置（ticketNonceDecision），
	// 绝不看 r.Host —— 否则任何别名主机名都能把这道闸门按请求关掉（回归审计 P0）。
	decision := m.ticketNonceDecision()
	if decision.Plan != ticketNonceRequired && !m.opt.AllowTicketWithoutNonce {
		// fail-closed：宁可不签发票，也不签一张"没有浏览器持有性证明"的票。
		// 这是**运维可定位的配置故障**，不是用户错误 —— 日志说清配哪里，审计留痕。
		m.refuseTicketNonce(w, r, lang, emp.Username, appID, decision)
		return
	}
	code, err := newSecret()
	if err != nil {
		writePage(w, http.StatusInternalServerError, loginHTML(lang, loginView{
			Error: copyFor(lang).ErrInternal, ShowForm: false,
		}))
		return
	}
	now := m.now()
	nonce := ""
	if decision.Plan == ticketNonceRequired {
		nonce, err = newSecret()
		if err != nil {
			writePage(w, http.StatusInternalServerError, loginHTML(lang, loginView{
				Error: copyFor(lang).ErrInternal, ShowForm: false,
			}))
			return
		}
		// 防御性 fail-loud（判定层已保证可写，这里是"序列化那一刻"的兜底）：
		// Cookie 的 Domain 一旦写不出去，net/http 会**静默省略**该属性 ⇒ Cookie 退化成
		// host-only ⇒ 子域兑换恒失败、零 ERROR 零审计（2026-09-19 第二轮审计 §1.2 的
		// "静默死"）。宁可 500 + ERROR + 审计，也不发一张注定兑换不了的票。
		if !cookieDomainWritable(decision.CookieDomain) {
			m.refuseTicketNonce(w, r, lang, emp.Username, appID, ticketNonceDecision{
				Plan:       ticketNonceUnavailable,
				MainOrigin: decision.MainOrigin,
				Derived:    decision.Derived,
				Reason:     "cookie_domain_not_writable:" + decision.CookieDomain,
				Remedy:     decision.Remedy,
			})
			return
		}
		// ⚠️ Cookie 名**必须带这张票的 code 摘要**（2026-09-19 第二轮审计 §1.4 / P3）：
		// 固定名 + `Domain=基域` + `Path=/` 的 Cookie 在浏览器里是**基域级唯一**一份，
		// 同一浏览器同时开两个应用（应用中心中键连开）时后一次签发会覆盖前一份 ⇒
		// **先签发的那张票必然兑换失败**、被烧掉，用户被弹回换票页重来一轮，审计里
		// 还留下一条与攻击同形的 `rejected=nonce_mismatch`。带上摘要后每张在途票各持
		// 一份，互不覆盖（见 ticketNonceCookieNameFor）。
		http.SetCookie(w, ticketNonceCookie(ticketNonceCookieNameFor(code), decision.CookieDomain, nonce, now.Add(limits.TicketTTL)))
		// 固定名的那一条**同时**下发，作为兑换侧的**回退**读取口（见 ticketNonceVerdict）：
		// 它只兜住"只有固定名 Cookie"的既有形态（例如内嵌装配的集成链路），兑换时
		// 仍然逐字节比对**本票的** nonce —— 因此它不构成跨票放行，也不再是唯一来源。
		http.SetCookie(w, ticketNonceCookie(TicketNonceCookieName, decision.CookieDomain, nonce, now.Add(limits.TicketTTL)))
	} else {
		// 显式降级（内嵌方打开了 Go 字段 AllowTicketWithoutNonce）：本部署已被明确声明
		// "无法下发 nonce"，这张票只剩 Sec-Fetch 判据。必须每次留痕（ERROR），否则
		// "这台部署为什么挡不住伪造链接"在日志里查不到。运维侧**不能**开关这个形态 ——
		// 不想承担该风险就把对外地址配成与应用基域同域。
		logError("pico-wasm-session: 本部署（内嵌装配）显式允许**无 nonce** 的换票（AllowTicketWithoutNonce，运维面无开关）⇒ "+
			"该票只受 Sec-Fetch 判据保护 app=%s main_origin=%q base_domain=%q reason=%s %s",
			appID, decision.MainOrigin, m.baseDomain(), decision.Reason, edge.OriginDiagFields(r))
	}
	m.tickets.issue(code, ticket{
		userID:            emp.ID,
		appID:             appID,
		employeeSessionID: emp.SessionID,
		expiresAt:         now.Add(limits.TicketTTL),
		nonce:             nonce,
	}, now)
	m.touchEmployeeSession(r.Context(), emp.SessionID, now)
	// §4.9：换票签发是高频项 ⇒ 异步审计（审计写路径最坏 25 s）。
	if decision.Plan == ticketNonceRequired {
		m.auditAsync(emp.Username, "app_ticket_issue", "app="+appID+" ip="+clientIP(r))
	} else {
		m.auditAsync(emp.Username, "app_ticket_issue", "app="+appID+" nonce=disabled(configured) ip="+clientIP(r))
	}

	// 目标 URL 只有这一份拼接实现（appTicketURL）—— 跳板页、测试与将来的诊断都读它，
	// 绝不在页面里再拼一遍（两处拼接必然漂移）。
	writePage(w, http.StatusOK, RedirectPage(lang, RedirectTicketIssued,
		m.appTicketURL(appID, next, code), m.ticketTitle(lang), strings.TrimSpace(m.opt.ProductName)))
}

// redirectToLogin 把未登录的用户送到登录页，并记住"登录后回到 /app-ticket"。
//
// 嵌套编码说明：/login 的 next 必须是一个同基域相对路径，而我们要回到的是
// `/app-ticket?app=X&next=Y` —— 因此对 app 与 next 各做一次 QueryEscape 再整体
// 作为 /login 的 next。sanitizeNext 只解码一次做校验，正好还原这一层
// （多一层编码会因为还原出 `%`/控制字符而被拒，见 sanitizeNext 的容忍度说明）。
func (m *Manager) redirectToLogin(w http.ResponseWriter, r *http.Request, appID, next string) {
	http.Redirect(w, r, "/login?next="+url.QueryEscape(ticketLoginNext(appID, next)), http.StatusFound)
}

// ticketLoginNext 拼"登录后回到换票端点"的 next 值（同基域相对路径）。
//
// 只有一处实现：redirectToLogin（未登录 302）与 TicketSubmit 的来源校验失败页
// （渲染登录表单，让用户当场重试）必须给出**逐字节相同**的回跳目标 ——
// 两处各写一遍就会出现"302 能回到换票、表单重试却回到首页"的分叉。
func ticketLoginNext(appID, next string) string {
	return "/app-ticket?app=" + url.QueryEscape(appID) + "&next=" + url.QueryEscape(next)
}

// appTicketURL 拼换票回跳地址（§4.7：「302 到 https://<app_id>.<BaseDomain><next>?ticket=…」）。
//
// scheme：BaseDomain 显式带 scheme 时以其为准（明文部署只能这样打开），
// 否则**必须是 https**（§4.7 原话"必须拼 https"）。
//
// ticket 参数放在原 query **之前**：若 next 自己带了 `ticket=…`，
// 浏览器/服务端取第一个值，先出现的才是我们签发的那张（避免应用读到自己的旧值）。
func (m *Manager) appTicketURL(appID, next, code string) string {
	origin := m.AppOrigin(appID)
	if origin == "" {
		return "/"
	}
	path, query, _ := strings.Cut(next, "?")
	out := origin + path + "?ticket=" + code
	if query != "" {
		out += "&" + query
	}
	return out
}

// ===== 应用子域侧（供 appserver 调用）=====

// Identity 是应用子域一次请求解析出的身份与会话键。
//
// CurrentUser / SessionKey 是它的两个投影；appserver 一次 Resolve 即可拿到两者，
// 避免同一请求查两遍库。
type Identity struct {
	User *abi.User
	// SessionKey 是应用会话键（= app_sessions.id 的十进制串）。
	SessionKey string
}

// Resolve 读应用子域 Cookie 并解析身份（nil = 未登录/会话失效）。
//
// appID 来自**服务端解析出的主机标签**（HostGate 已保证形态），因此走 lookupAppID：
// 剥端口/尾部点后过同一套业务规则（保留字/企业既有主机名），与换票端点同一个校验入口。
func (m *Manager) Resolve(r *http.Request, appID string) (*Identity, bool) {
	if r == nil {
		return nil, false
	}
	appID, ok := m.lookupAppID(appID)
	if !ok {
		return nil, false
	}
	c, err := r.Cookie(AppCookieName)
	if err != nil || c.Value == "" {
		return nil, false
	}
	id, err := m.resolveAppSession(r.Context(), c.Value, appID, m.now())
	if err != nil {
		return nil, false
	}
	return &Identity{
		User: &abi.User{
			ID:          id.UserID,
			Username:    id.Username,
			DisplayName: id.DisplayName,
			Dept:        id.Dept,
			IsPublisher: id.IsPublisher,
		},
		SessionKey: appSessionKey(id.SessionID),
	}, true
}

// CurrentUser 读应用子域 Cookie 返回**帧内身份**（nil = 未登录/会话失效）。
//
// 身份只有这一条来源（§15.1 第 8 条）：帧由宿主构造，应用无法伪造 ——
// 应用既读不到 Cookie（HttpOnly）也拿不到任何可用于调平台的凭证（红线 3）。
func (m *Manager) CurrentUser(r *http.Request, appID string) *abi.User {
	id, ok := m.Resolve(r, appID)
	if !ok {
		return nil
	}
	return id.User
}

// SessionKey 返回应用会话键（供 aichat 的令牌按会话吊销用）。
//
// 返回值是 app_sessions.id 的十进制串 —— 与 aichat 的约定一致
// （aichat.WithSessionKey(ctx, appSession.ID)）；它不是秘密，只是内存令牌表的键。
func (m *Manager) SessionKey(r *http.Request, appID string) string {
	id, ok := m.Resolve(r, appID)
	if !ok {
		return ""
	}
	return id.SessionKey
}

// appSessionKey 是应用会话 id → 会话键的唯一转换点（SessionKey 与吊销回调共用）。
func appSessionKey(id int64) string { return strconv.FormatInt(id, 10) }

// RedeemTicket 处理 `?ticket=<code>`（§6.1 ④）：成功则设 Cookie 并返回应重定向到的干净 URL。
//
// 调用方（appserver）在每次请求进入时调用它：返回 ok 时应当 302 到 cleanURL；
// 返回 !ok 时按"未登录"继续走正常流程（RequiresLogin ⇒ 302 主站换票）。
//
// 逐请求校验（§10.4 第 40 项）：
//   - code 必须存在、未过期、且**绑定的 app_id 等于当前子域的 appID** ——
//     跨应用兑换一律拒（ticketStore.consume 在锁内比对，不消费不匹配的票）；
//   - **必须 https**（§10.4 第 49 项 fail-closed）：明文连接下不签发应用 Cookie，
//     直接按未登录处理；
//   - **票必须带 nonce（浏览器持有性证明）且与票记录逐字节匹配**（R1-sec-1）：
//     按**本票专属 Cookie 名**（code 摘要派生）读取，固定名那条只作回退
//     （ticketNonceCookieNames）⇒ 多张在途票互不干扰；无论从哪条读到，值都必须等于
//     **本票的** nonce（跨票 nonce ⇒ `rejected=nonce_mismatch`）。
//     `t.nonce == ""` 的票**默认一律拒**（回归审计 P0 的修法 1：那种票只剩 Sec-Fetch
//     判据，而 Sec-Fetch 挡不住地址栏粘贴与缺席头）—— 只有部署方显式配置
//     `Options.AllowTicketWithoutNonce` 才放行，且每次都要 ERROR 日志 + 审计
//     （该字段是 Go 字段、运维面无配置面；对运维而言唯一可做的动作是把对外地址配成
//     与应用基域同域，见 ticketNonceRemedyAlignOrigin）。
//     缺 Cookie / 不匹配 ⇒ 拒，**绝不签发应用会话 Cookie**；票照旧一次性烧掉
//     （否则一张已知的 code 可以被反复拿来探测 nonce）；
//   - **Sec-Fetch-\* 纵深**（`Sec-Fetch-Site ∈ {same-site, same-origin, none}` 且
//     `Sec-Fetch-Mode: navigate`）：头存在且不符 ⇒ 拒；头缺席（老浏览器/非浏览器
//     客户端）⇒ **按现状放行但留日志**（不能把老浏览器一刀切）。
//   - 员工会话必须仍然有效 —— 由 insertAppSession 的 `WHERE EXISTS` 在 SQL 层
//     原子校验（签发到兑换之间有 ≤60 s 窗口，期间可能已登出，§10.4 第 46 项）。
//
// 成功后 302 回**去掉 ticket 参数的干净 URL**（由调用方执行跳转）——
// 否则票据会留在地址栏、浏览器历史与后续请求的 Referer 里。
//
// ⚠️ 认账（不假装解决）：
//   - nonce 只证明"是同一只浏览器"，不证明"是同一个人"—— 共享机器上无人值守的
//     已登录浏览器、或整个浏览器 profile 被复制，都不在防护面内；
//   - **同基域的兄弟应用可以伪造这个 Cookie**（机制与前提见文件下方 nonce 段落的长注释）；
//   - 地址栏粘贴（`Sec-Fetch-Site: none`）无法与合法场景区分 —— 挡住它的只有 nonce，
//     而 nonce 只在"签发那一刻的那只浏览器"里；
//   - nonce Cookie 被浏览器拒收（用户禁用 Cookie / 部署域不匹配的降级票）会让
//     **合法链路**在"子域兑换失败 ⇒ 回主站换票 ⇒ 再兑换失败"之间来回，直到浏览器报
//     重定向过多；这是 fail-closed 的代价，见报告 temp/wasm-review-r1/fix-sec1.md。
func (m *Manager) RedeemTicket(w http.ResponseWriter, r *http.Request, appID string) (cleanURL string, ok bool) {
	if r == nil {
		return "", false
	}
	// appID 来自主机名标签（HostGate 已校验形态）⇒ 走 lookupAppID（与 Resolve 同一入口）。
	appID, valid := m.lookupAppID(appID)
	if !valid {
		return "", false
	}
	code := r.URL.Query().Get("ticket")
	if code == "" {
		return "", false
	}
	clean := stripTicketParam(r)
	now := m.now()
	t, ok := m.tickets.consume(code, appID, now)
	if !ok {
		return "", false
	}
	// ⚠️ 从这里往下的**每一次拒绝都发生在 consume 之后** ⇒ 票已经被烧掉。
	// 这是有意的（一次性语义无条件优先）：一张已知的 code 不能被反复拿来探测 nonce。
	if !m.secureRequest(r) {
		// fail-closed：非 https 不签发。⚠️ 票**仍然被消费**（一次性语义无条件优先）——
		// 这张票刚刚在明文线路上传过（它就在 URL 里），任何看到它的人都能重放；
		// 烧掉它是唯一安全的处理，代价是明文部署下换票会失败（该部署本来就不该
		// 启用应用子域）。调用方按未登录处理。
		m.auditAsync("", "app_ticket_redeem", "app="+appID+" rejected=insecure")
		return "", false
	}

	// ===== 浏览器持有性证明（nonce Cookie，R1-sec-1）=====
	// 票在 URL 里 ⇒ 任何拿到 URL 的浏览器都能把 code 交上来；nonce 只在"签发那一刻
	// 确实收到这张票"的浏览器里。
	//
	// ⚠️ nonce 为空的票**默认一律拒**（R1-sec-1 回归审计 P0 的修法 1）：那种票意味着
	// "这张票没有任何浏览器持有性证明"，只有 Sec-Fetch 判据 —— 而 Sec-Fetch 挡不住
	// 地址栏粘贴（`Site: none`）与缺席头。历史票、以及任何我们没预料到的签发路径，
	// 都必须在这里被 fail-closed 挡住，而不是"因为签发侧没给 nonce 就放行"。
	// 唯一的例外是部署方在**内嵌装配**里显式打开 AllowTicketWithoutNonce（Go 字段，
	// 运维面没有这个开关；此时必须 ERROR 留痕 + 审计）。
	if t.nonce == "" {
		if !m.opt.AllowTicketWithoutNonce {
			m.auditAsync("", "app_ticket_redeem", "app="+appID+" rejected=nonce_unbound")
			logWarn("pico-wasm-session: 换票兑换被拒：票上没有 nonce（无浏览器持有性证明）app=%s %s "+
				"⇒ 这是 fail-closed 的默认行为。票上没有 nonce 只可能来自内嵌方显式打开 "+
				"Options.AllowTicketWithoutNonce；正常部署走的是'签发侧直接拒绝签发票 + ERROR'，"+
				"运维可做的动作是 %s", appID, edge.OriginDiagFields(r), ticketNonceRemedyAlignOrigin)
			return "", false
		}
		// 显式降级：只保留 Sec-Fetch 判据，且每次都要 ERROR 级留痕 + 审计。
		m.auditAsync("", "app_ticket_redeem", "app="+appID+" nonce_unbound=allowed_by_config")
		logError("pico-wasm-session: 本部署显式允许**无 nonce** 的换票（AllowTicketWithoutNonce）⇒ "+
			"本次兑换只受 Sec-Fetch 判据保护 app=%s %s", appID, edge.OriginDiagFields(r))
	} else if v, why := ticketNonceVerdict(r, code, t.nonce); v != 1 {
		// v == 0：Cookie 缺失/为空；v == -1：值不匹配。
		m.auditAsync("", "app_ticket_redeem", "app="+appID+" rejected=nonce_"+why)
		logWarn("pico-wasm-session: 换票兑换被 nonce 判据拒绝 reason=%s app=%s %s",
			why, appID, edge.OriginDiagFields(r))
		return "", false
	}

	// ===== Sec-Fetch-* 纵深（§4.8 的浏览器元数据判据）=====
	allow, reason, detail := ticketSecFetchVerdict(r)
	if !allow {
		m.auditAsync("", "app_ticket_redeem", "app="+appID+" rejected=sec_fetch_"+reason)
		logWarn("pico-wasm-session: 换票兑换被 Sec-Fetch 判据拒绝 reason=%s app=%s %s %s",
			reason, appID, detail, edge.OriginDiagFields(r))
		return "", false
	}
	if reason != "" {
		// 头缺席 ⇒ 放行（老浏览器），但必须留痕：这是"这台机器为什么没被挡住"的现场。
		logWarn("pico-wasm-session: 换票兑换缺少 Sec-Fetch-* 头（放行）app=%s nonce_bound=%t %s",
			appID, t.nonce != "", detail)
	}

	raw, err := newSecret()
	if err != nil {
		logError("pico-wasm-session: app session secret: %v", err)
		return "", false
	}
	if err := m.insertAppSession(r.Context(), t.employeeSessionID, t.userID, appID, raw, now, now.Add(limits.AppSessionTTL)); err != nil {
		// ErrSessionNotFound = 员工会话在换票期间失效（登出/禁用）——
		// 这正是 §10.4 第 46 项要保证的：登出后票也换不出会话。
		logError("pico-wasm-session: redeem app session: %v", err)
		return "", false
	}
	http.SetCookie(w, appCookie(raw, now.Add(limits.AppSessionTTL)))
	m.auditAsync("", "app_ticket_redeem", "app="+appID+" user_id="+strconv.FormatInt(t.userID, 10)+" ip="+clientIP(r))
	return clean, true
}

// stripTicketParam 返回去掉 `ticket` 参数后的相对 URL（保留其余参数）。
//
// 只用 path + query，**不带 scheme/host**：调用方在同源上跳转，避免把绝对 URL
// 交给上游的"要不要跳、跳到哪"的判断（少一个可被误用的输入）。
func stripTicketParam(r *http.Request) string {
	q := r.URL.Query()
	q.Del("ticket")
	if len(q) == 0 {
		return r.URL.Path
	}
	return r.URL.Path + "?" + q.Encode()
}

// appCookie 构造应用子域会话 Cookie。
//
// 与员工 Cookie 的差别只有 SameSite：应用子域用 **Strict**（§15.1 第 3 条）——
// `<a>.<基域>` 与 `<b>.<基域>` 同站，Lax 挡不住跨源写（表单 + text/plain 免预检），
// 因此应用子域的 Cookie 连"跨站导航顺带带上"都不允许。
// host-only（不设 Domain）⇒ 每个 `<app_id>.<基域>` 各自一份，天然不共享。
func appCookie(raw string, expires time.Time) *http.Cookie {
	return &http.Cookie{
		Name:     AppCookieName,
		Value:    raw,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   true,
		MaxAge:   int(limits.AppSessionTTL.Seconds()),
		Expires:  expires,
	}
}

// ===== 换票的浏览器持有性证明（nonce Cookie，R1-sec-1 / 2026-09-19）=====
//
// 攻击形态（真机复现，见报告 temp/wasm-review-r1/fix-sec1.md）：任一登录员工
// `POST /app-ticket` 拿到 `https://<app>.<基域>/?ticket=<64hex>`，把这条链接发给受害者；
// 受害者在**全新 cookie jar**（无任何 Cookie）里 GET 它 ⇒ 302 + `Set-Cookie: picoaide_app=…`，
// 此后帧内身份 = **攻击者**（受害者的一切输入都落在攻击者账号下）。
// 根因：兑换只校验了"票存在/未过期/单次/绑 (user,app)/https"，**不看请求来自哪只浏览器**。
//
// 修法是给票加"第二半"：签发时同时写一个 nonce Cookie（Domain=应用基域 ⇒ 应用子域也收得到），
// 值存进票记录；兑换时必须携带且匹配。它是一个**持有性证明**，不是新的凭证体系：
//   - 单独持有它换不出任何东西（没有 code 就没有票记录可比对）；
//   - 寿命与票一致（limits.TicketTTL）、一次性（票一烧，nonce 就没有比对对象）。
//
// 三个刻意的取舍（写在这里，避免日后被"顺手放宽"）：
//   - **SameSite 必须 Strict，绝不能 Lax**：Lax 会随**跨站顶层 GET 导航**发送，
//     而"点开别人发来的链接"正是攻击形态本身；
//   - **HttpOnly**：应用子域是本平台上的任意 HTML/JS 宿主（R8），HttpOnly 除了不让
//     应用读到，还拦住它用 document.cookie **覆盖**同名 Cookie（RFC 6265 §5.3 第 11.2 步）；
//   - **每张票一份 Cookie（名字带 code 摘要）**：固定名 + 基域 Domain 的 Cookie 是
//     基域级唯一一份，两张在途票会互相覆盖 ⇒ 先签发的那张必然兑换失败（2026-09-19
//     第二轮审计 §1.4 / P3，见 ticketNonceCookieNameFor）。固定名的那一条仍然下发，
//     但只作为兑换侧的**回退**读取口（见 ticketNonceCookieNames）；
//   - **不设 Expires 之外的清除逻辑**：nonce 只对自己的那张票有效，票一烧即失效；
//     每份专属 Cookie 的寿命就是票的寿命（60 s），因此在途 Cookie 数量有界，不需要
//     在兑换成功后额外清 Cookie（多一条 Set-Cookie 只会让"兑换响应里到底有没有
//     会话 Cookie"这件事更难读）。
//
// ⚠️ **第三条残留（本次修复挡不住，如实认账；推理自 RFC 6265 + 本平台 CSP，未真机复现）**：
// 兄弟应用可以**伪造**这个 Cookie。nonce 的 Domain 是应用基域，而 `<app>.<基域>` 上的
// 页面能跑应用作者自己的 JS（`script-src 'self' 'unsafe-inline'`、`text/html` 在允许集合内）
// ⇒ 攻击者应用页面的 `document.cookie = "…; Domain=<基域>; Path=/; Secure; SameSite=Strict"`
// 是合法的。于是攻击者可以：①签发一张**自己的**票拿到 code+nonce；②引导受害者在
// **自己的应用页**上把这条 nonce 写进浏览器；③再导航到 `<受害应用>/?ticket=code`。
// 该导航是**同站**的（`Sec-Fetch-Site: same-site`），与主站跳板页那一跳**无法区分** ⇒
// 会话固定照样成立。HttpOnly 只挡住"覆盖已存在的那条"（同上第 11.2 步），挡不住
// "在没有旧 Cookie 时新建"（旧 Cookie 的寿命只有 limits.TicketTTL，等 60 s 即可）。
// 每票一份 Cookie 的命名**不改变**这条残留：攻击者知道自己那张票的 code，因此也能算出
// 对应的专属名。前提是受害者**先加载一个同基域下攻击者可控的页面**（任一员工可发布
// wasm 应用；审核开关会再加一道门），因此本修复把攻击从"发一条链接"抬到"两步 + 一次
// 页面加载"，但没有在协议层消除它 —— 详见报告 temp/wasm-review-r1/fix-sec1.md 的残留清单。
//
// ⚠️ **"降级"不是请求方可以选的东西**（R1-sec-1 回归审计 P0，2026-09-19 二次修复）：
// 初版把"能否下发 nonce"判在 `r.Host` 上，于是任何别名主机名（IP 直连/旧域名/反代域名/
// 渠道第二域名 —— edge.HostGate 把它们一律判成 HostMain，主站路由照常服务）都能让这道闸门
// **按请求关掉**：别名 Host 上签发成功但不带 nonce，受害者在全新 cookie jar 里照样兑换成功。
// 现在的形态（两轮加固后的完整口径）：
//   - **判定只读服务端配置**（ticketNonceDecision），绝不看 r.Host；
//   - 对外地址**未配置** ⇒ 按**应用基域**推导主站源（配置事实，与 edge.MatchHost 的
//     「基域主机 == 主站」模型一致）⇒ 照常下发 nonce（info 日志说明推导）；
//   - 对外地址**配成与基域不同域** ⇒ 签发侧**拒绝签发票**（fail-closed + ERROR + 审计）；
//   - 兑换侧对 nonce 为空的票**一律拒**（regression：这正是被审计打穿的那条路）；
//   - 只有**内嵌方**在装配时显式配置 `Options.AllowTicketWithoutNonce`（Go 字段，
//     运维面没有开关）才存在"只靠 Sec-Fetch 判据"的降级形态，且每次签发/兑换都留
//     ERROR 日志与审计。
//   - **归一化两侧同一形状**（normalizeHostOnly：小写、去尾点、剥端口）并且只有在
//     Cookie Domain 真的写得出去（cookieDomainWritable）时才签发票 —— 否则
//     fail-loud（500 + ERROR + 审计），绝不静默退化成 host-only（那会让兑换恒失败却
//     零信号，2026-09-19 第二轮审计 §1.2）。

// publicBaseURLEnvName 是"服务端对外地址"的环境变量名（与 clientrelease.PublicBaseURLEnv 同值）。
//
// 只用于**错误文案**（让运维一眼知道去配哪里），不参与解析 —— 解析由装配方注入的
// Options.MainOriginResolver 完成（本包不 import clientrelease，避免把下载面拖进会话面）。
const publicBaseURLEnvName = "PICOAI_PUBLIC_BASE_URL"

// ticketNoncePlan 是"这张票能不能带 nonce"的**部署级**判定结果。
type ticketNoncePlan int

const (
	// ticketNonceUnavailable：本部署**无法**下发 nonce Cookie（配置的主站源与基域不匹配，
	// 或基域本身写不出 Cookie Domain）⇒ 签发侧 fail-closed 拒绝签发票（除非**内嵌方**
	// 显式 AllowTicketWithoutNonce），兑换侧对 nonce 为空的票一律拒。
	ticketNonceUnavailable ticketNoncePlan = iota
	// ticketNonceRequired：主站源 domain-match 基域 ⇒ 必须下发 nonce。
	ticketNonceRequired
)

// ticketNonceDecision 是一次判定的完整结果（判定 + 依据），便于日志/审计/测试观察。
type ticketNonceDecision struct {
	// Plan 是判定结论（required / unavailable）。
	Plan ticketNoncePlan
	// CookieDomain 是 Plan==required 时 Cookie 的 Domain 属性（= 应用基域主机名，
	// **不带端口**：归一化见 normalizeHostOnly）。
	CookieDomain string
	// MainOrigin 是本次判定依据的**主站源**（配置值，或按应用基域推导出来的值）。
	MainOrigin string
	// Derived 表示 MainOrigin 是**按应用基域推导**的（对外地址未配置/不可解析）。
	Derived bool
	// Reason 是 Plan==unavailable 时的原因（进日志与审计）。
	Reason string
	// Remedy 是 Plan==unavailable 时给运维的**可执行动作**（进 ERROR 日志）。
	//
	// 唯一真源是 ticketNonceRemedy* 常量：文案纪律是"只准写运维真的能做的动作"，
	// 绝不写"去打开 session.Options.AllowTicketWithoutNonce"（Go 字段，运维没有配置面
	// —— 2026-09-19 第二轮审计 §1.3）。由 ticketNonceRemedy 用例钉住。
	Remedy string
}

// ticketNonceRemedyAlignOrigin 是"对外地址与基域不同域"的可执行动作（唯一真源）。
//
// 为什么写成常量而不是内联进日志：① 文案纪律要被测试钉住（ticket_nonce_test.go 的
// 文案用例：只能指向运维可做的动作，不得指向 Go 字段）；② 页面文案（pages.go）与日志
// 文案必须说同一件事，否则运维在日志与页面之间看到两种说法。
const ticketNonceRemedyAlignOrigin = "把服务端对外地址配成与应用基域**同域**：控制台设置 " +
	"server.base_url 或环境变量 " + publicBaseURLEnvName + " 写成 https://<应用基域> 本身" +
	"（应用子域是 <app_id>.<应用基域>，同一张通配证书覆盖）；若这个部署无法把主站搬到应用基域上，" +
	"就只能停用应用子域（把 PICOAI_APPS_BASE_DOMAIN 留空，应用不可访问）——" +
	"平台**没有**\"允许无 nonce 换票\"的运维开关（env / settings / 控制台里都不存在这个配置项）"

// ticketNonceRemedyBaseDomain 是"应用基域本身写不出 Cookie Domain"的可执行动作。
const ticketNonceRemedyBaseDomain = "换一个能承载 Cookie 的应用基域（普通 DNS 名：字母/数字/连字符/点，" +
	"端口会被忽略；**不能**是 IP 地址，也不能含下划线），并让服务端对外地址与该基域同域" +
	"（控制台 server.base_url / " + publicBaseURLEnvName + "）"

// refuseTicketNonce 是"无法为本部署下发 nonce Cookie"的**唯一出口**：
// 审计 + ERROR 日志（含可执行动作）+ 可读页面（500）。
//
// 为什么抽成函数：判定层（ticketNonceDecision）与序列化层（Set-Cookie 之前）两处都要
// 走它，而"其中一处忘了写审计/日志"正是这类 fail-closed 分支最常见的退化形态。
func (m *Manager) refuseTicketNonce(w http.ResponseWriter, r *http.Request, lang, username, appID string, decision ticketNonceDecision) {
	remedy := decision.Remedy
	if remedy == "" {
		remedy = ticketNonceRemedyAlignOrigin
	}
	m.auditAsync(username, "app_ticket_issue", "app="+appID+" rejected=nonce_unavailable ip="+clientIP(r))
	logError("pico-wasm-session: 拒绝签发换票：无法为本部署下发 nonce Cookie（换票的浏览器持有性证明）。"+
		"main_origin=%q base_domain=%q reason=%s %s ⇒ %s",
		decision.MainOrigin, m.baseDomain(), decision.Reason, edge.OriginDiagFields(r), remedy)
	writePage(w, http.StatusInternalServerError, loginHTML(lang, loginView{
		Error: copyFor(lang).ErrTicketNonceUnavailable, ShowForm: false,
	}))
}

// ticketNonceDecision 判定本部署能否下发换票 nonce Cookie。
//
// ⚠️ **输入只有服务端配置**（Options.MainOriginResolver / Options.MainOrigin 与
// Options.BaseDomain），**绝不看 r.Host**。这是 R1-sec-1 回归审计 P0 的修法 2：
// 请求 Host 是攻击者可选的（任何别名主机名都被 edge.HostGate 判成 HostMain，
// 主站路由含 /app-ticket 照常服务），若拿它当判定输入，攻击者就能"用自己的 Host
// 把 nonce 闸门按请求关掉"（实测：别名 Host 签出的票 nonce 为空，受害者在全新
// cookie jar 里照样兑换成功 —— 与修复前的 P0 同一个形态）。
//
// 归一化（R2-2，2026-09-19 第二轮审计 §1.2）：两侧（应用基域 / 对外地址的主机名）
// 都过 **normalizeHostOnly**（小写、去尾点、**剥端口**）再比较 —— 旧实现里基域只做
// normalizeDomain（不剥端口），对外地址走 originHost（剥端口），于是**同一个值**
// `harness.example.com:8443` 被判成"两个不同的域"（登录可见应用一律 500，文案却让
// 管理员去检查一个本来就对的配置）；而 derive 出的 Domain 带端口会被 net/http 静默
// 省略（Cookie 退化成 host-only）⇒ 子域兑换恒失败、零 ERROR 零审计（静默死）。
// Cookie 的 Domain 属性本来就不允许端口（RFC 6265 §4.1.1 的 domain-value 是 host）。
//
// 判定规则（Cookie 的 Domain 必须 domain-match **响应所在主机**，RFC 6265 §5.3 第 6 步，
// 否则浏览器静默丢弃这条 Set-Cookie）：
//  1. 应用基域未配置 ⇒ unavailable（调用方在此之前已 404，本分支只为完备）；
//     1b. 应用基域归一后**写不出可用的 Cookie Domain**（IP 字面量 / 含下划线的主机名 /
//     非法字符）⇒ unavailable ⇒ 签发侧拒绝签发票 + ERROR + 审计。**不降级成 host-only**：
//     那正是"票恒兑换不了却零信号"的形态；
//  2. **对外地址未配置/不可解析** ⇒ 按**应用基域**推导主站源（`<scheme>://<基域>`）
//     ⇒ required，Cookie Domain = 基域主机名。这不是"降级"，而是把配置里**已经存在**的
//     那份事实固定下来：平台的主站模型就是"基域主机 == 主站"（`edge.MatchHost` 对 `h == b`
//     判 HostMain，appserver.mainOriginNow 也返回 `scheme://基域`）。
//     代价：推导值不再来自请求，因此别名主机名上签出的票**带 nonce 却存不进那个主机**
//     （浏览器拒收 Domain Cookie）⇒ 不可兑换（fail-closed），而不是"按请求降级"。
//     推导生效时打一条 info 日志（每个 Manager 一次），点名建议显式配置对外地址；
//  3. 配置的主站 Host == 基域，或是基域的**子域**（`x.<基域>`）⇒ required，Cookie Domain = 基域。
//     注意方向：RFC 6265 要求 **响应所在主机** domain-match **Domain 属性**，所以主站必须是
//     基域本身或其子域，**祖先域不行**；而基域的一级子域又会被 edge.HostGate 判成应用子域
//     （主站路由不注册在那里）⇒ 实际可用形态只有"主站 Host == 应用基域"这一种；
//  4. 其余（配置的主站源与基域不同域）⇒ unavailable ⇒ 签发侧拒绝签发票 + ERROR 日志。
//
// 每条 unavailable 都带 **Remedy**：给运维**实际可做**的动作（唯一真源，见
// ticketNonceRemedy* 常量）。绝不写"去打开 session.Options.AllowTicketWithoutNonce"
// —— 那是 Go 结构体字段，运维没有配置面（2026-09-19 第二轮审计 §1.3）。
//
// 注意这里**不猜 registrable domain**（不引 PSL、不写 `Domain=example.com`）：
// Domain 一律写成应用基域，越界猜父域会把 Cookie 铺到比应用面更大的范围上。
func (m *Manager) ticketNonceDecision() ticketNonceDecision {
	scheme, rawHost := ParseBaseDomain(m.baseDomain())
	baseHost := normalizeHostOnly(rawHost)
	if baseHost == "" {
		return ticketNonceDecision{
			Plan:   ticketNonceUnavailable,
			Reason: "base_domain_unset",
			Remedy: ticketNonceRemedyAlignOrigin,
		}
	}
	if !cookieDomainWritable(baseHost) {
		return ticketNonceDecision{
			Plan:   ticketNonceUnavailable,
			Reason: "base_domain_not_cookie_writable:" + baseHost,
			Remedy: ticketNonceRemedyBaseDomain,
		}
	}
	configured := m.configuredMainOrigin()
	// derive 是"对外地址给不出可用主机名"时的统一处理：按应用基域推导（配置事实）。
	// 诊断用的 origin 保留配置里写的端口（如实反映部署），Cookie Domain 只取主机名。
	derive := func() ticketNonceDecision {
		origin := scheme + "://" + rawHost
		m.logDerivedMainOriginOnce(origin)
		return ticketNonceDecision{
			Plan:         ticketNonceRequired,
			CookieDomain: baseHost,
			MainOrigin:   origin,
			Derived:      true,
		}
	}
	if configured == "" {
		// 未配置（或配了一个解析不出源的值，例如漏 scheme）⇒ 按应用基域推导。
		return derive()
	}
	mainHost := originHost(configured)
	if mainHost == "" {
		// 配置了但取不出可用主机名（IPv6 字面量等）：Domain Cookie 在 IP 上没有意义
		// ⇒ 与"未配置"同等处理（推导出的是配置里的基域，仍然只来自配置）。
		return derive()
	}
	if mainHost == baseHost || strings.HasSuffix(mainHost, "."+baseHost) {
		return ticketNonceDecision{
			Plan:         ticketNonceRequired,
			CookieDomain: baseHost,
			MainOrigin:   configured,
		}
	}
	return ticketNonceDecision{
		Plan:       ticketNonceUnavailable,
		MainOrigin: configured,
		Reason:     "main_origin_not_same_domain_as_base:" + mainHost,
		Remedy:     ticketNonceRemedyAlignOrigin,
	}
}

// logDerivedMainOriginOnce 把"按应用基域推导主站源"这件事记一次（info 级）。
//
// 为什么只记一次：换票签发在"每次应用登录"都会发生，逐次打印会把日志刷满；而这条信息
// 是**部署级**事实（配没配对外地址），启动后第一次用到就足以说清。生产装配还会在启动
// 日志里再说明一次（见 cmd/server/wasmapp.go）。
func (m *Manager) logDerivedMainOriginOnce(origin string) {
	m.derivedOriginOnce.Do(func() {
		logInfo("pico-wasm-session: 未配置服务端对外地址（控制台设置 server.base_url / 环境变量 %s），"+
			"已按应用基域推导主站源 main_origin=%q（换票 nonce 正常下发）；"+
			"建议显式配置对外地址以避免歧义", publicBaseURLEnvName, origin)
	})
}

// originHost 从源（`https://h[:port]`，可能带路径）里取主机名：小写、去端口、去尾点。
//
// 空串 = 取不到（IPv6 字面量 / 空源）：Domain Cookie 在 IP 上没有意义（浏览器不接受），
// 一律当作"无法下发"。
//
// 与 normalizeHostOnly 共用同一个"主机名形状"实现（R2-2）：两侧归一必须逐字一致，
// 否则同一个值会被判成两个域（旧实现正是如此）。
func originHost(origin string) string {
	s := strings.TrimSpace(origin)
	if s == "" {
		return ""
	}
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	return normalizeHostOnly(s)
}

// normalizeDomain 归一化域名（小写、去尾点）——**不剥端口**。
//
// ⚠️ 只用于"域名标签"这类不看端口的场景；换票 nonce 的判定与 Cookie Domain 必须用
// normalizeHostOnly（Cookie 的 domain-value 不允许端口，RFC 6265 §4.1.1）。
func normalizeDomain(raw string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(raw)), ".")
}

// normalizeHostOnly 把主机名归一成**比较与 Cookie Domain 共用的唯一形状**：
// 小写、去尾点、剥端口。空串 = 取不出主机名（空值 / IPv6 字面量）。
//
// 为什么需要它（R2-2，2026-09-19 第二轮审计 §1.2）：
//   - `PICOAI_APPS_BASE_DOMAIN=apps.example.com:8443` 与 `http://127.0.0.1:8080`
//     这两种写法都被 Options.BaseDomain 的注释明确支持，但端口不参与 Cookie 的作用域；
//   - 旧实现里 baseHost 只做 normalizeDomain（保留端口）而 mainHost 走 originHost
//     （剥端口）⇒ 基域与对外地址**写成同一个值**也被判成"不同域"（500 + 文案指错方向）；
//   - derive 出来的 `Domain=<host>:<port>` 会被 net/http 静默省略整个属性 ⇒ Cookie
//     退化成 host-only ⇒ 子域兑换恒失败，且零 ERROR 零审计（静默死）。
func normalizeHostOnly(raw string) string {
	host := normalizeDomain(raw)
	if host == "" || strings.HasPrefix(host, "[") { // IPv6 字面量：Domain Cookie 无意义
		return ""
	}
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	return strings.TrimSuffix(host, ".")
}

// cookieDomainWritable 报告 host 能否作为 Set-Cookie 的 Domain 属性真正下发。
//
// 判据直接问**将要执行序列化的那份实现**（net/http 的 Cookie.String：Domain 非法时
// **静默省略整个属性**），而不是自己复制一份字符规则 —— 这样"能不能写出去"永远以网库
// 为准，不会随 Go 版本漂移（也恰好解释了 `harness_example.com` 为什么写不出去）。
//
// IP 字面量单独拒：net/http 对裸 IPv4 会照写 `Domain=127.0.0.1`，而浏览器按
// RFC 6265 §5.3 只接受"与响应主机 domain-match 的域名"，IP 一律丢弃整条 Set-Cookie
// ⇒ 又是一种"服务端自认为发了、浏览器根本没存"的静默死。
func cookieDomainWritable(host string) bool {
	if host == "" || strings.ContainsAny(host, ":[]") {
		return false
	}
	if net.ParseIP(host) != nil {
		return false
	}
	probe := http.Cookie{Name: TicketNonceCookieName, Value: "probe", Path: "/", Domain: host}
	return strings.Contains(probe.String(), "Domain=")
}

// ticketNonceCookieNameFor 派生"这张票专属的 nonce Cookie 名"。
//
// 为什么要有它（2026-09-19 第二轮对抗审计 §1.4，P3）：nonce Cookie 若只有一个固定名，
// 它在浏览器里就是**基域级唯一**一份（`Domain=应用基域` + `Path=/`），而"一次签发
// 覆盖同名的上一份"是 RFC 6265 §5.3 的既定语义。于是同一浏览器同时有两张在途票
// （应用中心里中键连开两个应用，A 的跳转还没落地就点了 B）时，先签发的那张票**必然**
// 兑换失败、被烧掉，并写一条与攻击同形的 `rejected=nonce_mismatch`。
//
// 名字 = `picoaide_ticket_nonce_<sha256(code) 前 8 位十六进制>`：
//   - **从 code 派生而不是从 nonce 派生**：兑换时只知道 URL 里的 code（nonce 要读了
//     Cookie 才能比对），而且 Cookie **名**对应用子域的 JS 是可见的（只有值受 HttpOnly
//     保护）—— 把 nonce 写进名字等于把它暴露给任意应用页面；
//   - **取摘要而不是 code 前缀**：名字里出现 code 的任何一段都等于把票的一半交给
//     能读 `document.cookie` 名字的人；sha256 单向前缀没有这个信息量；
//   - 名字是合法的 cookie-name token（十六进制 + 下划线），长度固定、可逐字节断言。
//
// 寿命与票一致（MaxAge=limits.TicketTTL=60 s），因此在途 Cookie 的数量自然有界
// （签发速率 × 60 s）；票一烧，对应的那份 nonce 就没有比对对象。
func ticketNonceCookieNameFor(code string) string {
	sum := sha256.Sum256([]byte(code))
	return TicketNonceCookieName + "_" + hex.EncodeToString(sum[:])[:8]
}

// ticketNonceCookie 构造换票 nonce Cookie。
//
// SameSite=Strict + Secure + HttpOnly + Path=/ + **Domain=应用基域**（唯一一个设 Domain
// 的 Cookie）。MaxAge 与票同寿命：票过期后 nonce 没有任何比对对象，留着只会扩大
// "被误当成凭证"的想象面。
//
// name 由调用方给出：签发侧写"本票专属名 + 固定名"两条（见 TicketSubmit），
// 兑换侧按同一派生规则读（见 ticketNonceVerdict）。
func ticketNonceCookie(name, domain, value string, expires time.Time) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		Domain:   domain,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   true,
		MaxAge:   int(limits.TicketTTL.Seconds()),
		Expires:  expires,
	}
}

// ticketNonceCookieNames 返回兑换本票时按顺序读取的 Cookie 名：本票专属名优先，
// 固定名（TicketNonceCookieName）作为**回退**。
//
// 回退为什么留：①内嵌装配的既有集成链路只带固定名那一条（appserver 的集成 helper
// 就是它的代表）—— 回退让它们不回归；②它不削弱绑定：无论从哪一条读到的值，都必须与
// **本票的** nonce 逐字节相等（见 ticketNonceVerdict），跨票的 nonce 照样是 mismatch。
// 它**不再**是唯一来源 —— "唯一一份固定名 Cookie"正是本缺陷的成因。
func ticketNonceCookieNames(code string) []string {
	primary := ticketNonceCookieNameFor(code)
	if primary == TicketNonceCookieName {
		return []string{TicketNonceCookieName}
	}
	return []string{primary, TicketNonceCookieName}
}

// ticketNonceVerdict 比对请求携带的 nonce 与票记录的 nonce。
//
// 返回 (1, "") 表示匹配；(0, "absent") 表示两条 Cookie 都缺失/为空；(-1, "mismatch")
// 表示读了但值与本票的 nonce 不等。两个失败原因在**审计与日志里区分**（便于定位
// "是隐私浏览器没存 Cookie"还是"有人在探测/跨票送 nonce"），但对外都是同一句拒绝
// —— 不向攻击者区分。
//
// 用 crypto/subtle 的常量时间比较：nonce 是随机值、不是用户输入，时序侧信道在这里
// 并非现实威胁，但比较秘密值的代码没有"够用就行"的理由。候选名固定两条，比较次数
// 与请求内容无关。
func ticketNonceVerdict(r *http.Request, code, want string) (int, string) {
	if want == "" {
		// 调用方只在本票 nonce 非空时才调用这里（空 nonce 走 fail-closed 分支）；
		// 万一被误用，绝不把"空串 == 空串"判成匹配。
		return 0, "absent"
	}
	present := false
	for _, name := range ticketNonceCookieNames(code) {
		c, err := r.Cookie(name)
		if err != nil || c == nil || c.Value == "" {
			continue
		}
		present = true
		if subtle.ConstantTimeCompare([]byte(c.Value), []byte(want)) == 1 {
			return 1, ""
		}
	}
	if !present {
		return 0, "absent"
	}
	return -1, "mismatch"
}

// ticketSecFetchVerdict 是换票兑换的**纵深**判据：浏览器元数据头 Sec-Fetch-*。
//
// 判定（逐条独立；头缺席即跳过该条，见下）：
//   - `Sec-Fetch-Site` 存在 ⇒ 必须 ∈ {same-site, same-origin, none}。
//     `cross-site` 是"别的站点发起的请求"（点开别人发来的链接、被第三方页面 iframe/表单
//     带上），一律拒；`none` 是"浏览器自己发起、没有 initiator"（地址栏粘贴/书签/新标签
//     直接输入）—— **无法**与合法场景区分，只能放行（残留，见 RedeemTicket 的注释）。
//   - `Sec-Fetch-Mode` 存在 ⇒ 必须是 `navigate`。换票只可能发生在顶层导航上
//     （票在地址栏 URL 里），`cors`/`no-cors` 之流意味着别人在用 fetch/XHR/<img> 试探。
//
// **头缺席按现状放行**（老浏览器与非浏览器客户端不发这些头），但调用方必须留日志
// ——"放行了但判据缺席"是安全事件，不是无事发生。返回的 reason 为空 = 判据齐全且通过；
// 为 "headers_absent" = 放行但缺席；其余 = 拒绝原因（落审计与日志）。
//
// 判据名与拒绝原因都进日志 ⇒ 头值一律经 headerForLog 截断 + 引号转义（防日志注入/放大）。
func ticketSecFetchVerdict(r *http.Request) (allow bool, reason, detail string) {
	rawSite := r.Header.Get("Sec-Fetch-Site")
	rawMode := r.Header.Get("Sec-Fetch-Mode")
	detail = "sec-fetch-site=" + headerForLog(rawSite) + " sec-fetch-mode=" + headerForLog(rawMode)
	site := strings.ToLower(strings.TrimSpace(rawSite))
	mode := strings.ToLower(strings.TrimSpace(rawMode))
	if site != "" {
		switch site {
		case "same-site", "same-origin", "none":
		default:
			return false, "site_rejected", detail
		}
	}
	if mode != "" && mode != "navigate" {
		return false, "mode_rejected", detail
	}
	if site == "" || mode == "" {
		return true, "headers_absent", detail
	}
	return true, "", detail
}

// headerForLog 把请求头值变成可安全写进日志的形态：截断（防日志放大）+ 引号转义
// （`%q` 语义，防 CR/LF 日志注入）。
//
// ⚠️ 只用于**判据类**头（Sec-Fetch-*、Origin、Referer）。**绝不用于 Cookie**：
// 会话明文或 nonce 进日志等于凭证泄漏（与 checkMainOrigin 的口径一致）。
func headerForLog(v string) string {
	const maxLen = 64
	v = strings.TrimSpace(v)
	if len(v) > maxLen {
		v = v[:maxLen] + "..."
	}
	return strconv.Quote(v)
}

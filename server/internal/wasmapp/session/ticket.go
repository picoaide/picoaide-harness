package session

import (
	"crypto/subtle"
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
	// （TicketNonceCookieName）。兑换时必须逐字节匹配 —— 这是"票 + 浏览器"的绑定
	// （R1-sec-1）：票在 URL 里，任何拿到 URL 的浏览器都能把 code 交上来，但只有
	// **签发那一刻确实收到了这张票**的浏览器才持有 nonce。
	//
	// 空串是一个**明确的降级标记**：主站 Host 写不出覆盖应用基域的 Domain Cookie
	// （见 ticketNonceCookieDomain），本张票只能靠 Sec-Fetch 判据 —— 这是已知残留，
	// 见报告 temp/wasm-review-r1/fix-sec1.md 的"残留与约束"。
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
//
// ⚠️ 已知残留（不假装解决，详见报告 temp/wasm-review-r1/fix-sec1.md）：
//   - **主站 Host 与应用基域不共享可写域**时（如主站 `harness.example.com`、基域
//     `apps.example.com`），浏览器会拒收这个 Domain Cookie（RFC 6265 的 domain-match
//     规则）⇒ 本函数**降级**为"不发 nonce"，该票只能靠 Sec-Fetch 判据。降级会在日志里
//     留一条 error（唯一现场）。
//   - **地址栏粘贴**：那是"浏览器发起、无 initiator"的顶层导航（`Sec-Fetch-Site: none`），
//     Strict Cookie 照样会发送、Sec-Fetch 也区分不出 ⇒ 该形态只能靠 nonce 挡；nonce
//     不可用的场合（降级部署）这条路径仍然可通。
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
	// Cookie 时还要用它（Domain 属性必须写它，见 ticketNonceCookieDomain），所以这里
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
	code, err := newSecret()
	if err != nil {
		writePage(w, http.StatusInternalServerError, loginHTML(lang, loginView{
			Error: copyFor(lang).ErrInternal, ShowForm: false,
		}))
		return
	}
	now := m.now()
	nonce := ""
	if domain := ticketNonceCookieDomain(r, baseHost); domain != "" {
		nonce, err = newSecret()
		if err != nil {
			writePage(w, http.StatusInternalServerError, loginHTML(lang, loginView{
				Error: copyFor(lang).ErrInternal, ShowForm: false,
			}))
			return
		}
		http.SetCookie(w, ticketNonceCookie(domain, nonce, now.Add(limits.TicketTTL)))
	} else {
		// 降级（要认账）：主站 Host 与"应用基域的祖先域"不共享可写域 ⇒ 浏览器会拒收
		// 这个 Domain Cookie，合法链路也会失败。本张票因此**只能用 Sec-Fetch 判据**。
		// 必须留痕：这是"为什么这台部署挡不住伪造链接"的唯一现场。
		logError("pico-wasm-session: 主站 Host 无法为应用基域下发换票 nonce Cookie（域不匹配，"+
			"浏览器会拒收）⇒ 该票降级为 Sec-Fetch 判据 base=%q %s",
			baseHost, edge.OriginDiagFields(r))
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
	m.auditAsync(emp.Username, "app_ticket_issue", "app="+appID+" ip="+clientIP(r))

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
//   - **必须带签发时下发的 nonce Cookie 且与票记录的 nonce 逐字节匹配**（R1-sec-1）：
//     这是把票绑到"签发那一刻的浏览器"上的唯一手段。缺 Cookie 或不匹配 ⇒ 拒，
//     **绝不签发应用会话 Cookie**；票照旧一次性烧掉（否则一张已知的 code 可以被
//     反复拿来探测 nonce）；
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
	// 确实收到这张票"的浏览器里。t.nonce 为空 = 该部署写不出覆盖应用基域的 Domain
	// Cookie（签发侧已降级并留痕，见 TicketSubmit），此时只剩 Sec-Fetch 判据。
	if t.nonce != "" {
		if v, why := ticketNonceVerdict(r, t.nonce); v != 1 {
			// v == 0：Cookie 缺失/为空；v == -1：值不匹配。
			m.auditAsync("", "app_ticket_redeem", "app="+appID+" rejected=nonce_"+why)
			logWarn("pico-wasm-session: 换票兑换被 nonce 判据拒绝 reason=%s app=%s %s",
				why, appID, edge.OriginDiagFields(r))
			return "", false
		}
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
//   - **不设 Expires 之外的清除逻辑**：nonce 只对自己的那张票有效，票一烧即失效；
//     每次换票都会覆盖它，因此不需要在兑换成功后额外清 Cookie（多一条 Set-Cookie
//     只会让"兑换响应里到底有没有会话 Cookie"这件事更难读）。
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
// 前提是受害者**先加载一个同基域下攻击者可控的页面**（任一员工可发布 wasm 应用；
// 审核开关会再加一道门），因此本修复把攻击从"发一条链接"抬到"两步 + 一次页面加载"，
// 但没有在协议层消除它 —— 详见报告 temp/wasm-review-r1/fix-sec1.md 的残留清单。

// ticketNonceCookieDomain 返回可以作为 Cookie `Domain` 属性的值；空串 = 这个部署
// **写不出**覆盖应用基域的 Cookie，调用方据此降级（见 TicketSubmit / ticket.nonce）。
//
// 为什么需要它：Cookie 的 Domain 必须 **domain-match 发起请求的主机名**
// （RFC 6265 §5.3 第 6 步），否则浏览器**直接丢弃**这条 Set-Cookie（静默失败）。
// 主站与应用基域同属一个可写域时（`harness.example.com` 对 `harness.example.com`、
// 或 `harness.example.com` 对 `example.com`）能下发；两者不在同一可写域时
// （主站 `harness.example.com`、应用基域 `apps.example.com`）浏览器拒收。
// 那种部署下若照常要求 nonce，**合法链路也会失败** ⇒ 只能降级为 Sec-Fetch 判据并留痕。
//
// 注意这里**不猜 registrable domain**（不引 PSL、不写 `Domain=example.com`）：任务口径
// 就是把 Domain 写成应用基域；越界猜父域会把 Cookie 铺到比应用面更大的范围上。
func ticketNonceCookieDomain(r *http.Request, baseHost string) string {
	if r == nil {
		return ""
	}
	baseHost = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(baseHost), "."))
	if baseHost == "" {
		return ""
	}
	host := strings.ToLower(strings.TrimSpace(r.Host))
	if host == "" || strings.HasPrefix(host, "[") {
		// 空 Host / IPv6 字面量：Domain Cookie 在 IP 上没有意义（浏览器不接受），
		// 直接降级而不是发一条注定被丢弃的 Set-Cookie。
		return ""
	}
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return ""
	}
	if host != baseHost && !strings.HasSuffix(host, "."+baseHost) {
		return ""
	}
	return baseHost
}

// ticketNonceCookie 构造换票 nonce Cookie。
//
// SameSite=Strict + Secure + HttpOnly + Path=/ + **Domain=应用基域**（唯一一个设 Domain
// 的 Cookie，见 TicketNonceCookieName 的注释）。MaxAge 与票同寿命：票过期后 nonce
// 没有任何比对对象，留着只会扩大"被误当成凭证"的想象面。
func ticketNonceCookie(domain, value string, expires time.Time) *http.Cookie {
	return &http.Cookie{
		Name:     TicketNonceCookieName,
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

// ticketNonceVerdict 比对请求携带的 nonce 与票记录的 nonce。
//
// 返回 (1, "") 表示匹配；(0, "absent") 表示 Cookie 缺失/为空；(-1, "mismatch") 表示不匹配。
// 两个失败原因在**审计与日志里区分**（便于定位"是隐私浏览器没存 Cookie"还是"有人在探测"），
// 但对外都是同一句拒绝 —— 不向攻击者区分。
//
// 用 crypto/subtle 的常量时间比较：nonce 是随机值、不是用户输入，时序侧信道在这里
// 并非现实威胁，但比较秘密值的代码没有"够用就行"的理由。
func ticketNonceVerdict(r *http.Request, want string) (int, string) {
	c, err := r.Cookie(TicketNonceCookieName)
	if err != nil || c == nil || c.Value == "" {
		return 0, "absent"
	}
	if subtle.ConstantTimeCompare([]byte(c.Value), []byte(want)) != 1 {
		return -1, "mismatch"
	}
	return 1, ""
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

package session

import (
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
	if _, host := ParseBaseDomain(m.baseDomain()); host == "" {
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
	code, err := newSecret()
	if err != nil {
		writePage(w, http.StatusInternalServerError, loginHTML(lang, loginView{
			Error: copyFor(lang).ErrInternal, ShowForm: false,
		}))
		return
	}
	now := m.now()
	m.tickets.issue(code, ticket{
		userID:            emp.ID,
		appID:             appID,
		employeeSessionID: emp.SessionID,
		expiresAt:         now.Add(limits.TicketTTL),
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
//   - 员工会话必须仍然有效 —— 由 insertAppSession 的 `WHERE EXISTS` 在 SQL 层
//     原子校验（签发到兑换之间有 ≤60 s 窗口，期间可能已登出，§10.4 第 46 项）；
//   - **必须 https**（§10.4 第 49 项 fail-closed）：明文连接下不签发应用 Cookie，
//     直接按未登录处理。
//
// 成功后 302 回**去掉 ticket 参数的干净 URL**（由调用方执行跳转）——
// 否则票据会留在地址栏、浏览器历史与后续请求的 Referer 里。
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
	if !m.secureRequest(r) {
		// fail-closed：非 https 不签发。⚠️ 票**仍然被消费**（一次性语义无条件优先）——
		// 这张票刚刚在明文线路上传过（它就在 URL 里），任何看到它的人都能重放；
		// 烧掉它是唯一安全的处理，代价是明文部署下换票会失败（该部署本来就不该
		// 启用应用子域）。调用方按未登录处理。
		m.auditAsync("", "app_ticket_redeem", "app="+appID+" rejected=insecure")
		return "", false
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

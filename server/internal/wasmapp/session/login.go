package session

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ---- 主站员工登录页与会话（R16）----

// LoginPage 渲染主站登录页（GET /login）。
//
// 页面的三个产品约束：
//   - **无外部资源**（内联 CSS/JS，可配 `default-src 'none'`）；
//   - **语言按请求解析**（Accept-Language，中英两版）；
//   - **非 https 明确报错**：不渲染表单，直接告诉用户平台不会签发凭证
//     （§10.4 第 49 项 fail-closed 的用户可见面 —— 静默发一个不安全 Cookie
//     或静默什么都不发生，都是不可接受的行为）。
func (m *Manager) LoginPage(w http.ResponseWriter, r *http.Request) {
	lang := localeOf(r)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		m.renderLogin(w, r, http.StatusMethodNotAllowed, loginView{
			Error:    copyFor(lang).ErrMethod,
			ShowForm: false,
		})
		return
	}
	v := loginView{
		Title:    m.loginTitle(lang),
		Product:  strings.TrimSpace(m.opt.ProductName),
		Next:     sanitizeNext(r.URL.Query().Get("next")),
		ShowForm: true,
	}
	if r.URL.Query().Get("logout") != "" {
		v.Notice = copyFor(lang).NoticeOut
	}
	if !m.secureRequest(r) {
		v.Insecure = true
		v.ShowForm = false
	}
	m.renderLogin(w, r, http.StatusOK, v)
}

// LoginSubmit 处理登录表单（POST /login）。
//
// 校验顺序（任一不过即停）：
//  1. 方法必须是 POST；
//  2. **Origin/Referer 同源**（§4.7：防登录 CSRF —— 攻击者页面不能把受害者
//     静默登进攻击者的账号，也不能借受害者已登录的浏览器发写请求）；
//  3. **必须 https**（fail-closed，不下发不安全 Cookie）；
//  4. 认证（Options.Auth → serverauth 的 provider 链，local/LDAP 顺序一致）；
//  5. 账号可用性（禁用/审计员，与客户端面同一判据）；
//  6. 落库只存 SHA-256，Cookie 带 HttpOnly + Secure + SameSite=Lax + host-only。
func (m *Manager) LoginSubmit(w http.ResponseWriter, r *http.Request) {
	lang := localeOf(r)
	if r.Method != http.MethodPost {
		m.renderLogin(w, r, http.StatusMethodNotAllowed, loginView{
			Error: copyFor(lang).ErrMethod, ShowForm: false,
		})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		m.renderLogin(w, r, http.StatusBadRequest, loginView{
			Error: copyFor(lang).ErrCredentials, ShowForm: true,
		})
		return
	}
	next := sanitizeNext(r.PostFormValue("next"))
	form := loginView{Next: next, ShowForm: true}

	if !m.checkMainOrigin(r) {
		// 来源校验失败**仍然渲染表单**（2026-09-19 P0 修复）。
		//
		// 曾经这里是 ShowForm=false：用户落到一个"只有一行报错、没有任何输入框"的
		// 死页面（用户原话"根本没有地方输入账号密码"），无法重试、也看不出下一步。
		// 来源校验失败可能是**瞬态**的（隐私扩展、代理改写、扩展注入的 iframe），
		// 而表单本身没有任何安全价值：POST 到 /login 会再走一次同样的校验。
		// 文案用专用的 ErrOriginRejected（带可操作指引），与"审计员/禁用账号"那条
		// 不可重试的 ErrForbidden 区分开。
		form.Error = copyFor(lang).ErrOriginRejected
		form.ShowForm = true
		m.renderLogin(w, r, http.StatusForbidden, form)
		return
	}
	if !m.secureRequest(r) {
		form.Insecure = true
		form.ShowForm = false
		m.renderLogin(w, r, http.StatusForbidden, form)
		return
	}

	username := strings.TrimSpace(r.PostFormValue("username"))
	password := r.PostFormValue("password")
	if username == "" || len(username) > maxUsernameLen || len(password) > maxPasswordLen {
		m.audit(username, "login_fail", "app_platform invalid_form ip="+clientIP(r))
		form.Error = copyFor(lang).ErrCredentials
		m.renderLogin(w, r, http.StatusUnauthorized, form)
		return
	}
	if m.opt.Auth == nil {
		logError("pico-wasm-session: Options.Auth 未注入，登录不可用")
		form.Error = copyFor(lang).ErrInternal
		form.ShowForm = false
		m.renderLogin(w, r, http.StatusInternalServerError, form)
		return
	}

	// 登录失败预算：与客户端面 /auth/login 共享同一份（见 Options.Throttle）。
	// 必须**在认证之前**判，否则预算只在事后生效、挡不住 argon2 放大。
	ip := clientIP(r)
	if m.opt.Throttle != nil && !m.opt.Throttle.Allow(username, ip) {
		m.audit(username, "login_fail", "app_platform rate_limited ip="+ip)
		form.Error = copyFor(lang).ErrRateLimited
		form.ShowForm = false
		m.renderLogin(w, r, http.StatusTooManyRequests, form)
		return
	}

	authed, userIDHint, err := m.opt.Auth(username, password)
	if err != nil {
		if m.opt.Throttle != nil {
			m.opt.Throttle.Failure(username, ip)
		}
		// 认证失败与"账号不存在"必须给出**同一句话**（否则 /login 变成账号枚举器）。
		m.audit(username, "login_fail", "app_platform ip="+ip)
		form.Error = copyFor(lang).ErrCredentials
		m.renderLogin(w, r, http.StatusUnauthorized, form)
		return
	}
	if strings.TrimSpace(authed) == "" {
		authed = username
	}

	ctx := r.Context()
	user, err := m.loadLoginUser(ctx, authed, userIDHint)
	if err != nil {
		// 认证通过但本地没有行（外部身份尚未建号）也按统一文案处理：
		// 这一层同样不能成为"该账号是否存在"的探针。
		m.audit(authed, "login_fail", "app_platform no_local_row ip="+clientIP(r))
		form.Error = copyFor(lang).ErrCredentials
		m.renderLogin(w, r, http.StatusUnauthorized, form)
		return
	}
	// 认证已经成功，下面两条不再是"存在性"信息（攻击者必须已有正确密码才能到达），
	// 与客户端面 serverauth/handler.go 的文案保持一致。
	switch err := user.checkUsable(); {
	case err == ErrAuditorBlocked:
		m.audit(user.Username, "login_fail", "app_platform auditor_blocked ip="+clientIP(r))
		form.Error = copyFor(lang).ErrForbidden
		form.ShowForm = false
		m.renderLogin(w, r, http.StatusUnauthorized, form)
		return
	case err != nil:
		m.audit(user.Username, "login_fail", "app_platform disabled ip="+clientIP(r))
		form.Error = copyFor(lang).ErrCredentials
		form.ShowForm = false
		m.renderLogin(w, r, http.StatusUnauthorized, form)
		return
	}

	now := m.now()
	raw, err := newSecret()
	if err != nil {
		m.renderInternalError(w, r, lang, form)
		return
	}
	expires := now.Add(limits.AppSessionTTL)
	if _, err := m.insertEmployeeSession(ctx, user.ID, raw, r.UserAgent(), clientIP(r), now, expires); err != nil {
		logError("pico-wasm-session: insert employee session: %v", err)
		m.renderInternalError(w, r, lang, form)
		return
	}
	m.sweepExpiredEmployeeSessions(ctx, now)
	if m.opt.Throttle != nil {
		m.opt.Throttle.Success(user.Username, ip)
	}
	m.audit(user.Username, "login_success", "app_platform ip="+ip)
	http.SetCookie(w, employeeCookie(raw, expires))
	// 303：POST 之后必须是 GET（POST/Redirect/GET），否则刷新会重发表单。
	http.Redirect(w, r, next, http.StatusSeeOther)
}

// Logout 处理登出（POST /logout）。
//
// 语义（§10.4 第 46 项）：POST + Origin 校验 ⇒ 置 revoked_at ⇒ **在 SQL 层**
// 级联失效该会话下全部应用子域会话（显式 DELETE + FK 级联双保险）⇒ 清 Cookie。
// 之后任何带着旧应用 Cookie 的子域请求都解析不出身份（resolveAppSession 还额外
// 校验 employee_sessions.revoked_at，纵深）。
func (m *Manager) Logout(w http.ResponseWriter, r *http.Request) {
	lang := localeOf(r)
	if r.Method != http.MethodPost {
		m.renderLogin(w, r, http.StatusMethodNotAllowed, loginView{
			Error: copyFor(lang).ErrMethod, ShowForm: false,
		})
		return
	}
	if !m.checkMainOrigin(r) {
		m.renderLogin(w, r, http.StatusForbidden, loginView{
			Error: copyFor(lang).ErrForbidden, ShowForm: false,
		})
		return
	}

	ctx := r.Context()
	now := m.now()
	if c, err := r.Cookie(EmployeeCookieName); err == nil && c.Value != "" {
		if emp, err := m.lookupEmployeeSession(ctx, c.Value, now); err == nil {
			keys, rerr := m.revokeEmployeeSession(ctx, emp.SessionID, now)
			if rerr != nil {
				logError("pico-wasm-session: revoke on logout: %v", rerr)
			}
			for _, k := range keys {
				m.notifyAppSessionRevoked(k)
			}
			m.audit(emp.Username, "logout", fmt.Sprintf("app_platform app_sessions=%d ip=%s", len(keys), clientIP(r)))
		}
	}
	// 删除指令的属性必须与写入时一致（Secure/Path/SameSite），否则浏览器忽略删除
	// （admin.go 里 OIDC state cookie 的同一条教训）。
	http.SetCookie(w, clearEmployeeCookie(m.secureRequest(r)))
	http.Redirect(w, r, "/login?logout=1", http.StatusSeeOther)
}

// CurrentEmployee 从主站 Cookie 解析员工身份（nil/未登录/会话失效 ⇒ false）。
//
// 顺带节流刷新 last_seen_at（最多每分钟一次）—— 这是"最近活跃"运维视图的数据源。
func (m *Manager) CurrentEmployee(r *http.Request) (*Employee, bool) {
	if r == nil {
		return nil, false
	}
	c, err := r.Cookie(EmployeeCookieName)
	if err != nil || c.Value == "" {
		return nil, false
	}
	now := m.now()
	emp, err := m.lookupEmployeeSession(r.Context(), c.Value, now)
	if err != nil {
		return nil, false
	}
	m.touchEmployeeSession(r.Context(), emp.SessionID, now)
	return emp, true
}

// RevokeSession 按会话 id 吊销员工会话，并级联失效其全部应用子域会话。
//
// 供管理面/运维处置调用（离职、可疑会话）。返回的 error 只表示**持久化**失败；
// 应用会话 key 的通知与审计即使部分失败也不会回滚（吊销本身已尽力而为）。
func (m *Manager) RevokeSession(ctx context.Context, id int64) error {
	if ctx == nil {
		ctx = context.Background()
	}
	keys, err := m.revokeEmployeeSession(ctx, id, m.now())
	for _, k := range keys {
		m.notifyAppSessionRevoked(k)
	}
	// §4.9：令牌吊销是高频项 ⇒ 异步审计。
	m.auditAsync("", "app_session_revoke", fmt.Sprintf("employee_session=%d app_sessions=%d", id, len(keys)))
	return err
}

// ---- 渲染辅助 ----

func (m *Manager) loginTitle(lang string) string {
	c := copyFor(lang)
	if p := strings.TrimSpace(m.opt.ProductName); p != "" {
		return c.LoginTitle + " · " + p
	}
	return c.LoginTitle
}

func (m *Manager) ticketTitle(lang string) string {
	c := copyFor(lang)
	if p := strings.TrimSpace(m.opt.ProductName); p != "" {
		return c.TicketTitle + " · " + p
	}
	return c.TicketTitle
}

func (m *Manager) renderLogin(w http.ResponseWriter, r *http.Request, status int, v loginView) {
	lang := localeOf(r)
	if v.Title == "" {
		v.Title = m.loginTitle(lang)
	}
	if v.Product == "" {
		v.Product = strings.TrimSpace(m.opt.ProductName)
	}
	writePage(w, status, loginHTML(lang, v))
}

func (m *Manager) renderInternalError(w http.ResponseWriter, r *http.Request, lang string, v loginView) {
	v.Error = copyFor(lang).ErrInternal
	v.ShowForm = false
	m.renderLogin(w, r, http.StatusInternalServerError, v)
}

// ---- Cookie ----

// employeeCookie 构造员工会话 Cookie。
//
// 四个属性都是硬要求：host-only（**不设 Domain**，见 EmployeeCookieName）、
// HttpOnly、Path=/、SameSite=Lax（主站内导航需要带上 Cookie；跨站写由
// Origin 校验挡），Secure（调用方只在 https 下才会走到这里，见 secureRequest）。
func employeeCookie(raw string, expires time.Time) *http.Cookie {
	return &http.Cookie{
		Name:     EmployeeCookieName,
		Value:    raw,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   true,
		MaxAge:   int(limits.AppSessionTTL.Seconds()),
		Expires:  expires,
	}
}

// clearEmployeeCookie 是登出时的删除指令（Value 空 + MaxAge<0）。
func clearEmployeeCookie(secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     EmployeeCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		MaxAge:   -1,
	}
}

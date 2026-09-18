package session

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件覆盖**登录失败预算**（Options.Throttle）。
//
// 为什么单独立一个文件：这个钩子是集成期补上的 —— 员工浏览器登录页是与客户端面
// `/auth/login` **并列的第二个密码入口**。它一度完全没有失败预算（新入口绕过既有
// 爆破防护），修复方式是在 session 侧留一个钩子、由 main.go 注入 serverauth 的
// **同一套三个桶**。所以这里要钉住的不是"限流器能不能限流"（那是 serverauth 的
// 用例），而是"**登录处理器有没有真的用这个钩子**"。
//
// 变异验证：把 LoginSubmit 里 `!m.opt.Throttle.Allow(...)` 那一段删掉 ⇒
// TestLoginThrottleBlocksBeforeAuth / TestLoginThrottleRecordsFailure 必红。

type fakeThrottle struct {
	mu       sync.Mutex
	allowed  bool
	attempts []string
	failures []string
	success  []string
}

func (f *fakeThrottle) Allow(username, host string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts = append(f.attempts, username+"|"+host)
	return f.allowed
}

func (f *fakeThrottle) Failure(username, host string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failures = append(f.failures, username+"|"+host)
}

func (f *fakeThrottle) Success(username, host string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.success = append(f.success, username+"|"+host)
}

func (f *fakeThrottle) counts() (int, int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.attempts), len(f.failures), len(f.success)
}

// postLoginForm 发一次登录表单（https + 正确 Origin，绕开 CSRF/明文那两道闸）。
func postLoginForm(t *testing.T, e *testEnv, username, password string) *httptest.ResponseRecorder {
	t.Helper()
	form := url.Values{"username": {username}, "password": {password}, "next": {"/"}}
	req := formReq(t, "/login", form)
	req.Header.Set("Origin", testMainOrigin)
	w := httptest.NewRecorder()
	e.mgr.LoginSubmit(w, req)
	return w
}

// TestLoginThrottleBlocksBeforeAuth：预算耗尽 ⇒ 429，且**不进入认证**。
//
// 顺序很关键：必须在认证**之前**判，否则预算只在事后生效，挡不住
// "用随机用户名反复触发 argon2id(64MiB)" 那类放大攻击（审计 2026-09-13 P1-2 同族）。
func TestLoginThrottleBlocksBeforeAuth(t *testing.T) {
	th := &fakeThrottle{allowed: false}
	e := newEnv(t, func(o *Options) { o.Throttle = th })
	w := postLoginForm(t, e, "nobody", "whatever")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("预算耗尽应回 429，got %d body=%.120q", w.Code, w.Body.String())
	}
	// 未进入认证 ⇒ 不应记失败（预算由 serverauth 侧维护，这里只负责"不进"）。
	if _, _, s := th.counts(); s != 0 {
		t.Fatalf("被预算挡住时不该记成功")
	}
	if n, f, _ := th.counts(); n != 1 || f != 0 {
		t.Fatalf("应询问 1 次预算、记 0 次失败，got ask=%d fail=%d", n, f)
	}
}

// TestLoginThrottleRecordsFailure：认证失败 ⇒ 记一次失败（三个桶由 serverauth 维护）。
func TestLoginThrottleRecordsFailure(t *testing.T) {
	e := newEnv(t)
	e.newUser(t, "alice")
	th := &fakeThrottle{allowed: true}
	e.mgr.opt.Throttle = th

	w := postLoginForm(t, e, "alice", "wrong-password")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("密码错应回 401，got %d", w.Code)
	}
	if n, f, s := th.counts(); n != 1 || f != 1 || s != 0 {
		t.Fatalf("应 ask=1 fail=1 success=0，got ask=%d fail=%d success=%d", n, f, s)
	}
	// 认证失败与"账号不存在"必须同一文案（防账号枚举）。
	w2 := postLoginForm(t, e, "ghost", "wrong-password")
	if w2.Code != w.Code || w2.Body.String() != w.Body.String() {
		t.Fatal("账号不存在与密码错必须给出完全相同的响应（否则 /login 变成账号枚举器）")
	}
}

// TestLoginThrottleResetsOnSuccess：认证成功 ⇒ 清空预算（合法登录不该消耗失败额度）。
func TestLoginThrottleResetsOnSuccess(t *testing.T) {
	e := newEnv(t)
	e.newUser(t, "bob")
	th := &fakeThrottle{allowed: true}
	e.mgr.opt.Throttle = th

	w := postLoginForm(t, e, "bob", testPassword)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("正确凭据应 303，got %d body=%.160q", w.Code, w.Body.String())
	}
	if n, f, s := th.counts(); n != 1 || f != 0 || s != 1 {
		t.Fatalf("应 ask=1 fail=0 success=1，got ask=%d fail=%d success=%d", n, f, s)
	}
	if !strings.Contains(w.Header().Get("Set-Cookie"), "picoaide_emp=") {
		t.Fatal("成功登录应签发员工会话 Cookie")
	}
}

// TestLoginThrottleNilIsSafe：未注入（仅测试/未装配）时不得 panic。
func TestLoginThrottleNilIsSafe(t *testing.T) {
	e := newEnv(t)
	e.newUser(t, "carol")
	e.mgr.opt.Throttle = nil
	if w := postLoginForm(t, e, "carol", "wrong"); w.Code != http.StatusUnauthorized {
		t.Fatalf("未注入预算时应照常认证（401），got %d", w.Code)
	}
	if w := postLoginForm(t, e, "carol", testPassword); w.Code != http.StatusSeeOther {
		t.Fatalf("未注入预算时应能登录成功，got %d", w.Code)
	}
}

// TestLoginThrottleUsesClientIP：预算的 host 维度必须是客户端 IP（不是空串）——
// 否则 serverauth 的 ip: 桶会全部落到同一个键上，退化成"全组织共桶"。
func TestLoginThrottleUsesClientIP(t *testing.T) {
	e := newEnv(t)
	e.newUser(t, "dave")
	th := &fakeThrottle{allowed: true}
	e.mgr.opt.Throttle = th
	postLoginForm(t, e, "dave", "wrong")
	th.mu.Lock()
	defer th.mu.Unlock()
	if len(th.attempts) != 1 {
		t.Fatalf("attempts=%v", th.attempts)
	}
	host := th.attempts[0][len("dave|"):]
	if host == "" {
		t.Fatal("预算的 host 维度为空 ⇒ 单 IP 桶会坍缩成全局桶（本仓已有同族事故）")
	}
}

// TestSessionLimitsComeFromLimits：表单/字段上限必须与 limits 同源（§5.5 数值单一真源）。
func TestSessionLimitsComeFromLimits(t *testing.T) {
	if maxFormBytes != limits.SessionMaxFormBytes {
		t.Fatalf("maxFormBytes=%d want %d", maxFormBytes, limits.SessionMaxFormBytes)
	}
	if maxUsernameLen != limits.SessionMaxUsernameBytes {
		t.Fatalf("maxUsernameLen=%d want %d", maxUsernameLen, limits.SessionMaxUsernameBytes)
	}
	if maxPasswordLen != limits.SessionMaxPasswordBytes {
		t.Fatalf("maxPasswordLen=%d want %d", maxPasswordLen, limits.SessionMaxPasswordBytes)
	}
}

// TestLoginAndTicketPagesRenderInlineCSS：注入式页面的内联样式必须真的输出。
//
// 为什么需要这条：`html/template` 会拒绝把**裸 string** 注入 `<style>`，输出
// `ZgotmplZ` 占位符 —— 页面不会报错，只是**静默退化成无样式的裸表单**（实测过：
// 登录页与换票页都中招）。样式是编译期常量、不含用户输入，必须显式标成
// `template.CSS`。变异：把 `v.CSS = template.CSS(pageCSS)` 改回 `pageCSS`
// ⇒ 本用例必红（断言 ZgotmplZ 不出现 + 样式确实落地）。
func TestLoginAndTicketPagesRenderInlineCSS(t *testing.T) {
	e := newEnv(t)
	e.newUser(t, "erin")
	e.newApp(t, "css-app", "erin")

	// 登录页
	w := httptest.NewRecorder()
	req := httpsReq(http.MethodGet, "https://"+testMainOrigin+"/login", nil)
	e.mgr.LoginPage(w, req)
	body := w.Body.String()
	if strings.Contains(body, "ZgotmplZ") {
		t.Fatal("登录页出现 ZgotmplZ ⇒ 内联样式被 html/template 拒绝（页面会退化成裸表单）")
	}
	if !strings.Contains(body, "<style>") || !strings.Contains(body, "box-sizing") {
		t.Fatal("登录页没有输出内联样式")
	}

	// 换票确认页
	w2 := httptest.NewRecorder()
	req2 := httpsReq(http.MethodGet, "https://"+testMainOrigin+"/app-ticket?app=css-app&next=/", nil)
	e.mgr.TicketPage(w2, req2)
	body2 := w2.Body.String()
	if strings.Contains(body2, "ZgotmplZ") {
		t.Fatal("换票页出现 ZgotmplZ ⇒ 内联样式被 html/template 拒绝")
	}
	if !strings.Contains(body2, "box-sizing") {
		t.Fatal("换票页没有输出内联样式")
	}
}

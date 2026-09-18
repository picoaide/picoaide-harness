package appserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero/api"
)

// mustURL 解析一个 URL（测试辅助；解析失败即 Fatal）。
func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return u
}

// ===== WriteAppResponse：响应体上限（§10.3 第 29 项）=====

func TestWriteAppResponse_OverrunIs500(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://app.harness.example.com/api/big", nil)

	body := strings.Repeat("x", limits.AppResponseBodyMaxBytes+1)
	s.writeAppResponse(rec, req, abi.Response{Status: http.StatusOK, Body: body})

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("超限响应体应 500，得到 %d", rec.Code)
	}
	if code := errorCodeOf(t, rec.Body); code != "RUNTIME_OUTPUT_OVERRUN" {
		t.Fatalf("错误码应为 RUNTIME_OUTPUT_OVERRUN，得到 %q", code)
	}
	// 绝不返回部分内容（半个 JSON/HTML 只会有害）。
	if strings.Contains(rec.Body.String(), strings.Repeat("x", 64)) {
		t.Fatal("超限时不得把应用的部分响应体写出去")
	}
}

func TestWriteAppResponse_BoundaryIsAllowed(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://app.harness.example.com/api/big", nil)

	body := strings.Repeat("y", limits.AppResponseBodyMaxBytes)
	s.writeAppResponse(rec, req, abi.Response{Status: http.StatusOK, Body: body})
	if rec.Code != http.StatusOK {
		t.Fatalf("恰好等于上限应放行，得到 %d", rec.Code)
	}
	if rec.Body.Len() != limits.AppResponseBodyMaxBytes {
		t.Fatalf("响应体长度不对: %d", rec.Body.Len())
	}
}

func TestWriteAppResponse_StatusDefaultsAndClamps(t *testing.T) {
	cases := []struct {
		name string
		in   int
		want int
	}{
		{"零值回落 200", 0, http.StatusOK},
		{"非法低位回落 200", 99, http.StatusOK},
		{"非法高位回落 200", 999, http.StatusOK},
		{"正常状态保留", http.StatusTeapot, http.StatusTeapot},
		{"错误状态保留", http.StatusForbidden, http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{}
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "https://app.harness.example.com/", nil)
			s.writeAppResponse(rec, req, abi.Response{Status: tc.in, Body: "ok"})
			if rec.Code != tc.want {
				t.Fatalf("status %d 应映射成 %d，得到 %d", tc.in, tc.want, rec.Code)
			}
		})
	}
}

// ===== 静态资源路径判定 =====

func TestStaticLogicalPath(t *testing.T) {
	cases := []struct {
		path      string
		wantPath  string
		wantEntry bool
		wantOK    bool
	}{
		{"/", "index.html", true, true},
		{"/index.html", "index.html", true, true},
		{"/app.js", "app.js", false, true},
		{"/static/app.css", "static/app.css", false, true},
		{"/docs/", "docs/index.html", false, true},
		{"/api", "", false, false},
		{"/api/items", "", false, false},
		{"/apiary/x", "apiary/x", false, true}, // 只有 /api 前缀是保留的，不误伤 apiary
		{"/../etc/passwd", "", false, false},
		{"/a/../../b", "", false, false},
		{"/./x", "", false, false},
		{"/a\\b", "", false, false},
		{"relative", "", false, false},
		{"", "", false, false},
	}
	for _, tc := range cases {
		gotPath, gotEntry, gotOK := staticLogicalPath(mustURL(t, "https://x.example.com"+tc.path))
		if gotOK != tc.wantOK || gotPath != tc.wantPath || gotEntry != tc.wantEntry {
			t.Fatalf("staticLogicalPath(%q) = (%q,%v,%v)，期望 (%q,%v,%v)",
				tc.path, gotPath, gotEntry, gotOK, tc.wantPath, tc.wantEntry, tc.wantOK)
		}
	}
}

func TestAssetETagIncludesAppVersionAndPath(t *testing.T) {
	data := []byte("same bytes")
	base := assetETag("app-a", "1.0.0", "index.html", data)
	if base != assetETag("app-a", "1.0.0", "index.html", data) {
		t.Fatal("同一输入必须得到同一 ETag")
	}
	if base == assetETag("app-b", "1.0.0", "index.html", data) {
		t.Fatal("不同 app_id 绝不能共用 ETag")
	}
	if base == assetETag("app-a", "2.0.0", "index.html", data) {
		t.Fatal("不同 version 绝不能共用 ETag")
	}
	if base == assetETag("app-a", "1.0.0", "other.html", data) {
		t.Fatal("不同 path 绝不能共用 ETag")
	}
	if base == assetETag("app-a", "1.0.0", "index.html", []byte("changed")) {
		t.Fatal("内容变了 ETag 必须变")
	}
	if !strings.HasPrefix(base, `"`) || !strings.HasSuffix(base, `"`) {
		t.Fatalf("ETag 必须是带引号的强校验形态: %q", base)
	}
}

// ===== releaseAssetID：发布期的目录约定 =====

func TestReleaseAssetID(t *testing.T) {
	cases := []struct {
		name string
		rel  *serverstore.WasmRelease
		want string
	}{
		{"空 assets_dir 用 release id", &serverstore.WasmRelease{ID: 42}, "42"},
		{"目录名直接用", &serverstore.WasmRelease{ID: 42, AssetsDir: "custom-1"}, "custom-1"},
		{"绝对路径取 basename", &serverstore.WasmRelease{ID: 42, AssetsDir: "/data/apps/x/assets/7"}, "7"},
		{"带尾斜杠取 basename", &serverstore.WasmRelease{ID: 42, AssetsDir: "/data/apps/x/assets/7/"}, "7"},
		{"纯空白回落 id", &serverstore.WasmRelease{ID: 42, AssetsDir: "   "}, "42"},
		{"点路径回落 id", &serverstore.WasmRelease{ID: 42, AssetsDir: ".."}, "42"},
	}
	for _, tc := range cases {
		if got := releaseAssetID(tc.rel); got != tc.want {
			t.Fatalf("%s: releaseAssetID = %q，期望 %q", tc.name, got, tc.want)
		}
	}
	if got := releaseAssetID(nil); got != "" {
		t.Fatalf("nil 版本应返回空串，得到 %q", got)
	}
}

// ===== clientIP：可信代理边界（R35）=====

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("172.28.0.0/24")}
	cases := []struct {
		name       string
		remote     string
		xff        string
		trusted    []netip.Prefix
		wantResult string
	}{
		{"无信任代理时忽略 XFF（防伪造）", "203.0.113.5:1234", "1.2.3.4", nil, "203.0.113.5"},
		{"对端不是可信代理时忽略 XFF", "203.0.113.5:1234", "1.2.3.4", trusted, "203.0.113.5"},
		{"对端可信时采信最左的不可信地址", "172.28.0.2:443", "203.0.113.9, 172.28.0.2", trusted, "203.0.113.9"},
		{"整条链都是可信代理时回落对端", "172.28.0.2:443", "172.28.0.3", trusted, "172.28.0.2"},
		{"链中出现垃圾时回落对端（不可信链）", "172.28.0.2:443", "203.0.113.9, garbage", trusted, "172.28.0.2"},
		{"无 XFF 时用对端", "172.28.0.2:443", "", trusted, "172.28.0.2"},
		{"IPv6 字面量", "[2001:db8::1]:8080", "", trusted, "2001:db8::1"},
		{"对端不可解析时原样返回", "unix-socket", "1.2.3.4", trusted, "unix-socket"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "https://app.harness.example.com/", nil)
			req.RemoteAddr = tc.remote
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := clientIP(req, tc.trusted); got != tc.wantResult {
				t.Fatalf("clientIP = %q，期望 %q", got, tc.wantResult)
			}
		})
	}
}

// ===== 模块缓存（CompiledModule 的淘汰策略与上限）=====

// fakeModule 是 wazero.CompiledModule 的最小实现（只为观察缓存行为）。
type fakeModule struct {
	name   string
	closed atomic.Bool
}

func (m *fakeModule) Name() string                                         { return m.name }
func (m *fakeModule) ImportedFunctions() []api.FunctionDefinition          { return nil }
func (m *fakeModule) ExportedFunctions() map[string]api.FunctionDefinition { return nil }
func (m *fakeModule) ImportedMemories() []api.MemoryDefinition             { return nil }
func (m *fakeModule) ExportedMemories() map[string]api.MemoryDefinition    { return nil }
func (m *fakeModule) CustomSections() []api.CustomSection                  { return nil }
func (m *fakeModule) Close(context.Context) error {
	m.closed.Store(true)
	return nil
}

// newLoader 返回一个记录调用次数的 loader。
func newLoader(name string, calls *int32, size int64) func(context.Context) (compiledResult, *apperr.Error) {
	return func(context.Context) (compiledResult, *apperr.Error) {
		atomic.AddInt32(calls, 1)
		return compiledResult{mod: &fakeModule{name: name}, size: size}, nil
	}
}

func TestModuleCache_HitsDoNotRecompile(t *testing.T) {
	c := newModuleCache()
	var calls int32
	key := moduleKey{AppID: "a", Version: "1.0.0", ReleaseID: 1}
	for i := 0; i < 3; i++ {
		mod, release, err := c.acquire(t.Context(), key, newLoader("m1", &calls, 10))
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		if mod == nil {
			t.Fatal("模块不应为 nil")
		}
		release()
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("同一 key 只应编译一次，得到 %d 次", got)
	}
	if entries, bytes := c.size(); entries != 1 || bytes != 10 {
		t.Fatalf("缓存记账不对: entries=%d bytes=%d", entries, bytes)
	}
}

func TestModuleCache_KeySeparatesVersionAndRelease(t *testing.T) {
	c := newModuleCache()
	var calls int32
	keys := []moduleKey{
		{AppID: "a", Version: "1.0.0", ReleaseID: 1},
		{AppID: "a", Version: "1.0.0", ReleaseID: 2},
		{AppID: "a", Version: "2.0.0", ReleaseID: 3},
		{AppID: "b", Version: "1.0.0", ReleaseID: 4},
	}
	for _, k := range keys {
		_, release, err := c.acquire(t.Context(), k, newLoader("m", &calls, 1))
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		release()
	}
	if got := atomic.LoadInt32(&calls); got != int32(len(keys)) {
		t.Fatalf("不同键必须各自编译，得到 %d 次", got)
	}
	if entries, _ := c.size(); entries != len(keys) {
		t.Fatalf("应有 %d 条缓存，得到 %d", len(keys), entries)
	}
}

func TestModuleCache_EvictsLRU(t *testing.T) {
	c := newModuleCache()
	c.maxEntries = 2
	c.maxBytes = 0
	var callsA, callsB, callsC int32
	keyA := moduleKey{AppID: "a", Version: "1", ReleaseID: 1}
	keyB := moduleKey{AppID: "b", Version: "1", ReleaseID: 2}
	keyC := moduleKey{AppID: "c", Version: "1", ReleaseID: 3}

	_, relA1, err := c.acquire(t.Context(), keyA, newLoader("a", &callsA, 1))
	if err != nil {
		t.Fatalf("acquire A: %v", err)
	}
	relA1()
	_, relB, err := c.acquire(t.Context(), keyB, newLoader("b", &callsB, 1))
	if err != nil {
		t.Fatalf("acquire B: %v", err)
	}
	relB()
	// 再次命中 A ⇒ A 变成最近使用（LRU 的 front）。
	_, relA2, err := c.acquire(t.Context(), keyA, newLoader("a", &callsA, 1))
	if err != nil {
		t.Fatalf("re-acquire A: %v", err)
	}
	relA2()

	// 插入 C：应淘汰最久未用的 B。
	if _, relC, err := c.acquire(t.Context(), keyC, newLoader("c", &callsC, 1)); err != nil {
		t.Fatalf("acquire C: %v", err)
	} else {
		relC()
	}
	if entries, _ := c.size(); entries != 2 {
		t.Fatalf("淘汰后应剩 2 条，得到 %d", entries)
	}
	if c.has(keyB) {
		t.Fatal("最久未用的 B 应已被淘汰")
	}
	if !c.has(keyA) {
		t.Fatal("刚命中的 A 不应被淘汰")
	}
}

func TestModuleCache_NeverEvictsInUse(t *testing.T) {
	c := newModuleCache()
	c.maxEntries = 1
	c.maxBytes = 0
	keyA := moduleKey{AppID: "a", Version: "1", ReleaseID: 1}
	keyB := moduleKey{AppID: "b", Version: "1", ReleaseID: 2}
	keyC := moduleKey{AppID: "c", Version: "1", ReleaseID: 3}
	var calls int32

	_, relA, err := c.acquire(t.Context(), keyA, newLoader("a", &calls, 1))
	if err != nil {
		t.Fatalf("acquire A: %v", err)
	}
	// A 仍被持有（未 release）：插入 B 时不得把 A 关掉（否则正在跑的请求会失败）。
	if _, relB, err := c.acquire(t.Context(), keyB, newLoader("b", &calls, 1)); err != nil {
		t.Fatalf("acquire B: %v", err)
	} else {
		relB()
	}
	if !c.has(keyA) {
		t.Fatal("仍被使用的条目绝不能淘汰")
	}
	relA()
	// A 释放后：插入 C 应淘汰 A（此时它是最久未用的空闲条目）。
	if _, relC, err := c.acquire(t.Context(), keyC, newLoader("c", &calls, 1)); err != nil {
		t.Fatalf("acquire C: %v", err)
	} else {
		relC()
	}
	if entries, _ := c.size(); entries != 1 {
		t.Fatalf("应回到 1 条，得到 %d", entries)
	}
	if c.has(keyA) {
		t.Fatal("释放后的 A 应被淘汰")
	}
}

func TestModuleCache_ByteBudgetEvicts(t *testing.T) {
	c := newModuleCache()
	c.maxEntries = 0
	c.maxBytes = 10
	var calls int32
	for i := 0; i < 3; i++ {
		k := moduleKey{AppID: "a", Version: "1", ReleaseID: int64(i + 1)}
		_, release, err := c.acquire(t.Context(), k, newLoader("m", &calls, 10))
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		release()
	}
	if entries, bytes := c.size(); entries != 1 || bytes != 10 {
		t.Fatalf("按字节上限应只剩 1 条/10 字节，得到 %d/%d", entries, bytes)
	}
}

func TestModuleCache_LoadErrorPropagates(t *testing.T) {
	c := newModuleCache()
	want := apperr.New(apperr.CodeCompileTimeout, "编译超时")
	_, _, err := c.acquire(t.Context(), moduleKey{AppID: "a"}, func(context.Context) (compiledResult, *apperr.Error) {
		return compiledResult{}, want
	})
	if err == nil || err.Code != want.Code {
		t.Fatalf("loader 的错误必须原样传出，得到 %v", err)
	}
	if entries, _ := c.size(); entries != 0 {
		t.Fatalf("失败不应留下缓存条目，得到 %d", entries)
	}
}

func TestModuleCache_CloseAllClosesEntries(t *testing.T) {
	c := newModuleCache()
	mod := &fakeModule{name: "a"}
	_, release, err := c.acquire(t.Context(), moduleKey{AppID: "a"}, func(context.Context) (compiledResult, *apperr.Error) {
		return compiledResult{mod: mod, size: 1}, nil
	})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	release()
	if err := c.closeAll(); err != nil {
		t.Fatalf("closeAll: %v", err)
	}
	if !mod.closed.Load() {
		t.Fatal("closeAll 必须关闭每个模块")
	}
	if entries, bytes := c.size(); entries != 0 || bytes != 0 {
		t.Fatalf("closeAll 后记账应清零，得到 %d/%d", entries, bytes)
	}
}

// ===== 换票 URL：next 必须是相对路径且正确转义 =====

func TestTicketURLUsesRelativeNext(t *testing.T) {
	// 主站源不再缓存成字段（基域运行期可改）⇒ 用例按 Options 给当前基域。
	s := &Server{opt: Options{BaseDomain: func() string { return testBaseDomain }}}
	req := httptest.NewRequest(http.MethodGet, "https://app."+testBaseDomain+"/a/b?q=1&r=2&ticket=dead", nil)
	got := s.ticketURL(req, "expense")
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("ticketURL 不是合法 URL: %q", got)
	}
	if u.Scheme+"://"+u.Host != testMainOrigin {
		t.Fatalf("换票必须在主站: %q", got)
	}
	if u.Path != "/app-ticket" {
		t.Fatalf("换票路径不对: %q", got)
	}
	if u.Query().Get("app") != "expense" {
		t.Fatalf("app 参数不对: %q", got)
	}
	next := u.Query().Get("next")
	if next != "/a/b?q=1&r=2" {
		t.Fatalf("next 应保留其余参数并去掉 ticket，得到 %q", next)
	}
	// 关键：含 `&`/`=` 的相对路径必须被整体转义，否则会被解析成额外的 query 参数
	//（net/url 的 PathEscape 不转义 & 与 =，这是一个真实的坑）。
	if !strings.Contains(got, "next=%2Fa%2Fb%3Fq%3D1%26r%3D2") {
		t.Fatalf("next 必须整体转义（QueryEscape），得到 %q", got)
	}
}

func TestCleanRequestURI(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://app."+testBaseDomain+"/", nil)
	if got := cleanRequestURI(req); got != "/" {
		t.Fatalf("根路径应得到 /，得到 %q", got)
	}
	req2 := httptest.NewRequest(http.MethodGet, "https://app."+testBaseDomain+"/x?a=1&ticket=t", nil)
	if got := cleanRequestURI(req2); got != "/x?a=1" {
		t.Fatalf("应去掉 ticket，得到 %q", got)
	}
}

// 编译期断言：静态资源与动态响应的头策略都来自 edge（不复制规则）。
var _ = edge.MaxBodyBytes

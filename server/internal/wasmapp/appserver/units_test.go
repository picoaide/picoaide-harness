package appserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

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
		// 1xx 一律回落 200（F-7，2026-09-21）：它们是协议控制语义（100 让客户端继续等
		// body、101 触发协议切换、103 提前推头），不该由应用内容决定；且 WriteHeader(1xx)
		// 之后 http 仍允许再写一次头 ⇒ "一次响应一帧"的契约会在 HTTP 层被绕过。
		{"100 Continue 回落 200", http.StatusContinue, http.StatusOK},
		{"101 Switching Protocols 回落 200", http.StatusSwitchingProtocols, http.StatusOK},
		{"103 Early Hints 回落 200", http.StatusEarlyHints, http.StatusOK},
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

// TestWriteAppResponse_ContentTypeIsExplicitAndAllowlisted 是 F-13 的判据：
// 平台必须**显式**写出 content-type，且结果收口在 §4.8 的允许集合里。
//
// 修复前：应用没写（或被白名单剥掉）⇒ 头为空 ⇒ `net/http` 按前 512 字节隐式嗅探。
// 后果是"白名单被内容绕过"且行为随 Go 版本漂移；更隐蔽的是它在测试里不可见
// （隐式路径只在实际写出时发生，而单元测试用 httptest.Recorder 往往只看 Body）。
//
// 判据：
//   - 应用给了**允许集合内**的类型 ⇒ 逐字保留（不能被平台改写）；
//   - 应用没给 ⇒ 平台显式判定，HTML/纯文本按嗅探结果并补 charset，其余一律
//     `application/octet-stream`（含 Go 会认出的 application/pdf）；
//   - 应用给了**不在集合内**的类型 ⇒ 被白名单剥掉后走同一条显式判定，绝不落到
//     net/http 的隐式嗅探。
//
// 变异验证：删掉 respond.go 里的 `if h.Get("Content-Type") == ""` 兜底 ⇒
// 本用例的"没给 CT"与"给了非法 CT"两组立即红（Recorder 上不再有该头）。
func TestWriteAppResponse_ContentTypeIsExplicitAndAllowlisted(t *testing.T) {
	htmlBody := "<!DOCTYPE html><html><body>hi</body></html>"
	pdfBody := "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"

	cases := []struct {
		name      string
		headers   map[string]string
		body      string
		wantCT    string
		wantEmpty bool
	}{
		{"应用声明合法类型时逐字保留", map[string]string{"Content-Type": "application/json"}, `{"a":1}`, "application/json", false},
		{"应用声明 HTML 保留", map[string]string{"Content-Type": "text/html; charset=utf-8"}, htmlBody, "text/html; charset=utf-8", false},
		{"没给 CT + HTML 体 ⇒ 显式 text/html", nil, htmlBody, "text/html; charset=utf-8", false},
		{"没给 CT + 纯文本体 ⇒ 显式 text/plain", nil, "hello world", "text/plain; charset=utf-8", false},
		{"没给 CT + PDF 体 ⇒ 收口 octet-stream（Go 会认成 application/pdf，不在集合内）", nil, pdfBody, "application/octet-stream", false},
		{"非法 CT 被剥掉后同样显式判定", map[string]string{"Content-Type": "application/x-msdownload"}, htmlBody, "text/html; charset=utf-8", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{}
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "https://app.harness.example.com/", nil)
			s.writeAppResponse(rec, req, abi.Response{Status: http.StatusOK, Headers: tc.headers, Body: tc.body})
			got := rec.Header().Get("Content-Type")
			if tc.wantEmpty && got != "" {
				t.Fatalf("期望没有 Content-Type，实际 %q", got)
			}
			if !tc.wantEmpty && got != tc.wantCT {
				t.Fatalf("Content-Type = %q，期望 %q", got, tc.wantCT)
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

// ===== 发布期目录约定（assets_dir / release id）：**已随内存资源集取消** =====
//
// 旧用例 TestReleaseAssetID 断言 `releaseAssetID(rel)`（从 `app_releases.assets_dir`
// 或版本行 id 推出资源目录名，供 `assets.Open` 打开那个目录）——2026-09-20 起随包资源
// 改为从 wasm 自定义段 + 库内 config_json 构造的**内存**资源集
// （docs/decisions/2026-09-20-wasm-assets-in-memory.md）：
//
//   - 宿主盘上不再有"按版本抽取的资源目录"，因此没有目录名可推；
//   - `openAssets` / `releaseAssetID` 两个函数随本次改造一起从 serve.go 删除；
//   - `app_releases.assets_dir` 列保留（DB schema 不动）但**不再被任何代码读取**
//     —— 反向断言见 static_test.go 的 TestStatic_AssetsDirColumnIsIgnored。

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

// 编译期断言：静态资源与动态响应的头策略都来自 edge（不复制规则）。
var _ = edge.MaxBodyBytes

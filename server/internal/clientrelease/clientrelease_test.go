package clientrelease

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

const testSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// testInfo 造一份与 CI 同形状的资产清单(schema + channel_id + client.*)。
func testInfo(t *testing.T, version string, assets map[string]any) map[string]any {
	t.Helper()
	if assets == nil {
		assets = map[string]any{}
	}
	return map[string]any{
		"schema":     1,
		"channel_id": "official",
		"client":     map[string]any{"version": version, "assets": assets},
	}
}

// withReleaseDir 用临时目录充当镜像内的客户端资产目录。
func withReleaseDir(t *testing.T, info map[string]any, files map[string]string) {
	t.Helper()
	Dir = t.TempDir()
	t.Cleanup(func() { Dir = "/opt/picoaide/client" })
	if info != nil {
		raw, err := json.Marshal(info)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(Dir, "CLIENT-RELEASE.json"), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(Dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func newRouter(version string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	h := NewHandlers(func() string { return version }, "official")
	r := gin.New()
	r.GET("/api/client/v2/updates/manifest", h.Manifest)
	r.GET("/updates/client/*file", h.File)
	return r
}

func TestManifestPointsDownloadsAtThisServer(t *testing.T) {
	info := testInfo(t, "2.7.0", map[string]any{"win-x64": map[string]any{"file": "Setup.exe", "sha256": testSHA, "size": 42}})
	withReleaseDir(t, info, nil)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/client/v2/updates/manifest", nil)
	req.Host = "ai.example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	newRouter("2.7.0").ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	var got struct {
		ChannelID string                   `json:"channel_id"`
		Server    struct{ Version string } `json:"server"`
		Client    struct {
			Version string `json:"version"`
			Assets  map[string]struct {
				URL    string `json:"url"`
				SHA256 string `json:"sha256"`
				Size   int64  `json:"size"`
			} `json:"assets"`
		} `json:"client"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ChannelID != "official" || got.Client.Version != "2.7.0" {
		t.Errorf("channel/version = %q/%q", got.ChannelID, got.Client.Version)
	}
	// 关键:下载地址指向**本服务端**,不是外网更新服务器
	want := "https://ai.example.com/updates/client/Setup.exe"
	if a := got.Client.Assets["win-x64"]; a.URL != want {
		t.Errorf("asset url = %q, want %q", a.URL, want)
	}
}

// 镜像未带客户端资产时:清单仍 200 但无 assets(不是错误)。
func TestManifestWithoutAssets(t *testing.T) {
	withReleaseDir(t, nil, nil)
	w := httptest.NewRecorder()
	newRouter("2.7.0").ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/client/v2/updates/manifest", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if strings.Contains(w.Body.String(), "/updates/client/") {
		t.Errorf("no assets expected: %s", w.Body.String())
	}
}

// ---- 缺陷 1 回归(2026-09-10):下载地址必须是客户端可用的绝对 https ----
//
// 旧实现按 X-Forwarded-Proto 推 proto,非 "https" 一律回落 http;而客户端
// (packages/host/desktop/src/desktop-release.ts)只接受**绝对 https** URL,
// 一个 http 地址就让整份清单被判空 → 客户端静默显示"已是最新"。修法:
//   - PICOAI_PUBLIC_BASE_URL 配了就是唯一权威来源;
//   - 未配时只有 XFP:https / TLS / 回环 Host 三种情况能给出安全地址;
//   - 其它情况不下发 client 段,改下发 client_unavailable 并在服务端告警一次。

// oneAsset 造一份单平台(win-x64)资产清单。
func oneAsset(t *testing.T) map[string]any {
	t.Helper()
	return testInfo(t, "2.7.0", map[string]any{
		"win-x64": map[string]any{"file": "Setup.exe", "sha256": testSHA, "size": 42},
	})
}

// getManifest 请求清单并按 map 解析(便于断言"字段缺失")。
func getManifest(t *testing.T, r *gin.Engine, mutate func(*http.Request)) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/client/v2/updates/manifest", nil)
	if mutate != nil {
		mutate(req)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v (%s)", err, w.Body.String())
	}
	return body
}

// assetURL 取 client.assets[key].url;client 段缺失时返回空。
func assetURL(body map[string]any, key string) string {
	client, _ := body["client"].(map[string]any)
	assets, _ := client["assets"].(map[string]any)
	entry, _ := assets[key].(map[string]any)
	url, _ := entry["url"].(string)
	return url
}

// captureOriginWarnings 接管来源告警出口,返回计数(验证"每进程只告警一次")。
func captureOriginWarnings(t *testing.T) *int {
	t.Helper()
	var n int
	prevWarn := logWarn
	logWarn = func(string, ...any) { n++ }
	originWarnMu.Lock()
	prevWarned := originWarned
	originWarned = false
	originWarnMu.Unlock()
	t.Cleanup(func() {
		logWarn = prevWarn
		originWarnMu.Lock()
		originWarned = prevWarned
		originWarnMu.Unlock()
	})
	return &n
}

// PICOAI_PUBLIC_BASE_URL 是唯一权威来源:去掉尾斜杠、保留子路径、压过请求头推断。
func TestManifestUsesPublicBaseURLAsAuthority(t *testing.T) {
	withReleaseDir(t, oneAsset(t), nil)
	r := newRouter("2.7.0")

	cases := []struct {
		name string
		base string
		want string
	}{
		{"根地址", "https://ai.example.com/", "https://ai.example.com/updates/client/Setup.exe"},
		{"子路径", "https://ai.example.com/picoaide/", "https://ai.example.com/picoaide/updates/client/Setup.exe"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(PublicBaseURLEnv, tc.base)
			// 故意给一组"看起来是内网 http"的请求头:权威来源必须压过它。
			got := assetURL(getManifest(t, r, func(req *http.Request) {
				req.Host = "10.0.0.9:8080"
				req.Header.Set("X-Forwarded-Proto", "http")
			}), "win-x64")
			if got != tc.want {
				t.Fatalf("asset url = %q, want %q", got, tc.want)
			}
		})
	}
}

// 显式配置非法/不安全时不下发任何链接(而不是回落请求头推断)。
func TestManifestRejectsInvalidPublicBaseURL(t *testing.T) {
	withReleaseDir(t, oneAsset(t), nil)
	r := newRouter("2.7.0")

	for _, bad := range []string{
		"https://ai.example.com/?x=1",  // query
		"https://ai.example.com/#frag", // fragment
		"ai.example.com",               // 不是绝对地址
		"ftp://ai.example.com",         // 非 http(s)
		"http://ai.example.com",        // 非 https 且非回环:客户端会丢弃
	} {
		t.Run(bad, func(t *testing.T) {
			t.Setenv(PublicBaseURLEnv, bad)
			body := getManifest(t, r, func(req *http.Request) {
				req.Host = "ai.example.com"
				req.Header.Set("X-Forwarded-Proto", "https") // 请求头安全也不能救回非法配置
			})
			if _, ok := body["client"]; ok {
				t.Fatalf("非法 %s 时不得下发 client 段: %v", PublicBaseURLEnv, body)
			}
			reason, _ := body["client_unavailable"].(string)
			if !strings.Contains(reason, PublicBaseURLEnv) {
				t.Fatalf("client_unavailable = %q, want 提示 %s", reason, PublicBaseURLEnv)
			}
			if strings.Contains(reason, "/updates/client/") {
				t.Fatalf("原因里不该有链接: %q", reason)
			}
		})
	}
}

// 无法提供安全地址:不下发 client 段,改下发明确原因,且**绝不含链接**。
func TestManifestWithoutSecureOriginOmitsClientSection(t *testing.T) {
	withReleaseDir(t, oneAsset(t), nil)
	t.Setenv(PublicBaseURLEnv, "")
	warns := captureOriginWarnings(t)
	r := newRouter("2.7.0")

	body := getManifest(t, r, func(req *http.Request) {
		req.Host = "ai.example.com" // 非回环 + 无 XFP + 无 TLS
		req.Header.Set("X-Forwarded-Proto", "http")
	})

	if _, ok := body["client"]; ok {
		t.Fatalf("不安全来源下不得下发 client 段: %v", body)
	}
	reason, _ := body["client_unavailable"].(string)
	if reason == "" {
		t.Fatalf("缺少 client_unavailable: %v", body)
	}
	if strings.Contains(reason, "/updates/client/") {
		t.Fatalf("原因里不该有链接: %q", reason)
	}
	if body["channel_id"] != "official" || body["schema"] != float64(1) {
		t.Fatalf("服务端段必须照常下发: %v", body)
	}
	// 每进程只告警一次:再来两次请求也不该重复刷屏。
	getManifest(t, r, func(req *http.Request) { req.Host = "ai.example.com" })
	getManifest(t, r, func(req *http.Request) { req.Host = "ai2.example.com" })
	if *warns != 1 {
		t.Fatalf("告警次数 = %d, want 1(每进程一次)", *warns)
	}
}

// 回环 Host 允许 http(本地开发);https 信号直接给 https。
func TestManifestSecureOriginDetection(t *testing.T) {
	withReleaseDir(t, oneAsset(t), nil)
	t.Setenv(PublicBaseURLEnv, "")
	r := newRouter("2.7.0")

	secure := []struct {
		name   string
		host   string
		xfp    string
		useTLS bool
		want   string
	}{
		{"XFP https", "ai.example.com", "https", false, "https://ai.example.com/updates/client/Setup.exe"},
		{"TLS 直连", "ai.example.com", "", true, "https://ai.example.com/updates/client/Setup.exe"},
		{"回环 127.0.0.1", "127.0.0.1:8080", "", false, "http://127.0.0.1:8080/updates/client/Setup.exe"},
		{"回环 localhost", "localhost", "", false, "http://localhost/updates/client/Setup.exe"},
		{"回环 [::1]", "[::1]:9000", "", false, "http://[::1]:9000/updates/client/Setup.exe"},
		{"回环 ::1", "::1", "", false, "http://::1/updates/client/Setup.exe"},
	}
	for _, tc := range secure {
		t.Run(tc.name, func(t *testing.T) {
			got := assetURL(getManifest(t, r, func(req *http.Request) {
				req.Host = tc.host
				if tc.xfp != "" {
					req.Header.Set("X-Forwarded-Proto", tc.xfp)
				}
				if tc.useTLS {
					req.TLS = &tls.ConnectionState{}
				}
			}), "win-x64")
			if got != tc.want {
				t.Fatalf("asset url = %q, want %q", got, tc.want)
			}
		})
	}

	// 非回环 + 无 https 信号 → 不可用(旧实现会给 http 链接,被客户端静默丢弃)
	body := getManifest(t, r, func(req *http.Request) { req.Host = "ai.example.com" })
	if _, ok := body["client"]; ok {
		t.Fatalf("非回环 http 不得下发 client 段: %v", body)
	}
}

// 来源判定的纯函数表(解耦 gin 请求对象,覆盖边界)。
func TestResolveOrigin(t *testing.T) {
	cases := []struct {
		name string
		env  string
		in   originInput
		want string // 期望来源;空 = 不可用
	}{
		{"未配且无 https 信号", "", originInput{Host: "ai.example.com"}, ""},
		{"未配且 XFP=http", "", originInput{ForwardedProto: "http", Host: "ai.example.com"}, ""},
		{"未配无 Host", "", originInput{ForwardedProto: "https"}, ""},
		{"未配 XFP=https", "", originInput{ForwardedProto: "https", Host: "ai.example.com"}, "https://ai.example.com"},
		{"未配 TLS", "", originInput{TLS: true, Host: "ai.example.com:8443"}, "https://ai.example.com:8443"},
		{"未配回环", "", originInput{Host: "127.0.0.1"}, "http://127.0.0.1"},
		{"配置 https", "https://ai.example.com/", originInput{Host: "ai.example.com"}, "https://ai.example.com"},
		{"配置子路径", "https://ai.example.com/picoaide", originInput{Host: "x"}, "https://ai.example.com/picoaide"},
		{"配置回环 http", "http://127.0.0.1:9000", originInput{ForwardedProto: "https", Host: "ai.example.com"}, "http://127.0.0.1:9000"},
		{"配置非回环 http", "http://ai.example.com", originInput{Host: "ai.example.com"}, ""},
		{"配置带 query", "https://ai.example.com/?a=1", originInput{Host: "ai.example.com"}, ""},
		{"配置带 fragment", "https://ai.example.com/#a", originInput{Host: "ai.example.com"}, ""},
		{"配置相对地址", "ai.example.com", originInput{Host: "ai.example.com"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(PublicBaseURLEnv, tc.env)
			got := resolveOrigin(tc.in)
			if got.Base != tc.want {
				t.Fatalf("resolveOrigin(%+v) = %q (reason %q), want %q", tc.in, got.Base, got.Reason, tc.want)
			}
			if tc.want == "" {
				if got.OK() || got.Reason == "" {
					t.Fatalf("不可用时必须给出原因: %+v", got)
				}
				if strings.Contains(got.Reason, "://") && !strings.Contains(got.Reason, PublicBaseURLEnv) {
					t.Fatalf("原因不该带链接: %q", got.Reason)
				}
			} else if got.Reason != "" {
				t.Fatalf("可用时不该有原因: %+v", got)
			}
		})
	}
}

// ---- 缺陷 2 回归(2026-09-10):只服务白名单扩展名的普通文件 ----
//
// 旧实现只拒空名与路径分隔符,name=".." / "." 会命中目录,
// http.ServeFile 于是返回**目录列表**(曾实测可列出资产目录的父目录文件名)。

func TestFileServesOnlyWhitelistedRegularFiles(t *testing.T) {
	withReleaseDir(t, testInfo(t, "2.7.0", nil), map[string]string{
		"PicoAide-2.7.0.dmg": "dmg",
		"PicoAide-2.7.0.DMG": "DMG",
		"Setup-2.7.0.exe":    "exe",
		"PicoAide-2.7.0.msi": "msi",
		"app.AppImage":       "appimage",
		"pkg.tar.gz":         "targz",
		"picoaide.deb":       "deb",
		"mac.pkg":            "pkg",
		"win.zip":            "zip",
		"notes.txt":          "txt",
	})
	// 资产目录里的子目录(目录探测的目标)。
	if err := os.Mkdir(filepath.Join(Dir, "downloads"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := newRouter("2.7.0")

	cases := []struct {
		name string
		path string
		want int
	}{
		{"点目录", "/updates/client/.", http.StatusNotFound},
		{"双点目录", "/updates/client/..", http.StatusNotFound},
		{"双点穿越", "/updates/client/../x", http.StatusNotFound},
		{"子路径", "/updates/client/a/b", http.StatusNotFound},
		{"含双点的合法扩展名", "/updates/client/..dmg", http.StatusNotFound},
		{"反斜杠", `/updates/client/a\x.dmg`, http.StatusNotFound},
		{"非白名单扩展名", "/updates/client/notes.txt", http.StatusNotFound},
		{"清单文件", "/updates/client/CLIENT-RELEASE.json", http.StatusNotFound},
		{"目录名", "/updates/client/downloads", http.StatusNotFound},
		{"不存在", "/updates/client/nope.dmg", http.StatusNotFound},
		{"合法 dmg", "/updates/client/PicoAide-2.7.0.dmg", http.StatusOK},
		{"扩展名大小写不敏感", "/updates/client/PicoAide-2.7.0.DMG", http.StatusOK},
		{"合法 exe", "/updates/client/Setup-2.7.0.exe", http.StatusOK},
		{"合法 msi", "/updates/client/PicoAide-2.7.0.msi", http.StatusOK},
		{"合法 AppImage", "/updates/client/app.AppImage", http.StatusOK},
		{"合法 tar.gz", "/updates/client/pkg.tar.gz", http.StatusOK},
		{"合法 deb", "/updates/client/picoaide.deb", http.StatusOK},
		{"合法 pkg", "/updates/client/mac.pkg", http.StatusOK},
		{"合法 zip", "/updates/client/win.zip", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if w.Code != tc.want {
				t.Fatalf("GET %s = %d, want %d", tc.path, w.Code, tc.want)
			}
			if tc.want == http.StatusNotFound && !strings.Contains(w.Body.String(), `"error"`) {
				t.Fatalf("GET %s 非 JSON 错误信封: %s", tc.path, w.Body.String())
			}
			// 目录列表是旧的失败模式:任何响应都不得带 index/目录标记
			if strings.Contains(w.Body.String(), "CLIENT-RELEASE.json") {
				t.Fatalf("GET %s 泄露了目录内容: %s", tc.path, w.Body.String())
			}
		})
	}
}

func TestFileServesAndSupportsRange(t *testing.T) {
	body := strings.Repeat("PA", 512)
	withReleaseDir(t, testInfo(t, "2.7.0", nil), map[string]string{"ok.exe": body})
	r := newRouter("2.7.0")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/updates/client/ok.exe", nil))
	if w.Code != http.StatusOK || w.Body.String() != body {
		t.Fatalf("status=%d len=%d", w.Code, w.Body.Len())
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q, want immutable", cc)
	}

	w2 := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/updates/client/ok.exe", nil)
	req.Header.Set("Range", "bytes=0-9")
	r.ServeHTTP(w2, req)
	if w2.Code != http.StatusPartialContent || w2.Body.String() != body[:10] {
		t.Fatalf("range status=%d body=%q", w2.Code, w2.Body.String())
	}
}

// 不存在的文件与路径穿越一律 404 + JSON 信封。
func TestFileRejectsMissingAndTraversal(t *testing.T) {
	withReleaseDir(t, testInfo(t, "2.7.0", nil), map[string]string{"ok.exe": "x"})
	r := newRouter("2.7.0")
	for _, path := range []string{"/updates/client/nope.exe", "/updates/client/", "/updates/client/../x"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, w.Code)
		}
		if !strings.Contains(w.Body.String(), `"error"`) {
			t.Errorf("%s: 非 JSON 错误信封: %s", path, w.Body.String())
		}
	}
}

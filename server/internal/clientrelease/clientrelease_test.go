package clientrelease

import (
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

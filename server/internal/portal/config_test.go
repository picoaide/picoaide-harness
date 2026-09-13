package portal

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 审计 R7 srvcore-3:PUT /api/server/admin/portal 必须是**真正的部分更新**。
//
// 原实现 `ShouldBindJSON(&body Config)` 把请求体解码进一个零值 Config 再整份
// SaveConfig:没提供的字段不是"保持原值",而是被 Go 零值 false/"" 覆盖 ——
// 一次「只改 Windows 下载地址」的 PUT 就把 public/enabled 打成 false,
// 公开门户当场变成 302 → /admin/(可用性事故,且 PUT 响应体就回显了 false)。
// ---------------------------------------------------------------------------

// portalAdminRouter 按生产装配挂门户管理端点(真库:无 PG 时 NewTestDB 自行 skip)。
func portalAdminRouter(t *testing.T) (*gin.Engine, *sql.DB) {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	h := NewAdminHandlers(db)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/portal", h.Get)
	r.PUT("/portal", h.Put)
	return r, db
}

func putPortalRaw(t *testing.T, r *gin.Engine, body string) []byte {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/portal", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT %s = %d, want 200; body=%s", body, w.Code, w.Body.String())
	}
	return w.Body.Bytes()
}

func putPortal(t *testing.T, r *gin.Engine, body string) Config {
	t.Helper()
	var got Config
	if err := json.Unmarshal(putPortalRaw(t, r, body), &got); err != nil {
		t.Fatalf("PUT %s 响应不是门户配置 JSON: %v", body, err)
	}
	return got
}

func getPortalRaw(t *testing.T, r *gin.Engine) []byte {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/portal", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /portal = %d, want 200", w.Code)
	}
	return w.Body.Bytes()
}

func getPortal(t *testing.T, r *gin.Engine) Config {
	t.Helper()
	var got Config
	if err := json.Unmarshal(getPortalRaw(t, r), &got); err != nil {
		t.Fatalf("GET /portal 响应不是门户配置 JSON: %v", err)
	}
	return got
}

// 只提供部分字段时,其余字段按库里的现值保持(而不是被零值覆盖)。
func TestPutPortalKeepsUnspecifiedFields(t *testing.T) {
	r, _ := portalAdminRouter(t)

	base := putPortal(t, r, `{
      "enabled": true, "public": true, "subtitle": "副标题",
      "client_download_url": "https://legacy.example.com/setup.exe",
      "client_download_linux": "https://cdn.example.com/linux.AppImage",
      "client_download_mac": "https://cdn.example.com/mac.dmg",
      "client_download_win": "https://cdn.example.com/win.exe",
      "client_download_note": "安装包暂未签名",
      "landing_path": "/usage"
    }`)

	// 只改 Windows 下载地址 —— 这是运维最常做的一次 PUT。
	got := putPortal(t, r, `{"client_download_win":"https://cdn2.example.com/win.exe"}`)

	if !got.Public {
		t.Fatal("部分更新把 public 打成 false:公开门户会被下线(/ → 302 /admin/)")
	}
	if !got.Enabled {
		t.Fatal("部分更新把 enabled 打成 false")
	}
	if got.ClientDownloadWin != "https://cdn2.example.com/win.exe" {
		t.Fatalf("本次提供的字段没生效: %q", got.ClientDownloadWin)
	}
	for name, pair := range map[string][2]string{
		"client_download_url":   {got.ClientDownloadURL, base.ClientDownloadURL},
		"client_download_linux": {got.ClientDownloadLinux, base.ClientDownloadLinux},
		"client_download_mac":   {got.ClientDownloadMac, base.ClientDownloadMac},
		"client_download_note":  {got.ClientDownloadNote, base.ClientDownloadNote},
		"subtitle":              {got.Subtitle, base.Subtitle},
		"landing_path":          {got.LandingPath, base.LandingPath},
	} {
		if pair[0] != pair[1] {
			t.Fatalf("未提供的字段 %s 被改掉了: %q → %q", name, pair[1], pair[0])
		}
	}

	// 回读(GET)必须与 PUT 响应一致 —— 避免"响应看着对、库里其实被清零"。
	if reread := getPortal(t, r); reread != got {
		t.Fatalf("GET 回读与 PUT 响应不一致:\n PUT  = %+v\n GET  = %+v", got, reread)
	}
}

// 显式提供的 false / 空串必须照常生效(部分更新 != 忽略 false)。
func TestPutPortalAppliesExplicitFalseAndEmpty(t *testing.T) {
	r, _ := portalAdminRouter(t)
	putPortal(t, r, `{"public": true, "enabled": true, "client_download_note": "x"}`)

	off := putPortal(t, r, `{"public": false}`)
	if off.Public {
		t.Fatal("显式 public=false 未生效")
	}
	// 再改别的字段:public=false 必须保持(它已被显式设置过)。
	again := putPortal(t, r, `{"client_download_win": "https://cdn.example.com/win.exe"}`)
	if again.Public {
		t.Fatal("public=false 被后续的部分更新重置回 true")
	}
	// 显式空串同样生效(清空说明文字)。
	cleared := putPortal(t, r, `{"client_download_note": ""}`)
	if cleared.ClientDownloadNote != "" {
		t.Fatalf("显式空串未生效: %q", cleared.ClientDownloadNote)
	}
}

// ---------------------------------------------------------------------------
// 审计 R7-RV-7:enabled / landing_path 是**没有任何消费方**的死开关 ——
// cmd/server 的 servePortal 只读 portal.public,文档却教运维用 portal.enabled
// 下线门户。字段不能删(webadmin 契约 + 部分更新语义),但 API 必须自描述:
// GET 与 PUT 响应都带上 reserved_fields / reserved_note,告诉调用方这两个键
// 只是被接受并回显、尚未生效,真正的下线开关是 public=false。
// ---------------------------------------------------------------------------
func TestPortalConfigAPIDeclaresUnwiredFieldsAsReserved(t *testing.T) {
	r, _ := portalAdminRouter(t)

	// assertReserved 校验任一响应:清单与 Go 侧单一真源一致、说明非空且点名 public。
	assertReserved := func(endpoint string, raw []byte) {
		t.Helper()
		var env struct {
			ReservedFields []string `json:"reserved_fields"`
			ReservedNote   string   `json:"reserved_note"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("%s 响应不是 JSON: %v; body=%s", endpoint, err, raw)
		}
		if got, want := strings.Join(env.ReservedFields, ","), strings.Join(ReservedFields(), ","); got != want {
			t.Fatalf("%s 的 reserved_fields = %v, want %v(必须来自同一份 Go 定义)", endpoint, env.ReservedFields, ReservedFields())
		}
		if got, want := strings.Join(env.ReservedFields, ","), "enabled,landing_path"; got != want {
			t.Fatalf("%s 的 reserved_fields = %v, want [enabled landing_path]", endpoint, env.ReservedFields)
		}
		if strings.TrimSpace(env.ReservedNote) == "" {
			t.Fatalf("%s 的 reserved_note 为空:调用方需要知道这些字段为什么无效、该用什么开关", endpoint)
		}
		if !strings.Contains(env.ReservedNote, "public=false") {
			t.Fatalf("%s 的 reserved_note 未指明真正的下线开关(public=false): %q", endpoint, env.ReservedNote)
		}
		// 清单必须诚实:列出的键真的在响应顶层(被接受并回显),不是凭空声明。
		var keys map[string]json.RawMessage
		if err := json.Unmarshal(raw, &keys); err != nil {
			t.Fatalf("%s 响应不是 JSON 对象: %v", endpoint, err)
		}
		for _, f := range env.ReservedFields {
			if _, ok := keys[f]; !ok {
				t.Fatalf("%s 把 %q 列为保留字段,但响应里没有这个键(清单在说谎)", endpoint, f)
			}
		}
	}

	assertReserved("GET /portal", getPortalRaw(t, r))

	// PUT 用**同样的清单**(单一真源,两端不可能漂移);请求体只给两个保留字段,
	// 且显式 false 仍照常回显(保留 != 拒绝)。
	putRaw := putPortalRaw(t, r, `{"enabled": false, "landing_path": "/usage"}`)
	assertReserved("PUT /portal", putRaw)

	// 契约保持:字段被"接受并回显",不是被拒绝或忽略。
	var echo struct {
		Enabled     *bool   `json:"enabled"`
		Public      *bool   `json:"public"`
		LandingPath *string `json:"landing_path"`
	}
	if err := json.Unmarshal(putRaw, &echo); err != nil {
		t.Fatalf("PUT 响应不是门户配置 JSON: %v; body=%s", err, putRaw)
	}
	if echo.Enabled == nil || *echo.Enabled {
		t.Fatalf("PUT enabled=false 必须原样回显 false(保留 != 拒绝),实际: %v", echo.Enabled)
	}
	if echo.LandingPath == nil || *echo.LandingPath != "/usage" {
		t.Fatalf("PUT landing_path 必须原样回显(保留 != 拒绝),实际: %v", echo.LandingPath)
	}
	if echo.Public == nil || !*echo.Public {
		t.Fatalf("PUT 没提供 public,回显必须保持现值 true(部分更新语义),实际: %v", echo.Public)
	}
	// 回读:值真的落库,且 public 未被 enabled/landing_path 的部分更新带偏。
	cfg := getPortal(t, r)
	if cfg.Enabled {
		t.Fatal("显式 enabled=false 未落库(round-trip 契约回归)")
	}
	if cfg.LandingPath != "/usage" {
		t.Fatalf("显式 landing_path 未落库: %q", cfg.LandingPath)
	}
	if !cfg.Public {
		t.Fatal("PUT enabled/landing_path 时把 public 带成 false(部分更新语义回归)")
	}
}

// 非法 JSON 仍然 400(部分更新不放松入参校验)。
func TestPutPortalRejectsMalformedBody(t *testing.T) {
	r, _ := portalAdminRouter(t)
	req := httptest.NewRequest(http.MethodPut, "/portal", strings.NewReader(`{"public": `))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("PUT 非法 JSON = %d, want 400", w.Code)
	}
}

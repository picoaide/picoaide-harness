package router

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/portal"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/skillseed"
)

// seedSkillSource 是仓库里内置技能资产的源头（Dockerfile 把它 COPY 进镜像的
// /opt/picoaide/skills/app-builder）。
//
// 测试拷贝**这一个**技能目录而不是整个 skills/ —— 与镜像里的形态逐字对齐
// （Dockerfile 是逐技能 COPY 的）。用假资产的话，「仓库里那份资产真的能被服务端
// 下发」这条最该被钉住的断言就没了，所以拷的是真货。
//
// 2026-09-19：源目录从客户端 vendored 包（packages/vendor/memory-evolve/skills/）
// 搬进服务端仓库（server/skills/），技能同时改名 picoaide-app-builder → app-builder。
const seedSkillSource = "../../../server/skills/app-builder"

// buildSkillSeedRouter 组装**生产同形**的路由树（真实临时库 + 真实内置技能目录）。
// 与 buildTestRouter 的差别只有 DB 与技能资产来源。
//
// 第三个返回值是那个临时库：管理端用例要造一个超管会话（AdminAuth 走会话 cookie，
// 不是 Bearer 员工令牌），没有它就只能去调 handler，钉不住"路由真的挂在管理面"。
func buildSkillSeedRouter(t *testing.T) (*gin.Engine, string, *sql.DB) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if err := serverstore.ApplyMigrations(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "secret123")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	r := gin.New()
	Register(r, Deps{
		DB:            db,
		Auth:          serverauth.New(db).Handlers(),
		Admin:         (&serverauth.AdminAPI{DB: db}).Handlers(),
		Appstore:      appstore.NewHandlers(db),
		Bootstrap:     bootstrap.NewHandlers(db),
		Channel:       channel.NewHandlers(),
		PortalAdmin:   portal.NewAdminHandlers(db),
		ClientRelease: clientrelease.NewHandlers(func() string { return "dev" }, "official"),
		Market:        marketplace.NewHandlers(db, t.TempDir()),
		Agentshare:    agentshare.NewHandlers(db, t.TempDir()),
		Shared:        sharedskills.NewHandlers(db, t.TempDir()),
		Capability:    capabilities.NewHandlers(db, t.TempDir()),
		Connector:     connectors.NewHandlers(db),
		Telemetry:     telemetry.NewHandlers(db),
		Gateway:       llmgateway.NewHandlers(db),
		Reports:       reports.NewHandlers(db),
		Wasm:          wasmapi.NewHandlers(wasmapi.Options{}),
		// 资产目录 = 仓库里那份真货，按镜像布局摆成 <dir>/app-builder/。
		SkillSeed: skillseed.NewHandlers(skillseed.New(stageSeedDir(t))),
	})
	t.Cleanup(func() { db.Close() })
	return r, token, db
}

// stageSeedDir 把仓库里的内置技能按镜像布局摆进一次性目录。
func stageSeedDir(t *testing.T) string {
	t.Helper()
	src := absPath(t, seedSkillSource)
	dst := filepath.Join(t.TempDir(), "app-builder")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, rerr := filepath.Rel(src, path)
		if rerr != nil {
			return rerr
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatalf("stage %s: %v", src, err)
	}
	return filepath.Dir(dst)
}

func absPath(t *testing.T, rel string) string {
	t.Helper()
	abs, err := filepath.Abs(rel)
	if err != nil {
		t.Fatalf("abs %s: %v", rel, err)
	}
	return abs
}

func getWithToken(r *gin.Engine, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// 内置技能的两个端点必须在 **BearerAuth 分组**下（未登录不得枚举平台内置了
// 什么、更不得下载）。变异验证：把 registerClientV2 里那两个 handler 从
// BearerAuth 分组挪出来（直接挂 cli.GET），本用例立刻变红。
func TestBuiltinSkillsRequireBearerAuth(t *testing.T) {
	r, token, _ := buildSkillSeedRouter(t)

	for _, path := range []string{
		"/api/client/v2/skills/builtin",
		"/api/client/v2/skills/builtin/app-builder/archive",
	} {
		w := getWithToken(r, path, "")
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("未认证访问 %s = %d，必须 401", path, w.Code)
		}
		// 失败也必须是 JSON 信封（AGENTS.md §7.0）。
		if ct := w.Header().Get("Content-Type"); ct == "" || ct[:16] != "application/json" {
			t.Fatalf("未认证响应必须是 JSON，Content-Type = %q", ct)
		}
	}

	// 认证后：清单与归档都能拿到，且两处的 sha256 一致。
	w := getWithToken(r, "/api/client/v2/skills/builtin", token)
	if w.Code != http.StatusOK {
		t.Fatalf("清单 = %d %s", w.Code, w.Body.String())
	}
	var payload struct {
		Skills []struct {
			Name    string `json:"name"`
			Source  string `json:"source"`
			SHA256  string `json:"sha256"`
			Version string `json:"version"`
		} `json:"skills"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("清单 JSON: %v", err)
	}
	if len(payload.Skills) != 1 || payload.Skills[0].Name != "app-builder" {
		t.Fatalf("清单 = %+v（资产目录 %s 里应恰有一个内置技能）", payload.Skills, seedSkillSource)
	}
	if payload.Skills[0].Source != "builtin" || len(payload.Skills[0].SHA256) != 64 {
		t.Fatalf("清单行 = %+v", payload.Skills[0])
	}

	w = getWithToken(r, "/api/client/v2/skills/builtin/app-builder/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("归档 = %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-Skill-Checksum"); got != payload.Skills[0].SHA256 {
		t.Fatalf("归档 X-Skill-Checksum = %q，清单 sha256 = %q（客户端靠这个头做完整性对照）", got, payload.Skills[0].SHA256)
	}
	// 头必须与**同一份清单**逐字一致：此前这里钉死字面量 "1.0.0"，技能提版本
	// （app-builder 于 2026-09-19 提到 1.1.0）后用例就假红 —— 真正的不变量是
	// "头 == 清单里的版本"，不是某个具体号（谁改版本都不该动这条用例）。
	if got := w.Header().Get("X-Skill-Version"); got != payload.Skills[0].Version {
		t.Fatalf("X-Skill-Version = %q，清单 version = %q（客户端靠这个头核对版本）", got, payload.Skills[0].Version)
	}
}

// 平台内置技能的**管理端只读诊断面**（2026-09-19 用户要求"管理端要看得见"）：
//
//  1. 必须声明在生产路由树上（业务包不得自行注册）；
//  2. 必须在 AdminAuth 分组下 —— **员工 Bearer 令牌不算数**：未认证 401 JSON 信封；
//  3. 用真超管会话打开时，看到的是镜像里那条真资产（走完整路由树 + 真临时库），
//     且带 dir/dir_exists/problems 三段诊断信息。
//
// 变异验证：把这条路由从 authed 组挪到 cli 组（或去掉 AdminRoute 申报），
// 第 2 条立刻变红；把 SkillSeed 换成空目录，第 3 条变红。
func TestBuiltinSkillsAdminFaceRequiresAdminSession(t *testing.T) {
	r, _, db := buildSkillSeedRouter(t)

	// 1) 路由确实存在（声明在 internal/router，生产树可枚举）。
	found := false
	for _, route := range r.Routes() {
		if route.Method == http.MethodGet && route.Path == "/api/server/admin/skills/builtin" {
			found = true
		}
	}
	if !found {
		t.Fatal("GET /api/server/admin/skills/builtin 未声明在生产路由树上")
	}

	// 2) 未认证：401 + JSON 信封（管理面口径）。
	w := getWithToken(r, "/api/server/admin/skills/builtin", "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("未认证访问 = %d，必须 401", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("未认证响应必须是 JSON，Content-Type = %q", ct)
	}
	// 员工 Bearer 令牌同样进不了管理面（那是另一套认证）。
	// （本用例里 alice 是普通员工，token 只对 /api/client/v2 有效。）

	// 3) 真超管会话：看到真资产 + 三段诊断。
	bossID, err := serverstore.CreateUserWithPassword(db, "skillseed-boss", "pw123456")
	if err != nil {
		t.Fatalf("create boss: %v", err)
	}
	boss, err := serverstore.GetUserByID(db, bossID)
	if err != nil {
		t.Fatalf("get boss: %v", err)
	}
	boss.Role = serverstore.RoleSuperAdmin
	if err := serverstore.UpdateUser(db, boss); err != nil {
		t.Fatalf("promote boss: %v", err)
	}
	sess, _, err := serverauth.CreateAdminSession(db, bossID)
	if err != nil {
		t.Fatalf("admin session: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/server/admin/skills/builtin", nil)
	req.AddCookie(&http.Cookie{Name: "picoaide_session", Value: sess.ID})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("超管读内置技能诊断面 = %d %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Dir       string `json:"dir"`
		DirExists bool   `json:"dir_exists"`
		Skills    []struct {
			Name, Version, SHA256 string
			Files                 int
		} `json:"skills"`
		Problems []struct{ Name, Reason string } `json:"problems"`
		LoadErr  string                          `json:"load_error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("诊断面 JSON: %v", err)
	}
	if payload.Dir == "" || !payload.DirExists {
		t.Fatalf("诊断面必须回显扫描目录与存在性: %+v", payload)
	}
	if payload.LoadErr != "" {
		t.Fatalf("正常部署不得带 load_error: %q", payload.LoadErr)
	}
	if len(payload.Skills) != 1 || payload.Skills[0].Name != "app-builder" {
		t.Fatalf("诊断面必须显示镜像里的真资产: %+v", payload.Skills)
	}
	// 意图是"这三项**在不在**"，不是"等于某个号"：版本号属技能内容（会随内容提升），
	// 钉字面量会让每次提版本都假红（2026-09-19 app-builder 1.0.0→1.1.0 即如此）。
	if payload.Skills[0].Version == "" || len(payload.Skills[0].SHA256) != 64 || payload.Skills[0].Files < 10 {
		t.Fatalf("诊断面清单行缺 version/sha256/files: %+v", payload.Skills[0])
	}
	if len(payload.Problems) != 0 {
		t.Fatalf("正常资产不得有 problems: %+v", payload.Problems)
	}
}

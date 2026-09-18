package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	"github.com/picoaide/picoaide/internal/wasmapp/session"
	"github.com/picoaide/picoaide/internal/wasmapp/skillseed"
)

// seedSkillSource 是仓库里内置技能资产的源头（Dockerfile 把它 COPY 进镜像的
// /opt/picoaide/skills/picoaide-app-builder）。
//
// 测试拷贝**这一个**技能目录而不是整个 skills/ —— 与镜像里的形态逐字对齐
// （Dockerfile 是逐技能 COPY 的：那个目录里另外 5 个是随客户端分发的 COI 适配器
// 技能，不是平台内置技能）。用假资产的话，「仓库里那份资产真的能被服务端下发」
// 这条最该被钉住的断言就没了，所以拷的是真货。
const seedSkillSource = "../../../packages/vendor/memory-evolve/skills/picoaide-app-builder"

// buildSkillSeedRouter 组装**生产同形**的路由树（真实临时库 + 真实内置技能目录）。
// 与 buildTestRouter 的差别只有 DB 与技能资产来源。
func buildSkillSeedRouter(t *testing.T) (*gin.Engine, string) {
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
		WasmSession:   session.New(session.Options{}),
		// 资产目录 = 仓库里那份真货，按镜像布局摆成 <dir>/picoaide-app-builder/。
		SkillSeed: skillseed.NewHandlers(skillseed.New(stageSeedDir(t))),
	})
	t.Cleanup(func() { db.Close() })
	return r, token
}

// stageSeedDir 把仓库里的内置技能按镜像布局摆进一次性目录。
func stageSeedDir(t *testing.T) string {
	t.Helper()
	src := absPath(t, seedSkillSource)
	dst := filepath.Join(t.TempDir(), "picoaide-app-builder")
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
	r, token := buildSkillSeedRouter(t)

	for _, path := range []string{
		"/api/client/v2/skills/builtin",
		"/api/client/v2/skills/builtin/picoaide-app-builder/archive",
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
			Name   string `json:"name"`
			Source string `json:"source"`
			SHA256 string `json:"sha256"`
		} `json:"skills"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("清单 JSON: %v", err)
	}
	if len(payload.Skills) != 1 || payload.Skills[0].Name != "picoaide-app-builder" {
		t.Fatalf("清单 = %+v（资产目录 %s 里应恰有一个内置技能）", payload.Skills, seedSkillSource)
	}
	if payload.Skills[0].Source != "builtin" || len(payload.Skills[0].SHA256) != 64 {
		t.Fatalf("清单行 = %+v", payload.Skills[0])
	}

	w = getWithToken(r, "/api/client/v2/skills/builtin/picoaide-app-builder/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("归档 = %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-Skill-Checksum"); got != payload.Skills[0].SHA256 {
		t.Fatalf("归档 X-Skill-Checksum = %q，清单 sha256 = %q（客户端靠这个头做完整性对照）", got, payload.Skills[0].SHA256)
	}
	if got := w.Header().Get("X-Skill-Version"); got != "1.0.0" {
		t.Fatalf("X-Skill-Version = %q", got)
	}
}

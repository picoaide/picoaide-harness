package api_test

// audit_r25_serving_appid_route_test.go —— 第二十五轮审计 Y3-1（P1）的
// **真 PG + 真生产路由树**判据。
//
// 缺陷形态（Y3-1）：主控的"服务侧不得套用写侧路由保留字"只接到了一个调用点
// （appserver/serve.go），api 层还有 7 处 handler 仍走写侧 `h.validateAppID`
// ⇒ 存量应用（名字 ∈ WASM 路由静态段：`open` / `rows` / `releases` / `request` /
// `proof` / `schema` …）在 open / request / proof / ownedApp / 管理面两条 / opens 上
// 一律 400 INVALID_APP_ID（details.reason=route_static_segment），而同一条链上的
// serveApp 放行。
//
// 为什么要"真路由 + 真 PG"：
//   - 只测 registry 两个函数（既有 TestR24X4ServeSideDoesNotApplyRouteStaticReserved）
//     不钉调用点 ⇒ 把任何一处改回写侧变体，包级测试仍然全绿（Y3 实跑证明）；
//   - 只测"函数返回 nil"看不出**路由能不能到达 handler**（首段静态路由会遮蔽
//     `:app_id`，`uploads` 就是现场）——所以这里用 `router.Register` 装配**生产路由表**，
//     并从真实路由表里独立复算保留集合与可达性；
//   - 身份必须是真的（Bearer 令牌 + 管理会话 cookie）：这些入口的第一道闸门是认证，
//     不带身份时拿到 401，判据会**假绿**（校验根本没跑到）。
//
// 本文件的三条断言：
//   A. 服务侧入口（open/request/proof/ownedApp/adminReleases/adminAppOpens/adminAppAIUsage）
//      对**结构可达**的保留字存量行必须给出业务态（不是"名字非法"）；
//   B. 写侧闸门（发布 / 分片上传开会话）对同一批名字必须**仍然拒**，且点名
//      route_static_segment；
//   C. 自校准：保留集合非空 + 与独立复算一致 + 每个候选名字确实被写侧拒
//      （否则这条用例会退化成"对一个不存在的集合做断言"）。
//
// 变异（把任一处 h.validateAppIDServing 改回 h.validateAppID）⇒ A 红；
// 把写侧闸门改成服务侧变体 ⇒ B 红。红/绿对照见 temp/r21/fix-27/REPORT.md。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

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
	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/appproof"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	wasmregistry "github.com/picoaide/picoaide/internal/wasmapp/registry"
	"github.com/picoaide/picoaide/internal/wasmapp/skillseed"
)

// ---------------------------------------------------------------------------
// 夹具：真 PG + 生产路由树 + 真身份
// ---------------------------------------------------------------------------

type r25RouteEnv struct {
	t           *testing.T
	db          *sql.DB
	r           *gin.Engine
	token       string // 普通员工 alice
	adminCookie string // super_admin 的管理会话 cookie 值
	adminUserID int64
}

var (
	r25ChildOnce sync.Once
	r25ChildPath string
	r25ChildErr  error
)

// r25CompileChild 现场构建编译子进程（与 api 包既有夹具同源：不入库任何二进制）。
//
// 为什么写侧判据需要它：发布与"分片上传开会话"的第一道自检是 requireCompiler ——
// 没有编译器时它们回 500「编译子系统未配置」，**根本走不到** app_id 校验，
// 于是"写侧仍拒"这条断言会假绿。
func r25CompileChild(t *testing.T) string {
	t.Helper()
	r25ChildOnce.Do(func() {
		out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
		if err != nil {
			r25ChildErr = fmt.Errorf("定位模块根失败（需要 go 工具链）: %w", err)
			return
		}
		root := strings.TrimSpace(string(out))
		dir, err := os.MkdirTemp("", "picoaide-r25-compile-child-")
		if err != nil {
			r25ChildErr = err
			return
		}
		bin := filepath.Join(dir, compile.ChildBinaryName)
		cmd := exec.Command("go", "build", "-o", bin, "./cmd/picoaide-app-compile")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			r25ChildErr = fmt.Errorf("构建编译子进程失败: %v\n%s", err, b)
			return
		}
		r25ChildPath = bin
	})
	if r25ChildErr != nil {
		t.Fatalf("%v", r25ChildErr)
	}
	return r25ChildPath
}

type r25Logger struct{ t *testing.T }

func (l r25Logger) Printf(format string, args ...any) { l.t.Logf(format, args...) }

func newR25RouteEnv(t *testing.T) *r25RouteEnv {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	dataRoot := t.TempDir()

	proof, perr := appproof.New(appproof.Options{DataRoot: t.TempDir()})
	if perr != nil {
		t.Fatalf("构造 app-proof 失败: %v", perr)
	}
	comp, cerr := compile.New(compile.Options{
		DataRoot: t.TempDir(),
		// OS 级隔离由 compile 包自己的端到端用例负责；这里测的是 app_id 闸门，
		// 关掉隔离让结论只取决于被测代码。
		ChildBinary: r25CompileChild(t),
		Isolation:   compile.IsolationOff,
		Logger:      r25Logger{t},
	})
	if cerr != nil {
		t.Fatalf("构造编译器失败: %v", cerr)
	}
	t.Cleanup(func() { _ = comp.Close() })

	wasm := wasmapi.NewHandlers(wasmapi.Options{
		DB:       db,
		DataRoot: dataRoot,
		Compiler: comp,
		Proof:    proof,
		Now:      func() time.Time { return time.Now().UTC() },
	})

	gin.SetMode(gin.TestMode)
	r := gin.New()
	router.Register(r, router.Deps{
		DB:            db,
		Auth:          serverauth.New(db).Handlers(),
		Admin:         (&serverauth.AdminAPI{DB: db}).Handlers(),
		Appstore:      appstore.NewHandlers(db),
		Bootstrap:     bootstrap.NewHandlers(db),
		Channel:       channel.NewHandlers(),
		PortalAdmin:   portal.NewAdminHandlers(db),
		ClientRelease: clientrelease.NewHandlers(func() string { return "0.0.0-r25" }, "official"),
		Market:        marketplace.NewHandlers(db, t.TempDir()),
		Agentshare:    agentshare.NewHandlers(db, t.TempDir()),
		Shared:        sharedskills.NewHandlers(db, t.TempDir()),
		Capability:    capabilities.NewHandlers(db, t.TempDir()),
		Connector:     connectors.NewHandlers(db),
		Telemetry:     telemetry.NewHandlers(db),
		Gateway:       llmgateway.NewHandlers(db),
		Reports:       reports.NewHandlers(db),
		Wasm:          wasm,
		SkillSeed:     skillseed.NewHandlers(skillseed.New(t.TempDir())),
	})
	// Register 把派生出来的路由静态段注入 registry（写侧封口的唯一入口）。
	// 本用例会临时改这个**进程级**集合，收尾复位 —— 本包其余用例依赖"未注入=空集"
	// 的初始状态（发布链路会用到各种普通名字）。
	t.Cleanup(func() { wasmregistry.SetRouteReservedAppIDs(nil) })

	aliceID, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "r25-alice", Source: "local", Status: 1, Role: serverstore.RoleUser})
	if err != nil {
		t.Fatalf("建员工失败: %v", err)
	}
	token, terr := serverauth.IssueToken(db, aliceID)
	if terr != nil {
		t.Fatalf("签发令牌失败: %v", terr)
	}
	bossID, berr := serverstore.CreateUser(db, &serverstore.User{
		Username: "r25-boss", Source: "local", Status: 1, Role: serverstore.RoleSuperAdmin})
	if berr != nil {
		t.Fatalf("建管理员失败: %v", berr)
	}
	sess, _, serr := serverauth.CreateAdminSession(db, bossID)
	if serr != nil {
		t.Fatalf("建管理会话失败: %v", serr)
	}
	return &r25RouteEnv{t: t, db: db, r: r, token: token, adminCookie: sess.ID, adminUserID: bossID}
}

func (e *r25RouteEnv) do(method, path, body string, admin bool) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if admin {
		// cookie 名与 serverauth.sessionCookieName 同值（本仓各包既有测试同款字面量）。
		req.Header.Set("Cookie", "picoaide_session="+e.adminCookie)
	} else {
		req.Header.Set("Authorization", "Bearer "+e.token)
	}
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}

// seedLegacyApp 直接落一行"存量应用"（owner = alice）。
//
// 为什么不能走发布链路建它：这些名字现在被**写侧**拒（X4-1 的封口），而本用例的
// 前提正是"升级前库里已经有这样的行"—— 直接写库才是对现场忠实的复现。
func (e *r25RouteEnv) seedLegacyApp(appID string) {
	e.t.Helper()
	err := serverstore.UpsertWasmApp(context.Background(), e.db, serverstore.WasmApp{
		AppID:           appID,
		Title:           "存量应用 " + appID,
		Description:     "第二十五轮审计夹具",
		Owner:           "r25-alice",
		Enabled:         true,
		Purpose:         "审计夹具",
		DataSensitivity: "internal",
		ConfigJSON:      `{"access":"login","whitelist":[]}`,
	})
	if err != nil {
		e.t.Fatalf("落存量行 %s 失败: %v", appID, err)
	}
}

// ---------------------------------------------------------------------------
// 保留集合：独立复算 + 可达性
// ---------------------------------------------------------------------------

// r25IndependentSegments 从**真实路由表**独立复算 WASM 客户端面（员工面）的全部
// 字面量段，并标出哪些段出现在**首段**位置。
//
// 为什么不直接调 `router.WasmAppIDReservedSegments`：判据若复用被测实现，
// "把某个段从清单里过滤掉"这种改动会让清单与候选集同时消失（自证同义反复）——
// 与 router 包自己的 wasm_appid_route_test.go 同一条纪律。
func r25IndependentSegments(routes gin.RoutesInfo) (segs, firstSegment map[string]bool) {
	segs = map[string]bool{}
	firstSegment = map[string]bool{}
	for _, rt := range routes {
		base := router.WasmClientRouteBase
		if rt.Path != base && !strings.HasPrefix(rt.Path, base+"/") {
			continue
		}
		parts := strings.Split(strings.Trim(strings.TrimPrefix(rt.Path, base), "/"), "/")
		for i, seg := range parts {
			if seg == "" || strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*") {
				continue
			}
			segs[seg] = true
			if i == 0 {
				firstSegment[seg] = true
			}
		}
	}
	return segs, firstSegment
}

// r25ReservedCandidates 返回 registry 里**生效**的保留集合，并附"哪些名字是首段
// 静态路由"（`/apps/wasm/<name>/…` 结构上到不了 `:app_id` handler —— `uploads` /
// `validate` / `catalog` 属这一类；它们的 `:app_id` 路由在 X4-1 里就是被遮蔽的那些）。
func r25ReservedCandidates(t *testing.T, r *gin.Engine) ([]string, map[string]bool) {
	t.Helper()
	effective := wasmregistry.RouteReservedAppIDs()
	if len(effective) < 8 {
		t.Fatalf("registry 里生效的保留集合只有 %d 条（%v）—— router.Register 的注入被拆掉，"+
			"本用例会退化成空转", len(effective), effective)
	}
	indep, first := r25IndependentSegments(r.Routes())
	if len(indep) < 8 {
		t.Fatalf("从真实路由表独立复算只有 %d 个静态段（%v）—— 路由表或前缀常量写错了", len(indep), indep)
	}
	eff := map[string]bool{}
	for _, s := range effective {
		eff[s] = true
	}
	for s := range indep {
		if !eff[s] {
			t.Errorf("路由表里的静态段 %q 没被注入 registry（写侧封口漏了它）", s)
		}
	}
	for s := range eff {
		if !indep[s] {
			t.Errorf("registry 生效集合里的 %q 不在真实路由表里（死条目）", s)
		}
	}
	reachable := 0
	for _, s := range effective {
		if !first[s] {
			reachable++
		}
	}
	if reachable < 8 {
		t.Fatalf("可达的保留字只有 %d 条（%v）—— 自校准失败", reachable, effective)
	}
	// 现场哨兵：Y3-1 点名的名字必须在集合里（否则用例可能"恰好"绕开了现场）。
	// `proof` 是**首段静态**路由（`POST /apps/wasm/proof`，app_id 在请求体里），
	// 因此它的可达性由"固定路径 + 体内 app_id"那条入口单独覆盖。
	for _, want := range []string{"open", "rows", "releases", "request", "proof", "schema", "uploads"} {
		if !eff[want] {
			t.Fatalf("现场名 %q 不在保留集合里（%v）—— 用例失去对象", want, effective)
		}
	}
	for _, want := range []string{"open", "rows", "releases", "request", "schema"} {
		if first[want] {
			t.Fatalf("现场名 %q 被判成首段静态路由（%v）—— 可达性判据写错了", want, effective)
		}
	}
	return effective, first
}

// ---------------------------------------------------------------------------
// A：服务侧入口对存量保留字行不得回"名字非法"
// ---------------------------------------------------------------------------

// isRouteStaticRejection 判定响应是不是写侧那条"与路由静态段同名"的拒绝。
func isRouteStaticRejection(w *httptest.ResponseRecorder) (bool, string) {
	var env struct {
		Error struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		return false, ""
	}
	if env.Error.Code != "INVALID_APP_ID" {
		return false, ""
	}
	reason, _ := env.Error.Details["reason"].(string)
	if reason != "route_static_segment" {
		return false, ""
	}
	return true, fmt.Sprintf("%d %s: %s", w.Code, env.Error.Code, env.Error.Message)
}

func TestAuditR25ServingEntriesAcceptLegacyRouteStaticAppIDs(t *testing.T) {
	env := newR25RouteEnv(t)
	candidates, firstSegment := r25ReservedCandidates(t, env.r)
	t.Logf("真实路由表派生的保留集合 %d 个：%v", len(candidates), candidates)
	reachable := 0
	for _, c := range candidates {
		if !firstSegment[c] {
			reachable++
		}
	}
	t.Logf("其中 :app_id 路径可达 %d 个（首段静态路由 %d 个结构上被遮蔽，由写侧封口负责）",
		reachable, len(candidates)-reachable)

	for _, appID := range candidates {
		// C（自校准）：这个名字今天**不可能**被发布出来（写侧拒）—— 这正是"存量行"
		// 的前提；若写侧放行了它，本用例的前提不成立（应当由写侧用例变红）。
		if aerr := wasmregistry.ValidateAppID(appID, nil); aerr == nil {
			t.Fatalf("前提不成立：app_id=%q 在写侧被接受 ⇒ 它不再是「存量行」形态", appID)
		}
		env.seedLegacyApp(appID)

		// 七个服务侧入口（与 api 包的调用点清单一一对应）。
		// pathReach=false 的入口只在 app_id 不在路径首段时才有对象（首段静态路由
		// 会遮蔽 `:app_id`）—— `proof` 的 app_id 在**请求体**里，所以它恒可达。
		cases := []struct {
			name      string
			method    string
			path      string
			body      string
			admin     bool
			pathReach bool
			// wantStatus/wantCode 非零值 = 期望的**业务态**（证明 handler 真的跑到了
			// 校验之后），零值 = 只断言"不是名字非法"。
			wantStatus int
			wantCode   string
		}{
			{"open", http.MethodPost, router.WasmClientRouteBase + "/" + appID + "/open", `{}`, false, true, 401, "proof_required"},
			{"request", http.MethodPost, router.WasmClientRouteBase + "/" + appID + "/request",
				`{"method":"GET","path":"/"}`, false, true, 401, "proof_required"},
			{"proof", http.MethodPost, router.WasmClientRouteBase + "/proof",
				fmt.Sprintf(`{"install_id":"i1","public_key":"AA==","nonce":"n1","ts":%d,"signature":"AA==","app_id":%q}`,
					time.Now().Unix(), appID), false, false, 0, ""},
			{"ownedApp", http.MethodGet, router.WasmClientRouteBase + "/" + appID + "/releases", "", false, true, 200, ""},
			{"loadAdminApp", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/releases", "", true, true, 200, ""},
			{"adminAppOpens", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/opens", "", true, true, 200, ""},
			{"adminAppAIUsage", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/ai-usage", "", true, true, 200, ""},
		}
		checked := 0
		for _, tc := range cases {
			if tc.pathReach && firstSegment[appID] {
				continue // 结构上不可达（首段静态路由遮蔽）—— 由写侧那条封口负责
			}
			checked++
			w := env.do(tc.method, tc.path, tc.body, tc.admin)
			if bad, detail := isRouteStaticRejection(w); bad {
				t.Errorf("[%s] app_id=%q 被服务侧判成「名字非法」：%s\nbody=%s\n"+
					"（这是 Y3-1 的缺陷形态：存量行在同一条链上被校验层拒掉，而 serveApp 放行）",
					tc.name, appID, detail, w.Body.String())
				continue
			}
			if tc.wantStatus != 0 {
				if w.Code != tc.wantStatus {
					t.Errorf("[%s] app_id=%q status=%d，want %d；body=%s",
						tc.name, appID, w.Code, tc.wantStatus, w.Body.String())
					continue
				}
				if tc.wantCode != "" {
					var envl struct {
						Error struct {
							Code string `json:"code"`
						} `json:"error"`
					}
					_ = json.Unmarshal(w.Body.Bytes(), &envl)
					if envl.Error.Code != tc.wantCode {
						t.Errorf("[%s] app_id=%q code=%q，want %q；body=%s",
							tc.name, appID, envl.Error.Code, tc.wantCode, w.Body.String())
					}
				}
			}
		}
		if checked == 0 {
			t.Fatalf("app_id=%q 一个入口都没检查到 —— 判据空转", appID)
		}
	}
}

// TestAuditR25ServingEntriesControlNameIsStillAccepted 是 A 的**正向对照**：
// 一个普通名字必须走完全同一条链路并给出同一批业务态。
//
// 没有它，"所有入口都回 401/200"就不能排除"请求根本没到 handler（例如认证层
// 直接短路）"这一种假绿。
func TestAuditR25ServingEntriesControlNameIsStillAccepted(t *testing.T) {
	env := newR25RouteEnv(t)
	const appID = "r25-control-app"
	env.seedLegacyApp(appID)

	checks := []struct {
		name       string
		method     string
		path       string
		body       string
		admin      bool
		wantStatus int
		wantCode   string
	}{
		{"open", http.MethodPost, router.WasmClientRouteBase + "/" + appID + "/open", `{}`, false, 401, "proof_required"},
		{"request", http.MethodPost, router.WasmClientRouteBase + "/" + appID + "/request",
			`{"method":"GET","path":"/"}`, false, 401, "proof_required"},
		{"ownedApp", http.MethodGet, router.WasmClientRouteBase + "/" + appID + "/releases", "", false, 200, ""},
		{"loadAdminApp", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/releases", "", true, 200, ""},
		{"adminAppOpens", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/opens", "", true, 200, ""},
		{"adminAppAIUsage", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/ai-usage", "", true, 200, ""},
	}
	for _, tc := range checks {
		w := env.do(tc.method, tc.path, tc.body, tc.admin)
		if w.Code != tc.wantStatus {
			t.Fatalf("[%s] 对照名 status=%d，want %d；body=%s —— 用例本身失效（链路没跑到 handler）",
				tc.name, w.Code, tc.wantStatus, w.Body.String())
		}
		if tc.wantCode != "" {
			var envl struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &envl)
			if envl.Error.Code != tc.wantCode {
				t.Fatalf("[%s] 对照名 code=%q，want %q；body=%s", tc.name, envl.Error.Code, tc.wantCode, w.Body.String())
			}
		}
	}
}

// ---------------------------------------------------------------------------
// B：写侧闸门对同一批名字必须仍然拒（且点名 route_static_segment）
// ---------------------------------------------------------------------------

func TestAuditR25WriteSideStillRejectsRouteStaticAppIDs(t *testing.T) {
	env := newR25RouteEnv(t)
	candidates, firstSegment := r25ReservedCandidates(t, env.r)

	for _, appID := range candidates {
		// ① 发布链路（POST /:app_id/releases，body 里的 app_id 也参与校验）。
		// 首段静态路由的名字在这里结构上不可达（由 ② 覆盖 —— X4-1 的现场 `uploads`
		// 正是经分片上传链路建出来的）。
		if !firstSegment[appID] {
			pub := fmt.Sprintf(
				`{"app_id":%q,"version":"1.0.0","title":"t","changelog":"c","wasm_base64":"AGFzbQEAAAA=","config":{"access":"login"}}`,
				appID)
			w := env.do(http.MethodPost, router.WasmClientRouteBase+"/"+appID+"/releases", pub, false)
			if bad, detail := isRouteStaticRejection(w); !bad {
				t.Errorf("[publish] app_id=%q 未被写侧以 route_static_segment 拒绝（status=%d，body=%s；%s）\n"+
					"（放松它 = 应用建得成、但永远打不开：X4-1 复发）", appID, w.Code, w.Body.String(), detail)
			}
		}

		// ② 分片上传开会话（固定路径，body 里带 app_id；建立会话 = 这个名字即将进库）。
		up := fmt.Sprintf(`{"app_id":%q,"version":"1.0.0","total_bytes":1048576,"chunk_bytes":1048576}`, appID)
		wu := env.do(http.MethodPost, router.WasmClientRouteBase+"/uploads", up, false)
		if bad, detail := isRouteStaticRejection(wu); !bad {
			t.Errorf("[uploads] app_id=%q 未被写侧以 route_static_segment 拒绝（status=%d，body=%s；%s）",
				appID, wu.Code, wu.Body.String(), detail)
		}
	}

	// 正向对照：普通名字在两处都不得吃到 route_static_segment（证明闸门不是"一律拒"）。
	const ok = "r25-control-app"
	w := env.do(http.MethodPost, router.WasmClientRouteBase+"/uploads",
		fmt.Sprintf(`{"app_id":%q,"version":"1.0.0","total_bytes":1048576,"chunk_bytes":1048576}`, ok), false)
	if w.Code != http.StatusCreated {
		t.Fatalf("对照名 %q 开会话 status=%d，want 201；body=%s", ok, w.Code, w.Body.String())
	}
	if bad, detail := isRouteStaticRejection(w); bad {
		t.Fatalf("对照名 %q 被误拒：%s", ok, detail)
	}
}

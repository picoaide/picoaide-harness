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
// ## 变异覆盖矩阵（S7-R N3 更正：旧版逐字宣称"把任一处 h.validateAppIDServing 改回
// ## h.validateAppID ⇒ A 红"，实测**不成立** —— 它把管理面入口也一起跳过了）
//
// 一处回退能不能被**本文件**咬住，取决于**该入口的路径对保留名是否可达**。保留集合收窄后
// 只剩 `uploads`（真遮蔽段），而它在客户端前缀 `/:app_id/…` 上**结构性不可达**：
//
//	入口（api 包）                    路由模板                                      本文件  由谁负责
//	h.openApp                        POST /apps/wasm/:app_id/open                  ✗      C=调用点判据
//	h.clientRequest                  POST /apps/wasm/:app_id/request               ✗      C=调用点判据
//	h.ownedApp                       GET  /apps/wasm/:app_id/releases              ✗      C=调用点判据
//	h.appProofIssue                  POST /apps/wasm/proof（app_id 在**体内**）    ✓ A    —
//	h.loadAdminApp                   GET  /api/server/admin/wasm-apps/:app_id/releases  ✓ A    —
//	h.adminAppOpens                  GET  /api/server/admin/wasm-apps/:app_id/opens     ✓ A    —
//	h.adminAppAIUsage                GET  /api/server/admin/wasm-apps/:app_id/ai-usage  ✓ A    —
//	（**包外**）appserver/serve.go:60  registry.ValidateAppIDForServing              ✗      **无判据**（见报告"未覆盖"节）
//
//	C = `audit_r25_serving_appid_callsite_test.go` 的
//	    `TestAuditR25ServingAppIDCallSitesAreBoundToServing`（go/ast 反向可达闭包：
//	    serving 闭包必须**恰好**等于登记表 ⇒ 任一处回退都会让该节点落进写侧闭包 ⇒ 红）。
//	    它的解析面是**本包**（`os.ReadDir(".")`）⇒ 包外节点（appserver）不在其中。
//
// 旧版的问题是**宣称 > 实际覆盖**：跳过条件写成 `pathReach && reserved[appID]`，于是
// `GET /api/server/admin/wasm-apps/uploads/releases` 这类**真实可达**的管理面入口也被跳过
//（红队 m12 实测：`admin.go` 单点回退 ⇒ 本文件 EXIT=0）。现在跳过条件改为
// "**路径落在被遮蔽的客户端前缀模板上**"（见 {@link reservedShadowedClientPath}），
// 管理面入口与体内携带 app_id 的入口始终参与断言，并加三条自校准（保留名必须有入口被跳过、
// 管理面一个都不许被跳过、每个名字至少要检查到一个入口）。

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
	"sort"
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

// r25StaticSegments 返回真实路由表里 WASM 客户端面的**全部**字面量段（`all`，
// 含深层与叶子）与"首段静态段"（`first`），并对齐 registry 里**生效**的保留集合
// （`reserved`）。
//
// S7-2（v2.8.1→HEAD 回归审计）之后，生效集合不再等于"首段静态段"，而是它的子集
// ——只有那些**能把 `:app_id` 的下降领走**的静态段（真遮蔽：`uploads`，它之下有
// `/uploads/:upload_id`）。本函数把这条口径钉住：收宽了（把 `rows` / `catalog` 这类
// 可达名字也收进来）就是 S7-2 本身，收窄了（漏掉 `uploads`）就是 X4-1。
func r25StaticSegments(t *testing.T, r *gin.Engine) (all, reserved map[string]bool) {
	t.Helper()
	indep, first := r25IndependentSegments(r.Routes())
	if len(indep) < 8 {
		t.Fatalf("从真实路由表独立复算只有 %d 个静态段（%v）—— 路由表或前缀常量写错了", len(indep), indep)
	}
	effective := wasmregistry.RouteReservedAppIDs()
	if len(effective) == 0 {
		t.Fatalf("registry 里生效的保留集合是空的 —— router.Register 的注入被拆掉，" +
			"本用例会退化成空转")
	}
	eff := map[string]bool{}
	for _, s := range effective {
		eff[s] = true
	}
	for s := range eff {
		if !indep[s] {
			t.Errorf("registry 生效集合里的 %q 不在真实路由表里（死条目）", s)
		}
	}
	// S7-2 的现场哨兵（双向）：
	//   - `uploads` 必须在（它之下有参数子节点，12/13 条 :app_id 模板打不开）；
	//   - 深层静态段（rows / open / releases / request / schema）与**叶子**首段静态段
	//     （catalog / proof / validate）都不许在 —— 它们实测全可达（gin 在静态分支找
	//     不到子节点时退回参数分支），收进来 = 拒了可达的名字 ⇒ 存量应用发不出新版本。
	if !eff["uploads"] {
		t.Fatalf("现场名 uploads 不在保留集合里（X4-1 的现场会复发）：%v", effective)
	}
	for _, want := range []string{"rows", "open", "releases", "request", "schema", "catalog", "proof", "validate"} {
		if eff[want] {
			t.Fatalf("现场名 %q 在保留集合里（S7-2 复发：可达的名字被写侧拒，存量应用发不出新版本）：%v",
				want, effective)
		}
	}
	// 首段判定自校准：uploads 是首段静态路由，rows 不是。
	if !first["uploads"] || first["rows"] {
		t.Fatalf("r25IndependentSegments 的首段判定不对：first[uploads]=%v first[rows]=%v",
			first["uploads"], first["rows"])
	}
	return indep, eff
}

// sortedKeys 把集合转成稳定顺序的切片（日志与遍历用）。
func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
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

// reservedShadowedClientPath 判定"这条入口的路径是否落在**被遮蔽的客户端前缀模板**上"。
//
// 只有这类入口对保留名（今天 = `uploads`）结构上不可达：`/apps/wasm/<保留名>/<后缀>` 会被
// 首段静态路由领走（`/uploads/:upload_id` 吃掉下一段，或整条落 NoRoute）。**管理面**走的是
// `/api/server/admin/wasm-apps/…`（另一棵树，不受 WASM 前缀静态段遮蔽）⇒ 对 `uploads`
// **真实可达**，不能被跳过（S7-R N3：旧版按 `reserved[appID]` 一刀切，把管理面也跳过了）。
func reservedShadowedClientPath(path, appID string) bool {
	prefix := router.WasmClientRouteBase + "/" + appID
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

func TestAuditR25ServingEntriesAcceptLegacyRouteStaticAppIDs(t *testing.T) {
	env := newR25RouteEnv(t)
	all, reserved := r25StaticSegments(t, env.r)
	candidates := sortedKeys(all)
	t.Logf("真实路由表的 WASM 字面量段 %d 个：%v；其中写侧保留（真遮蔽）%d 个：%v",
		len(candidates), candidates, len(reserved), sortedKeys(reserved))

	for _, appID := range candidates {
		// C（自校准，双向）：这个名字在写侧的状态必须与保留集合一致 ——
		// 保留段（真遮蔽）必须被拒；其余（深层/叶子静态段，实测全可达）必须被接受
		// （S7-2 的修复目标：它们不再被"名字非法"挡住）。任一方向不符 ⇒ 本用例的
		// 前提（"库里可能已经有这样的行，而这个名字本身合法/不合法"）与实现不符。
		writeRejects := wasmregistry.ValidateAppID(appID, nil) != nil
		if writeRejects != reserved[appID] {
			t.Fatalf("app_id=%q 写侧拒=%v，但保留集合 membership=%v —— 两侧口径相反（S7-2/X4-1 的形态）",
				appID, writeRejects, reserved[appID])
		}
		env.seedLegacyApp(appID)

		// 七个服务侧入口（与 api 包的调用点清单一一对应）。
		// 只有**路径落在被遮蔽的客户端前缀模板上**的入口对保留名不可达（首段静态路由会
		// 遮蔽 `:app_id`）—— 见 {@link reservedShadowedClientPath} 与文件头的覆盖矩阵；
		// `proof` 的 app_id 在**请求体**里、管理面走 `/api/server/admin/**`，两者恒可达。
		cases := []struct {
			name   string
			method string
			path   string
			body   string
			admin  bool
			// wantStatus/wantCode 非零值 = 期望的**业务态**（证明 handler 真的跑到了
			// 校验之后），零值 = 只断言"不是名字非法"。
			wantStatus int
			wantCode   string
		}{
			{"open", http.MethodPost, router.WasmClientRouteBase + "/" + appID + "/open", `{}`, false, 401, "proof_required"},
			{"request", http.MethodPost, router.WasmClientRouteBase + "/" + appID + "/request",
				`{"method":"GET","path":"/"}`, false, 401, "proof_required"},
			{"proof", http.MethodPost, router.WasmClientRouteBase + "/proof",
				fmt.Sprintf(`{"install_id":"i1","public_key":"AA==","nonce":"n1","ts":%d,"signature":"AA==","app_id":%q}`,
					time.Now().Unix(), appID), false, 0, ""},
			{"ownedApp", http.MethodGet, router.WasmClientRouteBase + "/" + appID + "/releases", "", false, 200, ""},
			{"loadAdminApp", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/releases", "", true, 200, ""},
			{"adminAppOpens", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/opens", "", true, 200, ""},
			{"adminAppAIUsage", http.MethodGet, "/api/server/admin/wasm-apps/" + appID + "/ai-usage", "", true, 200, ""},
		}
		checked, skipped, adminSkipped := 0, 0, 0
		for _, tc := range cases {
			if reserved[appID] && reservedShadowedClientPath(tc.path, appID) {
				// 结构上不可达（被遮蔽的客户端前缀模板）—— 由写侧那条封口负责。
				skipped++
				if tc.admin {
					adminSkipped++
				}
				continue
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
		// 自校准（S7-R N3，三条互相独立）：
		//   ① 管理面入口**一个都不许**被跳过 —— 它走 /api/server/admin/**，对保留名真实可达
		//      （跳过它们 = 那三个入口的单点回退在本文件上失去判别力，正是 N3 的缺口形态）；
		//   ② 保留名必须**至少有一个**入口被跳过（否则"遮蔽判定"失效，断言会打在结构上
		//      不可达的路径上，红的是环境不是实现）；
		//   ③ 非保留名不得有任何入口被跳过（它们全可达，跳过即判据静默缩面）。
		if adminSkipped > 0 {
			t.Fatalf("app_id=%q：%d 个**管理面**入口被跳过 —— 管理面走 /api/server/admin/**，"+
				"不受 WASM 前缀静态段遮蔽（对 uploads 真实可达）⇒ 跳过它 = 该入口的单点回退"+
				"在本文件上无牙（S7-R N3）", appID, adminSkipped)
		}
		if reserved[appID] && skipped == 0 {
			t.Fatalf("app_id=%q 是保留名（真遮蔽段），却没有任何入口被跳过 —— "+
				"遮蔽判定失效，断言会打在结构上不可达的路径上", appID)
		}
		if !reserved[appID] && skipped != 0 {
			t.Fatalf("app_id=%q 不是保留名，却有 %d 个入口被跳过 —— 判据静默缩面", appID, skipped)
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
	all, reserved := r25StaticSegments(t, env.r)

	// ① 真遮蔽名（保留集合，今天 = `uploads`）：发布链路与分片上传开会话都必须拒，
	// 且点名 route_static_segment。
	for _, appID := range sortedKeys(reserved) {
		// 发布链路（POST /:app_id/releases，body 里的 app_id 也参与校验）。
		// 首段静态路由的名字在这里结构上不可达（由下面的 ② 覆盖 —— X4-1 的现场
		// `uploads` 正是经分片上传链路建出来的）。
		if !firstSegmentName(env.r, appID) {
			pub := fmt.Sprintf(
				`{"app_id":%q,"version":"1.0.0","title":"t","changelog":"c","wasm_base64":"AGFzbQEAAAA=","config":{"access":"login"}}`,
				appID)
			w := env.do(http.MethodPost, router.WasmClientRouteBase+"/"+appID+"/releases", pub, false)
			if bad, detail := isRouteStaticRejection(w); !bad {
				t.Errorf("[publish] app_id=%q 未被写侧以 route_static_segment 拒绝（status=%d，body=%s；%s）\n"+
					"（放松它 = 应用建得成、但永远打不开：X4-1 复发）", appID, w.Code, w.Body.String(), detail)
			}
		}
		up := fmt.Sprintf(`{"app_id":%q,"version":"1.0.0","total_bytes":1048576,"chunk_bytes":1048576}`, appID)
		wu := env.do(http.MethodPost, router.WasmClientRouteBase+"/uploads", up, false)
		if bad, detail := isRouteStaticRejection(wu); !bad {
			t.Errorf("[uploads] app_id=%q 未被写侧以 route_static_segment 拒绝（status=%d，body=%s；%s）",
				appID, wu.Code, wu.Body.String(), detail)
		}
	}

	// ② 反方向（S7-2 的判据面）：其它静态段名字（深层 + 叶子）实测全可达，写侧的
	// **每一次发布**入口都不得再把它们判成"名字非法" —— 那正是"存量应用发不出新版本"
	// 的成因。这里用分片上传开会话（固定路径，app_id 在请求体里，覆盖全部静态段名字）
	// 作为写侧代表：必须 201；随即主动放弃会话（每用户未完成会话上限 4 个，不回收会
	// 把后续名字挡在 429 上 —— 那是判据自身的环境限制，不是被测行为）。
	for _, appID := range sortedKeys(all) {
		if reserved[appID] {
			continue
		}
		up := fmt.Sprintf(`{"app_id":%q,"version":"1.0.0","total_bytes":1048576,"chunk_bytes":1048576}`, appID)
		w := env.do(http.MethodPost, router.WasmClientRouteBase+"/uploads", up, false)
		if bad, detail := isRouteStaticRejection(w); bad {
			t.Errorf("[uploads] app_id=%q 被写侧判成「与路由静态段同名」（%s；body=%s）—— "+
				"它在真实匹配树上可达（实测 169/169），拒了它就是 S7-2：存量应用发不出新版本",
				appID, detail, w.Body.String())
			continue
		}
		if w.Code != http.StatusCreated {
			t.Errorf("[uploads] app_id=%q status=%d，want 201；body=%s", appID, w.Code, w.Body.String())
			continue
		}
		var created struct {
			UploadID string `json:"upload_id"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.UploadID == "" {
			t.Fatalf("[uploads] app_id=%q 的 201 体里没有 upload_id（err=%v body=%s）",
				appID, err, w.Body.String())
		}
		if del := env.do(http.MethodDelete, router.WasmClientRouteBase+"/uploads/"+created.UploadID, "", false); del.Code != http.StatusNoContent && del.Code != http.StatusOK {
			t.Fatalf("[uploads] 放弃会话 %s 失败：status=%d body=%s", created.UploadID, del.Code, del.Body.String())
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

// firstSegmentName 报告某个名字是不是真实路由表的**首段**静态段
// （首段静态名在 `/:app_id/…` 路径上结构不可达，只能经"固定路径 + 体内 app_id"的入口测）。
func firstSegmentName(r *gin.Engine, name string) bool {
	_, first := r25IndependentSegments(r.Routes())
	return first[name]
}

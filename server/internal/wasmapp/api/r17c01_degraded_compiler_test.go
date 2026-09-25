package api

// R17C-01（审计 2026-09-25，P1）：WASM 平台把「发布面」的编译器闸门盖到了
// **发现面 / 执行面 / 管理面 / 应急处置面**。
//
// 缺陷形态（修前）：`requireReady()` 把 `h.opt.Compiler == nil` 与 DB/DataRoot 绑在
// 一条判据里，33 个调用点全过它。编译子系统缺席时（compose 缺省
// `PICOAI_COMPILE_ISOLATION=auto` 下 bwrap 不可用；或镜像里少一个
// `picoaide-app-compile` 二进制）：
//
//	GET  catalog / availability / schema / diagnostics / releases / export  -> 500
//	GET  管理端列表 / releases / rows / diagnostics / runtime                -> 500
//	POST freeze / unpublish / publish（上下架）/ delete / review             -> 500
//	GET/PUT 管理端 limits（内存与并发闸门）                                   -> 500
//
// 而同进程的**执行面**（open/request）与 `/readyz {ok:true, compile_available:false}`
// 都表明平台本体健康，启动日志还写着"其余功能正常" ⇒ **降级态下管理员失去下架/
// 冻结一个行为异常应用的应急处置能力**，只能动库。
//
// 修法：拆成 `requirePlatform()`（DB + DataRoot，平台所有端点）与
// `requireCompiler()`（平台 + 编译器，**只有** upload*/validate/publish 这些真的会
// 编译/占编译并发额度的端点）。
//
// 本用例的判据刻意写成"**不得出现「编译子系统未配置」这条 500**"而不是"不得 500"：
// 后者会把与本缺陷无关的装配缺失（如本夹具没有注入 limits 闭包）也算进来，
// 判据就不再指向被修的那件事。另一半判据（发布面**必须**保持同一条 500）单独钉住，
// 免得有人为了"修好 500"把发布面的 fail-closed 一起拆掉。

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

const compilerMissingMessage = "编译子系统未配置"

// degradedEnv 先用**完好**的编译器发布一个真应用，再把同一 DB/DataRoot 上的
// Handlers 换成 `Compiler == nil` 的装配（= 编译子进程二进制缺失的等价形态）。
func degradedEnv(t *testing.T) *testEnv {
	t.Helper()
	env := newTestEnv(t)
	wasm := testGuestModule(t)
	env.publishOK(env.tokens["alice"], "deg-app", "1.0.0", wasm, goodConfig())

	saved := env.h
	env.h = NewHandlers(Options{
		DB:               env.db,
		DataRoot:         env.dataRoot,
		CompileCacheRoot: env.dataRoot,
		Proof:            env.proof,
		Opens:            env.opens.record,
		Now:              func() time.Time { return time.Now().UTC() },
		// Compiler 故意为 nil —— 这就是被测的降级态。
	})
	t.Cleanup(func() { env.h = saved })

	r := gin.New()
	env.mount(r)
	env.r = r
	return env
}

func TestDegradedCompilerKeepsDiscoveryAndAdminSurfacesUsable(t *testing.T) {
	env := degradedEnv(t)
	type probe struct {
		name, method, path, token string
		body                      any
	}
	probes := []probe{
		// 发现面（员工）
		{"员工应用目录 catalog", http.MethodGet, "/api/client/v2/apps/wasm/catalog", env.tokens["alice"], nil},
		{"员工可用性 availability", http.MethodGet, "/api/client/v2/apps/wasm/deg-app/availability", env.tokens["alice"], nil},
		{"员工自省 schema", http.MethodGet, "/api/client/v2/apps/wasm/deg-app/schema", env.tokens["alice"], nil},
		{"员工诊断 diagnostics", http.MethodGet, "/api/client/v2/apps/wasm/deg-app/diagnostics", env.tokens["alice"], nil},
		{"员工版本历史 releases", http.MethodGet, "/api/client/v2/apps/wasm/deg-app/releases", env.tokens["alice"], nil},
		{"员工数据面 rows", http.MethodGet, "/api/client/v2/apps/wasm/deg-app/rows", env.tokens["alice"], nil},
		{"员工导出 export", http.MethodGet, "/api/client/v2/apps/wasm/deg-app/export", env.tokens["alice"], nil},
		// 管理面（读）
		{"管理端列表", http.MethodGet, "/api/server/admin/wasm-apps", "", nil},
		{"管理端版本历史", http.MethodGet, "/api/server/admin/wasm-apps/deg-app/releases", "", nil},
		{"管理端诊断", http.MethodGet, "/api/server/admin/wasm-apps/deg-app/diagnostics", "", nil},
		{"管理端数据面 rows", http.MethodGet, "/api/server/admin/wasm-apps/deg-app/rows", "", nil},
		{"管理端 schema", http.MethodGet, "/api/server/admin/wasm-apps/deg-app/schema", "", nil},
		{"管理端 runtime 水位", http.MethodGet, "/api/server/admin/wasm-apps/runtime", "", nil},
		{"管理端限制项读", http.MethodGet, "/api/server/admin/wasm-apps/limits", "", nil},
		// 管理面（应急处置 —— 缺陷描述里最要紧的那一半）
		{"管理端 freeze", http.MethodPost, "/api/server/admin/wasm-apps/deg-app/freeze", "", map[string]any{"frozen": true}},
		{"管理端 unpublish", http.MethodPost, "/api/server/admin/wasm-apps/deg-app/unpublish", "", nil},
		{"管理端 review 开关", http.MethodPut, "/api/server/admin/wasm-apps/review", "", map[string]any{"required": true}},
		{"管理端限制项写", http.MethodPut, "/api/server/admin/wasm-apps/limits", "", map[string]any{"max_instances": 4}},
		// 发布者自助的上下架（也是 Release/应急语义，不是编译）
		{"员工上架开关", http.MethodPost, "/api/client/v2/apps/wasm/deg-app/publish", env.tokens["alice"], nil},
	}
	for _, p := range probes {
		w := env.req(p.method, p.path, p.token, p.body)
		if w.Code == http.StatusInternalServerError && strings.Contains(w.Body.String(), compilerMissingMessage) {
			t.Errorf("%s ⇒ 500「%s」：编译器缺席不该让发现面/管理面不可用（R17C-01）body=%s",
				p.name, compilerMissingMessage, w.Body.String())
		}
	}
}

// 另一半：发布面必须**保持**编译器缺席时的 fail-closed（同一条错误信封与文案）。
func TestDegradedCompilerStillFailsPublishSurfaceClosed(t *testing.T) {
	env := degradedEnv(t)
	wasm := testGuestModule(t)

	// validate（预检同样真的编译）
	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", env.tokens["alice"],
		env.payload("deg-app-2", "1.0.0", wasm, goodConfig()))
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), compilerMissingMessage) {
		t.Fatalf("validate 在编译器缺席时 status=%d body=%s, want 500「%s」", w.Code, w.Body.String(), compilerMissingMessage)
	}
	// publish（真的编译）
	w = env.req(http.MethodPost, "/api/client/v2/apps/wasm/deg-app/releases", env.tokens["alice"],
		env.payload("deg-app", "2.0.0", wasm, goodConfig()))
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), compilerMissingMessage) {
		t.Fatalf("publish 在编译器缺席时 status=%d body=%s, want 500「%s」", w.Code, w.Body.String(), compilerMissingMessage)
	}
	if got := env.countReleases("deg-app"); got != 1 {
		t.Fatalf("被拒的发布不得落版本行：release 行数=%d want 1（只有夹具那一版）", got)
	}
}

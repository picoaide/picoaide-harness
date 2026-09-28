package router

// wasm_appid_route_test.go —— X4-1 的判据面（第二十四轮审计）。
//
// 现场：`POST /api/client/v2/apps/wasm/uploads/{releases,open,request,freeze,
// publish,unpublish}` 与 `GET …/uploads/{rows,schema,diagnostics,export,
// availability,releases}` 在**真实生产路由树 + 真 NoRoute** 下全部 404「接口不存在」
// （对照 `myapp` → 401），而 `registry.ValidateAppID("uploads")` 却 ALLOWED，
// 且这个 id 能经分片上传链路（body 里带 app_id）**发布出去** ⇒ 应用建完即废、
// 归属与版本号永久占位。
//
// 既有判据为什么看不见：`cmd/server/api_sweep_test.go` 把 `:app_id` 固定替换成
// `"1"`（必不与任何静态段同名）⇒ "全路由扫描"结构上不可能发现本类；既有的
// integrity 断言比对的是 gin **注册表**（`r.Routes()`）⇒ 只证"注册了"、不证"可达"。
//
// 本文件的四条断言（缺任一条都会被变异打红，见 `mutations` 注释）：
//
//	A. 派生集合与路由表**双向**对账（路由新增静态段而派生漏了 ⇒ 红）；
//	B. 派生集合 == registry 里**生效**的集合（接线被拆 ⇒ 红）；
//	C. 每个派生静态段都必须被**写侧**拒（把清单改回旧 host label 清单 ⇒ 红）；
//	D. 任何**写侧接受**的 app_id，其全部 `:app_id` 路由必须在真实路由树上
//	   **逐条命中它自己的模板**（新增静态段遮蔽而未登记 ⇒ 红）。
//
// D 的取法：全局中间件在 gin 匹配完成之后、handler 执行之前读 `c.FullPath()`
// 并把模板写进响应头后 abort —— 用的是**真实 gin 匹配树**，但一个 handler 都不跑
// （nil DB 下也不会 panic，且不会被"某个 handler 恰好也返回 404"骗过）。

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	wasmregistry "github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// routeProbeHeader 携带"这一请求被哪条路由模板匹配"（未命中任何路由时为空）。
const routeProbeHeader = "X-Picoaide-Route-Probe"

// buildRouteProbeRouter 组装**真实生产路由树** + 真实 gin 匹配 + NoRoute 标记。
//
// 与 buildTestRouter 的差别只有两处（都由判据需要）：全局探针中间件必须在
// Register 之前挂（gin 的中间件在注册路由时并入 handler 链），以及 NoRoute
// 显式标记（生产树的 NoRoute 是 JSON 404 信封，这里只要一个可判定的哨兵）。
func buildRouteProbeRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		// c.FullPath() 在 handleHTTPRequest 里"找到节点之后、跑 handler 之前"
		// 就被赋值；未命中任何路由时是空串（含 NoRoute 链）。
		c.Header(routeProbeHeader, c.FullPath())
		c.AbortWithStatus(http.StatusTeapot)
	})
	r.NoRoute(func(c *gin.Context) {
		c.Header(routeProbeHeader, "")
		c.AbortWithStatus(http.StatusTeapot)
	})
	Register(r, testRouterDeps(t))
	return r
}

// wasmAppIDRoutePatterns 取真实路由表里全部带 `:app_id` 的 WASM 客户端路由模板。
func wasmAppIDRoutePatterns(t *testing.T, r *gin.Engine) []string {
	t.Helper()
	var out []string
	for _, rt := range r.Routes() {
		if strings.Contains(rt.Path, ":app_id") &&
			(rt.Path == WasmClientRouteBase || strings.HasPrefix(rt.Path, WasmClientRouteBase+"/")) {
			out = append(out, rt.Method+" "+rt.Path)
		}
	}
	if len(out) == 0 {
		t.Fatal("真实路由表里没有带 :app_id 的 WASM 路由 —— 判据失去对象")
	}
	sort.Strings(out)
	return out
}

// probeMatchedTemplate 用真实匹配树问"这个具体路径命中哪条模板"（不跑 handler）。
func probeMatchedTemplate(r *gin.Engine, method, path string) string {
	req := httptest.NewRequest(method, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Header().Get(routeProbeHeader)
}

// independentWasmStaticSegments 在**测试里独立复算**一遍"WASM 前缀之后的全部字面量段"。
//
// 与生产实现（`WasmAppIDReservedSegments`）分开写是**有意的**：判据如果复用被测函数的输出，
// "把某个段从清单里过滤掉"这种改动就两边同时看不见（自证同义反复）。
// @param routes - `gin.Engine.Routes()` 的快照。
// @returns 字面量段集合。
func independentWasmStaticSegments(routes gin.RoutesInfo) map[string]bool {
	want := map[string]bool{}
	for _, rt := range routes {
		if rt.Path != WasmClientRouteBase && !strings.HasPrefix(rt.Path, WasmClientRouteBase+"/") {
			continue
		}
		for _, seg := range strings.Split(strings.Trim(strings.TrimPrefix(rt.Path, WasmClientRouteBase), "/"), "/") {
			if seg == "" || strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*") {
				continue
			}
			want[seg] = true
		}
	}
	return want
}

// TestWasmAppIDReservedSegmentsAreDerivedFromRouteTable —— A + B。
func TestWasmAppIDReservedSegmentsAreDerivedFromRouteTable(t *testing.T) {
	r := buildRouteProbeRouter(t)

	// A（独立复算，不调用被测函数）：把真实路由表里 WASM 前缀之后的**全部**
	// 字面量段手工收集一遍，再与派生结果对账。
	want := independentWasmStaticSegments(r.Routes())
	if len(want) == 0 {
		t.Fatal("独立复算得到 0 个静态段 —— 路由表或前缀常量写错了")
	}
	got := WasmAppIDReservedSegments(r.Routes())
	gotSet := map[string]bool{}
	for _, seg := range got {
		gotSet[seg] = true
	}
	for seg := range want {
		if !gotSet[seg] {
			t.Errorf("路由表里的静态段 %q 没有被派生进保留集合（路由加了静态段而清单没跟上）", seg)
		}
	}
	for seg := range gotSet {
		if !want[seg] {
			t.Errorf("保留集合里的 %q 不在路由表中（清单比路由表宽 = 死条目）", seg)
		}
	}
	// 参数段/通配段绝不进集合（否则 :app_id 自己会被保留掉）。
	for _, seg := range got {
		if strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*") {
			t.Errorf("保留集合里出现了参数/通配段 %q", seg)
		}
	}
	// 现场哨兵：`uploads` 必须在（它是 X4-1 的实际触发名）。
	if !gotSet["uploads"] {
		t.Errorf("静态段 uploads 不在保留集合里（X4-1 的现场会复发）：%v", got)
	}

	// B（接线）：Register 之后 registry 里生效的集合必须与派生结果逐条相同。
	effective := wasmregistry.RouteReservedAppIDs()
	if strings.Join(effective, ",") != strings.Join(got, ",") {
		t.Errorf("registry 生效集合与路由派生不一致：\n got=%v\n want=%v\n"+
			"（Register 里的 publishRouteReservedAppIDs 接线被拆掉或写错位置时会这样）", effective, got)
	}
}

// TestWasmStaticSegmentAppIDsRejectedOnWriteSide —— C。
func TestWasmStaticSegmentAppIDsRejectedOnWriteSide(t *testing.T) {
	r := buildRouteProbeRouter(t)
	segs := WasmAppIDReservedSegments(r.Routes())
	if len(segs) == 0 {
		t.Fatal("静态段集合为空")
	}
	for _, seg := range segs {
		aerr := wasmregistry.ValidateAppID(seg, nil)
		if aerr == nil {
			t.Errorf("app_id=%q 与 WASM 路由静态段同名，写侧必须拒（放过去 = 应用建完即废且永久占名）", seg)
			continue
		}
		// 必须点名"路由静态段"，不能混进"平台保留字"（否则运维查不到病根）。
		if aerr.Details["reason"] != "route_static_segment" {
			t.Errorf("app_id=%q 的拒绝理由应点名 route_static_segment，实得 detail=%v", seg, aerr.Details)
		}
	}
	// 合法 app_id 不受影响（对照集）。
	for _, ok := range []string{"myapp", "expense-note", "hello-picoaide", "app1"} {
		if aerr := wasmregistry.ValidateAppID(ok, nil); aerr != nil {
			t.Errorf("合法 app_id %q 被误拒：%v", ok, aerr)
		}
	}
}

// TestWasmAppIDRoutesAreReachableForAcceptedIDs —— D（可达性判据本身）。
//
// 不变式：**写侧接受什么名字，这个名字的全部 :app_id 路由就必须真的可达**。
// 不得出现"能发布但不可达"。
func TestWasmAppIDRoutesAreReachableForAcceptedIDs(t *testing.T) {
	r := buildRouteProbeRouter(t)
	patterns := wasmAppIDRoutePatterns(t, r)

	// 候选 = **独立复算**出来的全部路由静态段 + 合法名字。
	//
	// 为什么用独立复算而不是 `WasmAppIDReservedSegments()`：后者与保留字清单是同一份实现，
	// "把某个段从清单里过滤掉"会让"清单"与"候选集"同时消失 ⇒ 本判据变成空转。
	// 用独立复算时，那种改动会让 `uploads` 落进"写侧接受"的分支 ⇒ 可达性断言当场红
	//（A/B/C 三条此时全都可能仍是绿的：清单与生效集合一致、清单里的每一项也都被拒）。
	candidates := make([]string, 0, 32)
	for seg := range independentWasmStaticSegments(r.Routes()) {
		candidates = append(candidates, seg)
	}
	sort.Strings(candidates)
	candidates = append(candidates, "myapp", "expense-note", "app1", "hello-picoaide")

	shadowed := 0
	for _, id := range candidates {
		if aerr := wasmregistry.ValidateAppID(id, nil); aerr != nil {
			continue // 写侧已 fail-loud ⇒ 这个名字不可能被发布出来
		}
		for _, pat := range patterns {
			key := strings.SplitN(pat, " ", 2)
			method, tmpl := key[0], key[1]
			path := strings.ReplaceAll(tmpl, ":app_id", id)
			matched := probeMatchedTemplate(r, method, path)
			if matched != tmpl {
				shadowed++
				t.Errorf("app_id=%q 能被写侧接受，但 %s %s 实际命中 %q（期望 %q）—— "+
					"这正是 X4-1 的形态：能发布、但不可达", id, method, path, matched, tmpl)
			}
		}
	}
	// 对照：合法名字必须真的走了这一圈（否则 D 是空转）。
	if got := probeMatchedTemplate(r, "POST", WasmClientRouteBase+"/myapp/releases"); got != WasmClientRouteBase+"/:app_id/releases" {
		t.Fatalf("对照失败：POST %s/myapp/releases 期望命中 :app_id 模板，实得 %q", WasmClientRouteBase, got)
	}
	if shadowed != 0 {
		t.Fatalf("共 %d 条 (app_id, 路由) 组合被遮蔽", shadowed)
	}
}

// TestWasmRouteProbeCatchesShadowing 是 D 的**自校准**：判据必须能咬到已知形态。
//
// 直接在一棵"故意把静态段造得更多"的树上验证探针的判别力 —— 若探针本身写坏
// （比如永远返回期望值），这条会红。
func TestWasmRouteProbeCatchesShadowing(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Header(routeProbeHeader, c.FullPath())
		c.AbortWithStatus(http.StatusTeapot)
	})
	base := r.Group("/api/client/v2/apps/wasm")
	base.POST("/:app_id/releases", func(*gin.Context) {})
	base.POST("/uploads", func(*gin.Context) {})
	base.GET("/uploads/:upload_id", func(*gin.Context) {})

	cases := []struct {
		method string
		path   string
		want   string
	}{
		// 对照（合法 app_id）：命中自己的模板。
		{"POST", "/api/client/v2/apps/wasm/myapp/releases", "/api/client/v2/apps/wasm/:app_id/releases"},
		// 遮蔽形态（X4-1 的第二半）：静态段抢先匹配到**别的** handler。
		{"GET", "/api/client/v2/apps/wasm/uploads/rows", "/api/client/v2/apps/wasm/uploads/:upload_id"},
		// NoRoute 判别力：未命中任何路由必须是空串（不是上一请求的残留值）。
		{"GET", "/api/client/v2/apps/wasm/deep/unmatched/x/y", ""},
	}
	for _, tc := range cases {
		got := probeMatchedTemplate(r, tc.method, tc.path)
		if got != tc.want {
			t.Fatalf("自校准失败：%s %s 期望 %q 实得 %q（探针判别力不足，D 会假绿）", tc.method, tc.path, tc.want, got)
		}
	}
}

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
// 本文件的六条断言（缺任一条都会被变异打红，见 `mutations` 注释）：
//
//	A. 派生集合与**判据侧的第二份实现（镜像）**双向对账（只改了一边 ⇒ 红）。
//	   ⚠️ 它**不是**"独立复算"：镜像与生产实现是同一套规则的两份代码，规则本身
//	   写宽/写窄时两处会**一起错**，A 结构上看不见（S7-R N2 实测：生产与镜像曾
//	   同款自指）。判别力在 E（真实匹配树）与 F（合成树 + 真实匹配树）；
//	B. 派生集合 == registry 里**生效**的集合（接线被拆 ⇒ 红）；
//	C. 每个派生静态段都必须被**写侧**拒（把清单改回旧 host label 清单 ⇒ 红）；
//	D. 任何**写侧接受**的 app_id，其全部 `:app_id` 路由必须在真实路由树上
//	   **逐条命中它自己的模板**（新增静态段遮蔽而未登记 ⇒ 红）；
//	E. 派生集合 == **真实匹配树上真的会遮蔽 `:app_id` 的静态段集合**（S7-2：
//	   多收一个 ⇒ 完全可用的名字被误判成不可用、存量应用发不出新版本；少收一个
//	   ⇒ X4-1 复发。双向对拍，两个方向都必须红）。
//	F. **合成树上**派生集合 == 真实匹配树算出来的遮蔽集合（S7-R N1：真实路由表
//	   今天是"派生 == 真遮蔽 == {uploads}"，自指形态**不显形**；合成树才有判别力
//	   —— 静态路由自己的第二段被当成"应用模板第二段"时，F 当场红）。
//
// E 是 S7-2 补的"反方向"判据：A/B/C/D 都只保证"清单里的项被拒 / 被接受的可达"，
// 对**清单过宽**（拒了可达的名字）结构上没有判据 —— 第一版收"任意深度"的静态段
// 时四条全绿，而 13 个实测 169/169 可达的名字被一律拒。
//
// F 是 S7-R 补的"判别力缺口"判据：E 只在**真实路由表**上有牙，而自指形态（N1）
// 在真实表上恰好与真值等价 ⇒ E/A/B/C/D 全绿（红队 m7 实测）。F 把同一套不变式放到
// **判别力存在的合成树**上跑（真 gin 匹配树当基准，不复用任何推导），两个形态都咬得住。
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

// independentWasmStaticSegments 在**测试里独立枚举**"WASM 前缀之后的全部字面量段"。
//
// 这一条**是**独立的（与 `mirroredWasmShadowingSegments` 不同）：它只是一次**扁平枚举**
// ——"路由表里出现过哪些字面量段"—— 不含任何"会不会遮蔽"的推导规则，所以它不可能与生产
// 实现"一起写错"（生产实现算的是它的**子集**）。它的角色是**候选集**：
// E 拿它做"逐个替换 `:app_id` 再问真实匹配树"的输入，D 拿它做"写侧会不会接受"的输入。
// 判据如果直接复用被测函数的输出，"把某个段从清单里过滤掉"这种改动就两边同时看不见。
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

// underWasmBase / wasmPathSegments / isParamSegment 是测试自己的路径切分（**不**复用
// 生产实现的辅助函数：复用会让"两处一起写错"变成假绿）。
func underWasmBase(path string) bool {
	return path == WasmClientRouteBase || strings.HasPrefix(path, WasmClientRouteBase+"/")
}

func wasmPathSegments(path string) []string {
	return strings.Split(strings.Trim(strings.TrimPrefix(path, WasmClientRouteBase), "/"), "/")
}

func isParamSegment(seg string) bool {
	return seg != "" && (strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*"))
}

// mirroredWasmShadowingSegments 是**判据侧的第二份实现（镜像）**：把"会遮蔽 `:app_id`
// 的静态段"按同一套规则再算一遍，并返回 `:app_id` 出现的层深集合。
//
// ⚠️ **它不是"独立复算"**（S7-R N2 的更正）：它与生产实现（`WasmAppIDReservedSegments`
// → `wasmAppIDSuccessorSegments`）是同一套规则的两份代码。分开写的价值只有一个 ——
// **只改了一边**（例如只在生产里给某个段加过滤）会在这里对不上；而"规则本身写宽/写窄"
// 会让两处**一起错**，本判据结构上看不见。实测证据（红队 m7/P10）：两处曾**同款自指**
// （收 `segs[depth+1]` 时不要求 `segs[depth] == ":app_id"`），在合成树上生产与镜像同时
// 多收 `alpha`，而真实匹配树判定 `alpha` 可达 ⇒ A 全绿。
//
// 真正有判别力的两条判据（都用**真 gin 匹配树**当基准，而不是镜像推导）：
//   - `TestWasmAppIDReservedSegmentsEqualShadowingSet`（E，真实路由表）；
//   - `TestWasmAppIDSuccessorSegmentsComeFromAppIDTemplatesOnly`（F，合成树 —— N1
//     这种"真实表上不显形"的形态只有它咬得住）。
//
// 规则：同层字面量段 `<seg>`，且它在路由表里能把下降领走 ——
//   - `<seg>` 之后没有更多段（叶子）⇒ 不遮蔽（gin 在静态分支找不到子节点时退回参数分支）；
//   - 之后是参数/通配子节点 ⇒ 遮蔽；
//   - 之后是静态子节点 ⇒ 仅当它与某条 `:app_id` 模板的第二段同名时遮蔽。
func mirroredWasmShadowingSegments(routes gin.RoutesInfo) (map[string]bool, map[int]bool) {
	depths := map[int]bool{}
	for _, rt := range routes {
		if !underWasmBase(rt.Path) {
			continue
		}
		for i, seg := range wasmPathSegments(rt.Path) {
			if seg == ":app_id" {
				depths[i] = true
			}
		}
	}
	// 应用自己路由模板的第二段集合（`/:app_id/rows` ⇒ rows）。
	//
	// 取值域必须与生产实现一致：**只有真的在那一层是 `:app_id` 的模板**才算（S7-R N1）。
	// 少了这条闸门，静态路由自己的第二段会被当成"应用模板的第二段"（自指）。
	successors := map[string]bool{}
	for _, rt := range routes {
		if !underWasmBase(rt.Path) {
			continue
		}
		segs := wasmPathSegments(rt.Path)
		for depth := range depths {
			if depth >= len(segs) || segs[depth] != ":app_id" {
				continue
			}
			if depth+1 < len(segs) && !isParamSegment(segs[depth+1]) {
				successors[segs[depth+1]] = true
			}
		}
	}
	want := map[string]bool{}
	for _, rt := range routes {
		if !underWasmBase(rt.Path) {
			continue
		}
		segs := wasmPathSegments(rt.Path)
		for depth := range depths {
			if depth >= len(segs) {
				continue
			}
			seg := segs[depth]
			if seg == "" || isParamSegment(seg) {
				continue
			}
			next := depth + 1
			if next >= len(segs) {
				continue // 叶子：不遮蔽
			}
			if isParamSegment(segs[next]) || successors[segs[next]] {
				want[seg] = true
			}
		}
	}
	return want, depths
}

// sortedSegmentKeys 只用于日志（判据比较用集合）。
func sortedSegmentKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// TestWasmAppIDReservedSegmentsEqualShadowingSet —— E（S7-2 的**双向**判据）。
//
// 不变式：**保留集合恰好等于"在真实匹配树上真的会遮蔽 `:app_id` 的静态段集合"**。
// 判据完全不依赖"深度"推理：对路由表里出现的每一个字面量段 S，逐条把 `:app_id`
// 模板里的参数替换成 S，再问真实 gin 树"这个路径命中了哪条模板"——只要有一条没命中
// 它自己的模板，S 就抢走了应用命名空间。
//
//   - 保留集合里多一个（S 其实可达）⇒ 完全可用的名字被写侧拒；
//     本规则的消费方是**每一次发布**（不只是首版）⇒ 存量应用永远发不出新版本（S7-2 现场）。
//   - 保留集合里少一个（S 真的会遮蔽）⇒ 应用建得成、永远打不开（X4-1 现场）。
func TestWasmAppIDReservedSegmentsEqualShadowingSet(t *testing.T) {
	r := buildRouteProbeRouter(t)
	patterns := wasmAppIDRoutePatterns(t, r)
	candidates := independentWasmStaticSegments(r.Routes())
	if len(candidates) == 0 {
		t.Fatal("路由表里没有任何字面量段 —— 判据失去对象")
	}

	shadowing := map[string]bool{}
	for seg := range candidates {
		for _, pat := range patterns {
			kv := strings.SplitN(pat, " ", 2)
			method, tmpl := kv[0], kv[1]
			path := strings.ReplaceAll(tmpl, ":app_id", seg)
			if got := probeMatchedTemplate(r, method, path); got != tmpl {
				shadowing[seg] = true
				break
			}
		}
	}
	// 自校准（缺了它，"相等"可能是"两边都空"或"探针恒判遮蔽/恒判不遮蔽"）：
	//   - 必须咬到东西；
	//   - `uploads` 是 X4-1 的现场（同层静态段，必须判遮蔽）；
	//   - `rows` 是 S7-2 的现场（深层静态段，审计实测 169/169 可达，必须判不遮蔽）。
	if len(shadowing) == 0 {
		t.Fatal("探针判定 0 个静态段会遮蔽 —— 探针或路由表有问题（判据会退化成空转）")
	}
	if !shadowing["uploads"] {
		t.Fatalf("自校准失败：uploads 是 X4-1 的现场（同层静态段必须先被匹配），探针却判它不遮蔽；"+
			"候选=%v 遮蔽=%v", sortedSegmentKeys(candidates), sortedSegmentKeys(shadowing))
	}
	if shadowing["rows"] {
		t.Fatalf("自校准失败：rows 在真实匹配树上可达（13 名字 × 13 模板 = 169/169），探针却判它遮蔽 —— "+
			"判别力不足会把 S7-2 判成假绿；遮蔽=%v", sortedSegmentKeys(shadowing))
	}

	gotSet := map[string]bool{}
	for _, seg := range WasmAppIDReservedSegments(r.Routes()) {
		gotSet[seg] = true
	}
	for _, seg := range sortedSegmentKeys(gotSet) {
		if !shadowing[seg] {
			t.Errorf("保留集合**多了一个**：%q 在真实匹配树上不会遮蔽 :app_id"+
				"（它的全部 :app_id 模板都命中自己）—— 把完全可用的名字判成不可用，"+
				"而该规则挂在每一次发布上 ⇒ 存量应用永远发不出新版本（S7-2）", seg)
		}
	}
	for _, seg := range sortedSegmentKeys(shadowing) {
		if !gotSet[seg] {
			t.Errorf("保留集合**少了一个**：%q 在真实匹配树上会遮蔽 :app_id"+
				"（写侧放行它 = 应用建得成、但永远打不开，X4-1 复发）", seg)
		}
	}
	t.Logf("真遮蔽集合=%v 派生保留集合=%v（候选字面量段 %d 个：%v）",
		sortedSegmentKeys(shadowing), sortedSegmentKeys(gotSet), len(candidates), sortedSegmentKeys(candidates))
}

// TestWasmAppIDReservedSegmentsAreDerivedFromRouteTable —— A + B。
func TestWasmAppIDReservedSegmentsAreDerivedFromRouteTable(t *testing.T) {
	r := buildRouteProbeRouter(t)

	// A（判据侧镜像，不调用被测函数）：把真实路由表里"会遮蔽 `:app_id` 的静态段"
	// 按同一套规则再算一遍，再与派生结果**双向**对账。
	//
	// 这条的价值边界（S7-R N2 已实测并写进 {@link mirroredWasmShadowingSegments} 的注释）：
	// 它捕捉的是"**只改了一边**"，对"规则本身写宽/写窄"没有判别力 —— 那种形态由 E
	// （真实路由表 + 真实匹配）与 F（合成树 + 真实匹配）负责。
	want, depths := mirroredWasmShadowingSegments(r.Routes())
	if len(want) == 0 {
		t.Fatal("判据侧镜像得到 0 个遮蔽段 —— 路由表或前缀常量写错了（两边一起空 ⇒ A 会退化成空转）")
	}
	if !depths[0] {
		t.Fatalf("`:app_id` 不在前缀之后的第一段（层深集合 %v）—— 路由形状变了，"+
			"派生与判据要一起改", depths)
	}
	got := WasmAppIDReservedSegments(r.Routes())
	gotSet := map[string]bool{}
	for _, seg := range got {
		gotSet[seg] = true
	}
	for seg := range want {
		if !gotSet[seg] {
			t.Errorf("会遮蔽 :app_id 的静态段 %q 没有被派生进保留集合"+
				"（路由加了静态段而清单没跟上 = X4-1 复发）", seg)
		}
	}
	for seg := range gotSet {
		if !want[seg] {
			t.Errorf("保留集合里的 %q 不是遮蔽段（收宽了 = S7-2 的过宽形态：拒了可达的名字）", seg)
		}
	}
	// 参数段/通配段绝不进集合（否则 :app_id 自己会被保留掉）。
	for _, seg := range got {
		if isParamSegment(seg) {
			t.Errorf("保留集合里出现了参数/通配段 %q", seg)
		}
	}
	// 现场哨兵三个方向：
	//   - `uploads` 必须在（X4-1 的实际触发名：它之下有 `/uploads/:upload_id`，
	//     参数子节点会把下一段吞掉 ⇒ 12/13 条 :app_id 模板打不开）；
	//   - `rows` 必须不在（S7-2 的实际触发名：深层静态段，实测 169/169 可达）；
	//   - `catalog` / `proof` / `validate` 必须不在（**同层但没遮蔽**：它们是叶子
	//     静态段，gin 在静态分支找不到子节点时退回参数分支 ⇒ 13/13 条模板全可达）。
	//     第一版"任意深度全收"与只收同层都会把它们误判成不可用。
	if !gotSet["uploads"] {
		t.Errorf("静态段 uploads 不在保留集合里（X4-1 的现场会复发）：%v", got)
	}
	for _, seg := range []string{"rows", "open", "catalog", "proof", "validate"} {
		if gotSet[seg] {
			t.Errorf("静态段 %q 进了保留集合，但它在真实匹配树上可达"+
				"（叶子/深层静态段不会领走 :app_id 的下降）—— 拒了可达的名字，"+
				"存量应用发不出新版本（S7-2）：%v", seg, got)
		}
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

	// 候选 = **独立枚举**出来的全部路由静态段 + 合法名字。
	//
	// 为什么用独立枚举而不是 `WasmAppIDReservedSegments()`：后者与保留字清单是同一份实现，
	// "把某个段从清单里过滤掉"会让"清单"与"候选集"同时消失 ⇒ 本判据变成空转。
	// 用独立枚举时，那种改动会让 `uploads` 落进"写侧接受"的分支 ⇒ 可达性断言当场红
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

// ---------------------------------------------------------------------------
// F：合成树上的派生不变式（S7-R N1 的判别力缺口）
// ---------------------------------------------------------------------------

// buildSyntheticWasmTree 造一棵**合成**路由树：只在 WASM 客户端前缀下注册给定的
// (method, path) 路由，并挂上与生产探针同形的匹配探针中间件。
//
// 为什么需要合成树：E（真实路由表）是**唯一**能判"派生 == 真遮蔽"的判据，但它的取值域
// 只有一张表 —— 自指形态（N1）在那张表上恰好与真值等价（派生 = 真遮蔽 = `{uploads}`），
// 于是 E/A/B/C/D 全绿。合成树把同一套不变式放到**判别力确实存在**的形状上。
func buildSyntheticWasmTree(routes [][2]string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Header(routeProbeHeader, c.FullPath())
		c.AbortWithStatus(http.StatusTeapot)
	})
	r.NoRoute(func(c *gin.Context) {
		c.Header(routeProbeHeader, "")
		c.AbortWithStatus(http.StatusTeapot)
	})
	g := r.Group(WasmClientRouteBase)
	for _, rt := range routes {
		g.Handle(rt[0], rt[1], func(*gin.Context) {})
	}
	return r
}

// shadowingSegmentsByRealMatching 在**给定树上**用真实 gin 匹配算"会遮蔽 `:app_id` 的
// 字面量段集合"（与 E 同一条口径，只是树由调用方给）。
//
// 它**不复用**任何推导（`WasmAppIDReservedSegments` / `mirroredWasmShadowingSegments`）：
// 候选来自扁平枚举，判定来自"把 `:app_id` 换成候选段后，真实匹配树还认不认这条模板"。
func shadowingSegmentsByRealMatching(t *testing.T, r *gin.Engine) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for seg := range independentWasmStaticSegments(r.Routes()) {
		for _, rt := range r.Routes() {
			if !strings.Contains(rt.Path, ":app_id") {
				continue
			}
			path := strings.ReplaceAll(rt.Path, ":app_id", seg)
			if probeMatchedTemplate(r, rt.Method, path) != rt.Path {
				out[seg] = true
				break
			}
		}
	}
	return out
}

// TestWasmAppIDSuccessorSegmentsComeFromAppIDTemplatesOnly —— F（S7-R N1）。
//
// 不变式（与 E 同一条，只是换到判别力存在的树上）：**派生保留集合 == 真实匹配树算出来的
// 遮蔽集合**。四棵树覆盖"自指形态能不能显形"与两条正控：
//
//	F1 静态兄弟 + 应用模板（`/alpha/other` + `/:app_id/rows`）
//	   真值 = {}（`/alpha/rows` 在静态分支找不到 `rows` 子节点 ⇒ gin 退回 `:app_id` 分支）
//	   自指实现会多收 `alpha`（把 `/alpha/other` 的第二段当成"模板第二段"）⇒ 本判据红。
//	F2 静态兄弟 + **真的会遮蔽**的参数子节点（`/beta/:token`）
//	   真值 = {beta}。正控：判据不是"恒判不遮蔽"（少收 `beta` 同样红）。
//	F3 只有应用模板、静态段是叶子（`/gamma`）
//	   真值 = {}。正控：叶子静态段不得被收（gin 在静态分支找不到子节点时退回参数分支）。
//	F4 静态兄弟的第二段**恰好与模板第二段同名**（`/delta/rows`）
//	   真值 = {delta}（`/delta/rows` 命中的是**静态**那条，不是应用模板）—— 这条是
//	   "同名静态子节点"这一支的正控：它是**唯一**该被收的静态子节点形态。
func TestWasmAppIDSuccessorSegmentsComeFromAppIDTemplatesOnly(t *testing.T) {
	cases := []struct {
		name   string
		routes [][2]string
		// wantShadowing 是本用例**必须真的咬到**的段（自校准：少了它，"两边都空"也能绿）。
		wantShadowing []string
		// wantAbsent 是本用例点名的"不得被收"的段（N1 的自指形态收的就是它）。
		wantAbsent []string
	}{
		{
			name: "F1 静态兄弟的第二段与模板第二段**不同名** ⇒ alpha 可达、不得进保留集合",
			routes: [][2]string{
				{http.MethodPost, "/:app_id/rows"},
				{http.MethodPost, "/alpha/other"},
			},
			wantShadowing: nil,
			wantAbsent:    []string{"alpha", "other"},
		},
		{
			name: "F2 同树上加一个真的会遮蔽的参数子节点 ⇒ beta 必须被收（正控）",
			routes: [][2]string{
				{http.MethodPost, "/:app_id/rows"},
				{http.MethodPost, "/alpha/other"},
				{http.MethodPost, "/beta/:token"},
			},
			wantShadowing: []string{"beta"},
			wantAbsent:    []string{"alpha", "other"},
		},
		{
			name: "F3 叶子静态段不遮蔽（gin 退回参数分支）（正控）",
			routes: [][2]string{
				// 两条必须**同方法**：gin 每方法一棵树，跨方法时静态节点根本不参与匹配，
				// 那条"退回参数分支"的路径就没被真的走到（判据会假绿）。
				{http.MethodPost, "/:app_id/rows"},
				{http.MethodPost, "/gamma"},
			},
			wantShadowing: nil,
			wantAbsent:    []string{"gamma"},
		},
		{
			name: "F4 静态子节点**恰好与模板第二段同名** ⇒ delta 该被收（正控）",
			routes: [][2]string{
				{http.MethodGet, "/:app_id/rows"},
				{http.MethodGet, "/delta/rows"},
			},
			wantShadowing: []string{"delta"},
			wantAbsent:    nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := buildSyntheticWasmTree(tc.routes)
			shadowing := shadowingSegmentsByRealMatching(t, r)
			got := map[string]bool{}
			for _, seg := range WasmAppIDReservedSegments(r.Routes()) {
				got[seg] = true
			}
			// 自校准（先证判据有对象、探针有判别力，再比集合 —— 否则"两边都空"会假绿）。
			for _, seg := range tc.wantShadowing {
				if !shadowing[seg] {
					t.Fatalf("自校准失败：真实匹配树判定 %q **不**遮蔽，与用例前提不符（探针或树写坏了）"+
						"；真遮蔽=%v 派生=%v", seg, sortedSegmentKeys(shadowing), sortedSegmentKeys(got))
				}
			}
			for _, seg := range tc.wantAbsent {
				if shadowing[seg] {
					t.Fatalf("自校准失败：%q 被判成遮蔽，而用例前提是它可达；真遮蔽=%v",
						seg, sortedSegmentKeys(shadowing))
				}
			}
			for _, seg := range sortedSegmentKeys(got) {
				if !shadowing[seg] {
					t.Errorf("派生多收了一个：%q 在真实匹配树上可达（它的 :app_id 模板全命中自己）—— "+
						"写侧会拒一个完全可用的名字（S7-R N1 / S7-2 同类）：%v", seg, sortedSegmentKeys(got))
				}
			}
			for _, seg := range sortedSegmentKeys(shadowing) {
				if !got[seg] {
					t.Errorf("派生少收了一个：%q 在真实匹配树上会遮蔽 :app_id（写侧放行 = 应用建得成、"+
						"永远打不开，X4-1 复发）：%v", seg, sortedSegmentKeys(got))
				}
			}
			t.Logf("合成树 %v ⇒ 真遮蔽=%v 派生=%v", tc.routes, sortedSegmentKeys(shadowing), sortedSegmentKeys(got))
		})
	}

	// 反向自校准：把 F1 的树**人为改成**"静态兄弟的第二段与模板第二段同名"（F1'），
	// 派生必须跟着变 —— 否则上面四条可能只是"派生恒空"这一种退化形态在骗人。
	rAlt := buildSyntheticWasmTree([][2]string{
		{http.MethodPost, "/:app_id/other"},
		{http.MethodPost, "/alpha/other"},
	})
	alt := WasmAppIDReservedSegments(rAlt.Routes())
	if len(alt) != 1 || alt[0] != "alpha" {
		t.Fatalf("反向自校准失败：把模板第二段改成 `other` 后，派生应恰好是 [alpha]（`/alpha/other` 会领走 "+
			"`/alpha/other`），实得 %v —— 派生退化成常量或判别力不足", alt)
	}
}

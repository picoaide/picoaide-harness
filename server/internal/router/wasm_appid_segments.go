package router

// wasm_appid_segments.go —— app_id 与 WASM 操作面**路由静态段**的同名冲突
// 收口（第二十四轮审计 X4-1；收窄口径见下方 S7-2）。
//
// 问题（X4-1，P2）：`app_id` 校验只查了一份**旧的子域 DNS label 清单**
// （`limits.ReservedAppIDs`：www/api/admin/…/updates），而 WASM 操作面的路由
// 里存在**同级的静态段**（`/apps/wasm/uploads` 等）。于是 `uploads` 这种"合法英文词、
// 不在旧清单里"的名字能一路通过校验、还能被分片上传链路发布出去，但发布完之后
//
//	POST /api/client/v2/apps/wasm/uploads/{releases,open,request,…}
//	GET  /api/client/v2/apps/wasm/uploads/{rows,schema,diagnostics,…}
//
// 全部落到 NoRoute 或被 `/uploads/:upload_id` 吃掉 ⇒ **应用建完即废、归属与版本号
// 永久占位**，而且作者看到的是"接口不存在"而不是"这个标识符不可用"，无从自查。
//
// 为什么这份清单必须是**派生的**而不是手抄的：路由表是本包声明的，任何新增的
// 静态段都会立刻改变"哪些名字会被遮蔽"。手抄清单在下一次加路由时必然漂移，而漂移的
// 表现正是本条缺陷本身。因此这里只认**真实注册的路由表**（`gin.Engine.Routes()`）。
//
// # S7-2（v2.8.1→HEAD 回归审计，P1）：保留集合必须**恰好**等于真遮蔽集合
//
// 第一版把 WASM 前缀下**任意深度**的静态段全部收进保留集合（`open` / `rows` /
// `export` / `releases` / `request` / `schema` / `publish` / `freeze` / `unpublish` /
// `diagnostics` / `availability` / `chunks` / `complete` 共 13 个），而写侧规则挂在
// **每一次发布**上（`creationAppID` 是发布与 availability 预查的第一步）。后果：
// 这些名字在真实匹配树上**全部可达**（实测 13 个名字 × 13 条 `:app_id` 模板 =
// 169/169 命中自己的模板），却被一律 400 `INVALID_APP_ID` ⇒ X4-1 封口前建出来的
// **存量应用永远发不出新版本**，而服务侧同一份规则是**刻意豁免**的
// （`registry.ValidateAppIDForServing`），两侧口径相反。
//
// 收窄时又实测到第二层事实（比"只收同层"更细）：**同层静态段也未必遮蔽**。
// gin 在每一段先试静态子节点，但当那条静态分支在**下一段找不到可匹配的子节点**时，
// 它会退回参数分支（`skippedNodes`）—— 于是 `/apps/wasm/catalog/rows` 会落到
// `:app_id/rows`。真实路由表上只有 `uploads` 真的遮蔽（12/13 条模板被打断：
// 它之下有 `/uploads/:upload_id`，参数子节点会把下一段吞掉）；`catalog` / `proof` /
// `validate` 都是**叶子**静态段（各自只有 `…/<seg>` 一条路由），作为 app_id 时
// 13/13 条 `:app_id` 模板全部可达。把它们一并保留同样是"拒了可达的名字"（S7-2 同类）。
//
// 因此判定口径 = **"这个静态段能不能把 `:app_id` 的下降领走"**：
//   - `…/<seg>` 之后**没有**更多段（叶子）⇒ 不遮蔽（gin 退回参数分支）；
//   - 之后有**参数/通配**子节点 ⇒ 遮蔽（任意下一段都会被它吞掉）；
//   - 之后是**静态**子节点 ⇒ 仅当该子节点与某条 `:app_id` 模板的第二段同名时才遮蔽
//     （那时 `/apps/wasm/<seg>/<同名段>` 命中的是那条静态路由，而不是应用的模板）。
//
// 上面第三条里的"模板第二段"有**取值域**（S7-R N1）：只能从**真的在那一层是 `:app_id`
// 的模板**里收（`segs[depth] == ":app_id"`）。把静态路由自己的第二段也算进来就是自指，
// 会把完全可用的名字收进保留集合 —— 见 {@link wasmAppIDSuccessorSegments} 的注释。
//
// 判据（`wasm_appid_route_test.go`）：
//   - 派生集合与"**在真实匹配树上真的会遮蔽**的静态段集合"**双向**相等
//     （`TestWasmAppIDReservedSegmentsEqualShadowingSet`：多一个或少一个都红）；
//   - 每个派生出来的静态段都必须被写侧拒（`registry.ValidateAppID`）；
//   - 任何**写侧接受**的 app_id，其全部 `:app_id` 路由必须在真实路由树上可达
//     （用真实 gin 匹配 + `c.FullPath()`，不执行 handler）；
//   - 端到端（`internal/wasmapp/api/audit_s72_deep_static_upgrade_test.go`）：
//     深层静态段名字（`rows`）先建应用、再发第二个版本，两次都必须 201。

import (
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	wasmregistry "github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// WasmClientRouteBase 是 WASM 客户端（员工面）操作面的路由前缀。
//
// 与 `registerWasm` 里 `r.Group(NamespaceClientV2+"/apps/wasm", …)` 同源：
// 这里用常量而不是字面量，避免两处各写一份再漂移。
const WasmClientRouteBase = NamespaceClientV2 + "/apps/wasm"

// appIDParamSegment 是 app_id 在路由模板里的参数段名（gin 语法要求字面量）。
//
// 与 `registerWasm` 的 `wg.POST("/:app_id/…")` 同源；写错的表现是派生集合变空，
// `wasm_appid_route_test.go` 的"集合与真实匹配树双向对拍"会立刻红。
const appIDParamSegment = ":app_id"

// wasmRouteSegments 把一条路由路径拆成 WASM 前缀之后的段。
// @returns (段列表, 是否属于 WASM 前缀)。
func wasmRouteSegments(path string) ([]string, bool) {
	if path != WasmClientRouteBase && !strings.HasPrefix(path, WasmClientRouteBase+"/") {
		return nil, false
	}
	rest := strings.Trim(strings.TrimPrefix(path, WasmClientRouteBase), "/")
	if rest == "" {
		return nil, true
	}
	return strings.Split(rest, "/"), true
}

// isParamOrWildcard 判定段是否为 gin 的参数段（`:name`）或通配段（`*name`）。
func isParamOrWildcard(seg string) bool {
	return seg != "" && (strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*"))
}

// wasmAppIDDepths 返回 `:app_id` 出现在 WASM 路由里的**层深集合**
// （本平台恒为 {0}：紧邻前缀；写成推导式是为了将来 app_id 若挪到更深一层，
// "会遮蔽的静态段"的定义自动跟上，而不是又出现一份手抄口径）。
func wasmAppIDDepths(routes []gin.RouteInfo) map[int]bool {
	depths := map[int]bool{}
	for _, rt := range routes {
		segs, ok := wasmRouteSegments(rt.Path)
		if !ok {
			continue
		}
		for i, seg := range segs {
			if seg == appIDParamSegment {
				depths[i] = true
			}
		}
	}
	return depths
}

// wasmAppIDSuccessorSegments 返回 `:app_id` 各层深**下一段**上出现的字面量段
// （= 应用自己路由模板的第二段集合：`/:app_id/rows` ⇒ `rows`）。
//
// 它只用于判定一种形态：静态子节点**恰好与模板第二段同名**时，那条静态路由会把
// `/apps/wasm/<seg>/<同名段>` 领走（其余同名以外的静态子节点不会 —— 下一段不匹配时
// gin 退回参数分支）。
//
// **取值域是"这条路由在该层真的就是 `:app_id` 模板"**（S7-R N1）：`segs[depth]` 必须
// 逐字等于 {@link appIDParamSegment}。少了这条，静态路由**自己的**第二段会被当成
// "应用模板的第二段"（自指）——例如合成树 `POST /alpha/other` + `POST /:app_id/rows`
// 会把 `other` 收进来，而真正要收的 `rows` 反而取决于别的模板 ⇒ 任何"同层且不止一段"
// 的静态路由都会被判成遮蔽段（写侧拒一个**完全可用**的名字，S7-2 同类形态）。
//
// 今天不显形（真实表的派生结果 == 真遮蔽集合 == `{uploads}`），但它是结构性的：
// 加一条最普通的 `POST /apps/wasm/<seg>/<literal>` 就会多收一个段。判据：
// `wasm_appid_route_test.go` 的 `TestWasmAppIDSuccessorSegmentsComeFromAppIDTemplatesOnly`
// （合成树 + 真实 gin 匹配树对拍，多收即红）。
func wasmAppIDSuccessorSegments(routes []gin.RouteInfo, depths map[int]bool) map[string]bool {
	out := map[string]bool{}
	for _, rt := range routes {
		segs, ok := wasmRouteSegments(rt.Path)
		if !ok {
			continue
		}
		for depth := range depths {
			// 自指闸门：只有"这条路由在该层是 `:app_id`"时，后继段才是应用模板的第二段。
			if depth >= len(segs) || segs[depth] != appIDParamSegment {
				continue
			}
			next := depth + 1
			if next >= len(segs) {
				continue
			}
			seg := segs[next]
			if seg == "" || isParamOrWildcard(seg) {
				continue
			}
			out[seg] = true
		}
	}
	return out
}

// staticSegmentShadowsAppID 判定"`<seg>` 位于 `depth` 段的那条路由"是否会把
// `:app_id` 的下降领走（= 用 `<seg>` 当 app_id 会有路由打不开）。
//
// 三种形态（与真实 gin 匹配树实测对齐，见文件头 S7-2 段）：
//   - `<seg>` 之后没有更多段（叶子路由）⇒ 不遮蔽；
//   - 之后是参数/通配子节点 ⇒ 遮蔽（它会吞掉下一段）；
//   - 之后是静态子节点 ⇒ 只在与某条 `:app_id` 模板的第二段同名时遮蔽。
func staticSegmentShadowsAppID(segs []string, depth int, appSuccessors map[string]bool) bool {
	next := depth + 1
	if next >= len(segs) {
		return false
	}
	if isParamOrWildcard(segs[next]) {
		return true
	}
	return appSuccessors[segs[next]]
}

// WasmAppIDReservedSegments 从**真实注册的路由表**派生"会遮蔽 `:app_id` 的静态段"
// （= 与 `:app_id` 同层、且能把下降领走的字面量段），排序去重后返回。
//
// 多收（拒了可达的名字）与少收（放行了打不开的名字）都会被打红
// （`TestWasmAppIDReservedSegmentsEqualShadowingSet` 用真实匹配树双向对拍），
// 所以这里不需要"宁可多留几个"的保守余量。
func WasmAppIDReservedSegments(routes []gin.RouteInfo) []string {
	depths := wasmAppIDDepths(routes)
	appSuccessors := wasmAppIDSuccessorSegments(routes, depths)
	seen := make(map[string]struct{})
	for _, rt := range routes {
		segs, ok := wasmRouteSegments(rt.Path)
		if !ok {
			continue
		}
		for depth := range depths {
			if depth >= len(segs) {
				continue
			}
			seg := segs[depth]
			if seg == "" || isParamOrWildcard(seg) {
				continue
			}
			if !staticSegmentShadowsAppID(segs, depth, appSuccessors) {
				continue
			}
			seen[seg] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for seg := range seen {
		out = append(out, seg)
	}
	sort.Strings(out)
	return out
}

// publishRouteReservedAppIDs 把派生结果注入 registry（写侧封口的唯一入口）。
//
// 注入而不是让 registry 反过来 import 本包：`router → wasmapi → registry`
// 已经是既有依赖方向，反着 import 会成环。注入点只有 Register 一处，
// `wasm_appid_route_test.go` 的"路由派生 == registry 里生效的集合"断言
// 保证这条接线被删掉时立刻变红。
func publishRouteReservedAppIDs(routes []gin.RouteInfo) {
	wasmregistry.SetRouteReservedAppIDs(WasmAppIDReservedSegments(routes))
}

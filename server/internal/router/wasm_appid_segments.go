package router

// wasm_appid_segments.go —— app_id 与 WASM 操作面**路由静态段**的同名冲突
// 收口（第二十四轮审计 X4-1）。
//
// 问题（X4-1，P2）：`app_id` 校验只查了一份**旧的子域 DNS label 清单**
// （`limits.ReservedAppIDs`：www/api/admin/…/updates），而 WASM 操作面的路由
// 里存在**同级的静态段**（`/apps/wasm/uploads`、`/validate`、`/catalog`、`/proof`）。
// 于是 `uploads` 这种"合法英文词、不在旧清单里"的名字能一路通过校验、还能被
// 分片上传链路发布出去，但发布完之后
//
//	POST /api/client/v2/apps/wasm/uploads/{releases,open,request,…}
//	GET  /api/client/v2/apps/wasm/uploads/{rows,schema,diagnostics,…}
//
// 全部落到 NoRoute（404 接口不存在）或被 `UploadStatus`（`/uploads/:upload_id`）
// 吃掉 ⇒ **应用建完即废、归属与版本号永久占位**，而且作者看到的是"接口不存在"
// 而不是"这个标识符不可用"，无从自查。
//
// 为什么这份清单必须是**派生的**而不是手抄的：路由表是本包声明的，任何新增的
// 静态段（例如将来加一条 `/apps/wasm/preview`）都会立刻改变"哪些名字会被遮蔽"。
// 手抄清单在下一次加路由时必然漂移，而漂移的表现正是本条缺陷本身。
// 因此这里只认**真实注册的路由表**（`gin.Engine.Routes()`，与
// `cmd/server` 的路由转储、`api_sweep_test.go` 的全路由扫描同一个来源）。
//
// 判据（`wasm_appid_route_test.go`）：
//   - 每个派生出来的静态段都必须被写侧拒（`registry.ValidateAppID`）；
//   - 任何**写侧接受**的 app_id，其全部 `:app_id` 路由必须在真实路由树上可达
//     （用真实 gin 匹配 + `c.FullPath()`，不执行 handler）；
//   - 派生集合与路由表**双向**对账（路由加了静态段而派生漏了 ⇒ 红）。

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

// WasmAppIDReservedSegments 从**真实注册的路由表**派生 WASM 操作面里的全部
// 静态段（`:app_id` 参数段与 `*file` 通配段不算），排序去重后返回。
//
// 为什么是"全部静态段"而不是"与 `:app_id` 同级的静态段"：同级静态段只是**当前**
// 路由形状下会遮蔽的那几个；将来任何一条新静态路由（无论挂在哪一层）都可能变成
// `:app_id` 的同级，派生集合自动跟上。多留几个保留字的代价远小于"应用建完即废"。
func WasmAppIDReservedSegments(routes []gin.RouteInfo) []string {
	seen := make(map[string]struct{})
	for _, rt := range routes {
		if rt.Path != WasmClientRouteBase && !strings.HasPrefix(rt.Path, WasmClientRouteBase+"/") {
			continue
		}
		rest := strings.TrimPrefix(rt.Path, WasmClientRouteBase)
		for _, seg := range strings.Split(strings.Trim(rest, "/"), "/") {
			if seg == "" || strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*") {
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

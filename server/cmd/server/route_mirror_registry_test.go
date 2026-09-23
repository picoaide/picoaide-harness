package main

// 「业务包直挂引擎」形态的守卫（R4-C-7 现象 A，审计 2026-09-23）。
//
// 背景：`server/AGENTS.md §7.0` 规定**路由集中声明在 internal/router**，业务包
// 只暴露 `Handlers`（gin.HandlerFunc 集合），不得自行 `r.Group()` 注册生产路由。
// 但各业务包为了"测试自建路由树"仍保留了一批 `RegisterRoutes` / `RegisterAdminRoutes`
// 镜像函数 —— 它们直接接收 `*gin.Engine`。此前这些入口**只受注释约束**：
//
//   - `bootstrap.RegisterRoutes` 直挂 `/healthz` + bootstrap 端点，生产**不调用**它
//     （生产由 cmd/server 直挂 healthz、internal/router 声明 bootstrap），只被包内
//     测试调用 ⇒ 双份真源，且位于所有守卫的扫描面之外（cmd/server 的直挂守卫只扫
//     自己包的源码，见 route_declaration_guard_test.go 的能力边界）。**本轮已移除**
//     （测试改用 `NewHandlers` 的 handler 自行组树）。
//   - 其余镜像被大量测试依赖（serverauth/marketplace/llmgateway/… 的用例都靠它们组
//     树），移除不现实 ⇒ 处置是「**登记**」：每一个直挂引擎的镜像函数都必须在本文件的
//     `routeMirrorRegistry` 里逐条登记并写明理由。
//
// 两条判据（缺任何一条都会退化成"注释承诺"）：
//
//	1. **扫描面 ⊆ 登记表**：`internal/**`（非测试源码）里每一个
//	   `RegisterRoutes` / `RegisterAdminRoutes` 定义都必须登记；新增镜像不登记即红；
//	2. **登记表 ⊆ 扫描面**：登记了却找不到定义（改名/删除/整包搬走）即红 —— 防止
//	   清单陈旧成"看起来有守卫"的摆设。
//
// 外加一条方向相反的判据（真正的危害面）：**生产装配点不得调用任何镜像** ——
// `cmd/server` 与 `internal/router` 的非测试源码里出现对 `X.RegisterRoutes(...)` /
// `X.RegisterAdminRoutes(...)` 的调用即红（豁免表刻意留空）。这条直接对应
// "把测试镜像接进生产"的形态：它会让生产树出现未申报/未登记的路由。
//
// 变异验证（本轮实测）：
//   - 往 `internal/telemetry/routes.go` 加一个未登记的新镜像函数 ⇒ 判据 1 红；
//   - 删掉 `routeMirrorRegistry` 里的一条（定义仍在）⇒ 判据 2 红；
//   - 在 `internal/router/router.go` 里写一行 `bootstrap.RegisterRoutes(r, d.DB)` ⇒
//     判据 3 红。

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// routeMirrorRegistry 登记所有「直挂 *gin.Engine 的业务包镜像函数」。
//
// 键 = `<repo 相对路径>:<函数名>`（`server/internal/...`）；值 = 为什么必须存在
// （不能一句话说清"它只是图方便"的条目说明该函数该被移除）。
var routeMirrorRegistry = map[string]string{
	"server/internal/agentshare/routes.go:RegisterRoutes":              "测试镜像：组织共享 Agent 的客户端只读面（生产由 internal/router 声明）",
	"server/internal/agentshare/routes.go:RegisterAdminRoutes":         "测试镜像：组织共享 Agent 的管理面（同上）",
	"server/internal/capabilities/capabilities.go:RegisterRoutes":      "测试镜像：能力中心客户端面",
	"server/internal/capabilities/capabilities.go:RegisterAdminRoutes": "测试镜像：能力中心管理面",
	"server/internal/connectors/admin.go:RegisterAdminRoutes":          "测试镜像：连接器管理面",
	"server/internal/llmgateway/admin.go:RegisterAdminRoutes":          "测试镜像：网关管理面（用例需要真实的网关 handler 集合）",
	"server/internal/llmgateway/routes.go:RegisterRoutes":              "测试镜像：/v1 网关全端点（llmgateway 不能 import router，会成环）",
	"server/internal/marketplace/admin.go:RegisterAdminRoutes":         "测试镜像：市场管理面",
	"server/internal/marketplace/routes.go:RegisterRoutes":             "测试镜像：市场客户端面",
	"server/internal/marketplace/skill_api.go:RegisterRoutes":          "测试镜像：技能 API（方法接收者形态）",
	"server/internal/serverauth/admin.go:RegisterAdminRoutes":          "测试镜像：管理面登录/会话/RBAC（router 包的对拍基准之一）",
	"server/internal/serverauth/handler.go:RegisterRoutes":             "测试镜像：员工认证面（方法接收者形态）",
	"server/internal/sharedskills/routes.go:RegisterRoutes":            "测试镜像：共享技能客户端面",
	"server/internal/sharedskills/routes.go:RegisterAdminRoutes":       "测试镜像：共享技能管理面",
	"server/internal/telemetry/routes.go:RegisterRoutes":               "测试镜像：客户端遥测上报面",
}

// routeMirrorProductionCallAllowList 是"生产装配允许调用镜像"的豁免表（当前为空）。
//
// 出现豁免的唯一正当理由是"生产确实需要这份路由子集，且它已在 internal/router
// 里同步申报并登记"；空表 = 任何调用都红。
var routeMirrorProductionCallAllowList = map[string]string{}

// routeScanRoot 是 `server/` 目录相对本包（server/cmd/server）的路径。
const routeScanRoot = "../.."

func TestRouteMirrorsAreRegistered(t *testing.T) {
	found := map[string]string{} // 键 → 定义位置（file:line）
	err := filepath.WalkDir(routeScanRoot+"/internal", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if strings.Contains(path, "testdata") {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel := strings.TrimPrefix(filepath.ToSlash(path), routeScanRoot+"/")
		if !strings.HasPrefix(rel, "internal/") {
			return nil
		}
		src, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		fset := token.NewFileSet()
		f, perr := parser.ParseFile(fset, path, src, 0)
		if perr != nil {
			return fmt.Errorf("parse %s: %w", rel, perr)
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil && len(fn.Recv.List) == 0 {
				continue
			}
			if fn.Name.Name != "RegisterRoutes" && fn.Name.Name != "RegisterAdminRoutes" {
				continue
			}
			// 只认"直挂引擎"的形态：第一个参数是 *gin.Engine。
			if !takesGinEngine(fn) {
				continue
			}
			found["server/"+rel+":"+fn.Name.Name] = fmt.Sprintf("%s:%d", rel, fset.Position(fn.Pos()).Line)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) == 0 {
		t.Fatal("扫描面为空（一个直挂引擎的镜像都没找到）—— 判据失效，绝不静默通过")
	}
	var unregistered []string
	for key, pos := range found {
		if _, ok := routeMirrorRegistry[key]; !ok {
			unregistered = append(unregistered, key+"  ("+pos+")")
		}
	}
	if len(unregistered) > 0 {
		sort.Strings(unregistered)
		t.Fatalf("业务包直挂引擎的路由入口未登记（%d 个）：\n  %s\n"+
			"⇒ 要么在本文件的 routeMirrorRegistry 里登记理由（测试镜像），要么把路由改到 internal/router 声明",
			len(unregistered), strings.Join(unregistered, "\n  "))
	}
	var stale []string
	for key := range routeMirrorRegistry {
		if _, ok := found[key]; !ok {
			stale = append(stale, key)
		}
	}
	if len(stale) > 0 {
		sort.Strings(stale)
		t.Fatalf("登记表里有 %d 条已不存在（改名/删除/搬走）：\n  %s\n⇒ 清理 routeMirrorRegistry（陈旧清单会假装有守卫）",
			len(stale), strings.Join(stale, "\n  "))
	}
}

// TestProductionAssemblyDoesNotCallRouteMirrors 判据 3：生产装配点不得调用镜像。
func TestProductionAssemblyDoesNotCallRouteMirrors(t *testing.T) {
	scanned := 0
	var violations []string
	for _, dir := range []string{".", routeScanRoot + "/internal/router", routeScanRoot + "/internal/bootstrap"} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			path := filepath.Join(dir, e.Name())
			src, rerr := os.ReadFile(path)
			if rerr != nil {
				t.Fatal(rerr)
			}
			scanned++
			fset := token.NewFileSet()
			f, perr := parser.ParseFile(fset, path, src, 0)
			if perr != nil {
				t.Fatalf("parse %s: %v", path, perr)
			}
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if sel.Sel.Name != "RegisterRoutes" && sel.Sel.Name != "RegisterAdminRoutes" {
					return true
				}
				key := filepath.ToSlash(path) + ":" + sel.Sel.Name
				if _, exempt := routeMirrorProductionCallAllowList[key]; exempt {
					return true
				}
				line := fset.Position(call.Pos()).Line
				violations = append(violations, fmt.Sprintf("%s:%d 调用了 %s（业务包的测试镜像）", path, line, sel.Sel.Name))
				return true
			})
		}
	}
	if scanned == 0 {
		t.Fatal("扫描面为空（生产装配包一个 Go 文件都没读到）—— 判据失效")
	}
	if len(violations) > 0 {
		sort.Strings(violations)
		t.Fatalf("生产装配不得调用业务包的路由镜像（%d 处）：\n  %s\n"+
			"⇒ 路由必须在 internal/router 集中声明（§7.0）；若确实需要豁免，在 routeMirrorProductionCallAllowList 里逐条登记",
			len(violations), strings.Join(violations, "\n  "))
	}
}

// takesGinEngine 判定函数首个参数是否为 *gin.Engine（含命名返回/匿名参数形态）。
func takesGinEngine(fn *ast.FuncDecl) bool {
	if fn.Type.Params == nil || len(fn.Type.Params.List) == 0 {
		return false
	}
	star, ok := fn.Type.Params.List[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	sel, ok := star.X.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "gin" && sel.Sel.Name == "Engine"
}

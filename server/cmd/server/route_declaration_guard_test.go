package main

// 装配层不得直挂 /api 命名空间的路由（A-8 F1 残差加固，2026-09-23）。
//
// 缺陷现场（独立复验 temp/verify-a8a11-gaps/VERIFY.md §1.4；本轮 2026-09-23 逐形态实跑
// 复核，见 temp/round3-2026-09-23/fix-route-declaration-blindspot.md）：
// A-8 的 F1 修复把「市场命名空间渠道口径清单」与**生产路由表**做了双向对拍，关掉了
// "只改 internal/router/router.go 就绕过守门"的盲区。但它（以及本包既有的一批装配/扫描
// 守卫）都建立在同一个前提上：**路由只经 internal/router.Register 声明**。绕过这个
// 前提、直接在 registerProductionRoutes 里 `r.GET(...)` 挂路由时：
//
//   - **不带鉴权**的形态被 TestAPISweepAllRoutesContract 抓住（未认证回 200，与
//     "认证闸之后的 API 必须 401" 冲突）；
//   - **带 serverauth.AdminAuth 且落在 /api/server/admin/\*** 的形态会被既有的
//     TestAdminRouterNoFallOpen 顺带抓住（路由表里有、AdminRoute 权限表里没有）——
//     复验报告说"完全不可见"对这一种形态不成立（本轮实测更正）；
//   - 但**其余带鉴权形态是真的全绿盲区**，实测三种：员工面 `/api/client/v2/*`
//     （BearerAuth）、非 admin 的 `/api/server/*`、以及**经 serverauth.AdminRoute 直挂**
//     （权限申报齐了，故 NoFallOpen 也绿）—— 对 cmd/server 全部既有守卫、
//     internal/router 的生产判据、internal/marketplace 的镜像守门都不可见。
//
// 本用例补的就是那个残差：**cmd/server 包（非测试源码）里出现的每一个 gin 路由注册
// 调用，其路径都必须落在直接挂载白名单 directRouteAllowList 内，且不得落在 /api
// 命名空间下**。
//
// 为什么扫描面是"整个 cmd/server 包"而不是只解析 registerProductionRoutes 的函数体：
//   - 它是"registerProductionRoutes **及其可达装配代码**"的超集 ⇒ 有人把直挂挪进同包
//     helper（`registerProductionRoutes` → `applyExtraRoutes(r)`）照样被咬住；
//   - 还顺带覆盖"main() 在 registerProductionRoutes 之后又调了一个挂路由的函数"这条
//     路 —— 局部可达闭包做不到（那条函数不在 registerProductionRoutes 的可达集里），
//     而它同样能把路由挂上引擎；
//   - 代价是：同包内**任何**直挂都必须登记 —— 这正是"直挂是例外、必须逐个申报"的语义
//     （现有正当例外只有 /healthz、/readyz 两个探针，见 directRouteAllowList）。
//
// 判据的四个方向（缺任何一个都会退化成"标签"或空转）：
//  1. **白名单 ⊆ 扫描面**：清单里的路径必须真的扫到（证明判据在看这段代码，不是空转）；
//  2. **扫描面 ⊆ 白名单**：扫到的路径必须在清单里（新增直挂必须显式登记，逐个申报）；
//  3. **命名空间**：解析结果不得等于 /api 或以 /api/ 开头（含 router.NamespaceServer /
//     router.NamespaceClientV2 这两个真源常量及其 `+ "/…"` 拼接）；
//  4. **扫描面为空 = 红**：registerProductionRoutes 找不到、或包内一个注册调用都扫不到
//     ⇒ fail-loud，绝不静默通过（本仓已多次踩过"扫不到 ⇒ 宣称一致"）。
//
// 能力边界（不夸大；报告 §"这条判据拦不住什么"逐条认账）：
//   - 只做**常量折叠**：字符串字面量、同包 const（含链式 const）、`a + b` 拼接、
//     `pkg.NamespaceServer|NamespaceClientV2` 选择器。路径来自变量 / 函数返回值 /
//     结构体字段 ⇒ 记"无法静态判定"并**红**（是 fail-loud，不是放过）；
//   - 路由组前缀只跟随**同函数内的赋值**（`g := r.Group(p)` 与链式
//     `r.Group(p).GET(...)`）；经函数返回、结构体字段、跨函数传递拿到的组 ⇒ 落回
//     上一条（无法判定 ⇒ 红）；
//   - 别的包（internal/**）里的直挂不在扫描面内 —— 它们够不到引擎实例，路由表漂移由
//     运行期装配守卫（TestRouteAssemblyMatchesProductionSource 等）负责；本判据只钉
//     "引擎在 cmd/server 里被直接挂上了哪些路由"；
//   - 覆盖的注册形态 = gin v1.12.0 `*gin.RouterGroup` 上**全部**带路径实参的方法
//     （GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS/Any/Handle/Match/Static/StaticFS/
//     StaticFile/StaticFileFS）+ `Group(...)` 组前缀；这份方法表由
//     TestDirectRouteMethodTableCoversGinRouterGroup 用反射对拍 gin 的真实方法集，
//     漏登记（含 gin 升级新增注册方法）会红 —— 判据自己也不许静默漏扫。
//   - **拦不住**的形态（需要刻意规避约定，且都会在 review 里露出来）：把引擎传到别的包
//     再挂；函数值/方法值转手（`reg := r.GET; reg("/api/x", h)`）；反射调用；
//     把 gin 生成的 ORM/第三方 RouterGroup 包装类型当接收者（接收者不参与判定，只看
//     方法名与路径实参 —— 所以这一条其实仍会被路径判据咬住，只有"路径也判定不出来"
//     时才落回 fail-loud）。

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/router"
)

// directRouteHint 是红信息里那句可直接照抄的处置口径。
const directRouteHint = "请改到 internal/router 集中声明（server/AGENTS.md §7.0：所有路由必须经 internal/router.Register 装配）"

// directRouteAllowList：允许在 cmd/server 装配层**直接挂载**的路径白名单（路径 → 理由）。
//
// 语义是"恰好等于"（双向核对）：扫描面有而清单没有 ⇒ 红（新增直挂必须登记）；
// 清单有而扫描面没有 ⇒ 也红（死条目会让判据空转，也会掩盖"探针被悄悄搬走"）。
// 登记一条 = 声明三件事：①它不属于 /api、/v1 命名空间；②它必须比 router.Register
// 更早/更直接地挂上引擎（拿不到 Deps 或必须与 DB 可用性解耦）；③它的失效形态已被
// 别的判据盯住。不满足这三条的直挂没有理由存在 —— 走 internal/router.Register。
var directRouteAllowList = map[string]string{
	"/healthz": "存活探针（bootstrap.Health）：不属于任何 API 命名空间，DB 不可用时也必须能答",
	"/readyz":  "运维就绪探针（productionDeps.Ready）：同上，且装配期传 nil 即 panic（registerProductionRoutes 首段）",
}

// directRouteMethods：gin 上真的会往路由表里加条目的方法 → 路径实参的下标。
//
// 集合取自 gin v1.12.0 的 `*gin.RouterGroup`（routergroup.go 里全部带路径实参的方法），
// 并由 TestDirectRouteMethodTableCoversGinRouterGroup 用反射对拍 gin 的**真实方法集**：
// 漏登记（gin 升级新增注册方法 / 有人删了这里的条目）会红 —— 判据不许静默漏扫。
//
// 刻意**不含** NoRoute / Use / HandleMethodNotAllowed：NoRoute 的实参是 handler 不是
// 路径（mountAPIGuards 就是用它挂 NoRoute 护栏的）。大小写敏感，所以 `c.Get(...)`
// （*gin.Context.Get，读上下文键）不会被当成 `GET` 路由 —— 这是本判据不做类型检查
// 还能站得住的前提。
var directRouteMethods = map[string]int{
	"GET": 0, "POST": 0, "PUT": 0, "DELETE": 0, "PATCH": 0,
	"HEAD": 0, "OPTIONS": 0, "Any": 0,
	"Static": 0, "StaticFS": 0, "StaticFile": 0, "StaticFileFS": 0,
	"Handle": 1, // Handle(httpMethod, relativePath string, handlers ...HandlerFunc)
	"Match":  1, // Match(methods []string, relativePath string, handlers ...HandlerFunc)
}

// directRouteSpecialMethods：gin 上"有路径实参、但不是路由注册"的方法 → 为什么不算。
//
// 它们同样受 TestDirectRouteMethodTableCoversGinRouterGroup 的双向核对 —— 例外必须
// 写明理由，不许"登记了就不用管"。
var directRouteSpecialMethods = map[string]string{
	"Group": "只建路由组、不注册路由；组前缀由 receiverGroupPrefix / collectGroupPrefixes 折叠，" +
		"组本身落在 /api 下时同样报红（见 scanRouteCallsInFunc 的 Group 分支）",
}

// directRouteNamespaceConstants 是"命名空间常量名 → 取值"。
//
// 取值直接来自 internal/router 的**导出常量**（不抄字面量）：命名空间真源改前缀时，
// 下面的自检会当场红，判据不会与真源漂移。
var directRouteNamespaceConstants = map[string]string{
	"NamespaceServer":   router.NamespaceServer,
	"NamespaceClientV2": router.NamespaceClientV2,
}

// unresolvedGroupPrefix 是"路由组前缀无法静态判定"的哨兵值（不会与真实路径相撞）。
const unresolvedGroupPrefix = "\x00unresolved"

// directRouteCall 是一次静态扫到的路由注册调用。
type directRouteCall struct {
	file     string // 包内文件名
	line     int    // 1 起
	fn       string // 所在函数（便于人读"这是哪段装配代码"）
	src      string // 该行原文（红信息里可直接照抄）
	group    string // 路由组前缀（"" = 直接挂在 engine 上）
	path     string // 静态解析出的完整路径（仅 resolved 时有效）
	resolved bool
	why      string // 无法静态判定时的原因
}

// describe 输出一条可照抄的定位信息。
func (c directRouteCall) describe() string {
	target := strconv.Quote(c.path)
	if !c.resolved {
		target = "无法静态判定（" + c.why + "）"
	}
	if c.group != "" {
		target += fmt.Sprintf("（路由组前缀 %s）", strconv.Quote(c.group))
	}
	return fmt.Sprintf("  %s:%d（函数 %s）：%s\n      → 解析为 %s", c.file, c.line, c.fn, c.src, target)
}

// inAPINamespace 判定一个路径是否落在 /api 命名空间（/api 本身或 /api/… 之下）。
func inAPINamespace(path string) bool {
	return path == "/api" || strings.HasPrefix(path, "/api/")
}

// TestRouteAssemblyDoesNotMountAPINamespaceDirectly：装配层直挂清单判据（详见文件头）。
func TestRouteAssemblyDoesNotMountAPINamespaceDirectly(t *testing.T) {
	// 前置自检：命名空间真源必须真的在 /api 之下。它一旦变化，本判据的判据面必须同步
	// —— 否则"扫到了但不算违规"会静默发生。
	for name, value := range directRouteNamespaceConstants {
		if !inAPINamespace(value) {
			t.Fatalf("internal/router.%s = %q 不在 /api 命名空间下 —— 命名空间真源已变，"+
				"本用例的判据面需要同步（这不是被测代码的问题，是判据自己的前提坏了）", name, value)
		}
	}

	calls := scanDirectRouteRegistrations(t)
	if len(calls) == 0 {
		t.Fatalf("cmd/server 包的非测试源码里一个路由注册调用都扫不到 —— 扫描面为空，不得静默通过。" +
			"（若确实把 /healthz、/readyz 移进了 internal/router，请同步更新本用例的扫描面与 directRouteAllowList）")
	}

	var namespaceViolations, offList, unresolved []directRouteCall
	seen := map[string]bool{}
	for _, c := range calls {
		if !c.resolved {
			unresolved = append(unresolved, c)
			continue
		}
		seen[c.path] = true
		if inAPINamespace(c.path) {
			namespaceViolations = append(namespaceViolations, c)
			continue
		}
		if _, ok := directRouteAllowList[c.path]; !ok {
			offList = append(offList, c)
		}
	}

	if len(namespaceViolations) > 0 {
		t.Errorf("装配层直挂了 /api 命名空间的路由（%d 处）—— %s：\n%s\n"+
			"  为什么必须红：直挂绕过了 internal/router 的集中声明；带鉴权时未认证仍回 401、与其它 API "+
			"逐字同形，于是 TestAPISweepAllRoutesContract（只看未认证状态码）、TestRouteAssembly*"+
			"（比较两棵同源树）、internal/router 的生产判据与 internal/marketplace 的镜像守门**都看不见它**。\n"+
			"  实测只有「/api/server/admin/* 且未经 AdminRoute 申报」这一种形态会被既有的 "+
			"TestAdminRouterNoFallOpen 顺带抓住（变异对照见 temp/round3-2026-09-23/fix-route-declaration-blindspot.md）；"+
			"员工面 /api/client/v2/*、非 admin 的 /api/server/*、经 AdminRoute 申报的直挂都是全绿盲区。\n"+
			"  允许的直挂只有 directRouteAllowList 里那两个非 /api 探针。",
			len(namespaceViolations), directRouteHint, joinDirectRouteCalls(namespaceViolations))
	}

	if len(offList) > 0 {
		t.Errorf("装配层直挂的路由不在直接挂载白名单里（%d 处）—— 直挂是例外，必须逐个申报：\n%s\n"+
			"  若确属正当直挂（不属于 /api、/v1 命名空间，且必须比 router.Register 更早/更直接地"+
			"挂上引擎），请登记进 directRouteAllowList 并写一句理由；否则 %s。",
			len(offList), joinDirectRouteCalls(offList), directRouteHint)
	}

	if len(unresolved) > 0 {
		t.Errorf("装配层有 %d 处路由注册的路径/路由组前缀无法静态判定：\n%s\n"+
			"  本判据只做常量折叠（字符串字面量 / 同包 const / `+` 拼接 / router.Namespace*）；"+
			"无法判定就不能证明它不在 /api 下，按 fail-loud 处理。\n"+
			"  处置：把路径改成字面量或同包 const（组前缀同理），或者 %s。",
			len(unresolved), joinDirectRouteCalls(unresolved), directRouteHint)
	}

	// 方向 2 的反面：白名单不得留死条目（判据空转 / 探针被悄悄搬走都靠这条现形）。
	for _, path := range sortedKeys(directRouteAllowList) {
		if !seen[path] {
			t.Errorf("directRouteAllowList 登记了 %s（%s），但扫描面里没有这个直挂 —— "+
				"探针被移走/改名了？请同步更新本用例（死条目会让这条判据空转）",
				path, directRouteAllowList[path])
		}
	}

	var inventory []string
	for _, c := range calls {
		state := strconv.Quote(c.path)
		if !c.resolved {
			state = "无法静态判定"
		}
		inventory = append(inventory, fmt.Sprintf("%s:%d %s → %s", c.file, c.line, c.fn, state))
	}
	t.Logf("装配层直挂清单（%d 条，全部经 directRouteAllowList 双向核对）：%s",
		len(inventory), strings.Join(inventory, "; "))
}

// TestDirectRouteMethodTableCoversGinRouterGroup：判据自己的"扫描面"不许静默漏扫。
//
// directRouteMethods / directRouteSpecialMethods 是**手写的**方法表；手写表的失效形态
// 就是漂移：gin 升级新增一个注册方法（或改名）时，判据会安静地少扫一类调用，而所有
// 用例照样绿 —— 这正是本仓反复踩过的"扫不到 ⇒ 宣称一致"。这里用反射拿 gin 的**真实
// 方法集**做双向核对：
//
//  1. gin 上任何"带非可变 string 形参"的 RouterGroup 方法，必须出现在
//     directRouteMethods（真注册）或 directRouteSpecialMethods（写明理由的例外）里；
//  2. 表里登记的每个方法必须真的存在于 gin（防改名/删方法后留死条目）；
//  3. 登记的路径下标必须与签名对得上（该位置确实是 string）—— 下标写错会让判据看错
//     实参（例如把 httpMethod 当路径），这条把它钉住。
func TestDirectRouteMethodTableCoversGinRouterGroup(t *testing.T) {
	typ := reflect.TypeOf(&gin.RouterGroup{})

	var missing []string
	for i := 0; i < typ.NumMethod(); i++ {
		m := typ.Method(i)
		if !takesStringParam(m.Type) {
			continue
		}
		if _, ok := directRouteMethods[m.Name]; ok {
			continue
		}
		if _, ok := directRouteSpecialMethods[m.Name]; ok {
			continue
		}
		missing = append(missing, m.Name)
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("gin 的 *gin.RouterGroup 上这些方法带路径实参，但本判据既不认识也不登记：%s\n"+
			"  漏登记的后果是**静默漏扫**（判据照样绿，直挂照样发生）：gin 升级新增注册方法时"+
			"必须把它加进 directRouteMethods（含路径实参下标），或加进 directRouteSpecialMethods "+
			"并说明为什么它不是路由注册", strings.Join(missing, ", "))
	}

	for _, name := range sortedIntKeys(directRouteMethods) {
		m, ok := typ.MethodByName(name)
		if !ok {
			t.Errorf("directRouteMethods 登记了 gin 上不存在的 *gin.RouterGroup 方法 %q（死条目）", name)
			continue
		}
		idx := directRouteMethods[name]
		if idx+1 >= m.Type.NumIn() {
			t.Errorf("directRouteMethods[%s]=%d 越界：该方法只有 %d 个形参（不含接收者）",
				name, idx, m.Type.NumIn()-1)
			continue
		}
		if m.Type.In(idx+1).Kind() != reflect.String {
			t.Errorf("directRouteMethods[%s]=%d 指到的形参不是 string（实为 %s）—— "+
				"判据会看错实参", name, idx, m.Type.In(idx+1))
		}
	}

	for _, name := range sortedKeys(directRouteSpecialMethods) {
		if _, ok := typ.MethodByName(name); !ok {
			t.Errorf("directRouteSpecialMethods 登记了 gin 上不存在的 *gin.RouterGroup 方法 %q（死条目）", name)
		}
	}

	t.Logf("gin *gin.RouterGroup 路由注册方法表已核对：%d 个注册方法 + %d 个写明理由的例外",
		len(directRouteMethods), len(directRouteSpecialMethods))
}

// takesStringParam 判定方法（不含接收者）是否有非可变长的 string 形参 —— 即它"带路径"。
func takesStringParam(mt reflect.Type) bool {
	for i := 1; i < mt.NumIn(); i++ {
		if mt.IsVariadic() && i == mt.NumIn()-1 {
			continue
		}
		if mt.In(i).Kind() == reflect.String {
			return true
		}
	}
	return false
}

func sortedIntKeys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// joinDirectRouteCalls 汇总多条违规（确定性顺序：调用点已按文件/行排序）。
func joinDirectRouteCalls(calls []directRouteCall) string {
	lines := make([]string, 0, len(calls))
	for _, c := range calls {
		lines = append(lines, c.describe())
	}
	return strings.Join(lines, "\n")
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// scanDirectRouteRegistrations 解析 cmd/server 包的全部非测试 .go 文件，收集所有 gin
// 路由注册调用（含路由组前缀的静态折叠）。
//
// 结构性失败（目录读不了 / 解析不了 / 找不到 registerProductionRoutes）一律 t.Fatal：
// 判据的前提坏了就不能给出"没问题"的结论。
func scanDirectRouteRegistrations(t *testing.T) []directRouteCall {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("列举 cmd/server 包目录: %v", err)
	}
	fset := token.NewFileSet()
	files := map[string]*ast.File{}
	sources := map[string][]byte{}
	var order []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("读 %s: %v", name, err)
		}
		f, err := parser.ParseFile(fset, name, src, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("解析 %s: %v", name, err)
		}
		files[name] = f
		sources[name] = src
		order = append(order, name)
	}
	if len(order) == 0 {
		t.Fatal("cmd/server 包里扫不到任何非测试 .go 文件 —— 扫描面为空，不得静默通过")
	}
	sort.Strings(order)
	if !packageDeclaresFunc(files, "registerProductionRoutes") {
		t.Fatalf("cmd/server 包（%s）里找不到 registerProductionRoutes 的函数体 —— "+
			"生产装配入口不见了，本判据的扫描面依赖它存在，不得静默通过",
			strings.Join(order, ", "))
	}

	res := directRouteResolver{consts: packageStringConstants(files)}
	var calls []directRouteCall
	for _, name := range order {
		for _, decl := range files[name].Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			groups := collectGroupPrefixes(fd, res)
			calls = append(calls, scanRouteCallsInFunc(name, sources[name], fd, groups, res, fset)...)
		}
	}
	sort.Slice(calls, func(i, j int) bool {
		if calls[i].file != calls[j].file {
			return calls[i].file < calls[j].file
		}
		return calls[i].line < calls[j].line
	})
	return calls
}

func packageDeclaresFunc(files map[string]*ast.File, name string) bool {
	for _, f := range files {
		for _, decl := range f.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if ok && fd.Recv == nil && fd.Name.Name == name {
				return true
			}
		}
	}
	return false
}

// scanRouteCallsInFunc 扫一个函数体内（含嵌套闭包）的路由注册调用。
//
// 两种形态：
//   - `X.GET("/p", …)`（含链式 `r.Group("/g").GET("/p", …)`）= 路由注册，路径 = 组前缀 + 实参；
//   - `X.Group("/g")` 本身不注册路由，但组前缀落在 /api 下时该组下所有路由都在 /api 里 ⇒ 同样红。
func scanRouteCallsInFunc(file string, src []byte, fd *ast.FuncDecl, groups map[string]string, res directRouteResolver, fset *token.FileSet) []directRouteCall {
	var out []directRouteCall
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		mk := func(group string, resolved bool, path, why string) directRouteCall {
			line := fset.Position(call.Pos()).Line
			return directRouteCall{
				file: file, line: line, fn: fd.Name.Name,
				src: sourceLineAt(src, line), group: group,
				path: path, resolved: resolved, why: why,
			}
		}
		if sel.Sel.Name == "Group" {
			if len(call.Args) == 0 {
				return true
			}
			prefix, ok2, _ := receiverGroupPrefix(sel.X, res, groups)
			if !ok2 {
				return true // 前缀不可判定：该组下的子路由各自会报"无法静态判定"
			}
			groupPath, ok3 := res.eval(call.Args[0])
			if !ok3 {
				return true // 同上
			}
			full := prefix + groupPath
			if inAPINamespace(full) {
				out = append(out, mk(prefix, true, full, ""))
			}
			return true
		}
		idx, isRoute := directRouteMethods[sel.Sel.Name]
		if !isRoute || len(call.Args) <= idx {
			return true
		}
		expr := call.Args[idx]
		prefix, ok2, why := receiverGroupPrefix(sel.X, res, groups)
		if !ok2 {
			out = append(out, mk("", false, "", why))
			return true
		}
		lit, ok3 := res.eval(expr)
		if !ok3 {
			out = append(out, mk(prefix, false, "", "路径实参不是可静态判定的字符串常量（表达式："+expressionText(expr)+"）"))
			return true
		}
		out = append(out, mk(prefix, true, prefix+lit, ""))
		return true
	})
	return out
}

// receiverGroupPrefix 折叠一次注册调用的**接收者**所属路由组前缀。
//
//   - `r`（engine）或任何无法识别的接收者 ⇒ 根前缀 ""；
//   - 链式 `X.Group(p)` ⇒ X 的前缀 + p；
//   - 同函数内 `g := X.Group(p)` 得到的变量 ⇒ 查 groups 表（前缀不可判定时记哨兵）。
//
// 无法判定时返回 ok=false 并给出 why —— 调用方按 fail-loud 处理（记"无法静态判定"）。
func receiverGroupPrefix(recv ast.Expr, res directRouteResolver, groups map[string]string) (string, bool, string) {
	switch e := recv.(type) {
	case *ast.CallExpr:
		if sel, ok := e.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Group" {
			if len(e.Args) == 0 {
				return "", false, "路由组 Group(...) 没有路径实参"
			}
			outer, ok1, why1 := receiverGroupPrefix(sel.X, res, groups)
			if !ok1 {
				return "", false, why1
			}
			lit, ok2 := res.eval(e.Args[0])
			if !ok2 {
				return "", false, "路由组前缀不是可静态判定的字符串常量（表达式：" + expressionText(e.Args[0]) + "）"
			}
			return outer + lit, true, ""
		}
	case *ast.Ident:
		if v, ok := groups[e.Name]; ok {
			if v == unresolvedGroupPrefix {
				return "", false, "路由组变量 " + e.Name + " 的前缀不是可静态判定的字符串常量"
			}
			return v, true, ""
		}
		return "", true, "" // 引擎（r）或其它非组接收者
	case *ast.ParenExpr:
		return receiverGroupPrefix(e.X, res, groups)
	}
	return "", true, ""
}

// collectGroupPrefixes 折叠一个函数内 `x := X.Group(prefix)` 形成的组前缀表。
//
// 多轮迭代以支持 `g2 := g.Group(sub)` 这类链（每轮都从头扫，收敛即停）。前缀算不出来
// 的记 unresolvedGroupPrefix 哨兵，让用到它的注册调用以"无法静态判定"红掉。
func collectGroupPrefixes(fd *ast.FuncDecl, res directRouteResolver) map[string]string {
	type assignment struct {
		name string
		expr ast.Expr
	}
	var assigns []assignment
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok || len(as.Lhs) != len(as.Rhs) {
			return true
		}
		for i := range as.Lhs {
			id, ok := as.Lhs[i].(*ast.Ident)
			if !ok || id.Name == "_" {
				continue
			}
			assigns = append(assigns, assignment{name: id.Name, expr: as.Rhs[i]})
		}
		return true
	})
	groups := map[string]string{}
	for round := 0; round < 4; round++ {
		changed := false
		for _, a := range assigns {
			if _, done := groups[a.name]; done {
				continue
			}
			call, ok := a.expr.(*ast.CallExpr)
			if !ok {
				continue
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Group" || len(call.Args) == 0 {
				continue
			}
			prefix, ok2, _ := receiverGroupPrefix(sel.X, res, groups)
			if !ok2 {
				groups[a.name] = unresolvedGroupPrefix
				changed = true
				continue
			}
			lit, ok3 := res.eval(call.Args[0])
			if !ok3 {
				groups[a.name] = unresolvedGroupPrefix
				changed = true
				continue
			}
			groups[a.name] = prefix + lit
			changed = true
		}
		if !changed {
			break
		}
	}
	return groups
}

// directRouteResolver 做字符串常量折叠。
type directRouteResolver struct{ consts map[string]string }

// eval 折叠出表达式的字符串值；无法静态判定时返回 ok=false。
func (r directRouteResolver) eval(expr ast.Expr) (string, bool) {
	switch e := expr.(type) {
	case *ast.BasicLit:
		if e.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(e.Value)
		if err != nil {
			return "", false
		}
		return s, true
	case *ast.ParenExpr:
		return r.eval(e.X)
	case *ast.Ident:
		if v, ok := r.consts[e.Name]; ok {
			return v, true
		}
		if v, ok := directRouteNamespaceConstants[e.Name]; ok { // dot-import 形态
			return v, true
		}
	case *ast.SelectorExpr:
		if v, ok := directRouteNamespaceConstants[e.Sel.Name]; ok {
			return v, true
		}
	case *ast.BinaryExpr:
		if e.Op == token.ADD {
			left, ok1 := r.eval(e.X)
			right, ok2 := r.eval(e.Y)
			if ok1 && ok2 {
				return left + right, true
			}
		}
	}
	return "", false
}

// packageStringConstants 折叠包级 const 字符串（含 `const a = b + "/x"` 这类链）。
func packageStringConstants(files map[string]*ast.File) map[string]string {
	type pendingConst struct {
		name string
		expr ast.Expr
	}
	var pending []pendingConst
	for _, f := range files {
		for _, decl := range f.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, spec := range gd.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, name := range vs.Names {
					if i >= len(vs.Values) {
						break
					}
					pending = append(pending, pendingConst{name: name.Name, expr: vs.Values[i]})
				}
			}
		}
	}
	out := map[string]string{}
	for round := 0; round < 4; round++ {
		changed := false
		res := directRouteResolver{consts: out}
		for _, c := range pending {
			if _, done := out[c.name]; done {
				continue
			}
			if v, ok := res.eval(c.expr); ok {
				out[c.name] = v
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	return out
}

// sourceLineAt 取第 line 行（1 起）并裁剪首尾空白与行尾注释之外的多余空格；越界返回 ""。
func sourceLineAt(src []byte, line int) string {
	lines := strings.Split(string(src), "\n")
	if line < 1 || line > len(lines) {
		return ""
	}
	out := strings.TrimSpace(lines[line-1])
	const maxLen = 200
	if len(out) > maxLen {
		out = out[:maxLen] + " …"
	}
	return out
}

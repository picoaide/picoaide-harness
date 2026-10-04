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
// ⚠️ "整个包"必须**真的**是整个包（S3-01，审计 2026-10-04，P2）：修前这里只遍历
// `*ast.FuncDecl`，于是**包级变量初始化器里的函数字面量**完全在扫描面外：
//
//	var mountExtra = func(r *gin.Engine) { r.GET("/api/client/v2/…", h) }
//
// 不需要任何函数调用它就能挂路由（`registerProductionRoutes` 里一行 `mountExtra(r)`
// 即可），而四条方向（白名单双向、命名空间、扫描面为空）全部保持绿 —— 这正是本用例
// 自己声称要关掉的那类盲区，只是换了个语法形态（`init()` 与包内方法本来就是
// `*ast.FuncDecl`，修前已在面内；**包级函数值不在**）。现在扫描目标是
// collectRouteScanTargets 收集的两类代码段：全部 `*ast.FuncDecl` 函数体 + 全部包级
// `var`/`const` 初始化器里的函数字面量。负例（自校准）见
// TestRouteDeclarationGuardCatchesPackageLevelFunctionValues —— 它用**同一份**扫描与
// 判定实现喂一段合成了该形态的源码，断言判据真的报红。
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
//   - 别的包（internal/**）里的直挂不在扫描面内。**理由不是"它们够不到引擎实例"**
//     （修前这里就是这么写的，与事实相反：internal/** 里的镜像装配函数正是把
//     `*gin.Engine` 当形参收进去的，例如 `RegisterRoutes(r *gin.Engine)`，而
//     `route_mirror_registry_test.go` 也只认那两个字面方法名）。真实边界是**本用例
//     只解析 cmd/server 这一个包**；跨包装配当前由 route_mirror_registry_test.go 盯着
//     （判据面 = 名字恰为 RegisterRoutes / RegisterAdminRoutes 的调用），换名
//     （`MountAPIRoutes(r *gin.Engine)`）即同时躲开两条 —— 这是**已登记的残差**，
//     不在本用例的判据面内（登记见 temp/audit-v282/fixes/S3-P2-batch.md）。
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
	col      int    // 1 起（仅用于去重：同一段代码可能被两个扫描目标覆盖）
	fn       string // 所在函数 / 包级初始化器（便于人读"这是哪段装配代码"）
	src      string // 该行原文（红信息里可直接照抄）
	group    string // 路由组前缀（"" = 直接挂在 engine 上）
	path     string // 静态解析出的完整路径（仅 resolved 时有效）
	resolved bool
	why      string // 无法静态判定时的原因
}

// dedupeKey 是"同一次注册调用"的身份：扫描面从"每个函数体"扩到"包级函数字面量"之后，
// 嵌套的函数字面量会被外层目标与自身目标各扫一遍 —— 它们是**同一次**调用，红信息里
// 不能出现两遍（否则"扫到几次"会随写法漂移）。
func (c directRouteCall) dedupeKey() string {
	return fmt.Sprintf("%s:%d:%d", c.file, c.line, c.col)
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

// routeDeclarationReport 是一次扫描的**判定结果**。
//
// 判定（而不是扫描）是判据的判别力所在，所以它必须能被自校准用例用**合成源码**喂进去
// 实跑 —— TestRouteDeclarationGuardCatchesPackageLevelFunctionValues 用的就是这一份
// judgeDirectRouteCalls，与生产扫描逐字同源。只让"生产扫描"跑一遍真实包、再断言
// "没报错"，证明不了判据咬得住任何一种违规形态（包恰好干净时它永远是绿的）。
type routeDeclarationReport struct {
	calls               []directRouteCall
	namespaceViolations []directRouteCall
	offList             []directRouteCall
	unresolved          []directRouteCall
	deadAllowList       []string
	seen                map[string]bool // 扫描面里出现过的路径（白名单死条目的反面）
}

// judgeDirectRouteCalls 对一次扫描结果做四个方向的判定（方向定义见文件头）。
func judgeDirectRouteCalls(calls []directRouteCall) routeDeclarationReport {
	rep := routeDeclarationReport{calls: calls, seen: map[string]bool{}}
	for _, c := range calls {
		if !c.resolved {
			rep.unresolved = append(rep.unresolved, c)
			continue
		}
		rep.seen[c.path] = true
		if inAPINamespace(c.path) {
			rep.namespaceViolations = append(rep.namespaceViolations, c)
			continue
		}
		if _, ok := directRouteAllowList[c.path]; !ok {
			rep.offList = append(rep.offList, c)
		}
	}
	// 方向 2 的反面：白名单不得留死条目（判据空转 / 探针被悄悄搬走都靠这条现形）。
	for _, path := range sortedKeys(directRouteAllowList) {
		if !rep.seen[path] {
			rep.deadAllowList = append(rep.deadAllowList, path)
		}
	}
	return rep
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

	rep := judgeDirectRouteCalls(calls)

	if len(rep.namespaceViolations) > 0 {
		t.Errorf("装配层直挂了 /api 命名空间的路由（%d 处）—— %s：\n%s\n"+
			"  为什么必须红：直挂绕过了 internal/router 的集中声明；带鉴权时未认证仍回 401、与其它 API "+
			"逐字同形，于是 TestAPISweepAllRoutesContract（只看未认证状态码）、TestRouteAssembly*"+
			"（比较两棵同源树）、internal/router 的生产判据与 internal/marketplace 的镜像守门**都看不见它**。\n"+
			"  实测只有「/api/server/admin/* 且未经 AdminRoute 申报」这一种形态会被既有的 "+
			"TestAdminRouterNoFallOpen 顺带抓住（变异对照见 temp/round3-2026-09-23/fix-route-declaration-blindspot.md）；"+
			"员工面 /api/client/v2/*、非 admin 的 /api/server/*、经 AdminRoute 申报的直挂都是全绿盲区。\n"+
			"  允许的直挂只有 directRouteAllowList 里那两个非 /api 探针。",
			len(rep.namespaceViolations), directRouteHint, joinDirectRouteCalls(rep.namespaceViolations))
	}

	if len(rep.offList) > 0 {
		t.Errorf("装配层直挂的路由不在直接挂载白名单里（%d 处）—— 直挂是例外，必须逐个申报：\n%s\n"+
			"  若确属正当直挂（不属于 /api、/v1 命名空间，且必须比 router.Register 更早/更直接地"+
			"挂上引擎），请登记进 directRouteAllowList 并写一句理由；否则 %s。",
			len(rep.offList), joinDirectRouteCalls(rep.offList), directRouteHint)
	}

	if len(rep.unresolved) > 0 {
		t.Errorf("装配层有 %d 处路由注册的路径/路由组前缀无法静态判定：\n%s\n"+
			"  本判据只做常量折叠（字符串字面量 / 同包 const / `+` 拼接 / router.Namespace*）；"+
			"无法判定就不能证明它不在 /api 下，按 fail-loud 处理。\n"+
			"  处置：把路径改成字面量或同包 const（组前缀同理），或者 %s。",
			len(rep.unresolved), joinDirectRouteCalls(rep.unresolved), directRouteHint)
	}

	for _, path := range rep.deadAllowList {
		t.Errorf("directRouteAllowList 登记了 %s（%s），但扫描面里没有这个直挂 —— "+
			"探针被移走/改名了？请同步更新本用例（死条目会让这条判据空转）",
			path, directRouteAllowList[path])
	}

	var inventory []string
	for _, c := range rep.calls {
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

// routeScanTarget 是判据的一个扫描目标：一段**可能挂着路由**的代码。
type routeScanTarget struct {
	file string // 包内文件名
	fn   string // 人读定位名：函数名 / `var <名字>` / 包级初始化器
	body ast.Node
}

// collectRouteScanTargets 收集 cmd/server 包里**全部**可能挂路由的代码段。
//
// 两类，缺一不可（修前只有第 1 类，于是包级函数值整类落在面外 —— 审计 S3-01）：
//
//  1. 每个 `*ast.FuncDecl` 的函数体：覆盖 registerProductionRoutes 本身、同包 helper、
//     `init()`（它本来就是一个 FuncDecl，修前已在面内）、包内方法（方法值/方法表达式
//     最终都落到这些函数体上）；
//  2. 每个包级 `var` / `const` 初始化器里的**函数字面量**：
//     `var mountExtra = func(r *gin.Engine) { r.GET("/api/client/v2/…", h) }`。
//     它不需要被任何函数定义调用就能挂路由（`registerProductionRoutes` 里一行
//     `mountExtra(r)` 即可），所以"函数体遍历"给不出任何保护 —— 负例见
//     TestRouteDeclarationGuardCatchesPackageLevelFunctionValues。
//
// 只扫这两类而不是"文件里所有 FuncLit"：函数体内的嵌套字面量已经由第 1 类覆盖，
// 重复扫会让同一次调用在报告里出现两遍；扫描实现仍按 dedupeKey 去重兜底。
func collectRouteScanTargets(files map[string]*ast.File, order []string) []routeScanTarget {
	var out []routeScanTarget
	for _, name := range order {
		for _, decl := range files[name].Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if d.Body == nil {
					continue // 无函数体（外部实现），没有可扫的代码
				}
				out = append(out, routeScanTarget{file: name, fn: d.Name.Name, body: d.Body})
			case *ast.GenDecl:
				if d.Tok != token.VAR && d.Tok != token.CONST {
					continue
				}
				for _, spec := range d.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, val := range vs.Values {
						label := "包级初始化器"
						if i < len(vs.Names) && vs.Names[i].Name != "_" {
							label = "var " + vs.Names[i].Name
						}
						ast.Inspect(val, func(n ast.Node) bool {
							lit, ok := n.(*ast.FuncLit)
							if !ok {
								return true
							}
							out = append(out, routeScanTarget{file: name, fn: label, body: lit.Body})
							return false // 嵌套字面量已由外层目标的遍历覆盖（去重再兜一层）
						})
					}
				}
			}
		}
	}
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
	sort.Strings(order)
	return scanRouteRegistrationsInPackage(t, files, sources, order, fset)
}

// scanRouteRegistrationsInPackage 是判据的**唯一扫描实现**：给定一组已解析的包文件，
// 收集全部路由注册调用。生产扫描（scanDirectRouteRegistrations）与自校准用例
// （TestRouteDeclarationGuardCatchesPackageLevelFunctionValues）共用它 —— 否则负例
// 验的是"另一份实现"，证明不了生产判据咬得住。
func scanRouteRegistrationsInPackage(
	t *testing.T,
	files map[string]*ast.File,
	sources map[string][]byte,
	order []string,
	fset *token.FileSet,
) []directRouteCall {
	t.Helper()
	if len(order) == 0 {
		t.Fatal("cmd/server 包里扫不到任何非测试 .go 文件 —— 扫描面为空，不得静默通过")
	}
	if !packageDeclaresFunc(files, "registerProductionRoutes") {
		t.Fatalf("cmd/server 包（%s）里找不到 registerProductionRoutes 的函数体 —— "+
			"生产装配入口不见了，本判据的扫描面依赖它存在，不得静默通过",
			strings.Join(order, ", "))
	}

	res := directRouteResolver{consts: packageStringConstants(files)}
	var calls []directRouteCall
	seen := map[string]bool{}
	for _, target := range collectRouteScanTargets(files, order) {
		groups := collectGroupPrefixes(target.body, res)
		for _, c := range scanRouteCallsInTarget(target.file, sources[target.file], target.fn, target.body, groups, res, fset) {
			if key := c.dedupeKey(); seen[key] {
				continue
			} else {
				seen[key] = true
			}
			calls = append(calls, c)
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

// scanRouteCallsInTarget 扫一段代码（函数体或包级函数字面量的体，含嵌套闭包）里的
// 路由注册调用。
//
// 两种形态：
//   - `X.GET("/p", …)`（含链式 `r.Group("/g").GET("/p", …)`）= 路由注册，路径 = 组前缀 + 实参；
//   - `X.Group("/g")` 本身不注册路由，但组前缀落在 /api 下时该组下所有路由都在 /api 里 ⇒ 同样红。
func scanRouteCallsInTarget(file string, src []byte, fn string, body ast.Node, groups map[string]string, res directRouteResolver, fset *token.FileSet) []directRouteCall {
	var out []directRouteCall
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		mk := func(group string, resolved bool, path, why string) directRouteCall {
			pos := fset.Position(call.Pos())
			return directRouteCall{
				file: file, line: pos.Line, col: pos.Column, fn: fn,
				src: sourceLineAt(src, pos.Line), group: group,
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

// collectGroupPrefixes 折叠一段代码内 `x := X.Group(prefix)` 形成的组前缀表。
//
// 多轮迭代以支持 `g2 := g.Group(sub)` 这类链（每轮都从头扫，收敛即停）。前缀算不出来
// 的记 unresolvedGroupPrefix 哨兵，让用到它的注册调用以"无法静态判定"红掉。
func collectGroupPrefixes(body ast.Node, res directRouteResolver) map[string]string {
	type assignment struct {
		name string
		expr ast.Expr
	}
	var assigns []assignment
	ast.Inspect(body, func(n ast.Node) bool {
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

// ---------------------------------------------------------------------------
// 自校准：判据真的咬得住"包级函数值"这个形态吗（S3-01，审计 2026-10-04，P2）
// ---------------------------------------------------------------------------

// routeGuardFixture 把一组**合成源码**交给**生产扫描实现**跑一遍并判定。
//
// 为什么必须复用生产实现（scanRouteRegistrationsInPackage + judgeDirectRouteCalls）：
// 负例若自己写一套"我认识的坏形态"匹配，证明的只是负例自己；这里跑的是与真实包
// 逐字同源的扫描 + 判定，所以"负例变红"直接等价于"生产判据咬得住这个形态"。
func routeGuardFixture(t *testing.T, files map[string]string) routeDeclarationReport {
	t.Helper()
	fset := token.NewFileSet()
	parsed := map[string]*ast.File{}
	sources := map[string][]byte{}
	var order []string
	for name, src := range files {
		f, err := parser.ParseFile(fset, name, []byte(src), parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("解析合成源码 %s: %v", name, err)
		}
		parsed[name] = f
		sources[name] = []byte(src)
		order = append(order, name)
	}
	sort.Strings(order)
	return judgeDirectRouteCalls(scanRouteRegistrationsInPackage(t, parsed, sources, order, fset))
}

// routeGuardFixtureShape 是合成包的公共骨架：只留两个探针（与生产一致）。
//
// 三个变体共用它，所以它们的差异**只有**路由注册那一段 —— 负例红、正例绿都只能归因
// 到那一段，而不是夹具的整体形状。
const routeGuardFixtureShape = `package main

const clientNamespace = "/api/client/v2"

type engine struct{}

func (e *engine) GET(path string, handler func()) {}
func (e *engine) POST(path string, handler func()) {}
func (e *engine) Group(prefix string) *engine     { return e }

func probe() {}

func registerProductionRoutes(r *engine) {
	r.GET("/healthz", probe)
	r.GET("/readyz", probe)
%s}

%s`

// TestRouteDeclarationGuardCatchesPackageLevelFunctionValues 是判据的自校准用例：
// 用合成源码实跑生产扫描 + 生产判定，逐形态断言"该红的红、该绿的绿"。
//
// 背景（审计 S3-01）：修前扫描面只遍历 `*ast.FuncDecl`，下面第 ②③ 两种形态**完全不
// 在面内** —— 一条已认证的员工面生产路由可以落进生产树而四条方向全部保持绿。
// 本用例的判别力是双向的：
//
//	正向（必须红）：包级 `var` 里的函数字面量注册 /api 路由（②）、
//	                结构体字段里的函数字面量注册 /api 路由（③）；
//	反向（必须绿）：同一夹具只留 /healthz + /readyz 时零违规（④）——
//	                否则"永远报红"的判据也能通过正向断言（假绿的另一面）。
func TestRouteDeclarationGuardCatchesPackageLevelFunctionValues(t *testing.T) {
	// ① 阳性对照：夹具本身必须被扫到（两个探针），否则后面的"红/绿"都没有意义
	// （扫描面为空时任何形态都是绿的）。
	clean := routeGuardFixture(t, map[string]string{
		"route_assembly.go": fmt.Sprintf(routeGuardFixtureShape, "", ""),
	})
	if len(clean.calls) != 2 {
		t.Fatalf("夹具扫描面 = %d 条调用，want 2（/healthz + /readyz）—— 夹具或扫描实现漂移，"+
			"后面所有正向断言都会退化成恒真：%v", len(clean.calls), clean.calls)
	}
	if len(clean.namespaceViolations)+len(clean.offList)+len(clean.unresolved)+len(clean.deadAllowList) != 0 {
		t.Fatalf("干净夹具被判违规（判据在夹具上恒红，正向断言就没有判别力了）：namespace=%v offList=%v unresolved=%v dead=%v",
			clean.namespaceViolations, clean.offList, clean.unresolved, clean.deadAllowList)
	}

	// ② 缺陷形态本体：**包级函数值**注册一条已认证员工面生产路由，并由
	// registerProductionRoutes 调用它（审计给出的正是这个可达形态）。
	packageLevelValue := routeGuardFixture(t, map[string]string{
		"route_assembly.go": fmt.Sprintf(routeGuardFixtureShape,
			"\tmountExtraRoutes(r)\n",
			"var mountExtraRoutes = func(r *engine) {\n\tr.GET(clientNamespace+\"/evil-package-level-func-value\", probe)\n}\n"),
	})
	if len(packageLevelValue.namespaceViolations) != 1 {
		t.Fatalf("包级函数值注册的 /api 路由没有被判违规（namespaceViolations=%d）—— "+
			"扫描面漏掉了包级变量初始化器里的函数字面量（S3-01 的原缺陷形态）：%v",
			len(packageLevelValue.namespaceViolations), packageLevelValue.calls)
	}
	if got := packageLevelValue.namespaceViolations[0].fn; got != "var mountExtraRoutes" {
		t.Errorf("违规归因到 %q，want %q —— 定位信息要能指回那个包级变量", got, "var mountExtraRoutes")
	}
	if got := packageLevelValue.namespaceViolations[0].path; got != "/api/client/v2/evil-package-level-func-value" {
		t.Errorf("违规路径 = %q，want 拼接折叠后的完整路径（同包 const + `+` 必须照样折叠）",
			got)
	}

	// ③ 同族写法：函数字面量挂在**结构体字段**里（包级复合字面量），同样是
	// "初始化器里的函数值"，必须一并被咬住。
	structField := routeGuardFixture(t, map[string]string{
		"route_assembly.go": fmt.Sprintf(routeGuardFixtureShape,
			"\textraRoutes.mount(r)\n",
			"var extraRoutes = struct{ mount func(*engine) }{\n\tmount: func(r *engine) { r.POST(\"/api/server/evil-struct-field\", probe) },\n}\n"),
	})
	if len(structField.namespaceViolations) != 1 {
		t.Fatalf("结构体字段里的函数字面量注册的 /api 路由没有被判违规（namespaceViolations=%d）：%v",
			len(structField.namespaceViolations), structField.calls)
	}

	// ④ 反方向的判别力：非 /api 但**未登记**的直挂必须落进 offList（否则"只判命名空间"
	// 会让白名单双向核对退化成单向）。
	offList := routeGuardFixture(t, map[string]string{
		"route_assembly.go": fmt.Sprintf(routeGuardFixtureShape,
			"\textraRoutes.mount(r)\n",
			"var extraRoutes = struct{ mount func(*engine) }{\n\tmount: func(r *engine) { r.GET(\"/metrics\", probe) },\n}\n"),
	})
	if len(offList.offList) != 1 || len(offList.namespaceViolations) != 0 {
		t.Fatalf("未登记的直挂 /metrics 没有被判 offList（offList=%d namespace=%d）：%v",
			len(offList.offList), len(offList.namespaceViolations), offList.calls)
	}
}

package serverauth

// S3-06 的判据（审计 2026-10-04，P2）：包级单例的**复位口径只允许一份实现**，
// 而且那份实现必须罩住本包全部的包级限流单例。
//
// 缺陷现场：`token_quota.go`（**生产文件**）里有一个 `resetTokenIssueQuotaForTest`，
// 注释自称"由本包的测试入口调用"，而全仓**零调用点** —— 真正生效的复位是
// `resetSharedLimitersForTest`（ratelimit_isolation_test.go）里按 `*loginLimiter`
// 列表统一清空（签发配额桶就在那份列表里）。同一逻辑两份实现，且其中一份是
// "生产代码里的死测试钩子"：将来该单例新增状态（如按用户分桶）时，维护者不知道
// 该改哪一份。处置：删掉生产文件里的那份，复位回到唯一实现。
//
// 本文件钉住两件事（这正是那套纪律的两半）：
//
//	1. **生产文件里不得再有 `…ForTest` 钩子**（测试接缝属于 `_test.go`）；
//	2. **统一复位入口必须罩住每一个包级限流单例**：本包非测试源码里每个
//	   `func shared*() *loginLimiter` 访问器都必须在 resetSharedLimitersForTest 的
//	   函数体里被调用，且都在本文件的登记表（resetRegisteredLimiters）里 ——
//	   新增单例不登记 / 不接入统一入口即红（"有能力没接线"是本仓登记的独立缺陷类）。

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// sharedLimiterAccessorRe 匹配"包级限流单例访问器"的名字形状。
var sharedLimiterAccessorRe = regexp.MustCompile(`^shared[A-Za-z0-9]*$`)

// packageSourceFuncs 解析本包**非测试** .go 文件里的全部顶层函数，返回
// "函数名 → 返回类型源码（去掉空白）"。结构性失败一律 fatal（判据前提坏了不得静默通过）。
func packageSourceFuncs(t *testing.T) (map[string]string, map[string]*ast.FuncDecl) {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("列举 serverauth 包目录: %v", err)
	}
	fset := token.NewFileSet()
	rets := map[string]string{}
	decls := map[string]*ast.FuncDecl{}
	files := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		files++
		f, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("解析 %s: %v", name, err)
		}
		for _, d := range f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Recv != nil || fd.Type.Results == nil || len(fd.Type.Results.List) == 0 {
				continue
			}
			rets[fd.Name.Name] = strings.Join(strings.Fields(exprString(fd.Type.Results.List[0].Type)), "")
			decls[fd.Name.Name] = fd
		}
	}
	if files == 0 {
		t.Fatal("serverauth 包目录里扫不到任何非测试 .go 文件 —— 扫描面为空，不得静默通过")
	}
	return rets, decls
}

func exprString(e ast.Expr) string {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.StarExpr:
		return "*" + exprString(v.X)
	case *ast.SelectorExpr:
		return exprString(v.X) + "." + v.Sel.Name
	default:
		return "?"
	}
}

// resetRegisteredLimiters 是本包**全部**包级限流单例的登记表（访问器 → 该单例是什么）。
//
// 与 resetSharedLimitersForTest 的复位列表是**两处**独立表述，正是要它们互相咬：
// 新增单例只改一处（要么只加访问器、要么只加复位）都会让本文件的用例红。
var resetRegisteredLimiters = map[string]string{
	"sharedLoginLimiter":           "账号维度失败预算桶（ip|username / u:username）",
	"sharedLoginIPLimiter":         "登录/回调 IP 维度失败预算桶（客户端面与管理面共用）",
	"sharedTokenIssueQuotaLimiter": "员工自助签发令牌配额桶（按 user_id，R15C-R-01 ③）",
}

// TestNoTestResetHooksInProductionSources：生产文件里不得出现 `…ForTest` 测试钩子。
//
// 为什么这是一条判据而不是风格洁癖：修前的死代码正是这个形状 —— 生产文件里的
// `resetTokenIssueQuotaForTest` 与 `_test.go` 里的真复位**两份实现**，且前者零调用点。
// 测试接缝放生产文件里 = 它要么是死的（无人调用，本仓已踩），要么是第二份真源。
func TestNoTestResetHooksInProductionSources(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var offenders []string
	scanned := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		scanned++
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("读 %s: %v", name, err)
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, name, src, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("解析 %s: %v", name, err)
		}
		for _, d := range f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Recv != nil {
				continue
			}
			if strings.HasSuffix(fd.Name.Name, "ForTest") {
				offenders = append(offenders, name+":"+fd.Name.Name)
			}
		}
	}
	if scanned == 0 {
		t.Fatal("扫不到任何非测试 .go 文件 —— 扫描面为空，不得静默通过")
	}
	sort.Strings(offenders)
	if len(offenders) > 0 {
		t.Fatalf("生产源码里仍有测试钩子（%d 处）：%s\n"+
			"  测试接缝属于 _test.go；生产文件里的 *ForTest 要么是死代码，要么是第二份复位实现"+
			"（S3-06 的缺陷形态）。把复位统一到 resetSharedLimitersForTest 一处。",
			len(offenders), strings.Join(offenders, ", "))
	}
}

// TestUnifiedResetCoversEverySharedLimiterSingleton：统一复位入口必须罩住每一个
// 包级限流单例，且每个单例都在本文件登记（双向）。
func TestUnifiedResetCoversEverySharedLimiterSingleton(t *testing.T) {
	rets, _ := packageSourceFuncs(t)

	// 扫描面：本包非测试源码里所有"返回 *loginLimiter 的 shared* 访问器"。
	found := map[string]bool{}
	for name, ret := range rets {
		if ret == "*loginLimiter" && sharedLimiterAccessorRe.MatchString(name) {
			found[name] = true
		}
	}
	if len(found) == 0 {
		t.Fatal("扫不到任何包级限流单例访问器 —— 扫描面为空（判据或命名惯例漂移），不得静默通过")
	}

	// 方向 1：扫到的访问器都必须登记（防"新增单例忘了接入统一复位"）。
	var unregistered []string
	for name := range found {
		if _, ok := resetRegisteredLimiters[name]; !ok {
			unregistered = append(unregistered, name)
		}
	}
	sort.Strings(unregistered)
	if len(unregistered) > 0 {
		t.Fatalf("这些包级限流单例没有登记：%s\n"+
			"  新增『包级单例 + 进程级累积状态』必须挂进 resetSharedLimitersForTest 并在"+
			"本文件的 resetRegisteredLimiters 登记（否则跨用例累积会让判据假红）。", strings.Join(unregistered, ", "))
	}
	// 方向 2：登记表里不许有死条目（访问器改名/删除后留下的陈旧登记）。
	var stale []string
	for name := range resetRegisteredLimiters {
		if !found[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Fatalf("登记表里的单例访问器已不存在（死条目）：%s", strings.Join(stale, ", "))
	}

	// 方向 3：统一复位入口的函数体里必须**调用**每一个访问器。
	src, err := os.ReadFile("ratelimit_isolation_test.go")
	if err != nil {
		t.Fatalf("读 ratelimit_isolation_test.go: %v", err)
	}
	body := string(src)
	for _, name := range sortedLimiterNames(resetRegisteredLimiters) {
		if !strings.Contains(body, name+"()") {
			t.Fatalf("resetSharedLimitersForTest 没有覆盖 %s（%s）—— 该单例的跨用例累积"+
				"会污染判据（把 %s 加进统一复位入口）", name, resetRegisteredLimiters[name], name)
		}
	}

	// 方向 4（行为级）：播种 → 统一复位 → 必须全部清空。
	for _, name := range sortedLimiterNames(resetRegisteredLimiters) {
		limiterForResetTest(t, name).record("s3-06-reset-probe")
	}
	for _, name := range sortedLimiterNames(resetRegisteredLimiters) {
		l := limiterForResetTest(t, name)
		if got := bucketLen(l, "s3-06-reset-probe"); got != 1 {
			t.Fatalf("%s 的播种没有生效（bucket=%d, want 1）—— 方向 4 的判据前提坏了", name, got)
		}
	}
	resetSharedLimitersForTest()
	for _, name := range sortedLimiterNames(resetRegisteredLimiters) {
		if got := bucketLen(limiterForResetTest(t, name), "s3-06-reset-probe"); got != 0 {
			t.Fatalf("%s 没有被 resetSharedLimitersForTest 清空（残留 %d 条）—— 统一复位入口"+
				"没有覆盖它（跨用例污染会产出假红/假绿）", name, got)
		}
	}
	// 同一入口也必须清掉 S3-05 引入的进程级计数（同为"包级单例 + 累积状态"）。
	oidcFlowCapacityRejections.Store(3)
	resetSharedLimitersForTest()
	if got := OIDCFlowCapacityRejections(); got != 0 {
		t.Fatalf("resetSharedLimitersForTest 没有清 OIDC 容量拒绝计数（残留 %d）—— 新增包级"+
			"累积状态必须一并挂进统一复位入口", got)
	}
}

// sortedLimiterNames 按名字排序登记表的键（确定性输出）。
func sortedLimiterNames(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// limiterForResetTest 按登记名取单例实例（显式 switch：Go 没有按名调用函数，
// 而登记表由上面的双向核对保证与扫描面一致）。
func limiterForResetTest(t *testing.T, name string) *loginLimiter {
	t.Helper()
	switch name {
	case "sharedLoginLimiter":
		return sharedLoginLimiter()
	case "sharedLoginIPLimiter":
		return sharedLoginIPLimiter()
	case "sharedTokenIssueQuotaLimiter":
		return sharedTokenIssueQuotaLimiter()
	}
	t.Fatalf("登记表里的 %s 没有对应的取用实现（判据自己漂移了）", name)
	return nil
}

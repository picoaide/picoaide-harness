package serverstore

// 第二十二轮复审 V2-B6（P3）的判据：把「**写入口必须过名字面闸门**」变成可执行判据。
//
// ## 缺陷形态（判据要杀的东西）
//
// 名字面判据此前钉的是 `skillmanifest.IsAppID` 的**调用点**
// （`skillmanifest/app_id_reserved_device_name_test.go` 的 `appIDCallSites` 表），
// 而不是真正的 DB 写入口 —— `serverstore.UpsertApp`（`apps.go:126` ⇒ `upsertApp` 的
// `INSERT INTO apps … ON CONFLICT (kind, app_id)`）。复审的变异 m9（在既有
// `createAgentAdmin` 里**新增**一次 `UpsertApp(AppID:"con")`）虽然被杀，但红点是
// 管理员智能体**列表断言**的副作用（多了一行 `con`），名字面判据**全绿** ——
// 也就是说"新写入口必须过闸门"这件事当时没有任何判据在守。
//
// ## 判据（三条，缺一条就能被绕过）
//
//	① **写入口调用点穷举**：全 server 生产源码里 `UpsertApp` /
//	   `UpsertAppAndCreateReleaseOn` / `upsertApp` 的调用点，按
//	   「文件 | 所在函数 | **调用次数**」必须**恰好等于**登记表 ——
//	   在一个已有函数里再加一次调用（m9 的形态）也会被计数咬住；
//	② **闸门声明可验证**：声明 `IsAppID` 的点，其所在函数必须在写入调用**之前**
//	   真的调用 `IsAppID`；声明"只改既有行"的点，必须在写入之前先取既有行
//	   （`marketAgentApp`）。表里的每一行都要在源码里成立，不是注释里的声明；
//	③ **负控**：登记表必须覆盖发布内核（`appstore.Publish`）与管理端登记
//	   （`createAgentAdmin`）两条关键写路径 —— 否则把表退化成一堆种子函数也能绿。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-15/REPORT.md）
//
//   - 在 `createAgentAdmin` 里新增一次 `UpsertApp(AppID:"con")`（m9 本体）⇒ ① 红；
//   - 摘掉 `createAgentAdmin` 的 `IsAppID` 闸门 ⇒ ② 红；
//   - 删掉登记表里任意一行 ⇒ ①（"在却没登记"）红；
//   - 把 `updateAgentAdmin` 的"先取既有行"改成直接写 ⇒ ② 红。

import (
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

// appWriteEntries 是写入口名（三选一即命中）：两个导出入口 + 包内共享执行器。
var appWriteEntries = []string{"UpsertApp", "UpsertAppAndCreateReleaseOn", "upsertApp"}

// 闸门种类。
const (
	gateIsAppID          = "IsAppID"           // 直接名字面闸门，必须在写入之前调用
	gateExistingRowOnly  = "existing-row"      // 只改既有行：写入之前必须先取既有行
	gateSeedRepair       = "seed-repair"       // 播种/数据修复专用 DAO（不服务 HTTP 请求）
	gateExecutorPassthru = "executor-passthru" // 写入口自身：闸门在调用方
)

// appWriteCallSites 是「写入口调用点 → 闸门」的可执行登记表（判据 ① + ② 的真源）。
//
// `Calls` 是**该函数内**写入口的调用次数：改这个数（多加一条写路径）必须同时改表，
// 否则判据红 —— 这正是 m9 的形态。
type appWriteCallSite struct {
	File  string // server 模块内相对路径（POSIX）
	Func  string // 调用点所在的顶层函数/方法
	Calls int    // 该函数内写入口的调用次数
	Kind  string // 闸门种类（见上面四个常量）
	Guard string // Kind=gateIsAppID/gateExistingRowOnly 时，必须在写入前出现的调用名
	Why   string // 这个点为什么安全 / 它的闸门是什么（表必须自解释）
}

var appWriteCallSites = []appWriteCallSite{
	{
		File: "internal/serverstore/apps.go", Func: "UpsertApp", Calls: 1,
		Kind: gateExecutorPassthru,
		Why:  "导出写入口：只是 upsertApp 的薄包装，闸门在调用方（见表内各调用点）",
	},
	{
		File: "internal/serverstore/apps.go", Func: "UpsertAppAndCreateReleaseOn", Calls: 1,
		Kind: gateExecutorPassthru,
		Why:  "事务版写入口：同上；生产调用方只有 appstore.Publish",
	},
	{
		File: "internal/appstore/publish.go", Func: "Publish", Calls: 1,
		Kind: gateIsAppID, Guard: "IsAppID",
		Why: "统一发布内核（三条上传路径共用）：函数首段就判 skillmanifest.IsAppID(req.AppID)",
	},
	{
		File: "internal/marketplace/agent_api.go", Func: "createAgentAdmin", Calls: 1,
		Kind: gateIsAppID, Guard: "IsAppID",
		Why: "管理端登记市场智能体：marketplace-9 起与上传同一套名字口径",
	},
	{
		File: "internal/marketplace/agent_api.go", Func: "updateAgentAdmin", Calls: 1,
		Kind: gateExistingRowOnly, Guard: "marketAgentApp",
		Why: "只改既有行的元数据：先 marketAgentApp（市场渠道守卫）取既有行，不能创建新 app_id",
	},
	{
		File: "internal/serverstore/agent_presets.go", Func: "CreateAgentPreset", Calls: 1,
		Kind: gateSeedRepair,
		Why:  "播种/数据修复专用 DAO（组织智能体）；不服务 HTTP 请求，生产发布走 appstore.Publish",
	},
	{
		File: "internal/serverstore/shared_skills.go", Func: "CreateSharedSkill", Calls: 1,
		Kind: gateSeedRepair,
		Why:  "播种/数据修复专用 DAO（组织技能）；同上",
	},
	{
		File: "internal/serverstore/skills.go", Func: "AddSkill", Calls: 1,
		Kind: gateSeedRepair,
		Why:  "播种/数据修复专用 DAO（市场技能）；同上",
	},
}

func TestAppWriteCallSitesAreRegisteredWithGates(t *testing.T) {
	root := appWriteModuleRoot(t)
	got := collectAppWriteCallSites(t, root)

	want := make(map[string]appWriteCallSite, len(appWriteCallSites))
	for _, s := range appWriteCallSites {
		if strings.TrimSpace(s.Why) == "" {
			t.Fatalf("登记表里 %s|%s 的说明为空（表必须自解释闸门与代价）", s.File, s.Func)
		}
		if s.Calls < 1 {
			t.Fatalf("登记表里 %s|%s 的 Calls=%d，必须 ≥1", s.File, s.Func, s.Calls)
		}
		if s.Kind == gateIsAppID || s.Kind == gateExistingRowOnly {
			if strings.TrimSpace(s.Guard) == "" {
				t.Fatalf("登记表里 %s|%s 声明了 %s 却没有 Guard 调用名（判据 ② 无法验证）", s.File, s.Func, s.Kind)
			}
		}
		want[s.File+"|"+s.Func] = s
	}

	// 判据 ①：集合相等 + 次数相等（双向）。
	seen := map[string]bool{}
	for _, s := range got {
		key := s.File + "|" + s.Func
		seen[key] = true
		w, ok := want[key]
		if !ok {
			t.Errorf("出现**表外**的 app 写入口调用点 %s（%s:%d，共 %d 次）：先判定它是否经过名字面闸门"+
				"（skillmanifest.IsAppID / appstore.Publish / 只改既有行 / 播种专用），确认后把该点补进"+
				"appWriteCallSites —— 绕过名字面的写路径会让「审核通过 = 客户端装不上」复发",
				key, s.File, s.FirstLine, s.Calls)
			continue
		}
		if s.Calls != w.Calls {
			t.Errorf("%s 的写入口调用次数 = %d, want %d（登记表）—— 在一个已有函数里**新增**一条写路径"+
				"（复审变异 m9 的形态）必须同步登记并说明闸门", key, s.Calls, w.Calls)
		}
	}
	for _, w := range appWriteCallSites {
		if !seen[w.File+"|"+w.Func] {
			t.Errorf("登记的写入口 %s|%s 不再被调用：判据锚点已漂移（删/改名都要同步本表）", w.File, w.Func)
		}
	}

	// 判据 ③：负控 —— 表必须覆盖发布内核与管理端登记两条关键写路径。
	for _, must := range []string{
		"internal/appstore/publish.go|Publish",
		"internal/marketplace/agent_api.go|createAgentAdmin",
	} {
		if _, ok := want[must]; !ok {
			t.Fatalf("登记表缺了关键写路径 %s（它正是名字面闸门所在的位置）", must)
		}
	}

	// 判据 ②：闸门声明的**结构验证**（表里的声明必须在源码里成立）。
	for _, s := range got {
		w, ok := want[s.File+"|"+s.Func]
		if !ok {
			continue
		}
		switch w.Kind {
		case gateIsAppID, gateExistingRowOnly:
			guardLine := s.firstGuardLine(w.Guard)
			if guardLine < 0 {
				t.Errorf("%s|%s 声明闸门是 %q，但该函数里**根本没有**这次调用 ⇒ 声明不成立",
					w.File, w.Func, w.Guard)
				continue
			}
			if guardLine > s.FirstLine {
				t.Errorf("%s|%s 声明闸门是 %q，但它出现在写入口调用**之后**（闸门在第 %d 行、"+
					"写入在第 %d 行）—— 名字面/行存在性判断必须在写入之前",
					w.File, w.Func, w.Guard, guardLine, s.FirstLine)
			}
		}
	}
}

// appWriteSite 是一个函数内的写入口调用聚合（`Calls` 计数是 m9 形态的克星）。
type appWriteSite struct {
	File       string
	Func       string
	Calls      int
	FirstLine  int
	guardLines map[string]int // 闸门调用名 → 该函数内首次出现的行号
}

func (s appWriteSite) firstGuardLine(name string) int {
	if n, ok := s.guardLines[name]; ok {
		return n
	}
	return -1
}

// collectAppWriteCallSites 用 AST 枚举 server 生产源码（internal/ 与 cmd/，排除 _test.go）
// 里的写入口调用点，按「文件 | 顶层函数」聚合调用次数与闸门调用位置。
func collectAppWriteCallSites(t *testing.T, moduleRoot string) []appWriteSite {
	t.Helper()
	type key struct{ file, fn string }
	agg := map[key]*appWriteSite{}
	guards := map[key]map[string]int{}
	guardNames := map[string]bool{"IsAppID": true, "marketAgentApp": true}
	for _, rel := range []string{"internal", "cmd"} {
		base := filepath.Join(moduleRoot, rel)
		werr := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			fset := token.NewFileSet()
			file, perr := parser.ParseFile(fset, path, nil, 0)
			if perr != nil {
				t.Fatalf("解析 %s: %v", path, perr)
			}
			relPath, rerr := filepath.Rel(moduleRoot, path)
			if rerr != nil {
				t.Fatalf("相对路径 %s: %v", path, rerr)
			}
			relPath = filepath.ToSlash(relPath)
			for _, decl := range file.Decls {
				fd, ok := decl.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				k := key{relPath, fd.Name.Name}
				ast.Inspect(fd, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					name := ""
					switch fun := call.Fun.(type) {
					case *ast.Ident:
						name = fun.Name
					case *ast.SelectorExpr:
						name = fun.Sel.Name
					}
					if name == "" {
						return true
					}
					isWrite := false
					for _, w := range appWriteEntries {
						if name == w {
							isWrite = true
							break
						}
					}
					if !isWrite && !guardNames[name] {
						return true
					}
					line := fset.Position(call.Pos()).Line
					if isWrite {
						s, ok := agg[k]
						if !ok {
							s = &appWriteSite{File: k.file, Func: k.fn, FirstLine: -1, guardLines: map[string]int{}}
							agg[k] = s
						}
						s.Calls++
						if s.FirstLine < 0 || line < s.FirstLine {
							s.FirstLine = line
						}
						return true
					}
					g, ok := guards[k]
					if !ok {
						g = map[string]int{}
						guards[k] = g
					}
					if cur, seen := g[name]; !seen || line < cur {
						g[name] = line
					}
					return true
				})
			}
			return nil
		})
		if werr != nil {
			t.Fatalf("遍历 %s: %v", base, werr)
		}
	}
	for k, g := range guards {
		if s, ok := agg[k]; ok {
			s.guardLines = g
		}
	}
	out := make([]appWriteSite, 0, len(agg))
	for _, s := range agg {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Func < out[j].Func
	})
	if len(out) == 0 {
		t.Fatal("一个 app 写入口调用点都没扫到：判据失效（路径推断错或写入口被改名），必须红")
	}
	return out
}

// appWriteModuleRoot 返回 server/ 目录（测试工作目录恒为包目录）。
func appWriteModuleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("取工作目录: %v", err)
	}
	root := filepath.Clean(filepath.Join(wd, "..", ".."))
	if _, serr := os.Stat(filepath.Join(root, "go.mod")); serr != nil {
		t.Fatalf("推断的模块根 %s 不含 go.mod: %v", root, serr)
	}
	return root
}

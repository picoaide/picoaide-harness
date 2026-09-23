package readyz

// 本文件是**发布闸门自愈路径登记表**的常设判据（2026-09-23 现场 P0-c 第 2 条）。
//
// 要防的东西（现场 P0 的教训）："编译缓存超上限"被写成**阻塞项**，而它唯一的解除者是
// "编译作业之后的回收"——恰恰被这道闸门关上 ⇒ 自锁、永不恢复。根因不是某个判断写错了，
// 而是**新增一条阻塞理由时没有人回答"谁来解除它"**。
//
// 因此：每一条阻塞理由都必须在 `publishBlockers` 里登记解除者（周期任务 / 同步回收 /
// 自然回落）或"需运维介入 + 可行动文案"。本文件用**两个方向**钉住它：
//
//	① 行为方向：真的造出每一条 reason，逐一在登记表里查得到；登记表里登记的每一条
//	   也必须真的能被造出来（"登记了却不在 / 在却没登记"都红）；
//	② 源码方向：collect() 里每条 reason 都必须经 `Snapshot.addReason` 用 reason* 常量
//	   产出（禁止裸拼 `s.Reasons = append(...)`）—— 否则"新增一条理由"可以绕开登记表。
//
// 变异验证（实跑，见交付报告）：
//   - 在 collect() 里加一条未登记的阻塞理由（无论是走 addReason + 新常量，还是裸
//     `s.Reasons = append("新的阻塞理由…")`）⇒ 本文件红；
//   - 把某条阻塞理由的 Heal 清空 / Action 清空（HealOperator）⇒ 本文件红；
//   - 删掉某条登记项（而 collect() 仍会产出它）⇒ 行为方向红。
//
// ⚠️ 解析面（R5-D-27，2026-09-23 五轮对抗审计）：判据扫的是**整个包目录下的全部非测试
// .go 文件**，而不是只解析 `readyz.go`。旧形态（只解析一个文件）有一个**静默逃逸**：
// 把新的阻塞 reason 的写入点放进同包另一个文件（方法名不叫 `addReason`、或干脆在别处
// `s.Reasons = append(...)`）⇒ 八条登记表判据全绿，而那条 reason **未登记** ⇒ 装配后成为
// "未登记的 fail-closed 阻塞" ⇒ 永久 503 且没有解除者（正是 909440eab4 刚修的现场自锁
// 形态复发）。现在两个方向都被包级扫描罩住，且"扫不到任何写入点/一个文件都没解析到"
// 一律 fail-loud（不许静默通过）。

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// reasonsSourceDir 是源码判据解析的**包目录**（与测试同目录；R5-D-27 起是整包而不是单文件）。
const reasonsSourceDir = "."

// reasonScan 是一次包级扫描的结果。
type reasonScan struct {
	// Files 是**已解析**的非测试 .go 文件（相对路径）。
	Files []string
	// Produced 是 addReason 产出的 reason 值 → 出现次数。
	Produced map[string]int
	// Problems 是结构性缺陷（解析失败 / 没有文件 / 裸写 Reasons / addReason 缺失或重复 /
	// 首个参数不是常量标识符 / 参数个数不对）。**任何一条都必须 fail-loud**。
	Problems []string
}

// nonTestGoFiles 列出 dir 下的非测试 .go 文件（排序后返回，保证判据可复现）。
func nonTestGoFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out, nil
}

// scanPackageReasons 扫**包目录下的全部非测试 .go**（R5-D-27 的解析面）。
func scanPackageReasons(dir string) reasonScan {
	paths, err := nonTestGoFiles(dir)
	if err != nil {
		return reasonScan{Produced: map[string]int{}, Problems: []string{fmt.Sprintf("列举 %s 下的源文件失败: %v", dir, err)}}
	}
	if len(paths) == 0 {
		return reasonScan{Produced: map[string]int{}, Problems: []string{fmt.Sprintf("%s 下没有任何非测试 .go 文件（判据失效）", dir)}}
	}
	abs := make([]string, 0, len(paths))
	for _, p := range paths {
		abs = append(abs, dir+string(os.PathSeparator)+p)
	}
	return scanReasonSources(abs)
}

// scanReasonSources 扫**给定的源文件集合**（跨文件语义：常量表与 addReason 实现体的位置
// 都是包级聚合的，因此"常量在 A 文件、addReason 调用在 B 文件"同样被罩住）。
func scanReasonSources(paths []string) reasonScan {
	res := reasonScan{Files: append([]string{}, paths...), Produced: map[string]int{}}
	type parsedFile struct {
		path string
		fset *token.FileSet
		file *ast.File
	}
	var files []parsedFile
	consts := map[string]string{} // 包级常量表（name → 字符串值）
	type span struct {
		path     string
		pos, end token.Pos
	}
	var addReasonSpans []span

	for _, p := range paths {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			res.Problems = append(res.Problems, fmt.Sprintf("解析 %s 失败: %v", p, err))
			continue
		}
		files = append(files, parsedFile{p, fset, file})
		ast.Inspect(file, func(n ast.Node) bool {
			gd, ok := n.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				return true
			}
			for _, spec := range gd.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, name := range vs.Names {
					if i >= len(vs.Values) {
						continue
					}
					if lit, ok := vs.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
						if v, uerr := strconv.Unquote(lit.Value); uerr == nil {
							consts[name.Name] = v
						}
					}
				}
			}
			return true
		})
		ast.Inspect(file, func(n ast.Node) bool {
			fd, ok := n.(*ast.FuncDecl)
			if ok && fd.Name != nil && fd.Name.Name == "addReason" {
				addReasonSpans = append(addReasonSpans, span{p, fd.Pos(), fd.End()})
			}
			return true
		})
	}
	if len(files) == 0 {
		res.Problems = append(res.Problems, "一个源文件都没解析成功（判据失效）")
		return res
	}
	// addReason 自己的实现体是**唯一**允许写 `s.Reasons = append(...)` 的地方（它就是那个
	// 集中点）—— 赋值判据在该区间内豁免。缺失 ⇒ fail-loud（否则"没有集中点"会静默放行一切）。
	switch len(addReasonSpans) {
	case 0:
		res.Problems = append(res.Problems, "找不到 addReason 的实现（判据本身失效）")
	case 1:
	default:
		res.Problems = append(res.Problems, fmt.Sprintf("addReason 有 %d 处实现（集中点必须唯一）", len(addReasonSpans)))
	}

	for _, pf := range files {
		inAddReason := func(n ast.Node) bool {
			for _, s := range addReasonSpans {
				if s.path == pf.path && n.Pos() >= s.pos && n.End() <= s.end {
					return true
				}
			}
			return false
		}
		ast.Inspect(pf.file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.AssignStmt:
				// 禁止直接给 *Reasons 赋值/追加（会绕过登记表）；addReason 自己的实现体除外。
				if inAddReason(node) {
					return true
				}
				for _, lhs := range node.Lhs {
					sel, ok := lhs.(*ast.SelectorExpr)
					if ok && sel.Sel.Name == "Reasons" {
						res.Problems = append(res.Problems, fmt.Sprintf(
							"%s:%d 直接对 Reasons 赋值/追加 —— reason 必须经 Snapshot.addReason 用登记常量产出"+
								"（否则发布闸门的判据表无法枚举，见 publishBlockers 的注释）",
							pf.path, pf.fset.Position(node.Pos()).Line))
					}
				}
			case *ast.CallExpr:
				sel, ok := node.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "addReason" {
					return true
				}
				if len(node.Args) != 2 {
					res.Problems = append(res.Problems, fmt.Sprintf("%s:%d addReason 需要 2 个参数 (prefix, extra)",
						pf.path, pf.fset.Position(node.Pos()).Line))
					return true
				}
				ident, ok := node.Args[0].(*ast.Ident)
				if !ok {
					res.Problems = append(res.Problems, fmt.Sprintf(
						"%s:%d addReason 的第一个参数必须是 reason* 常量标识符（不许写字面量/拼接）",
						pf.path, pf.fset.Position(node.Pos()).Line))
					return true
				}
				value, ok := consts[ident.Name]
				if !ok {
					res.Problems = append(res.Problems, fmt.Sprintf(
						"%s:%d addReason 的 %s 不是本包的字符串常量 —— 新增 reason 必须先在常量区声明并登记进 publishBlockers",
						pf.path, pf.fset.Position(node.Pos()).Line, ident.Name))
					return true
				}
				res.Produced[value]++
			}
			return true
		})
	}
	if len(res.Produced) == 0 {
		res.Problems = append(res.Problems, "扫描没有找到任何 addReason 产出点（判据失效：不许静默通过）")
	}
	sort.Strings(res.Problems)
	return res
}

// registryCoverageProblems 返回"源码写入点 ↔ 登记表"两个方向的全部不一致（空 ⇒ 一致）。
//
// 抽成纯函数（R5-D-27 的要求）：跨文件正/反例可以在**临时目录的合成源文件**上跑同一套
// 判据，而不必改真实包内容 —— "把写入点放进第二个文件且不登记 ⇒ 必须红"这件事因此是
// 可复跑的判据，而不是一次性的手工变异。
func registryCoverageProblems(produced map[string]int, blockers []publishBlocker) []string {
	var out []string
	registered := map[string]bool{}
	for _, b := range blockers {
		if registered[b.Prefix] {
			out = append(out, fmt.Sprintf("登记表里有重复前缀：%q", b.Prefix))
		}
		registered[b.Prefix] = true
	}
	for prefix, n := range produced {
		if !registered[prefix] {
			out = append(out, fmt.Sprintf("产出的 reason %q（%d 处）没有登记 —— 新增阻塞理由必须显式回答"+
				"「谁来解除它」（periodic-task / sync-reclaim / self-draining / operator+可行动文案）", prefix, n))
		}
	}
	for _, b := range blockers {
		if produced[b.Prefix] == 0 {
			out = append(out, fmt.Sprintf("登记项 %q 在源码里没有任何产出点（陈旧登记：它不会出现在 /readyz 上）", b.Prefix))
		}
	}
	sort.Strings(out)
	return out
}

// collectReasonPrefixes 扫真实包并把结构性缺陷一律 fail-loud。
//
// 判据形态：
//   - 每条 reason 必须写成 `s.addReason(<reason 常量>, …)`（第一个参数是**标识符**）；
//   - 一律禁止 `*.Reasons = append(...)` 的裸拼装（绕过登记表）；
//   - 标识符必须解析到本包（**任意文件**）的字符串常量（改名/新字面量都会被抓住）；
//   - 解析面 = 包目录下全部非测试 .go（R5-D-27）。
func collectReasonPrefixes(t *testing.T) map[string]int {
	t.Helper()
	res := scanPackageReasons(reasonsSourceDir)
	if len(res.Problems) > 0 {
		t.Fatalf("源码判据发现结构性缺陷（%d 条，解析面=%s 下全部非测试 .go）：%s",
			len(res.Problems), reasonsSourceDir, strings.Join(res.Problems, "；"))
	}
	return res.Produced
}

// TestPublishBlockersCoverEveryReasonInSource：源码方向 —— 产出的每一条 reason 都已登记，
// 登记的每一条也都真的会被产出（两个方向都由 registryCoverageProblems 判定，解析面=整包）。
func TestPublishBlockersCoverEveryReasonInSource(t *testing.T) {
	produced := collectReasonPrefixes(t)
	if problems := registryCoverageProblems(produced, publishBlockers); len(problems) > 0 {
		t.Fatalf("源码写入点与登记表不一致（%d 条）：%s", len(problems), strings.Join(problems, "；"))
	}
}

// TestPublishBlockersHaveSelfHealOrOperatorAction：登记表自身的完整性 ——
// 阻塞项必须有解除者；"需运维介入"必须有可行动文案；非阻塞项必须解释为什么不拦。
func TestPublishBlockersHaveSelfHealOrOperatorAction(t *testing.T) {
	valid := map[PublishHealKind]bool{
		HealPeriodicReclaim: true,
		HealSyncReclaim:     true,
		HealSelfDraining:    true,
		HealOperator:        true,
	}
	var blocking int
	for _, b := range publishBlockers {
		if strings.TrimSpace(b.Prefix) == "" {
			t.Fatal("登记项缺 Prefix")
		}
		if !valid[b.Heal] {
			t.Fatalf("登记项 %q 的 Heal=%q 不是封闭枚举里的取值（自愈路径必须显式登记）", b.Prefix, b.Heal)
		}
		if b.BlocksPublish {
			blocking++
			if strings.TrimSpace(b.Why) == "" {
				t.Fatalf("阻塞项 %q 必须写清「不降级为非阻塞」的理由", b.Prefix)
			}
			if b.Heal == HealOperator && len([]rune(b.Action)) < 12 {
				t.Fatalf("阻塞项 %q 只能靠运维介入 ⇒ 必须给**可行动**文案（现在：%q）", b.Prefix, b.Action)
			}
		} else if strings.TrimSpace(b.Why) == "" {
			t.Fatalf("非阻塞项 %q 必须解释为什么不拦（防随手豁免）", b.Prefix)
		}
	}
	if blocking == 0 {
		t.Fatal("登记表里一条阻塞理由都没有（判据失效：AllowPublish 的失败面不应为空）")
	}
	// 现场 P0 的那条理由必须登记了**两条**自动解除路径（周期回收 + 同步回收）。
	b, ok := publishBlockerFor(reasonCompileCacheOver)
	if !ok || !b.BlocksPublish {
		t.Fatal("编译缓存超上限必须是登记在案的阻塞理由（它不能降级为非阻塞：超限继续编译会把磁盘写满）")
	}
	if b.Heal != HealSyncReclaim {
		t.Fatalf("编译缓存超上限的解除者必须是同步回收（AllowPublish 自己），现在是 %q", b.Heal)
	}
	if !strings.Contains(b.Action, "周期任务") && !strings.Contains(b.Action, "每 5 分钟") {
		t.Fatalf("编译缓存超上限的文案必须同时点出周期回收这条路径：%q", b.Action)
	}
}

// TestAllowPublishBlockingSetUnregisteredFailsClosed：**未登记 ⇒ 阻塞**（安全方向）。
//
// 这条挡住"新增理由但忘了登记"时的运行期行为：宁可不发布，也不静默放行。
func TestAllowPublishBlockingSetUnregisteredFailsClosed(t *testing.T) {
	if !blocksPublish("一条从未登记过的新阻塞理由：42") {
		t.Fatal("未登记的 reason 必须 fail-closed 视为阻塞")
	}
	// 两条已登记的非阻塞说明项必须继续豁免（否则执行槽满时会连发布都做不了）。
	if blocksPublish(reasonExecutorFull + "：32 ≥ 32") {
		t.Fatal("执行槽满是登记在案的非阻塞项")
	}
	if blocksPublish(reasonMemUnavailable + "：detail") {
		t.Fatal("未取到可用内存是登记在案的非阻塞项")
	}
}

// ===== 行为方向：真的造出每一条 reason =====

// reasonCase 是一个"能造出某条 reason"的配置。
type reasonCase struct {
	name string
	// want 是这条配置必须产出的 reason 前缀（空 ⇒ 只要求"产出的都登记过"）。
	want string
	make func(t *testing.T) Options
}

func reasonCases() []reasonCase {
	return []reasonCase{
		{
			name: "磁盘余量不足", want: reasonDiskLow,
			make: func(t *testing.T) Options { return fixedOpts(MinDiskFreeBytes-1, nil) },
		},
		{
			name: "磁盘余量不可读", want: reasonDiskUnreadable,
			make: func(t *testing.T) Options {
				o := fixedOpts(MinDiskFreeBytes, nil)
				o.DiskFree = func(string) (int64, error) { return 0, errors.New("statfs: 输入/输出错误") }
				return o
			},
		},
		{
			name: "编译子系统不可用", want: reasonCompileUnavailable,
			make: func(t *testing.T) Options {
				o := fixedOpts(MinDiskFreeBytes, nil)
				o.CompileAvailability = func() CompileAvailability {
					return CompileAvailability{Available: false, Detail: "编译子进程缺失"}
				}
				return o
			},
		},
		{
			name: "编译队列已满", want: reasonQueueFull,
			make: func(t *testing.T) Options {
				return fixedOpts(MinDiskFreeBytes, &CompilerStatsSnapshot{QueueDepth: limits.CompileQueueDepth})
			},
		},
		{
			name: "编译缓存超上限", want: reasonCompileCacheOver,
			make: func(t *testing.T) Options {
				f := newFakeCache(int64(limits.CompileCacheMaxBytes)+1, int64(limits.CompileCacheMaxBytes))
				return overLimitOpts(t, f)
			},
		},
		{
			name: "数据库不可达", want: reasonDBUnreachable,
			make: func(t *testing.T) Options {
				o := fixedOpts(MinDiskFreeBytes, nil)
				o.Ping = func() error { return errors.New("connection refused") }
				return o
			},
		},
		{
			name: "执行槽已满", want: reasonExecutorFull,
			make: func(t *testing.T) Options {
				o := fixedOpts(MinDiskFreeBytes, nil)
				sch := queue.New(queue.DefaultOptions())
				o.Scheduler = sch
				for i := 0; i < limits.GlobalInstances; i++ {
					tk, err := sch.Acquire(t.Context(), "app-"+strconv.Itoa(i), int64(i+1))
					if err != nil {
						t.Fatalf("acquire: %v", err)
					}
					t.Cleanup(tk.Release)
				}
				return o
			},
		},
		{
			name: "未取到可用内存", want: reasonMemUnavailable,
			make: func(t *testing.T) Options {
				o := fixedOpts(MinDiskFreeBytes, nil)
				o.MemAvailable = func() MemoryAvailability {
					return MemoryAvailability{Source: MemorySourceNone, Detail: "读 /proc/meminfo 失败"}
				}
				return o
			},
		},
	}
}

// TestEveryRegistryEntryIsProducibleAndRegistered：逐条造出全部 reason，
// 断言"产出的都在登记表里"且"登记表里的都被产出过"（双向）。
func TestEveryRegistryEntryIsProducibleAndRegistered(t *testing.T) {
	seen := map[string]bool{}
	for _, tc := range reasonCases() {
		t.Run(tc.name, func(t *testing.T) {
			s := New(tc.make(t)).Snapshot()
			if len(s.Reasons) == 0 {
				t.Fatalf("这条配置应产出 reason（%s）", tc.want)
			}
			for _, r := range s.Reasons {
				if _, ok := publishBlockerFor(r); !ok {
					t.Fatalf("产出了未登记的 reason：%q", r)
				}
				seen[prefixOf(r)] = true
			}
			if tc.want != "" {
				found := false
				for _, r := range s.Reasons {
					if strings.HasPrefix(r, tc.want) {
						found = true
					}
				}
				if !found {
					t.Fatalf("没有产出期望的理由 %q：%v", tc.want, s.Reasons)
				}
			}
		})
	}
	for _, b := range publishBlockers {
		if !seen[b.Prefix] {
			t.Fatalf("登记项 %q 在行为用例里造不出来（登记了却不在：判据/实现已漂移）", b.Prefix)
		}
	}
}

// prefixOf 返回 reason 命中的登记前缀（调用方保证已登记）。
func prefixOf(reason string) string {
	b, _ := publishBlockerFor(reason)
	return b.Prefix
}

// TestReasonPrefixConstantsMatchRegistry：常量值与登记项一字不差（防"改文案不改登记"）。
func TestReasonPrefixConstantsMatchRegistry(t *testing.T) {
	for _, want := range []string{
		reasonExecutorFull, reasonCompileUnavailable, reasonMemUnavailable,
		reasonDiskLow, reasonDiskUnreadable, reasonQueueFull, reasonCompileCacheOver, reasonDBUnreachable,
	} {
		if _, ok := publishBlockerFor(want); !ok {
			t.Fatalf("常量 %q 没有登记进 publishBlockers", want)
		}
	}
}

// TestCollectReasonPrefixesScannerIsNotVacuous：判据自证 ——
// 扫描器必须真的从源码里读到全部 8 条 reason（否则"没找到 ⇒ 不报错"就是假绿），
// 并且**真的覆盖了包目录下的每一个非测试 .go 文件**（R5-D-27：漏文件 = 静默逃逸）。
func TestCollectReasonPrefixesScannerIsNotVacuous(t *testing.T) {
	produced := collectReasonPrefixes(t)
	if len(produced) != len(publishBlockers) {
		t.Fatalf("扫描到 %d 条 reason，登记表有 %d 条（扫描器或实现漂移）：%v",
			len(produced), len(publishBlockers), produced)
	}
	// 解析面完整性：本次扫描的文件集合必须等于包目录下的全部非测试 .go 文件。
	want, err := nonTestGoFiles(reasonsSourceDir)
	if err != nil {
		t.Fatalf("列举包目录源文件失败：%v", err)
	}
	if len(want) == 0 {
		t.Fatal("包目录下没有任何非测试 .go 文件（判据失效）")
	}
	res := scanPackageReasons(reasonsSourceDir)
	if len(res.Problems) > 0 {
		t.Fatalf("包级扫描有结构性缺陷：%s", strings.Join(res.Problems, "；"))
	}
	got := map[string]bool{}
	for _, f := range res.Files {
		got[filepath.Base(f)] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Fatalf("包级扫描漏掉了 %s（解析面必须罩住同包**全部**非测试 .go —— "+
				"漏一个文件就等于给「把写入点搬过去」开了后门，R5-D-27）：扫过=%v", name, res.Files)
		}
	}
}

// ===== R5-D-27：解析面的**跨文件**正/反例（合成源文件，不改真实包）=====

// syntheticPackage 在临时目录里造一个"两个文件的包"，返回目录与两个文件路径。
//
// 第一个文件承载常量表与 addReason 的**实现体**（唯一允许裸写 Reasons 的地方）；
// 第二个文件承载**新的写入点** —— 这正是旧形态（只解析 readyz.go）漏掉的形态。
func syntheticPackage(t *testing.T, extraSource string) (dir, first, second string) {
	t.Helper()
	dir = t.TempDir()
	first = filepath.Join(dir, "registry.go")
	second = filepath.Join(dir, "extra_writer.go")
	write := func(path, src string) {
		if err := os.WriteFile(path, []byte(src), 0o600); err != nil {
			t.Fatalf("写合成源文件 %s: %v", path, err)
		}
	}
	write(first, `package readyz

// 已知理由（已登记）
const reasonKnown = "已知理由"

type Snapshot struct{ Reasons []string }

// addReason 记一条 reason：集中点（唯一允许裸写 Reasons 的地方）。
func (s *Snapshot) addReason(prefix, extra string) {
	s.Reasons = append(s.Reasons, prefix+extra)
}

func collectKnown(s *Snapshot, ok bool) {
	if ok {
		s.addReason(reasonKnown, "")
	}
}
`)
	write(second, extraSource)
	return dir, first, second
}

// TestRegistryScannerCoversWholePackageCrossFile 是 R5-D-27 的承重判据：
//
//	反例：新写入点在**同包第二个文件**且未登记 ⇒ 包级扫描必须产出它、覆盖判据必须红；
//	      而"只解析第一个文件"的旧形态**抓不到**（这正是本条修复存在的理由）；
//	正例：同一条 reason 登记之后 ⇒ 覆盖判据必须绿。
func TestRegistryScannerCoversWholePackageCrossFile(t *testing.T) {
	const newReason = "一条没登记的新阻塞理由"
	const extra = `package readyz

const reasonUndeclared = "一条没登记的新阻塞理由"

func collectExtra(s *Snapshot) {
	s.addReason(reasonUndeclared, "")
}
`
	_, first, second := syntheticPackage(t, extra)

	// ① 反例（跨文件、未登记）：包级扫描必须看见它，覆盖判据必须红。
	pkg := scanReasonSources([]string{first, second})
	if len(pkg.Problems) > 0 {
		t.Fatalf("合成包不该有结构性缺陷：%s", strings.Join(pkg.Problems, "；"))
	}
	if pkg.Produced[newReason] == 0 {
		t.Fatalf("包级扫描必须覆盖第二个文件里的写入点（R5-D-27）：%v", pkg.Produced)
	}
	problems := registryCoverageProblems(pkg.Produced, []publishBlocker{{Prefix: "已知理由", BlocksPublish: true, Heal: HealSelfDraining, Why: "夹具"}})
	if len(problems) == 0 {
		t.Fatal("未登记的跨文件 reason 必须被覆盖判据抓住（否则它会成为没有解除者的永久 503）")
	}
	if !strings.Contains(strings.Join(problems, "；"), newReason) {
		t.Fatalf("覆盖判据必须点名那条未登记的 reason：%v", problems)
	}
	// ② 旧形态（只解析第一个文件）**抓不到** —— 这条断言说明修复承重，而不是"看起来更全"。
	old := scanReasonSources([]string{first})
	if old.Produced[newReason] != 0 {
		t.Fatal("夹具不成立：旧形态（单文件解析）本该看不见第二个文件")
	}
	if got := registryCoverageProblems(old.Produced, []publishBlocker{{Prefix: "已知理由", BlocksPublish: true, Heal: HealSelfDraining, Why: "夹具"}}); len(got) != 0 {
		t.Fatalf("旧形态在反例上应当**全绿**（这就是 R5-D-27 的逃逸面）：%v", got)
	}
	// ③ 正例（跨文件、已登记）：同一份源码 + 登记项 ⇒ 覆盖判据必须绿。
	registered := []publishBlocker{
		{Prefix: "已知理由", BlocksPublish: true, Heal: HealSelfDraining, Why: "夹具"},
		{Prefix: newReason, BlocksPublish: true, Heal: HealOperator, Action: "请运维介入（夹具）", Why: "夹具"},
	}
	if got := registryCoverageProblems(pkg.Produced, registered); len(got) != 0 {
		t.Fatalf("登记之后必须绿：%v", got)
	}

	// ④ 同族逃逸面同样被罩住：第二个文件里**裸写** s.Reasons ⇒ 结构性缺陷。
	bareDir, bareFirst, bareSecond := syntheticPackage(t, `package readyz

func collectBare(s *Snapshot) {
	s.Reasons = append(s.Reasons, "裸拼的阻塞理由")
}
`)
	bare := scanReasonSources([]string{bareFirst, bareSecond})
	if len(bare.Problems) == 0 || !strings.Contains(strings.Join(bare.Problems, "；"), "Reasons") {
		t.Fatalf("第二个文件里的裸写必须被抓住（否则绕过登记表的第二条路仍然通着）：%v", bare.Problems)
	}
	if _, err := nonTestGoFiles(bareDir); err != nil {
		t.Fatalf("nonTestGoFiles 在合成目录上失败：%v", err)
	}
}

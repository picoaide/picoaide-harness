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

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// reasonsSourceFile 是源码判据读的文件（与测试同目录）。
const reasonsSourceFile = "readyz.go"

// collectReasonPrefixes 从源码里取出 collect() 产出的全部 reason 前缀。
//
// 判据形态：
//   - 每条 reason 必须写成 `s.addReason(<reason 常量>, …)`（第一个参数是**标识符**）；
//   - 一律禁止 `*.Reasons = append(...)` 的裸拼装（绕过登记表）；
//   - 标识符必须解析到本文件里的字符串常量（改名/新字面量都会被抓住）。
func collectReasonPrefixes(t *testing.T) map[string]int {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, reasonsSourceFile, nil, 0)
	if err != nil {
		t.Fatalf("解析 %s 失败: %v", reasonsSourceFile, err)
	}
	// 先收集常量表（name → 字符串值）。
	consts := map[string]string{}
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

	out := map[string]int{}
	// addReason 自己的实现体是**唯一**允许写 `s.Reasons = append(...)` 的地方
	//（它就是那个集中点）—— 先算出它的位置区间，赋值判据在该区间内豁免。
	addReasonStart, addReasonEnd := token.NoPos, token.NoPos
	ast.Inspect(file, func(n ast.Node) bool {
		fd, ok := n.(*ast.FuncDecl)
		if ok && fd.Name != nil && fd.Name.Name == "addReason" {
			addReasonStart, addReasonEnd = fd.Pos(), fd.End()
		}
		return true
	})
	if !addReasonStart.IsValid() {
		t.Fatalf("%s 里找不到 addReason 的实现（判据本身失效了）", reasonsSourceFile)
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.AssignStmt:
			// 禁止直接给 *Reasons 赋值/追加（会绕过登记表）；addReason 自己的实现体除外。
			if node.Pos() >= addReasonStart && node.End() <= addReasonEnd {
				return true
			}
			for _, lhs := range node.Lhs {
				sel, ok := lhs.(*ast.SelectorExpr)
				if ok && sel.Sel.Name == "Reasons" {
					t.Fatalf("%s:%d 直接对 Reasons 赋值/追加 —— reason 必须经 Snapshot.addReason 用登记常量产出"+
						"（否则发布闸门的判据表无法枚举，见 publishBlockers 的注释）",
						reasonsSourceFile, fset.Position(node.Pos()).Line)
				}
			}
		case *ast.CallExpr:
			sel, ok := node.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "addReason" {
				return true
			}
			if len(node.Args) != 2 {
				t.Fatalf("%s:%d addReason 需要 2 个参数 (prefix, extra)",
					reasonsSourceFile, fset.Position(node.Pos()).Line)
			}
			ident, ok := node.Args[0].(*ast.Ident)
			if !ok {
				t.Fatalf("%s:%d addReason 的第一个参数必须是 reason* 常量标识符（不许写字面量/拼接）",
					reasonsSourceFile, fset.Position(node.Pos()).Line)
			}
			value, ok := consts[ident.Name]
			if !ok {
				t.Fatalf("%s:%d addReason 的 %s 不是本文件的字符串常量 —— 新增 reason 必须先在常量区声明并登记进 publishBlockers",
					reasonsSourceFile, fset.Position(node.Pos()).Line, ident.Name)
			}
			out[value]++
		}
		return true
	})
	if len(out) == 0 {
		t.Fatal("源码里没有找到任何 addReason 调用（判据本身失效了）")
	}
	return out
}

// TestPublishBlockersCoverEveryReasonInSource：源码方向 —— 产出的每一条 reason 都已登记，
// 登记的每一条也都真的会被产出。
func TestPublishBlockersCoverEveryReasonInSource(t *testing.T) {
	produced := collectReasonPrefixes(t)
	registered := map[string]bool{}
	for _, b := range publishBlockers {
		if registered[b.Prefix] {
			t.Fatalf("登记表里有重复前缀：%q", b.Prefix)
		}
		registered[b.Prefix] = true
	}
	for prefix, n := range produced {
		if _, ok := publishBlockerFor(prefix); !ok {
			t.Fatalf("collect() 产出的 reason %q（%d 处）没有登记 —— 新增阻塞理由必须显式回答"+
				"「谁来解除它」（periodic-task / sync-reclaim / self-draining / operator+可行动文案）", prefix, n)
		}
	}
	for _, b := range publishBlockers {
		if produced[b.Prefix] == 0 {
			t.Fatalf("登记项 %q 在 collect() 里没有任何产出点（陈旧登记：它不会出现在 /readyz 上）", b.Prefix)
		}
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
// 扫描器必须真的从源码里读到全部 8 条 reason（否则"没找到 ⇒ 不报错"就是假绿）。
func TestCollectReasonPrefixesScannerIsNotVacuous(t *testing.T) {
	produced := collectReasonPrefixes(t)
	if len(produced) != len(publishBlockers) {
		t.Fatalf("扫描到 %d 条 reason，登记表有 %d 条（扫描器或实现漂移）：%v",
			len(produced), len(publishBlockers), produced)
	}
	if _, err := os.Stat(reasonsSourceFile); err != nil {
		t.Fatalf("源码判据读的文件不存在：%v", err)
	}
}

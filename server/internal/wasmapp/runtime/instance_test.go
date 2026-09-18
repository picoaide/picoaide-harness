package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero/sys"
)

// 本文件覆盖 §10.2 第 14/15/21/22/23 项（沙箱能力面：随机源 / 时钟 / args / env / 零 preopen）。
//
// 判据都取"guest 自己读到的值"（探针 guest 把结果打成 stdout 文本，宿主直接捕获），
// 不依赖任何宿主侧的间接推断。
//
// 变异方式（用例必红的方式）：
//   - 去掉 newModuleConfig 的 WithRandSource(rand.Reader)  ⇒ TestInstanceConfig_RandomSourcePerInstance 红
//     （默认是固定种子 42 的伪随机：两个独立 Runtime 的 guest 会读到**完全相同**的序列）；
//   - 去掉 WithSysWalltime/WithSysNanotime ⇒ TestInstanceConfig_RealClock 红（guest 看到 2022-01-01）；
//   - 加 WithArgs/WithEnv ⇒ TestInstanceConfig_NoArgsNoEnv 红；
//   - 加任何 WithFS*/WithDirMount/WithFSMount ⇒ TestInstanceConfig_ZeroPreopen 红。

// runProbeIn 在一个**独立** Runtime 里跑探针 guest 并返回它的 stdout。
func runProbeIn(t *testing.T, rt *Runtime) string {
	t.Helper()
	out, errOut, err := runGuestCaptured(context.Background(), rt, guestBinary(t, "probe"),
		InstanceLimits{GuestBudget: 10 * time.Second}, strings.NewReader(""))
	if err != nil && !isNormalExit(err) {
		t.Fatalf("探针 guest 非正常结束: %v (stderr=%s)", err, errOut)
	}
	if out == "" {
		t.Fatalf("探针 guest 没有输出（stderr=%s）", errOut)
	}
	return out
}

func isNormalExit(err error) bool {
	var se *sys.ExitError
	return errors.As(err, &se) && se.ExitCode() == 0
}

func newProbeRuntime(t *testing.T) *Runtime {
	t.Helper()
	rt, err := New(context.Background(), Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close(context.Background()) })
	return rt
}

// §10.2 第 21 项：random_get 两次独立实例的序列必须**不同且非全零**。
func TestInstanceConfig_RandomSourcePerInstance(t *testing.T) {
	first := runProbeIn(t, newProbeRuntime(t))
	second := runProbeIn(t, newProbeRuntime(t)) // 另一个 Runtime（跨实例独立的极端情形）

	r1a := firstField(fieldOf(t, first, "rand1"))
	r1b := firstField(fieldOf(t, first, "rand2"))
	r2a := firstField(fieldOf(t, second, "rand1"))
	r2b := firstField(fieldOf(t, second, "rand2"))
	t.Logf("runtime#1 rand: %s %s\nruntime#2 rand: %s %s", r1a, r1b, r2a, r2b)

	for name, v := range map[string]string{"#1.rand1": r1a, "#1.rand2": r1b, "#2.rand1": r2a, "#2.rand2": r2b} {
		b, err := hex.DecodeString(v)
		if err != nil || len(b) != 16 {
			t.Fatalf("%s 不是 16 字节的十六进制: %q (%v)", name, v, err)
		}
		allZero := true
		for _, x := range b {
			if x != 0 {
				allZero = false
			}
		}
		if allZero {
			t.Fatalf("%s 是全零（固定种子伪随机的典型表现）", name)
		}
	}
	if r1a == r2a {
		t.Fatalf("两次独立实例的 random_get 序列相同（%s）⇒ WithRandSource(rand.Reader) 没生效", r1a)
	}
	if r1a == r1b {
		t.Fatalf("同一实例内两次 random_get 相同（%s）", r1a)
	}
}

// §10.2 第 22 项：clock_time_get 返回真实时间（默认是 2022-01-01 假时钟）。
func TestInstanceConfig_RealClock(t *testing.T) {
	before := time.Now().Unix()
	out := runProbeIn(t, newProbeRuntime(t))
	after := time.Now().Unix()
	got := intOf(t, fieldOf(t, out, "walltime_unix"))
	skew := got - before
	if skew < 0 {
		skew = -skew
	}
	if skew >= 60 {
		t.Fatalf("guest 读到的墙钟与真实时间差 %ds（§10.2 第 22 项要求 < 60s，实际值 %d，宿主 %d/%d）"+
			"：WithSysWalltime 未生效（默认是 2022-01-01 假时钟）", skew, got, before, after)
	}
	t.Logf("clock_time_get: guest=%d host=%d/%d 差=%ds", got, before, after, skew)
}

// §10.2 第 23 项：args_get / environ_get 读到的是空（不传 args、不传 env）。
func TestInstanceConfig_NoArgsNoEnv(t *testing.T) {
	out := runProbeIn(t, newProbeRuntime(t))
	args := fieldOf(t, out, "args")
	env := fieldOf(t, out, "environ")
	t.Logf("guest 读到 args=%s environ=%s", args, env)
	if args != "[]" {
		t.Fatalf("args 必须为空（不能把宿主命令行带进沙箱），实际 %s", args)
	}
	if env != "[]" {
		t.Fatalf("environ 必须为空（传 env = 把部署环境交进沙箱，§4.3），实际 %s", env)
	}
}

// §10.2 第 14/15 项：零 preopen 下所有文件操作 DENIED。
func TestInstanceConfig_ZeroPreopen(t *testing.T) {
	out := runProbeIn(t, newProbeRuntime(t))
	ops := parseOps(t, out)
	want := []string{"open_etc_passwd", "open_relative", "readdir_root", "stat_etc", "mkdir_tmp", "remove", "writefile", "readlink"}
	for _, name := range want {
		got, ok := ops[name]
		if !ok {
			t.Fatalf("探针没有报告 %s（输出：%s）", name, out)
		}
		t.Logf("%s -> %s errno=%d（%s）", name, got.result, got.errno, got.detail)
		if got.result != "DENIED" {
			t.Fatalf("%s 被允许了（零 preopen 被破坏：任何 WithFS*/WithDirMount/WithFSMount 都是漏洞）", name)
		}
		if got.errno == 0 {
			t.Fatalf("%s 的 errno 应为非零", name)
		}
	}
	// cwd：实测 Go wasip1 的 os.Getwd 会"成功"返回**空串**（没有 FS 配置 ⇒ 无 cwd），
	// 关键判据是它拿不到任何真实路径（非空即说明文件系统面被打开）。
	if cwd := firstField(fieldOf(t, out, "cwd")); cwd != "" {
		t.Fatalf("guest 取到了工作目录 %q ⇒ 文件系统面被打开", cwd)
	}
}

type opResult struct {
	result string
	errno  int
	detail string
}

var opLineRe = regexp.MustCompile(`^op (\S+) (DENIED|ALLOWED) errno=(\d+) as_errno=\w+ err="(.*)"$`)

// parseOps 解析探针的 op 行（格式见 testdata/guests/probe/main.go 的 op()）。
func parseOps(t *testing.T, out string) map[string]opResult {
	t.Helper()
	res := map[string]opResult{}
	for _, line := range strings.Split(out, "\n") {
		m := opLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		errno, err := strconv.Atoi(m[3])
		if err != nil {
			t.Fatalf("errno 不是整数: %q", m[3])
		}
		res[m[1]] = opResult{result: m[2], errno: errno, detail: m[4]}
	}
	if len(res) == 0 {
		t.Fatalf("没有任何 op 行（输出：%s）", out)
	}
	return res
}

// 手工核验 §10.2 第 16/17 项的**导入面**：Go wasip1 产物只导入 wasi_snapshot_preview1，
// 且没有 sock_* / env.* / js.*（这是"不能联网"的静态判据）。
//
// ⚠️ 实测结论（重要，给上传期白名单用）：**导入面取决于 guest 用了哪些 std 函数**，
// 不是每个 Go 程序都一样 —— 只做帧协议 + 内存分配的 app guest 与"跑文件/args/env
// 探针"的 probe guest 条数不同。因此 §4.2 的"导入面白名单由参考实现构建期生成"
// 必须是**参考实现并集**（或按符号+类型的保守超集），否则作者用一行 os.Stat 就会
// 撞 IMPORT_NOT_ALLOWED。
func TestGuestImportSurface_OnlyWasiNoSockets(t *testing.T) {
	rt := sharedRuntime(t)
	for _, pkg := range []string{"app", "probe"} {
		bin := guestBinary(t, pkg)
		cm, err := rt.CompileModule(context.Background(), bin)
		if err != nil {
			t.Fatalf("CompileModule(%s): %v", pkg, err)
		}
		names := map[string]int{}
		for _, f := range cm.ImportedFunctions() {
			mod, name, ok := f.Import()
			if !ok {
				t.Fatalf("%s: 导入项没有 module/name: %v", pkg, f)
			}
			if mod != limits.WasmImportModule {
				t.Fatalf("%s: 导入了非白名单模块 %q（§10.2 第 17 项：env.* / js.* 一律拒）", pkg, mod)
			}
			names[name]++
		}
		for _, banned := range []string{"sock_open", "sock_connect", "sock_send", "sock_recv", "sock_shutdown"} {
			if names[banned] > 0 {
				t.Fatalf("%s: 导入面含 %s ⇒ 沙箱具备出站能力（§10.2 第 16 项）", pkg, banned)
			}
		}
		if names["fd_read"] == 0 {
			t.Fatalf("%s: 导入面必须含 fd_read（ABI 读 stdin 需要，§4.2）", pkg)
		}
		if len(cm.ImportedMemories()) != 0 {
			t.Fatalf("%s: 不应导入内存，实际 %d 个", pkg, len(cm.ImportedMemories()))
		}
		sorted := make([]string, 0, len(names))
		for n, c := range names {
			sorted = append(sorted, n+"×"+strconv.Itoa(c))
		}
		sum := sha256.Sum256(bin)
		t.Logf("%s.wasm：%d 字节，sha256=%s，导入 %d 条 / %d 个不同名：%s",
			pkg, len(bin), hex.EncodeToString(sum[:]), countImports(names), len(names), strings.Join(sorted, ", "))
		if pkg == "probe" && countImports(names) != 26 {
			t.Logf("⚠️ probe 的导入条数从 26 变了（实测基线 26 条 / 23 名，Go 1.26.5）：现在是 %d，请同步白名单", countImports(names))
		}

		// 导出面：必须有 _start 与 memory。
		exports := map[string]bool{}
		for _, e := range cm.ExportedFunctions() {
			// 注意：必须用 ExportNames()，FunctionDefinition.Name() 是**调试名**不是导出名。
			for _, n := range e.ExportNames() {
				exports[n] = true
			}
		}
		for _, want := range limits.RequiredExports {
			if want == "memory" {
				if len(cm.ExportedMemories()) == 0 {
					t.Fatalf("%s: 缺少导出 memory（§4.2）", pkg)
				}
				continue
			}
			if !exports[want] {
				t.Fatalf("%s: 缺少导出 %s（§4.2）", pkg, want)
			}
		}
	}
}

func countImports(names map[string]int) int {
	n := 0
	for _, c := range names {
		n += c
	}
	return n
}

// 目录权限（§4.3：数据目录 0700）——与 NewCompilationCache 的断言互为补充：
// 这里断言"执行侧新建 Runtime 时不会把缓存目录权限放开"。
func TestNewRuntimeWithDataRoot_CacheDirMode(t *testing.T) {
	root := t.TempDir()
	rt, err := New(context.Background(), Options{DataRoot: root})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = rt.Close(context.Background()) }()
	fi, err := os.Stat(CompileCacheDir(root))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != os.FileMode(limits.DataDirMode) {
		t.Fatalf("缓存目录权限 %o ≠ %o", perm, limits.DataDirMode)
	}
	_ = guestBinary(t, "probe") // 让包级 guest 编译目录也走一遍清理路径
}

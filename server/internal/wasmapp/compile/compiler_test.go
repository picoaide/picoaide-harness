package compile

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
)

// 本文件是**真起进程**的编译验收（R19/R31）。
//
// 纪律：所有用例都真跑 cmd/picoaide-app-compile（或 testdata/compilechild 注入故障），
// 不用 mock 替掉 exec —— 超时/被杀/协议破坏/退出码都只有跨进程边界才成立。
//
// 变异方式：
//   - 去掉超时后的 kill ⇒ TestCompileTimeoutKillsChild 红（进程仍活着）；
//   - 把 COMPILE_TIMEOUT 换成 INTERNAL ⇒ 同用例红；
//   - 去掉缓存目录传递 ⇒ TestCompileSecondRunHitsCache 红；
//   - 去掉缓存回收 ⇒ TestReclaimCacheEnforcesBothLimits 红。

// waitProcGone 轮询等待进程消失（Linux 上看 /proc/<pid>；其它平台直接跳过）。
func waitProcGone(t *testing.T, pid int, within time.Duration) bool {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("仅 Linux 可从 /proc 判定进程是否真的没了")
	}
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join("/proc", itoa(pid))); err != nil {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}

func TestCompileColdThenWarmCache(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)

	dir := t.TempDir()
	mod := writeModule(t, dir, "app.wasm", wasmtest.Base())

	// 冷编译。
	cold, err := c.Compile(context.Background(), mod)
	if err != nil {
		t.Fatalf("冷编译失败: %v", err)
	}
	if cold.Cached {
		t.Error("首次编译不应报告命中缓存")
	}
	if len(cold.Imports) == 0 || len(cold.Exports) == 0 {
		t.Errorf("编译结果应带导入/导出面：%+v", cold)
	}
	if cold.CompileMS < 0 {
		t.Errorf("compile_ms 非法：%d", cold.CompileMS)
	}
	entries := c.CacheEntries()
	if len(entries) == 0 {
		t.Fatal("冷编译后缓存里应有条目（NewCompilationCacheWithDir 必须真的用了）")
	}
	for _, e := range entries {
		if !strings.HasPrefix(filepath.Base(filepath.Dir(e.Path)), "wazero-") {
			t.Errorf("条目应落在 wazero 的版本分片目录下：%s", e.Path)
		}
	}
	t.Logf("冷编译：%d ms，缓存 %d 条，共 %d 字节", cold.CompileMS, len(entries), c.Stats().CacheBytes)

	// 把条目 mtime 改成很久以前：这样"命中不写新条目"就有一个**确定性**判据
	//（不依赖文件系统 mtime 分辨率，也不依赖小模块本来就毫秒级的时间差）。
	old := time.Now().Add(-24 * time.Hour)
	for _, e := range c.CacheEntries() {
		if err := os.Chtimes(e.Path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := c.newestCacheMtime()

	warm, err := c.Compile(context.Background(), mod)
	if err != nil {
		t.Fatalf("热编译失败: %v", err)
	}
	after, entriesAfter := c.newestCacheMtime()
	if after != before {
		t.Errorf("第二次编译改写了缓存条目（mtime %d → %d）⇒ 没有命中缓存", before, after)
	}
	if !warm.Cached {
		t.Error("第二次编译应报告命中缓存（mtime 未前进）")
	}
	if entriesAfter != len(entries) {
		t.Errorf("缓存条目数变化：%d → %d（同一模块+同一 RuntimeConfig 必须复用同一条目，§4.3.1-a）",
			len(entries), entriesAfter)
	}
	t.Logf("热编译：%d ms（冷 %d ms），命中=%v", warm.CompileMS, cold.CompileMS, warm.Cached)
}

func TestCompileRealGoGuestModule(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：真实 guest 编译较慢")
	}
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)

	dir := t.TempDir()
	guestPath, guest := writeGuestModule(t, dir)
	_ = guestPath

	start := time.Now()
	first, err := c.Compile(context.Background(), writeModule(t, dir, "guest.wasm", guest))
	if err != nil {
		t.Fatalf("真实 Go wasip1 模块编译失败: %v", err)
	}
	wall1 := time.Since(start)
	if first.Cached {
		t.Error("首次编译不应命中缓存")
	}

	start = time.Now()
	second, err := c.Compile(context.Background(), writeModule(t, dir, "guest.wasm", guest))
	if err != nil {
		t.Fatalf("第二次编译失败: %v", err)
	}
	wall2 := time.Since(start)

	// 断言**必须无条件**：原来写成 `if second.Cached { ... }` ⇒ 命中判定坏掉时
	// 整个断言被跳过（假绿）。命中是缓存设计的核心不变量，不能"没命中就不查"。
	if !second.Cached {
		t.Errorf("第二次编译必须命中磁盘缓存（§4.3：编译进程与执行进程共享缓存）")
	}
	if wall2 >= wall1 {
		t.Errorf("命中缓存却未变快：冷 %v / 热 %v", wall1, wall2)
	}
	t.Logf("真实模块 %s：冷 wazero=%d ms（wall %v）/ 热 wazero=%d ms（wall %v）/ 命中=%v / 条目 %d 字节",
		describeInt(int64(len(guest))), first.CompileMS, wall1, second.CompileMS, wall2, second.Cached, c.Stats().CacheBytes)
	if len(first.Imports) < 5 {
		t.Errorf("真实 Go 产物应有多个 WASI 导入：%+v", first.Imports)
	}
}

func TestCompileTimeoutKillsChild(t *testing.T) {
	helper := compileHelperChild(t)
	c := newTestCompiler(t, helper, func(o *Options) {
		o.Timeout = 300 * time.Millisecond
		o.ChildArgs = []string{"-sleep", "30s"}
	})

	mod := writeModule(t, t.TempDir(), "app.wasm", wasmtest.Base())

	// 先手动起一次子进程，拿到 pid（真实 spawn 路径；ensureChild 自己加锁，
	// **不要**在调用方再加锁——内层 mu 是不可重入的）。
	proc, cerr := c.ensureChild(dirOf(mod))
	if cerr != nil {
		t.Fatalf("启动子进程失败: %v", cerr)
	}
	pid := proc.cmd.Process.Pid

	start := time.Now()
	_, err := c.Compile(context.Background(), mod)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("模拟慢编译应超时")
	}
	if err.Code != apperr.CodeCompileTimeout {
		t.Fatalf("超时应返回 COMPILE_TIMEOUT，实际 %s（%s）", err.Code, err.Message)
	}
	if err.Status() != 504 {
		t.Errorf("COMPILE_TIMEOUT 的 HTTP 语义应为 504，实际 %d", err.Status())
	}
	if elapsed > 5*time.Second {
		t.Errorf("超时应及时收场（%v）——不能等子进程自己结束", elapsed)
	}
	// **核心断言**：超时必须真的把子进程杀掉（不是"放弃等待"）。
	if !waitProcGone(t, pid, 5*time.Second) {
		t.Fatalf("超时后子进程 %d 仍活着（没有 kill）", pid)
	}
	t.Logf("超时证据：pid=%d 在 %v 后从 /proc 消失；错误码=%s", pid, elapsed.Round(time.Millisecond), err.Code)

	if st := c.Stats(); st.Timeouts != 1 {
		t.Errorf("Stats.Timeouts 应计 1 次，实际 %d", st.Timeouts)
	}
}

func TestCompileAfterTimeoutRestartsChild(t *testing.T) {
	helper := compileHelperChild(t)
	c := newTestCompiler(t, helper, func(o *Options) {
		o.Timeout = 300 * time.Millisecond
		o.ChildArgs = []string{"-sleep", "2s"}
	})
	mod := writeModule(t, t.TempDir(), "app.wasm", wasmtest.Base())

	if _, err := c.Compile(context.Background(), mod); err == nil || err.Code != apperr.CodeCompileTimeout {
		t.Fatalf("第一次应超时，实际 %v", err)
	}
	// 下一次请求必须自动重启子进程并成功（不需要人工干预）。
	c.opt.ChildArgs = nil // 换掉注入的"慢"行为（测试独占该 Compiler，无需加锁）
	c.DropChild()

	res, err := c.Compile(context.Background(), mod)
	if err != nil {
		t.Fatalf("超时后的下一次编译应成功（自动重启）：%v", err)
	}
	if res == nil {
		t.Fatal("应返回结果")
	}
}

func TestCompileCrashMapsToCompileOOM(t *testing.T) {
	helper := compileHelperChild(t)
	c := newTestCompiler(t, helper, func(o *Options) {
		o.ChildArgs = []string{"-crash"}
	})
	_, err := c.Compile(context.Background(), writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base()))
	if err == nil {
		t.Fatal("子进程崩溃应报错")
	}
	if err.Code != apperr.CodeCompileOOM {
		t.Fatalf("异常退出应映射 COMPILE_OOM(500)，实际 %s", err.Code)
	}
	if err.Status() != 500 {
		t.Errorf("COMPILE_OOM 的 HTTP 语义应为 500，实际 %d", err.Status())
	}
	if got, ok := err.Details["exit_code"]; !ok || got != 9 {
		t.Errorf("details 应带 exit code=9，实际 %+v", err.Details)
	}
}

func TestCompileGarbageResponseIsInternal(t *testing.T) {
	helper := compileHelperChild(t)
	c := newTestCompiler(t, helper, func(o *Options) {
		o.ChildArgs = []string{"-garbage"}
	})
	_, err := c.Compile(context.Background(), writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base()))
	if err == nil {
		t.Fatal("协议被破坏应报错")
	}
	if err.Code != apperr.CodeInternal {
		t.Fatalf("应答非 JSON 应归 INTERNAL，实际 %s", err.Code)
	}
}

func TestCompileStartupSelfCheckRejectsBadChild(t *testing.T) {
	helper := compileHelperChild(t)
	c := newTestCompiler(t, helper, func(o *Options) {
		o.ChildArgs = []string{"-badexit"}
		o.Timeout = 2 * time.Second
	})
	_, err := c.Compile(context.Background(), writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base()))
	if err == nil {
		t.Fatal("启动自检失败的子进程不应被使用")
	}
	if !strings.Contains(err.Message, "启动自检") {
		t.Errorf("错误应点名启动自检：%s", err.Message)
	}
}

func TestCompileQueueFullReturnsBusy(t *testing.T) {
	helper := compileHelperChild(t)
	c := newTestCompiler(t, helper, func(o *Options) {
		o.MaxQueue = 1
		o.Timeout = 500 * time.Millisecond
		o.ChildArgs = []string{"-sleep", "1s"}
	})
	mod := writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base())

	// 第一个占住 worker，第二个占住队列（深度 1），第三个必然被拒。
	done := make(chan struct{})
	go func() { _, _ = c.Compile(context.Background(), mod); close(done) }()
	// 等 worker 真的开始跑（compiling=true），否则第三个可能抢到队列位。
	waitUntil(t, 2*time.Second, func() bool { return c.Stats().Compiling })

	go func() { _, _ = c.Compile(context.Background(), mod) }()
	waitUntil(t, 2*time.Second, func() bool { return c.Stats().QueueDepth >= 1 })

	_, err := c.Compile(context.Background(), mod)
	if err == nil {
		t.Fatal("队列满应被拒")
	}
	if err.Code != apperr.CodeCompileBusy {
		t.Fatalf("队列满应返回 COMPILE_BUSY(429)，实际 %s", err.Code)
	}
	if err.Status() != 429 {
		t.Errorf("COMPILE_BUSY 的 HTTP 语义应为 429，实际 %d", err.Status())
	}
	if got, ok := err.Details["queue_capacity"]; !ok || got != 1 {
		t.Errorf("details 应带 queue_capacity：%+v", err.Details)
	}
	if len(err.Hints) == 0 {
		t.Error("429 应带可操作 hint（第一消费者是 AI）")
	}
	<-done
}

// childPID 返回当前常驻子进程的 pid（测试断言"真的重启了"用）。
func (c *Compiler) childPID() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.childProc == nil {
		return -1
	}
	return c.childProc.cmd.Process.Pid
}

func TestCompileRejectsRelativePath(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	_, err := c.Compile(context.Background(), "relative/app.wasm")
	if err == nil || err.Code != apperr.CodeValidation {
		t.Fatalf("相对路径应被拒（validation），实际 %v", err)
	}
}

func TestCompileChildRestartsAfterDrop(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	mod := writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base())

	if _, err := c.Compile(context.Background(), mod); err != nil {
		t.Fatal(err)
	}
	firstPid := c.childPID()

	c.DropChild()
	if _, err := c.Compile(context.Background(), mod); err != nil {
		t.Fatalf("丢子进程后应自动重启：%v", err)
	}
	secondPid := c.childPID()
	if firstPid == secondPid {
		t.Fatalf("子进程应被重启（pid 相同：%d）", firstPid)
	}
}

func TestCloseIsIdempotentAndUnblocks(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	mod := writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base())
	if _, err := c.Compile(context.Background(), mod); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close 应幂等: %v", err)
	}
}

func TestStatsReflectQueueAndCache(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) { o.MaxQueue = 7 })
	st := c.Stats()
	if st.QueueCapacity != 7 {
		t.Errorf("QueueCapacity 应反映配置：%d", st.QueueCapacity)
	}
	if st.CacheMaxBytes <= 0 || st.CacheMaxEntries <= 0 {
		t.Errorf("缓存阈值应透出（/readyz 判水位）：%+v", st)
	}
	if st.ChildRunning {
		t.Error("还没编译过，子进程不该在跑")
	}
	if _, err := c.Compile(context.Background(), writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base())); err != nil {
		t.Fatal(err)
	}
	st = c.Stats()
	if !st.ChildRunning {
		t.Error("编译后子进程应常驻")
	}
	if st.Compiles != 1 || st.CacheEntries == 0 {
		t.Errorf("统计不符：%+v", st)
	}
}

// waitUntil 轮询等待条件成立（编译队列是并发的，测试需要"等到真的开始"）。
func waitUntil(t *testing.T, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待条件超时（%v）", within)
}

// TestCompileChildAppliesResourceLimits 验证 §4.3 的"编译进程 CPU/内存配额"**真的设上了**。
//
// 背景（对抗性审查 P1）：`WithMemoryLimitPages` 只管 wasm **实例**内存，管不到编译期
// 宿主内存；此前 compile 侧既无 rlimit 也无 cgroup ⇒ "编译进程超限被杀 ⇒ COMPILE_OOM"
// 这条语义没有进程内落地。现在子进程用 RLIMIT_AS/RLIMIT_CPU 自保，本用例把"配额是
// 多少"变成可断言的输出（否则这条能力只能靠读代码相信）。
//
// 变异方式：把 applyResourceLimits 的调用去掉 ⇒ 输出里的 0 会让本用例红。
func TestCompileChildAppliesResourceLimits(t *testing.T) {
	child := buildCompileChildOnce(t)
	out, err := exec.Command(child, "-print-limits").Output()
	if err != nil {
		t.Fatalf("子进程 -print-limits 失败: %v", err)
	}
	var got struct {
		OK        bool  `json:"ok"`
		RLimitAS  int64 `json:"rlimit_as"`
		RLimitCPU int64 `json:"rlimit_cpu"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("解析子进程输出失败: %v（%s）", err, out)
	}
	if !got.OK {
		t.Fatalf("子进程未报告 ok：%s", out)
	}
	if got.RLimitAS <= 0 {
		t.Errorf("RLIMIT_AS 未设置（%d）⇒ 编译期宿主内存无界", got.RLimitAS)
	}
	if got.RLimitCPU <= 0 {
		t.Errorf("RLIMIT_CPU 未设置（%d）⇒ 编译期 CPU 无界", got.RLimitCPU)
	}
	t.Logf("子进程资源上限：RLIMIT_AS=%s RLIMIT_CPU=%ds", describeInt(got.RLimitAS), got.RLimitCPU)
}

// TestIsolationFromEnv 验证部署面选档开关（P0：让 fail-closed 档不再是死代码）。
func TestIsolationFromEnv(t *testing.T) {
	for _, tc := range []struct {
		val  string
		want IsolationMode
	}{
		{"", IsolationAuto},
		{"auto", IsolationAuto},
		{"REQUIRE", IsolationRequire},
		{" strict ", IsolationRequire},
		{"off", IsolationOff},
		{"none", IsolationOff},
		{"garbage", IsolationAuto}, // 未知值回落而非报错（加固开关写错不该让服务起不来）
	} {
		t.Setenv(IsolationEnvVar, tc.val)
		if got := IsolationFromEnv(); got != tc.want {
			t.Errorf("%s=%q ⇒ %v，期望 %v", IsolationEnvVar, tc.val, got, tc.want)
		}
	}
}

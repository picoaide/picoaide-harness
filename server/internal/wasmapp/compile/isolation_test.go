package compile

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
)

// 本文件覆盖**隔离三模式**的行为（R31 / §15.1 第 14 条）。
//
// 探测函数 detectIsolation 是变量（不是函数调用），因此三种模式的行为可以
// 确定性地测到——不依赖"跑测试的机器上有没有 bwrap"。
//
// 变异方式：
//   - 让 IsolationRequire 在不可用时仍返回 nil ⇒ TestIsolationRequireFailsClosed 红；
//   - 让 IsolationAuto 不可用时不记日志 ⇒ TestIsolationAutoLogsLoudly 红；
//   - 让 IsolationOff 不记日志 ⇒ TestIsolationOffDeclaresItself 红。

func fakeAvailable(bwrap string) func() isolationAvailability {
	return func() isolationAvailability { return isolationAvailability{bwrap: bwrap} }
}

func unavailable(reason string) func() isolationAvailability {
	return func() isolationAvailability { return isolationAvailability{bwrapErr: errors.New(reason)} }
}

func TestIsolationRequireFailsClosedWhenUnavailable(t *testing.T) {
	defer func(f func() isolationAvailability) { detectIsolation = f }(detectIsolation)
	detectIsolation = unavailable("bwrap 不存在")

	log := &recordingLogger{}
	if _, err := planIsolation(IsolationRequire, "/usr/bin/compile", log); err == nil {
		t.Fatal("IsolationRequire 在隔离不可用时必须返回错误（fail-closed）")
	} else if !strings.Contains(err.Error(), "IsolationRequire") {
		t.Errorf("错误文案应点名模式：%v", err)
	}
	// fail-closed 的语义是"不启动"，因此这条路径不应产生"继续运行"的日志。
	if strings.Contains(log.joined(), "未隔离") {
		t.Errorf("Require 模式失败时不应打出'继续运行'的警告：%s", log.joined())
	}
}

func TestIsolationAutoContinuesAndLogsLoudly(t *testing.T) {
	defer func(f func() isolationAvailability) { detectIsolation = f }(detectIsolation)
	detectIsolation = unavailable("unshare 被 seccomp 拒绝")

	log := &recordingLogger{}
	plan, err := planIsolation(IsolationAuto, "/usr/bin/compile", log)
	if err != nil {
		t.Fatalf("Auto 模式不应失败: %v", err)
	}
	if plan.available {
		t.Fatal("不可用时 plan.available 必须是 false（不许假装已隔离）")
	}
	msg := log.joined()
	if !strings.Contains(msg, "⚠️") {
		t.Errorf("必须大声记日志（warn 级）：%q", msg)
	}
	for _, want := range []string{"未隔离", "bwrap", "IsolationRequire", "env 白名单"} {
		if !strings.Contains(msg, want) {
			t.Errorf("日志里应写明 %q（运维要据此决定是否加固）：%s", want, msg)
		}
	}
}

func TestIsolationAutoUsesBwrapWhenAvailable(t *testing.T) {
	defer func(f func() isolationAvailability) { detectIsolation = f }(detectIsolation)
	detectIsolation = fakeAvailable("/usr/bin/bwrap")

	log := &recordingLogger{}
	plan, err := planIsolation(IsolationAuto, "/usr/bin/compile", log)
	if err != nil {
		t.Fatalf("planIsolation: %v", err)
	}
	if !plan.available || plan.backend != "bwrap" {
		t.Fatalf("bwrap 可用时应启用：%+v", plan)
	}
	if plan.dir != "/" {
		t.Errorf("bwrap 下 cwd 应为 /（避免相对路径与宿主 cwd 泄漏）：%q", plan.dir)
	}
	if !strings.Contains(plan.describe(), "已启用") {
		t.Errorf("describe 应报告已启用：%s", plan.describe())
	}
}

func TestIsolationRequireAcceptsAvailableBackend(t *testing.T) {
	defer func(f func() isolationAvailability) { detectIsolation = f }(detectIsolation)
	detectIsolation = fakeAvailable("/usr/bin/bwrap")

	if _, err := planIsolation(IsolationRequire, "/usr/bin/compile", &recordingLogger{}); err != nil {
		t.Fatalf("Require 模式在隔离可用时应成功: %v", err)
	}
}

func TestIsolationOffDeclaresItself(t *testing.T) {
	defer func(f func() isolationAvailability) { detectIsolation = f }(detectIsolation)
	// 即使隔离可用，Off 也必须显式声明（不许"悄悄关掉"）。
	detectIsolation = fakeAvailable("/usr/bin/bwrap")

	log := &recordingLogger{}
	plan, err := planIsolation(IsolationOff, "/usr/bin/compile", log)
	if err != nil {
		t.Fatalf("Off 模式不应失败: %v", err)
	}
	if plan.available {
		t.Fatal("Off 模式不得启用隔离")
	}
	msg := log.joined()
	if !strings.Contains(msg, "显式关闭") || !strings.Contains(msg, "仅") {
		t.Errorf("Off 模式必须在日志里显式声明'仅测试'：%s", msg)
	}
}

func TestIsolationOffDoesNotProbe(t *testing.T) {
	// Off 模式不应调用探测（省一次 exec，也让"测试环境下探测命令不存在"不成为噪音）。
	called := false
	defer func(f func() isolationAvailability) { detectIsolation = f }(detectIsolation)
	detectIsolation = func() isolationAvailability { called = true; return isolationAvailability{} }

	if _, err := planIsolation(IsolationOff, "/usr/bin/compile", &recordingLogger{}); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Error("IsolationOff 不该探测隔离（探测会 exec bwrap，测试环境里没必要）")
	}
}

func TestBwrapArgvShape(t *testing.T) {
	// bwrap 的 argv 是本模块里唯一"安全靠参数正确"的地方：逐条断言。
	dir := t.TempDir()
	cache := filepath.Join(dir, "cache")
	moduleDir := filepath.Join(dir, "mod")
	for _, d := range []string{cache, moduleDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	mod := filepath.Join(moduleDir, "a.wasm")
	if err := os.WriteFile(mod, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	args := []string{"-listen", "-timeout", "60s", "-cache-dir", cache}
	argv, err := bwrapArgv("/usr/bin/bwrap", procModePrivate, append([]string{"/usr/bin/compile"}, args...),
		isolationTargets{CacheDir: cache, ReadOnlyDirs: []string{moduleDir}}, &recordingLogger{})
	if err != nil {
		t.Fatalf("bwrapArgv: %v", err)
	}
	joined := strings.Join(argv, " ")
	for _, want := range []string{
		"--unshare-all",              // 含网络 namespace（红线 4 在编译进程侧的落地）
		"--die-with-parent",          // 父死子死（隔离路径下**这才是**超时不留残余的保证）
		"--new-session",              // 断控制终端
		"--proc /proc",               // 独立 procfs
		"--dev /dev",                 // 最小 /dev
		"--tmpfs /tmp",               // 可写的临时目录（沙箱里 / 是空 tmpfs）
		"--bind " + cache,            // 唯一可写面
		"--ro-bind-try " + moduleDir, // ReadOnlyDirs：模块目录只读
		"--chdir /",                  // 固定 cwd
		"--clearenv",                 // 不继承宿主 env
		"--setenv TMPDIR /tmp",       // 沙箱内临时目录
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("bwrap argv 缺少 %q\n实际：%s", want, joined)
		}
	}
	// **读白名单**：绝不能出现 `--ro-bind / /`（那会让被攻破的编译进程读走
	// <data_root>/master.key 与各应用数据库）。这条断言是本次修复的守卫。
	if strings.Contains(joined, "--ro-bind / /") {
		t.Errorf("出现了 --ro-bind / /（读白名单被破坏：编译进程能读整个宿主文件系统）\n实际：%s", joined)
	}
	// 顺序不变量（bwrap 按参数顺序应用挂载，后者覆盖前者）——两条都是踩过的坑：
	//   ① `--bind <cache>` 必须在所有只读绑定之后（否则缓存被盖成不可写）；
	//   ② `--tmpfs /tmp` 必须在任何"目标落在 /tmp 下"的绑定**之前**
	//     （否则那些绑定被 tmpfs 整个盖掉：本机实测子进程二进制在 /tmp 下时
	//      直接 `execvp: No such file or directory`）。
	assertMountOrder(t, argv, cache, moduleDir)

	if argv[0] != "/usr/bin/bwrap" {
		t.Errorf("argv[0] 应是 bwrap：%q", argv[0])
	}
	if argv[len(argv)-1] != "-listen" && !strings.Contains(joined, "-- /usr/bin/compile") {
		t.Errorf("原命令必须落在 `--` 之后：%s", joined)
	}
}

func TestBwrapArgvRejectsMissingCacheDir(t *testing.T) {
	// 拿不到 cache_dir ⇒ fail-closed（不许"没有可写面就放行整个文件系统"）。
	_, err := bwrapArgv("/usr/bin/bwrap", procModePrivate, []string{"/usr/bin/compile", "-listen"},
		isolationTargets{}, &recordingLogger{})
	if err == nil {
		t.Fatal("缺少 cache_dir 时必须报错（否则隔离放行面无法确定）")
	}
}

func TestBwrapArgvDoesNotLeakParentEnv(t *testing.T) {
	// 即使宿主 env 里有密钥，bwrap argv 里也不得出现它的名字或值。
	t.Setenv("PICOAI_MASTER_KEY", "deadbeef-cafe")
	t.Setenv("PG_DSN", "postgres://secret")

	dir := t.TempDir()
	cache := filepath.Join(dir, "cache")
	if err := os.MkdirAll(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	argv, err := bwrapArgv("/usr/bin/bwrap", procModePrivate, []string{"/usr/bin/compile", "-listen", "-cache-dir", cache},
		isolationTargets{CacheDir: cache}, &recordingLogger{})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(argv, " ")
	if strings.Contains(joined, "PICOAI_MASTER_KEY") || strings.Contains(joined, "deadbeef-cafe") {
		t.Errorf("master key 泄漏进 bwrap argv：%s", joined)
	}
	if strings.Contains(joined, "PG_DSN") || strings.Contains(joined, "postgres://secret") {
		t.Errorf("PG DSN 泄漏进 bwrap argv：%s", joined)
	}
}

func TestIsolationPlanDescribe(t *testing.T) {
	if got := (&isolationPlan{backend: "bwrap", available: true, notes: "x"}).describe(); !strings.Contains(got, "bwrap") || !strings.Contains(got, "已启用") {
		t.Errorf("describe: %s", got)
	}
	if got := (&isolationPlan{backend: "none"}).describe(); !strings.Contains(got, "不可用") {
		t.Errorf("describe: %s", got)
	}
	var nilPlan *isolationPlan
	if got := nilPlan.describe(); !strings.Contains(got, "未初始化") {
		t.Errorf("nil plan describe: %s", got)
	}
}

// TestDetectIsolationOnThisMachine 记录本机探测结果（不断言"必须有 bwrap"：
// CI 容器里通常没有；但断言"要么给出 bwrap，要么给出原因"，不许两者都空）。
func TestDetectIsolationOnThisMachine(t *testing.T) {
	av := detectIsolationImpl()
	if av.bwrap == "" && av.bwrapErr == nil {
		t.Fatal("探测必须给出结论：要么可用路径，要么不可用原因")
	}
	t.Logf("本机隔离探测：bwrap=%q landlock=%v err=%v", av.bwrap, av.landlock, av.bwrapErr)
}

func TestKernelAtLeast(t *testing.T) {
	// 本机内核 6.x ⇒ 对 5.13 为真、对 99.0 为假。
	if !kernelAtLeast(5, 13) {
		t.Error("本机内核应 ≥ 5.13")
	}
	if kernelAtLeast(99, 0) {
		t.Error("kernelAtLeast(99,0) 应为假")
	}
}

func TestIsolationPlanWrapNoopWhenUnavailable(t *testing.T) {
	p := &isolationPlan{backend: "none", available: false}
	argv, dir, err := p.wrap("/bin/x", []string{"-listen"}, isolationTargets{})
	if err != nil {
		t.Fatal(err)
	}
	if dir != "" || len(argv) != 2 || argv[0] != "/bin/x" {
		t.Fatalf("不可用时 wrap 应原样返回：%v %q", argv, dir)
	}
}

func TestExitSignalOfNonSignaled(t *testing.T) {
	// 正常退出（无信号）⇒ 空串。
	if got := exitSignalOf(nil); got != "" {
		t.Errorf("nil ExitError 应返回空串：%q", got)
	}
}

func TestDefaultIdleTimeoutIsBounded(t *testing.T) {
	// 空闲退出时间必须存在且不能太大（它决定"编译进程保留的编译内存"能挂多久）。
	if DefaultIdleTimeout <= 0 || DefaultIdleTimeout > 30*time.Minute {
		t.Fatalf("DefaultIdleTimeout 取值不合理：%v", DefaultIdleTimeout)
	}
}

// TestCompileUnderBwrapIsolation 是隔离的**端到端验收**：真的在 bwrap 里编译一个模块。
//
// 为什么必须有这条：TestBwrapArgvShape 只证明 argv 的"形状"对，不证明它**能跑起来**
// （参数多一个 --ro-bind、少一个 --dev 都会让子进程起不来，而那正是最容易被后续改动
// 破坏的地方）。本用例覆盖"策略 → argv → 真实进程 → 成功编译"的整条链。
//
// 隔离不可用的环境（多数 CI 容器）会 Skip —— 但 Skip 是**显式记录**的：
// 交付说明里会写明本机（可用 bwrap）是真跑过的。
func TestCompileUnderBwrapIsolation(t *testing.T) {
	if detectIsolationImpl().bwrap == "" {
		t.Skip("本机无可用 bwrap ⇒ 隔离端到端用例跳过（argv 形状仍由 TestBwrapArgvShape 覆盖）")
	}
	child := buildCompileChildOnce(t)
	// 注意：这里**不**传 ChildArgs（生产路径不注入任何参数）。
	c := newTestCompiler(t, child, func(o *Options) {
		o.Isolation = IsolationAuto
		o.ChildArgs = nil
	})
	if plan := c.IsolationPlan(); !strings.Contains(plan, "已启用") || !strings.Contains(plan, "bwrap") {
		t.Fatalf("本机 bwrap 可用，隔离应已启用：%s", plan)
	} else {
		t.Logf("隔离方案：%s", plan)
	}

	mod := writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base())
	res, err := c.Compile(context.Background(), mod)
	if err != nil {
		t.Fatalf("bwrap 隔离下编译失败（argv 可能被改坏）：%v details=%+v hints=%v", err, err.Details, err.Hints)
	}
	if res == nil || len(res.Exports) == 0 {
		t.Fatalf("隔离下编译应返回完整结果：%+v", res)
	}
	// 缓存条目必须真的写到宿主缓存目录（证明可写面绑定生效）。
	if _, entries, _ := c.cacheUsage(); entries == 0 {
		t.Error("bwrap 下编译应把缓存条目写进绑定目录")
	}
}

// TestBwrapBlocksWriteOutsideCacheDir 验证隔离的**实际效果**（而不只是"启动了"）。
//
// 判据：在 bwrap 里跑一个 shell（本机有 /bin/sh），尝试写宿主上的任意路径，
// 必须失败；写缓存目录必须成功。这条把"只读根 + 唯一可写面"从声明变成实测。
func TestBwrapBlocksWriteOutsideCacheDir(t *testing.T) {
	if detectIsolationImpl().bwrap == "" {
		t.Skip("本机无可用 bwrap")
	}
	dir := t.TempDir()
	cache := filepath.Join(dir, "cache")
	outside := filepath.Join(dir, "outside")
	for _, d := range []string{cache, outside} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// 显式拼一份等价 argv（bwrapArgv 的 cache_dir 是从 -request 里解析的，
	// 本用例要单独验证"绑定生效"，所以直接构造）。
	argv := []string{
		"/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session",
		"--ro-bind", "/", "/", "--dev", "/dev", "--ro-bind-try", "/proc", "/proc",
		"--bind", cache, cache, "--chdir", "/",
		"--", "/bin/sh", "-c", "echo ok > " + filepath.Join(cache, "written"),
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("在 bwrap 里写缓存目录应成功：%v（%s）", err, out)
	}
	if _, err := os.Stat(filepath.Join(cache, "written")); err != nil {
		t.Errorf("缓存目录的写入应落到宿主：%v", err)
	}

	// 反向：写宿主上**未绑定**的目录必须失败（只读根）。
	argv[0] = "/usr/bin/bwrap"
	argv[len(argv)-1] = "echo x > " + filepath.Join(outside, "pwned")
	cmd = exec.Command(argv[0], argv[1:]...)
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Errorf("写未绑定目录**必须失败**（只读根），实际成功：%s", out)
	}
	if _, err := os.Stat(filepath.Join(outside, "pwned")); err == nil {
		t.Error("宿主上的文件被隔离进程创建了 ⇒ 只读根失效")
	}

	// 网络隔离（§3.3 红线 4 在编译进程侧的同族要求）：--unshare-all 含 --unshare-net。
	//
	// ⚠️ 判据必须是**网络 namespace 本身**，不能用 `ls /sys/class/net`：
	// 我们 `--ro-bind / /` 把宿主 sysfs 只读带进来了，它反映的是宿主网卡
	//（第一次写这条用例时正是这样误判成"隔离失效"）。正确判据 = 比较 netns inode，
	// 并用 netns 相对的 /proc/net/dev 看接口列表。
	hostNetns, err := os.Readlink("/proc/self/ns/net")
	if err != nil {
		t.Skipf("无法读取宿主 netns（跳过网络隔离断言）：%v", err)
	}
	netArgv := []string{
		"/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session",
		"--ro-bind", "/", "/", "--dev", "/dev", "--ro-bind-try", "/proc", "/proc", "--chdir", "/",
		"--", "/bin/sh", "-c", "readlink /proc/self/ns/net; echo ---; cat /proc/net/dev",
	}
	ncmd := exec.Command(netArgv[0], netArgv[1:]...)
	ncmd.Dir = "/"
	ncmd.Env = []string{"PATH=/usr/bin:/bin"}
	out, nerr := ncmd.CombinedOutput()
	if nerr != nil {
		t.Fatalf("网络隔离探测命令失败：%v（%s）", nerr, out)
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "---", 2)
	gotNetns := strings.TrimSpace(parts[0])
	if gotNetns == hostNetns {
		t.Errorf("隔离进程与宿主共用同一 netns（%s）⇒ --unshare-net 未生效", gotNetns)
	}
	if len(parts) == 2 {
		// /proc/net/dev 的前两行是表头；接口行形如 "  lo: 1234 ..."。
		var ifaces []string
		for _, line := range strings.Split(parts[1], "\n") {
			i := strings.IndexByte(line, ':')
			if i > 0 && strings.Contains(line, "|") == false && strings.Contains(line[:i], "face") == false {
				ifaces = append(ifaces, strings.TrimSpace(line[:i]))
			}
		}
		for _, i := range ifaces {
			if i != "lo" {
				t.Errorf("隔离 netns 里出现了非 lo 接口 %q ⇒ 未真正断网：%v", i, ifaces)
			}
		}
		if len(ifaces) == 0 {
			t.Errorf("隔离 netns 里读不到任何接口（探测姿势有问题，不是隔离失败）：%q", parts[1])
		}
		t.Logf("网络隔离实测：netns %s → %s，接口=%v", hostNetns, gotNetns, ifaces)
	}
}

// assertMountOrder 断言 bwrap argv 的挂载顺序不变量（见 TestBwrapArgvShape 的注释）。
//
// bwrap 按参数顺序应用挂载、**后者覆盖前者**，因此顺序错了不会报错、只会静默失效：
//   - `--bind <cache>` 排在只读绑定之前 ⇒ 缓存目录被盖成不可写；
//   - `--tmpfs /tmp` 排在"目标在 /tmp 下"的绑定之后 ⇒ 那些绑定被整个盖掉
//     （本机实测：子进程二进制在 /tmp 下时 `execvp: No such file or directory`）。
func assertMountOrder(t *testing.T, argv []string, cache, moduleDir string) {
	t.Helper()
	idxCacheBind, idxTmpfs, idxLastRO := -1, -1, -1
	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "--tmpfs":
			if i+1 < len(argv) && argv[i+1] == "/tmp" {
				idxTmpfs = i
			}
		case "--bind":
			if i+1 < len(argv) && argv[i+1] == cache {
				idxCacheBind = i
			}
		case "--ro-bind-try":
			idxLastRO = i
			if i+1 < len(argv) && strings.HasPrefix(argv[i+1], "/tmp/") && idxTmpfs > i {
				t.Errorf("`--ro-bind-try %s`（idx=%d）排在 `--tmpfs /tmp`（idx=%d）之前："+
					"该绑定会被 tmpfs 整个盖掉\n实际：%s",
					argv[i+1], i, idxTmpfs, strings.Join(argv, " "))
			}
		}
	}
	if idxCacheBind < 0 {
		t.Error("argv 里找不到 `--bind <cache>`（唯一可写面缺失）")
	}
	if idxLastRO > idxCacheBind && idxCacheBind >= 0 {
		t.Errorf("`--bind <cache>`（idx=%d）排在只读绑定（idx=%d）之前 ⇒ 缓存会被盖成不可写",
			idxCacheBind, idxLastRO)
	}
	if idxTmpfs < 0 {
		t.Error("缺少 `--tmpfs /tmp`（沙箱内 /tmp 会落到只读根上）")
	}
	_ = moduleDir
}

// TestBwrapArgvMountOrder 用"目标落在 /tmp 下"的路径验证顺序不变量。
//
// 本机 t.TempDir() 就在 /tmp 下，因此这条用例天然覆盖了踩过的那个场景。
func TestBwrapArgvMountOrder(t *testing.T) {
	base := t.TempDir()
	cache := filepath.Join(base, "cache")
	moduleDir := filepath.Join(base, "mod")
	for _, d := range []string{cache, moduleDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	argv, err := bwrapArgv("/usr/bin/bwrap", procModeHostRO,
		[]string{"/usr/bin/compile", "-listen", "-cache-dir", cache},
		isolationTargets{CacheDir: cache, ReadOnlyDirs: []string{moduleDir}}, &recordingLogger{})
	if err != nil {
		t.Fatal(err)
	}
	idx := func(flag, val string) int {
		for i := 0; i+1 < len(argv); i++ {
			if argv[i] == flag && argv[i+1] == val {
				return i
			}
		}
		return -1
	}
	idxTmpfs := idx("--tmpfs", "/tmp")
	idxRO := idx("--ro-bind-try", moduleDir)
	idxBind := idx("--bind", cache)
	if idxTmpfs < 0 || idxRO < 0 || idxBind < 0 {
		t.Fatalf("argv 缺少预期项（tmpfs=%d ro=%d bind=%d）：%v", idxTmpfs, idxRO, idxBind, argv)
	}
	if idxRO < idxTmpfs {
		t.Errorf("模块目录只读绑定（idx=%d）必须在 --tmpfs /tmp（idx=%d）之后", idxRO, idxTmpfs)
	}
	if idxBind < idxTmpfs {
		t.Errorf("缓存目录绑定（idx=%d）必须在 --tmpfs /tmp（idx=%d）之后", idxBind, idxTmpfs)
	}
}

// TestCompileTimeoutUnderBwrapLeavesNoResidue 锁住"隔离路径下超时不留残余进程"。
//
// 为什么必须单独测（P1，来自对抗性审查）：`--new-session` 会让**被包装的 payload
// 进入新的 session/pgid**，因此 `kill(-pgid)` 只打得到 bwrap、打不到真正的编译进程；
// 真正保证不留残余的是 `--die-with-parent`（内核语义）。套件里此前的超时用例一律
// `IsolationOff`，所以这条路径**从来没有被测过** —— 有人删掉 `--die-with-parent`
// 也不会有任何红灯，而后果是"超时后留一个孤儿继续写缓存"。
//
// 判据：用唯一的 marker 参数启动假子进程（长睡），触发超时后扫描 /proc/*/cmdline，
// 断言带该 marker 的进程一个都不剩。
func TestCompileTimeoutUnderBwrapLeavesNoResidue(t *testing.T) {
	if detectIsolationImpl().bwrap == "" {
		t.Skip("本机无可用 bwrap ⇒ 隔离超时残留用例跳过（隔离外路径由 TestCompileTimeoutKillsChild 覆盖）")
	}
	helper := compileHelperChild(t)
	// marker 保证只匹配本用例启动的进程（不误伤同机其他 bwrap）。
	marker := "picoaide-residue-probe-" + itoa(os.Getpid()) + "-" + time.Now().Format("150405.000000")
	c := newTestCompiler(t, helper, func(o *Options) {
		o.Isolation = IsolationAuto
		o.Timeout = 400 * time.Millisecond
		o.ChildArgs = []string{"-sleep", "30s", "-marker", marker}
	})
	if plan := c.IsolationPlan(); !strings.Contains(plan, "已启用") {
		t.Fatalf("本用例要求真的启用隔离：%s", plan)
	}
	mod := writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base())
	if _, err := c.Compile(context.Background(), mod); err == nil || err.Code != apperr.CodeCompileTimeout {
		t.Fatalf("应超时（COMPILE_TIMEOUT），实际 %v", err)
	}
	// 超时返回后，宿主上不得再有任何带 marker 的进程（bwrap 或 payload）。
	deadline := time.Now().Add(5 * time.Second)
	for {
		n := countProcessesWithMarker(t, marker)
		if n == 0 {
			t.Logf("隔离超时后无残余进程（marker=%s）", marker)
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("超时后仍有 %d 个带 marker 的进程存活（--die-with-parent 失效？）", n)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// countProcessesWithMarker 统计 cmdline 里含 marker 的进程数（读 /proc，无需 root）。
func countProcessesWithMarker(t *testing.T, marker string) int {
	t.Helper()
	dirs, err := os.ReadDir("/proc")
	if err != nil {
		t.Skipf("无法读 /proc（跳过残留检查）：%v", err)
	}
	n := 0
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		if _, err := itoaStrict(d.Name()); err != nil {
			continue // 非 pid 目录
		}
		b, err := os.ReadFile(filepath.Join("/proc", d.Name(), "cmdline"))
		if err != nil {
			continue
		}
		if strings.Contains(string(b), marker) {
			n++
		}
	}
	return n
}

func itoaStrict(s string) (int, error) {
	if s == "" {
		return 0, os.ErrInvalid
	}
	v := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, os.ErrInvalid
		}
		v = v*10 + int(r-'0')
	}
	return v, nil
}

// TestBwrapCannotReadOutsideWhitelist 是 P0 修复的**直接判据**：
// 隔离进程不得读到数据根下的机密（master key）与宿主家目录。
//
// 背景（对抗性审查发现）：此前的 argv 用 `--ro-bind / /`（**整个宿主文件系统只读可见**），
// 而编译进程与 server 同 uid ⇒ 它可以直接读走 `<data_root>/master.key`（0600 但同 uid）、
// 各应用 SQLite 库、部署 `.env`。env 白名单只堵住了"读环境变量"这一条通道。
// 现在改成读白名单（bwrapReadOnlySystemDirs），沙箱内 / 是空 tmpfs。
//
// 判据用"真的存在且真的不该被读到的文件"：临时目录里造一个 0600 的假 master key，
// 它**不在**任何白名单目录里 ⇒ 沙箱内 cat 必须失败。
func TestBwrapCannotReadOutsideWhitelist(t *testing.T) {
	if detectIsolationImpl().bwrap == "" {
		t.Skip("本机无可用 bwrap")
	}
	dir := t.TempDir()
	secretDir := filepath.Join(dir, "data")
	cacheDir := filepath.Join(dir, "cache")
	binDir := filepath.Join(dir, "bin")
	for _, d := range []string{secretDir, cacheDir, binDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	secret := filepath.Join(secretDir, "master.key")
	if err := os.WriteFile(secret, []byte("SUPER-SECRET-MASTER-KEY"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 用 production 形态的 argv：只白名单系统目录 + 二进制目录，**不含** secretDir。
	argv, err := bwrapArgv("/usr/bin/bwrap", procModeHostRO,
		[]string{"/bin/sh", "-c", "cat " + secret + " 2>&1; echo rc=$?"},
		isolationTargets{CacheDir: cacheDir, ReadOnlyDirs: []string{binDir}}, &recordingLogger{})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	out, _ := cmd.CombinedOutput()
	if strings.Contains(string(out), "SUPER-SECRET-MASTER-KEY") {
		t.Fatalf("隔离进程读到了白名单外的机密文件（读白名单失效）：%s", out)
	}
	t.Logf("读白名单实测：沙箱内读取数据根机密被拒 → %q", strings.TrimSpace(string(out)))

	// 反向对照：把该目录加进只读白名单后**可以**读到（证明上面的拒绝来自白名单，
	// 而不是"命令根本没跑起来"这种恒真结果）。
	argv2, err := bwrapArgv("/usr/bin/bwrap", procModeHostRO,
		[]string{"/bin/sh", "-c", "cat " + secret},
		isolationTargets{CacheDir: cacheDir, ReadOnlyDirs: []string{binDir, secretDir}}, &recordingLogger{})
	if err != nil {
		t.Fatal(err)
	}
	cmd2 := exec.Command(argv2[0], argv2[1:]...)
	cmd2.Dir = "/"
	cmd2.Env = []string{"PATH=/usr/bin:/bin"}
	out2, err2 := cmd2.CombinedOutput()
	if err2 != nil || !strings.Contains(string(out2), "SUPER-SECRET-MASTER-KEY") {
		t.Fatalf("把目录加入白名单后应能读到（说明上一条的拒绝确实来自白名单）：err=%v out=%s", err2, out2)
	}
}

// TestBwrapTmpIsWritable 验证 `--tmpfs /tmp` 真的给了可写临时目录
// （此前 TMPDIR=/tmp 指向只读根 —— 实测 `touch /tmp/x` 报 Read-only file system）。
func TestBwrapTmpIsWritable(t *testing.T) {
	if detectIsolationImpl().bwrap == "" {
		t.Skip("本机无可用 bwrap")
	}
	dir := t.TempDir()
	cache := filepath.Join(dir, "cache")
	if err := os.MkdirAll(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	argv, err := bwrapArgv("/usr/bin/bwrap", procModeHostRO,
		[]string{"/bin/sh", "-c", "touch /tmp/probe && echo TMP_OK"},
		isolationTargets{CacheDir: cache}, &recordingLogger{})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	out, cerr := cmd.CombinedOutput()
	if cerr != nil || !strings.Contains(string(out), "TMP_OK") {
		t.Fatalf("沙箱内 /tmp 应可写（--tmpfs /tmp）：err=%v out=%s", cerr, out)
	}
	// 沙箱内的 /tmp 是私有的：写进去的东西不得出现在宿主 /tmp。
	if _, serr := os.Stat("/tmp/probe"); serr == nil {
		t.Error("沙箱内的 /tmp 写入泄漏到了宿主 /tmp（不是私有 tmpfs）")
	}
}

//go:build linux

package compile

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// 本文件是 Linux 上的编译进程 OS 级隔离（R31 / §15.1 第 14 条）。
//
// 设计取舍（按优先级）：
//  1. **bwrap（bubblewrap）**：它同时给出"独立 mount/pid/ipc/uts/user namespace"
//     + "新会话" + "网络 namespace" + "只读根" 四件事，是 Linux 上最省的完整解。
//     `--unshare-all` 已经包含 `--unshare-net`（网络 namespace）⇒ §3.3 红线 4
//     "应用不能出站"在**编译进程**这一侧也顺带成立（编译期不需要网络）。
//  2. **landlock**：没有 bwrap 时至少确认内核支持 landlock（LSM），
//     在日志里如实声明"只有 landlock 可用、未启用文件系统限制"——**不假装已隔离**。
//  3. 都没有 ⇒ 由 IsolationMode 决定 fail-closed 还是大声记日志后继续。
//
// 为什么探测不能只看"二进制在不在"：容器里 bwrap 常存在但 `unshare(CLONE_NEWUSER)`
// 被 seccomp/启动参数禁掉（Docker 默认就禁 user namespace 的某些形态）。只看 PATH
// 会给出"已隔离"的假象——而这是安全声明，不能是假象。

// bwrapReadOnlySystemDirs 是沙箱内**只读**放行的系统目录白名单。
//
// ⚠️ 这是本模块最重要的一条安全口径：**不做 `--ro-bind / /`**。
// 理由（§15.1 第 14 条 + 红线 1/3）：编译进程读的是攻击者提交的字节，必须假设它
// **可能被攻破**；而它与 server 同 uid（部署形态下 entrypoint `su-exec` 到同一个
// 用户），`--ro-bind / /` 会让它直接读走
// `<data_root>/master.key`（0600 但同 uid）、`<data_root>/apps/**/app.db`
// （各应用的数据库）、部署 `.env`（PG DSN）。
// env 白名单只堵住了"读环境变量"这一条通道，**堵不住文件通道**。
//
// 因此这里只放行"跑一个静态链接的 Go 二进制"真正需要的东西：动态库/时区/系统配置。
// wazero 是纯 Go 实现，编译期不需要额外系统文件；`/etc` 用于 TZ 与本地化。
var bwrapReadOnlySystemDirs = []string{
	"/usr", "/lib", "/lib64", "/lib32", "/libx32", "/bin", "/sbin", "/etc",
}

// detectIsolation 探测本机可用的隔离层。
//
// 可注入（变量而非函数）：测试要覆盖"隔离可用/不可用"两种行为，
// 而真实探测结果取决于跑测试的机器（CI 容器里通常没有 bwrap）。
// 注入点做成变量是为了让三种 IsolationMode 的行为都能被确定性地测到。
var detectIsolation = detectIsolationImpl

// isolationProbeRunner 执行探测命令（可注入，便于测试模拟 bwrap 存在但不可用）。
var isolationProbeRunner = func(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	// 探测不该继承环境（PATH 除外，LookPath 已经解析过绝对路径）。
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	return cmd.Run()
}

func detectIsolationImpl() isolationAvailability {
	av := isolationAvailability{}
	// ---- bwrap ----
	//
	// 探测姿势与真实用法一致：真的建命名空间并跑一个进程（只看二进制在不在会给出
	// "已隔离"的假象——容器里 bwrap 常存在但 unshare/mount 被禁）。
	//
	// 两级探测的理由：`--proc /proc` 要挂一个**新的** procfs，在嵌套容器里常被
	// "Operation not permitted" 拒掉（本机实测就是这种），而 `--ro-bind / /` 本来
	// 就已经把宿主 /proc 以只读方式带进来了。因此退一步用 `--ro-bind /proc /proc`
	// 仍能得到"只读根 + 断网 + 独立命名空间"的隔离，只是少了"看不见别的进程"这层。
	// 有 private procfs 时优先用它（更强），否则用只读绑定（仍远好于不隔离）。
	if path, err := exec.LookPath("bwrap"); err == nil {
		if err := isolationProbeRunner(path, bwrapProbeArgs(path, procModePrivate)...); err == nil {
			av.bwrap = path
			av.bwrapProcMode = procModePrivate
		} else if perr := isolationProbeRunner(path, bwrapProbeArgs(path, procModeHostRO)...); perr == nil {
			av.bwrap = path
			av.bwrapProcMode = procModeHostRO
			av.bwrapErr = fmt.Errorf("private procfs 不可用（%v），已回落到只读绑定宿主 /proc", err)
		} else {
			av.bwrapErr = err
		}
	} else {
		av.bwrapErr = err
	}
	// ---- landlock（仅探测；未启用则如实说明）----
	av.landlock = landlockAvailable()
	return av
}

// procMode 决定 bwrap 内 /proc 的形态。
type procMode int

const (
	// procModePrivate 挂一个独立的 procfs（更强：看不到宿主进程）。
	procModePrivate procMode = iota
	// procModeHostRO 只读绑定宿主 /proc（嵌套容器里挂 procfs 被禁时的退路；
	// 因为我们已经 `--ro-bind / /`，宿主 /proc 本来就在，不会因此放宽写面）。
	procModeHostRO
)

// bwrapProbeArgs 构造探测用的 argv（与真实 argv 的前缀保持一致）。
func bwrapProbeArgs(bwrap string, mode procMode) []string {
	args := []string{
		"--unshare-all", "--die-with-parent", "--new-session",
		"--ro-bind", "/", "/", "--dev", "/dev",
	}
	args = append(args, procArgs(mode)...)
	return append(args, "--", "/bin/true")
}

// procArgs 返回 /proc 相关的 bwrap 参数。
func procArgs(mode procMode) []string {
	if mode == procModeHostRO {
		return []string{"--ro-bind-try", "/proc", "/proc"}
	}
	return []string{"--proc", "/proc"}
}

// isolationAvailability 是探测结果。
type isolationAvailability struct {
	// bwrap 是可用 bwrap 的绝对路径（空 = 不可用）。
	bwrap string
	// bwrapProcMode 是探测通过时采用的 /proc 形态（决定真实 argv 用哪一组参数）。
	bwrapProcMode procMode
	// bwrapErr 是"存在但不可用"的原因（诊断用；回落成功时记录回落原因）。
	bwrapErr error
	// landlock 表示内核支持 landlock LSM（仅检测，不作为主后端）。
	landlock bool
}

// landlockAvailable 检测内核 landlock 支持（不改任何状态）。
//
// 判据（两个都要满足）：
//   - 内核版本 ≥ 5.13（landlock 首次进入 mainline）；
//   - landlock 的 syscall 存在（用 ABI 版本查询返回非 ENOSYS 判定）。
//
// 之所以不直接用它做后端：Go 侧没有 x/sys/unix 的 landlock 封装（本仓也未引入），
// 自己写 `landlock_create_ruleset` + `landlock_add_rule` 序列属于**新的安全关键
// 代码**——在没有真实逃逸测试的情况下引入它是净风险。这里只做检测与声明，
// 真正落地前需要专门的逃逸测试（§11 第 8 项）。
func landlockAvailable() bool {
	// 版本门槛：landlock 在 5.13 引入，6.2 起有 ABI v4。
	if !kernelAtLeast(5, 13) {
		return false
	}
	// 内核里 landlock 的 LSM 目录只在 securityfs 挂载且 LSM 启用时可见。
	// 某些发行版 securityfs 未挂载 ⇒ 该判据会低估，所以再看 syscall。
	if _, err := os.Stat("/sys/kernel/security/landlock"); err == nil {
		return true
	}
	// 兜底：LANDLOCK_CREATE_RULESET_VERSION 查询（syscall 161 on amd64/arm64）。
	// 返回 -1 且 errno=ENOSYS/EOPNOTSUPP 表示内核不支持。
	return landlockSyscallSupported()
}

// landlockSyscallSupported 用 landlock_create_ruleset(NULL, 0, VERSION) 判定支持。
func landlockSyscallSupported() bool {
	_, _, errno := syscall.Syscall(landlockCreateRulesetSyscall, 0, 0, uintptr(1 /* LANDLOCK_CREATE_RULESET_VERSION */))
	// 返回 0 表示成功（ABI 版本为 0 不会发生，但成功即支持）；
	// EOPNOTSUPP/ENOSYS 表示不支持；其他 errno（如 EFAULT）说明 syscall 存在。
	switch errno {
	case 0, syscall.EFAULT, syscall.EINVAL:
		return true
	default:
		return false
	}
}

// landlockCreateRulesetSyscall 是 landlock_create_ruleset 的 syscall 号。
//
// amd64 与 arm64 在 Linux 上同为 444（generic syscall table），
// 与 x/sys/unix 的 SYS_LANDLOCK_CREATE_RULESET 一致。
const landlockCreateRulesetSyscall = 444

// planIsolation 依据模式与探测结果给出隔离方案。
//
// 三种模式的行为（用户要求逐条可测）：
//   - IsolationRequire：隔离不可用 ⇒ 返回错误（fail-closed，生产部署用）；
//   - IsolationAuto（默认）：可用则启用；不可用则**大声记日志**（warn）并继续；
//   - IsolationOff：仅测试用，且**必须在日志里显式声明**。
func planIsolation(mode IsolationMode, child string, logger Logger) (*isolationPlan, error) {
	if mode == IsolationOff {
		logger.Printf("compile: ⚠️ 编译进程 OS 级隔离已**显式关闭**（IsolationOff）——仅允许在测试环境使用；"+
			"生产部署必须使用 IsolationAuto 或 IsolationRequire（子进程=%s）", child)
		return &isolationPlan{backend: "off", available: false, notes: "显式关闭（仅测试）"}, nil
	}

	av := detectIsolation()
	if av.bwrap != "" {
		notes := fmt.Sprintf("bwrap=%s（--unshare-all 含网络 namespace；/proc=%s）",
			av.bwrap, procModeName(av.bwrapProcMode))
		if av.bwrapErr != nil {
			// 回落信息必须进日志/诊断：它说明"隔离比最强的形态弱在哪一层"。
			notes += "；" + av.bwrapErr.Error()
		}
		return &isolationPlan{
			backend:   "bwrap",
			available: true,
			dir:       "/",
			notes:     notes,
			wrapArgv: func(argv []string, tgt isolationTargets) ([]string, error) {
				return bwrapArgv(av.bwrap, av.bwrapProcMode, argv, tgt, logger)
			},
		}, nil
	}

	reason := "本机未找到 bwrap"
	if av.bwrapErr != nil {
		reason = fmt.Sprintf("bwrap 不可用（%v）", av.bwrapErr)
	}
	landlockNote := "landlock 不可用"
	if av.landlock {
		landlockNote = "landlock 可用但未启用（本仓无经过逃逸测试的 landlock 后端）"
	}
	msg := fmt.Sprintf("compile: ⚠️ 编译进程未隔离（%s；%s）。编译进程是唯一读不可信字节的进程（§15.1 第 14 条）："+
		"它仍受 env 白名单与\"只读两个路径\"的约束，但没有 OS 级边界。请在部署镜像中提供 bwrap（bubblewrap），"+
		"或显式设置 IsolationRequire 让启动 fail-closed。", reason, landlockNote)

	if mode == IsolationRequire {
		return nil, fmt.Errorf("compile: IsolationRequire 但隔离不可用：%s；%s", reason, landlockNote)
	}
	// IsolationAuto：大声记日志（warn）后继续。
	logger.Printf("%s", msg)
	backend := "none"
	if av.landlock {
		backend = "landlock-detect-only"
	}
	return &isolationPlan{backend: backend, available: false, notes: reason + "；" + landlockNote}, nil
}

// bwrapArgv 构造 bwrap 的完整 argv。
//
// 参数逐条理由（少一条都会破坏"可用"或"安全"之一）：
//
//	--unshare-all      独立 mount/pid/ipc/uts/user/cgroup/net namespace；
//	                   ⚠️ 其中 --unshare-net 使编译进程**没有任何网络**（顺带满足红线 4）
//	--die-with-parent  父进程死了就一起死（防孤儿编译进程常驻）
//	--new-session      新会话：断掉控制终端（防 TIOCSTI 类注入）
//	--ro-bind / /      只读根：编译进程能看到宿主的文件系统布局，但一个字节都改不了
//	--ro-bind-try /etc 时区/本地化（缺了不影响编译，所以用 try）
//	--dev /dev         最小 /dev（bwrap 自带 tmpfs，只有 null/zero/random 等）
//	--proc /proc       独立 procfs（Go 运行时会读 /proc/self 等）
//	--bind <cache>     唯一的**宿主**可写面：缓存目录（§4.3.1-d）
//	--tmpfs /tmp       沙箱内私有可写面（宿主不可见；审计 P2-11 澄清）
//	--ro-bind <moddir> 模块所在目录只读（模块本身必须是只读的输入）
//	--chdir /          工作目录固定为 /（相对路径不成立 ⇒ "只读两个路径"可验证）
//	--clearenv + --setenv：env 白名单通过 bwrap 显式注入（**不**继承宿主 env）
//
// 返回的 argv 里 `/bin/true` 之类的位置由原 argv 填充（即真正的编译子进程）。
func bwrapArgv(bwrap string, mode procMode, argv []string, tgt isolationTargets, logger Logger) ([]string, error) {
	if len(argv) == 0 {
		return nil, fmt.Errorf("compile: bwrap 包装缺少命令")
	}
	// cache_dir 必填且必须是绝对路径：它是唯一的**宿主**可写面，拿不到就没法构造隔离
	//（放行整个文件系统比不隔离更糟，所以这里 fail-closed）。
	if tgt.CacheDir == "" {
		return nil, fmt.Errorf("compile: bwrap 包装缺少 cache_dir（唯一可写面无法确定）")
	}
	if !filepath.IsAbs(tgt.CacheDir) {
		return nil, fmt.Errorf("compile: cache_dir 必须是绝对路径（%q）", tgt.CacheDir)
	}
	for _, d := range tgt.ReadOnlyDirs {
		if !filepath.IsAbs(d) {
			return nil, fmt.Errorf("compile: 只读放行目录必须是绝对路径（%q）", d)
		}
	}

	out := []string{
		bwrap,
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
	}
	// ---- 挂载顺序（bwrap 按参数顺序应用，**后者覆盖前者**）----
	//
	// ⚠️ 这里有一条踩过的硬约束：`--tmpfs /tmp` 会把之前挂在 /tmp 下的任何东西
	// **整个盖掉**。本机实测：子进程二进制在被测环境里位于 /tmp/... 时，
	// 先绑二进制目录再挂 `--tmpfs /tmp` ⇒ `execvp: No such file or directory`。
	// 因此顺序固定为：
	//   1) 系统只读白名单
	//   2) /dev 与 /proc
	//   3) `--tmpfs /tmp`（必须在任何 /tmp 下的绑定**之前**）
	//   4) 只读业务目录（模块目录 / 二进制目录 / 声明目录）
	//   5) 唯一宿主可写面（缓存目录，最后 ⇒ 不会被覆盖；沙箱私有 /tmp tmpfs 另算）
	// 这条顺序有 TestBwrapArgvMountOrder 守着。

	// 1) 只读白名单（**不是** `--ro-bind / /`，见 bwrapReadOnlySystemDirs 的注释）：
	//    沙箱内的 / 是 bwrap 新建的空 tmpfs，宿主文件系统整体不可见。
	for _, d := range bwrapReadOnlySystemDirs {
		out = append(out, "--ro-bind-try", d, d)
	}
	// 2) /dev 与 /proc
	out = append(out, "--dev", "/dev")
	out = append(out, procArgs(mode)...)
	// 3) /tmp 必须是可写的 tmpfs：沙箱里没有它时子进程的临时文件会写到只读根上
	//    （实测 `touch /tmp/x` → Read-only file system；wazero 目前把缓存临时文件
	//    建在分片目录内所以尚未暴露，但那是依赖上游实现细节）。
	//    ⚠️ 如实注明：它同时也是一块**沙箱内私有可写面**（宿主字节不可见，见
	//    isolation_test.go 的"未绑定宿主路径写入成功但宿主字节未变"用例）。
	out = append(out, "--tmpfs", "/tmp")
	// 4) 只读业务目录（模块字节与要 exec 的二进制都必须可见）。
	for _, d := range tgt.ReadOnlyDirs {
		out = append(out, "--ro-bind-try", d, d)
	}
	// 5) 唯一宿主可写面 + cwd。
	out = append(out, "--bind", tgt.CacheDir, tgt.CacheDir, "--chdir", "/")

	// env 白名单：--clearenv 之后逐项 --setenv。只传调用方给的允许项，
	// 不凭空造值（子进程的行为差异不该由平台臆造的默认值决定）。
	//
	// env 由**调用方**传入（Compiler 的白名单结果）而不是这里读 os.Environ()：
	// 两条路径（直接 exec / bwrap 包装）必须用同一份来源，否则 Options.Env 注入时
	// 会出现"隔离关了用一套 env、隔离开了用另一套"的保真差异。
	out = append(out, "--clearenv")
	for _, kv := range tgt.Env {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			continue
		}
		out = append(out, "--setenv", kv[:eq], kv[eq+1:])
	}
	// TMPDIR 指向上面那个 `--tmpfs /tmp`（可写、且是沙箱内私有的）。
	out = append(out, "--setenv", "TMPDIR", "/tmp")

	out = append(out, "--")
	out = append(out, argv...)
	if logger != nil {
		// 只记关键项（不打印完整 argv：模块路径是用户输入，日志里没必要留全路径）。
		// 措辞口径（审计 P2-11）：沙箱内另有**私有** `/tmp` tmpfs 可写（宿主看不到、
		// 随命名空间释放），所以"可写面只有缓存目录"指的是**宿主**可写面。
		logger.Printf("compile: 已启用 bwrap 隔离（unshare-all 含网络隔离；/proc=%s；宿主可写面只有 %s；沙箱内另有私有 /tmp tmpfs）",
			procModeName(mode), tgt.CacheDir)
	}
	return out, nil
}

// procModeName 返回 /proc 形态的可读名（日志与诊断用）。
func procModeName(mode procMode) string {
	if mode == procModeHostRO {
		return "ro-bind-host"
	}
	return "private"
}

// ===== 进程组与信号（Linux）=====

// setProcessGroup 让子进程成为独立进程组组长。
//
// ⚠️ 实测修正（2026-09-18，别被"进程组"这个名字误导）：
// bwrap 的 `--new-session` 会让**被包装的 payload 进入新的 session/pgid**
// （实测 payload pgrp=10 vs bwrap pgrp=8），因此 `kill(-pgid)` 只打得到 bwrap
// **打不到真正的编译进程**。真正保证"超时后不留残余"的是 `--die-with-parent`
// （父死子死，内核保证）；本函数的进程组杀只在**非隔离**路径上直接生效。
// 这条差异有专门的用例守着（TestCompileTimeoutUnderBwrapLeavesNoResidue），
// 因为它正是"以为杀干净了、其实留了个孤儿在写缓存"的典型来源。
func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// killProcessGroup 杀掉整个进程组（SIGKILL；先 TERM 没必要——编译进程没有需要
// 优雅收尾的状态，而"多等 3 秒"会让超时的语义变模糊）。
//
// 隔离路径下这只杀得到 bwrap，payload 由 `--die-with-parent` 收（见 setProcessGroup
// 的注释）；因此**不要删 `--die-with-parent`**，那条参数是超时语义的一部分。
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		return
	}
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}

// exitSignalOf 返回退出信号名（无信号返回空串）。
func exitSignalOf(ee *exec.ExitError) string {
	if ee == nil {
		return ""
	}
	if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return ws.Signal().String()
	}
	return ""
}

// kernelAtLeast 判断内核版本是否 ≥ major.minor（解析 /proc/sys/kernel/osrelease）。
func kernelAtLeast(major, minor int) bool {
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return false
	}
	var ma, mi int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(b)), "%d.%d", &ma, &mi); err != nil {
		return false
	}
	if ma != major {
		return ma > major
	}
	return mi >= minor
}

// 保持 log 包被使用（Logger 缺省实现来自 stdlib；这里显式声明默认值来源）。
var _ Logger = log.Default()

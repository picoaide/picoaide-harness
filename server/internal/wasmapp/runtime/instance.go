package runtime

import (
	"crypto/rand"
	"io"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
)

// InstanceLimits 是**一次请求**的上限集合（§4.3 / §4.6）。
//
// 零值可用：所有缺省都回落到 limits 包（数值唯一真源），调用方只覆盖它关心的一项。
type InstanceLimits struct {
	// MemoryPages 是单实例线性内存页上限；0 ⇒ limits.InstanceMemoryPages（64 MiB）。
	//
	// ⚠️ 语义边界（wazero 的 API 事实）：`WithMemoryLimitPages` 是 **RuntimeConfig**
	// 上的项，不是 ModuleConfig ⇒ **无法逐请求改变**（§4.3.1-c 的逐请求清单里也只有
	// 随机源/时钟/stdio/args/env）。因此这里填的是"本次请求期望的上限"，必须与
	// 构造 Runtime 时用的 Options.MemoryPages 一致；不一致时 Serve 直接报错
	// （fail-loud：绝不假装限制了内存，也绝不静默用另一个值）。
	MemoryPages uint32
	// GuestBudget 是 guest 执行预算（进入宿主调用时暂停计时）；0 ⇒ limits.GuestBudget（10 s）。
	GuestBudget time.Duration
	// HostBudgets 是「方法名 → 宿主调用预算」；缺省 limits.HostCallBudgetDefault。
	// 非正值视为"未设置"，回落到缺省（防一次笔误把预算设成 0 导致所有宿主调用立刻超时）。
	HostBudgets map[string]time.Duration
}

// DefaultInstanceLimits 返回全缺省的请求上限。
func DefaultInstanceLimits() InstanceLimits { return InstanceLimits{} }

// MemoryLimitPages 返回生效的内存页上限。
func (l InstanceLimits) MemoryLimitPages() uint32 {
	if l.MemoryPages == 0 {
		return limits.InstanceMemoryPages
	}
	return l.MemoryPages
}

// EffectiveGuestBudget 返回生效的 guest 预算。
func (l InstanceLimits) EffectiveGuestBudget() time.Duration {
	if l.GuestBudget <= 0 {
		return limits.GuestBudget
	}
	return l.GuestBudget
}

// HostBudget 返回某个宿主方法的生效预算。
//
// 顺序：显式配置（>0）→ 通用缺省（§4.4/§4.6）。
//
// ⚠️ W4：原"`ai.chat` 专属缺省 = limits.HostAIChatBudget（30 s）"这一支已随
// 服务端 ai.chat 删除（总纲 §21.3）—— 其余宿主调用（db.* / log / assets.read）
// 都走通用缺省，没有例外项。
func (l InstanceLimits) HostBudget(method string) time.Duration {
	if d, ok := l.HostBudgets[method]; ok && d > 0 {
		return d
	}
	return limits.HostCallBudgetDefault
}

// newModuleConfig 为**一次实例化**构造全新的 ModuleConfig（§4.3.1-c）。
//
// 铁律：同一个 ModuleConfig **不得跨请求复用** —— 它承载的是"本次请求的 stdio 缓冲、
// 随机源、时钟"这些请求级状态；复用等于把上一请求的 stdout 缓冲/环境带进下一请求。
// 因此本函数没有对应的"复用一个 config"的 API，调用点只有 Serve 内部一处。
//
// 逐项对应设计文档（§4.3 / §15.1 第 1 条），默认值全部是危险值：
//
//	WithRandSource(rand.Reader)  默认 = 固定种子 42 的确定性伪随机（跨独立实例完全一致）
//	WithSysWalltime/Nanotime     默认 = 2022-01-01 假时钟
//	WithNanosleep(真实实现)      默认 = 立即返回（假睡眠）
//	WithStdin/Stdout/Stderr      必须指向本次请求的缓冲；stdout/stderr **绝不落宿主 stdout**
//	不传 args / 不传 env         args_get / environ_get 读到空（§10.2 第 23 项）
//	零 preopen                   **不调用任何 WithFS* / WithDirMount / WithFSMount**
//	WithStartFunctions()（空）   _start 由本包显式调用，见 Serve 的注释
func newModuleConfig(name string, stdin io.Reader, stdout, stderr io.Writer) wazero.ModuleConfig {
	return wazero.NewModuleConfig().
		WithName(name).
		// §7.1 实测：wazero 的 fd_read 对 io.Pipe 是**阻塞读**，但"无数据时立即 EAGAIN"
		// 的语义不确定性仍在（Go/Node 的 wasip1 运行时都做过非阻塞假设）⇒ 我们只用
		// io.Pipe 且**单写者 + 结束即 Close**，不依赖任何阻塞/非阻塞细节。
		WithStdin(stdin).
		WithStdout(stdout).
		WithStderr(stderr).
		// §4.3 ⚠️ 默认是 platform.NewFakeRandSource() = rand.New(rand.NewSource(42))：
		// 固定种子 42 的确定性伪随机，跨独立实例完全一致（比"全零"更隐蔽）。
		WithRandSource(rand.Reader).
		// §4.3 ⚠️ 默认不是 time.Now（config.go:582）：实测 guest 读到 2022-01-01。
		WithSysWalltime().
		WithSysNanotime().
		// §4.3 ⚠️ 默认是假睡眠（立即返回）⇒ guest 的 sleep/poll 会被压成忙等。
		WithNanosleep(sysNanosleep).
		// 不自动跑 _start：本包要拿到 module 句柄才能采样内存峰值（§4.9 PeakMemory），
		// 并区分「proc_exit 正常退出」与「被 ctx 关闭」；显式调用等价于默认行为
		// （wazero 默认 startFunctions = ["_start"]），见 Serve。
		WithStartFunctions()
}

// sysNanosleep 是 WithNanosleep 需要的形状（sys.Nanosleep = func(ns int64)），
// 语义就是 time.Sleep（§4.3「真实实现」）。
//
// ⚠️ 为什么这一项必须有**CPU 时间**判据的用例（而不是"耗时断言"）：
// Go 在 wasip1 上的等待是**忙等循环**（`runtime/lock_wasip1.go`：*"Waiting for a mutex or
// timeout is implemented as a busy loop"*）——`time.Sleep` 会反复 `usleep` → `poll_oneoff`。
// 于是把本函数换成空实现（假睡眠）时，**墙钟几乎不变**（实测：`time.Sleep(300ms)` 仍是 ~305ms），
// 唯一变的是**进程 CPU 时间**（5ms → ~300ms）。任何"耗时断言"都测不出这个变异；
// 判据必须是 `Getrusage` 的 CPU 时间增量 << 墙钟（见 serve_test.go 的
// TestServe_NanosleepDoesNotBurnCPU）。
func sysNanosleep(ns int64) {
	if ns <= 0 {
		return
	}
	time.Sleep(time.Duration(ns))
}

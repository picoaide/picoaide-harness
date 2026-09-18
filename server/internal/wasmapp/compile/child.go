package compile

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// childProcess 是常驻编译子进程的父侧句柄（单进程串行 ⇒ 一个句柄串行使用）。
//
// 为什么常驻：每次 Compile 都 fork/exec 会让子进程的 wazero Runtime 状态全部重建，
// 磁盘缓存命中路径要多付一次"重新 mmap + 校验条目"的钱。常驻 + 空闲退出
// （limits 里的 IdleTimeout）是"复用"与"不长期占内存"之间的折中。
type childProcess struct {
	cmd *exec.Cmd
	// stdin/stdout 是父侧持有的管道端。
	//
	// ⚠️ 必须保存并在收尾时**关闭**：exec.Cmd.Wait() 会等"所有 I/O 管道归位"，
	// 而父侧持有的管道不关，子进程退出后 stdout 也不会 EOF ⇒ Wait() 永不返回
	//（表现为"kill 之后 5 秒超时"）。见 killLocked 的注释。
	stdin  io.WriteCloser
	stdout io.ReadCloser
	// reader 是 stdout 上的缓冲读（读一行应答）。
	reader *bufio.Reader
	stderr *ringBuffer
	// exitCh 在进程退出后收到信号（用于超时/异常退出的归类）。
	exitCh  chan struct{}
	exitErr error

	// boundDirs 是这个子进程启动时被**只读**绑进沙箱的目录（隔离关闭时为空）。
	//
	// 它的作用：模块换目录 ⇒ 沙箱里看不见 ⇒ 必须重启子进程（见 ensureChild 的
	// coversDir 分支）。隔离关闭时 coversDir 恒为 true（没有绑定面这回事）。
	boundDirs []string
	// mu 保护 lastUsed（以及身份字段）；**不**保护 exitErr/exitCh，
	// 后两者由 close(exitCh) 建立 happens-before（见 startChild 的 goroutine 注释）。
	mu       sync.Mutex
	lastUsed time.Time
	plan     *isolationPlan
	// killed 让 kill 幂等（管道已关、进程已杀之后再 kill 不应重复动作）。
	killed bool
}

// startChild 启动一个常驻子进程。
//
// 隔离（R31）：如果隔离方案可用，argv 会被包装（bwrap 等）；env 是**白名单**结果
// （调用方已经过滤，这里不做二次过滤——过滤只有一份，在 CompileProcessEnv）。
func startChild(bin string, args []string, env []string, plan *isolationPlan, tgt isolationTargets) (*childProcess, error) {
	argv, dir, err := plan.wrap(bin, args, tgt)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = env
	setProcessGroup(cmd)

	// 用 cmd.StdinPipe/StdoutPipe（它们返回 io.WriteCloser/io.ReadCloser）：
	// 收尾时**关掉两端**是让 exec.Cmd.Wait() 返回的关键 —— Wait 会等 I/O 管道归位，
	// 父侧持有的管道不关，子进程退出后也不会 EOF ⇒ Wait 永不返回
	//（表现就是"kill 之后 5 秒超时"，这是真踩过的坑）。
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("compile: 建立 stdin 管道失败: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("compile: 建立 stdout 管道失败: %w", err)
	}
	// stderr 只用于诊断（有界环形缓冲，绝不继承宿主 stdout/stderr：
	// 子进程的输出不能直接污染宿主日志，§4.3「stdout/stderr 捕获」）。
	rb := newRingBuffer(limits.StderrTailBytes)
	cmd.Stderr = rb

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("compile: 启动编译子进程失败: %w", err)
	}
	p := &childProcess{
		cmd:       cmd,
		stdin:     stdin,
		stdout:    stdout,
		reader:    bufio.NewReaderSize(stdout, 64<<10),
		stderr:    rb,
		exitCh:    make(chan struct{}),
		lastUsed:  time.Now(),
		plan:      plan,
		boundDirs: boundDirsOf(plan, tgt),
	}
	// ⚠️ 这个 goroutine **不得**再取 p.mu：killLocked() 持有 p.mu 并等 exitCh 关闭，
	// 而它若为了发布退出结果去抢同一把锁，就构成"持有锁等对方、对方等锁"的死锁
	//（症状：kill 每次都卡满 5 s 超时才返回，还被误报成"清理失败"——真踩过）。
	// 正确做法是用 channel close 建立 happens-before：先写 exitErr，再 close(exitCh)；
	// 读者只在 `<-exitCh` 之后读 exitErr（见 alive/exitStatus 的用法）。
	go func() {
		p.exitErr = cmd.Wait()
		close(p.exitCh)
	}()
	return p, nil
}

// coversDir 报告该子进程能否读到 dir 下的文件（隔离关闭时恒为 true）。
func (p *childProcess) coversDir(dir string) bool {
	if p.plan == nil || !p.plan.available {
		return true // 没隔离 ⇒ 宿主文件系统整体可见
	}
	return dirCovered(p.boundDirs, dir)
}

// boundDirsOf 返回隔离启动器实际只读绑定的目录（未隔离时为空）。
func boundDirsOf(plan *isolationPlan, tgt isolationTargets) []string {
	if plan == nil || !plan.available {
		return nil
	}
	return append([]string{}, tgt.ReadOnlyDirs...)
}

// alive 报告子进程是否还活着（不阻塞）。
func (p *childProcess) alive() bool {
	select {
	case <-p.exitCh:
		return false
	default:
		return true
	}
}

// idleFor 返回距离上次使用的时间（空闲退出的判据）。
func (p *childProcess) idleFor() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	return time.Since(p.lastUsed)
}

// exitStatus 返回退出码与信号（诊断/COMPILE_OOM 的 details）。
func (p *childProcess) exitStatus() (code int, signal string, ok bool) {
	if p.alive() {
		return 0, "", false
	}
	if p.exitErr == nil {
		return 0, "", true
	}
	var ee *exec.ExitError
	if errors.As(p.exitErr, &ee) {
		return ee.ExitCode(), exitSignal(ee), true
	}
	return -1, "", true
}

// stderrTail 返回子进程 stderr 的尾巴（诊断用；上限 limits.StderrTailBytes）。
func (p *childProcess) stderrTail() string { return p.stderr.String() }

// request 发一行请求、读一行应答（**串行**：调用方持有编译 worker 的单线程语义）。
//
// 超时语义（§4.3 / §10.3）：
//   - 到点 ⇒ **杀子进程**并返回 COMPILE_TIMEOUT(504)；
//   - 下一次请求会重启子进程（ensureChild 看到已死即重启）。
//
// 为什么必须杀而不是"放弃等待"：编译是 CPU 密集的，放弃等待只会让一个疯跑的
// 编译继续吃 CPU，并把"下一个请求"拖进同一个进程的饥饿里。
func (p *childProcess) request(req Request, timeout time.Duration) (Response, *apperr.Error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.alive() {
		return Response{}, p.exitError()
	}
	line, err := encodeLine(req)
	if err != nil {
		return Response{}, apperr.From(err)
	}
	deadline := time.Now().Add(timeout)
	// 写路径不做 deadline（保存的是 io.WriteCloser，没有 deadline 语义）：
	// 请求只有一行几百字节，远小于管道缓冲区；真正的兜底是下面的读超时 + 杀进程。
	if _, err := p.stdin.Write(append(line, '\n')); err != nil {
		// 写失败通常意味着子进程已死（EPIPE）。
		if !p.alive() {
			return Response{}, p.exitError()
		}
		return Response{}, apperr.New(apperr.CodeInternal, "向编译子进程写请求失败").WithCause(err)
	}

	type readResult struct {
		line []byte
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		l, err := p.reader.ReadBytes('\n')
		ch <- readResult{line: l, err: err}
	}()

	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case r := <-ch:
		p.lastUsed = time.Now()
		if r.err != nil {
			// EOF 与"exitCh 关闭"之间存在极短竞态：子进程已经死了，但 Wait 的
			// goroutine 还没跑到 close(exitCh)。直接判 alive() 会把"被杀/OOM"
			// 误报成 INTERNAL（真踩过）。因此先给退出信号一点落地时间，
			// 再按退出状态归类（这正是 COMPILE_OOM 的语义）。
			if p.waitExited(exitSettleGrace) {
				return Response{}, p.exitError()
			}
			return Response{}, apperr.New(apperr.CodeInternal, "读取编译子进程应答失败").WithCause(r.err)
		}
		var resp Response
		if err := json.Unmarshal(r.line, &resp); err != nil {
			// 应答不是 JSON：协议被破坏（子进程内部错误/被替换）。
			// 不重试、不猜测，直接归为内部错误并把 stderr 尾巴带上。
			return Response{}, apperr.New(apperr.CodeInternal, "编译子进程应答非法（不是 JSON）").
				WithCause(err).
				WithDetail("stderr_tail", p.stderrTail())
		}
		if !resp.OK {
			e := apperr.New(protocolErrorCode(resp.Code), resp.Message)
			for k, v := range resp.Details {
				e = e.WithDetail(k, v)
			}
			return Response{}, e
		}
		return resp, nil
	case <-timer.C:
		// 超时：杀进程，并把"这一轮已经不可能有结果"这件事固定下来。
		if err := p.killLocked(); err != nil {
			return Response{}, apperr.New(apperr.CodeCompileTimeout, "编译超时（且子进程清理失败）").
				WithDetail("timeout_ms", timeout.Milliseconds()).
				WithCause(err)
		}
		return Response{}, apperr.New(apperr.CodeCompileTimeout, "编译超时，已终止编译进程").
			WithDetail("timeout_ms", timeout.Milliseconds()).
			WithDetail("stderr_tail", p.stderrTail()).
			WithHint("模块过大或编译期常量折叠过重时会超时；请减少依赖或拆分应用")
	case <-p.exitCh:
		// 进程在等待应答时死了（OOM / 被外部杀掉）：归 COMPILE_OOM(500)，
		// details 带 exit code/signal（§4.3：编译进程超限被杀）。
		return Response{}, p.exitError()
	}
}

// exitSettleGrace 是"读到 EOF 后等退出信号落地"的宽限。
//
// 取值理由：Wait 的 goroutine 与读管道是两件事，EOF 往往先到几微秒；
// 500 ms 足够覆盖调度抖动，又远小于任何超时预算（不会掩盖真正的挂起）。
const exitSettleGrace = 500 * time.Millisecond

// waitExited 等待退出信号落地（最多 grace），返回是否已退出。
func (p *childProcess) waitExited(grace time.Duration) bool {
	if !p.alive() {
		return true
	}
	t := time.NewTimer(grace)
	defer t.Stop()
	select {
	case <-p.exitCh:
		return true
	case <-t.C:
		return false
	}
}

// exitError 把"子进程非正常退出"映射成 COMPILE_OOM（§7.4：500，details 带 exit code）。
//
// 为什么归 OOM 而不是 INTERNAL：设计文档把"编译进程异常退出（被杀/OOM）"明确划到
// COMPILE_OOM；内核 OOM killer、cgroup 限额、CPU 配额超限的失败形态都是"进程没了"，
// 区分它们需要 cgroup 视角（部署面的事），运行期无法可靠分辨。
func (p *childProcess) exitError() *apperr.Error {
	if p.alive() {
		return apperr.New(apperr.CodeInternal, "编译子进程状态异常")
	}
	code, sig, _ := p.exitStatus()
	e := apperr.New(apperr.CodeCompileOOM, "编译进程异常退出（可能被内存/CPU 限额杀掉）").
		WithDetail("exit_code", code).
		WithDetail("stderr_tail", p.stderrTail())
	if sig != "" {
		e = e.WithDetail("signal", sig)
	}
	return e.WithHint("请减小模块体积或降低编译期计算量；平台侧请检查编译进程的内存/CPU 限额")
}

// kill 终止子进程（SIGKILL 整个进程组；bwrap 包装时 group 内还有子进程）。
func (p *childProcess) kill() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.killLocked()
}

func (p *childProcess) killLocked() error {
	// 已经杀过（句柄被复用）⇒ 幂等返回。
	if p.killed {
		return nil
	}
	p.killed = true

	// 1) 先关掉父侧管道：exec.Cmd.Wait() 会等所有 I/O 管道归位。stdout 读端
	//    不关 ⇒ 子进程退出后也不 EOF ⇒ 卡在读上的 goroutine 不返回、
	//    I/O 拷贝不结束 ⇒ Wait() 永不返回（表现为"kill 之后 5 秒超时"）。
	_ = p.stdin.Close()
	_ = p.stdout.Close()

	if !p.alive() {
		return nil
	}
	// 2) 杀整个进程组（bwrap 包装时组内还有真正的编译进程）。
	killProcessGroup(p.cmd)
	select {
	case <-p.exitCh:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("编译子进程在 5 s 内未退出")
	}
}

// exitSignal 提取 exec.ExitError 的信号名（无信号返回空串）。
//
// 覆盖 Windows 的带外字段（waitstatus 在不同平台语义不同），实现放在
// platform 文件里（process_linux.go / process_other.go）。
func exitSignal(ee *exec.ExitError) string { return exitSignalOf(ee) }

// ===== stderr 有界环形缓冲 =====

// ringBuffer 是只保留最后 N 字节的 writer（并发安全）。
//
// 为什么需要：子进程 stderr 可能很长（Go 运行时崩溃栈），全量保留会让
// "编译失败"变成内存问题；而诊断只需要尾巴（§4.9/§7.4 的 StderrTailBytes）。
type ringBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func newRingBuffer(max int) *ringBuffer {
	if max <= 0 {
		max = limits.StderrTailBytes
	}
	return &ringBuffer{max: max}
}

func (r *ringBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.max {
		r.buf = append(r.buf[:0], r.buf[len(r.buf)-r.max:]...)
	}
	return len(p), nil
}

func (r *ringBuffer) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.buf)
}

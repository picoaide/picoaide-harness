//go:build !linux

package compile

import (
	"fmt"
	"os/exec"
)

// 非 Linux 平台的隔离实现（macOS / Windows / *BSD）。
//
// 本文件的存在是为了让"隔离不可用"成为**平台事实**而不是运行时惊喜：
// macOS 的 sandbox-exec 已废弃、Windows 没有等价的 bwrap，平台没有实现这两者时
// 必须如实返回"不支持"，由 IsolationMode 决定 fail-closed 还是大声记日志。

// detectIsolation 在非 Linux 平台恒为"不可用"。
//
// 可注入（与 Linux 侧同名同签名）：测试通过替换它覆盖三种模式的行为。
var detectIsolation = func() isolationAvailability {
	return isolationAvailability{bwrapErr: fmt.Errorf("本平台未提供编译进程隔离后端（仅 Linux 支持 bwrap）")}
}

// planIsolation 与 Linux 侧同语义（见 isolate_linux.go 的注释）。
func planIsolation(mode IsolationMode, child string, logger Logger) (*isolationPlan, error) {
	if mode == IsolationOff {
		logger.Printf("compile: ⚠️ 编译进程 OS 级隔离已**显式关闭**（IsolationOff）——仅允许在测试环境使用（子进程=%s）", child)
		return &isolationPlan{backend: "off", available: false, notes: "显式关闭（仅测试）"}, nil
	}
	reason := "本平台不支持编译进程隔离（仅 Linux 提供 bwrap 后端）"
	msg := fmt.Sprintf("compile: ⚠️ 编译进程未隔离：%s。编译进程是唯一读不可信字节的进程（§15.1 第 14 条）："+
		"它仍受 env 白名单与\"只读两个路径\"的约束，但没有 OS 级边界。", reason)
	if mode == IsolationRequire {
		return nil, fmt.Errorf("compile: IsolationRequire 但隔离不可用：%s", reason)
	}
	logger.Printf("%s", msg)
	return &isolationPlan{backend: "none", available: false, notes: reason}, nil
}

// ===== 进程组与信号（非 Linux 兜底）=====

// setProcessGroup 在非 Linux 平台不做额外设置（没有等价的进程组语义保证）。
func setProcessGroup(cmd *exec.Cmd) {}

// killProcessGroup 在非 Linux 平台只杀直接子进程。
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

// exitSignalOf 在非 Linux 平台无信号语义（返回空串）。
func exitSignalOf(ee *exec.ExitError) string { return "" }

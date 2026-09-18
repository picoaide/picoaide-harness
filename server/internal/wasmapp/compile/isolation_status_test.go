package compile

import (
	"os"
	"path/filepath"
	"testing"
)

// 审计修复回归（P2-1 / P2-2 的判据面）：
// `IsolationStatus` 提供**结构化**的隔离状态，让"require 档必须 fail-closed"
// 这类启动判据不必依赖 IsolationPlan() 的描述文案。
//
// 变异验证：
//   - 让 IsolationStatus 恒返回 usable=true ⇒ TestIsolationStatusIsStructured 必红；
//   - 让它返回的 mode 不是构造时的档位 ⇒ 同上（mode 断言）。
func TestIsolationStatusIsStructured(t *testing.T) {
	defer func(f func() isolationAvailability) { detectIsolation = f }(detectIsolation)
	child := fakeChildBinary(t)

	// 1) 隔离可用 + require ⇒ usable=true（判据来自 plan.available，不是文案）。
	detectIsolation = fakeAvailable("/usr/bin/bwrap")
	c := newIsolationCompiler(t, child, IsolationRequire)
	mode, usable, detail := c.IsolationStatus()
	if mode != IsolationRequire {
		t.Fatalf("mode=%v want require（必须回报**构造时**的档位）", mode)
	}
	if !usable {
		t.Fatalf("bwrap 可用时 usable 必须为 true：%s", detail)
	}
	if detail == "" {
		t.Fatal("detail 必须可读（启动日志/诊断要用）")
	}

	// 2) auto + 隔离不可用 ⇒ 构造成功但 usable=false（调用方据此决定降级）。
	detectIsolation = unavailable("bwrap 不存在")
	c2 := newIsolationCompiler(t, child, IsolationAuto)
	mode, usable, detail = c2.IsolationStatus()
	if mode != IsolationAuto || usable {
		t.Fatalf("auto+不可用：mode=%v usable=%v，want auto/false（%s）", mode, usable, detail)
	}

	// 3) off ⇒ usable=false（显式关隔离 ≠ 隔离生效），但 mode 如实回报 off。
	detectIsolation = fakeAvailable("/usr/bin/bwrap")
	c3 := newIsolationCompiler(t, child, IsolationOff)
	mode, usable, _ = c3.IsolationStatus()
	if mode != IsolationOff || usable {
		t.Fatalf("off 档：mode=%v usable=%v，want off/false", mode, usable)
	}

	// 4) nil 接收者安全（装配失败路径上会被调用）。
	var nilC *Compiler
	if _, usable, detail := nilC.IsolationStatus(); usable || detail == "" {
		t.Fatalf("nil 编译器：usable=%v detail=%q", usable, detail)
	}
}

// newIsolationCompiler 用真实的（但从不执行的）子进程文件构造编译器：
// New 会校验可执行位，但子进程是**惰性启动**的，因此一个可执行的假文件足够。
func newIsolationCompiler(t *testing.T, child string, mode IsolationMode) *Compiler {
	t.Helper()
	c, err := New(Options{
		DataRoot:    t.TempDir(),
		Isolation:   mode,
		ChildBinary: child,
		Logger:      &recordingLogger{},
	})
	if err != nil {
		t.Fatalf("New(%v): %v", mode, err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// fakeChildBinary 造一个"存在且可执行"的假编译子进程（不会被真的执行）。
func fakeChildBinary(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), ChildBinaryName)
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

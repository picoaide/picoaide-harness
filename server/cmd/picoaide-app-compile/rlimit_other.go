//go:build !linux

package main

// rlimitKind 是本文件内部用的 rlimit 选择子（非 Linux 平台无对应实现）。
type rlimitKind int

const (
	rlimitAS rlimitKind = iota
	rlimitCPU
)

// setRLimit 在非 Linux 平台不做任何事（rlimit 语义不通用）。
//
// 这不构成安全缺口：真正的主闸门是**父侧**的超时 + SIGKILL（跨平台一致），
// rlimit 只是编译进程的进程内纵深。
func setRLimit(kind rlimitKind, value int64) { _ = kind; _ = value }

// currentRLimit 在非 Linux 平台返回 -1（无对应语义）。
func currentRLimit(kind rlimitKind) int64 { _ = kind; return -1 }

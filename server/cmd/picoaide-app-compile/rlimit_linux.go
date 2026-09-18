//go:build linux

package main

import (
	"fmt"
	"os"
	"syscall"
)

// rlimitKind 是本文件内部用的 rlimit 选择子（避免在跨平台文件里引入 syscall 常量）。
type rlimitKind int

const (
	rlimitAS rlimitKind = iota
	rlimitCPU
)

// setRLimit 设置一条 rlimit（best-effort；失败只记 stderr）。
func setRLimit(kind rlimitKind, value int64) {
	if value <= 0 {
		return
	}
	var res int
	switch kind {
	case rlimitAS:
		res = syscall.RLIMIT_AS
	case rlimitCPU:
		res = syscall.RLIMIT_CPU
	default:
		return
	}
	lim := syscall.Rlimit{Cur: uint64(value), Max: uint64(value)}
	// 先只降 Cur（软限），失败再尝试同时设 Max（硬限）——某些环境不允许提升硬限。
	if err := syscall.Setrlimit(res, &lim); err != nil {
		lim.Max = ^uint64(0)
		if err2 := syscall.Setrlimit(res, &lim); err2 != nil {
			fmt.Fprintf(os.Stderr, "picoaide-app-compile: 设置 rlimit %d=%d 失败（继续，靠父侧超时兜底）: %v\n",
				res, value, err)
		}
	}
}

// currentRLimit 返回当前生效的 rlimit 软限（门禁用）。
func currentRLimit(kind rlimitKind) int64 {
	var res int
	switch kind {
	case rlimitAS:
		res = syscall.RLIMIT_AS
	case rlimitCPU:
		res = syscall.RLIMIT_CPU
	default:
		return -1
	}
	var lim syscall.Rlimit
	if err := syscall.Getrlimit(res, &lim); err != nil {
		return -1
	}
	return int64(lim.Cur)
}

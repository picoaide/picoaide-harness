//go:build unix

package runtime

import (
	"syscall"
	"time"
)

// processCPUTime 返回本进程累计的 CPU 时间（用户 + 系统）；ok=false 表示本平台读不到。
//
// 为什么必须用"本进程 CPU 时间"：判据要测的是 **WithNanosleep 是真实实现还是空实现**。
// Go 在 wasip1 上的等待是**忙等循环**（`runtime/lock_wasip1.go`），假睡眠下墙钟几乎不变、
// 只有 CPU 时间会爆掉（实测：300ms 睡眠从 5ms → ~300ms）。见 nanosleep_test.go。
func processCPUTime() (time.Duration, bool) {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0, false
	}
	sec := time.Duration(ru.Utime.Sec+ru.Stime.Sec) * time.Second
	usec := time.Duration(ru.Utime.Usec+ru.Stime.Usec) * time.Microsecond
	return sec + usec, true
}

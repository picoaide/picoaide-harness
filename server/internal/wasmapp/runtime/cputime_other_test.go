//go:build !unix

package runtime

import "time"

// processCPUTime 在非 unix 平台没有等价的 getrusage ⇒ 报"读不到"，
// 由 nanosleep_test.go 明确 skip（不是静默假绿）。
func processCPUTime() (time.Duration, bool) { return 0, false }

// Command spinapp 是"死循环、永不返回"的应用（§10.3 第 24 项 RUNTIME_TIMEOUT）。
//
// 宿主必须在 guest 预算（limits.GuestBudget，10 s）到点时关闭实例并按
// RUNTIME_TIMEOUT(504) 返回 —— 关键是**真的返回**：看门狗必须解开管道阻塞，
// 否则请求会永远挂住（runtime 包的 watchdog 就是为此存在的）。
//
// 它连请求帧都不读：这是最坏形态之一（宿主写帧的 goroutine 也会一起被解开）。
package main

// sink 防止空循环被优化掉（Go 的 wasip1 后端不会删掉无限循环，但显式写出来
// 让"这是一个刻意的死循环"这件事对读者与编译器都清楚）。
var sink uint64

func main() {
	for {
		sink++
	}
}

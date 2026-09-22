package main

// 装配级判据（审计 M8）：网关文件回收器必须真的在**启动路径**上被调用。
//
// 背景：`llmgateway.StartFileReaper` 有实现、有用例、有回收语义，但生产侧唯一
// 调用点只是 main() 里的一行。删掉那一行 → 回收器永不运行 → 上游共享配额被
// 已过期文件吃光，而**所有门禁依旧全绿**（没有任何断言观察装配）。
//
// 两条判据互补，缺一不可：
//   - 执行级（TestGatewayFileReaperWiring）：把 `startFileReaper` 换成桩，
//     断言调用发生、参数为 (启动期 ctx, 同一个 db, llmgateway.FileReaperInterval)；
//     删掉 startGatewayFileReaper 体内的调用即红。
//   - 源码级（TestStartupCallsGatewayFileReaper）：断言 main() 里存在
//     `startGatewayFileReaper(ctx, db, llmgateway.FileReaperInterval)`，且它排在
//     `ctx, stop := signal.NotifyContext(...)` 之后、位于 main() 函数体内 ——
//     ctx 未定义就调用会编译失败，但"整行删掉""挪进某个不执行的分支"不会。
//     （与 routes_source_test.go 的入口漂移守卫同一手法：装配的漂移只能靠读
//     装配源码来发现。）

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway"
)

// TestGatewayFileReaperWiring：装配接缝必须把启动期 ctx、同一个 db、间隔常量
// 原样交给回收器。
//
// 为什么不用真库：回收器在这里被桩替换，断言的是**装配参数**；用真库只会让
// 用例依赖 PG 而判据不变。db 用 sql.Open（不拨号）拿到一个非 nil 句柄，
// 从而能验证"传的不是 nil"——StartFileReaper 对 nil db 是静默 return 的，
// 传 nil = 回收器永不运行且零报错。
func TestGatewayFileReaperWiring(t *testing.T) {
	type call struct {
		ctx      context.Context
		db       *sql.DB
		interval time.Duration
	}
	got := make(chan call, 1)
	prev := startFileReaper
	t.Cleanup(func() { startFileReaper = prev })
	startFileReaper = func(ctx context.Context, db *sql.DB, interval time.Duration) {
		got <- call{ctx, db, interval}
	}

	db, err := sql.Open("pgx", "postgres://user:pass@127.0.0.1:1/never-connected")
	if err != nil {
		t.Fatalf("open placeholder db: %v", err)
	}
	defer db.Close()

	// 带哨兵值的 signal 风格 ctx：既校验身份（同一个 ctx），也校验"传的是启动期
	// 那个 ctx"而不是 context.Background()。
	type ctxKey struct{}
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), ctxKey{}, "startup"))
	defer cancel()

	startGatewayFileReaper(parent, db, llmgateway.FileReaperInterval)

	select {
	case c := <-got:
		if c.ctx != parent {
			t.Fatalf("回收器拿到的不是启动期 ctx（哨兵 = %v）", c.ctx.Value(ctxKey{}))
		}
		if c.ctx.Value(ctxKey{}) != "startup" {
			t.Fatalf("ctx 被换掉了: 哨兵 = %v", c.ctx.Value(ctxKey{}))
		}
		if c.db != db {
			t.Fatalf("回收器拿到的不是启动路径的 db 句柄（%p ≠ %p）", c.db, db)
		}
		if c.db == nil {
			t.Fatal("db 为 nil：StartFileReaper 对 nil 是静默 return，回收器会永不运行")
		}
		if c.interval != llmgateway.FileReaperInterval {
			t.Fatalf("间隔 = %v, want %v", c.interval, llmgateway.FileReaperInterval)
		}
		if c.interval <= 0 {
			t.Fatalf("间隔必须为正: %v", c.interval)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("startGatewayFileReaper 没有调用回收器（装配接缝断了）")
	}
}

// TestStartupCallsGatewayFileReaper：main() 必须在 ctx 定义之后调用回收器装配。
func TestStartupCallsGatewayFileReaper(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	s := string(src)

	const call = "startGatewayFileReaper(ctx, db, llmgateway.FileReaperInterval)"
	callAt := strings.Index(s, call)
	if callAt < 0 {
		t.Fatalf("main.go 里找不到装配调用 %q —— 回收器不会被启动（审计 M8）", call)
	}
	// ctx 必须先定义（NotifyContext 是启动期 ctx 的唯一来源）。
	ctxAt := strings.Index(s, "ctx, stop := signal.NotifyContext(")
	if ctxAt < 0 {
		t.Fatal("main.go 里找不到启动期 ctx 的定义（signal.NotifyContext）")
	}
	if callAt < ctxAt {
		t.Fatal("回收器在 ctx 定义之前被调用（用的是别的 ctx 或根本编译不过）")
	}
	// 必须在 main() 函数体内（挪进别的函数/init 就等于没在启动路径上调用）。
	mainAt := strings.Index(s, "func main() {")
	if mainAt < 0 {
		t.Fatal("main.go 里找不到 func main()")
	}
	nextFuncAt := strings.Index(s[mainAt+1:], "\nfunc ")
	if nextFuncAt < 0 {
		nextFuncAt = len(s) - mainAt - 1
	}
	if callAt < mainAt || callAt > mainAt+nextFuncAt {
		t.Fatal("回收器装配不在 main() 函数体内 —— 进程启动路径不会执行到它")
	}
	// 直连 llmgateway.StartFileReaper 的调用只允许存在于接缝文件里（否则又出现
	// "绕开接缝自行启动"的第二条路径，接缝的断言就管不住它了）。
	if n := strings.Count(s, "llmgateway.StartFileReaper("); n != 0 {
		t.Fatalf("main.go 里仍有 %d 处直连 llmgateway.StartFileReaper 的调用（应只走装配接缝）", n)
	}
	seam, err := os.ReadFile("gateway_reaper.go")
	if err != nil {
		t.Fatalf("read gateway_reaper.go: %v", err)
	}
	if !strings.Contains(string(seam), "var startFileReaper = llmgateway.StartFileReaper") {
		t.Fatal("装配接缝 gateway_reaper.go 里找不到 startFileReaper 的默认实现绑定")
	}
}

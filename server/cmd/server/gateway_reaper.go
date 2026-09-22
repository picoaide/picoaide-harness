package main

// 后台常驻任务的装配接缝（审计 M8）。
//
// 缺陷形态：`llmgateway.StartFileReaper` 在库里有完整实现、也有自己的用例，
// 但**唯一的生产调用点**只是 main() 里的一行。把那一行删掉（或挪到某个
// 永远不会走到的分支里）时，所有门禁依旧全绿 —— 回收器不再运行，上游配额
// 被"已不可访问但仍占着"的文件吃光，而没有任何断言会红。
//
// 修法分两半，缺一不可：
//  1. 把调用收进一个**可测的函数**（startGatewayFileReaper），并用包级变量
//     （startFileReaper）留出替换点 —— 这样"参数是不是 signal ctx / 同一个 db /
//     间隔常量"可以被执行级断言钉住，而不只是"代码里有这行字"；
//  2. main() 里必须真的调用它（cmd/server 的装配级用例同时读 main.go 源码断言
//     调用存在、且排在 ctx 定义之后 —— 删掉调用即红）。

import (
	"context"
	"database/sql"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway"
)

// startFileReaper 是回收器的装配接缝：生产恒为 llmgateway.StartFileReaper，
// 仅测试替换（断言"启动路径确实调用了它，且拿到的是启动期的 ctx 与 db"）。
var startFileReaper = llmgateway.StartFileReaper

// startGatewayFileReaper 启动网关文件回收：启动先跑一轮，之后每
// FileReaperInterval 一次；ctx 取消即退出（回收器内部自行处理）。
//
// 抽成函数而不是直接在 main 里调用，是为了让"装配参数"可被断言（见文件头）。
func startGatewayFileReaper(ctx context.Context, db *sql.DB, interval time.Duration) {
	startFileReaper(ctx, db, interval)
}

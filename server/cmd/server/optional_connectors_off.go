//go:build !connectors

package main

// 本文件是 `connectors` 模块**关闭**时的装配接线（P1 第二片，2026-10-14）：
// `internal/connectors` 从依赖图里消失，`/api/server/admin/connectors*` 整片不注册。
//
// 注意边界（P0 规划 §4.2）：连接器的**种子行**（迁移 0042/0045/0084）与
// `mcp.*` settings 仍然照常建、照常存在 —— 关闭的是下发与运行面，不是数据面。

import "github.com/picoaide/picoaide/internal/router"

// applyConnectorDeps 在 connectors 关闭时是编译期 no-op。
func applyConnectorDeps(_ *router.Deps, _ productionDeps) {}

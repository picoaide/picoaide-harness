//go:build connectors

package main

// 本文件是 `connectors` 模块**打开**时的装配接线（P1 第二片，2026-10-14）。

import (
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/router"
)

// applyConnectorDeps 装配连接器管理面 handler。
func applyConnectorDeps(rd *router.Deps, d productionDeps) {
	rd.Connector = connectors.NewHandlers(d.DB)
}

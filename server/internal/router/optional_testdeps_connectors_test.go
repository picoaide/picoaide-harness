//go:build connectors

package router

// 本文件在 `connectors` 打开时给 router 包内测试装配补上连接器管理面
// （P1 第二片，2026-10-14）。

import (
	"testing"

	"github.com/picoaide/picoaide/internal/connectors"
)

// fillConnectorsTestDeps 填连接器 handler。
func fillConnectorsTestDeps(_ *testing.T, d *Deps) {
	d.Connector = connectors.NewHandlers(nil)
}

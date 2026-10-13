//go:build apps

package router

// 本文件在 `apps` 打开时给 router 包内测试装配补上 WASM 操作面（P1 第二片，2026-10-14）。

import (
	"testing"

	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
)

// fillAppsTestDeps 填 WASM 应用平台 handler（`apps` 关闭时整片注册代码不存在）。
func fillAppsTestDeps(t *testing.T, d *Deps) {
	t.Helper()
	_ = t
	d.Wasm = wasmapi.NewHandlers(wasmapi.Options{})
}

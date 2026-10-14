//go:build !connectors

package router

// 本文件在 `connectors` 关闭时生效（P1 第二片，2026-10-14）。

import "testing"

// fillConnectorsTestDeps 在 connectors 关闭时什么都不填。
func fillConnectorsTestDeps(_ *testing.T, _ *Deps) {}

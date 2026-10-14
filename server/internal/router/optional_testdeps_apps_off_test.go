//go:build !apps

package router

// 本文件在 `apps` 关闭时生效（P1 第二片，2026-10-14）。

import "testing"

// fillAppsTestDeps 在 apps 关闭时什么都不填。
func fillAppsTestDeps(_ *testing.T, _ *Deps) {}

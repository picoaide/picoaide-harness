//go:build !apps

package main

// 本文件在 `apps` 关闭时给测试装配补上替身 /readyz 探针（P1 第二片，2026-10-14）。
//
// `Ready` 在**所有**变体里都必须非 nil：生产装配对它 fail-fast
// （`registerProductionRoutes` 首段的 panic），漏填会变成"每个 /readyz 请求 500"。
// apps 关闭时没有 wasmPlat.Checker，因此给与生产替身同源的 `wasmCheckerOff`。

import (
	"database/sql"
	"testing"
)

// fillAppsProductionDeps 填 apps 面的 productionDeps 字段（关闭态只剩替身探针）。
func fillAppsProductionDeps(t *testing.T, d *productionDeps, _ *sql.DB, _ string) {
	t.Helper()
	d.Ready = wasmCheckerOff{}.Handler()
}

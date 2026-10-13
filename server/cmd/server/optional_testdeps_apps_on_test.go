//go:build apps

package main

// 本文件在 `apps` 打开时给测试装配补上 WASM 操作面与 /readyz 探针
// （P1 第二片，2026-10-14）。

import (
	"database/sql"
	"testing"

	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// fillAppsProductionDeps 填 apps 面的 productionDeps 字段（与 main() 同形）。
func fillAppsProductionDeps(t *testing.T, d *productionDeps, db *sql.DB, dataDir string) {
	t.Helper()
	// WASM 应用平台操作面：必须非 nil，否则 router 整片跳过（见 productionDeps.Wasm）。
	d.Wasm = wasmapi.NewHandlers(wasmapi.Options{DB: db, DataRoot: dataDir})
	// /readyz 探针：与生产同形（真实库时带 Ping）。
	d.Ready = readyz.New(readyz.Options{DataRoot: dataDir, Ping: pingFn(db)}).Handler()
}

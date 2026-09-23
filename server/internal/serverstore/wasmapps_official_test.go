package serverstore

import (
	"context"
	"testing"
)

// ---- 官方归属不变量（R3-A A-9）：official=1 ⇒ owner='' ----
//
// 变异验证（改回危险实现时哪条用例必红）：
//   - UpsertWasmApp 的 owner 分支去掉 `CASE WHEN apps.official = 1 THEN ''`
//     → TestUpsertWasmAppKeepsOfficialOwnerEmpty 红（官方行被填成发布者）
//   - WasmApp 的 Official 字段/列集被删 → 同一条用例红在"读不到官方标记"
//     （以及 wasmapp/api 侧的 official 分支失效）

// TestUpsertWasmAppKeepsOfficialOwnerEmpty 钉住 DAO 层的不变量守卫。
//
// 为什么守卫必须在 DAO（而不是只在 wasmapp/api 的调用点）：`SetAppOfficial`
// 早就是对"official=1 ∧ owner≠”"返回 ErrValidation 的**唯一写入口守卫**，
// 而 `UpsertWasmApp` 的 COALESCE 分支恰好能绕过它 —— 官方行的 owner 本来是
// 空串，`COALESCE(NULLIF(”,”), excluded.owner)` 于是把归属填成发布者。
// 本用例**绕过 api 层**直接调 DAO，模拟"未来某个调用者"（例如每次启动都会跑的
// appseed 播种），证明禁止状态在唯一写入口处就造不出来。
func TestUpsertWasmAppKeepsOfficialOwnerEmpty(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	// 官方行：official=1 ∧ owner=''（SetAppOfficial 只接受这一种组合）。
	newWasmApp(t, db, "official-guard", "")
	if err := SetAppOfficial(db, AppKindWasmApp, "official-guard", true, ""); err != nil {
		t.Fatalf("SetAppOfficial(true): %v", err)
	}

	// 绕过 api 层直接 upsert，并**显式传一个非空的 owner**（最坏形态）。
	if err := UpsertWasmApp(ctx, db, WasmApp{
		AppID: "official-guard", Title: "官方应用", Owner: "bob", Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertWasmApp: %v", err)
	}
	app, err := GetWasmApp(ctx, db, "official-guard")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if app.Official != 1 {
		t.Fatalf("official = %d, want 1（DTO 必须读得见官方标记，否则调用点无法照它分支）", app.Official)
	}
	if app.Owner != "" {
		t.Fatalf("BUG: 官方行的归属被 upsert 改写成 %q（official=1 ∧ owner≠'' 是 SetAppOfficial 拒绝的禁止状态）",
			app.Owner)
	}

	// 反向（防过度修复）：同一次 upsert 仍要正常更新 title —— 守卫只该管 owner 一列，
	// 不能把整条冲突分支变成 no-op。
	if app.Title != "官方应用" {
		t.Fatalf("title = %q, want 官方应用（守卫不该连带冻结其它投影列）", app.Title)
	}

	// 反向：非官方行的"归属首占 + 不可改写"必须一字不变（§4.1/R6 发布者即管理员）。
	newWasmApp(t, db, "plain-guard", "alice")
	if err := UpsertWasmApp(ctx, db, WasmApp{AppID: "plain-guard", Owner: "bob", Enabled: true}); err != nil {
		t.Fatalf("UpsertWasmApp(plain): %v", err)
	}
	plain, err := GetWasmApp(ctx, db, "plain-guard")
	if err != nil {
		t.Fatalf("GetWasmApp(plain): %v", err)
	}
	if plain.Official != 0 || plain.Owner != "alice" {
		t.Fatalf("非官方行的归属被改写：official=%d owner=%q（want 0/alice）", plain.Official, plain.Owner)
	}

	// 反向：官方归属被**显式**解除（owner 转移端点）后，归属必须能被重新写入 ——
	// 守卫认的是"当前 official=1"，不是"曾经官方过"。
	if err := SetAppOfficial(db, AppKindWasmApp, "official-guard", false, "bob"); err != nil {
		t.Fatalf("SetAppOfficial(false): %v", err)
	}
	if err := UpsertWasmApp(ctx, db, WasmApp{AppID: "official-guard", Owner: "carol", Enabled: true}); err != nil {
		t.Fatalf("UpsertWasmApp(after demote): %v", err)
	}
	demoted, err := GetWasmApp(ctx, db, "official-guard")
	if err != nil {
		t.Fatalf("GetWasmApp(demoted): %v", err)
	}
	if demoted.Official != 0 || demoted.Owner != "bob" {
		t.Fatalf("解除官方后归属应保持既有值 bob：official=%d owner=%q", demoted.Official, demoted.Owner)
	}
}

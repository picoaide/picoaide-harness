package serverstore

// R16A-17（审计 2026-09-25，P2；泳道 A 报告 §3.1）：退役应用与"审核通过待审版本"
// 的交错**产不出** `approved + archive IS NULL` 的坏行。
//
// 缺陷形态（修复前，真 PG 实测，见 temp/r16/A/REPORT.md §3.1）：`SoftDeleteWasmApp`
// 把该应用名下**全部**版本的 `archive` 清空（含 `status='pending'` 的待审版本），
// 但**不给 release 行置 `deleted_at`**；而 `SetReleaseStatusForReview` 的 approve
// 谓词是
//
//	deleted_at IS NULL AND (archive IS NOT NULL OR status <> 'rejected')
//
// 第二个析取项对 pending 行**恒真** ⇒ 审核通过成功返回，产出
// `approved + archive IS NULL` —— 而 apps.go 逐字写着"任何交错都产不出"这条形态
// （那是 N-4 / P0 级修复的判据本体）。
//
// 今天潜伏（应用行已退役、全仓无 restore），但一旦出现"恢复应用/取消删除"或任何以
// `status='approved'` 为判据的读面（导出、审计、目录重建），坏行立刻变成"当前生效
// 版本没有字节"。
//
// 修法：清字节时**同时置 `deleted_at`**（与孪生路径 `SoftDeleteWasmRelease` 逐字一致
// —— 它本来就是 `SET deleted_at = now(), archive = NULL, size = 0`）。
//
// 判据（本文件）：构造交错 ⇒ approve 必须**返回错误**，且库里不存在
// `status='approved' AND archive IS NULL` 的行。拆掉修复（去掉 deleted_at）⇒ 必红。

import (
	"context"
	"errors"
	"testing"
)

// TestR16A17SoftDeleteAppCannotProduceApprovedRowWithoutArchive 是 R16A-17 的核心判据。
func TestR16A17SoftDeleteAppCannotProduceApprovedRowWithoutArchive(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	const appID = "r16a17-app"
	const user = "r16a17-user"

	if err := UpsertWasmApp(ctx, db, WasmApp{
		AppID: appID, Title: appID, Owner: user, Channel: AppChannelWasm, Enabled: true,
	}); err != nil {
		t.Fatalf("建应用: %v", err)
	}
	// 一个**待审**版本（pending，带字节）：这正是交错里被清字节的那一行。
	if _, err := db.ExecContext(ctx, `
		INSERT INTO app_releases (kind, app_id, version, title, description, publisher,
			checksum, size, archive, status)
		VALUES ('wasm_app', $1, '1.0.0', 't', '', $2, 'sum', 8, convert_to('12345678','UTF8'), 'pending')`,
		appID, user); err != nil {
		t.Fatalf("插入待审版本: %v", err)
	}

	// 交错第一步：退役应用（清掉该版本字节）。
	if err := SoftDeleteWasmApp(ctx, db, appID); err != nil {
		t.Fatalf("SoftDeleteWasmApp: %v", err)
	}
	var archiveCleared, rowDeleted bool
	if err := db.QueryRowContext(ctx, `SELECT archive IS NULL, deleted_at IS NOT NULL
		FROM app_releases WHERE kind = 'wasm_app' AND app_id = $1 AND version = '1.0.0'`, appID).
		Scan(&archiveCleared, &rowDeleted); err != nil {
		t.Fatalf("读版本行: %v", err)
	}
	if !archiveCleared {
		t.Fatal("前置条件不成立：退役没有清空字节")
	}
	// 修法本体：字节被清的行必须同时是"软删"态 —— 否则 approve 谓词的第二个析取项
	// （status <> 'rejected'）会放行它。
	if !rowDeleted {
		t.Fatal("字节已清空，但这一行没有被置 deleted_at ⇒ approve 谓词会放行它（R16A-17 未修）")
	}

	// 交错第二步：审核通过。必须失败（ErrReleaseArchiveCleared → 调用方映射 409），
	// 而不是"成功返回 + 产出坏行"。
	err := SetReleaseStatusForReview(db, AppKindWasmApp, appID, "1.0.0", ReleaseStatusApproved, "")
	if err == nil {
		t.Fatal("退役应用下的待审版本被 approve 成功 —— 坏行产出了")
	}
	if !errors.Is(err, ErrReleaseArchiveCleared) {
		t.Fatalf("approve 的错误 = %v, want ErrReleaseArchiveCleared（409 语义）", err)
	}

	// 不变量（判据本体，直查库）：全库不得存在 approved + archive IS NULL 的行。
	var bad int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM app_releases WHERE status = 'approved' AND archive IS NULL`).Scan(&bad); err != nil {
		t.Fatal(err)
	}
	if bad != 0 {
		t.Fatalf("库里存在 %d 行 `approved + archive IS NULL`（N-4 的不变量被打破）", bad)
	}

	// 正向对照：**未退役**应用的同名交错必须照旧可 approve（防"过度修复"——
	// 把正常审核路径一起拦死）。这是"上面的失败是修法造成的，而不是整个审核路径坏了"。
	const appID2 = "r16a17-app-ok"
	if err := UpsertWasmApp(ctx, db, WasmApp{
		AppID: appID2, Title: appID2, Owner: user, Channel: AppChannelWasm, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO app_releases (kind, app_id, version, title, description, publisher,
			checksum, size, archive, status)
		VALUES ('wasm_app', $1, '1.0.0', 't', '', $2, 'sum', 8, convert_to('12345678','UTF8'), 'pending')`,
		appID2, user); err != nil {
		t.Fatal(err)
	}
	if err := SetReleaseStatusForReview(db, AppKindWasmApp, appID2, "1.0.0", ReleaseStatusApproved, ""); err != nil {
		t.Fatalf("正常应用的待审版本必须能通过审核: %v", err)
	}
	var status string
	if err := db.QueryRowContext(ctx, `SELECT status FROM app_releases
		WHERE kind = 'wasm_app' AND app_id = $1 AND version = '1.0.0'`, appID2).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != ReleaseStatusApproved {
		t.Fatalf("正常路径 status = %q, want approved", status)
	}
}

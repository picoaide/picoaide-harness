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
// 修法（2026-09-25 修正为**谓词侧**收口）：退役仍只清字节（不给 release 行置
// `deleted_at`），坏行由 `SetReleaseStatusForReview` 的 approve 谓词新增的
// 「应用未退役」条件挡住。
//
// 为什么不是"退役时给 release 行置 deleted_at"（第一版修法）：那等于把退役做成
// **版本级删除**，而退役的产品契约是"保留期内作者/管理员仍能读版本清单"
// （`TestMyReleasesSurvivesRetirement` 与 `myReleases` 的文档注释逐字钉住）——
// 置 deleted_at 之后一切 `deleted_at IS NULL` 的读面都会看不见这些行，退役就等于
// 版本历史凭空消失。谓词侧的 EXISTS 让两条要求同时成立。
//
// 判据（本文件）：构造交错 ⇒ approve 必须**返回错误**（ErrReleaseArchiveCleared），
// 且库里不存在"未退役应用的 `status='approved' AND archive IS NULL`"行；同时
// 退役后该版本行**仍然**在 `deleted_at IS NULL` 的读面里（保留期语义）。
// 拆掉修复（去掉谓词的 EXISTS 条件）⇒ approve 成功、坏行产出 ⇒ 必红。

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
	var archiveCleared, rowVisible bool
	if err := db.QueryRowContext(ctx, `SELECT archive IS NULL, deleted_at IS NULL
		FROM app_releases WHERE kind = 'wasm_app' AND app_id = $1 AND version = '1.0.0'`, appID).
		Scan(&archiveCleared, &rowVisible); err != nil {
		t.Fatalf("读版本行: %v", err)
	}
	if !archiveCleared {
		t.Fatal("前置条件不成立：退役没有清空字节")
	}
	// 保留期语义（产品契约的一半）：退役**不**把 release 行标成已删 —— 作者与管理
	// 员的版本清单（`deleted_at IS NULL` 读面）在保留期内仍看得见这一行。
	// 变异的另一半在这里：把 deleted_at 写回去 ⇒ 下面这条立刻红。
	if !rowVisible {
		t.Fatal("退役把 release 行置成了 deleted_at ⇒ 保留期内作者/管理员读不到版本清单（TestMyReleasesSurvivesRetirement 会红）")
	}
	// 逐字复核"清单读面确实看得见"（不只查列，走真正的 DAO）。
	listed, lerr := ListWasmReleases(ctx, db, appID, false)
	if lerr != nil {
		t.Fatalf("ListWasmReleases: %v", lerr)
	}
	if len(listed) != 1 || listed[0].Version != "1.0.0" {
		t.Fatalf("退役后版本清单 = %+v, want 1 行 1.0.0（保留期内作者仍要能回看结论）", listed)
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

	// 不变量（判据本体，直查库）：**未退役**应用名下不得存在
	// `approved + archive IS NULL` 的行。
	//
	// 口径为什么带"未退役"：退役本来就会清空已生效版本的字节（释放配额是它的
	// 目的），而退役应用没有任何服务路径 —— 那条不变量真正要防的是"**活着的**
	// 应用有一个没有字节的生效版本"。
	var bad int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM app_releases r
		   JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
		  WHERE r.status = 'approved' AND r.archive IS NULL AND a.deleted_at IS NULL`).Scan(&bad); err != nil {
		t.Fatal(err)
	}
	if bad != 0 {
		t.Fatalf("库里存在 %d 行「未退役应用的 approved + archive IS NULL」（N-4 的不变量被打破）", bad)
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

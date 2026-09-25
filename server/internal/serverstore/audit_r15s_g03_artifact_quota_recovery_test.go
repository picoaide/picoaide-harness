package serverstore

// R15C-G-03 回归判据：WASM 制品配额（每用户 1 GiB）**必须有恢复路径**。
//
// 缺陷形态（第 15 轮审计子泳道 G，主报告判为"最该先修"）：闸门在发布链路的最前面
// （publish.go 的 CheckArtifactQuota），而唯一会释放字节的 GC 在**发布成功之后**；
// 同时软删不清字节、GC 候选集又排除软删行 ⇒ 连"发布失败后的补偿软删"都永久吃掉
// 配额（每次最多 32 MiB）⇒ 配额用尽 ⇒ 发布永远失败 ⇒ GC 永不运行（自锁）。
// 报错文案承诺的两条出路（删除版本 / 管理员扩容）**都不存在**。
//
// 判据（对应任务书要求的等价不变量）：
//   ① **一次发布失败的补偿软删之后，配额必须回到软删前的可用值**
//      （CountUserArtifactBytes 回到 baseline，且闸门 CheckArtifactQuota 重新放行）；
//   ② 退役应用（DELETE /apps/wasm/:app_id → SoftDeleteWasmApp）必须释放它名下
//      全部版本的字节 —— 这是用户在"配额已满"时唯一能自己按的恢复动作；
//   ③ 口径本身也收口：配额只计**未软删（仍在版本清单里可见）**的版本；
//   ④ GC 顺手回收历史遗留的"已软删但仍有字节"的行（修复上线前的数据）。
//
// 变异验证（把 wasmapps.go 换回 HEAD 版 ⇒ ① 的第一轮就红：used 每轮 +32 MiB 不减；
// 只回退 SoftDeleteWasmRelease 而保留 SoftDeleteWasmApp ⇒ ① 红、② 绿；
// 只回退 CountUserArtifactBytes 的 `deleted_at IS NULL` 谓词 ⇒ ③ 红）。

import (
	"context"
	"database/sql"
	"fmt"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// r15sInsertBigRelease 直接落一行带**逻辑大**制品的版本：PG 的 TOAST 会把
// repeat('x') 压得很小，而 octet_length 返回未压缩长度 ⇒ 用几 MB 磁盘造出真实的
// 配额占用（口径与生产一致：CountUserArtifactBytes 就数 octet_length）。
func r15sInsertBigRelease(t *testing.T, db *sql.DB, appID, version, publisher string, bytes int) int64 {
	t.Helper()
	var id int64
	err := db.QueryRowContext(context.Background(), `
		INSERT INTO app_releases (kind, app_id, version, title, description, publisher,
			checksum, size, archive, status)
		VALUES ('wasm_app', $1, $2, $2, '', $3, '', $4::bigint,
		        convert_to(repeat('x', $5::int), 'UTF8'), 'approved')
		RETURNING id`, appID, version, publisher, int64(bytes), bytes).Scan(&id)
	if err != nil {
		t.Fatalf("插入大制品版本 %s: %v", version, err)
	}
	return id
}

func r15sUsed(t *testing.T, db *sql.DB, user string) int64 {
	t.Helper()
	n, err := CountUserArtifactBytes(context.Background(), db, user)
	if err != nil {
		t.Fatalf("CountUserArtifactBytes: %v", err)
	}
	return n
}

func r15sNewQuotaApp(t *testing.T, db *sql.DB, appID, owner string) {
	t.Helper()
	if err := UpsertWasmApp(context.Background(), db, WasmApp{
		AppID: appID, Title: appID, Owner: owner, Channel: AppChannelWasm, Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertWasmApp(%s): %v", appID, err)
	}
}

// TestR15SG03CompensatingSoftDeleteRestoresQuota 是核心判据 ①：
// "先占字节（发布落行）→ 补偿软删"这个循环跑 N 轮，配额必须每一轮都回到 baseline。
// 修好前每轮净增 incoming 字节（永久占用，从不回落）：累计超过 1 GiB 之后发布永久
// 失败，而 GC 只在发布成功之后运行 ⇒ 自锁（子泳道 G 的探针用 5×300 MiB 复现）。
func TestR15SG03CompensatingSoftDeleteRestoresQuota(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	const user = "r15s-quota-user"
	const appID = "r15s-quota-app"

	r15sNewQuotaApp(t, db, appID, user)
	// 初始占用：一个正常发布的版本（10 MiB）。
	baseline := int64(10 << 20)
	r15sInsertBigRelease(t, db, appID, "1.0.0", user, int(baseline))
	if got := r15sUsed(t, db, user); got != baseline {
		t.Fatalf("夹具失效：baseline=%d，实测 %d", baseline, got)
	}

	// 补偿软删的字节规模取"单次上传上限"量级（生产里一次发布失败最多吃这么多）。
	const perAttempt = 32 << 20
	for round := 1; round <= 8; round++ {
		// 发布失败前的形态：release 行已落库（带字节），随后收尾失败触发补偿。
		id := r15sInsertBigRelease(t, db, appID, r15sVersionFor(round), user, perAttempt)
		if got := r15sUsed(t, db, user); got != baseline+perAttempt {
			t.Fatalf("第 %d 轮：落行之后 used=%d，期望 %d", round, got, baseline+perAttempt)
		}
		// 补偿路径（publish.go 的 compensate 闭包）。
		if err := SoftDeleteWasmRelease(ctx, db, id); err != nil {
			t.Fatalf("第 %d 轮 SoftDeleteWasmRelease: %v", round, err)
		}
		got := r15sUsed(t, db, user)
		t.Logf("第 %d 轮补偿软删之后 used=%d（baseline=%d）", round, got, baseline)
		if got != baseline {
			t.Fatalf("补偿软删没有把配额还回来（第 %d 轮）：used=%d，期望回到 baseline=%d —— "+
				"每次发布失败都会永久吃掉 %d 字节，配额用尽后发布永久失败、GC（只在发布成功后跑）永不运行",
				round, got, baseline, perAttempt)
		}
		// 闸门必须一直可用（这就是"恢复路径"的可执行形态）。
		if qerr := registry.CheckArtifactQuota(got, perAttempt); qerr != nil {
			t.Fatalf("第 %d 轮之后闸门仍拦：%v", round, qerr.Message)
		}
	}
	// 版本号永久占位（软删不删行）：重发同一版本仍冲突。
	if _, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: appID, Version: r15sVersionFor(1), Title: "重发", Publisher: user,
		Wasm: []byte("x"), Status: ReleaseStatusApproved,
	}); err == nil {
		t.Errorf("软删版本的版本号应永久占位（重发必须冲突）")
	}
}

// r15sVersionFor 生成第 n 轮的版本号（1.0.0 已被 baseline 占用）。
func r15sVersionFor(round int) string {
	return fmt.Sprintf("9.%d.0", round)
}

// TestR15SG03RetireAppIsTheUserVisibleRecoveryPath 是判据 ②：
// 一个**已经超过配额**的用户，必须有一个自己能按的动作把占用降下来 ——
// 就是退役应用（DELETE /apps/wasm/:app_id）。修好前退役一字节不减（自锁）。
func TestR15SG03RetireAppIsTheUserVisibleRecoveryPath(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	const user = "r15s-retire-user"
	const appID = "r15s-retire-app"

	r15sNewQuotaApp(t, db, appID, user)
	// 5 × 300 MiB = 1.46 GiB > 1 GiB 配额：用户已经发不出任何东西。
	for i, v := range []string{"1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"} {
		r15sInsertBigRelease(t, db, appID, v, user, (300<<20)+i)
	}
	used := r15sUsed(t, db, user)
	t.Logf("退役前 used=%d（配额 %d）", used, int64(limits.ArtifactQuotaPerUserBytes))
	if used <= int64(limits.ArtifactQuotaPerUserBytes) {
		t.Fatalf("夹具失效：used=%d 未超过配额", used)
	}
	if qerr := registry.CheckArtifactQuota(used, 1); qerr == nil {
		t.Fatalf("夹具失效：超配额却仍放行")
	} else {
		t.Logf("闸门判词 = %s / %s", qerr.Code, qerr.Message)
		t.Logf("给用户的出路 = %v", qerr.Hints)
	}

	// 用户唯一能按的动作：退役这个应用。
	if err := SoftDeleteWasmApp(ctx, db, appID); err != nil {
		t.Fatalf("SoftDeleteWasmApp: %v", err)
	}
	after := r15sUsed(t, db, user)
	t.Logf("退役后 used=%d", after)
	if after != 0 {
		t.Fatalf("退役没有释放字节：used=%d（该应用已不可能再被服务，字节却仍全额计入配额 ⇒ 自锁）", after)
	}
	if qerr := registry.CheckArtifactQuota(after, 32<<20); qerr != nil {
		t.Fatalf("退役之后闸门仍然拦住发布：%v", qerr.Message)
	}
	// 元数据行一字不删（R37 冻结期导出靠它们），只有字节被释放。
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM app_releases WHERE kind = 'wasm_app' AND app_id = $1`, appID).Scan(&rows); err != nil {
		t.Fatalf("复查版本行: %v", err)
	}
	if rows != 5 {
		t.Errorf("退役不该删版本行（导出/追溯要用）：剩 %d 行，期望 5", rows)
	}
}

// TestR15SG03PruneReapsDeadRowsAndKeepsLiveWindow 是判据 ④ + 保留窗口的反向判据：
//   - 历史遗留的"已软删但仍有字节"的行必须被 GC 回收（修复上线前的数据不会自己消失）；
//   - 活着的 approved 版本仍按 keep 窗口保留（回收不能越界到线上版本）。
func TestR15SG03PruneReapsDeadRowsAndKeepsLiveWindow(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	const appID = "r15s-prune-app"
	const user = "r15s-prune-user"

	r15sNewQuotaApp(t, db, appID, user)
	// 一个历史遗留行：软删但仍有字节（模拟修复上线前的补偿软删）。
	deadID := r15sInsertBigRelease(t, db, appID, "0.1.0", user, 1<<20)
	if _, err := db.ExecContext(ctx, `UPDATE app_releases SET deleted_at = now() WHERE id = $1`, deadID); err != nil {
		t.Fatalf("造历史软删行: %v", err)
	}
	// 三个活着的 approved 版本（keep=3 时必须一个都不回收）。
	var liveIDs []int64
	for _, v := range []string{"1.0.0", "1.1.0", "1.2.0"} {
		liveIDs = append(liveIDs, r15sInsertBigRelease(t, db, appID, v, user, 1<<20))
	}

	pruned, err := PruneWasmReleases(ctx, db, appID, limits.RetainedVersions)
	if err != nil {
		t.Fatalf("PruneWasmReleases: %v", err)
	}
	t.Logf("GC 回收的 id = %v（历史软删行 id=%d）", pruned, deadID)
	reaped := false
	for _, id := range pruned {
		if id == deadID {
			reaped = true
		}
		for _, live := range liveIDs {
			if id == live {
				t.Errorf("GC 越界：回收了仍在线（keep 窗口内）的版本 id=%d", live)
			}
		}
	}
	if !reaped {
		t.Errorf("GC 没有回收历史软删行（id=%d）：删除行仍占字节，而候选集排除软删 ⇒ 这类字节永远留在库里", deadID)
	}
	var deadBytes int64
	if err := db.QueryRow(`SELECT COALESCE(octet_length(archive), 0) FROM app_releases WHERE id = $1`, deadID).Scan(&deadBytes); err != nil {
		t.Fatalf("复查历史软删行: %v", err)
	}
	if deadBytes != 0 {
		t.Errorf("历史软删行仍有 %d 字节", deadBytes)
	}
}

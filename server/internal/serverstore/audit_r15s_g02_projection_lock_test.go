package serverstore

// R15C-G-02 回归判据：`RecomputeAppProjection` 的「读最高 approved 版本 → 写
// apps 投影」必须是一个**有守卫的串行单元**（同一事务 + apps 行锁），并发审批
// 不允许丢更新。
//
// 缺陷形态（第 15 轮审计子泳道 G）：旧实现是 autocommit 下的两条语句。两个管理员
// 并发审批两个待审版本时，后写者用自己那一刻读到的陈旧快照覆盖先写者 ⇒
// `apps.title/description` 停在**不是**最高 approved 的版本上，而目录、详情、导出
// 都读 apps 行 ⇒ 全组织看到的标题属于一个已过期的版本，且无自愈路径。
//
// 本用例用行锁把并发窗口**变确定**（不靠碰运气），判据 = "被挡住的那个写者，
// 拿到锁之后必须重新读版本快照"：
//   ① 第三个连接持住 apps 行的 FOR UPDATE；
//   ② 让 RecomputeAppProjection 起跑（修好前它会先读完 v1、再卡在 UPDATE 上；
//      修好后它卡在取锁那一步 —— 两种形态都被 r15sWaitForBlockedAppsStatement 接受）；
//   ③ 窗口内并发 approve v3.0.0（这正是 sharedskills / agentshare 的 approve 分支
//      会做的事）+ 再起第二个 RecomputeAppProjection（第二个并发写者）；
//   ④ 放锁 ⇒ 两个写者依次落地，终态必须与真相表（最高 approved）一致。
//
// 变异验证（把 RecomputeAppProjection 换回 HEAD 的 autocommit 两语句版 ⇒ 必红）：
// 返回的生效版本会停在 "1.0.0"、apps.title 会停在 "T1"，而真相是 3.0.0/"T3"。

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// r15sRelease 落一行版本（投影判据只关心 version/title/description/status）。
func r15sRelease(t *testing.T, db *sql.DB, appID, version, title, status string) {
	t.Helper()
	if _, err := CreateRelease(db, &Release{
		Kind: AppKindSkill, AppID: appID, Version: version, Title: title,
		Description: "desc-" + version, Publisher: "author", Status: status,
	}); err != nil {
		t.Fatalf("CreateRelease(%s): %v", version, err)
	}
}

// r15sWaitForBlockedAppsStatement 轮询 pg_stat_activity，等到出现一条被行锁挡住、
// 且语句里出现 apps 的后端。修好前被挡住的是 `UPDATE apps`，修好后是
// `SELECT 1 FROM apps … FOR UPDATE` —— 两种形态都算命中，判据只看
// "确实有一个写者卡在 apps 行锁上"（探针夹具的自校准：等不到就判定夹具失效，
// 而不是把环境差异读成结论）。
func r15sWaitForBlockedAppsStatement(t *testing.T, db *sql.DB, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM pg_stat_activity
			WHERE wait_event_type = 'Lock' AND state = 'active'
			  AND query ILIKE '%apps%'`).Scan(&n); err == nil && n > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("在 %s 内没有观察到被行锁挡住的 apps 语句（夹具失效，不据此判缺陷）", timeout)
}

// TestR15SG02RecomputeProjectionNoLostUpdateUnderConcurrentApproval 是核心判据。
func TestR15SG02RecomputeProjectionNoLostUpdateUnderConcurrentApproval(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	const appID = "r15s-projection"

	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: appID, Title: "T1", Owner: "author",
		Channel: AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatalf("UpsertApp: %v", err)
	}
	r15sRelease(t, db, appID, "1.0.0", "T1", ReleaseStatusApproved)
	r15sRelease(t, db, appID, "2.0.0", "T2", ReleaseStatusPending)
	r15sRelease(t, db, appID, "3.0.0", "T3", ReleaseStatusPending)

	ctx := context.Background()
	// ① 第三方连接持住 apps 行锁（模拟另一个写者正在改这一行）。
	holder, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("取独占连接: %v", err)
	}
	defer holder.Close()
	if _, err := holder.ExecContext(ctx, "BEGIN"); err != nil {
		t.Fatalf("holder BEGIN: %v", err)
	}
	var one int
	if err := holder.QueryRowContext(ctx,
		`SELECT 1 FROM apps WHERE kind = ? AND app_id = ? FOR UPDATE`, AppKindSkill, appID).Scan(&one); err != nil {
		t.Fatalf("holder 锁住 apps 行: %v", err)
	}

	type result struct {
		version string
		err     error
	}
	recompute := func() chan result {
		done := make(chan result, 1)
		go func() {
			v, err := RecomputeAppProjection(db, AppKindSkill, appID)
			done <- result{v, err}
		}()
		return done
	}
	await := func(done chan result, who string) result {
		t.Helper()
		select {
		case r := <-done:
			if r.err != nil {
				t.Fatalf("%s: RecomputeAppProjection: %v", who, r.err)
			}
			return r
		case <-time.After(20 * time.Second):
			t.Fatalf("%s: RecomputeAppProjection 超时未返回（可能死锁在行锁上）", who)
			return result{}
		}
	}

	// ② 第一个写者起跑，被行锁挡住。
	w1 := recompute()
	r15sWaitForBlockedAppsStatement(t, db, 10*time.Second)

	// ③ 窗口内并发审批 v3.0.0（第二条并发路径），并起第二个写者。
	if err := SetReleaseStatus(db, AppKindSkill, appID, "3.0.0", ReleaseStatusApproved, ""); err != nil {
		t.Fatalf("并发 approve v3: %v", err)
	}
	w2 := recompute()

	// ④ 放锁：两个写者依次落地。
	if _, err := holder.ExecContext(ctx, "ROLLBACK"); err != nil {
		t.Fatalf("holder ROLLBACK: %v", err)
	}
	got1, got2 := await(w1, "写者 1"), await(w2, "写者 2")
	t.Logf("两个写者返回的生效版本 = %q / %q", got1.version, got2.version)

	// 真相表：最高 approved 版本。
	var truthVersion, truthTitle, truthDesc string
	if err := db.QueryRow(`SELECT version, title, description FROM app_releases
		WHERE kind = ? AND app_id = ? AND status = ? AND deleted_at IS NULL
		ORDER BY id DESC LIMIT 1`, AppKindSkill, appID, ReleaseStatusApproved).
		Scan(&truthVersion, &truthTitle, &truthDesc); err != nil {
		t.Fatalf("读最高 approved: %v", err)
	}
	a, err := GetApp(db, AppKindSkill, appID)
	if err != nil {
		t.Fatalf("GetApp: %v", err)
	}
	t.Logf("真相表最高 approved = %s(%q) | apps 投影 = %q/%q", truthVersion, truthTitle, a.Title, a.Description)

	// 判据 1：返回的生效版本必须与真相一致（陈旧快照会给出 "1.0.0"）。
	for i, r := range []result{got1, got2} {
		if r.version != truthVersion {
			t.Errorf("写者 %d 返回的生效版本 = %q，真相是 %q（读-改-写没有守卫：读发生在取锁之前）",
				i+1, r.version, truthVersion)
		}
	}
	// 判据 2：终态投影必须等于最高 approved 版本的值（丢更新的直接后果）。
	if a.Title != truthTitle || a.Description != truthDesc {
		t.Errorf("投影与生效版本不一致（丢更新）：apps=%q/%q，最高 approved %s 是 %q/%q",
			a.Title, a.Description, truthVersion, truthTitle, truthDesc)
	}
}

// TestR15SG02RecomputeProjectionWritesInsideItsOwnTransaction 钉住"读-改-写同事务"：
// 一次调用必须把它该写的写到位（不是留到第二次调用），且各分支与旧实现逐字同义
// —— 没有 approved 版本回落 app_id 占位、待审版本永不投影、重复调用幂等。
func TestR15SG02RecomputeProjectionWritesInsideItsOwnTransaction(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	const appID = "r15s-projection-basic"

	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: appID, Title: "占位前的脏值", Owner: "author",
		Channel: AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatalf("UpsertApp: %v", err)
	}
	// ① 没有 approved 版本：回落到 app_id 占位（与发布期首版待审同口径）。
	if v, err := RecomputeAppProjection(db, AppKindSkill, appID); err != nil || v != "" {
		t.Fatalf("无 approved 版本时 = (%q, %v)，期望 (\"\", nil)", v, err)
	}
	if a, _ := GetApp(db, AppKindSkill, appID); a.Title != appID {
		t.Errorf("无 approved 版本应回落 app_id 占位：apps.title=%q", a.Title)
	}
	// ② 有了 approved 版本：投影切到它。
	r15sRelease(t, db, appID, "1.0.0", "T1", ReleaseStatusApproved)
	if v, err := RecomputeAppProjection(db, AppKindSkill, appID); err != nil || v != "1.0.0" {
		t.Fatalf("有 approved 版本时 = (%q, %v)，期望 (\"1.0.0\", nil)", v, err)
	}
	if a, _ := GetApp(db, AppKindSkill, appID); a.Title != "T1" || a.Description != "desc-1.0.0" {
		t.Errorf("投影未切到生效版本：apps=%q/%q", a.Title, a.Description)
	}
	// ③ 更高的**待审**版本不得投影（审核门控）。
	r15sRelease(t, db, appID, "2.0.0", "T2", ReleaseStatusPending)
	if v, err := RecomputeAppProjection(db, AppKindSkill, appID); err != nil || v != "1.0.0" {
		t.Fatalf("待审版本不该生效：(%q, %v)", v, err)
	}
	if a, _ := GetApp(db, AppKindSkill, appID); a.Title != "T1" {
		t.Errorf("待审版本被投影了：apps.title=%q", a.Title)
	}
	// ④ 幂等：重复调用不改变值（updated_at 也不该跳，最小写入）。
	before, _ := GetApp(db, AppKindSkill, appID)
	if _, err := RecomputeAppProjection(db, AppKindSkill, appID); err != nil {
		t.Fatalf("重复调用: %v", err)
	}
	after, _ := GetApp(db, AppKindSkill, appID)
	if after.Title != before.Title || after.Description != before.Description || !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Errorf("重复调用不是零副作用：%q/%q@%s → %q/%q@%s",
			before.Title, before.Description, before.UpdatedAt,
			after.Title, after.Description, after.UpdatedAt)
	}
	// ⑤ 没有 apps 行时：返回值仍按版本表算（UPDATE 0 行），不报错、不静默返回空。
	if v, err := RecomputeAppProjection(db, AppKindSkill, "r15s-no-such-row"); err != nil || v != "" {
		t.Fatalf("无 apps 行时 = (%q, %v)，期望 (\"\", nil)", v, err)
	}
}

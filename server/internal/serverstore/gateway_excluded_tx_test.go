package serverstore

// 2026-09-23(第三轮 §7.3 C):渠道同步排除名单的读-改-写竞态。
//
// 缺陷形态(已复现,见 temp/round2-2026-09-23/W2-server.md 的 W2-2):
// AddExcludedModel 旧实现是「读名单(经 settings 缓存)→ append → SetSetting 整串
// 覆写」,三步各自 autocommit 且中间没有任何锁 ⇒ 两个并发的"加入"各自基于同一份
// 旧名单覆写,**后写者覆盖前写者**。丢掉的那一项 = 管理员显式删除的渠道模型不在
// 排除名单里 ⇒ 下一轮渠道同步的 RemoveMissingProviderModels 把它当"上游已下架"
// 重新上架 —— webadmin 删除确认文案承诺的「删除后同步不会自动恢复」被撤销。
//
// 判据刻意用**确定性交错**(不靠赢得竞态):控制事务先用 `SELECT … FOR UPDATE`
// 钉住名单行,再依次放两个 goroutine 进入 —— 修复前两者都阻塞在 SetSetting 的
// UPDATE 上、修复后都阻塞在事务内的 `SELECT … FOR UPDATE` 上,释放控制锁后两者
// 依次完成。修复前最终名单只剩最后一个写者(丢项),修复后两个都在。

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// excludedNamesInDB 直读 settings 行(绕过 settings 缓存),解析排除名单。
func excludedNamesInDB(t *testing.T, db *sql.DB, providerID int64) []string {
	t.Helper()
	var raw string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, excludedModelsKey(providerID)).Scan(&raw); err != nil {
		t.Fatalf("读排除名单行失败: %v", err)
	}
	var names []string
	if err := json.Unmarshal([]byte(raw), &names); err != nil {
		t.Fatalf("解析排除名单失败(%q): %v", raw, err)
	}
	return names
}

// waitForBlockedBackends 轮询 pg_stat_activity,等到当前测试库里出现 wantBlocked
// 个"卡在锁等待上"的后端(不含本连接与 idle in transaction 的控制连接)。
// 用它把"两个写者都已经进入临界区并阻塞"变成可观测事实,而不是靠 sleep 猜。
func waitForBlockedBackends(t *testing.T, db *sql.DB, wantBlocked int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		var blocked int
		err := db.QueryRow(`SELECT COUNT(*) FROM pg_stat_activity
			WHERE datname = current_database() AND pid <> pg_backend_pid()
			  AND state = 'active' AND wait_event_type = 'Lock'`).Scan(&blocked)
		if err != nil {
			t.Fatalf("读 pg_stat_activity 失败: %v", err)
		}
		last = fmt.Sprintf("blocked=%d", blocked)
		if blocked >= wantBlocked {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等待阻塞中的后端超时: want>=%d, 实测 %s", wantBlocked, last)
}

// TestAddExcludedModelConcurrentAddsDoNotLoseEntries 是 W2-2 的核心判据:
// 两个并发的"加入名单"必须都在,少一个就是丢失更新。
func TestAddExcludedModelConcurrentAddsDoNotLoseEntries(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	var pid int64
	if err := db.QueryRow(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models)
		VALUES ('excl-race', 'https://up.example.com/v1', '', '[]') RETURNING id`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	// 名单行先存在(空数组):控制事务要能锁住它。生产里这一行在第一次删除后就有。
	key := excludedModelsKey(pid)
	if err := SetSetting(db, key, "[]"); err != nil {
		t.Fatal(err)
	}

	// 控制事务持有名单行锁:两个 AddExcludedModel 都会停在它上面。
	ctrl, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer ctrl.Rollback()
	var locked string
	if err := ctrl.QueryRow(`SELECT value FROM settings WHERE key = ? FOR UPDATE`, key).Scan(&locked); err != nil {
		t.Fatal(err)
	}

	doneA := make(chan error, 1)
	go func() { doneA <- AddExcludedModel(db, pid, "A") }()
	waitForBlockedBackends(t, db, 1)

	doneB := make(chan error, 1)
	go func() { doneB <- AddExcludedModel(db, pid, "B") }()
	waitForBlockedBackends(t, db, 2)

	if err := ctrl.Commit(); err != nil { // 放行
		t.Fatal(err)
	}
	if err := <-doneA; err != nil {
		t.Fatalf("A 加入名单失败: %v", err)
	}
	if err := <-doneB; err != nil {
		t.Fatalf("B 加入名单失败: %v", err)
	}

	names := excludedNamesInDB(t, db, pid)
	t.Logf("并发两次加入后的名单 = %v", names)
	has := map[string]bool{}
	for _, n := range names {
		has[n] = true
	}
	if !has["A"] || !has["B"] {
		t.Fatalf("丢失更新:并发加入后名单 = %v,期望同时含 A 与 B "+
			"(少的那一项会被下一轮渠道同步复活)", names)
	}
}

// TestAddExcludedModelTxCreatesRowAndIsIdempotent 钉住两件在竞态之外的语义:
//  1. 名单行**不存在**时(该 provider 第一次删除模型)也能加进去 —— 实现靠
//     `INSERT … ON CONFLICT (key) DO NOTHING` 建行,再由行锁串行化读-改-写
//     (行不存在时 `FOR UPDATE` 锁不到东西,所以建行必须在同一事务里先做);
//  2. 幂等:同名重复加入返回 changed=false 且不改库(调用方据此判断是否真的加了)。
func TestAddExcludedModelTxCreatesRowAndIsIdempotent(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	var pid int64
	if err := db.QueryRow(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models)
		VALUES ('excl-fresh', 'https://up.example.com/v1', '', '[]') RETURNING id`).Scan(&pid); err != nil {
		t.Fatal(err)
	}

	add := func(name string) bool {
		t.Helper()
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		changed, err := AddExcludedModelTx(tx, pid, name)
		if err != nil {
			t.Fatalf("AddExcludedModelTx(%q): %v", name, err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return changed
	}

	if !add("A") {
		t.Fatal("首次加入返回 changed=false(应当真的写库)")
	}
	if got := excludedNamesInDB(t, db, pid); len(got) != 1 || got[0] != "A" {
		t.Fatalf("首次加入后名单 = %v, want [A]", got)
	}
	if add("A") {
		t.Fatal("重复加入同名返回 changed=true(幂等被破坏)")
	}
	if !add("B") {
		t.Fatal("第二次加入新名字返回 changed=false")
	}
	got := excludedNamesInDB(t, db, pid)
	if len(got) != 2 || got[0] != "A" || got[1] != "B" {
		t.Fatalf("名单 = %v, want [A B](追加且保序)", got)
	}
	// 缓存口径:AddExcludedModel(自开事务版)提交后必须失效 settings 缓存,
	// 否则运行期读侧 30s 内看不到刚写的名单。
	if err := AddExcludedModel(db, pid, "C"); err != nil {
		t.Fatal(err)
	}
	names, err := GetExcludedModels(db, pid)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 3 {
		t.Fatalf("GetExcludedModels(缓存读)= %v, want 3 项(缓存未失效?)", names)
	}
}

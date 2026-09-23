package llmgateway

// 2026-09-23(第三轮 §7.3 C):DELETE /models/:id 的排除名单读-改-写竞态(管理面复现)。
//
// 与 serverstore 侧的 DAO 用例(`gateway_excluded_tx_test.go`)打的是同一条不变量,
// 但走**管理端路由**:旧实现里 deleteModel 是「事务外读模型 → AddExcludedModel
// (读名单+append+整串覆写,无事务无锁)→ DeleteModel(自己的事务)→ `_ = AuditLog`」,
// 两个并发的 DELETE(同一渠道型上游的两个模型;双管理员或双击两行即可)各自基于
// 同一份旧名单覆写 ⇒ 后写者覆盖前写者,丢掉的名字会在下一轮渠道同步里"复活"。
//
// 判据同样是**确定性交错**:控制事务用 `SELECT … FOR UPDATE` 钉住名单行,放两个
// DELETE 依次进入(修复前阻塞在 SetSetting 的 UPDATE 上、修复后阻塞在事务内的
// SELECT … FOR UPDATE 上),释放后断言名单里**两个名字都在**、模型行全部消失。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// excludedListInDB 直读名单(绕过缓存)。
func excludedListInDB(t *testing.T, db *sql.DB, providerID int64) []string {
	t.Helper()
	key := "gateway.excluded_models." + strconv.FormatInt(providerID, 10)
	var raw string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&raw); err != nil {
		t.Fatalf("读排除名单行失败: %v", err)
	}
	var names []string
	if err := json.Unmarshal([]byte(raw), &names); err != nil {
		t.Fatalf("解析排除名单失败(%q): %v", raw, err)
	}
	return names
}

func TestDeleteModelConcurrentDeletesKeepBothExcludedEntries(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 渠道型上游:创建时即从固定目录同步出两个模型。
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"chan","api_key":"sk","channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("建渠道型上游: %d %s", w.Code, w.Body.String())
	}
	var providerID int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'chan'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query(`SELECT id, name FROM models WHERE provider_id = ? ORDER BY name`, providerID)
	if err != nil {
		t.Fatal(err)
	}
	type modelRow struct {
		id   int64
		name string
	}
	var models []modelRow
	for rows.Next() {
		var m modelRow
		if err := rows.Scan(&m.id, &m.name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		models = append(models, m)
	}
	rows.Close()
	if len(models) != 2 {
		t.Fatalf("前置条件不成立:渠道型上游的模型行 = %d, want 2", len(models))
	}

	// 名单行先存在(生产里第一次删除后即如此):控制事务才锁得住它。
	key := "gateway.excluded_models." + strconv.FormatInt(providerID, 10)
	if err := serverstore.SetSetting(db, key, "[]"); err != nil {
		t.Fatal(err)
	}
	ctrl, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer ctrl.Rollback()
	var locked string
	if err := ctrl.QueryRow(`SELECT value FROM settings WHERE key = ? FOR UPDATE`, key).Scan(&locked); err != nil {
		t.Fatal(err)
	}

	del := func(id int64) chan putOutcome {
		ch := make(chan putOutcome, 1)
		go func() {
			w, _ := adminReq(t, r, "DELETE", "/api/server/admin/models/"+strconv.FormatInt(id, 10), "", hdr)
			ch <- putOutcome{code: w.Code, body: w.Body.String()}
		}()
		return ch
	}

	done1 := del(models[0].id)
	waitForBlockedBackends(t, db, 0, 1)
	done2 := del(models[1].id)
	waitForBlockedBackends(t, db, 0, 2)

	if err := ctrl.Commit(); err != nil { // 放行
		t.Fatal(err)
	}
	for i, ch := range []chan putOutcome{done1, done2} {
		if got := <-ch; got.code != http.StatusOK {
			t.Fatalf("并发 DELETE #%d: %d %s", i+1, got.code, got.body)
		}
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM models WHERE provider_id = ?`, providerID); n != 0 {
		t.Fatalf("并发删除后 models 行 = %d, want 0", n)
	}
	names := excludedListInDB(t, db, providerID)
	got := map[string]bool{}
	for _, n := range names {
		got[n] = true
	}
	t.Logf("并发两次删除后的排除名单 = %v", names)
	for _, m := range models {
		if !got[m.name] {
			t.Fatalf("丢失更新:排除名单 = %v 缺少 %q —— 下一轮渠道同步会把这个被显式删除的模型复活",
				names, m.name)
		}
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'model_delete'`); n != 2 {
		t.Fatalf("model_delete 审计 = %d 条, want 2(审计与删除同事务,不得丢)", n)
	}
	if broken, err := serverstore.VerifyAuditChain(db); err != nil || broken != 0 {
		t.Fatalf("审计哈希链校验失败: broken=%d err=%v", broken, err)
	}
}

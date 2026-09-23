package llmgateway

// 2026-09-23(第三轮 §7.3 A):POST /providers 的半提交。
//
// 缺陷形态(VERIFY.md §9.4 明列的排队项):旧实现是三段各 autocommit ——
//   :290 AddGatewayProvider(插行,自动提交)
//   :303 SyncProviderModels(自己的事务)
//   :304 失败时 `_ = DeleteGatewayProvider(db, p.ID)`(**补偿删除**,错误被吞)
//   :314 `_ = AuditLog(...)`(**审计错误被丢弃**)
// 于是创建侧仍有两条静默半提交:补偿删除自身失败 ⇒ 孤儿上游行;审计写不进去 ⇒
// "创建成功但零审计"。
//
// 修法(§7.3 A):手动型收敛成**一个事务**(插行 + 清单同步 + 审计 AuditLogTx),
// 任一步失败整体回滚、**不再需要补偿删除**;渠道型的渠道同步是**出网**调用,
// 不得放进事务 —— 事务只覆盖"插行 + 审计",出网同步在提交后执行并如实报告结果
// (下面的用例分别钉住这两半)。

import (
	"database/sql"
	"net/http"
	"testing"
)

// installAuditFailureTrigger 注入"指定 action 的审计写入必失败"的触发器。
// 审计写入失败在旧实现里被 `_ =` 吞掉,在新实现里必须让整个事务回滚。
func installAuditFailureTrigger(t *testing.T, db *sql.DB, action string) {
	t.Helper()
	_, err := db.Exec(`
CREATE OR REPLACE FUNCTION r3_block_audit_action() RETURNS trigger AS $$
BEGIN
	IF NEW.action = '` + action + `' THEN
		RAISE EXCEPTION 'r3 injected audit failure for action=%', NEW.action;
	END IF;
	RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER r3_block_audit_action BEFORE INSERT ON audit_logs
	FOR EACH ROW EXECUTE FUNCTION r3_block_audit_action();`)
	if err != nil {
		t.Fatalf("注入审计失败触发器: %v", err)
	}
}

func dropAuditFailureTrigger(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`DROP TRIGGER IF EXISTS r3_block_audit_action ON audit_logs`); err != nil {
		t.Fatalf("撤销审计失败触发器: %v", err)
	}
}

// countRows 是测试用的窄计数助手。
func countRows(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("计数失败(%s): %v", query, err)
	}
	return n
}

// TestAdminProviderCreateAuditFailureRollsBackEverything 是 §7.3 A 的核心判据:
// 审计写不进去 ⇒ 整体回滚,**库里零行**(旧行为:200 + 上游行已落库 + 零审计)。
func TestAdminProviderCreateAuditFailureRollsBackEverything(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	installAuditFailureTrigger(t, db, "provider_create")
	// 不需要 defer 撤销:每个用例一个临时库,结束时整库 DROP。

	w, out := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"p1","base_url":"http://x","api_key":"k1","models":["m1","m2"]}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("审计不可写时创建: 状态 = %d %s, want 500(旧行为是 200 + 零审计)", w.Code, w.Body.String())
	}
	errObj, _ := out["error"].(map[string]any)
	if errObj == nil || errObj["code"] != "INTERNAL" {
		t.Fatalf("失败信封 = %v, want code=INTERNAL", out)
	}
	// 零副作用:provider 行 / 模型行 / 审计 三者都必须是零。
	// (旧实现靠"补偿删除"撤销 provider 行,但那一步的错误没有出口;审计更是
	//  完全没有补偿路径 —— 所以这条断言在旧实现上必然红。)
	if n := countRows(t, db, `SELECT COUNT(*) FROM gateway_providers`); n != 0 {
		t.Fatalf("审计失败后 provider 行 = %d, want 0(半提交:补偿删除没有兜住)", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM models`); n != 0 {
		t.Fatalf("审计失败后 models 行 = %d, want 0", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'provider_create'`); n != 0 {
		t.Fatalf("审计失败后 provider_create 审计 = %d, want 0", n)
	}

	// 反向对照:撤销注入后同一请求必须成功,三样都在(证明上面的"零"不是
	// "整个创建路径坏了"造成的假绿)。
	dropAuditFailureTrigger(t, db)
	if w2, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"p1","base_url":"http://x","api_key":"k1","models":["m1","m2"]}`, hdr); w2.Code != http.StatusOK {
		t.Fatalf("撤销注入后创建: %d %s", w2.Code, w2.Body.String())
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM gateway_providers WHERE name = 'p1'`); n != 1 {
		t.Fatalf("成功路径缺 provider 行: %d", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM models`); n != 2 {
		t.Fatalf("成功路径 models 行 = %d, want 2", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'provider_create'`); n != 1 {
		t.Fatalf("成功路径 provider_create 审计 = %d, want 1(且必须与业务写同事务)", n)
	}
}

// TestAdminProviderCreateManualSyncFailureLeavesNoTrace 钉住"手动型失败即无痕":
// 清单同步失败时 provider 行不能留下(旧实现靠补偿删除,新实现靠事务回滚)。
// 注入是确定性的:模型名里带 NUL(PG 的 TEXT 拒绝 0x00),不依赖网络。
func TestAdminProviderCreateManualSyncFailureLeavesNoTrace(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"pbad","base_url":"http://x","api_key":"k1","models":["m1","bad\u0000name"]}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("清单含 NUL 的创建: 状态 = %d %s, want 500(模型同步失败)", w.Code, w.Body.String())
	}
	if errObj, _ := out["error"].(map[string]any); errObj == nil || errObj["message"] != "模型同步失败" {
		t.Fatalf("失败信封 = %v, want message=模型同步失败", out)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM gateway_providers`); n != 0 {
		t.Fatalf("清单同步失败后 provider 行 = %d, want 0(孤儿上游行)", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM models`); n != 0 {
		t.Fatalf("清单同步失败后 models 行 = %d, want 0", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'provider_create'`); n != 0 {
		t.Fatalf("清单同步失败后 provider_create 审计 = %d, want 0", n)
	}
}

// TestAdminProviderCreateChannelSyncRunsAfterCommit 钉住 §7.3 A 的**不对称性**:
// 渠道型的渠道同步是出网动作,必须在事务**提交之后**执行 —— 出网期间另一条连接
// 必须已经看得见 provider 行(用例在 fetchFn 里直读库来证明这件事),而同步失败
// 只进响应体的 sync 字段,不回滚创建。
func TestAdminProviderCreateChannelSyncRunsAfterCommit(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	visibleDuringSync := -1
	prev := syncFetchFn
	syncFetchFn = func(string) ([]byte, error) {
		// 出网同步若被塞进事务,这里读到的会是 0(未提交);提交后执行才会是 1。
		visibleDuringSync = countRows(t, db, `SELECT COUNT(*) FROM gateway_providers WHERE name = 'chan-a'`)
		return []byte(`{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}`), nil
	}
	t.Cleanup(func() { syncFetchFn = prev })

	w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"chan-a","api_key":"sk","channel":"deepseek"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("建渠道型上游: %d %s", w.Code, w.Body.String())
	}
	if visibleDuringSync != 1 {
		t.Fatalf("出网同步期间另一条连接看到 provider 行 = %d, want 1"+
			"(说明同步没有在事务提交之后执行)", visibleDuringSync)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'provider_create'`); n != 1 {
		t.Fatalf("渠道型创建的 provider_create 审计 = %d, want 1", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM models`); n != 2 {
		t.Fatalf("渠道型创建后 models 行 = %d, want 2(提交后同步出来的目录)", n)
	}

	// 出网失败:创建**不回滚**,失败如实落在响应体的 sync.error 里(既有契约)。
	syncFetchFn = func(string) ([]byte, error) { return nil, http.ErrHandlerTimeout }
	w2, out2 := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"chan-b","api_key":"sk","channel":"deepseek"}`, hdr)
	if w2.Code != http.StatusOK {
		t.Fatalf("渠道同步失败不得让创建失败: %d %s", w2.Code, w2.Body.String())
	}
	sync, _ := out2["sync"].(map[string]any)
	if sync == nil || sync["error"] == "" || sync["error"] == nil {
		t.Fatalf("响应缺 sync.error,出网失败被吞: %s", w2.Body.String())
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM gateway_providers WHERE name = 'chan-b'`); n != 1 {
		t.Fatalf("渠道同步失败却回滚了创建: chan-b 行 = %d, want 1", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'provider_create'`); n != 2 {
		t.Fatalf("provider_create 审计 = %d, want 2", n)
	}
}

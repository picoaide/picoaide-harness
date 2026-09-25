package llmgateway

// R16C-01（审计 2026-09-25，P1）：模型目录是**"改配置即改钱"**的路径，它的审计
// 必须与业务写同事务。
//
// 缺陷形态（修复前，探针实测）：`PUT /api/server/admin/models/:id` 是
// 「读原值（autocommit）→ UpdateModel（自己的事务）→ `_ = AuditLog`（fire-and-forget）」
// 三段各自提交。只让 `model_update` 这一条审计写不进去（表级 CHECK）时：
//
//	HTTP 200（业务成功）
//	models.input_price_per_1m 1.0 → 100.0（价格真的改了 100 倍）
//	audit_logs 里 model_update = 0 行、服务端日志 0 行
//
// 而同文件里的孪生路径 `PUT /providers/:id` 早已是"审计与业务写同事务"（失败即
// 500 + 整体回滚），规则真源写在 `serverstore/audit.go` 的 AuditLogTx 头注释里。
// `CreateModel` 同族（两条分支的审计都在事务外）。
//
// 判据（本文件）：阻断审计写入 ⇒ 请求必须 5xx，且那一行**逐列不变**、审计条数不变。
// 正向对照：解除阻断后同一请求必须照旧 200 + 改价 + 落审计（防"整个写路径都坏了"
// 造成的假绿）。

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// blockAuditAction 用表级 CHECK **精确**阻断某个 action 的审计写入（与探针同一手法）。
//
// 先删同 action 的存量行：`ALTER TABLE … ADD CONSTRAINT` 会校验既有行，表里已经有
// 一条同 action 的审计时约束根本加不上（探针第一版就栽在这里 —— 约束没加上，于是
// "审计 0 行"的断言假绿）。
func blockAuditAction(t *testing.T, db *sql.DB, action string) {
	t.Helper()
	if _, err := db.Exec(`DELETE FROM audit_logs WHERE action = ?`, action); err != nil {
		t.Fatalf("清理 %s 审计行: %v", action, err)
	}
	// 约束名/表达式里的 action 由测试写死（非用户输入），无需参数化（DDL 也不接受参数）。
	ddl := fmt.Sprintf(`ALTER TABLE audit_logs ADD CONSTRAINT r16c_block_%s CHECK (action <> '%s')`, action, action)
	if _, err := db.Exec(ddl); err != nil {
		t.Fatalf("加阻断约束失败（判据根本咬不到）: %v", err)
	}
}

// unblockAuditAction 解除阻断（正向对照用）。
func unblockAuditAction(t *testing.T, db *sql.DB, action string) {
	t.Helper()
	if _, err := db.Exec(fmt.Sprintf(`ALTER TABLE audit_logs DROP CONSTRAINT r16c_block_%s`, action)); err != nil {
		t.Fatalf("解除阻断约束失败: %v", err)
	}
}

// modelRowDump 把模型行的**运营方配置列**拼成可逐字比较的字符串。
func modelRowDump(t *testing.T, db *sql.DB, id int64) string {
	t.Helper()
	var name, display, in, out, cache, off, params, mods string
	var providerID int64
	if err := db.QueryRow(`SELECT name, provider_id, COALESCE(display_name,''),
		COALESCE(CAST(input_price_per_1m AS TEXT),'-'), COALESCE(CAST(output_price_per_1m AS TEXT),'-'),
		COALESCE(CAST(cache_input_price_per_1m AS TEXT),'-'), COALESCE(CAST(offpeak_discount AS TEXT),'-'),
		COALESCE(default_params,''), COALESCE(input_modalities,'')
		FROM models WHERE id = ?`, id).Scan(&name, &providerID, &display, &in, &out, &cache, &off, &params, &mods); err != nil {
		t.Fatalf("读模型行失败: %v", err)
	}
	return fmt.Sprintf("name=%s|provider=%d|display=%s|in=%s|out=%s|cache=%s|off=%s|params=%s|mods=%s",
		name, providerID, display, in, out, cache, off, params, mods)
}

func auditCount(t *testing.T, db *sql.DB, action string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = ?`, action).Scan(&n); err != nil {
		t.Fatalf("统计审计行失败: %v", err)
	}
	return n
}

// setupManualModel 建一个手动型上游 + 一个模型行，返回模型 id。
func setupManualModel(t *testing.T, r http.Handler, db *sql.DB, hdr map[string]string) int64 {
	t.Helper()
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"http://x","api_key":"sk-x","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("建上游: %d %s", w.Code, w.Body.String())
	}
	// 上游创建时会把 models 清单同步成模型行（无价）；这里给它定价。
	var id int64
	if err := db.QueryRow(`SELECT id FROM models WHERE name = 'm1'`).Scan(&id); err != nil {
		t.Fatalf("上游清单未建模型行: %v", err)
	}
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/server/admin/models/%d", id),
		`{"input_price_per_1m":1,"output_price_per_1m":2}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("给 m1 定价: %d %s", w.Code, w.Body.String())
	}
	return id
}

// TestAdminModelUpdateAuditFailureRollsBackPriceChange 是 R16C-01 的核心判据。
func TestAdminModelUpdateAuditFailureRollsBackPriceChange(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	id := setupManualModel(t, r, db, hdr)

	blockAuditAction(t, db, "model_update")
	before := modelRowDump(t, db, id)
	beforeAudit := auditCount(t, db, "model_update")

	w, out := adminReq(t, r, "PUT", fmt.Sprintf("/api/server/admin/models/%d", id),
		`{"input_price_per_1m":100,"output_price_per_1m":200}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("审计写不进去时状态 = %d %s, want 500 —— 改价必须与审计同事务（修前是 200）",
			w.Code, w.Body.String())
	}
	if errObj, ok := out["error"].(map[string]any); !ok || errObj["code"] != "INTERNAL" {
		t.Fatalf("失败响应不是 INTERNAL 信封: %s", w.Body.String())
	}
	if after := modelRowDump(t, db, id); after != before {
		t.Fatalf("审计失败却改了模型行（价格已落库）:\n before=%s\n after =%s", before, after)
	}
	if n := auditCount(t, db, "model_update"); n != beforeAudit {
		t.Fatalf("被阻断的审计竟然落库: %d → %d", beforeAudit, n)
	}

	// 正向对照：解除阻断后同一请求必须 200 + 改价 + 落一条审计（明细口径不变）。
	unblockAuditAction(t, db, "model_update")
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/server/admin/models/%d", id),
		`{"input_price_per_1m":100,"output_price_per_1m":200}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("正常改价: %d %s", w.Code, w.Body.String())
	}
	after := modelRowDump(t, db, id)
	if !strings.Contains(after, "in=100") || !strings.Contains(after, "out=200") {
		t.Fatalf("正常路径没有真的改价: %s", after)
	}
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action='model_update' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatalf("正常路径缺 model_update 审计: %v", err)
	}
	if !strings.Contains(detail, "input:1→100") {
		t.Fatalf("审计明细 = %q, want 含 input:1→100（口径逐字不变）", detail)
	}
}

// TestAdminModelCreateAuditFailureRollsBackRow 钉住同族的建行路径：
// 审计写不进去 ⇒ 模型行不得存在（修前是 200 + 行已落库 + 审计 0 行）。
func TestAdminModelCreateAuditFailureRollsBackRow(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	// 清单留空：本用例要测的是**建模型行**那一步，清单非空会在建上游时就同步出行。
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"http://x","api_key":"sk-x","models":[]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("建上游: %d %s", w.Code, w.Body.String())
	}
	blockAuditAction(t, db, "model_create")

	w, _ := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"m1","provider_id":1,"input_price_per_1m":1,"output_price_per_1m":2}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("审计写不进去时建模型状态 = %d %s, want 500", w.Code, w.Body.String())
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM models WHERE name = 'm1'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("审计失败却建出了模型行: %d 行", n)
	}

	// 正向对照。
	unblockAuditAction(t, db, "model_create")
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"m1","provider_id":1,"input_price_per_1m":1,"output_price_per_1m":2}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("正常建模型: %d %s", w.Code, w.Body.String())
	}
	if n := auditCount(t, db, "model_create"); n != 1 {
		t.Fatalf("正常路径 model_create 审计 = %d 行, want 1", n)
	}
}

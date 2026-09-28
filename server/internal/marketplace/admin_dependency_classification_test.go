package marketplace

// R23-V3-B2 / B3（复审 2026-09-27，**P2**）的判据：管理面"上下架"与"渠道守卫"两条
// 依赖故障路径必须分类正确、且必须有日志。
//
// ## 缺陷形态（判据要杀的东西）
//
//	① **写错误被吞**（B2）：`deleteAgentAdmin` / `enableAgentAdmin` 用
//	   `_ = SetAppEnabled(...)` 之后**无条件**回 `200 {"ok":true}`。真 PG + BEFORE UPDATE
//	   触发器实测（UPDATE 被拒，SQLSTATE P0001）仍回 200 ⇒ **下架静默失效**：管理员看到
//	   "下架成功"而 `apps.enabled` 一字未改，员工侧仍可继续安装/使用。
//	② **依赖故障塌成 404**（B3）：管理面 4 条路由（技能对 + 智能体对）把
//	   `err != nil || channel != market` 合并成 404「不存在」。把 `apps` 表改名后
//	   4/4 条路由全部 404 且**零日志** —— 管理员把一次 PG 抖动读成终态；而同一台服务端在
//	   同一次故障下员工面回 500（口径分裂）。
//
// ## 修后契约（本文件钉住的三条）
//
//	① UPDATE 被拒 ⇒ **500**（绝不再是 200）+ 日志 + DB 状态未变（`enabled` 保持原值）；
//	② 依赖故障（表不可读）⇒ 4 条路由**全部 500** + 日志（同一口径）；
//	③ 反向：真"不存在/跨渠道"仍必须是 **404**（不泄露存在性），正常上下架仍 200。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-21/REPORT.md）
//
//   - 把 `if err := SetAppEnabled(...); err != nil` 改回 `_ =` + 无条件 200 ⇒ ①红；
//   - 把 `requireMarketAdminApp` 的分类合回 `err != nil || channel != market ⇒ 404`
//     ⇒ ②红（依赖故障变回 404）；
//   - 去掉 500 分支的 `logMarketDependencyFailure` ⇒ ②的日志断言红。

import (
	"bytes"
	"database/sql"
	"log"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// captureMarketLogs 把标准 logger 的输出抓下来跑 fn（本仓的依赖故障分类都走 `log.Printf`）。
//
// 顺序执行（本包用例不并行）：捕获期间任何日志都算数，闭包结束后恢复原输出。
func captureMarketLogs(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)
	fn()
	return buf.String()
}

// seedMarketApp 建一条市场渠道的 app 行（技能/智能体都由 apps 表承载）。
func seedMarketApp(t *testing.T, db *sql.DB, kind, name string) {
	t.Helper()
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: kind, AppID: name, Title: name, Owner: "boss",
		Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatalf("播种 %s/%s: %v", kind, name, err)
	}
}

// appEnabled 读回 `apps.enabled`（0/1）——"写有没有真的落库"的唯一判据。
func appEnabled(t *testing.T, db *sql.DB, kind, name string) int {
	t.Helper()
	a, err := serverstore.GetApp(db, kind, name)
	if err != nil {
		t.Fatalf("读回 %s/%s: %v", kind, name, err)
	}
	return a.Enabled
}

// denyUpdatesOn 给 `apps` 装着 "更新必失败" 的 BEFORE UPDATE 触发器（按 app_id 限定，
// 与复审 W3 的夹具同形），并**自校准**：该连接上 UPDATE 确实被拒。
//
// 自校准不能省：没有它，一条"夹具其实没走到写路径"的用例会假绿（判据通过只是因为
// 请求根本没打到这里）。
func denyUpdatesOn(t *testing.T, db *sql.DB, appID string) {
	t.Helper()
	if _, err := db.Exec(`CREATE OR REPLACE FUNCTION r23_deny_app_update() RETURNS trigger AS $$
		BEGIN
			IF OLD.app_id = '` + appID + `' THEN
				RAISE EXCEPTION 'r23: update denied by trigger';
			END IF;
			RETURN NEW;
		END; $$ LANGUAGE plpgsql`); err != nil {
		t.Fatalf("建触发器函数: %v", err)
	}
	if _, err := db.Exec(`CREATE TRIGGER r23_deny_app_update BEFORE UPDATE ON apps
		FOR EACH ROW EXECUTE FUNCTION r23_deny_app_update()`); err != nil {
		t.Fatalf("建触发器: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DROP TRIGGER IF EXISTS r23_deny_app_update ON apps`)
		_, _ = db.Exec(`DROP FUNCTION IF EXISTS r23_deny_app_update()`)
	})
	// —— 自校准：这条连接上对该行的 UPDATE 必须被触发器拒绝（SQLSTATE P0001）。——
	_, err := db.Exec(`UPDATE apps SET enabled = enabled WHERE app_id = $1`, appID)
	if err == nil {
		t.Fatal("自校准失败：触发器在场时 UPDATE 竟然成功 —— 判据会假绿")
	}
	if !strings.Contains(err.Error(), "update denied by trigger") {
		t.Fatalf("自校准失败：UPDATE 失败的原因不是触发器（%v）", err)
	}
}

// TestAgentAdminWriteFailureIsNotReportedAsSuccess 是 ① 的端到端判据（技能对是兄弟实现，
// 同一分类出口，这里覆盖智能体对 —— 复审 W3 实测的反例正是这两条）。
func TestAgentAdminWriteFailureIsNotReportedAsSuccess(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	const name = "swallow-agent"
	seedMarketApp(t, db, serverstore.AppKindAgent, name)
	denyUpdatesOn(t, db, name)

	logs := captureMarketLogs(t, func() {
		w, out := mreq(t, r, "DELETE", "/api/server/admin/agents/"+name, "", hdr)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("下架的 UPDATE 被拒时返回 %d %s，want 500 —— "+
				"修前这里无条件回 200 {\"ok\":true}，管理员看到「已下架」而库里一字未改",
				w.Code, w.Body.String())
		}
		if code := errorCode(out); code != "INTERNAL" {
			t.Fatalf("错误码 = %q, want INTERNAL（统一信封）", code)
		}
		w, _ = mreq(t, r, "POST", "/api/server/admin/agents/"+name+"/enable", "", hdr)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("上架的 UPDATE 被拒时返回 %d，want 500", w.Code)
		}
	})
	if !strings.Contains(logs, "dependency, not a rejection") {
		t.Fatalf("写失败没有留下任何日志（抓到 %q）—— 排障时不可见", logs)
	}
	if got := appEnabled(t, db, serverstore.AppKindAgent, name); got != 1 {
		t.Fatalf("apps.enabled = %d, want 1（写失败 ⇒ 数据库状态必须未变）", got)
	}

	// —— 正向对照：触发器撤掉后，同一个动作必须真的生效并回 200。——
	if _, err := db.Exec(`DROP TRIGGER IF EXISTS r23_deny_app_update ON apps`); err != nil {
		t.Fatal(err)
	}
	w, _ := mreq(t, r, "DELETE", "/api/server/admin/agents/"+name, "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("正常下架 = %d %s, want 200", w.Code, w.Body.String())
	}
	if got := appEnabled(t, db, serverstore.AppKindAgent, name); got != 0 {
		t.Fatalf("正常下架后 apps.enabled = %d, want 0", got)
	}
	w, _ = mreq(t, r, "POST", "/api/server/admin/agents/"+name+"/enable", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("正常上架 = %d %s, want 200", w.Code, w.Body.String())
	}
	if got := appEnabled(t, db, serverstore.AppKindAgent, name); got != 1 {
		t.Fatalf("正常上架后 apps.enabled = %d, want 1", got)
	}
}

// TestAdminMarketGuardsClassifyDependencyFailure 是 ②③ 的端到端判据：
// 把 `apps` 表改名制造**依赖故障**，管理面 4 条路由必须 500 + 日志；而"真不存在"
// 仍是 404（同形、不泄露存在性），正常路径仍 200。
func TestAdminMarketGuardsClassifyDependencyFailure(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	seedMarketApp(t, db, serverstore.AppKindAgent, "guard-agent")
	seedMarketApp(t, db, serverstore.AppKindSkill, "guard-skill")

	routes := []struct{ method, path string }{
		{"DELETE", "/api/server/admin/skills/guard-skill"},
		{"POST", "/api/server/admin/skills/guard-skill/enable"},
		{"DELETE", "/api/server/admin/agents/guard-agent"},
		{"POST", "/api/server/admin/agents/guard-agent/enable"},
	}

	// —— 对照①：真不存在（apps 表正常）⇒ 4 条都必须是 404（与"跨渠道"同形）。——
	for _, rt := range routes {
		missing := strings.Replace(rt.path, "guard-", "no-such-", 1)
		w, out := mreq(t, r, rt.method, missing, "", hdr)
		if w.Code != http.StatusNotFound {
			t.Fatalf("对照：%s %s（不存在）= %d %s, want 404", rt.method, missing, w.Code, w.Body.String())
		}
		if code := errorCode(out); code != "NOT_FOUND" {
			t.Fatalf("对照：%s %s 错误码 = %q, want NOT_FOUND", rt.method, missing, code)
		}
	}

	// —— 判据：依赖故障（apps 表不可读）⇒ 4 条都必须 500 + 日志，绝不塌成 404。——
	if _, err := db.Exec(`ALTER TABLE apps RENAME TO apps_r23_probe`); err != nil {
		t.Fatalf("制造依赖故障: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`ALTER TABLE apps_r23_probe RENAME TO apps`) })

	logs := captureMarketLogs(t, func() {
		for _, rt := range routes {
			w, out := mreq(t, r, rt.method, rt.path, "", hdr)
			if w.Code != http.StatusInternalServerError {
				t.Fatalf("依赖故障下 %s %s = %d %s, want 500 —— "+
					"把 DB 故障塌成 404 会让管理员把一次 PG 抖动读成「这个技能/智能体不存在」",
					rt.method, rt.path, w.Code, w.Body.String())
			}
			if code := errorCode(out); code != "INTERNAL" {
				t.Fatalf("依赖故障下 %s %s 错误码 = %q, want INTERNAL", rt.method, rt.path, code)
			}
		}
	})
	if n := strings.Count(logs, "dependency, not a rejection"); n != len(routes) {
		t.Fatalf("依赖故障日志条数 = %d, want %d（4 条路由每条都要留痕）:\n%s", n, len(routes), logs)
	}

	// —— 对照②：故障恢复后同一批路由照常工作（200 或 404，但不再是 500）。——
	if _, err := db.Exec(`ALTER TABLE apps_r23_probe RENAME TO apps`); err != nil {
		t.Fatalf("恢复 apps 表: %v", err)
	}
	for _, rt := range routes {
		w, _ := mreq(t, r, rt.method, rt.path, "", hdr)
		if w.Code != http.StatusOK {
			t.Fatalf("恢复后 %s %s = %d %s, want 200", rt.method, rt.path, w.Code, w.Body.String())
		}
	}
}

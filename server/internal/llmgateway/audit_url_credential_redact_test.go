package llmgateway

import (
	"database/sql"
	"strings"
	"testing"
)

// ===========================================================================
// `PUT /gateway` 的**其余 URL 写点**也必须写入侧省略凭据（第二十八轮 FIX-40 ②）
// ===========================================================================
//
// 第二十七轮 AA2-03 只修了 `web.error_reporting_dsn`（被点名的那一条），而同一个
// `setGatewayConfig` 里还有两个**零准入校验**的 URL 写入点，走的是同一条明文路径：
//
//	detail="GlitchTip地址:(空)→https://<user>:<pass>@glitchtip.example.com"   ← 实测
//	detail="对外地址:(空)→https://<user>:<pass>@harness.example.com"          ← 实测
//
// 两个键都没有任何校验（`https://<user>:<pass>@host` 直接入库），而审计行参与哈希链、
// 写下之后不可改写、保留 180 天、还会进 CSV 导出与库备份 ⇒ 折叠必须在写入侧。
//
// 判据为什么必须直读 audit_logs 行：读侧（`RedactAuditDetailForViewer`）按查看者权限
// 折叠，覆盖不了 CSV 导出与库备份。所以下面全部断言直读 `SELECT detail FROM audit_logs`
// （经由既有 helper `gwfAudit`），而不是走 /audit 的响应。
//
// 完整写点清单（含"哪些不是 URL/凭据、为什么"）由
// `audit_set_setting_inventory_test.go` 的登记表双向对账 —— 本文件只钉**折叠后的形状**。
// ===========================================================================

const (
	glitchTipTestUser   = "GLITCHTIPUSER"
	glitchTipTestSecret = "GLITCHTIPSECRET"
	glitchTipTestValue  = "https://" + glitchTipTestUser + ":" + glitchTipTestSecret + "@glitchtip.example.com"

	serverBaseTestUser   = "SERVERBASEUSER"
	serverBaseTestSecret = "SERVERBASESECRET"
	serverBaseTestValue  = "https://" + serverBaseTestUser + ":" + serverBaseTestSecret + "@harness.example.com"
)

// 保存带 userinfo 的 GlitchTip 地址：审计行不得含 userinfo/完整 URL，设置值必须原样。
func TestGatewayConfigAuditOmitsGlitchTipBaseURLCredential(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"glitchtip_base_url":"`+glitchTipTestValue+`"}`, hdr)
	if w.Code != 200 {
		t.Fatalf("保存 GlitchTip 地址 = %d %s", w.Code, w.Body.String())
	}
	// 折叠只影响审计明细：真正生效的设置值必须完整（否则是把安全修复做成功能回归）。
	stored, ok := gwcSetting(t, db, "web.glitchtip_base_url")
	if !ok || stored != glitchTipTestValue {
		t.Fatalf("设置值 = %q (ok=%v), want 原样 %q", stored, ok, glitchTipTestValue)
	}
	assertGatewayAuditRow(t, db,
		"GlitchTip地址:(空)→https://glitchtip.example.com/…（已脱敏）",
		glitchTipTestUser, glitchTipTestSecret, glitchTipTestValue)
}

// 保存带 userinfo 的对外地址：同上（同一条路径、同一个折叠实现）。
func TestGatewayConfigAuditOmitsServerBaseURLCredential(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"server_base_url":"`+serverBaseTestValue+`"}`, hdr)
	if w.Code != 200 {
		t.Fatalf("保存对外地址 = %d %s", w.Code, w.Body.String())
	}
	stored, ok := gwcSetting(t, db, "server.base_url")
	if !ok || stored != serverBaseTestValue {
		t.Fatalf("设置值 = %q (ok=%v), want 原样 %q", stored, ok, serverBaseTestValue)
	}
	assertGatewayAuditRow(t, db,
		"对外地址:(空)→https://harness.example.com/…（已脱敏）",
		serverBaseTestUser, serverBaseTestSecret, serverBaseTestValue)
}

// 只改凭据（host 不变）的轮换**必须仍然留痕**：变更判定用原值，不是折叠后的值。
func TestGatewayConfigAuditStillRecordsGlitchTipCredentialRotation(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"glitchtip_base_url":"https://FIRSTUSER@glitchtip.example.com"}`, hdr); w.Code != 200 {
		t.Fatalf("首次保存 = %d %s", w.Code, w.Body.String())
	}
	rotated := "https://SECONDUSER@glitchtip.example.com"
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"glitchtip_base_url":"`+rotated+`"}`, hdr); w.Code != 200 {
		t.Fatalf("轮换保存 = %d %s", w.Code, w.Body.String())
	}
	rows := gwfAudit(t, db, "gateway_config")
	if len(rows) != 2 {
		t.Fatalf("审计行 = %d, want 2（只换凭据的轮换必须留痕）：%v", len(rows), rows)
	}
	last := rows[1]
	if !strings.Contains(last, "GlitchTip地址:https://glitchtip.example.com/…（已脱敏）→https://glitchtip.example.com/…（已脱敏）") {
		t.Fatalf("轮换明细 = %q，want 两侧都是折叠形态（且旧值不是空）", last)
	}
	for _, banned := range []string{"FIRSTUSER", "SECONDUSER"} {
		if strings.Contains(last, banned) {
			t.Errorf("轮换明细含凭据形态 %q：%q", banned, last)
		}
	}
	if stored, _ := gwcSetting(t, db, "web.glitchtip_base_url"); stored != rotated {
		t.Fatalf("轮换后的设置值 = %q, want %q", stored, rotated)
	}
}

// 清空（空值 = 不配）也要能读出来，且不把旧地址带进明细 —— 与 DSN 的 `(空)` 形态一致。
func TestGatewayConfigAuditOmitsClearedGlitchTipBaseURL(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"glitchtip_base_url":"`+glitchTipTestValue+`"}`, hdr); w.Code != 200 {
		t.Fatalf("首次保存 = %d %s", w.Code, w.Body.String())
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"glitchtip_base_url":""}`, hdr); w.Code != 200 {
		t.Fatalf("清空 = %d %s", w.Code, w.Body.String())
	}
	rows := gwfAudit(t, db, "gateway_config")
	last := rows[len(rows)-1]
	if !strings.HasSuffix(last, "→(空)") {
		t.Fatalf("清空明细 = %q，want 以 →(空) 收尾", last)
	}
	for _, banned := range []string{glitchTipTestUser, glitchTipTestSecret} {
		if strings.Contains(last, banned) {
			t.Errorf("清空明细仍含凭据形态 %q：%q", banned, last)
		}
	}
}

// 非 URL 字段的明细必须与修前**逐字相同**（折叠只针对 URL/凭据型取值，不许顺带改样）。
func TestGatewayConfigAuditKeepsNonURLCredentialFieldsVerbatim(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"glitchtip_organization":"example-org","max_file_refs":"321"}`, hdr); w.Code != 200 {
		t.Fatalf("保存 = %d %s", w.Code, w.Body.String())
	}
	rows := gwfAudit(t, db, "gateway_config")
	if len(rows) != 1 {
		t.Fatalf("审计行 = %d, want 1（%v）", len(rows), rows)
	}
	for _, want := range []string{"GlitchTip组织:(空)→example-org", "单请求文件引用上限:(空)→321"} {
		if !strings.Contains(rows[0], want) {
			t.Errorf("明细 = %q，want 含 %q", rows[0], want)
		}
	}
}

// assertGatewayAuditRow 直读 audit_logs（不经读侧 API）断言最后一条 gateway_config 明细：
// 含期望的折叠形态，且**不含**任何凭据形态。
func assertGatewayAuditRow(t *testing.T, db *sql.DB, want string, banned ...string) {
	t.Helper()
	rows := gwfAudit(t, db, "gateway_config")
	if len(rows) != 1 {
		t.Fatalf("审计行 = %d, want 1（%v）", len(rows), rows)
	}
	detail := rows[0]
	for _, secret := range append(append([]string{}, banned...), "@") {
		if strings.Contains(detail, secret) {
			t.Errorf("审计 detail 含凭据形态 %q：%q", secret, detail)
		}
	}
	if !strings.Contains(detail, want) {
		t.Fatalf("审计 detail = %q，want 含 %q（保留 host 才可诊断）", detail, want)
	}
}

package llmgateway

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 修复轮 1(F-07)回归防线:库里存着**被新校验拒绝**的历史 DSN 时,
// 「网关」页保存无关配置不能被拦住。
//
// 现场链路:旧版 webadmin 零校验,把 `http://…@localhost:8000/1` 照收入库;
// 「网关」页没有 DSN 输入框,它 GET 整份配置后 `{ ...cfg }` 原样回提交 ——
// 早期实现只看"字段是否出现",于是该页保存任何无关配置都 400,管理员在本页
// 无法自救(复核员实测:A) PUT {rate_limit} → 200;B) 整份回提交 → 400)。
func TestGatewaySaveIgnoresUnchangedLegacyBadDSN(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 用合成公钥(仓库源码禁止出现真实 GlitchTip 域名/公钥 —— 红线 5)。
	const legacyBadDSN = "http://0123456789abcdef0123456789abcdef@localhost:8000/1"
	if err := serverstore.SetSetting(db, "web.error_reporting_dsn", legacyBadDSN); err != nil {
		t.Fatal(err)
	}

	// (A) 不带 dsn 字段的局部更新:必须成功。
	w, out := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"rate_limit":321}`, hdr)
	if w.Code != 200 {
		t.Fatalf("partial update rejected: %d %s", w.Code, w.Body.String())
	}

	// (B) 前端真实行为:GET 整份对象 → 只改一个字段 → 整份回提交。
	// 这里等价于把 GET 下发的 error_reporting_dsn 原样带上(值未变化)。
	w2, out2 := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"322","error_reporting_dsn":"`+legacyBadDSN+`"}`, hdr)
	if w2.Code != 200 {
		t.Fatalf("unchanged legacy bad DSN blocked an unrelated save: %d %s", w2.Code, w2.Body.String())
	}
	if got, _, _ := serverstore.GetSetting(db, "gateway.rate_limit"); got != "322" {
		t.Fatalf("rate_limit not saved: %q (want 322)", got)
	}
	// 但要如实告警:库中现值不可用(不能把坏配置渲染成一切正常)。
	warnings, _ := out2["warnings"].([]any)
	found := false
	for _, raw := range warnings {
		if text, ok := raw.(string); ok && strings.Contains(text, "库中现有值不可用") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a warning about the unusable stored DSN, got %v", out2["warnings"])
	}
	if got, _, _ := serverstore.GetSetting(db, "web.error_reporting_dsn"); got != legacyBadDSN {
		t.Fatalf("stored DSN must stay untouched, got %q", got)
	}
	_ = out
}

// F-07 的另一半:把同一个坏值**改成另一个坏值**仍然必须拒绝(不能借"未变化"绕过)。
func TestGatewaySaveRejectsChangingToAnotherBadDSN(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	const legacyBadDSN = "http://key@localhost:8000/1"
	if err := serverstore.SetSetting(db, "web.error_reporting_dsn", legacyBadDSN); err != nil {
		t.Fatal(err)
	}
	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":"http://other@127.0.0.1:9000/2"}`, hdr)
	if w.Code != 400 {
		t.Fatalf("changing to another bad DSN must be rejected, got %d %s", w.Code, w.Body.String())
	}
	// 也不许把好值换成坏值。
	w2, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":"http://key@glitchtip.example.com/1"}`, hdr)
	if w2.Code != 200 {
		t.Fatalf("valid DSN rejected: %d %s", w2.Code, w2.Body.String())
	}
	w3, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":"http://key@localhost:8000/1"}`, hdr)
	if w3.Code != 400 {
		t.Fatalf("good→bad must be rejected, got %d", w3.Code)
	}
}

// 修复轮 1(F-13):跨字段一致性 + 长度上限。
func TestErrorReportingEnabledRequiresDSN(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_enabled":true,"error_reporting_dsn":""}`, hdr)
	if w.Code != 400 {
		t.Fatalf("enabled=true with empty DSN must be rejected, got %d %s", w.Code, w.Body.String())
	}
	if env, _, _ := serverstore.GetSetting(db, "web.error_reporting_enabled"); env != "" {
		t.Fatalf("nothing may be written on rejection, enabled=%q", env)
	}
	errBody, _ := out["error"].(map[string]any)
	if code, _ := errBody["code"].(string); code != "VALIDATION" {
		t.Fatalf("expected VALIDATION envelope, got %v", out)
	}

	// 单独打开开关(DSN 已存在)必须放行。
	if err := serverstore.SetSetting(db, "web.error_reporting_dsn", "https://key@glitchtip.example.com/1"); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"error_reporting_enabled":true}`, hdr); w.Code != 200 {
		t.Fatalf("enabling with a stored DSN must pass, got %d %s", w.Code, w.Body.String())
	}
	// 关闭开关 + 清空 DSN 是合法组合(允许停用)。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_enabled":false,"error_reporting_dsn":""}`, hdr); w.Code != 200 {
		t.Fatalf("disabling + clearing must pass, got %d %s", w.Code, w.Body.String())
	}

	// 超长 DSN 必须被拒且不入库。
	long := "http://key@" + strings.Repeat("a", 8000) + ".example.com/1"
	w2, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":"`+long+`"}`, hdr)
	if w2.Code != 400 {
		t.Fatalf("over-long DSN must be rejected, got %d", w2.Code)
	}
	if stored, _, _ := serverstore.GetSetting(db, "web.error_reporting_dsn"); len(stored) > ErrorReportingDSNMaxLength {
		t.Fatalf("over-long DSN must not be stored, stored_len=%d", len(stored))
	}
}

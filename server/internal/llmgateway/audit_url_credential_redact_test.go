package llmgateway

import (
	"database/sql"
	"net/http"
	"strconv"
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

// ===========================================================================
// `provider_*` 的三条审计明细也必须写入侧省略凭据（第二十九轮 FIX-44 ①）
// ===========================================================================
//
// 缺陷形态与上面两条**同族**，但**不是 settings 写点**（所以不在
// `audit_set_setting_inventory_test.go` 的登记表扫描根里 —— 那张表的扫描面是
// `admin.go` 的 `auditSetSetting*` 调用点）：
//
//	POST /api/server/admin/providers {"base_url":"https://llm.example.com/v1?accessToken=…"}
//	⇒ 200（`validateUpstreamBaseURL` 只拒 userinfo / 云 metadata，**不拒凭据型查询串**）
//	⇒ provider_create / provider_update / provider_delete 的 detail 原样带上它。
//
// 与 DSN/GlitchTip 同样的三条理由决定必须**写入侧**折叠：detail 参与哈希链、写下之后
// 不可改写、默认保留 180 天，且会进 CSV 导出与库备份 —— 读侧按查看者权限折叠
// （`RedactAuditDetailForViewer`）覆盖不了导出与备份。
//
// 折叠器复用**同一个** `redactURLCredentialForAudit`（唯一实现，第二十七/二十八轮建立），
// 因此 provider 的 base_url 也只留 `scheme://host/…（已脱敏）`。这是**有意**的取舍：
// 写侧是"不可变 + 无权限门"的永久面，取值域必须比读侧宽，所以干净的
// `?api-version=2024-01-01` 也一并折叠 —— 那个**代价**由
// `TestProviderAuditFoldsCleanQueryStringToo` 钉成判据，而不是留成注释。
//
// 为什么不用 `serverauth.auditSensitiveQueryParams` 做"按参数名折叠"（第二十九轮的另一
// 候选方案）：它是一张 webhook 导向的 30 个名字的白名单，缺云厂商预签名参数族
// （`X-Amz-Signature`/`X-Amz-Credential`/`X-Amz-Security-Token`/`X-Goog-Signature`/
// `SharedAccessSignature`…），且其文件头自己认账三种不可覆盖形态；再引入第二种粒度
// 既少挡一类凭据、又多一份实现。论证见 temp/r21/fix-44/REPORT.md。
//
// 判据全部**直读** `SELECT detail FROM audit_logs`（helper `gwfAudit`），不走 /audit 响应。
// ===========================================================================

const (
	providerQueryToken = "QUERYSECRETTOKEN"
	providerQueryURL   = "https://llm.example.com/v1?accessToken=" + providerQueryToken
)

// assertProviderAuditRow 直读 audit_logs 断言**最后一条**该动作的明细。
func assertProviderAuditRow(t *testing.T, db *sql.DB, action, want string, banned ...string) string {
	t.Helper()
	rows := gwfAudit(t, db, action)
	if len(rows) == 0 {
		t.Fatalf("%s 审计缺失", action)
	}
	detail := rows[len(rows)-1]
	for _, secret := range banned {
		if strings.Contains(detail, secret) {
			t.Errorf("%s 明细含凭据形态 %q：%q", action, secret, detail)
		}
	}
	if !strings.Contains(detail, want) {
		t.Fatalf("%s 明细 = %q，want 含 %q（保留 host 才可诊断）", action, detail, want)
	}
	return detail
}

// zzInsertProvider 走真实路由建一个 provider，返回它的 id。
func zzInsertProvider(t *testing.T, r http.Handler, hdr map[string]string, name, baseURL string) int64 {
	t.Helper()
	w, out := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"`+name+`","base_url":"`+baseURL+`","api_key":"sk-test","models":["m1"]}`, hdr)
	if w.Code != 200 {
		t.Fatalf("创建 provider = %d %s", w.Code, w.Body.String())
	}
	provider, ok := out["provider"].(map[string]any)
	if !ok {
		t.Fatalf("创建响应里没有 provider：%s", w.Body.String())
	}
	id, ok := provider["id"].(float64)
	if !ok {
		t.Fatalf("创建响应里 provider.id 不是数字：%s", w.Body.String())
	}
	return int64(id)
}

// 凭据型**查询串**是当下可达的（不是存量行）：创建与删除两侧都不得把它写进 detail，
// 而生效的 base_url 必须原样（折叠只影响审计，不许做成功能回归）。
func TestProviderAuditOmitsCredentialQueryString(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	id := zzInsertProvider(t, r, hdr, "querycred", providerQueryURL)

	var stored string
	if err := db.QueryRow(`SELECT base_url FROM gateway_providers WHERE id = ?`, id).Scan(&stored); err != nil {
		t.Fatalf("读回 base_url：%v", err)
	}
	if stored != providerQueryURL {
		t.Fatalf("库里的 base_url = %q，want 原样 %q（折叠只针对审计明细）", stored, providerQueryURL)
	}
	assertProviderAuditRow(t, db, "provider_create",
		"querycred base_url=https://llm.example.com/…（已脱敏）",
		providerQueryToken, providerQueryURL, "accessToken")

	// 删除路径的值来自**库** ⇒ 同一条折叠必须覆盖它。
	if w, _ := adminReq(t, r, "DELETE", "/api/server/admin/providers/"+strconv.FormatInt(id, 10), ``, hdr); w.Code != 200 {
		t.Fatalf("删除 provider = %d %s", w.Code, w.Body.String())
	}
	assertProviderAuditRow(t, db, "provider_delete",
		"querycred base_url=https://llm.example.com/…（已脱敏）",
		providerQueryToken, providerQueryURL, "accessToken")
}

// 代价如实钉住（方案取舍的另一半）：**干净**查询串也被折叠 —— 唯一实现是 host-only 粒度，
// 与同族的两条 settings 写点（`server.base_url`）一致；库里的值仍是完整地址。
func TestProviderAuditFoldsCleanQueryStringToo(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	const clean = "https://llm.example.com/v1?api-version=2024-01-01"
	id := zzInsertProvider(t, r, hdr, "cleanquery", clean)

	detail := assertProviderAuditRow(t, db, "provider_create",
		"cleanquery base_url=https://llm.example.com/…（已脱敏）")
	for _, banned := range []string{"api-version", "2024-01-01", "/v1"} {
		if strings.Contains(detail, banned) {
			t.Errorf("明细含 %q —— 与「host-only 唯一实现」的取舍不一致：%q", banned, detail)
		}
	}
	var stored string
	if err := db.QueryRow(`SELECT base_url FROM gateway_providers WHERE id = ?`, id).Scan(&stored); err != nil {
		t.Fatalf("读回 base_url：%v", err)
	}
	if stored != clean {
		t.Fatalf("库里的 base_url = %q，want %q", stored, clean)
	}
}

// 更新路径：只换查询串里的凭据也必须**留痕**（变更判定用原值），而两侧取值都折叠。
func TestProviderUpdateAuditOmitsCredentialQueryStringAndKeepsRotation(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	id := zzInsertProvider(t, r, hdr, "updcred", "https://llm.example.com/v1")
	path := "/api/server/admin/providers/" + strconv.FormatInt(id, 10)
	for _, token := range []string{"FIRSTROTATION", "SECONDROTATION"} {
		body := `{"name":"updcred","base_url":"https://llm.example.com/v1?accessToken=` + token + `","models":["m1"]}`
		if w, _ := adminReq(t, r, "PUT", path, body, hdr); w.Code != 200 {
			t.Fatalf("更新到 %s = %d %s", token, w.Code, w.Body.String())
		}
	}
	rows := gwfAudit(t, db, "provider_update")
	if len(rows) != 2 {
		t.Fatalf("provider_update 审计行 = %d，want 2（只换查询串里的凭据也必须留痕）：%v", len(rows), rows)
	}
	last := rows[len(rows)-1]
	for _, banned := range []string{"FIRSTROTATION", "SECONDROTATION", "accessToken"} {
		if strings.Contains(last, banned) {
			t.Errorf("轮换明细含凭据形态 %q：%q", banned, last)
		}
	}
	if !strings.Contains(last,
		"base_url:https://llm.example.com/…（已脱敏）→https://llm.example.com/…（已脱敏）") {
		t.Fatalf("轮换明细 = %q，want 两侧都是折叠形态且都非空", last)
	}
}

// 存量行（F10 校验上线前写入的 userinfo 形态）：删除路径的值来自库 ⇒ 同一条折叠覆盖它。
func TestProviderDeleteAuditOmitsLegacyUserinfoBaseURL(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	const legacy = "https://LEGACYUSER:LEGACYSECRET@legacy.example.com/v1"
	id := zzInsertProvider(t, r, hdr, "legacyrow", "https://api.example.com/v1")
	if _, err := db.Exec(`UPDATE gateway_providers SET base_url = ? WHERE id = ?`, legacy, id); err != nil {
		t.Fatalf("造存量行失败：%v", err)
	}
	if w, _ := adminReq(t, r, "DELETE", "/api/server/admin/providers/"+strconv.FormatInt(id, 10), ``, hdr); w.Code != 200 {
		t.Fatalf("删除 provider = %d %s", w.Code, w.Body.String())
	}
	assertProviderAuditRow(t, db, "provider_delete",
		"legacyrow base_url=https://legacy.example.com/…（已脱敏）",
		"LEGACYUSER", "LEGACYSECRET", legacy, "@")
}

package llmgateway

import (
	"strings"
	"testing"
)

// ===========================================================================
// 错误上报 DSN 的**写入侧省略**（第二十七轮审计 AA2-03）
// ===========================================================================
//
// 缺陷形态：`PUT /api/server/admin/gateway` 保存错误上报 DSN 时，把
// `error_reporting_dsn` 的**原文**拼进 `gateway_config` 审计明细 ——
// 而 DSN 形如 `https://<publicKey>[:<privateKey>]@<host>/<project>`，userinfo
// 就是凭据本体（开启"允许私钥"的项目里还带私钥）。审计行参与 `VerifyAuditChain`
// 的哈希链，**写下之后不可改写**，默认保留 180 天，还会进 CSV 导出与库备份。
//
// 同族已经定过口径：reports 的 `hook_url` 因"凭据本体进了不可变历史行"改成了
// **写入侧省略**（`internal/reports/handlers.go` 的 auditDetail +
// `internal/serverauth/audit_redact.go` 文件头那段历史）。修法照同一口径：
// `auditSetSettingFormattedTx` + `redactURLCredentialForAudit`（见 admin.go 的注释）。
//
// # 判据为什么必须直读 audit_logs 行
//
// 读侧（`/api/server/admin/audit` 的 RedactAuditDetailForViewer）**不是**这条的
// 防线：它按查看者权限折叠，覆盖不了 CSV 导出与库备份，也覆盖不了"换个人读库"。
// 所以下面所有断言都直接 `SELECT detail FROM audit_logs`（= 库里那一行、哈希链
// 参与计算的原文），而不是走 API 响应 —— 只覆盖读侧的判据在本条上是假绿。
// ===========================================================================

// dsnTestPublic/dsnTestPrivate 是占位取值（公开仓纪律：一律 example.com / 占位）。
const (
	dsnTestPublic  = "PUBKEYTESTVALUE"
	dsnTestPrivate = "PRIVATEKEYSECRETTESTVALUE"
	dsnTestValue   = "https://" + dsnTestPublic + ":" + dsnTestPrivate + "@errors.example.com/42"
)

// 保存 DSN 后，审计行里不得出现 userinfo（公钥/私钥）、完整 DSN 与项目 ID；
// 必须保留"配没配"与"指向哪台收集器"（可诊断性），且**入库的设置值本身不受影响**。
func TestGatewayConfigAuditOmitsErrorReportingDSNCredential(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":"`+dsnTestValue+`"}`, hdr)
	if w.Code != 200 {
		t.Fatalf("保存 DSN = %d %s", w.Code, w.Body.String())
	}
	_ = out

	// 写入侧省略**只影响审计明细**：真正生效的设置值必须是完整 DSN
	// （否则客户端拿不到可用 DSN，等于把安全修复做成功能回归）。
	stored, ok := gwcSetting(t, db, "web.error_reporting_dsn")
	if !ok || stored != dsnTestValue {
		t.Fatalf("设置值 = %q (ok=%v), want 原样 %q", stored, ok, dsnTestValue)
	}

	rows := gwfAudit(t, db, "gateway_config")
	if len(rows) != 1 {
		t.Fatalf("审计行 = %d, want 1（%v）", len(rows), rows)
	}
	detail := rows[0]
	for _, banned := range []string{dsnTestPublic, dsnTestPrivate, dsnTestValue, "errors.example.com/42", "@"} {
		if strings.Contains(detail, banned) {
			t.Errorf("审计 detail 含凭据形态 %q：%q", banned, detail)
		}
	}
	want := "错误上报DSN:(空)→https://errors.example.com/…（已脱敏）"
	if !strings.Contains(detail, want) {
		t.Fatalf("审计 detail = %q, want 含 %q（保留 host 才可诊断）", detail, want)
	}
}

// 密钥轮换必须仍然留痕（变更判定用**原值**，不是折叠后的值）：
// 只改 userinfo、host 不变时，若先折叠再比较，这条审计会整条消失。
func TestGatewayConfigAuditStillRecordsDSNRotation(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	first := "https://" + dsnTestPublic + "@errors.example.com/42"
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":"`+first+`"}`, hdr); w.Code != 200 {
		t.Fatalf("首次保存 = %d %s", w.Code, w.Body.String())
	}
	// 只换公钥（host/项目都不变）——折叠后两侧字符串相同。
	rotated := "https://ROTATEDPUBKEYVALUE@errors.example.com/42"
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":"`+rotated+`"}`, hdr); w.Code != 200 {
		t.Fatalf("轮换保存 = %d %s", w.Code, w.Body.String())
	}
	rows := gwfAudit(t, db, "gateway_config")
	if len(rows) != 2 {
		t.Fatalf("审计行 = %d, want 2（轮换必须留痕）：%v", len(rows), rows)
	}
	last := rows[1]
	if !strings.Contains(last, "错误上报DSN:https://errors.example.com/…（已脱敏）→https://errors.example.com/…（已脱敏）") {
		t.Fatalf("轮换明细 = %q，want 两侧都是折叠形态（且旧值不是空）", last)
	}
	for _, banned := range []string{dsnTestPublic, "ROTATEDPUBKEYVALUE", "/42"} {
		if strings.Contains(last, banned) {
			t.Errorf("轮换明细含凭据形态 %q：%q", banned, last)
		}
	}
	if stored, _ := gwcSetting(t, db, "web.error_reporting_dsn"); stored != rotated {
		t.Fatalf("轮换后的设置值 = %q, want %q", stored, rotated)
	}
	// 清空（空值 = 关闭）也要能读出来，且不把旧 DSN 带进明细。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":""}`, hdr); w.Code != 200 {
		t.Fatalf("清空 = %d %s", w.Code, w.Body.String())
	}
	rows = gwfAudit(t, db, "gateway_config")
	if got := rows[len(rows)-1]; !strings.HasSuffix(got, "→(空)") {
		t.Fatalf("清空明细 = %q，want 以 →(空) 收尾", got)
	}
	if stored, _ := gwcSetting(t, db, "web.error_reporting_dsn"); stored != "" {
		t.Fatalf("清空后的设置值 = %q, want 空", stored)
	}
}

// 正向不退化：**非敏感字段**的明细与修前逐字相同（含"键不存在→有值"这一档），
// 且同一请求里 DSN 只影响自己那一段。
func TestGatewayConfigAuditKeepsNonSecretFieldsVerbatim(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"max_file_refs":"300","error_reporting_dsn":"`+dsnTestValue+`"}`, hdr)
	if w.Code != 200 {
		t.Fatalf("保存 = %d %s", w.Code, w.Body.String())
	}
	rows := gwfAudit(t, db, "gateway_config")
	if len(rows) != 1 {
		t.Fatalf("审计行 = %d, want 1（%v）", len(rows), rows)
	}
	for _, want := range []string{
		"单请求文件引用上限:(空)→300", // 非敏感字段：原样，含 (空) 形态
		"错误上报DSN:(空)→https://errors.example.com/…（已脱敏）",
	} {
		if !strings.Contains(rows[0], want) {
			t.Errorf("明细 = %q，want 含 %q", rows[0], want)
		}
	}
}

// redactURLCredentialForAudit 的取值域（含畸形输入：绝不原样透出）。
func TestRedactDSNForAuditTable(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "(空)"},
		{"   ", "(空)"},
		{dsnTestValue, "https://errors.example.com/…（已脱敏）"},
		{"https://pub@collector.example.com:8443/7", "https://collector.example.com:8443/…（已脱敏）"},
		{"http://k:p@plain.example.com/1", "http://plain.example.com/…（已脱敏）"},
		{"https://pub@errors.example.com/42?x=1#frag", "https://errors.example.com/…（已脱敏）"},
		{"不是 URL", "（已设置，地址不可用）"},
		{"https://", "（已设置，地址不可用）"},
	}
	for _, tc := range cases {
		if got := redactURLCredentialForAudit(tc.in); got != tc.want {
			t.Errorf("redactURLCredentialForAudit(%q) = %q, want %q", tc.in, got, tc.want)
		}
		if strings.ContainsAny(tc.in, "@") && strings.Contains(redactURLCredentialForAudit(tc.in), "@") {
			t.Errorf("redactURLCredentialForAudit(%q) 仍含 userinfo 分隔符", tc.in)
		}
	}
}

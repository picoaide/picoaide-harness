package serverauth

// N7(2026-09-13 第三轮独立复核 §4.2 / 清单 N7,P3):审计读侧 URL 扫描大小写敏感。
//
// 缺陷形态:RedactAuditDetailForViewer 用 strings.Index(rest, "http://") 定位
// URL —— 对 `HTTPS://…?key=` **大小写敏感**、对 `//host/…?key=`(协议相对)
// 根本不扫描、对百分号编码形态(https%3A%2F%2F…%3Fkey%3D)也没有入口。于是
// 「按 report:read 脱敏」在这些形态下全部失效(含 report_subscription_* 动作
// 的无条件折叠:扫描没找到 URL,动作规则自然也不会触发)。
//
// 当前不可达(写入侧报表订阅只接受小写 http(s) 前缀,且没有别的审计写入点会
// 把这类形态写进 detail),属**预防性**缺口;但脱敏是读侧最后一道闸,形态缺口
// 不该留着。
//
// 修法:①扫描对 scheme 大小写不敏感;②协议相对 `//host/…` 也纳入扫描;
// ③百分号编码形态按解码后的语义分类(折叠时保留解码出的 scheme://host);
// ④report_subscription_* 动作对定位到的任何 URL(含自定义路径、无凭据标记)
// 无条件整体折叠。
//
// 边界(不得越界):
//   - 持 report:read 者(super_admin)读原文,逐字节不变;
//   - 读侧脱敏不写库:行数与 detail 原文不变、哈希链仍校验通过;
//   - 非报表动作的**普通** URL(无凭据参数/userinfo/webhook 路径)继续原样
//     显示,不牺牲审计可读性。

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// r4AuditShape 是一条审计 detail 形态。
type r4AuditShape struct {
	name   string
	action string
	detail string
	// token 是嵌在 detail 里的凭据片段(auditor 侧必须读不到)。
	token string
	// redact  = auditor 读到时必须已折叠(token 不得出现)。
	redact bool
}

const r4Secret = "SECRET-R4-TOKEN"

var r4AuditShapes = []r4AuditShape{
	// 大小写不敏感(修复前:HTTPS:// 完全不被扫描)。
	{"uppercase-scheme-report", "report_subscription_create",
		"bot HTTPS://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + r4Secret + "-1", r4Secret + "-1", true},
	{"uppercase-scheme-other", "skill_create",
		"hook HTTPS://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + r4Secret + "-2", r4Secret + "-2", true},
	{"uppercase-scheme-param", "skill_create",
		"hook HTTPS://example.com/x?KEY=" + r4Secret + "-3", r4Secret + "-3", true},
	{"mixed-case-param", "skill_create",
		"hook https://example.com/x?a=1&KeY=" + r4Secret + "-4", r4Secret + "-4", true},
	{"uppercase-userinfo", "skill_create",
		"回调 HTTPS://user:" + r4Secret + "-5@git.example.com/repo.git", r4Secret + "-5", true},
	// 协议相对(修复前:不扫描)。
	{"scheme-relative-query", "skill_create",
		"hook //qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + r4Secret + "-6", r4Secret + "-6", true},
	{"scheme-relative-uppercase", "skill_create",
		"hook //QYAPI.WEIXIN.QQ.COM/robot/send?ACCESS_TOKEN=" + r4Secret + "-7", r4Secret + "-7", true},
	{"scheme-relative-userinfo", "skill_create",
		"回调 //user:" + r4Secret + "-8@git.example.com/repo.git", r4Secret + "-8", true},
	{"scheme-relative-report", "report_subscription_update",
		"bot //my-hook.example.com/notify/" + r4Secret + "-9", r4Secret + "-9", true},
	// 百分号编码(修复前:整串无 http:// 前缀,不被扫描)。
	{"percent-encoded", "skill_create",
		"hook https%3A%2F%2Fqyapi.weixin.qq.com%2Fwebhook%2Fsend%3Fkey%3D" + r4Secret + "-10", r4Secret + "-10", true},
	{"percent-encoded-uppercase", "skill_create",
		"hook HTTPS%3A%2F%2Fhooks.slack.com%2Fservices%2FT00%2FB00%2F" + r4Secret + "-11", r4Secret + "-11", true},
	{"percent-encoded-report", "report_subscription_create",
		"bot HTTPS%3A%2F%2Fmy-hook.example.com%2Fnotify%2F" + r4Secret + "-12", r4Secret + "-12", true},
	// 报表动作:无条件折叠(含自定义路径 / 无凭据标记)。
	{"report-custom-path", "report_subscription_create",
		"bot https://my-hook.example.com/notify/" + r4Secret + "-13", r4Secret + "-13", true},
	{"report-custom-path-uppercase", "report_subscription_create",
		"bot HTTPS://my-hook.example.com/notify/" + r4Secret + "-14", r4Secret + "-14", true},
	{"report-plain-url", "report_subscription_delete", "bot https://hooks.example.com/plain", "", true},
	// 既有形态对照(修复前已正确,防回归)。
	{"lowercase-query", "skill_create",
		"hook https://oapi.dingtalk.com/robot/send?access_token=" + r4Secret + "-15", r4Secret + "-15", true},
	{"feishu-path", "skill_create",
		"hook https://open.feishu.cn/open-apis/bot/v2/hook/" + r4Secret + "-16", r4Secret + "-16", true},
	{"json-wrapped-uppercase", "report_subscription_update",
		`{"name":"x","hook_url":"HTTPS://qyapi.weixin.qq.com/x?key=` + r4Secret + `-17","note":"ok"}`, r4Secret + "-17", true},
	// 片段里带凭据(非报表动作)也必须折叠。
	{"fragment-credential", "skill_create",
		"hook https://example.com/cb#" + "key=" + r4Secret + "-18", r4Secret + "-18", true},
	// 4KB 超长 URL(不得"先截断后脱敏"):凭据在尾部也必须被折叠。
	{"long-url-tail-secret", "skill_create",
		"hook https://qyapi.weixin.qq.com/x?pad=" + strings.Repeat("P", 4000) + "&key=" + r4Secret + "-19",
		r4Secret + "-19", true},
	// 边界:非报表动作的普通 URL 必须原样(audit_redact_test.go 已固定的口径)。
	{"plain-url-untouched", "gateway_update", "server_base_url=https://harness.example/admin", "", false},
	{"plain-detail-untouched", "user_update", "角色 auditor → super_admin", "", false},
	{"double-slash-not-url", "user_update", "路径 a // b 拆分说明", "", false},
}

// TestRedactAuditDetailForViewerURLShapes:纯函数逐条形态。
func TestRedactAuditDetailForViewerURLShapes(t *testing.T) {
	for _, s := range r4AuditShapes {
		got := RedactAuditDetailForViewer(s.detail, s.action, false)
		if s.token != "" && strings.Contains(got, s.token) {
			t.Errorf("%s: 脱敏后仍含凭据 %q → %q", s.name, s.token, got)
		}
		if !s.redact && got != s.detail {
			t.Errorf("%s: 不应改动普通 detail\n in = %q\nout = %q", s.name, s.detail, got)
		}
		if s.redact && !strings.Contains(got, "已脱敏") {
			t.Errorf("%s: 期望折叠出「已脱敏」标记, got %q", s.name, got)
		}
		// 折叠必须保留可定位的主机名(审计定位需要) —— 逐字形状见
		// TestRedactAuditDetailForViewerShapeDetails。
		if s.redact && s.token != "" && !strings.Contains(got, "host") && !strings.Contains(got, ".") {
			t.Errorf("%s: 折叠后未保留 host: %q", s.name, got)
		}
		// 持 report:read 者读原文。
		if raw := RedactAuditDetailForViewer(s.detail, s.action, true); raw != s.detail {
			t.Errorf("%s: canReadReport=true 被改写: %q", s.name, raw)
		}
	}
}

// TestRedactAuditDetailForViewerShapeDetails:折叠形状(逐字),便于人工核对。
func TestRedactAuditDetailForViewerShapeDetails(t *testing.T) {
	cases := []struct{ name, action, detail, want string }{
		{"大写 scheme + 报表动作",
			"report_subscription_create",
			"bot HTTPS://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET",
			"bot HTTPS://qyapi.weixin.qq.com/…（已脱敏）"},
		{"协议相对 + 凭据参数",
			"skill_create",
			"hook //qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET",
			"hook //qyapi.weixin.qq.com/…（已脱敏）"},
		{"百分号编码(折叠成解码后的 scheme://host)",
			"skill_create",
			"hook https%3A%2F%2Fqyapi.weixin.qq.com%2Fwebhook%2Fsend%3Fkey%3DSECRET",
			"hook https://qyapi.weixin.qq.com/…（已脱敏）"},
		{"报表动作自定义路径(无条件折叠)",
			"report_subscription_create",
			"bot HTTPS://my-hook.example.com/notify/SECRET",
			"bot HTTPS://my-hook.example.com/…（已脱敏）"},
		{"大写 userinfo",
			"skill_create",
			"回调 HTTPS://user:SECRET@git.example.com/repo.git",
			"回调 HTTPS://git.example.com/…（已脱敏）"},
		{"非报表普通 URL 不误伤",
			"gateway_update",
			"server_base_url=https://harness.example/admin",
			"server_base_url=https://harness.example/admin"},
		{"无 URL 文本不误伤",
			"user_update",
			"路径 a // b 拆分说明",
			"路径 a // b 拆分说明"},
		{"多个 URL(混合形态)逐个判定",
			"report_subscription_update",
			"旧 HTTPS://qyapi.weixin.qq.com/x?key=A 新 //open.feishu.cn/open-apis/bot/v2/hook/B",
			"旧 HTTPS://qyapi.weixin.qq.com/…（已脱敏） 新 //open.feishu.cn/…（已脱敏）"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := RedactAuditDetailForViewer(c.detail, c.action, false); got != c.want {
				t.Fatalf("脱敏结果 = %q, want %q", got, c.want)
			}
		})
	}
}

// TestAuditReadSideRedactionHTTP:真 HTTP + 真权限 + 真 PG。
// 断言:auditor 读不到任何形态的凭据;super_admin 读原文;库内行数与 detail
// 原文不变;哈希链仍校验通过(读侧脱敏绝不写库)。
func TestAuditReadSideRedactionHTTP(t *testing.T) {
	db := mustDB(t)
	gin.SetMode(gin.TestMode)

	audID, err := serverstore.CreateUserWithPassword(db, "r4-auditor", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	aud, err := serverstore.GetUserByID(db, audID)
	if err != nil {
		t.Fatal(err)
	}
	aud.Role = serverstore.RoleAuditor
	if err := serverstore.UpdateUser(db, aud); err != nil {
		t.Fatal(err)
	}
	audSess, _, err := CreateAdminSession(db, audID)
	if err != nil {
		t.Fatal(err)
	}

	bossID, err := serverstore.CreateUserWithPassword(db, "r4-boss", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	boss, err := serverstore.GetUserByID(db, bossID)
	if err != nil {
		t.Fatal(err)
	}
	boss.Role = serverstore.RoleSuperAdmin
	if err := serverstore.UpdateUser(db, boss); err != nil {
		t.Fatal(err)
	}
	bossSess, _, err := CreateAdminSession(db, bossID)
	if err != nil {
		t.Fatal(err)
	}

	// 历史行:走真 AuditLog(参与哈希链,不绕过写入侧)。
	for _, s := range r4AuditShapes {
		if err := serverstore.AuditLog(db, "r4-boss", s.action, s.detail); err != nil {
			t.Fatalf("写审计: %v", err)
		}
	}
	var rowsBefore int
	if err := db.QueryRow("SELECT count(*) FROM audit_logs").Scan(&rowsBefore); err != nil {
		t.Fatal(err)
	}

	r := gin.New()
	RegisterAdminRoutes(r, db)
	get := func(sess *AdminSession) (int, string) {
		w, _ := doJSON(t, r, "GET", "/api/server/admin/audit?size=200", "",
			map[string]string{"Cookie": sessionCookieName + "=" + sess.ID})
		return w.Code, w.Body.String()
	}

	status, audBody := get(audSess)
	if status != http.StatusOK {
		t.Fatalf("auditor GET /audit = %d body=%s", status, audBody)
	}
	for _, s := range r4AuditShapes {
		if s.token == "" {
			continue
		}
		if strings.Contains(audBody, s.token) {
			t.Errorf("auditor 仍能读到 %s 的明文凭据 %q", s.name, s.token)
		}
	}
	// 普通 URL 必须仍可见(不牺牲审计可读性)。
	if !strings.Contains(audBody, "server_base_url=https://harness.example/admin") {
		t.Error("普通 URL 被误折叠(auditor 应能看到非凭据 URL)")
	}

	status, bossBody := get(bossSess)
	if status != http.StatusOK {
		t.Fatalf("super_admin GET /audit = %d body=%s", status, bossBody)
	}
	for _, s := range r4AuditShapes {
		if s.token == "" {
			continue
		}
		if !strings.Contains(bossBody, s.token) {
			t.Errorf("super_admin(持 report:read)读不到 %s 原文", s.name)
		}
	}

	// 读侧不写库:行数不变、detail 原文保留、哈希链仍通过。
	var rowsAfter int
	if err := db.QueryRow("SELECT count(*) FROM audit_logs").Scan(&rowsAfter); err != nil {
		t.Fatal(err)
	}
	if rowsAfter != rowsBefore {
		t.Fatalf("读侧脱敏改动了行数: before=%d after=%d", rowsBefore, rowsAfter)
	}
	var raw string
	if err := db.QueryRow("SELECT detail FROM audit_logs WHERE action='skill_create' ORDER BY id LIMIT 1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, r4Secret) {
		t.Fatalf("库内历史行被改写: %q", raw)
	}
	if _, err := serverstore.VerifyAuditChain(db); err != nil {
		t.Fatalf("读侧脱敏破坏了哈希链: %v", err)
	}
}

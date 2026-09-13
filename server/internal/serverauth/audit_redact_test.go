package serverauth

// 读侧脱敏的纯函数回归(三轮残留①,2026-09-13):覆盖各 webhook 形态,
// 并固定两条边界 —— 无凭据的普通 URL 不误伤、持 report:read 者读原文。

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestRedactAuditDetailForViewer(t *testing.T) {
	cases := []struct {
		name   string
		action string
		detail string
		want   string
	}{
		{
			name:   "企微机器人(查询参数 key)",
			action: "report_subscription_create",
			detail: "bot-x https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET",
			want:   "bot-x https://qyapi.weixin.qq.com/…（已脱敏）",
		},
		{
			name:   "钉钉机器人(access_token)",
			action: "report_subscription_update",
			detail: "bot-y https://oapi.dingtalk.com/robot/send?access_token=SECRET",
			want:   "bot-y https://oapi.dingtalk.com/…（已脱敏）",
		},
		{
			name:   "飞书机器人(凭据在路径里,无查询参数)",
			action: "report_subscription_create",
			detail: "bot-z https://open.feishu.cn/open-apis/bot/v2/hook/0f1e2d3c",
			want:   "bot-z https://open.feishu.cn/…（已脱敏）",
		},
		{
			name:   "报表动作里的任意 URL 一律视为凭据(宽口径)",
			action: "report_subscription_create",
			detail: "bot-w https://hooks.example.com/plain",
			want:   "bot-w https://hooks.example.com/…（已脱敏）",
		},
		{
			name:   "非报表动作但带凭据参数(userinfo)",
			action: "user_update",
			detail: "回调 https://user:pass@git.example.com/repo.git 已配置",
			want:   "回调 https://git.example.com/…（已脱敏） 已配置",
		},
		{
			name:   "非报表动作的普通 URL 不误伤(审计可读性)",
			action: "gateway_update",
			detail: "server_base_url=https://harness.example/admin",
			want:   "server_base_url=https://harness.example/admin",
		},
		{
			name:   "无 URL 的 detail 原样",
			action: "user_update",
			detail: "角色 auditor → super_admin",
			want:   "角色 auditor → super_admin",
		},
		{
			name:   "多个 URL 逐个判定",
			action: "report_subscription_update",
			detail: "旧 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=A 新 https://open.feishu.cn/open-apis/bot/v2/hook/B",
			want:   "旧 https://qyapi.weixin.qq.com/…（已脱敏） 新 https://open.feishu.cn/…（已脱敏）",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := RedactAuditDetailForViewer(c.detail, c.action, false)
			if got != c.want {
				t.Fatalf("脱敏结果 = %q, want %q", got, c.want)
			}
			if strings.Contains(got, "SECRET") || strings.Contains(got, "user:pass@") ||
				strings.Contains(got, "0f1e2d3c") {
				t.Fatalf("脱敏后仍含凭据片段: %q", got)
			}
		})
	}
}

// TestRedactAuditDetailForViewerKeepsPlaintextForReportReaders:持 report:read 的
// 查看者读原文(历史行可追溯),逐字节不变。
func TestRedactAuditDetailForViewerKeepsPlaintextForReportReaders(t *testing.T) {
	detail := "bot-x https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET"
	if got := RedactAuditDetailForViewer(detail, "report_subscription_create", true); got != detail {
		t.Fatalf("持 report:read 者应读原文, got %q", got)
	}
	if got := RedactAuditDetailForViewer("", "report_subscription_create", false); got != "" {
		t.Fatalf("空 detail 应保持空, got %q", got)
	}
}

// TestRedactAuditEntryDetailsOnlyTouchesDetail:脱敏只动 detail,不碰参与哈希链
// 的 prev_hash/hash 字段(读侧不改链)。
func TestRedactAuditEntryDetailsOnlyTouchesDetail(t *testing.T) {
	const original = "x https://a.example/hook?key=K"
	fresh := func() []serverstore.AuditLogEntry {
		return []serverstore.AuditLogEntry{{
			ID: 7, Username: "boss", Action: "report_subscription_create",
			Detail: original, PrevHash: "p", Hash: "h",
		}}
	}
	denied := fresh()
	redactAuditEntryDetails(denied, false)
	if denied[0].Detail == original {
		t.Fatal("detail 未被脱敏")
	}
	if denied[0].PrevHash != "p" || denied[0].Hash != "h" || denied[0].ID != 7 {
		t.Fatalf("脱敏动到了哈希链字段: %+v", denied[0])
	}
	allowed := fresh()
	redactAuditEntryDetails(allowed, true)
	if allowed[0].Detail != original {
		t.Fatal("持权限者不应被脱敏")
	}
}

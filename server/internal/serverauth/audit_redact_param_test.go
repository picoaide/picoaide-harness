package serverauth

// 读侧脱敏的参数形态补漏(2026-09-19 审计)。
//
// 缺口:凭据型查询参数的切分只认 `&`、且参数名做**全等**比对 ⇒
//   - `?a=1;key=SECRET`(分号分隔的参数)整体当成一个参数名 `a`,漏判;
//   - `?key[]=SECRET`(数组式参数名)与 `key` 不全等,漏判。
// 两种形态都不脱敏 ⇒ 只读角色 auditor(持 audit:read、不持 report:read)能读到
// webhook 凭据明文。凭据可用于往企业群发任意内容 ⇒ 安全面。
//
// 本轮只扩两处:切分字符加 ';'、参数名只剥**一层**尾部 `[]`。
// **刻意不做通用归一化**:`key[][]`、`key[0]`、`keyish`、`keys`、`tokenizer`、
// `signature_v2` 一类一律不脱敏 —— 判断的是"这个 URL 是否凭据型",把变量名里
// 含 key/token 的正常参数误伤成脱敏会牺牲审计可读性,而没有任何已知 webhook
// 用这些形态承载凭据(钉钉 access_token / 企微 key / 飞书路径 uuid / Slack
// /services/)。负向用例在 TestRedactAuditDetailNoOverRedaction 里钉死。
//
// 影响面仅限 /audit **读时**形状:库内历史行与 sha256 哈希链不改(调用点见
// listAuditLogs → redactAuditEntryDetails,只写 logs[i].Detail)。

import (
	"strings"
	"testing"
)

// auditRedactParamCases 是本次修复的前后对拍语料。
//   - wantSensitive=true  → 契约内:必须脱敏(修复前不脱敏的即"契约内差异");
//   - wantSensitive=false → 契约外:必须**逐字节不变**(任何差异都是误伤)。
type auditRedactParamCase struct {
	name          string
	detail        string
	wantSensitive bool
	want          string // 期望的完整 detail(逐字节)
}

const (
	redactedExampleHost = "https://example.com/…（已脱敏）"
	// 协议相对形态折叠后保留 `//host` 形状。
	redactedProtoRelHost = "//example.com/…（已脱敏）"
)

var auditRedactParamCases = []auditRedactParamCase{
	// ---- 契约内:分号分隔的参数 -------------------------------------------
	{
		name:          "分号分隔的参数名在第二位",
		detail:        "bot https://example.com/p?a=1;key=SECRET",
		wantSensitive: true,
		want:          "bot " + redactedExampleHost,
	},
	{
		name:          "分号分隔且有多个前置参数",
		detail:        "bot https://example.com/p?a=1;b=2;access_token=SECRET",
		wantSensitive: true,
		want:          "bot " + redactedExampleHost,
	},
	{
		name:          "分号分隔的参数名在第一位",
		detail:        "https://example.com/p?key=SECRET;a=1",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	{
		name:          "分号 + 协议相对",
		detail:        "//example.com/p?a=1;key=SECRET",
		wantSensitive: true,
		want:          redactedProtoRelHost,
	},
	{
		name:          "分号 + 百分号编码(按解码后语义分类)",
		detail:        "https%3A%2F%2Fexample.com%2Fp%3Fa%3D1%3Bkey%3DSECRET",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	{
		name:          "分号 + 片段里的凭据名",
		detail:        "https://example.com/p?a=1#key=SECRET",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	// ---- 契约内:数组式参数名(只剥一层 [] ) -------------------------------
	{
		name:          "数组式 key[]",
		detail:        "https://example.com/p?key[]=SECRET",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	{
		name:          "数组式 access_token[]",
		detail:        "https://example.com/p?a=1&access_token[]=SECRET",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	{
		name:          "数组式 token[] 在片段里",
		detail:        "https://example.com/p#token[]=SECRET",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	{
		name:          "数组式 + 分号",
		detail:        "https://example.com/p?a=1;signature[]=SECRET",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	// ---- 契约外:不得误伤(逐字节不变) -----------------------------------
	{
		name:          "变量名里含 key 的正常参数(keyish)",
		detail:        "https://example.com/p?keyish=SECRET",
		wantSensitive: false,
		want:          "https://example.com/p?keyish=SECRET",
	},
	{
		name:          "keys 不是 key",
		detail:        "https://example.com/p?keys=SECRET",
		wantSensitive: false,
		want:          "https://example.com/p?keys=SECRET",
	},
	{
		name:          "tokenizer 不是 token",
		detail:        "https://example.com/p?tokenizer=v",
		wantSensitive: false,
		want:          "https://example.com/p?tokenizer=v",
	},
	{
		name:          "signature_v2 不是 signature(不做前缀/变体归一化)",
		detail:        "https://example.com/p?signature_v2=v",
		wantSensitive: false,
		want:          "https://example.com/p?signature_v2=v",
	},
	{
		name:          "只剥一层:key[][] 不脱敏",
		detail:        "https://example.com/p?key[][]=SECRET",
		wantSensitive: false,
		want:          "https://example.com/p?key[][]=SECRET",
	},
	{
		name:          "只剥一层:key[0] 不脱敏(PHP 下标形态不在契约内)",
		detail:        "https://example.com/p?key[0]=SECRET",
		wantSensitive: false,
		want:          "https://example.com/p?key[0]=SECRET",
	},
	{
		name:          "分号分隔但都不是凭据名",
		detail:        "https://example.com/p?a=1;b=2",
		wantSensitive: false,
		want:          "https://example.com/p?a=1;b=2",
	},
	{
		name:          "monkey 不是 key",
		detail:        "https://example.com/p?monkey=SECRET",
		wantSensitive: false,
		want:          "https://example.com/p?monkey=SECRET",
	},
	{
		name:          "普通无凭据 URL(审计可读性)",
		detail:        "https://example.com/plain?a=1",
		wantSensitive: false,
		want:          "https://example.com/plain?a=1",
	},
	{
		name:          "无 URL 的明细原样",
		detail:        "角色 auditor → super_admin",
		wantSensitive: false,
		want:          "角色 auditor → super_admin",
	},
	// ---- 回归护栏:修复前已脱敏的形态必须保持脱敏 -------------------------
	{
		name:          "& 分隔(既有行为)",
		detail:        "https://example.com/p?a=1&key=SECRET",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	{
		name:          "webhook 路径标记(既有行为)",
		detail:        "https://example.com/hooks/0f1e2d3c",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	{
		name:          "userinfo(既有行为)",
		detail:        "https://user:pass@example.com/p",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
	{
		name:          "code 参数(既有行为)",
		detail:        "https://example.com/cb?code=abc",
		wantSensitive: true,
		want:          redactedExampleHost,
	},
}

// TestRedactAuditDetailParamForms:契约内必须脱敏、契约外必须逐字节不变。
// 用非报表动作(避开 report_subscription_* 的"任意 URL 一律折叠"宽口径),
// 判定的就是参数形态本身。
func TestRedactAuditDetailParamForms(t *testing.T) {
	for _, c := range auditRedactParamCases {
		t.Run(c.name, func(t *testing.T) {
			got := RedactAuditDetailForViewer(c.detail, "gateway_config", false)
			if got != c.want {
				t.Fatalf("脱敏结果 = %q, want %q", got, c.want)
			}
			if c.wantSensitive && got == c.detail {
				t.Fatalf("凭据型 URL 未脱敏(明文下发): %q", got)
			}
			if c.wantSensitive && strings.Contains(got, "SECRET") {
				t.Fatalf("脱敏后仍含凭据片段: %q", got)
			}
		})
	}
}

// TestRedactAuditDetailNoOverRedaction:把"不误伤"单独钉一条 —— 负向语料必须
// 逐字节原样返回(修复只允许把漏判的凭据型 URL 折起来,不允许新增误伤)。
func TestRedactAuditDetailNoOverRedaction(t *testing.T) {
	for _, c := range auditRedactParamCases {
		if c.wantSensitive {
			continue
		}
		got := RedactAuditDetailForViewer(c.detail, "gateway_config", false)
		if got != c.detail {
			t.Fatalf("%s: 误伤 —— got %q, want %q", c.name, got, c.detail)
		}
	}
}

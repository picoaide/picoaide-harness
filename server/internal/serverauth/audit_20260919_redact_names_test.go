package serverauth

// 审计读侧脱敏:凭据参数名白名单补漏(2026-09-19,独立验证代理实测的 P2 残留)。
//
// 缺口形态(修复前**明文下发**给只读角色 auditor):
//
//	?accessToken=SECRET   驼峰 —— 白名单里只有下划线形态 access_token
//	?access-token=SECRET  连字符
//	?api-key=SECRET       白名单里只有 api_key / apikey
//	?authorization=SECRET Authorization 请求头被原样抄进查询串的形态
//
// 真实可达路径:internal/llmgateway/admin.go 的 provider_delete 写
// "… base_url=<上游地址>" —— 上游地址带凭据查询串时,持 audit:read、不持
// report:read 的 auditor 就能从 /audit 读到上游凭据明文(读侧脱敏是最后一道闸)。
//
// 本轮只**显式补名**,不引入任何通用归一化(去掉全部 `-`/`_` 再比对、前缀
// 匹配、模糊匹配):上一轮已用负向语料钉死 keyish/keys/tokenizer/signature_v2/
// key[][]/key[0]/monkey 必须保持不脱敏,通用归一化会把这些一起卷进来 ——
// 判定的是"这个 URL 是否凭据型",误伤正常参数会牺牲审计可读性。每个新名字都
// 在 TestAuditSensitiveQueryParamsExplicitNames 里逐条确认与负向语料**不全等**。
//
// 已知边界(与代码实际行为逐条对拍,断言在 TestAuditRedactKnownBoundaries):
//   - 已覆盖:参数名大小写不敏感(全等比对前 ToLower)、参数名单层尾部 `[]`、
//     `&` 与 `;` 两种参数分隔符、`?` 查询串与 `#` 片段两个入口;
//   - 不覆盖:单层 `;` **路径**参数(`/path;key=SECRET` —— `;` 在路径段里,
//     没有 `?`/`#` 入口,整段不进入参数判定)、二次编码(`%253Bkey%253D`,
//     只解一层百分号编码,解出的 `%3B` 仍不是分隔符)、前导 `%20`
//     (`;%20key=`,解码出的前导空格使参数名成为 ` key`,与 `key` 不全等)。
//   不覆盖的理由:这些形态只能靠通用归一化兜住(误伤风险见上),而没有任何
//   已知 webhook 用它们承载凭据 —— 钉钉 access_token / 企微 key / 飞书路径
//   uuid / Slack /services/ 全部落在覆盖面内。
//
// 影响面仅限 /audit **读时**形状:库内历史行与 sha256 哈希链不改
// (调用点 listAuditLogs → redactAuditEntryDetails 只写 logs[i].Detail)。

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

const (
	auditNamesRedactedHost = "https://example.com/…（已脱敏）"
	// auditNamesNegHost 负向语料用的 host:折叠时保留 host,便于断言"没被折"。
	auditNamesNegHost = "https://neg.example.com"
)

// auditNewSensitiveNames 本次显式补进 auditSensitiveQueryParams 的名字
// (全部小写形态 —— 白名单本身按小写全等比对)。
var auditNewSensitiveNames = []string{
	"accesstoken",   // 驼峰 accessToken
	"access-token",  // 连字符
	"api-key",       // 连字符
	"authorization", // Authorization 头形态
	"auth-token",    // 同族显式形态
	"authtoken",
	"refresh-token",
	"refresh_token",
	"refreshtoken",
	"x-api-key",
	"bearer",
}

// auditNearMissNames 与新增名字同族但**必须**保持不脱敏的近似形态。
// 它们钉死"只做全等比对、不做前缀/归一化/变体匹配"这条设计决策。
// 刻意只放**合成**变体(复数/`_v2`/拼接形态):真实服务不把它们当凭据参数名,
// 所以把它们钉成"不脱敏"不会挡住将来对真实凭据名的收口。
var auditNearMissNames = []string{
	"accesstokens", "access_token_v2", "access-token-v2",
	"api-keys", "apikey_v2", "authorizationcode",
	"authcode", "authcodes", "authtokens", "auth_token_v2",
	"refresh-tokens", "refresh_token_v2", "refreshtoken_v2",
	"x-api-keys", "bearer2", "bearertoken", "bearer_token_v2",
}

// auditRequestedVulnForms 是验证代理报告的 4 条形态(逐字),外加大小写变体。
// 修复前这些全部**明文返回**;修复后必须折叠成 scheme://host/…（已脱敏）。
var auditRequestedVulnForms = []struct {
	name   string
	detail string
	want   string
}{
	{"报告形态:accessToken 驼峰",
		"upstream base_url=https://example.com/v1?accessToken=SECRET-AT",
		"upstream base_url=" + auditNamesRedactedHost},
	{"报告形态:access-token 连字符",
		"upstream base_url=https://example.com/v1?access-token=SECRET-ATH",
		"upstream base_url=" + auditNamesRedactedHost},
	{"报告形态:api-key",
		"upstream base_url=https://example.com/v1?api-key=SECRET-AK",
		"upstream base_url=" + auditNamesRedactedHost},
	{"报告形态:authorization",
		"upstream base_url=https://example.com/v1?authorization=SECRET-AZ",
		"upstream base_url=" + auditNamesRedactedHost},
	{"大小写变体:AccessToken",
		"hook https://example.com/x?AccessToken=SECRET-AT2",
		"hook " + auditNamesRedactedHost},
	{"大小写变体:ACCESSTOKEN",
		"hook https://example.com/x?ACCESSTOKEN=SECRET-AT3",
		"hook " + auditNamesRedactedHost},
	{"大小写变体:Api-Key",
		"hook https://example.com/x?Api-Key=SECRET-AK2",
		"hook " + auditNamesRedactedHost},
	{"大小写变体:Authorization",
		"hook https://example.com/x?Authorization=SECRET-AZ2",
		"hook " + auditNamesRedactedHost},
}

// TestAuditRedactRequestedVulnForms:报告里的 4 条形态逐条(修复前必红)。
func TestAuditRedactRequestedVulnForms(t *testing.T) {
	for _, c := range auditRequestedVulnForms {
		t.Run(c.name, func(t *testing.T) {
			got := RedactAuditDetailForViewer(c.detail, "provider_delete", false)
			if got != c.want {
				t.Fatalf("凭据型 URL 未脱敏(auditor 读到明文)\n in = %q\nout = %q\nwant = %q",
					c.detail, got, c.want)
			}
			if strings.Contains(got, "SECRET-") {
				t.Fatalf("脱敏后仍含凭据片段: %q", got)
			}
		})
	}
}

// TestAuditRedactNewSensitiveParamNames:每个新名字 × 六种承载形态都必须脱敏:
// 裸形态、`&` 混合、`;` 分隔、`[]` 后缀、`#` 片段、全大写。
func TestAuditRedactNewSensitiveParamNames(t *testing.T) {
	for _, name := range auditNewSensitiveNames {
		forms := []struct{ label, detail, wantPrefix string }{
			{"裸形态", "hook https://example.com/x?" + name + "=SECRET", "hook "},
			{"与其它参数混合(&)", "hook https://example.com/x?a=1&" + name + "=SECRET&b=2", "hook "},
			{"分号分隔", "hook https://example.com/x?a=1;" + name + "=SECRET", "hook "},
			{"数组式后缀", "hook https://example.com/x?" + name + "[]=SECRET", "hook "},
			{"片段入口", "hook https://example.com/x#a=1&" + name + "=SECRET", "hook "},
			{"全大写", "hook https://example.com/x?" + strings.ToUpper(name) + "=SECRET", "hook "},
		}
		for _, f := range forms {
			t.Run(name+"/"+f.label, func(t *testing.T) {
				got := RedactAuditDetailForViewer(f.detail, "provider_delete", false)
				if got == f.detail || strings.Contains(got, "SECRET") {
					t.Fatalf("未脱敏(明文下发): name=%q form=%q → %q", name, f.label, got)
				}
				if want := f.wantPrefix + auditNamesRedactedHost; got != want {
					t.Fatalf("脱敏形状 = %q, want %q", got, want)
				}
			})
		}
	}
}

// TestAuditSensitiveQueryParamsExplicitNames:白名单的设计契约 ——
// 新名字必须**直接**在表里(不是靠某种归一化间接命中),负向语料必须不在表里。
// 这条也拦"把通用归一化塞进判定"的退化:那样一来负向名字会被表外匹配命中。
func TestAuditSensitiveQueryParamsExplicitNames(t *testing.T) {
	for _, name := range auditNewSensitiveNames {
		if !auditSensitiveQueryParams[name] {
			t.Errorf("白名单缺少显式名字 %q(不得依赖归一化间接命中)", name)
		}
		if strings.ToLower(name) != name {
			t.Errorf("白名单键必须是小写形态: %q", name)
		}
	}
	negative := append([]string{
		// 上一轮已钉死的负向语料(`key` 本身在表里,这里只钉"含 key 但不等于 key"的形态)。
		"keyish", "keys", "tokenizer", "signature_v2", "monkey",
		"a", "b", // `?a=1;b=2` 的两个参数名
	}, auditNearMissNames...)
	for _, name := range negative {
		if auditSensitiveQueryParams[name] {
			t.Errorf("负向名字 %q 不得进白名单(误伤审计可读性)", name)
		}
	}
	// `[]` 只剥一层:剥完剩下的形态必须在表外。
	for _, name := range []string{"key[]", "token[]", "accesstoken[]", "api-key[]"} {
		if auditSensitiveQueryParams[name] {
			t.Errorf("只剥一层 []:%q 不得进白名单", name)
		}
	}
}

// TestAuditRedactNameWhitelistNoOverRedaction:上一轮钉死的负向语料 + 本次
// 新增名字的同族近似形态,一律**逐字节不变**(任何差异都是误伤)。
func TestAuditRedactNameWhitelistNoOverRedaction(t *testing.T) {
	negative := []string{
		"keyish", "keys", "tokenizer", "signature_v2", "key[][]", "key[0]", "monkey",
	}
	negative = append(negative, auditNearMissNames...)
	for _, name := range negative {
		detail := auditNamesNegHost + "/p?" + name + "=SECRET"
		if got := RedactAuditDetailForViewer(detail, "provider_delete", false); got != detail {
			t.Errorf("误伤 %q: got %q, want %q", name, got, detail)
		}
		// 分号分隔形态同样不得误伤(切分扩到 `;` 后这条更容易被卷进来)。
		detail = auditNamesNegHost + "/p?a=1;" + name + "=SECRET"
		if got := RedactAuditDetailForViewer(detail, "provider_delete", false); got != detail {
			t.Errorf("误伤(分号) %q: got %q, want %q", name, got, detail)
		}
	}
	// 报告点名的两条整串语料。
	for _, detail := range []string{
		auditNamesNegHost + "/p?a=1;b=2",
		auditNamesNegHost + "/p?authcode=SECRET",
	} {
		if got := RedactAuditDetailForViewer(detail, "provider_delete", false); got != detail {
			t.Errorf("误伤: got %q, want %q", got, detail)
		}
	}
}

// TestAuditRedactKnownBoundaries:头部注释声明的"已覆盖 / 不覆盖"逐条对拍 ——
// 注释不许撒谎(覆盖的必须真覆盖,不覆盖的必须真不覆盖)。
func TestAuditRedactKnownBoundaries(t *testing.T) {
	t.Run("已覆盖:大小写不敏感", func(t *testing.T) {
		for _, detail := range []string{
			"h https://example.com/x?ReFrEsH-ToKeN=SECRET",
			"h https://example.com/x?BEARER=SECRET",
			"h https://example.com/x?X-API-KEY=SECRET",
		} {
			if got := RedactAuditDetailForViewer(detail, "provider_delete", false); strings.Contains(got, "SECRET") {
				t.Errorf("大小写形态未覆盖: %q → %q", detail, got)
			}
		}
	})
	t.Run("已覆盖:单层 [] 与 &/; 两种分隔", func(t *testing.T) {
		for _, detail := range []string{
			"h https://example.com/x?authorization[]=SECRET",
			"h https://example.com/x?a=1;authtoken[]=SECRET",
			"h https://example.com/x?refresh-token[]=SECRET;b=2",
		} {
			if got := RedactAuditDetailForViewer(detail, "provider_delete", false); strings.Contains(got, "SECRET") {
				t.Errorf("数组式/分号形态未覆盖: %q → %q", detail, got)
			}
		}
	})
	t.Run("已覆盖:# 片段入口", func(t *testing.T) {
		detail := "h https://example.com/x#accessToken=SECRET"
		if got := RedactAuditDetailForViewer(detail, "provider_delete", false); strings.Contains(got, "SECRET") {
			t.Errorf("# 片段形态未覆盖: %q", got)
		}
	})
	// ---- 以下三条是**认账**:注释声明不覆盖,必须真的不覆盖 ----
	t.Run("不覆盖:单层 ; 路径参数", func(t *testing.T) {
		detail := "h https://example.com/notify;key=SECRET"
		if got := RedactAuditDetailForViewer(detail, "provider_delete", false); got != detail {
			t.Errorf("注释声明不覆盖 `;` 路径参数,但实际被脱敏了: %q(注释需同步)", got)
		}
	})
	t.Run("不覆盖:二次编码 %253B", func(t *testing.T) {
		for _, detail := range []string{
			// 单层编码的 URL + 二次编码的分隔符。
			"h https%3A%2F%2Fexample.com%2Fp%3Fa%3D1%253Bkey%253DSECRET",
			// 整串二次编码(连 scheme 都不成形,定位不到 URL)。
			"h https%253A%2F%2Fexample.com%252Fp%253Fkey%253DSECRET",
		} {
			if got := RedactAuditDetailForViewer(detail, "provider_delete", false); got != detail {
				t.Errorf("注释声明不覆盖二次编码,但实际被脱敏了: %q(注释需同步)", got)
			}
		}
	})
	t.Run("不覆盖:前导 %20", func(t *testing.T) {
		for _, detail := range []string{
			"h https://example.com/p?a=1;%20key=SECRET",
			"h https://example.com/p?a=1&%20key=SECRET",
		} {
			if got := RedactAuditDetailForViewer(detail, "provider_delete", false); got != detail {
				t.Errorf("注释声明不覆盖前导 %%20,但实际被脱敏了: %q(注释需同步)", got)
			}
		}
	})
}

// auditNamesPGShapes 真库/真读路径用的形态(修复前 auditor 能读到 token)。
type auditNamesPGShape struct {
	name   string
	action string
	detail string
	token  string
}

const auditNamesPGAuditor = "nm-auditor"
const auditNamesPGBoss = "nm-boss"

var auditNamesPGShapes = []auditNamesPGShape{
	{"accessToken 驼峰", "provider_delete",
		"upstream base_url=https://llm.example.com/v1?accessToken=NM-SECRET-CAMEL", "NM-SECRET-CAMEL"},
	{"access-token 连字符", "provider_delete",
		"upstream base_url=https://llm.example.com/v1?access-token=NM-SECRET-HYPHEN", "NM-SECRET-HYPHEN"},
	{"api-key", "provider_delete",
		"upstream base_url=https://llm.example.com/v1?api-key=NM-SECRET-APIKEY", "NM-SECRET-APIKEY"},
	{"authorization", "provider_delete",
		"upstream base_url=https://llm.example.com/v1?authorization=NM-SECRET-AUTHZ", "NM-SECRET-AUTHZ"},
	{"refresh_token 数组式 + 分号", "connector_update",
		"oauth https://idp.example.com/token?a=1;refresh_token[]=NM-SECRET-REFRESH", "NM-SECRET-REFRESH"},
	{"x-api-key 片段入口", "provider_delete",
		"upstream base_url=https://llm.example.com/v1#x-api-key=NM-SECRET-XAPIKEY", "NM-SECRET-XAPIKEY"},
	{"bearer", "provider_delete",
		"upstream base_url=https://llm.example.com/v1?bearer=NM-SECRET-BEARER", "NM-SECRET-BEARER"},
}

// auditNamesPGPlain 非凭据形态:auditor 侧必须**仍能看见**(误伤会牺牲审计可读性)。
// 刻意不含 `&`/`<`/`>` —— gin 的 json.Marshal 会把这些转义成 \u0026 之类,
// 逐字断言会假红(断言的是"有没有被折叠",不是 JSON 转义)。
var auditNamesPGPlain = []string{
	"server_base_url=https://harness.example/admin",
	"noise https://example.com/p?a=1;b=2",
	"noise https://example.com/p?keyish=NM-NOISE",
}

// TestAuditRedactNewNamesHTTP:真 PG + 真 /audit 读路径(RegisterAdminRoutes)。
//
// 断言:
//   - role=auditor(持 audit:read、不持 report:read)看不到本次补的任何形态明文;
//   - auditor 仍能看到非凭据 URL(未误伤);
//   - role=super_admin 读原文(可追溯性不牺牲);
//   - 读侧脱敏不写库:行数不变、库内 detail 原文保留、VerifyAuditChain 仍通过。
func TestAuditRedactNewNamesHTTP(t *testing.T) {
	db := mustDB(t)
	gin.SetMode(gin.TestMode)

	audID, err := serverstore.CreateUserWithPassword(db, auditNamesPGAuditor, "pw123456")
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

	bossID, err := serverstore.CreateUserWithPassword(db, auditNamesPGBoss, "pw123456")
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

	// 历史行:走真 AuditLog(参与 sha256 哈希链),不绕过写入侧。
	for _, s := range auditNamesPGShapes {
		if err := serverstore.AuditLog(db, auditNamesPGBoss, s.action, s.detail); err != nil {
			t.Fatalf("写审计: %v", err)
		}
	}
	for _, detail := range auditNamesPGPlain {
		if err := serverstore.AuditLog(db, auditNamesPGBoss, "gateway_update", detail); err != nil {
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
	for _, s := range auditNamesPGShapes {
		if strings.Contains(audBody, s.token) {
			t.Errorf("auditor 仍能读到 %s 的明文凭据 %q", s.name, s.token)
		}
	}
	for _, plain := range auditNamesPGPlain {
		if !strings.Contains(audBody, plain) {
			t.Errorf("非凭据 detail 被误伤(auditor 应能看见): %q", plain)
		}
	}
	if !strings.Contains(audBody, "llm.example.com/…（已脱敏）") {
		t.Error("脱敏后应保留可定位的主机名 llm.example.com")
	}

	status, bossBody := get(bossSess)
	if status != http.StatusOK {
		t.Fatalf("super_admin GET /audit = %d body=%s", status, bossBody)
	}
	for _, s := range auditNamesPGShapes {
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
	if err := db.QueryRow(
		"SELECT detail FROM audit_logs WHERE action='provider_delete' ORDER BY id LIMIT 1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "accessToken=NM-SECRET-CAMEL") {
		t.Fatalf("库内历史行被改写: %q", raw)
	}
	if _, err := serverstore.VerifyAuditChain(db); err != nil {
		t.Fatalf("读侧脱敏破坏了哈希链: %v", err)
	}
}

package llmgateway

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// S12-01(审计 2026-09-17)回归:库里存着「开关已打开 + DSN 为空」时,
// 「网关」页保存**任何**无关字段都不能再被跨字段规则 400 拦住。
//
// 存量可达性:v2.7.4 的 webadmin 对 DSN 零校验,且当时由「错误监控」页
// **同时提交两个字段**(enabled=true + dsn="")即可写入成功;而这一版之后的
// 「网关」页只提交自己那 6 个字段(F-07 白名单,页面上根本没有 DSN 输入框,
// 见 server/webadmin/src/pages/Gateway.tsx)。若跨字段判定仍按"生效后"的
// 值拦截,该页的每一次保存(限流/默认模型/高峰时段/对外地址)都会 400,
// 报的还是本页不存在的字段 —— 管理员在本页无法自救。
//
// 所以判定口径与 F-07 一致:只有**本次提交显式提供** error_reporting_enabled
// 或 error_reporting_dsn 时才拒绝;未提供时降级为告警,并在文案里指向唯一
// 能修的地方(「错误监控」页)。不变量仍然成立:坏状态无法被**新建**
// (新建必须显式提交字段,那条路径照旧 400)。
func TestGatewayPartialSaveIgnoresStoredEnabledWithoutDSN(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 复现存量状态:enabled="true" + dsn=""(旧版页面能写入的组合)。
	if err := serverstore.SetSetting(db, "web.error_reporting_enabled", "true"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "web.error_reporting_dsn", ""); err != nil {
		t.Fatal(err)
	}

	// (1) 「网关」页形态的局部更新:必须 200(修复前恒 400)。
	w, out := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"rate_limit":321}`, hdr)
	if w.Code != 200 {
		t.Fatalf("partial update blocked by stored enabled-without-DSN: %d %s", w.Code, w.Body.String())
	}
	if got, _, _ := serverstore.GetSetting(db, "gateway.rate_limit"); got != "321" {
		t.Fatalf("rate_limit not saved: %q (want 321)", got)
	}
	// 存量状态本身不得被这次保存改写。
	if got, _, _ := serverstore.GetSetting(db, "web.error_reporting_enabled"); got != "true" {
		t.Fatalf("stored enabled must stay untouched, got %q", got)
	}
	if got, _, _ := serverstore.GetSetting(db, "web.error_reporting_dsn"); got != "" {
		t.Fatalf("stored DSN must stay untouched, got %q", got)
	}
	// 但必须如实告警,并指向唯一能修的页面(不能把坏状态渲染成一切正常)。
	warnings, _ := out["warnings"].([]any)
	warned := false
	for _, raw := range warnings {
		if text, ok := raw.(string); ok && strings.Contains(text, "错误监控") && strings.Contains(text, "DSN 为空") {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("expected a warning pointing at the 错误监控 page, got %v", out["warnings"])
	}

	// (2) 不变量:坏状态仍**无法被新建** —— 显式提交任一字段就回到严格判定。
	// 这里显式打开开关(DSN 仍为空)= 原本就该拒的组合。
	wExplicit, outExplicit := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"error_reporting_enabled":true}`, hdr)
	if wExplicit.Code != 400 {
		t.Fatalf("explicit enable with empty DSN must stay rejected, got %d %s", wExplicit.Code, wExplicit.Body.String())
	}
	// 400 文案必须能自我定位(指向「错误监控」页),否则管理员只知道被拒。
	//
	// TQ-5(审计 2026-09-17,r2 test-quality):信封本身也是断言的一部分 ——
	// 此前这段消息断言被 `if errBody != nil` 包着,一旦拒绝改成 c.String
	// (text/plain,违反 server/AGENTS.md §7),类型断言失败就整段跳过、只剩
	// 状态码 400 仍然为真,用例照旧绿;而 webadmin 正是靠这个信封渲染文案。
	errBody, ok := outExplicit["error"].(map[string]any)
	if !ok {
		t.Fatalf("rejection must use the JSON error envelope, got %s", wExplicit.Body.String())
	}
	if msg, _ := errBody["message"].(string); !strings.Contains(msg, "错误监控") {
		t.Fatalf("rejection must point at the 错误监控 page, got %q", msg)
	}

	// (3) 显式清空 DSN(有值 → 空)在开关打开时仍然 400,且不得写入。
	if err := serverstore.SetSetting(db, "web.error_reporting_dsn", "https://key@glitchtip.example.com/1"); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"error_reporting_dsn":""}`, hdr); w.Code != 400 {
		t.Fatalf("explicit clear while enabled must stay rejected, got %d %s", w.Code, w.Body.String())
	}
	if got, _, _ := serverstore.GetSetting(db, "web.error_reporting_dsn"); got != "https://key@glitchtip.example.com/1" {
		t.Fatalf("rejected clear must not be written, stored=%q", got)
	}
}

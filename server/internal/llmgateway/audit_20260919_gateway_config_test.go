package llmgateway

// 审计 2026-09-19:白名单校验必须早于任何写库。
//
// 缺陷形态:`PUT /api/server/admin/gateway` 的两条白名单校验
// (`error_reporting_level` / `default_thinking_level`)原先写在**各自的写入分支
// 内** —— 排在前面的字段(rate_limit / default_model / peak_windows /
// retention_months / error_reporting_dsn…)已经落库,随后才发现等级字段非法并
// 返回 400。与该函数自己声明的纪律直接矛盾(见 DSN 准入校验处的注释:
// "必须放在任何写库之前 —— 拒绝时不允许留下半套已生效的配置")。
//
// 复现实证:PUT {"rate_limit":"120","error_reporting_level":"fatal"} → 400,
// 但 gateway.rate_limit 已经是新值(而且下一次计费/限流立即按新值生效)。
//
// 判据:拒绝时**一个字段都不许落库**;成功路径与 400 响应体逐字不变。

import (
	"net/http"
	"testing"
)

func TestSetGatewayConfigRejectsLevelBeforeAnyWrite(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	readSetting := func(key string) (string, bool) {
		t.Helper()
		var v string
		err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
		if err != nil {
			return "", false
		}
		return v, true
	}

	// 基线:先成功写入,拿到"不该被拒绝请求改写"的现值。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"rate_limit":"120"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("baseline rate_limit 写入失败: %d", w.Code)
	}
	if v, ok := readSetting("gateway.rate_limit"); !ok || v != "120" {
		t.Fatalf("baseline rate_limit = %q/%v, want 120", v, ok)
	}

	cases := []struct {
		name       string
		body       string
		wantBody   string
		otherKey   string
		otherValue string
	}{
		{
			name:       "error_reporting_level 非法",
			body:       `{"rate_limit":"999","error_reporting_level":"fatal"}`,
			wantBody:   `{"error":{"code":"VALIDATION","message":"reporting_level 必须是 error|warning|info|debug"}}`,
			otherKey:   "web.error_reporting_level",
			otherValue: "",
		},
		{
			name:       "default_thinking_level 非法",
			body:       `{"rate_limit":"888","default_thinking_level":"ultra"}`,
			wantBody:   `{"error":{"code":"VALIDATION","message":"default_thinking_level 必须是 off|low|high|max"}}`,
			otherKey:   "web.default_thinking_level",
			otherValue: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", c.body, hdr)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body=%s)", w.Code, w.Body.String())
			}
			// 400 响应体逐字不变。
			if got := w.Body.String(); got != c.wantBody {
				t.Fatalf("400 响应体 = %s, want %s", got, c.wantBody)
			}
			// 半套配置:排在前面的合法字段不得落库。
			if v, _ := readSetting("gateway.rate_limit"); v != "120" {
				t.Fatalf("拒绝的请求改写了 gateway.rate_limit: %q (want 120)", v)
			}
			// 被拒字段自身也不得落库。
			if v, ok := readSetting(c.otherKey); ok && v != c.otherValue {
				t.Fatalf("拒绝的请求写入了 %s: %q", c.otherKey, v)
			}
		})
	}

	// 合法取值仍然成功(成功路径不变)。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"321","error_reporting_level":"warning","default_thinking_level":"max"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("合法等级字段被拒: %d %s", w.Code, w.Body.String())
	}
	if v, _ := readSetting("gateway.rate_limit"); v != "321" {
		t.Fatalf("成功路径未写入 rate_limit: %q", v)
	}
	if v, ok := readSetting("web.error_reporting_level"); !ok || v != "warning" {
		t.Fatalf("成功路径未写入 error_reporting_level: %q/%v", v, ok)
	}
	if v, ok := readSetting("web.default_thinking_level"); !ok || v != "max" {
		t.Fatalf("成功路径未写入 default_thinking_level: %q/%v", v, ok)
	}
	// 显式空串(清除档位)仍然合法。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"default_thinking_level":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("显式空串应合法: %d %s", w.Code, w.Body.String())
	}
}

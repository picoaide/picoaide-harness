package llmgateway

// 2026-09-23(第三轮 §7.3 D):api_key 的"掩码哨兵"必须是**显式**语义。
//
// 缺陷形态(W2-3):GET /providers 把 api_key 输出成 "***"(providerJSON),
// 写入侧只看"非空" ⇒ 任何"读-改-写"式客户端把 GET 的输出原样 PUT 回来,真密钥
// 被静默写成字面量 "***" 并回 200(之后该上游全部请求 401/403,响应无任何提示)。
//
// 定案 = **拒绝**(400 VALIDATION + 可行动文案)。核实依据:
//   - webadmin 的编辑弹窗从不回传掩码(openProviderEdit 把 api_key 置空、
//     saveProviderEdit 只在非空时提交该字段,webadmin/src/pages/Gateway.tsx),
//     所以 400 不会打断任何仓内合法调用方;
//   - 仓内唯一会回传 "***" 的调用方指向**认证配置**端点(serverauth.MaskSecret
//     的"保持现值"语义),与 provider 密钥无关;
//   - 密钥被写坏的代价是全线鉴权失败,静默接受哨兵只会把客户端的 bug 藏起来。
// 既有的"省略字段(或空串)= 保持不变"语义必须同时被钉住不退化。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// TestAdminProviderUpdateMaskedAPIKeyIsRejected 走 W2-3 的原始复现路径:
// GET 的输出原样 PUT 回去必须**被拒**,且库里一字未动。
func TestAdminProviderUpdateMaskedAPIKeyIsRejected(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"http://x","api_key":"orig-key","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("建上游: %d %s", w.Code, w.Body.String())
	}
	before := providerPutSnapshot(t, db, 1)

	// GET 的输出(含 api_key="***")原样 PUT 回去。
	w, out := adminReq(t, r, "GET", "/api/server/admin/providers", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("GET providers: %d %s", w.Code, w.Body.String())
	}
	list, ok := out["providers"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("GET providers 结构异常: %s", w.Body.String())
	}
	verbatim, err := json.Marshal(list[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(verbatim), `"api_key":"***"`) {
		t.Fatalf("前置条件不成立:GET 的输出没有掩码密钥: %s", verbatim)
	}

	w2, out2 := adminReq(t, r, "PUT", "/api/server/admin/providers/1", string(verbatim), hdr)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("原样回传掩码密钥: 状态 = %d %s, want 400(旧行为是 200 + 真密钥被写成字面量 ***)",
			w2.Code, w2.Body.String())
	}
	errObj, _ := out2["error"].(map[string]any)
	if errObj == nil || errObj["code"] != "VALIDATION" {
		t.Fatalf("失败信封 = %v, want code=VALIDATION", out2)
	}
	msg, _ := errObj["message"].(string)
	for _, want := range []string{"掩码", "省略"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("错误文案不可行动(缺 %q): %q", want, msg)
		}
	}
	if after := providerPutSnapshot(t, db, 1); after.Provider != before.Provider || after.AuditAll != before.AuditAll {
		t.Fatalf("被拒的请求改动了库:\n before=%s\n after =%s (audit %d→%d)",
			before.Provider, after.Provider, before.AuditAll, after.AuditAll)
	}

	// 只带掩码字段的窄请求同样被拒(不是"因为整行其他字段"才拒)。
	if w3, _ := adminReq(t, r, "PUT", "/api/server/admin/providers/1", `{"api_key":"***"}`, hdr); w3.Code != http.StatusBadRequest {
		t.Fatalf(`PUT {"api_key":"***"}: 状态 = %d, want 400`, w3.Code)
	}
	// 创建路径同样拒绝:把 GET 的掩码粘进创建请求会得到一个鉴权必失败的上游。
	if w4, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"masked","base_url":"http://x","api_key":"***","models":["m2"]}`, hdr); w4.Code != http.StatusBadRequest {
		t.Fatalf(`POST api_key="***": 状态 = %d %s, want 400`, w4.Code, w4.Body.String())
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM gateway_providers`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("拒绝路径留下了行:gateway_providers = %d 行, want 1", n)
	}
}

// TestAdminProviderUpdateOmittedAPIKeyKeepsStoredKey 钉住"省略字段 = 保持不变"
// 这条既有语义不因为 §7.3 D 的拒绝而退化(含空串形态),并正向对照真正的轮换。
func TestAdminProviderUpdateOmittedAPIKeyKeepsStoredKey(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"http://x","api_key":"orig-key","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("建上游: %d %s", w.Code, w.Body.String())
	}
	keyOf := func() string { return providerRowField(gatewayProviderRowDump(t, db, 1), "api_key_enc") }
	orig := keyOf()

	// ① 完全省略 api_key:改名 + 改 base_url 都必须保留密钥。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/providers/1",
		`{"name":"renamed","base_url":"http://y"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("省略 api_key 的 PUT: %d %s", w.Code, w.Body.String())
	}
	if got := keyOf(); got != orig {
		t.Fatalf("省略 api_key 却换了密钥: %q → %q", orig, got)
	}
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = 'provider_update' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(detail, "api_key:已更换") {
		t.Fatalf("没换密钥却记了 api_key:已更换: %q", detail)
	}

	// ② 空串形态:历史语义同样视为"不更换"。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/providers/1", `{"api_key":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("空串 api_key 的 PUT: %d %s", w.Code, w.Body.String())
	}
	if got := keyOf(); got != orig {
		t.Fatalf("空串 api_key 却换了密钥: %q → %q", orig, got)
	}

	// ③ 正向对照:真的传新密钥必须换,且审计记"已更换"。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/providers/1", `{"api_key":"rotated"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("轮换密钥的 PUT: %d %s", w.Code, w.Body.String())
	}
	if got := keyOf(); got == orig || got == "" {
		t.Fatalf("真密钥没落库: %q → %q", orig, got)
	}
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = 'provider_update' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "api_key:已更换") {
		t.Fatalf("轮换密钥没有留痕: %q", detail)
	}
}

// TestAdminProviderUpdateMissingProviderStillNotFound 钉住响应码次序:JSON 绑定与
// 请求体校验被提前到事务外之后,PUT 到不存在的 id 仍必须是 404 NOT_FOUND
// (而不是被 400 抢先),且不得写任何审计。
func TestAdminProviderUpdateMissingProviderStillNotFound(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "PUT", "/api/server/admin/providers/999", `{"name":"x"}`, hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("PUT 不存在的上游: 状态 = %d %s, want 404", w.Code, w.Body.String())
	}
	if errObj, _ := out["error"].(map[string]any); errObj == nil || errObj["code"] != "NOT_FOUND" {
		t.Fatalf("失败信封 = %v, want code=NOT_FOUND", out)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'provider_update'`); n != 0 {
		t.Fatalf("404 路径写了审计: %d 条", n)
	}
}

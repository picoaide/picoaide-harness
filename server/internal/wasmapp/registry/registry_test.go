package registry

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 变异验证：
//   - 去掉"纯数字"分支 ⇒ TestValidateAppIDDigits 必红；
//   - 去掉保留字分支 ⇒ TestValidateAppIDReserved 必红；
//   - CompareVersions 把 prerelease 比较反过来 ⇒ TestCompareVersions 必红；
//   - CheckArtifactQuota 去掉上限 ⇒ TestArtifactQuota 必红。

func TestValidateAppIDAccept(t *testing.T) {
	for _, id := range []string{"a", "expense-note", "app1", "x1y2z3", strings.Repeat("a", limits.MaxAppIDLen)} {
		if err := ValidateAppID(id, nil); err != nil {
			t.Errorf("ValidateAppID(%q) 应通过，got %v", id, err)
		}
	}
}

func TestValidateAppIDReject(t *testing.T) {
	cases := []struct{ id, why string }{
		{"", "空"},
		{"Expense", "大写"},
		{"expense_note", "下划线"},
		{"expense--note", "连续连字符"},
		{"-expense", "首连字符"},
		{"expense-", "尾连字符"},
		{strings.Repeat("a", limits.MaxAppIDLen+1), "超过 63"},
	}
	for _, c := range cases {
		err := ValidateAppID(c.id, nil)
		if err == nil {
			t.Errorf("ValidateAppID(%q) 应被拒（%s）", c.id, c.why)
			continue
		}
		if err.Code != apperr.CodeInvalidAppID {
			t.Errorf("app_id=%q code=%s want INVALID_APP_ID", c.id, err.Code)
		}
		if err.Status() != 400 {
			t.Errorf("app_id=%q http=%d want 400（§10.5 第 53 项）", c.id, err.Status())
		}
	}
}

// TestValidateAppIDDigits：纯数字会被误认成 IP（§4.1 / §10.5 第 53 项）。
func TestValidateAppIDDigits(t *testing.T) {
	for _, id := range []string{"1", "123", "192", "1000"} {
		if err := ValidateAppID(id, nil); err == nil {
			t.Errorf("app_id=%q 是纯数字，必须拒（避免 IP 形态）", id)
		}
	}
	// 含字母的数字混排是合法的。
	if err := ValidateAppID("app1", nil); err != nil {
		t.Errorf("app1 应合法：%v", err)
	}
}

// TestValidateAppIDPunycode：xn-- 前缀保留给国际化域名（§4.1）。
func TestValidateAppIDPunycode(t *testing.T) {
	if err := ValidateAppID("xn--fiqs8s", nil); err == nil {
		t.Fatal("xn-- 前缀必须拒")
	}
}

// TestValidateAppIDReserved：保留字不得被占用（§4.1 / §10.5 第 53b 项）。
func TestValidateAppIDReserved(t *testing.T) {
	for _, id := range []string{"www", "api", "admin", "portal", "app", "apps", "updates", "static", "cdn", "sso", "login", "auth", "acme"} {
		if err := ValidateAppID(id, nil); err == nil {
			t.Errorf("保留字 %q 必须拒（否则会抢走企业域名资产）", id)
		}
	}
	// limits 里的每个保留字都要真的拦住（防"表加了字但逻辑没跟上"）。
	for _, w := range limits.ReservedAppIDs {
		if err := ValidateAppID(w, nil); err == nil {
			t.Errorf("limits.ReservedAppIDs 里的 %q 未被拦截", w)
		}
	}
}

// TestValidateAppIDExtraReserved：部署期注入的企业已知主机名（§4.1）。
func TestValidateAppIDExtraReserved(t *testing.T) {
	extra := []string{"intranet", "OA"}
	for _, id := range []string{"intranet", "oa"} {
		if err := ValidateAppID(id, extra); err == nil {
			t.Errorf("企业既有主机名 %q 必须拒（大小写不敏感）", id)
		}
	}
	if err := ValidateAppID("other", extra); err != nil {
		t.Errorf("非保留名应通过：%v", err)
	}
}

// TestValidateAppIDRouteStaticSegment：与平台**路由静态段**同名必须拒（X4-1）。
//
// 现场（第二十四轮审计）：`uploads` 不在旧 host label 清单里 ⇒ 写侧放行、
// 分片上传链路还能把它发布出去，但发布完之后 `/apps/wasm/uploads/open|request|
// publish|rows|…` 全部 404（或被 `/uploads/:upload_id` 吃掉）⇒ 应用建完即废、
// 归属与版本号永久占位。修法 = 路由静态段集合由 `internal/router` 从真实路由表
// 派生后注入本包（`SetRouteReservedAppIDs`），写侧 fail-loud。
//
// 变异验证：把下面这次注入去掉（或把 `routeReserved` 判据删掉）⇒ 本用例必红；
// 把集合设成空 ⇒ 必红（`uploads` 会漏过）。
func TestValidateAppIDRouteStaticSegment(t *testing.T) {
	// 基线：在本包的单测里没有 router 注入 ⇒ 路由段判据静默缺席是**已知**的，
	// 所以这里显式注入（生产路径由 router.Register 注入；接线判据在
	// internal/router/wasm_appid_route_test.go）。
	segs := []string{"availability", "catalog", "open", "proof", "uploads", "validate"}
	SetRouteReservedAppIDs(segs)
	defer SetRouteReservedAppIDs(nil)

	got := RouteReservedAppIDs()
	if len(got) != len(segs) {
		t.Fatalf("RouteReservedAppIDs 回读 %v，期望 %v（集合被丢了）", got, segs)
	}
	for _, seg := range segs {
		aerr := ValidateAppID(seg, nil)
		if aerr == nil {
			t.Errorf("app_id=%q 与路由静态段同名，必须拒（放过去 = 应用建完即废且永久占名）", seg)
			continue
		}
		if aerr.Code != apperr.CodeInvalidAppID {
			t.Errorf("app_id=%q code=%s want INVALID_APP_ID", seg, aerr.Code)
		}
		// 理由必须点名"路由静态段"，否则运维查不到病根（会以为是 DNS 保留字）。
		if aerr.Details["reason"] != "route_static_segment" {
			t.Errorf("app_id=%q 的 detail.reason=%v，期望 route_static_segment", seg, aerr.Details["reason"])
		}
	}
	// 大小写：app_id 本身必须全小写，路由段也不会以大写入表。
	if err := ValidateAppID("Uploads", nil); err == nil {
		t.Error("大写 Uploads 应因形状被拒")
	}
	// 合法名字不受影响。
	for _, ok := range []string{"myapp", "expense-note", "app1"} {
		if err := ValidateAppID(ok, nil); err != nil {
			t.Errorf("合法 app_id %q 被误拒：%v", ok, err)
		}
	}
	// 清空注入后回到"无路由段"语义（不残留状态污染其他用例）。
	SetRouteReservedAppIDs(nil)
	if err := ValidateAppID("uploads", nil); err != nil {
		t.Errorf("清空注入后 uploads 不该再被路由段判据拒（fail-loud 的接线由 router 侧判据守）：%v", err)
	}
}

func TestValidateVersion(t *testing.T) {
	for _, v := range []string{"1.0.0", "0.0.1", "10.20.30", "1.0.0-beta.1", "2.3.1-rc.2"} {
		if err := ValidateVersion(v); err != nil {
			t.Errorf("ValidateVersion(%q) 应通过：%v", v, err)
		}
	}
	for _, v := range []string{"", "1.0", "1", "v1.0.0", "1.0.0.0", "1.0.0-", "abc"} {
		if err := ValidateVersion(v); err == nil {
			t.Errorf("ValidateVersion(%q) 应被拒（§10.5 第 54 项：1.0 非法）", v)
		}
	}
}

// TestCompareVersions 覆盖 §4.1「必须严格递增」的全部边界。
func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.1", "1.0.0", 1},
		{"1.0.0", "1.0.1", -1},
		{"2.0.0", "1.9.9", 1},
		{"1.10.0", "1.9.0", 1},
		{"1.0.0", "1.0.0-beta.1", 1},  // 正式版 > 预发布版
		{"1.0.0-beta.1", "1.0.0", -1}, //
		{"1.0.0-beta.2", "1.0.0-beta.1", 1},
		{"1.0.0-beta.10", "1.0.0-beta.9", 1}, // 数字段按数值比（不是字典序）
		{"1.0.0-alpha", "1.0.0-beta", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha", 1}, // 更多段更大
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q,%q)=%d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestMustBeNewer(t *testing.T) {
	if err := MustBeNewer("1.0.0", ""); err != nil {
		t.Fatalf("首个版本无需比较：%v", err)
	}
	if err := MustBeNewer("1.0.1", "1.0.0"); err != nil {
		t.Fatalf("递增应通过：%v", err)
	}
	for _, worse := range []string{"1.0.0", "0.9.9", "1.0.0-rc.1"} {
		err := MustBeNewer(worse, "1.0.0")
		if err == nil {
			t.Fatalf("MustBeNewer(%q,1.0.0) 应被拒", worse)
		}
		if err.Code != apperr.CodeVersionNotNewer {
			t.Fatalf("code=%s want VERSION_NOT_NEWER", err.Code)
		}
	}
}

// TestValidateChangelog：非首版必填（§10.5 第 55 项）。
func TestValidateChangelog(t *testing.T) {
	if err := ValidateChangelog("", true); err != nil {
		t.Fatalf("首版可以没有 changelog：%v", err)
	}
	err := ValidateChangelog("   ", false)
	if err == nil {
		t.Fatal("非首版空 changelog 必须拒")
	}
	if err.Code != apperr.CodeMissingField || err.Status() != 422 {
		t.Fatalf("code=%s http=%d want MISSING_FIELD/422（§10.5 第 55 项）", err.Code, err.Status())
	}
}

// TestArtifactQuota：每用户 1 GiB（§5.3）。
func TestArtifactQuota(t *testing.T) {
	q := int64(limits.ArtifactQuotaPerUserBytes)
	if err := CheckArtifactQuota(0, q); err != nil {
		t.Fatalf("恰好等于配额应通过：%v", err)
	}
	err := CheckArtifactQuota(0, q+1)
	if err == nil {
		t.Fatal("超出配额必须拒")
	}
	if err.Details["quota_bytes"] != q {
		t.Fatalf("details 应带 quota_bytes，got %v", err.Details)
	}
	if err := CheckArtifactQuota(q-1, 1); err != nil {
		t.Fatalf("恰好填满应通过：%v", err)
	}
	if err := CheckArtifactQuota(q, 1); err == nil {
		t.Fatal("再超一字节必须拒")
	}
}

func TestNormalizeAppID(t *testing.T) {
	if got := NormalizeAppID("  Expense-Note "); got != "expense-note" {
		t.Fatalf("NormalizeAppID=%q", got)
	}
}

// TestR24X4ServeSideDoesNotApplyRouteStaticReserved 钉住"写侧规则不得套在存量行上"：
//
// 第二十四轮 X4-1 让 app_id 不能与平台路由静态段同名（写侧 fail-loud，防止新发布的应用
// 建得成、打不开）。但服务侧若共用同一条判据，**存量库里已有的这类行**（例如 `rows`）会在
// 升级后直接 404 —— 那是修复引入的回归。本用例是它的回归判据：
//   - 写侧：静态段名必须被拒（路由遮蔽由写侧拦下）
//   - 服务侧：静态段名必须放行（存量行照常服务；服务侧仍保留形态/平台保留字/企业主机名三条）
func TestR24X4ServeSideDoesNotApplyRouteStaticReserved(t *testing.T) {
	SetRouteReservedAppIDs([]string{"uploads", "rows", "releases"})
	t.Cleanup(func() { SetRouteReservedAppIDs(nil) })

	for _, id := range []string{"uploads", "rows", "releases"} {
		if err := ValidateAppID(id, nil); err == nil {
			t.Fatalf("写侧必须拒绝与路由静态段同名的 app_id：%q", id)
		}
		if err := ValidateAppIDForServing(id, nil); err != nil {
			t.Fatalf("服务侧不得套用路由静态段规则（存量行会在升级后消失）：%q → %v", id, err)
		}
	}

	// 服务侧仍保留既有三条语义（与写侧同源，只差 routeStatic 开关）。
	if err := ValidateAppIDForServing("Bad_Name", nil); err == nil {
		t.Fatal("服务侧仍必须校验形态")
	}
	if err := ValidateAppIDForServing("12345", nil); err == nil {
		t.Fatal("服务侧仍必须拒绝纯数字")
	}
	if err := ValidateAppIDForServing("myapp", []string{"myapp"}); err == nil {
		t.Fatal("服务侧仍必须拒绝企业既有主机名")
	}
	// 写侧与服务侧在"非路由保留字"的输入上必须逐条同结论（同源证据）。
	for _, id := range []string{"myapp", "expense-note", "Bad_Name", "12345", "xn--fiq", ""} {
		w, s := ValidateAppID(id, nil), ValidateAppIDForServing(id, nil)
		if (w == nil) != (s == nil) {
			t.Fatalf("写侧与服务侧在 %q 上分叉：写侧=%v 服务侧=%v", id, w, s)
		}
	}
}

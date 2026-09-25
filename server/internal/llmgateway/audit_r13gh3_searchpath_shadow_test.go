package llmgateway

// R13-GH3 · H1（`search_path` 同族「第三条路径」）：**跨包读面/写面在敌对
// `search_path` 下必须读/写 public**。
//
// 来源：V13-B 的独立探针（`temp/r13/V13B/probe/llmgateway-shadow-third-path_test.go`）
// 在修复前实测 `llmgateway.ListModels` 读到 shadow 的诱饵模型 —— 而当时
// `grep search_path server/internal/llmgateway/*.go` 零命中、机械守卫的文件面是
// `filepath.Glob("*.go")`（只看 `internal/serverstore` 包）。本文件把那支探针收成
// **正式判据**，并把覆盖面从"只有 ListModels"扩到 llmgateway 的全部族内面：
//
//	① 模型目录读 `ListModels`（models ⋈ gateway_providers）；
//	② 上游路由与密钥读 `LoadUpstreams`（gateway_providers.base_url/api_key_enc
//	   + 每 provider 的 models 名）；
//	③ 管理端写事务（`PUT /api/server/admin/gateway` → settings）：五处
//	   `db.Begin()` 全部换成 `serverstore.UsageWriteTx`；
//	④ 审计写 `AuditLog`（audit_logs 本轮纳入族内集合）。
//
// 判据口径：**同一个库、同一个数据，只换池的 search_path**。敌对池
// `search_path=<shadow>,public` 里放同名 tables 的诱饵行；任何"读错对象"都会
// 让两侧读数不同 ⇒ 断言必须相等即"读的是 public"。这是 V13-B 探针的取向
// （不是"修复方说修前红"），也是本仓"判据与动作看同一个对象"纪律的运行时判据。
//
// 变异（拆掉 pin 即红，实跑证据见 temp/r13/GH3/REPORT.md）：
//   拆掉 ListModels 的 WithUsageSearchPathRead ⇒ ① 读到 r13gh3-shadow-model；
//   拆掉 loadUpstreamsDB 的 pin                ⇒ ② 上游 base_url/密钥来自 shadow；
//   拆掉 UsageWriteTx（改回 db.Begin）          ⇒ ③ settings 写进 shadow；
//   拆掉 audit 侧的 usageWriteTx                ⇒ ④ 审计落进 shadow。

import (
	"database/sql"
	"fmt"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

const r13gh3ShadowSchema = "r13gh3_shadow"

// r13gh3SidePool 开一个 search_path 被前置 shadow 的**旁路池**。
//
// 夹具 = serverstore.OpenShadowSearchPathPool（唯一实现，与 serverstore 包内的读面
// 判据共用同一份）：同一个库、同一批数据，只把解析顺序前置一个同名 shadow schema
// —— 任何"读错对象"都会让两侧读数不同，于是"断言必须相等"就是"读的是 public"。
func r13gh3SidePool(t *testing.T, db *sql.DB, schema string) *sql.DB {
	t.Helper()
	return serverstore.OpenShadowSearchPathPool(t, db, schema)
}

// r13gh3InstallShadow 造一株与产品同名的 shadow 树（族内关系 + 审计表），
// 并把每个表按需求播上诱饵值。返回旁路池。
func r13gh3InstallShadow(t *testing.T, db *sql.DB) *sql.DB {
	t.Helper()
	for _, s := range []string{
		"DROP SCHEMA IF EXISTS " + r13gh3ShadowSchema + " CASCADE",
		"CREATE SCHEMA " + r13gh3ShadowSchema,
		fmt.Sprintf("CREATE TABLE %s.models (LIKE public.models INCLUDING ALL)", r13gh3ShadowSchema),
		fmt.Sprintf("CREATE TABLE %s.gateway_providers (LIKE public.gateway_providers INCLUDING ALL)", r13gh3ShadowSchema),
		fmt.Sprintf("CREATE TABLE %s.settings (LIKE public.settings INCLUDING ALL)", r13gh3ShadowSchema),
		fmt.Sprintf("CREATE TABLE %s.audit_logs (LIKE public.audit_logs INCLUDING ALL)", r13gh3ShadowSchema),
	} {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("造 shadow: %v\n%s", err, s)
		}
	}
	t.Cleanup(func() {
		_, _ = db.Exec("DROP SCHEMA IF EXISTS " + r13gh3ShadowSchema + " CASCADE")
	})
	return r13gh3SidePool(t, db, r13gh3ShadowSchema)
}

// r13gh3SeedProviders 在 public 与 shadow 两侧各播一个**同名不同路由**的 provider，
// 并各播一个只有该侧才有的模型。返回两侧的 provider id。
func r13gh3SeedProviders(t *testing.T, db *sql.DB) (pubProvID, shadowProvID int64) {
	t.Helper()
	if err := db.QueryRow(`INSERT INTO public.gateway_providers (name, base_url, api_key_enc, models, enabled, protocol)
		VALUES ('r13gh3-prov','https://public-upstream.example.com','public-key','[]',1,'openai') RETURNING id`).Scan(&pubProvID); err != nil {
		t.Fatalf("播 public provider: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO public.models (name, provider_id, display_name, default_params)
		VALUES ('r13gh3-real-model',$1,'real','{}')`, pubProvID); err != nil {
		t.Fatalf("播 public model: %v", err)
	}
	if err := db.QueryRow(`INSERT INTO ` + r13gh3ShadowSchema + `.gateway_providers (name, base_url, api_key_enc, models, enabled, protocol)
		VALUES ('r13gh3-prov','https://shadow-upstream.example.com','shadow-key','[]',1,'openai') RETURNING id`).Scan(&shadowProvID); err != nil {
		t.Fatalf("播 shadow provider: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO `+r13gh3ShadowSchema+`.models (name, provider_id, display_name, default_params)
		VALUES ('r13gh3-shadow-model',$1,'shadow','{}')`, shadowProvID); err != nil {
		t.Fatalf("播 shadow model: %v", err)
	}
	return pubProvID, shadowProvID
}

func r13gh3ModelNames(ms []Model) []string {
	out := []string{}
	for _, m := range ms {
		out = append(out, m.ID)
	}
	return out
}

// TestAuditR13GH3LlmGatewayModelCatalogReadsPublic ①：模型目录读。
func TestAuditR13GH3LlmGatewayModelCatalogReadsPublic(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	side := r13gh3InstallShadow(t, db)
	r13gh3SeedProviders(t, db)

	pub, err := ListModels(db)
	if err != nil {
		t.Fatalf("public ListModels: %v", err)
	}
	got, err := ListModels(side)
	if err != nil {
		t.Fatalf("敌对池 ListModels: %v", err)
	}
	t.Logf("public ListModels=%v | 敌对 search_path ListModels=%v", r13gh3ModelNames(pub), r13gh3ModelNames(got))
	if len(got) != len(pub) {
		t.Errorf("两侧模型数不同：public=%v 敌对池=%v —— 目录读没有看同一个对象", r13gh3ModelNames(pub), r13gh3ModelNames(got))
	}
	for _, m := range got {
		if m.ID == "r13gh3-shadow-model" {
			t.Errorf("ListModels 读到 shadow 的诱饵模型（同族第三条路径未收口）：got=%v", r13gh3ModelNames(got))
		}
		if m.ID == "r13gh3-real-model" && m.DisplayName != "real" {
			t.Errorf("ListModels 读到的 r13gh3-real-model 显示名 = %q（public 是 real）—— 读的是 shadow 的同名行", m.DisplayName)
		}
	}
}

// TestAuditR13GH3LlmGatewayUpstreamRouteReadsPublic ②：上游路由**与密钥**读。
//
// 这是 V13-B 判定"后果比族内注释里那句『静默错数字』更重"的那条：base_url +
// api_key_enc 读自 shadow ⇒ 网关把请求（连同员工的模型流量）发往诱饵上游。
func TestAuditR13GH3LlmGatewayUpstreamRouteReadsPublic(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	// 密钥解密在真实部署里由 master key 提供；这里只关心"哪一行被读到"，
	// 所以用恒等解密（`api_key_enc` 明文）。默认实现返回错误 ⇒ 每个 provider
	// 都会被 LoadUpstreams 跳过，判据会退化成"两侧都空"的假绿。
	prevDecrypt := DecryptSecret
	DecryptSecret = func(s string) (string, error) { return s, nil }
	t.Cleanup(func() { DecryptSecret = prevDecrypt })
	side := r13gh3InstallShadow(t, db)
	pubProvID, shadowProvID := r13gh3SeedProviders(t, db)

	InvalidateUpstreams()
	pub, err := LoadUpstreams(db)
	if err != nil {
		t.Fatalf("public LoadUpstreams: %v", err)
	}
	InvalidateUpstreams()
	got, err := LoadUpstreams(side)
	if err != nil {
		t.Fatalf("敌对池 LoadUpstreams: %v", err)
	}
	byID := func(ups []Upstream) map[int64]Upstream {
		m := map[int64]Upstream{}
		for _, u := range ups {
			m[u.ID] = u
		}
		return m
	}
	pubBy, gotBy := byID(pub), byID(got)
	if _, ok := gotBy[shadowProvID]; ok {
		t.Errorf("LoadUpstreams 读到了 shadow 的 provider id=%d（上游路由与密钥来自 shadow）：敌对池=%v", shadowProvID, gotBy)
	}
	p, ok := gotBy[pubProvID]
	if !ok {
		t.Fatalf("LoadUpstreams 在敌对池下没有读到 public 的 provider id=%d（两侧读数不一致）：public=%v 敌对池=%v", pubProvID, pubBy, gotBy)
	}
	if p.BaseURL != "https://public-upstream.example.com" || p.APIKey != "public-key" {
		t.Errorf("上游路由读错对象：base_url=%q api_key=%q（public 是 public-upstream.example.com/public-key）",
			p.BaseURL, p.APIKey)
	}
	// 逐 provider 的 models 名（syncedModelNames）也必须读 public：
	hasReal, hasShadow := false, false
	for _, m := range p.Models {
		switch m {
		case "r13gh3-real-model":
			hasReal = true
		case "r13gh3-shadow-model":
			hasShadow = true
		}
	}
	t.Logf("public provider 在敌对池下的路由=%s key=%s models=%v", p.BaseURL, p.APIKey, p.Models)
	if hasShadow {
		t.Errorf("syncedModelNames 把 shadow 的模型并进了路由清单（models=%v）", p.Models)
	}
	if !hasReal {
		t.Errorf("syncedModelNames 没有读到 public 的模型（models=%v）", p.Models)
	}
}

// TestAuditR13GH3LlmGatewayAdminWriteTxLandsInPublic ③：管理端写事务。
//
// 五处 `db.Begin()`（provider 创建/更新、模型创建/删除、网关配置）原先都是裸事务：
// shadow 在场时写落 shadow、public 一行不动，而响应体报成功。这里用**真实管理端
// 路由**（`PUT /api/server/admin/gateway` → setGatewayConfig 的 `UsageWriteTx` 事务）
// 断言"写落 public、shadow 不动"。
func TestAuditR13GH3LlmGatewayAdminWriteTxLandsInPublic(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	side := r13gh3InstallShadow(t, db)
	// shadow.settings 与 public.settings 同内容：让登录/读配置与主池逐字一致，
	// 这样"写落在哪一侧"就是唯一变量（否则登录行为本身会因读 shadow 而变）。
	if _, err := db.Exec("INSERT INTO " + r13gh3ShadowSchema + ".settings SELECT * FROM public.settings"); err != nil {
		t.Fatalf("同步 shadow.settings: %v", err)
	}

	r, _, hdr := adminTestSetupOnDB(t, side)
	const key = "gateway.rate_limit"
	// 基线（写前，两侧都读一次）
	readSide := func(schema string) (string, bool) {
		var v string
		err := db.QueryRow("SELECT value FROM "+schema+".settings WHERE key = ?", key).Scan(&v)
		if err != nil {
			return "", false
		}
		return v, true
	}
	before, _ := readSide("public")

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"rate_limit":"4242"}`, hdr); w.Code != 200 {
		t.Fatalf("PUT /api/server/admin/gateway 状态=%d body=%s", w.Code, w.Body.String())
	}
	pubAfter, pubOK := readSide("public")
	shAfter, shOK := readSide(r13gh3ShadowSchema)
	t.Logf("settings[%s]: public(写前=%q,写后=%q ok=%v) | shadow(写后=%q ok=%v)", key, before, pubAfter, pubOK, shAfter, shOK)
	if !pubOK || pubAfter != "4242" {
		t.Errorf("管理端写事务没有落在 public：public.settings[%s]=%q（want 4242）—— shadow 在场时配置写进 shadow，而响应体报成功", key, pubAfter)
	}
	if shOK && shAfter == "4242" {
		t.Errorf("管理端写事务写进了 **shadow**：shadow.settings[%s]=4242 —— 同族写面的第三条路径未收口", key)
	}
}

// TestAuditR13GH3AuditLogLandsInPublic ④：审计写面（audit_logs 本轮纳入族内集合）。
//
// V13-B 的登记缺口观察：`audit_logs` 原先不在族内关系集合里 ⇒ shadow 同名表会让
// 审计**静默落到 shadow**（public 链一行不动，而 VerifyAuditChain/管理端列表读的也是
// shadow ⇒ 两侧自洽，"审计 0 条"看不出是读错了对象）。这条判据把缺口闭掉。
func TestAuditR13GH3AuditLogLandsInPublic(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	side := r13gh3InstallShadow(t, db)

	count := func(schema string) int64 {
		var n int64
		if err := db.QueryRow("SELECT COUNT(*) FROM " + schema + ".audit_logs WHERE username = 'r13gh3'").Scan(&n); err != nil {
			t.Fatalf("计数 %s.audit_logs: %v", schema, err)
		}
		return n
	}
	if err := serverstore.AuditLog(side, "r13gh3", "probe", "r13gh3 敌对 search_path 审计落点"); err != nil {
		t.Fatalf("AuditLog(敌对池): %v", err)
	}
	pubN, shN := count("public"), count(r13gh3ShadowSchema)
	t.Logf("审计落点：public=%d shadow=%d", pubN, shN)
	if pubN != 1 {
		t.Errorf("审计没有落在 public：public.audit_logs=%d（want 1）—— shadow 同名表吞掉了审计行", pubN)
	}
	if shN != 0 {
		t.Errorf("审计静默落到了 shadow：shadow.audit_logs=%d（want 0）", shN)
	}
	// 读面同源：VerifyAuditChain 也必须读 public 的链（shadow 里是一条独立链）。
	broken, err := serverstore.VerifyAuditChain(side)
	if err != nil {
		t.Errorf("敌对池 VerifyAuditChain 失败：%v（读面没有钉 public）", err)
	}
	if broken != 0 {
		t.Errorf("敌对池 VerifyAuditChain 报断链于 id=%d —— 它读的是 shadow 的链，而不是刚写进 public 的那条", broken)
	}
}

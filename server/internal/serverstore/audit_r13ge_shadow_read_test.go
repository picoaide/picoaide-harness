package serverstore

// R13-GE · V2-2 回归：**读面必须与写面一样，与判据看同一个对象**。
//
// 被审形态（V12-2 的 B2 探针，真 PG 实测）：写面从第十二轮起已经全部收口
// （六条写路径全落 public），但**读面**仍是裸 `db.QueryRow`：
//
//	定价读 `ModelPricesForProvider`  → shadow 价目（in=1000/out=2000，而 public 是 1.0/2.0）
//	                                   被算进 **public 行** 的 cost（B2② 实测 cost=1000.0000）；
//	报表读 `UsageAggregateWithLedger` → shadow 的诱饵行（B2③ 实测 777.00 vs public 1000.00）。
//
// 两条读路径都返回 `err=nil`，所有健康出口报绿 —— 与写面 P1-02 完全同族，只是
// 方向从"写错对象"变成"读错对象"。
//
// 本文件的判据 = V2 的 B2 **换成正确取向**后的正式版（V2 的探针断言写的是"缺陷
// 存在"，修复后它的前提断言按设计翻转；这里断言的是"必须读 public"）：
//
//	A. 定价/取参/缓存价/峰谷窗口四条计价输入在敌对 search_path 下全部读 public，
//	   且结算真正落下的 cost 用的是 public 价目（金额面，有计费后果）；
//	B. 报表 / 明细分页 / 余额流水 / 模型目录 / 渠道目录 / 计量行计数 / 应用 AI 用量
//	   / 网关文件台账**逐个读面**在敌对 search_path 下都读 public；
//	C. 同族的池上写入口（绑定 provider / 删行 / 配置写入 / 台账登记）也落在 public，
//	   shadow 一行不动（写面回归，防止收口读面时把写面拆坏）。
//
// 敌对池由 r13geHostilePool 造（= 库/角色级 `search_path = shadow, public` 的等价形态），
// 与 r12n2 的夹具同源。

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"
)

// r13geShadowSchema 是本次读面收口判据用的 shadow schema（与 r12n2 的分开，
// 避免两个用例并行时互相 DROP）。
const r13geShadowSchema = "r13ge_shadow"

// r13geHostilePool 造一株"与产品全部族内关系同名"的 shadow 树 + 一个
// `search_path` 前置 shadow 的**旁路池**。旁路池走生产 `openPG`（裸
// `sql.Open("pgx")` 不支持 `?` 占位符 ⇒ 42601 假失败）。
func r13geHostilePool(t *testing.T, db *sql.DB) *sql.DB {
	t.Helper()
	sh := quoteRelationIdent(r13geShadowSchema)
	stmts := []string{
		"DROP SCHEMA IF EXISTS " + sh + " CASCADE",
		"CREATE SCHEMA " + sh,
		// 族内关系里的**普通表**：同名 + 同列（`LIKE … INCLUDING ALL`）。
		fmt.Sprintf("CREATE TABLE %s.usage (LIKE public.usage INCLUDING ALL)", sh),
		fmt.Sprintf("CREATE TABLE %s.models (LIKE public.models INCLUDING ALL)", sh),
		fmt.Sprintf("CREATE TABLE %s.gateway_providers (LIKE public.gateway_providers INCLUDING ALL)", sh),
		fmt.Sprintf("CREATE TABLE %s.gateway_files (LIKE public.gateway_files INCLUDING ALL)", sh),
		fmt.Sprintf("CREATE TABLE %s.balance_ledger (LIKE public.balance_ledger INCLUDING ALL)", sh),
		fmt.Sprintf("CREATE TABLE %s.settings (LIKE public.settings INCLUDING ALL)", sh),
		// usage 的永久账本（懒建，存在于 public 就同样造一份）。
		fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s.usage_daily (LIKE public.usage_daily INCLUDING ALL)", sh),
		fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s.usage_monthly (LIKE public.usage_monthly INCLUDING ALL)", sh),
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("造 shadow（R13-GE 读面判据）: %v\n%s", err, s)
		}
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA IF EXISTS " + sh + " CASCADE") })

	return r13geHostilePoolFor(t, db, r13geShadowSchema)
}

// r13geHostilePoolFor 是"把 search_path 钉成 `schema,public` 的旁路池"的唯一构造点。
//
// **自包含**（不依赖 r12n2 的夹具）：这样本判据可以被整份复制到"修复前"的源码树上
// 直接跑出红色（先复现为红 → 修复后转绿），而不需要那棵树上有任何新符号。
// 旁路池走生产 `openPG`（裸 `sql.Open("pgx")` 不支持 `?` 占位符 ⇒ 42601 假失败）。
func r13geHostilePoolFor(t *testing.T, db *sql.DB, schema string) *sql.DB {
	t.Helper()
	u, err := url.Parse(r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("options", "-csearch_path="+schema+",public")
	u.RawQuery = q.Encode()
	side, err := openPG(u.String())
	if err != nil {
		t.Fatalf("openPG(hostile): %v", err)
	}
	t.Cleanup(func() { side.Close() })
	if err := side.Ping(); err != nil {
		t.Fatalf("敌对池 ping: %v", err)
	}
	var sp string
	if err := side.QueryRow("SHOW search_path").Scan(&sp); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sp, schema) {
		t.Fatalf("敌对池 search_path=%q，第一段必须是 %s（夹具无效）", sp, schema)
	}
	t.Logf("敌对池 search_path=%q", sp)
	return side
}

// r13geShadow 返回 shadow schema 的引号形态（判据里到处要用）。
func r13geShadow() string { return quoteRelationIdent(r13geShadowSchema) }

// TestAuditR13GEShadowReadPathsHitPublic 是判据 A/B/C（真 PG + 真 shadow 树）。
func TestAuditR13GEShadowReadPathsHitPublic(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	n2Reset(t, db)
	uid := mustUserID(t, db)
	// 开通余额账户（否则结算走"未开通 = 不扣不记"的分支，金额面验不到）。
	if _, err := AdjustUserBalance(db, uid, 100, "R13-GE 读面判据开通余额", "test"); err != nil {
		t.Fatalf("开通余额: %v", err)
	}
	side := r13geHostilePool(t, db)

	// ---------------------------------------------------------------- A. 计价输入
	//
	// public 与 shadow 各播**同一份**模型行（同 provider_id / 同名），价目差 1000 倍。
	name := fmt.Sprintf("r13ge-priced-%d", time.Now().UnixNano())
	var provID int64
	if err := db.QueryRow(`INSERT INTO public.gateway_providers (name, base_url, api_key_enc, models)
		VALUES ($1, 'https://upstream.example.com', 'x', '[]') RETURNING id`, "r13ge-prov-"+name).Scan(&provID); err != nil {
		t.Fatalf("造 provider: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM public.gateway_providers WHERE id = $1`, provID) })
	for _, spec := range []struct {
		tbl     string
		in, out float64
		params  string
	}{
		{"public.models", 1.0, 2.0, `{"temperature":0.11}`},
		{r13geShadow() + ".models", 1000.0, 2000.0, `{"temperature":0.99}`},
	} {
		if _, err := db.Exec(fmt.Sprintf(
			`INSERT INTO %s (name, provider_id, display_name, default_params, input_price_per_1m,
			                  output_price_per_1m, cache_input_price_per_1m, offpeak_discount)
			 VALUES ($1,$2,$1,$3,$4,$5,0.5,1.0)`, spec.tbl),
			name, provID, spec.params, spec.in, spec.out); err != nil {
			t.Fatalf("播 %s: %v", spec.tbl, err)
		}
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM public.models WHERE name = $1`, name) })
	InvalidateModelConfig()

	in, out, _ := ModelPricesForProvider(side, 0, name)
	t.Logf("A① 定价读（敌对 search_path，providerID=0）：in=%.2f out=%.2f（public=1.00/2.00，shadow=1000/2000）", in, out)
	if in != 1.0 || out != 2.0 {
		t.Errorf("定价读读的是 shadow 价目（in=%.2f out=%.2f）—— 读面未收口", in, out)
	}
	sin, sout, _ := ModelPricesForProvider(side, provID, name)
	if sin != 1.0 || sout != 2.0 {
		t.Errorf("按 provider 的定价读读的是 shadow 价目（in=%.2f out=%.2f）", sin, sout)
	}
	if c := ModelCachePriceForProvider(side, provID, name); c != 0.5 {
		t.Errorf("缓存价读读的是 shadow（%.4f，public=0.5）", c)
	}
	// default_params 也必须是 public 那一份（它决定上游请求的默认参数）。
	params, err := ModelDefaultParams(side, name)
	if err != nil {
		t.Fatalf("ModelDefaultParams（敌对池）: %v", err)
	}
	if params != `{"temperature":0.11}` {
		t.Errorf("ModelDefaultParams 读的是 shadow（%s）", params)
	}
	// 峰谷窗口住在 settings：shadow 里放一个"把成本打成 0.5 倍"的诱饵窗口，
	// 断言计价读的是 public 的（public 不设 = 无窗口 = 不打折）。
	if _, err := db.Exec(`INSERT INTO ` + r13geShadow() + `.settings (key, value)
		VALUES ('usage.peak_windows', '[{"start":"00:00","end":"23:59","discount":0.5}]'::text)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`); err != nil {
		t.Fatalf("播 shadow 峰谷诱饵: %v", err)
	}
	InvalidateSettings()
	if v, ok, err := GetSetting(side, PeakWindowsSetting); err != nil {
		t.Fatalf("GetSetting（敌对池）: %v", err)
	} else if ok {
		t.Errorf("settings 读读的是 shadow（usage.peak_windows=%q）—— public 侧该键不存在", v)
	}

	// 结算：1e6 prompt token × public 价 1.0/1M = 1.0；若读 shadow 则是 1000.0。
	//
	// **先失效两条 TTL 缓存**（30s）：上面的 A① 已经把 public 价目/设置读进了
	// modelConfigCache / settingsCache，缓存是按 `*sql.DB` 作用域绑定的，不失效就
	// 会让"结算这一步是否真的去读库"变得测不出来 —— 实测：拆掉计价输入的读面 pin
	// 后本判据仍绿（缓存命中掩盖），属本项目登记的「判据感知度不足」。
	InvalidateModelConfig()
	InvalidateSettings()
	var pendingID int64
	if err := db.QueryRow(`INSERT INTO public.usage
		(user_id, model, provider_id, prompt_tokens, completion_tokens, cache_prompt_tokens,
		 kind, cost, created_at, estimated)
		VALUES ($1,$2,0,0,0,0,'chat',0,now(),true) RETURNING id`, uid, name).Scan(&pendingID); err != nil {
		t.Fatal(err)
	}
	if err := UpdateUsageTokensCachedEstimatedOverdraft(side, pendingID, 1000000, 0, 0, false); err != nil {
		t.Fatalf("结算（敌对池）: %v", err)
	}
	var cost float64
	if err := db.QueryRow(`SELECT cost FROM public.usage WHERE id = $1`, pendingID).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	t.Logf("A② 结算落下的 cost=%.4f（public 价目=1.0000，shadow 价目=1000.0000）", cost)
	if cost < 0.999 || cost > 1.001 {
		t.Errorf("结算金额取自 shadow 价目（cost=%.4f，want 1.0）—— 有计费后果的读面未收口", cost)
	}

	// ---------------------------------------------------------------- B. 报表与其余读面
	//
	// shadow 里播一条"只有 shadow 才有"的当月诱饵（cost=777）。
	if _, err := db.Exec(`INSERT INTO `+r13geShadow()+`.usage
		(user_id, model, provider_id, prompt_tokens, completion_tokens, cache_prompt_tokens,
		 kind, cost, created_at, estimated)
		VALUES ($1,'r13ge-decoy',0,1000,1000,0,'chat',777.0,now(),false)`, uid); err != nil {
		t.Fatalf("shadow 诱饵: %v", err)
	}
	from := dayKey(BeijingMonth(time.Now()))
	to := from.AddDate(0, 1, -1)
	sumRows := func(rs []UsageAggregateRow) float64 {
		var s float64
		for _, r := range rs {
			s += r.Cost
		}
		return s
	}
	pubRows, err := UsageAggregateWithLedger(db, from, to, "model")
	if err != nil {
		t.Fatal(err)
	}
	sideRows, err := UsageAggregateWithLedger(side, from, to, "model")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("B① 当月报表：public 池=%.4f 敌对池=%.4f（shadow 诱饵=777.00）", sumRows(pubRows), sumRows(sideRows))
	if sumRows(sideRows) != sumRows(pubRows) {
		t.Errorf("报表读在敌对 search_path 下读到 shadow 的数据（%.4f vs public %.4f）—— 静默错库读数",
			sumRows(sideRows), sumRows(pubRows))
	}
	for _, r := range sideRows {
		if r.Label == "r13ge-decoy" {
			t.Errorf("报表读把 shadow 的诱饵模型带进了结果（label=%q）", r.Label)
		}
	}
	// 明细侧聚合（UsageAggregate）同样只在 public。
	aggRows, err := UsageAggregate(side, from, to, "model")
	if err != nil {
		t.Fatal(err)
	}
	if sumRows(aggRows) != sumRows(pubRows) {
		t.Errorf("UsageAggregate（敌对池）=%.4f，与 public 读路径 %.4f 不一致", sumRows(aggRows), sumRows(pubRows))
	}
	// UserMonthlyUsage / UserMonthlyCost / UserDayUsageCost / UserTotalUsageCost
	if n, err := UserMonthlyUsage(side, uid); err != nil || n == 0 {
		t.Errorf("UserMonthlyUsage（敌对池）= %d, %v（public 有当月明细 ⇒ 必须非 0）", n, err)
	}
	if c, err := UserMonthlyCost(side, uid); err != nil || c <= 0 {
		t.Errorf("UserMonthlyCost（敌对池）= %v, %v（public 有当月明细 ⇒ 必须 > 0）", c, err)
	}
	if _, c, err := UserTotalUsageCost(side, uid); err != nil || c <= 0 {
		t.Errorf("UserTotalUsageCost（敌对池）= %v, %v", c, err)
	}
	if _, c, err := UserDayUsageCost(side, uid, BeijingDay(time.Now())); err != nil || c <= 0 {
		t.Errorf("UserDayUsageCost（敌对池）= %v, %v", c, err)
	}
	if m, err := UserMonthlyUsageBatch(side, []int64{uid}); err != nil || m[uid] == 0 {
		t.Errorf("UserMonthlyUsageBatch（敌对池）= %v, %v", m, err)
	}
	if m, err := UserMonthlyCostBatch(side, []int64{uid}); err != nil || m[uid] <= 0 {
		t.Errorf("UserMonthlyCostBatch（敌对池）= %v, %v", m, err)
	}
	// 明细分页（计数 + 分页两条语句必须来自同一个库）。
	reqs, total, err := ListUsageRequests(side, time.Time{}, time.Time{}, "", "", "", 1, 50)
	if err != nil {
		t.Fatalf("ListUsageRequests（敌对池）: %v", err)
	}
	if int64(len(reqs)) != total {
		t.Errorf("用量明细分页：count=%d 与页内行数=%d 不一致（两条语句没有看同一个对象）", total, len(reqs))
	}
	for _, r := range reqs {
		if r.Model == "r13ge-decoy" {
			t.Errorf("用量明细分页读到了 shadow 的诱饵行")
		}
	}
	// 余额流水：public 侧有开通流水（+100），shadow 侧一行都没有。
	led, ledTotal, err := BalanceLedgerPage(side, uid, "", 1, 20)
	if err != nil {
		t.Fatalf("BalanceLedgerPage（敌对池）: %v", err)
	}
	if ledTotal == 0 || len(led) == 0 {
		t.Errorf("BalanceLedgerPage（敌对池）读到 0 行（public 侧有开通流水）—— 读的是 shadow")
	}
	wantSum, err := BalanceLedgerSum(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := BalanceLedgerSum(side, uid); err != nil || got != wantSum {
		t.Errorf("BalanceLedgerSum（敌对池）= %v, %v，public 读路径 = %v —— 两个库的读数必须相等",
			got, err, wantSum)
	}
	// 模型 / 渠道目录 + 计量行计数。
	if ms, err := ListAdminModels(side); err != nil {
		t.Fatalf("ListAdminModels（敌对池）: %v", err)
	} else {
		found := false
		for _, m := range ms {
			if m.Name == name {
				found = true
			}
		}
		if !found {
			t.Errorf("ListAdminModels（敌对池）里没有 public 的模型行 %q（读的是 shadow）", name)
		}
	}
	if ps, err := ListGatewayProviders(side); err != nil {
		t.Fatalf("ListGatewayProviders（敌对池）: %v", err)
	} else {
		found := false
		for _, p := range ps {
			if p.ID == provID {
				found = true
			}
		}
		if !found {
			t.Errorf("ListGatewayProviders（敌对池）里没有 public 的 provider #%d", provID)
		}
	}
	if _, err := GetModel(side, provID2ModelID(t, db, provID, name)); err != nil {
		t.Errorf("GetModel（敌对池）读不到 public 的模型行: %v", err)
	}
	if has, err := ModelHasUsage(side, name); err != nil || !has {
		t.Errorf("ModelHasUsage（敌对池）= %v, %v（public 有该模型的用量行 ⇒ 必须 true；"+
			"shadow 侧为空 ⇒ true 说明读的是 public）", has, err)
	}
	if mp, err := ModelProviderMap(side); err != nil {
		t.Fatalf("ModelProviderMap（敌对池）: %v", err)
	} else if _, ok := mp[name]; !ok {
		t.Errorf("ModelProviderMap（敌对池）里没有 public 的模型 %q（读的是 shadow）", name)
	}
	// 网关文件台账：在 public 里登记一份，敌对池必须读得到。
	if err := RecordGatewayFileSize(db, "r13ge-file-1", uid, nil, 4096); err != nil {
		t.Fatalf("登记台账（public 池）: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM public.gateway_files WHERE file_id = 'r13ge-file-1'`) })
	if owned, err := GatewayFilesOwnedBy(side, []string{"r13ge-file-1"}, uid); err != nil {
		t.Fatalf("GatewayFilesOwnedBy（敌对池）: %v", err)
	} else if _, ok := owned["r13ge-file-1"]; !ok {
		t.Errorf("GatewayFilesOwnedBy（敌对池）看不到 public 的台账行（读的是 shadow）")
	}
	if ok, err := GatewayFileRowExists(side, "r13ge-file-1"); err != nil || !ok {
		t.Errorf("GatewayFileRowExists（敌对池）= %v, %v（public 有该行）", ok, err)
	}
	if id, ok, err := GatewayFileOwner(side, "r13ge-file-1"); err != nil || !ok || id != uid {
		t.Errorf("GatewayFileOwner（敌对池）= %d, %v, %v（want uid=%d）", id, ok, err, uid)
	}
	if files, _, _, err := GatewayFileTotals(side); err != nil || files == 0 {
		t.Errorf("GatewayFileTotals（敌对池）= %d, %v（public 有一行）", files, err)
	}
	if _, err := ListGatewayFileIDs(side, uid); err != nil {
		t.Fatalf("ListGatewayFileIDs（敌对池）: %v", err)
	}
	if _, _, err := ListGatewayFiles(side, GatewayFileQuery{}); err != nil {
		t.Fatalf("ListGatewayFiles（敌对池）: %v", err)
	}
	if _, err := GatewayFileSummary(side, "", false); err != nil {
		t.Fatalf("GatewayFileSummary（敌对池）: %v", err)
	}
	// 应用 AI 用量（走 ctx 形态的读入口）。
	if u, err := QueryWasmAppAIUsage(context.Background(), side, "r13ge-app", from, to); err != nil {
		t.Fatalf("QueryWasmAppAIUsage（敌对池）: %v", err)
	} else if u == nil {
		t.Errorf("QueryWasmAppAIUsage（敌对池）返回 nil")
	}

	// ---------------------------------------------------------------- C. 同族写入口回归
	//
	// 收口读面时不得把写面拆坏：下面四条写路径经**敌对池**执行，必须只落 public。
	// ① SetUsageProvider 只改 public 行。
	if _, err := db.Exec(`INSERT INTO public.usage (user_id, model, provider_id, prompt_tokens,
		completion_tokens, cache_prompt_tokens, kind, cost, created_at, estimated)
		VALUES ($1,'r13ge-bind',0,10,5,0,'chat',0.5,now(),false) RETURNING id`, uid); err != nil {
		t.Fatal(err)
	}
	var bindID int64
	if err := db.QueryRow(`SELECT id FROM public.usage WHERE model = 'r13ge-bind' ORDER BY id DESC LIMIT 1`).Scan(&bindID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO `+r13geShadow()+`.usage (id, user_id, model, provider_id,
		prompt_tokens, completion_tokens, cache_prompt_tokens, kind, cost, created_at, estimated)
		VALUES ($1,$2,'r13ge-bind',0,10,5,0,'chat',0.5,now(),false)`, bindID, uid); err != nil {
		t.Fatalf("shadow 同 id 行: %v", err)
	}
	if err := SetUsageProvider(side, bindID, 7); err != nil {
		t.Fatalf("SetUsageProvider（敌对池）: %v", err)
	}
	if got := r12n2Cell(t, db, "public", bindID, "COALESCE(provider_id,0)::text"); got != "7" {
		t.Errorf("SetUsageProvider 没落在 public（provider_id=%s）", got)
	}
	if got := r12n2Cell(t, db, r13geShadowSchema, bindID, "COALESCE(provider_id,0)::text"); got != "0" {
		t.Errorf("SetUsageProvider 改了 shadow 行（provider_id=%s）", got)
	}
	// ② DeleteUsage 只删 public 行。
	if err := DeleteUsage(side, bindID); err != nil {
		t.Fatalf("DeleteUsage（敌对池）: %v", err)
	}
	if got := r12n2Cell(t, db, "public", bindID, "model"); got[:4] != "ERR:" {
		t.Errorf("DeleteUsage 没删到 public 行（仍读得到 %q）", got)
	}
	// ③ 配置写入只落 public.settings。
	if err := SetSetting(side, "r13ge.probe", "v1"); err != nil {
		t.Fatalf("SetSetting（敌对池）: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM public.settings WHERE key = 'r13ge.probe'`) })
	var pubHas, shHas int
	if err := db.QueryRow(`SELECT count(*) FROM public.settings WHERE key='r13ge.probe'`).Scan(&pubHas); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM ` + r13geShadow() + `.settings WHERE key='r13ge.probe'`).Scan(&shHas); err != nil {
		t.Fatal(err)
	}
	if pubHas != 1 || shHas != 0 {
		t.Errorf("SetSetting（敌对池）：public=%d shadow=%d（want 1/0）", pubHas, shHas)
	}
	// ④ 台账登记 / 删除只落 public。
	if err := RecordGatewayFileSize(side, "r13ge-file-2", uid, nil, 512); err != nil {
		t.Fatalf("RecordGatewayFileSize（敌对池）: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM public.gateway_files WHERE file_id = 'r13ge-file-2'`) })
	var pubGF, shGF int
	if err := db.QueryRow(`SELECT count(*) FROM public.gateway_files WHERE file_id='r13ge-file-2'`).Scan(&pubGF); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM ` + r13geShadow() + `.gateway_files WHERE file_id='r13ge-file-2'`).Scan(&shGF); err != nil {
		t.Fatal(err)
	}
	if pubGF != 1 || shGF != 0 {
		t.Errorf("RecordGatewayFileSize（敌对池）：public=%d shadow=%d（want 1/0）", pubGF, shGF)
	}
}

// provID2ModelID 取 (provider_id, name) 对应的 models 行 id（判据夹具用）。
func provID2ModelID(t *testing.T, db *sql.DB, providerID int64, name string) int64 {
	t.Helper()
	var id int64
	if err := db.QueryRow(`SELECT id FROM public.models WHERE provider_id = $1 AND name = $2`,
		providerID, name).Scan(&id); err != nil {
		t.Fatalf("取 models.id: %v", err)
	}
	return id
}

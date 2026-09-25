package serverstore

// R12-N2 · P1-02 回归：整条计量—结算—清理—余额链路上，**判据与动作必须看同一个对象**。
//
// 被审形态（origin/master @ 12540e681c，R12-A 的 P1-02）：R11A-02 引入的
// `usageSearchPathPin`（`SET LOCAL search_path = pg_catalog, public`）只钉了 **3 个**
// 调用点，而报表读面之外的**计费链路**上还有 4 条同族面（全部是"判据硬钉 `public.`、
// 动作走未限定名"）：
//
//	流式结算 updateUsageTokensAtCached（usage.go）：池上 SELECT + 事务内
//	  `SELECT … FOR UPDATE` / `UPDATE usage` 都没钉 ⇒ shadow 在场时把 shadow 行改成
//	  900/300（真 PG 实测），而 shadow 没有该行时整段以 `no rows` 失败 ⇒
//	  **真实 pending 永不结算**；
//	SetUsageProvider / DeleteUsage / CleanupPendingUsage：裸 `db.Exec` ⇒ 改/删的都是
//	  shadow 行 ⇒ **真实 pending 永不清理**（0-token 行无界堆积）；
//	连带 balance.go 的扣费路径（`balance_ledger` / `users`）：与上面的未钉事务同事务。
//
// 修法口径 = **唯一实现**：`pinUsageSearchPath(tx)`（已有事务）+ `withUsageSearchPath`
// （池上入口，开事务 → 钉 → 跑 → 提交），调用点只允许经它们钉；**不允许**再逐点抄那句
// 字面量（抄一份就多一个"只钉了 N 个调用点"的机会）。
//
// 本文件的判据：
//
//	A. 行为判据（真 PG + 真 shadow 树）：每一个族内入口的**动作都落在 public**、
//	   shadow 一行不动；结算金额落 public 行、pending 行被真清理；写路径建的分区
//	   也在 public；
//	B. 机械守卫（R13-GE 扩面）：包内**全部**非测试源文件里**每一个**触碰族内关系
//	   SQL 的函数都必须在 `r13geSearchPathInventory` 里登记并声明它怎么钉 ——
//	   新增函数/新增文件不登记即红，"第 N 个漏点"从此不可能静默出现；
//	   **且没有「读面已认账」这一档**（读面与写面同等收口）。

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

const r12n2ShadowSchema = "r12n2_shadow"

// r12n2InstallShadow 造一株与真表同名的 shadow 树（含 usage / users / balance_ledger /
// models），并把 search_path 前置 shadow 的**旁路池**交给调用方。
//
// 旁路池一律走生产 `openPG`（R12-A 的 P3：裸 `sql.Open("pgx")` 不支持 `?` 占位符，
// 每条语句都会变成 42601 假失败）。
func r12n2InstallShadow(t *testing.T, db *sql.DB) *sql.DB {
	t.Helper()
	for _, s := range []string{
		"DROP SCHEMA IF EXISTS " + quoteRelationIdent(r12n2ShadowSchema) + " CASCADE",
		"CREATE SCHEMA " + quoteRelationIdent(r12n2ShadowSchema),
		fmt.Sprintf("CREATE TABLE %s.usage (LIKE public.usage INCLUDING ALL)", quoteRelationIdent(r12n2ShadowSchema)),
		fmt.Sprintf("CREATE TABLE %s.users (LIKE public.users INCLUDING ALL)", quoteRelationIdent(r12n2ShadowSchema)),
		fmt.Sprintf("CREATE TABLE %s.balance_ledger (LIKE public.balance_ledger INCLUDING ALL)", quoteRelationIdent(r12n2ShadowSchema)),
		fmt.Sprintf("CREATE TABLE %s.models (LIKE public.models INCLUDING ALL)", quoteRelationIdent(r12n2ShadowSchema)),
	} {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("造 shadow: %v\n%s", err, s)
		}
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA IF EXISTS " + quoteRelationIdent(r12n2ShadowSchema) + " CASCADE") })

	side := r12n2PoolWithShadow(t, db)
	return side
}

// r12n2PoolWithShadow 开一个把 search_path 钉成 `shadow,public` 的**旁路池**
// （形态与"角色/库级 ALTER ROLE … SET search_path=…"或 DSN options 等价）。
//
// 为什么不复用 i4PoolWithSearchPath：那个 helper 断言 `SHOW search_path` 与传入串
// **逐字相等**，而 PG 会把 `a,public` 渲染成 `a, public`（带空格），且 startup options
// 用空格分词（`-csearch_path=a, public` 会被拆成两个 token ⇒ 22023）。这里改用
// "第一段必须是 shadow schema"的判据。旁路连接一律走生产 `openPG`（R12-A 的 P3：
// 裸 `sql.Open("pgx")` 不支持 `?` 占位符 ⇒ 每条语句 42601 假失败）。
func r12n2PoolWithShadow(t *testing.T, db *sql.DB) *sql.DB {
	t.Helper()
	return r12n2PoolWithShadowNamed(t, db, r12n2ShadowSchema)
}

// r12n2PoolWithShadowNamed 是参数化 schema 的形态（R13-GE 的读面判据用自己那株
// shadow，避免与 r12n2 的用例互相 DROP）。
//
// R13-GH3：夹具收敛到**唯一实现** `OpenShadowSearchPathPool`（与跨包的
// `internal/llmgateway` 判据同一份）—— 两边各写一份"造敌对池"的代码，
// 就会出现"一边的夹具其实没生效、判据静默变成在 public 上跑"的假绿。
func r12n2PoolWithShadowNamed(t *testing.T, db *sql.DB, schema string) *sql.DB {
	t.Helper()
	return OpenShadowSearchPathPool(t, db, schema)
}

// r12n2Cell 读某侧 usage 行的某列（两侧都读，用于"谁被改了"的判据）。
func r12n2Cell(t *testing.T, db *sql.DB, schema string, id int64, cols string) string {
	t.Helper()
	var out string
	q := fmt.Sprintf("SELECT %s FROM %s.usage WHERE id = %d", cols, quoteRelationIdent(schema), id)
	if err := db.QueryRow(q).Scan(&out); err != nil {
		return "ERR:" + err.Error()
	}
	return out
}

// TestAuditR12N2ShadowSettlementAndCleanupHitPublic 是行为判据 A（真 PG + 真 shadow 树）。
func TestAuditR12N2ShadowSettlementAndCleanupHitPublic(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	n2Reset(t, db)
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	// 先把余额账户开通（`balance_activated_at` 置位）——否则 settleUsageCostTx 按
	// "未开通 = 不扣不记"的分支直接返回，结算的余额面就验不到了。
	if _, err := AdjustUserBalance(db, uid, 100, "R12-N2 用例开通余额", "test"); err != nil {
		t.Fatalf("开通余额: %v", err)
	}
	side := r12n2InstallShadow(t, db)

	// 给该模型定价：否则结算算出的 cost = 0 与"已计费 0"相等 ⇒ settleUsageCostTx
	// 走 `delta == 0` 的早退、**不写流水**，余额面就验不到（本用例第一版踩过）。
	var provID int64
	if err := db.QueryRow(`INSERT INTO public.gateway_providers (name, base_url, api_key_enc, models)
		VALUES ('r12n2-prov', 'https://upstream.example.com', 'x', '[]') RETURNING id`).Scan(&provID); err != nil {
		t.Fatalf("建 provider: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM public.gateway_providers WHERE id = $1`, provID) })
	if _, err := db.Exec(`INSERT INTO public.models (name, provider_id, display_name, default_params,
		input_price_per_1m, output_price_per_1m, cache_input_price_per_1m)
		VALUES ('r12n2-p1', $1, 'r12n2-p1', '{}', 1000, 2000, 100)`, provID); err != nil {
		t.Fatalf("给 r12n2-p1 定价: %v", err)
	}
	// **同族读面（非本次改动面，如实登记）**：定价读 `SELECT … FROM models` 走的是
	// search_path（`ModelPricesForProvider` / `loadPeakWindows` 在 gateway.go / settings.go，
	// 不在本泳道的文件内）。所以 shadow 在场时结算算出的 cost 会是 shadow 的价格
	// （这里为空 ⇒ 0）。本用例把同一份价格也播进 shadow.models，让"结算金额"这一侧
	// 的判据仍然非零、可判定；**读面的收口**作为需主控决策项记在报告里。
	if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(r12n2ShadowSchema)+`.models (name, provider_id, display_name, default_params,
		input_price_per_1m, output_price_per_1m, cache_input_price_per_1m)
		VALUES ('r12n2-p1', $1, 'r12n2-p1', '{}', 1000, 2000, 100)`, provID); err != nil {
		t.Fatalf("给 shadow.models 播同一份价格: %v", err)
	}
	InvalidateModelConfig() // 让新定价立刻可见（30s TTL 缓存）
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM public.models WHERE name = 'r12n2-p1'`) })

	// ① 流式结算：public 与 shadow 各播一条**同 id** 的行，动作必须只改 public。
	pendingID := r12n2SeedRow(t, db, uid, 424242, "r12n2-p1", 10, 5, 0.5, provID)
	pub, sh := r12n2Cell(t, db, "public", pendingID, "prompt_tokens::text || '/' || completion_tokens::text"),
		r12n2Cell(t, db, r12n2ShadowSchema, pendingID, "prompt_tokens::text || '/' || completion_tokens::text")
	if err := UpdateUsageTokensCachedEstimatedOverdraft(side, pendingID, 900, 300, 0, false); err != nil {
		t.Fatalf("流式结算（shadow 池）: %v", err)
	}
	pub2, sh2 := r12n2Cell(t, db, "public", pendingID, "prompt_tokens::text || '/' || completion_tokens::text"),
		r12n2Cell(t, db, r12n2ShadowSchema, pendingID, "prompt_tokens::text || '/' || completion_tokens::text")
	t.Logf("A/结算：public.usage %q→%q | shadow.usage %q→%q", pub, pub2, sh, sh2)
	if pub2 != "900/300" {
		t.Errorf("结算没有落在 public 行（%q→%q）：判据面（public）与动作面（search_path）仍是两个对象", pub, pub2)
	}
	if sh2 != sh {
		t.Errorf("结算写进了 shadow 行（%q→%q）—— 真实用量永不结算、余额不扣，且没有任何错误面", sh, sh2)
	}
	// 结算还必须真扣了余额（同一事务里的 balance_ledger/users 也要落在 public）。
	var led int64
	if err := db.QueryRow(`SELECT count(*) FROM public.balance_ledger WHERE usage_id = ?`, pendingID).Scan(&led); err != nil {
		t.Fatal(err)
	}
	var ledShadow int64
	if err := db.QueryRow(`SELECT count(*) FROM `+quoteRelationIdent(r12n2ShadowSchema)+`.balance_ledger WHERE usage_id = ?`, pendingID).Scan(&ledShadow); err != nil {
		t.Fatal(err)
	}
	t.Logf("A/结算：public.balance_ledger 里 usage_id=%d 的流水行数=%d（shadow 侧=%d）", pendingID, led, ledShadow)
	if led == 0 {
		t.Errorf("结算没有在 public.balance_ledger 里留下流水（该行已开通余额 ⇒ 必须扣费）")
	}
	if ledShadow != 0 {
		t.Errorf("结算把扣费流水写进了 shadow.balance_ledger（%d 行）", ledShadow)
	}

	// ② SetUsageProvider：同样只改 public。
	setID := r12n2SeedRow(t, db, uid, 424243, "r12n2-p2", 10, 5, 0.5, 0)
	if err := SetUsageProvider(side, setID, 7); err != nil {
		t.Fatalf("SetUsageProvider（shadow 池）: %v", err)
	}
	pb := r12n2Cell(t, db, "public", setID, "COALESCE(provider_id,0)::text")
	sb := r12n2Cell(t, db, r12n2ShadowSchema, setID, "COALESCE(provider_id,0)::text")
	t.Logf("A/provider：public.provider_id=%s shadow.provider_id=%s", pb, sb)
	if pb != "7" {
		t.Errorf("SetUsageProvider 没有落在 public 行（provider_id=%s）", pb)
	}
	if sb != "0" {
		t.Errorf("SetUsageProvider 改的是 shadow 行（provider_id=%s）—— provider 绑定静默丢失（该行定价回落到 name 口径）", sb)
	}

	// ③ DeleteUsage：只删 public。
	delID := r12n2SeedRow(t, db, uid, 424244, "r12n2-p3", 10, 5, 0.5, 0)
	if err := DeleteUsage(side, delID); err != nil {
		t.Fatalf("DeleteUsage（shadow 池）: %v", err)
	}
	if got := r12n2Cell(t, db, "public", delID, "model"); !strings.HasPrefix(got, "ERR:") {
		t.Errorf("DeleteUsage 没有删到 public 行（仍读得到 %q）", got)
	}
	if got := r12n2Cell(t, db, r12n2ShadowSchema, delID, "model"); strings.HasPrefix(got, "ERR:") {
		t.Errorf("DeleteUsage 删的是 shadow 行（shadow 侧读不到了；public 侧已删）")
	}

	// ④ CleanupPendingUsage：只清 public 的 0-token 行。
	pend := r12n2SeedRow(t, db, uid, 424245, "r12n2-p4", 0, 0, 0, 0)
	if err := CleanupPendingUsage(side, time.Now().Add(24*time.Hour)); err != nil {
		t.Fatalf("CleanupPendingUsage（shadow 池）: %v", err)
	}
	if got := r12n2Cell(t, db, "public", pend, "model"); !strings.HasPrefix(got, "ERR:") {
		t.Errorf("真实 pending 行没被清理（public 侧仍在：%q）—— 0-token 行无界堆积", got)
	}

	// ⑤ 计量写入 + 写路径建分区：新月份的分区必须建在 public。
	next := BeijingMonth(time.Now()).AddDate(0, 1, 0)
	rel := "usage_" + monthKey(next)
	_, _ = db.Exec("DROP TABLE IF EXISTS public." + quoteRelationIdent(rel))
	if _, err := recordUsageKindAtCached(side, uid, 0, "r12n2-p5", 100, 50, 0, "chat", false, BeijingDayAt(next, 1)); err != nil {
		t.Fatalf("计量写入（shadow 池，需建新分区）: %v", err)
	}
	if !r9aRelationExists(t, db, rel) {
		t.Errorf("写路径把 %s 建到了 shadow（public 里不存在）⇒ 每次写入都重复建一遍、public 永不分分区", rel)
	}
	var shRel int
	if err := db.QueryRow(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname = ? AND c.relname = ?`, r12n2ShadowSchema, rel).Scan(&shRel); err != nil {
		t.Fatal(err)
	}
	if shRel != 0 {
		t.Errorf("写路径在 shadow 里建了同名分区（%s）", rel)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP TABLE IF EXISTS public." + quoteRelationIdent(rel)) })

	// ⑥ 余额链路：AdjustUserBalance / SetUserBalance 也必须落 public。
	balSide := side
	before := r12n2UserBalance(t, db, "public", uid)
	if _, err := AdjustUserBalance(balSide, uid, 12.5, "r12n2 用例", "test"); err != nil {
		t.Fatalf("AdjustUserBalance（shadow 池）: %v", err)
	}
	after := r12n2UserBalance(t, db, "public", uid)
	shAfter := r12n2UserBalance(t, db, r12n2ShadowSchema, uid)
	t.Logf("A/余额：public.balance_money %v→%v | shadow.balance_money=%v", before, after, shAfter)
	if after-before < 12.4 {
		t.Errorf("AdjustUserBalance 没有落在 public.users（%v→%v，want +12.5）", before, after)
	}
}

// r12n2SeedRow 在 public 与 shadow 的 usage 里各播一条**同 id** 的行。
func r12n2SeedRow(t *testing.T, db *sql.DB, uid, id int64, model string, pt, ct int64, cost float64, providerID int64) int64 {
	t.Helper()
	for _, rel := range []string{"public.usage", r12n2ShadowSchema + ".usage"} {
		var scanned int64
		if err := db.QueryRow(fmt.Sprintf(`INSERT INTO %s (id, user_id, model, provider_id, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
			VALUES (?, ?, ?, ?, ?, ?, 'chat', ?, now(), false) RETURNING id`, rel),
			id, uid, model, providerID, pt, ct, cost).Scan(&scanned); err != nil {
			t.Fatalf("播行 %s: %v", rel, err)
		}
	}
	return id
}

// r12n2UserBalance 读某侧 users.balance_money（两侧都读）。
func r12n2UserBalance(t *testing.T, db *sql.DB, schema string, uid int64) float64 {
	t.Helper()
	var v sql.NullFloat64
	q := fmt.Sprintf("SELECT balance_money FROM %s.users WHERE id = %d", quoteRelationIdent(schema), uid)
	if err := db.QueryRow(q).Scan(&v); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0 // shadow 是空树：没有那一行 = 读到 0（这正是"动作落在 shadow"的读数）
		}
		t.Fatalf("读 %s.balance_money: %v", schema, err)
	}
	return v.Float64
}

// ---------------------------------------------------------------------------
// B. 机械守卫：族内函数清单
// ---------------------------------------------------------------------------
// r13geSearchPathFiles 是被守卫的**文件面**：包内全部非测试 Go 源文件。
//
// R13-GE（V2-2 读面收口）：R12-N2 的守卫把扫描面硬编码成 5 个文件
// （usage.go / usage_ledger.go / usage_retention_status.go / partitions.go /
// balance.go），于是 `gateway.go` / `settings.go` / `gateway_files.go` /
// `requests.go` / `usage_provider.go` / `wasm_app_opens*.go` 里的族内 SQL
// **连登记都没有** —— 定价读 `ModelPricesForProvider`（把 shadow 价目算进
// public 行）就是这么漏掉的。现在改成"动态枚举包内全部非测试源文件"：
// **新增文件自动进入判据面**，不再需要有人记得往清单里加名字。
func r13geSearchPathFiles(t *testing.T) []string {
	t.Helper()
	all, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("枚举包内 .go: %v", err)
	}
	var out []string
	for _, f := range all {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		out = append(out, f)
	}
	sort.Strings(out)
	if len(out) < 20 {
		t.Fatalf("只枚举到 %d 个非测试源文件（守卫失效，不能静默通过）", len(out))
	}
	return out
}

// r13gePinMode 是"这个函数的族内 SQL 怎么与判据看同一个对象"的**封闭取值**。
type r13gePinMode string

const (
	// r13gePinned：函数自己（或它直接调用的唯一实现）钉了 search_path。
	r13gePinned r13gePinMode = "pinned"
	// r13geViaCaller：函数**开不出自己的事务**（形参里有 `*sql.Tx` / `rowQuerier` /
	// `usageQuerier` / `usageExecer` / `exec func(...)`），由调用方钉；每一个这样的
	// 函数都必须在 r13geViaCallerOwners 里点名谁钉了它。
	r13geViaCaller r13gePinMode = "via-caller"
	// r13geCatalogOnly：只读 `pg_catalog`（`pg_class` / `pg_namespace` / `pg_inherits`…）
	// 与 `to_regclass('public.'||…)`：pg_catalog 永远隐式排在 search_path 最前，
	// shadow schema 顶不掉它；判据本身硬钉 `public.`，没有"动作面"。
	r13geCatalogOnly r13gePinMode = "catalog-only"
)

// r13geSearchPathInventory 是"触碰族内关系 SQL 的函数"的**完整清单**。
//
// 族内关系（family）= `usage` / `usage_daily` / `usage_monthly` / `models` /
// `gateway_providers` / `gateway_files` / `balance_ledger` / `settings`：
// 这些关系上"读错/写错对象"的共同后果是**静默的错数字或静默丢账**——金额、
// 价目、计量行、余额流水、回收台账、峰谷/保留期配置——而所有健康出口报绿。
// （`users` / `user_groups` / `api_tokens` / `admin_sessions` 不在此列：它们的
// 遮蔽读会**可见地**失败（登录/列表/鉴权），不产生静默错金额。）
//
// **本清单没有"已认账 / read-acknowledged"这一档**（R13-GE 删除了它）：
// 读面与写面同等收口。新增一个"判据硬钉 public、动作走 search_path"的入口
// **不可能静默出现** —— 它要么让守卫变红，要么必须在这里登记并被分类。
var r13geSearchPathInventory = map[string]r13gePinMode{
	// —— 已钉（池上入口经唯一实现：newUsageReadConn / withUsageSearchPathRead /
	//    withUsageSearchPath / usageWriteTx / pinUsageSearchPath / applyUsageRetentionBudget）——
	"AuditLogTx":                           r13geViaCaller, // audit.go —— 由调用方的已钉事务钉（见 owners）
	"PurgeOldAuditLogs":                    r13gePinned,    // audit.go —— withUsageSearchPath
	"writeAuditBatch":                      r13gePinned,    // audit.go —— usageWriteTx
	"BalanceLedgerPage":                    r13gePinned,    // balance.go
	"BalanceLedgerSum":                     r13gePinned,    // balance.go
	"ClaimExpiredGatewayFile":              r13gePinned,    // gateway_files.go
	"CleanupPendingUsage":                  r13gePinned,    // usage.go
	"DeleteGatewayFileRow":                 r13gePinned,    // gateway_files.go
	"DeleteGatewayProvider":                r13gePinned,    // gateway.go
	"DeleteSetting":                        r13gePinned,    // settings.go
	"DeleteUsage":                          r13gePinned,    // usage.go
	"DeleteUser":                           r13gePinned,    // users.go
	"FinishReapedGatewayFile":              r13gePinned,    // gateway_files.go
	"GatewayFileOwner":                     r13gePinned,    // gateway_files.go
	"GatewayFileReapBacklogStats":          r13gePinned,    // gateway_files.go
	"GatewayFileReapClaimHeld":             r13gePinned,    // gateway_files.go
	"GatewayFileRowExists":                 r13gePinned,    // gateway_files.go
	"GatewayFileSummary":                   r13gePinned,    // gateway_files.go
	"GatewayFileTotals":                    r13gePinned,    // gateway_files.go
	"GatewayFilesOwnedBy":                  r13gePinned,    // gateway_files.go
	"GetAllSettings":                       r13gePinned,    // settings.go
	"GetGatewayProvider":                   r13gePinned,    // gateway.go
	"GetModel":                             r13gePinned,    // gateway.go
	"ListAdminModels":                      r13gePinned,    // gateway.go
	"ListExpiredGatewayFiles":              r13gePinned,    // gateway_files.go
	"ListGatewayFileIDs":                   r13gePinned,    // gateway_files.go
	"ListGatewayFiles":                     r13gePinned,    // gateway_files.go
	"ListGatewayFilesForPurge":             r13gePinned,    // gateway_files.go
	"ListGatewayProviders":                 r13gePinned,    // gateway.go
	"ListUsageRequests":                    r13gePinned,    // requests.go
	"ModelHasUsage":                        r13gePinned,    // gateway.go
	"ModelProviderMap":                     r13gePinned,    // usage_provider.go
	"NormalizeLegacyPermanentGatewayFiles": r13gePinned,    // gateway_files.go
	"PurgeExpiredGatewayFiles":             r13gePinned,    // gateway_files.go
	"QueryWasmAppAIUsage":                  r13gePinned,    // wasm_app_opens_summary.go
	"RecordGatewayFileSize":                r13gePinned,    // gateway_files.go
	"ReleaseReapClaim":                     r13gePinned,    // gateway_files.go
	"RemoveMissingProviderModels":          r13gePinned,    // gateway.go
	"SetSetting":                           r13gePinned,    // settings.go
	"SetUsageAppID":                        r13gePinned,    // wasm_app_opens.go
	"SetUsageAppIDVerified":                r13gePinned,    // wasm_app_opens.go —— 存在性校验与写入同一已钉事务（R14-K · D-04）
	"SetUsageProvider":                     r13gePinned,    // usage.go
	"SyncProviderModel":                    r13gePinned,    // gateway.go
	"UpdateModel":                          r13gePinned,    // gateway.go
	"UsageAggregate":                       r13gePinned,    // usage.go
	"UsageAggregateFromLedger":             r13gePinned,    // usage_ledger.go
	"UserDayUsageCost":                     r13gePinned,    // usage.go
	"UserMonthlyCost":                      r13gePinned,    // usage.go
	"UserMonthlyCostBatch":                 r13gePinned,    // usage.go
	"UserMonthlyUsage":                     r13gePinned,    // usage.go
	"UserMonthlyUsageBatch":                r13gePinned,    // usage.go
	"UserTotalUsageCost":                   r13gePinned,    // usage.go
	"gatewayFileReapClaimActive":           r13gePinned,    // gateway_files.go
	"GrantMonthlyBalance":                  r13gePinned,    // balance.go —— 事务内 pinUsageSearchPath
	"GetGrantStatus":                       r13gePinned,    // balance.go —— withUsageSearchPathRead
	"LastBalanceGrant":                     r13gePinned,    // balance.go —— withUsageSearchPathRead
	"GetBalanceGrant":                      r13gePinned,    // balance.go —— withUsageSearchPathRead
	"queryBalanceGrant":                    r13geViaCaller, // balance.go —— LastBalanceGrant / GetBalanceGrant（已钉只读事务）
	"ledgerMonthHasRows":                   r13gePinned,    // usage_ledger.go
	"listAuditLogsOn":                      r13geViaCaller, // audit.go —— listAuditLogs（withUsageSearchPathRead）
	"ledgerWindowEmpty":                    r13gePinned,    // usage_ledger.go
	"moveRowsIntoUsage":                    r13gePinned,    // usage_ledger.go
	"probeUsagePartitionBudget":            r13gePinned,    // partitions.go
	"reclaimUsagePartitionAtomically":      r13gePinned,    // usage_ledger.go
	"recordUsageKindAtCached":              r13gePinned,    // usage.go
	"updateUsageTokensAtCached":            r13gePinned,    // usage.go
	"usageMonthHasDetail":                  r13gePinned,    // usage_ledger.go
	"usageTreeDescendants":                 r13gePinned,    // partitions.go
	// —— 由调用方事务钉住（每个都必须在 r13geViaCallerOwners 里有点名）——
	"AddExcludedModelTx":                r13geViaCaller, // gateway.go
	"DeleteModelTx":                     r13geViaCaller, // gateway.go
	"GetGatewayProviderTx":              r13geViaCaller, // gateway.go
	"GetModelTx":                        r13geViaCaller, // gateway.go
	"SetSettingTx":                      r13geViaCaller, // settings.go
	"setUsageAppIDTx":                   r13geViaCaller, // wasm_app_opens.go —— SetUsageAppID / SetUsageAppIDVerified（均已钉）
	"SyncProviderModelsTx":              r13geViaCaller, // gateway.go
	"UpdateGatewayProviderTx":           r13geViaCaller, // gateway.go
	"addModel":                          r13geViaCaller, // gateway.go
	"addProviderModelName":              r13geViaCaller, // gateway.go
	"clearDefaultModelIf":               r13geViaCaller, // gateway.go
	"excludedModelsTx":                  r13geViaCaller, // gateway.go
	"getSettingQ":                       r13geViaCaller, // settings.go
	"grantBatchTx":                      r13geViaCaller, // balance.go
	"guardErr":                          r13geViaCaller, // usage_ledger.go
	"insertLedgerTx":                    r13geViaCaller, // balance.go
	"insertProvider":                    r13geViaCaller, // gateway.go
	"ledgerDetailSource":                r13geViaCaller, // usage_ledger.go
	"modelCachePriceForProviderQ":       r13geViaCaller, // gateway.go
	"modelCachePriceQ":                  r13geViaCaller, // gateway.go
	"modelDefaultParamsQ":               r13geViaCaller, // gateway.go
	"modelPricesForProviderQ":           r13geViaCaller, // gateway.go
	"modelPricesQ":                      r13geViaCaller, // gateway.go
	"partitionAncestorBounds":           r13geViaCaller, // partitions.go
	"providerModelRowsTx":               r13geViaCaller, // gateway.go
	"rebuildUsageLedgerRowsFrom":        r13geViaCaller, // usage_ledger.go
	"removeProviderModelName":           r13geViaCaller, // gateway.go
	"settleUsageCostTx":                 r13geViaCaller, // balance.go
	"usagePartitionRoot":                r13geViaCaller, // usage_ledger.go
	"usageRelationIsDirectChildOfUsage": r13geViaCaller, // usage_ledger.go
	// —— 只读 pg_catalog / to_regclass('public.'||…)（shadow 顶不掉，无动作面）——
	"scanUsageMonthTables":      r13geCatalogOnly, // usage_ledger.go
	"usageReclaimEstimatedRows": r13geCatalogOnly, // usage_ledger.go
	"verifyAuditChainOn":        r13geViaCaller,   // audit.go —— VerifyAuditChain（withUsageSearchPathRead）
}

// r13geViaCallerOwners 给每一个 via-caller 登记"谁钉的"，避免"以为有人钉"。
var r13geViaCallerOwners = map[string]string{
	// 事务版（同一个函数的 Tx 形态）：由它们的池上包装钉。
	"AuditLogTx":              "llmgateway admin 的 provider 创建/更新 / 模型删除事务（serverstore.UsageWriteTx 开出的已钉事务）",
	"listAuditLogsOn":         "listAuditLogs（withUsageSearchPathRead）",
	"verifyAuditChainOn":      "VerifyAuditChain（withUsageSearchPathRead）",
	"GetGatewayProviderTx":    "GetGatewayProvider（已钉只读事务）",
	"GetModelTx":              "GetModel（已钉只读事务）",
	"SetSettingTx":            "调用方事务（llmgateway/admin.go 等，均在事务首句业务语句前钉）",
	"setUsageAppIDTx":         "SetUsageAppID（withUsageSearchPath）/ SetUsageAppIDVerified（同一已钉事务内先查 apps 再写）",
	"DeleteModelTx":           "DeleteModel（usageWriteTx）/ llmgateway admin 的显式事务",
	"SyncProviderModelsTx":    "SyncProviderModel 的调用方事务（llmgateway admin，已钉）",
	"UpdateGatewayProviderTx": "llmgateway admin 的 provider 更新事务（usageWriteTx 同源）",
	"AddExcludedModelTx":      "llmgateway admin 的排除名单事务",
	"excludedModelsTx":        "AddExcludedModelTx / removeProviderModelName 的调用方事务",
	"providerModelRowsTx":     "RemoveMissingProviderModels / SyncProviderModelsTx 的已钉事务",
	"addProviderModelName":    "UpdateModel / SyncProviderModelsTx 的已钉事务",
	"removeProviderModelName": "DeleteModelTx / UpdateModel 的已钉事务",
	"clearDefaultModelIf":     "UpdateModel / DeleteModelTx 的已钉事务",
	"addModel":                "AddModel / AddModelTx（后者由调用方钉）",
	"insertProvider":          "AddGatewayProvider（withUsageSearchPath）/ AddGatewayProviderTx",
	"insertLedgerTx":          "settleUsageCostTx / adjustBalanceTx / grantBatchTx（均已在事务首句钉）",
	"grantBatchTx":            "GrantMonthlyBalance（usageWriteTx 族）",
	"settleUsageCostTx":       "recordUsageKindAtCached / updateUsageTokensAtCached / 结算段（均已钉）",
	// 语句实现（唯一一份 SQL，接收已钉事务的语句入口 rowQuerier）：
	"modelPricesQ":                "newUsageReadConn 的两个构造点（ModelPrices / loadModelPriceInputs）",
	"modelPricesForProviderQ":     "ModelPricesForProvider / loadModelPriceInputs（已钉只读事务）",
	"modelCachePriceQ":            "ModelCachePrice / loadModelPriceInputs（已钉只读事务）",
	"modelCachePriceForProviderQ": "ModelCachePriceForProvider / loadModelPriceInputs（已钉只读事务）",
	"modelDefaultParamsQ":         "ModelDefaultParams（已钉只读事务）",
	"getSettingQ":                 "GetSetting / loadPeakWindowsQ（已钉只读事务）",
	// 只拼 SQL 文本 / catalog 判据（没有 *sql.DB，语句由调用方的已钉事务执行）：
	"queryBalanceGrant":                 "LastBalanceGrant / GetBalanceGrant（withUsageSearchPathRead 的已钉只读事务）",
	"ledgerDetailSource":                "rebuildUsageLedgerRowsFrom（调用方的已钉事务）",
	"rebuildUsageLedgerRowsFrom":        "rebuildUsageLedgerRowsOnPool / applyUsageRetentionBudget 的已钉事务",
	"usagePartitionRoot":                "scanUsageMonthTables / probeUsagePartitionBudget 等（catalog 判据）",
	"usageRelationIsDirectChildOfUsage": "reclaimUsagePartitionAtomically / dropDetachedOrphanAtomically 的已钉事务",
	"partitionAncestorBounds":           "usagePartitionRoot / probeUsagePartitionBudget 的 catalog 判据",
	"guardErr":                          "usageQuerier 形态：全部调用点都在已钉事务或 catalog 判据里",
}

// r13geFamilyRelRe 匹配"对族内关系的**动作**"（未限定名或 public. 限定都算；
// 注释先被剥掉）。刻意**不含** `to_regclass(` —— 它是"限定名构造器"
// （`to_regclass('public.usage')`），单独由 r13geToRegclassRe 断言必须带 `public.` 前缀。
//
// R13-GH3：关系名不再写在本正则里，而是**从登记表 searchPathRelations 派生**
// （`searchPathFamilyAlternation()`，见 audit_r13gh3_searchpath_serverface_test.go）
// —— 关系集合是显式登记的数据，尺子与登记表不可能分叉；新增关系只改登记表。
var r13geFamilyRelRe = regexp.MustCompile(
	`\b(?:FROM|INTO|UPDATE|JOIN|TABLE|PARTITION\s+OF|DELETE\s+FROM)\s*['"]?\s*(?:public\.|pg_catalog\.|ONLY\s+)?["']?(?:` +
		searchPathFamilyAlternation() + `)\b`)

// r13geToRegclassRe 抓 `to_regclass(<实参>`，用于断言实参必须硬钉 `public.`。
var r13geToRegclassRe = regexp.MustCompile(`to_regclass\(\s*([^)]*)`)

// r13geCatalogRelRe 抓只读 catalog 的函数。
var r13geCatalogRelRe = regexp.MustCompile(`\b(?:pg_class|pg_namespace|pg_inherits|pg_partition_tree|pg_get_expr|pg_partition_root)\b`)

// r13gePinMarkers 是"钉住 search_path"的全部合法记号（唯一实现的入口集合）。
//
// R13-GH3：加入**跨包接缝**的导出名（见 usage_ledger.go 的「本族 pin 的跨包接缝」
// 一节）—— 包外调用点（`internal/llmgateway`）只允许经这几个名字钉，因此它们必须
// 与包内名字一样被认作合法 pin 记号；否则"包外也钉了"会被误判成未收口。
var r13gePinMarkers = []string{
	"pinUsageSearchPath", "withUsageSearchPath", "withUsageSearchPathRead",
	"newUsageReadConn", "newUsageReadConnContext", "usageWriteTx",
	"applyUsageRetentionBudget", "withUsageLockBudget", "setUsageRetentionStatementBudget",
	"withUsageSettleBudget",
	// —— 跨包接缝（导出别名，与上面同一批实现）——
	"UsageWriteTx", "WithUsageSearchPathRead", "WithUsageSearchPath", "NewUsageReadConn",
}

// r13geQuerierMarkers：形参里出现这些记号 ⇒ 函数开不出自己的事务（由调用方钉）。
var r13geQuerierMarkers = []string{"*sql.Tx", "rowQuerier", "usageQuerier", "usageExecer", "func(query string"}

// TestAuditR13GESearchPathInventoryIsComplete 是守卫判据（R13-GE · V2-2）。
//
// 与 R12-N2 版的三点差别：①文件面 = 包内全部非测试源文件（动态枚举）；
// ②分类改为**按签名**判"能不能开自己的事务"（不再靠 `*sql.Tx` 字符串出现在函数体里）；
// ③**删除了 read-acknowledged 档** —— 读面必须与写面同样钉住。
func TestAuditR13GESearchPathInventoryIsComplete(t *testing.T) {
	found := map[string]r13gePinMode{}
	files := r13geSearchPathFiles(t)
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("读 %s: %v", file, err)
		}
		for name, body := range r13geFuncBodies(t, file, string(raw)) {
			mode, ok := r13geClassifyFamilySQL(body)
			if !ok {
				continue
			}
			found[name] = mode
		}
	}
	if n := len(r13geFuncBodiesAll); n < r13geMinFuncBodies {
		t.Fatalf("包内 %d 个源文件里只切出 %d 个函数（下限 %d）—— 守卫失效，不能静默通过",
			len(files), n, r13geMinFuncBodies)
	}
	// ① 覆盖：族内 SQL 出现在清单之外的函数 ⇒ 新漏点
	var missing []string
	for name := range found {
		if _, ok := r13geSearchPathInventory[name]; !ok {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("这些函数触碰了族内关系 SQL 但**没有登记**在 r13geSearchPathInventory 里：%v\n"+
			"⇒ 新增一个「判据硬钉 public、动作走 search_path」的入口不会被任何人发现"+
			"（R12-A P1-02 写面 / R13 V2-2 读面都是这个形态）。请登记它并声明 pin 模式"+
			"（pinned / via-caller / catalog-only）；**没有「读面已认账」这一档**。", missing)
	}
	// ② 反向：清单里的 pinned 项必须真的钉了（防止"登记了却没钉"）
	for name, mode := range r13geSearchPathInventory {
		body, ok := r13geFuncBodiesAll[name]
		if !ok {
			t.Errorf("清单登记了 %q，但包内源文件里找不到这个函数（清单陈旧）", name)
			continue
		}
		clean := r13geStripComments(body)
		switch mode {
		case r13gePinned:
			if !r13geHasPinMarker(clean) {
				t.Errorf("%q 被登记为 pinned，但函数体里没有任何 pin 记号（%v）—— 登记与实现不符",
					name, r13gePinMarkers)
			}
		case r13geViaCaller:
			if _, ok := r13geViaCallerOwners[name]; !ok {
				t.Errorf("%q 登记为 via-caller，但没有在 r13geViaCallerOwners 里点名谁钉了它", name)
			}
		case r13geCatalogOnly:
			if r13geFamilyRelRe.MatchString(clean) {
				t.Errorf("%q 登记为 catalog-only，但函数体里有对族内关系的**动作**（未限定名）—— "+
					"catalog 判据不得顺带读写族内关系", name)
			}
		default:
			t.Errorf("%q 的模式 %q 不在封闭集合 {pinned, via-caller, catalog-only} 里", name, mode)
		}
	}
	// ③ 封闭性：不允许出现任何"认账但未收口"的档（R12-N2 的 read-acknowledged 已删除）
	for name, mode := range r13geSearchPathInventory {
		if mode != r13gePinned && mode != r13geViaCaller && mode != r13geCatalogOnly {
			t.Errorf("清单条目 %q 的模式 %q 不合法：本清单只允许 pinned / via-caller / catalog-only"+
				"（读面与写面同等收口，没有「已认账」这一档）", name, mode)
		}
	}
	t.Logf("族内 SQL 函数共 %d 个，清单登记 %d 个（pinned=%d via-caller=%d catalog-only=%d）",
		len(found), len(r13geSearchPathInventory), r13geCountMode(r13gePinned),
		r13geCountMode(r13geViaCaller), r13geCountMode(r13geCatalogOnly))
}

// TestAuditR13GEToRegclassIsAlwaysPublicQualified 是配套的第二个机械判据：
// 族内关系的动态名构造只允许 `to_regclass('public.'||…)` —— 未限定的
// `to_regclass('usage')` 会按 search_path 解析（正是 shadow 场景），而它比
// 裸 `FROM usage` 更隐蔽（catalog 函数看起来"没有动作面"）。
func TestAuditR13GEToRegclassIsAlwaysPublicQualified(t *testing.T) {
	for _, file := range r13geSearchPathFiles(t) {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("读 %s: %v", file, err)
		}
		for _, m := range r13geToRegclassRe.FindAllStringSubmatch(r13geStripComments(string(raw)), -1) {
			arg := strings.TrimSpace(m[1])
			// 只对"指向族内关系"的实参做要求；`to_regclass($1)` 这类变量形态在
			// 本包不存在（若将来出现，会命中下面这条 fail-loud）。
			if !strings.Contains(arg, "public.") {
				t.Errorf("%s：to_regclass(%s) 没有硬钉 public. 前缀 —— shadow schema 在场时"+
					"它会解析到别的库，而调用点看起来只是「查一个 catalog 事实」", file, arg)
			}
		}
	}
}

// r13geFuncBodiesAll 是所有函数体（不按类过滤），供反向判据用。
var r13geFuncBodiesAll = map[string]string{}

// r13geFuncBodies 把源码切成 `函数名 → 函数体`（gofmt 形态：函数体结束于列 0 的 `}`）。
// 返回的 body **包含签名行**（分类要用签名判"能不能开自己的事务"）。
func r13geFuncBodies(t *testing.T, file, src string) map[string]string {
	t.Helper()
	out := map[string]string{}
	re := regexp.MustCompile(`(?m)^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(`)
	locs := re.FindAllStringSubmatchIndex(src, -1)
	for i, m := range locs {
		name := src[m[2]:m[3]]
		start := m[0]
		end := len(src)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		body := src[start:end]
		out[name] = body
		r13geFuncBodiesAll[name] = body
	}
	// 允许"只有包级变量、没有函数"的源文件（例如 errors.go）；但**整体**切不出
	// 函数就是守卫失效 —— 用调用方的总数下限兜住（见下面的 r13geMinFuncBodies）。
	return out
}

// r13geMinFuncBodies 是"切函数"这一步的下限：包内函数总数低于它 ⇒ 守卫失效
// （正则被改坏/文件被整体搬走），必须 fail-loud 而不是静默通过。
const r13geMinFuncBodies = 600

// r13geClassifyFamilySQL 判断函数（**已去注释**）里有没有族内关系 SQL，并给出模式。
func r13geClassifyFamilySQL(body string) (r13gePinMode, bool) {
	clean := r13geStripComments(body)
	fam := r13geFamilyRelRe.MatchString(clean)
	cat := r13geCatalogRelRe.MatchString(clean)
	if !fam && !cat {
		return "", false
	}
	if r13geHasPinMarker(clean) {
		return r13gePinned, true
	}
	// 开不出自己的事务 ⇒ 由调用方钉（签名判据，不看函数体）。
	sig := clean
	if i := strings.Index(clean, "{"); i >= 0 {
		sig = clean[:i]
	}
	if !strings.Contains(sig, "*sql.DB") {
		return r13geViaCaller, true
	}
	if !fam {
		return r13geCatalogOnly, true
	}
	// 有 *sql.DB、有族内关系动作、又没有 pin 记号 ⇒ 未收口（登记表里不该有它）。
	return r13gePinned, true
}

// r13geHasPinMarker 报告这段代码是否调用了任一 pin 唯一实现。
func r13geHasPinMarker(clean string) bool {
	for _, m := range r13gePinMarkers {
		if strings.Contains(clean, m) {
			return true
		}
	}
	return false
}

// r13geStripComments 去掉行注释与块注释（只用于"这段代码里有没有族内 SQL"的判据：
// 注释里大段讨论 `FROM usage` 是常态，不能把注释算成动作面）。
func r13geStripComments(src string) string {
	src = regexp.MustCompile(`(?s)/\*.*?\*/`).ReplaceAllString(src, "")
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if i := strings.Index(line, "//"); i >= 0 && strings.Count(line[:i], `"`)%2 == 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

func r13geCountMode(m r13gePinMode) int {
	n := 0
	for _, v := range r13geSearchPathInventory {
		if v == m {
			n++
		}
	}
	return n
}

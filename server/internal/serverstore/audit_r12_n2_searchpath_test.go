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
//	B. 机械守卫：5 个族内文件里**每一个**触碰族内关系 SQL 的函数都必须在
//	   `r12n2SearchPathInventory` 里登记并声明它怎么钉 —— 新增函数不登记即红，
//	   "第 N 个漏点"从此不可能静默出现。

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
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
	u, err := url.Parse(r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("options", "-csearch_path="+r12n2ShadowSchema+",public")
	u.RawQuery = q.Encode()
	side, err := openPG(u.String())
	if err != nil {
		t.Fatalf("openPG(shadow): %v", err)
	}
	t.Cleanup(func() { side.Close() })
	if err := side.Ping(); err != nil {
		t.Fatalf("search_path 池 ping: %v", err)
	}
	var sp string
	if err := side.QueryRow("SHOW search_path").Scan(&sp); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sp, r12n2ShadowSchema) {
		t.Fatalf("旁路池 search_path=%q，第一段必须是 %s（夹具无效）", sp, r12n2ShadowSchema)
	}
	t.Logf("旁路池 search_path=%q", sp)
	return side
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

// r12n2SearchPathFile 是被守卫的族内文件（改动面）。
var r12n2SearchPathFiles = []string{
	"usage.go", "usage_ledger.go", "usage_retention_status.go", "partitions.go", "balance.go",
}

// r12n2PinMode 是"这个函数的 SQL 怎么与判据看同一个对象"的封闭取值。
type r12n2PinMode string

const (
	// r12n2Pinned：函数自己（或它直接调用的唯一实现）钉了 search_path。
	r12n2Pinned r12n2PinMode = "pinned"
	// r12n2ViaCaller：函数只接受 `*sql.Tx`（或从调用方拿事务），由**调用者**钉；
	// 每一个这样的函数都必须在 r12n2ViaCallerOwners 里点名谁钉了它。
	r12n2ViaCaller r12n2PinMode = "via-caller"
	// r12n2CatalogOnly：只读 `pg_catalog`（`pg_class` / `pg_namespace` / `pg_inherits`…）
	// 与 `to_regclass('public.'||…)`：pg_catalog 永远隐式排在 search_path 最前，
	// shadow schema 顶不掉它；判据本身硬钉 `public.`，没有"动作面"。
	r12n2CatalogOnly r12n2PinMode = "catalog-only"
	// r12n2ReadAcknowledged：报表/管理端**读**面（R12-A §3.2 第 5 行，已认账：
	// 读面仍按 search_path，属独立课题，不在本次"计量—结算—清理"写入链路的改动面内）。
	r12n2ReadAcknowledged r12n2PinMode = "read-acknowledged"
)

// r12n2SearchPathInventory 是"触碰族内关系 SQL 的函数"的**完整清单**（R12-N2 P1-02）。
//
// 守卫判据（TestAuditR12N2SearchPathInventoryIsComplete）：族内 5 个文件里**每一个**
// 含族内关系 SQL（非注释）的函数都必须在这里登记；登记了却不存在、或模式与实现不符，
// 同样红。⇒ 新增一个未钉的入口不可能静默出现（这正是"只钉了 3 个调用点"的防线）。
var r12n2SearchPathInventory = map[string]r12n2PinMode{
	// —— 计量写入 / 结算 / 绑定 / 删除 / 清理（本次修复面）——
	"recordUsageKindAtCached":      r12n2Pinned, // 事务内 pinUsageSearchPath
	"updateUsageTokensAtCached":    r12n2Pinned, // 读+写同事务、同一 pin
	"SetUsageProvider":             r12n2Pinned, // withUsageSearchPath
	"DeleteUsage":                  r12n2Pinned, // withUsageSearchPath
	"CleanupPendingUsage":          r12n2Pinned, // withUsageSearchPath
	"rebuildUsageLedgerRowsOnPool": r12n2Pinned, // pinUsageSearchPath
	"rebuildUsageLedgerRowsFrom":   r12n2ViaCaller,
	"ledgerDetailSource":           r12n2ViaCaller, // 只拼 SQL 文本，由调用方的事务执行
	"applyUsageRetentionBudget":    r12n2Pinned,
	"pinUsageSearchPath":           r12n2Pinned,
	"withUsageSearchPath":          r12n2Pinned,
	"runPartitionDDLAttempt":       r12n2Pinned,
	// —— 写路径的分区探测 / 覆盖扫描（判据硬钉 public.，动作是 CREATE/ATTACH）——
	"probeUsagePartitionBudget": r12n2Pinned,
	"usageTreeDescendants":      r12n2Pinned,
	// —— 余额链路（与结算同族，本次一并收口）——
	"AdjustUserBalance":   r12n2Pinned,
	"SetUserBalance":      r12n2Pinned,
	"GrantMonthlyBalance": r12n2Pinned,
	// —— 由调用方事务钉住的余额辅助（每个都必须有 owner）——
	"settleUsageCostTx":               r12n2ViaCaller, // recordUsageKindAtCached / updateUsageTokensAtCached / 结算段
	"adjustBalanceTx":                 r12n2ViaCaller, // AdjustUserBalance / SetUserBalance / grantBatchTx
	"insertLedgerTx":                  r12n2ViaCaller, // settleUsageCostTx / adjustBalanceTx / grantBatchTx
	"grantBatchTx":                    r12n2ViaCaller, // GrantMonthlyBalance
	"moveRowsIntoUsage":               r12n2ViaCaller, // 清理路径的临界区事务（applyUsageRetentionBudget）
	"CleanupUsageRetention":           r12n2ViaCaller, // 主循环：每个事务都经 applyUsageRetentionBudget
	"reclaimUsagePartitionAtomically": r12n2ViaCaller,

	// —— 只读 `pg_catalog` / `to_regclass('public.'||…)` 的判据（shadow schema 顶不掉
	// pg_catalog —— 它永远隐式排在 search_path 最前；判据本身硬钉 public.，没有动作面）——
	"usageMonthHasDetail":               r12n2CatalogOnly,
	"scanUsageMonthTables":              r12n2CatalogOnly,
	"usagePartitionRoot":                r12n2CatalogOnly,
	"usageRelationIsDirectChildOfUsage": r12n2CatalogOnly,
	"guardErr":                          r12n2CatalogOnly,
	"partitionAncestorBounds":           r12n2CatalogOnly,
	"usageReclaimEstimatedRows":         r12n2CatalogOnly,

	// —— 报表/管理端**读**面（R12-A §3.2 第 5 行，审计已认账：它们仍是"判据硬钉
	// public、动作走 search_path"，属独立课题）。登记在这里是为了让它们**可见**：
	// 一旦决定收口，这里就是完整的待改清单（守卫会强迫新增读面也登记）。
	"UserMonthlyUsage":         r12n2ReadAcknowledged,
	"UserMonthlyUsageBatch":    r12n2ReadAcknowledged,
	"UserMonthlyCost":          r12n2ReadAcknowledged,
	"UserMonthlyCostBatch":     r12n2ReadAcknowledged,
	"UserDayUsageCost":         r12n2ReadAcknowledged,
	"UserTotalUsageCost":       r12n2ReadAcknowledged,
	"UsageAggregate":           r12n2ReadAcknowledged,
	"UsageAggregateWithLedger": r12n2ReadAcknowledged,
	"UsageAggregateFromLedger": r12n2ReadAcknowledged,
	"ledgerMonthHasRows":       r12n2ReadAcknowledged,
	"ledgerWindowEmpty":        r12n2ReadAcknowledged,
	"BalanceLedgerPage":        r12n2ReadAcknowledged,
	"BalanceLedgerSum":         r12n2ReadAcknowledged,
	"GetBalanceSummary":        r12n2ReadAcknowledged,
	"GetGrantStatus":           r12n2ReadAcknowledged,
}

// r12n2ViaCallerOwners 给每一个 via-caller 登记"谁钉的"，避免"以为有人钉"。
var r12n2ViaCallerOwners = map[string]string{
	"rebuildUsageLedgerRowsFrom":      "rebuildUsageLedgerRowsOnPool / applyUsageRetentionBudget 的已钉事务",
	"ledgerDetailSource":              "同上（只返回 SQL 文本）",
	"settleUsageCostTx":               "recordUsageKindAtCached / updateUsageTokensAtCached / settleUsageReclaim（均已在事务首句钉）",
	"adjustBalanceTx":                 "AdjustUserBalance / SetUserBalance / grantBatchTx",
	"insertLedgerTx":                  "settleUsageCostTx / adjustBalanceTx / grantBatchTx",
	"grantBatchTx":                    "GrantMonthlyBalance（事务首句钉）",
	"moveRowsIntoUsage":               "applyUsageRetentionBudget 的已钉事务",
	"CleanupUsageRetention":           "applyUsageRetentionBudget / withUsageLockBudget / withUsageSettleBudget（每个事务都钉）",
	"reclaimUsagePartitionAtomically": "setUsageRetentionStatementBudget（= applyUsageRetentionBudget）",
}

// TestAuditR12N2SearchPathInventoryIsComplete 是守卫判据 B。
//
// 实现口径：把族内 5 个文件的函数体切出来（gofmt 之后的 Go 源码里函数体结束于列 0
// 的 `}`），**去掉注释**后匹配"族内关系的 SQL 上下文"，与清单逐条对拍。
func TestAuditR12N2SearchPathInventoryIsComplete(t *testing.T) {
	found := map[string]r12n2PinMode{}
	for _, file := range r12n2SearchPathFiles {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("读 %s: %v", file, err)
		}
		for name, body := range r12n2FuncBodies(t, file, string(raw)) {
			mode, ok := r12n2ClassifyFamilySQL(body)
			if !ok {
				continue
			}
			found[name] = mode
		}
	}
	// ① 覆盖：族内 SQL 出现在清单之外的函数 ⇒ 新漏点
	var missing []string
	for name := range found {
		if _, ok := r12n2SearchPathInventory[name]; !ok {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("这些函数触碰了族内关系 SQL 但**没有登记**在 r12n2SearchPathInventory 里：%v\n"+
			"⇒ 新增一个「判据硬钉 public、动作走 search_path」的入口不会被任何人发现（R12-A P1-02 的形态）。"+
			"请登记它并声明 pin 模式（pinned / via-caller / catalog-only / read-acknowledged）", missing)
	}
	// ② 反向：清单里的 pinned 项必须真的钉了（防止"登记了却没钉"）
	for name, mode := range r12n2SearchPathInventory {
		body, ok := r12n2FuncBodiesAll[name]
		if !ok {
			t.Errorf("清单登记了 %q，但族内 5 个文件里找不到这个函数（清单陈旧）", name)
			continue
		}
		pinned := strings.Contains(body, "pinUsageSearchPath") || strings.Contains(body, "withUsageSearchPath") ||
			strings.Contains(body, "applyUsageRetentionBudget") || strings.Contains(body, "withUsageLockBudget") ||
			strings.Contains(body, "setUsageRetentionStatementBudget") || strings.Contains(body, "withUsageSettleBudget")
		switch mode {
		case r12n2Pinned:
			if !pinned {
				t.Errorf("%q 被登记为 pinned，但函数体里既没有 pinUsageSearchPath/withUsageSearchPath，"+
					"也没有走 applyUsageRetentionBudget 家族 —— 登记与实现不符", name)
			}
		case r12n2ViaCaller:
			if _, ok := r12n2ViaCallerOwners[name]; !ok {
				t.Errorf("%q 登记为 via-caller，但没有在 r12n2ViaCallerOwners 里点名谁钉了它", name)
			}
		}
	}
	t.Logf("族内 SQL 函数共 %d 个，清单登记 %d 个（pinned=%d via-caller=%d catalog-only=%d read-acknowledged=%d）",
		len(found), len(r12n2SearchPathInventory), r12n2CountMode(r12n2Pinned), r12n2CountMode(r12n2ViaCaller),
		r12n2CountMode(r12n2CatalogOnly), r12n2CountMode(r12n2ReadAcknowledged))
}

// r12n2FuncBodiesAll 是所有函数体（不按类过滤），供反向判据用。
var r12n2FuncBodiesAll = map[string]string{}

// r12n2FuncBodies 把源码切成 `函数名 → 函数体`（gofmt 形态：函数体结束于列 0 的 `}`）。
func r12n2FuncBodies(t *testing.T, file, src string) map[string]string {
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
		r12n2FuncBodiesAll[name] = body
	}
	if len(out) == 0 {
		t.Fatalf("%s：一个函数都没切出来（守卫失效，不能静默通过）", file)
	}
	return out
}

// 族内关系名（`public.` 限定与否都算）与它们的 SQL 上下文。
var (
	r12n2FamilyRelRe = regexp.MustCompile(
		`\b(?:FROM|INTO|UPDATE|JOIN|TABLE|PARTITION\s+OF|DELETE\s+FROM|to_regclass\()\s*['"` + "`" + `(]?\s*(?:public\.|pg_catalog\.|ONLY\s+)?["']?(?:usage_daily|usage_monthly|usage|balance_ledger|users|models|user_groups)\b`)
	r12n2CatalogRelRe = regexp.MustCompile(`\b(?:pg_class|pg_namespace|pg_inherits|pg_partition_tree|pg_get_expr|pg_partition_root)\b`)
)

// r12n2ClassifyFamilySQL 判断函数体（**已去注释**）里有没有族内关系 SQL，并给出模式。
func r12n2ClassifyFamilySQL(body string) (r12n2PinMode, bool) {
	clean := r12n2StripComments(body)
	if !r12n2FamilyRelRe.MatchString(clean) {
		// 只看 catalog 的（判据硬钉 public.，没有动作面）也算"触碰"——
		// 它们大多是 catalog-only，登记后由清单声明。
		if !r12n2CatalogRelRe.MatchString(clean) {
			return "", false
		}
	}
	pinned := strings.Contains(clean, "pinUsageSearchPath") || strings.Contains(clean, "withUsageSearchPath") ||
		strings.Contains(clean, "applyUsageRetentionBudget") || strings.Contains(clean, "withUsageLockBudget") ||
		strings.Contains(clean, "setUsageRetentionStatementBudget") || strings.Contains(clean, "withUsageSettleBudget")
	if pinned {
		return r12n2Pinned, true
	}
	if strings.Contains(clean, "*sql.Tx") {
		return r12n2ViaCaller, true
	}
	if !r12n2FamilyRelRe.MatchString(clean) {
		return r12n2CatalogOnly, true
	}
	return r12n2ReadAcknowledged, true
}

// r12n2StripComments 去掉行注释与块注释（只用于"这段代码里有没有族内 SQL"的判据：
// 注释里大段讨论 `FROM usage` 是常态，不能把注释算成动作面）。
func r12n2StripComments(src string) string {
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

func r12n2CountMode(m r12n2PinMode) int {
	n := 0
	for _, v := range r12n2SearchPathInventory {
		if v == m {
			n++
		}
	}
	return n
}

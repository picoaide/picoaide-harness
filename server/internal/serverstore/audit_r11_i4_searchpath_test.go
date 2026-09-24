package serverstore

// R11-I4 · R11A-02（P2）回归：**判据与动作必须看到同一个对象**。
//
// 被审形态（origin/master @ 3264137997）：
//
//	清理路径的 catalog 判据一律硬钉 `public.`（`n.nspname = 'public'` +
//	`to_regclass('public.'||…)`：partitions.go 的形态探测、usage_ledger.go 的
//	存在性/直接父判据），而**动作**（`LOCK TABLE ONLY usage`、
//	`ALTER TABLE usage DETACH PARTITION …`、`DROP TABLE IF EXISTS "usage_<M>"`、
//	补账聚合的 `FROM usage`、`CREATE TABLE … PARTITION OF "usage"`）以及**写入**
//	（usage.go 的 `INSERT INTO usage`）用的都是**未限定名**。
//	⇒ 会话/角色/库级 `search_path` 前置了一个同名 shadow schema 时：真关系
//	**一行未动**、整轮 `err=nil/cleared=0/skipped=0/failures=0`（保留策略静默停摆、
//	/readyz 全绿），而永久账本被 shadow 的**虚构金额**覆盖成 999.00（真实明细
//	12.50 未进账本）。
//
// 修法口径 = **统一 search_path**（`SET LOCAL search_path = pg_catalog, public`，
// 唯一字面量 `usageSearchPathPin`）：一句覆盖事务内所有关系引用（含辅助函数里拼
// 出来的语句），并且 `pg_catalog` 在前还封掉同名函数/类型的遮蔽 —— 逐名限定做不到
// 后一半。调用点：清理路径的每一个事务（applyUsageRetentionBudget）、计量写入事务
// （usage.go）、池上账本聚合（rebuildUsageLedgerRowsOnPool）。
//
// 本用例的判据（与审计探针 B 同形，只是**断言修好之后的行为**）：
//
//	① 真关系被正常回收（不是"一行未动"）；
//	② 永久账本 = **真实**金额，且不含 shadow 的虚构金额；
//	③ 计量写入落在 `public.usage`，不落进 shadow 树。

import (
	"database/sql"
	"math"
	"net/url"
	"testing"
	"time"
)

// i4ShadowSchema 是 shadow 树的 schema 名（用例独占，用完 DROP）。
const i4ShadowSchema = "r11i4_shadow"

// i4PoolWithSearchPath 开一个把 search_path 钉成 `shadow,public` 的连接池
// （形态与"角色/库级 ALTER ROLE … SET search_path=…"或 DSN options 等价）。
func i4PoolWithSearchPath(t *testing.T, db *sql.DB, path string) *sql.DB {
	t.Helper()
	u, err := url.Parse(r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("options", "-csearch_path="+path)
	u.RawQuery = q.Encode()
	side, err := openPG(u.String())
	if err != nil {
		t.Fatalf("openPG(%s): %v", path, err)
	}
	t.Cleanup(func() { side.Close() })
	if err := side.Ping(); err != nil {
		t.Fatalf("search_path 池 ping: %v", err)
	}
	var sp string
	if err := side.QueryRow("SHOW search_path").Scan(&sp); err != nil {
		t.Fatal(err)
	}
	if sp != path {
		t.Fatalf("旁路池 search_path=%q，want %q（夹具无效）", sp, path)
	}
	t.Logf("旁路池 search_path=%q", sp)
	return side
}

// i4InstallShadowTree 造一株与真表同名的 shadow 分区树（边界与真实分区逐值一致），
// 并在其中放一条**虚构金额**。
func i4InstallShadowTree(t *testing.T, db *sql.DB, rel, model string, uid int64, at time.Time, shadowCost float64) {
	t.Helper()
	if _, err := db.Exec("DROP SCHEMA IF EXISTS " + quoteRelationIdent(i4ShadowSchema) + " CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE SCHEMA " + quoteRelationIdent(i4ShadowSchema)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(i4ShadowSchema) + `.usage (
			id bigserial,
			user_id bigint NOT NULL, model text NOT NULL, provider_id bigint DEFAULT 0,
			prompt_tokens bigint DEFAULT 0, completion_tokens bigint DEFAULT 0,
			cache_prompt_tokens bigint DEFAULT 0, kind text DEFAULT 'chat',
			cost double precision DEFAULT 0, created_at timestamptz NOT NULL,
			estimated boolean DEFAULT false, app_id text) PARTITION BY RANGE (created_at)`); err != nil {
		t.Fatalf("建 shadow 父表: %v", err)
	}
	for i := 8; i >= 1; i-- {
		m := bjMonth(i)
		lo := BeijingDayInstant(dayKey(m))
		hi := BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))
		if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(i4ShadowSchema) + `.` + quoteRelationIdent("usage_"+monthKey(m)) +
			` PARTITION OF ` + quoteRelationIdent(i4ShadowSchema) + `.usage FOR VALUES FROM ('` +
			lo.Format(pgInstantFmt) + `') TO ('` + hi.Format(pgInstantFmt) + `')`); err != nil {
			t.Fatalf("建 shadow 月分区 %s: %v", monthKey(m), err)
		}
	}
	// 与**真分区同名**的 shadow 月分区（用户例里的 rel）也必须存在：动作若解析到
	// shadow，就会作用在它身上而不是真关系。
	lo := BeijingDayInstant(dayKey(bjMonth(4)))
	hi := BeijingDayInstant(dayKey(bjMonth(4)).AddDate(0, 1, 0))
	// 月循环里可能已经建过同名的那一个（bjMonth(4) 在覆盖范围内）⇒ IF NOT EXISTS。
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS ` + quoteRelationIdent(i4ShadowSchema) + `.` + quoteRelationIdent(rel) +
		` PARTITION OF ` + quoteRelationIdent(i4ShadowSchema) + `.usage FOR VALUES FROM ('` +
		lo.Format(pgInstantFmt) + `') TO ('` + hi.Format(pgInstantFmt) + `')`); err != nil {
		t.Fatalf("建 shadow 同名分区 %s: %v", rel, err)
	}
	if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(i4ShadowSchema)+`.`+quoteRelationIdent(rel)+`
		(user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
		VALUES ($1,$2,1,1,'chat',$3,$4,false)`, uid, model, shadowCost, at); err != nil {
		t.Fatalf("写 shadow 明细: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA IF EXISTS " + quoteRelationIdent(i4ShadowSchema) + " CASCADE") })
}

// TestR11I4SearchPathShadowTreeDoesNotDecouple 是这条的主判据。
func TestR11I4SearchPathShadowTreeDoesNotDecouple(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	for _, stmt := range []string{
		"TRUNCATE TABLE usage RESTART IDENTITY CASCADE",
		"TRUNCATE TABLE usage_daily RESTART IDENTITY CASCADE",
		"TRUNCATE TABLE usage_monthly RESTART IDENTITY CASCADE",
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	nominal := bjMonth(4)
	rel := "usage_" + monthKey(nominal)
	uid := mustUserID(t, db)

	// 真实明细：一条属于名义月的行（走 public.usage 的分区路由）。
	const realCost = 12.5
	id := usageRowAt(t, db, uid, "r11i4-real", BeijingDayAt(nominal, 10), realCost)
	if got := r6PartitionOf(t, db, id); got != rel {
		t.Fatalf("夹具无效：真实行落在 %s，want %s", got, rel)
	}
	const shadowCost = 999.0
	i4InstallShadowTree(t, db, rel, "r11i4-real", uid, BeijingDayAt(nominal, 10), shadowCost)

	// 用 search_path=r11i4_shadow,public 的池跑一轮清理（与"角色级/库级 search_path"
	// 或 DSN options 等价的执行上下文）。
	pool := i4PoolWithSearchPath(t, db, i4ShadowSchema+",public")
	roundErr := CleanupUsageRetention(pool)
	st := CurrentUsageRetentionStatus()

	// ① 真关系必须被正常回收（旧形态：一行未动 + cleared=0/skipped=0/failures=0）。
	if r9aRelationExists(t, db, rel) {
		t.Errorf("判据与动作解耦：真关系 public.%s 仍在（旧形态是'整轮 err=nil/cleared=0/skipped=0/failures=0'），"+
			"roundErr=%v cleared=%d skipped=%d failures=%d", rel, roundErr, st.ClearedPartitions, st.Skipped, st.Failures)
	}
	// ② 永久账本必须是**真实**金额（旧形态：被 shadow 的虚构金额覆盖）。
	var ledgerCost float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage_daily
		WHERE day = $1::date AND model = 'r11i4-real'`,
		BeijingDayAt(nominal, 10).Format(dateFmt)).Scan(&ledgerCost); err != nil {
		t.Fatal(err)
	}
	t.Logf("看板：roundErr=%v | 真关系存在=%v | 账本金额=%.4f（真实 %.2f / shadow %.2f）| cleared=%d skipped=%d failures=%d",
		roundErr, r9aRelationExists(t, db, rel), ledgerCost, realCost, shadowCost, st.ClearedPartitions, st.Skipped, st.Failures)
	if math.Abs(ledgerCost-realCost) > 1e-9 {
		t.Errorf("账本金额=%.4f，want %.4f（真实明细）；shadow 的虚构金额 %.2f 不得进账本",
			ledgerCost, realCost, shadowCost)
	}
	// ③ shadow 里的行一根毫毛都不该被动过。
	var shadowLeft int64
	if err := db.QueryRow(`SELECT count(*) FROM ` + quoteRelationIdent(i4ShadowSchema) + `.` + quoteRelationIdent(rel)).Scan(&shadowLeft); err != nil {
		t.Fatal(err)
	}
	if shadowLeft != 1 {
		t.Errorf("shadow 树里的行数=%d，want 1（动作不得作用于 shadow）", shadowLeft)
	}
}

// TestR11I4SearchPathMeteringWriteLandsInPublic 覆盖写入路径那一半：`INSERT INTO
// usage` 用的也是未限定名，旧形态会让计量行落进 shadow 树 ⇒ 从产品的全部读面上
// 消失（而所有健康出口报绿）。
func TestR11I4SearchPathMeteringWriteLandsInPublic(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	// shadow 树里也放一株**当月**分区：旧形态下写入会路由到它。
	rel := "usage_" + monthKey(bjMonth(4))
	i4InstallShadowTree(t, db, rel, "r11i4-w", uid, BeijingDayAt(bjMonth(4), 10), 1.0)
	now := time.Now()
	shadowMonth := "usage_" + monthKey(BeijingMonth(now))
	lo := BeijingDayInstant(dayKey(BeijingMonth(now)))
	hi := BeijingDayInstant(dayKey(BeijingMonth(now)).AddDate(0, 1, 0))
	if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(i4ShadowSchema) + `.` + quoteRelationIdent(shadowMonth) +
		` PARTITION OF ` + quoteRelationIdent(i4ShadowSchema) + `.usage FOR VALUES FROM ('` +
		lo.Format(pgInstantFmt) + `') TO ('` + hi.Format(pgInstantFmt) + `')`); err != nil {
		t.Fatalf("建 shadow 当月分区: %v", err)
	}

	pool := i4PoolWithSearchPath(t, db, i4ShadowSchema+",public")
	id, err := RecordUsageKind(pool, uid, "r11i4-write", 11, 22, "chat")
	if err != nil {
		t.Fatalf("计量写入失败: %v", err)
	}
	// 按 (id, model) 定位：shadow 树里那条**虚构行**的 id 也是 1（各自独立的
	// bigserial），只按 id 查会把 shadow 自己的行算进来（本用例第一版就这么错过）。
	var inPublic, inShadow int64
	if err := db.QueryRow(`SELECT count(*) FROM public.usage WHERE id = $1 AND model = 'r11i4-write'`, id).Scan(&inPublic); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM ` + quoteRelationIdent(i4ShadowSchema) + `.usage WHERE model = 'r11i4-write'`).Scan(&inShadow); err != nil {
		t.Fatal(err)
	}
	t.Logf("写入路径看板：id=%d public.usage=%d shadow.usage=%d", id, inPublic, inShadow)
	if inPublic != 1 || inShadow != 0 {
		t.Errorf("计量行落错对象：public=%d shadow=%d（want 1/0 —— 写入路径必须与判据同源）", inPublic, inShadow)
	}
}

package serverstore

import (
	"bytes"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

// 0039 回归（2026-09-23，P0 MIG-1）：**存量普通表 usage 必须能升级**。
//
// 病根（独立审计用真实载荷复现）：v2.4.0 的 `0004_usage.sql` 建的是**普通表**，
// 该文件后来被**原地改写**成 `PARTITION BY RANGE` 版本（与 0039 同在提交
// 8f8d09fe31），而 `schema_migrations` 只记版本号、**没有校验和** ⇒ 由旧 0004
// 建库的存量库上，0039 原来的 `CREATE TABLE IF NOT EXISTS usage` 静默跳过（表已
// 存在）、紧接着的 `PARTITION OF usage` 直接报 `"usage" is not partitioned`：
// 事务回滚、版本号不落库、`cmd/server/main.go` 的 log.Fatalf ⇒ **崩溃循环，
// 每次启动重跑同一条迁移、重试永不自愈**。
//
// 本用例走**真实升级路径**（不是"直接建分区表再断言"）：
//
//	① 迁移 0001..0038 建出"升级前"的库，其中 0004 用 **v2.4.0 的正文**
//	   （testdata/legacy_0004_usage_v240.sql，git show 取出的逐字节副本，
//	   下方 legacyV240UsageDDL 还会与 git show 的输出逐字节对拍）；
//	② 塞入跨**北京月边界**前后的存量数据（2026-08 是 0039 唯一预建的月分区）；
//	③ 应用 0039..HEAD 的**全部**剩余迁移；
//	④ 断言：不报错 / relkind=p / 行与值一字不丢且落在正确的月分区 /
//	   账本结果成立（真跑一次 RebuildUsageLedger）/ 序列已复位 / 幂等可重放。
//
// 变异验证（2026-09-23 实跑）：把 §0 的转换分支拆掉（`IF v_relkind IS NULL OR
// v_relkind = 'p' THEN RETURN;` 改成无条件 `RETURN;`）⇒ 本用例在这里红，
// 报 `migration 0039 ... ERROR: "usage" is not partitioned (SQLSTATE 42P17)`。
func TestMigration0039ConvertsLegacyPlainUsage(t *testing.T) {
	legacyDDL := legacyV240UsageDDL(t)

	all := migrationsFor()
	var pre, post []migration
	var migration39 migration
	for _, m := range all {
		switch {
		case m.version == 4:
			// 关键：把 0004 换回 v2.4.0 的**普通表**正文（就是当年建库用的那份）
			m.name = "0004_usage.sql(v2.4.0 普通表形态)"
			m.sql = legacyDDL
			pre = append(pre, m)
		case m.version < 39:
			pre = append(pre, m)
		default:
			post = append(post, m)
			if m.version == 39 {
				migration39 = m
			}
		}
	}
	if migration39.version != 39 {
		t.Fatalf("找不到 0039 迁移（got %d 条 post）", len(post))
	}
	if len(pre) == 0 {
		t.Fatal("找不到 0038 之前的迁移")
	}

	db, cleanup := newVersionedTestDB(t, pre)
	defer cleanup()

	// --- ① 前置条件：这确实是"升级前"的库（usage 是普通表、没有分区子表） ---
	if got := relationKind(t, db, "usage"); got != "r" {
		t.Fatalf("前置条件失败：0001..0038 + v2.4.0 的 0004 之后 usage 应是普通表(r)，实得 %q", got)
	}
	if got := usageMonthPartitions(t, db); len(got) != 0 {
		t.Fatalf("前置条件失败：升级前不该有任何 usage_YYYYMM 分区，实得 %v", got)
	}
	// 老表列集也断言一次：本用例插入的行依赖这些列都存在（0020/0022/0030 加的）
	for _, col := range []string{"kind", "cost", "cache_prompt_tokens"} {
		if !columnExists(t, db, "usage", col) {
			t.Fatalf("前置条件失败：存量 usage 应有列 %s（0020/0022/0030 之后）", col)
		}
	}

	// --- ② 存量数据：北京月边界前后 + 跨年边界 ---
	// 北京月 = 绝对瞬时 [月初 00:00+08, 下月初 00:00+08)，见 beijing.go 的口径；
	// 2026-08 的边界瞬时就是 2026-07-31T16:00:00Z 与 2026-08-31T16:00:00Z。
	type legacyRow struct {
		id          int64
		model       string
		prompt      int64
		completion  int64
		kind        string
		cost        float64
		cachePrompt int64
		createdAt   string // 绝对瞬时（UTC）
		wantPart    string
		wantBeijing string // 北京墙钟（仅用于失败信息）
		description string
	}
	rows := []legacyRow{
		{101, "m-chat", 11, 22, "chat", 0.0011, 33, "2026-07-31T15:59:59Z", "usage_202607", "2026-07-31 23:59:59", "北京 7 月最后一秒"},
		{102, "m-chat", 12, 23, "search", 0.0012, 34, "2026-07-31T16:00:00Z", "usage_202608", "2026-08-01 00:00:00", "北京 8 月第一秒（下边界整点）"},
		{103, "m-embed", 13, 0, "embedding", 0.0013, 0, "2026-08-15T03:04:05Z", "usage_202608", "2026-08-15 11:04:05", "月中普通一行"},
		{104, "m-chat", 14, 24, "chat", 0.0014, 35, "2026-08-31T15:59:59Z", "usage_202608", "2026-08-31 23:59:59", "北京 8 月最后一秒"},
		{105, "m-chat", 15, 25, "chat", 0.0015, 36, "2026-08-31T16:00:00Z", "usage_202609", "2026-09-01 00:00:00", "北京 9 月第一秒（上边界整点）"},
		{106, "m-chat", 16, 26, "search", 0.0016, 37, "2026-09-23T00:00:00Z", "usage_202609", "2026-09-23 08:00:00", "9 月中普通一行"},
		{107, "m-chat", 17, 27, "chat", 0.0017, 38, "2025-12-31T20:00:00Z", "usage_202601", "2026-01-01 04:00:00", "跨年：北京 2026-01-01"},
	}
	if _, err := db.Exec(`INSERT INTO users (username, password_hash) VALUES ('legacy-user', 'x')`); err != nil {
		t.Fatalf("插入存量用户: %v", err)
	}
	var userID int64
	if err := db.QueryRow(`SELECT id FROM users WHERE username = 'legacy-user'`).Scan(&userID); err != nil {
		t.Fatalf("读存量用户 id: %v", err)
	}
	for _, r := range rows {
		if _, err := db.Exec(`INSERT INTO usage
			(id, user_id, model, prompt_tokens, completion_tokens, created_at, kind, cost, cache_prompt_tokens)
			VALUES (?, ?, ?, ?, ?, ?::timestamptz, ?, ?, ?)`,
			r.id, userID, r.model, r.prompt, r.completion, r.createdAt, r.kind, r.cost, r.cachePrompt); err != nil {
			t.Fatalf("插入存量 usage 行 %d（%s）: %v", r.id, r.description, err)
		}
	}

	// --- ③ 升级：跑到 HEAD 的全部迁移 ---
	testMigrationHook = func() []migration { return post }
	t.Cleanup(func() { testMigrationHook = nil })
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("从 v2.4.0 形状（普通表 usage）升级到 HEAD 失败 —— 这正是 P0 崩溃循环的形态: %v", err)
	}

	// --- ④ 形状：usage 必须是分区表，且老表已清干净 ---
	if got := relationKind(t, db, "usage"); got != "p" {
		t.Fatalf("升级后 usage 的 relkind = %q，期望 p（分区表）", got)
	}
	if tableExists(t, db, "usage_legacy") {
		t.Fatal("升级后 usage_legacy 必须已被丢弃（数据已在 §4 自检后搬入分区表）")
	}
	var legacyLeft int
	if err := db.QueryRow(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relname LIKE 'legacy\_%'`).Scan(&legacyLeft); err != nil {
		t.Fatalf("统计 legacy_* 残留对象: %v", err)
	}
	if legacyLeft != 0 {
		t.Fatalf("让位时改名的 legacy_* 索引/序列必须随老表一起消失，实得 %d 个", legacyLeft)
	}

	// --- ⑤ 行与值一字不丢，且落在正确的**北京月**分区 ---
	for _, r := range rows {
		var (
			gotModel, gotKind, gotPart   string
			gotPrompt, gotComp, gotCache int64
			gotCost                      float64
			gotCreated                   time.Time
		)
		err := db.QueryRow(`SELECT model, kind, tableoid::regclass::text, prompt_tokens,
			completion_tokens, cache_prompt_tokens, cost, created_at FROM usage WHERE id = ?`, r.id).
			Scan(&gotModel, &gotKind, &gotPart, &gotPrompt, &gotComp, &gotCache, &gotCost, &gotCreated)
		if err != nil {
			t.Fatalf("存量行 %d（%s）在升级后读不回来: %v", r.id, r.description, err)
		}
		if gotModel != r.model || gotKind != r.kind || gotPrompt != r.prompt || gotComp != r.completion ||
			gotCache != r.cachePrompt || gotCost != r.cost {
			t.Errorf("存量行 %d 的值被改写: got (model=%q kind=%q prompt=%d completion=%d cache=%d cost=%v), want (%q %q %d %d %d %v)",
				r.id, gotModel, gotKind, gotPrompt, gotComp, gotCache, gotCost,
				r.model, r.kind, r.prompt, r.completion, r.cachePrompt, r.cost)
		}
		if want := mustParseInstant(t, r.createdAt); !gotCreated.Equal(want) {
			t.Errorf("存量行 %d 的 created_at 被改写: got %s, want %s", r.id, gotCreated.UTC(), want.UTC())
		}
		if gotPart != r.wantPart {
			t.Errorf("存量行 %d（%s，北京墙钟 %s）落在 %s，期望 %s —— 月分区边界必须与运行期 BeijingMonth 口径一致",
				r.id, r.description, r.wantBeijing, gotPart, r.wantPart)
		}
	}
	var total int64
	if err := db.QueryRow(`SELECT count(*) FROM usage`).Scan(&total); err != nil {
		t.Fatalf("统计升级后行数: %v", err)
	}
	if total != int64(len(rows)) {
		t.Fatalf("升级后 usage 行数 = %d，期望 %d（既不能丢，也不该凭空多）", total, len(rows))
	}
	// 分区集合必须恰好是老数据涉及的月份（0039 自建 202608 + 转换按数据月补的）
	wantParts := []string{"usage_202601", "usage_202607", "usage_202608", "usage_202609"}
	if got := usageMonthPartitions(t, db); !reflect.DeepEqual(got, wantParts) {
		t.Fatalf("月分区集合 = %v，期望 %v", got, wantParts)
	}

	// --- ⑥ 账本结果成立：形状 + 用搬过来的明细真跑一次重算 ---
	if got := relationKind(t, db, "usage_daily"); got != "p" {
		t.Fatalf("usage_daily relkind = %q，期望 p（按年分区）", got)
	}
	if got := relationKind(t, db, "usage_monthly"); got != "r" {
		t.Fatalf("usage_monthly relkind = %q，期望 r（普通表）", got)
	}
	if !tableExists(t, db, "usage_daily_2026") {
		t.Fatal("usage_daily_2026 年分区必须存在（0039 建的）")
	}
	from := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	// 这一步同时是**运行期探测的验收**：RebuildUsageLedger 会对窗口内每个月调用
	// ensureUsagePartition，而它会校验既有分区边界是否**覆盖**运行期期望的北京月
	// 窗口（partitions.go:verifyPartitionBound）—— 转换出来的边界只要偏了 8 小时，
	// 这里就会红（而不是等到生产环境每月最后 8 小时计量写入失败）。
	if err := RebuildUsageLedger(db, from, to); err != nil {
		t.Fatalf("对迁移后的明细重算账本失败（分区边界或数据形态不被运行期接受）: %v", err)
	}
	var dailyRequests, monthlyRequests int64
	if err := db.QueryRow(`SELECT COALESCE(SUM(requests), 0) FROM usage_daily`).Scan(&dailyRequests); err != nil {
		t.Fatalf("读日账: %v", err)
	}
	if dailyRequests != int64(len(rows)) {
		t.Fatalf("日账 requests 合计 = %d，期望 %d（明细一行不少地进日账）", dailyRequests, len(rows))
	}
	if err := db.QueryRow(`SELECT COALESCE(SUM(requests), 0) FROM usage_monthly
		WHERE month >= '2026-01-01' AND month < '2026-10-01'`).Scan(&monthlyRequests); err != nil {
		t.Fatalf("读月账: %v", err)
	}
	if monthlyRequests != dailyRequests {
		t.Fatalf("月账 requests 合计 = %d，与日账 %d 不一致（账本三层必须自洽）", monthlyRequests, dailyRequests)
	}

	// --- ⑦ 序列已复位：紧接着的 INSERT 必须拿到 max(id)+1（不 setval 会撞 23505） ---
	var newID int64
	if err := db.QueryRow(`INSERT INTO usage (user_id, model, created_at)
		VALUES (?, ?, ?::timestamptz) RETURNING id`, userID, "m-new", "2026-09-23T01:00:00Z").Scan(&newID); err != nil {
		t.Fatalf("转换后写入新行失败（分区未就位 / 序列未复位）: %v", err)
	}
	if want := rows[len(rows)-1].id + 1; newID < want {
		t.Fatalf("新行 id = %d，期望 >= %d（转换必须 setval 到老表 max(id)+1）", newID, want)
	}

	// --- ⑧ 幂等：重放 0039 全文，不得报错、不得改变库内状态 ---
	before := snapshotUsageState(t, db)
	if _, err := db.Exec(migration39.sql); err != nil {
		t.Fatalf("重放 0039（幂等要求可重放）: %v", err)
	}
	if after := snapshotUsageState(t, db); !reflect.DeepEqual(before, after) {
		t.Fatalf("重放 0039 改变了库内状态\n before=%v\n after =%v", before, after)
	}
}

// legacyV240UsageDDL 返回 v2.4.0 的 `0004_usage.sql` 正文（普通表形态）。
//
// 正文是 `testdata/legacy_0004_usage_v240.sql` 的逐字节副本；这里再做一次
// **来源对拍**：只要当前是 git 工作树且 `v2.4.0` 可达，就必须与
// `git show v2.4.0:server/internal/serverstore/migrations-pg/0004_usage.sql`
// 的输出逐字节一致。为什么不让用例每次直接跑 git show：导出包（tarball/浅克隆）
// 里没有 tag，用例会变成环境相关；而夹具若被谁"顺手"改成 HEAD 的分区表版本，
// 这个用例就退化成"自证"（用它自己那版 DDL 建库、再断言能升级），来源对拍是
// 唯一能拦住这种退化的判据。
func legacyV240UsageDDL(t *testing.T) string {
	t.Helper()
	const fixture = "testdata/legacy_0004_usage_v240.sql"
	raw, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("读存量 DDL 夹具 %s: %v", fixture, err)
	}
	if !strings.Contains(string(raw), "CREATE TABLE usage") {
		t.Fatalf("夹具 %s 不是 0004_usage.sql 的正文", fixture)
	}
	if strings.Contains(string(raw), "PARTITION BY") {
		t.Fatalf("夹具 %s 必须是**普通表**形态（v2.4.0 的 0004）；含 PARTITION BY 说明它被换成了 HEAD 版本，本用例会退化成自证", fixture)
	}
	const ref = "v2.4.0:server/internal/serverstore/migrations-pg/0004_usage.sql"
	if _, err := exec.LookPath("git"); err != nil {
		t.Logf("跳过 DDL 来源对拍：本机没有 git（%v）", err)
		return string(raw)
	}
	out, err := exec.Command("git", "show", ref).Output()
	if err != nil {
		// 浅克隆/导出包/无该 tag：对拍不可用，但不影响用例本身（夹具仍是 git show 的副本）
		t.Logf("跳过 DDL 来源对拍：git show %s 不可用（%v）", ref, err)
		return string(raw)
	}
	if !bytes.Equal(out, raw) {
		t.Fatalf("存量 DDL 夹具与 git show %s 不一致（夹具被改动过？）\n--- git show ---\n%s\n--- 夹具 ---\n%s",
			ref, out, raw)
	}
	return string(raw)
}

// newVersionedTestDB 建一个"只跑到某版本"的临时库（迁移集合由调用方给定）。
// 与 newTestDB 的唯一区别：**不预建分区** —— 造 0039 的存量库时 usage 是普通表，
// ensureTestPartitions 会在它上面报 `"usage" is not partitioned`（那正是本 P0 的
// 报错形态，不能用来造库）。0054/0055 的回归（migration_0054_0055_test.go）复用本
// helper 造"回填前"的库。
func newVersionedTestDB(t *testing.T, ms []migration) (*sql.DB, func()) {
	t.Helper()
	resetTestCaches()
	dsn := PgTestDSN()
	admin := requireTestPG(t, dsn)
	u, err := url.Parse(dsn)
	if err != nil {
		admin.Close()
		t.Fatalf("parse test dsn: %v", err)
	}
	name := "picoaide_test_" + randomSuffix(6)
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		admin.Close()
		t.Fatalf("创建临时库 %s: %v", name, err)
	}
	u.Path = "/" + name
	db, err := Open(DBConfig{Driver: DriverPG, DSN: u.String()})
	if err != nil {
		admin.Close()
		t.Fatalf("连接临时库 %s: %v", name, err)
	}
	testMigrationHook = func() []migration { return ms }
	err = ApplyMigrations(db)
	testMigrationHook = nil
	if err != nil {
		db.Close()
		admin.Close()
		t.Fatalf("建存量库（应用 %d 条早期迁移）: %v", len(ms), err)
	}
	cleanup := func() {
		testMigrationHook = nil
		db.Close()
		if _, err := admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)"); err != nil {
			t.Logf("drop test db %s: %v", name, err)
		}
		admin.Close()
	}
	return db, cleanup
}

// ---- 0039 用例的小工具 ----

// relationKind 返回 public.<name> 的 pg_class.relkind（r=普通表 p=分区表 …）；
// 不存在返回空串。
func relationKind(t *testing.T, db *sql.DB, name string) string {
	t.Helper()
	var kind sql.NullString
	if err := db.QueryRow(`SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relname = ?`, name).Scan(&kind); err != nil {
		if err == sql.ErrNoRows {
			return ""
		}
		t.Fatalf("查 %s 的 relkind: %v", name, err)
	}
	return kind.String
}

// usageMonthPartitions 返回 usage 的月分区名（升序），用于断言"恰好这些月"。
func usageMonthPartitions(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT c.relname FROM pg_class c
		JOIN pg_inherits i ON i.inhrelid = c.oid
		JOIN pg_class p ON p.oid = i.inhparent
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND p.relname = 'usage' AND c.relname ~ '^usage_[0-9]{6}$'
		ORDER BY c.relname`)
	if err != nil {
		t.Fatalf("列 usage 月分区: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// snapshotUsageState 抓一份"重放 0039 不该改变"的状态快照。
func snapshotUsageState(t *testing.T, db *sql.DB) string {
	t.Helper()
	var rows int64
	if err := db.QueryRow(`SELECT count(*) FROM usage`).Scan(&rows); err != nil {
		t.Fatalf("快照 usage 行数: %v", err)
	}
	return fmt.Sprintf("rows=%d parts=%v kind=%s daily=%s monthly=%s legacy=%v",
		rows, usageMonthPartitions(t, db), relationKind(t, db, "usage"),
		relationKind(t, db, "usage_daily"), relationKind(t, db, "usage_monthly"),
		tableExists(t, db, "usage_legacy"))
}

func mustParseInstant(t *testing.T, iso string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		t.Fatalf("测试夹具时间 %q 不是 RFC3339: %v", iso, err)
	}
	return ts
}

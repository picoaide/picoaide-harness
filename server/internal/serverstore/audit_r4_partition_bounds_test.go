package serverstore

import (
	"database/sql"
	"net/url"
	"strings"
	"testing"
	"time"
)

// N4(2026-09-13 第三轮独立复核 §2.2 / 清单 N4,P2):分区探测只看 relispartition,
// 不校验 relpartbound 边界。
//
// 缺陷形态:历史/手工 DDL 建出的**错界真分区**(例如按 UTC 自然月建
//
//	CREATE TABLE usage_203701 PARTITION OF usage
//	  FOR VALUES FROM ('2037-01-01 00:00:00+00') TO ('2037-02-01 00:00:00+00');
//
// 而写入路径的期望区间是**北京月** 2036-12-31T16:00Z .. 2037-01-31T16:00Z)
// 会被 ensureRangePartition 判为「已就绪」→ 每月最后 8 小时的计费写入落到
// 该分区的窗口外 → `no partition of relation "usage" found for row`(23514),
// R3 之后表现为 503 METERING_FAILED,而且**永不自愈**(探测永远认为已就绪)。
//
// 修法:ensureRangePartition 在 relispartition 之外校验 pg_get_expr(relpartbound)
// 的 FROM/TO 是否与 spec 期望区间语义相等;不匹配 → fail-loud 并把「人工处置」
// 写进错误消息(**绝不自动 DROP 别人的表**)。
//
// 本文件的三条不变量:
//  1. 错界真分区 → 报错(修复前返回 nil = 红);
//  2. 报错必须到达真写路径(不是只在探测里拦一下),且不再是插入期 23514;
//  3. 正常分区 / 孤儿表 / 并发语义**不变**(不得误伤)。
//
// 全部走真 PG + 真 DDL(不 mock catalog)。

// r4MonthAt 返回落在目标北京月内的瞬时(月中正午,避免时区擦边)。
func r4MonthAt(year int, month time.Month) time.Time {
	return time.Date(year, month, 15, 4, 0, 0, 0, time.UTC)
}

// r4ProbeRelation 直接读 catalog:存在性 / 是否真分区 / 边界表达式原文。
func r4ProbeRelation(t *testing.T, db *sql.DB, rel string) (exists, isPartition bool, bound string) {
	t.Helper()
	var isp sql.NullBool
	var b sql.NullString
	err := db.QueryRow(`SELECT c.relispartition, pg_get_expr(c.relpartbound, c.oid)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = $1 AND n.nspname = 'public'`, rel).Scan(&isp, &b)
	if err == sql.ErrNoRows {
		return false, false, ""
	}
	if err != nil {
		t.Fatalf("probe %s: %v", rel, err)
	}
	return true, isp.Valid && isp.Bool, b.String
}

// TestEnsureUsagePartitionRejectsMisboundedPartition:月分区错界必须 fail-loud。
func TestEnsureUsagePartitionRejectsMisboundedPartition(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	const rel = "usage_203701"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	// 复刻复核报告的最小复现:UTC 自然月的错界真分区(与北京月差 8 小时)。
	// 边界显式带 +00 偏移 —— 裸日期字面量按 PG 会话时区解析,在 Asia/Shanghai
	// 会话里恰好等于北京月(复核报告用 `SET TIME ZONE 'UTC'` + 裸日期,本夹具
	// 改用会话时区无关的写法)。
	if _, err := db.Exec(`CREATE TABLE ` + rel +
		` PARTITION OF usage FOR VALUES FROM ('2037-01-01 00:00:00+00') TO ('2037-02-01 00:00:00+00')`); err != nil {
		t.Fatalf("构造错界分区: %v", err)
	}
	_, isp, before := r4ProbeRelation(t, db, rel)
	if !isp {
		t.Fatalf("%s 不是分区,夹具无效", rel)
	}

	err := ensureUsagePartition(db, r4MonthAt(2037, time.January))
	if err == nil {
		t.Fatalf("错界分区被判为「已就绪」(修复前行为): ensureUsagePartition = nil, 实际边界=%s", before)
	}
	msg := err.Error()
	if !strings.Contains(msg, rel) {
		t.Errorf("错误消息必须点名分区关系: %v", err)
	}
	if !strings.Contains(msg, before) {
		t.Errorf("错误消息必须回显实际边界(%s): %v", before, err)
	}
	if !strings.Contains(strings.ToLower(msg), "manual") {
		t.Errorf("错误消息必须要求人工处置(不得自动 DROP): %v", err)
	}

	// 不自动 DROP:错界分区必须原样活着(表可能是别人手工建的业务数据)。
	exists, stillPartition, after := r4ProbeRelation(t, db, rel)
	if !exists || !stillPartition {
		t.Fatalf("错界分区被自动删除/摘除: exists=%v isPartition=%v", exists, stillPartition)
	}
	if after != before {
		t.Fatalf("错界分区边界被改写: %q → %q", before, after)
	}
}

// TestEnsureUsagePartitionMisboundFailsWritePath:错界窗口的**真写路径**必须
// fail-loud —— 修复前是插入期 23514(no partition found),现在是探测期的
// 可处置错误;并且不得落任何计费行(零落账 = fail-closed)。
func TestEnsureUsagePartitionMisboundFailsWritePath(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	const rel = "usage_203702"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + rel +
		` PARTITION OF usage FOR VALUES FROM ('2037-02-01 00:00:00+00') TO ('2037-03-01 00:00:00+00')`); err != nil {
		t.Fatalf("构造错界分区: %v", err)
	}
	uid, err := CreateUser(db, &User{Username: "r4-misbound-writer", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}

	// 2037-01-31T17:00Z = 北京 2037-02-01 01:00:落在北京月窗口内,却落在错界
	// 分区(UTC 自然月 2037-02-01T00:00Z 起)之外 —— 复核报告的最小复现窗口。
	at := time.Date(2037, time.January, 31, 17, 0, 0, 0, time.UTC)
	_, err = recordUsageKindAt(db, uid, "model-x", 10, 10, "chat", at)
	if err == nil {
		t.Fatal("错界窗口写入竟然成功(修复前报 23514,修复后必须报可处置的探测错误)")
	}
	if strings.Contains(err.Error(), "23514") || strings.Contains(err.Error(), "no partition of relation") {
		t.Fatalf("仍是插入期分区缺失(探测没有拦住): %v", err)
	}
	if !strings.Contains(err.Error(), "ensure usage partition") {
		t.Fatalf("错误必须来自分区探测(写路径 fail-closed): %v", err)
	}
	var lines int
	if err := db.QueryRow(`SELECT count(*) FROM usage WHERE created_at >= '2037-01-31 16:00:00+00' AND created_at < '2037-02-28 16:00:00+00'`).Scan(&lines); err != nil {
		t.Fatalf("统计 usage 行: %v", err)
	}
	if lines != 0 {
		t.Fatalf("错界窗口落账 %d 行(应零落账)", lines)
	}
}

// TestEnsureUsageDailyPartitionRejectsMisboundedPartition:年日账分区(day DATE)
// 错界同样必须 fail-loud —— 两条路径共用 ensureRangePartition,不允许再分叉。
func TestEnsureUsageDailyPartitionRejectsMisboundedPartition(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	const rel = "usage_daily_2031"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + rel +
		` PARTITION OF usage_daily FOR VALUES FROM ('2031-06-01') TO ('2032-06-01')`); err != nil {
		t.Fatalf("构造错界年分区: %v", err)
	}
	_, isp, before := r4ProbeRelation(t, db, rel)
	if !isp {
		t.Fatalf("%s 不是分区,夹具无效", rel)
	}

	err := ensureUsageDailyPartition(db, time.Date(2031, time.January, 1, 0, 0, 0, 0, time.UTC))
	if err == nil {
		t.Fatalf("错界年分区被判为「已就绪」: nil, 实际边界=%s", before)
	}
	if !strings.Contains(err.Error(), rel) || !strings.Contains(err.Error(), before) {
		t.Errorf("年分区错界错误必须点名关系与边界: %v", err)
	}
	// 走真账本路径也必须失败(不是只在 helper 单测里)。
	if err := RebuildUsageLedger(db,
		time.Date(2031, time.June, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2031, time.June, 2, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Error("RebuildUsageLedger 未把错界年分区暴露出来")
	}
	exists, stillPartition, after := r4ProbeRelation(t, db, rel)
	if !exists || !stillPartition || after != before {
		t.Fatalf("错界年分区被自动处置: exists=%v isPartition=%v before=%q after=%q",
			exists, stillPartition, before, after)
	}
}

// TestEnsureUsagePartitionRejectsForeignKeyedPartition:同名关系挂在**别的**
// 分区父表下(边界可以完全一致)同样不算「已就绪」—— 写路径不会路由到它。
// 反向核查产物:只比边界不看父表会漏掉这条。
func TestEnsureUsagePartitionRejectsForeignKeyedPartition(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	const rel = "usage_203707"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	// 另一个与 usage 同形(timestamptz 分区键)的父表:边界故意与期望的北京月
	// 2037-07 一字不差(2037-06-30T16:00Z .. 2037-07-31T16:00Z)。
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS usage_probe_parent (month timestamptz NOT NULL) PARTITION BY RANGE (month)`); err != nil {
		t.Fatalf("构造干扰父表: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + rel +
		` PARTITION OF usage_probe_parent FOR VALUES FROM ('2037-06-30 16:00:00+00') TO ('2037-07-31 16:00:00+00')`); err != nil {
		t.Fatalf("构造异父分区: %v", err)
	}
	_, isp, bound := r4ProbeRelation(t, db, rel)
	if !isp {
		t.Fatalf("%s 不是分区,夹具无效", rel)
	}
	err := ensureUsagePartition(db, r4MonthAt(2037, time.July))
	if err == nil {
		t.Fatalf("异父分区(边界 %s 恰好一致)被判为「已就绪」", bound)
	}
	if !strings.Contains(err.Error(), "usage_probe_parent") {
		t.Errorf("错误消息必须点名实际父表: %v", err)
	}
	// 不自动处置。
	exists, stillPartition, after := r4ProbeRelation(t, db, rel)
	if !exists || !stillPartition || after != bound {
		t.Fatalf("异父分区被自动处置: exists=%v isPartition=%v after=%q", exists, stillPartition, after)
	}
}

// TestEnsureRangePartitionHealthySemanticsUnchanged:收紧边界校验不得误伤
// 正常路径 —— 新建分区 / 幂等复检 / 真写入 / 孤儿表语义全部保持。
func TestEnsureRangePartitionHealthySemanticsUnchanged(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// ① 新建月分区(窗口外):建出真分区,边界覆盖期望区间,幂等。
	month := BeijingMonth(time.Now()).AddDate(0, 18, 0)
	rel := "usage_" + monthKey(month)
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	if err := ensureUsagePartition(db, month); err != nil {
		t.Fatalf("正常月分区新建失败: %v", err)
	}
	exists, isp, bound := r4ProbeRelation(t, db, rel)
	if !exists || !isp {
		t.Fatalf("%s 未建成真分区: exists=%v isPartition=%v", rel, exists, isp)
	}
	from := pgInstantArg(BeijingDayInstant(month))
	to := pgInstantArg(BeijingDayInstant(month.AddDate(0, 1, 0)))
	if !r4BoundCovers(t, db, rel, from, to) {
		t.Fatalf("新建分区边界未覆盖期望区间: %s", bound)
	}
	if err := ensureUsagePartition(db, month); err != nil {
		t.Fatalf("幂等复检失败(同一正确分区第二次探测报错): %v", err)
	}

	// ② 真写入:该月分区必须真的承载业务写入(新建 + 复检之后)。
	uid, err := CreateUser(db, &User{Username: "r4-partition-writer", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	at := time.Date(month.Year(), month.Month(), 15, 4, 0, 0, 0, time.UTC)
	if _, err := recordUsageKindAt(db, uid, "model-x", 7, 3, "chat", at); err != nil {
		t.Fatalf("正常分区写入失败: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM usage WHERE user_id = $1`, uid).Scan(&n); err != nil {
		t.Fatalf("统计写入: %v", err)
	}
	if n != 1 {
		t.Fatalf("正常分区写入行数 = %d, want 1", n)
	}

	// ③ 年分区(day DATE):新建 + 幂等 + 真账本写入。
	year := BeijingMonth(time.Now()).AddDate(0, 24, 0)
	relYear := "usage_daily_" + yearKey(year)
	if _, err := db.Exec("DROP TABLE IF EXISTS " + relYear); err != nil {
		t.Fatalf("清理 %s: %v", relYear, err)
	}
	if err := ensureUsageDailyPartition(db, year); err != nil {
		t.Fatalf("正常年分区新建失败: %v", err)
	}
	yearStart := time.Date(year.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	if !r4BoundCovers(t, db, relYear, yearStart.Format("2006-01-02"), yearStart.AddDate(1, 0, 0).Format("2006-01-02")) {
		t.Fatalf("%s 边界未覆盖期望年区间", relYear)
	}
	if err := ensureUsageDailyPartition(db, year); err != nil {
		t.Fatalf("年分区幂等复检失败: %v", err)
	}
	day := time.Date(year.Year(), 3, 3, 0, 0, 0, 0, time.UTC)
	if err := RebuildUsageLedger(db, day, day); err != nil {
		t.Fatalf("年分区真账本写入失败: %v", err)
	}

	// ④ 孤儿表(F11)语义不变:同名非分区表仍然报 stale detached table。
	orphan := "usage_209901"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + orphan); err != nil {
		t.Fatalf("清理孤儿表: %v", err)
	}
	if _, err := db.Exec("CREATE TABLE " + orphan + " (id bigserial primary key)"); err != nil {
		t.Fatalf("构造孤儿表: %v", err)
	}
	err = ensureUsagePartition(db, r4MonthAt(2099, time.January))
	if err == nil || !strings.Contains(err.Error(), "stale detached table") {
		t.Fatalf("孤儿表语义变化: err = %v, want stale detached table", err)
	}
}

// TestEnsurePartitionBoundCheckSessionTimezoneIndependent:边界比对必须与 PG
// 会话时区无关 —— pg_get_expr 按会话 TimeZone 渲染边界字面量(UTC 下 +00、
// Asia/Shanghai 下 +08、Asia/Kathmandu 下 +05:45),字符串直比会误判。
func TestEnsurePartitionBoundCheckSessionTimezoneIndependent(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// 正确分区(由 ensure 自己建)与错界分区各一个,分别在不同会话时区下探测。
	good := BeijingMonth(time.Now()).AddDate(0, 20, 0)
	const bad = "usage_209812"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + bad); err != nil {
		t.Fatalf("清理 %s: %v", bad, err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + bad +
		` PARTITION OF usage FOR VALUES FROM ('2098-12-01 00:00:00+00') TO ('2099-01-01 00:00:00+00')`); err != nil {
		t.Fatalf("构造错界分区: %v", err)
	}

	for _, tz := range []string{"UTC", "Asia/Shanghai", "America/New_York", "Asia/Kathmandu"} {
		handle := r4SameDBWithTimezone(t, db, tz)
		if err := ensureUsagePartition(handle, good); err != nil {
			t.Errorf("会话时区 %s:正确分区被误判为错界: %v", tz, err)
		}
		err := ensureUsagePartition(handle, r4MonthAt(2098, time.December))
		if err == nil {
			t.Errorf("会话时区 %s:错界分区(UTC 自然月 2098-12)未报错", tz)
		}
	}
}

// r4SameDBWithTimezone 打开一个指向同一测试库的单连接句柄并固定会话时区
// (SET TIME ZONE 只作用于该连接,句柄限 1 连接即可保证后续探测走同一会话)。
func r4SameDBWithTimezone(t *testing.T, db *sql.DB, tz string) *sql.DB {
	t.Helper()
	var name string
	if err := db.QueryRow("SELECT current_database()").Scan(&name); err != nil {
		t.Fatalf("读库名: %v", err)
	}
	u, err := url.Parse(PgTestDSN())
	if err != nil {
		t.Fatalf("解析测试 DSN: %v", err)
	}
	u.Path = "/" + name
	// 必须走 serverstore.Open(`?`→`$N` 重写层 + 会话时区),裸 sql.Open("pgx")
	// 没有重写层,探测 SQL 的 `?` 占位符会直接语法报错。
	handle, err := Open(DBConfig{Driver: DriverPG, DSN: u.String()})
	if err != nil {
		t.Fatalf("打开同库句柄: %v", err)
	}
	handle.SetMaxOpenConns(1)
	handle.SetMaxIdleConns(1)
	t.Cleanup(func() { handle.Close() })
	if _, err := handle.Exec("SET TIME ZONE '" + tz + "'"); err != nil {
		t.Fatalf("设置会话时区 %s: %v", tz, err)
	}
	var got string
	if err := handle.QueryRow("SELECT current_setting('TimeZone')").Scan(&got); err != nil {
		t.Fatalf("回读会话时区: %v", err)
	}
	if got != tz {
		t.Fatalf("会话时区未生效: got %q want %q", got, tz)
	}
	return handle
}

// r4BoundCovers 语义比对(不依赖会话时区渲染):把 catalog 里的边界字面量与
// 期望字面量都交给 PG 做 timestamptz 归一后比较。夹具自检用(生产实现不允许
// 多一次往返,见 partitions.go)。
func r4BoundCovers(t *testing.T, db *sql.DB, rel, wantFrom, wantTo string) bool {
	t.Helper()
	_, isp, bound := r4ProbeRelation(t, db, rel)
	if !isp {
		t.Fatalf("%s 不是分区", rel)
	}
	gotFrom, gotTo, ok := splitRangeBound(bound)
	if !ok {
		t.Fatalf("%s 边界无法解析: %q", rel, bound)
	}
	var same bool
	if err := db.QueryRow(`SELECT $1::timestamptz = $3::timestamptz AND $2::timestamptz = $4::timestamptz`,
		wantFrom, wantTo, gotFrom, gotTo).Scan(&same); err != nil {
		t.Fatalf("比较边界: %v", err)
	}
	return same
}

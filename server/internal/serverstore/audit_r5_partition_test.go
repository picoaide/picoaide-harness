package serverstore

import (
	"database/sql"
	"net/url"
	"strings"
	"testing"
	"time"
)

// R5(2026-09-13 第五轮独立对抗式复核 §2):分区探测的两个残留缺陷。
//
//  1. **P1 可用性回归**(本轮引入):pg_get_expr(relpartbound) 的渲染受会话
//     DateStyle 影响(German/SQL/Postgres 下 timestamptz 渲染成
//     `01.09.2026 00:00:00 CST`、DATE 渲染成 `01.01.2026`),而边界解析只认
//     ISO ⇒ **正确**的分区被判错界 → ensureUsagePartition 在计量写入热路径
//     报错 → 全站 LLM 请求 503 METERING_FAILED。
//  2. **P2 二级分区漏网**:usage_<key> 手工建成 PARTITION BY RANGE(relkind='p',
//     子分区只覆盖半个窗口)被探测判「已就绪」,写入报 23514 且永不自愈。
//
// 本文件是真 PG 回归:①会话渲染穷举下正确分区仍就绪、错界仍 fail-loud、
// 真写路径不失败;②二级分区 fail-loud 且不再漏网;③「读不懂」与「确实不匹配」
// 是两条不同的错误,且文案不含任何诱导 DROP 正确分区的措辞。

// r5PartitionHandle 打开指向同一测试库、带任意会话设置的独立句柄
// (SET 只作用于该连接;限 1 连接保证后续探测走同一会话)。
func r5PartitionHandle(t *testing.T, db *sql.DB, setup ...string) *sql.DB {
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
	h, err := Open(DBConfig{Driver: DriverPG, DSN: u.String()})
	if err != nil {
		t.Fatalf("打开同库句柄: %v", err)
	}
	h.SetMaxOpenConns(1)
	h.SetMaxIdleConns(1)
	t.Cleanup(func() { h.Close() })
	for _, s := range setup {
		if _, err := h.Exec(s); err != nil {
			t.Fatalf("会话设置 %q: %v", s, err)
		}
	}
	return h
}

// r5RenderedBound 用**该会话**渲染边界原文(证明渲染确实随会话变化)。
func r5RenderedBound(t *testing.T, db *sql.DB, rel string) string {
	t.Helper()
	var b sql.NullString
	err := db.QueryRow(`SELECT pg_get_expr(c.relpartbound, c.oid) FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname='public'`, rel).Scan(&b)
	if err == sql.ErrNoRows {
		return ""
	}
	if err != nil {
		t.Fatalf("渲染 %s 边界: %v", rel, err)
	}
	return b.String
}

// r5SessionRenderSettings:第五轮复核点名的全部会话渲染形态(名称 → 会话设置)。
var r5SessionRenderSettings = []struct {
	name  string
	setup []string
}{
	{"默认(ISO)", nil},
	{"DateStyle=German,DMY", []string{"SET DateStyle='German, DMY'"}},
	{"DateStyle=SQL,DMY", []string{"SET DateStyle='SQL, DMY'"}},
	{"DateStyle=Postgres,MDY", []string{"SET DateStyle='Postgres, MDY'"}},
	{"DateStyle=German + TZ=Asia/Shanghai", []string{"SET DateStyle='German, DMY'", "SET TIME ZONE 'Asia/Shanghai'"}},
	{"TZ=Asia/Kathmandu(+05:45)", []string{"SET TIME ZONE 'Asia/Kathmandu'"}},
	{"TZ=Pacific/Chatham(+12:45)", []string{"SET TIME ZONE 'Pacific/Chatham'"}},
	{"TZ=Etc/GMT+12", []string{"SET TIME ZONE 'Etc/GMT+12'"}},
	{"TZ=America/New_York", []string{"SET TIME ZONE 'America/New_York'"}},
}

// TestR5PartitionProbeDateStyleIndependent:正确分区在任何会话渲染设置下都必须
// 判「就绪」,且真写路径不得失败(修复前:German/SQL/Postgres 三种 DateStyle 下
// 全部误判 + 写路径 503)。
func TestR5PartitionProbeDateStyleIndependent(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	now := time.Now()
	if err := ensureUsagePartition(db, now); err != nil {
		t.Fatalf("建当月分区: %v", err)
	}
	if err := ensureUsageDailyPartition(db, now); err != nil {
		t.Fatalf("建当年日账分区: %v", err)
	}
	monthRel := "usage_" + monthKey(BeijingMonth(now))
	yearRel := "usage_daily_" + yearKey(now)

	rendered := map[string]string{}
	for _, c := range r5SessionRenderSettings {
		h := r5PartitionHandle(t, db, c.setup...)
		rendered[c.name] = r5RenderedBound(t, h, monthRel) + " | " + r5RenderedBound(t, h, yearRel)
		if err := ensureUsagePartition(h, now); err != nil {
			t.Errorf("可用性回归:%s 下正确月分区被判错界: %v", c.name, err)
		}
		if err := ensureUsageDailyPartition(h, now); err != nil {
			t.Errorf("可用性回归:%s 下正确日账分区被判错界: %v", c.name, err)
		}
	}
	// 渲染确实随会话变化(否则本用例是假绿:夹具没有真正踩到 DateStyle)。
	if !strings.Contains(rendered["DateStyle=German,DMY"], "01.") {
		t.Errorf("夹具没有生效:German 会话下边界原文=%q(期望非 ISO 形态)", rendered["DateStyle=German,DMY"])
	}
	if !strings.Contains(rendered["默认(ISO)"], "-") {
		t.Errorf("夹具异常:ISO 会话下边界原文=%q", rendered["默认(ISO)"])
	}
	t.Logf("German 渲染=%q", rendered["DateStyle=German,DMY"])
	t.Logf("ISO    渲染=%q", rendered["默认(ISO)"])

	// 真写路径:非 ISO 会话下计量写入必须成功(修复前 503 METERING_FAILED 的锚点)。
	uid := mustUserID(t, db)
	for _, c := range r5SessionRenderSettings {
		h := r5PartitionHandle(t, db, c.setup...)
		if _, err := RecordUsageKind(h, uid, "r5-model", 1, 1, "chat"); err != nil {
			t.Errorf("可用性回归:%s 下计量写入失败(全站 503 的根因): %v", c.name, err)
		}
	}
}

// TestR5MisboundedStillLoudUnderAnyRendering:错界分区在**任何**会话渲染下都必须
// fail-loud(修复不得把 P1 的可用性修成"什么都放行")。
func TestR5MisboundedStillLoudUnderAnyRendering(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	const rel = "usage_209812"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	// 2098-12 的**期望**窗口是北京月(2098-11-30T16:00Z .. 2098-12-31T16:00Z);
	// 这里按 UTC 自然月建,差 8 小时 ⇒ 确实错界。
	if _, err := db.Exec(`CREATE TABLE ` + rel +
		` PARTITION OF usage FOR VALUES FROM ('2098-12-01 00:00:00+00') TO ('2099-01-01 00:00:00+00')`); err != nil {
		t.Fatalf("构造错界分区: %v", err)
	}
	at := r4MonthAt(2098, time.December)
	for _, c := range r5SessionRenderSettings {
		h := r5PartitionHandle(t, db, c.setup...)
		err := ensureUsagePartition(h, at)
		if err == nil {
			t.Errorf("%s 下错界分区(UTC 自然月)被判已就绪", c.name)
			continue
		}
		if !strings.Contains(err.Error(), "not the expected window") {
			t.Errorf("%s 下错界必须报「确实不匹配」而不是别的失败: %v", c.name, err)
		}
	}
}

// TestR5UnreadableBoundIsNotMismatch:DEFAULT / MAXVALUE / 表达式边界必须报
// **「读不懂」**这一类错误,与「确实不匹配」在文案上可区分 —— 修复前两者
// 共用一条 "its range is not the expected window"(把可能正确的分区判成错界)。
func TestR5UnreadableBoundIsNotMismatch(t *testing.T) {
	cases := []struct {
		name  string
		rel   string
		ddl   string
		month time.Time
	}{
		{"DEFAULT 分区", "usage_209903", `CREATE TABLE usage_209903 PARTITION OF usage DEFAULT`, r4MonthAt(2099, time.March)},
		{"MAXVALUE 上界", "usage_209904", `CREATE TABLE usage_209904 PARTITION OF usage FOR VALUES FROM ('2099-03-31 16:00:00+00') TO (MAXVALUE)`, r4MonthAt(2099, time.April)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			db, cleanup := NewTestDB(t)
			defer cleanup()
			if _, err := db.Exec("DROP TABLE IF EXISTS " + c.rel); err != nil {
				t.Fatalf("清理: %v", err)
			}
			if _, err := db.Exec(c.ddl); err != nil {
				t.Fatalf("构造 %s: %v", c.name, err)
			}
			err := ensureUsagePartition(db, c.month)
			if err == nil {
				t.Fatalf("%s 被判已就绪(无法证明覆盖窗口的关系不得放行)", c.name)
			}
			msg := err.Error()
			if !strings.Contains(msg, "cannot be read back from the catalog") {
				t.Errorf("%s 必须报「读不懂」类错误: %v", c.name, err)
			}
			if strings.Contains(msg, "not the expected window") {
				t.Errorf("%s 被当成「确实错界」(读不懂 ≠ 错界): %v", c.name, err)
			}
			if !strings.Contains(strings.ToLower(msg), "manual") {
				t.Errorf("%s 错误消息必须要求人工处置: %v", c.name, err)
			}
			// 文案纪律:不得给出"DROP 该分区重建"这类行动指引。
			for _, banned := range []string{"DROP 该分区", "drop it manually", "DROP the partition"} {
				if strings.Contains(msg, banned) {
					t.Errorf("%s 错误文案诱导删除分区(%q): %v", c.name, banned, err)
				}
			}
		})
	}
}

// TestR5MisboundedErrorTextHasNoDropAdvice:错界(确实不匹配)的文案同样不得
// 诱导管理员删除一个可能正确的分区(审计 r5 §2 的"放大器":照做会丢整月明细)。
func TestR5MisboundedErrorTextHasNoDropAdvice(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	const rel = "usage_209902"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + rel +
		` PARTITION OF usage FOR VALUES FROM ('2099-02-01 00:00:00+00') TO ('2099-03-01 00:00:00+00')`); err != nil {
		t.Fatalf("构造错界分区: %v", err)
	}
	err := ensureUsagePartition(db, r4MonthAt(2099, time.February))
	if err == nil {
		t.Fatal("错界分区被判已就绪")
	}
	msg := err.Error()
	for _, banned := range []string{"DROP 该分区", "drop it manually", "DROP the partition"} {
		if strings.Contains(msg, banned) {
			t.Errorf("错界文案出现诱导 DROP 的措辞(%q): %v", banned, err)
		}
	}
	if !strings.Contains(msg, "not the expected window") || !strings.Contains(msg, rel) {
		t.Errorf("错界文案必须点名关系与判据: %v", err)
	}
	if !strings.Contains(strings.ToLower(msg), "manual") {
		t.Errorf("错界文案必须要求人工处置: %v", err)
	}
}

// TestR5SubPartitionedRelationRejected:P2 —— usage_<key> 是 usage 的真分区、
// 边界正确,但**自身又是分区父表**(relkind='p')且子分区只覆盖半个窗口。
//
// 修复前:ensure=<nil>(判「已就绪」),真写入 23514 `no partition of relation`;
// 修复后:fail-loud(relkind 判据),且真写路径报的是探测错误而不是 23514。
func TestR5SubPartitionedRelationRejected(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	const rel = "usage_209908"
	for _, stmt := range []string{
		"DROP TABLE IF EXISTS usage_209908_a",
		"DROP TABLE IF EXISTS " + rel,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("清理: %v", err)
		}
	}
	// 边界与期望的北京月 2099-08 完全一致(2099-07-31T16:00Z .. 2099-08-31T16:00Z),
	// 但自身按 created_at 二级分区,子分区只覆盖半个窗口。
	for _, stmt := range []string{
		`CREATE TABLE ` + rel + ` PARTITION OF usage
			FOR VALUES FROM ('2099-07-31 16:00:00+00') TO ('2099-08-31 16:00:00+00') PARTITION BY RANGE (created_at)`,
		`CREATE TABLE usage_209908_a PARTITION OF ` + rel + `
			FOR VALUES FROM ('2099-07-31 16:00:00+00') TO ('2099-08-15 00:00:00+00')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("构造二级分区: %v", err)
		}
	}

	var kind string
	if err := db.QueryRow(`SELECT relkind FROM pg_class WHERE relname = $1`, rel).Scan(&kind); err != nil {
		t.Fatalf("读 relkind: %v", err)
	}
	if kind != "p" {
		t.Fatalf("夹具无效:%s 的 relkind=%q,期望 'p'", rel, kind)
	}

	at := r4MonthAt(2099, time.August)
	err := ensureUsagePartition(db, at)
	if err == nil {
		// 复核者观察到的"漏网":探测说就绪,写入才炸 23514。
		uid, uerr := CreateUser(db, &User{Username: "r5-subpart-writer", Source: "local", Status: 1})
		if uerr != nil {
			t.Fatalf("建用户: %v", uerr)
		}
		_, werr := recordUsageKindAt(db, uid, "model-x", 1, 1, "chat", at)
		t.Fatalf("二级分区被判「已就绪」(漏网):真写入 = %v", werr)
	}
	if !strings.Contains(err.Error(), "relkind='p'") {
		t.Errorf("二级分区错误必须点名 relkind 判据: %v", err)
	}
	if !strings.Contains(err.Error(), rel) {
		t.Errorf("错误必须点名关系: %v", err)
	}

	// 真写路径必须 fail-closed 且**不再是** 23514(探测先拦住)。
	uid, uerr := CreateUser(db, &User{Username: "r5-subpart-writer2", Source: "local", Status: 1})
	if uerr != nil {
		t.Fatalf("建用户: %v", uerr)
	}
	_, werr := recordUsageKindAt(db, uid, "model-x", 1, 1, "chat", at)
	if werr == nil {
		t.Fatal("二级分区下计量写入竟然成功")
	}
	if strings.Contains(werr.Error(), "23514") || strings.Contains(werr.Error(), "no partition of relation") {
		t.Errorf("仍是插入期 23514(探测没拦住): %v", werr)
	}
	if !strings.Contains(werr.Error(), "ensure usage partition") {
		t.Errorf("写路径错误必须来自分区探测: %v", werr)
	}
	// 不自动处置。
	var still string
	if err := db.QueryRow(`SELECT relkind FROM pg_class WHERE relname = $1`, rel).Scan(&still); err != nil {
		t.Fatalf("二级分区被自动处置: %v", err)
	}
	if still != "p" {
		t.Fatalf("二级分区被改写: relkind=%q", still)
	}
}

// TestR5LeafPartitionWritesSucceed:反向核查 —— relkind='r' 的正常分区
// (新建 + 复检 + 真写入)不得被新判据误伤。
func TestR5LeafPartitionWritesSucceed(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	month := BeijingMonth(time.Now()).AddDate(0, 30, 0)
	rel := "usage_" + monthKey(month)
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理: %v", err)
	}
	if err := ensureUsagePartition(db, month); err != nil {
		t.Fatalf("新建月分区: %v", err)
	}
	if err := ensureUsagePartition(db, month); err != nil {
		t.Fatalf("幂等复检: %v", err)
	}
	var kind string
	if err := db.QueryRow(`SELECT relkind FROM pg_class WHERE relname = $1`, rel).Scan(&kind); err != nil {
		t.Fatalf("读 relkind: %v", err)
	}
	if kind != "r" {
		t.Fatalf("%s relkind=%q,期望 'r'", rel, kind)
	}
	uid, err := CreateUser(db, &User{Username: "r5-leaf-writer", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	at := time.Date(month.Year(), month.Month(), 15, 4, 0, 0, 0, time.UTC)
	if _, err := recordUsageKindAt(db, uid, "model-x", 3, 2, "chat", at); err != nil {
		t.Fatalf("正常分区写入失败: %v", err)
	}
}

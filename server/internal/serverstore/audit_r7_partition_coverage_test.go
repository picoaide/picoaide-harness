package serverstore

// 审计 r7 分区边界回归(srvbill-3,复核报告 VERIFY-A1-server-billing-store §3)。
//
// R4 给 ensureRangePartition 加的边界校验用了**语义相等**,而它要防的危害是
// 「期望窗口没有被完整覆盖」—— 判据比危害严,就会误伤:一个边界更宽、完整覆盖
// 期望窗口的同名分区(DBA 按季度预建的 usage_<本月>)被判 misboundedPartitionErr,
// 该月**每一次** RecordUsage 都失败 → 网关 503 METERING_FAILED、账本重算同样
// 失败,而且探测永远返回同一个错误(不自愈,只能人工 DDL)。
//
// 修法:判据改成**区间覆盖**(actualFrom <= wantFrom && actualTo >= wantTo),
// 与危害同构;不覆盖(更窄/错位)才 fail-loud,读不懂仍走
// partitionBoundUnreadableErr 分流(不冒充错界)。

import (
	"strings"
	"testing"
	"time"
)

// r7MonthSpec 造一个月明细分区的 spec(与 ensureUsagePartition 同源口径:
// from/to 是显式 UTC 偏移的瞬时字面量)。
func r7MonthSpec(key, from, to string) partitionSpec {
	return partitionSpec{parent: "usage", key: key, from: from, to: to}
}

// TestR7PartitionBoundCoverageNotEquality 直接钉住判据:更宽覆盖 = 就绪,
// 更窄/错位 = 错界,读不懂 = 分流(DATE 与 instant 两类字面量各自比较)。
func TestR7PartitionBoundCoverageNotEquality(t *testing.T) {
	// 期望窗口 = 北京月 2026-09 = [2026-08-31T16:00Z, 2026-09-30T16:00Z)。
	month := r7MonthSpec("202609", "2026-08-31 16:00:00+00", "2026-09-30 16:00:00+00")

	cases := []struct {
		name  string
		spec  partitionSpec
		bound string
		want  string // "ready" | "misbounded" | "unreadable"
	}{
		{
			name:  "完全相等",
			spec:  month,
			bound: `FOR VALUES FROM ('2026-08-31 16:00:00+00:00') TO ('2026-09-30 16:00:00+00:00')`,
			want:  "ready",
		},
		{
			name:  "更宽覆盖(季度分区,北京时区渲染)",
			spec:  month,
			bound: `FOR VALUES FROM ('2026-07-01 00:00:00+08') TO ('2026-10-01 00:00:00+08')`,
			want:  "ready",
		},
		{
			name:  "更宽覆盖(单侧更宽)",
			spec:  month,
			bound: `FOR VALUES FROM ('2026-08-01 00:00:00+08') TO ('2026-09-30 16:00:00+00')`,
			want:  "ready",
		},
		{
			name:  "更窄(下界晚于期望)",
			spec:  month,
			bound: `FOR VALUES FROM ('2026-09-02 00:00:00+08') TO ('2026-09-30 16:00:00+00')`,
			want:  "misbounded",
		},
		{
			name:  "更窄(上界早于期望)",
			spec:  month,
			bound: `FOR VALUES FROM ('2026-08-31 16:00:00+00') TO ('2026-09-15 00:00:00+08')`,
			want:  "misbounded",
		},
		{
			name:  "错位(UTC 自然月)",
			spec:  month,
			bound: `FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00')`,
			want:  "misbounded",
		},
		{
			name:  "错位(整体平移一个月)",
			spec:  month,
			bound: `FOR VALUES FROM ('2026-07-31 16:00:00+00') TO ('2026-08-31 16:00:00+00')`,
			want:  "misbounded",
		},
		{
			name:  "读不懂(MAXVALUE)",
			spec:  month,
			bound: `FOR VALUES FROM ('2026-08-31 16:00:00+00') TO (MAXVALUE)`,
			want:  "unreadable",
		},
		{
			name:  "读不懂(DEFAULT)",
			spec:  month,
			bound: `DEFAULT`,
			want:  "unreadable",
		},
	}

	// DATE 类字面量(usage_daily 的年分区)走同一判据。
	year := partitionSpec{parent: "usage_daily", key: "2031", from: "2031-01-01", to: "2032-01-01"}
	cases = append(cases,
		struct {
			name  string
			spec  partitionSpec
			bound string
			want  string
		}{"DATE 相等", year, `FOR VALUES FROM ('2031-01-01') TO ('2032-01-01')`, "ready"},
		struct {
			name  string
			spec  partitionSpec
			bound string
			want  string
		}{"DATE 更宽覆盖", year, `FOR VALUES FROM ('2030-06-01') TO ('2032-06-01')`, "ready"},
		struct {
			name  string
			spec  partitionSpec
			bound string
			want  string
		}{"DATE 更窄", year, `FOR VALUES FROM ('2031-06-01') TO ('2032-01-01')`, "misbounded"},
		struct {
			name  string
			spec  partitionSpec
			bound string
			want  string
		}{"DATE 错位", year, `FOR VALUES FROM ('2031-07-01') TO ('2032-07-01')`, "misbounded"},
	)

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := verifyPartitionBound(c.spec, c.bound)
			switch c.want {
			case "ready":
				if err != nil {
					t.Fatalf("覆盖期望窗口的分区被判故障(判据必须与危害同构): %v", err)
				}
			case "misbounded":
				if err == nil {
					t.Fatalf("不覆盖期望窗口的分区被判就绪(窗口边缘的写入会 23514): %s", c.bound)
				}
				if !strings.Contains(err.Error(), "not the expected window") {
					t.Fatalf("不覆盖必须报「确实错界」: %v", err)
				}
			case "unreadable":
				if err == nil {
					t.Fatalf("读不懂的边界被判就绪: %s", c.bound)
				}
				if !strings.Contains(err.Error(), "cannot be read back from the catalog") {
					t.Fatalf("读不懂 ≠ 错界(不得冒充错界): %v", err)
				}
				if strings.Contains(err.Error(), "not the expected window") {
					t.Fatalf("读不懂被当成错界: %v", err)
				}
			}
		})
	}
}

// TestR7SupersetUsagePartitionIsReadyAndRoutesWrites 是真 PG 端到端回归:
// DBA 按季度预建的更宽同名分区必须被接受,且该月计量写入、账本重算全部正常
// (修复前:RecordUsage/RebuildUsageLedger 双双报错、网关 503、不自愈)。
func TestR7SupersetUsagePartitionIsReadyAndRoutesWrites(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// 北京月 2099-05(期望窗口 [2099-04-30T16:00Z, 2099-05-31T16:00Z));
	// 季度分区 [2099-04-01+08, 2099-07-01+08) 严格覆盖它(与审计复现的
	// "季度 vs 北京月"布局同形,只是换到未来月份避免与其它用例互相影响)。
	const rel = "usage_209905"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + rel +
		` PARTITION OF usage FOR VALUES FROM ('2099-04-01 00:00:00+08') TO ('2099-07-01 00:00:00+08')`); err != nil {
		t.Fatalf("构造更宽(季度)分区: %v", err)
	}
	_, isp, before := r4ProbeRelation(t, db, rel)
	if !isp {
		t.Fatalf("%s 不是分区,夹具无效", rel)
	}
	t.Logf("季度分区实际边界: %s", before)

	at := time.Date(2099, time.May, 15, 4, 0, 0, 0, time.UTC) // 北京 2099-05-15 12:00
	if err := ensureUsagePartition(db, at); err != nil {
		t.Fatalf("完整覆盖期望窗口的同名分区被判错界(整月计量 503 的根因): %v", err)
	}

	// 真写路径:该月计量必须能落进去(而不是只在探测里放行)。
	uid, err := CreateUser(db, &User{Username: "r7-superset-writer", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	if _, err := recordUsageKindAt(db, uid, "r7-model", 10, 10, "chat", at); err != nil {
		t.Fatalf("更宽分区下的计量写入失败: %v", err)
	}
	var routed int
	if err := db.QueryRow(`SELECT count(*) FROM ` + rel).Scan(&routed); err != nil {
		t.Fatalf("统计 %s: %v", rel, err)
	}
	if routed != 1 {
		t.Fatalf("写入没有路由到该季度分区: rows=%d, want 1", routed)
	}
	// 账本重算(日/月账)也必须恢复正常 —— 审计复现里它同样被拦。
	if err := RebuildUsageLedger(db, at, at); err != nil {
		t.Fatalf("RebuildUsageLedger 被更宽分区拦下: %v", err)
	}
	if err := ensureUsagePartition(db, at); err != nil {
		t.Fatalf("幂等复检失败: %v", err)
	}

	// 服务端不得改写/删除别人的分区。
	exists, stillPartition, after := r4ProbeRelation(t, db, rel)
	if !exists || !stillPartition || after != before {
		t.Fatalf("更宽分区被自动处置: exists=%v isPartition=%v before=%q after=%q", exists, stillPartition, before, after)
	}
}

// TestR7NarrowerUsagePartitionStillFailsLoud 是反向锁:放宽成"覆盖"之后,真正
// 有害的**更窄**分区(窗口后段写不进去)必须仍然 fail-loud 且不被自动处置。
func TestR7NarrowerUsagePartitionStillFailsLoud(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	const rel = "usage_209906"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	// 只覆盖北京月 2099-06 的前半段(上界早于期望上界)。
	if _, err := db.Exec(`CREATE TABLE ` + rel +
		` PARTITION OF usage FOR VALUES FROM ('2099-05-31 16:00:00+00') TO ('2099-06-15 00:00:00+00')`); err != nil {
		t.Fatalf("构造更窄分区: %v", err)
	}
	_, isp, before := r4ProbeRelation(t, db, rel)
	if !isp {
		t.Fatalf("%s 不是分区,夹具无效", rel)
	}

	at := time.Date(2099, time.June, 20, 4, 0, 0, 0, time.UTC) // 北京 2099-06-20 12:00
	if err := ensureUsagePartition(db, at); err == nil {
		t.Fatalf("更窄分区被判就绪(窗口后段写入会 23514): %s", before)
	} else if !strings.Contains(err.Error(), "not the expected window") {
		t.Fatalf("更窄分区必须报「确实错界」: %v", err)
	}
	if _, err := recordUsageKindAt(db, mustUserID(t, db), "r7-model", 1, 1, "chat", at); err == nil {
		t.Fatal("更窄分区下的计量写入竟然成功")
	}
	exists, stillPartition, after := r4ProbeRelation(t, db, rel)
	if !exists || !stillPartition || after != before {
		t.Fatalf("更窄分区被自动处置: exists=%v isPartition=%v before=%q after=%q", exists, stillPartition, before, after)
	}
}

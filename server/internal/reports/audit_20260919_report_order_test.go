package reports

import (
	"fmt"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 2026-09-19(服务端审计收尾):报表 TOP 榜排序非全序 / 非确定。
//
// topByCost 原先只有单一判据 `sorted[i].Cost > sorted[j].Cost` + sort.Slice
// (pdqsort)。等值行之间没有任何确定的次序 —— 未定价模型(usage.cost 恒 0)是
// 最常见的一种,用户/部门成本相同同理。pdqsort 只在 len>12 时才走分区重排
// (≤12 退化为插入排序,单判据下恰好"看起来稳定"),所以真实月报里
// 「模型数 > 12 且存在等值」时:
//  1. 等值组的先后顺序与任何判据无关(由 pdqsort 内部交换决定);
//  2. 第 n 名与第 n+1 名等值时,"取前 n"选谁不确定(多一个等值模型就换人)。
//
// 口径与本仓 internal/serverauth/usage_admin.go 的 usageOverview.top_models
// 一致:Cost 仍是唯一主判据、仍取前 n,等值时按 Label 升序。

func auditLabels(rows []serverstore.UsageAggregateRow) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%s(cost=%g)", r.Label, r.Cost))
	}
	return out
}

// TestAudit20260919TopByCostTieBreak 等值行必须按 Label 升序排列,且取前 n 的
// 选择由集合唯一决定(不受输入顺序影响)。
func TestAudit20260919TopByCostTieBreak(t *testing.T) {
	// 15 个未定价模型(成本全 0),标签故意按**降序**构造:稳定排序 + 次级键的
	// 期望输出是 u01..u10;单判据 pdqsort 从标签降序出发会打乱等值组。
	const total, n = 15, 10
	rows := make([]serverstore.UsageAggregateRow, 0, total)
	for i := total; i >= 1; i-- {
		rows = append(rows, serverstore.UsageAggregateRow{
			Label:    fmt.Sprintf("u%02d", i),
			Requests: int64(i),
		})
	}
	got := topByCost(rows, n)
	if len(got) != n {
		t.Fatalf("topByCost 长度 = %d, want %d", len(got), n)
	}
	for i, r := range got {
		want := fmt.Sprintf("u%02d", i+1)
		if r.Label != want {
			t.Fatalf("等值(成本全 0)第 %d 名 = %q, want %q(等值必须按 Label 升序)\n实际顺序 = %v",
				i+1, r.Label, want, auditLabels(got))
		}
	}

	// 输入顺序不得改变输出:全序比较器下"前 n 名"只由集合决定。
	rev := make([]serverstore.UsageAggregateRow, len(rows))
	for i := range rows {
		rev[i] = rows[len(rows)-1-i]
	}
	gotRev := topByCost(rev, n)
	for i := range got {
		if got[i].Label != gotRev[i].Label {
			t.Fatalf("输入顺序改变后结果变化(说明比较器不是全序):\n正序 = %v\n逆序 = %v",
				auditLabels(got), auditLabels(gotRev))
		}
	}
}

// TestAudit20260919TopByCostPrimaryThenLabel 主判据仍是 Cost 降序(回归保护:
// 加次级键不得改动已有口径),等值段内按 Label 升序,取前 n。
func TestAudit20260919TopByCostPrimaryThenLabel(t *testing.T) {
	rows := []serverstore.UsageAggregateRow{
		{Label: "cheap-b", Cost: 0},
		{Label: "price-c", Cost: 3},
		{Label: "cheap-a", Cost: 0},
		{Label: "price-a", Cost: 9},
		{Label: "cheap-d", Cost: 0},
		{Label: "price-b", Cost: 3},
		{Label: "cheap-c", Cost: 0},
	}
	got := auditLabels(topByCost(rows, 6))
	want := []string{"price-a(cost=9)", "price-b(cost=3)", "price-c(cost=3)", "cheap-a(cost=0)", "cheap-b(cost=0)", "cheap-c(cost=0)"}
	if len(got) != len(want) {
		t.Fatalf("topByCost 长度 = %d, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 名 = %s, want %s(完整顺序 %v)", i+1, got[i], want[i], got)
		}
	}
	// n 大于行数:原样返回全部,不 panic
	if all := topByCost(rows, 99); len(all) != len(rows) {
		t.Fatalf("n>len 时长度 = %d, want %d", len(all), len(rows))
	}
	// 不得就地改动调用方切片(旧实现 append 到新切片,语义必须保持)
	if rows[0].Label != "cheap-b" || rows[6].Label != "cheap-c" {
		t.Fatalf("topByCost 改动了入参切片: %v", rows)
	}
}

// TestAudit20260919MonthlyReportTopTieOrder 走真实月报生成路径(推送 webhook 的
// 那份 body):等值行出现在"取前 n"的边界上时,选谁 + 怎么排必须是确定的全序。
//
// 夹具刻意做成"成本与标签无关"(聚合 SQL 是 ORDER BY label,现实中成本与名字当
// 然不相关):8 行有价 + 12 行未定价(cost 0),⇒ 第 9/10 名落在 12 个零成本行里,
// 单判据下这 2 个名额由 pdqsort 的分区交换决定。期望:有价按成本降序在前、
// 边界上的等值行按 Label 升序取前 2(zu01 → zu02 / um01 → um02)。
func TestAudit20260919MonthlyReportTopTieOrder(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	const priced, unpriced = 8, 12
	insert := func(username, model string, cost float64) {
		t.Helper()
		uid, err := serverstore.CreateUser(db, &serverstore.User{Username: username, Source: "local", Status: 1})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, cache_prompt_tokens, kind, cost, created_at)
			VALUES (?, ?, 10, 0, 0, 'chat', ?, ?)`, uid, model, cost, bjAt(2026, 8, 15, 10)); err != nil {
			t.Fatal(err)
		}
	}
	for i := 1; i <= priced; i++ {
		// 成本随标签**升序**(与 SQL 的 ORDER BY label 同向),这样输入对
		// "成本降序"而言不是有序序列,pdqsort 一定会分区交换。
		insert(fmt.Sprintf("pu%02d", i), fmt.Sprintf("pm%02d", i), float64(i))
	}
	for i := 1; i <= unpriced; i++ {
		insert(fmt.Sprintf("zu%02d", i), fmt.Sprintf("um%02d", i), 0)
	}

	body, err := GenerateMonthlyReport(db, bjAt(2026, 9, 5, 0))
	if err != nil {
		t.Fatal(err)
	}

	wantModels := make([]string, 0, 10)
	for i := priced; i >= 1; i-- {
		wantModels = append(wantModels, fmt.Sprintf("pm%02d", i))
	}
	wantModels = append(wantModels, "um01", "um02")

	wantUsers := make([]string, 0, 10)
	for i := priced; i >= 1; i-- {
		wantUsers = append(wantUsers, fmt.Sprintf("pu%02d", i))
	}
	wantUsers = append(wantUsers, "zu01", "zu02")

	for _, tc := range []struct {
		name string
		got  []serverstore.UsageAggregateRow
		want []string
	}{
		{"TopModels", body.TopModels, wantModels},
		{"TopUsers", body.TopUsers, wantUsers},
	} {
		if len(tc.got) != len(tc.want) {
			t.Fatalf("%s 长度 = %d, want %d: %v", tc.name, len(tc.got), len(tc.want), auditLabels(tc.got))
		}
		for i, w := range tc.want {
			if tc.got[i].Label != w {
				t.Fatalf("%s 第 %d 名 = %q, want %q(有价按成本降序,等值按 Label 升序)\n实际 = %v",
					tc.name, i+1, tc.got[i].Label, w, auditLabels(tc.got))
			}
		}
	}
}

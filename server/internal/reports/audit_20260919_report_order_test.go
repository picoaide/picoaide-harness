package reports

import (
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 2026-09-19(服务端审计收尾):报表 TOP 榜排序非全序 / 非确定。
//
// topByCost 原先只有单一判据 `sorted[i].Cost > sorted[j].Cost` + sort.Slice。
// 等值行之间没有任何确定的次序 —— 未定价模型(usage.cost 恒 0)是最常见的一种,
// 用户/部门成本相同同理。根因是**比较器不是全序**(等值键没有次级判据),
// **与排序算法/长度阈值无关**:等值键一律被判"不小于",组内次序就由输入顺序
// 决定,于是输出随输入置换变化 —— n≤12 走插入排序的路径同样如此,所以
// "pdqsort 只在 len>12 分区重排"不是解释(本条注释原先写的正是那个说法,已纠正)。
// 实测(三处独立夹具数字不同,但都证明"输出不唯一"):
//   - 5 行**全等值** + 全部 120 种输入置换 ⇒ 旧实现 120 种输出(= 输入顺序本身),
//     新实现 1 种 —— 见 TestAudit20260919TopByCostPermutationInvariant;
//   - 5 行(3+2 等值组)⇒ 12 种;18 行 ⇒ 78 种;25 行 ⇒ 200 种
//     (2026-09-19 第三/四轮独立审计各自实测,夹具在其 temp 探针里)。
// 后果两条:
//  1. 等值组的先后顺序与任何判据无关;
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

// TestAudit20260919TopByCostPermutationInvariant：输出必须只由**行集合**决定，
// 与输入顺序无关 —— 这是"比较器不是全序"的判别式判据（不是"看起来稳定"）。
//
// 判据强度与可复现性：本用例只造 5 行**全等值**数据（故意低于任何"分区重排
// 阈值"），枚举全部 120 种输入置换，要求 distinct 输出恰好 1 种。旧实现
// （单判据 sort.Slice）在同样的 5 行夹具上得到 **120 种**输出（= 输入顺序本身：
// 等值键被判"不小于"，插入排序不交换它们）—— 这个夹具本身就足以证伪"根因是
// pdqsort 分区阈值"那种解释，而且不依赖任何 gitignored 的临时探针。
func TestAudit20260919TopByCostPermutationInvariant(t *testing.T) {
	// 等成本（未定价模型最常见的形态）；标签顺序故意与字典序相反。
	base := []serverstore.UsageAggregateRow{
		{Label: "m05"}, {Label: "m04"}, {Label: "m03"}, {Label: "m02"}, {Label: "m01"},
	}
	idx := []int{0, 1, 2, 3, 4}
	const total = 120 // 5!
	seen := map[string]bool{}
	var permute func(k int)
	permute = func(k int) {
		if k == len(idx) {
			rows := make([]serverstore.UsageAggregateRow, 0, len(base))
			for _, i := range idx {
				rows = append(rows, base[i])
			}
			seen[strings.Join(auditLabels(topByCost(rows, 10)), "|")] = true
			return
		}
		for i := k; i < len(idx); i++ {
			idx[k], idx[i] = idx[i], idx[k]
			permute(k + 1)
			idx[k], idx[i] = idx[i], idx[k]
		}
	}
	permute(0)

	const want = "m01(cost=0)|m02(cost=0)|m03(cost=0)|m04(cost=0)|m05(cost=0)"
	if len(seen) != 1 {
		outs := make([]string, 0, len(seen))
		for k := range seen {
			outs = append(outs, k)
		}
		sort.Strings(outs)
		t.Fatalf("同一行集合在 %d 种输入置换下得到 %d 种输出（应当只有 1 种）：\n  %s",
			total, len(seen), strings.Join(outs, "\n  "))
	}
	for out := range seen {
		if out != want {
			t.Fatalf("输出 = %q\nwant 按 Label 升序: %q", out, want)
		}
	}
}

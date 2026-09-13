package serverstore

// 审计 r7 **第二轮**对抗复核(报告 RECHECK-F1-server-billing §4 r7f1-3):
// 第一轮的"区间覆盖"判据只作用在**同名关系**上 —— probeUsagePartition(rel)。
// 危害(期望窗口没被完整覆盖)是**区间语义**,入口却是**名字语义**,于是:
//
//	① 命名恰好撞上覆盖窗口的那个月 → 判就绪(第一轮修复生效);
//	② 同季度其它月(窗口同样被覆盖、但同名关系不存在)→ 走 CREATE →
//	   与覆盖分区 overlap → SQLSTATE 42P17,裸 PG 错误、无人工处置指引,
//	   RecordUsage / RebuildUsageLedger 全挂、该月 503 且不自愈;
//	③ 更糟的是基点会报 misboundedPartitionErr(含"需人工处置"指引),
//	   第一轮把**唯一会说话的告警**换成了延迟的裸错误 —— 季度布局看起来是
//	   好的,直到季度内其它月首写才炸。
//
// 修法:ensureRangePartition 在 CREATE 前先探测"期望窗口是否已被 usage 的
// **任何**分区覆盖"(与 partitionReadyErr 同一比较器),已覆盖则直接复用、
// 跳过 CREATE;真发生 overlap 时翻译成与 misboundedPartitionErr 同级的可诊断
// 错误(指出冲突分区 + 人工处置指引),不再抛裸 PG 错误。

import (
	"strings"
	"testing"
	"time"
)

// r7bMonthAt 造一个落在目标北京月中间的瞬时(与 ensureUsagePartition 的
// BeijingMonth 归一化同源)。
func r7bMonthAt(year int, month time.Month) time.Time {
	return time.Date(year, month, 15, 4, 0, 0, 0, time.UTC) // 北京 12:00
}

// TestR7bSiblingMonthCoveredByWidePartitionSkipsCreate:季度分区覆盖 7/8/9 月,
// 只有 9 月有"同名"关系。对 8 月(同季度邻月)的计量写入必须直接复用季度分区,
// 而不是去建兄弟月分区(那必然 42P17,该月 503 且不自愈)。
func TestR7bSiblingMonthCoveredByWidePartitionSkipsCreate(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// 季度分区 [2099-07-01+08, 2099-10-01+08):完整覆盖北京 7/8/9 三个月。
	const quarter = "usage_209909"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + quarter); err != nil {
		t.Fatalf("清理 %s: %v", quarter, err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + quarter +
		` PARTITION OF usage FOR VALUES FROM ('2099-07-01 00:00:00+08') TO ('2099-10-01 00:00:00+08')`); err != nil {
		t.Fatalf("构造季度覆盖分区: %v", err)
	}
	_, isp, before := r4ProbeRelation(t, db, quarter)
	if !isp {
		t.Fatalf("%s 不是分区,夹具无效", quarter)
	}
	t.Logf("季度覆盖布局:仅存在 %s = %s(7/8/9 月都没有各自的月分区)", quarter, before)

	aug := r7bMonthAt(2099, time.August) // 同季度邻月:同名关系 usage_209908 不存在
	if err := ensureUsagePartition(db, aug); err != nil {
		t.Fatalf("同季度邻月的期望窗口已被季度分区覆盖,仍去建兄弟分区(42P17 → 该月 503 且不自愈): %v", err)
	}
	if exists, _, _ := r4ProbeRelation(t, db, "usage_209908"); exists {
		t.Fatalf("窗口已被覆盖时仍建了兄弟分区 usage_209908(创建路径没有做区间探测)")
	}

	// 真写路径:计量必须落进季度分区,而不是只在探测里放行。
	uid, err := CreateUser(db, &User{Username: "r7b-quarter-writer", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	if _, err := recordUsageKindAt(db, uid, "r7b-model", 10, 10, "chat", aug); err != nil {
		t.Fatalf("季度覆盖布局下的计量写入失败: %v", err)
	}
	// 账本重算(日/月账)同样必须恢复正常 —— 审计复现里它一起被 42P17 拦下。
	if err := RebuildUsageLedger(db, aug, aug); err != nil {
		t.Fatalf("RebuildUsageLedger 被兄弟分区路径拦下: %v", err)
	}
	if err := ensureUsagePartition(db, aug); err != nil {
		t.Fatalf("幂等复检失败: %v", err)
	}
	var routed int
	if err := db.QueryRow(`SELECT count(*) FROM ` + quarter).Scan(&routed); err != nil {
		t.Fatalf("统计 %s: %v", quarter, err)
	}
	if routed != 1 {
		t.Fatalf("写入没有路由到季度覆盖分区: rows=%d, want 1", routed)
	}
	// 服务端不得改写/删除别人的分区。
	exists, stillPartition, after := r4ProbeRelation(t, db, quarter)
	if !exists || !stillPartition || after != before {
		t.Fatalf("季度分区被自动处置: exists=%v isPartition=%v before=%q after=%q", exists, stillPartition, before, after)
	}
}

// TestR7bPartiallyOverlappingWindowFailsLoudWithManualIntervention:既有分区与
// 期望窗口**部分重叠**(既不覆盖、也不能再建月分区)。此时必须给出可诊断的
// 错误:指出冲突分区 + 人工处置指引,而不是裸 SQLSTATE 42P17;
// 并且该月的计量写入必须拿到同一个可诊断错误(而不是让调用方 503 时无从下手)。
func TestR7bPartiallyOverlappingWindowFailsLoudWithManualIntervention(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// [2099-08-10+08, 2099-09-10+08):下界落在北京 8 月窗口内 ⇒ 与 8 月窗口
	// 部分重叠(不覆盖),再建 usage_209908 必然 overlap。
	const partial = "usage_209888"
	if _, err := db.Exec("DROP TABLE IF EXISTS " + partial); err != nil {
		t.Fatalf("清理 %s: %v", partial, err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + partial +
		` PARTITION OF usage FOR VALUES FROM ('2099-08-10 00:00:00+08') TO ('2099-09-10 00:00:00+08')`); err != nil {
		t.Fatalf("构造部分重叠分区: %v", err)
	}
	_, isp, before := r4ProbeRelation(t, db, partial)
	if !isp {
		t.Fatalf("%s 不是分区,夹具无效", partial)
	}

	aug := r7bMonthAt(2099, time.August)
	err := ensureUsagePartition(db, aug)
	if err == nil {
		t.Fatalf("部分重叠的既有分区被判就绪(8 月后半段写入会 23514/23699): %s", before)
	}
	msg := err.Error()
	t.Logf("部分重叠窗口的错误: %v", err)
	if !strings.Contains(msg, "manual intervention") {
		t.Fatalf("overlap 没有被翻译成含人工处置指引的可诊断错误(基线会报 misboundedPartitionErr): %v", err)
	}
	if !strings.Contains(msg, partial) {
		t.Fatalf("错误没有指出冲突的现有分区(管理员无从下手): %v", err)
	}
	if !strings.Contains(msg, "overlap") && !strings.Contains(msg, "重叠") {
		t.Fatalf("错误没有说明冲突性质(窗口与现有分区重叠): %v", err)
	}

	// 计量写入路径必须得到同一个可诊断结论(而不是裸 PG 错误让网关只记 503)。
	uid := mustUserID(t, db)
	if _, rerr := recordUsageKindAt(db, uid, "r7b-model", 1, 1, "chat", aug); rerr == nil {
		t.Fatalf("部分重叠窗口下的计量写入竟然成功(窗口后有洞)")
	} else if !strings.Contains(rerr.Error(), "manual intervention") {
		t.Fatalf("RecordUsage 拿到的是裸错误(无人工处置指引): %v", rerr)
	}

	// 现有分区不得被自动改写/删除。
	exists, stillPartition, after := r4ProbeRelation(t, db, partial)
	if !exists || !stillPartition || after != before {
		t.Fatalf("现有分区被自动处置: exists=%v isPartition=%v before=%q after=%q", exists, stillPartition, before, after)
	}
}

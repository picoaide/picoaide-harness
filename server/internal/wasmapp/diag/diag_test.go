package diag

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ---- 变异验证(改回危险实现时哪条用例必红)----
//   - clampLimit 去掉上限/默认值        → TestClampLimit 红
//   - hintTable 少一个必需错误码        → TestHintsCoverRequiredReasons 红
//   - RecentFailures 的 outcome<>'ok' 条件去掉 → TestRecentFailuresAndSummary 红(把成功也算失败)
//   - Summary 不带 app_id 过滤          → TestRecentFailuresAndSummary 红(串应用)

func TestClampLimit(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, limits.DiagnosticsDefaultLimit},
		{-5, limits.DiagnosticsDefaultLimit},
		{1, 1},
		{limits.DiagnosticsMaxLimit, limits.DiagnosticsMaxLimit},
		{limits.DiagnosticsMaxLimit + 1, limits.DiagnosticsMaxLimit},
		{1 << 30, limits.DiagnosticsMaxLimit},
	}
	for _, c := range cases {
		if got := clampLimit(c.in); got != c.want {
			t.Fatalf("clampLimit(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

// TestHintsCoverRequiredReasons 设计 §4.9 要求至少覆盖这些错误码
// (第一消费者是 AI ⇒ 没有 hint 等于让人自己猜)。
func TestHintsCoverRequiredReasons(t *testing.T) {
	required := []apperr.Code{
		apperr.CodeRuntimeTimeout,
		apperr.CodeRuntimeMemory,
		apperr.CodeRuntimeGuestExit,
		apperr.CodeDBLimit,
		apperr.CodeDBDenied,
		apperr.CodeAppQueueFull,
		apperr.CodeAIBalanceInsufficient,
	}
	for _, code := range required {
		hints := HintsFor(string(code))
		if len(hints) == 0 {
			t.Fatalf("错误码 %s 没有可操作 hint", code)
		}
		for _, h := range hints {
			if strings.TrimSpace(h) == "" {
				t.Fatalf("错误码 %s 有空 hint", code)
			}
		}
	}
	// 未覆盖的码返回 nil(而不是伪造一条空建议)。
	if HintsFor("NOT_A_REAL_CODE") != nil {
		t.Fatal("未知错误码应返回 nil")
	}
	// 返回的是副本:调用方改 hints 不能污染全局表。
	first := HintsFor(string(apperr.CodeRuntimeTimeout))
	first[0] = "tampered"
	if HintsFor(string(apperr.CodeRuntimeTimeout))[0] == "tampered" {
		t.Fatal("HintsFor 返回了内部切片(可变全局状态)")
	}
}

func insertEvent(t *testing.T, db *sql.DB, appID, outcome, reason string, at time.Time, cpu int64, mem int64, exit int) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO wasm_call_events
		(app_id, user_id, outcome, reason_code, cpu_ms, peak_memory_bytes, guest_exit_code, stderr_tail, created_at)
		VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
		appID, outcome, reason, cpu, mem, exit, "stderr-"+reason, at); err != nil {
		t.Fatal(err)
	}
}

func TestRecentFailuresAndSummary(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC()

	// 窗口内:3 成功 + 2 超时 + 1 内存被杀;窗口外 1 条;另一个应用 2 条。
	insertEvent(t, db, "app-a", "ok", "", now.Add(-10*time.Minute), 10, 1<<20, 0)
	insertEvent(t, db, "app-a", "ok", "", now.Add(-9*time.Minute), 20, 2<<20, 0)
	insertEvent(t, db, "app-a", "ok", "", now.Add(-8*time.Minute), 30, 3<<20, 0)
	insertEvent(t, db, "app-a", "error", string(apperr.CodeRuntimeTimeout), now.Add(-7*time.Minute), 10001, 5<<20, 0)
	insertEvent(t, db, "app-a", "error", string(apperr.CodeRuntimeTimeout), now.Add(-6*time.Minute), 10002, 6<<20, 0)
	insertEvent(t, db, "app-a", "killed", string(apperr.CodeRuntimeMemory), now.Add(-5*time.Minute), 4000, 64<<20, 137)
	insertEvent(t, db, "app-a", "error", string(apperr.CodeDBLimit), now.Add(-40*24*time.Hour), 999, 9<<20, 0)
	insertEvent(t, db, "app-b", "error", string(apperr.CodeDBDenied), now.Add(-time.Minute), 1, 1, 0)
	insertEvent(t, db, "app-b", "killed", string(apperr.CodeAppQueueFull), now.Add(-time.Minute), 1, 1, 0)

	since := now.Add(-time.Hour)
	// --- RecentFailures:只回失败/被杀,最新在前,app 维度隔离 ---
	// 注意语义差别:RecentFailures 是"最近 N 条失败"(不带时间窗口,limit 才是边界),
	// 时间窗口属于 Summary。那条 40 天前的 DB_LIMIT 因此会出现在这里、但不出现在
	// Summary(since=1 小时)里 —— 这两条断言一起把两个口径钉住。
	fails, err := RecentFailures(ctx, db, "app-a", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(fails) != 4 {
		t.Fatalf("失败条数 = %d, want 4(3 条近期 + 1 条 40 天前;别的应用不得混入)", len(fails))
	}
	if fails[0].ReasonCode != string(apperr.CodeRuntimeMemory) ||
		fails[1].ReasonCode != string(apperr.CodeRuntimeTimeout) {
		t.Fatalf("顺序错(应最新在前): %+v", fails)
	}
	if fails[3].ReasonCode != string(apperr.CodeDBLimit) {
		t.Fatalf("最旧一条应是窗口外的 DB_LIMIT: %+v", fails[3])
	}
	if fails[0].GuestExitCode != 137 || fails[0].PeakMemory != 64<<20 {
		t.Fatalf("guest exit code / peak memory 未回传: %+v", fails[0])
	}
	if !strings.Contains(fails[0].StderrTail, "RUNTIME_MEMORY") {
		t.Fatalf("stderr_tail 未回传: %q", fails[0].StderrTail)
	}
	// limit 生效。
	if one, err := RecentFailures(ctx, db, "app-a", 1); err != nil || len(one) != 1 {
		t.Fatalf("limit=1 → %d 条 err=%v", len(one), err)
	}
	// 另一个应用互不可见。
	if other, err := RecentFailures(ctx, db, "app-b", 0); err != nil || len(other) != 2 {
		t.Fatalf("app-b 失败条数 = %d err=%v, want 2", len(other), err)
	}
	if empty, err := RecentFailures(ctx, db, "app-c", 0); err != nil || len(empty) != 0 {
		t.Fatalf("无事件应用 = %d 条 err=%v, want 0", len(empty), err)
	}
	if _, err := RecentFailures(ctx, db, "", 10); err == nil {
		t.Fatal("空 app_id 必须被拒")
	}

	// --- Summary:窗口内计数、按次数排序的失败码、hints ---
	sum, err := Summary(ctx, db, "app-a", since)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Total != 6 || sum.OK != 3 || sum.Error != 2 || sum.Killed != 1 || sum.Failed != 3 {
		t.Fatalf("汇总错误: total=%d ok=%d error=%d killed=%d failed=%d",
			sum.Total, sum.OK, sum.Error, sum.Killed, sum.Failed)
	}
	if len(sum.Reasons) != 2 {
		t.Fatalf("失败码种类 = %d, want 2: %+v", len(sum.Reasons), sum.Reasons)
	}
	if sum.Reasons[0].ReasonCode != string(apperr.CodeRuntimeTimeout) || sum.Reasons[0].Count != 2 {
		t.Fatalf("失败码排序错(次数降序): %+v", sum.Reasons)
	}
	if len(sum.Reasons[0].Hints) == 0 || len(sum.Hints) == 0 {
		t.Fatalf("hints 未生成: %+v", sum)
	}
	if sum.MaxCPUMs != 10002 || sum.MaxPeakMemoryBytes != 64<<20 {
		t.Fatalf("极值统计错: cpu=%d mem=%d", sum.MaxCPUMs, sum.MaxPeakMemoryBytes)
	}
	if sum.LastFailureAt == nil || sum.LastFailureAt.Before(now.Add(-6*time.Minute)) {
		t.Fatalf("LastFailureAt = %v", sum.LastFailureAt)
	}
	// 窗口外的那条不得计数(Total=6 已证明),hints 也不该出现仅窗口外才有的码。
	for _, h := range sum.Hints {
		if strings.Contains(h, "SELECT") && strings.Contains(h, "DDL") {
			t.Fatalf("窗口外的 DB_LIMIT 混进了 hints: %v", sum.Hints)
		}
	}
	if _, err := Summary(ctx, db, "", since); err == nil {
		t.Fatal("空 app_id 必须被拒")
	}
}

// TestSummaryUnknownReasonGetsGenericHint 未覆盖的失败码必须给出通用建议,
// 而不是静默返回空 hints(§8:错误响应的第一消费者是 AI)。
func TestSummaryUnknownReasonGetsGenericHint(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC()
	insertEvent(t, db, "app-x", "error", "WEIRD_FAILURE", now.Add(-time.Minute), 1, 1, 0)

	sum, err := Summary(ctx, db, "app-x", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Reasons) != 1 || sum.Reasons[0].ReasonCode != "WEIRD_FAILURE" {
		t.Fatalf("未覆盖错误码未出现在概览里: %+v", sum.Reasons)
	}
	if len(sum.Reasons[0].Hints) != 0 {
		t.Fatalf("未覆盖错误码不该伪造 hints: %+v", sum.Reasons[0].Hints)
	}
	if len(sum.Hints) == 0 {
		t.Fatal("未覆盖错误码必须补通用建议")
	}
	// 窗口内没有任何事件时:计数全 0 且不报错。
	sum, err = Summary(ctx, db, "app-x", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Total != 0 || sum.Failed != 0 || len(sum.Reasons) != 0 || sum.LastFailureAt != nil {
		t.Fatalf("空窗口结果不为零值: %+v", sum)
	}
}

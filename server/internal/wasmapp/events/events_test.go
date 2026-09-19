package events

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ---- 变异验证(改回危险实现时哪条用例必红)----
//   - Record 里加数据库调用 / 加阻塞等待 → TestRecordNeverTouchesDatabase 红(nil db 会 panic)
//   - 环满改成"丢弃最新"或不再计数         → TestRingDropsOldestAndCounts 红
//   - 默认值不再来自 limits                → TestDefaultsComeFromLimits 红
//   - Close 不 flush                       → TestCloseFlushesWithoutStart 红
//   - Cleanup 用 time.Now() 而非注入的 now → TestCleanupUsesInjectedNow 红

func TestDefaultsComeFromLimits(t *testing.T) {
	s := NewSink(nil, Options{})
	if s.opt.RingSize != limits.CallEventRingSize {
		t.Fatalf("RingSize = %d, want %d(limits 单一真源)", s.opt.RingSize, limits.CallEventRingSize)
	}
	if s.opt.FlushInterval != limits.CallEventFlushInterval ||
		s.opt.BatchMax != limits.CallEventBatchMax ||
		s.opt.RetentionDays != limits.CallEventRetentionDays {
		t.Fatalf("默认值未取自 limits: %+v", s.opt)
	}
}

func TestRingDropsOldestAndCounts(t *testing.T) {
	s := NewSink(nil, Options{RingSize: 4})
	for i := 0; i < 6; i++ {
		s.Record(capapi.CallMetrics{AppID: "app", UserID: int64(i)})
	}
	if s.Dropped() != 2 {
		t.Fatalf("Dropped = %d, want 2(环满丢最旧并计数)", s.Dropped())
	}
	got := s.drain(10)
	if len(got) != 4 {
		t.Fatalf("环内条数 = %d, want 4", len(got))
	}
	// 丢的是最旧两条(0/1),留下的是最新四条(2..5)。
	for i, ev := range got {
		if ev.m.UserID != int64(i+2) {
			t.Fatalf("第 %d 条 UserID = %d, want %d(必须丢最旧)", i, ev.m.UserID, i+2)
		}
	}
	// 重复 Record 后顺序仍然单调(环形下标推进正确)。
	s.Record(capapi.CallMetrics{AppID: "app", UserID: 6})
	s.Record(capapi.CallMetrics{AppID: "app", UserID: 7})
	got = s.drain(10)
	if len(got) != 2 || got[0].m.UserID != 6 || got[1].m.UserID != 7 {
		t.Fatalf("环形下标推进错乱: %+v", got)
	}
	if s.Failed() != 0 {
		t.Fatalf("无数据库时 Failed = %d, want 0(内存模式不落库也不该计失败)", s.Failed())
	}
}

// TestBuildInsertSQLShape 占位符形状:每行 15 个带括号的 $N、编号连续、多行拼接正确。
// (曾经漏掉每行的括号 ⇒ PG 只回一句 "syntax error at or near $1"。)
func TestBuildInsertSQLShape(t *testing.T) {
	one := buildInsertSQL(1)
	if !strings.HasSuffix(one, "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)") {
		t.Fatalf("单行占位符形状错:\n%s", one)
	}
	two := buildInsertSQL(2)
	if !strings.Contains(two, "),($16,") {
		t.Fatalf("多行占位符编号/括号错:\n%s", two)
	}
	if n := strings.Count(two, "$"); n != 2*callEventColumns {
		t.Fatalf("占位符个数 = %d, want %d", n, 2*callEventColumns)
	}
}

func TestEmptyOutcomeCountsAsOK(t *testing.T) {
	s := NewSink(nil, Options{RingSize: 2})
	s.Record(capapi.CallMetrics{AppID: "app"}) // 调用方只标失败路径
	got := s.drain(1)
	if len(got) != 1 || got[0].m.Outcome != capapi.OutcomeOK {
		t.Fatalf("空 outcome 应视作 ok: %+v", got)
	}
}

// TestRecordNeverTouchesDatabase 用**nil db** 当探针:Record 一旦碰数据库就会 panic。
// 这条契约("绝不因为落库慢而阻塞请求路径")靠结构而不是靠计时来证明。
func TestRecordNeverTouchesDatabase(t *testing.T) {
	s := NewSink(nil, Options{RingSize: 4, FlushInterval: time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	defer cancel()
	for i := 0; i < 10; i++ {
		s.Record(capapi.CallMetrics{AppID: "app", UserID: int64(i), Outcome: capapi.OutcomeError})
	}
	time.Sleep(20 * time.Millisecond) // 让 worker 跑几轮 flush(nil db ⇒ 静默跳过)
	s.Record(capapi.CallMetrics{AppID: "app", UserID: 11})
	if s.Failed() != 0 {
		t.Fatalf("nil db 是内存模式,不应计失败: %d", s.Failed())
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	// 关闭后不再接受(没有 worker 会落库):计入丢弃而不是静默留在环里。
	before := s.Dropped()
	s.Record(capapi.CallMetrics{AppID: "app"})
	if s.Dropped() != before+1 {
		t.Fatalf("关闭后 Record 未计入丢弃: %d → %d", before, s.Dropped())
	}
}

func TestTailUTF8KeepsValidSuffix(t *testing.T) {
	// 从多字节字符中间切:被切掉的那个字符不要,但结果必须是**合法 UTF-8 的后缀**
	// (不能留下半个 rune —— PG 的 text 会因此拒掉整批 INSERT)。
	src := strings.Repeat("a", 10) + "中文" // "中"=E4B8AD / "文"=E69687
	got := tailUTF8(src, 5)               // 尾部 5 字节正好从"中"的中间开始
	if got != "文" {
		t.Fatalf("尾截断 = %q, want %q(半个 rune 必须丢掉)", got, "文")
	}
	if !utf8.ValidString(got) || !strings.HasSuffix(src, got) || len(got) > 5 {
		t.Fatalf("尾截断结果不合法: %q", got)
	}
	// 恰好切在边界上时整个字符都要保留。
	if got := tailUTF8(src, 3); got != "文" {
		t.Fatalf("边界截断 = %q, want 文", got)
	}
	if got := tailUTF8(src, 6); got != "中文" {
		t.Fatalf("整字截断 = %q, want 中文", got)
	}
	// 非法字节序列必须被替换,否则 PG 的 text 会拒掉整批 INSERT。
	bad := tailUTF8("\xff\xfe"+"tail", 64)
	if !utf8.ValidString(bad) {
		t.Fatalf("非法字节未净化(PG 的 text 会拒掉整批): %q", bad)
	}
	// 短串原样返回。
	if tailUTF8("abc", 64) != "abc" {
		t.Fatal("短串不应被改动")
	}
}

func waitRows(t *testing.T, db *sql.DB, appID string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var n int
	for time.Now().Before(deadline) {
		if err := db.QueryRow(`SELECT count(*) FROM wasm_call_events WHERE app_id = $1`, appID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("等待落库超时:app_id=%s 实际 %d 条, want %d", appID, n, want)
}

// TestInsertBudgetHasFloorForSmallFlushInterval 钉住"预算下限"这条回归门禁。
//
// 现场(2026-09-19 CI flake):测试注入 FlushInterval=10ms ⇒ 预算只剩
// FlushInterval×5 = 50ms;负载下 insert 会在**事务已提交之后**才等到驱动返回,
// 超时被记成失败并丢掉整批,测试报 `Written = N, want M` 而库里其实已有那些行
// ("超时 ≠ 未执行")。去掉下限(改回裸乘)本用例必红。
func TestInsertBudgetHasFloorForSmallFlushInterval(t *testing.T) {
	s := NewSink(nil, Options{FlushInterval: 10 * time.Millisecond})
	if got := s.insertBudget(); got < flushInsertBudgetMin {
		t.Fatalf("小 FlushInterval 下预算 = %v,必须不低于 %v(否则成功批量会被误判为失败)",
			got, flushInsertBudgetMin)
	}
	// 大 FlushInterval 仍按周期数走(下限不改变原有的"卡住也能回来"语义)。
	s2 := NewSink(nil, Options{FlushInterval: 2 * time.Second})
	if got, want := s2.insertBudget(), 2*time.Second*flushBudgetIntervals; got != want {
		t.Fatalf("大 FlushInterval 下预算 = %v, want %v", got, want)
	}
}

// TestFlushPersistsBatchFields 批量落库:字段逐项落对(§4.9 字段表)。
func TestFlushPersistsBatchFields(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	sink := NewSink(db, Options{RingSize: 16, FlushInterval: 10 * time.Millisecond, BatchMax: 2})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink.Start(ctx)

	sink.Record(capapi.CallMetrics{
		AppID: "flush-app", UserID: 10231, Outcome: capapi.OutcomeKilled,
		ReasonCode: "RUNTIME_TIMEOUT", CPUMs: 10001, PeakMemory: 64 << 20,
		HostCalls: 7, HostCallMS: 120, QueueWaitMS: 33, ResponseSize: 4096,
		DBRows: 12, DBBytes: 2048, GuestExitCode: 137, StderrTail: "boom",
	})
	for i := 0; i < 4; i++ {
		sink.Record(capapi.CallMetrics{AppID: "flush-app", UserID: 1, Outcome: capapi.OutcomeOK})
	}
	waitRows(t, db, "flush-app", 5)
	if err := sink.Close(); err != nil {
		t.Fatal(err)
	}
	if sink.Written() != 5 {
		t.Fatalf("Written = %d, want 5", sink.Written())
	}
	if sink.Failed() != 0 || sink.Dropped() != 0 {
		t.Fatalf("Failed=%d Dropped=%d, want 0/0", sink.Failed(), sink.Dropped())
	}
	var (
		userID   int64
		outcome  string
		reason   string
		cpu      int64
		peak     int64
		calls    int64
		callMS   int64
		queueMS  int64
		respSize int64
		dbRows   int64
		dbBytes  int64
		exitCode int
		stderr   string
		created  time.Time
	)
	if err := db.QueryRow(`SELECT user_id, outcome, reason_code, cpu_ms, peak_memory_bytes,
		host_call_count, host_call_ms, queue_wait_ms, response_bytes, db_rows, db_bytes,
		guest_exit_code, stderr_tail, created_at FROM wasm_call_events
		WHERE app_id = $1 AND user_id = 10231`, "flush-app").Scan(&userID, &outcome, &reason, &cpu,
		&peak, &calls, &callMS, &queueMS, &respSize, &dbRows, &dbBytes, &exitCode, &stderr, &created); err != nil {
		t.Fatal(err)
	}
	if outcome != capapi.OutcomeKilled || reason != "RUNTIME_TIMEOUT" || cpu != 10001 ||
		peak != 64<<20 || calls != 7 || callMS != 120 || queueMS != 33 || respSize != 4096 ||
		dbRows != 12 || dbBytes != 2048 || exitCode != 137 || stderr != "boom" {
		t.Fatalf("字段落库不一致: %s/%s cpu=%d peak=%d calls=%d callms=%d q=%d resp=%d rows=%d bytes=%d exit=%d stderr=%q",
			outcome, reason, cpu, peak, calls, callMS, queueMS, respSize, dbRows, dbBytes, exitCode, stderr)
	}
	// created_at 用**记录时刻**而不是批量落库时刻:同一批几百条不该挤在同一时间点。
	if time.Since(created) > time.Minute {
		t.Fatalf("created_at = %v,疑似落库时刻而非记录时刻", created)
	}
}

// TestCloseFlushesWithoutStart 从未 Start 也要在 Close 时尽力 flush。
func TestCloseFlushesWithoutStart(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	sink := NewSink(db, Options{RingSize: 8})
	sink.Record(capapi.CallMetrics{AppID: "close-app", Outcome: capapi.OutcomeError, ReasonCode: "RUNTIME_TRAP"})
	sink.Record(capapi.CallMetrics{AppID: "close-app", Outcome: capapi.OutcomeOK})
	if err := sink.Close(); err != nil {
		t.Fatal(err)
	}
	if err := sink.Close(); err != nil { // 幂等
		t.Fatal(err)
	}
	waitRows(t, db, "close-app", 2)
	if sink.Written() != 2 {
		t.Fatalf("Written = %d, want 2", sink.Written())
	}
}

// TestCleanupUsesInjectedNow 保留期清理(§4.9:7 天),边界用注入的 now 判定。
func TestCleanupUsesInjectedNow(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	sink := NewSink(db, Options{})
	now := time.Now().UTC()

	ins := func(appID string, at time.Time) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO wasm_call_events (app_id, user_id, outcome, created_at)
			VALUES ($1, 1, 'ok', $2)`, appID, at); err != nil {
			t.Fatal(err)
		}
	}
	ins("expired", now.AddDate(0, 0, -limits.CallEventRetentionDays-1)) // 超期
	ins("edge", now.AddDate(0, 0, -limits.CallEventRetentionDays))      // 正好到期(保留)
	ins("fresh", now.Add(-time.Hour))                                   // 保留

	n, err := sink.Cleanup(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("清理条数 = %d, want 1(只删超过 %d 天的)", n, limits.CallEventRetentionDays)
	}
	for _, app := range []string{"edge", "fresh"} {
		var c int
		if err := db.QueryRow(`SELECT count(*) FROM wasm_call_events WHERE app_id = $1`, app).Scan(&c); err != nil {
			t.Fatal(err)
		}
		if c != 1 {
			t.Fatalf("%s 行被误删(边界应保留)", app)
		}
	}
	// 再清一次:没有可删的。
	if n, err = sink.Cleanup(context.Background(), now); err != nil || n != 0 {
		t.Fatalf("重复清理 n=%d err=%v, want 0/nil", n, err)
	}
	// 未绑定数据库时必须显式报错,而不是静默"清理成功"。
	if _, err := NewSink(nil, Options{}).Cleanup(context.Background(), now); err == nil {
		t.Fatal("nil db 的 Cleanup 必须报错")
	}
}

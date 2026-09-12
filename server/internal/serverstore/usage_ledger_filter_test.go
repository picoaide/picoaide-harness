package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"
)

// FIX-10(审计 2026-09-12,P1-4):用量账本段的 username 过滤参数错位。
//
// 缺陷形态:UsageAggregateFromLedger 在函数**开头**就
// `args = append(args, q.Username)`,而占位符 usernameFilter 是最后才拼进
// SQL 的 —— 占位符顺序 [from, to, dept, username] ≠ 参数顺序
// [username, from, to, dept]。窗口一旦跨越用量保留边界(走账本段),PG 就把
// 用户名喂给 `?::date`,必然 500:
//
//	ERROR: invalid input syntax for type date: "u1757…" (SQLSTATE 22007)
//
// 影响面:GET /usage 的统计徽标 500;Logs.tsx 在 setRows 之后 await 徽标,
// 所以整页呈现「查询失败 + 无行」。
//
// 修法:参数与占位符成对追加(见函数内注释),顺序在结构上不可能再错位。

// ledgerFixture 造出「旧月只有账本、当月有明细」的跨边界场景。
func ledgerFixture(t *testing.T) (db *sql.DB, uid int64, oldMonth time.Time) {
	t.Helper()
	d, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	d.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	if err := SetSetting(d, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	uid = mustUserID(t, d)

	// 8 个月前:明细已过期,只有账本(两个模型,便于 FIX-11 的过滤断言)
	oldMonth = bjMonth(8)
	if err := ensureUsagePartition(d, oldMonth); err != nil {
		t.Fatal(err)
	}
	oldDay := oldMonth.AddDate(0, 0, 2).Add(10 * time.Hour)
	if _, err := recordUsageKindAt(d, uid, "model-a", 100, 0, "chat", oldDay); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(d, uid, "model-b", 50, 0, "chat", oldDay); err != nil {
		t.Fatal(err)
	}
	// 1 个月前:仍在保留窗口内(明细段)
	recent := bjMonth(1)
	if err := ensureUsagePartition(d, recent); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(d, uid, "model-a", 220, 0, "chat", recent); err != nil {
		t.Fatal(err)
	}
	if err := RebuildUsageLedger(d, oldMonth, oldMonth.AddDate(0, 1, -1)); err != nil {
		t.Fatal(err)
	}
	// 等价于 CleanupUsageRetention DROP 掉旧分区
	if _, err := d.Exec("DELETE FROM usage WHERE model IN ('model-a','model-b') AND created_at < ?", recent); err != nil {
		t.Fatal(err)
	}
	return d, uid, oldMonth
}

func usernameOf(t *testing.T, db *sql.DB, uid int64) string {
	t.Helper()
	u, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	return u.Username
}

// TestUsageAggregateWithLedgerUsernameAcrossRetention 是 FIX-10 的回归锁:
// 跨保留边界 + 按用户名必须正常返回,而不是 SQLSTATE 22007。
func TestUsageAggregateWithLedgerUsernameAcrossRetention(t *testing.T) {
	db, uid, oldMonth := ledgerFixture(t)
	name := usernameOf(t, db, uid)

	rows, err := UsageAggregateWithLedger(db, oldMonth, bjDay(0), "user", WithUsername(name))
	if err != nil {
		t.Fatalf("跨边界 + username 查询失败(修复前为 SQLSTATE 22007): %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %+v, want 1(该用户)", rows)
	}
	// 账本 150 + 明细 220 = 370
	if rows[0].PromptTokens != 370 {
		t.Fatalf("tokens = %d, want 370(账本 150 + 明细 220)", rows[0].PromptTokens)
	}
	// 不存在的用户名 → 空结果(而不是报错)
	rows, err = UsageAggregateWithLedger(db, oldMonth, bjDay(0), "user", WithUsername("no-such-user-zz"))
	if err != nil {
		t.Fatalf("不存在的用户名不应报错: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("rows = %+v, want 空", rows)
	}
}

// TestUsageAggregateFromLedgerUsernameMatchesArgOrder 是**结构级**断言:
// 拼出的 SQL 里占位符个数必须与 args 个数一致。
//
// 参数错位的根因就是两者数量/顺序脱钩;这里用一个会**报错**的用户名把
// "顺序对不对"变成可观测结果(顺序错 → PG 把用户名当日期 → 22007)。
func TestUsageAggregateFromLedgerUsernameMatchesArgOrder(t *testing.T) {
	db, uid, oldMonth := ledgerFixture(t)
	name := usernameOf(t, db, uid)
	// 直接用账本段(不经过 WithLedger 的区间切分),覆盖面更窄更精确。
	rows, err := UsageAggregateFromLedger(db, oldMonth, oldMonth.AddDate(0, 1, -1), "model",
		WithUsername(name), WithDept(""), WithModel("model-a"))
	if err != nil {
		t.Fatalf("账本段查询失败: %v", err)
	}
	if len(rows) != 1 || rows[0].Label != "model-a" {
		t.Fatalf("rows = %+v, want 单行 model-a", rows)
	}
	if rows[0].PromptTokens != 100 {
		t.Fatalf("tokens = %d, want 100(model-a 在账本里的值)", rows[0].PromptTokens)
	}
}

// FIX-11(审计 2026-09-12,P1-5):账本段静默忽略 model/kind 过滤。
//
// 缺陷形态:UsageAggregateFromLedger 的函数体里 q.Model / q.Kind **零命中**,
// 只读了 q.Username / q.Dept。于是窗口跨保留边界时:
//   - model 过滤被丢掉 → 账本段返回**全部模型**,与明细段相加后统计徽标偏大
//     (审计实测 ledger WithModel(model-a) → rows=2, cost=15.00);
//   - kind 过滤同样被丢掉 → WithKind(embedding) → rows=2。
//
// usage_daily 的列只有 (user_id, model, day, …) —— **有 model、没有 kind**
// (0039:48-58)。所以两者的正确修法不同:
//   - model:真的下推过滤;
//   - kind :明确返回「不支持」(ErrUnsupportedFilter),绝不返回偏大的数字。

// TestUsageAggregateFromLedgerHonoursModelFilter 是 FIX-11 的 model 回归锁。
func TestUsageAggregateFromLedgerHonoursModelFilter(t *testing.T) {
	db, _, oldMonth := ledgerFixture(t)
	to := oldMonth.AddDate(0, 1, -1)

	// 不过滤:两个模型各一行
	all, err := UsageAggregateFromLedger(db, oldMonth, to, "model")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("rows = %+v, want 2(两个模型)", all)
	}

	// model-a:必须只剩一行,且 token 数只算 model-a
	rows, err := UsageAggregateFromLedger(db, oldMonth, to, "model", WithModel("model-a"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("WithModel(model-a) rows = %+v, want 1(修复前为 2 —— 过滤被静默忽略)", rows)
	}
	if rows[0].Label != "model-a" {
		t.Fatalf("label = %q, want model-a", rows[0].Label)
	}
	if rows[0].PromptTokens != 100 {
		t.Fatalf("tokens = %d, want 100(不得把 model-b 的 50 算进来)", rows[0].PromptTokens)
	}

	// 与明细段口径对照:同一过滤在明细路径上一直是正确的
	detail, err := UsageAggregate(db, oldMonth, to, "model", WithModel("model-a"))
	if err != nil {
		t.Fatal(err)
	}
	if len(detail) != 0 {
		// 旧分区已被删除,明细段本来就空 —— 这正是"只有账本段"的场景
		t.Fatalf("detail rows = %+v, want 0(旧分区已删)", detail)
	}
}

// TestUsageAggregateFromLedgerRejectsKindFilter 是 FIX-11 的 kind 回归锁:
// 必须显式失败,不能返回偏大的数字。
func TestUsageAggregateFromLedgerRejectsKindFilter(t *testing.T) {
	db, _, oldMonth := ledgerFixture(t)
	to := oldMonth.AddDate(0, 1, -1)

	_, err := UsageAggregateFromLedger(db, oldMonth, to, "model", WithKind("embedding"))
	if err == nil {
		t.Fatal("WithKind 在账本段必须显式失败(修复前静默忽略过滤,给出偏大数字)")
	}
	if !errors.Is(err, ErrUnsupportedFilter) {
		t.Fatalf("err = %v, want ErrUnsupportedFilter", err)
	}
	// 报错信息必须说清为什么不支持、怎么绕过(客户端原样展示)。
	if msg := err.Error(); !strings.Contains(msg, "kind") || !strings.Contains(msg, "usage_daily") {
		t.Fatalf("err message = %q, want 提到 kind 与 usage_daily", msg)
	}

	// 保留期内由**明细段**(UsageAggregate,usage 表有 kind 列)处理,
	// 不受本回归影响;而 UsageAggregateWithLedger 只在窗口确实跨过保留
	// 边界时才走账本段 —— 区间整体在保留期内仍然照常工作。
	recent := bjMonth(1)
	if _, err := UsageAggregateWithLedger(db, recent, bjDay(0), "model", WithKind("embedding")); err != nil {
		t.Fatalf("保留期内的区间必须仍支持 kind(只走明细段): %v", err)
	}
	if _, err := UsageAggregate(db, recent, bjDay(0), "model", WithKind("embedding")); err != nil {
		t.Fatalf("明细段必须支持 kind: %v", err)
	}
}

// TestUsageAggregateFromLedgerKindFilterOnEmptyLedger 是**防误伤**:
// 账本窗口里一行都没有时,kind 过滤必须返回**空结果**而不是报错。
//
// 为什么:不过滤与过滤在空集上结果相同,没有任何数字会被放大;若无条件报错,
// 一个合法的空查询(例如刚部署、尚未生成日账)就会变成 400,破坏 G9 契约
// "日志页统计与明细同口径"(既有测试
// serverauth TestAdminUsageAggregateModelKindFilter 正是这个场景)。
func TestUsageAggregateFromLedgerKindFilterOnEmptyLedger(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	// 刻意不写任何 usage/usage_daily:账本窗口为空。
	rows, err := UsageAggregateFromLedger(db, bjMonth(8), bjMonth(7), "model", WithKind("embedding"))
	if err != nil {
		t.Fatalf("空账本 + kind 不该报错(否则合法空查询变 400): %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("rows = %+v, want 空", rows)
	}
	// 端到端同样不报错。
	if _, err := UsageAggregateWithLedger(db, bjMonth(8), bjDay(0), "model", WithKind("embedding")); err != nil {
		t.Fatalf("端到端空账本 + kind 不该报错: %v", err)
	}
}

// TestUsageAggregateWithLedgerSurfacesUnsupportedKind 锁住端到端行为:
// 跨边界 + kind ⇒ 明确报错(调用方映射成 400),而不是悄悄给出偏大的徽标。
func TestUsageAggregateWithLedgerSurfacesUnsupportedKind(t *testing.T) {
	db, _, oldMonth := ledgerFixture(t)
	_, err := UsageAggregateWithLedger(db, oldMonth, bjDay(0), "model", WithKind("embedding"))
	if err == nil {
		t.Fatal("跨边界 + kind 必须报错")
	}
	if !errors.Is(err, ErrUnsupportedFilter) {
		t.Fatalf("err = %v, want ErrUnsupportedFilter", err)
	}
}

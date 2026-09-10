package serverstore

import (
	"database/sql"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// ---------------------------------------------------------------------------
// 时区安全测试夹具(2026-09-10 修复时区依赖缺陷)。
//
// 用例必须在**任意进程 TZ**(TZ=UTC / Asia/Shanghai / America/New_York …)与
// **任意 PG 会话时区**下成立,因此:
//   - 写库夹具与查询边界一律用"北京日"推出的**绝对瞬时**(fixtureAt/bjDay),
//     不再用 time.Now().Format("2006-01-02") 这类"本机日期"(本机日 ≠ 北京日
//     时必然查空:每天 8 小时窗口,CI 就在这个窗口里挂掉);
//   - 固定历史日期用 beijingWall 按北京时间解释成绝对瞬时(不是把裸字符串丢给
//     PG 按会话时区解释)。
// ---------------------------------------------------------------------------

// bjToday 返回北京日期值(今天)。
func bjToday() time.Time { return BeijingDay(time.Now()) }

// bjDay 返回"北京日(今天 - daysAgo)"的日期值,直接当 from/to 参数用。
func bjDay(daysAgo int) time.Time { return bjToday().AddDate(0, 0, -daysAgo) }

// bjMonth 返回"北京月(本月 - monthsAgo)月首"的日期值。
func bjMonth(monthsAgo int) time.Time { return BeijingMonth(time.Now()).AddDate(0, -monthsAgo, 0) }

// bjDate 把 "YYYY-MM-DD" 字面量解析为北京日期值(测试用固定历史窗口边界)。
func bjDate(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse(dateFmt, s)
	if err != nil {
		t.Fatalf("bad fixture date %q: %v", s, err)
	}
	return d
}

// fixtureAt 返回"北京日(今天 - daysAgo)的 hour:00"对应的**绝对瞬时**:
// 写库夹具与查询边界的统一构造器,与进程 TZ、PG 会话时区无关。
func fixtureAt(daysAgo, hour int) time.Time { return BeijingDayAt(bjDay(daysAgo), hour) }

// beijingWall 把 "2006-01-02 15:04:05"(或 "2006-01-02")字面量按**北京时间**
// 解释成绝对瞬时——固定历史日期的夹具用(此前是把裸字符串交给 PG 按会话时区
// 解释,会话时区一变结果就变)。
func beijingWall(t *testing.T, s string) time.Time {
	t.Helper()
	for _, layout := range []string{pgTimeFmt, dateFmt} {
		if tm, err := time.Parse(layout, s); err == nil {
			return tm.Add(-BeijingOffset) // 北京墙钟 → UTC 瞬时
		}
	}
	t.Fatalf("bad fixture time %q", s)
	return time.Time{}
}

// setCreatedAt 把用量行的 created_at 回填为**北京墙钟**字面量对应的绝对瞬时
// (timestamptz 参数绑定,与 PG 会话时区无关;分区按北京月自动建)。
func setCreatedAt(t *testing.T, db *sql.DB, id int64, ts string) {
	t.Helper()
	setCreatedAtAt(t, db, id, beijingWall(t, ts))
}

// setCreatedAtAt 把用量行的 created_at 回填为给定绝对瞬时
// (优先用 fixtureAt 构造,避免手写"本机日期")。
func setCreatedAtAt(t *testing.T, db *sql.DB, id int64, at time.Time) {
	t.Helper()
	if err := ensureUsagePartition(db, at); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE usage SET created_at = ? WHERE id = ?", at, id); err != nil {
		t.Fatal(err)
	}
}

// openTestDBWithSessionTZ 打开指向**同一个测试库**、但 PG 会话时区不同的句柄
// (同一 ?→$N rewrite 层)。用于钉死"聚合结果不依赖 PG 会话时区"。
func openTestDBWithSessionTZ(t *testing.T, db *sql.DB, tz string) *sql.DB {
	t.Helper()
	var name string
	if err := db.QueryRow("SELECT current_database()").Scan(&name); err != nil {
		t.Fatalf("current_database: %v", err)
	}
	u, err := url.Parse(PgTestDSN())
	if err != nil {
		t.Fatalf("parse test dsn: %v", err)
	}
	u.Path = "/" + name
	cfg, err := pgx.ParseConfig(u.String())
	if err != nil {
		t.Fatalf("parse pg config: %v", err)
	}
	cfg.RuntimeParams["TimeZone"] = tz
	cfg.RuntimeParams["application_name"] = "picoaide-test-session-tz"
	h := sql.OpenDB(&rewriteConnector{raw: stdlib.GetConnector(*cfg)})
	var got string
	if err := h.QueryRow("SHOW timezone").Scan(&got); err != nil {
		t.Fatalf("session-tz handle ping (%s): %v", tz, err)
	}
	if got != tz {
		t.Fatalf("session timezone = %q, want %q", got, tz)
	}
	t.Cleanup(func() { h.Close() })
	return h
}

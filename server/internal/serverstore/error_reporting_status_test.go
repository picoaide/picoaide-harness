package serverstore

import (
	"database/sql"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// 0068 迁移必须真的建出表(表名/列名与 DAO、管理端聚合接口同一契约)。
func TestErrorReportingStatusMigrationCreatesTable(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	var table string
	if err := db.QueryRow(`SELECT tablename FROM pg_tables WHERE tablename = 'client_error_reporting_status'`).Scan(&table); err != nil {
		t.Fatalf("client_error_reporting_status missing after migration: %v", err)
	}
	// schema_migrations 必须记到 0068,否则新库不会建表。
	var applied bool
	if err := db.QueryRow(`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 68)`).Scan(&applied); err != nil {
		t.Fatalf("schema_migrations probe: %v", err)
	}
	if !applied {
		t.Fatalf("migration 0068 not recorded (latest=%d)", latestMigration())
	}
	// 列契约:user_id 主键 + 六个状态列。
	for _, col := range []string{"user_id", "state", "reason", "dsn_host", "level", "release", "updated_at"} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
			WHERE table_name = 'client_error_reporting_status' AND column_name = ?`, col).Scan(&n); err != nil {
			t.Fatalf("column probe %s: %v", col, err)
		}
		if n != 1 {
			t.Fatalf("column %s missing (n=%d)", col, n)
		}
	}
}

// TestUpsertErrorReportingStatusIsIdempotent:同一用户重复上报只保留一行,
// 字段被最新一次覆盖(按 user_id 的 upsert 语义;updated_at 单调不减)。
func TestUpsertErrorReportingStatusIsIdempotent(t *testing.T) {
	db := openTestDB(t)
	uid, err := CreateUserWithPassword(db, "alice", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	if err := UpsertErrorReportingStatus(db, uid, ErrorReportingStateFailed, "DSN 非法", "glitchtip.example.com", "error", "picoaide-desktop@2.4.0"); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	first := mustListErrorReportingStatuses(t, db)
	if len(first) != 1 {
		t.Fatalf("rows after first upsert = %d, want 1", len(first))
	}
	if first[0].UserID != uid || first[0].Username != "alice" || first[0].State != ErrorReportingStateFailed {
		t.Fatalf("row mismatch: %+v", first[0])
	}

	time.Sleep(2 * time.Millisecond) // 拉开 updated_at(now() 为事务时间戳,两次 Exec 必然前进)
	if err := UpsertErrorReportingStatus(db, uid, ErrorReportingStateReady, "", "glitchtip.example.com", "warning", "picoaide-desktop@2.4.1"); err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	rows := mustListErrorReportingStatuses(t, db)
	if len(rows) != 1 {
		t.Fatalf("rows after second upsert = %d, want 1 (upsert must not insert)", len(rows))
	}
	got := rows[0]
	if got.State != ErrorReportingStateReady || got.Reason != "" || got.Level != "warning" || got.Release != "picoaide-desktop@2.4.1" {
		t.Fatalf("second upsert did not overwrite fields: %+v", got)
	}
	if got.UpdatedAt.Before(first[0].UpdatedAt) {
		t.Fatalf("updated_at went backwards: %v < %v", got.UpdatedAt, first[0].UpdatedAt)
	}

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM client_error_reporting_status WHERE user_id = ?`, uid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("raw rows = %d, want 1", n)
	}
}

// TestUpsertErrorReportingStatusBounding:客户端输入不可信 —— 超长字段按
// **rune** 截断(中文原因不得被截成半个字),非法参数不落库。
func TestUpsertErrorReportingStatusBounding(t *testing.T) {
	db := openTestDB(t)
	uid, err := CreateUserWithPassword(db, "bob", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	longReason := strings.Repeat("中", 300)
	longHost := strings.Repeat("h", 300)
	longRelease := strings.Repeat("v", 100)
	if err := UpsertErrorReportingStatus(db, uid, ErrorReportingStateFailed, longReason, longHost, "error", longRelease); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	var reason, host, release string
	if err := db.QueryRow(`SELECT reason, dsn_host, release FROM client_error_reporting_status WHERE user_id = ?`, uid).
		Scan(&reason, &host, &release); err != nil {
		t.Fatal(err)
	}
	if utf8.RuneCountInString(reason) != ErrorReportingMaxReasonRunes {
		t.Fatalf("reason runes = %d, want %d", utf8.RuneCountInString(reason), ErrorReportingMaxReasonRunes)
	}
	if !utf8.ValidString(reason) {
		t.Fatal("reason is not valid UTF-8 after truncation")
	}
	if len(host) != ErrorReportingMaxDSNHostLen {
		t.Fatalf("dsn_host len = %d, want %d", len(host), ErrorReportingMaxDSNHostLen)
	}
	if len(release) != ErrorReportingMaxReleaseLen {
		t.Fatalf("release len = %d, want %d", len(release), ErrorReportingMaxReleaseLen)
	}
	// userID <= 0 是调用方 bug:拒绝而不是写出一行无主状态。
	if err := UpsertErrorReportingStatus(db, 0, ErrorReportingStateReady, "", "", "", ""); err == nil {
		t.Fatal("upsert with userID=0 must fail")
	}
}

// TestListErrorReportingStatusesOrdersByUpdatedAt:列表按 updated_at 倒序
// (管理端"最近上报"口径),limit 收敛到 1..100。
//
// 判别力(2026-09-17 审计 S09-1):原用例按 u1→u2→u3 升序建号并升序上报,
// 于是 `ORDER BY s.user_id DESC` 单独就能给出被断言的 u3,u2,u1 —— 主排序键
// updated_at 被删掉也全绿;`limit=999` 又在 3 行表上断言 3,上限收敛(100)
// 同样没人验。现在:(a) 让 id 顺序与 updated_at 顺序**相反**;(b) 单独用
// 105 行验证 limit 收敛。
func TestListErrorReportingStatusesOrdersByUpdatedAt(t *testing.T) {
	db := openTestDB(t)
	ids := map[string]int64{}
	for _, name := range []string{"u1", "u2", "u3"} {
		uid, err := CreateUserWithPassword(db, name, "pw123456")
		if err != nil {
			t.Fatal(err)
		}
		ids[name] = uid
		if err := UpsertErrorReportingStatus(db, uid, ErrorReportingStateReady, "", name+".example.com", "error", "v1"); err != nil {
			t.Fatal(err)
		}
		// updated_at 用 now():间隔太小可能同刻,而同刻时 user_id DESC 兜底
		// 会掩盖主排序键 —— 睡 2ms 保证三行时间戳严格递增(微秒精度足够)。
		time.Sleep(2 * time.Millisecond)
	}
	// 再上报一次 u1:此时 **id 最小但 updated_at 最新**,id 顺序与时间顺序相反。
	if err := UpsertErrorReportingStatus(db, ids["u1"], ErrorReportingStateFailed, "重试", "u1.example.com", "error", "v2"); err != nil {
		t.Fatal(err)
	}
	rows := mustListErrorReportingStatuses(t, db)
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	// updated_at 倒序 ⇒ u1(最新),u3,u2;仅按 user_id DESC 会得到 u3,u2,u1。
	for i, want := range []string{"u1", "u3", "u2"} {
		if rows[i].Username != want {
			t.Fatalf("row[%d] = %s, want %s (order %v)", i, rows[i].Username, want, usernames(rows))
		}
	}
	if rows[0].State != ErrorReportingStateFailed {
		t.Fatalf("row[0].state = %s, want %s (最新一次上报必须置顶)", rows[0].State, ErrorReportingStateFailed)
	}
	// limit 收敛:<=0 → 默认 100(本用例只有 3 行)。
	if got := mustListErrorReportingStatusesLimit(t, db, 0); len(got) != 3 {
		t.Fatalf("limit=0 rows = %d, want 3 (default)", len(got))
	}
	if got := mustListErrorReportingStatusesLimit(t, db, 2); len(got) != 2 {
		t.Fatalf("limit=2 rows = %d, want 2", len(got))
	}
}

// TestListErrorReportingStatusesClampsLimit:limit > 100 收敛到 100 —— 必须
// 用**超过 100 行**的数据验证,否则 LIMIT 999 与 LIMIT 100 不可区分
// (2026-09-17 审计 S09-1)。造数据走直插:CreateUserWithPassword 每人一次
// argon2id,105 人代价不可接受。
func TestListErrorReportingStatusesClampsLimit(t *testing.T) {
	db := openTestDB(t)
	const seeded = 105
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	for i := 0; i < seeded; i++ {
		var uid int64
		if err := tx.QueryRow(`INSERT INTO users (username, source, is_admin, role, status, created_at, updated_at)
			VALUES (?, 'local', 0, 'user', 1, now(), now()) RETURNING id`, "clamp"+strconv.Itoa(i)).Scan(&uid); err != nil {
			t.Fatal(err)
		}
		// updated_at 显式递减:第 0 行最新 —— 收敛后必须恰好留下最新的 100 行。
		if _, err := tx.Exec(`INSERT INTO client_error_reporting_status (user_id, state, reason, dsn_host, level, release, updated_at)
			VALUES (?, ?, '', '', '', '', now() - (? || ' seconds')::interval)`,
			uid, ErrorReportingStateReady, strconv.Itoa(i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	clamped := mustListErrorReportingStatusesLimit(t, db, 999)
	if len(clamped) != ErrorReportingListMaxLimit {
		t.Fatalf("limit=999 rows = %d, want %d (clamped)", len(clamped), ErrorReportingListMaxLimit)
	}
	// 收敛不是"随便留 100 行":被砍掉的必须是最旧的 5 行(clamp0 最新)。
	for i, row := range clamped {
		if want := "clamp" + strconv.Itoa(i); row.Username != want {
			t.Fatalf("clamped[%d] = %s, want %s (收敛后必须保留最新的 %d 行)",
				i, row.Username, want, ErrorReportingListMaxLimit)
		}
	}
}

// TestCountErrorReportingStatuses:按 state 分组计数(管理端聚合页的状态
// 计数与 total 的来源)。
func TestCountErrorReportingStatuses(t *testing.T) {
	db := openTestDB(t)
	states := []string{
		ErrorReportingStateReady, ErrorReportingStateReady,
		ErrorReportingStateFailed, ErrorReportingStateDisabled, ErrorReportingStateIdle,
		// config_unavailable 必须**真的造一行**：只读一个没被 seed 的键拿到 0，
		// 任何实现都满足（把 SQL 改成 `WHERE state <> 'config_unavailable'`
		// 也照样绿 —— 2026-09-17 二轮审计 TQ-4）。
		ErrorReportingStateConfigUnavailable,
	}
	for i, st := range states {
		uid, err := CreateUserWithPassword(db, "cnt"+string(rune('a'+i)), "pw123456")
		if err != nil {
			t.Fatal(err)
		}
		if err := UpsertErrorReportingStatus(db, uid, st, "no config", "", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	counts, err := CountErrorReportingStatuses(db)
	if err != nil {
		t.Fatalf("CountErrorReportingStatuses: %v", err)
	}
	want := map[string]int{
		ErrorReportingStateReady:             2,
		ErrorReportingStateFailed:            1,
		ErrorReportingStateDisabled:          1,
		ErrorReportingStateIdle:              1,
		ErrorReportingStateConfigUnavailable: 1,
	}
	for st, n := range want {
		if counts[st] != n {
			t.Fatalf("counts[%s] = %d, want %d (all=%v)", st, counts[st], n, counts)
		}
	}
	// 合计必须等于 seed 行数：漏掉任一 state 的 SQL 都会在这里露出来。
	total := 0
	for _, n := range counts {
		total += n
	}
	if total != len(states) {
		t.Fatalf("counts total = %d, want %d (all=%v)", total, len(states), counts)
	}
	// 空表:计数为空 map,不报错(管理端渲染 total=0)。
	if _, err := db.Exec(`DELETE FROM client_error_reporting_status`); err != nil {
		t.Fatal(err)
	}
	empty, err := CountErrorReportingStatuses(db)
	if err != nil {
		t.Fatalf("CountErrorReportingStatuses(empty): %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("empty counts = %v, want empty", empty)
	}
}

func mustListErrorReportingStatuses(t *testing.T, db *sql.DB) []ClientErrorReportingStatus {
	t.Helper()
	return mustListErrorReportingStatusesLimit(t, db, 100)
}

func mustListErrorReportingStatusesLimit(t *testing.T, db *sql.DB, limit int) []ClientErrorReportingStatus {
	t.Helper()
	rows, err := ListErrorReportingStatuses(db, limit)
	if err != nil {
		t.Fatalf("ListErrorReportingStatuses(limit=%d): %v", limit, err)
	}
	return rows
}

func usernames(rows []ClientErrorReportingStatus) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Username)
	}
	return out
}

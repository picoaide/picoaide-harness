package main

// R8-A-3 的**装配级判据**（审计 2026-09-24，P2）：保留策略的过程事实必须出现在
// 生产路由树真正对外提供的 `/readyz` 响应体里。
//
// 为什么必须是"走生产路由树"的判据：只断言 `mergeUsageRetentionField` 这个辅助函数
// 等于只测"我写的函数是对的"——**接线**（`registerProductionRoutes` 里真的包装了
// `d.Ready`）没有任何判据，摘掉它测试照样全绿（本仓登记过的假绿形态之一）。
// 本文件因此有两个层次：
//
//  1. 单元层：字段合并的边界（200/503/非 JSON 原样透传）；
//  2. 装配层：真 PG + 真多级布局 + 真清理轮次 ⇒ `GET /readyz`（生产同一段装配代码）
//     的响应体里出现按原因分类的未回收计数与点名清单。

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestUsageRetentionReadyzFieldMergesStatus(t *testing.T) {
	// 内层替身必须用**生产同款**写法（`json.NewEncoder(...).Encode`：声明序 + 结尾
	// 换行）。R9-D R9D-10（P3）指出的正是"判据形态 ≠ 生产形态"：手写紧凑字面量时，
	// "重序列化会改键序/丢结尾换行"这类副作用在判据里结构性不可见。
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(struct {
			OK        bool   `json:"ok"`
			CheckedAt string `json:"checked_at"`
		}{OK: true, CheckedAt: "2026-09-24T00:00:00Z"})
	})
	rec := httptest.NewRecorder()
	usageRetentionReadyzHandler(inner).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应体必须是 JSON 对象: %v (%s)", err, rec.Body.String())
	}
	if _, ok := body["ok"]; !ok {
		t.Fatalf("包装后必须保留原有字段: %s", rec.Body.String())
	}
	if _, ok := body[usageRetentionField]; !ok {
		t.Fatalf("响应体必须带 %q 字段: %s", usageRetentionField, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("内层响应头必须原样保留：Cache-Control = %q", got)
	}
	if rec.Header().Get("Content-Type") == "" {
		t.Fatalf("Content-Type 必须原样保留")
	}

	// 503 必须原样透传（探针不达标时监控靠状态码分流）。
	inner503 := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"ok":false,"reasons":["磁盘余量不足"]}`)
	})
	rec2 := httptest.NewRecorder()
	usageRetentionReadyzHandler(inner503).ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec2.Code != http.StatusServiceUnavailable {
		t.Fatalf("503 必须保留，实际 %d", rec2.Code)
	}
	var body2 map[string]json.RawMessage
	if err := json.Unmarshal(rec2.Body.Bytes(), &body2); err != nil {
		t.Fatalf("503 响应体仍必须是 JSON: %v", err)
	}
	if _, ok := body2[usageRetentionField]; !ok {
		t.Fatalf("503 时同样要带 %q 字段（保留策略的状态与探针是否达标无关）", usageRetentionField)
	}

	// 非 JSON（或空）响应体：原样透传 —— 探针的既有契约优先于新增字段。
	broken := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "not-json")
	})
	rec3 := httptest.NewRecorder()
	usageRetentionReadyzHandler(broken).ServeHTTP(rec3, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec3.Body.String() != "not-json" {
		t.Fatalf("非 JSON 响应体必须原样透传，实际 %q", rec3.Body.String())
	}

	// R9-D R9D-09（P3）：包装**不得改变内层的字节形态** —— 键序保持声明序、结尾换行
	// 保留，新字段附加在末尾。判据是逐字节前缀/后缀比较，不是"能解析"（后者对
	// 键序与换行都不敏感，是典型的假绿）。
	got := rec.Body.String()
	if !strings.HasPrefix(got, `{"ok":true,"checked_at":"2026-09-24T00:00:00Z"`) {
		t.Fatalf("包装后必须保持内层的键序（声明序），实际 %q", got)
	}
	if !strings.HasSuffix(got, "}\n") {
		t.Fatalf("包装后必须保留内层的结尾换行（生产内层是 json.NewEncoder 产出），实际 %q", got)
	}
	var tail struct {
		UsageRetention *json.RawMessage `json:"usage_retention"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(got)), &tail); err != nil || tail.UsageRetention == nil {
		t.Fatalf("新字段必须仍在（追加在末尾）: %v (%q)", err, got)
	}
	// 空对象也要能合并且不产生多余逗号。
	empty := httptest.NewRecorder()
	usageRetentionReadyzHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	})).ServeHTTP(empty, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	var emptyBody map[string]json.RawMessage
	if err := json.Unmarshal(empty.Body.Bytes(), &emptyBody); err != nil {
		t.Fatalf("空对象包装后必须仍是合法 JSON: %v (%q)", err, empty.Body.String())
	}
	if _, ok := emptyBody[usageRetentionField]; !ok {
		t.Fatalf("空对象包装后必须带 %q: %q", usageRetentionField, empty.Body.String())
	}
}

// TestUsageRetentionReadyzThroughProductionRoutes 是装配级判据：真 PG + 真多级
// 布局 ⇒ 一轮清理之后，生产路由树的 `/readyz` 必须报出"有一条关系没有回收、原因是
// 深层后代"。摘掉 main.go 里的接线（`gin.WrapH(d.Ready)`）本用例必红。
func TestUsageRetentionReadyzThroughProductionRoutes(t *testing.T) {
	db := requireRealDB(t)
	r := buildRouterWithDB(t, db)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "r8readyz", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	if err := serverstore.SetSetting(db, serverstore.RetentionMonthsSetting, "2"); err != nil {
		t.Fatalf("设保留期: %v", err)
	}
	cur := serverstore.BeijingMonth(time.Now())
	// 多级布局覆盖一个**到期**月（保留期 2 个月 ⇒ bjMonth(3) 到期）。
	m := cur.AddDate(0, -3, 0)
	yearRel := fmt.Sprintf("usage_%04d", m.Year())
	leaf := "usage_" + m.Format("200601")
	dropDirectUsagePartitionsForTest(t, db)
	lo := serverstore.BeijingDayInstant(m).UTC().Format("2006-01-02 15:04:05-07")
	hi := serverstore.BeijingDayInstant(m.AddDate(0, 1, 0)).UTC().Format("2006-01-02 15:04:05-07")
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		yearRel, lo, hi)); err != nil {
		t.Fatalf("建中间父表 %s: %v", yearRel, err)
	}
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		leaf, yearRel, lo, hi)); err != nil {
		t.Fatalf("建深层叶子 %s: %v", leaf, err)
	}
	if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
		VALUES ($1, 'r8readyz', 1000, 500, 'chat', 0, $2, FALSE)`, uid, serverstore.BeijingDayAt(m, 10)); err != nil {
		t.Fatalf("写明细: %v", err)
	}
	if err := serverstore.CleanupUsageRetention(db); err != nil {
		t.Fatalf("深层后代必须只补账 + 跳过（不失败）: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK && rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /readyz status = %d（want 200/503 的 JSON 探针响应）: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		UsageRetention *struct {
			RoundNumber     int64          `json:"rounds"`
			Skipped         int            `json:"skipped"`
			SkippedByReason map[string]int `json:"skipped_by_reason"`
			Unreclaimed     []string       `json:"unreclaimed"`
		} `json:"usage_retention"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("/readyz 必须是 JSON: %v (%s)", err, rec.Body.String())
	}
	if payload.UsageRetention == nil {
		t.Fatalf("/readyz 缺少 %q 字段（保留策略零观测面）: %s", usageRetentionField, rec.Body.String())
	}
	st := payload.UsageRetention
	if st.RoundNumber < 1 {
		t.Fatalf("/readyz 的 usage_retention.rounds = %d，want >=1（清理刚跑过一轮）", st.RoundNumber)
	}
	if st.SkippedByReason["descendant"] < 1 {
		t.Fatalf("/readyz 必须报出「深层后代未回收」的计数（skipped_by_reason.descendant >= 1）；实际 %+v", st)
	}
	if len(st.Unreclaimed) == 0 || !strings.Contains(strings.Join(st.Unreclaimed, ","), leaf) {
		t.Fatalf("/readyz 的未回收清单必须点名 %s；实际 %v", leaf, st.Unreclaimed)
	}
}

// dropDirectUsagePartitionsForTest 摘掉 usage 的全部直接子分区（建中间父表前清场；
// PG 不允许区间重叠）。测试用：只做 DDL，不依赖 serverstore 内部实现。
func dropDirectUsagePartitionsForTest(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.Query(`SELECT c.relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_inherits i ON i.inhrelid = c.oid
JOIN pg_class p ON p.oid = i.inhparent
WHERE n.nspname = 'public' AND p.relname = 'usage'`)
	if err != nil {
		t.Fatalf("枚举 usage 的直接子分区: %v", err)
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		names = append(names, name)
	}
	rows.Close()
	for _, name := range names {
		if _, err := db.Exec(`ALTER TABLE usage DETACH PARTITION "` + name + `"`); err != nil {
			t.Fatalf("detach %s: %v", name, err)
		}
		if _, err := db.Exec(`DROP TABLE IF EXISTS "` + name + `"`); err != nil {
			t.Fatalf("drop %s: %v", name, err)
		}
	}
}

// TestR9D00ReadyzReportsMeteringWriteBlocked 是 R9-D R9D-00（P0）的**装配级可观测判据**：
// "当月不可写"必须能从生产路由树的 `/readyz` 读出来。
//
// 缺陷形态：`ALTER TABLE usage DETACH PARTITION usage_<YYYY>` 之后，子树里仍在保留期内
// 的同名孤儿让**每一次**计量写入失败 ⇒ 网关对每一次对话回 503 METERING_FAILED，而
// `/readyz` 的 usage_retention 全绿（rounds=N / skipped=0 / failures=0）⇒ 从任何观测面
// 都看不出全站对话已经不可用。
//
// 判据（三层都在同一个响应体里）：
//
//	write_blocked=true + write_blocked_month=当月  —— "该月写不进去"这件事本身可读；
//	write_blocked_kind 是封闭取值                —— 机器可分流（不是自由文本）；
//	write_blocked_action 非空且点名关系           —— **可执行**的运维动作随状态一起下发。
func TestR9D00ReadyzReportsMeteringWriteBlocked(t *testing.T) {
	db := requireRealDB(t)
	r := buildRouterWithDB(t, db)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "r9dreadyz", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	cur := serverstore.BeijingMonth(time.Now())
	parent := "usage_" + cur.AddDate(0, -1, 0).Format("200601")
	leaf := "usage_" + cur.Format("200601")
	dropDirectUsagePartitionsForTest(t, db)
	lo := serverstore.BeijingDayInstant(serverstore.BeijingMonth(time.Now()).AddDate(0, -1, 0)).UTC().Format("2006-01-02 15:04:05-07")
	hi := serverstore.BeijingDayInstant(serverstore.BeijingMonth(time.Now()).AddDate(0, 1, 0)).UTC().Format("2006-01-02 15:04:05-07")
	leafLo := serverstore.BeijingDayInstant(serverstore.BeijingMonth(time.Now())).UTC().Format("2006-01-02 15:04:05-07")
	leafHi := serverstore.BeijingDayInstant(serverstore.BeijingMonth(time.Now()).AddDate(0, 1, 0)).UTC().Format("2006-01-02 15:04:05-07")
	// 同名关系是**中间父表**（relkind='p'，带一个更深叶子）：服务端不替管理员拆分区树，
	// 因此不做自动领回 ⇒ 走 fail-loud 分支 ⇒ 当月写入被挡。
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		parent, lo, hi)); err != nil {
		t.Fatalf("建中间父表: %v", err)
	}
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		leaf, parent, leafLo, leafHi)); err != nil {
		t.Fatalf("建当月中间父表: %v", err)
	}
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s_sub PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		leaf, leaf, leafLo, leafHi)); err != nil {
		t.Fatalf("建更深叶子: %v", err)
	}
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + parent); err != nil {
		t.Fatalf("DETACH: %v", err)
	}
	if _, err := serverstore.RecordUsageKind(db, uid, "r9dreadyz", 1, 1, "chat"); err == nil {
		t.Fatalf("前置不成立：该形态下当月写入竟然成功")
	}

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK && rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /readyz status = %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		UsageRetention *struct {
			WriteBlocked       bool   `json:"write_blocked"`
			WriteBlockedMonth  string `json:"write_blocked_month"`
			WriteBlockedKind   string `json:"write_blocked_kind"`
			WriteBlockedAction string `json:"write_blocked_action"`
			WriteBlockedError  string `json:"write_blocked_error"`
			ConfiguredKnown    bool   `json:"configured_months_known"`
		} `json:"usage_retention"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("/readyz 必须是 JSON: %v (%s)", err, rec.Body.String())
	}
	if payload.UsageRetention == nil {
		t.Fatalf("/readyz 缺少 %q 字段: %s", usageRetentionField, rec.Body.String())
	}
	got := payload.UsageRetention
	if !got.WriteBlocked {
		t.Fatalf("当月写入被挡却报健康（这正是 P0 的「完全静默」）: %+v", got)
	}
	if got.WriteBlockedMonth != cur.Format("200601") {
		t.Fatalf("write_blocked_month = %q，want %q", got.WriteBlockedMonth, cur.Format("200601"))
	}
	if got.WriteBlockedKind != "orphan-name-collision" {
		t.Fatalf("write_blocked_kind = %q，want orphan-name-collision（机器可分流，不是自由文本）", got.WriteBlockedKind)
	}
	if !strings.Contains(got.WriteBlockedAction, leaf) || !strings.Contains(got.WriteBlockedError, leaf) {
		t.Fatalf("可执行运维动作与错误必须点名 %s: action=%q error=%q", leaf, got.WriteBlockedAction, got.WriteBlockedError)
	}
}

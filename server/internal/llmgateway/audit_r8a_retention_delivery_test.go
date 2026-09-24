package llmgateway

// 第 8 轮审计 A 泳道 **R8-A-1 / R8-A-2 / R8-A-4** 的**端到端交付判据**
// （2026-09-24；V3-B 复审指出"serverstore 返回 nil ⇒ HTTP 2xx 而不是 5xx"这一段
// 此前只有临时探针、交付树里零回归用例，本文件把它补成正式判据）。
//
// 为什么必须挂在 llmgateway 包：这一段的**唯一对外可观察量**在这里 ——
//   - `balance_settlement.go` 的 `rejectSettlementFailure`：结算失败 ⇒ 429
//     `BALANCE_EXHAUSTED` / 503 `METERING_FAILED`（非流式改状态码、流式写 SSE
//     error 事件并终止泵送）；
//   - `admin.go` 的 `PUT /api/server/admin/gateway`：`CleanupUsageRetention`
//     返回非 nil ⇒ 500「保留清理失败」（而配置其实已提交并已审计）。
// `serverstore` 侧的单元判据（`audit_r8_retention_fix_test.go`）只能证明"函数返回
// 什么"，证明不了"用户看到什么" —— 两段都要有判据。
//
// 覆盖的缺陷形态（真 PG + 真路由树 + 真上游，与生产同一段装配）：
//
//	R8-A-1  多级布局 `usage → usage_<YYYY>[p] → usage_<YYYYMM>` 覆盖**当前月** ⇒
//	        每一次计量写入的 `ensureUsagePartition` 报"期望父表 usage"⇒ 网关对
//	        **每一次对话**回 503 METERING_FAILED（fail-closed，不交付上游内容）；
//	R8-A-4  月名中间父表 `usage_<m1>[p]` 下挂着保留期内的 `usage_<m2>` ⇒ 清理的
//	        `fold-adjacent` 每轮失败 ⇒ 管理端保存保留期固定 500（配置已生效但
//	        管理员以为失败）。
//
// 判据落在**对外可观察量**上（不看内部返回值）：
//
//	I1  非流式：HTTP 200 + 上游正文真的交付 + 明细真的落进当月叶子（含 token 数）；
//	I2  流式：SSE 正文与 `[DONE]` 都到达，且**没有** METERING_FAILED 错误事件；
//	I3  管理端保存保留期：HTTP 200 + `usage.retention_months` **真的被保存** +
//	    保留期内子分区的明细一行不少。
//
// 确定性：全部同步断言（httptest 的 handler 在 `ServeHTTP` 内泵完响应），
// 无 sleep、无轮询、无负载依赖。
//
// 装配复用本包既有夹具（与其余 `audit_*_billing_test.go` 同一约定）：
// `newAuditR3Upstream`/`newAuditR3Gateway`（真 PG + 真 `RegisterRoutes` 路由树）、
// `doPost`、`auditR3Snapshot`/`checkLedgerInvariant`、`adminTestSetup`/`adminReq`。

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// r8aDropUsageDirectPartitions 摘掉 usage 的全部**直接**子分区（PG 不允许区间重叠，
// 建中间父表前必须清场）。判据只做 DDL，不依赖 serverstore 内部实现。
func r8aDropUsageDirectPartitions(t *testing.T, db *sql.DB) {
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
	if err := rows.Err(); err != nil {
		t.Fatalf("枚举 usage 的直接子分区: %v", err)
	}
	for _, name := range names {
		if _, err := db.Exec(`ALTER TABLE usage DETACH PARTITION "` + name + `"`); err != nil {
			t.Fatalf("detach %s: %v", name, err)
		}
		if _, err := db.Exec(`DROP TABLE IF EXISTS "` + name + `"`); err != nil {
			t.Fatalf("drop %s: %v", name, err)
		}
	}
}

// r8aMonthInstant 把北京日瞬时渲染成带显式偏移的字面量（DDL 用；会话时区无关）。
func r8aMonthInstant(tm time.Time) string {
	return serverstore.BeijingDayInstant(tm).UTC().Format("2006-01-02 15:04:05-07")
}

// r8aBuildMultiLevelMonth 造 `usage → usage_<YYYY>[p>[ → usage_<YYYYMM>]`，覆盖 m 的
// 北京月（withLeaf=false 时只建中间父表 —— "窗口被中间父表覆盖、月叶子缺失"的形态）。
// 返回 (中间父表名, 月叶子名)。
func r8aBuildMultiLevelMonth(t *testing.T, db *sql.DB, m time.Time, withLeaf bool) (string, string) {
	t.Helper()
	r8aDropUsageDirectPartitions(t, db)
	yearRel := fmt.Sprintf("usage_%04d", m.Year())
	leaf := "usage_" + m.Format("200601")
	yearFrom := time.Date(m.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		yearRel, r8aMonthInstant(yearFrom), r8aMonthInstant(yearFrom.AddDate(1, 0, 0)))); err != nil {
		t.Fatalf("建中间父表 %s（多级布局）: %v", yearRel, err)
	}
	if !withLeaf {
		return yearRel, leaf
	}
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		leaf, yearRel, r8aMonthInstant(m), r8aMonthInstant(m.AddDate(0, 1, 0)))); err != nil {
		t.Fatalf("建当月叶子 %s: %v", leaf, err)
	}
	return yearRel, leaf
}

// r8aUsageRelOfRows 返回该用户最新一条明细落在那张关系上（tableoid 事实，不走产品判据）。
func r8aUsageRelOfRows(t *testing.T, db *sql.DB, userID int64) string {
	t.Helper()
	var rel string
	if err := db.QueryRow(`SELECT tableoid::regclass::text FROM usage WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
		userID).Scan(&rel); err != nil {
		t.Fatalf("读新写入的明细所在关系: %v", err)
	}
	return rel
}

// TestR8ARetentionMultiLevelLayoutGatewayDelivers 是 R8-A-1 的端到端判据（非流式）。
//
// 修复前：多级布局覆盖当月 ⇒ 结算落账失败 ⇒ **503 METERING_FAILED**（fail-closed，
// 不交付上游内容）⇒ 当月每一次对话都失败。
// 修复后：写路径自愈（叶子存在 ⇒ 直接就绪；叶子缺失 ⇒ 建在覆盖窗口的中间父表下），
// 请求 200 交付，明细落进当月叶子。
func TestR8ARetentionMultiLevelLayoutGatewayDelivers(t *testing.T) {
	const marker = "R8A_DELIVERED"

	cases := []struct {
		name     string
		withLeaf bool
	}{
		{"leaf_exists", true},
		{"leaf_missing_write_path_self_heals", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u := newAuditR3Upstream(t)
			u.setNon(`{"id":"r8a","object":"chat.completion","choices":[{"message":{"content":"` + marker + `"}}],` +
				`"usage":{"prompt_tokens":1000,"completion_tokens":500}}`)
			r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 0)
			yearRel, leaf := r8aBuildMultiLevelMonth(t, db, serverstore.BeijingMonth(time.Now()), tc.withLeaf)

			w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)

			// I1-a 状态码 + 错误码：必须是 200，且**不能**是结算失败信封。
			if w.Code != http.StatusOK {
				t.Fatalf("多级布局覆盖当月时请求必须成功（修复前：503 %s，当月对话全不可用）: status=%d body=%s",
					r3MeteringFailedCode, w.Code, bodyHead(w))
			}
			if strings.Contains(w.Body.String(), r3MeteringFailedCode) {
				t.Fatalf("响应体不得出现 %s: %s", r3MeteringFailedCode, bodyHead(w))
			}
			// I1-b 真的交付了上游内容。
			if !strings.Contains(w.Body.String(), marker) {
				t.Fatalf("响应体没有交付上游内容: %s", bodyHead(w))
			}
			// I1-c 明细真的落进当月叶子（写路径自愈的物理证据）。
			if got := r8aUsageRelOfRows(t, db, uid); got != leaf {
				t.Fatalf("明细落在 %s，want %s（叶子缺失时写路径必须把它建在 %s 下）", got, leaf, yearRel)
			}
			// I1-d 结算痕迹齐全 + 余额账本不变量。
			s := auditR3Snapshot(t, db, uid)
			if s.usageRows != 1 || s.tokens != 1500 {
				t.Fatalf("usage 落账 = (%d 行, %d tokens)，want (1, 1500)", s.usageRows, s.tokens)
			}
			checkLedgerInvariant(t, s, "R8A-1 "+tc.name)
			// I1-e 叶子缺失那一档：必须挂在**中间父表**下（挂 usage 下会 42P17 overlap），
			// 而且自愈是**永久**的 —— 第二次对话同样必须 200（判据是"当月每一次对话
			// 都可用"，不是"第一次恰好能过"；只判一次会让"建完叶子又判它不就绪"的实现
			// 蒙混过关）。
			if !tc.withLeaf {
				var parent string
				if err := db.QueryRow(`SELECT p.relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
WHERE c.relname = $1 AND n.nspname = 'public'`, leaf).Scan(&parent); err != nil {
					t.Fatalf("读自愈后 %s 的直接父表: %v", leaf, err)
				}
				if parent != yearRel {
					t.Fatalf("自愈后叶子的直接父表 = %q，want %q", parent, yearRel)
				}
				if u.callCount() != 1 {
					t.Fatalf("第二次请求之前上游调用数 = %d，want 1", u.callCount())
				}
				w2 := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
				if w2.Code != http.StatusOK || !strings.Contains(w2.Body.String(), marker) {
					t.Fatalf("自愈后第二次对话也必须成功（自愈必须是永久的，不是「第一次恰好过」）: status=%d body=%s",
						w2.Code, bodyHead(w2))
				}
				if got := r8aUsageRelOfRows(t, db, uid); got != leaf {
					t.Fatalf("第二次对话的明细落在 %s，want %s", got, leaf)
				}
				s2 := auditR3Snapshot(t, db, uid)
				if s2.usageRows != 2 || s2.tokens != 3000 {
					t.Fatalf("两次对话的 usage 落账 = (%d 行, %d tokens)，want (2, 3000)", s2.usageRows, s2.tokens)
				}
				checkLedgerInvariant(t, s2, "R8A-1 "+tc.name+" second-turn")
			}
		})
	}
}

// TestR8ARetentionMultiLevelLayoutGatewayDeliversStream 是同一条缺陷的**流式**形态：
// SSE 头已经发出、状态码改不了，所以修复前的唯一表达是"写一条 METERING_FAILED
// error 事件并终止泵送" ⇒ 用户拿到半截回答。修复后必须跑完整条流（正文 + [DONE]）。
func TestR8ARetentionMultiLevelLayoutGatewayDeliversStream(t *testing.T) {
	const (
		before = "R8A_STREAM_BEFORE"
		after  = "R8A_STREAM_AFTER"
	)
	u := newAuditR3Upstream(t)
	u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"" + before + "\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":500}}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"" + after + "\"}}]}\n\n" +
		"data: [DONE]\n\n")
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 0)
	_, leaf := r8aBuildMultiLevelMonth(t, db, serverstore.BeijingMonth(time.Now()), true)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	body := w.Body.String()

	// I2-a 不得出现结算失败事件（修复前：正文后紧跟 METERING_FAILED，且没有 [DONE]）。
	if strings.Contains(body, r3MeteringFailedCode) {
		t.Fatalf("流式结算不得失败（修复前：写 SSE error 事件并终止泵送）: %s", bodyHead(w))
	}
	// I2-b 整条流跑完：usage 之后的内容仍在、[DONE] 到达。
	if !strings.Contains(body, after) || !strings.Contains(body, "[DONE]") {
		t.Fatalf("流式响应必须完整交付（含 usage 之后的内容与 [DONE]）: %s", bodyHead(w))
	}
	if !strings.Contains(body, before) {
		t.Fatalf("流式响应缺少 usage 之前的内容: %s", bodyHead(w))
	}
	// I2-c 明细落进当月叶子 + 计费痕迹。
	if got := r8aUsageRelOfRows(t, db, uid); got != leaf {
		t.Fatalf("流式明细落在 %s，want %s", got, leaf)
	}
	s := auditR3Snapshot(t, db, uid)
	if s.usageRows != 1 || s.tokens != 1500 {
		t.Fatalf("流式 usage 落账 = (%d 行, %d tokens)，want (1, 1500)", s.usageRows, s.tokens)
	}
	checkLedgerInvariant(t, s, "R8A-1 stream")
}

// TestR8AAdminRetentionSaveSucceedsUnderMonthNamedMiddleParent 是 R8-A-2 / R8-A-4 的
// 端到端判据：**管理端保存保留期**不得因为"某条关系没被回收"而回 500。
//
// 修复前：`usage_<m1>[p]` 下的 `usage_<m2>` 落在保留期内 ⇒ 清理的 fold-adjacent
// 每轮失败 ⇒ `CleanupUsageRetention` 非 nil ⇒ `PUT /api/server/admin/gateway`
// 回 **500「保留清理失败」**，而 retention_months 其实**已经提交并已审计**
// （管理员据此以为没保存成功、反复重试；调度器每轮告警）。
func TestR8AAdminRetentionSaveSucceedsUnderMonthNamedMiddleParent(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	cur := serverstore.BeijingMonth(time.Now())
	m1 := cur.AddDate(0, -3, 0) // 名字月（保留期 2 个月 ⇒ 到期）
	m2 := cur.AddDate(0, -2, 0) // 子分区月（保留期内）
	r8aDropUsageDirectPartitions(t, db)

	parentRel := "usage_" + m1.Format("200601")
	childRel := "usage_" + m2.Format("200601")
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		parentRel, r8aMonthInstant(m1), r8aMonthInstant(m2.AddDate(0, 1, 0)))); err != nil {
		t.Fatalf("建月名中间父表 %s: %v", parentRel, err)
	}
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		childRel, parentRel, r8aMonthInstant(m2), r8aMonthInstant(m2.AddDate(0, 1, 0)))); err != nil {
		t.Fatalf("建子分区 %s: %v", childRel, err)
	}
	// 保留期内的那一行：拆树会连它一起删，所以清理必须"保留但不回收"。
	if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
		VALUES ((SELECT id FROM users LIMIT 1), 'r8a-admin', 1000, 500, 'chat', 7.5, $1, FALSE)`,
		serverstore.BeijingDayAt(m2, 10)); err != nil {
		t.Fatalf("写保留期内的明细: %v", err)
	}

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"retention_months":"2"}`, hdr)

	// I3-a 状态码 + 错误信封：修复前是 500「保留清理失败」。
	if w.Code != http.StatusOK {
		t.Fatalf("保存保留期必须 200（修复前：清理因 fold-adjacent 返回非 nil ⇒ 500「保留清理失败」，"+
			"而配置其实已提交并已审计）: status=%d body=%s", w.Code, bodyHead(w))
	}
	if strings.Contains(w.Body.String(), "保留清理失败") {
		t.Fatalf("响应体不得出现「保留清理失败」: %s", bodyHead(w))
	}
	// I3-b 保留期**真的被保存**（不只是状态码好看）。
	if n, err := serverstore.EffectiveRetentionMonths(db); err != nil || n != 2 {
		t.Fatalf("保存后 EffectiveRetentionMonths = %d/%v，want 2", n, err)
	}
	// I3-c 保留期内的子分区与其明细一行不少（"保留但不回收"的物理证据）。
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM ` + childRel).Scan(&rows); err != nil {
		t.Fatalf("读子分区 %s: %v", childRel, err)
	}
	if rows != 1 {
		t.Fatalf("保留期内的子分区 %s 行数 = %d，want 1（不得连它一起删）", childRel, rows)
	}
	// I3-d 该月读数仍然正确（明细是事实源：窗口聚合 = 7.5）。
	agg := r6SumCostViaAPI(t, db, m2)
	if agg < 7.49 || agg > 7.51 {
		t.Fatalf("保留期内 %s 的窗口聚合 = %.4f，want 7.5（明细被删或聚合口径分叉）", m2.Format("200601"), agg)
	}
}

// r6SumCostViaAPI 求和某北京月的窗口聚合（走生产聚合入口 UsageAggregateWithLedger）。
func r6SumCostViaAPI(t *testing.T, db *sql.DB, m time.Time) float64 {
	t.Helper()
	rows, err := serverstore.UsageAggregateWithLedger(db, m, m.AddDate(0, 1, -1), "model")
	if err != nil {
		t.Fatalf("UsageAggregateWithLedger(%s): %v", m.Format("200601"), err)
	}
	var sum float64
	for _, row := range rows {
		sum += row.Cost
	}
	return sum
}

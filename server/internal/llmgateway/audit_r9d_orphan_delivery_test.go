package llmgateway

// R9-D P0（R9D-00）的**端到端交付判据**：管理员执行受支持的运维动作
// `ALTER TABLE usage DETACH PARTITION usage_<YYYY>`（把整株子树摘下来）之后，
// 网关的**每一次对话**都必须照常交付。
//
// 为什么必须挂在 llmgateway 包：这一段的唯一对外可观察量在这里 ——
// `balance_settlement.go` 的 `rejectSettlementFailure`（结算失败 ⇒ 503
// `METERING_FAILED`，fail-closed 不交付上游内容）。serverstore 侧的单元判据只能
// 证明"函数返回什么"，证明不了"用户看到什么"。
//
// 修复前（真实复现，见 temp/r9/F-server3/EVIDENCE.md 引用的原始输出）：
//
//	DETACH 后第 1 次对话（非流式）：status=503 body={"error":{"code":"METERING_FAILED",…}}
//	DETACH 后第 2 次对话（非流式）：status=503 body={"error":{"code":"METERING_FAILED",…}}
//	DETACH 后流式对话：status=503 body={"error":{"code":"METERING_FAILED",…}}
//	第 1/2/3 轮清理: err=<nil> cleared=0 skipped=0 reasons=map[] failures=0
//
// 修复后：写路径把同名孤儿领回 usage 下（DETACH + ATTACH 同一事务），请求 200、
// 上游内容真的交付、明细落在当月分区上，且**第二次**对话同样成功（自愈是永久的）。
//
// 判据落在对外可观察量上：状态码 + 上游内容 + 明细落点（tableoid 事实）+
// 计费痕迹；不读任何内部返回值。

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestR9D00DetachedOrphanGatewayDelivers 是 P0 的端到端判据（非流式）。
func TestR9D00DetachedOrphanGatewayDelivers(t *testing.T) {
	const marker = "R9D00_DELIVERED"
	u := newAuditR3Upstream(t)
	u.setNon(`{"id":"r9d00","object":"chat.completion","choices":[{"message":{"content":"` + marker + `"}}],` +
		`"usage":{"prompt_tokens":1000,"completion_tokens":500}}`)
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 0)

	now := serverstore.BeijingMonth(time.Now())
	prev := now.AddDate(0, -1, 0)
	parent := "usage_" + prev.Format("200601")
	leaf := "usage_" + now.Format("200601")
	r8aDropUsageDirectPartitions(t, db)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		parent, r8aMonthInstant(prev), r8aMonthInstant(now.AddDate(0, 1, 0)))); err != nil {
		t.Fatalf("建中间父表 %s: %v", parent, err)
	}
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		leaf, parent, r8aMonthInstant(now), r8aMonthInstant(now.AddDate(0, 1, 0)))); err != nil {
		t.Fatalf("建当月叶子 %s: %v", leaf, err)
	}

	// ① DETACH 之前：200 + 明细落进当月叶子。
	wBefore := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
	if wBefore.Code != http.StatusOK {
		t.Fatalf("前置不成立：DETACH 之前请求就失败: %d %s", wBefore.Code, bodyHead(wBefore))
	}
	if got := r8aUsageRelOfRows(t, db, uid); got != leaf {
		t.Fatalf("DETACH 前明细落在 %s，want %s", got, leaf)
	}
	// ② 管理员把中间父表整株摘下来（本仓注释把该操作当成受支持状态）。
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + parent); err != nil {
		t.Fatalf("DETACH %s: %v", parent, err)
	}

	// ③ 当月每一次对话：必须 200 且真的交付上游内容（修复前：503 METERING_FAILED）。
	for i := 1; i <= 2; i++ {
		w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("第 %d 次对话必须成功（修复前：%s，当月每一次对话都不可用）: status=%d body=%s",
				i, r3MeteringFailedCode, w.Code, bodyHead(w))
		}
		if strings.Contains(w.Body.String(), r3MeteringFailedCode) {
			t.Fatalf("第 %d 次对话响应体不得出现 %s: %s", i, r3MeteringFailedCode, bodyHead(w))
		}
		if !strings.Contains(w.Body.String(), marker) {
			t.Fatalf("第 %d 次对话没有交付上游内容: %s", i, bodyHead(w))
		}
		if got := r8aUsageRelOfRows(t, db, uid); got != leaf {
			t.Fatalf("第 %d 次对话的明细落在 %s，want %s（领回之后应当落回当月分区）", i, got, leaf)
		}
	}
	// ④ 三次落账齐全 + 余额账本不变量。
	s := auditR3Snapshot(t, db, uid)
	if s.usageRows != 3 || s.tokens != 4500 {
		t.Fatalf("usage 落账 = (%d 行, %d tokens)，want (3, 4500)", s.usageRows, s.tokens)
	}
	checkLedgerInvariant(t, s, "R9D-00 detached orphan")
	// ⑤ 没有任何"当月不可写"的阻塞状态残留。
	if st := serverstore.CurrentUsageRetentionStatus(); st.WriteBlocked {
		t.Fatalf("自愈成功却报了 write_blocked: %+v", st)
	}
}

// TestR9D00DetachedOrphanGatewayDeliversStream 是同一条缺陷的**流式**形态：
// pending 行在**调用上游之前**插入 ⇒ 修复前流式请求根本打不到上游就以 SSE error
// 终止；修复后必须跑完整条流（正文 + [DONE]）。
func TestR9D00DetachedOrphanGatewayDeliversStream(t *testing.T) {
	const (
		before = "R9D00_STREAM_BEFORE"
		after  = "R9D00_STREAM_AFTER"
	)
	u := newAuditR3Upstream(t)
	u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"" + before + "\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":500}}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"" + after + "\"}}]}\n\n" +
		"data: [DONE]\n\n")
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 0)

	now := serverstore.BeijingMonth(time.Now())
	prev := now.AddDate(0, -1, 0)
	parent := "usage_" + prev.Format("200601")
	leaf := "usage_" + now.Format("200601")
	r8aDropUsageDirectPartitions(t, db)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		parent, r8aMonthInstant(prev), r8aMonthInstant(now.AddDate(0, 1, 0)))); err != nil {
		t.Fatalf("建中间父表 %s: %v", parent, err)
	}
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		leaf, parent, r8aMonthInstant(now), r8aMonthInstant(now.AddDate(0, 1, 0)))); err != nil {
		t.Fatalf("建当月叶子 %s: %v", leaf, err)
	}
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + parent); err != nil {
		t.Fatalf("DETACH %s: %v", parent, err)
	}

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	body := w.Body.String()
	if strings.Contains(body, r3MeteringFailedCode) {
		t.Fatalf("流式结算不得失败（修复前：SSE error 事件 + 终止泵送）: %s", bodyHead(w))
	}
	if !strings.Contains(body, before) || !strings.Contains(body, after) || !strings.Contains(body, "[DONE]") {
		t.Fatalf("流式响应必须完整交付（正文 + [DONE]）: %s", bodyHead(w))
	}
	if got := r8aUsageRelOfRows(t, db, uid); got != leaf {
		t.Fatalf("流式明细落在 %s，want %s", got, leaf)
	}
	s := auditR3Snapshot(t, db, uid)
	if s.usageRows != 1 || s.tokens != 1500 {
		t.Fatalf("流式 usage 落账 = (%d 行, %d tokens)，want (1, 1500)", s.usageRows, s.tokens)
	}
}

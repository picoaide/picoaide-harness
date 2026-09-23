package llmgateway

// R5-A-12 的回收器级判据（审计 2026-09-23，P1）：**一个永久失败行不得让更晚的文件
// 永不回收**。
//
// 缺陷形态：批次 = `ORDER BY expires_at ASC LIMIT 500` + 失败即归还认领 ⇒ ≥批次上限
// 的永久失败行（典型：上游换 key 后旧对象 DELETE 返回 403）把每一轮占满，更晚过期的
// 文件永远进不了候选，上游共享配额单调泄漏。修法 = 候选按尝试次数（`reap_gen`）分层
// 排序（从未失败的行永远优先）+ 达到阈值的行进入可观测的"人工处置"口径。
//
// 判据用**小批次**（limit=3）构造同一个形态：批次上限是参数，形态与 501/500 等价，
// 但一轮只发 3 个 HTTP 请求。

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestReaperProgressesPastPermanentlyFailingHead(t *testing.T) {
	resetBodyParseGate(t)
	gw, up, api := lane2Reaper(t, "deepseek-official")
	// 上游：stuck-* 恒 403（永久失败），其余 DELETE 成功。
	up.respond = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			if strings.Contains(r.URL.Path, "file-stuck-") {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file-x"}`))
	}

	// 3 条永久失败行（更旧）+ 1 条健康行（更新）⇒ 批次上限 3 时旧实现下健康行永不进批次。
	const batch = 3
	for i := 0; i < batch; i++ {
		lane2ExpiredRow(t, gw, fmt.Sprintf("file-stuck-%d", i), gw.uidA, 10*24*time.Hour)
	}
	const healthy = "file-healthy"
	lane2ExpiredRow(t, gw, healthy, gw.uidA, 5*24*time.Hour)

	// 第一轮：批次被最旧的失败行占满（这是现实形态，不是缺陷 —— 缺陷在第二轮之后）。
	deleted, failed := api.ReapExpiredGatewayFiles(batch)
	if deleted != 0 || failed != batch {
		t.Fatalf("第一轮 = %d/%d, want 0/%d", deleted, failed, batch)
	}
	if !lane2RowExists(t, gw, healthy) {
		t.Fatal("第一轮不该动到更晚过期的健康行")
	}

	// 第二轮：失败行的尝试次数已经 +1，健康行（从未失败）必须排到最前并被真正回收。
	deleted, failed = api.ReapExpiredGatewayFiles(batch)
	if deleted != 1 {
		t.Fatalf("永久失败行占满批次 ⇒ 更晚的健康文件永不被回收（R5-A-12 队头阻塞）："+
			"第二轮 deleted=%d failed=%d", deleted, failed)
	}
	if lane2RowExists(t, gw, healthy) {
		t.Fatal("健康行被上游成功删除后必须清掉台账行")
	}
	var gen int64
	if err := gw.db.QueryRow(`SELECT reap_gen FROM gateway_files WHERE file_id = 'file-stuck-0'`).Scan(&gen); err != nil {
		t.Fatal(err)
	}
	if gen != 2 {
		t.Fatalf("失败行的尝试次数必须每轮 +1（gen=%d, want 2）", gen)
	}

	// 持续失败的行必须进入"人工处置"的可观测口径，而不是只在日志里刷 failed 计数。
	for round := 0; round < serverstore.GatewayFileReapStuckThreshold; round++ {
		api.ReapExpiredGatewayFiles(batch)
	}
	bl, err := serverstore.GatewayFileReapBacklogStats(gw.db)
	if err != nil {
		t.Fatal(err)
	}
	if bl.Stuck != batch {
		t.Fatalf("反复失败的行数 = %d, want %d（回收不动的对象必须被点名）", bl.Stuck, batch)
	}
	if bl.MaxAttempts < serverstore.GatewayFileReapStuckThreshold {
		t.Fatalf("MaxAttempts = %d, want >= %d", bl.MaxAttempts, serverstore.GatewayFileReapStuckThreshold)
	}
	if len(bl.StuckSample) == 0 {
		t.Fatal("需要人工处置的行必须给出文件 id 样例（只有计数无法处置）")
	}
}

// TestReaperKeepsLedgerRowForPermanentlyFailingObject：修法不得回退既有语义 ——
// 失败行仍然**保留**（清理责任的唯一凭据），只是不再阻塞批次。
func TestReaperKeepsLedgerRowForPermanentlyFailingObject(t *testing.T) {
	resetBodyParseGate(t)
	gw, up, api := lane2Reaper(t, "deepseek-official")
	up.respond = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file-x"}`))
	}
	lane2ExpiredRow(t, gw, "file-perm-fail", gw.uidA, 10*24*time.Hour)
	for i := 0; i < 3; i++ {
		deleted, failed := api.ReapExpiredGatewayFiles(0)
		if deleted != 0 || failed != 1 {
			t.Fatalf("第 %d 轮 = %d/%d, want 0/1（失败行保留 + 下轮重试）", i+1, deleted, failed)
		}
		if !lane2RowExists(t, gw, "file-perm-fail") {
			t.Fatal("上游删除失败必须保留台账行（否则对象再无凭据 = 配额静默泄漏）")
		}
	}
}

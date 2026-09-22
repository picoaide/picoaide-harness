package llmgateway

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 网关文件回收器：M6（回收失败保留行）+ 写回语义 + 无上游时不规范化
// ---------------------------------------------------------------------------

// lane2Reaper 是回收器用例的固定装置：假上游 + 网关 + 最小 API。
func lane2Reaper(t *testing.T, providerName string) (*filesGateway, *fakeFilesUpstream, *API) {
	t.Helper()
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, providerName)
	return gw, up, &API{DB: gw.db, client: &http.Client{}}
}

// lane2ExpiredRow 写一行已过期的归属（带 size_bytes 与可控的 created_at）。
func lane2ExpiredRow(t *testing.T, gw *filesGateway, id string, uid int64, aged time.Duration) time.Time {
	t.Helper()
	past := time.Now().Add(-time.Minute).Truncate(time.Microsecond)
	if err := serverstore.RecordGatewayFileSize(gw.db, id, uid, &past, 4242); err != nil {
		t.Fatal(err)
	}
	if _, err := gw.db.Exec(`UPDATE gateway_files SET created_at = ? WHERE file_id = ?`,
		time.Now().Add(-aged), id); err != nil {
		t.Fatal(err)
	}
	return past
}

func lane2RowExists(t *testing.T, gw *filesGateway, id string) bool {
	t.Helper()
	var one int
	switch err := gw.db.QueryRow(`SELECT 1 FROM gateway_files WHERE file_id = ?`, id).Scan(&one); {
	case errors.Is(err, sql.ErrNoRows):
		return false
	case err != nil:
		t.Fatal(err)
	}
	return true
}

func lane2RowExpiry(t *testing.T, gw *filesGateway, id string) (expires *time.Time, createdAt time.Time, size int64) {
	t.Helper()
	if err := gw.db.QueryRow(`SELECT expires_at, created_at, size_bytes FROM gateway_files WHERE file_id = ?`, id).
		Scan(&expires, &createdAt, &size); err != nil {
		t.Fatal(err)
	}
	return expires, createdAt, size
}

// TestFilesReaperRowRetentionByUpstreamOutcome（M6）：上游 5xx / 网络错误 ⇒ **保留行**
// （下一轮重试），404/410/2xx ⇒ 视为成功并清行。保留时连快照字段一起保住。
func TestFilesReaperRowRetentionByUpstreamOutcome(t *testing.T) {
	const aged = 10 * 24 * time.Hour

	t.Run("上游5xx保留行", func(t *testing.T) {
		resetBodyParseGate(t)
		gw, up, api := lane2Reaper(t, "deepseek-official")
		var failing atomic.Bool
		failing.Store(true)
		up.respond = func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodDelete {
				if failing.Load() {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				w.WriteHeader(http.StatusOK)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"file-x"}`))
		}
		past := lane2ExpiredRow(t, gw, "file-5xx", gw.uidA, aged)

		deleted, failed := api.ReapExpiredGatewayFiles(0)
		if deleted != 0 || failed != 1 {
			t.Fatalf("reap = %d/%d, want 0/1", deleted, failed)
		}
		if !lane2RowExists(t, gw, "file-5xx") {
			t.Fatal("上游 5xx 后必须写回台账行（行是清理责任的唯一凭据）")
		}
		expires, created, size := lane2RowExpiry(t, gw, "file-5xx")
		if expires == nil || expires.Sub(past).Abs() > time.Millisecond {
			t.Fatalf("写回的过期时间不对: %v want %v", expires, past)
		}
		if age := time.Since(created); age < aged-time.Minute {
			t.Fatalf("写回丢了原始 created_at（实测只有 %v）", age)
		}
		if size != 4242 {
			t.Fatalf("写回丢了 size_bytes: %d", size)
		}
		// 上游恢复后下一轮能清掉（幂等重试）。
		failing.Store(false)
		if deleted, failed := api.ReapExpiredGatewayFiles(0); deleted != 1 || failed != 0 {
			t.Fatalf("第二轮 = %d/%d, want 1/0", deleted, failed)
		}
		if lane2RowExists(t, gw, "file-5xx") {
			t.Fatal("成功删除后应清行")
		}
	})

	t.Run("网络错误保留行", func(t *testing.T) {
		resetBodyParseGate(t)
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		deadAddr := "http://" + l.Addr().String()
		_ = l.Close()
		gw := newFilesGateway(t, deadAddr, "deepseek-official")
		api := &API{DB: gw.db, client: &http.Client{}}

		lane2ExpiredRow(t, gw, "file-net", gw.uidA, aged)
		deleted, failed := api.ReapExpiredGatewayFiles(0)
		if deleted != 0 || failed != 1 {
			t.Fatalf("reap = %d/%d, want 0/1", deleted, failed)
		}
		if !lane2RowExists(t, gw, "file-net") {
			t.Fatal("网络错误后必须写回台账行")
		}
	})

	for _, tc := range []struct {
		name   string
		status int
	}{
		{"上游404清行", http.StatusNotFound},
		{"上游410清行", http.StatusGone},
		{"上游200清行", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetBodyParseGate(t)
			gw, up, api := lane2Reaper(t, "deepseek-official")
			status := tc.status
			up.respond = func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodDelete {
					w.WriteHeader(status)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"id":"file-x"}`))
			}
			lane2ExpiredRow(t, gw, "file-gone", gw.uidA, aged)
			deleted, failed := api.ReapExpiredGatewayFiles(0)
			if deleted != 1 || failed != 0 {
				t.Fatalf("reap = %d/%d, want 1/0", deleted, failed)
			}
			if lane2RowExists(t, gw, "file-gone") {
				t.Fatal("视为成功的状态码必须清掉台账行")
			}
		})
	}
}

// TestFilesReaperRestoreDoesNotClobberFreshRegistration（N7）：写回快照时必须
// **只补回缺失的行** —— 认领与写回之间发生的并发上传（上游按内容去重会把同一个 id
// 再发给上传者）登记的是**活行**，旧实现（RecordGatewayFileSize）对同一 user_id
// 无条件覆盖，把未来的过期时间改回过去：那份活文件随即被判 404、下一轮还会被删。
func TestFilesReaperRestoreDoesNotClobberFreshRegistration(t *testing.T) {
	resetBodyParseGate(t)
	gw, up, api := lane2Reaper(t, "deepseek-official")
	future := time.Now().Add(6 * time.Hour)
	up.respond = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			// 模拟"删除请求在飞时，同一个 id 被重新登记"（同一员工、未来过期）。
			if err := serverstore.RecordGatewayFile(gw.db, "file-refresh", gw.uidA, &future); err != nil {
				t.Errorf("re-register: %v", err)
			}
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file-refresh"}`))
	}
	lane2ExpiredRow(t, gw, "file-refresh", gw.uidA, 10*24*time.Hour)

	if deleted, failed := api.ReapExpiredGatewayFiles(0); deleted != 0 || failed != 1 {
		t.Fatalf("reap = %d/%d, want 0/1", deleted, failed)
	}
	if !lane2RowExists(t, gw, "file-refresh") {
		t.Fatal("重新登记的行被写回逻辑弄丢了")
	}
	expires, _, _ := lane2RowExpiry(t, gw, "file-refresh")
	if expires == nil || !expires.After(time.Now()) {
		t.Fatalf("写回把**活行**的过期时间改回了过去: %v（该文件会被判 404 并在下一轮被误删）", expires)
	}
	if owned, err := serverstore.GatewayFileOwnedBy(gw.db, "file-refresh", gw.uidA); err != nil || !owned {
		t.Fatalf("重新登记后归属必须仍然有效: owned=%v err=%v", owned, err)
	}
}

// TestFilesReaperBoundedByDeleteTimeout：上游接受连接但不回响应头时，回收器不能永久
// 挂住（只有一条协程 ⇒ 一次挂死等于整个自动回收停摆）。
func TestFilesReaperBoundedByDeleteTimeout(t *testing.T) {
	resetBodyParseGate(t)
	gw, up, api := lane2Reaper(t, "deepseek-official")
	// 上游接受连接但**迟迟不回响应头**（8s）——没有删除预算时会一直等到它开口。
	const hang = 8 * time.Second
	up.respond = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			select {
			case <-time.After(hang):
			case <-r.Context().Done():
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file-x"}`))
	}

	prev := fileDeleteTimeout
	fileDeleteTimeout = 200 * time.Millisecond
	t.Cleanup(func() { fileDeleteTimeout = prev })

	lane2ExpiredRow(t, gw, "file-hang", gw.uidA, 10*24*time.Hour)
	start := time.Now()
	deleted, failed := api.ReapExpiredGatewayFiles(0)
	elapsed := time.Since(start)

	if elapsed > 3*time.Second {
		t.Fatalf("回收器被挂死的上游拖住了 %v（缺删除预算，变异：去掉 context.WithTimeout 即红）", elapsed)
	}
	if deleted != 0 || failed != 1 {
		t.Fatalf("reap = %d/%d, want 0/1", deleted, failed)
	}
	if !lane2RowExists(t, gw, "file-hang") {
		t.Fatal("删除未确认时必须保留台账行")
	}
}

// TestFilesReaperDropsUnusableLedgerID：形状非法的台账行拼不出合法上游 URL，
// 必须就地丢弃（否则每轮挤占一个批次位、把管理员列表变成永久幽灵），
// 且不得影响同一批里的正常行。
func TestFilesReaperDropsUnusableLedgerID(t *testing.T) {
	resetBodyParseGate(t)
	gw, up, api := lane2Reaper(t, "deepseek-official")
	lane2ExpiredRow(t, gw, "bad.id/../escape", gw.uidA, 10*24*time.Hour)
	// 过期时间更晚 ⇒ 排后面：前一行若卡住批次，这一行就清不掉。
	later := time.Now().Add(-30 * time.Second)
	if err := serverstore.RecordGatewayFile(gw.db, "file-ok", gw.uidA, &later); err != nil {
		t.Fatal(err)
	}

	deleted, failed := api.ReapExpiredGatewayFiles(0)
	if deleted != 1 || failed != 0 {
		t.Fatalf("reap = %d/%d, want 1/0", deleted, failed)
	}
	if lane2RowExists(t, gw, "bad.id/../escape") {
		t.Fatal("形状非法的行必须被丢弃")
	}
	if lane2RowExists(t, gw, "file-ok") {
		t.Fatal("正常行被非法行挡住了（批次饥饿）")
	}
	if up.hits.Load() != 1 {
		t.Fatalf("上游调用次数 = %d, want 1（非法 id 不得进上游 URL）", up.hits.Load())
	}
	if got, _ := up.path.Load().(string); got != "/files/file-ok" {
		t.Fatalf("上游路径 = %q，非法 id 进了 URL", got)
	}
}

// TestFilesReaperSkipsNormalizeWhenUpstreamMissing（N6）：上游不可用时**不得**先做
// 存量永久行的规范化 —— 把删不掉的行标成"已过期"只会让配额泄漏变成隐身的
// （管理端看起来已处理，对象还在）。
func TestFilesReaperSkipsNormalizeWhenUpstreamMissing(t *testing.T) {
	resetBodyParseGate(t)
	gw, up, api := lane2Reaper(t, "some-other-vendor") // 非 deepseek ⇒ 无可用上游
	if err := serverstore.RecordGatewayFile(gw.db, "file-legacy", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := gw.db.Exec(`UPDATE gateway_files SET created_at = now() - interval '30 days' WHERE file_id = 'file-legacy'`); err != nil {
		t.Fatal(err)
	}

	deleted, failed := api.ReapExpiredGatewayFiles(0)
	if deleted != 0 || failed != 0 {
		t.Fatalf("无上游时应直接跳过本轮: reap = %d/%d", deleted, failed)
	}
	if !lane2RowExists(t, gw, "file-legacy") {
		t.Fatal("无上游时不得丢失存量行")
	}
	if expires, _, _ := lane2RowExpiry(t, gw, "file-legacy"); expires != nil {
		t.Fatalf("上游不可用时不得把永久行规范化成已过期（%v）—— 对象删不掉，配额继续泄漏", expires)
	}
	if up.hits.Load() != 0 {
		t.Fatalf("无可用上游时不得触达任何上游（%d 次）", up.hits.Load())
	}
}

// TestFilesReaperNilAPIIsSafe：nil API / 无 DB 时安全返回。
func TestFilesReaperNilAPIIsSafe(t *testing.T) {
	var api *API
	if deleted, failed := api.ReapExpiredGatewayFiles(0); deleted != 0 || failed != 0 {
		t.Fatalf("nil API: %d/%d", deleted, failed)
	}
	if deleted, failed := (&API{}).ReapExpiredGatewayFiles(0); deleted != 0 || failed != 0 {
		t.Fatalf("nil DB: %d/%d", deleted, failed)
	}
}

// TestFilesReaperHooksAreRaceFree：钩子必须用原子访问。
//
// 回收器跑在常驻 goroutine 里（StartFileReaper），测试会从另一个 goroutine 注入钩子；
// 裸包级 var 在 `go test -race` 下就是 DATA RACE。**本用例的判据是 -race 的结论**：
//   - 变异（把 reapHookBox 换成裸字段）后 `go test -race -run TestFilesReaperHooksAreRaceFree`
//     必报 DATA RACE；
//   - 修复后同一命令干净通过。
func TestFilesReaperHooksAreRaceFree(t *testing.T) {
	resetBodyParseGate(t)
	gw, _, api := lane2Reaper(t, "deepseek-official")
	past := time.Now().Add(-time.Minute)

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			// 每轮都补一条过期行：保证回收器真的走到"读钩子"那两步。
			if err := serverstore.RecordGatewayFile(gw.db, "file-hook-race", gw.uidA, &past); err != nil {
				return
			}
			_, _ = api.ReapExpiredGatewayFiles(0)
		}
	}()

	for i := 0; i < 200; i++ {
		reapAfterListHook.store(func([]string) {})
		reapRecheckHook.store(func(string) {})
		reapAfterListHook.store(nil)
		reapRecheckHook.store(nil)
		runtime.Gosched()
	}
	close(stop)
	<-done
	t.Cleanup(func() {
		reapAfterListHook.store(nil)
		reapRecheckHook.store(nil)
	})
}

// TestStartFileReaperReapsThenStops：启动时先跑一轮（进程停了几天的堆积不必再等一个
// 间隔），ctx 取消后停止扫描。
func TestStartFileReaperReapsThenStops(t *testing.T) {
	resetBodyParseGate(t)
	gw, _, _ := lane2Reaper(t, "deepseek-official")
	lane2ExpiredRow(t, gw, "file-startup", gw.uidA, 10*24*time.Hour)

	ctx, cancel := context.WithCancel(context.Background())
	StartFileReaper(ctx, gw.db, 10*time.Millisecond)
	t.Cleanup(cancel)

	deadline := time.Now().Add(5 * time.Second)
	for lane2RowExists(t, gw, "file-startup") {
		if time.Now().After(deadline) {
			t.Fatal("StartFileReaper 启动时的首轮没有执行")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	time.Sleep(100 * time.Millisecond) // 让已在飞的一轮结束
	lane2ExpiredRow(t, gw, "file-after-cancel", gw.uidA, 10*24*time.Hour)
	time.Sleep(300 * time.Millisecond)
	if !lane2RowExists(t, gw, "file-after-cancel") {
		t.Fatal("ctx 取消后回收器仍在扫描")
	}
}

// ---------------------------------------------------------------------------
// R7 N11：回收标记（认领不删行）——中断可重入、续期即放弃、失败可立即重试
// ---------------------------------------------------------------------------

// TestReaperClaimSurvivesCrashWithoutOrphan（R7 N11）：认领后进程中断（这里用
// "认领了但没走完"模拟：直接调用 DAO 打标记后不再动它）**不会**产生"永无凭据"的
// 上游孤儿对象 —— 行还在、下一轮（租约过期后）能重新认领并重删（404 = 成功）再收尾。
func TestReaperClaimSurvivesCrashWithoutOrphan(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	api := &API{DB: gw.db, client: &http.Client{}}

	past := time.Now().Add(-time.Minute)
	if err := serverstore.RecordGatewayFile(gw.db, "file-crash", gw.uidA, &past); err != nil {
		t.Fatal(err)
	}
	// 模拟"认领成功但进程随即死掉"：只打标记。
	if _, ok, err := serverstore.ClaimExpiredGatewayFile(gw.db, "file-crash"); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	if exists, _ := serverstore.GatewayFileRowExists(gw.db, "file-crash"); !exists {
		t.Fatal("认领必须**保留**台账行（否则上游对象再无凭据）")
	}
	// 租约内：别的批次不会抢（claim 返回 false），也不会重复删上游；
	// 候选列表也必须把它排除（否则崩溃留下的标记行每轮白占一个批次位）。
	if _, ok, _ := serverstore.ClaimExpiredGatewayFile(gw.db, "file-crash"); ok {
		t.Fatal("租约内不该被重复认领")
	}
	if ids, err := serverstore.ListExpiredGatewayFiles(gw.db, 10); err != nil {
		t.Fatal(err)
	} else {
		for _, id := range ids {
			if id == "file-crash" {
				t.Fatal("租约内的标记行不该再进候选列表（会挤占批次位）")
			}
		}
	}
	// 租约过期（把标记推到 11 分钟前）⇒ 下一轮可重新认领并真正收尾。
	if _, err := gw.db.Exec(`UPDATE gateway_files SET reaping_at = now() - interval '11 minutes' WHERE file_id = 'file-crash'`); err != nil {
		t.Fatal(err)
	}
	deleted, failed := api.ReapExpiredGatewayFiles(0)
	if deleted != 1 || failed != 0 {
		t.Fatalf("租约过期后应能回收: %d/%d", deleted, failed)
	}
	if exists, _ := serverstore.GatewayFileRowExists(gw.db, "file-crash"); exists {
		t.Fatal("收尾后台账行必须清掉")
	}
	if up.deletes.Load() != 1 {
		t.Fatalf("上游删除次数 = %d, want 1（重入时上游已是 404 = 成功）", up.deletes.Load())
	}
}

// TestReaperAbandonsIfRenewedDuringReap（R7 N11 续期侧）：两个窗口都必须放弃删上游对象 ——
//
//	(a) 列出候选 → 认领之间被续期（认领的"复检仍过期"挡住）；
//	(b) 认领（打标记）→ 删上游之间被续期（续期**清空标记** ⇒ 复检发现认领已失效）。
//
// 两个窗口分开成子用例：合并写会互相遮蔽 —— (a) 的续期让认领直接失败，(b) 的注入点
// 根本不会被执行，于是"续期清标记"这条实现细节没有任何判据（变异实测：删掉
// `reaping_at = NULL` 时合并版仍绿）。
func TestReaperAbandonsIfRenewedDuringReap(t *testing.T) {
	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)

	cases := []struct {
		name  string
		arm   func(t *testing.T, gw *filesGateway, id string, future time.Time)
		clear func()
	}{
		{
			name: "after-list",
			arm: func(t *testing.T, gw *filesGateway, id string, future time.Time) {
				reapAfterListHook.store(func(ids []string) {
					for _, got := range ids {
						if got != id {
							continue
						}
						reapAfterListHook.store(nil)
						if err := serverstore.RecordGatewayFile(gw.db, id, gw.uidB, &future); err != nil {
							t.Errorf("renew: %v", err)
						}
					}
				})
			},
			clear: func() { reapAfterListHook.store(nil) },
		},
		{
			name: "after-claim",
			arm: func(t *testing.T, gw *filesGateway, id string, future time.Time) {
				reapRecheckHook.store(func(got string) {
					if got != id {
						return
					}
					reapRecheckHook.store(nil)
					if err := serverstore.RecordGatewayFile(gw.db, id, gw.uidB, &future); err != nil {
						t.Errorf("renew during reap: %v", err)
					}
				})
			},
			clear: func() { reapRecheckHook.store(nil) },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := newFakeFilesUpstream(t)
			gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
			api := &API{DB: gw.db, client: &http.Client{}}
			// id 必须满足 validGatewayFileID 的白名单（`[A-Za-z0-9_-]`）：否则回收器会先把它
			// 当成"本地损坏行"就地丢弃（L2 的有意设计），判据就测不到了。
			id := "file-renew-" + tc.name
			if err := serverstore.RecordGatewayFile(gw.db, id, gw.uidA, &past); err != nil {
				t.Fatal(err)
			}
			tc.arm(t, gw, id, future)
			t.Cleanup(tc.clear)

			before := up.deletes.Load()
			if deleted, _ := api.ReapExpiredGatewayFiles(0); deleted != 0 {
				t.Fatalf("被续期的文件不该计入回收（deleted=%d）", deleted)
			}
			if up.deletes.Load() != before {
				t.Fatalf("被续期的文件其上游对象被删了（deletes %d → %d）", before, up.deletes.Load())
			}
			owner, ok, err := serverstore.GatewayFileOwner(gw.db, id)
			if err != nil || !ok {
				t.Fatalf("续期后的行必须仍然有效: ok=%v err=%v", ok, err)
			}
			if owner != gw.uidB {
				t.Fatalf("归属应转为续期者: %d want %d", owner, gw.uidB)
			}
		})
	}
}

// TestReaperReleasesClaimOnUpstreamFailure（R7 N11）：上游删除失败时释放标记 ⇒ 下一轮
// **立刻**重试（不必等租约），且台账行仍在（清理责任不丢）。
func TestReaperReleasesClaimOnUpstreamFailure(t *testing.T) {
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file-x"}`))
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	api := &API{DB: gw.db, client: &http.Client{}}

	past := time.Now().Add(-time.Minute)
	if err := serverstore.RecordGatewayFile(gw.db, "file-retry", gw.uidA, &past); err != nil {
		t.Fatal(err)
	}
	if deleted, failed := api.ReapExpiredGatewayFiles(0); deleted != 0 || failed != 1 {
		t.Fatalf("第一轮 = %d/%d, want 0/1", deleted, failed)
	}
	if held, err := serverstore.GatewayFileReapClaimHeld(gw.db, "file-retry"); err != nil || held {
		t.Fatalf("失败后必须释放标记才能立刻重试: held=%v err=%v", held, err)
	}
	up.respond = nil
	if deleted, failed := api.ReapExpiredGatewayFiles(0); deleted != 1 || failed != 0 {
		t.Fatalf("第二轮 = %d/%d, want 1/0（不该等租约过期）", deleted, failed)
	}
}

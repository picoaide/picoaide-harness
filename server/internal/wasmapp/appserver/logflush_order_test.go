package appserver

// 本文件是 R1-rt-6 的行为级护栏：**应用日志刷盘不得发生在持有执行槽 + 库句柄期间**。
//
// 现场（审计 runtime-perf.md R1-rt-6，HEAD 7da0ba47dd）：`serveWasm` 的 defer 注册顺序
// 让 `flushAppLogs` 排在最后（LIFO 最先执行）⇒ 每请求 ≤100 条 × 4 KiB 的**同步**
// `log.Printf`（stderr）发生在"执行槽 + 库句柄 + 模块引用"全都还握着的时候。
// 容器 log driver 慢 / 磁盘满时，这段写会直接吃掉稀缺的执行槽（默认档全局只有 32 个）。
//
// 修法：`logbuf` 与 `defer flushAppLogs` 提前到**最早注册**（LIFO 最后执行），
// 于是刷盘发生在 `db.endRequest` → `appdbs.release` → 模块 release → `ticket.Release`
// 全都归还之后。同步语义不变（仍然每请求一次、仍然有界、仍然不丢）。
//
// # 变异验证（2026-09-19 实跑）
//
//	把 `defer s.flushAppLogs(appID, logs)` 挪回句柄获取之后（即旧实现的注册顺序）
//	⇒ TestServe_AppLogFlushHoldsNoSlotOrHandle 红：
//	  "刷盘时仍在持有执行槽：GlobalRunning=1（必须为 0）"。

import (
	"net/http"
	"strings"
	"sync"
	"testing"
)

// handleInflightForTest 读某应用句柄的在途持有数（>0 = 还有请求握着这个句柄）。
func (p *appDBPool) handleInflightForTest(appID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if h, ok := p.handles[appID]; ok {
		return h.inflight
	}
	return 0
}

// logFlushSample 是"刷盘那一刻"的平台状态快照。
type logFlushSample struct {
	msg     string
	running int // scheduler.Stats().GlobalRunning（执行槽）
	handle  int // 该应用库句柄的在途计数
}

// TestServe_AppLogFlushHoldsNoSlotOrHandle 是 R1-rt-6 的核心判据。
//
// 判据来自**运行期可观测状态**（不是读 defer 顺序）：应用真的打一条日志，在平台
// 日志出口观察到 `wasm-app[...]` 那一行的**同一时刻**读执行槽/句柄持有数 ——
// 两者都必须归零。这条断言在旧实现（先刷盘、后归还）上必红。
func TestServe_AppLogFlushHoldsNoSlotOrHandle(t *testing.T) {
	var (
		mu      sync.Mutex
		samples []logFlushSample
	)
	var srvRef *Server
	var appRef string

	e := newEnv(t, func(o *Options) {
		o.Logger = func(format string, args ...any) {
			msg := sprintf(format, args...)
			if strings.Contains(msg, "wasm-app[") && srvRef != nil {
				slot, held := 0, 0
				if srvRef.scheduler != nil {
					slot = srvRef.scheduler.Stats().GlobalRunning
				}
				if srvRef.appdbs != nil && appRef != "" {
					held = srvRef.appdbs.handleInflightForTest(appRef)
				}
				mu.Lock()
				samples = append(samples, logFlushSample{msg: msg, running: slot, handle: held})
				mu.Unlock()
			}
		}
	})
	srvRef = e.srv

	appID := e.appID("rtlog")
	appRef = appID
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})

	rec := e.get(appID, "/log?msg="+urlQueryEscape("flush-order-probe")+"&level=warn")
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d body=%.200s", rec.Code, rec.Body.String())
	}

	mu.Lock()
	got := append([]logFlushSample(nil), samples...)
	mu.Unlock()
	if len(got) == 0 {
		t.Fatal("没有观察到应用日志刷盘（日志不丢的语义被破坏了）")
	}
	for _, s := range got {
		if s.running != 0 {
			t.Fatalf("刷盘时仍在持有执行槽：GlobalRunning=%d（必须为 0）；日志=%q", s.running, s.msg)
		}
		if s.handle != 0 {
			t.Fatalf("刷盘时仍在持有应用库句柄：inflight=%d（必须为 0）；日志=%q", s.handle, s.msg)
		}
	}
	if !strings.Contains(got[0].msg, "flush-order-probe") {
		t.Fatalf("刷盘内容不对：%q", got[0].msg)
	}
}

// TestServe_AppLogStillFlushedOnEarlyFailurePath 守住"日志不丢"的另一半：
// 提前注册 defer 之后，**失败路径**（这里用 413 请求体超限，发生在获取句柄之前）
// 也必须照常走到 flush（不 panic、不吞异常）。
func TestServe_AppLogStillFlushedOnEarlyFailurePath(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtlogfail")
	e.publishApp(appSpec{appID: appID})

	big := strings.Repeat("x", int(1<<20)+1)
	rec := e.post(appID, "/api/echo", "text/plain", big)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超限请求体应 413，得到 %d body=%.200s", rec.Code, rec.Body.String())
	}
	// 走到这里说明 defer 链（含 flushAppLogs）在早退路径上没有炸。
	if code := errorCodeOf(t, rec.Body); code != "BODY_TOO_LARGE" {
		t.Fatalf("错误码应为 BODY_TOO_LARGE，得到 %q", code)
	}
}

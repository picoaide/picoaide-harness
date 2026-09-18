package serverstore

import (
	"strings"
	"sync"
	"testing"
)

// PG 的 NOTICE/WARNING 落点回归（独立审计 2026-09-18 P2-2）。
//
// 判据：迁移/DDL 里的 `RAISE WARNING` 必须真的到达服务端日志。此前 `newPGConnector`
// 没给 `cfg.OnNotice`，pgconn 默认不转发 —— 0071 那条"跳过 N 行坏 JSON"的 WARNING
// 一个字都出不来，数据不丢但报告静默。
//
// 变异判据：删掉 newPGConnector 里的 `cfg.OnNotice = …` ⇒ 本用例红（捕获不到）。
func TestPGNoticesReachTheSink(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	var mu sync.Mutex
	var captured []string
	prev := pgNoticeSink
	pgNoticeSink = func(message string) {
		mu.Lock()
		captured = append(captured, message)
		mu.Unlock()
	}
	t.Cleanup(func() { pgNoticeSink = prev })

	// RAISE WARNING 是迁移里实际用的那种诊断（NOTICE 同一条通路）。
	if _, err := db.Exec(`DO $probe$ BEGIN RAISE WARNING 'picoaide notice probe %', 42; END $probe$;`); err != nil {
		t.Fatalf("执行 RAISE WARNING: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(captured) == 0 {
		t.Fatal("PG 的 WARNING 没有到达 sink —— 迁移里的诊断信息会完全静默")
	}
	joined := strings.Join(captured, "\n")
	if !strings.Contains(joined, "picoaide notice probe 42") {
		t.Fatalf("sink 收到的内容不含预期消息：%q", joined)
	}
	if !strings.Contains(joined, "WARNING") {
		t.Fatalf("sink 内容应带严重级别：%q", joined)
	}
}

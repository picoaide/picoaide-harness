package serverstore

// R16C-05（审计 2026-09-25，P2）：审计"丢了"看得见，"为什么丢"看不见。
//
// 缺陷形态（修复前，探针实测）：worker 里唯一的"丢失"打点是
//
//	auditWriteFailure("entry dropped after retries", r.username, r.action, 1)
//
// —— 形参里**没有 error**，底层错误只经 `r.done <- err[i]` 交回调用方，而全仓
// 90+ 个调用点写的是 `_ = serverstore.AuditLog(...)`（错误在每一处被丢掉）。于是
// 日志里只有 `action="login_fail" username="nul\x00probe" dropped_entries=1`，
// **没有任何 SQL 错误 / SQLSTATE / 约束名**：运维只知"丢了几条"，不知"为什么丢"。
// 对照：走 AuditLogTx 的路径会把 `ERROR: … violates check constraint … (SQLSTATE 23514)`
// 完整打出来。
//
// 判据（本文件）：注入一次确定性的 insert 失败（表级 CHECK）⇒ 日志里必须能 grep 到
// SQLSTATE/约束名，且进程内"最近一次失败"快照带出原因类别（`/server-info` 读它）。

import (
	"bytes"
	"database/sql"
	"fmt"
	"log"
	"strings"
	"testing"
)

// blockAuditActionForTest 用表级 CHECK 精确阻断某个 action 的审计写入。
func blockAuditActionForTest(t *testing.T, db *sql.DB, action string) {
	t.Helper()
	if _, err := db.Exec(`DELETE FROM audit_logs WHERE action = ?`, action); err != nil {
		t.Fatalf("清理 %s 审计行: %v", action, err)
	}
	ddl := fmt.Sprintf(`ALTER TABLE audit_logs ADD CONSTRAINT r16c05_block_%s CHECK (action <> '%s')`, action, action)
	if _, err := db.Exec(ddl); err != nil {
		t.Fatalf("加阻断约束失败（判据根本咬不到）: %v", err)
	}
}

// captureAuditLog 捕获标准库日志（worker 与 AuditLog 用的是同一个 log 包）。
// 被测代码的日志是**全局** log；本包用例不并行，捕获窗口只覆盖一次调用。
func captureAuditLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prevOut := log.Writer()
	prevFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	}()
	fn()
	return buf.String()
}

// TestAuditWriteFailureLogsCauseWithSQLState 是 R16C-05 的核心判据。
func TestAuditWriteFailureLogsCauseWithSQLState(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	blockAuditActionForTest(t, db, "r16c05_blocked")

	var callErr error
	out := captureAuditLog(t, func() {
		callErr = AuditLog(db, "victim", "r16c05_blocked", "detail")
	})
	if callErr == nil {
		t.Fatal("被约束阻断的审计写入必须返回错误")
	}
	if !strings.Contains(out, "entry dropped after retries") {
		t.Fatalf("缺少丢失打点: %q", out)
	}
	// 核心：原因必须可检索。SQLSTATE 23514（check_violation）或约束名二者之一
	// 至少要出现 —— 修前这里一个都没有。
	if !strings.Contains(out, "SQLSTATE") && !strings.Contains(out, "r16c05_block") {
		t.Fatalf("丢条日志里没有 SQLSTATE/约束名，运维仍不知道'为什么丢': %q", out)
	}
	if !strings.Contains(out, "cause=") {
		t.Fatalf("日志里没有 cause 字段（判据无法检索）: %q", out)
	}

	// 进程内"最近一次失败"快照：给被调用点丢弃的错误一条出路（/server-info 暴露它）。
	last, ok := AuditWriteLastFailure()
	if !ok {
		t.Fatal("最近一次审计写入失败没有被记录 —— 错误在调用点被丢弃后就彻底消失了")
	}
	if last.Action != "r16c05_blocked" || last.Username != "victim" {
		t.Fatalf("最近失败快照的 action/username = %q/%q", last.Action, last.Username)
	}
	if last.CauseClass != "sqlstate:23514" {
		t.Fatalf("cause_class = %q, want sqlstate:23514（机器可读的原因类别）", last.CauseClass)
	}
	if !strings.Contains(last.Cause, "r16c05_block") {
		t.Fatalf("cause 缺少约束名: %q", last.Cause)
	}
	if last.At == "" {
		t.Fatal("最近失败快照缺时间戳")
	}
}

// TestAuditFailureSnapshotEscapesCause 钉"原因进日志"不得成为新的行结构伪造面：
// 错误文本同样要过 EscapeControl（PG 会把含不可打印字符的入参回显在消息里）。
func TestAuditFailureSnapshotEscapesCause(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	blockAuditActionForTest(t, db, "r16c05_esc")

	out := captureAuditLog(t, func() {
		_ = AuditLog(db, "u", "r16c05_esc", "d")
	})
	if strings.Count(out, "\n") != 1 {
		// log.Printf 自己会补一个换行；多于一个说明 cause 里带了裸换行。
		t.Fatalf("失败日志行数 != 1（原因里的控制字符没有转义）: %q", out)
	}
	last, ok := AuditWriteLastFailure()
	if !ok {
		t.Fatal("缺最近失败快照")
	}
	if strings.ContainsAny(last.Cause, "\n\r") {
		t.Fatalf("快照里的 cause 带裸换行: %q", last.Cause)
	}
	if strings.ContainsAny(last.Username, "\n\r") {
		t.Fatalf("快照里的 username 带裸换行: %q", last.Username)
	}
}

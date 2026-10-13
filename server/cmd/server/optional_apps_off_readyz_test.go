//go:build !apps

package main

// 关闭态 /readyz 替身的判据（2026-10-14 独立审计 P2-5）。
//
// 缺陷现场：替身此前无条件回 200/`ready:true`，于是同一个 `/readyz` 路径在降配变体里
// 退化成常量 —— 全开态 DB 挂了会 503，降配态永远绿，编排/巡检（compose healthcheck、
// k8s readiness）会永远认为这台机器就绪。本文件钉三件事：
//
//	① DB 不可达 ⇒ 503，且 `ok/ready/db_ok` 三个键如实为 false；
//	② **不回显驱动原文**（/readyz 是未认证端点，pgx 的连接错误里带用户名/库名/地址）——
//	   只给分类后的固定理由；
//	③ `db == nil`（未接线）⇒ 这一维**没有判定**：200 + `db_ok:false`，而不是编一条假 reason。
//
// 变异（实跑）：把 handler 里的 `if !snapshot.OK` 去掉 ⇒ ①红；把 reason 换成
// `err.Error()` ⇒ ②红。

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubConnector 是一个**只用来产生 Ping 结果**的假驱动：不起真实连接、不依赖 PG。
type stubConnector struct{ pingErr error }

func (c stubConnector) Connect(context.Context) (driver.Conn, error) {
	return &stubConn{pingErr: c.pingErr}, nil
}

func (c stubConnector) Driver() driver.Driver { return stubDriver{pingErr: c.pingErr} }

type stubDriver struct{ pingErr error }

func (d stubDriver) Open(string) (driver.Conn, error) { return &stubConn{pingErr: d.pingErr}, nil }

// stubConn 只需要满足 driver.Conn 与 driver.Pinger —— /readyz 只调 PingContext。
type stubConn struct{ pingErr error }

func (c *stubConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("未实现") }
func (c *stubConn) Close() error                        { return nil }
func (c *stubConn) Begin() (driver.Tx, error)           { return nil, errors.New("未实现") }
func (c *stubConn) Ping(context.Context) error          { return c.pingErr }

// readyzBody 打一次 /readyz 并解出响应体。
//
// 接的是**已经建好的 handler**（而不是 checker 值）：`wasmCheckerOff` 带锁（快照缓存），
// 每次传值都会拿到一份新缓存 —— 那样测出来的"缓存没生效"是夹具自己造的假象。
func readyzBody(t *testing.T, handler http.Handler) (int, map[string]any, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	raw := rec.Body.String()
	parsed := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("/readyz 的响应体必须是 JSON 对象（实得 %q）：%v", raw, err)
	}
	return rec.Code, parsed, raw
}

func TestClosedReadyzReportsDatabaseHealth(t *testing.T) {
	// 驱动原文里放一个**不该出现在响应体里**的标记串（形态与 pgx 的连接错误一致：
	// 带用户名/库名/地址）。
	const driverDetail = "failed to connect to `user=secret-user database=secret-db`: 10.0.0.9:5432"
	db := sql.OpenDB(stubConnector{pingErr: errors.New(driverDetail)})
	t.Cleanup(func() { _ = db.Close() })

	status, body, raw := readyzBody(t, (&wasmCheckerOff{db: db}).Handler())
	if status != http.StatusServiceUnavailable {
		t.Errorf("DB 不可达时 /readyz 必须 503（否则编排永远认为这台机器就绪），实得 %d", status)
	}
	for _, key := range []string{"ok", "ready", "db_ok"} {
		if value, ok := body[key].(bool); !ok || value {
			t.Errorf("DB 不可达时 %q 必须是 false，实得 %v（响应体 %s）", key, body[key], raw)
		}
	}
	if body["module_apps"] != "off" {
		t.Errorf("关闭态探针必须仍然自报 module_apps=off，实得 %v", body["module_apps"])
	}
	// ② 分类后的理由必须在；驱动原文必须**不在**（未认证端点不许回显基础设施标识）。
	if !strings.Contains(raw, reasonDBUnreachableOff) {
		t.Errorf("响应体缺少分类后的理由 %q：%s", reasonDBUnreachableOff, raw)
	}
	if strings.Contains(raw, "secret-user") || strings.Contains(raw, "10.0.0.9") {
		t.Errorf("响应体回显了驱动原文（未认证端点泄漏库名/用户名/地址）：%s", raw)
	}
	if !strings.Contains(raw, "db_ok") {
		t.Errorf("响应体缺少 db_ok 键（告警规则在两种变体下读同一个键）：%s", raw)
	}
}

func TestClosedReadyzPassesWhenDatabaseReachable(t *testing.T) {
	db := sql.OpenDB(stubConnector{})
	t.Cleanup(func() { _ = db.Close() })

	status, body, raw := readyzBody(t, (&wasmCheckerOff{db: db}).Handler())
	if status != http.StatusOK {
		t.Errorf("DB 可达时 /readyz 必须 200，实得 %d（%s）", status, raw)
	}
	if body["db_ok"] != true {
		t.Errorf("DB 可达时 db_ok 必须 true，实得 %v", body["db_ok"])
	}
	if _, present := body["reasons"]; present {
		t.Errorf("DB 可达时不该有 reasons（空 reasons 必须被 omitempty 省掉）：%s", raw)
	}
}

func TestClosedReadyzWithoutDBDoesNotInventAVerdict(t *testing.T) {
	// db == nil = 未接线：与打开态 `Options.Ping == nil` 同形 —— 这一维**没有判定**，
	// 既不判失败也不编 reason（`productionReferenceTree` 就是这条路径）。
	status, body, raw := readyzBody(t, (&wasmCheckerOff{}).Handler())
	if status != http.StatusOK {
		t.Errorf("未接线 DB 时不该判失败（它不是「DB 不可达」），实得 %d（%s）", status, raw)
	}
	if body["db_ok"] != false {
		t.Errorf("未接线 DB 时 db_ok 必须是 false（「没有判定」不是「判定通过」），实得 %v", body["db_ok"])
	}
	if _, present := body["reasons"]; present {
		t.Errorf("未接线 DB 时不许编 reason：%s", raw)
	}
}

func TestClosedReadyzCachesSnapshot(t *testing.T) {
	// /readyz 是**未认证**端点：TTL 内必须复用读数（与打开态 limits.ReadyzSnapshotTTL 同源）。
	db := sql.OpenDB(stubConnector{})
	t.Cleanup(func() { _ = db.Close() })
	handler := (&wasmCheckerOff{db: db}).Handler()

	_, first, _ := readyzBody(t, handler)
	if first["snapshot_cached"] != false {
		t.Errorf("首次读数的 snapshot_cached 必须是 false，实得 %v", first["snapshot_cached"])
	}
	_, second, _ := readyzBody(t, handler)
	if second["snapshot_cached"] != true {
		t.Errorf("TTL 内的第二次读数必须报告 snapshot_cached=true（否则运维分不清「水位没变」与「看到的是旧快照」），实得 %v",
			second["snapshot_cached"])
	}
}

//go:build !apps

package main

// 本文件是 `apps` 模块**关闭**时的装配替身（P1 第二片，2026-10-14）。
//
// 关闭态不是"少注册几条路由"，而是：
//   - 整个 `internal/wasmapp/**` 包树**不在依赖图里**（setupWasmPlatform /
//     seedDemoApps / validateAppOriginScheme 的真实实现都在 `//go:build apps`
//     的 cmd/server/wasmapp*.go 里）；
//   - `/api/client/v2/apps/wasm/*` 与 `/api/server/admin/wasm-apps/*` 两片路由
//     由 router 侧的编译期 no-op 负责（见 internal/router/optional_apps_off.go）。
//
// 这里保留**同名同签名**的最小替身，目的是让 `main()` 的装配字面量在八种组合下
// 逐字不变 —— 装配判据（main_assembly_criteria_test.go 要求 `seedDemoApps(...)`
// 字面出现在 main() 的静态可达路径上）因此不需要按变体分叉。

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/limits"
	"github.com/picoaide/picoaide/internal/router"
)

// wasmPlatform 是关闭态的替身：字段名与打开态保持一致（装配代码逐字不变），
// 但 API 恒为 nil（router 侧根本没有注册代码），Checker 换成最小探针。
type wasmPlatform struct {
	// API 是 WASM 操作面 handler 集合；关闭态恒为 nil。
	//
	// 为什么允许 nil：`router.registerWasm` 在关闭态是**编译期 no-op**，
	// 不存在"把 nil handler 交给 gin"的路径（那才是会 panic→500 的形态）。
	API *router.WasmAPI
	// Checker 提供 /readyz 的响应；关闭态是最小探针（见下方 Handler）。
	Checker wasmCheckerOff
}

// wasmCheckerOff 是关闭态的 /readyz 提供者。
//
// 关闭态没有"平台就绪"这回事，但 /readyz 是**无条件注册**的探针（运维面契约），
// 因此必须给出一个结构化的响应 —— 而不是让装配 fail-fast 或让请求 500。
// `module_apps` 字段让运维一眼看出"这台机器没编进应用中心"。
//
// **DB 维必须还在**（2026-10-14 独立审计 P2-5）：本替身此前无条件回 200/`ready:true`，
// 于是同一个 `/readyz` 路径在降配变体里退化成常量 —— DB 挂了编排/巡检照样永远绿
// （`/healthz` 仍做 `db.Ping`，所以不是全丢信号，但这是**静默降级**：探针的名字与
// 位置都没变、语义变了）。现在按打开态同一条口径判 DB：可达 ⇒ 200；不可达 ⇒ 503 +
// 分类后的原因（**不回显驱动原文**，原文只进服务端日志，与 readyz.go 的纪律一致）。
type wasmCheckerOff struct {
	// db 是基础面的连接池；nil = 未接线（这一维没有判定，不是"判定通过"）。
	db *sql.DB
	// mu/at/cached 是响应快照缓存：`/readyz` 是**未认证**端点，不能每个请求都打一次 DB。
	// TTL 与打开态同源（limits.ReadyzSnapshotTTL）。
	mu     sync.Mutex
	at     time.Time
	cached offReadyzSnapshot
}

// offReadyzSnapshot 是关闭态探针的响应体。
//
// 四个键名刻意与打开态 `readyz.Snapshot` 的重合（`ok` / `db_ok` / `reasons` /
// `snapshot_cached`）：告警规则按这些键写，在两种变体下必须同样可读。
// `ready` 与 `module_apps` 是关闭态既有的历史字段，保留（既有脚本可能读它们）。
type offReadyzSnapshot struct {
	OK             bool     `json:"ok"`
	Ready          bool     `json:"ready"`
	ModuleApps     string   `json:"module_apps"`
	DBOK           bool     `json:"db_ok"`
	Reasons        []string `json:"reasons,omitempty"`
	CheckedAt      string   `json:"checked_at"`
	SnapshotCached bool     `json:"snapshot_cached"`
}

// reasonDBUnreachableOff 是关闭态探针的 DB 不可达理由（与打开态的
// `readyz.reasonDBUnreachable` 同文案 —— 告警规则按字面量匹配时两种变体一致）。
const reasonDBUnreachableOff = "数据库不可达"

// Handler 返回关闭态探针（JSON；DB 不可达时 503）。
//
// 指针接收者：`wasmCheckerOff` 带锁（快照缓存），`go vet` 的 copylocks 会拒绝值接收者。
func (c *wasmCheckerOff) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		snapshot := c.snapshot()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		// 未认证端点：与打开态同一条纪律（不许被中间层把健康读数缓存住）。
		w.Header().Set("Cache-Control", "no-store")
		if !snapshot.OK {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(snapshot)
	})
}

// snapshot 返回 TTL 内的缓存读数；过期就重探一次 DB。
func (c *wasmCheckerOff) snapshot() offReadyzSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < limits.ReadyzSnapshotTTL {
		cached := c.cached
		cached.SnapshotCached = true
		return cached
	}
	fresh := c.probe()
	c.at, c.cached = time.Now(), fresh
	return fresh
}

// probe 是一次真实读数（组装快照 + 一次 DB 探针）。
func (c *wasmCheckerOff) probe() offReadyzSnapshot {
	snapshot := offReadyzSnapshot{
		OK:         true,
		Ready:      true,
		ModuleApps: "off",
		CheckedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	if c.db == nil {
		// 未接线 ⇒ 这一维**没有判定**（与打开态 `Options.Ping == nil` 同形：
		// db_ok=false，但不因此判失败，也不编一条假 reason）。
		return snapshot
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.db.PingContext(ctx); err != nil {
		snapshot.OK = false
		snapshot.Ready = false
		// 只给**分类后**的原因，不回显驱动原文：pgx 的连接错误里带用户名/库名/地址，
		// 而 /readyz 是未认证端点 —— 原文只进服务端日志（可 grep，排障不降级）。
		snapshot.Reasons = append(snapshot.Reasons, reasonDBUnreachableOff)
		log.Printf("readyz: apps 关闭态的 DB 探针失败（原文仅进本行日志，不进 /readyz）：%v", err)
		return snapshot
	}
	snapshot.DBOK = true
	return snapshot
}

// setupWasmPlatform 在 apps 关闭时只记一行日志并返回替身（不申请实例锁、
// 不读内存档位、不起任何调度器 —— 那些全部属于被裁掉的包树）。
func setupWasmPlatform(_ context.Context, db *sql.DB, _ string) *wasmPlatform {
	log.Printf("wasm: apps 模块未编入本变体（-tags 不含 apps）—— 应用平台端点不注册、演示应用不播种、" +
		"调用事件/分片上传/打开计数三条清理调度器不启动；/readyz 由替身探针应答（仍判 DB 可达性）")
	return &wasmPlatform{Checker: wasmCheckerOff{db: db}}
}

// Close 是空实现（关闭态没有需要释放的平台资源）。
func (*wasmPlatform) Close() {}

// seedDemoApps 在 apps 关闭时是 no-op（演示应用属于应用中心资产）。
//
// ⚠️ 调用点**必须**留在 main() 的静态可达路径上：`main_assembly_criteria_test.go`
// 用它证明"内置演示应用随启动播种"这行装配没被人悄悄删掉；关闭态的语义是
// "这个变体不含演示应用"，而不是"这行装配失踪了"。
func seedDemoApps(_ context.Context, _ *sql.DB, _ string) {}

// validateAppOriginScheme 在 apps 关闭时不做强制校验（P0 规划 §5 第 3 条：
// `desktop.app_origin_scheme` 是应用中心的字段，关闭应用中心后它不再有任何消费者）。
//
// 只放宽"必须存在"这一条：字段写错（形状非法）仍由 channel 包自己报错，
// 这里只是不再因为"缺这个字段"而拒绝启动。
func validateAppOriginScheme() error {
	log.Printf("app origin scheme: apps 模块未编入本变体，跳过强制校验（渠道字段仅在应用中心内有消费者）")
	return nil
}

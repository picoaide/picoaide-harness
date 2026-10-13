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
// 这里保留**同名同签名**的最小替身，目的是让 `main()` 的装配字面量在六种组合下
// 逐字不变 —— 装配判据（main_assembly_criteria_test.go 要求 `seedDemoApps(...)`
// 字面出现在 main() 的静态可达路径上）因此不需要按变体分叉。

import (
	"context"
	"database/sql"
	"log"
	"net/http"

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
// 因此必须给出一个结构化的 200 —— 而不是让装配 fail-fast 或让请求 500。
// `module_apps` 字段让运维一眼看出"这台机器没编进应用中心"。
type wasmCheckerOff struct{}

// Handler 返回关闭态探针（JSON，`module_apps=off`）。
func (wasmCheckerOff) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"ready":true,"module_apps":"off"}`))
	})
}

// setupWasmPlatform 在 apps 关闭时只记一行日志并返回替身（不申请实例锁、
// 不读内存档位、不起任何调度器 —— 那些全部属于被裁掉的包树）。
func setupWasmPlatform(_ context.Context, _ *sql.DB, _ string) *wasmPlatform {
	log.Printf("wasm: apps 模块未编入本变体（-tags 不含 apps）—— 应用平台端点不注册、演示应用不播种、" +
		"调用事件/分片上传/打开计数三条清理调度器不启动；/readyz 由替身探针应答")
	return &wasmPlatform{}
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

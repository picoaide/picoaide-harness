package appserver

import (
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/logbuf"
)

// assetsAdapter 把内存资源集（assets.Set）适配成 capapi.Assets。
//
// ⚠️ 为什么需要它（跨模块契约缺口，已在交付说明里点名，**不改任何一侧**）：
// `assets.Set.Read` 的签名是
//
//	func (s *Set) Read(logicalPath string) (string, []byte, *apperr.Error)
//
// 而 `capapi.Assets.Read` 声明的是 `error`（capapi/capapi.go:80）—— 方法签名不同 ⇒
// `*assets.Set` **不满足** `capapi.Assets`，直接塞给 `hostcap.Capabilities.Assets`
// 编译不过（`*assets.Set does not implement capapi.Assets (wrong type for method Read)`）。
// 这里用一层零逻辑适配器弥合：真正要修的是两边之一（把 assets.Read 改成返回 error，
// 或把 capapi.Assets 改成返回 *apperr.Error），但那两个包都不是本模块的文件。
//
// 注意"typed nil"陷阱：`*apperr.Error` 为 nil 时若直接当 error 返回会变成非 nil 接口，
// 因此这里显式判空后再返回 nil。
type assetsAdapter struct{ set *assets.Set }

// Read 实现 capapi.Assets。
func (a assetsAdapter) Read(logicalPath string) (string, []byte, error) {
	if a.set == nil {
		return "", nil, apperr.New(apperr.CodeInternal, "资源集未加载")
	}
	contentType, data, err := a.set.Read(logicalPath)
	if err != nil {
		return "", nil, err
	}
	return contentType, data, nil
}

// List 实现 capapi.Assets。
func (a assetsAdapter) List() []string {
	if a.set == nil {
		return nil
	}
	return a.set.List()
}

// flushAppLogs 把本次请求的应用日志（logbuf，§5.1）转写到平台日志出口。
//
// 为什么用 logbuf 而不是自建 sink：`log` 的限额语义（单条 4 KiB 截断、每请求 100 条
// 丢弃计数）是 §5.1 的规定，必须只有一份实现（模块负责人已把它做成
// internal/wasmapp/logbuf）。本函数只负责"把缓冲交给运维面"：
//   - 每条带 app_id 前缀（否则多个应用的日志混在一起无法归因）；
//   - 丢弃计数单独一行（回给应用的数字由 hostcap 从 Dropped() 读，这里只是让运维看得见）；
//   - 缓冲本身有界（≤100 条 × 4 KiB），因此这一步不可能成为"应用打爆宿主日志"的路径。
func (s *Server) flushAppLogs(appID string, buf *logbuf.Buffer) {
	if s == nil || buf == nil {
		return
	}
	for _, entry := range buf.Snapshot() {
		s.logf("wasm-app[%s] %s: %s", appID, entry.Level, entry.Message)
	}
	if dropped := buf.Dropped(); dropped > 0 {
		s.logf("wasm-app[%s] 日志超过每请求上限，丢弃 %d 条", appID, dropped)
	}
}

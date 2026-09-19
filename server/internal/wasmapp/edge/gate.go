// Package edge 提供客户端专属应用管线共用的 **HTTP 面原语**：宿主独占的响应安全头、
// 应用头剥离、请求体上限、Origin 形态判定与规范化、404 页。
//
// 设计依据：总纲 §8.1（管线步骤 ⑦ 跨源写校验复用 `IsOriginShaped`）、§8.4（删除清单）
// 与 §4.8（响应与浏览器侧）。
//
// ⚠️ 本包**曾经**同时承担"应用子域的最外层门控"（主机名 allow-list、未知主机 404、
// 编排探针例外）。那套主机名门控（`HostGate`/`MatchHost`/`HostKind`/`IsProbePath`/
// `CheckOrigin`/`SelfOrigin`）已随 W4 波次**整体删除**：应用不再有对外主机名，
// 请求由桌面客户端的协议 handler 合成并带 app_id 送进
// `POST /api/client/v2/apps/wasm/:app_id/request`，平台上不存在"按 Host 分流"这件事。
// 保留下来的都是与主机名无关的**纯原语**（见 primitives.go）。
//
// **边界铁律**（W4，抄自 §8.4）：本包内任何写安全头的函数都必须**接受调用方传入的
// selfOrigin**（`ApplyHostSecurityHeaders`、`WriteAppNotFound`），包内**不得**自行推导
// 自身源 —— 自行推导就是过去 `SelfOrigin` 那套主机名逻辑的入口，也正是被删掉的东西。
package edge

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// WriteAppNotFound 是应用请求的统一 404。
//
// 两条硬要求：
//   - 不泄露"这个 app_id 是否存在"（未登记 / 已软删 / 已冻结都走它）；
//   - 安全头照样要写（含 4xx/5xx）；是 API 路径时用平台 JSON 信封。
//
// selfOrigin 由**调用方**传入（appserver 的 `(*Server).selfOrigin`，唯一构造点是
// `AppOrigin(app_id)`）—— 本包不自行推导，见包注释的边界铁律。
func WriteAppNotFound(w http.ResponseWriter, r *http.Request, appLabel, selfOrigin string) {
	ApplyHostSecurityHeaders(w.Header(), selfOrigin)
	if wantsJSON(r) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(apperr.EnvelopeOf(
			apperr.New(apperr.CodeNotFound, "应用不存在").
				// reason 是**跨端契约**（契约 §5.1 失败行 / §7.7③）：客户端据此在
				// 三档之间选文案（不存在 / 已删除 / 已冻结）。这里给的是"未登记"
				// 那一档；冻结与软删由 appserver 用各自的 reason 单独报
				// —— 三档**不得塌缩**成同一个"应用不存在"。
				WithDetail("reason", "app_not_found").
				WithHint("请确认应用标识是否正确；应用标识一经发布不能改名")))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(appNotFoundHTML))
}

// wantsJSON 判定客户端期望 JSON（API 路径或显式 Accept: application/json）。
func wantsJSON(r *http.Request) bool {
	if r == nil {
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		return true
	}
	accept := strings.ToLower(r.Header.Get("Accept"))
	return strings.Contains(accept, "application/json")
}

// appNotFoundHTML 是极简 404 页（无外链、无内联脚本，符合自身 CSP）。
const appNotFoundHTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404</title></head>
<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem;color:#333">
<h1 style="font-size:1.25rem">应用不存在</h1>
<p style="color:#666">请确认应用标识是否正确。应用标识一经发布不能改名。</p>
</body></html>`

package llmgateway

// R4-C-7（审计 2026-09-23，P3）：**测试镜像与生产在 SSRF 传输层不同源**。
//
// 缺陷形态（修复前）：`routes.go` 的包内测试镜像用
// `&http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 120 * time.Second}}`
// 构造 API，而生产装配（handlers.go 的 NewHandlers、files.go、balance.go、
// channels/channel.go）一律走 `newUpstreamTransport()`（`util.SafeOutboundTransport()`
// 之上加响应头预算：连接期 IP 复检 + 代理路径复检）。镜像文件头只解释了"为什么用
// ResponseHeaderTimeout 而不是全量 Timeout"，没有说明这道**安全面**差异 ⇒ 所有经由
// 该镜像跑的用例，对"出站被 netguard 拦住"的行为与生产不等价。
//
// 判据两层（缺任何一层都会退化成"注释承诺"）：
//  1. **能力层**：镜像客户端与生产客户端的 transport 必须带同一套 guard 钩子
//     （Proxy == util.SafeOutboundProxyFromEnvironment、DialContext 非 nil、
//     ResponseHeaderTimeout 同值）—— 这是"拦住出站"的真正执行者；
//  2. **接线层**：`RegisterRoutes` 必须经 `routeMirrorClients()` 取客户端，且
//     routes.go 里不得再出现自建 `&http.Transport{`（辅助函数测得到 ≠ 被调用，
//     本仓既有教训：F2 provide 无判据）。
//
// 变异验证：把 `routes.go` 的 `client: mirrorClient` 换回
// `&http.Client{Transport: &http.Transport{...}}` ⇒ 本用例红。
import (
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/util"
)

// transportGuardHooks 提取一个 transport 的"出站守卫"三元组。
func transportGuardHooks(t *testing.T, c *http.Client) (proxy uintptr, hasDial bool, headerTimeout time.Duration) {
	t.Helper()
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport 类型 = %T, want *http.Transport", c.Transport)
	}
	if tr.Proxy == nil {
		return 0, false, tr.ResponseHeaderTimeout
	}
	return reflect.ValueOf(tr.Proxy).Pointer(), tr.DialContext != nil, tr.ResponseHeaderTimeout
}

func TestRouteMirrorClientsShareProductionOutboundGuards(t *testing.T) {
	mirror, mirrorSSE := routeMirrorClients()
	prod := upstreamHTTPClient()
	wantProxy, wantDial, wantHeader := transportGuardHooks(t, prod)
	if wantProxy == 0 || !wantDial {
		t.Fatalf("生产 transport 缺 guard 钩子（proxy=%v dial=%v）—— 判据基准不成立", wantProxy != 0, wantDial)
	}
	// 基准必须真的是 netguard 的代理复检（防止两边"一起退化"成同一份无守卫实现）。
	if got := reflect.ValueOf(util.SafeOutboundProxyFromEnvironment).Pointer(); got != wantProxy {
		t.Fatalf("生产 transport 的 Proxy 不是 util.SafeOutboundProxyFromEnvironment（%v vs %v）", wantProxy, got)
	}
	for name, c := range map[string]*http.Client{"mirror": mirror, "mirror-sse": mirrorSSE} {
		proxy, hasDial, header := transportGuardHooks(t, c)
		if proxy != wantProxy {
			t.Fatalf("%s 的 Proxy 钩子与生产不同源（%v vs %v）—— 镜像里的出站请求不会走 netguard 代理复检", name, proxy, wantProxy)
		}
		if !hasDial {
			t.Fatalf("%s 缺 DialContext 守卫（连接期 IP 复检）—— 与生产不同源", name)
		}
		if header != wantHeader {
			t.Fatalf("%s 的 ResponseHeaderTimeout = %v, want %v（与生产同值）", name, header, wantHeader)
		}
	}
}

func TestRoutesMirrorUsesTheSharedClientConstructor(t *testing.T) {
	src, err := os.ReadFile("routes.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	if !strings.Contains(text, "routeMirrorClients()") {
		t.Fatal("routes.go 的 RegisterRoutes 必须经 routeMirrorClients() 取客户端（与生产同源）")
	}
	if strings.Contains(text, "&http.Transport{") {
		t.Fatal("routes.go 不得自建裸 http.Transport（R4-C-7：镜像会丢掉 netguard，安全面与生产不等价）")
	}
}

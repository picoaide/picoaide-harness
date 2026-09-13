package channel

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 渠道素材(SVG)是**不可信输入**:内容来自镜像构建期注入的私有渠道仓
// (server/Dockerfile 的 COPY --from=channelassets),不是管理员在管理台里
// 敲出来的、也不经过管理端校验。
//
// 缺陷语义(审计 R7 branding-1):serveAsset 只设 Cache-Control 就 http.ServeFile,
// 于是**顶层导航**到 /api/client/v2/channel/logo 时浏览器按 image/svg+xml 渲染
// 该文档,内联 <script>/onload= 在**服务端源**上执行,并可携带 HttpOnly +
// SameSite=Lax 的 picoaide_session 读同源 /api/server/admin/me 的 csrf_token。
// (管理台/门户都用 <img> 消费素材,<img> 不执行脚本;触发路径是钓鱼链接/手输地址。)
//
// 因为渠道目录里没有可回落的"可信素材",这里不能丢弃内容(否则渠道 logo 变破图),
// 而是按桌面侧 brand-web-route.ts 的同款口径**下发时沙箱化**:CSP 禁脚本 +
// nosniff + Content-Disposition: inline。
//
// 注意断言口径:素材**字节必须原样下发**(不能靠改内容"修好"),防线在响应头。
func TestAssetResponsesBlockScriptExecutionFromChannelSvgs(t *testing.T) {
	// 攻击者素材:顶层导航即执行(onload= 与内联 <script> 双路径),
	// 并把同源管理接口的响应写进 title。
	const scriptishSVG = `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('/api/server/admin/me')">` +
		`<script>document.title='pwned'</script></svg>`
	withDir(t, map[string]string{
		"channel.json": `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme AI"},
          "assets":{"logo":"logo.svg","logo_dark":"logo-dark.svg","favicon":"logo.svg"}}`,
		"logo.svg":      scriptishSVG,
		"logo-dark.svg": scriptishSVG,
	})
	r := assetRouter()

	for _, path := range []string{"/channel/logo", "/channel/logo-dark", "/channel/favicon"} {
		t.Run(path, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200", path, w.Code)
			}
			// 素材字节原样下发(防线是响应头,不是改内容)。
			if w.Body.String() != scriptishSVG {
				t.Fatalf("GET %s body = %q, want 原样字节", path, w.Body.String())
			}
			csp := w.Header().Get("Content-Security-Policy")
			if csp == "" {
				t.Fatalf("GET %s 缺 Content-Security-Policy:顶层导航会执行渠道 SVG 里的脚本", path)
			}
			if !strings.Contains(csp, "default-src 'none'") {
				t.Fatalf("GET %s CSP = %q, want default-src 'none'(默认全禁)", path, csp)
			}
			// 没有 script-src 就不放开脚本(回落到 default-src 'none');出现
			// unsafe-eval 更是直接放行脚本执行。
			if strings.Contains(csp, "script-src") || strings.Contains(csp, "unsafe-eval") {
				t.Fatalf("GET %s CSP = %q 放开了脚本执行", path, csp)
			}
			if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
				t.Fatalf("GET %s X-Content-Type-Options = %q, want nosniff", path, got)
			}
			if got := w.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "inline") {
				t.Fatalf("GET %s Content-Disposition = %q, want inline", path, got)
			}
		})
	}
}

// 沙箱化不能把正常素材(非 SVG/正常 SVG)弄坏:字节、Content-Type 与长缓存不变。
func TestAssetResponsesKeepServingNormalAssets(t *testing.T) {
	withDir(t, map[string]string{
		"channel.json": `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme AI"},
          "assets":{"logo":"logo.svg"}}`,
		"logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`,
	})
	r := assetRouter()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/channel/logo", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("logo = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/svg+xml") {
		t.Fatalf("Content-Type = %q, want image/svg+xml", ct)
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "max-age=86400") {
		t.Fatalf("Cache-Control = %q, want 长缓存保留", cc)
	}
	if !strings.Contains(w.Body.String(), "<rect") {
		t.Fatalf("正常 SVG 未原样下发: %q", w.Body.String())
	}
}

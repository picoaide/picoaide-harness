package channel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---- P2-12(2026-09-13 审计):渠道 SVG 素材下发缺少防护 ----
//
// 素材是镜像内渠道目录里的**不可信输入**(CI 从私有渠道仓注入)。这里锁住两层:
//
//	第一层 响应头:nosniff + "文档型 SVG 也不能执行脚本"的沙箱 CSP;
//	第二层 内容检查:仅 .svg,命中脚本特征 = 拒绝下发,且回**同一个** 404 信封。
//
// 与桌面侧同源参考:packages/host/desktop/src/brand-web-route.ts。

// guardJSON 三套素材齐全;favicon 指向**位图**,用来验证"非 svg 不做内容检查"。
const guardJSON = `{
  "schema": 1,
  "channel_id": "acme",
  "identity": {"display_name": "Acme AI"},
  "assets": {"logo": "logo.svg", "logo_dark": "logo-dark.svg", "favicon": "favicon.png"}
}`

// cleanSVG 合法渠道 logo(纯 rect/path/circle,与 brands/official/logo.svg 同形状)。
// 刻意带 XML 声明里的 standalone="no":事件属性特征必须带"属性起始边界",否则
// 子串 `one=` 会把这份合法素材误拒(桌面侧 P1-12 踩过的坑)。
const cleanSVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">
  <rect x="0" y="0" width="1254" height="1254" rx="180" fill="#000000"/>
  <path d="M 334 409 C 300 409 273 431 273 466 V 548" fill="none" stroke="#FFFFFF" stroke-width="40"/>
  <circle cx="435" cy="627" r="65" fill="#FFFFFF"/>
</svg>`

// fakePNG 位图 favicon 的最小样本(内容里刻意塞了脚本特征,见下面的用例)。
const fakePNG = "\x89PNG\r\n\x1a\nfakepixels"

// get 请求一次(测试自建路由树;生产路径在 internal/router 声明)。
func get(t *testing.T, route string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	assetRouter().ServeHTTP(w, httptest.NewRequest(http.MethodGet, route, nil))
	return w
}

// assertAssetSecurityHeaders 断言 P2-12 的第一层:素材响应都带 nosniff 与沙箱 CSP。
func assertAssetSecurityHeaders(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if got := w.Header().Get("X-Content-Type-Options"); got != assetNoSniff {
		t.Errorf("X-Content-Type-Options = %q, want %q", got, assetNoSniff)
	}
	got := w.Header().Get("Content-Security-Policy")
	if got != assetCSP {
		t.Errorf("Content-Security-Policy = %q, want %q", got, assetCSP)
	}
	// 能力断言(不只看整串相等):必须真的关死脚本执行 ——
	// default-src 'none' 让 script-src 无源可用,sandbox 不带 allow-scripts
	// 让文档里的脚本根本无法执行。
	if !strings.Contains(got, "default-src 'none'") || !strings.Contains(got, "sandbox") ||
		strings.Contains(got, "allow-scripts") {
		t.Errorf("CSP 未关死脚本执行: %q", got)
	}
}

// errorEnvelope 解析错误信封(P2-12 要求拒绝下发与"未配置"形态一致)。
func errorEnvelope(t *testing.T, w *httptest.ResponseRecorder) (code, message string) {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON 错误信封: %q(%v)", w.Body.String(), err)
	}
	return body.Error.Code, body.Error.Message
}

// 合法素材:200 + 字节原样 + 两个安全头(三个端点都要)。
func TestAssetEndpointsSendNoSniffAndSandboxCSP(t *testing.T) {
	withDir(t, map[string]string{
		"channel.json":  guardJSON,
		"logo.svg":      cleanSVG,
		"logo-dark.svg": cleanSVG,
		"favicon.png":   fakePNG,
	})
	for _, tc := range []struct{ route, want string }{
		{"/channel/logo", cleanSVG},
		{"/channel/logo-dark", cleanSVG},
		{"/channel/favicon", fakePNG},
	} {
		t.Run(tc.route, func(t *testing.T) {
			w := get(t, tc.route)
			if w.Code != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200(%s)", tc.route, w.Code, w.Body.String())
			}
			if w.Body.String() != tc.want {
				t.Fatalf("GET %s 字节被改动: %q", tc.route, w.Body.String())
			}
			assertAssetSecurityHeaders(t, w)
		})
	}
}

// 未配置(404)同样带这两个头:三个端点的响应只有一种头集合,拒绝路径与它一致。
func TestAssetNotFoundSendsSameHeadersAndEnvelope(t *testing.T) {
	withDir(t, map[string]string{"channel.json": guardJSON}) // 素材文件一个都没有
	w := get(t, "/channel/logo")
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET /channel/logo = %d, want 404", w.Code)
	}
	assertAssetSecurityHeaders(t, w)
	if code, message := errorEnvelope(t, w); code != "NOT_FOUND" || message != "渠道未配置 logo" {
		t.Fatalf("未配置信封 = %s/%q", code, message)
	}
}

// 带脚本特征的 SVG:一律 404,且响应与"未配置"**逐字节一致**(不新增响应形态)。
func TestServeAssetRejectsScriptSVG(t *testing.T) {
	svgNS := `xmlns="http://www.w3.org/2000/svg"`

	// "未配置"基准响应(同一 handler 在文件缺失时的输出)。
	withDir(t, map[string]string{"channel.json": guardJSON})
	missing := get(t, "/channel/logo")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("基准:未配置时应 404, got %d", missing.Code)
	}

	cases := []struct{ name, body string }{
		{"script-element", `<svg ` + svgNS + `><script>alert(1)</script></svg>`},
		{"script-element-uppercase", `<svg ` + svgNS + `><SCRIPT>alert(1)</SCRIPT></svg>`},
		{"script-src-attribute", `<svg ` + svgNS + `><script xlink:href="//evil.example/x.js"/></svg>`},
		{"onload-double-quotes", `<svg ` + svgNS + ` onload="alert(1)"></svg>`},
		{"onload-spaces-single-quotes", `<svg ` + svgNS + ` onload = 'alert(1)'></svg>`},
		{"onerror", `<svg ` + svgNS + `><image onerror="alert(1)" href="x"/></svg>`},
		{"onclick-uppercase", `<svg ` + svgNS + ` ONCLICK="alert(1)"></svg>`},
		{"onbegin-animation-event", `<svg ` + svgNS + `><animate onbegin="alert(1)"/></svg>`},
		{"javascript-url", `<svg ` + svgNS + `><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`},
		{"javascript-url-uppercase", `<svg ` + svgNS + `><a href="JaVaScRiPt:alert(1)"/></svg>`},
		{"javascript-url-entity-encoded", `<svg ` + svgNS + `><a xlink:href="&#106;avascript:alert(1)"><text>x</text></a></svg>`},
		{"foreignobject-element", `<svg ` + svgNS + `><foreignObject width="10" height="10"></foreignObject></svg>`},
		{"use-external-http", `<svg ` + svgNS + `><use xlink:href="http://evil.example/x.svg#p"/></svg>`},
		{"use-external-https", `<svg ` + svgNS + `><use href="https://evil.example/x.svg#p"/></svg>`},
		{"use-external-protocol-relative", `<svg ` + svgNS + `><use xlink:href = "//evil.example/x.svg#p"/></svg>`},
		{"iframe-element", `<svg ` + svgNS + `><iframe src="https://evil.example"></iframe></svg>`},
		{"embed-element", `<svg ` + svgNS + `><embed src="https://evil.example"/></svg>`},
		{"animate-href-attribute", `<svg ` + svgNS + `><animate attributeName="href" to="javascript:alert(1)"/></svg>`},
		{"animate-href-attribute-spaces", `<svg ` + svgNS + `><animate attributeName = 'href' to="x"/></svg>`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withDir(t, map[string]string{"channel.json": guardJSON, "logo.svg": tc.body})
			w := get(t, "/channel/logo")
			if w.Code != http.StatusNotFound {
				t.Fatalf("带脚本特征的 SVG 被下发: %d %q", w.Code, w.Body.String())
			}
			if w.Body.String() != missing.Body.String() {
				t.Errorf("拒绝响应与\"未配置\"不一致:\n got %s\nwant %s", w.Body.String(), missing.Body.String())
			}
			if code, message := errorEnvelope(t, w); code != "NOT_FOUND" || message != "渠道未配置 logo" {
				t.Errorf("拒绝信封 = %s/%q", code, message)
			}
			assertAssetSecurityHeaders(t, w)
		})
	}
}

// 内容检查只认 .svg:位图素材(哪怕字节里带脚本特征)照常下发。
func TestServeAssetSkipsContentCheckForNonSVG(t *testing.T) {
	withDir(t, map[string]string{
		"channel.json": guardJSON,
		"logo.svg":     cleanSVG,
		"favicon.png":  fakePNG + `<script>alert(1)</script>`,
	})
	w := get(t, "/channel/favicon")
	if w.Code != http.StatusOK {
		t.Fatalf("位图 favicon 被内容检查误拒: %d %q", w.Code, w.Body.String())
	}
	if !strings.HasPrefix(w.Body.String(), fakePNG) {
		t.Fatalf("位图字节被改动: %q", w.Body.String())
	}
	assertAssetSecurityHeaders(t, w)
}

// 扩展名判定大小写不敏感:渠道把素材写成 .SVG 也照样受检。
func TestServeAssetChecksSVGExtensionCaseInsensitively(t *testing.T) {
	withDir(t, map[string]string{
		"channel.json": `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme AI"},
          "assets":{"logo":"logo.SVG"}}`,
		"logo.SVG": `<svg onload="alert(1)"/>`,
	})
	if w := get(t, "/channel/logo"); w.Code != http.StatusNotFound {
		t.Fatalf(".SVG 未被内容检查拦下: %d %q", w.Code, w.Body.String())
	}
}

// 超过 1MB 的 SVG:内容检查不读(取舍与理由见 checkAssetContent 注释),照常下发,
// 由响应头的 sandbox CSP 兜住"不执行脚本"这条底线。
func TestServeOversizedSVGUnderCSP(t *testing.T) {
	big := cleanSVG + strings.Repeat("<!-- padding -->\n", maxCheckedSVGBytes/8)
	if len(big) <= maxCheckedSVGBytes {
		t.Fatalf("样本没有超过上限: %d", len(big))
	}
	withDir(t, map[string]string{"channel.json": guardJSON, "logo.svg": big})
	w := get(t, "/channel/logo")
	if w.Code != http.StatusOK {
		t.Fatalf("超限 SVG 应照常下发(CSP 兜底), got %d", w.Code)
	}
	if w.Body.Len() != len(big) {
		t.Fatalf("下发字节数 = %d, want %d", w.Body.Len(), len(big))
	}
	assertAssetSecurityHeaders(t, w)
}

// 官方几何真源(brands/official/logo.svg 与反色版)必须被放行 ——
// 误拒的直接后果是登录页/门户的 logo 变破图。
func TestOfficialBrandLogoPassesAssetGuard(t *testing.T) {
	cases := []struct{ file, route string }{
		{"logo.svg", "/channel/logo"},
		{"logo-dark.svg", "/channel/logo-dark"},
	}
	for _, tc := range cases {
		t.Run(tc.file, func(t *testing.T) {
			// 从 channel 包出发到仓库根是三级。
			src := filepath.Join("..", "..", "..", "brands", "official", tc.file)
			raw, err := os.ReadFile(src)
			if err != nil {
				t.Skipf("取不到 %s(%v):测试环境不含 brands/ 时跳过,不误报红", src, err)
			}
			// 1) 内容检查必须放行真实官方矢量。
			if reason := checkAssetContent(src); reason != "" {
				t.Fatalf("官方 %s 被内容检查误拒: %s", tc.file, reason)
			}
			// 2) 走端点同样 200、字节原样、带安全头。
			withDir(t, map[string]string{"channel.json": guardJSON, tc.file: string(raw)})
			w := get(t, tc.route)
			if w.Code != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200(%s)", tc.route, w.Code, w.Body.String())
			}
			if w.Body.String() != string(raw) {
				t.Errorf("下发字节与官方素材不一致")
			}
			assertAssetSecurityHeaders(t, w)
		})
	}
}

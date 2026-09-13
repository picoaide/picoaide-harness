package channel

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---- checkAssetContent:SVG 内容检查的单元层(唯一真源) ----

// writeAsset 在临时目录写一个素材文件并返回路径(内容检查只吃路径)。
func writeAsset(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// 脚本特征表逐条命中(大小写不敏感;空白与属性引号差异都要覆盖)。
func TestCheckAssetContentSignatures(t *testing.T) {
	svgNS := `xmlns="http://www.w3.org/2000/svg"`

	cases := []struct{ name, body string }{
		// <script
		{"script", `<svg ` + svgNS + `><script>alert(1)</script></svg>`},
		{"script-uppercase", `<svg ` + svgNS + `><SCRIPT>alert(1)</SCRIPT></svg>`},
		{"script-self-closing", `<svg ` + svgNS + `><script src="x.js"/></svg>`},
		{"script-whitespace", "<svg " + svgNS + "><\tscript>alert(1)</\tscript></svg>"},
		// on* 事件属性(带属性起始边界的写法,含空白/单双引号差异)
		{"onload", `<svg ` + svgNS + ` onload="alert(1)"></svg>`},
		{"onload-no-quotes", `<svg ` + svgNS + ` onload=alert(1)></svg>`},
		{"onload-spaces", `<svg ` + svgNS + ` onload = 'alert(1)'></svg>`},
		{"onerror", `<svg ` + svgNS + `><image onerror="alert(1)" href="x"/></svg>`},
		{"onclick-uppercase", `<svg ` + svgNS + ` ONCLICK = "alert(1)"></svg>`},
		{"onbegin", `<svg ` + svgNS + `><animate onbegin="alert(1)"/></svg>`},
		{"onload-after-slash", `<svg ` + svgNS + `><rect/onload="alert(1)"/></svg>`},
		// javascript:
		{"javascript", `<svg ` + svgNS + `><a xlink:href="javascript:alert(1)"/></svg>`},
		{"javascript-mixed-case", `<svg ` + svgNS + `><a href="JaVaScRiPt:alert(1)"/></svg>`},
		{"javascript-embedded-newline", "<svg " + svgNS + "><a href=\"java\nscript:alert(1)\"/></svg>"},
		{"javascript-numeric-entity", `<svg ` + svgNS + `><a href="&#106;avascript:alert(1)"/></svg>`},
		{"javascript-hex-entity", `<svg ` + svgNS + `><a href="&#x6a;avascript:alert(1)"/></svg>`},
		// <foreignObject
		{"foreignobject", `<svg ` + svgNS + `><foreignObject width="1" height="1"/></svg>`},
		{"foreignobject-case", `<svg ` + svgNS + `><FOREIGNOBJECT width="1" height="1"/></svg>`},
		// <use 指向外部
		{"use-http", `<svg ` + svgNS + `><use xlink:href="http://evil.example/x.svg#p"/></svg>`},
		{"use-https", `<svg ` + svgNS + `><use href="https://evil.example/x.svg#p"/></svg>`},
		{"use-protocol-relative", `<svg ` + svgNS + `><use xlink:href="//evil.example/x.svg#p"/></svg>`},
		{"use-spaces", `<svg ` + svgNS + `><use xlink:href = 'http://evil.example/x.svg#p'/></svg>`},
		// <iframe / <embed
		{"iframe", `<svg ` + svgNS + `><iframe src="https://evil.example"></iframe></svg>`},
		{"embed", `<svg ` + svgNS + `><embed src="https://evil.example"/></svg>`},
		// <animate attributeName="href"
		{"animate-href", `<svg ` + svgNS + `><animate attributeName="href" to="javascript:alert(1)"/></svg>`},
		{"animate-href-spaces", `<svg ` + svgNS + `><animate attributeName = 'href' to="x"/></svg>`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeAsset(t, "logo.svg", tc.body)
			if reason := checkAssetContent(path); reason == "" {
				t.Fatalf("脚本特征未被拦下(%s): %q", tc.name, tc.body)
			}
		})
	}
}

// 合法渠道素材不得被误拒(误拒 = 登录页/门户破图)。
func TestCheckAssetContentAllowsCleanSVG(t *testing.T) {
	cases := []struct{ name, body string }{
		{"brand-logo", cleanSVG},
		{"xml-declaration-standalone", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`},
		{"inline-style", `<svg xmlns="http://www.w3.org/2000/svg"><style>.tile{fill:#000}</style><rect class="tile" width="10" height="10"/></svg>`},
		{"internal-use-reference", `<svg xmlns="http://www.w3.org/2000/svg"><defs><circle id="n" r="5"/></defs><use href="#n"/></svg>`},
		{"animate-transform", `<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"><animate attributeName="width" to="8" dur="1s"/></rect></svg>`},
		{"inline-comment", `<svg xmlns="http://www.w3.org/2000/svg"><!-- connector on node 1 --><circle r="5"/></svg>`},
		{"word-javascriptless", `<svg xmlns="http://www.w3.org/2000/svg"><desc>no javascript here</desc></svg>`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeAsset(t, "logo.svg", tc.body)
			if reason := checkAssetContent(path); reason != "" {
				t.Fatalf("合法 SVG 被误拒(%s): %s", tc.name, reason)
			}
		})
	}
}

// 事件属性特征必须带"属性起始边界":XML 声明里的 standalone="no" 含子串 `one=`,
// 裸的 on[a-z]+\s*= 会把它当成事件属性 —— 桌面侧 P1-12 的误拒就是这条。
func TestCheckAssetContentDoesNotFlagStandalone(t *testing.T) {
	path := writeAsset(t, "logo.svg",
		`<?xml version="1.0" encoding="UTF-8" standalone="no"?><svg xmlns="http://www.w3.org/2000/svg"/>`)
	if reason := checkAssetContent(path); reason != "" {
		t.Fatalf("standalone=\"no\" 被误判为事件属性: %s", reason)
	}
}

// 内容检查只对 .svg 生效(按文件扩展名):位图素材一律放行。
func TestCheckAssetContentOnlyForSVG(t *testing.T) {
	scripty := `<script>alert(1)</script>`
	for _, name := range []string{"favicon.png", "logo", "logo.svg.png", "logo.webp"} {
		path := writeAsset(t, name, scripty)
		if reason := checkAssetContent(path); reason != "" {
			t.Errorf("%s 不该做内容检查: %s", name, reason)
		}
	}
	// 扩展名大小写不敏感。
	if reason := checkAssetContent(writeAsset(t, "logo.SVG", scripty)); reason == "" {
		t.Errorf(".SVG 应同样受检")
	}
}

// 文件读不到时不拦(交给 ServeFile 按既有语义处理),不改变既有 404/403 行为。
func TestCheckAssetContentTolerantToReadFailure(t *testing.T) {
	if reason := checkAssetContent(filepath.Join(t.TempDir(), "missing.svg")); reason != "" {
		t.Fatalf("读不到的文件不该在这里拦: %s", reason)
	}
}

// 超过 1MB:不做内容检查(取舍与理由见 checkAssetContent 的注释 —— "不执行脚本"
// 这条底线由响应头 sandbox CSP 保证,与体积无关;拒绝反而会把合法的复杂矢量
// logo 变成破图)。这里把该决策钉住,避免有人误以为检查覆盖所有体积。
func TestCheckAssetContentSkipsOversizedFile(t *testing.T) {
	body := cleanSVG + strings.Repeat("<!-- padding -->\n", maxCheckedSVGBytes/8)
	if len(body) <= maxCheckedSVGBytes {
		t.Fatalf("样本没有超过上限: %d", len(body))
	}
	if reason := checkAssetContent(writeAsset(t, "logo.svg", body)); reason != "" {
		t.Fatalf("超限文件不该做内容检查: %s", reason)
	}
}

// readCapped 的边界:刚好等于上限读完(tooLarge=false),多一个字节即 tooLarge。
func TestReadCappedBoundary(t *testing.T) {
	exact := writeAsset(t, "logo.svg", strings.Repeat("a", int(maxCheckedSVGBytes)))
	data, tooLarge, err := readCapped(exact, maxCheckedSVGBytes)
	if err != nil || tooLarge {
		t.Fatalf("恰好等于上限: tooLarge=%v err=%v", tooLarge, err)
	}
	if len(data) != int(maxCheckedSVGBytes) {
		t.Fatalf("读到 %d 字节", len(data))
	}

	over := writeAsset(t, "logo.svg", strings.Repeat("a", int(maxCheckedSVGBytes)+1))
	data, tooLarge, err = readCapped(over, maxCheckedSVGBytes)
	if err != nil || !tooLarge {
		t.Fatalf("超过上限: tooLarge=%v err=%v", tooLarge, err)
	}
	if len(data) != int(maxCheckedSVGBytes) {
		t.Fatalf("超过上限时读到了 %d 字节, want %d", len(data), maxCheckedSVGBytes)
	}
}

// 数字字符引用解码:只解数字引用,解不出来的原样保留。
func TestDecodeNumericCharRefs(t *testing.T) {
	cases := []struct{ in, want string }{
		{`&#106;avascript:`, `javascript:`},
		{`&#x6a;avascript:`, `javascript:`},
		{`&#X6A;`, `j`},
		{`&#38;`, `&`},
		{`&amp;`, `&amp;`},             // 命名实体不在解码范围(还原也构造不出脚本特征)
		{`&#99999999;`, `&#99999999;`}, // 超出 Unicode 范围,原样保留
		{`&#0;`, `&#0;`},               // NUL 无意义,原样保留
		{`plain text`, `plain text`},
	}
	for _, tc := range cases {
		if got := decodeNumericCharRefs(tc.in); got != tc.want {
			t.Errorf("decodeNumericCharRefs(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

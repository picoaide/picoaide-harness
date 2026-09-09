package brand

import (
	"strings"
	"testing"
)

// P3 回归:SVG 实体编码绕过——属性值里的字符引用会被 XML 解析器还原,
// 只按原串做正则剥离会漏掉 xlink:href="&#x6a;avascript:…"。
func TestSanitizeSVGRejectsEntityEncodedJSURL(t *testing.T) {
	cases := []string{
		`<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="&#x6a;avascript:alert(1)"><text>x</text></a></svg>`,
		`<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:alert(1)"><text>x</text></a></svg>`,
		// 二次编码(&amp;#x6a;)同样要还原后命中。
		`<svg xmlns="http://www.w3.org/2000/svg"><a href="&amp;#x6a;avascript:alert(1)"><text>x</text></a></svg>`,
		// 编码后的 <script> 标记。
		`<svg xmlns="http://www.w3.org/2000/svg"><text>&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;</text></svg>`,
		// 编码的 javascript: 混在正常内容里。
		`<svg xmlns="http://www.w3.org/2000/svg"><text>java&#x73;cript:alert(1)</text></svg>`,
	}
	for i, raw := range cases {
		if _, ok := sanitizeSVG([]byte(raw)); ok {
			t.Fatalf("case %d: sanitizeSVG accepted entity-encoded payload: %s", i, raw)
		}
	}
}

// 明文危险内容仍按原行为剥离(不回归)。
func TestSanitizeSVGStripsPlainDangerous(t *testing.T) {
	raw := `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)"><text>hi</text></a></svg>`
	out, ok := sanitizeSVG([]byte(raw))
	if !ok {
		t.Fatal("sanitizeSVG rejected a well-formed svg")
	}
	s := strings.ToLower(string(out))
	for _, bad := range []string{"<script", "onload=", "javascript:"} {
		if strings.Contains(s, bad) {
			t.Fatalf("sanitized svg still contains %q: %s", bad, s)
		}
	}
	if !strings.Contains(string(out), "<text>hi</text>") {
		t.Fatalf("legitimate content dropped: %s", out)
	}
}

// 合法 SVG(含 &amp; 实体)必须原样通过。
func TestSanitizeSVGKeepsLegitSVG(t *testing.T) {
	raw := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/><text>A &amp; B</text></svg>`
	out, ok := sanitizeSVG([]byte(raw))
	if !ok {
		t.Fatal("sanitizeSVG rejected legitimate svg")
	}
	if string(out) != raw {
		t.Fatalf("legitimate svg modified:\n got %s\nwant %s", out, raw)
	}
}

// 非法 XML 一律拒绝。
func TestSanitizeSVGRejectsMalformedXML(t *testing.T) {
	for _, raw := range []string{"<svg><unclosed>", "not xml at all", ""} {
		if _, ok := sanitizeSVG([]byte(raw)); ok {
			t.Fatalf("sanitizeSVG(%q) = ok, want reject", raw)
		}
	}
}

func TestDecodeCharRefs(t *testing.T) {
	cases := map[string]string{
		"&#x6a;":       "j",
		"&#106;":       "j",
		"&amp;lt;":     "<",
		"&amp;amp;":    "&",
		"a&#x3c;b":     "a<b",
		"no entities":  "no entities",
		"&unknownent;": "&unknownent;",
		"&#xZZ;":       "&#xZZ;",
		"&#0;":         "&#0;",
	}
	for in, want := range cases {
		if got := decodeCharRefs(in); got != want {
			t.Fatalf("decodeCharRefs(%q) = %q, want %q", in, got, want)
		}
	}
	// 多层编码在最多 5 轮内收敛。
	if got := decodeCharRefs("&amp;amp;amp;lt;"); got != "<" {
		t.Fatalf("triple-encoded decode = %q, want <", got)
	}
}

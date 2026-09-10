package portal

import (
	"strings"
	"testing"
)

// 门户渲染的数据(渠道内容)必须全部转义:渠道配置里的尖括号/引号不得变成标签。
// 内容来源虽是构建期可信的私有仓,但"可信"不等于"可以拼接进 HTML"。
func TestRenderEscapesChannelContent(t *testing.T) {
	html := Render(View{
		Name:      `<script>alert(1)</script>`,
		Tagline:   `" onload="evil()`,
		Welcome:   `<img src=x onerror=alert(2)>`,
		AdminURL:  "/admin/",
		Version:   `1.0.0">&lt;`,
		Channel:   `acme"><b>`,
		LogoURL:   `javascript:alert(3)`, // 属性上下文:html/template 会替换为 #ZgotmplZ
		Downloads: []Platform{{Name: `<b>Win</b>`, Meta: `x`, URL: `" onmouseover="x`}},
	})

	if strings.Contains(html, "<script>alert(1)</script>") {
		t.Fatal("名称未转义")
	}
	// 文本上下文里 `<` 必须变成 &lt;:此时整串只是纯文本,不构成标签。
	// 注意不能直接断言 `!strings.Contains(html, "<img")` —— 模板本身的
	// logo 分支就含 <img(结构,非注入),要断言的是**注入串**的转义形态。
	if !strings.Contains(html, "&lt;img src=x onerror=alert(2)&gt;") {
		t.Fatal("欢迎语应转义后原样显示")
	}
	if strings.Contains(html, `<img src=x onerror=alert(2)>`) {
		t.Fatal("欢迎语未转义(可直接注入标签)")
	}
	// 属性上下文里引号必须转义,否则可以闭合属性注入 onload
	if strings.Contains(html, `onload="evil()`) {
		t.Fatal("标语里的引号未转义(可闭合属性)")
	}
	if !strings.Contains(html, "&quot;") && !strings.Contains(html, "&#34;") {
		t.Fatal("标语中的引号应被转义")
	}
	if strings.Contains(html, "<b>Win</b>") {
		t.Fatal("平台名未转义")
	}
	// 转义后的形态应当出现(证明内容确实被渲染而不是被吞掉)
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Fatal("名称应被转义后渲染")
	}
}

// 渠道未配置时的兜底:空字段不产生空区块(门户不应出现"undefined"或空标题)。
func TestRenderOmitsEmptyBlocks(t *testing.T) {
	html := Render(View{Name: "PicoAide", AdminURL: "/admin/"})
	if strings.Contains(html, "{{") || strings.Contains(html, "undefined") {
		t.Fatalf("模板未正确执行: %s", html[:200])
	}
	if strings.Contains(html, `class="empty"`) {
		t.Fatal("未提供 Downloads 时应直接省略下载区，而不是显示空态")
	}
}

// 有下载项时渲染按钮,地址原样透传(服务端拼好的绝对/相对地址)。
func TestRenderDownloads(t *testing.T) {
	html := Render(View{
		Name: "PicoAide", AdminURL: "/admin/",
		Downloads: []Platform{
			{Name: "Windows", Meta: "x64 · .exe", URL: "/updates/client/a.exe"},
			{Name: "macOS", Meta: "该平台暂无可用安装包"},
		},
	})
	if !strings.Contains(html, `href="/updates/client/a.exe"`) {
		t.Fatal("可下载平台应渲染链接")
	}
	// 无 URL 的平台渲染为不可用态(span + off),不给坏链接
	if strings.Contains(html, `href=""`) {
		t.Fatal("不可用平台不应渲染空链接")
	}
}

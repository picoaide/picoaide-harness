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
	if strings.Contains(html, `class="empty`) {
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
	// 下载徽标必须是**内联 SVG**,不能用文字箭头:文字符号(U+2193)不在系统字体
	// 主字集里,回退字形实测被渲染成歪斜的"¡"状残字(2026-09-14 真机截图发现)。
	if !strings.Contains(html, "<svg") {
		t.Fatal("下载徽标应使用内联 SVG 箭头")
	}
	if strings.Contains(html, "↓") {
		t.Fatal("下载徽标不得使用文字箭头(字体回退会渲染成残字)")
	}
}

// 全部平台都拿不到安装包时,不能再说"下载 → 安装 → 登录"(让访客下载不到东西
// 是空话),也不该摆三张一模一样的"暂无"死卡 —— 换一块说清原因的提示;
// 有一条可用就照常显示卡片。
func TestRenderLeadOnlyWhenDownloadable(t *testing.T) {
	allOff := Render(View{Name: "PicoAide", AdminURL: "/admin/", Downloads: []Platform{
		{Name: "Windows", Meta: "该平台暂无可用安装包"},
		{Name: "macOS", Meta: "该平台暂无可用安装包"},
	}})
	if strings.Contains(allOff, "用企业账号登录") {
		t.Fatal("无任何可用安装包时不应显示下载引导")
	}
	if !strings.Contains(allOff, `class="empty`) {
		t.Fatal("全部平台不可用时应显示统一提示,而不是三张死卡")
	}
	if strings.Contains(allOff, "该平台暂无可用安装包") {
		t.Fatal("全部平台不可用时不应再逐张渲染不可用卡片")
	}
	oneOn := Render(View{Name: "PicoAide", AdminURL: "/admin/", Downloads: []Platform{
		{Name: "Windows", Meta: "x64 · .exe", URL: "/updates/client/a.exe"},
		{Name: "macOS", Meta: "该平台暂无可用安装包"},
	}})
	if !strings.Contains(oneOn, "用企业账号登录") {
		t.Fatal("有可用安装包时应显示下载引导")
	}
	// 部分可用时,不可用平台仍按卡片呈现(让访客知道该平台确实没有,而不是漏了)
	if !strings.Contains(oneOn, `class="dl off`) {
		t.Fatal("部分可用时应保留不可用平台的占位卡片")
	}
}

// 2026-09-14 产品约定:门户访客是普通员工,首屏第一动作必须是**下载客户端**,
// 管理后台入口不得出现在首屏(员工会点进去看到自己无法使用的管理登录页)。
//
// 这条测试守护的是"分流"而不是"文案":既要求下载区在管理链接之前,也要求
// 页面不再有任何按钮式管理入口(管理员仍可从页脚低调进入,直接访问 /admin/ 亦可)。
func TestRenderDownloadFirstAndNoAdminCallToAction(t *testing.T) {
	html := Render(View{
		Name: "PicoAide", Tagline: "企业级 AI 办公智能体平台",
		Welcome:  "统一接入企业内网 AI 能力。",
		AdminURL: "/admin/", Version: "2.7.2",
		Downloads: []Platform{
			{Name: "Windows", Meta: "x64 · .exe 安装程序", URL: "/updates/client/a.exe"},
			{Name: "macOS", Meta: "Apple 芯片 (M 系列) · .dmg 磁盘映像", URL: "/updates/client/a.dmg"},
			{Name: "Linux", Meta: "x64 · .AppImage / .deb", URL: "/updates/client/a.AppImage"},
		},
	})

	dl := strings.Index(html, "客户端下载")
	admin := strings.Index(html, `href="/admin/"`)
	if dl < 0 {
		t.Fatal("门户必须渲染下载区")
	}
	if admin < 0 {
		t.Fatal("管理员入口应从页脚进入(缺链接会让运维找不到后台)")
	}
	if dl > admin {
		t.Fatal("下载区必须在管理入口之前(首屏给员工,不给管理登录)")
	}
	// 按钮式入口已移除:页面里不再有 .btn 系列样式/文案,管理入口只剩一处页脚链接。
	if strings.Contains(html, "进入管理后台") || strings.Contains(html, "btn-primary") {
		t.Fatal("管理后台不得再作为首屏按钮出现")
	}
	if n := strings.Count(html, `href="/admin/"`); n != 1 {
		t.Fatalf("管理入口应只保留页脚一处,实际 %d 处", n)
	}
	// 页脚不写渠道名(2026-09-14 用户要求):访客是员工,内部渠道标识对他们是噪音,
	// 也没必要让他们知道本部署跑在哪条发布线上。渠道标识曾用 <code> 渲染。
	if strings.Contains(html, "<code>") {
		t.Fatal("页脚不得渲染渠道标识")
	}
	// 下载按钮必须带「下载」文字:无字圆点在窄屏宽行卡片里不像按钮(2026-09-14 用户指出)。
	if !strings.Contains(html, ">下载</span>") {
		t.Fatal("下载按钮应带文字标签")
	}
}

// 深色主题必须换用**暗色版 logo**:浅色版是黑底白 mark,贴在深色背景上几乎
// 看不见(2026-09-14 用户指出)。门户跟随系统深浅色,所以用 <picture> 的
// <source media="(prefers-color-scheme: dark)"> 让浏览器自己挑 —— 服务端渲染时
// 并不知道访客用哪个主题。
func TestRenderLogoThemeVariants(t *testing.T) {
	const light, dark = "/api/client/v2/channel/logo", "/api/client/v2/channel/logo-dark"
	both := Render(View{Name: "PicoAide", AdminURL: "/admin/", LogoURL: light, LogoDarkURL: dark})
	if !strings.Contains(both, "prefers-color-scheme: dark") {
		t.Fatal("深色主题应切换到暗色版 logo")
	}
	if !strings.Contains(both, `srcset="`+dark+`"`) {
		t.Fatal("暗色版应以 srcset 下发")
	}
	if !strings.Contains(both, `src="`+light+`"`) {
		t.Fatal("浅色版仍是默认 img 源")
	}
	// 渠道没做暗色版(LogoDarkURL 为空)时不得给出会 404 的 source
	onlyLight := Render(View{Name: "PicoAide", AdminURL: "/admin/", LogoURL: light})
	if strings.Contains(onlyLight, "prefers-color-scheme: dark") {
		t.Fatal("渠道未配暗色版时不应渲染 dark source")
	}
	if !strings.Contains(onlyLight, `src="`+light+`"`) {
		t.Fatal("只有浅色版时应照常渲染")
	}
	// 完全没配 logo:退回文字标识,不能出现空 img
	if noLogo := Render(View{Name: "PicoAide", AdminURL: "/admin/"}); strings.Contains(noLogo, "<img") {
		t.Fatal("未配 logo 时应使用文字标识")
	}
}

// 下载区之后必须有功能说明(员工据此判断"装完能干什么"),且顺序在下载之后。
func TestRenderFeatures(t *testing.T) {
	html := Render(View{
		Name: "PicoAide", AdminURL: "/admin/",
		Downloads: []Platform{{Name: "Windows", Meta: "x64 · .exe", URL: "/updates/client/a.exe"}},
	})

	feat := strings.Index(html, "客户端功能")
	if feat < 0 {
		t.Fatal("门户应渲染客户端功能说明")
	}
	if feat < strings.Index(html, "客户端下载") {
		t.Fatal("功能说明应排在下载区之后(先让访客拿到客户端)")
	}
	for _, f := range featureList() {
		if !strings.Contains(html, f.Title) || !strings.Contains(html, f.Detail) {
			t.Fatalf("功能项 %q 未渲染", f.Title)
		}
	}
}

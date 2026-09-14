package portal

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// markRe 抓取品牌标记区块的 inner HTML(模板里唯一 span class="mark")。
var markRe = regexp.MustCompile(`(?s)<span class="mark">(.*?)</span>`)

// R7-RV-6:回落的品牌标记同时下发**两个配色变体**(同一份几何、仅颜色翻转),
// 用 class 区分,由 CSS 按 prefers-color-scheme 显隐;测试必须能分别抓到两版,
// 才能各自与权威文件对拍。
var (
	markLightRe = regexp.MustCompile(`(?s)<svg[^>]*class="mark-light"[^>]*>.*?</svg>`)
	markDarkRe  = regexp.MustCompile(`(?s)<svg[^>]*class="mark-dark"[^>]*>.*?</svg>`)
	// svgAttrRe 抓 SVG 属性对(与权威文件逐属性对拍用)。
	svgAttrRe = regexp.MustCompile(`[a-zA-Z-]+="[^"]*"`)
	// svgColorRe 抓颜色值(几何比对时抹掉,只留形状/坐标)。
	svgColorRe = regexp.MustCompile(`"#[0-9A-Fa-f]{3,8}"`)
	// schemeAnyRe 抓所有 prefers-color-scheme 块,返回 (scheme, body)。
	// 变体显隐必须与 token 集**同一条件**;两处规则在文件里可以分块声明
	// (CSS 不接受把后面的选择器写进前面的块而不被后面的默认值覆盖),
	// 所以对拍的是"用了哪条查询",而不是"在不在同一个块里"。
	schemeAnyRe = regexp.MustCompile(`(?s)@media \(prefers-color-scheme: (light|dark)\)\{(.*?)\n  \}`)
)

// schemeOf 返回包含 needle 的那条媒体查询名(light/dark);找不到即 fatal。
func schemeOf(t *testing.T, html, needle, what string) string {
	t.Helper()
	for _, m := range schemeAnyRe.FindAllStringSubmatch(html, -1) {
		if strings.Contains(m[2], needle) {
			return m[1]
		}
	}
	t.Fatalf("CSS 里找不到 %s(needle=%q)", what, needle)
	return ""
}

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
//
// 2026-09-13(R7 srvcore-5):本用例原来断言 `!strings.Contains(html, "class=\"empty\"")`,
// 而模板在无下载项时渲染的是 `<div class="empty rise" …>` —— `class="empty"`
// 根本不是它的子串,`t.Fatal` 分支不可达(恒真),注释还写着"应直接省略下载区",
// 与模板真实行为(渲染空态提示)相反。现在按产品真实意图断言**空态**:
// 断言改查真实片段与文案,注释同步。
func TestRenderOmitsEmptyBlocks(t *testing.T) {
	html := Render(View{Name: "PicoAide", AdminURL: "/admin/"})
	if strings.Contains(html, "{{") || strings.Contains(html, "undefined") {
		t.Fatalf("模板未正确执行: %s", html[:200])
	}
	// 空字段不产生区块:没有标语/欢迎语时不留空标签。
	if strings.Contains(html, `class="tagline"`) || strings.Contains(html, `class="welcome"`) {
		t.Fatal("空标语/欢迎语不应渲染空区块")
	}
	// 无 Downloads 时渲染**空态提示**(而不是空表/坏链接)。
	if !strings.Contains(html, `class="empty rise"`) {
		t.Fatal("未提供 Downloads 时应渲染空态区块")
	}
	if !strings.Contains(html, "本服务端暂未提供客户端安装包") {
		t.Fatal("空态区块应带可读文案")
	}
	// 空态是唯一形态:不得同时出现下载网格。
	if strings.Contains(html, `class="dl`) {
		t.Fatal("无下载项时不得渲染下载卡片")
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

// markVariant 从渲染出的标记区块里取指定配色变体(缺失即 fatal)。
func markVariant(t *testing.T, mark, name string, re *regexp.Regexp) string {
	t.Helper()
	v := re.FindString(mark)
	if v == "" {
		t.Fatalf("标记区块缺 %s 变体(主题切换缺一半): %q", name, mark)
	}
	return v
}

// markGeometry 抹掉颜色后返回变体的标记本体(去掉根 <svg> 标签:两版的分支
// 只允许 class 与颜色不同)。归一化后两版必须逐字节相同 —— 这直接证明
// "同一份几何、只有配色翻转"(AGENTS.md:logo.svg ↔ logo-dark.svg 的关系)。
func markGeometry(t *testing.T, variant string) string {
	t.Helper()
	gt := strings.Index(variant, ">")
	if gt < 0 {
		t.Fatalf("变体不是完整 SVG: %q", variant)
	}
	body := variant[gt+1:]
	if !svgColorRe.MatchString(body) {
		t.Fatalf("变体里没有颜色属性,无法建立配色关系: %q", variant)
	}
	return svgColorRe.ReplaceAllString(body, `"#COLOR"`)
}

// authorityAttrs 抽取权威 SVG 中**标记本体**(<rect> 起)的全部属性对。
// 根 <svg> 的 xmlns/width/height/viewBox 不参与:权威文件是 1254 定尺寸,
// 内联版按 100% 自适应,那几个不是几何真源的一部分。
func authorityAttrs(t *testing.T, file, source string) []string {
	t.Helper()
	i := strings.Index(source, "<rect")
	if i < 0 {
		t.Fatalf("%s 里找不到 <rect>(权威文件结构已变,测试需同步)", file)
	}
	attrs := svgAttrRe.FindAllString(source[i:], -1)
	if len(attrs) < 10 {
		t.Fatalf("%s 只抽到 %d 个属性,太少(测试正则已过期)", file, len(attrs))
	}
	return attrs
}

// ---------------------------------------------------------------------------
// 审计 R7 branding-5:渠道未配 logo 时,品牌标记必须是**官方几何**(内联 SVG),
// 不得是文字字形(旧版本输出「A/H/P」+ 自造渐变方块)。
// 审计 R7-RV-6:官方几何必须是**双色变体** —— 浅色面用 logo.svg(黑底白标记),
// 深色面用 logo-dark.svg(白底黑标记)且几何完全相同。
//
// AGENTS.md 品牌铁律:任何 logo/品牌标记都必须派生自 brands/official/logo.svg
// (never a text glyph, no `P` letters, no invented shapes);因此这里不仅断言
// "有 SVG",还把**两个内联变体分别**与两份权威文件**逐属性对拍** —— 几何漂移
// (手画了新图形、忘了带 1.25× 变换)或配色写反(深色底仍是黑方块)都会当场红。
// ---------------------------------------------------------------------------
func TestRenderBrandMarkDerivesFromOfficialLogo(t *testing.T) {
	official, err := os.ReadFile(filepath.Join("..", "..", "..", "brands", "official", "logo.svg"))
	if err != nil {
		// 只在仓库根可见时可跑(module-only 副本里没有 brands/)。
		t.Skipf("brands/official/logo.svg 不可见(%v):请在仓库内运行 go test", err)
	}
	officialDark, err := os.ReadFile(filepath.Join("..", "..", "..", "brands", "official", "logo-dark.svg"))
	if err != nil {
		t.Skipf("brands/official/logo-dark.svg 不可见(%v):请在仓库内运行 go test", err)
	}

	html := Render(View{Name: "Acme", AdminURL: "/admin/"})
	m := markRe.FindStringSubmatch(html)
	if m == nil {
		t.Fatalf("门户未渲染品牌标记区块: %s", html[:200])
	}
	mark := m[1]

	// 1) 回落的必须是内联 SVG 几何(两个配色变体),不是文字字形。
	if !strings.Contains(mark, "<svg") {
		t.Fatalf("渠道未配 logo 时品牌标记应为内联 SVG(官方几何),实际: %q", mark)
	}
	// 旧行为:{{initial .Name}} 会把名称首字母(或空名时的字面量 P)当标记。
	for _, glyph := range []string{">A<", ">H<", ">P<", ">a<", ">p<"} {
		if strings.Contains(mark, glyph) {
			t.Fatalf("品牌标记出现文字字形 %q(品牌铁律禁止): %q", glyph, mark)
		}
	}
	light := markVariant(t, mark, "mark-light", markLightRe)
	dark := markVariant(t, mark, "mark-dark", markDarkRe)

	// 2) 每个变体与其权威文件逐属性对拍:几何与配色都必须 verbatim 派生。
	for _, c := range []struct {
		name    string
		variant string
		file    string
		source  string
	}{
		{"mark-light", light, "brands/official/logo.svg", string(official)},
		{"mark-dark", dark, "brands/official/logo-dark.svg", string(officialDark)},
	} {
		for _, a := range authorityAttrs(t, c.file, c.source) {
			if !strings.Contains(c.variant, a) {
				t.Fatalf("%s 变体缺 %s 的属性 %q —— 标记必须逐字派生自品牌真源", c.name, c.file, a)
			}
		}
	}

	// 3) 1.25× 中心放缩是批准设计的一部分,两个变体都不得丢。
	for _, c := range []struct{ name, variant string }{{"mark-light", light}, {"mark-dark", dark}} {
		if !strings.Contains(c.variant, `transform="translate(627 627) scale(1.25) translate(-627 -627)"`) {
			t.Fatalf("%s 变体缺 1.25× 中心放缩变换", c.name)
		}
	}

	// 4) 两版必须**同一份几何**,只允许 fill/stroke 颜色不同。
	if lg, dg := markGeometry(t, light), markGeometry(t, dark); lg != dg {
		t.Fatalf("两个配色变体的几何不一致(只允许颜色翻转):\n light = %s\n dark  = %s", lg, dg)
	}
	if light == dark {
		t.Fatal("两个变体完全相同:深色底会继续显示黑方块(必须翻转底色)")
	}

	// 5) 深色变体 = 白底黑标记(logo-dark.svg);浅色变体 = 黑底白标记(logo.svg)。
	const tile = `<rect x="0" y="0" width="1254" height="1254" rx="180" fill="%s"/>`
	if !strings.Contains(dark, fmt.Sprintf(tile, "#FFFFFF")) {
		t.Fatalf("深色变体的方块底应为 #FFFFFF: %q", dark)
	}
	if !strings.Contains(dark, `stroke="#000000"`) || !strings.Contains(dark, `fill="#000000"`) {
		t.Fatalf("深色变体的标记应为 #000000: %q", dark)
	}
	if !strings.Contains(light, fmt.Sprintf(tile, "#000000")) {
		t.Fatalf("浅色变体的方块底应为 #000000: %q", light)
	}
	if !strings.Contains(light, `stroke="#FFFFFF"`) || !strings.Contains(light, `fill="#FFFFFF"`) {
		t.Fatalf("浅色变体的标记应为 #FFFFFF: %q", light)
	}
}

// ---------------------------------------------------------------------------
// 审计 R7-RV-6:门户的默认 token 集是深色底(rgb(8,10,15)),旧实现只下发
// logo.svg 那一版(黑底白标记)—— 黑方块在深色底上几乎不可见。修法是同一份
// 几何下发两版,由 CSS 按主题选边。
//
// 本用例钉住的是**选边条件必须与 token 集同源**:本页默认(无媒体查询)是深色
// token,浅色 token 在 @media (prefers-color-scheme: light) 里生效 —— 所以
// 标记也必须默认给深色变体,在**同一条 light 查询**里切到浅色变体。写成
// "默认浅色 + dark 查询翻转"会让"未声明偏好"的 UA 拿到深色底 + 黑方块,
// 也就是这条 finding 的原症状原样复发(这类 UA 包括部分内嵌 webview)。
// 变异测试:把两条规则换回 dark 查询 → 第 2 步当场红。
// ---------------------------------------------------------------------------
func TestRenderBrandMarkSwitchesTileColorWithColorScheme(t *testing.T) {
	html := Render(View{Name: "Acme", AdminURL: "/admin/"})

	// 1) 默认(未声明偏好):深色变体(白底黑标记)可见,与默认的深色 token 配套。
	if !strings.Contains(html, `.brand .mark .mark-dark{display:block}`) {
		t.Fatal("默认 token 是深色底,CSS 就必须默认显示深色变体(否则黑方块落在深色底上)")
	}
	if !strings.Contains(html, `.brand .mark .mark-light{display:none}`) {
		t.Fatal("CSS 未默认隐藏浅色变体")
	}
	// 2) 浅色偏好:与 --bg/--fg 等 token **同一条**媒体查询里切到浅色变体。
	//    (两处规则因为层叠顺序必须分块声明,所以对拍的是查询名一致 ——
	//    写成 dark 查询 = 未声明偏好的 UA 拿到深色底 + 黑方块,当场红。)
	tokenScheme := schemeOf(t, html, "--bg:#f7f8fb", "浅色 token 覆盖块")
	if tokenScheme != "light" {
		t.Fatalf("token 集的浅色覆盖应挂在 light 查询上,实际 %q", tokenScheme)
	}
	markScheme := schemeOf(t, html, ".brand .mark .mark-light{display:block}", "浅色标记变体的显示规则")
	if markScheme != tokenScheme {
		t.Fatalf("标记选边挂在 %q 查询上,而 token 翻转挂在 %q 上:两者必须同源", markScheme, tokenScheme)
	}
	light := schemeAnyRe.FindStringSubmatch(html)
	for _, m := range schemeAnyRe.FindAllStringSubmatch(html, -1) {
		if strings.Contains(m[2], ".brand .mark .mark-light{display:block}") {
			light = m
		}
	}
	if !strings.Contains(light[2], `.brand .mark .mark-dark{display:none}`) {
		t.Fatalf("浅色偏好下未隐藏深色变体: %q", light[2])
	}
	// 3) 两版都在同一个标记区块里(不是只留一版),且共用 38px 方框尺寸规则。
	m := markRe.FindStringSubmatch(html)
	if m == nil {
		t.Fatalf("门户未渲染品牌标记区块: %s", html[:200])
	}
	if !markLightRe.MatchString(m[1]) || !markDarkRe.MatchString(m[1]) {
		t.Fatalf("标记区块应同时含两个配色变体: %q", m[1])
	}
	if !strings.Contains(html, `.brand .mark img,.brand .mark svg{width:100%;height:100%;object-fit:contain;display:block}`) {
		t.Fatal("两个变体必须共用 .brand .mark svg 的 100%/100% 尺寸规则")
	}

	// 4) 渠道配了 logo:两个内联变体都必须让位给 <img>。
	withLogo := Render(View{Name: "Acme", AdminURL: "/admin/", LogoURL: "/api/client/v2/channel/logo"})
	lm := markRe.FindStringSubmatch(withLogo)
	if lm == nil {
		t.Fatalf("门户未渲染品牌标记区块: %s", withLogo[:200])
	}
	if markLightRe.MatchString(lm[1]) || markDarkRe.MatchString(lm[1]) {
		t.Fatalf("配置了渠道 logo 时两个内联变体都应被抑制: %q", lm[1])
	}
}

// 有 LogoURL 时仍走渠道素材(<img>),不注入内联几何(渠道品牌优先于回落)。
func TestRenderUsesChannelLogoWhenConfigured(t *testing.T) {
	html := Render(View{Name: "Acme", AdminURL: "/admin/", LogoURL: "/api/client/v2/channel/logo"})
	m := markRe.FindStringSubmatch(html)
	if m == nil {
		t.Fatalf("门户未渲染品牌标记区块: %s", html[:200])
	}
	if !strings.Contains(m[1], `<img src="/api/client/v2/channel/logo"`) {
		t.Fatalf("配置了渠道 logo 时应下发 <img>: %q", m[1])
	}
	if strings.Contains(m[1], "<svg") {
		t.Fatalf("配置了渠道 logo 时不应注入内联回落几何: %q", m[1])
	}
}

// 品牌标记区块 CSS 不得再自造渐变方块(旧行为:linear-gradient 假 logo)。
func TestRenderBrandMarkHasNoInventedGradientTile(t *testing.T) {
	html := Render(View{Name: "Acme", AdminURL: "/admin/"})
	if strings.Contains(html, "linear-gradient(140deg") {
		t.Fatal("品牌标记不得使用自造渐变方块(须用官方几何/渠道素材)")
	}
}

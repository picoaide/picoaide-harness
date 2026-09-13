package channel

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// ---------------------------------------------------------------------------
// SVG 素材下发防护(2026-09-13 审计 P2-12)
//
// 威胁:渠道素材(logo.svg / logo-dark.svg / favicon)来自镜像内的渠道目录,
// 由 CI 从私有渠道仓注入 —— 属**不可信输入**。若其中带脚本,用户直接导航到
// /api/client/v2/channel/logo 就会在**服务端源**(与 /admin/ 同源)上执行脚本。
// 桌面侧对同一份素材已有对应防护(packages/host/desktop/src/brand-web-route.ts
// 的 sanitizeBrandSvg + nosniff/sandbox CSP),服务端这里补齐两层:
//
//  1. 响应头(纵深第一层,覆盖一切情况,含"文件太大没来得及检查"的那类):
//     X-Content-Type-Options: nosniff
//     Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
//     —— sandbox 不带 allow-scripts,文档型 SVG 因此不可能执行脚本;对 PNG
//     等位图没有副作用(CSP 只在文档上下文生效)。
//  2. 内容检查(纵深第二层,只对 .svg):命中脚本特征即拒绝下发(视同未配置)。
//
// 单一真源:内容判定只有 checkAssetContent 一个函数,拒绝路径与放行路径共用它。
// ---------------------------------------------------------------------------

const (
	// assetNoSniff 阻止浏览器对素材做类型嗅探(否则改个扩展名就能改变渲染方式)。
	assetNoSniff = "nosniff"
	// assetCSP 素材响应统一携带的 CSP。三个指令各有分工:
	//   - default-src 'none' —— 文档型 SVG 里任何外链/脚本/样式都取不到源;
	//   - style-src 'unsafe-inline' —— 只放开内联样式,图形本身照常渲染;
	//   - sandbox —— 不带 allow-scripts,直接导航到素材时脚本执行被浏览器强制关死。
	// 位图(PNG 等)响应带同一份头没有副作用。
	assetCSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
)

// maxCheckedSVGBytes 内容检查的读取上限(1MB)。
//
// 渠道 logo 实际在 KB 量级(官方 logo.svg 不到 1KB);上限只用来界住"单请求读多少
// 字节",不是安全边界 —— 超过上限时的处理见 checkAssetContent 的注释。
const maxCheckedSVGBytes = 1 << 20

// svgSignature 一条脚本特征(名字只用于排查与测试断言,不进响应体)。
type svgSignature struct {
	name string
	re   *regexp.Regexp
}

// svgScriptSignatures 脚本特征表。大小写不敏感(?i),空白与属性引号差异由
// 正则里的 `\s*` / `["']?` 吸收(`<svg onload = 'x'>` 与 `<svg onload="x">` 同样命中)。
//
// 事件属性那条**必须**带"属性起始边界"(`^` 或空白/引号/斜杠/尖括号):裸的
// `on[a-z]+\s*=` 会命中 XML 声明里的 `standalone="no"`(子串 `one=`),把合法
// 渠道 logo 误判成可疑内容 —— 桌面侧 P1-12 已经踩过这个坑。
//
// 这里只覆盖"能被静态识别"的特征;签名式检查天然可以绕过(自定义实体、非
// 标准命名空间等),真正的兜底是 assetCSP 的 sandbox —— 见包注释。
var svgScriptSignatures = []svgSignature{
	{"script-element", regexp.MustCompile(`(?is)<\s*script[\s/>]`)},
	{"event-handler-attribute", regexp.MustCompile(`(?is)(?:^|[\s"'/<>])on[a-z]+\s*=`)},
	{"javascript-url", regexp.MustCompile(`(?is)java\s*script\s*:`)},
	{"foreign-object-element", regexp.MustCompile(`(?is)<\s*foreignobject[\s/>]`)},
	{"external-use-href", regexp.MustCompile(`(?is)<\s*use[\s/>][^>]*(?:xlink:)?href\s*=\s*["']?\s*(?:https?:)?//`)},
	{"iframe-element", regexp.MustCompile(`(?is)<\s*iframe[\s/>]`)},
	{"embed-element", regexp.MustCompile(`(?is)<\s*embed[\s/>]`)},
	{"animate-href-attribute", regexp.MustCompile(`(?is)<\s*animate[\s/>][^>]*attributename\s*=\s*["']?\s*href`)},
}

// numericCharRef 匹配 XML 数字字符引用(`&#106;` / `&#x6A;`)。
var numericCharRef = regexp.MustCompile(`&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));`)

// checkAssetContent 是渠道素材内容检查的**唯一真源**。
//
// 返回 "" 表示可以下发;非空表示拒绝原因(只用于排查与测试断言,不写进响应体 ——
// 拒绝下发与"未配置"返回**同一个** 404 JSON 信封,不新增响应形态)。
//
// 检查范围:仅 .svg(按**文件扩展名**判定,大小写不敏感)。位图 favicon 等不做内容
// 检查 —— 它们不是文档、不执行脚本,扫字节只会带来误拒。
//
// 超过 maxCheckedSVGBytes 时:**不检查、照常下发**,由响应头 CSP 兜底。理由:
//   - 本项审计的威胁是"直接导航素材时在服务端源上执行脚本",而
//     `… sandbox`(不含 allow-scripts)+ `default-src 'none'` 是该威胁的
//     **浏览器强制**闭包,与文件体积无关 —— 拒绝超限文件并不会多挡住任何脚本;
//   - 反过来"超限即拒绝"有真实代价:渠道 logo 可以是描迹出来的复杂矢量(合法
//     的几十万字节),而 BuildResponse 的语义是"URL 是否下发只看文件是否存在"
//     (本次不改),于是拒绝的直接后果是登录页/门户变破图,零安全收益;
//   - 若日后判定必须 fail-closed,把这里改成 `return "svg too large"` 即可,
//     唯一真源保证只需改一处。
func checkAssetContent(path string) string {
	if !strings.EqualFold(filepath.Ext(path), ".svg") {
		return ""
	}
	raw, tooLarge, err := readCapped(path, maxCheckedSVGBytes)
	if err != nil || tooLarge {
		// 读不到:交给 ServeFile 按既有语义处理(它自己会 404/403)。
		// 超限:见函数注释,CSP 兜底。
		return ""
	}
	// 先解码数字字符引用再匹配:属性值里的 `&#106;avascript:…` 会被 XML 解析器
	// 还原成 `javascript:…`,纯文本匹配若不还原就会漏掉这个变体。
	text := decodeNumericCharRefs(string(raw))
	for _, sig := range svgScriptSignatures {
		if sig.re.MatchString(text) {
			return "svg contains " + sig.name
		}
	}
	return ""
}

// decodeNumericCharRefs 解码 XML 数字字符引用(`&#106;` / `&#x6A;`);解不出来的保持原样。
//
// 只解数字引用:XML 预定义实体(&amp; 等)还原后构造不出脚本特征里的关键字,
// 而"属性值先解码再当 URL 用"正是绕过纯文本匹配的常见手法。
func decodeNumericCharRefs(s string) string {
	if !strings.Contains(s, "&#") {
		return s
	}
	return numericCharRef.ReplaceAllStringFunc(s, func(match string) string {
		groups := numericCharRef.FindStringSubmatch(match)
		base, digits := 10, groups[2]
		if groups[1] != "" {
			base, digits = 16, groups[1]
		}
		n, err := strconv.ParseInt(digits, base, 32)
		if err != nil || n <= 0 || n > unicode.MaxRune {
			return match
		}
		return string(rune(n))
	})
}

// readCapped 最多读 limit 字节;文件更大时返回 tooLarge=true(前 limit 字节仍然返回)。
func readCapped(path string, limit int64) (data []byte, tooLarge bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = f.Close() }()

	data, err = io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(data)) > limit {
		return data[:limit], true, nil
	}
	return data, false, nil
}

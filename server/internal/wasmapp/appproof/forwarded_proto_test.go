package appproof

import (
	"crypto/tls"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/clientrelease"
)

// ===========================================================================
// `X-Forwarded-Proto` 只有一个判定实现，appproof 是它的第三个消费点
// （第二十七轮 AA2-02 的同族，第二十八轮 FIX-40 收口）
// ===========================================================================
//
// 修前：本包有一份**独立的** XFP 解析（`strings.TrimSpace` → `IndexByte(',')` →
// `ToLower`），与 `clientrelease.resolveOrigin`、`serverauth.secureCookieFor` 各写一份。
// 三份实现"同结论"只是当下的巧合：判定的取值域（大小写 / 逗号列表 / 首尾空白 / 畸形
// 形态）一旦有一条不跟，分叉的后果是 proof 的绑定值算错 —— 而 proof 绑定值一错，
// 客户端**所有**应用请求都 401，原因只在服务端一行日志里（本仓已记录同类"静默
// fail-closed"事故）。
//
// 现在的形态：判定只有 `clientrelease.ForwardedProtoIsHTTPS` 一份实现（FIX-38 落在
// `clientrelease` 的理由：它零 internal 依赖、是三个消费点里最靠下的一层；
// `go list -deps ./internal/clientrelease` 实测只有它自己一个 picoaide 包 ⇒
// `appproof → clientrelease` 不可能成环）。本文件钉两件事：
//
//  1. **消费点断言**（取值域 = 真实解析面）：同一组 ≥13 种代理形态，`ServerURL` 算出的
//     来源必须与**字面量**期望逐字一致，且"算不算 https"必须与共享判定的结论一致；
//  2. **结构判据**（"同一件事一份实现"这句话本身）：整个 `server/` 里读这个头的每个
//     非测试源文件都必须经由共享实现，或逐条登记理由；逗号切分式的解析只允许出现在
//     `clientrelease` 一处。
//
// 语料与 `internal/clientrelease/forwarded_proto_test.go`、`internal/serverauth/
// forwarded_proto_test.go` 的 `xfpShapes` **逐字同形**（跨包的 _test.go 夹具不可导入，
// 所以三处各存一份、各自对同一组**字面量**断言 —— 复核任一处改口径都会至少一处变红）。
// ===========================================================================

// xfpOriginCases 是代理形态 → `ServerURL` 结论的期望语料。
//
// 期望值一律按**保守正确**定：TLS 是请求自身的既成事实（优先于头）；头声明 https ⇒
// https；其余一律 http（共享判定的语义是"判不出 https 即 false"）。
// `mutated` 标注第二十八轮收口带来的**行为变更**：修前这三种形态会让 scheme 变成
// 一个非法 token，`edge.NormalizeOrigin` 随后拒绝整串地址（返回空串）；现在按
// "非 https 即 http" 落到 http 源。
var xfpOriginCases = []struct {
	header    string
	wantHTTPS bool
	wantPlain string
	wantTLS   string
	note      string
}{
	{"https", true, "https://harness.example.com", "https://harness.example.com", "现状形态（修前唯一被认的取值）"},
	{"HTTPS", true, "https://harness.example.com", "https://harness.example.com", "全大写"},
	{"Https", true, "https://harness.example.com", "https://harness.example.com", "混合大小写"},
	{"https ", true, "https://harness.example.com", "https://harness.example.com", "尾随空白"},
	{" https", true, "https://harness.example.com", "https://harness.example.com", "前导空白"},
	{"https, http", true, "https://harness.example.com", "https://harness.example.com", "多跳：最左 = 客户端侧 https"},
	{"HTTPS , HTTP", true, "https://harness.example.com", "https://harness.example.com", "多跳 + 大小写 + 空白"},
	{"https,http", true, "https://harness.example.com", "https://harness.example.com", "多跳：无空格的紧凑形态"},
	{"https, http, http", true, "https://harness.example.com", "https://harness.example.com", "三跳链路"},
	{"\thttps\t", true, "https://harness.example.com", "https://harness.example.com", "制表符包裹（TrimSpace 的取值域）"},
	{"http, https", false, "http://harness.example.com", "https://harness.example.com", "多跳：最左 = 客户端侧 http ⇒ 不给 https 源"},
	{"http", false, "http://harness.example.com", "https://harness.example.com", "明文"},
	{"HTTP", false, "http://harness.example.com", "https://harness.example.com", "明文（大写）"},
	{"", false, "http://harness.example.com", "https://harness.example.com", "无头（非 https）"},
	{"wss", false, "http://harness.example.com", "https://harness.example.com", "未知 scheme（mutated：修前为空串）"},
	{"on", false, "http://harness.example.com", "https://harness.example.com", "非 scheme 形态（mutated：修前为空串）"},
	{", https", false, "http://harness.example.com", "https://harness.example.com", "畸形：最左段为空（mutated：修前为空串）"},
	{"   ", false, "http://harness.example.com", "https://harness.example.com", "纯空白（与无头同档）"},
}

// 消费点断言：`ServerURL` 的来源与**共享判定**在全部形态上一致，且逐字等于字面量期望。
func TestServerURLFollowsSharedForwardedProtoTable(t *testing.T) {
	for _, tc := range xfpOriginCases {
		t.Run(xfpCaseName(tc.header), func(t *testing.T) {
			// ① 共享实现本身的取值域（三个消费点共用同一组期望值）。
			if got := clientrelease.ForwardedProtoIsHTTPS(tc.header); got != tc.wantHTTPS {
				t.Fatalf("clientrelease.ForwardedProtoIsHTTPS(%q) = %v, want %v（%s）",
					tc.header, got, tc.wantHTTPS, tc.note)
			}
			// ② 无 TLS：结论必须与共享判定一致（"来源是 https" ⟺ "头声明 https"）。
			plain := ServerURL(requestWith(tc.header, false))
			if plain != tc.wantPlain {
				t.Fatalf("ServerURL(XFP=%q, 无 TLS) = %q, want %q（%s）", tc.header, plain, tc.wantPlain, tc.note)
			}
			if strings.HasPrefix(plain, "https://") != tc.wantHTTPS {
				t.Fatalf("ServerURL(XFP=%q) 是不是 https 与共享判定不一致：%q vs wantHTTPS=%v（%s）",
					tc.header, plain, tc.wantHTTPS, tc.note)
			}
			// ③ 有 TLS：TLS 优先（头是代理的声明，TLS 是请求自身的既成事实）。
			if got := ServerURL(requestWith(tc.header, true)); got != tc.wantTLS {
				t.Fatalf("ServerURL(XFP=%q, 有 TLS) = %q, want %q（TLS 必须优先）", tc.header, got, tc.wantTLS)
			}
		})
	}
}

// 非 XFP 面：Host 的归一化形态与空 Host 的 fail-closed 语义不得被本次收口改动。
func TestServerURLHostAndTLSShapes(t *testing.T) {
	cases := []struct {
		name   string
		host   string
		header string
		tls    bool
		want   string
	}{
		{"主机小写", "Harness.Example.COM", "", false, "http://harness.example.com"},
		{"https 默认端口省略", "harness.example.com:443", "https", false, "https://harness.example.com"},
		{"非默认端口保留", "harness.example.com:8443", "https", false, "https://harness.example.com:8443"},
		{"TLS + 默认端口", "harness.example.com:443", "", true, "https://harness.example.com"},
		{"path 被丢弃", "harness.example.com/base", "https", false, "https://harness.example.com"},
		// 空 Host ⇒ 空串（调用方按校验失败处理），这条与 XFP 无关但必须一起钉住。
		{"空 Host", "", "https", false, ""},
		{"空 Host + TLS", "", "", true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ServerURL(requestWithHost(tc.host, tc.header, tc.tls)); got != tc.want {
				t.Fatalf("ServerURL(host=%q, XFP=%q, tls=%v) = %q, want %q", tc.host, tc.header, tc.tls, got, tc.want)
			}
		})
	}
	if got := ServerURL(nil); got != "" {
		t.Fatalf("ServerURL(nil) = %q, want 空串", got)
	}
}

// ===========================================================================
// 结构判据：读这个头的每一处都必须经由共享实现（或逐条登记理由）
// ===========================================================================

/*
 * 这条判据守的是「同一件事只允许一份实现」**这句话本身** —— 行为语料只能证明
 * "今天两份实现对得上"，挡不住"明天在第四个包里再抄一份"。
 *
 * 判据（扫描根 = 整个 `server` 模块的**非测试** `.go`，AST 级 ⇒ 注释里的字样不算）：
 *
 *   A. 每个含 `X-Forwarded-Proto` **字符串字面量**的文件，必须满足三者之一：
 *      ① 它就是共享实现的定义处（`func ForwardedProtoIsHTTPS(`）；或
 *      ② 它引用了 `clientrelease.ForwardedProto…`（= 消费点）；或
 *      ③ 它在 {@link xfpReadWithoutDecision} 里逐条登记了理由（陈旧登记会红）。
 *   B. **逗号切分式解析**（`strings.Cut(…, ",")` / `strings.IndexByte(…, ',')`）只允许
 *      出现在共享实现那一个文件里 —— 这是"抄一份旧口径"的最小可识别形态
 *      （修前的 `appproof/service.go` 正是这个形态，本判据在修前**必红**）。
 *   C. 反面防空转：扫描面必须真的收到共享实现那个文件，否则"全绿"没有意义。
 *
 * 认账的盲区（写在这里，避免下一个人以为它覆盖了全部形态）：
 *   - 读头完全不经字符串字面量的实现（经常量/helper 间接取头）不会被 A 抓到；
 *     但间接 helper 自己也必须含字面量 ⇒ 仍会落在 A 里；
 *   - 不做任何 http/https 字面比较、直接给 scheme 赋值的实现（例如从别的头推导）
 *     不在判据面内。
 */
func TestForwardedProtoHasSingleImplementationSite(t *testing.T) {
	root := moduleRoot(t)
	files := goSourceFiles(t, filepath.Join(root, "internal"))
	// C：扫描面防空转（至少要有几百个源文件，且必须真的收到共享实现那个文件）。
	if len(files) < 100 {
		t.Fatalf("扫描面只收到 %d 个非测试 .go 文件 ⇒ 判据会空转", len(files))
	}

	const shared = "internal/clientrelease/clientrelease.go"
	readers := map[string]bool{}
	localParsers := map[string]bool{}
	routesThroughShared := map[string]bool{}
	definesShared := map[string]bool{}
	for _, rel := range files {
		facts := scanForwardedProto(t, filepath.Join(root, rel))
		if facts.readsHeader {
			readers[rel] = true
		}
		if facts.localParse {
			localParsers[rel] = true
		}
		if facts.routesThroughShared {
			routesThroughShared[rel] = true
		}
		if facts.definesShared {
			definesShared[rel] = true
		}
	}

	if !readers[shared] {
		t.Fatalf("共享实现 %s 不在扫描面里（夹具/扫描根坏了 ⇒ 下面全部是假绿）", shared)
	}
	if !definesShared[shared] {
		t.Fatalf("%s 里没有找到 `func ForwardedProtoIsHTTPS` —— 判据的锚点没了（搬走实现就要同步改这条判据与三个消费点）", shared)
	}

	// B：判定实现只有一份 —— 不允许任何函数"既读这个头、又自己按逗号切分/大小写折叠它"
	//    （修前的 `appproof.ServerURL` 与修前的 `serverauth.secureCookieFor` 都是这个形状）。
	for rel := range localParsers {
		t.Errorf("%s 里有函数既读 X-Forwarded-Proto、又自己解析/折叠它 —— 判定只允许 %s 一份实现（请改为调用 clientrelease.ForwardedProtoIsHTTPS）", rel, shared)
	}

	// A：每个读头的文件都必须经由共享实现或登记。
	for rel := range readers {
		if rel == shared {
			continue
		}
		if registered, ok := xfpReadWithoutDecision[rel]; ok {
			if len(registered) < 20 {
				t.Errorf("登记项 %s 的理由太短（必须写清为什么不做判定）", rel)
			}
			continue
		}
		if routesThroughShared[rel] {
			continue
		}
		t.Errorf("%s 读了 X-Forwarded-Proto 却没有经由共享实现（clientrelease.ForwardedProtoIsHTTPS）："+
			"要么改成调用它，要么在 xfpReadWithoutDecision 里逐条登记理由", rel)
	}

	// A 的双向陈旧检测：登记的站点必须仍然读这个头（否则豁免变成免检区）。
	for rel, reason := range xfpReadWithoutDecision {
		if !readers[rel] {
			t.Errorf("xfpReadWithoutDecision 里的 %s 已经不再读 X-Forwarded-Proto 了 —— 请删掉这条陈旧登记（%s）", rel, reason)
		}
	}
}

// xfpFacts 是一个源文件在 XFP 判据面上的事实（AST 级 ⇒ 注释里的字样不算）。
type xfpFacts struct {
	/** 真的读了 `X-Forwarded-Proto`（字符串字面量出现在代码里，不是注释里）。 */
	readsHeader bool
	/**
	 * 出现了"**在同一个函数里**既读这个头、又自己解析/折叠它"的形态
	 * （逗号切分或大小写折叠）—— 这就是"第二份实现"的最小可识别形状。
	 */
	localParse bool
	/** 引用了共享实现（`clientrelease.ForwardedProto…`）。 */
	routesThroughShared bool
	/** 定义了共享实现本身（`func ForwardedProtoIsHTTPS`）。 */
	definesShared bool
}

// scanForwardedProto 用 `go/parser` 取一个文件的事实。
//
// 为什么必须是 AST 而不是文本扫描：`X-Forwarded-Proto` 这个字样在本仓的**注释**里
// 出现得比代码里还多（`edge/primitives.go` 的文件头、`appserver/client.go` 的注释、
// 本包的说明），文本判据会把它们全算成"读了这个头"，于是豁免表被迫收进一批根本不做
// 判定的文件 —— 那正是"豁免表变成免检区"的起点。
//
// 为什么 `localParse` 要**按函数**而不是按文件：整个 `server/` 里 `strings.Cut(x, ",")`
// 遍地都是（解析各种逗号分隔的配置），按文件判会把六个毫不相干的文件判成"第二份实现"
// （实测：capabilities/serverauth×3/wasmapp-appserver 全部误报）。"从请求头取出值 → 立刻
// 自己切分/折叠"才是判定实现的形状，而这两个动作必须在同一个函数体里。
func scanForwardedProto(t *testing.T, path string) xfpFacts {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析 %s 失败：%v", path, err)
	}
	var facts xfpFacts
	ast.Inspect(file, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.BasicLit:
			if typed.Kind == token.STRING && unquoted(typed.Value) == "X-Forwarded-Proto" {
				facts.readsHeader = true
			}
		case *ast.FuncDecl:
			if typed.Name != nil && typed.Name.Name == "ForwardedProtoIsHTTPS" {
				facts.definesShared = true
			}
			if typed.Body != nil && functionReadsAndParses(typed.Body) {
				facts.localParse = true
			}
		case *ast.FuncLit:
			if typed.Body != nil && functionReadsAndParses(typed.Body) {
				facts.localParse = true
			}
		case *ast.SelectorExpr:
			if ident, ok := typed.X.(*ast.Ident); ok && ident.Name == "clientrelease" && strings.HasPrefix(typed.Sel.Name, "ForwardedProto") {
				facts.routesThroughShared = true
			}
		}
		return true
	})
	return facts
}

// functionReadsAndParses 判定一个函数体是否"既读 XFP、又自己解析/折叠它"（不进嵌套函数）。
func functionReadsAndParses(body *ast.BlockStmt) bool {
	reads := false
	parses := false
	ast.Inspect(body, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.FuncLit:
			return false // 嵌套函数的动作不是本函数的
		case *ast.BasicLit:
			if typed.Kind == token.STRING && unquoted(typed.Value) == "X-Forwarded-Proto" {
				reads = true
			}
		case *ast.CallExpr:
			if isCommaSplit(typed) || isCaseFold(typed) {
				parses = true
			}
		}
		return true
	})
	return reads && parses
}

// isCommaSplit 判定一次调用是不是"按逗号切分"（`strings.Cut/IndexByte/Split/…` + 逗号字面量）。
func isCommaSplit(call *ast.CallExpr) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := selector.X.(*ast.Ident)
	if !ok || pkg.Name != "strings" {
		return false
	}
	switch selector.Sel.Name {
	case "Cut", "IndexByte", "Split", "SplitN", "CutPrefix", "LastIndexByte":
	default:
		return false
	}
	for _, arg := range call.Args {
		literal, ok := arg.(*ast.BasicLit)
		if !ok {
			continue
		}
		if (literal.Kind == token.STRING || literal.Kind == token.CHAR) && unquoted(literal.Value) == "," {
			return true
		}
	}
	return false
}

// isCaseFold 判定一次调用是不是大小写折叠（口径分叉的另一种常见形状：`EqualFold(header,"https")`）。
func isCaseFold(call *ast.CallExpr) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := selector.X.(*ast.Ident)
	if !ok || pkg.Name != "strings" {
		return false
	}
	switch selector.Sel.Name {
	case "EqualFold", "ToLower", "ToUpper":
		return true
	default:
		return false
	}
}

// unquoted 取字面量的内容（畸形字面量返回原样：只用于相等比较，不需要报错）。
func unquoted(raw string) string {
	if value, err := strconv.Unquote(raw); err == nil {
		return value
	}
	return raw
}

// xfpReadWithoutDecision 是"读了头但不做任何协议判定"的站点（键 = 模块相对路径）。
//
// 判据：登记项必须仍然读到那个头（陈旧即红），且理由必须写清"为什么这里不做判定"。
var xfpReadWithoutDecision = map[string]string{
	"internal/wasmapp/edge/primitives.go": "`OriginDiagFields` 只把头的**原文**拼进跨源写拒绝的诊断行（`x-forwarded-proto=%q`），不做任何 scheme 判定；判定的唯一实现是 `clientrelease.ForwardedProtoIsHTTPS`。",
}

// moduleRoot 找 `server/go.mod`（用例的工作目录是包目录，不能写死相对层数）。
func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("取工作目录失败：%v", err)
	}
	for i := 0; i < 12; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("从 %s 向上找不到 go.mod", dir)
	return ""
}

// goSourceFiles 列出模块内全部**非测试** `.go` 文件（模块相对、`/` 分隔、已排序）。
func goSourceFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "testdata" || entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(filepath.Dir(root), path)
		if relErr != nil {
			return relErr
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 %s 失败：%v", root, err)
	}
	slices0Sort(out)
	return out
}

// slices0Sort 给文件清单排序（避免为一处排序引入额外依赖）。
func slices0Sort(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// readGoFile 读一个源文件（失败即红：判据的输入缺失不得静默跳过）。
func readGoFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s 失败：%v", path, err)
	}
	return string(raw)
}

// requestWith 造一个带 XFP（与可选 TLS）的请求。
func requestWith(header string, withTLS bool) *http.Request {
	return requestWithHost("harness.example.com", header, withTLS)
}

// requestWithHost 同上，主机可指定。
func requestWithHost(host string, header string, withTLS bool) *http.Request {
	r := &http.Request{Host: host, Header: http.Header{}}
	if header != "" {
		r.Header.Set("X-Forwarded-Proto", header)
	}
	if withTLS {
		r.TLS = &tls.ConnectionState{}
	}
	return r
}

// xfpCaseName 给空头/空白头一个可读的用例名（空串会自动变成 #00，排查时看不出是哪一行）。
func xfpCaseName(header string) string {
	if header == "" {
		return "(空)"
	}
	if strings.TrimSpace(header) == "" {
		return "(空白)"
	}
	return header
}

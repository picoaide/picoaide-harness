package archiveutil

// R21F-04 的**跨端对拍**判据：服务端审核期的"安装端可用性"判据必须与客户端安装期
// 同源 —— 本用例**读客户端的 TS 源码**抽出结构与语义事实，再与 Go 侧逐项比对。
//
// ## 为什么必须读对方源码（而不是两端各钉自己的字面量）
//
// 本仓已登记的假绿形态之一就是"两端各自维护一份契约、没有任何判据读对方源码"
// ⇒ 单边改名后两边都绿、运行时才分叉。保留设备名这张表在客户端
// （`packages/host/enterprise/src/skill-name-rules.ts`）与 Go 侧各有一份拷贝
// （语言不同，无法共享代码），所以**唯一**能防漂移的办法就是让一侧的判据去读另一侧
// 的源码。本用例取的是"Go 读 TS"这个方向（Go 测试在 server job 里跑；TS 侧的对拍
// 见 `packages/host/enterprise/tests/` 的同族用例）。
//
// ## 判据（四条，缺一条都不算闭合）
//
//	① **集合相等**：Go 的 `windowsReservedDeviceNames` 与 TS 的
//	   `WINDOWS_RESERVED_DEVICE_NAMES` 逐项相等（含 `Array.from({length:9}, …)`
//	   生成出来的 com1-9 / lpt1-9）；
//	② **判定语义对拍**：把 TS 谓词体里的折叠规则（段首取第一个点之前、剥尾随空格、
//	   小写比较、`\` 当分隔符、跳过 `.`/`..`、段列表是否 `.slice(N)`）抽成事实，按这些
//	   事实在测试侧实现"客户端判定"，再对一份语料要求与 Go 的
//	   `ReservedDeviceNameSegment` **逐条一致**；
//	③ **语料有牙齿**（自证）：对每条抽出来的规则，语料里必须存在"该规则缺失就会分叉"
//	   的输入 —— 否则②可能只是恒真断言；
//	④ **查重口径方向**：从 `archive-util.ts` 抽出客户端查重键仍是
//	   `path.toLowerCase()`，并断言 Go 的 `installerKey` **至少同样粗**
//	   （客户端判为同一个文件的路径对，服务端也必须判为同一个）。服务端缺保留设备名
//	   是"审核宽于安装"（会放行装不上的包），而这里钉的是反方向不许出现。
//
// ## 抽不出结构即失败（不是 skip）
//
// 源码文件读不到 = **仓库结构事故**（文件被改名/搬走）；函数体里抽不到预期结构 =
// **上游/一侧改了规则而另一侧没人知道**。两种情况都 `t.Fatalf`，绝不静默跳过 ——
// 静默跳过会让这条唯一防线变成 no-op（本仓 usage_contract_test.go 记过同款教训）。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-8/REPORT.md）
//
//   - TS 侧把 `'aux'` 改成别的名字 ⇒ ① 红；
//   - TS 侧删掉 `head.replace(/[ ]+$/u, '')`（少一条折叠）⇒ ② 红（语料里的 `aux `）；
//   - TS 侧把 `path.toLowerCase()` 换成 `toLocaleLowerCase()` ⇒ ④ 红（抽不到）；
//   - Go 侧从表里删掉 `aux` ⇒ ① 红且行为用例红。

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// 客户端源码位置（相对测试工作目录 = server/internal/archiveutil）。
//
// 两个候选：包目录相对（`go test ./internal/archiveutil/`）与仓库根相对
// （在仓库根跑 `go test ./server/internal/archiveutil/` 时 cwd 不变，仍是包目录；
// 保留仓库根相对只是为了容忍"从别处拉起测试二进制"的调用方式）。
const (
	clientSkillNameRulesRel = "packages/host/enterprise/src/skill-name-rules.ts"
	clientArchiveUtilRel    = "packages/host/enterprise/src/archive-util.ts"
)

func readClientSource(t *testing.T, rel string) string {
	t.Helper()
	candidates := []string{
		filepath.Join("..", "..", "..", rel),
		filepath.Join("..", "..", rel),
		rel,
	}
	for _, c := range candidates {
		raw, err := os.ReadFile(filepath.FromSlash(c))
		if err == nil {
			return string(raw)
		}
	}
	wd, _ := os.Getwd()
	t.Fatalf("客户端源码 %s 不可达（测试工作目录 = %s，候选 %v）—— 这是仓库结构事故"+
		"（文件被改名/搬走），不是环境差异。请把它放回候选路径之一。", rel, wd, candidates)
	return ""
}

// functionBody 切出 named 函数的函数体（从 `function <name>` 到下一个顶层 `}` 或
// 下一个 `function`/`export`）。只做文本切分 —— 判定的"形状"由下面的结构性事实固定。
func functionBody(t *testing.T, src, marker, rel string) string {
	t.Helper()
	start := strings.Index(src, marker)
	if start < 0 {
		t.Fatalf("%s 里找不到 %q —— 一侧改了这个函数的形态，请重新对拍（不许静默跳过）", rel, marker)
	}
	rest := src[start+len(marker):]
	for _, stop := range []string{"\nfunction ", "\nexport function ", "\nconst ", "\nexport const "} {
		if next := strings.Index(rest, stop); next >= 0 {
			rest = rest[:next]
		}
	}
	return rest
}

var (
	reTSQuotedName = regexp.MustCompile(`'([a-z0-9]+)'`)
	// Array.from({ length: 9 }, (_, index) => `com${index + 1}`)
	reTSGeneratedName = regexp.MustCompile("Array\\.from\\(\\{\\s*length:\\s*(\\d+)\\s*\\}[^`]*`([a-z]+)\\$\\{index \\+ 1\\}`")
)

// clientReservedDeviceNames 从 TS 源码抽出保留设备名集合（字面量 + Array.from 生成项）。
func clientReservedDeviceNames(t *testing.T, src string) map[string]bool {
	t.Helper()
	const marker = "WINDOWS_RESERVED_DEVICE_NAMES"
	start := strings.Index(src, marker)
	if start < 0 {
		t.Fatalf("%s 里找不到 %s —— 客户端把这张表改名/搬走了（不许静默跳过）", clientSkillNameRulesRel, marker)
	}
	// 数组起点必须找 `= [`（先出现的 `[` 是类型标注 `string[]` 里的那一个）；
	// 终点是行首的 `]`。
	eq := strings.Index(src[start:], "= [")
	if eq < 0 {
		t.Fatalf("%s 的 %s 不再是 `= [ … ]` 数组字面量，无法抽表", clientSkillNameRulesRel, marker)
	}
	rest := src[start+eq+len("= ["):]
	closing := strings.Index(rest, "\n]")
	if closing < 0 {
		t.Fatalf("%s 的 %s 数组没有闭合（找不到行首 `]`）", clientSkillNameRulesRel, marker)
	}
	block := rest[:closing]

	set := map[string]bool{}
	for _, m := range reTSQuotedName.FindAllStringSubmatch(block, -1) {
		set[m[1]] = true
	}
	for _, m := range reTSGeneratedName.FindAllStringSubmatch(block, -1) {
		n, err := strconv.Atoi(m[1])
		if err != nil || n <= 0 {
			t.Fatalf("模板生成项的 length 抽不出来: %q", m[1])
		}
		for i := 1; i <= n; i++ {
			set[m[2]+strconv.Itoa(i)] = true
		}
	}
	// 防"解析出空集即假绿"：四条基名与两组生成项都必须在。
	for _, must := range []string{"con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"} {
		if !set[must] {
			t.Fatalf("%s 的表里抽不到 %q（抽到的集合 = %v）—— 抽取器与客户端表形态已经脱节",
				clientSkillNameRulesRel, must, sortedKeys(set))
		}
	}
	return set
}

// clientSegmentRule 是从 TS 源码里抽出来的判定事实（不是重述实现逻辑）。
type clientSegmentRule struct {
	set                 map[string]bool
	firstDotHead        bool // indexOf('.') → 只看第一个点之前的段首
	stripTrailingSpaces bool // head.replace(/[ ]+$/u, '')
	lowercases          bool // .toLowerCase()
	splitsOnBackslash   bool // entryPath.replace(/\\/gu, '/')
	skipsDotSegments    bool // segment === '' || '.' || '..'
	// dropFirstSegments 是 `split('/')` 之后**额外的** `.slice(N)`（0 = 不丢段）。
	// 必须抽出来：只钉"用了 split('/')"而不钉"从第几段开始看"的话，
	// `.split('/').slice(1)` 这种改动会让客户端的判定真的变了、而判据仍然全绿
	// （本轮变异 m11 实测到的假绿，已收口）。
	dropFirstSegments int
}

// reserved 按**抽出来的事实**实现客户端判定：任一规则在 TS 侧被删/改，这里对同一
// 语料给出的结论就会与 Go 侧分叉 ⇒ 对拍用例变红。
func (r clientSegmentRule) reserved(path string) (segment string, hit bool) {
	norm := path
	if r.splitsOnBackslash {
		norm = strings.ReplaceAll(norm, "\\", "/")
	}
	segments := strings.Split(norm, "/")
	if r.dropFirstSegments > 0 {
		if r.dropFirstSegments >= len(segments) {
			segments = nil
		} else {
			segments = segments[r.dropFirstSegments:]
		}
	}
	for _, seg := range segments {
		if r.skipsDotSegments && (seg == "" || seg == "." || seg == "..") {
			continue
		}
		head := seg
		if r.firstDotHead {
			if i := strings.Index(seg, "."); i >= 0 {
				head = seg[:i]
			}
		}
		if r.stripTrailingSpaces {
			head = strings.TrimRight(head, " ")
		}
		if r.lowercases {
			head = strings.ToLower(head)
		}
		if r.set[head] {
			return seg, true
		}
	}
	return "", false
}

// clientSegmentSliceStart 抽出客户端"从第几段开始看"（`for (const segment of <expr>)`）。
//
// `<expr>` 只接受两种形态：
//
//	entryPath.replace(/\\/gu, '/').split('/')                  ⇒ 0
//	entryPath.replace(/\\/gu, '/').split('/').slice(N)         ⇒ N
//
// 任何别的后缀（`slice(1)`、`filter(...)`、`reverse()`、先 `map` 再 split …）**即红** ——
// 那说明客户端把"逐段判定"的形态改了，本用例的事实模型已经覆盖不到，必须人工重新对拍。
// 只钉 `split('/')` 存在是不够的：实测变异 `.slice(1)` 会让客户端真的漏掉第一段
// （`aux.txt` 不再命中），而旧版抽取器仍然全绿。
func clientSegmentSliceStart(t *testing.T, pathBody string) int {
	t.Helper()
	const marker = "for (const segment of "
	start := strings.Index(pathBody, marker)
	if start < 0 {
		t.Fatalf("%s 的 reservedDeviceNameInArchivePath 不再是 `for (const segment of …)` 形态"+
			"（抽不到段列表，不许静默跳过）", clientSkillNameRulesRel)
	}
	rest := pathBody[start+len(marker):]
	stop := strings.LastIndex(rest, ") {")
	if stop < 0 {
		t.Fatalf("%s 的段循环没有 `) {` 收尾（抽不到段列表）", clientSkillNameRulesRel)
	}
	expr := rest[:stop]
	base := expr
	drop := 0
	if idx := strings.Index(expr, ".slice("); idx >= 0 {
		base = expr[:idx]
		arg := strings.TrimSuffix(expr[idx+len(".slice("):], ")")
		n, err := strconv.Atoi(strings.TrimSpace(arg))
		if err != nil || n < 0 {
			t.Fatalf("%s 的段列表用了非常量 slice(%q)：本用例的抽取器覆盖不到，请人工对拍",
				clientSkillNameRulesRel, arg)
		}
		drop = n
	}
	want := `entryPath.replace(/\\/gu, '/').split('/')`
	if base != want {
		t.Fatalf("%s 的段列表基表达式变了：\n 实得 %q\n want %q\n"+
			"（客户端逐段判定的形态已改，必须人工重新对拍两侧口径）", clientSkillNameRulesRel, base, want)
	}
	return drop
}

// clientRuleFacts 从两个 TS 文件抽出判定事实（任何一条抽不到即红）。
func clientRuleFacts(t *testing.T, rulesSrc, utilSrc string) clientSegmentRule {
	t.Helper()
	segmentBody := functionBody(t, rulesSrc, "export function isWindowsReservedDeviceNameSegment", clientSkillNameRulesRel)
	pathBody := functionBody(t, rulesSrc, "export function reservedDeviceNameInArchivePath", clientSkillNameRulesRel)

	r := clientSegmentRule{
		set:                 clientReservedDeviceNames(t, rulesSrc),
		firstDotHead:        strings.Contains(segmentBody, "indexOf('.')"),
		stripTrailingSpaces: strings.Contains(segmentBody, "[ ]+$"),
		lowercases:          strings.Contains(segmentBody, ".toLowerCase()"),
		splitsOnBackslash:   strings.Contains(pathBody, `replace(/\\/gu, '/')`),
		skipsDotSegments:    strings.Contains(pathBody, "=== '..'") && strings.Contains(pathBody, "=== '.'"),
		dropFirstSegments:   clientSegmentSliceStart(t, pathBody),
	}
	for name, ok := range map[string]bool{
		"firstDotHead":        r.firstDotHead,
		"stripTrailingSpaces": r.stripTrailingSpaces,
		"lowercases":          r.lowercases,
		"splitsOnBackslash":   r.splitsOnBackslash,
		"skipsDotSegments":    r.skipsDotSegments,
	} {
		if !ok {
			t.Fatalf("%s：抽不到客户端的折叠规则 %s —— 一侧改了判据而另一侧不知道（不许静默跳过）",
				clientSkillNameRulesRel, name)
		}
	}
	// 客户端**安装期**必须仍然硬拒保留设备名（`assertNoReservedDeviceName` 里调用
	// `reservedDeviceNameInArchivePath` 并抛错）。若 TS 侧删掉这道闸门，服务端侧
	// 就变成"比安装端更严"，本用例红，人工复核后再决定保住哪一侧。
	installBody := functionBody(t, utilSrc, "function assertNoReservedDeviceName", clientArchiveUtilRel)
	if !strings.Contains(installBody, "reservedDeviceNameInArchivePath") || !strings.Contains(installBody, "throw") {
		t.Fatalf("%s 的 assertNoReservedDeviceName 不再硬拒保留设备名（抽到的函数体 = %q）"+
			"—— 服务端审核判据「宁可少判也不误杀」的前提没了，请重新对拍两侧口径", clientArchiveUtilRel, installBody)
	}
	return r
}

// reservedNameCorpus 是对拍的输入语料：每条折叠规则都至少有一个"缺了就会分叉"的输入。
var reservedNameCorpus = []string{
	// 基线
	"SKILL.md", "assets/notes.txt", "console.md", "auxiliary/references.md",
	// 表命中（含大写、扩展名不豁免、目录段）
	"aux.txt", "AUX.TXT", "aux", "nul", "con", "prn.log", "com1", "com9.md", "lpt1.dat", "lpt9",
	"assets/aux.txt", "nul/SKILL.md", "CON/child.md", "deep/nested/Com3.dat", "con.notes.md",
	// 尾随点/空格（Windows 忽略）
	"aux.", "aux ", "aux  ", "nul. ", "con .txt",
	// 反斜杠分隔
	`references\aux.md`, `nul\SKILL.md`,
	// `.`/`..` 段
	"./aux.md", "a/./nul", "x/../aux", "../nul",
	// 像但不是（不得误杀）
	"com0.md", "com10.md", "lpt0.md", "com.md", "lpt.md", "nu.md", "aux-.md", "aux_notes.md",
	"nul.md.bak", // 段首 = `nul` ⇒ 命中（与客户端一致）
	"aux\t",      // 只剥空格：制表符不算尾随空格 ⇒ 两侧都未命中
}

// TestWindowsReservedDeviceNamesMatchClientSource 是①。
func TestWindowsReservedDeviceNamesMatchClientSource(t *testing.T) {
	rulesSrc := readClientSource(t, clientSkillNameRulesRel)
	client := clientReservedDeviceNames(t, rulesSrc)
	goNames := sortedKeys(windowsReservedDeviceNames)
	clientNames := sortedKeys(client)
	if strings.Join(goNames, ",") != strings.Join(clientNames, ",") {
		t.Fatalf("两端保留设备名集合不等（服务端审核判据 ⊂ 客户端安装判据正是缺陷本体）：\n"+
			" Go（server/internal/archiveutil/archive.go） = %v\n 客户端（%s） = %v",
			goNames, clientSkillNameRulesRel, clientNames)
	}
}

// TestReservedDeviceNameVerdictsMatchClientRule 是②③。
func TestReservedDeviceNameVerdictsMatchClientRule(t *testing.T) {
	rulesSrc := readClientSource(t, clientSkillNameRulesRel)
	utilSrc := readClientSource(t, clientArchiveUtilRel)
	rule := clientRuleFacts(t, rulesSrc, utilSrc)

	for _, path := range reservedNameCorpus {
		goSeg := ReservedDeviceNameSegment(path)
		cliSeg, cliHit := rule.reserved(path)
		goHit := goSeg != ""
		if goHit != cliHit || goSeg != cliSeg {
			t.Fatalf("两端判定分叉：%q ⇒ Go(%q, hit=%v) / 客户端(%q, hit=%v)"+
				"（客户端规则来自 %s 的实抽结果：firstDotHead=%v stripTrailingSpaces=%v lowercases=%v "+
				"splitsOnBackslash=%v skipsDotSegments=%v dropFirstSegments=%d）",
				path, goSeg, goHit, cliSeg, cliHit, clientSkillNameRulesRel,
				rule.firstDotHead, rule.stripTrailingSpaces, rule.lowercases,
				rule.splitsOnBackslash, rule.skipsDotSegments, rule.dropFirstSegments)
		}
	}
	// ③ 语料有牙齿：**每条可区分的**规则都必须有"关掉它就分叉"的输入。
	//
	// `skipsDotSegments` 是**语义惰性**的（在 `firstDotHead` 已启用时，`.`/`..`/空段的
	// 段首都是空串，永远不会命中表）⇒ 不要求语料区分它；但它**仍必须出现在源码里**
	// （见 clientRuleFacts），因为那意味着客户端判据被重写过、需要人重新对拍。
	teeth := map[string]bool{}
	for _, fact := range []struct {
		name     string
		required bool
		off      func(clientSegmentRule) clientSegmentRule
	}{
		{"firstDotHead", true, func(c clientSegmentRule) clientSegmentRule { c.firstDotHead = false; return c }},
		{"stripTrailingSpaces", true, func(c clientSegmentRule) clientSegmentRule { c.stripTrailingSpaces = false; return c }},
		{"lowercases", true, func(c clientSegmentRule) clientSegmentRule { c.lowercases = false; return c }},
		{"splitsOnBackslash", true, func(c clientSegmentRule) clientSegmentRule { c.splitsOnBackslash = false; return c }},
		// 段列表形态（`.slice(N)`）：语料里必须有单段命中项（`aux.txt`）来区分它。
		{"dropFirstSegments", true, func(c clientSegmentRule) clientSegmentRule { c.dropFirstSegments = 1; return c }},
		{"skipsDotSegments", false, func(c clientSegmentRule) clientSegmentRule { c.skipsDotSegments = false; return c }},
	} {
		for _, path := range reservedNameCorpus {
			full, fullHit := rule.reserved(path)
			broken, brokenHit := fact.off(rule).reserved(path)
			if fullHit != brokenHit || full != broken {
				teeth[fact.name] = true
				break
			}
		}
		if fact.required && !teeth[fact.name] {
			t.Fatalf("语料里没有能区分客户端规则 %s 的输入 —— 对拍会退化成恒真断言，"+
				"请在 reservedNameCorpus 里补一条", fact.name)
		}
	}

}

// TestInstallerKeyCoversClientDuplicateRule 是④：查重口径的方向性不变量。
//
// 客户端 `assertNoDuplicateEntry` 的键是 `path.toLowerCase()`（大小写折叠），服务端
// `installerKey` 额外折叠 NTFS 危险码位与尾随点/空格 —— 服务端**宁严勿宽**，所以
// 不变量只有一条方向：**客户端判为同一个文件的路径对，服务端也必须判为同一个**。
// 反方向（服务端更严而客户端放行）是允许的取舍（见 DuplicateEntryError 的注释）。
func TestInstallerKeyCoversClientDuplicateRule(t *testing.T) {
	utilSrc := readClientSource(t, clientArchiveUtilRel)
	dupBody := functionBody(t, utilSrc, "function assertNoDuplicateEntry", clientArchiveUtilRel)
	// 抽出客户端"查重键"的形态：必须仍然是 `path.toLowerCase()`。
	if !strings.Contains(dupBody, "toLowerCase()") {
		t.Fatalf("%s 的 assertNoDuplicateEntry 不再用 toLowerCase() 折叠大小写（抽到的函数体 = %q）"+
			"—— 查重口径的客户端一侧变了，服务端 installerKey 必须同步复核", clientArchiveUtilRel, dupBody)
	}

	// 输入都是**已归一化**的 posix 路径（两侧的键函数在真实流程里都只看到归一化后的名字：
	// archive-util 先 posixNormalize，服务端先 NormalizePath）。
	pairs := [][2]string{
		{"SKILL.md", "skill.md"},
		{"a/b.md", "A/B.MD"},
		{"SKILL.md", "SKILL.md"}, // 自反
		{"x", "X"},
		{"references/Readme.MD", "REFERENCES/readme.md"},
	}
	for _, p := range pairs {
		a, b := p[0], p[1]
		if strings.ToLower(a) != strings.ToLower(b) {
			continue // 客户端不会判重，无需服务端保证
		}
		if installerKey(a) != installerKey(b) {
			t.Fatalf("客户端判为同一个文件的一对路径在服务端被判成两个：%q(%q) vs %q(%q)"+
				"（服务端查重必须至少与客户端同样粗）", a, installerKey(a), b, installerKey(b))
		}
	}
	// 反向自证（服务端**确实更严**，且这正是为什么它不能取代客户端判据的方向说明）：
	// NTFS 危险折叠只有服务端做，客户端不做 ⇒ 服务端会拒、客户端会放行。
	if installerKey("aſb.txt") != installerKey("asb.txt") {
		t.Fatal("installerKey 的 NTFS 危险折叠失效（aſb.txt 与 asb.txt 在 Windows 上是同一个文件）")
	}
	if strings.ToLower("aſb.txt") == strings.ToLower("asb.txt") {
		t.Fatal("客户端 toLowerCase 竟然折叠了 ſ —— 对拍前提（服务端更严）不成立，请复核")
	}
}

// sortedKeys 返回集合的排序键（比对时用同一口径，避免 map 迭代顺序造成假差异）。
func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

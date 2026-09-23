package serverstore

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/skillmanifest"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ---------------------------------------------------------------------------
// ID-03(审计 2026-09-23,P1):`app_id` 形态正则曾有**三份互不引用的字面量**,
// 真源声明互相指认(limits.go 说"manifest.go 同源",manifest.go 说"上游同源",
// wasm_app_opens.go 说"逐字写在这里供对拍"),而仓库里唯一的"对拍"是一条
// **单向、固定语料**的抽样(llmgateway/app_attribution_test.go:只证明副本 ⊆ 真源,
// 真源被放宽/收紧都不打红)。
//
// 修法:真源唯一 = `wasmapp/limits.AppIDPattern`(平台全部标识形态/数值的唯一
// 真源);消费者一律 import 它;`wasm_app_opens.go` 保留的那一份**必须登记在
// 本用例里**(它是"收窄副本",存在的理由是依赖方向)。本用例是**真对拍**:
// 读对方源码(不是各自钉自己的字面量)、文件缺席即红、集合相等而非抽样。
//
// 变异验证:
//   - 把 manifest.go 改回自己的字面量副本 ⇒ 副本集合断言红(未登记的新副本);
//   - 把 limits.AppIDPattern 放宽(例如允许下划线)⇒ 语料等价断言红;
//   - 删掉 wasm_app_opens.go ⇒ 文件读取失败 ⇒ 红(不是 skip)。
// ---------------------------------------------------------------------------

// appIDPatternLiteral 是 app_id 形态的规范字面量。它与上游
// @deepseek-ai/dsh-skill 的 SKILL_NAME 逐字一致(小写 kebab-case)。
const appIDPatternLiteral = `^[a-z0-9]+(?:-[a-z0-9]+)*$`

// appIDPatternSourceRegistry 登记"允许出现该字面量的非测试 Go 文件"(仓库
// 相对路径)。**新增副本必须登记**,否则 TestAppIDShapeHasASingleSource 红;
// 把副本改成引用真源后必须从本表移除,否则同样红 —— 两个方向都会逼人回来
// 更新这份登记表,不会静默漂移。
var appIDPatternSourceRegistry = []string{
	filepath.Join("wasmapp", "limits", "limits.go"),   // 真源
	filepath.Join("serverstore", "wasm_app_opens.go"), // 登记在案的收窄副本(依赖方向)
	// manifest.go 里的那一处是**引用上游源码的注释**(skill/src/index.ts 的
	// SKILL_NAME),不是规则定义 —— 定义点在下面这份"编译点"登记表里被禁止。
	filepath.Join("skillmanifest", "manifest.go"),
}

// appIDPatternDefRegistry 登记"允许**编译**该字面量"的文件(即真正的规则定义点)。
// 引用真源的消费者不在表内 —— 把 manifest.go 改回 `regexp.MustCompile(<字面量>)`
// 会立刻打红(ID-03 的根因)。
var appIDPatternDefRegistry = map[string]bool{
	filepath.Join("wasmapp", "limits", "limits.go"):   true,
	filepath.Join("serverstore", "wasm_app_opens.go"): true,
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(rel)
	if err != nil {
		// 文件缺席/改名必须**红**,不能 skip:对拍的前提是"读得到对方"。
		t.Fatalf("读不到对拍对象 %s: %v(路径改名了就要同步本用例与真源)", rel, err)
	}
	return string(b)
}

// TestAppIDShapeHasASingleSource 是 ID-03 的核心判据:
//  1. 真源字面量正确且被消费者**引用**(不是各自再写一份);
//  2. 全仓非测试 Go 源码里出现该字面量的文件集合 == 登记表(集合相等)。
func TestAppIDShapeHasASingleSource(t *testing.T) {
	if limits.AppIDPattern != appIDPatternLiteral {
		t.Fatalf("真源 limits.AppIDPattern = %q, want %q", limits.AppIDPattern, appIDPatternLiteral)
	}
	limitsSrc := readRepoFile(t, filepath.Join("..", "wasmapp", "limits", "limits.go"))
	if !strings.Contains(limitsSrc, "`"+appIDPatternLiteral+"`") {
		t.Fatalf("真源文件里没有形态字面量(消费者会失去可引用的常量)")
	}
	// 消费者必须**引用**真源,不能再写字面量。
	manifestSrc := readRepoFile(t, filepath.Join("..", "skillmanifest", "manifest.go"))
	if !strings.Contains(manifestSrc, "regexp.MustCompile(limits.AppIDPattern)") {
		t.Errorf("skillmanifest/manifest.go 没有引用真源 limits.AppIDPattern(ID-03 的根因)")
	}
	if strings.Contains(manifestSrc, "MustCompile(`"+appIDPatternLiteral+"`)") {
		t.Errorf("skillmanifest/manifest.go 又自己编译了字面量副本 —— 形态必须只有一处定义")
	}

	// 全仓扫描:凡出现该字面量的非测试 Go 文件都必须在登记表里,**且**凡
	// 真正把它编译成正则的文件都必须在"定义点"登记表里。
	found := map[string]bool{}
	foundDefs := map[string]bool{}
	root := ".." // internal/
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" || d.Name() == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		b, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		src := string(b)
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			return rerr
		}
		if strings.Contains(src, appIDPatternLiteral) {
			found[rel] = true
		}
		if strings.Contains(src, "MustCompile(`"+appIDPatternLiteral+"`)") {
			foundDefs[rel] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("扫描源码失败: %v", err)
	}
	var foundList, wantList []string
	for f := range found {
		foundList = append(foundList, f)
	}
	for _, f := range appIDPatternSourceRegistry {
		wantList = append(wantList, f)
	}
	sort.Strings(foundList)
	sort.Strings(wantList)
	if strings.Join(foundList, "\n") != strings.Join(wantList, "\n") {
		t.Fatalf("app_id 形态字面量的定义点集合与登记表不一致(ID-03):\n实际 = %v\n登记 = %v\n"+
			"(新增副本必须改为引用 limits.AppIDPattern,或登记到本用例并说明理由)", foundList, wantList)
	}

	for f := range foundDefs {
		if !appIDPatternDefRegistry[f] {
			t.Fatalf("%s 自己编译了 app_id 形态字面量(ID-03:形态只能有一处定义,"+
				"其余一律引用 limits.AppIDPattern)", f)
		}
	}

	// 登记在案的副本必须逐字等于真源(不是"看起来像")。
	opensSrc := readRepoFile(t, "wasm_app_opens.go")
	// 注释里引用上游正则 + 一处真正的定义 = 2 次;编译点必须恰好 1 次。
	if n := strings.Count(opensSrc, "MustCompile(`"+appIDPatternLiteral+"`)"); n != 1 {
		t.Fatalf("wasm_app_opens.go 里的形态定义点 = %d, want 1", n)
	}
	if !strings.Contains(opensSrc, "usageAppIDRe = regexp.MustCompile(`"+appIDPatternLiteral+"`)") {
		t.Fatalf("wasm_app_opens.go 的 usageAppIDRe 不再是登记在案的那份副本")
	}
	if !strings.Contains(opensSrc, "limits.AppIDPattern") {
		t.Errorf("wasm_app_opens.go 的注释宣称与真源同源,却没有引用/指向 limits.AppIDPattern")
	}
}

// TestAppIDShapeCopiesAreEquivalent 在**行为**层面对拍三份实现:同一语料上
// 三者结论必须逐条一致(不是单向抽样)。语料含长度边界与全部禁则。
func TestAppIDShapeCopiesAreEquivalent(t *testing.T) {
	src := readRepoFile(t, "wasm_app_opens.go")
	m := regexp.MustCompile("usageAppIDRe = regexp.MustCompile\\(`([^`]*)`\\)").FindStringSubmatch(src)
	if m == nil {
		t.Fatal("抽不出 wasm_app_opens.go 的 usageAppIDRe 字面量(判据失效,必须红)")
	}
	usageRe, err := regexp.Compile(m[1])
	if err != nil {
		t.Fatal(err)
	}
	sourceRe, err := regexp.Compile(limits.AppIDPattern)
	if err != nil {
		t.Fatal(err)
	}

	corpus := []string{
		"ab", "a-b", "a1", "1a", "abc-def-ghi", "a", "", "-x", "x-", "a--b",
		"UPPER", "Upper", "上标", "has space", "under_score", "dot.name",
		"xn--fiq", "sec-ch-ua", "notes/../etc", "notes.db",
		strings.Repeat("a", limits.MaxAppIDLen), strings.Repeat("a", limits.MaxAppIDLen+1),
		"a-" + strings.Repeat("b", 30), "9", "999999",
	}
	// 逐个字符位置上的禁则(不只抽样开头结尾)。
	for _, bad := range []string{"_", ".", "A", " ", "/", "\\", ":", "é"} {
		corpus = append(corpus, "a"+bad+"b", bad+"ab", "ab"+bad)
	}
	for _, in := range corpus {
		want := sourceRe.MatchString(in)
		if got := usageRe.MatchString(in); got != want {
			t.Errorf("usageAppIDRe(%q) = %v, 真源 = %v(副本与真源分叉)", in, got, want)
		}
		// skillmanifest.IsAppID 走真源 + 自己的长度边界(技能名比 DNS 标签宽
		// 一个字符:64 vs 63,见下面的显式断言)。
		if got, wantSkill := skillmanifest.IsAppID(in), want && len(in) >= skillmanifest.MinAppIDLen && len(in) <= skillmanifest.MaxAppIDLen; got != wantSkill {
			t.Errorf("skillmanifest.IsAppID(%q) = %v, want %v", in, got, wantSkill)
		}
	}

	// 长度边界必须**显式声明**而不是碰巧一致:DNS 标签上限 63,技能名上限 64
	// (技能名不是域名标签 —— 这是唯一的、有意的差异;改任一侧都要在这里改)。
	if limits.MaxAppIDLen != 63 {
		t.Fatalf("limits.MaxAppIDLen = %d, want 63(DNS 标签上限)", limits.MaxAppIDLen)
	}
	if usageAppIDMinLen != 2 || skillmanifest.MinAppIDLen != 2 {
		t.Fatalf("最小长度分叉: usage=%d skillmanifest=%d, want 2/2", usageAppIDMinLen, skillmanifest.MinAppIDLen)
	}
	if usageAppIDMaxLen != limits.MaxAppIDLen {
		t.Fatalf("归因标签上限 %d ≠ 真源上限 %d", usageAppIDMaxLen, limits.MaxAppIDLen)
	}
	if skillmanifest.MaxAppIDLen != limits.MaxAppIDLen+1 {
		t.Fatalf("技能名上限 %d 与真源上限 %d 的关系变了(唯一有意的 1 字符差异);"+
			"改这里就必须重新拍板并同步本断言", skillmanifest.MaxAppIDLen, limits.MaxAppIDLen)
	}
}

// TestSanitizeUsageAppIDMatchesShapeRule 钉住"归因标签 = 真源形态 + 长度边界 +
// 小写化/去空白",即收窄副本的判据本身也是可执行的(不是注释)。
func TestSanitizeUsageAppIDMatchesShapeRule(t *testing.T) {
	re := regexp.MustCompile(limits.AppIDPattern)
	corpus := []string{"notes", " Notes ", "A-B", "a--b", "-x", "x-", "", " ",
		"notes_1", "notes.db", "上标", strings.Repeat("a", limits.MaxAppIDLen),
		strings.Repeat("a", limits.MaxAppIDLen+1)}
	for _, in := range corpus {
		s := strings.ToLower(strings.TrimSpace(in))
		want := ""
		if len(s) >= 2 && len(s) <= limits.MaxAppIDLen && re.MatchString(s) {
			want = s
		}
		if got := SanitizeUsageAppID(in); got != want {
			t.Errorf("SanitizeUsageAppID(%q) = %q, want %q", in, got, want)
		}
	}
}

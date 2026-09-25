package skillmanifest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// 这份用例是 R13-B P1-1 的结构性收口。
//
// 缺陷形态:SKILL.md 写 `user-invocable:`(YAML 空值)/`null`/`~` 时,客户端预检与
// 服务端校验都把 `nil` 当成「没声明」放过,而 pinned 上游的 `frontmatterBoolean`
// 对它**直接 throw**,调用方 catch 后把**整份技能丢弃** ⇒ 上传 201、审核通过、
// 客户端装得上、能力中心显示「已安装」,而模型永远看不到,全链路零报错。
//
// 本项目已登记的死法之一是「两端各钉自己的字面量集合」——所以这里**不重述**上游
// 的取值集合,而是:
//
//	① 从 pinned 上游的**真实实现**派生取值集合(frontmatterBoolean 的 case 标签 +
//	   字符串相等比较 + 数字相等比较 + 兜底 throw),断言 Go 的 booleanLiterals
//	   与它**逐项相等**;
//	② 用一份「真跑 pinned 上游注册表得出」的取值语料(temp/r13/GC/corpus-probe.mjs
//	   的产物)断言 checkInvocation 的判定与上游**逐条一致**。
//
// 上游实现的来源(按可用性取第一个):
//
//  1. submodule 源码 deepseek-harness/packages/skill/skill-filesystem/src/index.ts
//     —— gate job 与本地 checkout 有;server CI job 没有(那里只 checkout server/)。
//  2. 安装产物 packages/host/desktop/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js
//     —— 就是运行时真正加载的那份代码。
//  3. testdata/upstream-invocation-boolean.json —— 从 1/2 提取并登记 sha256 的冻结件。
//
// server job 只有 3 可用 ⇒ 那份 job 里仍会断言「Go 的集合 == 冻结件」「语料逐条
// 一致」,只是不再校验冻结件与活文件一致;**那份校验在 gate job 的 TS 对拍用例里**
// (packages/host/enterprise/tests/skill-invocation-upstream-parity.spec.ts 会读
// 活上游并逐项比对冻结件,漂移即红)。
const (
	upstreamSubmoduleSource   = "../../../deepseek-harness/packages/skill/skill-filesystem/src/index.ts"
	upstreamInstalledLib      = "../../../packages/host/desktop/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js"
	upstreamParityFixturePath = "testdata/upstream-invocation-boolean.json"
)

type upstreamCorpusEntry struct {
	ID            string `json:"id"`
	Line          string `json:"line"`
	UpstreamLoads bool   `json:"upstreamLoads"`
	Why           string `json:"why"`
}

type upstreamParityFixture struct {
	Note                   string                `json:"note"`
	SubmoduleSourceSHA256  string                `json:"submoduleSourceSha256"`
	AcceptedStringLiterals []string              `json:"acceptedStringLiterals"`
	AcceptedNumbers        []int                 `json:"acceptedNumbers"`
	AcceptsBoolean         bool                  `json:"acceptsBoolean"`
	Lowercases             bool                  `json:"lowercases"`
	Trims                  bool                  `json:"trims"`
	ThrowsOtherwise        bool                  `json:"throwsOtherwise"`
	Corpus                 []upstreamCorpusEntry `json:"corpus"`
}

func loadUpstreamParityFixture(t *testing.T) upstreamParityFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(upstreamParityFixturePath))
	if err != nil {
		// 冻结件缺席即红(不是 skip):它是 server CI job 唯一的判据来源。
		t.Fatalf("读不到上游对拍冻结件 %s: %v", upstreamParityFixturePath, err)
	}
	var fx upstreamParityFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("冻结件不是合法 JSON: %v", err)
	}
	if len(fx.Corpus) == 0 || len(fx.AcceptedStringLiterals) == 0 {
		t.Fatalf("冻结件内容为空(集合 %d 条 / 语料 %d 条)", len(fx.AcceptedStringLiterals), len(fx.Corpus))
	}
	return fx
}

var (
	reFrontmatterCase = regexp.MustCompile(`case\s*['"]([^'"]+)['"]\s*:`)
	// RE2 没有 lookbehind:`typeof value === 'boolean'` 这类比较必须先摘掉,
	// 否则 `'boolean'`/`'string'` 会被当成被接受的字符串字面量。
	reFrontmatterTypeof = regexp.MustCompile(`typeof\s+\w+\s*===\s*['"][^'"]*['"]`)
	reFrontmatterQuoted = regexp.MustCompile(`(?:^|[^.\w])value\s*===\s*['"]([^'"]+)['"]`)
	reFrontmatterNumber = regexp.MustCompile(`(?m)(?:^|[^.\w])value\s*===\s*(-?\d+)(?:[^\d.]|$)`)
	reFrontmatterBool   = regexp.MustCompile(`typeof\s+value\s*===\s*['"]boolean['"]`)
	reFrontmatterLower  = regexp.MustCompile(`value\.toLowerCase\(\)`)
	reFrontmatterTrim   = regexp.MustCompile(`value\.trim\(\)`)
	reFrontmatterThrow  = regexp.MustCompile(`throw\s+new\s+TypeError`)
)

// extractFrontmatterBoolean 从上游源码/产物里切出 frontmatterBoolean 的函数体并
// 抽出它接受的取值集合。只做文本抽取(不重述判定逻辑):判定的"形状"由下面几个
// 结构性事实固定 —— boolean 直通、数字 1/0、字符串 switch、其余 throw。
func extractFrontmatterBoolean(t *testing.T, path string) (literals []string, numbers []int, body string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(path))
	if err != nil {
		t.Fatalf("读不到上游实现 %s: %v", path, err)
	}
	text := string(raw)
	start := strings.Index(text, "function frontmatterBoolean")
	if start < 0 {
		t.Fatalf("上游实现里找不到 frontmatterBoolean(%s):上游改名/重构了,请重新对拍", path)
	}
	rest := text[start+len("function frontmatterBoolean"):]
	if next := strings.Index(rest, "\nfunction "); next >= 0 {
		rest = rest[:next]
	}
	comparable := reFrontmatterTypeof.ReplaceAllString(rest, "typeof-compared")
	set := map[string]bool{}
	for _, m := range reFrontmatterCase.FindAllStringSubmatch(comparable, -1) {
		set[m[1]] = true
	}
	for _, m := range reFrontmatterQuoted.FindAllStringSubmatch(comparable, -1) {
		set[m[1]] = true
	}
	for _, m := range reFrontmatterNumber.FindAllStringSubmatch(comparable, -1) {
		if n, err := strconv.Atoi(m[1]); err == nil {
			numbers = append(numbers, n)
		}
	}
	for lit := range set {
		literals = append(literals, lit)
	}
	sort.Strings(literals)
	sort.Ints(numbers)
	return literals, numbers, rest
}

// boolLiteralKeys 返回 booleanLiterals 的键(排序后),作为"Go 侧合法集合"的口径。
func boolLiteralKeys() []string {
	keys := make([]string, 0, len(booleanLiterals))
	for k := range booleanLiterals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestUpstreamInvocationLiteralSetParity:Go 的合法字面量集合必须**逐项等于**
// pinned 上游实现里派生出来的集合 —— 上游加/减一个字面量,这里必红。
func TestUpstreamInvocationLiteralSetParity(t *testing.T) {
	fx := loadUpstreamParityFixture(t)

	if got := boolLiteralKeys(); !equalStrings(got, fx.AcceptedStringLiterals) {
		t.Fatalf("booleanLiterals 与冻结的上游集合不一致:\n  go        = %v\n  upstream  = %v\n"+
			"(两者必须逐项相等;上游改了取值语料就更新 %s)", got, fx.AcceptedStringLiterals, upstreamParityFixturePath)
	}

	live := ""
	for _, candidate := range []string{upstreamSubmoduleSource, upstreamInstalledLib} {
		if _, err := os.Stat(filepath.FromSlash(candidate)); err == nil {
			live = candidate
			break
		}
	}
	if live == "" {
		// server CI job(= 只 checkout server/)的真实情况,如实打印而不是静默。
		t.Logf("pinned 上游实现不在本次检出里(%s / %s);本 job 只用冻结件 %s 对拍;"+
			"与活文件的逐项对拍在 gate job 的 skill-invocation-upstream-parity.spec.ts",
			upstreamSubmoduleSource, upstreamInstalledLib, upstreamParityFixturePath)
		return
	}

	if live == upstreamSubmoduleSource {
		raw, err := os.ReadFile(filepath.FromSlash(live))
		if err != nil {
			t.Fatalf("读不到 %s: %v", live, err)
		}
		sum := sha256.Sum256(raw)
		if got := hex.EncodeToString(sum[:]); got != fx.SubmoduleSourceSHA256 {
			t.Fatalf("pinned 上游源码变了(sha256 %s != 冻结件 %s):请重新提取 %s 并更新 %s",
				got, fx.SubmoduleSourceSHA256, live, upstreamParityFixturePath)
		}
	}

	literals, numbers, body := extractFrontmatterBoolean(t, live)
	if !equalStrings(literals, fx.AcceptedStringLiterals) {
		t.Fatalf("从活上游派生的集合与冻结件不一致:\n  live     = %v\n  fixture  = %v\n请更新 %s",
			literals, fx.AcceptedStringLiterals, upstreamParityFixturePath)
	}
	if !equalStrings(literals, boolLiteralKeys()) {
		t.Fatalf("从活上游派生的集合与 Go 的 booleanLiterals 不一致:\n  live = %v\n  go   = %v",
			literals, boolLiteralKeys())
	}
	if len(numbers) != len(fx.AcceptedNumbers) {
		t.Fatalf("上游接受的数字集合变了:live=%v fixture=%v", numbers, fx.AcceptedNumbers)
	}
	for i := range numbers {
		if numbers[i] != fx.AcceptedNumbers[i] {
			t.Fatalf("上游接受的数字集合变了:live=%v fixture=%v", numbers, fx.AcceptedNumbers)
		}
	}
	// 判定的"形状":boolean 直通、字符串小写化、**不 trim**、其余一律 throw。
	// 缺任何一条,"键存在但取值非法 ⇒ 整份技能被丢弃"的结论就不再成立。
	for _, fact := range []struct {
		ok   bool
		name string
	}{
		{reFrontmatterBool.MatchString(body), "上游 frontmatterBoolean 不再直接接受 boolean"},
		{reFrontmatterLower.MatchString(body), "上游 frontmatterBoolean 不再做 toLowerCase(字面量比较口径变了)"},
		{!reFrontmatterTrim.MatchString(body), "上游 frontmatterBoolean 开始 trim(带空白的字符串不再是非法值,Go 侧也不再该拒)"},
		{reFrontmatterThrow.MatchString(body), "上游 frontmatterBoolean 不再对非法取值 throw(整份技能被丢弃的前提不成立)"},
	} {
		if !fact.ok {
			t.Fatalf("上游判据形状变了:%s(请重新对拍 %s)", fact.name, upstreamParityFixturePath)
		}
	}
}

// TestUpstreamInvocationCorpusParity:取值语料逐条对拍。
//
// 期望值 `upstreamLoads` 由**真跑 pinned 上游 SkillRegistry** 得出(冻结件里
// 逐条记了 why),不是人工判断:注册表里出现该技能 = 上游接受这个取值。
func TestUpstreamInvocationCorpusParity(t *testing.T) {
	fx := loadUpstreamParityFixture(t)
	for _, entry := range fx.Corpus {
		entry := entry
		t.Run(entry.ID, func(t *testing.T) {
			md := goodMDForInvocationLine(t, entry.Line)
			_, err := Parse(entries(), md, "")
			if entry.UpstreamLoads && err != nil {
				t.Fatalf("上游会加载这个取值(%s),本地却拒绝: %v", entry.Why, err)
			}
			if !entry.UpstreamLoads {
				if err == nil {
					t.Fatalf("上游会**丢弃整份技能**(%s),本地却放行 ⇒ 上传成功但模型永远看不到", entry.Why)
				}
				var e *Error
				if !errors.As(err, &e) || e.Code != CodeInvocationInvalid {
					t.Fatalf("应报 %s,实得 %v(%s)", CodeInvocationInvalid, err, entry.Why)
				}
			}
		})
	}
}

// goodMDForInvocationLine 把冻结件里的原始 frontmatter 行(如 `user-invocable:`)
// 拼进一份其它字段全部合规的 SKILL.md;空行 = 该键不出现。
func goodMDForInvocationLine(t *testing.T, line string) string {
	t.Helper()
	if strings.TrimSpace(line) == "" {
		return goodMD(nil)
	}
	key, value, found := strings.Cut(line, ":")
	if !found {
		t.Fatalf("冻结件里的取值行没有冒号: %q", line)
	}
	key = strings.TrimSpace(key)
	// `key:` 后面恰有一个空格(原样保留值的空白,`" true "` 这类用例依赖它)。
	value = strings.TrimPrefix(value, " ")
	if key == "" {
		t.Fatalf("冻结件里的取值行没有键: %q", line)
	}
	return goodMD(map[string]string{key: value})
}

// TestParseRejectsEmptyInvocationValue:把 R13-B P1-1 的载体单独钉一条 —— 空值
// (`user-invocable:` / `null` / `~` / 空串)必须被拒,且错误码是 INVOCATION_INVALID。
// 这一条是回归护栏:曾经这里是 `!ok || raw == nil { continue }`(三关全绿而运行时
// 丢弃整份技能)。
func TestParseRejectsEmptyInvocationValue(t *testing.T) {
	for _, tc := range []struct {
		label string
		md    string
	}{
		{"空值", goodMD(map[string]string{"user-invocable": ""})},
		{"null", goodMD(map[string]string{"user-invocable": "null"})},
		{"~", goodMD(map[string]string{"user-invocable": "~"})},
		{"空串", goodMD(map[string]string{"user-invocable": `""`})},
		{"带空白的字符串", goodMD(map[string]string{"user-invocable": `" true "`})},
		{"disable-model-invocation 空值", goodMD(map[string]string{"disable-model-invocation": ""})},
	} {
		tc := tc
		t.Run(tc.label, func(t *testing.T) {
			_, err := Parse(entries(), tc.md, "")
			assertCode(t, err, CodeInvocationInvalid, "")
			if err != nil && !strings.Contains(err.Error(), "丢弃整份技能") {
				t.Fatalf("错误文案必须说清后果(整份技能被丢弃),实得: %v", err)
			}
		})
	}
}

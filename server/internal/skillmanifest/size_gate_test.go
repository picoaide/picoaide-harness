package skillmanifest

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// FIX-01(审计 2026-09-12,P0):YAML 深度炸弹 → 进程级 OOM。
//
// 这三条测试锁住的是**不可 recover** 的失效模式:修复前 `Parse` 把
// frontmatter 直接交给 goccy/go-yaml v1.19.2 的解析器,而该解析器对嵌套集合
// 没有深度/节点上限,内存二次增长,超限时 `runtime: out of memory` →
// `fatal error: out of memory`(Go 运行时的致命错误,**不能被 recover() 捕获**)
// ——一次上传就能打死整个服务端进程。
//
// 实测证据(rlimit 3 GB,修复前):
//
//	`a: ` + `[`×200000 → fatal error: out of memory(exit 2)
//	`a: ` + `[`×20000  → RSS 5 → 462 MiB
//	`- `×65536          → fatal error: out of memory
//
// 所以这些测试**不能**断言「不 OOM」——断言失败之前进程就已经死了。
// 它们断言的是「返回错误码」:闸门在解析器之前拦下,内存曲线保持平坦。
// 深度炸弹的完整探测(fatal error 复现)在 zz_oom 探针里做,不进 CI。

// rssMiB 读 /proc/self/statm(仅 Linux;其它平台返回 -1 并跳过断言)。
func rssMiB() float64 {
	b, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return -1
	}
	var size, resident int64
	if _, err := fmt.Sscanf(string(b), "%d %d", &size, &resident); err != nil {
		return -1
	}
	return float64(resident) * float64(os.Getpagesize()) / (1 << 20)
}

// TestParseRejectsOversizedManifest 锁第一层闸门(O(1) 长度上限)。
func TestParseRejectsOversizedManifest(t *testing.T) {
	// frontmatter 本身超限:合法字段 + 超长填充。
	md := goodMD(nil) + strings.Repeat("x", MaxSkillMDBytes)
	if _, err := Parse(entries(), md, ""); err == nil {
		t.Fatal("oversized SKILL.md must be rejected")
	} else {
		assertCode(t, err, CodeInputTooLarge, "")
	}
	// 边界:恰好等于上限时长度闸不触发(还能继续走到后面的规则)。
	body := strings.Repeat("x", MaxSkillMDBytes-len(goodMD(nil)))
	if _, err := Parse(entries(), goodMD(nil)+body, ""); err != nil {
		var e *Error
		if errors.As(err, &e) && e.Code == CodeInputTooLarge {
			t.Fatalf("exactly MaxSkillMDBytes must pass the size gate, got %s", e.Code)
		}
	}
	if _, err := ParseAgent(entries(), strings.Repeat("x", MaxSkillMDBytes+1), "app"); err == nil {
		t.Fatal("oversized preset.yml must be rejected")
	} else {
		assertCode(t, err, CodeInputTooLarge, PresetMetaFile)
	}
}

// TestParseRejectsYAMLDepthBombs 锁第二层闸门(解析前字符统计)。
//
// 每个用例都是 100 KB(< MaxSkillMDBytes,所以第一层闸门**不会**触发)的
// **合法字段 + 炸弹前缀**;修复前它们要么直接 OOM(`[` / `- `),要么让解析器
// 分配数十 MB;修复后必须在进解析器之前被拒,且耗时为微秒级、RSS 平坦。
func TestParseRejectsYAMLDepthBombs(t *testing.T) {
	target := 100 << 10
	rep := func(s string) string { return strings.Repeat(s, target/len(s)) }
	cases := []struct {
		name  string
		front string
	}{
		{"flow-seq", "a: " + rep("[")},
		{"flow-map", "a: " + rep("{")},
		{"block-seq-dash", rep("- ")},
		{"block-seq-dash-tab", rep("-\t")},
		{"closing-brackets", "a: " + rep("]")},
		{"anchor-alias", "a: &x [1]\nb: " + rep("*x ")},
		{"tags", rep("!!str ")},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			md := "---\n" + tc.front + "\n---\n" + goodBody
			if len(md) > MaxSkillMDBytes {
				t.Fatalf("test bug: fixture %d bytes must stay under the size gate (%d)",
					len(md), MaxSkillMDBytes)
			}
			before := rssMiB()
			start := time.Now()
			_, err := Parse(entries(), md, "")
			elapsed := time.Since(start)
			runtime.GC()
			after := rssMiB()

			assertCode(t, err, CodeFrontmatterInvalid, "")
			// 闸门是零分配单遍扫描:必须远快于解析器(修复前同尺寸下
			// 47 MiB~OOM 需要数十毫秒)。
			if elapsed > 50*time.Millisecond {
				t.Errorf("complexity gate took %v; it must reject before the parser", elapsed)
			}
			if before > 0 && after > 0 && after-before > 32 {
				t.Errorf("RSS grew %.1f MiB (%.1f → %.1f); the bomb reached the parser",
					after-before, before, after)
			}
		})
	}
}

// TestParseAgentRejectsYAMLDepthBombs 锁 preset.yml 的同一处修复 ——
// ParseAgent 走的是同一个解析器,同一形态同样能打死进程。
func TestParseAgentRejectsYAMLDepthBombs(t *testing.T) {
	front := "a: " + strings.Repeat("[", 100<<10)
	if len(front) > MaxSkillMDBytes {
		t.Fatalf("test bug: fixture %d bytes over the size gate", len(front))
	}
	before := rssMiB()
	_, err := ParseAgent(entries(), front, "my-agent")
	after := rssMiB()
	assertCode(t, err, CodeFrontmatterInvalid, PresetMetaFile)
	if before > 0 && after > 0 && after-before > 32 {
		t.Errorf("RSS grew %.1f MiB; the bomb reached the parser", after-before)
	}
}

// TestFrontmatterComplexityThresholds 是闸门的单元级边界测试:阈值语义
// (">" 而非 ">=")与「合法扁平 frontmatter 不误伤」。
func TestFrontmatterComplexityThresholds(t *testing.T) {
	ok := []string{
		"",
		"name: my-skill\nversion: 1.0.0",
		"tags: [a, b, c]",
		"tags:\n  - a\n  - b\n  - c",
		// description 里的 markdown 粗体/感叹号/问号/冒号都不该触发。
		"description: 用 **粗体** 与 *斜体*!何时使用?先看:文档",
		"description: kebab-case-name with-dashes and --- separators",
	}
	for _, f := range ok {
		if err := checkFrontmatterComplexity(f, ""); err != nil {
			t.Errorf("legit frontmatter %q rejected: %v", f, err)
		}
	}
	// 恰好等于阈值通过;超过 1 即拒。
	// 注意:必须用「深度不增长」的写法触碰计数阈值(`[]` 配对 / 每行一个
	// `- `)——`[`×256 会先撞上深度闸(32),那是另一条规则、另一个报错。
	pairs := strings.Repeat("[]", MaxFrontmatterCollections/2) // 256 个括号,深度 1
	if len(pairs) != MaxFrontmatterCollections {
		t.Fatalf("test bug: %d brackets", len(pairs))
	}
	if err := checkFrontmatterComplexity(pairs, ""); err != nil {
		t.Errorf("exactly MaxFrontmatterCollections must pass: %v", err)
	}
	if err := checkFrontmatterComplexity(pairs+"[", ""); err == nil {
		t.Error("MaxFrontmatterCollections+1 must be rejected")
	}
	// 深度边界:`[`×32 通过,×33 拒(阈值是 ">" 语义)。
	if err := checkFrontmatterComplexity(strings.Repeat("[", MaxFrontmatterDepth), ""); err != nil {
		t.Errorf("exactly MaxFrontmatterDepth must pass: %v", err)
	}
	if err := checkFrontmatterComplexity(strings.Repeat("[", MaxFrontmatterDepth+1), ""); err == nil {
		t.Error("MaxFrontmatterDepth+1 must be rejected")
	}
	// 列表项:每行一个,深度每行归零 —— 只有计数闸生效。
	items := strings.Repeat("- item\n", MaxFrontmatterIndicators)
	if err := checkFrontmatterComplexity(items, ""); err != nil {
		t.Errorf("exactly MaxFrontmatterIndicators must pass: %v", err)
	}
	if err := checkFrontmatterComplexity(items+"- item\n", ""); err == nil {
		t.Error("MaxFrontmatterIndicators+1 must be rejected")
	}
	if err := checkFrontmatterComplexity(strings.Repeat("*", MaxFrontmatterReferences), ""); err != nil {
		t.Errorf("exactly MaxFrontmatterReferences must pass: %v", err)
	}
	if err := checkFrontmatterComplexity(strings.Repeat("*", MaxFrontmatterReferences+1), ""); err == nil {
		t.Error("MaxFrontmatterReferences+1 must be rejected")
	}
	// 足够多但仍合法的标签列表(线上实测最多 15 个)必须通过。
	var b strings.Builder
	b.WriteString("tags:\n")
	for i := 0; i < MaxTags; i++ {
		b.WriteString("  - tag-")
		b.WriteString(strings.Repeat("x", 20))
		b.WriteString("\n")
	}
	if err := checkFrontmatterComplexity(b.String(), ""); err != nil {
		t.Errorf("max-size legit tag list rejected: %v", err)
	}
}

// TestParseStillAcceptsRealManifests 是防回归锚:闸门不得误伤真实技能包。
func TestParseStillAcceptsRealManifests(t *testing.T) {
	tags := make([]string, 0, MaxTags)
	for i := 0; i < MaxTags; i++ {
		tags = append(tags, "tag-number-"+strings.Repeat("y", 10))
	}
	md := goodMD(map[string]string{
		"tags":      "[" + strings.Join(tags, ", ") + "]",
		"changelog": "首次发布:初始化知识库索引与读取规则。",
	}, "author")
	md = strings.Replace(md, "---\n\n", "author: zhangsan\n---\n\n", 1)
	if _, err := Parse(entries(), md, ""); err != nil {
		t.Fatalf("real-shaped manifest rejected: %v", err)
	}
	// 接近上限但仍合法的大 description(2000 字)必须通过。
	long := strings.Repeat("这是一个足够长的描述文本。", MaxDescriptionRunes/12+1)
	if runes := len([]rune(long)); runes > MaxDescriptionRunes {
		long = string([]rune(long)[:MaxDescriptionRunes])
	}
	if _, err := Parse(entries(), goodMD(map[string]string{"description": long}), ""); err != nil {
		t.Fatalf("max-length description rejected: %v", err)
	}
}

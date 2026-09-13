package agentshare

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// N-1 永久回归(2026-09-13 三轮)
//
// 前两轮的失败模式一致:修复只覆盖报告点名的那一条形态,同类形态换个写法
// 就穿透。所以这里的断言按**成本来源**分组,而不是按拼写:
//
//	A. merge key(`<<:`)的合并在**解码期**逐键拷贝 —— 无论 `<<:` 写成
//	   `<< :`、值用别名序列/标签/嵌套锚点,成本都在 goccy 的 keyToNodeMap 里,
//	   形状遍历看不见。闸门必须在解码前按「合并展开量」拒绝。
//	B. 解析前结构扫描器的引号状态必须只在**标量开头**开启:普通标量里的
//	   撇号(`don't`)不是引号,不能被它关掉深度/数量闸门。
//	C. 与形态无关的兜底:解析本身有墙钟预算,任何枚举不到的第三种构造都在
//	   预算内被拒(这一条用测试内临时收紧预算来证明闸门真的在跑)。
// ---------------------------------------------------------------------------

// mergeBombSpelled 生成 merge 炸弹:每层的 `<<` 写法由 spell 决定
// (`<<: [..]` / `<< : [..]`),引用可以被 tag 包裹 —— 成本同源,只是拼写不同。
func mergeBombSpelled(depth, fanout int, spell string, tag bool) string {
	var b strings.Builder
	b.WriteString("- name: root\n  k0: &m0 {a: 1}\n")
	prev := "*m0"
	for i := 1; i <= depth; i++ {
		refs := make([]string, fanout)
		for j := range refs {
			if tag {
				refs[j] = "!foo " + prev
			} else {
				refs[j] = prev
			}
		}
		fmt.Fprintf(&b, "  k%d: &m%d {%s [%s]}\n", i, i, spell, strings.Join(refs, ", "))
		prev = fmt.Sprintf("*m%d", i)
	}
	return b.String()
}

// nestedMergeBomb 把 merge 链放在**非顶层、非 name/group/config** 的键下:
// 形状遍历只看 name/group/config,所以这类炸弹的成本必须由独立于形状的
// merge 预算来封(它走的是整棵 AST,而不是可见键)。
func nestedMergeBomb(levels, fanout int) string {
	var b strings.Builder
	b.WriteString("- name: root\n  cfg:\n    base: &m0 {a: 1}\n")
	prev := "*m0"
	for i := 1; i <= levels; i++ {
		refs := make([]string, fanout)
		for j := range refs {
			refs[j] = prev
		}
		fmt.Fprintf(&b, "    l%d: &m%d {<<: [%s]}\n", i, i, strings.Join(refs, ", "))
		prev = fmt.Sprintf("*m%d", i)
	}
	return b.String()
}

// TestCompositionMergeKeyBombRejectedFast:N-1① 的等价形态矩阵。
//
// 报告形态是 `<<: [*a, *a, …]`;这里额外覆盖同源成本的 4 种写法:
// `<< :`(冒号前空格,goccy 仍识别为 merge key)、tag 包裹的引用、更高
// fanout/更少层数、以及自引用 merge(循环锚点)。判据是「被拒 + 快」,
// 不是「错误文案一样」。
func TestCompositionMergeKeyBombRejectedFast(t *testing.T) {
	shapes := []struct {
		name string
		doc  string
	}{
		{"merge7x9", mergeBombSpelled(7, 9, "<<:", false)},
		{"merge6x20", mergeBombSpelled(6, 20, "<<:", false)},
		{"merge-space-colon5x20", mergeBombSpelled(5, 20, "<< :", false)},
		{"merge-tagged-refs6x12", mergeBombSpelled(6, 12, "<<:", true)},
		{"merge-selfref", "- name: a\n  x: &x {<<: *x}\n"},
		{"merge-selfref-seq", "- name: a\n  x: &x {<<: [*x, *x]}\n"},
		{"merge-nested-under-dead-key", nestedMergeBomb(6, 10)},
		{"merge-nested-under-dead-key-8x8", nestedMergeBomb(8, 8)},
	}
	for _, tc := range shapes {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.doc) > maxFilePreviewBytes {
				t.Fatalf("fixture %d 字节超预览上限", len(tc.doc))
			}
			t0 := time.Now()
			err := ValidateAgentComposition(tc.doc)
			el := time.Since(t0)
			t.Logf("%-24s %5d 字节 -> %v(耗时 %v)", tc.name, len(tc.doc), err, el.Round(time.Millisecond))
			if err == nil {
				t.Fatalf("merge key 炸弹被放行(%d 字节,耗时 %v)", len(tc.doc), el)
			}
			if !strings.Contains(err.Error(), "merge key") {
				t.Fatalf("拒绝理由不是 merge 预算(可能是碰巧别的错误): %v", err)
			}
			if el > time.Second {
				t.Fatalf("拒绝耗时 %v:闸门没有在解码前生效", el)
			}
		})
	}
}

// TestCompositionMergeKeyLegitSpellingsAccepted:merge key 本身是合法 YAML,
// 不能因为闸门把正常用法一起拒掉(误伤与穿透同样是缺陷)。
func TestCompositionMergeKeyLegitSpellingsAccepted(t *testing.T) {
	cases := []struct {
		name string
		doc  string
	}{
		{"single-merge",
			"- name: a\n  base: &b {x: 1, y: 2}\n  cfg:\n    <<: *b\n    z: 3\n"},
		{"merge-list-of-two",
			"- name: a\n  p: &p {x: 1}\n  q: &q {y: 2}\n  cfg:\n    <<: [*p, *q]\n    z: 3\n"},
		{"merge-in-block-scalar",
			"- name: a\n  config:\n    prefix: |\n      <<: not a merge key\n      <<: still content\n"},
		{"merge-in-quoted-strings",
			"- name: a\n  config:\n    title: \"a <<: b\"\n    note: 'x <<: y'\n"},
		{"merge-in-comment",
			"- name: a\n  # <<: *nothing\n  config:\n    x: 1\n"},
		{"double-angle-in-plain-scalar",
			"- name: a\n  config:\n    x: a<<b\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateAgentComposition(tc.doc); err != nil {
				t.Fatalf("合法 merge 用法被误拒: %v", err)
			}
		})
	}
}

// apostropheShape 把「正文里的撇号」放在深嵌套结构之前:撇号若被当成引号,
// 后面的结构全部不计数,闸门被一个字符关掉。
func apostropheShape(prose string, depth int, withQuotes bool) string {
	nest := strings.Repeat("[", depth) + strings.Repeat("]", depth)
	doc := "- name: a\n  config:\n    " + prose + "\n    y: " + nest + "\n"
	if withQuotes {
		doc = "- name: a\n  config:\n    t: \"ok\"\n    " + prose + "\n    y: " + nest + "\n"
	}
	return doc
}

// flowApostropheShape 把「普通标量里的撇号/引号」放进**流式集合**里,同一行
// 后面紧跟深嵌套:这类形态里 goccy 确实把后面的 `[` 当结构解析,而扫描器若把
// 撇号当引号开头,就会把整行剩余部分当正文 —— 欠计数的危害在这里是真实的
// (缩进复位救不了同一行,只有「引号必须在标量开头」这条判定能救)。
func flowApostropheShape(prose string, depth int) string {
	return "- name: a\n  config:\n    x: [" + prose + ", " +
		strings.Repeat("[", depth) + strings.Repeat("]", depth) + "]\n"
}

// TestCompositionQuoteStateUnderCountingClosed:N-1② 的等价形态矩阵 ——
// 撇号出现在普通标量、双引号标量内、注释、`”` 转义里,都不能关掉闸门。
func TestCompositionQuoteStateUnderCountingClosed(t *testing.T) {
	shapes := []struct {
		name  string
		prose string
		// indicatorBomb 用 6000 个 `- `(块序列指示符)而不是深嵌套,因为它
		// 依赖的是同一份「后续内容被判为引号内」的欠计数。
		indicatorBomb bool
	}{
		{name: "apostrophe-plain", prose: "x: don't"},
		{name: "apostrophe-plain-unclosed", prose: "x: it's a 'test"},
		{name: "apostrophe-escaped-doubled", prose: "x: don''t"},
		{name: "apostrophe-inside-double-quotes", prose: "x: \"don't\""},
		{name: "apostrophe-in-comment", prose: "x: 1 # don't\n    z: 2"},
		{name: "apostrophe-after-bracket", prose: "x: [don't]"},
		{name: "apostrophe-indicator-bomb", prose: "x: don't", indicatorBomb: true},
		{name: "quote-in-plain", prose: "x: he said \"hi\" loudly"},
	}
	for _, tc := range shapes {
		t.Run(tc.name, func(t *testing.T) {
			var doc string
			if tc.indicatorBomb {
				doc = "- name: a\n  config:\n    " + tc.prose + "\n" + strings.Repeat("- ", 6000)
			} else {
				doc = apostropheShape(tc.prose, 40000, false)
			}
			if len(doc) > maxFilePreviewBytes {
				t.Fatalf("fixture %d 字节超预览上限", len(doc))
			}
			t0 := time.Now()
			err := checkCompositionBudget(doc)
			t.Logf("%-30s -> %v(耗时 %v)", tc.name, err, time.Since(t0).Round(time.Millisecond))
			if err == nil {
				t.Fatalf("撇号/引号形态关掉了结构闸门(欠计数):%s", tc.name)
			}
			// 解析后的完整闸门同样必须快(不能靠解析器慢慢报错)。
			t0 = time.Now()
			if verr := ValidateAgentComposition(doc); verr == nil {
				t.Fatalf("完整闸门放行了欠计数形态:%s", tc.name)
			}
			if el := time.Since(t0); el > time.Second {
				t.Fatalf("%s 完整闸门耗时 %v(应在解析前就挡住)", tc.name, el)
			}
		})
	}
}

// TestCompositionFlowContextQuoteUnderCountingClosed:同一行内的欠计数 ——
// 缩进复位(跨行)在这里无效,能救的只有 compositionQuoteOpener 的「引号必须
// 位于标量开头」判定。断言直接落在**解析前扫描器**上,所以这条测试对
// 「引号判定被退回成看到引号就进状态」是敏感的(变异测试证明)。
func TestCompositionFlowContextQuoteUnderCountingClosed(t *testing.T) {
	shapes := []struct {
		name  string
		prose string
	}{
		{"flow-apostrophe-plain", "don't"},
		{"flow-double-quote-plain", "he said \"hi\""},
		{"flow-apostrophe-key", "it's: 1"},
		{"flow-apostrophe-then-colon", "x'd: 1"},
	}
	for _, tc := range shapes {
		t.Run(tc.name, func(t *testing.T) {
			doc := flowApostropheShape(tc.prose, 40000)
			if len(doc) > maxFilePreviewBytes {
				t.Fatalf("fixture %d 字节超预览上限", len(doc))
			}
			scanErr := checkCompositionBudget(doc)
			t.Logf("%-24s 解析前扫描 -> %v", tc.name, scanErr)
			if scanErr == nil {
				t.Fatalf("同一行的撇号/引号把结构闸门关掉了(欠计数):%s", tc.name)
			}
			t0 := time.Now()
			err := ValidateAgentComposition(doc)
			el := time.Since(t0)
			if err == nil {
				t.Fatalf("%s 被完整闸门放行", tc.name)
			}
			if el > time.Second {
				t.Fatalf("%s 完整闸门耗时 %v(应在解析前挡住,而不是靠解析预算兜底)", tc.name, el)
			}
			t.Logf("%-24s 完整闸门 -> %v(耗时 %v)", tc.name, err, el.Round(time.Millisecond))
		})
	}
}

// TestCompositionApostropheLegitStillAccepted:撇号是正常文本,不能误拒。
func TestCompositionApostropheLegitStillAccepted(t *testing.T) {
	for _, ok := range []string{
		"- name: a\n  config:\n    description: it's fine\n",
		"- name: a\n  config:\n    description: \"don't\"\n",
		"- name: a\n  config:\n    desc: 'it''s fine'\n",
		"- name: a\n  config:\n    prefix: |\n      Don't break the build.\n      It's a bullet: - x\n",
	} {
		if err := ValidateAgentComposition(ok); err != nil {
			t.Fatalf("合法含撇号编排被误拒 %q: %v", ok, err)
		}
	}
}

// slowButLegalDocument 生成一份**形状合法、解析偏慢**的文档(大量同级映射键)。
// 它用来证明「解析墙钟预算」这条闸门真的在跑:正常预算下必须被接受,把预算
// 收紧到 1ms 后必须被预算拒绝 —— 若有人把 deadline 那段删掉,第二条断言会红。
func slowButLegalDocument(keys int) string {
	var b strings.Builder
	b.WriteString("- name: a\n  config:\n")
	for i := 0; i < keys; i++ {
		fmt.Fprintf(&b, "    k%d: %d\n", i, i)
	}
	return b.String()
}

// TestCompositionDecodeBudgetGateIsLive:N-1③ —— 与形态无关的兜底闸门。
func TestCompositionDecodeBudgetGateIsLive(t *testing.T) {
	doc := slowButLegalDocument(6000)
	if len(doc) > maxFilePreviewBytes {
		t.Fatalf("fixture %d 字节超预览上限", len(doc))
	}
	t.Logf("fixture %d 字节", len(doc))
	// 前提:正常预算下这份文档是合法的(所以下面的拒绝只能来自预算)。
	if err := ValidateAgentComposition(doc); err != nil {
		t.Fatalf("前提不成立:形状合法的文档被拒: %v", err)
	}
	orig := compositionDecodeBudget
	compositionDecodeBudget = time.Millisecond
	restored := false
	defer func() {
		if !restored {
			compositionDecodeBudget = orig
		}
	}()
	err := ValidateAgentComposition(doc)
	compositionDecodeBudget = orig
	restored = true
	if err == nil {
		t.Fatal("把解析预算收紧到 1ms 后仍然放行:deadline 闸门没有生效")
	}
	t.Logf("收紧预算后的拒绝: %v", err)
	// 再来一次:同一份文档已被「定罪」,即使预算恢复也必须立即被拒。
	t0 := time.Now()
	if err2 := ValidateAgentComposition(doc); err2 == nil {
		t.Fatal("被定罪的文档在预算恢复后被放行(定罪备忘失效)")
	}
	t.Logf("定罪备忘命中,耗时 %v", time.Since(t0).Round(time.Millisecond))
}

// TestCompositionAdversarialShapeBatteryTimeBounded:N-1③ 的「未知形态」矩阵。
// 每个形态都必须**在时间预算内**给出结论(接受或拒绝),不允许任何一个把
// CPU 烧掉 —— 这正是形态枚举追不上时唯一可靠的判据。
func TestCompositionAdversarialShapeBatteryTimeBounded(t *testing.T) {
	deep := func(depth int, wrap string) string {
		return "- name: a\n  config:\n    y: " + wrap + strings.Repeat("[", depth) + strings.Repeat("]", depth) + "\n"
	}
	shapes := []struct {
		name        string
		doc         string
		mustReject  bool
		maxDuration time.Duration
	}{
		{"deep-flow-40000", deep(40000, ""), true, time.Second},
		{"deep-flow-2000", deep(2000, "'"), true, 3 * time.Second}, // 引号未闭合 → 预算兜底
		{"multi-doc-bomb", "- name: a\n---\n" + mergeBombSpelled(6, 20, "<<:", false), true, time.Second},
		{"tag-bomb", "- name: a\n  x: &a0 !foo {q: 1}\n  y1: !foo [*a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0]\n", false, time.Second},
		{"complex-key", "- name: a\n  ? [x, y]\n  : 1\n", false, time.Second},
		{"long-line-120k", "- name: a\n  config:\n    x: " + strings.Repeat("a", 120_000) + "\n", false, time.Second},
		{"merge-space-colon", mergeBombSpelled(5, 20, "<< :", false), true, time.Second},
		{"anchor-selfref-group", "- &a {name: a, group: true, config: [*a]}\n", true, time.Second},
		{"dup-key", "- name: a\n  name: b\n", false, time.Second},
		{"crlf-and-bom", "\ufeff- name: a\r\n  config:\r\n    x: 1\r\n", false, time.Second},
	}
	for _, tc := range shapes {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.doc) > maxFilePreviewBytes {
				t.Skipf("fixture %d 字节超预览上限", len(tc.doc))
			}
			t0 := time.Now()
			err := ValidateAgentComposition(tc.doc)
			el := time.Since(t0)
			t.Logf("%-24s %6d 字节 -> err=%v(耗时 %v)", tc.name, len(tc.doc), err, el.Round(time.Millisecond))
			if el > tc.maxDuration {
				t.Fatalf("%s 耗时 %v 超出预算 %v(闸门没有封住 CPU)", tc.name, el, tc.maxDuration)
			}
			if tc.mustReject && err == nil {
				t.Fatalf("%s 是炸弹形态却被放行", tc.name)
			}
			if !tc.mustReject && err != nil && errors.Is(err, errCompositionMergeBudget) {
				t.Fatalf("%s 被 merge 闸门误伤: %v", tc.name, err)
			}
		})
	}
}

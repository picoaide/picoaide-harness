package agentshare

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// R7 二轮复核(F2-N1 / F2-N5 / F2-N8)的永久回归
//
// 一轮的编排闸门用「文本字符统计」当解析预算,于是:
//   - F2-N1:573 字节的 YAML 别名炸弹(&/* 91 个)让形状遍历按 9^k 指数展开,
//     实测 n=8 = 29 秒 CPU 且照样 201 入库;
//   - F2-N5:块标量里的大提示词(markdown 项目符号/链接方括号)被当成 YAML
//     结构,合法的 59918 字节编排被拒「插件行过多」;
//   - F2-N8:多文档 `---` 被闸门放行、被上游 js-yaml loader 拒绝。
// 下面三条分别覆盖,另附「结构炸弹仍被挡」与「方言对齐」两组控制组。
// ---------------------------------------------------------------------------

// aliasBombComposition 生成 billion-laughs 形态的编排:第 k 行的 config
// 引用上一行 9 次。n=8 时文本 715 字节、展开叶 9^8 ≈ 4300 万个 —— 一轮
// 实现的形状遍历实测耗 28 秒。
func aliasBombComposition(n int) string {
	var b strings.Builder
	b.WriteString("- name: defs\n  d: &m0 {name: leaf}\n")
	for i := 1; i <= n; i++ {
		if i == 1 {
			fmt.Fprintf(&b, "- &r1 {name: g1, group: true, config: [%s]}\n",
				strings.TrimSuffix(strings.Repeat("*m0, ", 9), ", "))
			continue
		}
		fmt.Fprintf(&b, "- &r%d {name: g%d, group: true, config: [%s]}\n", i, i,
			strings.TrimSuffix(strings.Repeat(fmt.Sprintf("*r%d, ", i-1), 9), ", "))
	}
	return b.String()
}

// TestCompositionAliasBombRejectedWithoutExponentialWalk:F2-N1 —— 别名展开
// 必须在**访问量**上封顶,而不是在文本字符上。断言两件事:拒绝,且拒绝得快
// (一轮实现在 n=8 上要 28 秒;这里给 3 秒的宽裕上限)。
func TestCompositionAliasBombRejectedWithoutExponentialWalk(t *testing.T) {
	bomb := aliasBombComposition(8)
	if len(bomb) > 1<<10 {
		t.Fatalf("bomb fixture is %d bytes, want a sub-KB payload (字符预算拦不住它)", len(bomb))
	}
	done := make(chan error, 1)
	t0 := time.Now()
	go func() { done <- ValidateAgentComposition(bomb) }()
	select {
	case err := <-done:
		elapsed := time.Since(t0)
		t.Logf("alias bomb (%d bytes, 9^8 展开叶) -> %v (耗时 %v)", len(bomb), err, elapsed.Round(time.Millisecond))
		if err == nil {
			t.Fatal("别名炸弹编排被发布闸门放行:形状遍历会按 9^k 指数展开")
		}
		if !strings.Contains(err.Error(), "节点数超过上限") {
			t.Fatalf("err = %v, want the node-budget refusal", err)
		}
		if elapsed > 3*time.Second {
			t.Fatalf("别名炸弹耗时 %v,超过 3s 上限(说明预算没有约束展开后的访问量)", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("别名炸弹在 5 秒内没有返回:形状遍历仍在指数展开")
	}
}

// TestCompositionGateTerminatesOnSelfReferentialAlias:自引用别名不能让
// 形状遍历无限递归(节点预算 + group 深度上限兜底)。这里只断言「会终止」,
// 不锁定具体错误 —— 不同 goccy 版本对 `&c [*c]` 的解析结果不同。
func TestCompositionGateTerminatesOnSelfReferentialAlias(t *testing.T) {
	docs := []string{
		"- name: a\n  group: true\n  config: &c [*c]\n",
		"- name: a\n  group: true\n  config: &c [{name: x, group: true, config: *c}]\n",
	}
	for _, doc := range docs {
		done := make(chan error, 1)
		go func(d string) { done <- ValidateAgentComposition(d) }(doc)
		select {
		case err := <-done:
			t.Logf("self-referential alias -> err=%v", err)
		case <-time.After(5 * time.Second):
			t.Fatalf("自引用别名让闸门挂死: %q", doc)
		}
	}
}

// legitLargeComposition 生成一份**合法**的大提示词编排:项目符号/方括号
// 全在块标量(prefix)正文里 —— 上游 js-yaml ACCEPT,一轮的字符计数器把
// 它们当成 YAML 结构。
func legitLargeComposition(bullets, bracketLines int) string {
	var b strings.Builder
	b.WriteString("- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    complete: true\n    prefix: |-\n")
	b.WriteString("      You are a helpful assistant.\n")
	for i := 0; i < bullets; i++ {
		fmt.Fprintf(&b, "      - Rule %d: cite [d%d](e.com)\n", i, i)
	}
	for i := 0; i < bracketLines; i++ {
		fmt.Fprintf(&b, "      See [d%d](e.com)\n", i)
	}
	b.WriteString("- id: tools\n  name: '@deepseek-ai/dsh-tools'\n")
	return b.String()
}

// TestCompositionGateAcceptsLargePromptWithMarkdownInBlockScalar:F2-N5 ——
// 判据不能严于危害:块标量正文里的 `- ` 与 `[]` 是提示词内容,不是插件行 /
// 流式集合。一轮实现把 59918 字节的合法编排误拒「插件行过多(- 共 2102 个)」。
func TestCompositionGateAcceptsLargePromptWithMarkdownInBlockScalar(t *testing.T) {
	doc := legitLargeComposition(2102, 600)
	if len(doc) > maxFilePreviewBytes {
		t.Fatalf("fixture %d bytes 超预览上限,测不到预算误判", len(doc))
	}
	if got := strings.Count(doc, "- Rule"); got <= maxCompositionIndicators {
		t.Fatalf("fixture 只有 %d 个项目符号,必须超过结构上限 %d 才有意义", got, maxCompositionIndicators)
	}
	if err := ValidateAgentComposition(doc); err != nil {
		t.Fatalf("合法大提示词编排被发布闸门误拒(%d 字节): %v", len(doc), err)
	}

	// 引号标量里的同类内容同样不能被算成结构。
	quoted := "- id: persona\n  name: '@d/p'\n  config:\n    description: \"" +
		strings.Repeat("- item [x](y) ", 3000) + "\"\n"
	if err := ValidateAgentComposition(quoted); err != nil {
		t.Fatalf("引号标量里的大提示词被误拒(%d 字节): %v", len(quoted), err)
	}
}

// TestCompositionGateRejectsMultipleDocuments:F2-N8 —— 上游 loader 是
// js-yaml 的 load(单文档),多文档 `---` 会让员工端挂载失败;闸门此前用
// goccy 的 Unmarshal 只解第一份,静默放行。
func TestCompositionGateRejectsMultipleDocuments(t *testing.T) {
	doc := "- id: a\n  name: x\n---\n- id: b\n  name: y\n"
	err := ValidateAgentComposition(doc)
	if err == nil {
		t.Fatal("多文档编排被闸门放行(上游 loader 会拒绝)")
	}
	if !strings.Contains(err.Error(), "多个 YAML 文档") {
		t.Fatalf("err = %v, want a multi-document refusal", err)
	}
	// 控制组:单个前导 `---` 与 %YAML 指令是合法的单文档,不能被误伤。
	for _, ok := range []string{
		"---\n- id: a\n  name: x\n",
		"%YAML 1.2\n---\n- id: a\n  name: x\n",
	} {
		if err := ValidateAgentComposition(ok); err != nil {
			t.Fatalf("单文档合法编排被误拒 %q: %v", ok, err)
		}
	}
}

// TestCompositionGateAcceptsLeadingBOM:上游 js-yaml 接受 BOM,作者也不会
// 主动写 BOM —— 闸门不能因为一个不可见字节把合法编排判死(F2-N8 方言对齐)。
func TestCompositionGateAcceptsLeadingBOM(t *testing.T) {
	if err := ValidateAgentComposition("\ufeff- id: a\n  name: x\n"); err != nil {
		t.Fatalf("带 BOM 的合法编排被误拒: %v", err)
	}
}

// TestCompositionGateStillRejectsStructuralBombs:控制组 —— 只按结构统计
// 之后,纯结构炸弹(一行 10 万个 `[`、6000 个插件行)仍必须在解析前被挡,
// 否则 goccy 解析器会因深嵌套耗尽内存。
func TestCompositionGateStillRejectsStructuralBombs(t *testing.T) {
	cases := map[string]string{
		"one-line-brackets": strings.Repeat("[", 100000),
		"block-sequences":   strings.Repeat("- name: p\n", 6000),
		"tag-flood":         "- name: a\n  config: [" + strings.Repeat("!t v, ", 10000) + "]\n",
	}
	for name, doc := range cases {
		t0 := time.Now()
		err := ValidateAgentComposition(doc)
		el := time.Since(t0)
		t.Logf("%-18s %7d bytes -> %v (耗时 %v)", name, len(doc), err, el.Round(time.Millisecond))
		if err == nil {
			t.Errorf("%s 未被结构预算拦住", name)
		}
		if el > 2*time.Second {
			t.Errorf("%s 耗时 %v,结构预算应当在解析前拒绝", name, el)
		}
	}
}

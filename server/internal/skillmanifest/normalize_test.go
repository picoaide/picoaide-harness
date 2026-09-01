package skillmanifest

import (
	"strings"
	"testing"
)

// 真实存量形态:中文 name + 无 title + 有 version/author/category。
const realWorldMD = "---\n" +
	"name: 团队知识库助手\n" +
	"category: 通用\n" +
	"version: 1.0.0\n" +
	"description: \"员工日常咨询知识库的索引与强制读取规则,覆盖人事行政与报销。\"\n" +
	"tags: [example-org, HR]\n" +
	"author: zhangsan\n" +
	"---\n\n# 员工日常咨询知识库\n\n本技能用于服务端单元测试:正文需要足够长才能通过空壳校验,因此这里补充了两句完整的说明文字,描述该技能的用途、触发时机与使用方式,确保长度稳稳超过五十字的下限要求。\n"

func TestNormalizeMovesChineseNameToTitle(t *testing.T) {
	out, changes, err := NormalizeSkillMD(realWorldMD, NormalizeOptions{AppID: "team-knowledge-wiki"})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	// 规范化后必须能通过严格校验——这是本函数存在的全部意义。
	m, perr := Parse([]string{"SKILL.md"}, out, "team-knowledge-wiki")
	if perr != nil {
		t.Fatalf("规范化产物仍不合规: %v\n%s", perr, out)
	}
	if m.AppID != "team-knowledge-wiki" {
		t.Fatalf("name = %q", m.AppID)
	}
	if m.Title != "团队知识库助手" {
		t.Fatalf("中文展示名必须保留到 title, got %q", m.Title)
	}
	if m.Author != "zhangsan" || m.Category != "通用" {
		t.Fatalf("原字段丢失: %+v", m)
	}
	if len(m.Tags) != 2 {
		t.Fatalf("tags 丢失: %v", m.Tags)
	}
	if !strings.Contains(strings.Join(changes, ";"), "迁移到 title") {
		t.Fatalf("changes = %v", changes)
	}
	if !strings.Contains(out, "本技能用于服务端单元测试") {
		t.Fatal("正文必须原样保留")
	}
}

func TestNormalizeStripsBOMAndFillsFallbacks(t *testing.T) {
	md := "\ufeff---\nname: demo\ndescription: 这是一段足够长的技能描述用于测试。\n---\n\n" +
		"本技能用于服务端单元测试:正文需要足够长才能通过空壳校验,因此这里补充了两句完整的说明文字,描述该技能的用途、触发时机与使用方式,确保长度稳稳超过五十字的下限要求。\n"
	out, changes, err := NormalizeSkillMD(md, NormalizeOptions{
		AppID: "demo", Version: "2.1.0", Author: "lisi", Category: "研发",
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if strings.HasPrefix(out, "\ufeff") {
		t.Fatal("BOM 未剥离")
	}
	m, perr := Parse([]string{"SKILL.md"}, out, "demo")
	if perr != nil {
		t.Fatalf("规范化产物仍不合规: %v", perr)
	}
	if m.Version != "2.1.0" || m.Author != "lisi" || m.Category != "研发" {
		t.Fatalf("兜底值未生效: %+v", m)
	}
	joined := strings.Join(changes, ";")
	for _, want := range []string{"BOM", "version 补为", "author 补为", "category 补为"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("changes 缺 %q: %v", want, changes)
		}
	}
}

func TestNormalizeRefusesToInventDescription(t *testing.T) {
	md := "---\nname: demo\nversion: 1.0.0\n---\n\n正文足够长的内容用于测试夹具说明文字补充。\n"
	if _, _, err := NormalizeSkillMD(md, NormalizeOptions{AppID: "demo", Author: "a", Category: "b"}); err == nil {
		t.Fatal("缺 description 必须报错(不得编造语义内容)")
	}
}

func TestNormalizeDropsSelfDeclaredProvenance(t *testing.T) {
	md := "---\nname: demo\nversion: 1.0.0\nauthor: a\ncategory: b\n" +
		"description: 这是一段足够长的技能描述用于测试。\nmetadata:\n  picoaide:\n    app_id: forged\n---\n\n" +
		"本技能用于服务端单元测试:正文需要足够长才能通过空壳校验,因此这里补充了两句完整的说明文字,描述该技能的用途、触发时机与使用方式,确保长度稳稳超过五十字的下限要求。\n"
	out, changes, err := NormalizeSkillMD(md, NormalizeOptions{AppID: "demo"})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if _, perr := Parse([]string{"SKILL.md"}, out, "demo"); perr != nil {
		t.Fatalf("剥离溯源后应合规: %v\n%s", perr, out)
	}
	if !strings.Contains(strings.Join(changes, ";"), "溯源") {
		t.Fatalf("changes = %v", changes)
	}
}

func TestBumpPatch(t *testing.T) {
	cases := map[string]string{"1.0.0": "1.0.1", "2.5.9": "2.5.10", "1.116.0": "1.116.1", "0.1.0": "0.1.1"}
	for in, want := range cases {
		if got := BumpPatch(in); got != want {
			t.Fatalf("BumpPatch(%s) = %s, want %s", in, got, want)
		}
	}
}

package skillmanifest

import (
	"errors"
	"strings"
	"testing"
)

// 复核 R-1(2026-09-13 独立复核确认仍存在):NormalizeSkillMD 是**唯一零闸
// YAML 入口**。
//
// 缺陷形态:manifest.go 的大小/复杂度/深度闸门只在 parseManifestYAML 上,而
// normalize.go:58 直接 `yaml.Unmarshal(front)`,注释却把 parseManifestYAML
// 写成"frontmatter 进入 YAML 解析器的唯一入口"。管理端规范化路径
// (POST /api/server/admin/skills/:name/normalize)先用 archiveutil.ReadAll
// 取出**完整** SKILL.md(单条上限 64 MB,无 128 KB 预览闸),再交给
// NormalizeSkillMD —— 一份深嵌套 frontmatter 即可让 goccy/go-yaml 解析期
// 内存二次方增长(`fatal error: out of memory` 不可 recover,实测 12 KB 深度
// 就足以打死进程)。当前靠"炸弹包在入库解析时已先被杀"兜住,属纵深防御缺口 /
// 不变量被破坏:任何新增入库路径或历史异常行都会立刻把它变成 P0。
//
// 修法要求:复用 parseManifestYAML(同一套闸门),不得复制第二份实现。
//
// 用例断言的是**行为差异**:基线这两份输入都能成功规范化(返回内容),修复后
// 必须带错误码被拒。
func TestNormalizeSkillMDRejectsDeepFrontmatter(t *testing.T) {
	opts := NormalizeOptions{AppID: "my-skill", Version: "1.0.0", Author: "tester", Category: "通用"}
	head := "---\nname: my-skill\nversion: 1.0.0\ndescription: 这是一个足够长的技能描述用于通过规范化校验\nauthor: tester\ncategory: 通用\n"

	// 1) 深度炸弹:1000 层平衡流式集合(合法 YAML → 基线解析成功并规范化,
	//    修复后必须先被深度闸拒绝;深度 1000 的解析实测 ~1.4 ms / 13 MB,
	//    不是靠"它自己会失败"来通过)。
	deep := head + "deep: " + strings.Repeat("[", 1000) + strings.Repeat("]", 1000) + "\n---\n\n正文\n"
	out, _, err := NormalizeSkillMD(deep, opts)
	if err == nil {
		t.Fatalf("深嵌套(1000 层)frontmatter 被 normalize 接受并输出 %d 字节 —— 这正是零闸入口(基线行为)", len(out))
	}
	var serr *Error
	if !errors.As(err, &serr) || serr.Code != CodeFrontmatterInvalid ||
		!strings.Contains(serr.Message, "嵌套过深") {
		t.Fatalf("深嵌套 frontmatter 的错误 = %v, want %s + 嵌套过深(走 parseManifestYAML 闸门)", err, CodeFrontmatterInvalid)
	}

	// 2) 体积闸:frontmatter 自身超过 MaxSkillMDBytes(128 KB)必须先被 O(1)
	//    长度闸拒绝,而不是交给解析器。
	big := "---\nname: my-skill\nversion: 1.0.0\ndescription: 这是一个足够长的技能描述用于通过规范化校验\nauthor: tester\ncategory: 通用\nfiller: \"" +
		strings.Repeat("a", MaxSkillMDBytes+1) + "\"\n---\n\n正文\n"
	out, _, err = NormalizeSkillMD(big, opts)
	if err == nil {
		t.Fatalf("超大(%d 字节)frontmatter 被 normalize 接受并输出 %d 字节", len(big), len(out))
	}
	if !errors.As(err, &serr) || serr.Code != CodeInputTooLarge {
		t.Fatalf("超大 frontmatter 的错误 = %v, want %s", err, CodeInputTooLarge)
	}

	// 3) 防误伤:正常扁平 frontmatter 必须照常规范化(闸门只拦异常形态)。
	ok := head + "tags: [a, b, c]\n---\n\n正文\n"
	out, changes, err := NormalizeSkillMD(ok, opts)
	if err != nil {
		t.Fatalf("正常 frontmatter 被误拒: %v", err)
	}
	if !strings.Contains(out, "name: my-skill") || len(changes) == 0 {
		t.Fatalf("正常 frontmatter 规范化结果异常: out=%q changes=%v", out, changes)
	}
}

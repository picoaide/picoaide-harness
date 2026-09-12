package skillmanifest

import (
	"strings"
	"testing"
)

// FIX-16(审计 2026-09-12,P1-8):skillmanifest 对 name 的归一化比运行时宽松。
//
// 缺陷形态:requiredString 先 `scalarString`(数字/布尔 fmt.Sprint 成文本)再
// `TrimSpace`,于是下面三种写法**全部 ACCEPTED**(审计实测 IsAppID 均为 true),
// 而上游运行时会把它们**整个丢掉**:
//
//	name: " my-skill "   → isSkillName 作用在未 trim 的原值上 ⇒ 不匹配
//	name: 123            → stringField 非 string ⇒ undefined
//	name: true           → 同上
//
// 上游契约(逐行核实):
//   - skill-filesystem/src/index.ts:982-985
//     `stringField = typeof v === 'string' && v.length > 0 ? v : undefined`
//     —— 不 trim、非字符串一律 undefined;
//   - :810-818 `name === undefined || description === undefined` →
//     logger.warn + `return undefined`(整份技能被忽略);
//   - skill/src/index.ts:21/35 `SKILL_NAME` 正则 + `isSkillName(name)` 作用于
//     **未 trim** 的 name。
//
// 失效模式:上传 201 成功、审核通过、下发到客户端,运行时只打一行 warn 然后
// 忽略 —— 用户拿到"上传成功但技能不存在"。

// TestParseRejectsNonStringRuntimeFields 锁 strictType:name/description 只
// 接受真字符串。
func TestParseRejectsNonStringRuntimeFields(t *testing.T) {
	for _, raw := range []string{"123", "1.5", "true", "false", "0"} {
		// name 非字符串 → INVALID_TYPE
		md := goodMD(map[string]string{"name": raw}, "name")
		md = strings.Replace(md, "---\n", "---\nname: "+raw+"\n", 1)
		if _, err := Parse(entries(), md, ""); err == nil {
			t.Errorf("name: %s 必须被拒(上游 stringField 会判 undefined → 整份技能被忽略)", raw)
		} else {
			assertCode(t, err, CodeInvalidType, "name")
		}
		// description 非字符串 → INVALID_TYPE
		md2 := goodMD(map[string]string{"description": raw}, "description")
		md2 = strings.Replace(md2, "---\n", "---\ndescription: "+raw+"\n", 1)
		if _, err := Parse(entries(), md2, ""); err == nil {
			t.Errorf("description: %s 必须被拒", raw)
		} else {
			assertCode(t, err, CodeInvalidType, "description")
		}
	}
	// 加引号的数字是**合法**字符串 —— 修复不能把"数字样子的字符串"也拒掉
	// (加引号后上游 stringField 拿到的是 string)。
	quoted := goodMD(nil)
	quoted = strings.Replace(quoted, "description: ",
		"description: \"1234567890 这是一段足够长的描述文本。\" # ", 1)
	if _, err := Parse(entries(), quoted, ""); err != nil {
		t.Fatalf("加引号的数字描述应当合法: %v", err)
	}
}

// TestParseRejectsWhitespacePaddedName 锁 exactTrim:name 的首尾空白即非法。
//
// 这是最隐蔽的一种:trim 后是好名字,所以"看起来没问题";但上游用**未 trim**
// 的原值跑正则,结果整个技能消失。
func TestParseRejectsWhitespacePaddedName(t *testing.T) {
	for _, raw := range []string{
		`" my-skill "`, // 两侧空格
		`"my-skill "`,  // 尾随
		`" my-skill"`,  // 前导
		"\"my-skill\t\"",
		"\"my-skill\n\"", // YAML 双引号内的转义换行
	} {
		var b strings.Builder
		b.WriteString("---\n")
		b.WriteString("name: " + raw + "\n")
		for _, k := range []string{"title", "version", "description", "author", "category"} {
			b.WriteString(k + ": ")
			switch k {
			case "version":
				b.WriteString("1.0.0")
			case "title":
				b.WriteString("标题")
			case "description":
				b.WriteString("这是一段足够长的描述文本用于通过长度校验。")
			default:
				b.WriteString("x")
			}
			b.WriteString("\n")
		}
		b.WriteString("---\n\n")
		b.WriteString(goodBody)

		if _, err := Parse(entries(), b.String(), ""); err == nil {
			t.Errorf("name: %s 必须被拒(上游 isSkillName 用未 trim 的原值)", raw)
		} else {
			assertCode(t, err, CodeInvalidType, "name")
		}
	}
	// 对照:不带空白的同名技能必须通过。
	if _, err := Parse(entries(), goodMD(nil), ""); err != nil {
		t.Fatalf("正常 name 被误伤: %v", err)
	}
}

// TestParseDescriptionTrimStillAllowed 是防误伤:description 的**内容**上游
// 不校验(只判 length > 0),所以首尾空白只影响观感,不该拒绝上传。
func TestParseDescriptionTrimStillAllowed(t *testing.T) {
	md := goodMD(map[string]string{
		"description": `"  这是一段前后带空格的、足够长的描述文本。  "`,
	})
	if _, err := Parse(entries(), md, ""); err != nil {
		t.Fatalf("description 首尾空白不该被拒(上游只判 length>0): %v", err)
	}
}

// TestParseNonRuntimeFieldsStayLenient 是防误伤 + 记录边界:只有 name /
// description 会被上游 stringField 读取;title/author/category/changelog 是
// 本产品自有元数据(上游 skill-filesystem 只再读一个可选的 whenToUse),
// 保持宽松转换,不制造无谓的迁移负担。
func TestParseNonRuntimeFieldsStayLenient(t *testing.T) {
	md := goodMD(map[string]string{
		"title":     "123",
		"author":    "456",
		"category":  "789",
		"changelog": "1000",
	})
	m, err := Parse(entries(), md, "")
	if err != nil {
		t.Fatalf("本产品自有元数据的数字标量不该被拒(与上游无关): %v", err)
	}
	if m.Title != "123" || m.Author != "456" || m.Category != "789" || m.Changelog != "1000" {
		t.Fatalf("宽松转换结果 = %q/%q/%q/%q", m.Title, m.Author, m.Category, m.Changelog)
	}
}

// TestParseNameStrictnessMatchesRuntimeRegex 是**契约对拍**:凡是本包接受的
// name,上游 isSkillName 的正则(作用于原值)也必须接受。
//
// 上游正则 = ^[a-z0-9]+(?:-[a-z0-9]+)*$;本包 appIDRe 与它逐字一致,所以
// "本包接受 ⇒ trim 恒等且匹配 appIDRe" 等价于 "上游也会接受"。
func TestParseNameStrictnessMatchesRuntimeRegex(t *testing.T) {
	cases := []struct {
		name   string
		accept bool
	}{
		{"my-skill", true},
		{"a", false}, // MinAppIDLen = 2
		{"ab", true},
		{"my--skill", false}, // 连续横线
		{"-my-skill", false}, // 首横线
		{"my-skill-", false}, // 尾横线
		{"My-Skill", false},  // 大写
		{"my_skill", false},  // 下划线
		{" my-skill", false}, // 前导空格(未 trim)
		{"my-skill ", false}, // 尾随空格(未 trim)
		{"my.skill", false},  // 点
	}
	for _, tc := range cases {
		md := goodMD(map[string]string{"name": `"` + tc.name + `"`}, "name")
		md = strings.Replace(md, "---\n", "---\nname: \""+tc.name+"\"\n", 1)
		_, err := Parse(entries(), md, "")
		if tc.accept && err != nil {
			t.Errorf("name=%q 应当被接受, got %v", tc.name, err)
		}
		if !tc.accept && err == nil {
			t.Errorf("name=%q 应当被拒绝(上游 isSkillName 也会拒)", tc.name)
		}
	}
}

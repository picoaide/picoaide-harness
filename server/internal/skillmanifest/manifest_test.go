package skillmanifest

import (
	"errors"
	"strings"
	"testing"
)

// goodBody 是合规正文;单独抽出常量,便于「空壳」用例精确替换掉它。
const goodBody = "# 员工日常咨询知识库\n\n本技能提供员工日常咨询知识库的索引与强制读取规则,覆盖人事、行政、商业保险与财务报销等高频问题的查询路径。\n"

// goodMD builds a compliant SKILL.md; 每个用例只改动它的一处,
// 保证失败信息精确指向被测规则。
func goodMD(overrides map[string]string, omit ...string) string {
	fields := map[string]string{
		"name":        "team-knowledge-wiki",
		"title":       "团队知识库助手",
		"version":     "1.2.0",
		"description": "员工手册、SSC 人事服务与报销制度的知识库索引与读取规则。",
		"author":      "zhangsan",
		"category":    "通用",
	}
	for k, v := range overrides {
		fields[k] = v
	}
	for _, k := range omit {
		delete(fields, k)
	}
	// 固定顺序,输出稳定可读。
	order := []string{"name", "title", "version", "description", "author", "category"}
	var b strings.Builder
	b.WriteString("---\n")
	for _, k := range order {
		if v, ok := fields[k]; ok {
			b.WriteString(k + ": " + v + "\n")
		}
	}
	for k, v := range fields {
		if k == "name" || k == "title" || k == "version" || k == "description" || k == "author" || k == "category" {
			continue
		}
		b.WriteString(k + ": " + v + "\n")
	}
	b.WriteString("---\n\n")
	b.WriteString(goodBody)
	return b.String()
}

func entries() []string { return []string{"SKILL.md", "references/wiki-index.md"} }

// assertCode 断言 Parse 返回指定错误码(并在失败时打印真实码与消息)。
func assertCode(t *testing.T, err error, wantCode, wantField string) {
	t.Helper()
	if err == nil {
		t.Fatalf("want %s, got nil error", wantCode)
	}
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("want *Error, got %T (%v)", err, err)
	}
	if e.Code != wantCode {
		t.Fatalf("code = %s (field=%s, msg=%s), want %s", e.Code, e.Field, e.Message, wantCode)
	}
	if wantField != "" && e.Field != wantField {
		t.Fatalf("field = %s, want %s", e.Field, wantField)
	}
	if strings.TrimSpace(e.Message) == "" {
		t.Fatal("error message must not be empty (客户端原样展示)")
	}
}

func TestParseValidManifest(t *testing.T) {
	m, err := Parse(entries(), goodMD(nil), "team-knowledge-wiki")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.AppID != "team-knowledge-wiki" || m.Title != "团队知识库助手" || m.Version != "1.2.0" {
		t.Fatalf("manifest = %+v", m)
	}
	if m.Author != "zhangsan" || m.Category != "通用" {
		t.Fatalf("manifest = %+v", m)
	}
}

func TestParseAcceptsOptionalFieldsAndCRLF(t *testing.T) {
	md := goodMD(map[string]string{
		"tags":      "[HR, 报销, 员工手册]",
		"changelog": "补充生育报销与居转户章节。",
	})
	m, err := Parse(entries(), strings.ReplaceAll(md, "\n", "\r\n"), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(m.Tags) != 3 || m.Tags[0] != "HR" {
		t.Fatalf("tags = %v", m.Tags)
	}
	if m.Changelog == "" {
		t.Fatal("changelog must be parsed")
	}
}

// 必填字段矩阵(决策文档 §十 验收 5):逐个缺失都必须报 MISSING_FIELD 并指明字段。
func TestParseRequiredFieldMatrix(t *testing.T) {
	for _, field := range []string{"name", "title", "version", "description", "author", "category"} {
		t.Run(field, func(t *testing.T) {
			_, err := Parse(entries(), goodMD(nil, field), "")
			assertCode(t, err, CodeMissingField, field)
		})
	}
}

func TestParseRejectsEmptyRequiredField(t *testing.T) {
	_, err := Parse(entries(), goodMD(map[string]string{"author": `""`}), "")
	assertCode(t, err, CodeMissingField, "author")
}

// 命名文法(验收 6):五种非法命名,上游运行时全部拒绝加载,发布期必须先拦下。
func TestParseRejectsNonKebabNames(t *testing.T) {
	for _, name := range []string{"My-Skill", "my.skill", "my_skill", "my--skill", "my-skill-", "团队知识库助手"} {
		t.Run(name, func(t *testing.T) {
			_, err := Parse(entries(), goodMD(map[string]string{"name": name}), "")
			assertCode(t, err, CodeInvalidAppID, "name")
		})
	}
}

func TestParseAcceptsValidKebabNames(t *testing.T) {
	for _, name := range []string{"dws", "excel-sheet-summary", "team-knowledge-wiki", "a1", "x2y3-z4"} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(entries(), goodMD(map[string]string{"name": name}), ""); err != nil {
				t.Fatalf("%s should be valid: %v", name, err)
			}
		})
	}
}

// 版本文法(验收 6):旧正则 ^[0-9a-zA-Z.-]{1,64}$ 会放行前三个。
func TestParseRejectsNonSemverVersions(t *testing.T) {
	for _, v := range []string{"v1", "abc", "1.0", "1", "1.2.3.4", "1.2.x"} {
		t.Run(v, func(t *testing.T) {
			_, err := Parse(entries(), goodMD(map[string]string{"version": `"` + v + `"`}), "")
			assertCode(t, err, CodeInvalidVersion, "version")
		})
	}
}

func TestParseAcceptsSemverWithPrerelease(t *testing.T) {
	m, err := Parse(entries(), goodMD(map[string]string{"version": "2.0.0-rc.1"}), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.Version != "2.0.0-rc.1" {
		t.Fatalf("version = %s", m.Version)
	}
}

// `version: 1.0` 会被 YAML 解析成浮点数,必须落到精确的版本号报错上。
func TestParseUnquotedFloatVersion(t *testing.T) {
	_, err := Parse(entries(), goodMD(map[string]string{"version": "1.0"}), "")
	assertCode(t, err, CodeInvalidVersion, "version")
}

func TestParseDescriptionBounds(t *testing.T) {
	_, err := Parse(entries(), goodMD(map[string]string{"description": "太短"}), "")
	assertCode(t, err, CodeFieldTooShort, "description")

	long := strings.Repeat("长", MaxDescriptionRunes+1)
	_, err = Parse(entries(), goodMD(map[string]string{"description": long}), "")
	assertCode(t, err, CodeFieldTooLong, "description")
}

func TestParseTitleTooLong(t *testing.T) {
	_, err := Parse(entries(), goodMD(map[string]string{"title": strings.Repeat("题", MaxTitleRunes+1)}), "")
	assertCode(t, err, CodeFieldTooLong, "title")
}

// category 写成数组是 内部技能中心 规范里点名的高频错误。
func TestParseRejectsListCategory(t *testing.T) {
	_, err := Parse(entries(), goodMD(map[string]string{"category": "[通用, 人事]"}), "")
	assertCode(t, err, CodeInvalidType, "category")
}

func TestParseTagRules(t *testing.T) {
	_, err := Parse(entries(), goodMD(map[string]string{"tags": "HR"}), "")
	assertCode(t, err, CodeInvalidType, "tags")

	many := "[" + strings.TrimSuffix(strings.Repeat("t, ", MaxTags+1), ", ") + "]"
	_, err = Parse(entries(), goodMD(map[string]string{"tags": many}), "")
	assertCode(t, err, CodeFieldTooLong, "tags")

	_, err = Parse(entries(), goodMD(map[string]string{"tags": "[" + strings.Repeat("标", MaxTagRunes+1) + "]"}), "")
	assertCode(t, err, CodeFieldTooLong, "tags")
}

func TestParseRejectsBOM(t *testing.T) {
	_, err := Parse(entries(), "\ufeff"+goodMD(nil), "")
	assertCode(t, err, CodeBOMDetected, "")
}

func TestParseFrontmatterProblems(t *testing.T) {
	cases := map[string]string{
		"无 frontmatter": "# 只有正文\n\n" + strings.Repeat("内容", 40),
		"未闭合":           "---\nname: demo\n\n# 正文" + strings.Repeat("内容", 40),
		"空文件":           "   ",
		"非映射":           "---\n- a\n- b\n---\n\n" + strings.Repeat("正文", 40),
		"非法 YAML":       "---\nname: [unclosed\n---\n\n" + strings.Repeat("正文", 40),
	}
	for label, md := range cases {
		t.Run(label, func(t *testing.T) {
			assertCode(t, mustErr(Parse(entries(), md, "")), CodeFrontmatterInvalid, "")
		})
	}
}

func TestParseRejectsEmptyBody(t *testing.T) {
	md := strings.Replace(goodMD(nil), goodBody, "简介\n", 1)
	_, err := Parse(entries(), md, "")
	assertCode(t, err, CodeBodyEmpty, "")
}

// 边界:恰好 MinBodyRunes 个字符的正文必须通过,少一个必须被拒——
// 阈值写死在代码里,漂移会静默改变发布门槛。
func TestParseBodyLengthBoundary(t *testing.T) {
	exact := strings.Repeat("字", MinBodyRunes)
	if _, err := Parse(entries(), strings.Replace(goodMD(nil), goodBody, exact, 1), ""); err != nil {
		t.Fatalf("正文恰好 %d 字应通过: %v", MinBodyRunes, err)
	}
	short := strings.Repeat("字", MinBodyRunes-1)
	_, err := Parse(entries(), strings.Replace(goodMD(nil), goodBody, short, 1), "")
	assertCode(t, err, CodeBodyEmpty, "")
}

// 上游 parseInvocationPolicy 对这些写法直接抛错 → 整个技能被忽略。
func TestParseInvocationRules(t *testing.T) {
	_, err := Parse(entries(), goodMD(map[string]string{"userInvocable": "true"}), "")
	assertCode(t, err, CodeInvocationInvalid, "userInvocable")

	_, err = Parse(entries(), goodMD(map[string]string{"user-invocable": "maybe"}), "")
	assertCode(t, err, CodeInvocationInvalid, "user-invocable")

	if _, err = Parse(entries(), goodMD(map[string]string{"user-invocable": "false"}), ""); err != nil {
		t.Fatalf("boolean literal should pass: %v", err)
	}
	if _, err = Parse(entries(), goodMD(map[string]string{"disable-model-invocation": "yes"}), ""); err != nil {
		t.Fatalf("yes/no literal should pass: %v", err)
	}
}

func TestParseIdentityMismatch(t *testing.T) {
	_, err := Parse(entries(), goodMD(nil), "another-app")
	assertCode(t, err, CodeIdentityMismatch, "name")
}

// 溯源块只能由安装器写入,包内自带即可伪造「来自市场某应用」。
func TestParseRejectsSelfDeclaredProvenance(t *testing.T) {
	withDir := append(entries(), ".picoaide/release.json")
	_, err := Parse(withDir, goodMD(nil), "")
	assertCode(t, err, CodeProvenanceForbidden, "")

	md := strings.Replace(goodMD(nil), "---\n\n",
		"metadata:\n  picoaide:\n    app_id: forged\n---\n\n", 1)
	_, err = Parse(entries(), md, "")
	assertCode(t, err, CodeProvenanceForbidden, "metadata.picoaide")
}

// 普通 metadata 必须照常放行(上游原样保留,技能可用它携带自定义信息)。
func TestParseAllowsOrdinaryMetadata(t *testing.T) {
	md := strings.Replace(goodMD(nil), "---\n\n",
		"metadata:\n  requires:\n    bins: [\"wecom-cli\"]\n---\n\n", 1)
	if _, err := Parse(entries(), md, ""); err != nil {
		t.Fatalf("ordinary metadata must pass: %v", err)
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int // -1 / 0 / 1
	}{
		{"1.0.0", "1.0.1", -1},
		{"1.2.0", "1.10.0", -1},
		{"2.0.0", "1.99.99", 1},
		{"1.2.3", "1.2.3", 0},
		{"1.2.0-rc.1", "1.2.0", -1},
		{"1.2.0", "1.2.0-rc.1", 1},
		{"1.2.0-rc.1", "1.2.0-rc.2", -1},
	}
	for _, c := range cases {
		got := CompareVersions(c.a, c.b)
		if (got < 0) != (c.want < 0) || (got > 0) != (c.want > 0) || (got == 0) != (c.want == 0) {
			t.Fatalf("CompareVersions(%s,%s) = %d, want sign %d", c.a, c.b, got, c.want)
		}
	}
}

func TestIsAppIDLengthBounds(t *testing.T) {
	if IsAppID("a") {
		t.Fatal("单字符应用 ID 应被拒绝")
	}
	if !IsAppID(strings.Repeat("a", MaxAppIDLen)) {
		t.Fatal("上限长度应通过")
	}
	if IsAppID(strings.Repeat("a", MaxAppIDLen+1)) {
		t.Fatal("超长应用 ID 应被拒绝")
	}
}

func mustErr(_ *Manifest, err error) error { return err }

// Package skillmanifest parses and strictly validates the SKILL.md manifest
// carried inside a skill archive.
//
// 决策 2026-09-01「包内即真相」(docs/decisions/2026-09-01-skill-app-management.md
// 第五节):发布接口不再接受元数据参数,名称/版本/标题/描述/作者/分类一律从包内
// SKILL.md frontmatter 解析,任何一项不合规即拒绝上传。
//
// 为什么必须严格:上游 @deepseek-ai/dsh-skill-filesystem 以 frontmatter 的
// `name` 作为技能的**运行时唯一身份**,且强制 kebab-case;不合规的 SKILL.md 会
// 被运行时**静默忽略**(只打一行 warn)。2026-09-01 实测线上 30 个市场技能,装到
// 磁盘后运行时只认出 3 个——上传校验比运行时宽松,就等于允许「上传成功但技能不
// 存在」。本包的每条规则都对应上游的一条硬约束。
package skillmanifest

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/goccy/go-yaml"
)

// 稳定错误码:直接进 serverauth.WriteError 的 envelope,客户端按码分流、
// 按 message 展示(报文含字段名与修复指引)。
const (
	CodeMissingField        = "MISSING_FIELD"
	CodeInvalidAppID        = "INVALID_APP_ID"
	CodeInvalidVersion      = "INVALID_VERSION"
	CodeFieldTooLong        = "FIELD_TOO_LONG"
	CodeFieldTooShort       = "FIELD_TOO_SHORT"
	CodeInvalidType         = "INVALID_TYPE"
	CodeIdentityMismatch    = "IDENTITY_MISMATCH"
	CodeBOMDetected         = "BOM_DETECTED"
	CodeFrontmatterInvalid  = "FRONTMATTER_INVALID"
	CodeBodyEmpty           = "BODY_EMPTY"
	CodeInvocationInvalid   = "INVOCATION_INVALID"
	CodeProvenanceForbidden = "PROVENANCE_FORBIDDEN"
	CodeManifestMismatch    = "MANIFEST_MISMATCH"
)

// StatusFor maps a validation code to its HTTP status. 全部包内校验失败都是
// 422(语义正确但内容不合规);冲突类(版本已存在等)由调用方按 409 处理。
func StatusFor(code string) int {
	switch code {
	case CodeMissingField, CodeInvalidAppID, CodeInvalidVersion, CodeFieldTooLong,
		CodeFieldTooShort, CodeInvalidType, CodeIdentityMismatch, CodeBOMDetected,
		CodeFrontmatterInvalid, CodeBodyEmpty, CodeInvocationInvalid,
		CodeProvenanceForbidden, CodeManifestMismatch:
		return 422
	default:
		return 422
	}
}

// 字段长度与数量上限(决策文档 5.1/5.2)。
const (
	MinAppIDLen         = 2
	MaxAppIDLen         = 64
	MaxTitleRunes       = 100
	MinDescriptionRunes = 10
	MaxDescriptionRunes = 500
	MaxAuthorRunes      = 64
	MaxCategoryRunes    = 32
	MaxChangelogRunes   = 500
	MaxTags             = 10
	MaxTagRunes         = 24
	MinBodyRunes        = 50
)

// ProvenanceKey 是安装器写入的溯源块键名;包内自带即视为伪造归属。
const ProvenanceKey = "picoaide"

// ProvenanceDir 是安装器写入的溯源目录(归档内出现即拒)。
const ProvenanceDir = ".picoaide/"

// appIDRe 与上游 @deepseek-ai/dsh-skill 的 SKILL_NAME 逐字一致。
// 上游:/^[a-z0-9]+(?:-[a-z0-9]+)*$/ —— 不允许大写、点、下划线、
// 连续横线与首尾横线。任何比它宽松的校验都会放进「装了加载不了」的包。
var appIDRe = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// versionRe 是严格 semver(可带预发布后缀)。旧实现用
// `^[0-9a-zA-Z.-]{1,64}$`,`v1`/`abc` 都能入库,导致版本无法比较大小、
// 「必须递增」根本判不了。
var versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$`)

// 上游 parseInvocationPolicy 会对这些 camelCase 旧键直接抛错 → 整个技能被
// 忽略。发布期必须拦下,并指向正确的 kebab 键名。
var legacyInvocationKeys = map[string]string{
	"disableModelInvocation": "disable-model-invocation",
	"modelInvocable":         "disable-model-invocation",
	"userInvocable":          "user-invocable",
}

// 上游 frontmatterBoolean 接受的布尔字面量(其余一律抛错 → 技能被忽略)。
var booleanLiterals = map[string]bool{
	"true": true, "yes": true, "on": true,
	"false": true, "no": true, "off": true,
	"1": true, "0": true,
}

// Manifest is the validated metadata parsed from a skill package.
// 它是发布链路的唯一元数据来源:入库的 name/title/version/description/
// author/category 全部取自这里,不接受调用方参数。
type Manifest struct {
	AppID       string
	Title       string
	Version     string
	Description string
	Author      string
	Category    string
	Changelog   string
	Tags        []string
}

// Error is a validation failure carrying a stable code, the offending field
// (when field-scoped), and a user-facing Chinese message.
type Error struct {
	Code    string
	Field   string
	Message string
}

func (e *Error) Error() string {
	if e.Field == "" {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("%s[%s]: %s", e.Code, e.Field, e.Message)
}

func newErr(code, field, format string, args ...any) *Error {
	return &Error{Code: code, Field: field, Message: fmt.Sprintf(format, args...)}
}

// IsAppID reports whether s is a valid app id (= upstream skill name grammar).
func IsAppID(s string) bool {
	if len(s) < MinAppIDLen || len(s) > MaxAppIDLen {
		return false
	}
	return appIDRe.MatchString(s)
}

// IsVersion reports whether s is a strict semver string.
func IsVersion(s string) bool { return versionRe.MatchString(s) }

// CompareVersions orders two semver strings numerically: negative when a<b,
// zero when equal, positive when a>b. 预发布版排在同号正式版之前
// (1.2.0-rc.1 < 1.2.0),供「版本必须递增」校验使用。
func CompareVersions(a, b string) int {
	aCore, aPre, _ := strings.Cut(a, "-")
	bCore, bPre, _ := strings.Cut(b, "-")
	aParts, bParts := strings.Split(aCore, "."), strings.Split(bCore, ".")
	for i := 0; i < 3; i++ {
		var av, bv int
		if i < len(aParts) {
			av, _ = strconv.Atoi(aParts[i])
		}
		if i < len(bParts) {
			bv, _ = strconv.Atoi(bParts[i])
		}
		if av != bv {
			return av - bv
		}
	}
	switch {
	case aPre == "" && bPre == "":
		return 0
	case aPre == "": // 正式版 > 预发布版
		return 1
	case bPre == "":
		return -1
	}
	return strings.Compare(aPre, bPre)
}

// Parse validates one skill package and returns its manifest.
//
// entries 是归档内的规范化条目路径(archiveutil.ListContents 的第一个返回值),
// skillMD 是顶层 SKILL.md 的原始内容(**不要预先剥 BOM**,BOM 检测依赖它),
// declaredAppID 为空表示以包内 name 为准,非空时要求与包内 name 完全一致。
//
// 校验顺序遵循决策文档 5.5(先便宜后昂贵),只返回第一条错误,便于客户端
// 预检与服务端给出同一个错误码。
func Parse(entries []string, skillMD, declaredAppID string) (*Manifest, error) {
	// 4. BOM 与 frontmatter。
	if strings.HasPrefix(skillMD, "\ufeff") {
		return nil, newErr(CodeBOMDetected, "",
			"SKILL.md 含 UTF-8 BOM,会导致技能被运行时忽略;请另存为「UTF-8 无 BOM」")
	}
	if strings.TrimSpace(skillMD) == "" {
		return nil, newErr(CodeFrontmatterInvalid, "",
			"无法读取 SKILL.md(文件为空或超出预览上限)")
	}
	front, body, err := splitFrontmatter(skillMD)
	if err != nil {
		return nil, err
	}
	var data map[string]any
	if uerr := yaml.Unmarshal([]byte(front), &data); uerr != nil || data == nil {
		return nil, newErr(CodeFrontmatterInvalid, "",
			"SKILL.md 的 frontmatter 不是合法 YAML 映射")
	}

	// 5. 必填字段与格式。
	m := &Manifest{}
	var ferr error
	if m.AppID, ferr = requiredString(data, "name", MaxAppIDLen); ferr != nil {
		return nil, ferr
	}
	if !IsAppID(m.AppID) {
		return nil, newErr(CodeInvalidAppID, "name",
			"技能名 %q 不合法:必须是小写 kebab-case(如 my-skill),不允许大写、点、下划线、连续或首尾横线", m.AppID)
	}
	if m.Version, ferr = requiredVersion(data); ferr != nil {
		return nil, ferr
	}
	if m.Title, ferr = requiredString(data, "title", MaxTitleRunes); ferr != nil {
		return nil, ferr
	}
	if m.Description, ferr = requiredString(data, "description", MaxDescriptionRunes); ferr != nil {
		return nil, ferr
	}
	if utf8.RuneCountInString(m.Description) < MinDescriptionRunes {
		return nil, newErr(CodeFieldTooShort, "description",
			"description 过短(至少 %d 字),它决定模型何时加载本技能", MinDescriptionRunes)
	}
	if m.Author, ferr = requiredString(data, "author", MaxAuthorRunes); ferr != nil {
		return nil, ferr
	}
	if m.Category, ferr = requiredString(data, "category", MaxCategoryRunes); ferr != nil {
		return nil, ferr
	}
	if m.Changelog, ferr = optionalString(data, "changelog", MaxChangelogRunes); ferr != nil {
		return nil, ferr
	}
	if m.Tags, ferr = optionalTags(data); ferr != nil {
		return nil, ferr
	}
	if utf8.RuneCountInString(strings.TrimSpace(body)) < MinBodyRunes {
		return nil, newErr(CodeBodyEmpty, "",
			"技能正文过短(至少 %d 字):只有 frontmatter 的空壳技能对模型没有价值", MinBodyRunes)
	}
	if ferr = checkInvocation(data); ferr != nil {
		return nil, ferr
	}

	// 6. 身份一致性。
	if declaredAppID != "" && declaredAppID != m.AppID {
		return nil, newErr(CodeIdentityMismatch, "name",
			"SKILL.md 的 name(%q)必须等于应用 ID(%q);中文展示名请写在 title 字段", m.AppID, declaredAppID)
	}

	// 7. 溯源禁止项(安装器专用,包内自带即可伪造归属)。
	if ferr = checkProvenance(entries, data); ferr != nil {
		return nil, ferr
	}
	return m, nil
}

// splitFrontmatter mirrors the upstream parser: frontmatter must open at the
// very first byte with `---` and close at the first following `\n---`.
// CRLF 归一后再匹配(上游同样支持 CRLF)。
func splitFrontmatter(raw string) (front, body string, err error) {
	s := strings.ReplaceAll(raw, "\r\n", "\n")
	const open = "---\n"
	if !strings.HasPrefix(s, open) {
		return "", "", newErr(CodeFrontmatterInvalid, "",
			"SKILL.md 缺少 YAML frontmatter:文件必须以 --- 开头")
	}
	rest := s[len(open):]
	idx := strings.Index(rest, "\n---")
	if idx < 0 {
		return "", "", newErr(CodeFrontmatterInvalid, "",
			"SKILL.md 的 frontmatter 没有结束分隔符 ---")
	}
	return rest[:idx], rest[idx+len("\n---"):], nil
}

// scalarString renders a YAML scalar as text. 数字/布尔标量一律转字符串,
// 这样 `version: 1.0` 这类写法会落到 INVALID_VERSION 的精确报错上,
// 而不是含糊的类型错误。
func scalarString(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		return t, true
	case int, int64, uint64, float32, float64, bool:
		return fmt.Sprint(t), true
	default:
		return "", false
	}
}

func requiredString(data map[string]any, field string, maxRunes int) (string, error) {
	raw, ok := data[field]
	if !ok || raw == nil {
		return "", newErr(CodeMissingField, field,
			"缺少必填字段 %s,请在 SKILL.md 的 frontmatter 中补充", field)
	}
	s, ok := scalarString(raw)
	if !ok {
		return "", newErr(CodeInvalidType, field,
			"字段 %s 必须是单值字符串(不能是列表或映射)", field)
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "", newErr(CodeMissingField, field,
			"必填字段 %s 不能为空", field)
	}
	if utf8.RuneCountInString(s) > maxRunes {
		return "", newErr(CodeFieldTooLong, field,
			"字段 %s 超长(上限 %d 字)", field, maxRunes)
	}
	return s, nil
}

func optionalString(data map[string]any, field string, maxRunes int) (string, error) {
	raw, ok := data[field]
	if !ok || raw == nil {
		return "", nil
	}
	s, ok := scalarString(raw)
	if !ok {
		return "", newErr(CodeInvalidType, field,
			"字段 %s 必须是单值字符串", field)
	}
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > maxRunes {
		return "", newErr(CodeFieldTooLong, field,
			"字段 %s 超长(上限 %d 字)", field, maxRunes)
	}
	return s, nil
}

func requiredVersion(data map[string]any) (string, error) {
	raw, ok := data["version"]
	if !ok || raw == nil {
		return "", newErr(CodeMissingField, "version",
			"缺少必填字段 version,请在 SKILL.md 中写明版本号(如 1.0.0)")
	}
	s, ok := scalarString(raw)
	if !ok {
		return "", newErr(CodeInvalidVersion, "version",
			"version 必须是形如 1.2.0 的版本号")
	}
	s = strings.TrimSpace(s)
	if !IsVersion(s) {
		return "", newErr(CodeInvalidVersion, "version",
			"version %q 不是合法版本号:必须是 x.y.z(可带 -rc.1 预发布后缀);若写成 1.0 请补足三段并加引号", s)
	}
	return s, nil
}

func optionalTags(data map[string]any) ([]string, error) {
	raw, ok := data["tags"]
	if !ok || raw == nil {
		return nil, nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, newErr(CodeInvalidType, "tags", "字段 tags 必须是数组")
	}
	if len(list) > MaxTags {
		return nil, newErr(CodeFieldTooLong, "tags", "标签过多(上限 %d 个)", MaxTags)
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		s, ok := scalarString(item)
		if !ok {
			return nil, newErr(CodeInvalidType, "tags", "标签必须是字符串")
		}
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if utf8.RuneCountInString(s) > MaxTagRunes {
			return nil, newErr(CodeFieldTooLong, "tags",
				"标签 %q 超长(上限 %d 字)", s, MaxTagRunes)
		}
		out = append(out, s)
	}
	return out, nil
}

// checkInvocation rejects what upstream parseInvocationPolicy would throw on:
// 旧 camelCase 键与非布尔值都会让上游忽略整个技能。
func checkInvocation(data map[string]any) error {
	for legacy, canonical := range legacyInvocationKeys {
		if _, ok := data[legacy]; ok {
			return newErr(CodeInvocationInvalid, legacy,
				"frontmatter 字段 %s 已废弃,请改用 %s(保留旧键会让技能被运行时忽略)", legacy, canonical)
		}
	}
	for _, key := range []string{"disable-model-invocation", "user-invocable"} {
		raw, ok := data[key]
		if !ok || raw == nil {
			continue
		}
		if _, isBool := raw.(bool); isBool {
			continue
		}
		s, isScalar := scalarString(raw)
		if !isScalar || !booleanLiterals[strings.ToLower(strings.TrimSpace(s))] {
			return newErr(CodeInvocationInvalid, key,
				"字段 %s 必须是布尔值(true/false)", key)
		}
	}
	return nil
}

// checkProvenance refuses packages that ship the installer-owned provenance
// markers. 溯源块决定客户端如何判定「这份技能来自市场哪个应用」,允许作者
// 自带就等于允许伪造归属。
func checkProvenance(entries []string, data map[string]any) error {
	for _, e := range entries {
		if strings.HasPrefix(e, ProvenanceDir) {
			return newErr(CodeProvenanceForbidden, "",
				"归档不得包含 %s 目录:它由安装器写入,用于标记技能来源", ProvenanceDir)
		}
	}
	meta, ok := data["metadata"].(map[string]any)
	if !ok {
		return nil
	}
	if _, exists := meta[ProvenanceKey]; exists {
		return newErr(CodeProvenanceForbidden, "metadata."+ProvenanceKey,
			"frontmatter 不得包含 metadata.%s:它由安装器写入,用于标记技能来源", ProvenanceKey)
	}
	return nil
}

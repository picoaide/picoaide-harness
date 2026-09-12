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
	CodeInputTooLarge       = "INPUT_TOO_LARGE"
)

// StatusFor maps a validation code to its HTTP status. 全部包内校验失败都是
// 422(语义正确但内容不合规);冲突类(版本已存在等)由调用方按 409 处理。
func StatusFor(code string) int {
	switch code {
	case CodeMissingField, CodeInvalidAppID, CodeInvalidVersion, CodeFieldTooLong,
		CodeFieldTooShort, CodeInvalidType, CodeIdentityMismatch, CodeBOMDetected,
		CodeFrontmatterInvalid, CodeBodyEmpty, CodeInvocationInvalid,
		CodeProvenanceForbidden, CodeManifestMismatch, CodeInputTooLarge:
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
	// description 是**模型侧的触发文本**(上游对其长度无限制):它决定模型
	// 何时加载该技能,写详尽是正确做法而非滥用。2026-09-01 实测线上 30 个
	// 技能:中位数 244 字、最长 958 字——上限一度定为 500 直接卡死 4 个合法
	// 技能,故放宽到 2000(仍有界,防滥用)。
	MaxDescriptionRunes = 2000
	MaxAuthorRunes      = 64
	MaxCategoryRunes    = 32
	MaxChangelogRunes   = 500
	// 实测线上技能最多 15 个标签(检索关键词),上限 10 会误伤。
	MaxTags      = 30
	MaxTagRunes  = 32
	MinBodyRunes = 50
)

// 解析预算(审计 2026-09-12 FIX-01,P0:YAML 深度炸弹 → 进程级 OOM)。
//
// 背景:goccy/go-yaml v1.19.2 的**解析器**对嵌套集合没有深度/节点上限,
// 内存随嵌套深度二次增长,且 `fatal error: out of memory` **不可 recover()**
// ——一次上传即可打死整个服务端进程。实测(rlimit 3 GB,128 KB 输入):
//
//	`a: ` + `[`×200000  → runtime: out of memory / fatal error(exit 2)
//	`a: ` + `[`×20000   → RSS 5 → 462 MiB
//	`a: ` + `[`×131072  → OOM;`- `×65536 → OOM;`{`×65536 → 47 MiB
//
// 上游没有 MaxDepth 选项(内部 maxDecodeDepth=10000 只在 AST **建成之后**的
// 解码阶段生效,拦不住解析期的爆炸),所以在把文本交给解析器之前必须先按字符
// 统计把它挡掉。三层闸门,从最便宜到最贵:
//
//  1. MaxSkillMDBytes            —— O(1) 长度上限,兜住一切形态的输入规模;
//  2. checkFrontmatterComplexity —— O(n) 单遍字符统计,零分配,先于解析器;
//  3. yaml.Unmarshal             —— 只有通过上面两关的文本才会进解析器。
//
// 阈值不误伤的理由:合法的技能 frontmatter 是**扁平映射**(最多
// `tags: [a, b, c]` 一层),嵌套深度 ≤ 2、流式集合 ≤ 2 个、块序列指示符
// ≤ MaxTags(30) 个、锚点/别名/标签 0 个 —— 下面留了一个数量级的余量。
const (
	// MaxSkillMDBytes 是一份 SKILL.md / preset.yml 交给解析器的字节上限。
	// 与 sharedskills/agentshare 的 maxFilePreviewBytes 同值:审核预览上限
	// 之上的文件本来就读不出来,解析入口必须给出同一个边界。
	MaxSkillMDBytes = 128 << 10

	// MaxFrontmatterDepth 是流式集合与块序列指示符的嵌套深度上限。
	MaxFrontmatterDepth = 32

	// MaxFrontmatterCollections 是 '[' / '{' / ']' / '}' 的出现次数上限。
	MaxFrontmatterCollections = 256

	// MaxFrontmatterIndicators 是块序列指示符("- " / "-\t" / "-\n")的
	// 出现次数上限。`- `×65536 与 `[`×65536 同样能打死进程,只统计 '['/'{'
	// 会漏掉这一形态。
	MaxFrontmatterIndicators = 256

	// MaxFrontmatterReferences 是锚点/别名/标签('&' / '*' / '!')的出现
	// 次数上限。单项开销远小于上面两类(实测 ~1.4 KB/个),阈值放宽到
	// description 里写满 markdown 粗体也不会触发。
	MaxFrontmatterReferences = 1024
)

// frontmatterBudget 是 scanFrontmatterComplexity 的统计结果。
//
// 三个计数器都是**原始字符计数,不做引号/注释感知**:任何有状态的扫描都可以
// 被引号或注释骗过去,而原始计数不能。计数是硬保证(直接界定解析器的工作
// 量),maxDepth 只是同一遍扫描顺带得到的、用于给出更准确报错的启发式。
type frontmatterBudget struct {
	collections int // '[' 与 '{' 的出现次数
	indicators  int // 块序列指示符的出现次数
	references  int // '&' / '*' / '!' 的出现次数
	maxDepth    int // 观测到的最大嵌套深度(只可能高估)
}

// scanFrontmatterComplexity 单遍扫描 frontmatter 统计结构预算。
//
// 深度是启发式:遇到 '[' / '{' 与块序列指示符 +1,遇到 ']' / '}' 或行尾 -1
// (块序列不跨行嵌套)。引号内的括号会一起计数——这是**故意**的:偏保守只会
// 多拒一些畸形 frontmatter,而低估会放过炸弹。真正的安全边界是三个计数器,
// 它们不依赖任何状态。
func scanFrontmatterComplexity(front string) frontmatterBudget {
	var b frontmatterBudget
	depth := 0
	bump := func() {
		depth++
		if depth > b.maxDepth {
			b.maxDepth = depth
		}
	}
	for i := 0; i < len(front); i++ {
		switch front[i] {
		case '[', '{':
			b.collections++
			bump()
		case ']', '}':
			// 闭合括号同样进 collections 计数:实测单行 `]`×51200 也能让
			// 解析器多分配 40 MiB(线性但放大 ~0.8 KB/个)。合法 frontmatter
			// 的开/闭括号一一对应且总数 ≤ 2,计数上限给的是同一个 256。
			b.collections++
			if depth > 0 {
				depth--
			}
		case '&', '*', '!':
			b.references++
		case '-':
			// 块序列指示符:后跟空格/制表符/换行(或位于文本末尾)。
			// 纯 `-`(kebab-case 里的连字符、`---`)不计数。
			if i+1 == len(front) {
				b.indicators++
				bump()
				continue
			}
			switch front[i+1] {
			case ' ', '\t', '\n':
				b.indicators++
				bump()
			}
		case '\n':
			depth = 0
		}
	}
	return b
}

// checkFrontmatterComplexity 在交给 YAML 解析器**之前**按字符统计拒绝深度
// 炸弹。返回的第一条错误就足以说明问题,不做全量诊断。
func checkFrontmatterComplexity(front, field string) error {
	b := scanFrontmatterComplexity(front)
	if b.maxDepth > MaxFrontmatterDepth {
		return newErr(CodeFrontmatterInvalid, field,
			"frontmatter 嵌套过深(深度 %d,上限 %d):技能元数据必须是扁平映射", b.maxDepth, MaxFrontmatterDepth)
	}
	if b.collections > MaxFrontmatterCollections {
		return newErr(CodeFrontmatterInvalid, field,
			"frontmatter 的流式集合过多([ { ] } 共 %d 个,上限 %d)", b.collections, MaxFrontmatterCollections)
	}
	if b.indicators > MaxFrontmatterIndicators {
		return newErr(CodeFrontmatterInvalid, field,
			"frontmatter 的列表项过多(- 共 %d 个,上限 %d)", b.indicators, MaxFrontmatterIndicators)
	}
	if b.references > MaxFrontmatterReferences {
		return newErr(CodeFrontmatterInvalid, field,
			"frontmatter 的锚点/别名/标签过多(& * ! 共 %d 个,上限 %d)", b.references, MaxFrontmatterReferences)
	}
	return nil
}

// checkManifestSize 是三层闸门里最便宜的一层(O(1))。
func checkManifestSize(raw, field, what string) error {
	if len(raw) > MaxSkillMDBytes {
		return newErr(CodeInputTooLarge, field,
			"%s 过大(%d 字节,上限 %d 字节):技能元数据应当只有几十行 frontmatter",
			what, len(raw), MaxSkillMDBytes)
	}
	return nil
}

// parseManifestYAML 是 frontmatter / preset.yml 进入 YAML 解析器的**唯一
// 入口**:先过长度上限与字符统计闸,再解析。Parse 与 ParseAgent 共用,
// 避免以后新增解析路径时忘记加闸。
func parseManifestYAML(raw, field, what string) (map[string]any, error) {
	if err := checkManifestSize(raw, field, what); err != nil {
		return nil, err
	}
	if err := checkFrontmatterComplexity(raw, field); err != nil {
		return nil, err
	}
	var data map[string]any
	if err := yaml.Unmarshal([]byte(raw), &data); err != nil || data == nil {
		return nil, newErr(CodeFrontmatterInvalid, field, "%s 不是合法的 YAML 映射", what)
	}
	return data, nil
}

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
	// 预发布段按 SemVer §11 比较(逐段、数字段按数值)。此前用
	// strings.Compare 字典序,`rc.2` > `rc.10` 会错误地让 1.2.0-rc.10
	// 无法作为递增版本发布(2026-09-01 审计 B4)。
	return comparePrerelease(aPre, bPre)
}

// comparePrerelease implements SemVer §11 prerelease precedence:
// dot-separated identifiers compared one by one; numeric identifiers compare
// numerically and rank below alphanumeric identifiers; a longer identifier
// list wins when all shared identifiers are equal.
func comparePrerelease(a, b string) int {
	ap := strings.Split(a, ".")
	bp := strings.Split(b, ".")
	n := len(ap)
	if len(bp) > n {
		n = len(bp)
	}
	for i := 0; i < n; i++ {
		if i >= len(ap) {
			return -1 // b 还有标识符 → b 更大
		}
		if i >= len(bp) {
			return 1
		}
		x, y := ap[i], bp[i]
		xNum, yNum := isNumericString(x), isNumericString(y)
		switch {
		case xNum && yNum:
			if c := compareNumericStrings(x, y); c != 0 {
				return c
			}
		case xNum && !yNum:
			return -1 // 数字标识符 < 字母数字标识符
		case !xNum && yNum:
			return 1
		default:
			if c := strings.Compare(x, y); c != 0 {
				return c
			}
		}
	}
	return 0
}

// isNumericString reports whether s consists solely of ASCII digits.
func isNumericString(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// compareNumericStrings compares two digit strings numerically without
// parsing (长度优先,避免超长数字溢出;纯数字无前导零语义时仍按数值大小)。
func compareNumericStrings(a, b string) int {
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
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
	// 4. 规模闸 + BOM + frontmatter。
	// 长度上限放在最前:P0 深度炸弹的第一层边界(O(1),不分配内存)。
	if serr := checkManifestSize(skillMD, "", "SKILL.md"); serr != nil {
		return nil, serr
	}
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
	// 字符统计闸(零分配单遍)+ YAML 解析统一走 parseManifestYAML:
	// `[`×65536 / `- `×65536 一类深度炸弹在这里被拒,不会进解析器。
	data, derr := parseManifestYAML(front, "", "SKILL.md 的 frontmatter")
	if derr != nil {
		return nil, derr
	}

	// 5. 必填字段与格式。
	m := &Manifest{}
	var ferr error
	// FIX-16:name 是**上游运行时身份**,必须按 runtimeIdentityRule 校验
	// (只收真字符串 + 首尾无空白)。宽松归一化 = 允许「上传成功但技能不存在」。
	if m.AppID, ferr = requiredStringRule(data, "name", MaxAppIDLen, runtimeIdentityRule); ferr != nil {
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
	// FIX-16:description 同样被上游 stringField 读取(非字符串 → undefined
	// → 整份技能被忽略),所以只收真字符串;它的**内容**上游不校验,trim 安全。
	if m.Description, ferr = requiredStringRule(data, "description", MaxDescriptionRunes, runtimeTextRule); ferr != nil {
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

// stringRule 描述一个字段相对**上游运行时**的严格程度(FIX-16)。
//
// 背景(审计 2026-09-12,P1-8):本包对 name 的归一化比运行时宽松,于是
// `name: " my-skill "` / `name: 123` / `name: true` 三种写法都能通过上传
// (HTTP 201),而上游运行时把它们**整个丢掉**(只打一行 warn)——
// 用户拿到的是「上传成功但技能不存在」。
//
// 上游契约(逐行核实):
//   - skill-filesystem/src/index.ts:982-985 `stringField` =
//     `typeof value === 'string' && value.length > 0 ? value : undefined`
//     —— **不做 trim、非字符串一律 undefined**;
//   - :810-818 `name === undefined || description === undefined` →
//     `logger.warn(... requires name and description)` 后
//     `return undefined`(整份技能被忽略);
//   - skill/src/index.ts:21 `SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`,
//     :35 `isSkillName` 作用在**未 trim 的原值**上 ⇒ 首尾空白即非法。
type stringRule struct {
	// strictType:只接受真 string(数字/布尔拒绝)。对应上游 stringField。
	strictType bool
	// exactTrim:归一化必须是恒等(首尾空白即非法)。对应 isSkillName 作用
	// 在未 trim 原值上。
	exactTrim bool
}

// runtimeIdentityRule 用于 name:上游拿它当**运行时唯一身份**,三处(类型、
// 首尾空白、kebab 正则)任何一处不一致都会让整个技能消失。
var runtimeIdentityRule = stringRule{strictType: true, exactTrim: true}

// runtimeTextRule 用于 description:上游同样只接受真字符串,但不校验内容
// (只判 length > 0),所以 trim 是安全的。
var runtimeTextRule = stringRule{strictType: true}

// scalarString renders a YAML scalar as text. 数字/布尔标量一律转字符串,
// 这样 `version: 1.0` 这类写法会落到 INVALID_VERSION 的精确报错上,
// 而不是含糊的类型错误。
//
// 注意:这只适用于**本产品自己的元数据字段**(version/title/author/category/
// changelog)。上游会解读的字段(name/description)必须走 stringRule.strictType
// —— 见 stringRule 的注释。
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

// scalarStringStrict 与 scalarString 相对:只接受真字符串。
func scalarStringStrict(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

// requiredStringRule 是 requiredString 的可配置版本(FIX-16)。规则由调用方
// 按「上游是否解读这个字段」选择:name/description 走运行时规则,本产品自有
// 元数据保持宽松(不制造无谓的迁移负担)。
func requiredStringRule(data map[string]any, field string, maxRunes int, rule stringRule) (string, error) {
	raw, ok := data[field]
	if !ok || raw == nil {
		return "", newErr(CodeMissingField, field,
			"缺少必填字段 %s,请在 SKILL.md 的 frontmatter 中补充", field)
	}
	var s string
	if rule.strictType {
		s, ok = scalarStringStrict(raw)
		if !ok {
			return "", newErr(CodeInvalidType, field,
				"字段 %s 必须是字符串(上游只接受真字符串:数字/布尔会让**整个技能被运行时忽略**;"+
					"若确实想写数字请加引号,如 %s: \"123\")", field, field)
		}
	} else {
		s, ok = scalarString(raw)
		if !ok {
			return "", newErr(CodeInvalidType, field,
				"字段 %s 必须是单值字符串(不能是列表或映射)", field)
		}
	}
	if rule.exactTrim && strings.TrimSpace(s) != s {
		return "", newErr(CodeInvalidType, field,
			"字段 %s 的首尾不能有空白(%q):上游用**未 trim** 的原值做运行时身份判定,"+
				"首尾空白会让整个技能被忽略", field, s)
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

func requiredString(data map[string]any, field string, maxRunes int) (string, error) {
	return requiredStringRule(data, field, maxRunes, stringRule{})
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

// PresetMetaFile 是智能体预设的展示元数据文件(上游约定,与功能文件
// agent.cordis.yml 分离)。
const PresetMetaFile = "preset.yml"

// ParseAgent validates one agent-preset package and returns its manifest.
//
// 与技能的两点关键差异(遵循上游约定,不强行套用技能语义):
//  1. 智能体的**运行时身份是目录名**,不是包内字段——没有技能那种
//     「name 非 kebab 就整个被忽略」的失效模式,因此不要求包内声明 ID;
//  2. 上游 preset.yml 的 `name` 就是**展示名**(客户端读作 displayName),
//     所以展示名取 `title`,缺省回退 `name`,不能反过来把它当 ID 校验。
//
// 但展示之外的元数据(版本/描述/作者/分类)同样必须来自包内——「包内即真相」
// 对两类能力一致,否则智能体会退回「卡片显示目录名、版本永远兜底 1.0.0」。
func ParseAgent(entries []string, presetYML, appID string) (*Manifest, error) {
	// 与 Parse 同源的三层闸门:preset.yml 走的是同一个 YAML 解析器,同样
	// 存在 `[`×65536 / `- `×65536 打死进程的形态(审计 FIX-01)。
	if serr := checkManifestSize(presetYML, PresetMetaFile, PresetMetaFile); serr != nil {
		return nil, serr
	}
	if strings.HasPrefix(presetYML, "\ufeff") {
		return nil, newErr(CodeBOMDetected, "",
			PresetMetaFile+" 含 UTF-8 BOM,请另存为「UTF-8 无 BOM」")
	}
	if strings.TrimSpace(presetYML) == "" {
		return nil, newErr(CodeMissingField, PresetMetaFile,
			"归档缺少 "+PresetMetaFile+":展示名/版本/描述/作者/分类必须写在包内")
	}
	data, derr := parseManifestYAML(presetYML, PresetMetaFile, PresetMetaFile)
	if derr != nil {
		return nil, derr
	}

	m := &Manifest{AppID: appID}
	var ferr error
	// 展示名:title 优先,回退上游约定的 name。
	if title, err := optionalString(data, "title", MaxTitleRunes); err == nil && title != "" {
		m.Title = title
	} else if err != nil {
		return nil, err
	} else if m.Title, ferr = requiredString(data, "name", MaxTitleRunes); ferr != nil {
		return nil, newErr(CodeMissingField, "name",
			"缺少展示名:请在 "+PresetMetaFile+" 中填写 name(或 title)")
	}
	if m.Version, ferr = requiredVersion(data); ferr != nil {
		return nil, ferr
	}
	if m.Description, ferr = requiredString(data, "description", MaxDescriptionRunes); ferr != nil {
		return nil, ferr
	}
	if utf8.RuneCountInString(m.Description) < MinDescriptionRunes {
		return nil, newErr(CodeFieldTooShort, "description",
			"description 过短(至少 %d 字)", MinDescriptionRunes)
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
	if ferr = checkProvenance(entries, data); ferr != nil {
		return nil, ferr
	}
	return m, nil
}

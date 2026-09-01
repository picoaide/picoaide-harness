package skillmanifest

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/goccy/go-yaml"
)

// NormalizeOptions 提供规范化时的兜底值(全部来自 DB 行,不凭空编造)。
type NormalizeOptions struct {
	// AppID 是权威应用 ID(= 技能目录名/DB name),frontmatter name 必须等于它。
	AppID string
	// Version 兜底版本号:包内缺 version 时使用(通常传 DB 行的版本)。
	Version string
	// Author 兜底作者:包内缺 author 时使用(通常传 DB 行的作者)。
	Author string
	// Category 兜底分类:包内缺 category 时使用。
	Category string
}

// 规范化时保持原样透传的常见字段顺序(其余字段按字母序追加,输出稳定)。
var normalizedFieldOrder = []string{
	"name", "title", "version", "description", "author", "category", "tags", "changelog",
}

// NormalizeSkillMD rewrites one SKILL.md so it satisfies the strict publish
// contract, and reports what was changed.
//
// 决策 2026-09-01 §八:存量包(线上 30 个市场技能全部不合规)不改历史版本,
// 而是由本函数产出规范化内容再作为**新版本**发布。规范化只做「搬运与补齐」,
// 绝不编造语义内容:
//   - 剥 UTF-8 BOM(否则上游解析不了 frontmatter);
//   - frontmatter `name` 非法或与 AppID 不符时:原值移入 `title`(若 title
//     为空),`name` 置为 AppID —— 中文展示名因此得以保留;
//   - `version`/`author`/`category` 缺失时用调用方给的 DB 兜底值;
//   - `description` 缺失或过短时**报错**:它决定模型何时加载技能,必须由人写。
func NormalizeSkillMD(raw string, opts NormalizeOptions) (string, []string, error) {
	var changes []string
	s := strings.ReplaceAll(raw, "\r\n", "\n")
	if strings.HasPrefix(s, "\ufeff") {
		s = strings.TrimPrefix(s, "\ufeff")
		changes = append(changes, "剥离 UTF-8 BOM")
	}
	if !IsAppID(opts.AppID) {
		return "", nil, newErr(CodeInvalidAppID, "name", "应用 ID %q 不是合法 kebab-case,无法规范化", opts.AppID)
	}

	data := map[string]any{}
	body := s
	if strings.HasPrefix(s, "---\n") {
		rest := s[len("---\n"):]
		if idx := strings.Index(rest, "\n---"); idx >= 0 {
			front := rest[:idx]
			body = strings.TrimPrefix(rest[idx+len("\n---"):], "\n")
			if err := yaml.Unmarshal([]byte(front), &data); err != nil || data == nil {
				return "", nil, newErr(CodeFrontmatterInvalid, "", "frontmatter 不是合法 YAML,无法自动规范化")
			}
		} else {
			return "", nil, newErr(CodeFrontmatterInvalid, "", "frontmatter 缺少结束分隔符,无法自动规范化")
		}
	} else {
		changes = append(changes, "补全缺失的 frontmatter")
	}

	// name → AppID;原值(通常是中文展示名)移入 title。
	oldName, _ := scalarString(data["name"])
	oldName = strings.TrimSpace(oldName)
	if oldName != opts.AppID {
		if title, _ := scalarString(data["title"]); strings.TrimSpace(title) == "" && oldName != "" {
			data["title"] = oldName
			changes = append(changes, fmt.Sprintf("展示名 %q 迁移到 title", oldName))
		}
		data["name"] = opts.AppID
		changes = append(changes, fmt.Sprintf("name 规范化为 %q", opts.AppID))
	}
	if title, _ := scalarString(data["title"]); strings.TrimSpace(title) == "" {
		data["title"] = opts.AppID
		changes = append(changes, "title 缺失,回退为应用 ID")
	}

	// version:包内优先,其次调用方兜底;都没有则无法规范化。
	version, _ := scalarString(data["version"])
	version = strings.TrimSpace(version)
	if !IsVersion(version) {
		fallback := strings.TrimSpace(opts.Version)
		if !IsVersion(fallback) {
			return "", nil, newErr(CodeInvalidVersion, "version",
				"包内无合法 version 且未提供兜底版本,无法规范化")
		}
		data["version"] = fallback
		changes = append(changes, "version 补为 "+fallback)
	}

	// description 必须由人撰写:缺失/过短一律报错,不编造。
	desc, _ := scalarString(data["description"])
	if len([]rune(strings.TrimSpace(desc))) < MinDescriptionRunes {
		return "", nil, newErr(CodeFieldTooShort, "description",
			"description 缺失或过短(至少 %d 字),它决定模型何时加载技能,需人工补写", MinDescriptionRunes)
	}

	if author, _ := scalarString(data["author"]); strings.TrimSpace(author) == "" {
		if strings.TrimSpace(opts.Author) == "" {
			return "", nil, newErr(CodeMissingField, "author", "包内与服务端均无作者信息,无法规范化")
		}
		data["author"] = opts.Author
		changes = append(changes, "author 补为 "+opts.Author)
	}
	if cat, _ := scalarString(data["category"]); strings.TrimSpace(cat) == "" {
		category := strings.TrimSpace(opts.Category)
		if category == "" {
			category = "通用"
		}
		data["category"] = category
		changes = append(changes, "category 补为 "+category)
	}
	// 溯源块只能由安装器写入:包内自带一律剥离(否则新版本会被自己的校验拒绝)。
	if meta, ok := data["metadata"].(map[string]any); ok {
		if _, exists := meta[ProvenanceKey]; exists {
			delete(meta, ProvenanceKey)
			changes = append(changes, "移除包内自带的溯源块")
			if len(meta) == 0 {
				delete(data, "metadata")
			}
		}
	}

	out, err := renderFrontmatter(data, body)
	if err != nil {
		return "", nil, err
	}
	return out, changes, nil
}

// renderFrontmatter re-emits the frontmatter with a stable field order,
// 保留未知字段(技能可能带 metadata/tags 等自定义信息,规范化不得丢数据)。
func renderFrontmatter(data map[string]any, body string) (string, error) {
	seen := map[string]bool{}
	var b strings.Builder
	b.WriteString("---\n")
	emit := func(key string) error {
		v, ok := data[key]
		if !ok || seen[key] {
			return nil
		}
		seen[key] = true
		chunk, err := yaml.Marshal(map[string]any{key: v})
		if err != nil {
			return newErr(CodeFrontmatterInvalid, key, "字段 %s 无法序列化", key)
		}
		b.Write(chunk)
		return nil
	}
	for _, key := range normalizedFieldOrder {
		if err := emit(key); err != nil {
			return "", err
		}
	}
	rest := make([]string, 0, len(data))
	for key := range data {
		if !seen[key] {
			rest = append(rest, key)
		}
	}
	sort.Strings(rest)
	for _, key := range rest {
		if err := emit(key); err != nil {
			return "", err
		}
	}
	b.WriteString("---\n\n")
	b.WriteString(strings.TrimLeft(body, "\n"))
	return b.String(), nil
}

// BumpPatch returns the next patch version ("1.2.0" → "1.2.1").
// 规范化产出的是**新版本**(历史版本不可变),因此需要一个确定的下一版本号。
func BumpPatch(version string) string {
	core, _, _ := strings.Cut(version, "-")
	parts := strings.Split(core, ".")
	for len(parts) < 3 {
		parts = append(parts, "0")
	}
	patch, err := strconv.Atoi(parts[2])
	if err != nil {
		patch = 0
	}
	return parts[0] + "." + parts[1] + "." + strconv.Itoa(patch+1)
}

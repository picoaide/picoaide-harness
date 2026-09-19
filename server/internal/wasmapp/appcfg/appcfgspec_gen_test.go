// 门禁测试：**字段规格单一真源**（设计基线 §4.2 应用配置文件 / §6.2 发布载荷 /
// §5.5「数值单一真源」的同一条纪律）。
//
// 这一组用例存在的理由：字段规格此前只活在**散文（SKILL / 作者文档）与服务端错误
// hints** 里，三处各写一份 ⇒ 审计实测到真实不一致（`title` 服务端首版必填、SKILL 没写；
// `data_sensitivity` 的"缺省"只写在 UI 里）。现在真源只有 `appcfgspec.go` 一张表，
// 下面五条把它钉住：
//
//	(a) TestAppcfgArtifactsAreByteIdentical —— 提交的 appcfg.json 与 SKILL 的
//	    references/app-config.md 与**生成器实时产物**逐字节一致；
//	(b) TestSpecCoversConfigStructAndKnownFields —— Config 结构体的每个 json 字段
//	    都在表里，表里的每个键都在结构体与 KnownFields 里（双向，反射）；
//	(c) TestAccessContractMatchesABIAndDesign —— access 的三取值/缺省与 §4.2、abi 包一致；
//	(d) TestSkillFieldNamesComeFromSpec —— SKILL 里的字段名全部来自生成物
//	    （旧字段名 visible/login_required 一律不得再现，手写字段表也不得再现）；
//	(e) TestFirstReleaseRequirementsMatchBehavior —— `title` 的"首版必填"在表里
//	    （审计查出的真实不一致，回归锁定），且表里每个"首版必填"字段都与
//	    Validate(true) 的实际行为一致。
//
// 变异验证记录（交付时实跑过，勿删）：
//   - 把 appcfg.json 里 access 的 default 手改成 "public" ⇒ (a)(c) 红；
//   - 把 Config 加一个 json 字段 `foo` 而不进表 ⇒ (b) 红；把表里加一个不存在的键 ⇒ (b) 红；
//   - 把 AccessValues 改成 ["public","login"] ⇒ (c) 红（并连带 abi 对拍）；
//   - 在 publishing.md 里写回 `| `access` | 是 | ... |` 字段表，或写 `login_required` ⇒ (d) 红；
//   - 把 title 的 RequiredWhen 删掉 ⇒ (e) 红。
package appcfg_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// 路径常量（**只有这一处**：产物或 SKILL 换位置时改这里）。
const (
	appcfgJSONRelPath = "internal/wasmapp/appcfg/appcfg.json"
	// skillDirRelPath 是内置技能目录（仓库根相对）。源在服务端仓库内（2026-09-19
	// 从客户端 vendored 包搬来），随镜像分发、客户端按需安装。
	skillDirRelPath       = "server/skills/app-builder"
	skillAppConfigRelPath = skillDirRelPath + "/references/app-config.md"
	// designDocRelPath 是唯一设计基线（access 三取值/缺省必须与它一致）。
	designDocRelPath = "docs/planning/2026-09-17-wasm-app-platform.md"
	regenerateHint   = "跑 `go generate ./internal/wasmapp/limits` 重新生成"
)

// generatedSkillFiles 是 skill 里的**生成物**（它们的字段覆盖由别的用例守，
// 不参与"字段名必须来自生成物"的自洽检查，否则等于自己检查自己）。
var generatedSkillFiles = map[string]bool{
	"references/app-config.md": true,
	"references/limits.md":     true,
}

// retiredFieldNames 是被本次变更**删除**的字段名：它们不得再出现在 SKILL 里
// （配置文件的读取侧仍兼容，但作者文档必须只教新 schema）。
var retiredFieldNames = []string{"visible", "login_required"}

// ===== (a) 生成物与源码逐字节一致 =====

// TestAppcfgArtifactsAreByteIdentical 用**真生成器**（cmd/picoaide-limits-gen）
// 在临时"假仓库"里重新生成一遍，再与提交的产物逐字节比对。
//
// 为什么要编出生成器跑、而不是在测试里复刻渲染逻辑：复刻出来的第二份实现本身就是
// 漂移源（生成器改了、测试没改 ⇒ 测试永远绿）。
func TestAppcfgArtifactsAreByteIdentical(t *testing.T) {
	moduleRoot := moduleRootOf(t)
	repoRoot := filepath.Dir(moduleRoot)
	genBin := buildGenerator(t, moduleRoot)

	fakeRepo := t.TempDir()
	fakeServer := filepath.Join(fakeRepo, "server")
	writeFile(t, filepath.Join(fakeServer, "go.mod"), []byte("module github.com/picoaide/picoaide\n\ngo 1.26\n"))
	if err := os.MkdirAll(filepath.Join(fakeRepo, filepath.FromSlash(skillDirRelPath), "references"), 0o755); err != nil {
		t.Fatalf("创建假 skill 目录: %v", err)
	}
	runGenerator(t, genBin, "-root", fakeServer)

	pairs := []struct{ name, committed, fresh string }{
		{"appcfg.json",
			filepath.Join(moduleRoot, filepath.FromSlash(appcfgJSONRelPath)),
			filepath.Join(fakeServer, filepath.FromSlash(appcfgJSONRelPath))},
		{"skill references/app-config.md",
			filepath.Join(repoRoot, filepath.FromSlash(skillAppConfigRelPath)),
			filepath.Join(fakeRepo, filepath.FromSlash(skillAppConfigRelPath))},
	}
	for _, p := range pairs {
		committed, err := os.ReadFile(p.committed)
		if err != nil {
			t.Errorf("%s: 读取提交的生成物失败: %v（生成物必须提交进仓库）", p.name, err)
			continue
		}
		fresh, err := os.ReadFile(p.fresh)
		if err != nil {
			t.Errorf("%s: 读取生成器产物失败: %v", p.name, err)
			continue
		}
		if !bytes.Equal(committed, fresh) {
			t.Errorf("%s: 提交的生成物与实时生成结果不一致 —— %s\n%s", p.name, regenerateHint, lineDiff(committed, fresh))
		}
	}

	// -check 是 CI 的入口，必须自己也是绿的（改动产物即非零退出由 limits 侧用例覆盖，
	// 这里再跑一次是为了让 appcfg 的漂移在**本包**就报出来）。
	out, err := exec.Command(genBin, "-check", "-root", moduleRoot).CombinedOutput()
	if err != nil {
		t.Errorf("生成器 -check 非零退出: %v\n%s\n%s", err, out, regenerateHint)
	}
}

// ===== (b) 表覆盖 Config 结构体的每个 json 字段 =====

// TestSpecCoversConfigStructAndKnownFields 双向检查：结构体 ⟷ 表 ⟷ KnownFields。
//
// **新增/改名 Config 的字段但忘了改表 ⇒ 红**（这是"字段规格单一真源"的落地）。
func TestSpecCoversConfigStructAndKnownFields(t *testing.T) {
	// ① 结构体 → 表
	typ := reflect.TypeOf(appcfg.Config{})
	if typ.NumField() < 5 {
		t.Fatalf("Config 只有 %d 个字段，远低于预期 —— 反射可能失效（假绿防线）", typ.NumField())
	}
	structKeys := make([]string, 0, typ.NumField())
	for i := 0; i < typ.NumField(); i++ {
		tag := typ.Field(i).Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			t.Errorf("Config.%s 没有 json 标签：字段名是外部契约，必须显式声明", typ.Field(i).Name)
			continue
		}
		structKeys = append(structKeys, name)
	}
	specFields := appcfg.ConfigFields()
	specKeys := appcfg.FieldNames(specFields)
	specSet := map[string]bool{}
	for _, k := range specKeys {
		specSet[k] = true
	}
	for _, k := range structKeys {
		if !specSet[k] {
			t.Errorf("Config 结构体有 json 字段 %q，但 appcfgspec.go 的 ConfigFields() 里没有 —— "+
				"新增字段必须同步进表（它是唯一真源）", k)
		}
	}
	structSet := map[string]bool{}
	for _, k := range structKeys {
		structSet[k] = true
	}
	for _, k := range specKeys {
		if !structSet[k] {
			t.Errorf("ConfigFields() 里的 %q 在 Config 结构体里不存在 —— 表与代码必须一一对应", k)
		}
	}
	// ② 表 → KnownFields（Parse 的未知字段白名单）**逐项逐序**一致：
	//    两者顺序不同会让"报错提示顺序"与文档顺序悄悄分叉。
	if !reflect.DeepEqual(specKeys, appcfg.KnownFields) {
		t.Errorf("ConfigFields() 的键 %v 与 KnownFields %v 必须逐项逐序一致", specKeys, appcfg.KnownFields)
	}
	// ③ 每个条目的形态自洽（类型枚举、必填条件取值、enum 必须有取值）。
	allowedTypes := map[string]bool{"string": true, "string[]": true, "enum": true, "object": true}
	allowedWhen := map[string]bool{"": true}
	for _, v := range appcfg.RequiredWhenValues {
		allowedWhen[v] = true
	}
	for _, f := range specFields {
		if !allowedTypes[f.Type] {
			t.Errorf("%s: type=%q 不在允许集合 {string,string[],enum,object}", f.Key, f.Type)
		}
		if f.Desc == "" {
			t.Errorf("%s: Desc 不能为空（它就是生成物里给作者看的那句话）", f.Key)
		}
		if !allowedWhen[f.RequiredWhen] {
			t.Errorf("%s: required_when=%q 不在 RequiredWhenValues %v 里（拼错会让客户端预校验静默失效）",
				f.Key, f.RequiredWhen, appcfg.RequiredWhenValues)
		}
		if f.Type == "enum" && len(f.Values) == 0 {
			t.Errorf("%s: enum 必须给出封闭取值", f.Key)
		}
		if f.Type != "enum" && len(f.Values) > 0 {
			t.Errorf("%s: 只有 enum 才该有 values", f.Key)
		}
		if f.Max < 0 {
			t.Errorf("%s: max 不能为负", f.Key)
		}
	}
}

// TestSpecCoversPublishPayload 检查发布载荷表与 api 包的 uploadPayload 结构体一致。
//
// 反射不了别的包的非导出结构体，所以这里做**源码级**检查：读 api/publish.go，
// 抠出 uploadPayload 的 json 标签，与 PublishFields() 的键集合对拍。
// 变异方式：给 uploadPayload 加一个字段（如 `assets_hint`）而不进表 ⇒ 红。
func TestSpecCoversPublishPayload(t *testing.T) {
	src := readFileString(t, filepath.Join(moduleRootOf(t), "internal", "wasmapp", "api", "publish.go"))
	body, ok := extractStructBody(src, "uploadPayload")
	if !ok {
		t.Fatal("在 api/publish.go 里找不到 uploadPayload 结构体定义（改名了？门禁要跟着改）")
	}
	tags := jsonTagsInStruct(body)
	if len(tags) < 5 {
		t.Fatalf("只从 uploadPayload 抠出 %d 个 json 字段，远低于预期（解析可能失效）: %v", len(tags), tags)
	}
	specKeys := appcfg.FieldNames(appcfg.PublishFields())
	specSet := map[string]bool{}
	for _, k := range specKeys {
		specSet[k] = true
	}
	for _, k := range tags {
		if !specSet[k] {
			t.Errorf("uploadPayload 有字段 %q，但 PublishFields() 里没有 —— 发布载荷字段必须进表", k)
		}
	}
	tagSet := map[string]bool{}
	for _, k := range tags {
		tagSet[k] = true
	}
	for _, k := range specKeys {
		if !tagSet[k] {
			t.Errorf("PublishFields() 里的 %q 在 uploadPayload 里不存在 —— 表与代码必须一一对应", k)
		}
	}
}

// ===== (c) access 契约与 §4.2 / abi 一致 =====

// TestAccessContractMatchesABIAndDesign 是本次变更的**核心断言**：
// access 只有三个取值、缺省 login，且三处（Go 常量 / abi 帧取值 / 设计基线 §4.2）互相一致。
//
// 变异方式：把 AccessDefault 改回"可见即公开"的旧语义（public），或把取值改回两个 ⇒ 红。
func TestAccessContractMatchesABIAndDesign(t *testing.T) {
	want := []string{"public", "login", "whitelist"}
	if !reflect.DeepEqual(appcfg.AccessValues, want) {
		t.Fatalf("AccessValues = %v, want %v（用户 2026-09-18 拍板的三模式）", appcfg.AccessValues, want)
	}
	if string(appcfg.AccessDefault) != "login" {
		t.Fatalf("AccessDefault = %q, want \"login\"（缺省=登录后全员）", appcfg.AccessDefault)
	}
	// 帧内取值必须与配置取值逐字一致（跨语言契约）。
	abiPairs := map[appcfg.Access]abi.AuthMode{
		appcfg.AccessPublic:    abi.AuthModePublic,
		appcfg.AccessLogin:     abi.AuthModeLogin,
		appcfg.AccessWhitelist: abi.AuthModeWhitelist,
	}
	if len(abiPairs) != len(want) {
		t.Fatalf("abi 侧只有 %d 个取值，want %d", len(abiPairs), len(want))
	}
	for access, mode := range abiPairs {
		if string(mode) != string(access) {
			t.Errorf("abi.AuthMode(%q) = %q：帧内取值必须与配置文件取值逐字一致", access, mode)
		}
	}
	// 行为：缺省必须落在 login（变异：缺省改成 public ⇒ 红）。
	c, e := appcfg.Parse([]byte("{}"))
	if e != nil {
		t.Fatalf("Parse({}) = %v", e)
	}
	if c.Access != appcfg.AccessDefault {
		t.Fatalf("Parse({}).access = %q, want 缺省 %q", c.Access, appcfg.AccessDefault)
	}
	// 产物里的三取值/缺省也必须一致（TS 侧读的是生成物，不是 Go 常量）。
	doc := loadSpecArtifact(t)
	if !reflect.DeepEqual(doc.AccessValues, want) {
		t.Errorf("appcfg.json 的 access_values = %v, want %v", doc.AccessValues, want)
	}
	if doc.AccessDefault != "login" {
		t.Errorf("appcfg.json 的 access_default = %q, want \"login\"", doc.AccessDefault)
	}
	accessField, ok := findField(doc.ConfigFields, "access")
	if !ok {
		t.Fatal("appcfg.json 的 config_fields 里没有 access")
	}
	if accessField.Default != "login" || !reflect.DeepEqual(accessField.Values, want) {
		t.Errorf("config_fields.access 的缺省/取值 = %q/%v, want login/%v",
			accessField.Default, accessField.Values, want)
	}

	// 设计基线 §4.2 的配置文件行必须写明同一套取值与缺省（就地勘误后的行）。
	design := readFileString(t, filepath.Join(repoRootOf(t), filepath.FromSlash(designDocRelPath)))
	// 定位 §4.2 的配置文件行：文档里唯一同时含"应用配置文件"与文件名的表格行。
	if !strings.Contains(design, "### 4.2 上传与包") {
		t.Fatal("设计基线里找不到 §4.2 章节（文档结构变了？门禁要跟着改）")
	}
	row := rowContaining(t, design, "应用配置文件", "picoaide.app.json")
	for _, needle := range []string{`"public"`, `"login"`, `"whitelist"`, "access", "缺省"} {
		if !strings.Contains(row, needle) {
			t.Errorf("设计基线 §4.2 的配置文件行里没有 %q —— 变更必须就地反映到文档：\n  %s", needle, clip(row))
		}
	}
	if !strings.Contains(design, "⚠️ 变更（2026-09-18，用户拍板）") {
		t.Error("设计基线里必须留下 `⚠️ 变更（2026-09-18，用户拍板）` 的勘误标记（变更来源可追溯）")
	}
}

// ===== (d) SKILL 里的字段名全部来自生成物 =====

// TestSkillFieldNamesComeFromSpec 守 SKILL 侧的字段纪律：
//  1. 生成物 app-config.md 覆盖表里的每个字段；
//  2. 已删除的字段名（visible / login_required）不得再出现在 SKILL 里；
//  3. 除生成物外，SKILL 里不得再有**手写字段表**（字段表只能引用生成物）；
//  4. markdown 表格首列的反引号标识符必须是表里的字段名（防"表格里写了个不存在的字段"）。
//
// 变异方式：在 publishing.md 里写回 `| `access` | 是 | … |` 字段表，或写 “ `login_required` “ ⇒ 红。
func TestSkillFieldNamesComeFromSpec(t *testing.T) {
	repoRoot := repoRootOf(t)
	skillDir := filepath.Join(repoRoot, filepath.FromSlash(skillDirRelPath))
	doc := loadSpecArtifact(t)
	keys := map[string]bool{}
	for _, f := range append(append([]appcfg.FieldSpec{}, doc.ConfigFields...), doc.PublishFields...) {
		keys[f.Key] = true
	}
	if len(keys) < 10 {
		t.Fatalf("生成物里只有 %d 个字段，远低于预期（产物可能被改坏）", len(keys))
	}

	// 1) 生成物必须覆盖全部字段。
	generated := readFileString(t, filepath.Join(repoRoot, filepath.FromSlash(skillAppConfigRelPath)))
	for k := range keys {
		if !strings.Contains(generated, "`"+k+"`") {
			t.Errorf("生成物 %s 里没有字段 %q —— 生成器必须为每个字段出一行", skillAppConfigRelPath, k)
		}
	}

	// 2~4) 扫散文文件。
	for _, rel := range skillTextFiles(t, skillDir) {
		text := readFileString(t, filepath.Join(skillDir, filepath.FromSlash(rel)))
		lines := strings.Split(text, "\n")
		// 2) 已删除的字段名不得再出现在散文里。唯一例外：**显式标注"兼容 shim"的那一行**
		//    ——发布文档需要讲清"旧配置平台仍读懂"，此时点出历史字段名是有信息量的；
		//    标记句是硬条件，避免这个例外慢慢变成后门。
		for _, ln := range lines {
			for _, name := range retiredFieldNames {
				for _, form := range []string{"`" + name + "`", `"` + name + `"`} {
					if strings.Contains(ln, form) && !strings.Contains(ln, "兼容 shim") {
						t.Errorf("%s: 出现已删除的字段名 %s —— 作者文档只允许教新 schema（access）\n  %s",
							rel, form, clip(ln))
					}
				}
			}
		}
		// 3)+4) 字段规格表：表头含 必填/缺省/默认 的表格视为"字段表"（帧字段表、
		//       宿主方法表等表头不含这些词，不受影响）。字段表**只允许**来自生成物。
		for _, row := range fieldSpecTableRows(lines) {
			name, ok := tableFirstCellIdent(row)
			if !ok {
				continue // 表头/分隔行/非标识符首列（如"步骤"）不算
			}
			if keys[name] || containsString(retiredFieldNames, name) {
				t.Errorf("%s: 出现手写的字段表行（字段 %q）—— 字段表只能来自生成物 app-config.md，"+
					"散文里请改为引用它\n  %s", rel, name, clip(row))
				continue
			}
			t.Errorf("%s: 字段表里出现生成物里没有的字段 %q —— 字段名必须来自 appcfgspec.go 的表\n  %s",
				rel, name, clip(row))
		}
	}

	// publishing.md 必须**指向**生成物（删掉手写表之后不能留下断链）。
	publishing := readFileString(t, filepath.Join(skillDir, "references", "publishing.md"))
	if !strings.Contains(publishing, "references/app-config.md") {
		t.Error("references/publishing.md 必须指向 references/app-config.md（字段规格的生成物）")
	}
}

// ===== (e) title 的"首版必填"必须在表里，且与行为一致 =====

// TestFirstReleaseRequirementsMatchBehavior 锁定审计查出的真实不一致：
// 服务端首版必填 `title`，而 SKILL 的手写字段表没写 ⇒ 现在必须写在表里。
//
// 同时把"表里声明"与"Validate(true) 的实际行为"对拍：任何一边漂移都红。
func TestFirstReleaseRequirementsMatchBehavior(t *testing.T) {
	// 先看**代码里的表**（真源），再看**提交的产物**（TS/SKILL 读的是它）：
	// 两边都要有这条要求，任何一边漂移都必须红。
	title, ok := findField(appcfg.PublishFields(), "title")
	if !ok {
		t.Fatal("PublishFields() 里必须有 title（它决定应用中心显示名）")
	}
	if title.RequiredWhen != appcfg.RequiredWhenFirstRelease {
		t.Fatalf("title.RequiredWhen = %q, want %q（服务端首版必填，审计查出的真实不一致）",
			title.RequiredWhen, appcfg.RequiredWhenFirstRelease)
	}
	if title.Required {
		t.Error("title 不是每次发布都必填（之后的版本可沿用上一版）⇒ Required 应为 false + RequiredWhen=first_release")
	}
	doc := loadSpecArtifact(t)
	if artTitle, ok := findField(doc.PublishFields, "title"); !ok {
		t.Error("生成物 appcfg.json 里没有 title —— 生成物必须与代码同源")
	} else if artTitle.RequiredWhen != appcfg.RequiredWhenFirstRelease {
		t.Errorf("生成物里 title.RequiredWhen = %q, want %q（重新生成）",
			artTitle.RequiredWhen, appcfg.RequiredWhenFirstRelease)
	}
	// 生成物里必须能读到这条要求（SKILL 是 AI 唯一会读的字段规格）。
	generated := readFileString(t, filepath.Join(repoRootOf(t), filepath.FromSlash(skillAppConfigRelPath)))
	if !strings.Contains(generated, "**首次发布必填**") {
		t.Error("生成物里没有把 title 的'首次发布必填'写出来 —— 这正是审计查出的不一致")
	}

	// 行为对拍：表里每个 RequiredWhen=first_release 的配置字段，Validate(true) 必须
	// 以 MISSING_FIELD 点名它；非首版（Validate(false)）不得要求它。
	full := map[string]string{
		appcfg.FieldAccess:          "public",
		appcfg.FieldPurpose:         "p",
		appcfg.FieldDataSensitivity: "internal",
		appcfg.FieldOwner:           "o",
	}
	for _, f := range doc.ConfigFields {
		if f.RequiredWhen != appcfg.RequiredWhenFirstRelease {
			continue
		}
		body := map[string]string{}
		for k, v := range full {
			body[k] = v
		}
		body[f.Key] = ""
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		c, perr := appcfg.Parse(raw)
		if perr != nil {
			t.Fatalf("Parse(%s) = %v（Parse 不做首版判定）", raw, perr)
		}
		if e := c.Validate(true); e == nil || e.Code != apperr.CodeMissingField || e.Details["field"] != f.Key {
			t.Errorf("表里声明 %s 首版必填，但 Validate(true) 给出 %v —— 表与行为必须一致", f.Key, e)
		}
		if e := c.Validate(false); e != nil {
			t.Errorf("非首版不该要求 %s，却是 %v", f.Key, e)
		}
	}
}

// ===== 通用工具 =====

// specArtifact 是 appcfg.json 的结构（只声明门禁用得到的部分；键名与生成物一致）。
type specArtifact struct {
	Schema        string             `json:"schema"`
	ABIVersion    string             `json:"abi_version"`
	ConfigFile    string             `json:"config_file"`
	AccessDefault string             `json:"access_default"`
	AccessValues  []string           `json:"access_values"`
	ConfigFields  []appcfg.FieldSpec `json:"config_fields"`
	PublishFields []appcfg.FieldSpec `json:"publish_fields"`
}

// loadSpecArtifact 读**提交的** appcfg.json（不是从 Go 常量现算：门禁要守的正是
// 提交的产物），并做基本形态检查。
func loadSpecArtifact(t *testing.T) specArtifact {
	t.Helper()
	raw := readFileString(t, filepath.Join(moduleRootOf(t), filepath.FromSlash(appcfgJSONRelPath)))
	var doc specArtifact
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("解析 %s: %v", appcfgJSONRelPath, err)
	}
	if doc.Schema != appcfg.SpecSchema {
		t.Errorf("%s 的 schema = %q, want %q", appcfgJSONRelPath, doc.Schema, appcfg.SpecSchema)
	}
	if doc.ABIVersion != abi.ABIVersion {
		t.Errorf("%s 的 abi_version = %q, want %q（与 abi 包同源）", appcfgJSONRelPath, doc.ABIVersion, abi.ABIVersion)
	}
	if doc.ConfigFile != "picoaide.app.json" {
		t.Errorf("%s 的 config_file = %q", appcfgJSONRelPath, doc.ConfigFile)
	}
	return doc
}

func findField(fields []appcfg.FieldSpec, key string) (appcfg.FieldSpec, bool) {
	for _, f := range fields {
		if f.Key == key {
			return f, true
		}
	}
	return appcfg.FieldSpec{}, false
}

// skillTextFiles 返回被扫描的 skill 散文文件（不含生成物）。
func skillTextFiles(t *testing.T, skillDir string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(skillDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(skillDir, path)
		if rerr != nil {
			return rerr
		}
		rel = filepath.ToSlash(rel)
		if generatedSkillFiles[rel] {
			return nil
		}
		switch {
		case strings.HasSuffix(rel, ".md"), strings.HasSuffix(rel, ".go"), strings.HasSuffix(rel, ".json"):
			out = append(out, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 skill 目录: %v", err)
	}
	sort.Strings(out)
	if len(out) < 4 {
		t.Fatalf("只找到 %d 个 skill 散文文件（SKILL.md + references + examples 应当都在）: %v", len(out), out)
	}
	return out
}

// fieldSpecTableRows 返回文档里所有"字段规格表"的**数据行**。
//
// 判据：markdown 表格（连续的 `|` 行）的表头行含 必填 / 缺省 / 默认 之一。
// 这样 `references/abi.md` 的请求帧表（表头 `| 字段 | 类型 | 说明 |`）与方法表不会被误判，
// 而任何一张"字段 / 必填 / 说明"式的字段表都会被抓到。
func fieldSpecTableRows(lines []string) []string {
	var out []string
	inTable, isFieldTable := false, false
	for _, ln := range lines {
		trimmed := strings.TrimSpace(ln)
		if !strings.HasPrefix(trimmed, "|") {
			inTable, isFieldTable = false, false
			continue
		}
		if !inTable {
			inTable = true
			isFieldTable = strings.Contains(trimmed, "必填") ||
				strings.Contains(trimmed, "缺省") || strings.Contains(trimmed, "默认")
			continue // 表头行本身不作为数据行
		}
		if !isFieldTable {
			continue
		}
		if strings.Contains(trimmed, "---") {
			continue // 分隔行
		}
		out = append(out, trimmed)
	}
	return out
}

// tableFirstCellIdent 抠出 markdown 表格行首列的反引号标识符（`access` | …）。
// 只认**裸标识符**（小写字母开头、无点号）：`auth.mode` / `ai.chat` 这类调用名不算字段。
func tableFirstCellIdent(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "|") {
		return "", false
	}
	cell := strings.TrimSpace(strings.TrimPrefix(trimmed, "|"))
	cell = strings.TrimSpace(strings.SplitN(cell, "|", 2)[0])
	if len(cell) < 3 || !strings.HasPrefix(cell, "`") || !strings.HasSuffix(cell, "`") {
		return "", false
	}
	name := cell[1 : len(cell)-1]
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r == '_':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return "", false
		}
	}
	return name, true
}

// rowContaining 在文档里找同时含全部关键词的行（设计文档的表格行检查用）。
func rowContaining(t *testing.T, doc string, keywords ...string) string {
	t.Helper()
	for _, ln := range strings.Split(doc, "\n") {
		ok := true
		for _, k := range keywords {
			if !strings.Contains(ln, k) {
				ok = false
				break
			}
		}
		if ok {
			return ln
		}
	}
	t.Fatalf("设计文档里找不到同时含 %v 的行", keywords)
	return ""
}

// extractStructBody 抠出 `type <name> struct { ... }` 的正文（按大括号配平）。
func extractStructBody(src, name string) (string, bool) {
	idx := strings.Index(src, "type "+name+" struct {")
	if idx < 0 {
		return "", false
	}
	rest := src[idx:]
	open := strings.Index(rest, "{")
	if open < 0 {
		return "", false
	}
	depth := 0
	for i := open; i < len(rest); i++ {
		switch rest[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return rest[open+1 : i], true
			}
		}
	}
	return "", false
}

// jsonTagsInStruct 收集结构体正文里的 `json:"name"` 标签。
func jsonTagsInStruct(body string) []string {
	var out []string
	for _, ln := range strings.Split(body, "\n") {
		i := strings.Index(ln, `json:"`)
		if i < 0 {
			continue
		}
		rest := ln[i+len(`json:"`):]
		j := strings.Index(rest, `"`)
		if j < 0 {
			continue
		}
		name := strings.Split(rest[:j], ",")[0]
		if name == "" || name == "-" {
			continue
		}
		out = append(out, name)
	}
	return out
}

func containsString(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// lineDiff 生成行级差异摘要（门禁红时人必须能一眼看懂改了哪一行）。
func lineDiff(committed, fresh []byte) string {
	a := strings.Split(string(committed), "\n")
	b := strings.Split(string(fresh), "\n")
	var sb strings.Builder
	shown := 0
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y string
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x == y {
			continue
		}
		sb.WriteString("\n    第 " + itoa(i+1) + " 行:\n      磁盘:   " + clip(x) + "\n      生成器: " + clip(y))
		shown++
		if shown >= 5 {
			sb.WriteString("\n    …（仅显示前 5 处）")
			break
		}
	}
	return sb.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func clip(s string) string {
	const max = 180
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// buildGenerator 编译生成器到临时目录（一次编译，多次执行）。
func buildGenerator(t *testing.T, moduleRoot string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "picoaide-limits-gen")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/picoaide-limits-gen")
	cmd.Dir = moduleRoot
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("编译生成器失败: %v\n%s", err, out)
	}
	return bin
}

func runGenerator(t *testing.T, bin string, args ...string) {
	t.Helper()
	if out, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
		t.Fatalf("生成器 %v 失败: %v\n%s", args, err, out)
	}
}

// moduleRootOf 返回 server/ 目录（测试的工作目录恒为包目录）。
func moduleRootOf(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("取工作目录: %v", err)
	}
	root := filepath.Clean(filepath.Join(wd, "..", "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("推断的模块根 %s 不含 go.mod: %v", root, err)
	}
	return root
}

// repoRootOf 返回仓库根（server/ 的上一级）。
func repoRootOf(t *testing.T) string {
	t.Helper()
	root := filepath.Dir(moduleRootOf(t))
	if _, err := os.Stat(filepath.Join(root, "AGENTS.md")); err != nil {
		t.Fatalf("推断的仓库根 %s 不含 AGENTS.md: %v", root, err)
	}
	return root
}

func readFileString(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 %s: %v", path, err)
	}
	return string(b)
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建目录: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("写入 %s: %v", path, err)
	}
}

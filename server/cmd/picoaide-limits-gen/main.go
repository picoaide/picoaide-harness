// Command picoaide-limits-gen 从 limits 包与 appcfg 包生成**单一真源的提交产物**
// （设计基线 §5.5「数值单一真源」：limits.go 是唯一数值来源；同一条纪律也适用于
// §4.2 的**字段规格**：appcfgspec.go 是唯一字段来源。两者都由本程序生成，
// 由同一条构建期门禁逐字节比对）。
//
// 生成物（五份，全部提交进仓库）：
//
//	server/internal/wasmapp/limits/limits.json   —— limits.Doc() 的 JSON（AI/工具消费）
//	server/internal/wasmapp/limits/limits.md     —— 给人看的 Markdown 表
//	server/internal/wasmapp/appcfg/appcfg.json   —— appcfg.Doc() 的 JSON（字段规格单一真源）
//	<packages/vendor/memory-evolve/skills/picoaide-app-builder/references/limits.md>
//	                                            —— 内置技能里的同一份上限表（逐字节相同）
//	<packages/vendor/memory-evolve/skills/picoaide-app-builder/references/app-config.md>
//	                                            —— 内置技能里的字段表（从 appcfgspec.go 生成）
//
// 用法：
//
//	cd server && go generate ./internal/wasmapp/limits     # 重新生成（directive 在 limits_gen_test.go）
//	cd server && go run ./cmd/picoaide-limits-gen          # 等价：写文件
//	cd server && go run ./cmd/picoaide-limits-gen -check   # 只比对（CI 门禁；不一致非零退出）
//
// ⚠️ 生成物里**不得出现时间戳/机器名/路径绝对化**：只要出现，每次生成都会产生 diff，
// 门禁就会"假红"（§5.5 的原意是"文档与代码不一致即红灯"，不是"每天红一次"）。
// 因此本程序只输出两张表的内容本身。
//
// ⚠️ 为什么 SKILL 里的两份 md 由本程序一并写：skill 是**客户可见交付物**，
// 它里面的每个上限数字都必须来自 limits 表、每个字段名都必须来自 appcfg 表
// （§9.3「单一真源」）。手工复制一份必然漂移；复制由生成器做、门禁逐字节比对，
// 漂移就变成编译期错误。
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// modulePath 是服务端模块的 module 行（用于确认"向上找到的是本仓的 server/"，
// 而不是某个无关的 go.mod）。
const modulePath = "github.com/picoaide/picoaide"

// 生成物相对**模块根**（server/）的路径。
const (
	jsonRelPath = "internal/wasmapp/limits/limits.json"
	mdRelPath   = "internal/wasmapp/limits/limits.md"
	// appcfgJSONRelPath 是字段规格的机器可读产物（TS 侧工具参数/表单预校验、
	// SKILL 生成、跨语言对拍的输入）。
	appcfgJSONRelPath = "internal/wasmapp/appcfg/appcfg.json"
)

// skillLimitsRelPath 是内置技能里那份 limits.md 相对**仓库根**的路径。
// 位置依据 §9.3：skill 随客户端分发（内置技能目录 = packages/vendor/memory-evolve/skills/，
// 由 dsh-memory-evolve 的 COI 同步整目录落到用户技能库）。
const skillLimitsRelPath = "packages/vendor/memory-evolve/skills/picoaide-app-builder/references/limits.md"

// skillAppConfigRelPath 是内置技能里那份字段表（从 appcfgspec.go 生成）。
// publishing.md 的手写字段表已删除并指向本文件 —— 字段规格只允许一个真源。
const skillAppConfigRelPath = "packages/vendor/memory-evolve/skills/picoaide-app-builder/references/app-config.md"

// generatedNote 是每个生成物都必须带的那句"不要手改"。
const generatedNote = "本文件由 `go generate ./internal/wasmapp/limits` 生成，不要手改。"

// appcfgGeneratedNote 是字段表生成物的"不要手改"（并指明唯一的真源文件）。
const appcfgGeneratedNote = "本文件由 `go generate ./internal/wasmapp/limits` 生成，不要手改；" +
	"单一真源是 `server/internal/wasmapp/appcfg/appcfgspec.go`。"

func main() {
	check := flag.Bool("check", false, "比对模式：不写文件，生成结果与磁盘内容不一致时以非零退出")
	root := flag.String("root", "", "模块根（含 go.mod 的 server/ 目录）；缺省自动向上查找")
	flag.Parse()

	if err := run(*check, *root); err != nil {
		fmt.Fprintf(os.Stderr, "picoaide-limits-gen: %v\n", err)
		os.Exit(1)
	}
}

// run 生成（或比对）全部产物。
func run(check bool, rootFlag string) error {
	moduleRoot, err := resolveModuleRoot(rootFlag)
	if err != nil {
		return err
	}
	repoRoot := filepath.Dir(moduleRoot)

	artifacts := []struct {
		path string
		data []byte
		// optional 为真时，产物缺失只提示不报错（用于 skill 目录尚未落地/被移动的场景；
		// 门禁测试 limits_gen_test.go / appcfgspec_gen_test.go 会对它做**硬断言**，
		// 所以这里不做静默放过）。
		optional bool
	}{
		{path: filepath.Join(moduleRoot, filepath.FromSlash(jsonRelPath)), data: renderJSON()},
		{path: filepath.Join(moduleRoot, filepath.FromSlash(mdRelPath)), data: renderMarkdown()},
		{path: filepath.Join(moduleRoot, filepath.FromSlash(appcfgJSONRelPath)), data: renderAppcfgJSON()},
		{path: filepath.Join(repoRoot, filepath.FromSlash(skillLimitsRelPath)), data: renderMarkdown(), optional: true},
		{path: filepath.Join(repoRoot, filepath.FromSlash(skillAppConfigRelPath)), data: renderAppConfigMarkdown(), optional: true},
	}

	var failed []string
	for _, a := range artifacts {
		rel := relTo(repoRoot, a.path)
		if check {
			committed, err := os.ReadFile(a.path)
			switch {
			case err != nil && os.IsNotExist(err) && a.optional:
				fmt.Fprintf(os.Stderr, "picoaide-limits-gen: 跳过可选产物 %s（不存在）\n", rel)
				continue
			case err != nil:
				failed = append(failed, fmt.Sprintf("%s: 读取失败: %v", rel, err))
				continue
			}
			if !bytes.Equal(committed, a.data) {
				failed = append(failed, diffSummary(rel, committed, a.data))
			}
			continue
		}
		if a.optional {
			if _, err := os.Stat(filepath.Dir(a.path)); err != nil {
				fmt.Fprintf(os.Stderr, "picoaide-limits-gen: 跳过可选产物 %s（目录不存在）\n", rel)
				continue
			}
		}
		if err := os.MkdirAll(filepath.Dir(a.path), 0o755); err != nil {
			return fmt.Errorf("创建目录 %s: %w", filepath.Dir(rel), err)
		}
		if err := os.WriteFile(a.path, a.data, 0o644); err != nil {
			return fmt.Errorf("写入 %s: %w", rel, err)
		}
		fmt.Printf("已写入 %s（%d 字节）\n", rel, len(a.data))
	}

	if len(failed) > 0 {
		return fmt.Errorf("生成物与源码不一致：\n%s\n跑 `go generate ./internal/wasmapp/limits` 重新生成", strings.Join(failed, "\n"))
	}
	if check {
		fmt.Printf("limits 生成物一致（%d 条目）；appcfg 生成物一致（配置 %d 字段 / 发布 %d 字段）\n",
			len(limits.Table()), len(appcfg.ConfigFields()), len(appcfg.PublishFields()))
	}
	return nil
}

// resolveModuleRoot 找到服务端模块根：优先用 -root，否则从当前目录向上找
// 带有本仓 module 行的 go.mod。
func resolveModuleRoot(rootFlag string) (string, error) {
	if rootFlag != "" {
		abs, err := filepath.Abs(rootFlag)
		if err != nil {
			return "", err
		}
		return abs, nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if isModuleRoot(dir) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("向上未找到 module %s 的 go.mod（请用 -root 指定 server/ 目录）", modulePath)
		}
		dir = parent
	}
}

// isModuleRoot 判断 dir 是否是本仓服务端模块根。
func isModuleRoot(dir string) bool {
	b, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == "module "+modulePath {
			return true
		}
	}
	return false
}

// renderJSON 渲染 limits.json：limits.Doc() 的 JSON，缩进 2 空格，末尾换行。
func renderJSON() []byte {
	b, err := json.MarshalIndent(limits.Doc(), "", "  ")
	if err != nil {
		// Doc() 只含字符串/整数，编码不会失败；真失败说明类型被改坏了，直接 panic
		// 好过写出一份残缺的"真源"。
		panic(fmt.Sprintf("picoaide-limits-gen: 编码 limits.json: %v", err))
	}
	return append(b, '\n')
}

// renderMarkdown 渲染 limits.md：标题 + 一句"不要手改" + 一张表
// （列：键 / 值 / 单位 / 章节 / 名称 / 说明）。
func renderMarkdown() []byte {
	var b strings.Builder
	b.WriteString("# WASM 应用平台上限表\n\n")
	b.WriteString(generatedNote + "\n\n")
	b.WriteString("单一真源：`server/internal/wasmapp/limits/limits.go`（含 `limitsspec.go` 的表定义）。")
	b.WriteString("改任何上限数值请改源码后重新生成——本表里的每个数字都必须与代码一致。\n\n")
	b.WriteString("| 键 | 值 | 单位 | 章节 | 名称 | 说明 |\n")
	b.WriteString("| --- | --- | --- | --- | --- | --- |\n")
	for _, e := range limits.Table() {
		fmt.Fprintf(&b, "| `%s` | %s | %s | %s | %s | %s |\n",
			cell(e.Key), valueCell(e.Value), cell(e.Unit), cell(e.Section), cell(e.Title), cell(e.Note))
	}
	return []byte(b.String())
}

// valueCell 渲染"值"列：空值给一个可见的占位（空单元格在宽表里容易被读成漏行）。
func valueCell(v string) string {
	if v == "" {
		return "—"
	}
	if strings.ContainsAny(v, " |") {
		return "`" + strings.ReplaceAll(v, "|", `\|`) + "`"
	}
	return v
}

// cell 转义表格单元格：竖线必须转义（否则列错位），换行折成空格（表格里不能换行）。
func cell(s string) string {
	s = strings.ReplaceAll(s, "|", `\|`)
	s = strings.ReplaceAll(s, "\r\n", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	return s
}

// renderAppcfgJSON 渲染 appcfg.json：appcfg.Doc() 的 JSON，缩进 2 空格，末尾换行。
//
// 这是**字段规格的跨语言契约**（TS 侧工具参数、表单预校验、SKILL 生成都读它）：
// 键名与取值一旦发布不得随意改（改字段名 = 破坏已发布应用）。
func renderAppcfgJSON() []byte {
	// 用 Encoder 并关掉 HTML 转义：Desc 里有 `<app_id>.<应用基域>` 这类尖括号，
	// 默认会被写成 \u003c（机器可读没问题，但人读与 diff 都难受）。
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(appcfg.Doc()); err != nil {
		// Doc() 只含字符串/整数/切片，编码不会失败；真失败说明类型被改坏了，
		// 直接 panic 好过写出一份残缺的"真源"。
		panic(fmt.Sprintf("picoaide-limits-gen: 编码 appcfg.json: %v", err))
	}
	return buf.Bytes()
}

// renderAppConfigMarkdown 渲染字段表生成物（写进 SKILL 的 references/app-config.md）。
//
// 只由 appcfgspec.go 的表驱动：表里没有的字段不会出现在这里，反之亦然
// （门禁用例 (d) 检查 SKILL 里的字段名全部来自生成物）。
func renderAppConfigMarkdown() []byte {
	var b strings.Builder
	b.WriteString("# 字段规格（应用配置文件 + 发布载荷）\n\n")
	b.WriteString(appcfgGeneratedNote + "\n\n")
	b.WriteString("上限数字与单位不在本文件里重复：一律见 `references/limits.md`（同一生成器产出）。\n")
	b.WriteString("改字段 = 改平台的 `appcfgspec.go` 并重新生成，**不要手改本文件**。\n\n")

	b.WriteString("## 1. 应用配置文件 `" + appcfg.Doc().ConfigFile + "`\n\n")
	b.WriteString("随发布一起提交（不计入 wasm 体积上限），发布期被抽到资源目录，\n")
	b.WriteString("应用用 `assets.read(\"" + appcfg.Doc().ConfigFile + "\")` 读它。\n")
	b.WriteString("顶层字段集合是封闭的：多一个未知字段即拒。\n\n")
	b.WriteString(renderFieldTable(appcfg.ConfigFields()))
	b.WriteString("\n")
	renderFieldHints(&b, appcfg.ConfigFields())

	b.WriteString("## 2. 发布载荷（`validate` / `publish` 的请求体）\n\n")
	b.WriteString("`POST /api/client/v2/apps/wasm/validate` 与 `POST /api/client/v2/apps/wasm/:app_id/releases` 共用同一份载荷。\n\n")
	b.WriteString(renderFieldTable(appcfg.PublishFields()))
	b.WriteString("\n")
	renderFieldHints(&b, appcfg.PublishFields())

	b.WriteString("## 3. 三条最容易搞错的语义\n\n")
	b.WriteString("- **`access` 缺省是 `" + appcfg.Doc().AccessDefault + "`**（要求登录）：写漏了不会意外变成匿名可达。\n")
	b.WriteString("- **准入由应用自己判**：平台只把 `access` 与身份注入帧，**不比对名单**；\n")
	b.WriteString("  名单在 `" + appcfg.Doc().ConfigFile + "` 里，应用入口第一件事就该读它。\n")
	b.WriteString("- **改配置 = 发新版**：运行期改不了；`access=\"whitelist\"` 且名单为空会被拒发布。\n")
	return []byte(b.String())
}

// renderFieldTable 渲染一张字段表。
//
// 列：字段 / 类型 / 必填 / 缺省 / 取值·上限 / 说明。
// "上限"列只写裸数字（不带单位）：单位与换算的唯一真源是 references/limits.md，
// 这里重复写单位只会造出第二个会漂移的数字来源。
func renderFieldTable(fields []appcfg.FieldSpec) string {
	var b strings.Builder
	b.WriteString("| 字段 | 类型 | 必填 | 缺省 | 取值 / 上限 | 说明 |\n")
	b.WriteString("| --- | --- | --- | --- | --- | --- |\n")
	for _, f := range fields {
		fmt.Fprintf(&b, "| `%s` | %s | %s | %s | %s | %s |\n",
			cell(f.Key), cell(f.Type), cell(requiredText(f)), cell(defaultText(f)),
			cell(valuesText(f)), cell(f.Desc))
	}
	return b.String()
}

// renderFieldHints 渲染每个字段的可操作提示（表里塞不下，单列一节）。
func renderFieldHints(b *strings.Builder, fields []appcfg.FieldSpec) {
	wrote := false
	for _, f := range fields {
		if len(f.Hints) == 0 {
			continue
		}
		if !wrote {
			b.WriteString("字段提示：\n\n")
			wrote = true
		}
		fmt.Fprintf(b, "- `%s`\n", f.Key)
		for _, h := range f.Hints {
			fmt.Fprintf(b, "  - %s\n", h)
		}
	}
	if wrote {
		b.WriteString("\n")
	}
}

// requiredText 渲染"必填"列：无条件必填 / 条件必填（条件的中文说法）。
func requiredText(f appcfg.FieldSpec) string {
	if f.Required {
		return "是"
	}
	switch f.RequiredWhen {
	case appcfg.RequiredWhenFirstRelease:
		return "首次发布"
	case appcfg.RequiredWhenNonFirstRelease:
		return "非首版"
	case appcfg.RequiredWhenAccessWhitelist:
		return "`access=\"whitelist\"` 时"
	case "":
		return "否"
	default:
		// 表里出现未知条件 ⇒ 生成物必须显式暴露，而不是渲染成"否"（错得看不见）。
		return "?" + f.RequiredWhen
	}
}

// defaultText 渲染"缺省"列（空 = 没有缺省）。
func defaultText(f appcfg.FieldSpec) string {
	if f.Default == "" {
		return "—"
	}
	return "`" + f.Default + "`"
}

// valuesText 渲染"取值 / 上限"列：enum 列封闭取值，其余列上限（裸数字）。
func valuesText(f appcfg.FieldSpec) string {
	var parts []string
	if len(f.Values) > 0 {
		quoted := make([]string, 0, len(f.Values))
		for _, v := range f.Values {
			quoted = append(quoted, "`"+v+"`")
		}
		parts = append(parts, strings.Join(quoted, " / "))
	}
	if f.Max > 0 {
		parts = append(parts, fmt.Sprintf("≤ %d", f.Max))
	}
	if len(parts) == 0 {
		return "—"
	}
	return strings.Join(parts, "；")
}

// relTo 把绝对路径渲染成相对仓库根的斜杠路径（只用于日志，不进生成物）。
func relTo(base, path string) string {
	if rel, err := filepath.Rel(base, path); err == nil {
		return filepath.ToSlash(rel)
	}
	return path
}

// diffSummary 生成**人类可读**的差异摘要（门禁红时必须能一眼看出改了什么，
// 而不是丢一句 "bytes differ"）。
func diffSummary(rel string, got, want []byte) string {
	gotLines := strings.Split(string(got), "\n")
	wantLines := strings.Split(string(want), "\n")
	var b strings.Builder
	fmt.Fprintf(&b, "%s: 内容不一致（磁盘 %d 行 / 期望 %d 行）", rel, len(gotLines), len(wantLines))
	shown := 0
	for i := 0; i < len(gotLines) || i < len(wantLines); i++ {
		var g, w string
		if i < len(gotLines) {
			g = gotLines[i]
		}
		var hasW bool
		if i < len(wantLines) {
			w, hasW = wantLines[i], true
		}
		if g == w && hasW {
			continue
		}
		fmt.Fprintf(&b, "\n  第 %d 行:\n    磁盘: %s\n    期望: %s", i+1, truncateRunes(g), truncateRunes(w))
		shown++
		if shown >= 5 {
			fmt.Fprintf(&b, "\n  …（仅显示前 5 处差异）")
			break
		}
	}
	return b.String()
}

// truncateRunes 截断过长行，避免把一整个 JSON 行倒进终端。
func truncateRunes(s string) string {
	const max = 200
	rs := []rune(s)
	if len(rs) <= max {
		return s
	}
	return string(rs[:max]) + "…"
}

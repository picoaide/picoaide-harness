package appserver

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ===========================================================================
// 入口文档形态：实现 ⟷ 契约面（文档 / 下发脚本）的一致性判据（R3-A A-5 续）
// ===========================================================================
//
// 背景：A-5 把实现从"只认根 index.html"改成"入口**文档**"（`isEntryDocument`：
// `index.html` 或 `*/index.html`），但**表述**散落在四处契约面里，改实现时漏一处
// 就会留下"文档说两形态、代码认三形态"的漂移 —— 审计第三轮的 abi.md:362 正是这样
// 留下的（同文件 :222 已改对，两处自相矛盾；只扫代码永远发现不了）。
//
// 本判据把"表述"变成可执行的东西，三个断言方向：
//  1. **实现面（行为）**：三种入口形态经**真实路径管线**（`staticLogicalPath` →
//     `isEntryDocument`）都判为入口，且非入口文档不被误判（反向）；
//  2. **契约面（表述）**：四个契约面文件里，凡是**枚举入口形态**的那一行，
//     必须列全三种形态（漏一个 ⇒ 红，报出行号与原文）；
//  3. **扫描面不得为空**：文件缺失、或文件里再没有任何枚举行 ⇒ 红（"扫不到就宣称
//     一致"是本仓明令禁止的形态，见 §6 的四条同类修复）。
//
// 为什么是源码/文本对拍而不是跑脚本（与 `assets.TestPreviewScriptSharesToolchainSectionPolicy`
// 同一条先例）：`preview.mjs` 的入口判定在"跑一个 wasm"这条路径里，Go 侧跑不动；
// 而它的**行为**另有兜底 —— 它的 `--selftest` 里有一条入口形态用例，由既有的
// `wasmmod.TestPreviewHostSelfTest`（`node preview.mjs --selftest`）执行 ⇒ 本文件管
// "表述"，那条管"行为"，两层都不空。
//
// 改文档的人必须能改到判据文件（避免"循环"）：判据就在本文件，红信息里带**文件:行 + 原文 +
// 缺哪一形态**，照抄即可；实现形态本身在 `static.go` 的 `isEntryDocument`（唯一定义点）。

// entryDocFormLiterals 是入口文档的三种形态**字面量**（契约面必须逐条列出）。
//
// 它们与 `isEntryDocument` 的判定面一一对应：`/` 与 `/index.html` 归一成 `index.html`，
// `<目录>/` 归一成 `<目录>/index.html` ⇒ 判据是"文档名是 index.html"，不是"路径恰好是 /"。
var entryDocFormLiterals = []string{"`/`", "`/index.html`", "`<目录>/`"}

// entryDocContractFiles 是要与实现同口径的契约面文件（相对本包目录）。
//
//   - `SKILL.md` 与 `references/abi.md`：随镜像下发给员工的作者手册（改它们要按
//     `skillseed` 的整目录摘要提 `version` 并登记新摘要，见 skill_version_test.go）；
//   - `examples/go/preview.mjs`：随技能下发的本地预览宿主（注释即契约）；
//   - `docs/wasm-app-authoring.md`：仓库内的作者文档（跨端对拍，路径从 server/ 往上一级）。
var entryDocContractFiles = []string{
	filepath.Join("..", "..", "..", "skills", "app-builder", "SKILL.md"),
	filepath.Join("..", "..", "..", "skills", "app-builder", "references", "abi.md"),
	filepath.Join("..", "..", "..", "skills", "app-builder", "examples", "go", "preview.mjs"),
	filepath.Join("..", "..", "..", "..", "docs", "wasm-app-authoring.md"),
}

// backtickedLiteral 抓一行里的反引号字面量（“ `…` “）。
var backtickedLiteral = regexp.MustCompile("`[^`]+`")

// isEntryDocEnumerationLine 判定一行是不是在**枚举入口文档的路径形态**。
//
// 三个条件同时成立才算"枚举行"：出现"入口"字样 + 出现**反引号的 `/index.html`**
// + 至少两个反引号包裹的路径形态（以 `/` 或 `<` 开头）。
//
// 为什么这么窄（两个条件都是被真实误报逼出来的，别放宽）：
//   - 只看"出现 index.html"会把顺带提到它的句子（示例代码注释、自测命令、表格里的
//     资源名）算进来 —— 要求那些句子列全 `<目录>/` 是假的严格；
//   - 只看"入口 + ≥2 个路径形态"会误伤**解释性**句子：`docs/wasm-app-authoring.md:130`
//     的「判据是"是不是**入口文档**"……页面放在子目录（`/admin/`、`/app/`）时」就是
//     一例（它讲的是判据的性质，不是在列形态）—— 本判据第一版实测把它判红过。
//   - 反过来，`/index.html` 的字面量正是"在列入口形态"的可靠标志：真·枚举句都会写它
//     （旧的两形态句 `（`/`、`/index.html`）` 同样命中 ⇒ 漂移照样被抓）。
func isEntryDocEnumerationLine(line string) bool {
	if !strings.Contains(line, "入口") || !strings.Contains(line, "`/index.html`") {
		return false
	}
	forms := 0
	for _, m := range backtickedLiteral.FindAllString(line, -1) {
		inner := strings.Trim(m, "`")
		if strings.HasPrefix(inner, "/") || strings.HasPrefix(inner, "<") {
			forms++
		}
	}
	return forms >= 2
}

// TestEntryDocumentFormsMatchContractsAndDocs 是本条漂移的**唯一判据**。
func TestEntryDocumentFormsMatchContractsAndDocs(t *testing.T) {
	// ---- ① 实现面（行为）：三种入口形态 + 反向（非入口文档不误判）----
	cases := []struct {
		path      string
		wantEntry bool
	}{
		{"/", true},
		{"/index.html", true},
		{"/admin/", true},           // 目录形态归一成 admin/index.html
		{"/admin/index.html", true}, // 显式写出的子目录入口
		{"/a/b/index.html", true},   // 多级目录
		{"/app.js", false},
		{"/static/app.css", false},
		{"/docs/readme.html", false}, // 非入口的普通文档不是入口（仍是壳资源）
		{"/index.htm", false},        // 只有 index.html 是入口
	}
	for _, tc := range cases {
		_, gotEntry, ok := staticLogicalPath(mustURL(t, "https://x.example.com"+tc.path))
		if !ok {
			t.Fatalf("staticLogicalPath(%q) 应 ok", tc.path)
		}
		if gotEntry != tc.wantEntry {
			t.Fatalf("staticLogicalPath(%q) 的 isEntry = %v，want %v（实现形态变了？改完记得同步四处契约面）",
				tc.path, gotEntry, tc.wantEntry)
		}
	}

	// ---- ② 契约面（表述）：每条枚举行必须列全三形态；③ 扫描面不得为空 ----
	for _, rel := range entryDocContractFiles {
		raw, err := os.ReadFile(rel)
		if err != nil {
			t.Fatalf("读不到契约面文件 %s（判据的扫描面缺失，拒绝宣称「文档与实现一致」）: %v", rel, err)
		}
		lines := strings.Split(string(raw), "\n")
		enumerations := 0
		for i, line := range lines {
			if !isEntryDocEnumerationLine(line) {
				continue
			}
			enumerations++
			for _, form := range entryDocFormLiterals {
				if strings.Contains(line, form) {
					continue
				}
				t.Fatalf("%s:%d 枚举了入口文档形态却漏掉 %s —— 实现把子目录入口（`<目录>/` =\n"+
					"`<目录>/index.html`）也交给 wasm，文档少写一种就会让作者以为子目录入口由宿主直出：\n%s",
					rel, i+1, form, strings.TrimSpace(line))
			}
		}
		if enumerations == 0 {
			t.Fatalf("%s 里没有任何「入口文档形态」枚举行（扫描面空了：表述被删、被改名，或本判据的"+
				"识别口径已失效）—— 空扫描面不得静默通过", rel)
		}
	}
}

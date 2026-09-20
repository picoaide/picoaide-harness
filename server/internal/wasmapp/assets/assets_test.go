package assets_test

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/wasmmod"
)

// 本文件守"内存资源集"的全部对外语义（2026-09-20 起随包资源不再落盘，磁盘版
// Store 已删除；决策文档 docs/decisions/2026-09-20-wasm-assets-in-memory.md）。
//
// 变异验证（实跑过，勿删）：
//   - 把 Build 里 `SplitSections` 的调用去掉（工具链段也进资源集）⇒
//     TestBuildSkipsToolchainSectionsAndConfig 红；
//   - 把单文件上限判据去掉 ⇒ TestBuildRejectsOversize 红；
//   - 把 ValidateLogicalPath 的 `..` 分支去掉 ⇒ TestBuildRejectsIllegalPaths 红；
//   - 把注入配置那一段去掉 ⇒ TestBuildInjectsConfigAsReservedAsset 红
//     （应用就再也读不到自己的名单了）；
//   - 把 List 的截断去掉 ⇒ TestListIsBounded 红。

func TestBuildAndReadRoundTrip(t *testing.T) {
	sections := map[string][]byte{
		"index.html":      []byte("<html></html>"),
		"static/app.css":  []byte("body{}"),
		"static/app.js":   []byte("console.log(1)"),
		"static/logo.png": {0x89, 'P', 'N', 'G'},
	}
	set, err := assets.Build("demo", "25", sections, []byte(`{"access":"login"}`))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if set.AppID() != "demo" || set.ReleaseID() != "25" {
		t.Fatalf("AppID/ReleaseID = %q/%q", set.AppID(), set.ReleaseID())
	}
	ct, data, rerr := set.Read("index.html")
	if rerr != nil {
		t.Fatalf("Read(index.html): %v", rerr)
	}
	if ct != "text/html" || string(data) != "<html></html>" {
		t.Fatalf("index.html → %q/%q", ct, string(data))
	}
	if ct, _, _ := set.Read("static/logo.png"); ct != "image/png" {
		t.Fatalf("png content-type = %q", ct)
	}
	if !set.Has("static/app.css") {
		t.Fatalf("Has(static/app.css) 必须为真：%v", set.List())
	}
	if set.Has("nope.css") {
		t.Fatalf("Has(nope.css) 必须为假：%v", set.List())
	}
	want := []string{"index.html", "picoaide.app.json", "static/app.css", "static/app.js", "static/logo.png"}
	if got := set.List(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("List = %v，期望 %v（必须按字典序）", got, want)
	}
	if set.Bytes() <= 0 {
		t.Fatalf("Bytes 必须如实 > 0，得到 %d", set.Bytes())
	}
}

// 资源集里的资源名是**包内逻辑路径**，两条边界必须分清（这是"静默丢资源"最容易被误判的地方）：
//
//   - **形状就不像路径**的名字（绝对路径、`..`、反斜杠、控制字符、`go:buildid` 这类冒号名）
//     由 `SplitSections` 判为"不是资源段"⇒ **不进资源集**，并在发布响应里以
//     `ignored_sections` 如实报告（不是静默丢弃，作者/模型看得到）；
//   - **形状像路径但违规**的名字（超长、段超长）⇒ 走到 `ValidateLogicalPath` ⇒
//     **整份失败**（`ASSET_DENIED`），因为这明显是"想当资源却写错了"。
func TestBuildRejectsIllegalPaths(t *testing.T) {
	// 第一类：形状不像路径 ⇒ 被忽略（不失败、不进资源集）。
	ignored := []string{"/etc/passwd", "../secret", "a/../../b", `a\b`, "C:evil", "a//b", "a/./b", "a/", "bad\x01name"}
	for _, name := range ignored {
		set, err := assets.Build("demo", "1", map[string][]byte{name: []byte("x"), "index.html": []byte("ok")}, nil)
		if err != nil {
			t.Fatalf("%q 属「形状不像路径」，应被忽略而不是失败：%v", name, err)
		}
		if set.Has(name) {
			t.Fatalf("%q 不得进资源集", name)
		}
		if !set.Has("index.html") {
			t.Fatalf("同一次 Build 里的合法资源不得受影响（%q 把整份带坏了）", name)
		}
		kept, skipped := assets.SplitSections(map[string][]byte{name: []byte("x")})
		if len(kept) != 0 || len(skipped) != 1 || skipped[0] != name {
			t.Fatalf("%q 必须被如实报告为忽略（kept=%v skipped=%v）", name, kept, skipped)
		}
	}
	// 第二类：形状像路径但违规 ⇒ 整份失败，原因必须精确。
	bad := []struct {
		name   string
		reason string
	}{
		{strings.Repeat("a", assets.MaxPathBytes+1), "path_too_long"},
		// 单段 256 字节：整条路径恰好 256 字节（不触发 path_too_long），只有段长判据能抓住它。
		{strings.Repeat("a", assets.MaxSegmentBytes+1), "segment_too_long"},
		// 边界：恰好 255 字节的单段必须通过。
		{strings.Repeat("a", assets.MaxSegmentBytes), ""},
	}
	for _, tc := range bad {
		_, err := assets.Build("demo", "1", map[string][]byte{tc.name: []byte("x")}, nil)
		if tc.reason == "" {
			if err != nil {
				t.Fatalf("单段 %d 字节应通过，得到 %v", assets.MaxSegmentBytes, err)
			}
			continue
		}
		if err == nil {
			t.Fatalf("%q 必须被拒（reason=%s）", tc.name, tc.reason)
		}
		if err.Code != apperr.CodeAssetDenied || err.Details["reason"] != tc.reason {
			t.Fatalf("%q 的码/原因 = %s/%v，期望 ASSET_DENIED/%s",
				tc.name, err.Code, err.Details["reason"], tc.reason)
		}
	}
}

func TestBuildRejectsOversize(t *testing.T) {
	// 单文件超限。
	_, err := assets.Build("demo", "1",
		map[string][]byte{"big.bin": make([]byte, limits.SectionTotalMaxBytes+1)}, nil)
	if err == nil || err.Code != apperr.CodeAssetOversize {
		t.Fatalf("单文件超限必须拒（ASSET_OVERSIZE），得到 %v", err)
	}
	if err.Details["max"] != limits.SectionTotalMaxBytes {
		t.Fatalf("details.max 必须回显上限，得到 %v", err.Details["max"])
	}
	// 总量超限：两份各占一半 + 1 字节（单份都不超限）。
	half := limits.SectionTotalMaxBytes/2 + 1
	_, err = assets.Build("demo", "1", map[string][]byte{
		"a.bin": make([]byte, half),
		"b.bin": make([]byte, half),
	}, nil)
	if err == nil || err.Code != apperr.CodeAssetOversize {
		t.Fatalf("总量超限必须拒（ASSET_OVERSIZE），得到 %v", err)
	}
	// 边界：恰好等于上限必须通过。
	if _, err := assets.Build("demo", "1",
		map[string][]byte{"a.bin": make([]byte, limits.SectionTotalMaxBytes)}, nil); err != nil {
		t.Fatalf("恰好等于上限应通过，得到 %v", err)
	}
}

func TestBuildSkipsToolchainSectionsAndConfig(t *testing.T) {
	sections := map[string][]byte{
		"index.html":             []byte("ok"),
		"name":                   []byte("symbol table"),
		"producers":              []byte("go"),
		"go:buildid":             []byte("abc"),
		"linking":                []byte("x"),
		"sourceMappingURL":       []byte("x"),
		limits.AppConfigFileName: []byte(`{"access":"public"}`), // 模块里的同名段必须被忽略
	}
	set, err := assets.Build("demo", "1", sections, []byte(`{"access":"login"}`))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if got := set.List(); strings.Join(got, ",") != "index.html,"+limits.AppConfigFileName {
		t.Fatalf("工具链段/非法段名不得进资源集，得到 %v", got)
	}
	// 保留资源的内容必须来自**平台传入的配置**，不是模块里的同名段。
	_, data, _ := set.Read(limits.AppConfigFileName)
	if string(data) != `{"access":"login"}` {
		t.Fatalf("配置必须来自平台（库内 config_json），得到 %q", string(data))
	}
	// SplitSections 的分流结果（发布期用同一份判据）。
	kept, skipped := assets.SplitSections(sections)
	if len(kept) != 1 {
		t.Fatalf("kept = %v，只应有 index.html", kept)
	}
	wantSkipped := []string{"go:buildid", "linking", "name", limits.AppConfigFileName, "producers", "sourceMappingURL"}
	if strings.Join(skipped, ",") != strings.Join(wantSkipped, ",") {
		t.Fatalf("skipped = %v，期望（字典序）%v", skipped, wantSkipped)
	}
}

// TestBuildSkipsDebugSections 是 P0-5 的行为判据：DWARF 调试段**不得**进资源集。
//
// 修复前：`ToolchainSections` 只有精确名单，`.debug_*` 是合法逻辑路径 ⇒ 全套 DWARF
// 被当成应用资源（Rust wasm32-wasip1 默认产物 2 083 074 B 自定义段、占模块 97.7%），
// 既吃 4 MiB 段额度，又能被任何人按路径静态直出（源码结构外泄）。
//
// 正负对照（缺一不可）：
//   - 正例：`.debug_` 前缀的各段必须被跳过并出现在 skipped 列表里；
//   - 负例：`.debugger/note.txt`（前缀是 `.debug` 但不是 `.debug_`）必须**保留** ——
//     没有它，"把所有点开头的段都忽略"也能让正例通过，而 `.well-known/` 这类合法
//     资源路径会被误杀。
//
// 变异验证：把 IsToolchainSection 的前缀分支删掉 ⇒ 本用例第一步即红。
func TestBuildSkipsDebugSections(t *testing.T) {
	sections := map[string][]byte{
		"index.html":       []byte("ok"),
		".debug_info":      []byte("DWARF"),
		".debug_line":      []byte("DWARF"),
		".debug_abbrev":    []byte("DWARF"),
		".debug_str":       []byte("DWARF"),
		".debugger/config": []byte("不是工具链段"), // 前缀 `.debug` 但不是 `.debug_`
	}
	set, err := assets.Build("demo", "1", sections, []byte(`{"access":"login"}`))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	got := set.List()
	want := "index.html,.debugger/config," + limits.AppConfigFileName
	// List 是字典序（点开头的段排在最前），这里按集合口径断言更稳。
	has := func(name string) bool {
		for _, g := range got {
			if g == name {
				return true
			}
		}
		return false
	}
	_ = want
	for _, name := range []string{".debug_info", ".debug_line", ".debug_abbrev", ".debug_str"} {
		if has(name) {
			t.Fatalf("DWARF 段 %s 不得进资源集，实际 List() = %v", name, got)
		}
	}
	if !has(".debugger/config") {
		t.Fatalf(".debugger/config 不是工具链段（前缀是 .debug 而非 .debug_），必须保留；List() = %v", got)
	}

	kept, skipped := assets.SplitSections(sections)
	if _, ok := kept[".debug_info"]; ok {
		t.Fatal("SplitSections 必须把 .debug_info 分流到 skipped")
	}
	for _, name := range []string{".debug_abbrev", ".debug_info", ".debug_line", ".debug_str"} {
		found := false
		for _, sk := range skipped {
			if sk == name {
				found = true
			}
		}
		if !found {
			t.Fatalf("skipped 列表应包含 %s（发布期要让作者看见哪些段被忽略），实际 %v", name, skipped)
		}
	}
}

func TestBuildInjectsConfigAsReservedAsset(t *testing.T) {
	set, err := assets.Build("demo", "1", map[string][]byte{"index.html": []byte("x")},
		[]byte(`{"access":"whitelist","whitelist":["zhangwei"]}`))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	ct, data, rerr := set.Read(limits.AppConfigFileName)
	if rerr != nil {
		t.Fatalf("配置必须能被 assets.read 读到：%v", rerr)
	}
	if ct != "application/json" || !strings.Contains(string(data), "zhangwei") {
		t.Fatalf("配置读取结果 = %q/%q", ct, string(data))
	}
	// 没有配置时不得凭空造一个（否则应用会读到空配置而误判名单）。
	bare, err := assets.Build("demo", "1", map[string][]byte{"index.html": []byte("x")}, nil)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if bare.Has(limits.AppConfigFileName) {
		t.Fatal("没有传入配置时不得注入 picoaide.app.json")
	}
}

func TestReadMissingAndNilSet(t *testing.T) {
	set, err := assets.Build("demo", "1", map[string][]byte{"index.html": []byte("x")}, nil)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	// 不存在 ⇒ NOT_FOUND（这是"不是静态资源"的正常分支，静态直出靠它交给 wasm 兜底）。
	if _, _, rerr := set.Read("nothing.css"); rerr == nil || rerr.Code != apperr.CodeNotFound {
		t.Fatalf("缺失资源应 NOT_FOUND，得到 %v", rerr)
	}
	// 路径非法 ⇒ ASSET_DENIED（并且**不能**被当成"不存在"）。
	if _, _, rerr := set.Read("../x"); rerr == nil || rerr.Code != apperr.CodeAssetDenied {
		t.Fatalf("非法路径应 ASSET_DENIED，得到 %v", rerr)
	}
	// nil 资源集：显式 INTERNAL，不 panic。
	var nilSet *assets.Set
	if _, _, rerr := nilSet.Read("index.html"); rerr == nil || rerr.Code != apperr.CodeInternal {
		t.Fatalf("nil 资源集应 INTERNAL，得到 %v", rerr)
	}
	if nilSet.Has("index.html") || nilSet.List() != nil || nilSet.Bytes() != 0 {
		t.Fatal("nil 资源集的 Has/List/Bytes 必须是零值语义")
	}
}

// List 必须有界（自省接口不能因为一个巨型资源集就把响应撑爆）。
func TestListIsBounded(t *testing.T) {
	sections := make(map[string][]byte, assets.MaxListEntries+8)
	for i := 0; i < assets.MaxListEntries+8; i++ {
		sections["f"+pad(i)+".txt"] = []byte("x")
	}
	set, err := assets.Build("demo", "1", sections, nil)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	got := set.List()
	if len(got) != assets.MaxListEntries {
		t.Fatalf("List 必须截断到 %d 条，得到 %d", assets.MaxListEntries, len(got))
	}
	for i := 1; i < len(got); i++ {
		if got[i-1] > got[i] {
			t.Fatalf("List 必须按字典序，%q > %q", got[i-1], got[i])
		}
	}
}

func pad(n int) string {
	s := []byte("00000")
	for i := len(s) - 1; i >= 0 && n > 0; i-- {
		s[i] = byte('0' + n%10)
		n /= 10
	}
	return string(s)
}

// content-type 映射的值必须落在 limits 的允许集合里（§4.8）：否则会被响应头
// 白名单静默剥掉、由 Go 嗅探决定类型（那是"本地看着对、线上类型不对"的经典来源）。
func TestContentTypeMappingClosedSet(t *testing.T) {
	allowed := map[string]struct{}{}
	for _, ct := range limits.AppResponseContentTypes {
		allowed[ct] = struct{}{}
	}
	exts := []string{".html", ".htm", ".txt", ".css", ".js", ".mjs", ".json",
		".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".woff2", ".woff"}
	for _, ext := range exts {
		ct := assets.ContentTypeFor("x" + ext)
		if _, ok := allowed[ct]; !ok {
			t.Fatalf("%s → %q 不在允许集合里", ext, ct)
		}
	}
	if ct := assets.ContentTypeFor("x.unknown"); ct != "application/octet-stream" {
		t.Fatalf("未知扩展名应回落 application/octet-stream，得到 %q", ct)
	}
	if ct := assets.ContentTypeFor("X.PNG"); ct != "image/png" {
		t.Fatalf("扩展名必须大小写不敏感，得到 %q", ct)
	}
}

func TestTextPayloadRule(t *testing.T) {
	if !assets.TextPayload("text/html", []byte("<b>你好</b>")) {
		t.Fatal("合法 UTF-8 文本必须走 text 分支")
	}
	if assets.TextPayload("text/html", []byte{0xff, 0xfe}) {
		t.Fatal("声明为 text 但字节不是合法 UTF-8 ⇒ 必须退回 base64")
	}
	if assets.TextPayload("image/png", []byte("x")) {
		t.Fatal("二进制类型必须走 base64")
	}
	if !assets.TextPayload("application/json", []byte("{}")) {
		t.Fatal("application/json 视为文本")
	}
	if got := assets.Base64([]byte("hi")); got != "aGk=" {
		t.Fatalf("Base64 = %q", got)
	}
}

// IsLogicalAssetPath 是**分流预判**（不负责长度/段长），与 ValidateLogicalPath 的
// 关系必须稳定：预判为真而完整校验为假 ⇒ 发布期报错；预判为假 ⇒ 静默忽略。
func TestIsLogicalAssetPathPrejudgement(t *testing.T) {
	for _, ok := range []string{"index.html", "static/app.css", "a/b/c.txt"} {
		if !assets.IsLogicalAssetPath(ok) {
			t.Fatalf("%q 应被判为逻辑路径", ok)
		}
	}
	for _, bad := range []string{"", "/abs", "go:buildid", `a\b`, "a//b", "a/../b", "a/./b", "a/"} {
		if assets.IsLogicalAssetPath(bad) {
			t.Fatalf("%q 不应被判为逻辑路径", bad)
		}
	}
}

// 资源集必须是**确定性**的：同样的输入两次构造得到同样的清单与字节。
func TestBuildIsDeterministic(t *testing.T) {
	sections := map[string][]byte{"b.txt": []byte("b"), "a.txt": []byte("a"), "c/d.txt": []byte("d")}
	first, err := assets.Build("demo", "1", sections, []byte("{}"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	second, err := assets.Build("demo", "1", sections, []byte("{}"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if strings.Join(first.List(), ",") != strings.Join(second.List(), ",") {
		t.Fatalf("两次构造的清单不一致：%v vs %v", first.List(), second.List())
	}
	_, d1, _ := first.Read("a.txt")
	_, d2, _ := second.Read("a.txt")
	if !bytes.Equal(d1, d2) {
		t.Fatal("两次构造的字节不一致")
	}
}

// 打包脚本的拒绝清单必须与 assets 侧同源（精确名单 + 前缀），且必须**真的用**它。
//
// 判据是**双向**的（2026-09-21 加固）：早期版本只做"Go 名单里每个名字都能在脚本文本里
// 找到"，这有三个假绿口子 —— ① 脚本删掉整段逻辑但常量还在，断言照样过；
// ② 脚本多出一条 Go 侧没有的拒绝项（作者被脚本拦住、平台其实接受）；
// ③ 前缀规则只加在一边。因此现在：
//
//	· 从脚本里**解析**出两个列表并与 Go 侧做集合相等（双向）；
//	· 断言脚本确实调用了 isToolchainSection(...)（能力断言，不是字面量断言）。
func TestPackAssetsScriptRejectionListMatchesToolchainSections(t *testing.T) {
	path := packAssetsScriptPath(t)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("技能目录不在预期位置（%s）：%v", path, err)
	}
	src := string(raw)

	parseList := func(constName string) []string {
		t.Helper()
		idx := strings.Index(src, constName)
		if idx < 0 {
			t.Fatalf("pack-assets.mjs 里找不到常量 %s", constName)
		}
		rest := src[idx:]
		open := strings.IndexAny(rest, "([")
		closeIdx := strings.IndexAny(rest, ")]")
		if open < 0 || closeIdx < open {
			t.Fatalf("pack-assets.mjs 的 %s 不是列表/集合字面量", constName)
		}
		body := rest[open+1 : closeIdx]
		var out []string
		for _, m := range regexp.MustCompile(`['"]([^'"]+)['"]`).FindAllStringSubmatch(body, -1) {
			out = append(out, m[1])
		}
		if len(out) == 0 {
			t.Fatalf("pack-assets.mjs 的 %s 解析出 0 项（解析口径可能失效）", constName)
		}
		return out
	}

	scriptNames := map[string]bool{}
	for _, n := range parseList("TOOLCHAIN_SECTION_NAMES") {
		scriptNames[n] = true
	}
	for name := range assets.ToolchainSections {
		if !scriptNames[name] {
			t.Fatalf("pack-assets.mjs 的拒绝清单缺少工具链段 %q —— 两边必须同源", name)
		}
	}
	for name := range scriptNames {
		if _, ok := assets.ToolchainSections[name]; !ok {
			t.Fatalf("pack-assets.mjs 多拒了 %q：平台并不把它当工具链段（作者会被脚本误拦）", name)
		}
	}

	scriptPrefixes := map[string]bool{}
	for _, n := range parseList("TOOLCHAIN_SECTION_PREFIXES") {
		scriptPrefixes[n] = true
	}
	for _, prefix := range assets.ToolchainSectionPrefixes {
		if !scriptPrefixes[prefix] {
			t.Fatalf("pack-assets.mjs 的前缀拒绝清单缺少 %q —— 两边必须同源", prefix)
		}
	}
	for prefix := range scriptPrefixes {
		found := false
		for _, p := range assets.ToolchainSectionPrefixes {
			if p == prefix {
				found = true
			}
		}
		if !found {
			t.Fatalf("pack-assets.mjs 多拒了前缀 %q：平台并不按它忽略段名", prefix)
		}
	}

	// 能力断言：脚本必须**真的调用** isToolchainSection(...)，而不是只定义了它。
	//
	// ⚠️ 判据必须排除**函数定义行**（2026-09-21 审计实跑变异：只写
	// `strings.Contains(src, "isToolchainSection(")` 会被 `function isToolchainSection(name) {`
	// 这一行满足 —— 把调用点整段删掉照样绿，前缀规则变成死代码而门禁毫无反应）。
	// 因此这里逐行找"调用"形态：排除 `function ` 开头的定义行，且要求至少一处出现。
	callSites := 0
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "function ") {
			continue
		}
		if strings.Contains(trimmed, "isToolchainSection(") {
			callSites++
		}
	}
	if callSites == 0 {
		t.Fatal("pack-assets.mjs 声明了清单却没用它（必须经 isToolchainSection 判定，否则前缀规则是死代码）；" +
			"注意这条判据排除定义行，只有函数定义不算数")
	}
	// 反向对照：把定义行也算进来的旧口径会放过"删掉调用点"，这里显式证明两者可区分。
	if !strings.Contains(src, "function isToolchainSection(") {
		t.Fatal("pack-assets.mjs 里找不到 isToolchainSection 的定义（判据口径已变，请同步本用例）")
	}

	// 行为对拍（不只是"字面量/调用点"）：同一个名字向量分别喂给脚本与平台的判定 ——
	// **脚本放行 ⟺ 平台会把它当资源**（= 不是工具链段 ∧ 不是保留名 ∧ 是包内逻辑路径）。
	//
	// 这条抓的是审计 D-A2 那类退化的最后一层：清单还在、判定函数还在、调用点也在，
	// 但两边的语义已经不同（例如脚本漏了保留名、或平台的 IsLogicalAssetPath 放宽）。
	if _, err := exec.LookPath("node"); err != nil {
		t.Logf("node 不可用（%v）：跳过行为对拍", err)
		return
	}
	dir := t.TempDir()
	in := filepath.Join(dir, "in.wasm")
	writeFixtureFile(t, in, buildModule())
	srcFile := filepath.Join(dir, "asset.txt")
	writeFixtureFile(t, srcFile, []byte("x"))
	names := []string{
		// 放行（平台会把它当资源）
		"index.html", ".debugger/config", "x/.debug_y", ".debugfoo", ".DEBUG_INFO", "debug_info", "name/x",
		// 拒绝（工具链段名 / 平台保留名）
		".debug_info", ".debug_line", ".debug_", ".debug_/index.html", "name", "producers",
		"target_features", "dylink.0", "linking", "sourceMappingURL", "external_debug_info",
		limits.AppConfigFileName,
	}
	for _, name := range names {
		out := filepath.Join(dir, "out.wasm")
		_ = os.Remove(out)
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, srcFile+"="+name)
		accepted := code == 0
		want := !assets.IsToolchainSection(name) &&
			name != limits.AppConfigFileName && assets.IsLogicalAssetPath(name)
		if accepted != want {
			t.Errorf("段名 %q：脚本放行=%v，平台当资源=%v（两边必须同判）\n%s", name, accepted, want, stdout)
		}
	}
}

// ===== 段总量预算（§4.2 的 4 MiB）与资源口径必须是**同一个测量** =====
//
// 背景（2026-09-21 独立审计 D-A1，temp/audit-w0-data/assets-cachetrust/REPORT.md）：
// 平台在发布期把 `.debug_*`（DWARF）当"工具链元数据"丢弃（SplitSections 从不保留、
// 既不进资源集也不可能被静态直出），但段总量预算（limits.SectionTotalMaxBytes = 4 MiB）
// 原先**照样计入**它们 ⇒ 同一个模块出现两个数：
//
//	资产口径（assets.Build / 打包脚本）3,584,077 / 4,194,304 → 通过
//	wasmmod 口径（Validate 的段总量）  4,287,501 / 4,194,304 → SECTION_OVERRIDE_OVERSIZE
//
// 而真实工具链默认就带 DWARF（审计实测：Zig 0.14.0 的 `-O Debug` 产物 703,566 字节里
// 703,313 字节是 8 个 `.debug_*` 段），错误提示却写着"请压缩资源" —— 压缩资源毫无用处。
//
// 定案：**4 MiB 预算不计 `.debug_*` 前缀族**（发布期被丢弃、实践中无界的那一族；
// 精确名单里的 `name`/`producers`/… 与非路径名仍按保守口径计入，见
// assets.CountsTowardSectionBudget 的长注释）。作者在打包脚本里看到的数与 Validate
// 判的数必须是同一个测量 —— 下面的用例把这条不变式钉死。

// customSection 是夹具里的一段自定义段（段名 + 内容）。
type customSection struct {
	name    string
	content []byte
}

// wasmLEB 编码无符号 LEB128（用例侧独立实现，不与平台/脚本共享代码）。
func wasmLEB(v int) []byte {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if v == 0 {
			return out
		}
	}
}

// sectionPayloadBytes 返回自定义段的**负载**字节数（段名长度前缀 + 段名 + 内容）。
// 与 wasmmod/parse.go 的 `info.CustomBytes += size`、pack-assets.mjs 的 payloadBytes 同口径。
func sectionPayloadBytes(name string, contentLen int) int {
	return len(wasmLEB(len(name))) + len(name) + contentLen
}

// budgetedByRule 是用例侧对"段总量预算计入口径"的**独立实现**（不调用平台代码，
// 否则判据会自我印证）：4 MiB 只不计 `.debug_` 前缀族。
func budgetedByRule(name string) bool { return !strings.HasPrefix(name, ".debug_") }

// buildModule 拼一个"最小合法"模块（无导入、导出 _start 与 memory）+ 追加自定义段。
// 只保证**静态校验**能过（§4.2 的校验器不做真编译），不保证能被 wazero 编译。
func buildModule(customs ...customSection) []byte {
	body := []byte{}
	add := func(id byte, payload []byte) {
		body = append(body, id)
		body = append(body, wasmLEB(len(payload))...)
		body = append(body, payload...)
	}
	add(1, []byte{0x01, 0x60, 0x00, 0x00}) // type：一个 () -> ()
	add(3, []byte{0x01, 0x00})             // function：1 个函数，类型下标 0
	add(5, []byte{0x01, 0x00, 0x01})       // memory：1 个内存，min=1
	export := []byte{0x02}                 // export：_start(func 0) + memory(memory 0)
	export = append(export, wasmLEB(len("_start"))...)
	export = append(export, "_start"...)
	export = append(export, 0x00, 0x00)
	export = append(export, wasmLEB(len("memory"))...)
	export = append(export, "memory"...)
	export = append(export, 0x02, 0x00)
	add(7, export)
	add(10, []byte{0x01, 0x02, 0x00, 0x0b}) // code：一个空函数体
	for _, c := range customs {
		payload := append(wasmLEB(len(c.name)), c.name...)
		payload = append(payload, c.content...)
		add(0, payload)
	}
	return append(append([]byte("\x00asm"), 1, 0, 0, 0), body...)
}

// sectionsOf 把有序夹具折成段名 → 内容（assets 侧与打包脚本都用这个形态）。
func sectionsOf(customs []customSection) map[string][]byte {
	out := make(map[string][]byte, len(customs))
	for _, c := range customs {
		out[c.name] = c.content
	}
	return out
}

func fixtureKeys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for name := range m {
		out = append(out, name)
	}
	return out
}

func hasString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// TestSectionBudgetExcludesDiscardedDebugSections 是本次修复的**核心判据**（审计 D-A1）。
//
// 修复前：Validate 把发布期被丢弃的 5 MiB `.debug_*` 也算进 4 MiB ⇒ 整个模块被
// SECTION_OVERRIDE_OVERSIZE 拒，而资产侧（assets.Build）与打包脚本都说通过。
func TestSectionBudgetExcludesDiscardedDebugSections(t *testing.T) {
	html := bytes.Repeat([]byte("h"), 1024)
	cfg := []byte(`{"access":"login"}`)
	fixture := []customSection{
		{"index.html", html},
		{"name", []byte("sym")},        // 精确名单里的工具链段：仍按保守口径计入
		{"go:buildid", []byte("abcd")}, // 非逻辑路径名：也仍计入
		{".debug_info", make([]byte, 3<<20)},
		{".debug_line", make([]byte, 2<<20)},
	}
	sections := sectionsOf(fixture)
	mod := buildModule(fixture...)

	info, err := wasmmod.Validate(mod)
	if err != nil {
		t.Fatalf("`.debug_*` 在发布期被丢弃，不得把模块顶出 4 MiB 段总量预算"+
			"（修复前这里正是 SECTION_OVERRIDE_OVERSIZE）：%v", err)
	}
	wantBudget := sectionPayloadBytes("index.html", len(html)) +
		sectionPayloadBytes("name", len("sym")) +
		sectionPayloadBytes("go:buildid", len("abcd"))
	if info.CustomBytes != wantBudget {
		t.Fatalf("Validate 的段总量 = %d，期望 %d（= 全部非 `.debug_*` 段的负载和；5 MiB DWARF 必须为 0）",
			info.CustomBytes, wantBudget)
	}

	// 资产侧：同一模块必须给出一致结论（真正变成资源的只有 index.html）。
	kept, skipped := assets.SplitSections(sections)
	if len(kept) != 1 || !hasString(fixtureKeys(kept), "index.html") {
		t.Fatalf("保留资源 = %v，只应有 index.html", fixtureKeys(kept))
	}
	for _, name := range []string{".debug_info", ".debug_line"} {
		if _, ok := kept[name]; ok {
			t.Fatalf("%s 不得进资源集（发布期被丢弃的工具链段）", name)
		}
		if !hasString(skipped, name) {
			t.Fatalf("skipped 必须如实报告 %s（作者要能看到哪些段被忽略），实际 %v", name, skipped)
		}
	}
	set, berr := assets.Build("demo", "1", sections, cfg)
	if berr != nil {
		t.Fatalf("资产侧必须接受同一模块（两侧必须给出同一个结论）：%v", berr)
	}
	if got := set.Bytes(); got != int64(len(html)+len(cfg)) {
		t.Fatalf("资源集字节 = %d，期望 %d（index.html 内容 + 平台注入的配置）", got, len(html)+len(cfg))
	}

	// 两个数的**口径分解**必须对得上（任一边多算/少算一段就会破）：
	//
	//	Validate 的数 = Σ 负载(计入预算的段)
	//	              = Σ 内容(保留段) + Σ 内容(被忽略但计入的段) + Σ 段名开销(计入预算的段)
	//	资产侧的数    = Σ 内容(保留段) + len(注入配置)
	budgetedIgnored, overhead := 0, 0
	for _, c := range fixture {
		if !budgetedByRule(c.name) {
			continue
		}
		overhead += sectionPayloadBytes(c.name, len(c.content)) - len(c.content)
		if _, isKept := kept[c.name]; !isKept {
			budgetedIgnored += len(c.content)
		}
	}
	moduleSide := set.Bytes() - int64(len(cfg)) // 资产侧去掉注入配置后的"模块侧"字节
	if want := int(moduleSide) + budgetedIgnored + overhead; info.CustomBytes != want {
		t.Fatalf("两侧不是同一个测量：Validate=%d，按资产侧反推=%d"+
			"（被忽略但计入 %d 字节 + 段名开销 %d 字节）", info.CustomBytes, want, budgetedIgnored, overhead)
	}
}

// TestSectionBudgetStillRejectsOversizeAssets 是上一条的**反向对照**：
// 把 `.debug_*` 排除出预算 ≠ 取消预算 —— 计入预算的段一旦超限，必须照旧拒。
//
// 变异验证：把 CountsTowardSectionBudget 改成恒 true（或删掉 validate 的判据）⇒ 本例红。
func TestSectionBudgetStillRejectsOversizeAssets(t *testing.T) {
	big := make([]byte, limits.SectionTotalMaxBytes+1024)
	mod := buildModule(
		customSection{"big.bin", big},                     // 计入预算：超限的就是它
		customSection{".debug_info", make([]byte, 1<<20)}, // 不计入：不能靠它"分摊"
	)
	_, err := wasmmod.Validate(mod)
	if err == nil {
		t.Fatal("计入预算的段超过 4 MiB 必须被拒（排除 `.debug_*` 不是取消预算）")
	}
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeSectionOverrideOversize {
		t.Fatalf("错误码 = %v，期望 SECTION_OVERRIDE_OVERSIZE", err)
	}
	wantBytes := sectionPayloadBytes("big.bin", len(big))
	if got := e.Details["custom_bytes"]; got != wantBytes {
		t.Fatalf("details.custom_bytes = %v，期望 %d（1 MiB `.debug_info` 不得计入）", got, wantBytes)
	}
}

// ===== 与作者侧打包脚本（pack-assets.mjs）的**逐字节**对拍 =====

// packAssetsScriptPath 返回作者侧打包脚本的**绝对**路径（脚本在临时目录里执行，
// 相对路径会按 `cmd.Dir` 解析）。
//
// `PACK_ASSETS_SCRIPT` 可覆盖：变异验证/双向对拍要指向**副本**（脚本是 Node 侧判据的
// 实现，`go test -overlay` 只能替换 Go 源文件，替换不了它运行期读到的 .mjs）。
func packAssetsScriptPath(t *testing.T) string {
	t.Helper()
	path := os.Getenv("PACK_ASSETS_SCRIPT")
	if path == "" {
		path = filepath.Join("..", "..", "..", "skills", "app-builder", "scripts", "pack-assets.mjs")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatalf("解析打包脚本路径失败（%s）：%v", path, err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("打包脚本不可用（%s）：%v", abs, err)
	}
	return abs
}

// runPackAssets 在 dir 下跑一次打包脚本，返回（stdout+stderr, 退出码）。node 不可用即 Skip。
func runPackAssets(t *testing.T, dir string, args ...string) (string, int) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node 不可用，跳过与打包脚本的对拍：%v", err)
	}
	cmd := exec.Command(node, append([]string{packAssetsScriptPath(t)}, args...)...)
	cmd.Dir = dir
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	runErr := cmd.Run()
	if runErr == nil {
		return buf.String(), 0
	}
	var ee *exec.ExitError
	if !errors.As(runErr, &ee) {
		t.Fatalf("执行 node 失败：%v\n%s", runErr, buf.String())
	}
	return buf.String(), ee.ExitCode()
}

func writeFixtureFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("写夹具 %s：%v", path, err)
	}
}

// scriptBudgetTotal 抽出脚本打印的「自定义段总量 N 字节」（对拍判据依赖这个可机读的数）。
func scriptBudgetTotal(t *testing.T, stdout string) int {
	t.Helper()
	m := regexp.MustCompile(`自定义段总量 (\d+) 字节`).FindStringSubmatch(stdout)
	if m == nil {
		t.Fatalf("脚本输出里没有可机读的「自定义段总量 <N> 字节」：\n%s", stdout)
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		t.Fatalf("解析脚本的段总量失败：%v", err)
	}
	return n
}

// TestSectionBudgetBytesMatchPackAssetsScript 证明"作者在打包脚本里看到的数"与
// "Validate 判的数"是**同一个测量**（审计 D-A1/D-A3 的不变式）。
//
// 做法是真跑脚本（node）+ 用平台自己的解析器复算产出模块：
//  1. 用例侧独立算出"非 `.debug_*` 段的负载和"（含本次追加的资产）；
//  2. 脚本打印的「自定义段总量」必须等于它（被丢弃的 DWARF 不得计入）；
//  3. wasmmod.Parse(产出模块).CustomBytes 也必须等于它。
//
// 任一边单独改口径（Go 的 parse.go 或 Node 的 pack-assets.mjs）都会让本条红 ——
// 这正是"作者按一个数改、被另一个数拒"的根因判据。
func TestSectionBudgetBytesMatchPackAssetsScript(t *testing.T) {
	added := customSection{"static/extra.css", []byte("body{color:red}")}
	fixture := []customSection{
		{"index.html", []byte("<html>hi</html>")},
		{"static/app.js", []byte("console.log(1)")},
		{"name", []byte("symbol-table")},
		{"go:buildid", []byte("build-id")},
		{".debug_info", bytes.Repeat([]byte{0xab}, 4096)},
		{".debug_line", bytes.Repeat([]byte{0xcd}, 2048)},
	}
	dir := t.TempDir()
	in := filepath.Join(dir, "in.wasm")
	writeFixtureFile(t, in, buildModule(fixture...))
	src := filepath.Join(dir, "extra.css")
	writeFixtureFile(t, src, added.content)
	out := filepath.Join(dir, "out.wasm")

	stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, src+"="+added.name)
	if code != 0 {
		t.Fatalf("脚本必须接受含 `.debug_*` 的模块（它们不计入 4 MiB 预算）：\n%s", stdout)
	}

	want, debugBytes := 0, 0
	for _, c := range append(append([]customSection{}, fixture...), added) {
		if budgetedByRule(c.name) {
			want += sectionPayloadBytes(c.name, len(c.content))
		} else {
			debugBytes += sectionPayloadBytes(c.name, len(c.content))
		}
	}
	if want >= debugBytes {
		t.Fatalf("夹具不成立：计入预算的 %d 字节必须远小于被丢弃的 %d 字节（否则本条分不出对错）",
			want, debugBytes)
	}
	printed := scriptBudgetTotal(t, stdout)
	if printed != want {
		t.Fatalf("脚本报的段总量 = %d，期望 %d（非 `.debug_*` 段的负载和；被丢弃的 %d 字节不得计入）",
			printed, want, debugBytes)
	}

	packed, rerr := os.ReadFile(out)
	if rerr != nil {
		t.Fatalf("读脚本产出：%v", rerr)
	}
	info, perr := wasmmod.Parse(packed)
	if perr != nil {
		t.Fatalf("平台解析脚本产出失败：%v", perr)
	}
	if info.CustomBytes != printed {
		t.Fatalf("脚本与平台不是同一个测量：脚本报 %d 字节，wasmmod.Parse 的 CustomBytes = %d 字节",
			printed, info.CustomBytes)
	}
	if _, verr := wasmmod.Validate(packed); verr != nil {
		t.Fatalf("脚本产出必须能过平台的静态校验：%v", verr)
	}
	// 双向：平台自己的分流也必须把 `.debug_*` 排除在资源之外（两边同一批段）。
	extracted, xerr := wasmmod.ExtractCustomSections(packed)
	if xerr != nil {
		t.Fatalf("抽取自定义段：%v", xerr)
	}
	kept, _ := assets.SplitSections(extracted)
	for _, name := range []string{".debug_info", ".debug_line"} {
		if _, ok := kept[name]; ok {
			t.Fatalf("%s 不得进资源集（发布期被丢弃）", name)
		}
	}
}

// TestPreviewScriptSharesToolchainSectionPolicy 钉住"作者侧第三份实现"必须同源。
//
// 背景（2026-09-21 独立审计 P3-②）：工具链段的判定在仓库里有**三处**实现 ——
//
//	server/internal/wasmapp/assets/assets.go            （平台唯一真源：前缀 + 精确名单）
//	server/skills/app-builder/scripts/pack-assets.mjs   （打包期：与 Go 侧有行为对拍）
//	server/skills/app-builder/examples/go/preview.mjs   （本地预览：**此前没有任何对拍**）
//
// 第三份此前**没有 `.debug_` 前缀规则** ⇒ 本地预览会把几 MB 的 DWARF 当成应用资源直出，
// 作者看到"本地能打开、线上 404"，而段总量预算两侧也会给出两个数。
//
// 本用例读 `preview.mjs` 的源码，断言：
//  1. 它持有与 Go 侧**完全相同**的前缀清单（逐项集合相等，两个方向都查）；
//  2. 它持有与 Go 侧**完全相同**的精确名单；
//  3. 段名分流真的走 `isToolchainSection(...)`（排除函数定义行，否则定义本身就能满足
//     字面量断言 —— 这正是 pack-assets 那条用例被抓过的假绿形态）。
//
// 为什么是源码解析而不是跑脚本：`preview.mjs` 的段名分流在"跑一个 wasm"这条路径里
// （需要产物 + 子进程），而"清单是否同源"这件事静态可判、且失败信息更准。
// 行为面的兜底在 `TestPreviewHostSelfTest`（跑 `--selftest`）。
//
// 变异验证：把 `preview.mjs` 的 TOOLCHAIN_SECTION_PREFIXES 改成 `[]`（或把 call site
// 换回 `TOOLCHAIN_SECTION_NAMES.has(name)`）⇒ 本用例红。
func TestPreviewScriptSharesToolchainSectionPolicy(t *testing.T) {
	path := filepath.Join("..", "..", "..", "skills", "app-builder", "examples", "go", "preview.mjs")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 preview.mjs（%s）: %v", path, err)
	}
	src := string(raw)

	// 解析一个 JS 数组/集合字面量里的字符串项（与 pack-assets 那条用例同款口径）。
	parseJsList := func(constName string) []string {
		t.Helper()
		idx := strings.Index(src, constName)
		if idx < 0 {
			t.Fatalf("preview.mjs 里找不到常量 %s", constName)
		}
		rest := src[idx:]
		open := strings.IndexAny(rest, "([")
		closing := strings.IndexAny(rest, ")]")
		if open < 0 || closing < open {
			t.Fatalf("preview.mjs 的 %s 不是列表/集合字面量", constName)
		}
		var out []string
		for _, m := range regexp.MustCompile(`['"]([^'"]+)['"]`).FindAllStringSubmatch(rest[open+1:closing], -1) {
			out = append(out, m[1])
		}
		if len(out) == 0 {
			t.Fatalf("preview.mjs 的 %s 解析出 0 项（解析口径可能失效）", constName)
		}
		return out
	}

	// ① 前缀清单：双向集合相等。
	previewPrefixes := map[string]bool{}
	for _, p := range parseJsList("TOOLCHAIN_SECTION_PREFIXES") {
		previewPrefixes[p] = true
	}
	for _, p := range assets.ToolchainSectionPrefixes {
		if !previewPrefixes[p] {
			t.Fatalf("preview.mjs 缺少平台的前缀 %q（本地预览会把这类段当资源直出，与线上不一致）", p)
		}
	}
	for p := range previewPrefixes {
		found := false
		for _, want := range assets.ToolchainSectionPrefixes {
			if want == p {
				found = true
			}
		}
		if !found {
			t.Fatalf("preview.mjs 多出平台没有的前缀 %q（本地预览隐藏了线上会直出的资源）", p)
		}
	}

	// ② 精确名单：双向集合相等。
	previewNames := map[string]bool{}
	for _, n := range parseJsList("TOOLCHAIN_SECTION_NAMES") {
		previewNames[n] = true
	}
	for name := range assets.ToolchainSections {
		if !previewNames[name] {
			t.Fatalf("preview.mjs 的精确名单缺少 %q（与 assets.ToolchainSections 必须同源）", name)
		}
	}
	for name := range previewNames {
		if _, ok := assets.ToolchainSections[name]; !ok {
			t.Fatalf("preview.mjs 的精确名单多出 %q（平台并不按它分流）", name)
		}
	}

	// ③ 能力断言：分流必须经 isToolchainSection(...)，且必须排除函数定义行。
	if !strings.Contains(src, "function isToolchainSection(") {
		t.Fatal("preview.mjs 里找不到 isToolchainSection 的定义")
	}
	callSites := 0
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "function ") {
			continue
		}
		if strings.Contains(trimmed, "isToolchainSection(") {
			callSites++
		}
	}
	if callSites == 0 {
		t.Fatal("preview.mjs 定义了 isToolchainSection 却没有调用它（前缀规则是死代码）")
	}
}

package assets_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
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

// 打包脚本的拒绝清单必须与 ToolchainSections 同源（脚本头部注释里点名了它）。
// 判据直接读脚本源码：改了工具链段名单却忘了同步脚本 ⇒ 红。
func TestPackAssetsScriptRejectionListMatchesToolchainSections(t *testing.T) {
	path := filepath.Join("..", "..", "..", "skills", "app-builder", "scripts", "pack-assets.mjs")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("技能目录不在预期位置（%s）：%v", path, err)
	}
	src := string(raw)
	for name := range assets.ToolchainSections {
		if !strings.Contains(src, "'"+name+"'") && !strings.Contains(src, `"`+name+`"`) {
			t.Fatalf("pack-assets.mjs 的拒绝清单里缺少工具链段 %q —— 两边必须同源", name)
		}
	}
}

// 门禁测试：**数值单一真源**（设计基线 §5.5 第 5 行 + §9.3「SKILL 的单一真源」+
// §10.5 第 58 项「客户端上传超时 > 服务端 ReadTimeout 是配置断言」）。
//
// 这一组用例存在的理由只有一句话：**让"文档/技能里的数字与代码不一致"变成编译期错误**。
// 上限数值一旦漂移，作者会照着错的数字写代码（例如按 "16 MiB" 设计内嵌资源，
// 实际上限是 32 MiB），而这类错误在运行期只会表现为"线上莫名被拒"。
//
// 本文件里的六条门禁（每条都能真的红，变异方式见各用例注释）：
//
//	(a) TestGeneratedArtifactsAreByteIdentical —— 提交的 limits.json / limits.md /
//	    skill 里的 references/limits.md 与**生成器实时产物**逐字节一致；
//	(b) TestTableCoversEveryExportedLimit —— limits.go 的每个导出常量/变量，
//	    要么被 Table() 的某个条目的值覆盖，要么在**显式豁免表**里（含理由）；
//	(c) TestCriticalValuesAndOrdering —— "错了就是事故"的数值与 §7.3 的序关系；
//	(d) TestNoUntabledNumericLiterals —— const 声明里的数值字面量，其键必须在表里；
//	(e) TestSkillDiscipline —— SKILL 的数值全部来自 limits 表、十一条硬约束齐全、
//	    x-abi-version 与 abi 包一致、不出现真实客户域名、引用的文件都存在；
//	(f) TestSkillGoExampleBuildsForWasiP1 —— SKILL 的示例**真编译**一次（wasm32-wasip1）；
//	(g) TestAuthorDocsMatchAppConcurrency —— 作者文档的**并发语义/归因**与真源一致
//	    （(e) 只守数字，守不住"每应用串行""平台没有并发旋钮""平台固定"这类散文漂移）。
//
// 变异验证记录（交付时实跑过，勿删）：
//   - 改 Table() 里任何一个 Value 的字符串（如 wasm_max_bytes 的 "33554432" → "33554431"）
//     ⇒ (a)(e) 变红；
//   - 删 Table() 里的一条（如 instance_memory_pages 整条）⇒ (b)(d) 变红；
//   - 把 §7.3 的序关系改成 ServerReadTimeout = 90s ⇒ (c) 变红；
//   - 把 docs/wasm-app-authoring.md 与 references/diagnostics.md 的并发表述改回
//     "每应用串行 / 平台没有并发旋钮" ⇒ (g) 变红，改回即绿（2026-09-19 实跑）。
package limits_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/constant"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 路径常量（**只有这一处**：SKILL 换位置时改这里）。
const (
	limitsSourceFile = "limits.go"
	jsonRelPath      = "internal/wasmapp/limits/limits.json"
	mdRelPath        = "internal/wasmapp/limits/limits.md"
	// skillDirRelPath 是内置技能目录（仓库根相对）。源头只有这一个 ——
	// 技能源就在服务端仓库内的 `server/skills/`（2026-09-19 从客户端 vendored 包
	// packages/vendor/memory-evolve 搬来）：随服务端镜像分发
	// （server/Dockerfile 直接 COPY 进 /opt/picoaide/skills），由员工在客户端
	// 能力中心按需安装。**不在客户端包里**，也不再由 COI 同步链路落盘。
	skillDirRelPath     = "server/skills/app-builder"
	skillLimitsRelPath  = skillDirRelPath + "/references/limits.md"
	skillExampleRelPath = skillDirRelPath + "/examples/go"
	skillMainFile       = skillDirRelPath + "/SKILL.md"
	// authorDocRelPath 是仓库级作者指南：它和 SKILL 一样是"面向作者的数字载体"，
	// 因此同样受"数字必须来自 limits 表"的门禁约束（同一份纪律，两处落地）。
	authorDocRelPath      = "docs/wasm-app-authoring.md"
	regenerateHint        = "跑 `go generate ./internal/wasmapp/limits` 重新生成"
	frontmatterABIVersion = "x-abi-version"
)

// ===== (a) 生成物与源码逐字节一致 =====

// TestGeneratedArtifactsAreByteIdentical 用**真生成器**（cmd/picoaide-limits-gen）
// 在临时"假仓库"里重新生成一遍，再与提交的产物逐字节比对。
//
// 为什么要把生成器编出来跑、而不是在测试里复刻一份渲染逻辑：复刻出来的第二份实现
// 本身就是漂移源（生成器改了、测试没改 ⇒ 测试永远绿）。
//
// 变异方式（确认真能红）：把 limits.md 的第一行表格值手改一个数字 ⇒ 本用例失败并
// 打印行级差异 + "跑 go generate 重新生成"。
func TestGeneratedArtifactsAreByteIdentical(t *testing.T) {
	moduleRoot := moduleRootOf(t)
	repoRoot := filepath.Dir(moduleRoot)
	genBin := buildGenerator(t, moduleRoot)

	// 假仓库：只需要 go.mod（生成器用它确认模块根）与 skill 的 references 目录。
	fakeRepo := t.TempDir()
	fakeServer := filepath.Join(fakeRepo, "server")
	writeFile(t, filepath.Join(fakeServer, "go.mod"), []byte("module github.com/picoaide/picoaide\n\ngo 1.26\n"))
	fakeSkillRefs := filepath.Join(fakeRepo, filepath.FromSlash(skillDirRelPath), "references")
	if err := os.MkdirAll(fakeSkillRefs, 0o755); err != nil {
		t.Fatalf("创建假 skill 目录: %v", err)
	}
	runGenerator(t, genBin, "-root", fakeServer)

	pairs := []struct{ name, committed, fresh string }{
		{"limits.json", filepath.Join(moduleRoot, filepath.FromSlash(jsonRelPath)),
			filepath.Join(fakeServer, filepath.FromSlash(jsonRelPath))},
		{"limits.md", filepath.Join(moduleRoot, filepath.FromSlash(mdRelPath)),
			filepath.Join(fakeServer, filepath.FromSlash(mdRelPath))},
		{"skill references/limits.md", filepath.Join(repoRoot, filepath.FromSlash(skillLimitsRelPath)),
			filepath.Join(fakeRepo, filepath.FromSlash(skillLimitsRelPath))},
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
		if bytes.Equal(committed, fresh) {
			continue
		}
		t.Errorf("%s: 提交的生成物与实时生成结果不一致 —— %s\n%s", p.name, regenerateHint, lineDiff(committed, fresh))
	}

	// -check 是 CI 的入口，必须自己也是绿的（并且真的会红：改动产物即非零退出）。
	cmd := exec.Command(genBin, "-check", "-root", moduleRoot)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Errorf("生成器 -check 非零退出: %v\n%s\n%s", err, out, regenerateHint)
	}
}

// ===== (b) 表覆盖全部导出常量 =====

// TestTableCoversEveryExportedLimit 断言 limits.go 的每个导出声明（const/var）
// 要么被 Table() 某个条目的 Value 覆盖，要么在下面的豁免表里。
//
// **新增上限常量但忘了进表 ⇒ 本用例红**（这是 §5.5 第 5 行"数值单一真源"的落地）。
// 变异方式：在 limits.go 加 `const FooMaxBytes = 7 << 20`（不改表）⇒ 红；
// 删掉 Table() 里任一条目（如 instance_memory_pages）⇒ 红。
func TestTableCoversEveryExportedLimit(t *testing.T) {
	decls := parseExportedDecls(t, limitsSourceFile)
	if len(decls) < 60 {
		// 防"解析器空转"的假绿：limits.go 当前有 80+ 个导出声明；数量骤降只可能是
		// 解析/类型检查出了问题，而不是"上限被删光了"。
		t.Fatalf("只解析出 %d 个导出声明，远低于预期 —— AST/types 解析可能失效（假绿防线）", len(decls))
	}

	byValue := map[string][]string{}
	for _, e := range limits.Table() {
		byValue[e.Value] = append(byValue[e.Value], e.Key)
	}

	usedExemption := map[string]bool{}
	for _, d := range decls {
		if _, ok := exemptDecls[d.name]; ok {
			usedExemption[d.name] = true
			if want := exemptDecls[d.name].wantKind; want != "" && want != d.kind {
				t.Errorf("豁免表把 %s 记成 %s，实际是 %s：豁免表的理由要与代码形态一致（否则豁免会被用错地方）",
					d.name, want, d.kind)
			}
			continue
		}
		if d.kind == "var" {
			t.Errorf("导出变量 %s 既不在 limits.Table() 里、也不在豁免表里。\n"+
				"  若是可枚举的上限/枚举值 → 加进 limitsspec.go 的 Table()；否则在 limits_gen_test.go 的 exemptDecls 里写明理由。", d.name)
			continue
		}
		if d.value == "" {
			t.Errorf("导出常量 %s 的值无法求值（不是常量表达式？）：数值单一真源必须可被机器比对", d.name)
			continue
		}
		if len(byValue[d.value]) == 0 {
			t.Errorf("导出常量 %s = %s 在 limits.Table() 里没有任何同值条目 —— 新增上限必须同步进表（limitsspec.go）。\n"+
				"  若它根本不是「上限数值」（换算常量/权限位/枚举），在 limits_gen_test.go 的 exemptDecls 里写明理由后豁免。",
				d.name, d.value)
		}
	}
	// 豁免表不得留死条目：常量改名/删除后忘了清理会让"豁免"慢慢变成一张空头名单。
	for name, ex := range exemptDecls {
		if !usedExemption[name] {
			t.Errorf("豁免表里的 %s 在 limits.go 里已不存在（理由：%s）—— 请删掉这条豁免", name, ex.reason)
		}
	}
}

// exemption 是一条豁免及其**必须写清的理由**。
type exemption struct {
	reason string
	// wantKind 用于防止豁免被误用到别的形态上（"const"/"var"/空=不限）。
	wantKind string
}

// exemptDecls 是非"上限数值"的导出声明白名单。
//
// 判据（写清楚才不会被当成"为了让测试变绿"）：**它不是 §4 护栏总表里的一条上限**。
// 三类：
//  1. 标识/模式/枚举/文件名等非数值契约（Pattern / Name / DirName / 保留字 / 枚举表）；
//  2. 规范或文件系统固定的换算常量（wasm 页大小、目录权限位）——它们是"单位"或"模式"，
//     不是平台可调的上限；对应的真上限是 instance_memory_pages / instance_memory_bytes；
//  3. 平台保留列名（应用提到即拒的**名字**，不是数值）。
//
// ⚠️ 不要为了"让某条测试变绿"往这里加真正的上限：那会让 (b) 门禁失效。
var exemptDecls = map[string]exemption{
	// —— 非数值契约（正则/文件名/保留字/枚举）——
	"AppIDPattern":               {reason: "app_id 正则（字符串契约，不是数值上限）", wantKind: "const"},
	"VersionPattern":             {reason: "版本号正则（字符串契约）", wantKind: "const"},
	"TableNamePattern":           {reason: "表名正则（字符串契约）", wantKind: "const"},
	"ColumnNamePattern":          {reason: "列名正则（字符串契约）", wantKind: "const"},
	"WasmImportModule":           {reason: "唯一允许的导入模块名（字符串契约）", wantKind: "const"},
	"AppConfigFileName":          {reason: "随包配置文件名（字符串契约）", wantKind: "const"},
	"ReservedRowIDColumn":        {reason: "平台保留列名（名字，不是数值）", wantKind: "const"},
	"CompileCacheDirName":        {reason: "数据根下的目录名（名字，不是数值）", wantKind: "const"},
	"AppsDirName":                {reason: "数据根下的目录名（名字，不是数值）", wantKind: "const"},
	"ReservedAppIDs":             {reason: "app_id 保留字集合（枚举表）", wantKind: "var"},
	"RequiredExports":            {reason: "导出面必须包含的符号（枚举表）", wantKind: "var"},
	"SQLColumnTypes":             {reason: "列类型枚举（枚举表，顺序即文档顺序）", wantKind: "var"},
	"SQLColumnTypeToSQLite":      {reason: "列类型到 SQLite 类型的映射（枚举表）", wantKind: "var"},
	"AllowedStatementKinds":      {reason: "语句种类白名单（枚举表）", wantKind: "var"},
	"DeniedStatementKinds":       {reason: "显式永久禁用的语句种类（枚举表）", wantKind: "var"},
	"AppResponseHeaderAllowlist": {reason: "可设置的响应头白名单（枚举表）", wantKind: "var"},
	"AppResponseContentTypes":    {reason: "允许的 content-type 集合（枚举表）", wantKind: "var"},

	// —— 换算常量 / 权限位（不是"上限"）——
	"WasmPageSize":         {reason: "wasm 规范固定的页大小（换算单位）：真上限是 instance_memory_pages / instance_memory_bytes", wantKind: "const"},
	"DataDirMode":          {reason: "应用数据目录权限位（os.FileMode 0700，安全基线而非上限）", wantKind: "const"},
	"CompileCacheRevision": {reason: "编译缓存分代的**回落常量**（字符串，不是数值也不是上限）：分代的唯一实现是 runtime.cacheNamespace()/compile.cacheNamespaceFor()（优先 wazero 真实版本，拿不到版本时才回落到本常量）；实测更正（2026-09-18）：GetWazeroVersion() 只在 **test 二进制**里返回 dev，生产 main 二进制里返回真实版本（v1.12.0）", wantKind: "const"},
}

// ===== (c) 关键数值语义 =====

// TestCriticalValuesAndOrdering 断言"错了就是事故"的数值与 §7.3 的序关系。
//
// 为什么单独列一条：这些值串联起"上传 → 编译 → 执行"三段的预算，任何一个写错
// 都会表现为线上可复现的失败（上传超时 / 编译被杀 / 请求 504），而不是测试里的
// 一个数字。§10.5 第 58 项明确要求把序关系写成**配置断言**。
//
// 变异方式：把 ServerReadTimeout 改成 90s（或 ClientUploadTimeout 改成 30s）⇒ 红。
func TestCriticalValuesAndOrdering(t *testing.T) {
	// 体积/页数类：单位换算写出来，避免"看着像对的"。
	cases := []struct {
		name string
		got  int64
		want int64
		why  string
	}{
		{"WasmMaxBytes==32MiB", limits.WasmMaxBytes, 32 << 20, "R33：.wasm 体积上限"},
		{"UploadBodyMaxBytes==48MiB", limits.UploadBodyMaxBytes, 48 << 20, "R21：base64 JSON 上传体上限"},
		{"SectionTotalMaxBytes==4MiB", limits.SectionTotalMaxBytes, 4 << 20, "§4.2：自定义段总量上限（实测零用途却整体进内存）"},
		{"InstanceMemoryPages==1024", limits.InstanceMemoryPages, 1024, "R22：单实例 64 MiB"},
		{"AppDBMaxPageCount==25600", limits.AppDBMaxPageCount, 25600, "R2：100 MB 硬限（25600 × 4096 B）"},
		{"AppDBMaxBytes==100MB", limits.AppDBMaxBytes, int64(limits.AppDBMaxPageCount) * int64(limits.AppDBPageSize), "R2：与页数换算一致"},
		{"SQLLimitAttached==0", limits.SQLLimitAttached, 0, "§4.5：引擎层否决 ATTACH，也是 VACUUM INTO 的唯一闸门"},
		{"SQLMaxRows==5000", limits.SQLMaxRows, 5000, "§4.5：单次查询返回行数上限"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %d, want %d（%s）", c.name, c.got, c.want, c.why)
		}
	}

	durations := []struct {
		name string
		got  int64 // 毫秒
		want int64
		why  string
	}{
		{"CompileTimeout==60s", limits.CompileTimeout.Milliseconds(), 60_000, "§4.2：同步 publish 在 60 s 预算内完成"},
		{"GuestBudget==10s", limits.GuestBudget.Milliseconds(), 10_000, "§4.6：guest 执行预算"},
		{"SQLStatementBudget==5s", limits.SQLStatementBudget.Milliseconds(), 5_000, "R13：单语句硬超时"},
		{"RequestWallClock==60s", limits.RequestWallClock.Milliseconds(), 60_000, "§4.6：端到端墙钟（含排队）"},
		{"AIBridgeMaxMessages 与文档一致", int64(limits.AIBridgeMaxMessages) * 1000, 64_000, "§21.2：AI 桥 messages ≤64 条（跨端冻结契约）"},
	}
	for _, c := range durations {
		if c.got != c.want {
			t.Errorf("%s: got %dms, want %dms（%s）", c.name, c.got, c.want, c.why)
		}
	}

	// §7.3 的序关系。文档原话写作 "客户端 90 s > 服务端 ReadTimeout 60 s > 编译 60 s"，
	// 但后两个数字相等 ⇒ 中间那个 ">" 只能是 ">="（§10.5 第 58 项只断言
	// "客户端超时 > 服务端 ReadTimeout"）。按"文档自相矛盾时以实现为准并在交付说明里
	// 指出"的纪律，这里断言两条**能同时成立**的关系，而不是照抄一个不可能成立的链。
	if !(limits.ClientUploadTimeout > limits.ServerReadTimeout) {
		t.Errorf("序关系被破坏：客户端上传超时(%s) 必须 > 服务端 ReadTimeout(%s)（§4.2 / §10.5 第 58 项）",
			limits.ClientUploadTimeout, limits.ServerReadTimeout)
	}
	if !(limits.ServerReadTimeout >= limits.CompileTimeout) {
		t.Errorf("序关系被破坏：服务端 ReadTimeout(%s) 必须 >= 编译超时(%s)（同步 publish 在 ReadTimeout 预算内返回）",
			limits.ServerReadTimeout, limits.CompileTimeout)
	}
	if !(limits.RequestWallClock > limits.GuestBudget) {
		t.Errorf("序关系被破坏：端到端墙钟(%s) 必须 > guest 预算(%s)（留给排队与宿主调用）",
			limits.RequestWallClock, limits.GuestBudget)
	}
}

// ===== (d) const 声明里的数值字面量必须在表里 =====

// TestNoUntabledNumericLiterals 用 AST 扫描 limits.go 的 **const 声明**，
// 收集出现在值表达式里的数值字面量，断言该常量对应的表键存在。
//
// 与 (b) 互补：(b) 断言"值被表覆盖"（值相等即可，(d) 断言"键存在"（名字对得上）。
// 两条一起才能同时挡住"忘了进表"与"进表但键名写错/张冠李戴"。
//
// 变异方式：在 limits.go 写 `const FooMaxBytes = 7 << 20` 且不进表 ⇒ 红。
func TestNoUntabledNumericLiterals(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, limitsSourceFile, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析 %s: %v", limitsSourceFile, err)
	}
	keys := map[string]bool{}
	for _, e := range limits.Table() {
		keys[e.Key] = true
	}

	literals := 0
	ast.Inspect(file, func(n ast.Node) bool {
		decl, ok := n.(*ast.GenDecl)
		if !ok || decl.Tok != token.CONST {
			return true
		}
		for _, spec := range decl.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			// 每个 ValueSpec 的 Values 与 Names 按位置对应（limits.go 里是一对一）。
			for i, v := range vs.Values {
				if !hasNumericLiteral(v) {
					continue
				}
				literals++
				if i >= len(vs.Names) {
					continue
				}
				name := vs.Names[i].Name
				if _, exempt := exemptDecls[name]; exempt {
					continue
				}
				key := snakeCase(name)
				if !keys[key] {
					t.Errorf("const %s 的声明里有数值字面量（%s），但表里没有键 %q —— "+
						"新增上限必须同时进 limitsspec.go 的 Table()；若它不是上限，在 exemptDecls 里写明理由",
						name, literalText(v), key)
				}
			}
		}
		return true
	})
	if literals < 40 {
		t.Fatalf("只扫到 %d 个数值字面量，远低于预期 —— AST 扫描可能失效（假绿防线）", literals)
	}
}

// hasNumericLiteral 报告表达式树里是否出现数值字面量（整数/浮点；字符常量不算）。
func hasNumericLiteral(expr ast.Expr) bool {
	found := false
	ast.Inspect(expr, func(n ast.Node) bool {
		lit, ok := n.(*ast.BasicLit)
		if ok && (lit.Kind == token.INT || lit.Kind == token.FLOAT) {
			found = true
			return false
		}
		return true
	})
	return found
}

// literalText 把表达式里的数值字面量拼成一行，供报错信息使用。
func literalText(expr ast.Expr) string {
	var parts []string
	ast.Inspect(expr, func(n ast.Node) bool {
		if lit, ok := n.(*ast.BasicLit); ok && (lit.Kind == token.INT || lit.Kind == token.FLOAT) {
			parts = append(parts, lit.Value)
		}
		return true
	})
	return strings.Join(parts, ", ")
}

// ===== (e) SKILL 交付物纪律 =====

// TestSkillDiscipline 守 SKILL 这一侧的三条纪律：
//  1. **数值必须来自 limits 表**：SKILL/参考文档里出现的每个"数字+单位"都必须在
//     limits.json 里找到同量纲同值的条目（§9.3「单一真源」）；
//  2. **十一条硬约束齐全**（§9.4 写进 skill 首屏）；
//  3. **客户可见交付物纪律**：不出现真实客户域名（只允许占位符）、引用的文件都在、
//     x-abi-version 与 abi 包一致。
//
// 变异方式：把 SKILL 里 "32 MiB" 改成 "31 MiB"，或删掉十一条里的一条 ⇒ 红。
func TestSkillDiscipline(t *testing.T) {
	skillDir := filepath.Join(repoRootOf(t), filepath.FromSlash(skillDirRelPath))
	if _, err := os.Stat(skillDir); err != nil {
		t.Fatalf("内置技能目录不存在: %v\n  （预期位置：%s；若 SKILL 移位，改 limits_gen_test.go 的 skillDirRelPath）",
			err, filepath.FromSlash(skillDirRelPath))
	}

	skill := readFileString(t, filepath.Join(skillDir, "SKILL.md"))

	// —— 1. 十一条硬约束（§9.4）——
	if n := countOrderedRules(skill, "十一条"); n != 11 {
		t.Errorf("SKILL.md 的「十一条硬约束」数出 %d 条，§9.4 要求恰好 11 条", n)
	}

	// —— 2. x-abi-version 与 abi 包一致 ——
	if !strings.Contains(skill, frontmatterABIVersion+": "+abi.ABIVersion) {
		t.Errorf("SKILL.md 的 frontmatter 必须写 `%s: %s`（与 abi.ABIVersion 同源；ABI 改版时技能必须跟着改）",
			frontmatterABIVersion, abi.ABIVersion)
	}

	// —— 3. 引用的文件必须存在（skill 是整目录同步的，缺文件就是坏技能）——
	for _, ref := range referencedSkillFiles(skill) {
		if _, err := os.Stat(filepath.Join(skillDir, filepath.FromSlash(ref))); err != nil {
			t.Errorf("SKILL.md 引用了 %s，但该文件不存在: %v", ref, err)
		}
	}

	// —— 4. 数值来自 limits 表 + 5. 不出现真实客户域名 ——
	facts := loadLimitFacts(t, filepath.Join(moduleRootOf(t), filepath.FromSlash(jsonRelPath)))
	for _, rel := range skillScannedFiles(t, skillDir) {
		text := readFileString(t, filepath.Join(skillDir, filepath.FromSlash(rel)))
		checkNumbersComeFromLimits(t, filepath.ToSlash(filepath.Join(skillDirRelPath, rel)), text, facts)
		checkHostnamesArePlaceholders(t, rel, text)
	}

	// 作者文档与 SKILL 同纪律（同一批数字，两个交付面）。
	docPath := filepath.Join(repoRootOf(t), filepath.FromSlash(authorDocRelPath))
	doc := readFileString(t, docPath)
	checkNumbersComeFromLimits(t, authorDocRelPath, doc, facts)
	checkHostnamesArePlaceholders(t, authorDocRelPath, doc)
}

// ===== (g) 作者文档的并发语义必须与真源一致 =====

// authorFacingConcurrencyDocs 是三份"作者会照着他写代码"的散文载体。
//
// 为什么是这三份：`references/limits.md` 与 `limits.md` 是生成物（(a) 已逐字节守），
// 而 `SKILL.md`（技能首屏，作者最先读）、`references/diagnostics.md`（排障时读）与仓库级
// `docs/wasm-app-authoring.md` 是**手写**的并发表述载体 —— 复验（2026-09-19）实测：
// 往 SKILL.md 塞回旧文案时旧版门禁全绿，所以它必须进扫描集。
// 仍然不扫全仓：`docs/decisions/**`、`limits.go`、`queue.go` 里的"每应用串行"是**历史叙述**
// （解释 2026-09-19 之前的行为），全仓扫描会把它们判成漂移。
// 代价（认账）：`abi.md` / `publishing.md` / `app-config.md` 目前没有并发表述；将来若在这些
// 文件里新增，需要把它们加进本表。
var authorFacingConcurrencyDocs = []struct {
	rel string
	why string
}{
	{authorDocRelPath, "仓库级作者指南：§2.2「从作者视角看不能做」与 §9「容易做错的地方」各有一处并发表述"},
	{skillMainFile, "SKILL 首屏（作者最先读的那份）：「并发与队列」一节给出口径"},
	{skillDirRelPath + "/references/diagnostics.md", "SKILL 参考：`APP_QUEUE_FULL` 一行与「只在人多的时候失败」一条都教作者怎么应对排队"},
}

// concurrencyDriftClaims 是"与真源矛盾"的并发表述（**不是**"出现串行就红"）。
//
// 每条只覆盖**平台语义被说错**的说法：写路径确实串行（appdb 单写者），所以
// "写仍串行" / "每应用写串行" 是**正确**表述，必须放过 —— 这也是模式里不允许出现"写"、
// 且刻意不收"只能"（"同一应用只串行写"会被误伤）的原因。
var concurrencyDriftClaims = []struct {
	name string
	re   *regexp.Regexp
}{
	{
		// 每应用串行 / 同一应用内请求串行 / 每个应用默认仍然串行 / 同应用顺序执行 …
		name: "把每应用请求说成串行",
		re: regexp.MustCompile(
			`(?:每|同)(?:一)?(?:个)?应用(?:内|上|里)?的?(?:全部|所有)?(?:请求|调用|读|查询)?` +
				`(?:默认|始终|一律|永远|仍|仍然|依然|还是|都)?(?:是)?(?:串行|顺序执行)`),
	},
	{
		// 平台没有并发旋钮 / 无并发参数 / 不存在并发开关 / 不给并发配置项 …
		// 作者侧改不了是真的，但**平台有**运维可在控制台改的全局值（应用中心 → 限制项），
		// 旧文案正是在这里把"作者不可调"错写成"平台没有"。
		name: "说平台没有并发旋钮",
		re: regexp.MustCompile(
			`(?:没有|无|不存在|不给|不带)[^。；\n]{0,8}并发[^。；\n]{0,6}(?:旋钮|参数|选项|开关|配置|设置)`),
	},
}

// concurrencyFixednessItems 是"控制台可调、却曾被文档说成固定"的项。
//
// 复验（2026-09-19）在 `docs/wasm-app-authoring.md` 抓到的正是这一类：把 `app_queue`
// （默认 32、可调到 4096）、`max_instances`（默认 32、可调到 256）、`user_per_app_queued` /
// `user_global_running`（默认 4）写成"平台固定"。它们是**默认值**，运维可在控制台改。
// name 用于报错；re 是文档里指代该项的说法（含 JSON 键名，便于直接引用控制台字段）。
var concurrencyFixednessItems = []struct {
	name string
	re   *regexp.Regexp
}{
	{"每应用队列（app_queue）", regexp.MustCompile(`队列|app_queue`)},
	{"全局并发实例（max_instances）", regexp.MustCompile(`全局实例|实例上限|实例池|max_instances`)},
	{"单用户同应用占槽（user_per_app_queued）", regexp.MustCompile(`占槽|同应用排队|user_per_app_queued`)},
	{"单用户跨应用在跑（user_global_running）", regexp.MustCompile(`跨应用在跑|user_global_running`)},
	{"单用户同应用在跑（user_per_app_running）", regexp.MustCompile(`同应用在跑|user_per_app_running`)},
	{"每应用并发（app_running）", regexp.MustCompile(`并发|app_running`)},
}

// fixednessWordRe 是"说成固定/不可调"的词形。
var fixednessWordRe = regexp.MustCompile(`固定|不可调|不能调|无法调|改不了|调不了`)

// authorCannotToken 是"作者不可调"的替身。
//
// "作者不可调（运维可在控制台改）"是**正确**归因，但字面含"不可调" ⇒ 先换成这个 token：
// 它既算补正标记（同句说了可调），又不会在 masking 时被拆成"可调"自我洗白。
const authorCannotToken = "__AUTHOR_CANNOT_TUNE__"

// fixednessCorrectiveRe 是"同句已给出可调/默认值口径"的补正标记。
// ⚠️ 刻意不含裸"可调"：否则"不可调"会把自己洗白（"不可调整"同理，故 fixednessIsCorrected 先做 masking）。
var fixednessCorrectiveRe = regexp.MustCompile(
	`默认值|不是固定|非固定|` + authorCannotToken +
		`|可调整|可调节|可改|能改|可配置|可设置|可调到|可调至|可调范围|运维可改|运维可调|控制台可改|控制台可调`)

// fixednessIsCorrected 判断一个子句是否已经给出"默认值/可调"的补正。
func fixednessIsCorrected(clause string) bool {
	masked := strings.ReplaceAll(clause, "作者不可调", authorCannotToken)
	for _, f := range []string{"不可调整", "不可调", "不能调", "无法调", "调不了", "改不了"} {
		masked = strings.ReplaceAll(masked, f, "×")
	}
	return fixednessCorrectiveRe.MatchString(masked)
}

// splitClauses 把散文切成子句（。；与换行；`|` 不切 —— markdown 表格的一行就是一句）。
func splitClauses(flat string) []string {
	return strings.FieldsFunc(flat, func(r rune) bool { return r == '。' || r == '；' || r == '\n' })
}

// clipRunes 按字符（不是字节）截断，避免把中文切成半个字。
func clipRunes(s string, maxRunes int) string {
	r := []rune(s)
	if len(r) <= maxRunes {
		return s
	}
	return string(r[:maxRunes]) + "…"
}

// checkAdjustableItemsAreNotCalledFixed 断言"控制台可调项"没有被描述成固定/不可调。
//
// 判据是**子句级**的：一个子句里同时出现"可调项"与"固定/不可调"字样，而整句没有任何
// "默认值 / 可调 / 作者不可调"补正 ⇒ 报错。
func checkAdjustableItemsAreNotCalledFixed(t *testing.T, rel, flat string) {
	t.Helper()
	for _, clause := range splitClauses(flat) {
		if !fixednessWordRe.MatchString(clause) {
			continue
		}
		for _, item := range concurrencyFixednessItems {
			hit := item.re.FindString(clause)
			if hit == "" {
				continue
			}
			if fixednessIsCorrected(clause) {
				break
			}
			t.Errorf("%s 把控制台可调项说成固定/不可调（%s，命中 %q）：…%s…\n"+
				"  这些项是**默认值**不是固定值：app_queue 默认 32（可调到 4096）、max_instances 默认 32（可调到 256）、"+
				"user_per_app_queued / user_global_running 默认 4，运维可在控制台「应用中心 → 限制项」改。\n"+
				"  正确写法：\"作者不可调（运维可在控制台…改）\"＋\"都是默认值\"；不要写\"平台固定 / 全部固定\"。",
				rel, item.name, hit, clipRunes(clause, 60))
			break
		}
	}
}

// concurrencyNumberClaimRe 抓"<数字>（个|路）请求？并发"这种把数值写进并发表述的形态。
var concurrencyNumberClaimRe = regexp.MustCompile(`([0-9]+)\s*(?:个|路)?\s*请求?并发`)

// precededByOtherLimitItem 判断数值前紧邻的是不是别的可调项（如"队列 32 个请求并发"），
// 是则不算"每应用并发"的数值声明（那是在说队列长度）。
func precededByOtherLimitItem(flat string, at int) bool {
	from := max(0, at-24)
	if from >= at {
		return false
	}
	return regexp.MustCompile(`队列|实例|占槽|排队|在跑|app_queue|max_instances`).MatchString(flat[from:at])
}

// TestAuthorDocsMatchAppConcurrency 守"作者文档里的并发语义与 limits 真源一致"。
//
// 背景（2026-09-19）：平台把"同应用请求串行"改成"每应用默认 4 个并发（**读并发**；
// 写仍串行），但单个用户在同一应用内默认仍只有 1 路"，队列/实例等上限从编译期常量
// 变成控制台可改项（默认值不变）。生成物由 (a) 逐字节守住，但**散文**两处漂移了；
// 而 (e) 只守"数字+单位"，守不住"每应用串行""平台没有并发旋钮""平台固定"这类句子。
//
// 判据（全部用真源值，不硬编码 4）：
//  1. `AppConcurrency > 1` 时，文档不得出现 concurrencyDriftClaims 里的说法（串行/没有旋钮）；
//  2. 文档不得把 concurrencyFixednessItems 里的**控制台可调项**说成固定/不可调
//     （子句级，且同句有"默认值/可调"补正时放过）；
//  3. 每份文档都必须有"并发"与真源数值**同句**（相距 ≤20 字符、不跨句/跨行）出现的表述；
//  4. 任何"<数字> 个/路 请求并发"的写法都必须等于真源数值（防"文件里两处数字不一致"）；
//  5. `AppConcurrency == 1`（真回到串行）时整条门禁自动让位 —— 那时"每应用串行"是**对的**，
//     值驱动的门禁不能把历史语义钉死。
//
// 刻意**不**写成"断言某个整句存在"：断言的是"矛盾说法不出现 + 真源数值就在这句话里"。
// 已知边界（复验 2026-09-19 实测，不假装没有）：
//   - 换一套完全不含关键词的说法（如"同一应用一次只处理一个请求"）能绕过 1/2；
//   - 数值锚 3 是**文件级**的（同文件另一行写着真源数值即可满足），只有 4 能抓"同一形态的数字写错"；
//   - 只守散文不守实现：把 queue/appdb 改回串行而文档不动，本用例抓不到（那是 queue/appdb 测试的活）。
//
// 变异方式（2026-09-19 实跑，命令与输出见交付报告）：
//   - 两处文案改回"每应用串行 / 平台没有并发旋钮" ⇒ 红；
//   - 把"平台固定"写回并发表述 ⇒ 红（第 2 条）；
//   - 往 SKILL.md 追加旧文案 ⇒ 红（第 1 条，SKILL.md 已在扫描集里）；
//   - 把某处写成"2 个请求并发"而别处仍写 4 ⇒ 红（第 4 条）；
//   - 把 `AppConcurrency` 改回 1（并同步生成物）⇒ 只打 Log 不拦（第 5 条）。
func TestAuthorDocsMatchAppConcurrency(t *testing.T) {
	// 两个别名分叉会让"每应用并发到底几个"这句话本身失去指代 —— 先钉住它。
	if limits.AppRuntimeConcurrency != limits.AppConcurrency {
		t.Errorf("AppRuntimeConcurrency(%d) != AppConcurrency(%d)：队列槽位与文档口径必须同源",
			limits.AppRuntimeConcurrency, limits.AppConcurrency)
	}

	concurrency := limits.AppConcurrency
	wantNumber := strconv.Itoa(concurrency)
	repoRoot := repoRootOf(t)

	for _, doc := range authorFacingConcurrencyDocs {
		text := readFileString(t, filepath.Join(repoRoot, filepath.FromSlash(doc.rel)))

		if concurrency <= 1 {
			// 串行语义下旧表述是对的：门禁自动让位，只在日志里留一句（免得"门禁悄悄失效"）。
			t.Logf("%s 未受并发语义约束：AppConcurrency=%d 表示同应用请求仍是串行（%s）",
				doc.rel, concurrency, doc.why)
			continue
		}

		// 中文散文按列宽折行，说法可能被换行切开 ⇒ 先把换行去掉再扫（短句内的跨行拼接
		// 不会制造误报：两条模式都要求词紧挨着，句子边界上的"。"不在允许的间隔里）。
		flat := strings.ReplaceAll(text, "\n", "")

		// —— 1. 旧漂移说法（串行 / 没有旋钮）——
		for _, claim := range concurrencyDriftClaims {
			if loc := claim.re.FindStringIndex(flat); loc != nil {
				t.Errorf("%s 出现与真源矛盾的并发表述（%s）：…%s…\n"+
					"  AppConcurrency=%d 表示同一应用最多 %d 个请求并发（读并发；**写仍串行**；单个用户在同一应用内默认仍只有 1 路），"+
					"运维可在控制台「应用中心 → 限制项」改全局值。\n"+
					"  正确口径见 %s 的「想调并发 / 队列参数」一行的写法：写成\"作者不可调（运维可在控制台改）\"，不要写成\"平台没有\"。",
					doc.rel, claim.name, clip(flat[max(0, loc[0]-24):min(len(flat), loc[1]+24)]),
					concurrency, concurrency, authorDocRelPath)
			}
		}

		// —— 2. 把"控制台可调项"说成固定/不可调 ——
		checkAdjustableItemsAreNotCalledFixed(t, doc.rel, flat)

		// —— 3. 数值锚（文件级）：必须告诉作者真实的默认并发 ——
		num := regexp.QuoteMeta(wantNumber)
		valueAnchor := regexp.MustCompile(`(?:并发[^。；\n]{0,20}?` + num + `|` + num + `[^。；\n]{0,20}?并发)`)
		if !valueAnchor.MatchString(text) {
			t.Errorf("%s 里找不到「并发」与真源数值 %d 同句出现的表述 —— 文档必须告诉作者真实的默认并发，"+
				"只把旧说法删掉不算修好（真源：limits.AppConcurrency）。若默认值真的变了，"+
				"请同步本文档的并发表述（数值本身以 limits.go 为准）。", doc.rel, concurrency)
		}

		// —— 4. 数值锚（逐处）："<数字> 个/路 请求并发"必须等于真源值 ——
		for _, m := range concurrencyNumberClaimRe.FindAllStringSubmatchIndex(flat, -1) {
			if precededByOtherLimitItem(flat, m[0]) {
				continue
			}
			if got := flat[m[2]:m[3]]; got != wantNumber {
				t.Errorf("%s 的并发表述写成 %q（…%s…），与真源 AppConcurrency=%d 不一致 —— "+
					"同一份文档里出现两个并发数字时，作者只会照错的那个设计。",
					doc.rel, got, clipRunes(flat[max(0, m[0]-16):min(len(flat), m[1]+16)], 40), concurrency)
			}
		}
	}
}

// skillScannedFiles 返回被扫描的 skill 文本文件（含生成物？**不含** limits.md：
// 它就是生成物本身，逐字节一致由 (a) 守）。
func skillScannedFiles(t *testing.T, skillDir string) []string {
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
		if rel == "references/limits.md" {
			return nil // 生成物
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
	if len(out) < 6 {
		t.Fatalf("只找到 %d 个 skill 文本文件（SKILL.md + references + examples 应当都在）: %v", len(out), out)
	}
	return out
}

// countOrderedRules 数出某个小节里的有序列表条目数（`1.` `2.` …）。
func countOrderedRules(text, headingKeyword string) int {
	lines := strings.Split(text, "\n")
	inSection := false
	n := 0
	re := regexp.MustCompile(`^\d+\.\s`)
	for _, ln := range lines {
		if strings.HasPrefix(ln, "#") {
			if inSection {
				break // 到了下一节
			}
			inSection = strings.Contains(ln, headingKeyword)
			continue
		}
		if inSection && re.MatchString(ln) {
			n++
		}
	}
	return n
}

// referencedSkillFiles 抠出 SKILL.md 里出现的 `references/x.md` / `examples/...` 相对路径。
func referencedSkillFiles(skill string) []string {
	re := regexp.MustCompile("`((?:references|examples)/[A-Za-z0-9_./-]+)`")
	seen := map[string]bool{}
	var out []string
	for _, m := range re.FindAllStringSubmatch(skill, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// limitFacts 是"limits 表里存在的事实"集合：量纲 → 该量纲下的全部取值。
type limitFacts struct {
	// bytes 是字节量纲的全部取值（Unit=bytes）。
	bytes map[int64]string
	// seconds 是时间量纲的全部取值（Unit=seconds 与 days 都折算成秒）。
	seconds map[int64]string
	// pages / count / percent 是各自量纲的取值。
	pages   map[int64]string
	count   map[int64]string
	percent map[int64]string
}

// loadLimitFacts 从**提交的** limits.json 读出全部事实（不是从 Table() 现算：
// 门禁要守的正是"提交的产物"）。
func loadLimitFacts(t *testing.T, path string) limitFacts {
	t.Helper()
	raw := readFileString(t, path)
	var doc struct {
		Items []struct {
			Key   string
			Value string
			Unit  string
		}
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("解析 %s: %v", path, err)
	}
	f := limitFacts{
		bytes:   map[int64]string{},
		seconds: map[int64]string{},
		pages:   map[int64]string{},
		count:   map[int64]string{},
		percent: map[int64]string{},
	}
	put := func(m map[int64]string, v int64, key string) {
		if _, ok := m[v]; !ok {
			m[v] = key
		}
	}
	for _, it := range doc.Items {
		n, err := strconv.ParseFloat(it.Value, 64)
		if err != nil {
			continue // 正则/枚举等非数值条目
		}
		switch it.Unit {
		case "bytes":
			put(f.bytes, int64(n), it.Key)
		case "seconds":
			put(f.seconds, int64(n), it.Key)
		case "days":
			put(f.seconds, int64(n)*86400, it.Key)
		case "pages":
			put(f.pages, int64(n), it.Key)
		case "count":
			put(f.count, int64(n), it.Key)
		case "percent":
			put(f.percent, int64(n), it.Key)
		}
	}
	// 防"读到的条目太少"的假绿：这些是当前表的下界（同值条目会去重，所以不是条目数本身）。
	if len(f.bytes) < 10 || len(f.seconds) < 8 || len(f.count) < 15 || len(f.pages) < 2 || len(f.percent) < 1 {
		t.Fatalf("从 limits.json 读到的条目太少（bytes=%d seconds=%d count=%d pages=%d percent=%d）—— 产物可能被改坏",
			len(f.bytes), len(f.seconds), len(f.count), len(f.pages), len(f.percent))
	}
	return f
}

// numberUnitRe 匹配"数字 + 可选空格 + 单位词"。
// 单位词表刻意只收**有量纲**的写法（MiB/秒/分钟/次/行…）：无单位的数字
// （HTTP 状态码、版本号、端口）不参与断言，否则门禁会变成噪音机器。
var numberUnitRe = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)\s*(KiB|MiB|GiB|KB|MB|GB|字节|秒|分钟|小时|天|次|行|条|张|个|列|页|字符|%)`)

// checkNumbersComeFromLimits 断言文本里每个"数字+单位"都能在 limits 表里找到同量纲同值的条目。
func checkNumbersComeFromLimits(t *testing.T, rel, text string, facts limitFacts) {
	t.Helper()
	for _, line := range strings.Split(text, "\n") {
		for _, m := range numberUnitRe.FindAllStringSubmatch(line, -1) {
			num, err := strconv.ParseFloat(m[1], 64)
			if err != nil {
				continue
			}
			unit := m[2]
			ok, detail := factLookup(facts, num, unit)
			if !ok {
				t.Errorf("%s: 「%s %s」在 limits 表里没有同量纲同值的条目 —— SKILL 的每个上限数字都必须来自 limits.go。\n"+
					"  改正方式：①改用表里的真实数值（references/limits.md 是生成物，照它抄）；"+
					"②确实是新上限 ⇒ 先加进 limitsspec.go 的 Table() 再重新生成。", rel, m[1], unit)
				continue
			}
			_ = detail
		}
	}
}

// factLookup 按量纲查值。字节量纲同时接受 SI（1 MB=1e6）与二进制（1 MiB=2^20）两种解读：
// 设计文档里 "100 MB" 与 limits 的 100 MiB 是同一个上限的两种写法（104857600 B）。
func factLookup(f limitFacts, num float64, unit string) (bool, string) {
	lookup := func(m map[int64]string, v int64) (bool, string) {
		key, ok := m[v]
		return ok, key
	}
	switch unit {
	case "字节":
		return lookup(f.bytes, int64(num))
	case "KiB":
		return anyOf(lookup, f.bytes, num, 1024)
	case "MiB":
		return anyOf(lookup, f.bytes, num, 1<<20)
	case "GiB":
		return anyOf(lookup, f.bytes, num, 1<<30)
	case "KB":
		return anyOf(lookup, f.bytes, num, 1000)
	case "MB":
		ok, key := anyOf(lookup, f.bytes, num, 1e6)
		if ok {
			return true, key
		}
		return anyOf(lookup, f.bytes, num, 1<<20) // 文档常写 MB 实指 MiB
	case "GB":
		ok, key := anyOf(lookup, f.bytes, num, 1e9)
		if ok {
			return true, key
		}
		return anyOf(lookup, f.bytes, num, 1<<30)
	case "秒":
		return lookup(f.seconds, int64(num))
	case "分钟":
		return lookup(f.seconds, int64(num*60))
	case "小时":
		return lookup(f.seconds, int64(num*3600))
	case "天":
		return lookup(f.seconds, int64(num*86400))
	case "页":
		return lookup(f.pages, int64(num))
	case "%":
		return lookup(f.percent, int64(num))
	case "次", "行", "条", "张", "个", "列", "字符":
		return lookup(f.count, int64(num))
	}
	return false, ""
}

func anyOf(lookup func(map[int64]string, int64) (bool, string), m map[int64]string, num, scale float64) (bool, string) {
	return lookup(m, int64(num*scale))
}

// placeholderHostRe 匹配看起来像主机名的串（含点 + 常见 TLD）。
var placeholderHostRe = regexp.MustCompile(`\b[a-z0-9][a-z0-9.-]*\.(?:com|cn|net|org|io|vip|local|dev)\b`)

// checkHostnamesArePlaceholders 断言 SKILL 里只出现占位符域名（客户可见交付物纪律，
// 见 AGENTS.md：真实客户/部署域名与主机名禁止入库）。
//
// 这里用**正向形态**断言（只允许 example.com 族 + 明确占位符），而不是黑名单比对：
// 黑名单写法本身就要把真实域名写进仓库，等于把违规内容再抄一遍。
func checkHostnamesArePlaceholders(t *testing.T, rel, text string) {
	t.Helper()
	allowed := map[string]bool{
		"harness.example.com": true,
		"notes.example.com":   true,
		"example.com":         true,
		"picoaide.app.json":   false, // 文件名，不是主机名（下面按后缀放过）
	}
	for _, host := range placeholderHostRe.FindAllString(text, -1) {
		if strings.HasSuffix(host, ".example.com") || host == "example.com" {
			continue
		}
		if allowed[host] {
			continue
		}
		// 形如 notes.example.com 之外的都拒；`picoaide.app.json` 这类文件名由
		// 调用方在文本里以反引号包裹，正则可能命中 ⇒ 用扩展名白名单放过。
		if strings.HasSuffix(host, ".json") || strings.HasSuffix(host, ".md") || strings.HasSuffix(host, ".go") {
			continue
		}
		t.Errorf("%s: 出现疑似真实主机名 %q —— skill 是客户可见交付物，只允许 harness.example.com 这类占位符", rel, host)
	}
}

// ===== (f) 示例真编译（wasm32-wasip1）=====

// TestSkillGoExampleBuildsForWasiP1 真编译 SKILL 的 Go 示例。
//
// 为什么必须在门禁里编译：示例是"黄金路径"的载体，作者与 AI 直接照抄；
// 一个编译不过的示例比没有示例更糟（会把人带到"平台是不是不支持 Go"的怀疑上）。
//
// 变异方式：在示例里写一个语法错误或引用不存在的包 ⇒ 红。
func TestSkillGoExampleBuildsForWasiP1(t *testing.T) {
	dir := filepath.Join(repoRootOf(t), filepath.FromSlash(skillExampleRelPath))
	if _, err := os.Stat(filepath.Join(dir, "go.mod")); err != nil {
		t.Fatalf("示例目录缺少 go.mod(%v)：示例必须是可独立 `go build` 的模块（作者会把整个目录拷走）", err)
	}
	out := filepath.Join(t.TempDir(), "shared-notes.wasm")
	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("示例编译失败（GOOS=wasip1 GOARCH=wasm go build）: %v\n%s", err, b)
	}
	st, err := os.Stat(out)
	if err != nil {
		t.Fatalf("编译产物不存在: %v", err)
	}
	if st.Size() == 0 {
		t.Fatalf("编译产物是空文件")
	}
	// .wasm 魔数（\0asm）——确认产物真是 wasm，而不是"编译器没跑但退出了 0"。
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("读取产物: %v", err)
	}
	if len(b) < 8 || !bytes.Equal(b[:4], []byte{0x00, 0x61, 0x73, 0x6d}) {
		t.Fatalf("产物不是 wasm 模块（魔数不符）")
	}
	if int64(len(b)) > int64(limits.WasmMaxBytes) {
		t.Errorf("示例产物 %d 字节超过平台的 .wasm 上限 %d 字节", len(b), limits.WasmMaxBytes)
	}
	t.Logf("示例产物大小: %d 字节", len(b))
}

// ===== 通用解析/工具 =====

// exportedDecl 是一个导出声明（const 或 var）与它的取值形态。
type exportedDecl struct {
	name  string
	kind  string // "const" | "var"
	value string // 常量值（整数十进制 / time.Duration 的秒 / 字符串原样）；不可求值则空
}

// parseExportedDecls 用 go/parser + go/types 收集 limits.go 的导出声明。
//
// 为什么用 go/types 而不是自己求值 AST：limits.go 里有 `90 * time.Second` 这类
// 表达式，手写求值器要跟 Go 的常量语义（移位、无类型常量、time.Duration 量纲）
// 赛跑；types.Info.Defs 直接给出常量值与类型，是唯一稳的做法。
func parseExportedDecls(t *testing.T, filename string) []exportedDecl {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filename, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析 %s: %v", filename, err)
	}
	info := &types.Info{Defs: map[*ast.Ident]types.Object{}}
	conf := types.Config{
		// source importer：不依赖 GOROOT 下预编译的导出数据（现代 Go 不带 .a），
		// 从源码解析 time 等依赖 —— CI 与本地行为一致。
		Importer: importer.ForCompiler(fset, "source", nil),
		Error:    func(error) {}, // 单个类型错误不致命：只影响那一项的可求值性
	}
	if _, err := conf.Check("limits", fset, []*ast.File{file}, info); err != nil {
		// 这里有可能是"依赖解析失败"（环境问题）也可能是"源码真的类型不通"。
		// 两者都不能放过：下面的数量防线会让空结果立刻暴露。
		t.Logf("类型检查 %s 报错（若下面的断言失败，先怀疑这里）: %v", filename, err)
	}

	var out []exportedDecl
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || (gen.Tok != token.CONST && gen.Tok != token.VAR) {
			continue
		}
		kind := "var"
		if gen.Tok == token.CONST {
			kind = "const"
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, name := range vs.Names {
				if !name.IsExported() {
					continue
				}
				d := exportedDecl{name: name.Name, kind: kind}
				if obj, ok := info.Defs[name].(*types.Const); ok {
					d.value = constValueString(obj)
				}
				out = append(out, d)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

// constValueString 把常量渲染成与 limits.Table() 里 Value 相同的字符串形态。
//
// 关键：**time.Duration 用秒**（limitsspec.go 的 secs() 就是 `%g` 的秒数），
// 其余整数用十进制。
func constValueString(c *types.Const) string {
	val := c.Val()
	if val == nil || val.Kind() == constant.Unknown {
		return ""
	}
	if c.Type() != nil && c.Type().String() == "time.Duration" {
		ns, ok := constant.Int64Val(val)
		if !ok {
			return ""
		}
		return strconv.FormatFloat(float64(ns)/1e9, 'g', -1, 64)
	}
	switch val.Kind() {
	case constant.Int:
		if n, ok := constant.Int64Val(val); ok {
			return strconv.FormatInt(n, 10)
		}
		if u, ok := constant.Uint64Val(val); ok {
			return strconv.FormatUint(u, 10)
		}
	case constant.Float:
		f, _ := constant.Float64Val(val)
		return strconv.FormatFloat(f, 'g', -1, 64)
	case constant.String:
		return constant.StringVal(val)
	case constant.Bool:
		return strconv.FormatBool(constant.BoolVal(val))
	}
	return ""
}

// snakeCase 把导出常量名转成 limits 表的键（MaxAppIDLen → max_app_id_len）。
//
// 缩写词的处理与 limitsspec.go 的既有键名一致：大写串里最后一个大写字母若紧跟
// 小写字母，则在它前面断词（SQLLimitVDBEOp → sql_limit_vdbe_op）。
func snakeCase(name string) string {
	rs := []rune(name)
	var b strings.Builder
	for i, r := range rs {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				prev := rs[i-1]
				prevLower := prev >= 'a' && prev <= 'z' || prev >= '0' && prev <= '9'
				nextLower := i+1 < len(rs) && rs[i+1] >= 'a' && rs[i+1] <= 'z'
				if prevLower || nextLower {
					b.WriteByte('_')
				}
			}
			b.WriteRune(r + ('a' - 'A'))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// lineDiff 生成行级差异摘要（门禁红时人必须能一眼看懂改了哪一行）。
func lineDiff(committed, fresh []byte) string {
	a := strings.Split(string(committed), "\n")
	b := strings.Split(string(fresh), "\n")
	var sb strings.Builder
	fmt.Fprintf(&sb, "  磁盘 %d 行 / 生成器 %d 行；差异（最多 5 处）:", len(a), len(b))
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
		fmt.Fprintf(&sb, "\n    第 %d 行:\n      磁盘:   %s\n      生成器: %s", i+1, clip(x), clip(y))
		shown++
		if shown >= 5 {
			sb.WriteString("\n    …（仅显示前 5 处）")
			break
		}
	}
	return sb.String()
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
	cmd := exec.Command(bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
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

// goGenerateDirective 供人工核对：`go generate ./internal/wasmapp/limits` 会执行本文件里的
// //go:generate 指令（go 命令扫描包的测试文件，见 cmd/go/internal/generate 的 InternalGoFiles）。
//
//go:generate go run ../../../cmd/picoaide-limits-gen

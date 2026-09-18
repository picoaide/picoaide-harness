package wasmmod

import (
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// 本文件是 FIX-31（审计 P0-1）的**覆盖性门禁**：把审计员的最小复现固化成仓库用例。
//
// 为什么必须有一条"独立于生成来源"的判据：
// imports_gen_test.go 的 TestWhitelistCoversEverySource 只保证"白名单覆盖了**来源程序**用到的面"
// —— 如果来源程序自己退化了（例如有人把 stdprobe 里的 template 段删掉再重跑生成器），
// 白名单会**跟着一起变小**，而那条用例仍然全绿（自洽但错误）。
// 本文件编译的是 `testdata/stdrender`：一份**固定的、不进生成来源清单**的最小程序，
// 表达"应用真的会写的代码" —— 用 html/template 渲染页面 + 用 (*os.File).ReadAt/WriteAt。
// 它一旦不被白名单覆盖，本文件立刻红（"下次再缺一条"的防线）。
//
// 变异验证（实跑过）：
//   - 从生成来源里删掉 stdprobe 的 template 段 + 重跑生成器 ⇒
//     TestWhitelistCoversTemplateRenderAndReadAtGuest 红（sock_accept/sock_shutdown 缺失）；
//   - 同样删掉 ReadAt/WriteAt 段 ⇒ 同一用例红（fd_pread/fd_pwrite 缺失）；
//   - 往白名单里加 sock_open ⇒ TestWhitelistSecurityBoundary（imports_gen_test.go）红。

// coverageGuestPkg 是覆盖性门禁的固定程序（**刻意不在 whitelistSources / whitelistSourcesForTest 里**）。
const coverageGuestPkg = "./internal/wasmapp/wasmmod/testdata/stdrender"

// coverageGuestRequired 是"渲染页面 + 随机读写"的合法 Go 应用必须能导入的四条符号。
// 签名必须与 Go 工具链实际发出的一致（判据 = 符号 + 类型，§4.2）。
var coverageGuestRequired = map[string]string{
	"sock_accept":   "i32i32i32_i32",       // html/text template 的 Execute（渲染）
	"sock_shutdown": "i32i32_i32",          // 同上
	"fd_pread":      "i32i32i32i64i32_i32", // (*os.File).ReadAt
	"fd_pwrite":     "i32i32i32i64i32_i32", // (*os.File).WriteAt
}

// TestWhitelistCoversTemplateRenderAndReadAtGuest 是 P0-1 的回归判据：
// 真编译一个用 html/template 渲染 + os.File.ReadAt/WriteAt 的最小程序，
// 断言它的导入集**是白名单的子集**（并且是真的靠那四条，不是"恰好没触发"）。
func TestWhitelistCoversTemplateRenderAndReadAtGuest(t *testing.T) {
	raw := buildSource(t, coverageGuestPkg)
	info := mustParse(t, raw)

	// ① 前置断言：这个程序**真的**发出了那四条（否则本用例是空转假绿）。
	emitted := map[string]string{}
	rawNames := map[string]int{}
	for _, imp := range info.Imports {
		rawNames[imp.Name]++
		if _, want := coverageGuestRequired[imp.Name]; want {
			emitted[imp.Name] = imp.Signature
		}
	}
	for name, want := range coverageGuestRequired {
		got, ok := emitted[name]
		if !ok {
			t.Fatalf("门禁程序没有发出 %s —— 夹具退化了（本用例将变成空转）：实际导入 %v",
				name, sortedImportNames(info.Imports))
		}
		if got != want {
			t.Fatalf("%s 的签名变了：实际 %q，夹具期望 %q（Go 工具链改了 ABI 时同步改 coverageGuestRequired）",
				name, got, want)
		}
	}
	t.Logf("门禁程序导入段原始 %d 条；四条关键符号 %v", len(info.Imports), coverageGuestRequired)

	// ② 逐条比对白名单（与生产入口同口径：符号 + 类型）。
	var missing []string
	for _, imp := range info.Imports {
		cands := LookupImport(ImportWhitelist, imp.Module, imp.Name)
		ok := false
		for _, c := range cands {
			if c.Kind == imp.Kind && c.Signature == imp.Signature {
				ok = true
				break
			}
		}
		if !ok {
			missing = append(missing, imp.Module+"."+imp.Name+" ("+imp.Kind+":"+imp.Signature+")")
		}
	}
	if len(missing) > 0 {
		t.Fatalf("【P0-1 回归】用 html/template 渲染 + os.File.ReadAt 的合法 Go 应用有 %d 条导入不在白名单，"+
			"上传会被 IMPORT_NOT_ALLOWED 拒：\n  %s\n修复：cd server && go run ./cmd/picoaide-wasm-imports-gen",
			len(missing), strings.Join(missing, "\n  "))
	}

	// ③ 端到端再走一次生产入口（比手工比对更硬：Validate 就是上传期调的那个函数）。
	if _, err := Validate(raw); err != nil {
		t.Fatalf("【P0-1 回归】门禁程序未通过 Validate（合法 Go 应用被平台拒）: %v", err)
	}
}

// TestCoverageGuestRequiredSymbolsAreTheJudgement 是上一条的**反向对照**：
// 把那四条逐条从白名单里删掉，Validate 必须拒 —— 证明"它们确实是被判据覆盖的"，
// 而不是"恰好这段代码没被检查"。
func TestCoverageGuestRequiredSymbolsAreTheJudgement(t *testing.T) {
	raw := buildSource(t, coverageGuestPkg)
	for name := range coverageGuestRequired {
		mutated := make([]ImportSpec, 0, len(ImportWhitelist))
		for _, spec := range ImportWhitelist {
			if spec.Name == name {
				continue
			}
			mutated = append(mutated, spec)
		}
		if len(mutated) == len(ImportWhitelist) {
			t.Fatalf("%s 本来就不在白名单里 —— 上一条用例的判据不成立", name)
		}
		_, err := ValidateWithWhitelist(raw, mutated)
		if err == nil {
			t.Fatalf("白名单里删掉 %s 后门禁程序仍被放行 —— 说明这条符号没进判据", name)
		}
		e := codeOf(t, err)
		if e.Code != apperr.CodeImportNotAllowed && e.Code != apperr.CodeImportSignatureMismatch {
			t.Fatalf("删掉 %s 的期望拒绝码是 IMPORT_NOT_ALLOWED/IMPORT_SIGNATURE_MISMATCH，实际 %s: %v",
				name, e.Code, err)
		}
	}
}

// TestWhitelistAllowsOnlyFdFreeSockSymbols 把"红线 4 的静态判据"钉死在**精确集合**上：
//
//	允许：sock_accept / sock_shutdown（拿不到已监听的 fd ⇒ EBADF(8)；Go 运行时会发出）
//	禁止：sock_open / sock_bind / sock_listen / sock_connect（造 fd 的路径）
//	禁止：sock_recv / sock_send（需要已连接的 fd；当前 Go 面用不到，收紧到最小集合）
func TestWhitelistAllowsOnlyFdFreeSockSymbols(t *testing.T) {
	got := map[string]string{}
	for _, spec := range ImportWhitelist {
		if strings.HasPrefix(spec.Name, "sock_") {
			got[spec.Name] = spec.Signature
		}
	}
	if len(got) != len(allowedSocketSymbols) {
		t.Fatalf("白名单里的 socket 符号集合 = %v，期望恰好 %v（红线 4 的静态判据：只放行不造 fd 的两条）",
			got, allowedSocketSymbols)
	}
	for name, sig := range allowedSocketSymbols {
		if got[name] != sig {
			t.Fatalf("白名单缺 %s(%s) 或签名不符：实际 %q", name, sig, got[name])
		}
	}
	// 反向对照：若有人把 sock_open 塞进白名单，本用例必须红。
	mutated := append(append([]ImportSpec{}, ImportWhitelist...),
		ImportSpec{Module: "wasi_snapshot_preview1", Name: "sock_open", Kind: KindFunc, Signature: "i32i32i32i32_i32"})
	if !whitelistHasBannedFdSymbol(mutated) {
		t.Fatal("判据失效：sock_open 出现在白名单里却未被识别为禁符号")
	}
	// 逐条复核禁令本身（四个造 fd 的符号一个都不能漏）。
	for _, banned := range []string{"sock_open", "sock_bind", "sock_listen", "sock_connect"} {
		if !whitelistHasBannedFdSymbol([]ImportSpec{{Module: "wasi_snapshot_preview1", Name: banned, Kind: KindFunc, Signature: "x"}}) {
			t.Fatalf("禁令漏了 %s —— 红线 4 的静态判据不完整", banned)
		}
	}
}

// whitelistHasBannedFdSymbol 报告给定白名单里是否含"能自造 socket fd"的符号。
func whitelistHasBannedFdSymbol(specs []ImportSpec) bool {
	for _, spec := range specs {
		for _, banned := range bannedSocketFdCreation {
			if spec.Name == banned {
				return true
			}
		}
	}
	return false
}

// sortedImportNames 给失败信息一个稳定的符号清单。
func sortedImportNames(imports []Import) []string {
	seen := map[string]bool{}
	var out []string
	for _, imp := range imports {
		if seen[imp.Name] {
			continue
		}
		seen[imp.Name] = true
		out = append(out, imp.Name)
	}
	sort.Strings(out)
	return out
}

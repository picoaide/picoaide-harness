package wasmmod

import (
	"os"
	"path/filepath"
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
//	允许：sock_accept / sock_recv / sock_send / sock_shutdown
//	      （四条都要求"已有可用 socket fd"，而平台里造不出这种 fd ⇒ 能力为空；
//	       Go 运行时会发出 accept/shutdown，TinyGo 的 net/url 路径还会发出 recv/send）
//	禁止：sock_open / sock_bind / sock_listen / sock_connect（唯一能造 fd 的四条）
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

// coverageSockGuestPkg 是 TinyGo 风格 socket 导入的固定门禁程序
// （**刻意不在 whitelistSources / whitelistSourcesForTest 里**，理由见 stdrender 的同款注释）。
const coverageSockGuestPkg = "./internal/wasmapp/wasmmod/testdata/sockguest"

// coverageSockRequired 是 TinyGo 的 `net/url` 路径会带出的两条符号及其 canonical 签名。
var coverageSockRequired = map[string]string{
	"sock_recv": "i32i32i32i32i32i32_i32",
	"sock_send": "i32i32i32i32i32_i32",
}

// TestWhitelistCoversTinyGoStyleSocketImports 是 P0-6 的回归判据：
// 真编译一份"TinyGo 会在导入面上产出的形状"，断言平台白名单覆盖它，
// 并且**删掉任一条就会拒**（证明白名单里的那两行是承重的，不是摆设）。
//
// 与 TestWhitelistAllowsOnlyFdFreeSockSymbols 的分工：
//   - 那条钉"精确集合"（多一条造 fd 的符号即红）；
//   - 本用例钉"够用"（少一条就让合法产物发不出去即红）。两条一起才既不过宽也不过窄。
//
// 变异验证：把 sockprobe 从生成来源里删掉并重跑生成器 ⇒ 本用例红（sock_recv/sock_send
// 不在白名单，Validate 报 IMPORT_NOT_ALLOWED）——门禁与生成器的一致性由此闭环。
func TestWhitelistCoversTinyGoStyleSocketImports(t *testing.T) {
	raw := buildSource(t, coverageSockGuestPkg)
	info := mustParse(t, raw)

	// ① 前置断言：门禁程序**真的**发出了这两条（否则本用例是空转假绿）。
	emitted := map[string]string{}
	for _, imp := range info.Imports {
		if _, want := coverageSockRequired[imp.Name]; want {
			emitted[imp.Name] = imp.Signature
		}
	}
	for name, want := range coverageSockRequired {
		got, ok := emitted[name]
		if !ok {
			t.Fatalf("门禁程序没有发出 %s —— 夹具退化了（本用例将变成空转）：实际导入 %v",
				name, sortedImportNames(info.Imports))
		}
		if got != want {
			t.Fatalf("%s 的签名 = %s，期望 canonical %s（夹具或 ABI 理解已漂移）", name, got, want)
		}
	}

	// ② 正例：白名单必须覆盖它（否则 TinyGo 产物发不出去）。
	if _, err := Validate(raw); err != nil {
		t.Fatalf("TinyGo 风格产物的导入面必须被白名单覆盖：%v\n修复：cd server && go run ./cmd/picoaide-wasm-imports-gen", err)
	}

	// ③ 反向：从白名单里删掉任一条 ⇒ 必须被拒（证明这两行是承重的）。
	for name := range coverageSockRequired {
		mutated := make([]ImportSpec, 0, len(ImportWhitelist))
		for _, spec := range ImportWhitelist {
			if spec.Name == name {
				continue
			}
			mutated = append(mutated, spec)
		}
		if len(mutated) == len(ImportWhitelist) {
			t.Fatalf("%s 本来就不在白名单里 —— 上面的正例判据不成立", name)
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

// hasParams 报告一行 `func name(...)...` 的参数列表是否非空（用于区分 wasmimport 声明
// 与无参辅助函数）。
func hasParams(funcLine string) bool {
	open := strings.Index(funcLine, "(")
	closeIdx := strings.Index(funcLine, ")")
	if open < 0 || closeIdx <= open {
		return false
	}
	return strings.TrimSpace(funcLine[open+1:closeIdx]) != ""
}

// TestSocketImportDeclarationsStayInSyncAcrossCopies 钉住"两份 sock 导入声明逐字相等"。
//
// 为什么需要它（2026-09-21 独立审计 P3-⑤）：`sock_recv`/`sock_send` 的声明在仓库里有
// **两份拷贝** ——
//
//	server/internal/wasmapp/refapp/sockprobe/sock_wasip1.go   （生成器来源：进 ImportWhitelist）
//	server/internal/wasmapp/wasmmod/testdata/sockguest/sock_wasip1.go（独立门禁：验证白名单够用）
//
// 两者**必须声明同一组符号、同一组签名**：签名是白名单比对的一部分
// （`IMPORT_SIGNATURE_MISMATCH`），任一份漂移都会让"够用"或"精确"这两条判据之一失去
// 意义（例如门禁程序写错签名 ⇒ 白名单看起来够用，真产物仍被拒）。
// 现在的机制性保证为零（靠"改一处记得改另一处"），本用例把它变成断言。
//
// 判据口径：比较**去掉注释与空白后的函数签名行 + wasmimport 指令行**，而不是整个文件
// ——两份文件的注释是**故意**不同的（各自解释自己的用途），逐字节比较会把文档改动变成红灯。
// 变异验证：把任一份的 `sock_send` 签名少写一个参数（或删掉一条声明）⇒ 本用例红。
func TestSocketImportDeclarationsStayInSyncAcrossCopies(t *testing.T) {
	// 两份拷贝的**相对包目录**（相对 server/）。
	const (
		generatorCopy = "refapp/sockprobe"
		guestCopy     = "wasmmod/testdata/sockguest"
	)
	// 相对 **go.mod 所在目录**（server/）解析：包的测试 cwd 是包目录，
	// 而既有用例的 `./internal/...` 口径是相对模块根的 —— 这里必须与之一致，
	// 否则换目录跑测试会读不到文件（且是"读不到"而不是"断言失败"，更容易误诊）。
	base := filepath.Join(moduleRootForTest(t), "internal", "wasmapp")
	extract := func(pkgDir string) map[string]string {
		t.Helper()
		path := filepath.Join(base, pkgDir, "sock_wasip1.go")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("读 %s: %v", path, err)
		}
		out := map[string]string{}
		var pending string // 上一行的 //go:wasmimport 指令
		for _, line := range strings.Split(string(raw), "\n") {
			trimmed := strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(trimmed, "//go:wasmimport"):
				pending = trimmed
			case strings.HasPrefix(trimmed, "func "):
				// 只认**带参数的包级函数**（即真的 wasmimport 声明）；`func probeSockets()`
				// 这类无参辅助函数本就该没有指令，不能因此判失败。
				// 形如 `func sockRecv(fd, iovs, iovsLen, flags, nread, nwritten uintptr) int32 {`
				if !hasParams(trimmed) {
					continue
				}
				sig := strings.TrimSuffix(trimmed, " {")
				if pending == "" {
					t.Fatalf("%s 里的 %q 缺 //go:wasmimport 指令（声明不完整）", path, sig)
				}
				out[sig] = pending
				pending = ""
			}
		}
		if len(out) == 0 {
			t.Fatalf("%s 里没解析到任何 //go:wasmimport 声明（解析口径可能失效）", path)
		}
		return out
	}
	gen := extract(generatorCopy)
	guest := extract(guestCopy)
	for sig, imp := range gen {
		other, ok := guest[sig]
		if !ok {
			t.Fatalf("门禁拷贝（%s）缺少生成器拷贝里的声明：%s\n"+
				"两份必须逐条相同，否则\"白名单够用\"的判据会在真产物上失效", guestCopy, sig)
		}
		if other != imp {
			t.Fatalf("同一签名的 wasmimport 指令不一致：\n  生成器：%s\n  门禁：  %s", imp, other)
		}
	}
	for sig := range guest {
		if _, ok := gen[sig]; !ok {
			t.Fatalf("门禁拷贝（%s）多出生成器拷贝没有的声明：%s（多声明的符号不会被白名单覆盖）", guestCopy, sig)
		}
	}
}

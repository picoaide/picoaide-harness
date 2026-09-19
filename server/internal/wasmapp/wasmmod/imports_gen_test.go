package wasmmod

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 §5.5「导入面生成：手写清单即测试红」的门禁实现。
//
// 它**真编译**全部来源程序（GOOS=wasip1 GOARCH=wasm）→ dump 导入集 → 与提交在库里的
// imports_gen.go **逐条比对**（条数 + 顺序 + 每个字段）。四类破坏都会变红：
//  1. 手写/改错清单（少一条、多一条、签名写错）→ TestImportWhitelistMatchesAllSources；
//  2. 清单过期（改了来源程序或升级 Go 工具链后没重跑生成器）→ 同上；
//  3. **覆盖面不足**（清单少于任一来源程序实际用到的导入面）→ TestWhitelistCoversEverySource
//     ——这条防的正是"白名单恰好等于最小样例的导入面 ⇒ 合法应用被拒"的功能缺陷；
//  4. 安全边界被破坏（有人往清单里塞了别的模块名或能造 socket fd 的符号）→ TestWhitelistSecurityBoundary。
//
// R1-pm-18 追加两条（作者面交付）：
//  5. **作者面文档缺失/漂移**（改了生成器没重跑、或有人手改 references/imports.md）→
//     TestGeneratorCheckModeAgreesWithDisk（`-check` 现在是双产物门禁）+
//     TestSkillImportsDocCoversEveryWhitelistSymbol（对真源 ImportWhitelist 逐条覆盖）；
//  6. **作者读不到这份清单**（SKILL.md / abi.md 忘了指路）→ TestSkillPointsAtImportsDoc。
//
// ⚠️ 这四条只盯"**来源程序**用到的面"。来源程序自己退化时（有人把 stdprobe 的 template 段删掉
// 再重跑生成器），白名单会跟着一起变小而上面四条**全绿** —— 所以另有一条独立于生成来源的
// 覆盖性门禁：imports_coverage_test.go 真编译 testdata/stdrender（html/template 渲染 +
// (*os.File).ReadAt/WriteAt 的最小程序）并断言其导入集是白名单子集（审计 P0-1 的回归判据）。
//
// 变异验证（§5.5）：
//   - 从 ImportWhitelist 删掉 fd_read / path_open / random_get → TestWhitelistCoversFDRead 与
//     TestDroppingAWhitelistEntryTurnsValidationRed 必红；
//   - 把某条签名改一个字符                     → 逐条比对必红；
//   - 把某条的 Module 改成 "env"               → TestWhitelistSecurityBoundary 必红；
//   - 让来源程序不再触碰某条 WASI 路径          → 导入集变化 ⇒ 比对必红（提醒重跑生成器）；
//   - 删掉 stdprobe 的 template 段 + 重跑生成器 → imports_coverage_test.go 的用例必红。
//
// ⚠️ 本文件的用例会**真的调用 go build**（wasip1 目标）：需要可写的 GOCACHE/GOMODCACHE。
// 本机沙箱先 `source temp/goenv.sh`；CI 上由 go 工具链默认值满足。

// whitelistSourcesForTest 是参与白名单生成的来源程序，必须与生成器
// cmd/picoaide-wasm-imports-gen 的 whitelistSources 一致（这里**独立列出**：
// 门禁要能发现"生成器偷偷少编了一份来源"这种情况）。
var whitelistSourcesForTest = []string{
	"./internal/wasmapp/refapp",
	"./internal/wasmapp/refapp/wasiprobe",
	"./internal/wasmapp/refapp/stdprobe",
}

// generatedFileName 是生成产物相对 wasmmod 包目录的文件名。
const generatedFileName = "imports_gen.go"

// skillImportsDocRelPath 是**作者面**生成物（内置技能里的导入面文档）相对**仓库根**的路径。
//
// R1-pm-18 的现场：真源（imports_gen.go）有白名单，而作者面的 `server/skills/app-builder/
// references/**` 对这些符号**零命中** —— 作者/AI 只能靠 422 `IMPORT_NOT_ALLOWED` 试错。
// 修复方式与 limits 的 `references/limits.md` 同形态：生成器多出一份产物 + 逐字节门禁。
const skillImportsDocRelPath = "server/skills/app-builder/references/imports.md"

// skillMainRelPath 是内置技能首屏（它必须指路到 imports.md，否则作者读不到这份清单）。
const skillMainRelPath = "server/skills/app-builder/SKILL.md"

// skillABIRelPath 是 ABI 参考（失败语义表里 IMPORT_NOT_ALLOWED 那一行必须指路）。
const skillABIRelPath = "server/skills/app-builder/references/abi.md"

// requiredWASISymbols 是"平台必须放行"的最小符号集，逐条说明为什么不能少（§4.2/§10.2）：
//
//	fd_read        — ABI 从 stdin 读请求帧（§4.2 硬要求：白名单必须含 fd_read）
//	fd_write       — 应用写协议帧到 stdout
//	proc_exit      — guest 退出（Go 运行时 OOM 走 proc_exit(2)，§7.4 RUNTIME_GUEST_EXIT）
//	random_get     — crypto/rand（平台注入 rand.Reader，§15.1 第 1 条）
//	clock_time_get — time.Now（平台注入真实墙钟）
//	poll_oneoff    — time.Sleep（Go wasip1 用 poll_oneoff 实现睡眠）
//	args_get / environ_get — 平台必须传空 args/env（§10.2 第 23 项）
//
// 以下五条是"合法 Go 应用一旦用了 os 包的文件 API 就会引入"的符号（模块 C 实测的缺陷面）：
// 少了它们，一行 os.Stat / os.ReadDir 就会让应用被 IMPORT_NOT_ALLOWED 拒 —— 那是功能缺陷，
// 不是安全取舍（红线 5 由运行时零 preopen 保证，见包注释与生成产物头部）。
//
//	path_open             — os.Open / os.Create / os.OpenFile
//	path_filestat_get     — os.Stat / os.Lstat、MkdirAll 的递归检查
//	fd_readdir            — os.ReadDir / filepath.WalkDir / RemoveAll
//	path_unlink_file      — os.Remove / os.RemoveAll
//	path_create_directory — os.Mkdir / os.MkdirAll
//
// 下面四条是审计 P0-1（2026-09-18）实测的缺陷面 —— **应用真的会写的那种代码**：
//
//	sock_accept / sock_shutdown — `html/template` 与 `text/template` 的 **Execute（渲染）**
//	                             （本平台最主要的用法就是渲染 HTML 页面，§4.2 R8）
//	fd_pread / fd_pwrite        — `(*os.File).ReadAt` / `WriteAt`
//
// 它们与 path_open/fd_read 同级：零 preopen 下拿不到可用 fd；sock_* 这两条是 Go 运行时自己
// 发出的等待/收尾调用，**造不出 socket fd**（见 bannedSocketFdCreation）。
var requiredWASISymbols = map[string]string{
	"fd_read":               "i32i32i32i32_i32",
	"fd_write":              "i32i32i32i32_i32",
	"proc_exit":             "i32_",
	"random_get":            "i32i32_i32",
	"clock_time_get":        "i32i64i32_i32",
	"poll_oneoff":           "i32i32i32i32_i32",
	"args_get":              "i32i32_i32",
	"environ_get":           "i32i32_i32",
	"path_open":             "i32i32i32i32i32i64i64i32i32_i32",
	"path_filestat_get":     "i32i32i32i32i32_i32",
	"fd_readdir":            "i32i32i32i64i32_i32",
	"path_unlink_file":      "i32i32i32_i32",
	"path_create_directory": "i32i32i32_i32",
	"sock_accept":           "i32i32i32_i32",
	"sock_shutdown":         "i32i32_i32",
	"fd_pread":              "i32i32i32i64i32_i32",
	"fd_pwrite":             "i32i32i32i64i32_i32",
}

// bannedImportModules 是绝不允许出现在白名单里的模块名（§10.2 第 17 项）：
// env.* / js.* 是 Emscripten/JS 宿主的导入面；wasi_unstable 是 preview1 之前的旧名；
// preview2 / wasi:cli 属于组件模型（wazero 不支持，且 preview2 有 wasi:sockets ⇒ §11 升级注意项）。
var bannedImportModules = []string{"env", "js", "wasi_unstable", "wasi_snapshot_preview2", "wasi:cli", "wasi:sockets"}

// bannedSocketFdCreation 是"能自造 socket fd"的符号 —— 红线 4 的**真正静态判据**。
//
// 审计更正（2026-09-18，P1-2）：早先这里的判据是"不允许任何 sock_* 前缀"，理由是
// "preview1 根本没有 sock_*"。实测（wazero v1.12.0 / Go 1.26.x）不成立：
//   - preview1 宿主模块**导出** sock_accept / sock_recv / sock_send / sock_shutdown
//     （无 sock_open / sock_bind / sock_listen / sock_connect）；
//   - Go 运行时自己就会发出 sock_accept / sock_shutdown（经 text/template 的 Execute 可达）。
//
// 所以红线 4 成立的理由要改写成"**没有任何途径得到一个 socket fd**"——判据是
// **拒掉造 fd 的符号**（下面这四个；它们本来也不在 preview1 里）+ 白名单不含任何
// 其它模块（见 bannedImportModules）。把 Go 会发出的 sock_accept/sock_shutdown 一并拒掉，
// 只会把"渲染 HTML 页面"的合法应用判死（审计 P0-1），并不会多挡住任何攻击路径。
var bannedSocketFdCreation = []string{"sock_open", "sock_bind", "sock_listen", "sock_connect"}

// allowedSocketSymbols 是白名单里**允许**出现的 sock_* 符号（精确集合，不多不少）。
// 判据 = 它不需要一个已存在的 socket fd、也造不出 fd：
// sock_accept 只是"从一个已监听的 fd 上接一个连接"（拿不到监听的 fd ⇒ EBADF(8) 实测），
// sock_shutdown 只是收尾（fd 不存在 ⇒ EBADF(8) 实测）。
var allowedSocketSymbols = map[string]string{
	"sock_accept":   "i32i32i32_i32",
	"sock_shutdown": "i32i32_i32",
}

func TestImportWhitelistMatchesAllSources(t *testing.T) {
	union := make([]ImportSpec, 0, len(ImportWhitelist))
	seen := map[ImportSpec]bool{}
	for _, pkg := range whitelistSourcesForTest {
		raw := buildSource(t, pkg)
		info, err := Parse(raw)
		if err != nil {
			t.Fatalf("解析 %s 的产物失败: %v", pkg, err)
		}
		if len(info.Imports) == 0 {
			t.Fatalf("%s 的导入集为空（Go wasip1 产物不可能没有 WASI 导入）", pkg)
		}
		specs := dedupSort(info.Imports)
		t.Logf("%s：导入段原始 %d 条、去重后 %d 条", pkg, len(info.Imports), len(specs))
		for _, spec := range specs {
			if seen[spec] {
				continue
			}
			seen[spec] = true
			union = append(union, spec)
		}
	}
	sortSpecs(union)

	if len(union) != len(ImportWhitelist) {
		t.Fatalf("导入白名单条数不一致：磁盘 %d 条，来源程序并集 %d 条\n"+
			"修复：cd server && go run ./cmd/picoaide-wasm-imports-gen\n磁盘: %s\n实际: %s",
			len(ImportWhitelist), len(union), formatSpecs(ImportWhitelist), formatSpecs(union))
	}
	for i := range union {
		if union[i] != ImportWhitelist[i] {
			t.Fatalf("导入白名单第 %d 条不一致：\n磁盘: %+v\n实际: %+v\n"+
				"修复：cd server && go run ./cmd/picoaide-wasm-imports-gen", i, ImportWhitelist[i], union[i])
		}
	}
}

func TestWhitelistCoversEverySource(t *testing.T) {
	// 覆盖性（**这条防的是"白名单恰好等于最小样例的导入面"**）：
	// 用提交在库里的白名单对**每一份**来源程序跑完整 Validate——任何一份缺一条这里就红。
	for _, pkg := range whitelistSourcesForTest {
		raw := buildSource(t, pkg)
		info, err := Validate(raw)
		if err != nil {
			t.Fatalf("%s 未通过 Validate（白名单缺项/签名过期？）: %v\n"+
				"修复：cd server && go run ./cmd/picoaide-wasm-imports-gen", pkg, err)
		}
		if !info.MemoryExported {
			t.Fatalf("%s 应导出 memory", pkg)
		}
		if _, ok := info.ExportKinds["_start"]; !ok {
			t.Fatalf("%s 应导出 _start", pkg)
		}
	}
}

func TestWhitelistCoversFDRead(t *testing.T) {
	// §4.2 硬要求：白名单必须含 fd_read（ABI 读 stdin 请求帧）。
	var found *ImportSpec
	for i := range ImportWhitelist {
		if ImportWhitelist[i].Name == "fd_read" {
			found = &ImportWhitelist[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("导入白名单缺少 fd_read：ABI 无法从 stdin 读请求帧（§4.2）")
	}
	if found.Module != limits.WasmImportModule {
		t.Fatalf("fd_read 的模块名 = %q，期望 %q", found.Module, limits.WasmImportModule)
	}
	if found.Kind != KindFunc || found.Signature != "i32i32i32i32_i32" {
		t.Fatalf("fd_read 的种类/签名不符：%+v", *found)
	}
}

func TestWhitelistCoversRequiredWASISymbols(t *testing.T) {
	byName := map[string]ImportSpec{}
	for _, spec := range ImportWhitelist {
		byName[spec.Name] = spec
	}
	for name, signature := range requiredWASISymbols {
		spec, ok := byName[name]
		if !ok {
			t.Fatalf("白名单缺少平台必需符号 %s（说明见本文件 requiredWASISymbols）", name)
		}
		if spec.Signature != signature {
			t.Fatalf("%s 的签名变了：磁盘 %q，本测试期望 %q（若 Go 工具链确实改了 ABI，请同步改这里并重跑生成器）",
				name, spec.Signature, signature)
		}
	}
}

func TestWhitelistSecurityBoundary(t *testing.T) {
	// 反向断言（红线 4 的静态判据，§10.2 第 16/17 项）：
	//   - 每一条的模块名必须**恰好**是 wasi_snapshot_preview1；
	//   - 不得出现 env.* / js.* / wasi_unstable / preview2 / 组件模型命名空间；
	//   - 不得出现"能自造 socket fd"的符号（sock_open / sock_bind / sock_listen / sock_connect）——
	//     这才是"应用不能出站"的判据（不是"禁止一切 sock_*"：preview1 有 accept/recv/send/shutdown，
	//     且 Go 运行时自己会发 accept/shutdown ⇒ 一刀切会把模板渲染判死，见 bannedSocketFdCreation）；
	//   - 出现的每个 sock_* 必须**恰好**是 allowedSocketSymbols 里的那两条（多了即红：防止以后
	//     有人把 sock_recv/sock_send 或别的 ABI 的 socket 面塞进来）。
	// 这条能抓住"以后有人手滑往白名单里加了个别的模块名/符号"。
	for _, spec := range ImportWhitelist {
		if spec.Module != limits.WasmImportModule {
			t.Fatalf("白名单含非 %s 模块：%+v（§10.2 第 17 项）", limits.WasmImportModule, spec)
		}
		for _, banned := range bannedImportModules {
			if spec.Module == banned {
				t.Fatalf("白名单含被禁模块 %q：%+v", banned, spec)
			}
		}
		for _, banned := range bannedSocketFdCreation {
			if spec.Name == banned {
				t.Fatalf("白名单含「能自造 socket fd」的符号 %q（红线 4：应用不能出站）：%+v", spec.Name, spec)
			}
		}
		if strings.HasPrefix(spec.Name, "sock_") {
			want, ok := allowedSocketSymbols[spec.Name]
			if !ok {
				t.Fatalf("白名单含未获准的 socket 符号 %q（只允许 %v）：%+v", spec.Name, allowedSocketSymbols, spec)
			}
			if spec.Signature != want {
				t.Fatalf("socket 符号 %q 的签名不符：磁盘 %q，期望 %q", spec.Name, spec.Signature, want)
			}
		}
		if spec.Kind != KindFunc && spec.Kind != KindMemory && spec.Kind != KindTable && spec.Kind != KindGlobal {
			t.Fatalf("白名单含未知种类：%+v", spec)
		}
		if spec.Signature == "" {
			t.Fatalf("白名单条目缺签名（判据 = 符号 + 类型，§4.2）：%+v", spec)
		}
	}
}

func TestDroppingAWhitelistEntryTurnsValidationRed(t *testing.T) {
	// 变异验证：删掉任意一条 ⇒ 用来源程序校验时必须被拒
	// （对照 TestWhitelistCoversEverySource 的绿）。
	raws := map[string][]byte{}
	for _, pkg := range whitelistSourcesForTest {
		raws[pkg] = buildSource(t, pkg)
	}
	victims := []string{"fd_read", "random_get", "clock_time_get", "path_open", "fd_readdir", "path_unlink_file",
		// FIX-31：模板渲染 / ReadAt 用到的四条也必须在判据里（删掉即必须被拒）。
		"sock_accept", "sock_shutdown", "fd_pread", "fd_pwrite"}
	for _, victim := range victims {
		mutated := make([]ImportSpec, 0, len(ImportWhitelist))
		for _, spec := range ImportWhitelist {
			if spec.Name == victim {
				continue
			}
			mutated = append(mutated, spec)
		}
		rejected := false
		for _, raw := range raws {
			if _, err := ValidateWithWhitelist(raw, mutated); err != nil {
				rejected = true
				break
			}
		}
		if !rejected {
			t.Fatalf("删掉 %s 后没有任何一份来源程序被拒——说明该符号没有被真正纳入判据", victim)
		}
	}
}

func TestRefappOnlyWhitelistWouldRejectFileUsingApps(t *testing.T) {
	// **回归证据**（模块 C 实测的功能缺陷，必须有这条用例把它钉住）：
	// 如果白名单只按 refapp（最小教学样例）生成，那么任何用了 os 包文件 API 的合法 Go 应用
	// 都会被 IMPORT_NOT_ALLOWED 拒 —— 而 Go 是 Tier 1 官方支持语言（§9.1）。
	// 这里现场构造"refapp-only 子集"去校验 wasiprobe，必须被拒且点名文件类符号。
	refappSpecs := dedupSort(mustParse(t, buildSource(t, "./internal/wasmapp/refapp")).Imports)
	probe := buildSource(t, "./internal/wasmapp/refapp/wasiprobe")

	// 先确认 wasiprobe 用到了 refapp 子集之外的符号（否则这条用例本身没有意义）。
	extra := map[string]bool{}
	for _, spec := range dedupSort(mustParse(t, probe).Imports) {
		found := false
		for _, base := range refappSpecs {
			if base == spec {
				found = true
				break
			}
		}
		if !found {
			extra[spec.Name] = true
		}
	}
	if len(extra) == 0 {
		t.Fatalf("wasiprobe 没有引入 refapp 之外的符号——探测程序退化了（白名单覆盖面会静默变窄）")
	}
	// 这些是"用了 os 包文件 API 就会引入"的代表性符号，必须出现在差集里。
	for _, want := range []string{"path_open", "fd_readdir", "path_filestat_get"} {
		if !extra[want] {
			t.Fatalf("wasiprobe 的差集里缺 %s（差集=%v）——探测覆盖面不足", want, extra)
		}
	}

	_, err := ValidateWithWhitelist(probe, refappSpecs)
	e := codeOf(t, err)
	if e.Code != apperr.CodeImportNotAllowed && e.Code != apperr.CodeImportSignatureMismatch {
		t.Fatalf("refapp-only 白名单应拒掉文件类导入，实际 %s: %v", e.Code, err)
	}
	symbol, _ := e.Details["symbol"].(string)
	if symbol == "" {
		t.Fatalf("拒绝原因应点名具体符号，实际 %v", e.Details)
	}
	for _, base := range refappSpecs {
		if base.Module+"."+base.Name == symbol {
			t.Fatalf("被拒符号 %s 属于 refapp 子集，说明拒绝原因不是「覆盖面不足」: %v", symbol, e.Details)
		}
	}
	// 反向：完整白名单必须放行（否则上面的"拒"就没有对照）。
	if _, err := ValidateWithWhitelist(probe, ImportWhitelist); err != nil {
		t.Fatalf("完整白名单应放行 wasiprobe: %v", err)
	}
}

func TestGeneratorCheckModeAgreesWithDisk(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：跳过 CLI 端到端（需要再编译两份来源程序）")
	}
	// 端到端验证生成器的 -check 模式（CI 可直接调它；这里保证它真的能发现不一致）。
	// ⚠️ `-check` 现在是**双产物**门禁：wasmmod/imports_gen.go **与**作者面的
	// references/imports.md 都要与实时产物逐字节一致（R1-pm-18）。
	root := moduleRootForTest(t)
	cmd := exec.Command("go", "run", "./cmd/picoaide-wasm-imports-gen", "-check")
	cmd.Dir = root
	cmd.Env = os.Environ()
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("生成器 -check 失败（清单与来源程序不一致？）: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "-check 通过") {
		t.Fatalf("生成器 -check 输出不符合预期:\n%s", out.String())
	}

	// 负向 1：把输出指到一个空文件上，-check 必须非零退出。
	tmp := filepath.Join(t.TempDir(), "empty.go")
	if err := os.WriteFile(tmp, []byte("package wasmmod\n"), 0o644); err != nil {
		t.Fatalf("写临时文件: %v", err)
	}
	cmd = exec.Command("go", "run", "./cmd/picoaide-wasm-imports-gen", "-check", "-o", tmp)
	cmd.Dir = root
	cmd.Env = os.Environ()
	out.Reset()
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err == nil {
		t.Fatalf("-check 对不一致的文件应非零退出:\n%s", out.String())
	}

	// 负向 2（R1-pm-18 的判据）：作者面文档单独不一致时同样必须非零退出 ——
	// 否则"改了生成器没重跑"会只在平台侧红、作者面悄悄漂移。
	tmpDoc := filepath.Join(t.TempDir(), "imports.md")
	if err := os.WriteFile(tmpDoc, []byte("# 空文档\n"), 0o644); err != nil {
		t.Fatalf("写临时文档: %v", err)
	}
	cmd = exec.Command("go", "run", "./cmd/picoaide-wasm-imports-gen", "-check", "-imports-md", tmpDoc)
	cmd.Dir = root
	cmd.Env = os.Environ()
	out.Reset()
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err == nil {
		t.Fatalf("-check 对不一致的 references/imports.md 应非零退出:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "作者面") {
		t.Fatalf("负向失败信息应点名是哪一份产物（作者面 / 平台侧）:\n%s", out.String())
	}

	// 负向 3（R2-SK-3 的判据）：**只改行尾/EOF 空行**同样是"下发字节变了"。
	// references/imports.md 会原样下发到员工磁盘，所以换行风格也算内容；
	// 此前 -check 走 normalize（CRLF→LF + 去尾空行）⇒ 这种情况静默绿。
	rawDoc, rerr := os.ReadFile(filepath.Join(filepath.Dir(root), filepath.FromSlash(skillImportsDocRelPath)))
	if rerr != nil {
		t.Fatalf("读 %s: %v", skillImportsDocRelPath, rerr)
	}
	crlfDoc := filepath.Join(t.TempDir(), "imports-crlf.md")
	if werr := os.WriteFile(crlfDoc, bytes.ReplaceAll(rawDoc, []byte("\n"), []byte("\r\n")), 0o644); werr != nil {
		t.Fatalf("写 CRLF 临时文档: %v", werr)
	}
	cmd = exec.Command("go", "run", "./cmd/picoaide-wasm-imports-gen", "-check", "-imports-md", crlfDoc)
	cmd.Dir = root
	cmd.Env = os.Environ()
	out.Reset()
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err == nil {
		t.Fatalf("-check 对**只有行尾不同**（CRLF）的 references/imports.md 必须非零退出:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "逐行内容相同") {
		t.Fatalf("CRLF 差异的报错应讲清「差异只在行尾」（而不是让人以为内容被改了）:\n%s", out.String())
	}
}

// TestSkillImportsDocCoversEveryWhitelistSymbol 是 R1-pm-18 的**覆盖性**判据：
// 提交的作者面文档必须逐条覆盖真源里的**全部**符号（符号 + 签名 + 模块名），
// 一条不多、一条不少。
//
// 为什么与 -check（逐字节）分开还要再来一条：逐字节守的是"生成器与产物同步"，
// 而这条直接对**真源** ImportWhitelist 说话 —— 白名单扩面后即使有人手改产物绕过
// 生成器，这里也会红。变异验证：从 references/imports.md 删掉任意一行 ⇒ 本用例必红
// （逐字节用例也会红，两条各自承重）。
func TestSkillImportsDocCoversEveryWhitelistSymbol(t *testing.T) {
	doc := readRepoFile(t, skillImportsDocRelPath)

	// 解析 Markdown 表格行：| `wasi_snapshot_preview1` | `fd_read` | func | `i32i32i32i32_i32` | … |
	rowRe := regexp.MustCompile("^\\|\\s*`([^`]+)`\\s*\\|\\s*`([^`]+)`\\s*\\|\\s*([A-Za-z]+)\\s*\\|\\s*`([^`]+)`\\s*\\|")
	type row struct{ module, name, kind, signature string }
	seen := map[string]row{}
	for _, line := range strings.Split(doc, "\n") {
		m := rowRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		r := row{module: m[1], name: m[2], kind: m[3], signature: m[4]}
		if _, dup := seen[r.name]; dup {
			t.Fatalf("%s 里符号 %s 出现了多次（每个符号只允许一行）", skillImportsDocRelPath, r.name)
		}
		seen[r.name] = r
	}
	if len(seen) == 0 {
		t.Fatalf("%s 里没有解析到任何符号行（表格被改坏了？）", skillImportsDocRelPath)
	}

	for _, spec := range ImportWhitelist {
		r, ok := seen[spec.Name]
		if !ok {
			t.Fatalf("%s 缺少白名单符号 %s —— 作者会以为它不被放行（修复：cd server && "+
				"go run ./cmd/picoaide-wasm-imports-gen）", skillImportsDocRelPath, spec.Name)
		}
		if r.module != spec.Module || r.kind != spec.Kind || r.signature != spec.Signature {
			t.Fatalf("%s 的 %s 与真源不一致：文档 %+v，真源 %+v", skillImportsDocRelPath, spec.Name, r, spec)
		}
	}
	// 反向：文档不得出现真源里没有的符号（防止"抄了一份别的 ABI 的表"）。
	known := map[string]bool{}
	for _, spec := range ImportWhitelist {
		known[spec.Name] = true
	}
	for name := range seen {
		if !known[name] {
			t.Fatalf("%s 里的 %s 不在真源白名单里（白名单是生成产物，不能手工扩面）", skillImportsDocRelPath, name)
		}
	}
	if len(seen) != len(ImportWhitelist) {
		t.Fatalf("%s 的符号行数 %d 与真源 %d 不一致", skillImportsDocRelPath, len(seen), len(ImportWhitelist))
	}

	// 文档必须把"为什么是保守超集"和"撞到 IMPORT_NOT_ALLOWED 怎么办"讲清楚 ——
	// 这两段是作者唯一的自助出口（否则他只能靠 422 试错，正是 R1-pm-18）。
	for _, want := range []string{
		"保守超集",
		"零 preopen",
		"IMPORT_NOT_ALLOWED",
		"details.symbol",
		"picoaide-wasm-imports-gen",
		"不要手改",
	} {
		if !strings.Contains(doc, want) {
			t.Fatalf("%s 缺少 %q（作者面必须自带判据来源 + 出错后怎么办）", skillImportsDocRelPath, want)
		}
	}
}

// TestSkillPointsAtImportsDoc 守"指路"：作者最先读的两份文件（SKILL 首屏与 abi 参考）
// 都必须把作者送到 references/imports.md。
//
// 为什么单独一条：文档写好了但没人指路，等于没交付 —— 作者会在 422 里继续试错。
// 变异验证：从 SKILL.md 或 abi.md 删掉那处引用 ⇒ 本用例必红。
func TestSkillPointsAtImportsDoc(t *testing.T) {
	for _, rel := range []string{skillMainRelPath, skillABIRelPath} {
		text := readRepoFile(t, rel)
		if !strings.Contains(text, "references/imports.md") && !strings.Contains(text, "`imports.md`") {
			t.Fatalf("%s 没有指路到 references/imports.md（导入面白名单是作者写代码前就该读的东西）", rel)
		}
	}
}

// readRepoFile 读仓库根下的文本文件（测试辅助）。
func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	path := filepath.Join(filepath.Dir(moduleRootForTest(t)), filepath.FromSlash(rel))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s: %v", rel, err)
	}
	return string(raw)
}

// TestGeneratedFileLocationAndHeader 守住三条生成产物纪律：
// 文件必须在 wasmmod 包目录里（否则包编译不过）、必须带 `Code generated … DO NOT EDIT.` 头
// （§4.2：生成产物可被工具识别，人不会被误导去手改）、必须写明"白名单 = Go 可发出的 WASI 面
// （保守超集）+ 为什么允许 path_open"（否则审计员会以为红线被破坏）。
func TestGeneratedFileLocationAndHeader(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatalf("runtime.Caller 失败")
	}
	path := filepath.Join(filepath.Dir(thisFile), generatedFileName)
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读生成产物 %s: %v", path, err)
	}
	const header = "// Code generated by picoaide-wasm-imports-gen; DO NOT EDIT."
	if !bytes.HasPrefix(content, []byte(header)) {
		t.Fatalf("%s 缺少生成头 %q（生成器模板被改坏了？）", generatedFileName, header)
	}
	if !strings.Contains(string(content), "cd server && go run ./cmd/picoaide-wasm-imports-gen") {
		t.Fatalf("%s 头部应写明重跑命令（§4.2）", generatedFileName)
	}
	if !strings.Contains(string(content), "保守超集") || !strings.Contains(string(content), "零 preopen") {
		t.Fatalf("%s 头部缺少「白名单语义 + 为什么允许 path_open」的说明", generatedFileName)
	}
}

// ===== 测试辅助 =====

// buildSource 真编译一份来源程序并返回 wasm 字节。
func buildSource(t *testing.T, pkg string) []byte {
	t.Helper()
	root := moduleRootForTest(t)
	name := strings.ReplaceAll(strings.TrimPrefix(pkg, "./"), "/", "_") + ".wasm"
	out := filepath.Join(t.TempDir(), name)
	cmd := exec.Command("go", "build", "-trimpath", "-o", out, pkg)
	cmd.Dir = root
	cmd.Env = withEnv(map[string]string{"GOOS": "wasip1", "GOARCH": "wasm", "CGO_ENABLED": "0"})
	var stderr bytes.Buffer
	cmd.Stdout = &stderr
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("编译 %s 失败（GOOS=wasip1 GOARCH=wasm go build %s）: %v\n%s", pkg, pkg, err, stderr.String())
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("读取 %s: %v", out, err)
	}
	return raw
}

// mustParse 解析 wasm 结构，失败即 Fatal（测试辅助）。
func mustParse(t *testing.T, raw []byte) *ModuleInfo {
	t.Helper()
	info, err := Parse(raw)
	if err != nil {
		t.Fatalf("解析产物失败: %v", err)
	}
	return info
}

// dedupSort 与生成器**各自独立**地去重排序（有意重复实现：
// 门禁测试若复用生成器的实现，就无法发现生成器自己的排序/去重写错）。
func dedupSort(imports []Import) []ImportSpec {
	seen := map[ImportSpec]bool{}
	out := make([]ImportSpec, 0, len(imports))
	for _, imp := range imports {
		spec := ImportSpec{Module: imp.Module, Name: imp.Name, Kind: imp.Kind, Signature: imp.Signature}
		if seen[spec] {
			continue
		}
		seen[spec] = true
		out = append(out, spec)
	}
	sortSpecs(out)
	return out
}

func sortSpecs(specs []ImportSpec) {
	sort.Slice(specs, func(i, j int) bool {
		a, b := specs[i], specs[j]
		switch {
		case a.Module != b.Module:
			return a.Module < b.Module
		case a.Name != b.Name:
			return a.Name < b.Name
		case a.Kind != b.Kind:
			return a.Kind < b.Kind
		default:
			return a.Signature < b.Signature
		}
	})
}

func formatSpecs(specs []ImportSpec) string {
	var b strings.Builder
	for i, s := range specs {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(s.Name + ":" + s.Signature)
	}
	return b.String()
}

// moduleRootForTest 从当前测试目录向上找 go.mod（= server/ 模块根）。
func moduleRootForTest(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("从 %s 向上找不到 go.mod", dir)
		}
		dir = parent
	}
}

// withEnv 以当前进程 env 为底覆盖指定键（同名替换，避免"首个匹配生效"的环境差异）。
func withEnv(overrides map[string]string) []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+len(overrides))
	for _, kv := range base {
		key, _, ok := strings.Cut(kv, "=")
		if ok {
			if _, override := overrides[key]; override {
				continue
			}
		}
		out = append(out, kv)
	}
	for k, v := range overrides {
		out = append(out, k+"="+v)
	}
	return out
}

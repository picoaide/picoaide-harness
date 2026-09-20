// Command picoaide-wasm-imports-gen 从参考程序的真编译产物生成**导入面白名单**
// （设计基线 §4.2「导入面白名单」+ §5.5「导入面生成：手写清单即测试红」）。
//
// 为什么必须"生成"而不是"手写"：白名单漂移的两个方向都不可接受——
// 少一条 ⇒ 合法的 Go 应用被平台拒（作者照着 skill 抄都过不了）；
// 多一条 ⇒ 放行了平台没打算支持的导入面。唯一权威来源只能是真编译产物。
//
// 为什么是**多份程序的并集**（不是单份参考实现的导入面）：
// 白名单的语义是"**Go wasip1 运行时可能发出的全部 wasi_snapshot_preview1 导入**"（保守超集），
// 而单个程序只覆盖它自己用到的符号——refapp 只做帧协议 + 内存分配，恰好 16 个符号；
// 任何一行 `os.Stat` 都会再引入 `path_filestat_get`，只按 refapp 生成会把
// "用了 os.Stat 的合法 Go 应用"直接判 IMPORT_NOT_ALLOWED（模块 C 实测的功能缺陷）。
// 审计（2026-09-18，P0-1）实测的同类缺陷：`html/template` / `text/template` 的 **Execute（渲染）**
// 会带出 `sock_accept` / `sock_shutdown`，`(*os.File).ReadAt` / `WriteAt` 会带出
// `fd_pread` / `fd_pwrite` —— 只按 refapp + wasiprobe 生成时这四条都不在名单里，
// 于是"渲染 HTML 页面"（§4.2 R8 的主要用法）的应用根本发不出去 ⇒ 本清单的第三个来源
// stdprobe 专门覆盖这些面。
//
// 红线**不靠白名单**保证：
//   - 不能读宿主文件 = 运行时零 preopen（§4.3 / §15.1 第 1 条）：允许导入 path_open，但没有任何
//     preopen 时文件操作一律 DENIED，errno 视调用层与路径形态为 EBADF(8) / EPERM(63) / ENOTDIR(54)
//     ——**不是 ENOSYS**（审计实测矩阵，2026-09-18 更正）；
//   - 不能出站 = **没有任何途径得到一个 socket fd**：preview1 只有 sock_accept / sock_recv /
//     sock_send / sock_shutdown，**没有** sock_open / sock_bind / sock_listen / sock_connect
//     ⇒ 自造不出 socket fd（`sock_accept(0..10)` / `sock_shutdown(3)` 实测全 EBADF(8)，
//     `syscall.Socket` 在 wasip1 上是 "Not implemented on wasip1"）。所以白名单要拒的是
//     **造 fd 的那几个 sock_* 符号**与非 wasi_snapshot_preview1 的模块（门禁有反向断言），
//     而不是把 Go 运行时会发出的 sock_accept / sock_shutdown 一并拒掉（那会把模板渲染判死）。
//
// 流程（对每个来源程序各做一遍，再取并集）：
//
//	GOOS=wasip1 GOARCH=wasm go build <pkg>   （继承当前进程 env）
//	  → wasmmod.Parse 解析段表、dump 导入集（符号 + 类型签名）
//	  → 去重 + 确定性排序 → 取并集
//	  → wasmmod.ValidateWithWhitelist 用**新清单**逐份自检（证明清单自洽且够用）
//	  → 渲染并 gofmt，写入 wasmmod/imports_gen.go
//
// 用法：
//
//	cd server && go run ./cmd/picoaide-wasm-imports-gen            # 重新生成
//	cd server && go run ./cmd/picoaide-wasm-imports-gen -check     # 只比对（CI 门禁；不一致非零退出）
//	cd server && go run ./cmd/picoaide-wasm-imports-gen -o /tmp/x.go
//
// ⚠️ 本机环境：本包用 os.Environ() 透传环境（GOCACHE/GOMODCACHE/GOPATH/GOFLAGS 都必须可见，
// 沙箱里 /root/.cache 与 /root/go 只读 ⇒ 先 source temp/goenv.sh）。
//
// ⚠️ 概念澄清（写进生成产物头部）：宿主能力调用走 stdin/stdout 上的 **JSON-RPC**（§7.2），
// **不是 wasm 导入**。所以本清单实际上是 **Go wasip1 运行时的 WASI 导入集**
// （模块名恒为 wasi_snapshot_preview1），其中 fd_read 是 ABI 读 stdin 请求帧的硬要求（§4.2）。
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/format"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/wasmmod"
)

// whitelistSources 是参与生成的全部参考程序（相对模块根；白名单 = 它们的并集）。
//
//   - `refapp`           参考实现 = 教学样例（只做帧协议 + 内存分配，必须保持干净，见其包注释）；
//   - `refapp/wasiprobe` 只用于 dump 的探测程序：故意触碰 os 包的文件/时间/随机/环境面；
//   - `refapp/stdprobe`  只用于 dump 的探测程序（FIX-31）：**应用真的会写的那种代码** ——
//     html/text template 的 Execute（渲染）、(*os.File).ReadAt/WriteAt、encoding/json、
//     strings/strconv/sort/regexp/math/errors、net/url、time.Parse/Format、base64、hash/*、
//     io.Copy/bufio、unicode/utf8、context、sync 等。它存在的直接原因是审计 P0-1：
//     template 的 Execute 会带出 sock_accept/sock_shutdown、ReadAt/WriteAt 会带出
//     fd_pread/fd_pwrite，这四条缺一条就让"渲染页面的合法 Go 应用"被 IMPORT_NOT_ALLOWED 拒。
//
//   - `refapp/sockprobe` 只用于 dump 的探测程序（2026-09-21 审计 P0-6）：**直接声明**
//     `sock_recv` / `sock_send` 两条 WASI 导入（`//go:wasmimport`）。存在的理由是
//     "白名单 = Go/TinyGo wasip1 运行时的保守超集"：Go 运行时只声明 sock_accept /
//     sock_shutdown，而 TinyGo 的 net/url 路径还会带出这两条 —— 缺了它们，同一份
//     只用标准库的应用"用 TinyGo 编译就发不出去"。两条符号能力为空（拿不到已连接的
//     socket fd，见 sockprobe 包注释与 TestWhitelistAllowsOnlyFdFreeSockSymbols）。
//
// 新增语言样例（Rust/Zig）时在这里加一条即可，生成器与门禁都会自动覆盖。
var whitelistSources = []string{
	"./internal/wasmapp/refapp",
	"./internal/wasmapp/refapp/wasiprobe",
	"./internal/wasmapp/refapp/stdprobe",
	"./internal/wasmapp/refapp/sockprobe",
}

// generatedRelPath 是生成产物的默认位置（相对模块根）。
var generatedRelPath = filepath.Join("internal", "wasmapp", "wasmmod", "imports_gen.go")

// skillImportsRelPath 是**作者面**那一份产物的默认位置（相对模块根）：内置技能
// `app-builder` 的 references/imports.md。
//
// 为什么同一份数据要出两份产物（R1-pm-18）：
//   - `wasmmod/imports_gen.go` 是**平台侧真源**（校验器读它），作者看不到；
//   - 作者/AI 读的是内置技能里的文档。此前技能目录里对白名单**零命中**，作者只能
//     在 32 MiB 上传 + 编译之后拿一个 422 `IMPORT_NOT_ALLOWED` 反复试错。
//
// 两份产物都由本生成器渲染、都由 `-check` **逐字节**守（与 limits 的
// `references/limits.md` 同形态）：文档一旦与真源漂移，作者就会照着错的清单写代码。
//
// "逐字节"是字面意思（R2-SK-3）：`references/imports.md` 会**原样下发**给已安装
// 该技能的员工，改行尾（CRLF）或 EOF 空行数同样是下发字节变了 ⇒ 必须红。此前比对
// 走了 normalize（CRLF→LF + 去尾空行），门禁绿着而字节已变，与它自己打印的
// "逐字节一致"不符。
var skillImportsRelPath = filepath.Join("skills", "app-builder", "references", "imports.md")

func main() {
	out := flag.String("o", "", "输出路径（缺省 = <模块根>/"+filepath.ToSlash(generatedRelPath)+"）")
	skillDoc := flag.String("imports-md", "", "作者面导入面文档的输出路径（缺省 = <模块根>/"+filepath.ToSlash(skillImportsRelPath)+"）")
	check := flag.Bool("check", false, "比对模式：不写文件，生成结果与磁盘内容不一致时以非零退出")
	flag.Parse()

	if err := run(*out, *skillDoc, *check); err != nil {
		fmt.Fprintf(os.Stderr, "picoaide-wasm-imports-gen: %v\n", err)
		os.Exit(1)
	}
}

// sourceDump 是一个来源程序的 dump 结果。
type sourceDump struct {
	pkg   string
	raw   int // 导入段原始条数（允许同名重复）
	specs []wasmmod.ImportSpec
	wasm  []byte
}

func run(outPath, skillDocPath string, check bool) error {
	root, err := moduleRoot()
	if err != nil {
		return err
	}
	if outPath == "" {
		outPath = filepath.Join(root, generatedRelPath)
	}
	if !filepath.IsAbs(outPath) {
		outPath = filepath.Join(root, outPath)
	}
	if skillDocPath == "" {
		skillDocPath = filepath.Join(root, skillImportsRelPath)
	}
	if !filepath.IsAbs(skillDocPath) {
		skillDocPath = filepath.Join(root, skillDocPath)
	}

	tmpDir, err := os.MkdirTemp("", "picoaide-wasm-imports-")
	if err != nil {
		return fmt.Errorf("创建临时目录: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// 1) 逐份真编译并 dump 导入集。
	dumps := make([]sourceDump, 0, len(whitelistSources))
	for _, pkg := range whitelistSources {
		wasmPath := filepath.Join(tmpDir, strings.ReplaceAll(strings.TrimPrefix(pkg, "./"), "/", "_")+".wasm")
		if err := buildPackage(root, pkg, wasmPath); err != nil {
			return err
		}
		raw, err := os.ReadFile(wasmPath)
		if err != nil {
			return fmt.Errorf("读取 %s 的编译产物: %w", pkg, err)
		}
		// 用 Parse 而不是 Validate：白名单本就是要生成的东西（自举——Validate 会拿**旧的**
		// 包级白名单判据，第一次生成/扩面时必然全红）。第 3 步立刻用新清单自检，等价走完整校验路径。
		info, err := wasmmod.Parse(raw)
		if err != nil {
			return fmt.Errorf("解析 %s 的产物: %w", pkg, err)
		}
		dumps = append(dumps, sourceDump{pkg: pkg, raw: len(info.Imports), specs: dedupSorted(info.Imports), wasm: raw})
	}

	// 2) 并集（去重 + 确定性排序）。
	specs := mergeSorted(dumps)

	// 3) 用新清单**逐份**自检：少一条这里就红，不会等 CI 才发现。
	for _, d := range dumps {
		if _, err := wasmmod.ValidateWithWhitelist(d.wasm, specs); err != nil {
			return fmt.Errorf("%s 未通过静态校验（说明生成逻辑或该程序有问题）: %w", d.pkg, err)
		}
	}

	content, err := render(specs, dumps)
	if err != nil {
		return err
	}
	// 作者面那一份：**同一份 specs**，多一层"每个符号都要有作者面说明"的把关
	// （新增导入面时忘了写说明 ⇒ 生成器直接失败，而不是悄悄出一行空白表格）。
	skillDoc, err := renderSkillDoc(specs)
	if err != nil {
		return err
	}

	// 4) 写出或比对。
	if check {
		if err := compareWithDisk(outPath, content, "导入面白名单"); err != nil {
			return err
		}
		if err := compareWithDisk(skillDocPath, skillDoc, "作者面导入面文档（references/imports.md）"); err != nil {
			return err
		}
		fmt.Printf("-check 通过：%s 的并集与 %s 逐条一致（%d 条）；平台侧真源与作者面文档 %s 都与真源**逐字节**一致（含行尾与 EOF）\n",
			strings.Join(whitelistSources, " ∪ "), filepath.ToSlash(outPath), len(specs), filepath.ToSlash(skillDocPath))
		return nil
	}

	for _, art := range []struct {
		path    string
		content []byte
		what    string
	}{
		{outPath, content, "平台侧真源"},
		{skillDocPath, skillDoc, "作者面文档"},
	} {
		if err := os.MkdirAll(filepath.Dir(art.path), 0o755); err != nil {
			return fmt.Errorf("创建 %s 的输出目录: %w", art.what, err)
		}
		if err := os.WriteFile(art.path, art.content, 0o644); err != nil {
			return fmt.Errorf("写入 %s（%s）: %w", art.path, art.what, err)
		}
		fmt.Printf("已写出 %s（%s）\n", filepath.ToSlash(art.path), art.what)
	}
	for _, d := range dumps {
		fmt.Printf("  %-42s 导入段原始 %3d 条，去重后 %3d 条\n", d.pkg, d.raw, len(d.specs))
	}
	fmt.Printf("并集（去重 + 确定性排序）：%d 条\n", len(specs))
	for _, s := range specs {
		fmt.Printf("  %-44s %-7s %s\n", s.Module+"."+s.Name, s.Kind, s.Signature)
	}
	return nil
}

// compareWithDisk 比对提交的生成物与实时产物（-check 门禁的唯一实现，两份产物共用）。
//
// 判据是**逐字节相等**（R2-SK-3）：这两份产物都会原样下发/被校验器读取，行尾风格或
// EOF 空行数的变化同样是"下发字节变了"。`normalizeForDiff` 只用来把差异讲成人话，
// 绝不参与判定 —— 否则门禁会一边容忍 CRLF/尾随空行，一边打印"逐字节一致"。
func compareWithDisk(path string, want []byte, what string) error {
	onDisk, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取 %s（%s）: %w（-check 模式要求该文件已提交）", path, what, err)
	}
	if bytes.Equal(onDisk, want) {
		return nil
	}
	return fmt.Errorf("%s 与参考程序不一致（%s）\n  第一处差异：%s\n"+
		"  修复：cd server && go run ./cmd/picoaide-wasm-imports-gen",
		what, path, firstDiffLine(onDisk, want))
}

// buildPackage 用 wasip1 目标编译一个参考程序。
func buildPackage(root, pkg, out string) error {
	cmd := exec.Command("go", "build", "-trimpath", "-o", out, pkg)
	cmd.Dir = root
	// 继承当前进程 env（GOCACHE/GOMODCACHE 必须可见），只覆盖目标三元组。
	cmd.Env = envWith(map[string]string{"GOOS": "wasip1", "GOARCH": "wasm", "CGO_ENABLED": "0"})
	var stderr bytes.Buffer
	cmd.Stdout = &stderr
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("编译 %s 失败（GOOS=wasip1 GOARCH=wasm go build %s）: %w\n%s",
			pkg, pkg, err, stderr.String())
	}
	return nil
}

// envWith 以当前进程 env 为底、覆盖指定键（同名键**替换**而不是追加，避免"首个匹配生效"的环境差异）。
func envWith(overrides map[string]string) []string {
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

// dedupSorted 对**单份**程序的导入集去重并按确定性顺序排序（module → name → kind → signature）。
//
// 为什么去重：导入段允许同一符号出现多次（实测 fd_write×2、path_filestat_get×2 等，
// 分别给不同调用点用），而白名单是"符号 + 类型的集合"，重复条目没有意义。
func dedupSorted(imports []wasmmod.Import) []wasmmod.ImportSpec {
	seen := make(map[wasmmod.ImportSpec]bool, len(imports))
	out := make([]wasmmod.ImportSpec, 0, len(imports))
	for _, imp := range imports {
		spec := wasmmod.ImportSpec{Module: imp.Module, Name: imp.Name, Kind: imp.Kind, Signature: imp.Signature}
		if seen[spec] {
			continue
		}
		seen[spec] = true
		out = append(out, spec)
	}
	sortSpecs(out)
	return out
}

// mergeSorted 把多份程序的导入集合并、去重并排序（白名单 = 各来源的并集）。
func mergeSorted(dumps []sourceDump) []wasmmod.ImportSpec {
	seen := map[wasmmod.ImportSpec]bool{}
	out := make([]wasmmod.ImportSpec, 0, 64)
	for _, d := range dumps {
		for _, spec := range d.specs {
			if seen[spec] {
				continue
			}
			seen[spec] = true
			out = append(out, spec)
		}
	}
	sortSpecs(out)
	return out
}

func sortSpecs(specs []wasmmod.ImportSpec) {
	sort.Slice(specs, func(i, j int) bool {
		a, b := specs[i], specs[j]
		if a.Module != b.Module {
			return a.Module < b.Module
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Signature < b.Signature
	})
}

// render 渲染 imports_gen.go（用 go/format 保证 gofmt 干净）。
func render(specs []wasmmod.ImportSpec, dumps []sourceDump) ([]byte, error) {
	var b strings.Builder
	b.WriteString("// Code generated by picoaide-wasm-imports-gen; DO NOT EDIT.\n")
	b.WriteString("//\n")
	b.WriteString("// 重跑（改任一来源程序、或升级 Go 工具链后**必须**重跑）：\n")
	b.WriteString("//\n")
	b.WriteString("//\tcd server && go run ./cmd/picoaide-wasm-imports-gen\n")
	b.WriteString("//\n")
	b.WriteString("// 比对模式（门禁，不一致即非零退出）：\n")
	b.WriteString("//\n")
	b.WriteString("//\tcd server && go run ./cmd/picoaide-wasm-imports-gen -check\n")
	b.WriteString("//\n")
	b.WriteString("// 判据 = 符号 + 类型（§4.2）。数据来源 = 下列参考程序真编译产物（GOOS=wasip1 GOARCH=wasm）\n")
	b.WriteString("// 导入段的**并集** —— 手写清单即门禁测试红（§5.5「导入面生成」）。\n")
	for _, d := range dumps {
		fmt.Fprintf(&b, "//   - %-38s 原始 %3d 条 / 去重 %3d 条\n", d.pkg, d.raw, len(d.specs))
	}
	b.WriteString("//\n")
	b.WriteString("// ⚠️ 白名单的语义 = **Go wasip1 运行时可能发出的全部 wasi_snapshot_preview1 导入**\n")
	b.WriteString("// （保守超集），不是「参考实现恰好用到的那些」：只按最小样例生成会让任何用了一行 os.Stat\n")
	b.WriteString("// 的合法 Go 应用被判 IMPORT_NOT_ALLOWED（模块 C 实测缺陷）；同理，[P0-1/2026-09-18] 实测\n")
	b.WriteString("// html/text template 的 **Execute（渲染）** 会带出 sock_accept / sock_shutdown、\n")
	b.WriteString("// (*os.File).ReadAt/WriteAt 会带出 fd_pread / fd_pwrite —— 缺这四条时「用 html/template\n")
	b.WriteString("// 渲染页面的合法应用」根本发不出去（本平台最主要的用法，§4.2 R8）。\n")
	b.WriteString("// 为什么允许 path_open / fd_readdir / fd_pread 等并不违反红线：\n")
	b.WriteString("//   - 红线 5（不能读宿主文件）由**运行时零 preopen** 保证（§4.3 / §15.1 第 1 条）：没有任何\n")
	b.WriteString("//     preopen 时文件操作一律 DENIED，errno 视调用层与路径形态为 EBADF(8) / EPERM(63) /\n")
	b.WriteString("//     ENOTDIR(54) —— **不是 ENOSYS**（审计实测 errno 矩阵，2026-09-18 更正），guest 拿不到可用 fd；\n")
	b.WriteString("//   - 红线 4（不能出站）由「**没有任何途径得到一个 socket fd**」保证：preview1 只有\n")
	b.WriteString("//     sock_accept / sock_recv / sock_send / sock_shutdown，**没有** sock_open / sock_bind /\n")
	b.WriteString("//     sock_listen / sock_connect ⇒ 自造不出 socket fd（实测 sock_accept(0..10) 与\n")
	b.WriteString("//     sock_shutdown(3) 全 EBADF(8)，syscall.Socket 在 wasip1 上不可用）。所以白名单要拒的是\n")
	b.WriteString("//     **造 fd 的那几个 sock_* 符号**与非 wasi_snapshot_preview1 的模块（imports_gen_test.go\n")
	b.WriteString("//     有反向断言），而不是把 Go 运行时会发出的 sock_accept / sock_shutdown 一并拒掉。\n")
	b.WriteString("//\n")
	b.WriteString("// ⚠️ 这里列的是 **WASI 导入**，不是宿主能力：宿主能力（db.* / log / assets.read 等）\n")
	b.WriteString("// 走 stdin/stdout 上的 JSON-RPC（§7.2），根本不经过 wasm 导入段；其中 **fd_read** 是 ABI 读\n")
	b.WriteString("// stdin 请求帧的硬要求（§4.2）。\n")
	b.WriteString("//\n")
	b.WriteString("// 签名格式：" + wasmmod.SignatureFormatDoc + "\n")
	fmt.Fprintf(&b, "//\n// 本次生成：并集 %d 条 (module, name, kind, signature)。\n", len(specs))
	b.WriteString("\npackage wasmmod\n\n")
	b.WriteString("// ImportWhitelist 是导入面白名单（生成产物，勿手改；判据 = 符号 + 类型，§4.2）。\n")
	b.WriteString("var ImportWhitelist = []ImportSpec{\n")
	for _, s := range specs {
		fmt.Fprintf(&b, "\t{Module: %q, Name: %q, Kind: %s, Signature: %q},\n",
			s.Module, s.Name, kindExpr(s.Kind), s.Signature)
	}
	b.WriteString("}\n")

	formatted, err := format.Source([]byte(b.String()))
	if err != nil {
		return nil, fmt.Errorf("渲染生成文件失败（说明模板不是合法 Go）: %w", err)
	}
	return formatted, nil
}

// kindExpr 把种类值渲染成 wasmmod 里的常量名（保持生成文件可读）。
func kindExpr(kind string) string {
	switch kind {
	case wasmmod.KindFunc:
		return "KindFunc"
	case wasmmod.KindMemory:
		return "KindMemory"
	case wasmmod.KindTable:
		return "KindTable"
	case wasmmod.KindGlobal:
		return "KindGlobal"
	default:
		return strconv.Quote(kind)
	}
}

// symbolNotes 是**作者面**的逐符号说明：这个符号为什么在表里（作者判断"我的写法会不会
// 被拒"时读的就是这一列）。
//
// 它是生成器的一部分，因此受两层门禁保护：
//   - renderSkillDoc 要求白名单里**每个**符号都有说明 —— 少了就直接失败（Go 升级带来
//     新导入面时，必须有人回答"为什么放行它"，而不是悄悄多出一行空白）；
//   - 说明文本进 references/imports.md，而该文档由 `-check` 与实时产物逐字节对拍。
//
// ⚠️ 写说明时的两条纪律（有测试守着）：不写具体上限数字（那属于 limits.md，写在这里
// 会与 limits 的"数字单一真源"门禁打架）；不写真实的客户域名（skill 是客户可见交付物）。
var symbolNotes = map[string]string{
	// —— ABI 与运行时硬要求 ——
	"fd_read":           "从 stdin 读请求帧（帧协议的硬要求：不读 stdin 就收不到任何请求）",
	"fd_write":          "把响应帧写到 stdout",
	"proc_exit":         "guest 退出（Go 运行时的致命错误与正常收尾都会走它）",
	"args_get":          "Go 运行时启动时读命令行参数（平台不传 args，读到的是空）",
	"args_sizes_get":    "同上：参数长度的查询（Go 运行时启动路径的一部分）",
	"environ_get":       "Go 运行时启动时读环境变量（平台不传 env，读到的是空）",
	"environ_sizes_get": "同上：环境变量长度的查询（Go 运行时启动路径的一部分）",
	"random_get":        "`crypto/rand` / `math/rand` 的随机源（平台注入真实随机源）",
	"clock_time_get":    "`time.Now` 等时间读取（平台注入真实墙钟）",
	"poll_oneoff":       "`time.Sleep` / 定时等待（Go wasip1 用它实现睡眠）",
	"sched_yield":       "调度让出（Go 运行时在自旋/等待路径上发出）",

	// —— os 包的文件面：运行期零 preopen ⇒ 拿不到可用描述符，但**编译期必须放行** ——
	"path_open":               "`os.Open` / `os.Create` / `os.OpenFile`（零 preopen 下失败，不是「没有实现」）",
	"path_filestat_get":       "`os.Stat` / `os.Lstat`、`MkdirAll` 的逐级检查",
	"fd_readdir":              "`os.ReadDir` / `filepath.WalkDir` / `RemoveAll` 的遍历",
	"path_create_directory":   "`os.Mkdir` / `os.MkdirAll`",
	"path_unlink_file":        "`os.Remove` / `os.RemoveAll`",
	"path_remove_directory":   "`os.Remove` / `os.RemoveAll` 删目录的那一步",
	"path_rename":             "`os.Rename`（安装型/临时文件的常见写法）",
	"path_symlink":            "`os.Symlink`（连同下面的 readlink 都是 os 包文件面的一部分）",
	"path_readlink":           "`os.Readlink` / `filepath.EvalSymlinks`",
	"path_filestat_set_times": "`os.Chtimes` / `os.Chtimes` 系的写时间戳",
	"fd_filestat_get":         "`(*os.File).Stat`（对已有描述符取状态）",
	"fd_filestat_set_size":    "`(*os.File).Truncate`",
	"fd_fdstat_get":           "取描述符状态（os 包在 `Fd()` / 终端判断路径上会问）",
	"fd_fdstat_set_flags":     "设置描述符标志（Go 运行时给非阻塞 IO 用的那一手）",
	"fd_close":                "关闭描述符（defer f.Close() 的收尾）",
	"fd_seek":                 "`(*os.File).Seek`",
	"fd_sync":                 "`(*os.File).Sync`",
	"fd_prestat_get":          "枚举预打开目录（零 preopen ⇒ 一个都枚举不到）",
	"fd_prestat_dir_name":     "同上：取预打开目录的名字",

	// —— 模板渲染与 ReadAt/WriteAt：审计 P0-1 实测的"合法应用发不出去"面 ——
	"fd_pread":  "`(*os.File).ReadAt`（`html/template` 的部分渲染路径会用到）",
	"fd_pwrite": "`(*os.File).WriteAt`",
	"sock_accept": "`html/template` / `text/template` 的 `Execute`（渲染页面）会带出它；" +
		"它只能从**已监听**的描述符接连接，而平台里没有任何途径造出这种描述符",
	"sock_shutdown": "模板渲染路径的收尾调用；描述符不存在 ⇒ 直接失败，不构成出站途径",
	"sock_recv": "**TinyGo 的 `net/url` 路径**会带出它（与 sock_accept/sock_shutdown 同理：Go 运行时不会发，" +
		"TinyGo 会）。它需要一个**已连接**的 socket 描述符，而平台里造不出这种描述符" +
		"（没有 sock_open/bind/listen/connect；sock_accept 只能从已监听的描述符接连接，实测拿不到）⇒ 能力为空",
	"sock_send": "同上：TinyGo 路径的发送侧符号，没有可用描述符就无从发送（不是出站途径）",
}

// renderSkillDoc 渲染**作者面**的导入面文档（内置技能的 references/imports.md）。
//
// 与 render 的分工：render 出的是校验器读的 Go 真源；本函数出的是作者/AI 读的 Markdown。
// 两者数据同源（同一份 specs），因此不可能各自漂移；`-check` 同时守两份。
func renderSkillDoc(specs []wasmmod.ImportSpec) ([]byte, error) {
	var b strings.Builder
	b.WriteString("# 导入面白名单（`wasi_snapshot_preview1`）\n\n")
	b.WriteString("> **本文件是生成产物，不要手改**（改了平台行为不会变，只会让门禁变红）。\n")
	b.WriteString(">\n")
	b.WriteString("> 重新生成：`cd server && go run ./cmd/picoaide-wasm-imports-gen`\n")
	b.WriteString("> 比对模式（门禁，不一致即非零退出）：`cd server && go run ./cmd/picoaide-wasm-imports-gen -check`\n")
	b.WriteString(">\n")
	b.WriteString("> 平台侧真源：`server/internal/wasmapp/wasmmod/imports_gen.go`（同一生成器的另一份产物）。\n\n")
	b.WriteString("## 这张表是什么\n\n")
	b.WriteString("发布预检会逐条校验 wasm 的**导入段**：只有下表里的 (模块, 符号, 类型) 才放行。\n")
	b.WriteString("不在表里的符号 → 422 `IMPORT_NOT_ALLOWED`；符号在表里但类型不符 → 422 `IMPORT_SIGNATURE_MISMATCH`。\n")
	b.WriteString("错误信封的 `details.symbol` 点名**第一个**出问题的导入（形如 `wasi_snapshot_preview1.path_open`），\n")
	b.WriteString("`details.expected` / `details.actual` 给出类型差异，`hints` 给出通用改法。\n\n")
	b.WriteString("表里只有一个模块名：`wasi_snapshot_preview1`（`wasm32-wasip1` 的 WASI 预览 1）。\n")
	b.WriteString("`env.*` / `js.*` / `wasi_unstable` / 组件模型命名空间一律不放行。\n\n")
	b.WriteString("⚠️ 这里列的是 **WASI 导入**，不是平台能力：`db.*` / `log` / `assets.read`\n")
	b.WriteString("走的是 stdin/stdout 上的 JSON-RPC，根本不经过导入段（见 `references/abi.md`）。\n\n")
	b.WriteString("## 为什么这是「保守超集」\n\n")
	b.WriteString("白名单的语义是「**Go 的 `wasip1` 运行时可能发出的全部 WASI 导入**」，不是「参考实现恰好用到的那些」：\n")
	b.WriteString("它由多个参考程序的真编译产物取**并集**生成（逐份条数记在 `imports_gen.go` 头部）。原因：\n\n")
	b.WriteString("- **少一条 = 功能缺陷。** 一行 `os.Stat` 会引入 `path_filestat_get`，`html/template` 的\n")
	b.WriteString("  `Execute`（渲染页面）会引入 `sock_accept` / `sock_shutdown`，`(*os.File).ReadAt` /\n")
	b.WriteString("  `WriteAt` 会引入 `fd_pread` / `fd_pwrite`。名单窄了，**合法应用会在发布预检被拒** ——\n")
	b.WriteString("  而它在本机编译、自测都是好的（审计实测过的功能缺陷，不是理论风险）。\n")
	b.WriteString("- **多一条 ≠ 放开红线**，因为两条红线都不由这张表保证：\n")
	b.WriteString("  - **读不到宿主文件**：运行期**零 preopen** —— 没有任何预打开目录时，`path_open` /\n")
	b.WriteString("    `fd_readdir` 这类调用拿不到可用的描述符（失败，不是「没有实现」）；\n")
	b.WriteString("  - **出不了网**：预览 1 里没有 `sock_open` / `sock_bind` / `sock_listen` / `sock_connect`，\n")
	b.WriteString("    自造不出 socket 描述符；表里的 `sock_accept` / `sock_shutdown` 是 Go 运行时自己发起的\n")
	b.WriteString("    等待与收尾调用，同样拿不到监听描述符。\n\n")
	b.WriteString("所以「表里有 `path_open`」不等于「能读文件」，「表里有 `sock_accept`」不等于「能联网」：\n")
	b.WriteString("真正被拒的是**能造出描述符的那几个符号**与非 `wasi_snapshot_preview1` 的模块。\n\n")
	b.WriteString("## 撞到 `IMPORT_NOT_ALLOWED` 怎么办\n\n")
	b.WriteString("1. **先看它点名了哪个符号**：`details.symbol`（连同 `details.name` / `details.signature`）就是第一个\n")
	b.WriteString("   不被放行的导入。失败的发布**不占版本号**，改完重发即可。\n")
	b.WriteString("2. **对照本表**：\n")
	b.WriteString("   - 表里没有这个符号 → 它属于平台刻意不放行的一类：不要引入依赖它的库或运行时\n")
	b.WriteString("     （例如需要 socket 的网络客户端），平台能力一律走 stdin/stdout 上的 JSON-RPC\n")
	b.WriteString("     （`db.*` / `log` / `assets.read`）；\n")
	b.WriteString("   - 表里有、但报的是 `IMPORT_SIGNATURE_MISMATCH` → 类型不符：按 `references/abi.md` §2 的\n")
	b.WriteString("     读帧/写帧样板重写，并确认编译目标是 `wasm32-wasip1`（Go：`GOOS=wasip1 GOARCH=wasm`）。\n")
	b.WriteString("3. **不要自己往名单里加符号**：`imports_gen.go` 与本文档都是生成产物，手写即门禁红；\n")
	b.WriteString("   扩面必须改参考程序并重跑生成器。\n")
	b.WriteString("4. **如果它是「合法 Go 代码必然会发出」的符号**（例如某个标准库路径带来的新导入）：那是平台的\n")
	b.WriteString("   覆盖面缺陷，不是你写错了 —— 把最小复现（一小段能编译的 Go 代码 + 报错里的 `details.symbol`）\n")
	b.WriteString("   交给平台管理员，由他们扩面后重新生成这一份文档。\n\n")
	b.WriteString("## 符号与签名\n\n")
	b.WriteString("签名格式：" + wasmmod.SignatureFormatDoc + "\n\n")
	b.WriteString("| 模块 | 符号 | 种类 | 签名 | 为什么放行 |\n")
	b.WriteString("| --- | --- | --- | --- | --- |\n")
	for _, s := range specs {
		note, ok := symbolNotes[s.Name]
		if !ok || strings.TrimSpace(note) == "" {
			return nil, fmt.Errorf("导入符号 %s 还没有作者面说明：请在 cmd/picoaide-wasm-imports-gen 的 "+
				"symbolNotes 里补一句「为什么放行它」（作者读的就是这一列）", s.Name)
		}
		fmt.Fprintf(&b, "| `%s` | `%s` | %s | `%s` | %s |\n", s.Module, s.Name, s.Kind, s.Signature, note)
	}
	fmt.Fprintf(&b, "\n本次生成：并集 %d (module, name, kind, signature)，符号、签名与说明均出自同一生成器。\n", len(specs))
	return []byte(b.String()), nil
}

// normalizeForDiff 只服务差异展示：把行尾统一成 LF、去掉尾部空行，这样"改了内容"
// 的报错能落到正确的那一行上（CRLF 差异下首行会整份不同、没有可读的行号）。
//
// ⚠️ 它**不参与** -check 的判定（判定是 bytes.Equal，见 compareWithDisk）：一旦这里
// 的归一化回到判定路径，"改行尾/尾随空行 ⇒ 下发字节变了但门禁绿"就会重演（R2-SK-3）。
func normalizeForDiff(b []byte) []byte {
	s := strings.ReplaceAll(string(b), "\r\n", "\n")
	return []byte(strings.TrimRight(s, "\n"))
}

// firstDiffLine 给出第一处差异的人类可读描述（行号 + 两侧内容）。
func firstDiffLine(old, new []byte) string {
	oldLines := strings.Split(string(normalizeForDiff(old)), "\n")
	newLines := strings.Split(string(normalizeForDiff(new)), "\n")
	for i := 0; i < len(oldLines) || i < len(newLines); i++ {
		var o, n string
		if i < len(oldLines) {
			o = oldLines[i]
		}
		if i < len(newLines) {
			n = newLines[i]
		}
		if o != n {
			return fmt.Sprintf("第 %d 行\n    磁盘: %s\n    应为: %s", i+1, strings.TrimSpace(o), strings.TrimSpace(n))
		}
	}
	// 归一化后逐行相同 = 差异只在行尾 CRLF 或 EOF/尾随空行（这两类都会改变下发字节）。
	return "字节不同但逐行内容相同（差异在行尾 CRLF 或 EOF/尾随空行）—— 请重新生成产物"
}

// moduleRoot 从当前目录向上找 go.mod（默认输出路径是相对模块根的）。
func moduleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("获取当前目录: %w", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("从 %s 向上找不到 go.mod：请在 server/ 目录（模块根）下运行本命令", dir)
		}
		dir = parent
	}
}

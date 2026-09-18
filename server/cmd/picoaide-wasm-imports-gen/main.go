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
// 新增语言样例（Rust/Zig）时在这里加一条即可，生成器与门禁都会自动覆盖。
var whitelistSources = []string{
	"./internal/wasmapp/refapp",
	"./internal/wasmapp/refapp/wasiprobe",
	"./internal/wasmapp/refapp/stdprobe",
}

// generatedRelPath 是生成产物的默认位置（相对模块根）。
var generatedRelPath = filepath.Join("internal", "wasmapp", "wasmmod", "imports_gen.go")

func main() {
	out := flag.String("o", "", "输出路径（缺省 = <模块根>/"+filepath.ToSlash(generatedRelPath)+"）")
	check := flag.Bool("check", false, "比对模式：不写文件，生成结果与磁盘内容不一致时以非零退出")
	flag.Parse()

	if err := run(*out, *check); err != nil {
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

func run(outPath string, check bool) error {
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

	// 4) 写出或比对。
	if check {
		onDisk, err := os.ReadFile(outPath)
		if err != nil {
			return fmt.Errorf("读取 %s: %w（-check 模式要求该文件已提交）", outPath, err)
		}
		if !bytes.Equal(normalize(onDisk), normalize(content)) {
			return fmt.Errorf("导入面白名单与参考程序不一致（%s）\n  第一处差异：%s\n"+
				"  修复：cd server && go run ./cmd/picoaide-wasm-imports-gen",
				outPath, firstDiffLine(onDisk, content))
		}
		fmt.Printf("-check 通过：%s 的并集与 %s 逐条一致（%d 条）\n",
			strings.Join(whitelistSources, " ∪ "), filepath.ToSlash(outPath), len(specs))
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("创建输出目录: %w", err)
	}
	if err := os.WriteFile(outPath, content, 0o644); err != nil {
		return fmt.Errorf("写入 %s: %w", outPath, err)
	}
	fmt.Printf("已写出 %s\n", outPath)
	for _, d := range dumps {
		fmt.Printf("  %-42s 导入段原始 %3d 条，去重后 %3d 条\n", d.pkg, d.raw, len(d.specs))
	}
	fmt.Printf("并集（去重 + 确定性排序）：%d 条\n", len(specs))
	for _, s := range specs {
		fmt.Printf("  %-44s %-7s %s\n", s.Module+"."+s.Name, s.Kind, s.Signature)
	}
	return nil
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
	b.WriteString("// ⚠️ 这里列的是 **WASI 导入**，不是宿主能力：宿主能力（db.* / ai.chat / log / assets.read 等）\n")
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

// normalize 归一化行尾，避免 CRLF/尾空行造成假差异。
func normalize(b []byte) []byte {
	s := strings.ReplaceAll(string(b), "\r\n", "\n")
	return []byte(strings.TrimRight(s, "\n"))
}

// firstDiffLine 给出第一处差异的人类可读描述（行号 + 两侧内容）。
func firstDiffLine(old, new []byte) string {
	oldLines := strings.Split(string(normalize(old)), "\n")
	newLines := strings.Split(string(normalize(new)), "\n")
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
	return "内容相同（差异只在不影响阅读的空白）"
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

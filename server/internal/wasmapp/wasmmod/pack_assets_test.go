package wasmmod

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 R1-e2e-6 的**自证门禁**：平台把 wasm 自定义段当一等静态资源载体
// （段名 = 包内逻辑路径，发布期抽到宿主磁盘），但仓库里长期只有文档没有工具 ——
// 作者得自己拼 LEB128 段长度（第一版几乎必踩"段长度要含名字长度前缀"，平台回
// SECTION_MALFORMED）。现在官方脚本是 server/skills/app-builder/scripts/pack-assets.mjs。
//
// 这一组用例存在的理由：**脚本产出的模块必须能被平台自己的解析器接受**，
// 而"能接受"不能靠脚本自说自话 —— 所以这里真编译一个 Go wasip1 产物、真跑脚本、
// 再用平台侧的 Validate / ExtractCustomSections（发布期用的就是这份实现，
// compile/staticvalidate.go 只是它的适配器）断言逐字节一致。
//
// 变异验证（交付时实跑过，勿删；改动见 temp/pack-mutations/）：
//   - M1 把脚本 encodeAssetSection 的段长度改成只写内容长度（漏掉名字长度前缀与名字）
//     ⇒ TestPackAssetsScriptProducesModuleAcceptedByPlatform 红，报错就是作者踩过的那条：
//     `SECTION_MALFORMED: 第 6561326 字节处的段长度前缀非法`；
//   - M2 删掉保留资源拒绝（assertNotReservedOrToolchain 的 RESERVED_ASSET_NAME 分支）
//     ⇒ TestPackAssetsScriptRefusesNamesThatWouldBeDropped 的两个保留资源子用例红；
//   - M3 覆盖"绝不就地覆盖输入"的**两层**（同路径检查 + inode 检查，互为兜底）：
//     只拆同路径检查 ⇒ 用例仍绿（inode 那层接住，实测记录）；只拆 inode 检查 ⇒ 硬链接子用例红；
//     两层都拆 ⇒ 两个子用例红；
//   - M4 把脚本的总量口径退回"整段字节"（与平台 CustomBytes 的"负载"口径不一致）
//     ⇒ TestPackAssetsScriptMatchesPlatformSectionTotalLimit 红 —— 这条用例当初就是这样
//     抓到首版脚本把段 id 与长度前缀也算进总量的（会误拒正好等于上限的资源）。

// packAssetsScriptRelPath 是官方打包脚本（相对 server/ 模块根）。
//
// 为什么放技能目录而不是 server/scripts/：脚本要能被**作者/AI 真的用到** ——
// 技能整目录随服务端镜像分发（Dockerfile COPY skills/app-builder/ → /opt/picoaide/skills，
// 客户端能力中心按需安装到 <dshHome>/skills），而 server/scripts/ 不进镜像。
// 同目录先例 = examples/go/preview.mjs（作者侧零依赖 Node 工具）。
const packAssetsScriptRelPath = "skills/app-builder/scripts/pack-assets.mjs"

// packAssetsGuestPkg 是夹具程序：与 imports_coverage_test.go 同款（真编译，不手工拼字节）。
const packAssetsGuestPkg = "./internal/wasmapp/wasmmod/testdata/stdrender"

// packAssetsScriptPath 定位脚本（缺文件即 Fatal：脚本是交付物的一部分）。
func packAssetsScriptPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join(moduleRootForTest(t), filepath.FromSlash(packAssetsScriptRelPath))
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("官方打包脚本不存在（%s）: %v", packAssetsScriptRelPath, err)
	}
	return path
}

// packAssetsNode 返回 node 可执行文件；不可用时跳过（与 serverstore 的 parity 用例同口径）。
func packAssetsNode(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node 不可用，跳过打包脚本的端到端用例: %v", err)
	}
	return node
}

// runPackAssets 在 dir 下跑脚本，返回（合并输出, 退出码）。node 自己起不来即 Fatal。
func runPackAssets(t *testing.T, dir string, args ...string) (string, int) {
	t.Helper()
	node := packAssetsNode(t)
	script := packAssetsScriptPath(t)
	cmd := exec.Command(node, append([]string{script}, args...)...)
	cmd.Dir = dir
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	if err == nil {
		return buf.String(), 0
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("执行 node 失败: %v\n%s", err, buf.String())
	}
	return buf.String(), exit.ExitCode()
}

// writeFixture 把夹具 wasm 写进目录并返回路径。
func writeFixture(t *testing.T, dir string, raw []byte) string {
	t.Helper()
	path := filepath.Join(dir, "app.wasm")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("写夹具 wasm: %v", err)
	}
	return path
}

// writeAsset 写一个资源文件（自动建目录）。
func writeAsset(t *testing.T, dir, rel string, data []byte) string {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建资源目录: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("写资源 %s: %v", rel, err)
	}
	return path
}

// ===== ① 产出被平台接受 + 路径/内容逐字节一致 =====

func TestPackAssetsScriptProducesModuleAcceptedByPlatform(t *testing.T) {
	raw := buildSource(t, packAssetsGuestPkg)
	dir := t.TempDir()
	in := writeFixture(t, dir, raw)
	html := []byte("<!doctype html>\n<h1>共享笔记</h1>\n")
	css := []byte("body{color:#333}\n")
	// 二进制 + 非 UTF-8 字节：证明段内容按字节搬运（不能被当文本规范化）。
	bin := make([]byte, 0, 256)
	for i := 0; i < 256; i++ {
		bin = append(bin, byte(i))
	}
	writeAsset(t, dir, "web/index.html", html)
	writeAsset(t, dir, "web/assets/app.css", css)
	writeAsset(t, dir, "web/logo.bin", bin)

	out := filepath.Join(dir, "packed.wasm")
	stdout, code := runPackAssets(t, dir,
		"--in", in, "--out", out,
		"web/index.html=index.html",
		"web/assets/app.css=static/app.css",
		"--asset", "web/logo.bin=static/logo.bin",
	)
	if code != 0 {
		t.Fatalf("打包脚本退出码 %d，应当成功：\n%s", code, stdout)
	}

	packed, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("读产出: %v", err)
	}
	// 追加式：既有字节逐字节不变（脚本只往末尾追加自定义段）。
	if len(packed) <= len(raw) || !bytes.Equal(packed[:len(raw)], raw) {
		t.Fatalf("产出不是「原模块 + 追加段」：原 %d 字节，产出 %d 字节（前缀不一致）",
			len(raw), len(packed))
	}

	// ① 平台静态校验：发布期的同一条入口（compile.NewValidator 就是 wasmmod.Validate 的适配器）。
	if _, verr := Validate(packed); verr != nil {
		t.Fatalf("平台拒收脚本产出的模块（Validate 失败）: %v\n脚本输出:\n%s", verr, stdout)
	}

	// ② 发布期的抽取逻辑：段被识别、名字就是包内路径、内容逐字节一致。
	sections, xerr := ExtractCustomSections(packed)
	if xerr != nil {
		t.Fatalf("ExtractCustomSections: %v", xerr)
	}
	want := map[string][]byte{
		"index.html":      html,
		"static/app.css":  css,
		"static/logo.bin": bin,
	}
	for name, content := range want {
		got, ok := sections[name]
		if !ok {
			t.Fatalf("产出的模块里没有段 %q（实际段: %v）", name, sortedKeys(sections))
		}
		if !bytes.Equal(got, content) {
			t.Fatalf("段 %q 的内容与源文件不一致：%d 字节 vs %d 字节", name, len(got), len(content))
		}
	}
	// ③ 工具链自带的段不能被弄丢/弄坏（我们只追加）。
	before, err := ExtractCustomSections(raw)
	if err != nil {
		t.Fatalf("ExtractCustomSections(原模块): %v", err)
	}
	for name, content := range before {
		got, ok := sections[name]
		if !ok {
			t.Fatalf("原模块的段 %q 在产出里消失了", name)
		}
		if !bytes.Equal(got, content) {
			t.Fatalf("原模块的段 %q 内容被改动", name)
		}
	}
	// ④ 段名唯一（重名会让平台"只取第一个"，等于静默丢资源）。
	info := mustParse(t, packed)
	for name := range want {
		if n := info.CustomSectionCounts[name]; n != 1 {
			t.Fatalf("段 %q 出现了 %d 次（平台重名取第一个）", name, n)
		}
	}
	// ⑤ 保留资源绝不出现在模块里（它由平台在发布期写入）。
	if _, ok := sections[limits.AppConfigFileName]; ok {
		t.Fatalf("产出的模块里出现了保留资源段 %q —— 平台会忽略它、配置也写不进去",
			limits.AppConfigFileName)
	}
	t.Logf("产出 %d 字节（原 %d），自定义段 %d 字节，段: %v",
		len(packed), len(raw), info.CustomBytes, sortedKeys(sections))
}

func sortedKeys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ===== ② 会被平台静默丢掉的段名：必须 fail-loud =====

func TestPackAssetsScriptRefusesNamesThatWouldBeDropped(t *testing.T) {
	raw := buildSource(t, packAssetsGuestPkg)
	dir := t.TempDir()
	in := writeFixture(t, dir, raw)
	writeAsset(t, dir, "web/a.txt", []byte("hello\n"))

	cases := []struct {
		name string
		spec string
		want string // 报错必须点名的关键词
	}{
		{"保留资源配置", "web/a.txt=" + limits.AppConfigFileName, "保留资源"},
		{"保留资源当目录", "web/a.txt=" + limits.AppConfigFileName + "/notes.txt", "保留资源"},
		{"工具链元数据段 name", "web/a.txt=name", "工具链"},
		{"工具链元数据段 producers", "web/a.txt=producers", "工具链"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := filepath.Join(t.TempDir(), "packed.wasm")
			stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, tc.spec)
			if code == 0 {
				t.Fatalf("段名 %q 应当被拒（平台会静默丢掉 / 当作保留资源），实际退出码 0：\n%s",
					tc.spec, stdout)
			}
			if !strings.Contains(stdout, tc.want) {
				t.Fatalf("报错没有点名 %q（作者看不懂该怎么改）：\n%s", tc.want, stdout)
			}
			if _, err := os.Stat(out); err == nil {
				t.Fatalf("被拒的调用不该留下产出文件 %s", out)
			}
		})
	}

	t.Run("重复的包内路径", func(t *testing.T) {
		out := filepath.Join(t.TempDir(), "packed.wasm")
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out,
			"web/a.txt=index.html", "--asset", "web/a.txt=index.html")
		if code == 0 || !strings.Contains(stdout, "重复") {
			t.Fatalf("同一次调用里重复的包内路径必须被拒（平台只取第一个）：code=%d\n%s", code, stdout)
		}
		if _, err := os.Stat(out); err == nil {
			t.Fatalf("被拒的调用不该留下产出文件 %s", out)
		}
	})

	t.Run("模块里已有同名段", func(t *testing.T) {
		// 用脚本自己的产出当下一次输入：一并证明"产出还能继续当输入"。
		first := filepath.Join(t.TempDir(), "first.wasm")
		if stdout, code := runPackAssets(t, dir, "--in", in, "--out", first, "web/a.txt=index.html"); code != 0 {
			t.Fatalf("第一轮打包失败：%d\n%s", code, stdout)
		}
		second := filepath.Join(t.TempDir(), "second.wasm")
		stdout, code := runPackAssets(t, dir, "--in", first, "--out", second, "web/a.txt=index.html")
		if code == 0 {
			t.Fatalf("模块里已有同名段时必须被拒（平台重名取第一个 ⇒ 静默丢资源）：\n%s", stdout)
		}
		if !strings.Contains(stdout, "重名") {
			t.Fatalf("报错没说明「重名会被平台丢掉」：\n%s", stdout)
		}
	})
}

// ===== ③ 非法输入（路径/参数/文件）报错可读 =====

func TestPackAssetsScriptRejectsInvalidInputs(t *testing.T) {
	raw := buildSource(t, packAssetsGuestPkg)
	dir := t.TempDir()
	in := writeFixture(t, dir, raw)
	writeAsset(t, dir, "web/a.txt", []byte("hello\n"))
	longSegment := strings.Repeat("a", 256)
	longPath := strings.Repeat("d/", 130) + "a.txt" // 265 字节

	cases := []struct {
		name string
		spec string
		want string
	}{
		{"绝对路径", "web/a.txt=/etc/passwd", "绝对路径"},
		{"空段", "web/a.txt=a//b.txt", "空段"},
		{"父目录段", "web/a.txt=../escape.txt", ".."},
		{"反斜杠", `web/a.txt=static\a.txt`, "反斜杠"},
		{"冒号", "web/a.txt=static:a.txt", "冒号"},
		{"尾随斜杠", "web/a.txt=static/", "空段"},
		{"空包内路径", "web/a.txt=", "为空"},
		{"单段超长", "web/a.txt=" + longSegment, "255"},
		{"整路径超长", "web/a.txt=" + longPath, "256"},
		{"不是 SRC=DEST", "web/a.txt", "SRC=DEST"},
		{"源文件不存在", "web/missing.txt=index.html", "不存在"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := filepath.Join(t.TempDir(), "packed.wasm")
			stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, tc.spec)
			if code == 0 {
				t.Fatalf("非法输入 %q 应当被拒：\n%s", tc.spec, stdout)
			}
			if !strings.Contains(stdout, tc.want) {
				t.Fatalf("报错没有点名 %q：\n%s", tc.want, stdout)
			}
			if _, err := os.Stat(out); err == nil {
				t.Fatalf("被拒的调用不该留下产出文件 %s", out)
			}
		})
	}

	t.Run("源路径是目录", func(t *testing.T) {
		out := filepath.Join(t.TempDir(), "packed.wasm")
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, "web=index.html")
		if code == 0 || !strings.Contains(stdout, "不是普通文件") {
			t.Fatalf("源路径是目录必须被拒：code=%d\n%s", code, stdout)
		}
	})
}

// ===== ④ 畸形 wasm 输入 =====

func TestPackAssetsScriptRejectsMalformedModule(t *testing.T) {
	raw := buildSource(t, packAssetsGuestPkg)

	t.Run("不是 wasm", func(t *testing.T) {
		dir := t.TempDir()
		in := writeAsset(t, dir, "notwasm.wasm", []byte("#!/bin/sh\necho nope\n"))
		writeAsset(t, dir, "web/a.txt", []byte("hello\n"))
		out := filepath.Join(dir, "packed.wasm")
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, "web/a.txt=index.html")
		if code == 0 || !strings.Contains(stdout, "魔数") {
			t.Fatalf("非 wasm 输入必须被拒并点明魔数：code=%d\n%s", code, stdout)
		}
		if _, err := os.Stat(out); err == nil {
			t.Fatalf("畸形输入不该留下产出文件")
		}
	})

	t.Run("段表截断", func(t *testing.T) {
		dir := t.TempDir()
		// 砍掉尾部 16 字节：最后一个段声明的长度必然越界。
		in := writeAsset(t, dir, "truncated.wasm", raw[:len(raw)-16])
		writeAsset(t, dir, "web/a.txt", []byte("hello\n"))
		out := filepath.Join(dir, "packed.wasm")
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, "web/a.txt=index.html")
		if code == 0 {
			t.Fatalf("截断的模块必须被拒（否则产出必然被平台回 SECTION_MALFORMED）：\n%s", stdout)
		}
		if !strings.Contains(stdout, "字节") {
			t.Fatalf("报错应当给出字节位置/长度：\n%s", stdout)
		}
		if _, err := os.Stat(out); err == nil {
			t.Fatalf("畸形输入不该留下产出文件")
		}
	})
}

// ===== ⑤ 绝不就地覆盖输入 =====

func TestPackAssetsScriptNeverOverwritesInput(t *testing.T) {
	raw := buildSource(t, packAssetsGuestPkg)

	t.Run("out 与 in 同路径", func(t *testing.T) {
		dir := t.TempDir()
		in := writeFixture(t, dir, raw)
		writeAsset(t, dir, "web/a.txt", []byte("hello\n"))
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", in, "web/a.txt=index.html")
		if code == 0 {
			t.Fatalf("--out 与 --in 同路径必须被拒：\n%s", stdout)
		}
		if !strings.Contains(stdout, "就地覆盖") {
			t.Fatalf("报错应点明「绝不就地覆盖」：\n%s", stdout)
		}
		after, err := os.ReadFile(in)
		if err != nil {
			t.Fatalf("读回输入: %v", err)
		}
		if !bytes.Equal(after, raw) {
			t.Fatalf("输入被改动了（%d → %d 字节）", len(raw), len(after))
		}
	})

	t.Run("out 是 in 的硬链接", func(t *testing.T) {
		dir := t.TempDir()
		in := writeFixture(t, dir, raw)
		writeAsset(t, dir, "web/a.txt", []byte("hello\n"))
		link := filepath.Join(dir, "link.wasm")
		if err := os.Link(in, link); err != nil {
			t.Skipf("本文件系统不支持硬链接: %v", err)
		}
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", link, "web/a.txt=index.html")
		if code == 0 {
			// 这两个路径是同一个文件（inode 相同）：脚本按"绝不就地覆盖输入"的契约直接拒，
			// 不给"--out 其实是 --in 的另一个名字"留歧义空间。
			t.Fatalf("--out 是 --in 的硬链接必须被拒（两个名字同一个文件）：\n%s", stdout)
		}
		after, err := os.ReadFile(in)
		if err != nil {
			t.Fatalf("读回输入: %v", err)
		}
		if !bytes.Equal(after, raw) {
			t.Fatalf("输入被改动了")
		}
	})

	t.Run("缺 --out", func(t *testing.T) {
		dir := t.TempDir()
		in := writeFixture(t, dir, raw)
		writeAsset(t, dir, "web/a.txt", []byte("hello\n"))
		stdout, code := runPackAssets(t, dir, "--in", in, "web/a.txt=index.html")
		if code == 0 || !strings.Contains(stdout, "--out") {
			t.Fatalf("缺 --out 必须被拒并说明理由：code=%d\n%s", code, stdout)
		}
	})

	t.Run("缺资源参数", func(t *testing.T) {
		dir := t.TempDir()
		in := writeFixture(t, dir, raw)
		out := filepath.Join(dir, "packed.wasm")
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out)
		if code == 0 || !strings.Contains(stdout, "资源") {
			t.Fatalf("没有资源参数时必须被拒（否则作者以为打包成功了）：code=%d\n%s", code, stdout)
		}
	})

	t.Run("输出目录不存在", func(t *testing.T) {
		dir := t.TempDir()
		in := writeFixture(t, dir, raw)
		writeAsset(t, dir, "web/a.txt", []byte("hello\n"))
		out := filepath.Join(dir, "missing-dir", "packed.wasm")
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, "web/a.txt=index.html")
		if code == 0 || !strings.Contains(stdout, "目录不存在") {
			t.Fatalf("输出目录不存在必须报错（不静默 mkdir）：code=%d\n%s", code, stdout)
		}
	})
}

// ===== ⑥ 段总量上限与平台同口径（边界按 limits 现算，不与脚本共享数字）=====

func TestPackAssetsScriptMatchesPlatformSectionTotalLimit(t *testing.T) {
	raw := buildSource(t, packAssetsGuestPkg)
	dir := t.TempDir()
	in := writeFixture(t, dir, raw)

	existing := mustParse(t, raw).CustomBytes
	const name = "big.bin"
	// 平台口径（wasmmod/parse.go 的 `info.CustomBytes += size`）：算的是**段负载**，
	// 即"段名的长度前缀 + 段名 + 内容"，不含段 id 与段长度前缀本身。
	budget := limits.SectionTotalMaxBytes - existing
	contentLen := budget - lebLen(len(name)) - len(name)
	if contentLen <= 0 {
		t.Fatalf("边界内容长度为 %d（existing=%d budget=%d），夹具/上限不匹配", contentLen, existing, budget)
	}
	if got := assetPayloadLen(name, contentLen); got != budget {
		t.Fatalf("用例自身的边界算式错了：payload=%d budget=%d", got, budget)
	}

	t.Run("正好等于上限必须通过", func(t *testing.T) {
		writeAsset(t, dir, "web/big.bin", bytes.Repeat([]byte{0xab}, contentLen))
		out := filepath.Join(dir, "boundary.wasm")
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, "web/big.bin="+name)
		if code != 0 {
			t.Fatalf("总量正好等于 limits.SectionTotalMaxBytes=%d 时必须通过：\n%s",
				limits.SectionTotalMaxBytes, stdout)
		}
		packed, rerr := os.ReadFile(out)
		if rerr != nil {
			t.Fatalf("读产出: %v", rerr)
		}
		// 与平台口径逐字节对账：info.CustomBytes 必须正好落在上限上。
		if got := mustParse(t, packed).CustomBytes; got != limits.SectionTotalMaxBytes {
			t.Fatalf("产出模块的自定义段总量 %d，期望正好 %d —— 脚本与平台对「段负载含段名」的口径不一致",
				got, limits.SectionTotalMaxBytes)
		}
	})

	t.Run("超过上限必须拒绝", func(t *testing.T) {
		writeAsset(t, dir, "web/one-more.bin", bytes.Repeat([]byte{0xcd}, contentLen+1))
		out := filepath.Join(dir, "over.wasm")
		stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, "web/one-more.bin="+name)
		if code == 0 {
			t.Fatalf("超过上限 1 字节必须被拒（否则平台回 SECTION_OVERRIDE_OVERSIZE）：\n%s", stdout)
		}
		if !strings.Contains(stdout, "超过平台上限") {
			t.Fatalf("报错应点明超过平台上限：\n%s", stdout)
		}
		if _, serr := os.Stat(out); serr == nil {
			t.Fatalf("超限时不该留下产出文件")
		}
	})
}

// ===== ⑦ 脚本本身：离线可用（零第三方依赖）=====

func TestPackAssetsScriptHasNoThirdPartyDependencies(t *testing.T) {
	script := packAssetsScriptPath(t)
	raw, err := os.ReadFile(script)
	if err != nil {
		t.Fatalf("读脚本: %v", err)
	}
	text := string(raw)
	// 企业环境常常离线：脚本只允许用 Node 内置模块（node: 前缀）。
	importRe := regexp.MustCompile(`(?m)^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]`)
	matches := importRe.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		t.Fatalf("没有解析到任何 import —— 正则或脚本写法变了，本条判据会变成空转")
	}
	for _, m := range matches {
		if !strings.HasPrefix(m[1], "node:") {
			t.Errorf("打包脚本引入了非内置依赖 %q —— 作者机器常常离线，脚本必须零外部依赖", m[1])
		}
	}
	if strings.Contains(text, "require(") {
		t.Errorf("打包脚本出现 require( —— 本仓库的作者侧工具都是 ESM（.mjs），不要混用")
	}
	if !strings.Contains(text, "SECTION_MALFORMED") {
		t.Errorf("脚本头部应当写明它解决的是哪个失败（SECTION_MALFORMED / 段长度前缀），"+
			"否则作者/AI 遇到同类错误时不知道有这个工具：%s", packAssetsScriptRelPath)
	}
}

// lebLen 返回无符号 LEB128 编码 v 需要的字节数（用例侧独立实现，不复用脚本的）。
func lebLen(v int) int {
	n := 1
	for v >= 0x80 {
		v >>= 7
		n++
	}
	return n
}

// assetPayloadLen 返回"名字 + contentLen 字节内容"打成自定义段后的**负载**字节数
// （与 wasmmod/parse.go 的 CustomBytes 同口径：含段名的长度前缀与段名，不含段 id 与长度前缀）。
func assetPayloadLen(name string, contentLen int) int {
	return lebLen(len(name)) + len(name) + contentLen
}

// TestPreviewHostSelfTest 跑作者侧预览宿主的自检（`node preview.mjs --selftest`）。
//
// 为什么这条门禁必须存在：`preview.mjs` 在 2026-09-21 从"内存桩 + 三个正则解析 SQL"
// 换成了**真 SQLite**（`node:sqlite`）。换引擎最容易的退化是"作者本地看到的语义与线上
// 不同"——而那种偏差不会让任何 Go 测试变红（脚本是 Node 侧交付物）。`--selftest` 把
// 五条关键语义固化成可复跑判据：幂等建表、跨连接可见（真库）、query 路径不可写、
// 多语句拒绝、保留列 `_row_id` 不可见/不可提、事务回滚不落库、列类型枚举与平台一致。
//
// 变异验证（实跑过）：
//   - 把 PreviewDB.query 的只读连接换成读写连接 ⇒ 用例红（"query 路径上写数据"这条自检失败）；
//   - 去掉 #classify 的多语句判据 ⇒ 用例红；
//   - 不剥保留列 ⇒ 用例红。
func TestPreviewHostSelfTest(t *testing.T) {
	node := packAssetsNode(t)
	script := filepath.Join(moduleRootForTest(t), "skills", "app-builder", "examples", "go", "preview.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("作者侧预览宿主不存在（%s）: %v", script, err)
	}
	cmd := exec.Command(node, script, "--selftest")
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	out := buf.String()
	if err != nil {
		t.Fatalf("preview.mjs --selftest 失败: %v\n%s", err, out)
	}
	if !strings.Contains(out, "全过") {
		t.Fatalf("自检输出里没有「全过」（判据可能被改弱）：\n%s", out)
	}
	// 反向断言：自检**真的跑了**（有 ok 行），而不是"没跑到就退出 0"。
	if strings.Count(out, "  ok   ") < 8 {
		t.Fatalf("自检只跑过 %d 条，期望 ≥8 条：\n%s", strings.Count(out, "  ok   "), out)
	}
}

// firstNonEmptyLine 取输出的第一行非空内容（失败信息里给一句可读的脚本报错）。
func firstNonEmptyLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return "(脚本无输出)"
}

// TestPackAssetsSectionOrderParityWithPlatform 把"脚本的段表判据 == 平台"变成常驻判据。
//
// 为什么需要它（2026-09-21 二轮独立审计 P1-②）：`pack-assets.mjs` 的段表判据此前只做
// "纯 id 升序"，会把 TinyGo/LLVM 的**规范 DataCount 位置**误拒；本批把它改成与
// `wasmmod.Parse` 逐条同判（重复优先 → DataCount 特例 → 严格递增 → Tag(13) 拒绝）。
// 但**仓库里没有任何用例把重复段/DataCount/Tag 喂给那个脚本**（审计实跑 12 种形状证明
// 当时同判，同时 grep 证明零判据）⇒ 脚本侧任何回退都会静默复发
// "作者本地打包通过、平台发布被拒"，而门禁全绿。
//
// 判据口径：对每种形状，**脚本的接受/拒绝**必须与 `Parse` 的接受/拒绝一致
// （比 `Validate` 更贴切：脚本只复刻段表判据，不管导入/导出面）。11 种形状覆盖
// 合法基线与 DataCount 两种位置、6 类重复段、算术插空重复、Tag(13)、未知 id(14)、
// 以及"自定义段重复必须放行"的反向对照。
//
// 变异验证（审计已实跑其中一个方向）：把脚本的 `if (seenSectionIDs.has(id))` 改成
// `if (false)`，或删掉 `DATA_COUNT_SECTION_ID` 特例 ⇒ 本用例红。
func TestPackAssetsSectionOrderParityWithPlatform(t *testing.T) {
	base := wasmtest.Build(
		wasmtest.TypeSection(wasmtest.TypeFunc(wasmtest.Params(), wasmtest.Params())),
		wasmtest.FunctionSection(0),
		wasmtest.MemorySection(1),
		wasmtest.ExportSection(wasmtest.ExportMemory("memory", 0), wasmtest.ExportFunc("_start", 0)),
		wasmtest.CodeSection(wasmtest.Body(0x0b)),
	)
	cases := []struct {
		name string
		raw  []byte
	}{
		{"基线（规范升序）", base},
		{"DataCount 规范位置", wasmtest.WithDataCount()},
		{"DataCount 错位（Code 之后）", wasmtest.WithDataCountMisordered()},
		{"重复 Function", wasmtest.WithDuplicateSection(3, []byte{0x00}, []byte{0x00})},
		{"重复 Table", wasmtest.WithDuplicateSection(4, []byte{0x00}, []byte{0x00})},
		{"重复 Code", wasmtest.WithDuplicateSection(10, []byte{0x00}, []byte{0x00})},
		{"重复 Data", wasmtest.WithDuplicateSection(11, []byte{0x00}, []byte{0x00})},
		{"末尾重复 Function", wasmtest.WithDuplicateSectionAtTail(3, []byte{0x00}, []byte{0x00})},
		{"算术插空的重复段（3/4/3）", wasmtest.Build(
			wasmtest.TypeSection(wasmtest.TypeFunc(wasmtest.Params(), wasmtest.Params())),
			wasmtest.Section(3, []byte{0x00}),
			wasmtest.Section(4, []byte{0x00}),
			wasmtest.Section(3, []byte{0x00}),
		)},
		{"Tag(13)", wasmtest.Build(wasmtest.Section(13, []byte{0x00}))},
		{"未知 id(14)", wasmtest.Build(wasmtest.Section(14, []byte{0x00}))},
		{"自定义段重名（合法）", wasmtest.Build(
			wasmtest.CustomSection("a", []byte("1")),
			wasmtest.CustomSection("a", []byte("2")),
		)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, perr := Parse(tc.raw)
			platformOK := perr == nil

			dir := t.TempDir()
			in := writeFixture(t, dir, tc.raw)
			src := writeAsset(t, dir, "a.txt", []byte("hello"))
			out := filepath.Join(dir, "out.wasm")
			stdout, code := runPackAssets(t, dir, "--in", in, "--out", out, src+"=index.html")
			scriptOK := code == 0

			if scriptOK != platformOK {
				t.Fatalf("脚本与平台不同判（脚本接受=%v，平台 Parse 接受=%v）：\n"+
					"  平台错误：%v\n  脚本输出：%s\n"+
					"两侧必须同判：不同判的后果是「脚本放行 ⇒ 平台发布被拒」（或反向误拒合法产物）",
					scriptOK, platformOK, perr, firstNonEmptyLine(stdout))
			}
		})
	}
}

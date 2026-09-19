package skillseed

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// 本文件守 R1-pm-8 的**第二半**：内容变了，version 必须跟着变。
//
// 现场（独立审计 R1-pm-8 / SK-2）：`references/limits.md` 的内容真的改了（`app_concurrency`
// 从"恒为 1（串行）"改成默认 4 并发、新增 `app_db_readers` / `app_db_busy_timeout`），
// 而 `SKILL.md` 的 `version` 从 beta.1 起一直是 `1.0.0` ⇒ 服务端清单与本机已装版本
// **都是 1.0.0**，客户端 `builtinAction()` 永远返回"已安装"，判不出有更新 ——
// 平台修正过的作者手册永远到不了已安装的员工手上（配合"更新入口是死代码"就是永久静默陈旧）。
//
// 判据：把整个技能目录（相对路径 + 逐字节内容，按路径排序，**目录条目也计入**）摘要成
// sha256；**每个摘要只允许对应一个 version**。于是四种破坏都会红：
//   - 改内容不提版本 ⇒ 摘要查不到 ⇒ TestBuiltinSkillVersionTracksContent 红；
//   - 提了版本不登记 ⇒ 摘要登记的仍是旧版本 ⇒ 红；
//   - 复用旧版本号（改内容 + 把新摘要也标成 1.0.0）⇒ "一个 version 只能有一个摘要" 红；
//   - **加/删一个空目录**（不新增任何文件）⇒ 摘要变 ⇒ 红（R2-SK-4：PackDir 为每个
//     目录产出 tar 条目，下发字节确实变了）。
//
// 登记表**只增不减**：它同时是"这个版本交付了什么内容"的对账依据。
//
// 变异验证（实跑过，勿删）：
//   - 改 `references/imports.md` 里任意一个字节（不动 SKILL.md 的 version）⇒ 红；
//   - 把 SKILL.md 的 version 从 1.1.0 改成 1.0.0（内容不动）⇒ 红（摘要登记的是 1.1.0）；
//   - 给某条摘要补一个已用过的 version ⇒ 反向断言红。
//
// ⚠️ 本表是**整目录**摘要：`references/limits.md` 是 limits 生成器的产物，它的内容由
// `cmd/picoaide-limits-gen` 决定 —— 改 limits 的真源（limitsspec.go）并重跑生成器后，
// 这里会红，那不是误报：交付给员工的手册变了，版本就该提。

// seededSkillDigests 是「内置技能内容摘要 → SKILL.md 的 version」登记表。
//
// 登记的是**要交付出去的那一份内容**（本分支合并后的状态）。尚未提交、也没下发过的
// 中间态可以就地替换（同一版本只留一条），已提交/已发布的条目只增不减。
var seededSkillDigests = map[string]string{
	// 1.2.0 = 本分支的完整技能交付内容（14 个文件）：
	//   - references/imports.md（导入面白名单，R1-pm-18）+ abi/SKILL 指路；
	//   - SKILL 黄金路径第 5 步的导入面自查指引（R1-pm-8 的第二半：内容变 ⇒ 版本必须跟着变）；
	//   - scripts/pack-assets.mjs + scripts/README.md（自定义段打包脚本，R1-e2e-6，同分支并行改动）。
	//
	// 2026-09-19（R2-SK-4）：摘要口径加入**目录条目**（含空目录）后重算，内容本身未变、
	// 交付字节未变 ⇒ 版本没有变，就地替换那一条（同一版本只留一条摘要）。
	//
	// 1.1.0 的历史摘要**保留**（登记表只增不减：它同时是"这个版本交付了什么内容"
	// 的对账依据）。注意：1.1.0 从未随任何 tag 下发过 —— 它记录的是本分支早期的中间态。
	"4cfa5c266e3eaa50ec944b3b7632827e76592a13a52d79274cc433e5475a0f91": "1.1.0",
	// 2026-09-19（W1，appcfg 侧生成物重生成）：`references/app-config.md` 随
	// `appcfgspec.go` 的收敛（access 只列可写取值 login|whitelist，R1-DAT-8/UX-13）
	// 重新生成 ⇒ 交付内容变了 ⇒ SKILL.md 的 version 已由本分支提到 1.2.0，这里登记
	// 对应的新摘要。**W4 的第二次重生成（limits 侧）会再次改变摘要**：那时必须
	// 再提一级版本并登记新摘要（DAT-7 把那次登记分配给 W4），不要在本条上就地改写。
	// 1.2.0 = W1（appcfg 侧生成物重生成 + `window.*` 子字段）的交付内容。
	// ⚠️ 同一版本只留一条摘要：下面是 1.2.0 的那一份，**不要就地改写**。
	"9a6c37f4287542f38e30e5291c764aa50ad29ca97e3404b22fbe3e2acb5dfc96": "1.2.0",

	// 1.3.0 = **W4 的第二次重生成**（L7，2026-09-20）的交付内容，三处一起变：
	//   ① `references/limits.md`：删掉服务端宿主 AI / 匿名限流 / 换票 / 应用会话 /
	//      员工浏览器表单的数值行，新增 §21.2 的 AI 桥形状（64 条 / 单条 16 KiB）；
	//   ② `references/imports.md`：导入面说明里的宿主能力清单不再含 AI（`db.* / log /
	//      assets.read`），来源是 `cmd/picoaide-wasm-imports-gen` 的重生成；
	//   ③ `references/app-config.md`：`app_id` 的措辞不再写"域名标签 `<app_id>.<应用基域>`"
	//      （应用只在客户端内以 `<渠道 app 源 scheme>://<app_id>` 打开）。
	// 为什么必须提版本：交付给员工的手册字节变了，已安装的客户端靠 version 判「有更新」
	//（R1-pm-8）。W4-11 把这次登记分配给 W4，且明确**不得**在 1.2.0 上就地改写。
	"fd832c3efbd22a212bc07f39093f63c949998aa85334cd988e2cdf5323994f56": "1.3.0",
}

// TestBuiltinSkillVersionTracksContent 断言当前技能内容的摘要已在登记表里，且登记的
// 版本与 SKILL.md 写的一致（并反向断言"一个版本只对应一次内容交付"）。
func TestBuiltinSkillVersionTracksContent(t *testing.T) {
	digest, files := skillContentDigest(t, repoSkillDir)
	version := skillFrontmatterVersion(t, filepath.Join(repoSkillDir, SkillFile))
	if files < 10 {
		t.Fatalf("只摘要到 %d 个文件（技能目录被搬走或变空？）", files)
	}
	want, ok := seededSkillDigests[digest]
	if !ok {
		t.Fatalf("内置技能内容变了，但 seededSkillDigests 里没有这个摘要（R1-pm-8）：\n"+
			"  内容摘要 = %s（%d 个文件）\n"+
			"  当前 SKILL.md 的 version = %s\n"+
			"  修复：①把 SKILL.md 的 version 提一级 —— 内容变就必须提，已安装的员工靠它判「有更新」；\n"+
			"        ②把 %q: %q 加进本文件的 seededSkillDigests。",
			digest, files, version, digest, "<新版本>")
	}
	if want != version {
		t.Fatalf("内容摘要 %s 登记的是 version %s，而 SKILL.md 写的是 %s（提了版本但忘了同步登记表？）",
			digest, want, version)
	}
	// 反向断言：一个 version 只能对应一个内容摘要（否则"提版本"可以被绕过：
	// 改内容 + 把新摘要也标成同一个版本号）。
	byVersion := map[string]string{}
	for d, v := range seededSkillDigests {
		if prev, dup := byVersion[v]; dup {
			t.Fatalf("version %s 对应了多个内容摘要（%s 与 %s）—— 版本号必须唯一标识一次内容交付", v, prev, d)
		}
		byVersion[v] = d
	}
}

// TestSeededSkillVersionMatchesManifestGate 只是把"版本号字面量只有一处"这件事钉住：
// 其它用例里的 seededSkillVersion 必须与 SKILL.md 一致（避免提版本时漏改断言）。
func TestSeededSkillVersionMatchesManifestGate(t *testing.T) {
	if got := skillFrontmatterVersion(t, filepath.Join(repoSkillDir, SkillFile)); got != seededSkillVersion {
		t.Fatalf("SKILL.md 的 version = %s，而测试常量 seededSkillVersion = %s —— 两处必须一起改",
			got, seededSkillVersion)
	}
}

// skillContentDigest 把技能目录摘要成确定性 sha256（相对路径 + 逐字节内容，按路径排序）。
//
// 刻意**不**看 mtime / 文件模式 / 目录项顺序：同一份内容在任意机器上都是同一个摘要
// （否则登记表会变成"每台机器一份"的噪音）。
//
// 口径（R2-SK-4）：**目录也进摘要**（含空目录）—— `PackDir` 为每个目录产出 tar
// 条目（`items = append(items, item{name: clean + "/", dir: true, …})`），所以哪怕
// 只加一个空目录，下发的 archive sha256/size（客户端 `X-Skill-Checksum` 对拍的那两个
// 值）都会变。此前只收 `d.Type().IsRegular()`，于是"下发字节变了、版本门禁仍绿"。
// 返回 (摘要, 参与摘要的**普通文件**数)。
func skillContentDigest(t *testing.T, dir string) (string, int) {
	t.Helper()
	var entries []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil // 包根自身不入摘要（PackDir 也不为它产出条目）
		}
		rel, rerr := filepath.Rel(dir, path)
		if rerr != nil {
			return rerr
		}
		relSlash := filepath.ToSlash(rel)
		switch {
		case d.IsDir():
			entries = append(entries, "D:"+relSlash)
		case d.Type().IsRegular():
			entries = append(entries, "F:"+relSlash)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 %s: %v", dir, err)
	}
	sort.Strings(entries)

	h := sha256.New()
	files := 0
	for _, e := range entries {
		if kind, rel, ok := strings.Cut(e, ":"); ok && kind == "D" {
			// 目录只记路径：空目录与"目录本身"同样是下发字节的一部分。
			fmt.Fprintf(h, "D:%s\n", rel)
			continue
		}
		_, rel, _ := strings.Cut(e, ":")
		content, rerr := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if rerr != nil {
			t.Fatalf("读 %s: %v", rel, rerr)
		}
		// 路径与长度都进摘要：改名/改内容/换行差异都会变。
		fmt.Fprintf(h, "F:%s:%d\n", rel, len(content))
		h.Write(content)
		h.Write([]byte{'\n'})
		files++
	}
	return hex.EncodeToString(h.Sum(nil)), files
}

// R2-SK-4：目录摘要必须覆盖**空目录**。
//
// PackDir 为每个目录产出 tar 条目，所以"只加一个空目录、不加任何文件"同样改变下发
// 的字节（archive sha256/size、客户端下载时的 X-Skill-Checksum 都会变）；摘要若只收
// 普通文件，这种变化就完全不可见，版本门禁照绿。
//
// 变异验证（实跑过）：把 skillContentDigest 的目录分支删掉（回到只收
// `d.Type().IsRegular()` 的旧形态）⇒ 本用例在"空目录没进摘要"那条必红。
func TestSkillContentDigestCoversEmptyDirectories(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, SkillFile), []byte("---\nname: x\n---\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mkdir := func(rel string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	mkdir("references")
	before, beforeFiles := skillContentDigest(t, dir)
	beforeArchive, _, err := PackDir(dir)
	if err != nil {
		t.Fatalf("PackDir: %v", err)
	}

	// 只加一个空目录：一个文件都不新增。
	mkdir("references/zz-empty")
	after, afterFiles := skillContentDigest(t, dir)
	afterArchive, _, err := PackDir(dir)
	if err != nil {
		t.Fatalf("PackDir: %v", err)
	}

	// 前置：PackDir 确实为目录产出条目（否则"空目录进摘要"就无从谈起）。
	if bytes.Equal(beforeArchive, afterArchive) {
		t.Fatal("前置失败：加一个空目录后下发归档必须变（PackDir 为每个目录产出条目）")
	}
	if afterFiles != beforeFiles {
		t.Fatalf("空目录不得增加普通文件数：%d → %d", beforeFiles, afterFiles)
	}
	if before == after {
		t.Fatalf("空目录没进摘要：下发归档已变（len %d → %d）而版本门禁仍绿 —— R2-SK-4 的缺口",
			len(beforeArchive), len(afterArchive))
	}
	// 反向对照：同一份内容（含空目录）重复计算必须稳定（摘要确定性）。
	again, _ := skillContentDigest(t, dir)
	if again != after {
		t.Fatalf("摘要必须确定性：%s vs %s", after, again)
	}
}

// frontmatterVersionRe 抠 frontmatter 里的 version 行（只认文件开头的 `---` 块）。
var frontmatterVersionRe = regexp.MustCompile(`(?m)^version:[ \t]*(\S+)[ \t]*$`)

// skillFrontmatterVersion 读 SKILL.md frontmatter 的 version（读不到即 Fatal：
// skillmanifest.Parse 也会因此把整条技能丢掉）。
func skillFrontmatterVersion(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s: %v", path, err)
	}
	text := string(raw)
	if !strings.HasPrefix(text, "---\n") {
		t.Fatalf("%s 必须以 frontmatter 开头", path)
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		t.Fatalf("%s 的 frontmatter 没有结束行", path)
	}
	m := frontmatterVersionRe.FindStringSubmatch(text[:4+end])
	if m == nil {
		t.Fatalf("%s 的 frontmatter 缺 version（内置技能会被静默丢弃）", path)
	}
	return m[1]
}

package skillseed

import (
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
// 判据：把整个技能目录（相对路径 + 逐字节内容，按路径排序）摘要成 sha256；
// **每个摘要只允许对应一个 version**。于是三种破坏都会红：
//   - 改内容不提版本 ⇒ 摘要查不到 ⇒ TestBuiltinSkillVersionTracksContent 红；
//   - 提了版本不登记 ⇒ 摘要登记的仍是旧版本 ⇒ 红；
//   - 复用旧版本号（改内容 + 把新摘要也标成 1.0.0）⇒ "一个 version 只能有一个摘要" 红。
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
	// 1.1.0 = 本分支的完整技能交付内容（14 个文件）：
	//   - references/imports.md（导入面白名单，R1-pm-18）+ abi/SKILL 指路；
	//   - SKILL 黄金路径第 5 步的导入面自查指引（R1-pm-8 的第二半：内容变 ⇒ 版本必须跟着变）；
	//   - scripts/pack-assets.mjs + scripts/README.md（自定义段打包脚本，R1-e2e-6，同分支并行改动）。
	"488e021eab1c3342f55c12592b05f865ac470023ed78a88b6265862cf080748e": "1.1.0",
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
// （否则登记表会变成"每台机器一份"的噪音）。返回 (摘要, 参与摘要的普通文件数)。
func skillContentDigest(t *testing.T, dir string) (string, int) {
	t.Helper()
	var rels []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		rel, rerr := filepath.Rel(dir, path)
		if rerr != nil {
			return rerr
		}
		rels = append(rels, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 %s: %v", dir, err)
	}
	sort.Strings(rels)

	h := sha256.New()
	for _, rel := range rels {
		content, rerr := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if rerr != nil {
			t.Fatalf("读 %s: %v", rel, rerr)
		}
		// 路径与长度都进摘要：改名/改内容/换行差异都会变。
		fmt.Fprintf(h, "F:%s:%d\n", rel, len(content))
		h.Write(content)
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil)), len(rels)
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

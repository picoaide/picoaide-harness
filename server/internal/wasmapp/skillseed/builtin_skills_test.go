package skillseed

import (
	"bytes"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// 本文件守 R13-F-05（原 F-P2-3）：**技能目录集合的三方双向对账**。
//
// 缺陷形态（独立审计在副本里复现过）：`skillseed_test.go` 的 `repoSkillDir` 只认死一个目录
// （`../../../../server/skills/app-builder`），摘要登记表也只覆盖这一个技能，而
// `server/Dockerfile` 又**逐个** COPY 技能目录 ⇒ 在 `server/skills/` 下新加一个技能目录、
// 谁都不登记，是**全绿**的（`go test ./internal/wasmapp/skillseed/` 整包 `ok`）。那个技能：
//   - 永远不会进镜像（Dockerfile 没有它那一行）⇒ 员工在能力中心里永远看不到它；
//   - 不受任何版本/摘要纪律约束（R1-pm-8 的形态：内容变了没人提版本，已安装的员工
//     永远判不出"有更新"）。
//
// 开发者看到的是一路绿灯。**"路径存在性"与"整目录豁免"都不是判据**（本仓已登记的假绿形态）。
//
// 判据：三个集合必须**逐元素相等**，任一方向不一致即红：
//
//	① 磁盘：`server/skills/` 下真实存在的技能目录（判据自己 walk，不看任何清单）；
//	② 镜像：`server/Dockerfile` 里 `COPY skills/<name>/ /opt/picoaide/skills/<name>/`
//	   的清单（**真解析** Dockerfile 文本：先拼续行、再丢整行注释、再按 COPY 指令取
//	   "源 → 目标"，一行一个技能；不是查"某个字符串出现过"）；
//	③ 登记：本文件的 `builtinSkillRegistry`（技能集合的唯一真源）+ 摘要登记表
//	   `seededSkillDigests` 的**分组键集合**。
//
// 于是"新增一个平台内置技能"必须三处同时改才绿：
//
//	① 磁盘目录（SKILL.md frontmatter 齐备，且目录名逐字等于 frontmatter 的 name）；
//	② `server/Dockerfile` 加一行 COPY（否则技能不进镜像）；
//	③ 本文件 `builtinSkillRegistry` 加一条 + `skill_version_test.go` 的
//	   `seededSkillDigests` 加一组摘要（否则技能不受版本纪律约束、也没人复核它该不该下发）。
//
// 只想把某个目录留在仓库里而**不**随镜像下发 ⇒ 登记为 `{Shipped: false, Reason: "…"}`：
// 豁免必须**逐条显式**并写理由，不接受通配/整目录豁免（那正是本条缺陷的形态）。
//
// 第四个维度（2026-09-26 起，第 ⑦ 项）：**技能目录里由中性源注入的文件**
// （`skillFileInjections`）。技能的内容不只有 `server/skills/` 那一棵树 —— 有的文件
// 唯一实现在中性位置（例如既给演示应用用、又随技能分发的打包器），构建镜像时由
// Dockerfile 从**同一个源** COPY 到每个落点，技能源树里没有副本。判据据此能表达
// 「该技能文件来自中性源路径」，并把「同源 + 两个 COPY 落点 + 同摘要」三者对上：
//   - 中性源必须存在且**不在**技能源树里，技能源树里也不许有同名/同字节副本；
//   - 该源的 COPY 落点数与登记一致、逐字同源，注入技能目录的那一条落点唯一且目标正确；
//   - 注入的字节必须真的参与技能内容摘要（`skillContentDigestWithAdditions`），
//     且含注入文件的摘要正是 `seededSkillDigests` 里登记的那一个。
//
// 没有这道对账时的形态：把"打包器解耦到中性位置"做成"顺手在技能目录里再放一份"，
// 或者解耦后注入 COPY 被删掉而没人发现（技能目录少一个文件、员工装到的技能不完整）。
//
// 第 ⑦ 项的变异验证（2026-10-13 在隔离 worktree 里逐条实跑，每条都让本包红；
// harness 与原始输出见 temp/p0/w4-decouple-demo-packer/mutations/run-mutations.sh 与
// 同目录 logs/mutations2.log）：
//   - 中性源路径写错（Source 指向不存在的文件）⇒ 红（读不到源 + Dockerfile 那条 COPY 变成"未登记的外来源"）；
//   - demoassets 阶段改回从技能目录取 ⇒ 红（落点数 2 → 1，且"没有别的落点"）；
//   - 删掉注入技能目录的那条 COPY ⇒ 红（注入落点 0 条）；
//   - 技能源树里恢复一份**同名**副本 ⇒ 红（同名条目冲突）；
//   - 技能源树里放一份**同字节换名**副本 ⇒ 红（同字节副本清单命中）；
//   - 注入落点改名 ⇒ 红（落点不在登记表里 / 目标不逐字相等）；
//   - 改中性源内容却不提技能版本 ⇒ 红（注入字节确实进技能内容摘要）；
//   - 未登记的外来源 COPY 进 seed 目录 ⇒ 红（Fatal，与解耦前同判）；
//   - 登记的落点数与 Dockerfile 不符 ⇒ 红（登记表自检）；
//   - 中性源登记成技能源树里的路径 ⇒ 红（登记表自检：中性源必须在技能源树之外）。
//
// 变异验证（实跑过，原始输出见 temp/r13/GF/sub-skills/FINDINGS.md）：
//   - 新增 `server/skills/<新技能>/SKILL.md`、三处都不动 ⇒ 本用例红（修前是整包 `ok`）；
//   - 登记了却把磁盘目录删掉 ⇒ 红；登记了却没写 Dockerfile COPY 行 ⇒ 红；
//   - 登记了却没登记摘要（分组键集合不一致）⇒ 红；
//   - 三处一起改 + 摘要登记 ⇒ 绿（正例）。
//
// 与本文件同源的两条判据（不要重复造）：
//   - "目录名 ≠ SKILL.md frontmatter 的 name"由 `skillmanifest.Parse` 覆盖
//     （manifest.go 的 CodeIdentityMismatch），运行期 `loadSkill` 与下面第 ⑤ 项都用
//     它；仓库级不再另写一套字符串比较。
//   - "内容变了版本必须变"由 `skill_version_test.go` 的
//     `TestBuiltinSkillVersionTracksContent` 覆盖（本文件只对账**集合**）。

// 判据读的三处位置（相对本包目录）。服务端模块根是 `server/`，所以四个 `..` 回到仓库根，
// 与 `repoSkillDir` 同一口径。
const (
	repoSkillsRoot     = "../../../../server/skills"
	repoDockerfilePath = "../../../../server/Dockerfile"
	// repoServerRoot 是 Dockerfile 的**构建上下文**（`docker buildx build … server`）——
	// COPY 的源路径都相对它解析，判据要按同一口径把源路径映射回磁盘。
	repoServerRoot = "../../../../server"
	// imageSkillSeedDir 是 Dockerfile 里 `PICOAI_SKILL_SEED_DIR` 的取值，也是
	// `skillseed.Dir` 的缺省 —— COPY 的目标必须落在它下面，否则服务端一个技能都扫不到。
	imageSkillSeedDir = "/opt/picoaide/skills"
)

// builtinSkillEntry 是技能登记表的一条。
type builtinSkillEntry struct {
	// Dir 是 `server/skills/` 下的目录名。运行期 `skillmanifest` 要求它**逐字等于**
	// SKILL.md frontmatter 的 `name`（不一致 ⇒ 整条技能被静默跳过）；下面第 ⑤ 项用与
	// 运行期 `loadSkill` 完全相同的路径复核每个已下发技能。
	Dir string
	// Shipped=false 表示"这个目录在仓库里，但刻意**不**随镜像下发"（例如只给本仓工具
	// 或镜像构建阶段用的素材目录）。必须写 Reason。
	Shipped bool
	// Reason 是 Shipped=false 的豁免理由（Shipped=true 时留空）。
	Reason string
}

// builtinSkillRegistry 是本仓「技能目录集合」的登记表 —— 全量、显式、唯一真源。
//
// ⚠️ 改动这里必须同步三处（见文件头）：磁盘目录 / `server/Dockerfile` 一行 COPY /
// `skill_version_test.go` 的 `seededSkillDigests` 分组。漏任何一处都会被
// TestBuiltinSkillInventoryMatchesDiskDockerfileAndDigests 打红。
var builtinSkillRegistry = []builtinSkillEntry{
	// app-builder = 平台内置的「WASM 应用作者手册」：客户端能力中心按需安装，
	// 员工在应用中心里打开"用 AI 建应用"时随会话加载。
	{Dir: "app-builder", Shipped: true},
}

// repoSkillDirFor 返回某个技能目录相对本包目录的路径（与 `repoSkillDir` 同口径）。
func repoSkillDirFor(dir string) string { return repoSkillsRoot + "/" + dir }

// skillFileInjection 描述「技能目录里、但**不由 `server/skills/` 提供**的文件」：
// 唯一实现放在中性位置（不属于任何一侧），构建镜像时由 Dockerfile 从**同一个源**
// COPY 到每个落点，技能源树里**没有**副本。
//
// 为什么需要这种形态（也是为什么判据不能只是"删掉那条断言"）：
// 演示应用的资产打包器与随技能分发的打包器**必须是同一份实现**（两份会漂，而"规则
// 不会漂"正是这条链存在的理由），但它又不该由技能源码目录拥有 —— 于是源树里只留一份
// **中性**实现，镜像内的技能布局靠"注入"复原：`<seed>/<技能>/<Dest>` 仍然存在，
// 技能文档里的相对路径照旧可用。
//
// 这个结构就是判据的**表达力**所在：它把"该技能文件来自中性源路径"从一个说不出口的
// 事实变成可对账的登记项 —— 判据据此核对「同源（逐字同一个源路径）⇒ 同字节 ⇒ 同摘要」
// 与「两个落点」；没登记的"外来源 COPY 进 seed 目录"仍然当场 Fatal。
type skillFileInjection struct {
	// Skill 是技能目录名（必须是 builtinSkillRegistry 里 Shipped=true 的技能）。
	Skill string
	// Dest 是技能目录内的相对路径（POSIX）；镜像落点 = imageSkillSeedDir/Skill/Dest。
	Dest string
	// Source 是构建上下文里的**中性源**路径（仓库相对、POSIX）——唯一实现所在，
	// 必须落在技能源树之外（否则就不是解耦，技能目录里会同时存在第二份）。
	Source string
	// Landings 是这个源在 Dockerfile 里被 COPY 到的落点**数**（含注入技能目录的那一条）。
	// 逐条显式：多了/少了都红 —— 落点集合变化必须有人复核（"不接受通配/静默新增"）。
	Landings int
	// Reason 写清这个文件为什么不在技能源树里。
	Reason string
}

func (inj skillFileInjection) key() string { return inj.Skill + "/" + inj.Dest }

// skillFileInjections 是「由中性源注入技能目录的文件」登记表 —— 全量、显式。
//
// ⚠️ 改动这里要同步三处：中性源文件本身（磁盘）/ `server/Dockerfile` 里**每一个**
// 落点的 COPY 行 / `seededSkillDigests` 里该技能的新摘要（注入文件进技能内容摘要）。
// 漏任何一处都会被下方第 ⑦ 项打红。
var skillFileInjections = []skillFileInjection{
	{
		Skill:    "app-builder",
		Dest:     "scripts/pack-assets.mjs",
		Source:   "demoapps/scripts/pack-assets.mjs",
		Landings: 2,
		Reason: "演示应用的资产打包器与随技能分发的打包器**必须是同一份实现**（打出来的段格式、拒绝清单、" +
			"总量预算口径都要求两边逐字一致；各自留一份必然漂）。唯一实现在中性的 server/demoapps/scripts/ 下，" +
			"Dockerfile 从这同一个源 COPY 到两个落点：演示应用打包阶段（/demo/pack-assets.mjs）与技能目录" +
			"（/opt/picoaide/skills/app-builder/scripts/pack-assets.mjs）。技能源树里不再留副本。",
	},
}

// registeredSkillInjections 读注入登记表并自检（形态、唯一性、中性性、落点数、理由）。
func registeredSkillInjections(t *testing.T) (byKey map[string]skillFileInjection, bySource map[string]skillFileInjection) {
	t.Helper()
	byKey = map[string]skillFileInjection{}
	bySource = map[string]skillFileInjection{}
	for _, inj := range skillFileInjections {
		if inj.Skill == "" || inj.Skill != strings.TrimSpace(inj.Skill) || strings.Contains(inj.Skill, "/") {
			t.Fatalf("skillFileInjections 的 Skill %q 非法：必须是 server/skills/ 下的单段目录名", inj.Skill)
		}
		cleanDest := path.Clean(inj.Dest)
		if inj.Dest == "" || cleanDest != inj.Dest || cleanDest == "." ||
			strings.HasPrefix(cleanDest, "../") || strings.HasPrefix(cleanDest, "/") {
			t.Fatalf("skillFileInjections 的 %s 的 Dest %q 非法：必须是技能目录内的 POSIX 相对路径（不许 .. / 绝对路径）", inj.Skill, inj.Dest)
		}
		cleanSource := path.Clean(inj.Source)
		if inj.Source == "" || cleanSource != inj.Source || strings.HasPrefix(cleanSource, "/") {
			t.Fatalf("skillFileInjections 的 %s 的 Source %q 非法：必须是构建上下文里的 POSIX 相对路径", inj.Skill, inj.Source)
		}
		if cleanSource == "skills" || strings.HasPrefix(cleanSource, "skills/") {
			t.Fatalf("skillFileInjections 的 %s 的 Source %q 落在**技能源树**里 —— 那就不叫解耦："+
				"技能目录里会同时留着第二份实现（两份会漂）。中性源必须放到技能源树之外。", inj.Skill, inj.Source)
		}
		if inj.Landings < 2 {
			t.Fatalf("skillFileInjections 的 %s 声明落点数 = %d：除了注入技能目录，至少还要有一个落点"+
				"（演示应用打包阶段）—— 只有一个落点的话这个文件根本没有解耦到中性位置的必要", inj.Skill, inj.Landings)
		}
		if strings.TrimSpace(inj.Reason) == "" {
			t.Fatalf("skillFileInjections 的 %s 没写 Reason —— 为什么这个文件不在技能源树里必须逐条写明", inj.Skill)
		}
		if prev, dup := byKey[inj.key()]; dup {
			t.Fatalf("skillFileInjections 重复登记 %s（已有 Source %q）", inj.key(), prev.Source)
		}
		if prev, dup := bySource[inj.Source]; dup {
			t.Fatalf("skillFileInjections 里中性源 %q 被登记了两次（%s 与 %s）—— 一个源只对应一个注入落点",
				inj.Source, prev.key(), inj.key())
		}
		byKey[inj.key()] = inj
		bySource[inj.Source] = inj
	}
	return byKey, bySource
}

// sortedInjections 返回按 key 升序的登记项（遍历顺序与报错信息都要确定性）。
func sortedInjections(byKey map[string]skillFileInjection) []skillFileInjection {
	out := make([]skillFileInjection, 0, len(byKey))
	for _, inj := range byKey {
		out = append(out, inj)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key() < out[j].key() })
	return out
}

// skillInjectionsOf 读出某个技能的全部注入文件（逐字节内容取自中性源）。
func skillInjectionsOf(t *testing.T, skill string, byKey map[string]skillFileInjection) []skillContentAddition {
	t.Helper()
	var out []skillContentAddition
	for _, inj := range sortedInjections(byKey) {
		if inj.Skill != skill {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(repoServerRoot, filepath.FromSlash(inj.Source)))
		if err != nil {
			t.Fatalf("读中性源 %s（技能 %s 的 %s）：%v", inj.Source, inj.Skill, inj.Dest, err)
		}
		out = append(out, skillContentAddition{Rel: inj.Dest, Content: raw})
	}
	return out
}

// effectiveSkillDigest 返回某个技能**在镜像里**的内容摘要（磁盘技能树 + 注入文件）与
// 普通文件数 —— 与 `skill_version_test.go` 的登记表同一口径（两处必须一致，否则
// "判据钉住的内容"与"员工装到的内容"分叉）。
func effectiveSkillDigest(t *testing.T, skill string, byKey map[string]skillFileInjection) (string, int) {
	t.Helper()
	return skillContentDigestWithAdditions(t, repoSkillDirFor(skill), skillInjectionsOf(t, skill, byKey))
}

// TestBuiltinSkillInventoryMatchesDiskDockerfileAndDigests 是 R13-F-05 的判据本体。
func TestBuiltinSkillInventoryMatchesDiskDockerfileAndDigests(t *testing.T) {
	injectionsByKey, injectionsBySource := registeredSkillInjections(t)
	shipped, exempt := registeredSkillDirs(t)
	disk := diskSkillDirs(t)
	dockerfileRaw := readRepoFile(t, repoDockerfilePath)
	dockerfileShipped, dockerfileNested, landings := dockerfileSkillCopies(t, dockerfileRaw, injectionsByKey, injectionsBySource)

	digestGroups := make(map[string]bool, len(seededSkillDigests))
	for dir := range seededSkillDigests {
		digestGroups[dir] = true
	}
	registered := make(map[string]bool, len(shipped)+len(exempt))
	for dir := range shipped {
		registered[dir] = true
	}
	for dir := range exempt {
		registered[dir] = true
	}
	dockerfileSet := make(map[string]bool, len(dockerfileShipped))
	for dir := range dockerfileShipped {
		dockerfileSet[dir] = true
	}

	// ① 磁盘 ↔ 登记表（双向）：在磁盘却没登记 ⇒ 新技能静默存在；登记了却不在磁盘 ⇒ 幽灵条目。
	if missing, extra := diffSets(disk, registered); len(missing) > 0 || len(extra) > 0 {
		t.Errorf("技能集合三方对账不一致（磁盘 ↔ builtinSkillRegistry）：\n"+
			"  server/skills/ 有、登记表没有：%v\n"+
			"  登记表有、server/skills/ 没有：%v\n"+
			"  → 新增一个平台内置技能必须**三处一起改**：\n"+
			"      ① 磁盘：server/skills/<name>/SKILL.md（frontmatter 齐备，目录名 == name）；\n"+
			"      ② 镜像：server/Dockerfile 加一行 `COPY skills/<name>/ /opt/picoaide/skills/<name>/`；\n"+
			"      ③ 登记：本文件 builtinSkillRegistry 加 `{Dir: \"<name>\", Shipped: true}` +\n"+
			"         skill_version_test.go 的 seededSkillDigests 加一组 `\"<name>\": {<内容摘要>: \"<version>\"}`。\n"+
			"  只想留在仓库里不下发 ⇒ 登记为 `{Shipped: false, Reason: \"…\"}`（豁免逐条显式）。",
			missing, extra)
	}

	// ② 已下发集合 == Dockerfile 的目录 COPY 清单（双向）：登记了却没写进 Dockerfile ⇒
	// 技能永远不进镜像（本条缺陷最隐蔽的一半）；COPY 了却没登记 ⇒ 有人绕开登记表加资产。
	if missing, extra := diffSets(shipped, dockerfileSet); len(missing) > 0 || len(extra) > 0 {
		t.Errorf("技能集合三方对账不一致（builtinSkillRegistry ↔ server/Dockerfile 的 COPY 清单）：\n"+
			"  登记为已下发、Dockerfile 没有 COPY 行：%v ⇒ 这些技能**永远不进镜像**，员工在能力中心里看不到；\n"+
			"  Dockerfile 有 COPY 行、登记表没有：%v\n"+
			"  → 在 server/Dockerfile 的「内置技能随镜像分发」一节逐个补 COPY（一行一个技能，不用 `skills/*/` 通配）。",
			missing, extra)
	}

	// ③ 已下发集合 == 摘要登记表的分组键（双向）：没有摘要分组 ⇒ 技能不受版本纪律约束
	//（R1-pm-8：内容变了没人提版本，已安装客户端永远判不出「有更新」）。
	if missing, extra := diffSets(shipped, digestGroups); len(missing) > 0 || len(extra) > 0 {
		t.Errorf("技能集合三方对账不一致（builtinSkillRegistry ↔ seededSkillDigests 的分组键）：\n"+
			"  已下发、摘要登记表没有分组：%v ⇒ 该技能不受「内容变 ⇒ 版本必须变」约束；\n"+
			"  摘要登记表有分组、已下发集合没有：%v\n"+
			"  → 在 skill_version_test.go 的 seededSkillDigests 里加/删一组（键 = 技能目录名）。",
			missing, extra)
	}

	// ④ Dockerfile 里"引用技能目录内部文件"的 COPY（如把打包脚本给别的构建阶段用）也必须
	// 指向一个真实存在的**已登记**技能 —— 否则 Dockerfile 在指一个不存在（或已改名）的目录。
	for _, dir := range sortedKeys(dockerfileNested) {
		if !registered[dir] {
			t.Errorf("server/Dockerfile:%v 从 skills/%s/ 里取文件，但 %q 不在 builtinSkillRegistry 里（也不在磁盘上的技能目录集合里）",
				dockerfileNested[dir], dir, dir)
		}
	}

	// ⑤ 每个已下发技能：① 走运行期**同一条**校验路径（含「目录名 == frontmatter name」的
	// identity 规则）；② **镜像里那一棵树**的内容摘要（磁盘技能树 + 中性源注入的文件，与
	// 第 ⑦ 项同一口径）已登记且版本一致。运行期 `loadSkill` 就是生产读资产的入口，用它
	// 而不是另写一套检查，避免判据与运行期判据漂移。
	for _, dir := range sortedKeys(shipped) {
		root := repoSkillDirFor(dir)
		if _, err := loadSkill(repoSkillsRoot, dir); err != nil {
			t.Errorf("已下发技能 %s 过不了运行期的资产校验（loadSkill）：%v\n"+
				"  → 运行期 skillseed 会把整条技能记成「被跳过的坏资产」：清单里没有它、客户端装不到，"+
				"只在启动日志与管理端诊断里可见。", dir, err)
			continue
		}
		digest, files := effectiveSkillDigest(t, dir, injectionsByKey)
		version := skillFrontmatterVersion(t, filepath.Join(root, SkillFile))
		if files == 0 {
			t.Errorf("已下发技能 %s 一个普通文件都没摘要到（目录被搬走或变空？）", root)
			continue
		}
		table := seededSkillDigests[dir]
		want, ok := table[digest]
		if !ok {
			t.Errorf("已下发技能 %s 的当前内容摘要不在 seededSkillDigests[%q] 里（R1-pm-8）：\n"+
				"  内容摘要 = %s（%d 个文件）\n"+
				"  当前 SKILL.md 的 version = %s\n"+
				"  → 提 SKILL.md 的 version 并把 %q: %q 加进 seededSkillDigests[%q]。",
				dir, dir, digest, files, version, digest, "<新版本>", dir)
			continue
		}
		if want != version {
			t.Errorf("已下发技能 %s：内容摘要 %s 登记的是 version %s，而 SKILL.md 写的是 %s（提了版本但忘了同步登记表？）",
				dir, digest, want, version)
		}
	}

	// ⑥ Dockerfile 的 PICOAI_SKILL_SEED_DIR ↔ skillseed 实际扫描的目录：COPY 的落点与
	// 服务端读资产的目录是同一个契约，写歪了技能一个都扫不到（而清单接口会安静地返回空数组）。
	if got, ok := dockerfileEnv(t, dockerfileRaw, "PICOAI_SKILL_SEED_DIR"); !ok {
		t.Errorf("server/Dockerfile 没有 `ENV PICOAI_SKILL_SEED_DIR=…` —— 服务端扫不到任何内置技能")
	} else if got != imageSkillSeedDir {
		t.Errorf("server/Dockerfile 的 PICOAI_SKILL_SEED_DIR = %q，判据/服务端缺省 = %q", got, imageSkillSeedDir)
	}
	if os.Getenv("PICOAI_SKILL_SEED_DIR") == "" && Dir != imageSkillSeedDir {
		t.Errorf("skillseed.Dir = %q，而 Dockerfile 与判据都用 %q（两边必须同源）", Dir, imageSkillSeedDir)
	}

	// ⑦ 由**中性源注入**技能目录的文件（`skillFileInjections`）：镜像里的技能内容不是只有
	// `server/skills/` 那一棵树 —— 技能目录 = 磁盘技能树 + 注入文件。这一节让判据能表达
	// 「该技能文件来自中性源路径」，并证明「同源 + 两个 COPY 落点 + 同摘要」三者一致：
	//
	//	a. 中性源确实存在、且**不在**技能源树里（否则不是解耦）；技能源树里也不许留副本
	//	   （同名或**同字节**换名都算 —— 副本会让规则漂）；
	//	b. 该源在 Dockerfile 里被 COPY 到**登记的落点数**、每个落点**逐字同一个源**
	//	   （同源 ⇒ 同字节 ⇒ 同摘要），其中注入技能目录的落点恰好一条、且目标逐字是
	//	   `<seed>/<技能>/<Dest>`；
	//	c. 注入的字节真的参与技能内容摘要（若把注入 COPY 删掉判据也不红，这条登记就是死代码），
	//	   且"加上注入文件后的摘要"正是 `seededSkillDigests` 里登记的那一个。
	for _, inj := range sortedInjections(injectionsByKey) {
		if !shipped[inj.Skill] {
			t.Errorf("skillFileInjections 往技能 %q 注入 %q，但该技能不在 builtinSkillRegistry 的已下发集合里 —— "+
				"注入到一个不下发的目录是无效动作（要么登记它，要么删掉这条注入）。", inj.Skill, inj.Dest)
			continue
		}

		// a. 中性源在磁盘上恰好一份实现，且不在技能源树里。
		sourceRel := filepath.Join(repoServerRoot, filepath.FromSlash(inj.Source))
		sourceBytes, readErr := os.ReadFile(sourceRel)
		if readErr != nil {
			t.Errorf("skillFileInjections 登记的中性源 %q 读不到（%s）：%v —— 注入的源必须真实存在",
				inj.Source, sourceRel, readErr)
			continue
		}
		destRel := filepath.Join(repoSkillDirFor(inj.Skill), filepath.FromSlash(inj.Dest))
		if _, statErr := os.Lstat(destRel); statErr == nil {
			t.Errorf("技能源树里同时存在 %s —— 解耦后这个文件**只能**来自中性源 %q；"+
				"技能目录里留副本就是「两份会漂的实现」（本判据存在的理由）。", destRel, inj.Source)
		}
		if dupes := filesWithSameBytes(t, repoSkillsRoot, sourceBytes); len(dupes) > 0 {
			t.Errorf("技能源树里出现了中性源 %q 的**同字节副本**：%v —— 换名复制同样会让规则漂；"+
				"源树里只允许有一份实现（改中性源的那一份）。", inj.Source, dupes)
		}

		// b. 落点对账：数量逐条显式、逐字同源、注入落点唯一且目标正确。
		srcLandings := landings[inj.Source]
		if len(srcLandings) != inj.Landings {
			t.Errorf("中性源 %q 在 server/Dockerfile 里有 %d 条 COPY 落点，而 skillFileInjections 登记的是 %d —— "+
				"落点集合变化必须有人复核（多了可能意味着又冒出一份副本，少了意味着某个落点被删）。",
				inj.Source, len(srcLandings), inj.Landings)
		}
		seedLandings, otherLandings := 0, 0
		wantSeedDest := path.Join(imageSkillSeedDir, inj.Skill, inj.Dest)
		for _, l := range srcLandings {
			if l.Source != inj.Source {
				t.Errorf("server/Dockerfile:%d 从 %q 取文件，而登记的中性源是 %q —— 两个落点必须逐字同源"+
					"（不同源就可能不同字节，同摘要的前提就没了）。", l.Line, l.Source, inj.Source)
			}
			if l.InSeed {
				seedLandings++
				if l.Dest != wantSeedDest {
					t.Errorf("server/Dockerfile:%d 把中性源 %q 注入到 %q，而不是 %q（注入落点必须逐字等于 "+
						"`<PICOAI_SKILL_SEED_DIR>/<技能>/<Dest>`，否则镜像里技能文档引用的相对路径失效）。",
						l.Line, inj.Source, l.Dest, wantSeedDest)
				}
			} else {
				otherLandings++
			}
		}
		if seedLandings != 1 {
			t.Errorf("中性源 %q 注入技能目录的落点有 %d 条（必须恰好 1 条）：0 条 ⇒ 镜像里技能目录缺这个文件"+
				"（员工装到的技能不完整、技能文档引用的路径不存在）；多条 ⇒ 落点可能漂。", inj.Source, seedLandings)
		}
		if otherLandings < 1 {
			t.Errorf("中性源 %q 除了注入技能目录，没有别的落点（%d 条）—— 那这个文件就没有解耦到中性位置的必要，"+
				"应当留在技能目录里。", inj.Source, otherLandings)
		}

		// c. 同摘要：注入的字节确实算进技能内容摘要，且登记表认得这个摘要。
		withInjection, files := effectiveSkillDigest(t, inj.Skill, injectionsByKey)
		withoutInjection, _ := skillContentDigest(t, repoSkillDirFor(inj.Skill))
		if withInjection == withoutInjection {
			t.Errorf("把 %q 注入技能 %s 对内容摘要没有任何影响 —— 这条登记是死代码（删掉 Dockerfile 里那条注入 "+
				"COPY，判据也不会红，正是本项要防的形态）。", inj.Source, inj.Skill)
		}
		if _, ok := seededSkillDigests[inj.Skill][withInjection]; !ok {
			t.Errorf("技能 %s **含注入文件**的内容摘要 %s（%d 个文件）不在 seededSkillDigests[%q] 里（R1-pm-8）：\n"+
				"  注入：%s → %s\n"+
				"  → 提 SKILL.md 的 version 并把 %q 加进 seededSkillDigests[%q]（登记表描述的是**下发给员工的"+
				"那棵树**：磁盘技能树 + 注入文件）。",
				inj.Skill, withInjection, files, inj.Skill, inj.Source, wantSeedDest, withInjection, inj.Skill)
		}
	}
}

// filesWithSameBytes 返回 root 下**内容与 want 逐字节相同**的文件（相对 root 的 POSIX 路径，升序）。
//
// 用途：证明"源树里只有一份实现"不是靠文件名判的 —— 换名复制（`pack-assets-v2.mjs` 之类）
// 同样会让规则漂，所以按字节找副本。先按文件大小筛一遍（不同大小不可能同字节），
// 于是这个全树扫描在判据里是廉价的。
func filesWithSameBytes(t *testing.T, root string, want []byte) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return ierr
		}
		if info.Size() != int64(len(want)) {
			return nil
		}
		got, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		if bytes.Equal(got, want) {
			rel, _ := filepath.Rel(root, p)
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 %s: %v", root, err)
	}
	sort.Strings(out)
	return out
}

// registeredSkillDirs 读登记表并自检（目录名形态、不重复、豁免必须写理由）。
func registeredSkillDirs(t *testing.T) (shipped map[string]bool, exempt map[string]string) {
	t.Helper()
	shipped = map[string]bool{}
	exempt = map[string]string{}
	if len(builtinSkillRegistry) == 0 {
		t.Fatal("builtinSkillRegistry 是空的 —— 技能集合登记表被清掉了？（R13-F-05 的三方对账以它为准）")
	}
	for _, e := range builtinSkillRegistry {
		if e.Dir == "" || e.Dir != strings.TrimSpace(e.Dir) || strings.Contains(e.Dir, "/") || strings.HasPrefix(e.Dir, ".") {
			t.Fatalf("builtinSkillRegistry 的 Dir %q 非法：必须是 server/skills/ 下的单段目录名（小写 kebab-case）", e.Dir)
		}
		if shipped[e.Dir] {
			t.Fatalf("builtinSkillRegistry 重复登记 %q", e.Dir)
		}
		if _, dup := exempt[e.Dir]; dup {
			t.Fatalf("builtinSkillRegistry 重复登记 %q", e.Dir)
		}
		if e.Shipped {
			shipped[e.Dir] = true
			continue
		}
		if strings.TrimSpace(e.Reason) == "" {
			t.Fatalf("builtinSkillRegistry 的 %q 标了 Shipped:false（不随镜像下发）却没写 Reason —— "+
				"豁免必须逐条显式并说明理由，不接受通配/整目录豁免（那正是 R13-F-05 的形态）", e.Dir)
		}
		exempt[e.Dir] = e.Reason
	}
	return shipped, exempt
}

// diskSkillDirs 列出 server/skills/ 下**真实存在**的技能目录（判据自己 walk，不看任何清单）。
func diskSkillDirs(t *testing.T) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(repoSkillsRoot)
	if err != nil {
		t.Fatalf("读 %s: %v（技能源目录不在了？它就是 Dockerfile 的构建上下文）", repoSkillsRoot, err)
	}
	out := make(map[string]bool, len(entries))
	for _, de := range entries {
		if de.IsDir() {
			out[de.Name()] = true
			continue
		}
		// 与运行期同判（skillseed.go 的 loadLocked）：资产根只放技能子目录。
		// 散文件既不打包也不下发，只在管理端诊断里记一条 problem —— 在仓库侧它同样是
		// "以为加了技能、其实什么都没发生"，所以在判据面直接红。
		t.Errorf("%s 根目录出现散文件 %q —— 资产根只放技能子目录（<name>/SKILL.md）；"+
			"散文件不会被打包下发（与 skillseed.go 的 loadLocked 同判）", repoSkillsRoot, de.Name())
	}
	return out
}

// dockerfileInstruction 是一条逻辑指令：续行已拼接、整行注释与空行已丢。
type dockerfileInstruction struct {
	Line int    // 指令起始行号（1-based，报错能指到行）
	Op   string // 大写指令名（COPY / ADD / ENV …）
	Args []string
}

// dockerfileInstructions 把 Dockerfile 文本切成逻辑指令。
//
// 口径：
//   - 行尾 `\` 续行先拼成一条（COPY 常常跨行）；
//   - **整行**注释（首个非空白字符是 `#`，含 `# syntax=` 解析指令）与空行丢掉 ——
//     注释里出现 `skills/…` 正是"查某个字符串出现过"会误判的来源；
//   - 参数按 shell 形式切词（支持引号包裹的路径与反斜杠转义）。
func dockerfileInstructions(raw string) []dockerfileInstruction {
	var out []dockerfileInstruction
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	for i := 0; i < len(lines); i++ {
		start := i + 1
		text := lines[i]
		for strings.HasSuffix(strings.TrimRight(text, " \t"), "\\") && i+1 < len(lines) {
			text = strings.TrimSuffix(strings.TrimRight(text, " \t"), "\\") + " " + lines[i+1]
			i++
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		fields := dockerfileFields(trimmed)
		if len(fields) == 0 {
			continue
		}
		out = append(out, dockerfileInstruction{
			Line: start,
			Op:   strings.ToUpper(fields[0]),
			Args: fields[1:],
		})
	}
	return out
}

// dockerfileFields 按 shell 形式切词（只处理到"能把源与目标分开"的程度）。
func dockerfileFields(line string) []string {
	var (
		fields []string
		cur    strings.Builder
		quote  rune
		esc    bool
	)
	flush := func() {
		if cur.Len() > 0 {
			fields = append(fields, cur.String())
			cur.Reset()
		}
	}
	for _, r := range line {
		switch {
		case esc:
			cur.WriteRune(r)
			esc = false
		case r == '\\' && quote != '\'':
			esc = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote = r
		case r == ' ' || r == '\t':
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return fields
}

// dockerfileLanding 是一条 COPY 把某个**中性源**（`skillFileInjections` 登记的源）送到的
// 落点。同一个源的多条落点必须**逐字同源** ⇒ 同字节 ⇒ 同摘要。
type dockerfileLanding struct {
	Line   int
	Source string // 构建上下文里的源（逐字等于登记的中性源）
	Dest   string // 目标（path.Clean 后）
	InSeed bool   // 目标是否落在 imageSkillSeedDir 下（= 注入技能目录的那一条）
}

// dockerfileSkillCopies 从 Dockerfile 里抽出「一行一个技能」的 COPY 清单。
//
// 返回：shipped = 技能目录 → COPY 行号；nested = 被引用内部文件的技能目录 → 行号列表；
// landings = 中性源 → 它被 COPY 到的落点列表（含注入技能目录的那一条）。
//
// 不可静态判定的写法一律 Fatal（"读不出清单"不等于"清单是空的"）：
//   - 源是整个 `skills/` 根或用通配/变量（判据读不出具体技能）；
//   - 一条 COPY 带多个技能目录源（清单必须一行一个技能，判据才能逐行对拍）；
//   - `COPY --from=<另一阶段> skills/…`（判据读不到那个阶段的真实内容）；
//   - 把技能目录**内部**的路径 COPY 进 seed 目录（下发的是残包，不是整技能）；
//   - 把**没登记**的外来源 COPY 进 seed 目录（谁在下发什么必须逐条可查 —— 登记通道
//     是 `skillFileInjections`，它同时表达"这个技能文件来自中性源路径"）。
func dockerfileSkillCopies(
	t *testing.T,
	raw string,
	injectionsByKey map[string]skillFileInjection,
	injectionsBySource map[string]skillFileInjection,
) (shipped map[string]int, nested map[string][]int, landings map[string][]dockerfileLanding) {
	t.Helper()
	shipped = map[string]int{}
	nested = map[string][]int{}
	landings = map[string][]dockerfileLanding{}
	for _, ins := range dockerfileInstructions(raw) {
		if ins.Op != "COPY" && ins.Op != "ADD" {
			continue
		}
		args := ins.Args
		fromStage := ""
		for len(args) > 0 && strings.HasPrefix(args[0], "--") {
			if v, ok := strings.CutPrefix(args[0], "--from="); ok {
				fromStage = v
			}
			args = args[1:]
		}
		if len(args) < 2 {
			continue // 形态非法时 docker build 自己会报错，不在这里兜
		}
		srcs, dest := args[:len(args)-1], args[len(args)-1]
		destClean := path.Clean(dest)
		destIsSeed := destClean == imageSkillSeedDir || strings.HasPrefix(destClean, imageSkillSeedDir+"/")

		// 中性源：技能目录里的某个文件唯一实现在别处（登记在 skillFileInjections），
		// 构建期从这同一个源注入。与「skills/ 下的源」分开处理：前者是注入，后者是下发。
		var neutralSrcs []string
		for _, s := range srcs {
			if s == "" || strings.Contains(s, "$") || strings.HasPrefix(s, "/") {
				continue
			}
			if _, ok := injectionsBySource[path.Clean(strings.TrimPrefix(s, "./"))]; ok {
				neutralSrcs = append(neutralSrcs, path.Clean(strings.TrimPrefix(s, "./")))
			}
		}
		if len(neutralSrcs) > 0 {
			if len(srcs) != 1 || len(neutralSrcs) != 1 {
				t.Fatalf("server/Dockerfile:%d 的一条 %s 从登记的中性源取文件，却带了多个源（源：%v）—— "+
					"中性源注入必须一条 COPY 一个源，判据才能逐条对账落点（登记表：skillFileInjections）。",
					ins.Line, ins.Op, srcs)
			}
			if fromStage != "" {
				t.Fatalf("server/Dockerfile:%d 的 %s --from=%s 从另一个构建阶段取中性源 %q —— "+
					"判据读不到那个阶段的真实内容，无法保证两个落点同源（skillFileInjections）。",
					ins.Line, ins.Op, fromStage, neutralSrcs[0])
			}
			src := neutralSrcs[0]
			if destIsSeed {
				rel, ok := strings.CutPrefix(destClean, imageSkillSeedDir+"/")
				if !ok || rel == "" {
					t.Fatalf("server/Dockerfile:%d 把中性源 %q COPY 到 %q —— 目标在 %s 下但不是一个技能目录内的文件；"+
						"登记表只接受 `<seed>/<技能>/<相对路径>` 的落点。",
						ins.Line, src, destClean, imageSkillSeedDir)
				}
				inj, ok := injectionsByKey[rel]
				if !ok {
					t.Fatalf("server/Dockerfile:%d 把中性源 %q COPY 到 %q —— 但 %q（技能 %q 的 %q）不在 "+
						"skillFileInjections 里。把文件注入技能目录**必须逐条登记**（技能 / 目录内落点 / 中性源 / 落点数），"+
						"否则判据读不出「镜像里这个技能文件是谁下发的」。",
						ins.Line, src, destClean, rel, path.Dir(rel), path.Base(rel))
				}
				if inj.Source != src {
					t.Fatalf("server/Dockerfile:%d 把 %q 注入到 %q，而 skillFileInjections 登记的中性源是 %q —— "+
						"两个落点必须逐字同源（同源 ⇒ 同字节 ⇒ 同摘要）。",
						ins.Line, src, destClean, inj.Source)
				}
			}
			landings[src] = append(landings[src], dockerfileLanding{
				Line:   ins.Line,
				Source: src,
				Dest:   destClean,
				InSeed: destIsSeed,
			})
			continue
		}

		type skillRef struct {
			dir    string
			nested bool
		}
		var refs []skillRef
		for _, s := range srcs {
			rel, ok := skillsRelativePath(s)
			if !ok {
				continue
			}
			if rel == "" {
				t.Fatalf("server/Dockerfile:%d 的 %s 源 %q 指向整个 skills/ 根 —— 技能清单必须**逐目录列出**"+
					"（`COPY skills/<name>/ /opt/picoaide/skills/<name>/`，一行一个技能），否则判据读不出"+
					"「哪些技能进了镜像」（R13-F-05）。", ins.Line, ins.Op, s)
			}
			dir, rest, _ := strings.Cut(rel, "/")
			refs = append(refs, skillRef{dir: dir, nested: rest != ""})
		}

		if len(refs) == 0 {
			if destIsSeed {
				t.Fatalf("server/Dockerfile:%d 有东西被 COPY 进 %s，但源不是 `skills/<name>/` 的形态、也不是 "+
					"skillFileInjections 登记的中性源（源：%v）—— 内置技能必须一行一个技能地从构建上下文的 "+
					"server/skills/ 取（或按登记表从**中性源**注入），判据才能对拍清单（R13-F-05）。",
					ins.Line, imageSkillSeedDir, srcs)
			}
			continue
		}
		if len(srcs) != 1 || len(refs) != 1 {
			t.Fatalf("server/Dockerfile:%d 的一条 %s 带了多个技能目录源（源：%v）—— 技能清单必须一行一个技能，"+
				"判据才能逐行对拍（R13-F-05）。", ins.Line, ins.Op, srcs)
		}
		if fromStage != "" {
			t.Fatalf("server/Dockerfile:%d 的 %s --from=%s 从另一个构建阶段取 skills/ 下的内容 —— "+
				"判据读不到那个阶段的真实内容，无法保证技能清单完整（R13-F-05）。",
				ins.Line, ins.Op, fromStage)
		}
		ref := refs[0]
		if ref.nested {
			if destIsSeed {
				t.Fatalf("server/Dockerfile:%d 把技能目录**内部**的路径 COPY 进 %s（源：%v）—— 下发的会是残包而不是整技能；"+
					"要下发整个技能请写 `COPY skills/%s/ %s/%s/`。",
					ins.Line, imageSkillSeedDir, srcs, ref.dir, imageSkillSeedDir, ref.dir)
			}
			nested[ref.dir] = append(nested[ref.dir], ins.Line)
			continue
		}
		want := imageSkillSeedDir + "/" + ref.dir
		if destClean != want {
			t.Fatalf("server/Dockerfile:%d 把 skills/%s/ COPY 到 %q，而不是 %q —— "+
				"服务端只扫 `PICOAI_SKILL_SEED_DIR`（%s）下的一层技能目录（skillseed.go 的 loadLocked）。"+
				"整个技能目录只允许出现在「下发」这一条 COPY 里；某个构建阶段要用技能里的文件，"+
				"请按文件 COPY（`COPY skills/%s/<相对路径> <目标>`，判据认这种形态并会核对技能已登记）。",
				ins.Line, ref.dir, destClean, want, imageSkillSeedDir, ref.dir)
		}
		if prev, dup := shipped[ref.dir]; dup {
			t.Fatalf("server/Dockerfile:%d 与 :%d 重复 COPY 了技能 %s", ins.Line, prev, ref.dir)
		}
		shipped[ref.dir] = ins.Line
	}
	return shipped, nested, landings
}

// skillsRelativePath 判断一个 COPY 源是不是构建上下文里 `server/skills/` 下的路径，
// 是则返回去掉 `skills/` 前缀的相对路径（`app-builder` / `app-builder/scripts/x.mjs`）。
//
// 返回 ok=true 且 rel="" 表示源就是整个 `skills/` 根（调用方按 Fatal 处理）。
// 带变量（`$…`）或绝对路径的源无法静态判定 ⇒ ok=false（是否可接受由调用方按"目标落点"
// 决定：目标确实落在 seed 目录里就会 Fatal）。
func skillsRelativePath(arg string) (string, bool) {
	if arg == "" || strings.Contains(arg, "$") || strings.HasPrefix(arg, "/") {
		return "", false
	}
	clean := path.Clean(strings.TrimPrefix(arg, "./"))
	if clean == "skills" {
		return "", true
	}
	if !strings.HasPrefix(clean, "skills/") {
		return "", false
	}
	return strings.TrimPrefix(clean, "skills/"), true
}

// dockerfileEnv 读 `ENV <name>=<value>`（也支持 `ENV <name> <value>` 形态）。
func dockerfileEnv(t *testing.T, raw, name string) (string, bool) {
	t.Helper()
	for _, ins := range dockerfileInstructions(raw) {
		if ins.Op != "ENV" {
			continue
		}
		for i, arg := range ins.Args {
			if k, v, ok := strings.Cut(arg, "="); ok {
				if k == name {
					return v, true
				}
				continue
			}
			// `ENV KEY VALUE` 形态：值可能被切成多段，按空格拼回去。
			if arg == name && i+1 < len(ins.Args) {
				return strings.Join(ins.Args[i+1:], " "), true
			}
		}
	}
	return "", false
}

// readRepoFile 读判据用的仓库文件（相对本包目录）。
func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(rel)
	if err != nil {
		t.Fatalf("读 %s: %v", rel, err)
	}
	return string(raw)
}

// diffSets 返回 want 有而 got 没有的（missing）与 got 有而 want 没有的（extra），升序。
func diffSets(want, got map[string]bool) (missing, extra []string) {
	for k := range want {
		if !got[k] {
			missing = append(missing, k)
		}
	}
	for k := range got {
		if !want[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	return missing, extra
}

// sortedKeys 返回 map 的键（升序）—— 遍历顺序与报错信息都要确定性。
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

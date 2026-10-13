package skillseed

import (
	"bytes"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
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
// 第 ⑧ 项与四处判据口径修正（2026-10-13 独立审计的 P1/P2 修复批）：
//   - **登记表非空**：清空 `skillFileInjections` 会让第 ⑦ 项整段零次遍历（一处不报、
//     全绿），而技能里 20 处文档引用照样指向那个文件 —— 与 `seededSkillDigests` 的非空
//     判据同形态（零断言/整段缩面是本仓明确登记的缺陷形态）。
//   - **⑧ 文档引用必须在镜像里那一棵树里存在**（`TestBuiltinSkillReferencedFilesExistInImageTree`）：
//     技能内容里出现 `scripts/…`、`references/…`、`examples/…` 这类**技能目录内**相对路径时，
//     该路径必须在「磁盘技能树 ∪ 注入文件」里真实存在。这一条把"注入关系被删掉"从
//     "登记表少一条"升级成"文档说的文件真的不在"—— 清空登记表 + 删掉注入 COPY 时，
//     20 处引用会一起喊（它由技能内容自己写成，删注入 COPY 的人改不动它）。
//   - **注入落点必须在最后一个构建阶段**：Dockerfile 的中间阶段到不了最终镜像
//     （dest 字符串、落点数、摘要模型全对，唯独文件不在镜像里 ⇒ 判据必须建模"段落"）。
//   - **最终阶段的 RUN 不许出现技能目录路径**：判据只解析 COPY/ADD，而 RUN 可以在技能
//     目录里写出判据看不见的字节（于是"镜像字节 == 中性源字节"不成立）。文本面分不清
//     "读"与"写"，所以取"最终阶段不碰技能目录"这条可静态判定的强形式。
//   - **同字节副本的扫描面 = 仓库**（不是技能源树）：承诺是"源树里只此一份"，扫描面就
//     必须一样宽 —— 把副本放到 `server/demoapps/scripts/` 下的**别的名字**同样会让规则漂。
//
// 上述五条（外加 ⑧ 的独立承重）的变异验证（2026-10-13 在本分支的隔离副本里逐条实跑，
// 每条都让本包红；harness = temp/p0/w4-decouple-demo-packer/fixverify/run-fix-mutations.sh，
// 原始输出 = 同目录 mutations-fix.log）：
//   - 清空 `skillFileInjections` + 删掉注入 COPY + 把摘要换成"磁盘树去掉该文件"的摘要 ⇒ 红
//     （非空判据 + ⑧ 两条独立喊：前者 Fatal，后者逐条列出引用它的技能文件）；
//   - 把注入 COPY 整行挪进 demoassets 中间阶段 ⇒ 红（落点不在最终阶段）；
//   - 注入 COPY 之后在最终阶段 `RUN echo … > <技能目录>/scripts/pack-assets.mjs` ⇒ 红
//     （用 `$PICOAI_SKILL_SEED_DIR` 写的同形变体同样红）；
//   - 把打包器同字节复制成 `server/demoapps/scripts/pack-assets-backup.mjs`、或放到
//     `packages/` 下 ⇒ 都红（仓库级副本扫描，改前只扫技能源树）；
//   - 删掉 `scripts/pack-assets.mjs` 的注入 COPY（登记表照旧）⇒ 红（落点数 + 注入落点 0 条）；
//   - ⑧ 独立承重：删掉一个被文档引用的磁盘文件、并把摘要登记改到新树（排除版本判据）⇒
//     只有 ⑧ 红（引用的路径逐条列出）。
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
	// repoRootPath 是仓库根（相对本包目录，与 `repoSkillDir` 同一口径）。
	//
	// 用途只有一个：第 ⑦ 项 a 的"中性源在**源树**里只此一份"是**仓库级**承诺
	//（提交口径就是"源树里只此一份"），扫描面必须与承诺一样宽 —— 只扫
	// `server/skills/` 的话，把同字节副本放到 `server/demoapps/scripts/` 下的别的名字
	// （真正的漂移形态）是全绿的。
	repoRootPath = "../../../.."
)

// repoScanSkipDirs 是仓库级扫描跳过的目录名（逐层匹配）：它们都不是"本仓源树"。
//
//	.git             VCS 元数据（worktree 里是文件，主检出里是目录）
//	deepseek-harness 上游 pin 的只读 submodule（不归本仓判据管，且体量极大）
//	temp             临时工作区（含其它 worktree 与审计副本 —— 同一份文件会在那里
//	                 出现多次，扫进来只会制造与真实漂移无关的红）
//	node_modules     依赖
//	.yarn            包管理器缓存
//	dist / build     构建产物（源树里没有它们，产物里有副本不算"两份实现"）
var repoScanSkipDirs = map[string]bool{
	".git":             true,
	"deepseek-harness": true,
	"temp":             true,
	"node_modules":     true,
	".yarn":            true,
	"dist":             true,
	"build":            true,
}

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
	// 非空判据（与 skill_version_test.go 的 seededSkillDigests 同形态）：第 ⑦ 项整段由
	// 这张表驱动，表被清空时那一段**零次遍历**、一处不报 ⇒ 全绿，而技能内容里仍有多处
	// 文档引用指向被注入的那个文件（"解耦后注入 COPY 被删掉而没人发现"只是从
	// "登记表少一条"换成"整张表没有"）。⑧（`TestBuiltinSkillReferencedFilesExistInImageTree`，
	// 文档引用对账）是同一形态的第二道，两条独立承重。
	if len(skillFileInjections) == 0 {
		t.Fatal("skillFileInjections 是空的 —— 注入关系登记表被清掉了？" +
			"（技能目录里由中性源注入的文件必须逐条登记，否则第 ⑦ 项与 TestBuiltinSkillReferencedFilesExistInImageTree 都失去覆盖面）")
	}
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
	// Dockerfile 的**构建阶段**必须在解析面里：只有最后一个阶段变成镜像，中间阶段的
	// COPY 到不了最终镜像（dest 字符串、落点数、摘要模型全对，文件却不在镜像里）。
	dockerfileInsns := dockerfileInstructions(dockerfileRaw)
	lastStage := dockerfileLastStage(dockerfileInsns)
	dockerfileShipped, dockerfileNested, landings := dockerfileSkillCopies(t, dockerfileInsns, injectionsByKey, injectionsBySource, lastStage)
	assertFinalStageRunsLeaveSeedDirAlone(t, dockerfileInsns, lastStage)

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
	//	a. 中性源确实存在、且**不在**技能源树里（否则不是解耦）；**源树里**也不许留副本
	//	   （同名或**同字节**换名都算 —— 副本会让规则漂）。扫描面 = **仓库**（跳过
	//	   repoScanSkipDirs：VCS / 上游 pin / 临时区 / 依赖 / 构建产物）：承诺是
	//	   "源树里只此一份"，扫描面窄于承诺就等于没守住；
	//	b. 该源在 Dockerfile 里被 COPY 到**登记的落点数**、落在**最终构建阶段**、目标逐字
	//	   是 `<seed>/<技能>/<Dest>`（"逐字同源"由 `dockerfileSkillCopies` 在解析期 Fatal
	//	   保证：非登记源 COPY 进 seed 目录、或落点源与登记源不一致，都在那里当场红）；
	//	c. 注入的字节真的参与技能内容摘要（若把注入 COPY 删掉判据也不红，这条登记就是死代码），
	//	   且"加上注入文件后的摘要"正是 `seededSkillDigests` 里登记的那一个。
	for _, inj := range sortedInjections(injectionsByKey) {
		if !shipped[inj.Skill] {
			t.Errorf("skillFileInjections 往技能 %q 注入 %q，但该技能不在 builtinSkillRegistry 的已下发集合里 —— "+
				"注入到一个不下发的目录是无效动作（要么登记它，要么删掉这条注入）。", inj.Skill, inj.Dest)
			continue
		}

		// a. 中性源在磁盘上恰好一份实现（扫描面 = 仓库源树），且不在技能源树里。
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
		if dupes := sameBytesElsewhere(t, repoRootPath, sourceBytes, path.Join("server", inj.Source)); len(dupes) > 0 {
			t.Errorf("仓库源树里出现了中性源 %q 的**同字节副本**（除登记的那一份 %s 之外）：%v —— "+
				"换名复制、备份副本、放到别的目录同样会让规则漂；源树里只允许有一份实现（改中性源的那一份）。",
				inj.Source, path.Join("server", inj.Source), dupes)
		}

		// b. 落点对账：数量逐条显式、注入落点唯一且目标正确（"逐字同源"见函数头注释）。
		srcLandings := landings[inj.Source]
		if len(srcLandings) != inj.Landings {
			t.Errorf("中性源 %q 在 server/Dockerfile 里有 %d 条 COPY 落点，而 skillFileInjections 登记的是 %d —— "+
				"落点集合变化必须有人复核（多了可能意味着又冒出一份副本，少了意味着某个落点被删）。",
				inj.Source, len(srcLandings), inj.Landings)
		}
		seedLandings, otherLandings := 0, 0
		wantSeedDest := path.Join(imageSkillSeedDir, inj.Skill, inj.Dest)
		for _, l := range srcLandings {
			// ⚠️ 这里曾经有一条 `if l.Source != inj.Source { t.Errorf(…"两个落点必须逐字同源"…) }`：
			// 它是**恒假**的死断言（landings 以解析出来的 src 为键，而 srcLandings 正是
			// 按同一个键取的 ⇒ 循环里元素的 Source 恒等于键）。该性质由解析期承担：
			// 落进 seed 目录的 COPY 若源与登记的中性源不同，`dockerfileSkillCopies`
			// 已经 Fatal；非 seed 落点也只可能来自这个键（同源由构造保证）。死断言删掉，
			// 不留"看起来核过"的空壳。
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

// skillRelativeRefRe 抠出技能内容里出现的**技能目录内**相对路径。
//
// 只认三个已知顶层（`scripts/` / `references/` / `examples/`）：它们是技能树的固定布局；
// 形如 `docs/…`、`server/…`、`webadmin/…` 的引用是**仓库**路径，不属于技能树，不参与对账。
// 前导字符不能是路径字符（否则会从 `foo/references/x.md` 里截出半截路径当技能内路径）。
var skillRelativeRefRe = regexp.MustCompile(`(?:^|[^A-Za-z0-9_./-])((?:scripts|references|examples)/[A-Za-z0-9][A-Za-z0-9._/-]*)`)

// imageSkillTree 是"镜像里那一棵树"的模型：条目集合（文件 + 目录，目录以 `rel/` 记）与
// 文件内容（磁盘技能树 + `skillFileInjections` 注入的文件，逐字节取自中性源）。
//
// 与 `skillContentDigestWithAdditions` 同一口径（磁盘树 + 注入），只是这里要的是"路径
// 集合能否回答『文档引用的文件在不在』"。
type imageSkillTree struct {
	entries map[string]bool
	files   map[string][]byte
}

// imageSkillTreeOf 装配某个技能在镜像里的那一棵树。
func imageSkillTreeOf(t *testing.T, skill string, byKey map[string]skillFileInjection) imageSkillTree {
	t.Helper()
	root := repoSkillDirFor(skill)
	tree := imageSkillTree{entries: map[string]bool{}, files: map[string][]byte{}}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return rerr
		}
		relSlash := filepath.ToSlash(rel)
		if d.IsDir() {
			tree.entries[relSlash+"/"] = true
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		raw, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		tree.entries[relSlash] = true
		tree.files[relSlash] = raw
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 %s: %v", root, err)
	}
	for _, inj := range sortedInjections(byKey) {
		if inj.Skill != skill {
			continue
		}
		raw, rerr := os.ReadFile(filepath.Join(repoServerRoot, filepath.FromSlash(inj.Source)))
		if rerr != nil {
			t.Fatalf("读中性源 %s（技能 %s 的 %s）：%v", inj.Source, inj.Skill, inj.Dest, rerr)
		}
		tree.entries[inj.Dest] = true
		// 注入路径的祖先目录（`scripts/` 之类）同样是镜像里的目录条目。
		for dir := path.Dir(inj.Dest); dir != "." && dir != "/"; dir = path.Dir(dir) {
			tree.entries[dir+"/"] = true
		}
		tree.files[inj.Dest] = raw
	}
	return tree
}

// cleanSkillReference 归一化引用 token：去掉尾部的标点/引号（`README.md.`、`app.js,`
// 之类），归一化路径。返回 "" 表示这个 token 不参与对账（越界路径）。
func cleanSkillReference(tok string) string {
	tok = strings.TrimRight(tok, ".,;:!?)]}\"'`*")
	if tok == "" || strings.Contains(tok, "..") {
		return ""
	}
	clean := path.Clean(tok)
	if clean == "." || clean == "/" || strings.HasPrefix(clean, "../") {
		return ""
	}
	return clean
}

// TestBuiltinSkillReferencedFilesExistInImageTree 是第 ⑧ 项：**技能内容里引用的技能内
// 相对路径，必须在镜像里那一棵树（磁盘技能树 ∪ 注入文件）里真实存在**。
//
// 为什么单独立一条（而不是只留第 ⑦ 项）：第 ⑦ 项整段由 `skillFileInjections` 驱动，
// 表被清空时它**零次遍历**、一处不报；而技能文档里 20 处引用照样指向
// `scripts/pack-assets.mjs` —— 于是"解耦后注入 COPY 被删掉"这个形态（提交口径明确说
// 已被第 ⑦ 项防住）只是换了个入口：把登记表整张删掉。文档引用是这张表**之外**的第二个
// 见证：它由技能内容自己写成，删注入 COPY 的人改不动它（改了就是"文档说的文件不存在"，
// 更该红）。
//
// 变异验证（2026-10-13，隔离副本里实跑）：清空 `skillFileInjections` + 删掉注入 COPY
// ⇒ 红（本条逐条列出引用了该文件的技能文件）；**只有本条**的形态另测过一次：删掉一个
// 被文档引用的磁盘文件（`references/diagnostics.md`）并把摘要登记改到新树（排除
// "内容变 ⇒ 版本必须变"那条判据）⇒ 只有本条红，失败信息里逐条列出引用的路径与文件。
// 正例（现状：登记 + 注入 COPY 齐备）⇒ 绿。
func TestBuiltinSkillReferencedFilesExistInImageTree(t *testing.T) {
	injectionsByKey, _ := registeredSkillInjections(t)
	shipped, _ := registeredSkillDirs(t)
	for _, skill := range sortedKeys(shipped) {
		tree := imageSkillTreeOf(t, skill, injectionsByKey)
		// 引用 → 引用它的技能文件（报错一次说清"谁在引用"，不按出现次数刷屏）。
		missing := map[string][]string{}
		for _, rel := range sortedKeys(tree.files) {
			raw := tree.files[rel]
			// 二进制不进引用扫描（技能里可能有图片/压缩产物）。
			if bytes.IndexByte(raw, 0) >= 0 {
				continue
			}
			for _, m := range skillRelativeRefRe.FindAllStringSubmatch(string(raw), -1) {
				ref := cleanSkillReference(m[1])
				if ref == "" {
					continue
				}
				if tree.entries[ref] || tree.entries[ref+"/"] {
					continue
				}
				missing[ref] = append(missing[ref], rel)
			}
		}
		for _, ref := range sortedKeys(missing) {
			refs := missing[ref]
			sort.Strings(refs)
			t.Errorf("技能 %s 的内容引用了 %q，但它不在**镜像里那一棵树**里（磁盘技能树 ∪ skillFileInjections 注入）：\n"+
				"  引用的文件：%s\n"+
				"  引用它的技能文件：%v\n"+
				"  → 技能文档里的相对路径必须真的随技能下发，否则员工装到的技能缺这个文件\n"+
				"    （本仓登记过的形态：解耦后注入 COPY 被删掉、而技能里多处引用照样在）。\n"+
				"  → 该文件确实随技能下发、但不由 server/skills/ 提供 ⇒ 在 skillFileInjections 里登记\n"+
				"    （技能 / 目录内落点 / 中性源 / 落点数）并在 server/Dockerfile 的**最终阶段**从那个源 COPY；\n"+
				"  → 只是举例/占位路径 ⇒ 改写成不带技能目录前缀的写法（本判据只对账技能树内的相对路径）。",
				skill, ref, strings.Join(refs, ", "), refs)
		}
	}
}

// sameBytesElsewhere 返回 root 下**内容与 want 逐字节相同**的文件（相对 root 的 POSIX
// 路径，升序），排除 keep（登记的那一份中性源）与 `repoScanSkipDirs` 里的目录。
//
// 用途：证明"源树里只有一份实现"不是靠文件名判的 —— 换名复制（`pack-assets-v2.mjs`、
// `pack-assets-backup.mjs` 之类）同样会让规则漂，所以按字节找副本。先按文件大小筛一遍
// （不同大小不可能同字节），于是这个全树扫描在判据里是廉价的。
//
// 扫描根是**仓库**（`repoRootPath`），不是技能源树：承诺（提交口径）是"源树里只此一份"，
// 扫描面就必须和承诺一样宽 —— 只扫 `server/skills/` 时把副本放到 `server/demoapps/`
// 或 `packages/` 下是全绿的，而那正是"两份会漂"的形态。
func sameBytesElsewhere(t *testing.T, root string, want []byte, keep string) []string {
	t.Helper()
	keep = path.Clean(filepath.ToSlash(keep))
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != root && repoScanSkipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return rerr
		}
		relSlash := path.Clean(filepath.ToSlash(rel))
		if relSlash == keep {
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
			out = append(out, relSlash)
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
	Line  int    // 指令起始行号（1-based，报错能指到行）
	Stage int    // 所属**构建阶段**序号（0-based；FROM 属于它自己开启的阶段；首个 FROM 之前为 -1）
	Op    string // 大写指令名（COPY / ADD / ENV …）
	Args  []string
}

// dockerfileInstructions 把 Dockerfile 文本切成逻辑指令，并标注每条指令所属的构建阶段。
//
// 为什么要标阶段：多阶段构建里**只有最后一个阶段**变成镜像。中间阶段的一条 COPY 可以把
// dest 字符串、落点数、摘要模型全部"看起来正确"，而文件根本不在最终镜像里 —— 判据若不
// 建模阶段，这一类改动是全绿的。
//
// 口径：
//   - 行尾 `\` 续行先拼成一条（COPY 常常跨行）；
//   - **整行**注释（首个非空白字符是 `#`，含 `# syntax=` 解析指令）与空行丢掉 ——
//     注释里出现 `skills/…` 正是"查某个字符串出现过"会误判的来源；
//   - 参数按 shell 形式切词（支持引号包裹的路径与反斜杠转义）；
//   - `FROM` 开启一个新阶段（序号从 0 起），它**自己**属于这个新阶段。
func dockerfileInstructions(raw string) []dockerfileInstruction {
	var out []dockerfileInstruction
	stage := -1
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
		op := strings.ToUpper(fields[0])
		if op == "FROM" {
			stage++
		}
		out = append(out, dockerfileInstruction{
			Line:  start,
			Stage: stage,
			Op:    op,
			Args:  fields[1:],
		})
	}
	return out
}

// dockerfileLastStage 返回最后一个构建阶段的序号（= 变成镜像的那一个）。
//
// 没有 `FROM` 时返回 -1：那种文本不是合法的 Dockerfile，调用方不必在这里兜
// （docker build 自己会报错），但判据不能因此把"阶段未知"当成"阶段正确"。
func dockerfileLastStage(insns []dockerfileInstruction) int {
	last := -1
	for _, ins := range insns {
		if ins.Stage > last {
			last = ins.Stage
		}
	}
	return last
}

// dockerfileStageFrom 返回某个阶段的 `FROM …` 原文（报错时点名阶段，读日志的人不用数行）。
func dockerfileStageFrom(insns []dockerfileInstruction, stage int) string {
	for _, ins := range insns {
		if ins.Op == "FROM" && ins.Stage == stage {
			return "FROM " + strings.Join(ins.Args, " ")
		}
	}
	return "<未知阶段>"
}

// assertFinalStageRunsLeaveSeedDirAlone 判「最终镜像阶段的 RUN 不许出现技能目录」。
//
// 为什么需要它：本文件只解析 COPY/ADD，而 RUN 可以在技能目录里写出判据看不见的字节 ——
// `COPY <中性源> <seed>/<技能>/<Dest>` 之后再来一条
// `RUN echo MUTATED > <seed>/<技能>/<Dest>`，镜像里的字节就与中性源不同，而
// "同源 ⇒ 同字节 ⇒ 同摘要"这条论证的前提已经不成立（登记表里的摘要仍是中性源的摘要）。
//
// 为什么取"出现即 Fatal"这种强形式：文本面**分不清读与写**
// （`RUN node -e 'fs.writeFileSync(…)'` 之类根本看不出来），所以可静态判定、不会漏的口径
// 只能是"最终阶段不碰技能目录"。技能目录的字节只允许由 COPY/ADD 决定。
// 想让镜像自己的断言生效，请写进 `scripts/ci-build-channel-images.sh` 的 `verify_image`
// （真在镜像里跑）或本文件的 ⑤/⑦ 项（判据面）。
func assertFinalStageRunsLeaveSeedDirAlone(t *testing.T, insns []dockerfileInstruction, lastStage int) {
	t.Helper()
	for _, ins := range insns {
		if ins.Op != "RUN" || ins.Stage != lastStage {
			continue
		}
		text := strings.Join(ins.Args, " ")
		if !strings.Contains(text, imageSkillSeedDir) && !strings.Contains(text, "PICOAI_SKILL_SEED_DIR") {
			continue
		}
		t.Fatalf("server/Dockerfile:%d 在**最终镜像阶段**（%s）的 RUN 里出现了技能目录（%s / PICOAI_SKILL_SEED_DIR）：\n"+
			"  RUN %s\n"+
			"  → 判据只解析 COPY/ADD，RUN 能在技能目录里写出判据看不见的字节（注入文件的字节就不再等于中性源，\n"+
			"    而 seededSkillDigests 登记的仍是中性源的摘要）。文本面分不清「读」与「写」，所以最终阶段的 RUN\n"+
			"    一律不许碰技能目录：技能目录的内容只能由 COPY/ADD 决定。\n"+
			"  → 要断言镜像里的技能文件存在，请写进 scripts/ci-build-channel-images.sh 的 verify_image（镜像级）\n"+
			"    或本文件第 ⑤/⑦ 项（Dockerfile 文本级）。",
			ins.Line, dockerfileStageFrom(insns, ins.Stage), imageSkillSeedDir, text)
	}
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
// 落点。同一个源的多条落点必须**逐字同源** ⇒ 同字节 ⇒ 同摘要（"逐字同源"在解析期保证：
// 落进 seed 目录的 COPY 若源与登记的中性源不同，本函数当场 Fatal；其余落点由 `landings`
// 以解析出来的源为键这一构造保证）。
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
//     是 `skillFileInjections`，它同时表达"这个技能文件来自中性源路径"）；
//   - 任何**落进 seed 目录**的 COPY/ADD 不在**最后一个构建阶段**（中间阶段到不了最终
//     镜像：dest 字符串、落点数、摘要模型可以全对，文件却不在镜像里）；
//   - **中性源**的落点是相对路径（相对 WORKDIR 解析，判据读不出它落在哪 —— 落点数
//     与"哪一条进了技能目录"都会失准）。
func dockerfileSkillCopies(
	t *testing.T,
	insns []dockerfileInstruction,
	injectionsByKey map[string]skillFileInjection,
	injectionsBySource map[string]skillFileInjection,
	lastStage int,
) (shipped map[string]int, nested map[string][]int, landings map[string][]dockerfileLanding) {
	t.Helper()
	shipped = map[string]int{}
	nested = map[string][]int{}
	landings = map[string][]dockerfileLanding{}
	for _, ins := range insns {
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
		// 落进 seed 目录的 COPY/ADD 必须在**最后一个构建阶段**：中间阶段不参与最终镜像，
		// 文件到不了 /opt/picoaide/skills（而 dest 字符串、落点数、摘要模型可以全对）。
		if destIsSeed && ins.Stage != lastStage {
			t.Fatalf("server/Dockerfile:%d 的 %s 把内容放进技能目录 %s，但它不在**最后一个构建阶段**"+
				"（本指令在阶段 %d：%s；最后一个阶段是 %d：%s）——\n"+
				"  中间阶段不会进入最终镜像，这个文件到不了 /opt/picoaide/skills，员工装到的技能会缺它。\n"+
				"  → 把这条 COPY/ADD 移到最后一个阶段（技能目录的内容只能由最终阶段的 COPY/ADD 决定）。",
				ins.Line, ins.Op, imageSkillSeedDir, ins.Stage, dockerfileStageFrom(insns, ins.Stage),
				lastStage, dockerfileStageFrom(insns, lastStage))
		}

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
			// 中性源的落点必须是绝对路径：相对路径相对 WORKDIR 解析，判据读不出它落在哪，
			// 于是"落进技能目录的那一条"可能被记成别的落点（落点数对账就失准）。
			if !strings.HasPrefix(destClean, "/") {
				t.Fatalf("server/Dockerfile:%d 把中性源 %q COPY 到相对路径 %q —— 相对 WORKDIR 解析，"+
					"判据读不出它落在哪，无法对账「中性源被放到了哪几个落点」。请写绝对路径"+
					"（注入技能目录的那一条必须是 `<PICOAI_SKILL_SEED_DIR>/<技能>/<Dest>`）。",
					ins.Line, src, dest)
			}
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

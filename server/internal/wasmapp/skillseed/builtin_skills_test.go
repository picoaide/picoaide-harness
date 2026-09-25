package skillseed

import (
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

// TestBuiltinSkillInventoryMatchesDiskDockerfileAndDigests 是 R13-F-05 的判据本体。
func TestBuiltinSkillInventoryMatchesDiskDockerfileAndDigests(t *testing.T) {
	shipped, exempt := registeredSkillDirs(t)
	disk := diskSkillDirs(t)
	dockerfileRaw := readRepoFile(t, repoDockerfilePath)
	dockerfileShipped, dockerfileNested := dockerfileSkillCopies(t, dockerfileRaw)

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
	// identity 规则）；② 当前内容摘要已登记且版本一致。运行期 `loadSkill` 就是生产读资产的
	// 入口，用它而不是另写一套检查，避免判据与运行期判据漂移。
	for _, dir := range sortedKeys(shipped) {
		root := repoSkillDirFor(dir)
		if _, err := loadSkill(repoSkillsRoot, dir); err != nil {
			t.Errorf("已下发技能 %s 过不了运行期的资产校验（loadSkill）：%v\n"+
				"  → 运行期 skillseed 会把整条技能记成「被跳过的坏资产」：清单里没有它、客户端装不到，"+
				"只在启动日志与管理端诊断里可见。", dir, err)
			continue
		}
		digest, files := skillContentDigest(t, root)
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

// dockerfileSkillCopies 从 Dockerfile 里抽出「一行一个技能」的 COPY 清单。
//
// 返回：shipped = 技能目录 → COPY 行号；nested = 被引用内部文件的技能目录 → 行号列表。
//
// 不可静态判定的写法一律 Fatal（"读不出清单"不等于"清单是空的"）：
//   - 源是整个 `skills/` 根或用通配/变量（判据读不出具体技能）；
//   - 一条 COPY 带多个技能目录源（清单必须一行一个技能，判据才能逐行对拍）；
//   - `COPY --from=<另一阶段> skills/…`（判据读不到那个阶段的真实内容）；
//   - 把技能目录**内部**的路径 COPY 进 seed 目录（下发的是残包，不是整技能）。
func dockerfileSkillCopies(t *testing.T, raw string) (shipped map[string]int, nested map[string][]int) {
	t.Helper()
	shipped = map[string]int{}
	nested = map[string][]int{}
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
				t.Fatalf("server/Dockerfile:%d 有东西被 COPY 进 %s，但源不是 `skills/<name>/` 的形态（源：%v）—— "+
					"内置技能必须一行一个技能地从构建上下文的 server/skills/ 取，判据才能对拍清单（R13-F-05）。",
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
	return shipped, nested
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

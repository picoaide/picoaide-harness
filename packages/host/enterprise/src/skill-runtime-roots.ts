/**
 * 运行时技能**发现根**的唯一真源（R13-GH3 · H2「跨根」缺口）。
 *
 * 为什么需要它：能力中心的"已安装集合 == 运行时集合"这条判据，在**同一个技能库根内**
 * 已经闭合（install → uninstall → 再列运行时注册表，见
 * `tests/skill-install-runtime-parity.spec.ts`），但**运行时发现面是多根合并的** ——
 * pinned 上游 `packages/skill/skill-filesystem/src/index.ts` 的 `roots()`（同文件里
 * `PROJECT_DSH_RANK=100 / PROJECT_AGENTS_RANK=200 / CUSTOM_RANK=300 /
 * USER_DSH_RANK=400 / USER_AGENTS_RANK=500`，加 `dsh-skill` 的
 * `BUNDLED_SKILL_RANK=600`）把 project → custom → `<dshHome>/skills` →
 * `<agentsHome>/skills` → bundled 依次合并，**rank 小的赢**。
 *
 * 而企业侧技能库只拥有 `<dshHome>/skills` 一个根。于是同一个名字若也在
 * `<agentsHome>/skills`（默认 `$DSH_AGENTS_HOME` 或 `~/.agents`）里：
 *
 *	uninstallSkill 返回成功、能力中心显示"未安装"，而运行时照旧加载该技能
 *	（V13-B 的边界探针实测：卸载后 runtime = [["alpha","FROM-AGENTS-ROOT"]]）。
 *
 * 收口口径（任务给出的 (a) 方案）：卸载时按**运行时同一判据**（`discoverRuntimeSkills`，
 * 与上游 `discoverRoot` 逐条对齐）在**全部已知根**里查同名；不属于自己能管的根 ⇒ 抛
 * `RESIDUE`（列条目名 + 根 + 指引），**绝不返回成功**。
 *
 * R18B-01（2026-09-25）：**project 根也在"已知根"里**。此前本表只在调用方显式给出
 * `projectRoot` 时才产出 project 根，而生产调用点（能力中心的本机安装/卸载路由）
 * 从来不给 ⇒ `<项目>/.dsh/skills`（rank 100，**排在被管的 400 之前**）里的同名技能
 * 让"安装成功 / 卸载成功"两个方向都变成界面上的说法，而模型读的是项目里那一份；
 * 更糟的是那个目录在工作区里（= 沙箱可写根），随仓库克隆或 agent 自己写下都能形成
 * 持久的系统提示词注入面。现在调用方拿**已登记工作区**（`workspaceRegistry`）经
 * {@link workspaceProjectRoots} 折成项目根传进来（`projectRoots`），install/uninstall
 * 两侧因此都能如实报 `RESIDUE`。
 *
 * 本模块只放"根表 + 路径推导"（纯数据/纯函数，不 import 安装器，避免循环依赖）；
 * 逐根扫描与合并留在 `skill-install.ts` 的 `discoverRuntimeSkills` /
 * `discoverRuntimeSkillsAcrossRoots` —— 判据实现只有一份。
 *
 * **与上游的漂移由行为探针守住**：`tests/skill-runtime-roots.spec.ts` 真跑 pinned
 * 上游注册表，在每一个候选根里放一个唯一名字的技能，断言"上游实际加载了哪些根"
 * 与本表**逐项相等**（含反向对照：不在表里的目录必须**不**被上游加载）。上游增删
 * 根 ⇒ 该用例红 ⇒ 本表必须跟着改。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 上游 `roots()` 的 `source` 取值（跨根残留报告里点名"是哪一种根"）。 */
export type RuntimeSkillRootSource =
  | 'project-dsh'
  | 'project-agents'
  | 'custom'
  | 'user-dsh'
  | 'user-agents'
  | 'bundled'

/** 一枚运行时发现根（与上游 `SkillRoot` 同形 + 我们自己的 `managed` 标记）。 */
export interface RuntimeSkillRoot {
  /** 绝对路径（已 resolve）。 */
  readonly path: string
  /** 上游的 source 标签。 */
  readonly source: RuntimeSkillRootSource
  /** 上游 `roots()` 的 rank —— **小的赢**（同名先到先得按 rank 升序）。 */
  readonly rank: number
  /** 上游 `skipSystem`：只有 `<dshHome>/skills` 这一个根跳过 `.system`。 */
  readonly skipSystem: boolean
  /**
   * 能力中心**能管**的根（只有 `<dshHome>/skills`：安装器的落点）。
   * false 的根里出现同名技能时，卸载只能如实报 `RESIDUE`（那是用户/别的工具的
   * 内容，本产品不替用户删）。
   */
  readonly managed: boolean
}

/** 上游 `roots()` 的 rank 常量（pinned 上游同源；改这里必须同步行为探针）。 */
export const RUNTIME_SKILL_ROOT_RANKS = {
  projectDsh: 100,
  projectAgents: 200,
  custom: 300,
  userDsh: 400,
  userAgents: 500,
  bundled: 600,
} as const

/** 上游 `skill-filesystem` 的 `roots()` 里，project 根的判定依赖"项目根"。 */
export interface RuntimeSkillRootsOptions {
  /**
   * 能力中心管的那个技能库（`<dshHome>/skills`，通常来自 `resolveSkillsDir()`）。
   * 提供它时 `dshHome` 取它的父目录 —— 那是"我正在管哪个根"的唯一权威，
   * 不依赖 `DSH_HOME` 环境变量（调用方可能已经用显式 `skillsDir` 覆盖过）。
   */
  readonly skillsDir?: string | undefined
  /** 显式 dshHome（没有 `skillsDir` 时用；两者都给时以 `skillsDir` 推导为准）。 */
  readonly dshHome?: string | undefined
  /** 环境映射（测试 seam；缺省 `process.env`）。 */
  readonly env?: Record<string, string | undefined> | undefined
  /** `~` 展开用的 home（测试 seam；缺省 `os.homedir()`）。 */
  readonly home?: string | undefined
  /**
   * 当前工作区/项目根。上游只在 `list({cwd})` 给出 cwd 且找得到项目根时扫描
   * project 根。传了就**原样**纳入（不再向上找 `.git` —— 调用方已经给出了项目根）。
   */
  readonly projectRoot?: string | undefined
  /**
   * 多个项目根（R18B-01）：调用方拿到的是**会话工作区目录**时，先用
   * {@link workspaceProjectRoots} 折成项目根（判据与上游 `findProjectRoot` 同一份），
   * 再传进来。每个项目根贡献 project-dsh(100) 与 project-agents(200) 两条。
   *
   * 为什么需要多根：能力中心的技能库是**机器作用域**的（一个根服务全部会话），
   * 而运行时按**每个会话的 cwd** 决定 project 根 ⇒ "装好了 == 运行时加载的是刚装的
   * 那一份"这条不变量必须对**本机已登记的每一个工作区**成立，否则某个工作区里的
   * 同名技能会把能力中心那一份整个盖住（模型读的是仓库里那一份）。
   */
  readonly projectRoots?: readonly string[] | undefined
  /** 上游 `customSkillDirs` 的等价物（桌面组合没有配它，默认空）。 */
  readonly customSkillDirs?: readonly string[] | undefined
}

/**
 * 生产默认的 `<agentsHome>`：与上游逐字一致
 * （`resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))`）。
 * 桌面组合只 `insert` 该行、不给 config ⇒ 走这里。
 */
export function defaultAgentsHome(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const fromEnv = env.DSH_AGENTS_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(home, '.agents')
  return resolve(selected)
}

/**
 * 「会话工作区目录 → 项目根」的推导：**逐条镜像** pinned 上游
 * `skill-filesystem` 的 `findProjectRoot(cwd)`（同文件 `roots()` 里 project 根的来源）：
 *
 *	从 resolve(cwd) 起**向上**找第一个含 `.git` 的目录；一路到文件系统根都没找到
 *	就回落到 cwd 本身。
 *
 * 为什么必须照抄而不是"就用 cwd"：`.git` 可以在工作区的**祖先**目录里（用户把
 * 工作区设成 monorepo 的子目录时最常见），此时上游扫的是祖先里的
 * `<祖先>/.dsh/skills` —— 用 cwd 直接拼会指向一个**运行时根本不读**的目录，
 * 判据于是恒为空（假绿）。漂移由行为探针守住：
 * `tests/skill-runtime-roots.spec.ts` 真跑上游注册表（带 `cwd`）与这里逐例对拍。
 *
 * @param cwd - 会话工作区目录（可以是子目录）。
 * @param hasGitMarker - `.git` 存在性判据（测试 seam；缺省 `existsSync`）。
 *   注意上游只看"这个路径存不存在"（工作树里 `.git` 是**文件**，正常仓库里是目录）。
 * @returns 项目根绝对路径（找不到 `.git` 时 = `resolve(cwd)`）。
 */
export function resolveWorkspaceProjectRoot(
  cwd: string,
  hasGitMarker: (candidate: string) => boolean = candidate => existsSync(candidate),
): string {
  const start = resolve(cwd)
  let current = start
  for (;;) {
    if (hasGitMarker(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/**
 * 把**多个**会话工作区目录折成去重后的项目根列表（顺序 = 输入顺序）。
 *
 * 去重按 {@link skillRootPathKey}（同目录的不同拼写只算一个根）；空串/纯空白跳过
 * （注册表里出现过占位取值时不要把它当根）。
 *
 * @param workspacePaths - 已登记工作区的目录。
 * @param hasGitMarker - 见 {@link resolveWorkspaceProjectRoot}。
 * @returns 项目根（已 resolve、已去重）。
 */
export function workspaceProjectRoots(
  workspacePaths: readonly string[],
  hasGitMarker?: (candidate: string) => boolean,
): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  for (const path of workspacePaths) {
    if (typeof path !== 'string' || path.trim() === '') continue
    const projectRoot = resolveWorkspaceProjectRoot(path, hasGitMarker)
    const key = skillRootPathKey(projectRoot)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(projectRoot)
  }
  return roots
}

/**
 * 列出**运行时真正会扫描**的技能根（顺序 = 上游 `roots()` 的顺序，rank 升序）。
 *
 * 与上游的三点差异，都是显式的：
 *  1. `includeDefaultRoots` 恒为 true（桌面组合没有把它关掉的地方）；
 *  2. project 根只在调用方给出 `projectRoot`/`projectRoots` 时出现（见
 *     {@link RuntimeSkillRootsOptions.projectRoots}）；
 *  3. bundled 根只在 `$DSH_BUNDLED_SKILL_DIR` 非空时出现（与上游同判据）。
 */
export function runtimeSkillRoots(options: RuntimeSkillRootsOptions = {}): RuntimeSkillRoot[] {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const dshHome = options.skillsDir !== undefined
    ? dirname(resolve(options.skillsDir))
    : resolve(options.dshHome ?? env.DSH_HOME ?? join(home, '.dsh'))
  const agentsHome = defaultAgentsHome(env, home)
  const managedRoot = options.skillsDir !== undefined ? resolve(options.skillsDir) : join(dshHome, 'skills')

  const roots: RuntimeSkillRoot[] = []
  // project 根：单个 `projectRoot` 与多个 `projectRoots` 走**同一条**产出路径
  // （不再有第二份"根从哪来"的手抄），并且按目录去重 —— 同一个项目根被两条来源
  // 同时给到（或注册表里有两个工作区落在同一项目）时只出现一次。
  const projectSeen = new Set<string>()
  for (const candidate of [...options.projectRoot === undefined ? [] : [options.projectRoot], ...options.projectRoots ?? []]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const projectRoot = resolve(candidate)
    const key = skillRootPathKey(projectRoot)
    if (projectSeen.has(key)) continue
    projectSeen.add(key)
    roots.push(
      { path: join(projectRoot, '.dsh/skills'), source: 'project-dsh', rank: RUNTIME_SKILL_ROOT_RANKS.projectDsh, skipSystem: false, managed: false },
      { path: join(projectRoot, '.agents/skills'), source: 'project-agents', rank: RUNTIME_SKILL_ROOT_RANKS.projectAgents, skipSystem: false, managed: false },
    )
  }
  for (const dir of options.customSkillDirs ?? []) {
    roots.push({ path: resolve(dir), source: 'custom', rank: RUNTIME_SKILL_ROOT_RANKS.custom, skipSystem: false, managed: false })
  }
  roots.push({
    path: managedRoot,
    source: 'user-dsh',
    rank: RUNTIME_SKILL_ROOT_RANKS.userDsh,
    skipSystem: true, // 上游只给 user-dsh 根设 skipSystem
    managed: true,
  })
  roots.push({
    path: join(agentsHome, 'skills'),
    source: 'user-agents',
    rank: RUNTIME_SKILL_ROOT_RANKS.userAgents,
    skipSystem: false,
    managed: false,
  })
  const bundled = env.DSH_BUNDLED_SKILL_DIR
  if (bundled !== undefined && bundled.trim().length > 0) {
    roots.push({ path: resolve(bundled.trim()), source: 'bundled', rank: RUNTIME_SKILL_ROOT_RANKS.bundled, skipSystem: false, managed: false })
  }
  return roots
}

/**
 * 路径比较键（跨平台一致：分隔符归一 + 去尾分隔 + 小写）。
 * 与 `host-home` 的 `normalizePathForCompare` 同口径（那边未导出，这里是同一规则
 * 的本地实现，只用于"这两个根是不是同一个目录"）。
 */
export function skillRootPathKey(value: string): string {
  const resolved = resolve(value).split('\\').join('/')
  let end = resolved.length
  while (end > 1 && resolved[end - 1] === '/') end--
  return resolved.slice(0, end).toLowerCase()
}

/** 两个根是不是同一个目录（路径比较键相等）。 */
export function isSameSkillRoot(a: string, b: string): boolean {
  return skillRootPathKey(a) === skillRootPathKey(b)
}

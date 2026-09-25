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
 * 本模块只放"根表 + 路径推导"（纯数据/纯函数，不 import 安装器，避免循环依赖）；
 * 逐根扫描与合并留在 `skill-install.ts` 的 `discoverRuntimeSkills` /
 * `discoverRuntimeSkillsAcrossRoots` —— 判据实现只有一份。
 *
 * **与上游的漂移由行为探针守住**：`tests/skill-runtime-roots.spec.ts` 真跑 pinned
 * 上游注册表，在每一个候选根里放一个唯一名字的技能，断言"上游实际加载了哪些根"
 * 与本表**逐项相等**（含反向对照：不在表里的目录必须**不**被上游加载）。上游增删
 * 根 ⇒ 该用例红 ⇒ 本表必须跟着改。
 */
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
   * project 根；卸载面拿不到 cwd（能力中心的本机路由不带工作区），所以生产路径
   * 通常不传 —— 这是**登记在案的边界**：project 根不在"已知根"集合里。
   * 传了就如实纳入（判据与上游同一份 roots() 顺序）。
   */
  readonly projectRoot?: string | undefined
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
 * 列出**运行时真正会扫描**的技能根（顺序 = 上游 `roots()` 的顺序，rank 升序）。
 *
 * 与上游的三点差异，都是显式的：
 *  1. `includeDefaultRoots` 恒为 true（桌面组合没有把它关掉的地方）；
 *  2. project 根只在调用方给出 `projectRoot` 时出现（见 {@link RuntimeSkillRootsOptions.projectRoot}）；
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
  if (options.projectRoot !== undefined) {
    const projectRoot = resolve(options.projectRoot)
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

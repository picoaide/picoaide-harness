/**
 * 平台内置技能（服务端下发、客户端按需安装）的**数据与动作**。
 *
 * 2026-09-18 用户口径：内置技能在能力中心里必须**和普通技能一样是一张卡片**，
 * 而不是顶部置顶的一条横幅。因此这里不再渲染任何 UI —— 只导出：
 *   - `useBuiltinSkills()`：清单 / 已装目录 / 本地版本 / 忙碌与失败态 / 安装动作；
 *   - 纯函数（`builtinAction` / `builtinRowState` / `builtinInstallEndpoint` /
 *     `matchBuiltinSkill`）：可单测，且让"哪一行显示什么"与渲染解耦。
 * 卡片外观由 `CapabilityCenterPanel` 用**它自己的卡片样式**渲染（同一套 CARD /
 * 徽章 / 按钮），避免两份样式漂移，也避免 panel ↔ 本模块的循环 import。
 */
import { useEffect, useState } from 'react'
import { compareVersions } from './version-compare.ts'

/** 内置技能清单行（服务端 `GET /api/client/v2/skills/builtin` 的形状）。 */
export interface BuiltinSkill {
  name: string
  version: string
  title?: string | undefined
  description?: string | undefined
  author?: string | undefined
  category?: string | undefined
  sha256?: string | undefined
  size?: number | undefined
  files?: number | undefined
}

/** 清单响应（宿主代理会额外附上 `installed` 目录名列表）。 */
export interface BuiltinSkillsPayload {
  skills?: BuiltinSkill[] | undefined
  installed?: string[] | undefined
}

/** 一个内置技能相对本机安装状态的动作（纯函数，单测直接打它）。 */
export type BuiltinAction = 'install' | 'update' | 'installed'

/**
 * 由「清单版本 / 已装版本 / 是否已在本机」推出按钮语义。
 *
 * 已装版本的来源是能力中心聚合面（`.picoaide/release.json` 的 provenance，
 * 比 SKILL.md 的 frontmatter 更权威：它记的就是安装时那个版本）。读不到版本
 * 时保守判「已安装」而不谎报可更新（宁可不提示，不可误报 —— 与
 * `hasUpdateFor` 同口径）。
 *
 * **判据为什么是 version 而不是 sha256**（R1-pm-8）：清单里的 `sha256` 是**打包后
 * tar.gz** 的摘要（`server/internal/wasmapp/skillseed` 的打包产物），而本机安装目录
 * 上没有任何可与之对拍的归档摘要 —— provenance 里的 `archiveChecksum` 是
 * `computeSkillContentHash()` 算的**解包后的内容树**哈希（该函数自己的注释写明
 * 「与安装时记录的归档校验和不同源」）。两者是不同对象，直接比大小只会把每一份
 * 已装技能都判成「有更新」（假报）。因此：
 *   - `version` 是**唯一端到端可比**的字段（服务端清单 vs 安装时写下的 provenance，
 *     两者同源：都来自 `X-Skill-Version` / SKILL.md frontmatter）；
 *   - `sha256` 的真职责是**下载时的完整性凭据**（安装链路逐字节对照，见
 *     auth-gate 的内置技能分支），不参与「要不要更新」的判定；
 *   - 「内容变了但 version 不变」由服务端门禁兜住（skillseed 的
 *     TestBuiltinSkillVersionTracksContent：改内容必须提版本），否则这个判据会失灵。
 * 客户端**不硬编码任何版本号或摘要**：一切以服务端清单为准。
 * @param latest - 服务端清单里的版本。
 * @param installedVersion - 本机已装版本（未知则 undefined）。
 * @param installed - 本机是否已装（目录存在）。
 */
export function builtinAction(latest: string, installedVersion: string | undefined, installed: boolean): BuiltinAction {
  if (!installed) return 'install'
  if (installedVersion === undefined || installedVersion === '') return 'installed'
  return compareVersions(latest, installedVersion) > 0 ? 'update' : 'installed'
}

/**
 * 一行的按钮区状态（**纯函数**：可单测，与渲染解耦）。
 *
 * 抽出来的理由与 {@link builtinAction} 同款，外加一条独立性：失败态必须是**按行**的
 * （独立审计 2026-09-18 P2-5）。原先用一个全局 `failed` 字符串，任意一行失败就让
 * **所有**未安装行都变成错误文案、连按钮都没了 —— 一次网络抖动把整块区域变成死墙。
 * 这个纯函数让"失败只影响那一行"成为可断言的契约，不必依赖 jsdom 渲染。
 *
 * ⚠️ 本函数只回答"已装的行显示已安装胶囊"。"**已装但有新版**"的行不是这个态 ——
 * 它要出的是可点的「更新到 vX」按钮，判定在 {@link planBuiltinCards}（R1-pm-8：
 * 若把更新行也交回这里，它会显示「已安装」、按钮消失，那正是死代码的形态）。
 * @param name - 技能名。
 * @param state - 已装名单 / 正在装的行 / 失败的行。
 * @returns `installed` | `busy` | `failed` | `action`（可点安装或更新）。
 */
export function builtinRowState(
  name: string,
  state: { installed: readonly string[], busy: string | null, failedName: string | null },
): 'installed' | 'busy' | 'failed' | 'action' {
  if (state.installed.includes(name)) return 'installed'
  return builtinRowProgress(name, state)
}

/**
 * 按钮区的"临时态"：正在装 / 这一行刚失败 / 可点。与"是否已装"无关。
 *
 * 单独抽出来是给 {@link planBuiltinCards} 用的：更新行在磁盘上已装，但它的按钮区
 * 不是「已安装」而是「更新到 vX」（可点 / 进行中 / 失败三态）。
 * @param name - 技能名。
 * @param state - 正在装的行与失败的行。
 * @returns `busy` | `failed` | `action`。
 */
export function builtinRowProgress(
  name: string,
  state: { busy: string | null, failedName: string | null },
): 'busy' | 'failed' | 'action' {
  if (state.busy === name) return 'busy'
  if (state.failedName === name) return 'failed'
  return 'action'
}

/** 安装端点（与市场技能同一前缀的宿主代理；不直连服务端）。 */
export function builtinInstallEndpoint(name: string, force: boolean): string {
  const base = `/api/pico/skills/builtin/${encodeURIComponent(name)}/install`
  return force ? `${base}?force=1` : base
}

/**
 * 内置技能的数据与动作（面板把它渲染成普通卡片）。
 *
 * 拿不到清单（未登录 / 旧版服务端 / 网络失败）时返回空列表 —— 这不是错误面，
 * 能力中心自己的分区错误提示负责其它失败。
 * @returns 清单、已装目录、本地版本、忙碌/失败态与安装动作。
 */
export function useBuiltinSkills(onInstalled?: () => void) {
  const [rows, setRows] = useState<BuiltinSkill[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  const [versions, setVersions] = useState<Record<string, string | undefined>>({})
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * 失败态**按行**记（技能名 + 文案）。
   *
   * 原先是一个全局 `string | null`，于是**任意一行**安装失败后，所有"未安装/可更新"
   * 的行都会被替换成同一句错误文案、连按钮都没了 —— 一次网络抖动就把整块区域变成
   * 死墙，用户既看不出是哪一行失败、也没法重试（独立审计 2026-09-18 P2-5）。
   */
  const [failed, setFailed] = useState<{ name: string, message: string } | null>(null)

  useEffect(() => {
    // 卸载后不再 setState（面板可随时关闭）。
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/pico/skills/builtin')
        if (!res.ok) return
        const data = await res.json() as BuiltinSkillsPayload
        if (!alive) return
        const skills = data.skills ?? []
        setRows(skills)
        setInstalled(data.installed ?? [])
        // 已装版本取自能力中心聚合面（与「我的」列表同一个事实源）。
        const local = await fetch('/api/pico/capabilities?source=local')
        if (!local.ok || !alive) return
        const payload = await local.json() as { items?: Array<{ name?: string, version?: string, source?: string }> }
        const map: Record<string, string | undefined> = {}
        for (const item of payload.items ?? []) {
          if (item.source === 'local' && typeof item.name === 'string') map[item.name] = item.version
        }
        if (alive) setVersions(map)
      } catch {
        // 静默：拿不到内置技能清单就当作"没有"（旧版服务端就是这条路）。
      }
    })()
    return () => { alive = false }
  }, [])

  /**
   * 安装 / **重装（更新）**一行。
   *
   * `force` 由**判据**决定而不是调用方随手传：只要本机已经有这一行（已装）就走既有的
   * `?force=1` 重装路径（`builtinInstallEndpoint`），未装则是普通安装。这样"更新"
   * 按钮与"安装"按钮共用同一条链路，不会出现"看起来能更新、实际装不上"的第二条路径。
   * @param skill - 清单行。
   */
  const install = async (skill: BuiltinSkill): Promise<void> => {
    const force = builtinAction(skill.version, versions[skill.name], installed.includes(skill.name)) !== 'install'
    setBusy(skill.name)
    setFailed(null)
    try {
      const res = await fetch(builtinInstallEndpoint(skill.name, force), { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? `HTTP ${String(res.status)}`)
      }
      setInstalled(prev => (prev.includes(skill.name) ? prev : [...prev, skill.name]))
      setVersions(prev => ({ ...prev, [skill.name]: skill.version }))
      // 装成功 ⇒ 通知面板刷新「我的」列表：那只技能马上以普通卡片出现
      // （带「平台内置」来源徽章），同时本入口卡片消失（见面板的 localSkillNames 过滤）。
      onInstalled?.()
    } catch (cause) {
      setFailed({ name: skill.name, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(null)
    }
  }

  return { rows, installed, versions, busy, failed, install }
}

/**
 * 内置技能是否命中搜索词（与面板对普通卡片的搜索口径一致：标题/名字/描述）。
 *
 * 抽成纯函数是为了让"内置技能也要能被搜到"这条口径可单测 —— 它在横幅形态下
 * 天然不成立（横幅在列表之外，搜索框管不到它）。
 * @param skill - 内置技能行。
 * @param query - 搜索框内容（空串 = 全部命中）。
 * @returns 命中为 true。
 */
export function matchBuiltinSkill(skill: BuiltinSkill, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const fields = [skill.name, skill.title ?? '', skill.description ?? '', skill.author ?? '', skill.category ?? '']
  return fields.some(f => f.toLowerCase().includes(q))
}

/** 面板要渲染的一张内置技能卡：动作 / 端点 / 行状态都已定好，渲染层不再做判断。 */
export interface BuiltinCard {
  /** 服务端清单里的那一行（版本来自服务端，不在客户端硬编码）。 */
  skill: BuiltinSkill
  /** 未装 = install；已装且清单更新 = update（已装且同版本不会出卡）。 */
  action: 'install' | 'update'
  /** 点按钮要 POST 的地址；`update` 走既有的 `?force=1` 重装路径。 */
  endpoint: string
  /** 本机已装（服务端清单 `installed[]` ∪ 面板本地列表）。 */
  installed: boolean
  /** 按钮区状态：可点 / 这一行进行中 / 这一行失败。 */
  state: 'action' | 'busy' | 'failed'
  /** 这一行的失败文案（`state === 'failed'` 时非 null）。 */
  failure: string | null
}

/**
 * 决定「我的」分区里内置技能出哪些卡、每张卡的按钮做什么（**面板唯一的判定入口**）。
 *
 * 三条口径（缺任何一条都会回到 R1-pm-8 的现场）：
 *  1. **未装 ⇒ 出「安装」卡**（原有行为）。
 *  2. **已装且清单版本更新 ⇒ 出「更新到 vX」卡**，端点是 `?force=1` —— 这一条原先是
 *     死代码：卡片列表把"已装"整个过滤掉，而 `builtinAction` 只在已装时才返回
 *     `'update'`，两个条件互斥 ⇒ 平台换了新版手册，装过的人永远拿不到。
 *  3. **已装且同版本（或读不到本机版本）⇒ 不出卡**：本机技能库扫描出来的那张普通卡片
 *     就是它，再出第二张会让同一个技能显示两张卡（也避免"读不到版本就谎报有更新"）。
 *
 * 版本比较的两侧都是**服务端/安装时**的事实：`skill.version` 来自服务端清单，
 * `installedVersions[name]` 来自安装时写下的 provenance —— 客户端不硬编码任何版本号。
 * @param options - 清单行、已装名字集合、本机已装版本、搜索词、类型筛选与忙碌/失败态。
 * @returns 需要渲染的卡片（保持服务端给出的顺序）。
 */
export function planBuiltinCards(options: {
  rows: readonly BuiltinSkill[]
  installedNames: ReadonlySet<string>
  /** 本机已装版本（`/api/pico/capabilities?source=local` 的 provenance 版本）；缺省 = 读不到。 */
  installedVersions?: Readonly<Record<string, string | undefined>> | undefined
  query: string
  kindFilter: 'all' | 'skill' | 'agent'
  /** 正在安装/更新的技能名（按行，不阻塞其它行）。 */
  busy?: string | null | undefined
  /** 刚失败的那一行。 */
  failed?: { name: string, message: string } | null | undefined
}): BuiltinCard[] {
  if (options.kindFilter === 'agent') return []
  const busy = options.busy ?? null
  const failed = options.failed ?? null
  const cards: BuiltinCard[] = []
  for (const skill of options.rows) {
    if (!matchBuiltinSkill(skill, options.query)) continue
    // 端到端可比的两个事实：清单版本（服务端）与本机已装版本（安装时的 provenance）。
    const installed = options.installedNames.has(skill.name)
    const action = builtinAction(skill.version, options.installedVersions?.[skill.name], installed)
    // 已装且与清单同版本：本机技能库里那张普通卡片就是它，再出一张会变成同一技能两张卡。
    // （读不到本机版本时 builtinAction 也返回 installed ⇒ 宁可不提示，不误报。）
    if (action === 'installed') continue
    cards.push({
      skill,
      action,
      endpoint: builtinInstallEndpoint(skill.name, action === 'update'),
      installed,
      state: builtinRowProgress(skill.name, { busy, failedName: failed?.name ?? null }),
      failure: failed?.name === skill.name ? failed.message : null,
    })
  }
  return cards
}

/**
 * 选出"要以普通卡片渲染"的内置技能行（{@link planBuiltinCards} 的行视图）。
 *
 * 口径见 {@link planBuiltinCards}：未装的出卡；**已装但清单有更新的也出卡**
 * （R1-pm-8）；已装且同版本的不出（本机技能库那张卡就是它）。
 *
 * `installedNames` 请传**两个事实源的并集**（服务端清单里的 installed[] +
 * 面板「我的」列表里的本地技能名）：任一源说"已装"就按已装处理 —— 宁可少一张
 * 入口卡片（用户能在列表里看到它），也不要出现重复卡片。
 * @param options - 候选行、已装名字集合、本机已装版本、搜索词与类型筛选。
 * @returns 需要渲染的行（保持服务端给出的顺序）。
 */
export function selectBuiltinCards(options: {
  rows: readonly BuiltinSkill[]
  installedNames: ReadonlySet<string>
  installedVersions?: Readonly<Record<string, string | undefined>> | undefined
  query: string
  kindFilter: 'all' | 'skill' | 'agent'
}): BuiltinSkill[] {
  return planBuiltinCards(options).map(card => card.skill)
}

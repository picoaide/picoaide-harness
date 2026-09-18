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
 * 一行按钮区该显示什么（**纯函数**：可单测，与渲染解耦）。
 *
 * 抽出来的理由与 {@link builtinAction} 同款，外加一条独立性：失败态必须是**按行**的
 * （独立审计 2026-09-18 P2-5）。原先用一个全局 `failed` 字符串，任意一行失败就让
 * **所有**未安装行都变成错误文案、连按钮都没了 —— 一次网络抖动把整块区域变成死墙。
 * 这个纯函数让"失败只影响那一行"成为可断言的契约，不必依赖 jsdom 渲染。
 * @param name - 技能名。
 * @param state - 已装名单 / 正在装的行 / 失败的行。
 * @returns `installed` | `busy` | `failed` | `action`（可点安装或更新）。
 */
export function builtinRowState(
  name: string,
  state: { installed: readonly string[], busy: string | null, failedName: string | null },
): 'installed' | 'busy' | 'failed' | 'action' {
  if (state.installed.includes(name)) return 'installed'
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

  const install = async (skill: BuiltinSkill): Promise<void> => {
    const isInstalled = installed.includes(skill.name)
    setBusy(skill.name)
    setFailed(null)
    try {
      const res = await fetch(builtinInstallEndpoint(skill.name, isInstalled), { method: 'POST' })
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

/**
 * 选出"要以普通卡片渲染"的内置技能行。
 *
 * 口径（2026-09-18 用户要求 + 不重复渲染）：
 *   - **已装的排除**：本机技能库扫描出来的那张普通卡片就是它（带「平台内置」来源
 *     徽章），再渲染一张会变成同一个技能两张卡；
 *   - 只属于「我的」分区，且类型筛选为"智能体"时全部排除（内置的目前都是技能）；
 *   - 参与搜索，口径与普通卡片一致（标题/名字/描述/作者/分类）。
 *
 * `installedNames` 请传**两个事实源的并集**（服务端清单里的 installed[] +
 * 面板「我的」列表里的本地技能名）：任一源说"已装"就按已装处理 —— 宁可少一张
 * 入口卡片（用户能在列表里看到它），也不要出现重复卡片。
 * @param options - 候选行、已装名字集合、搜索词与类型筛选。
 * @returns 需要渲染的行（保持服务端给出的顺序）。
 */
export function selectBuiltinCards(options: {
  rows: readonly BuiltinSkill[]
  installedNames: ReadonlySet<string>
  query: string
  kindFilter: 'all' | 'skill' | 'agent'
}): BuiltinSkill[] {
  if (options.kindFilter === 'agent') return []
  return options.rows.filter(skill =>
    !options.installedNames.has(skill.name) && matchBuiltinSkill(skill, options.query))
}

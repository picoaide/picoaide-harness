/**
 * 能力中心的「平台内置技能」区（2026-09-18）。
 *
 * 背景：内置技能（当前是 WASM 应用作者手册 `picoaide-app-builder`）**随服务端
 * 镜像发布**，客户端**按需安装** —— 用户明确要求"skill 应该是内置到服务端，
 * 客户端可以按需安装"。因此：
 *
 *  - 不自动安装：这里只给一个可点的入口（员工自己决定装不装）。**这是唯一入口**
 *    —— vendored 插件（`dsh-memory-evolve`）的随包技能同步清单里刻意排除了平台
 *    技能（`lib/coi/skills-sync.js` 的 `PLATFORM_SKILLS`）：否则开机就自动装好，
 *    这个按钮永远走不到，「按需」名存实亡（独立审计 2026-09-18 P1-1）；
 *  - 复用既有安装链路：`POST /api/pico/skills/builtin/:name/install` 在宿主侧
 *    走的就是能力中心市场技能那条 `installSkillArchive()`（sha256 对照 → 整树
 *    安全解包 → `<dshHome>/skills`），不另写一套安装逻辑；
 *  - 落点与市场安装**同一个根**（`<dshHome>/skills`，上游 skill-filesystem 的
 *    user-dsh root / rank 400）。
 *
 * 服务端没有这条端点时（旧版服务端）整块**隐藏**：不显示空壳，也不报错打扰。
 */
import { useEffect, useState } from 'react'
import { t } from './locales.ts'
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

const SECTION: React.CSSProperties = {
  margin: '0 0 12px',
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform, transparent)',
}
const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }
const NAME: React.CSSProperties = { fontSize: 13, fontWeight: 600, margin: 0 }
const META: React.CSSProperties = { fontSize: 11, opacity: 0.7, margin: 0 }
const DESC: React.CSSProperties = { fontSize: 12, opacity: 0.85, margin: '2px 0 0', lineHeight: 1.45 }
const BUTTON: React.CSSProperties = {
  marginLeft: 'auto', flex: '0 0 auto', height: 28, padding: '0 12px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)', fontSize: 12,
}
const BUTTON_DISABLED: React.CSSProperties = { ...BUTTON, opacity: 0.55, cursor: 'default' }
const DONE: React.CSSProperties = { ...META, marginLeft: 'auto', flex: '0 0 auto' }
const FAIL_ROW: React.CSSProperties = { marginLeft: 'auto', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }
const FAIL: React.CSSProperties = { ...META, marginLeft: 0, flex: '0 0 auto', color: 'var(--dsw-alias-state-error-primary)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

/**
 * 「平台内置技能」区。
 *
 * 拿不到清单（未登录 / 旧版服务端 / 网络失败）时**不渲染任何东西** —— 这是一块
 * 便利入口，不是主面；失败态交给能力中心自己的分区错误提示，不在这里制造噪音。
 */
export function BuiltinSkillsStrip() {
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
        // 静默：内置技能区拿不到就整块不显示（旧版服务端就是这条路）。
      }
    })()
    return () => { alive = false }
  }, [])

  if (rows.length === 0) return null

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
    } catch (cause) {
      setFailed({ name: skill.name, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section style={SECTION} aria-label={t('capability.builtinTitle')}>
      <p style={NAME}>{t('capability.builtinTitle')}</p>
      <p style={META}>{t('capability.builtinHint')}</p>
      {rows.map(skill => {
        const isInstalled = installed.includes(skill.name)
        const rowState = builtinRowState(skill.name, { installed, busy, failedName: failed?.name ?? null })
        // 本行的失败信息（`rowState` 是另一个变量，TS 不会替我们把 `failed` 收窄）。
        const failure = failed?.name === skill.name ? failed : null
        const action = builtinAction(skill.version, versions[skill.name], isInstalled)
        const label = action === 'install'
          ? t('capability.builtinInstall')
          : action === 'update'
            ? t('capability.updateTo', { version: skill.version })
            : t('capability.builtinInstalled')
        return (
          <div key={skill.name} style={ROW}>
            <div style={{ minWidth: 0 }}>
              <p style={NAME}>{skill.title !== undefined && skill.title !== '' ? skill.title : skill.name}</p>
              <p style={META}>{`${skill.name} · v${skill.version}`}</p>
              {skill.description !== undefined && skill.description !== '' && <p style={DESC}>{skill.description}</p>}
            </div>
            {rowState === 'installed'
              ? <span style={DONE}>{label}</span>
              : rowState === 'busy'
                ? <button type="button" style={BUTTON_DISABLED} disabled>{label}</button>
                : failure !== null
                  // 失败的是**这一行**：就地显示原因 + 重试按钮，其余行不受影响。
                  ? (
                      <span style={FAIL_ROW}>
                        <span style={FAIL} title={failure.message}>{failure.message}</span>
                        <button type="button" style={BUTTON} onClick={() => { void install(skill) }}>
                          {t('capability.builtinRetry')}
                        </button>
                      </span>
                    )
                  : <button type="button" style={BUTTON} onClick={() => { void install(skill) }}>{label}</button>}
          </div>
        )
      })}
    </section>
  )
}

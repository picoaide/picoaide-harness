/**
 * R5-B-1 / R5-B-2 / R5-B-3：能力中心的**状态呈现与动作可达性**（2026-09-23 修复）。
 *
 * 三条 finding 的客户端半边各有一个"用户看见什么"的判据，而它们此前**全都**
 * 落在同一个退化路径上：`planCardAction` 在 `source === 'local'` 且没有
 * `uploadStatus` 时一律给「上传」——
 *   1. 管理员**下架**（`apps.enabled=0`）后，员工面 market/org/own 三个来源同时
 *      变空，只剩磁盘本机行 ⇒ 卡片显示「上传」，用户永远不知道它已被下架；
 *   2. **归属转移**后旧作者的本机行仍然是"已通过"，新归属人在「我的」什么都
 *      看不到，而唯一有权续传的是他；
 *   3. 下架后的**智能体**本机行既不能更新也不能卸载：可移除判据只认
 *      `skill` 的 builtin/plugin 两渠道，于是 `uninstallEndpoint` 里那条
 *      `/api/pico/agent-presets/:name/uninstall`（宿主**早就有**）永远走不到。
 *
 * 本文件钉住修好之后的行为，并同时钉住**没有被误伤**的两条既有口径：
 *  - 本机自制、从未上传过的行照旧出「上传」（不然"上传"这个产品动作就没了）；
 *  - `localRemoveEndpoint`（builtin/plugin 那两条端点）的既有语义不变。
 *
 * 判据的判别力（变异验证，逐条实跑见 `temp/round5-2026-09-23/fix-r5b-client-mutations.md`）：
 *  - 把 `isDelistedItem` 改回 `return false` ⇒ 「下架后不再假装可上传」两条必红；
 *  - 把 `isTransferredItem` 改回 `return false` ⇒ 「已转交」两条必红；
 *  - 把归并里的 `isOwner` 改回 `some(=== true) ? true : undefined` ⇒ 归属两条必红；
 *  - 把 `planCardAction` 的 delisted 分支删掉 ⇒ 智能体那条必红（退回 upload）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isDelistedItem,
  isTransferredItem,
  localRemoveEndpoint,
  mergeItems,
  planCardAction,
  uninstallEndpoint,
  type CapabilityItem,
} from '../src/client/CapabilityCenterPanel.tsx'
import { en, setActiveLocale, t, zh } from '../src/client/locales.ts'
import { afterEach } from 'vitest'

afterEach(() => { setActiveLocale('zh') })

const PANEL = fileURLToPath(new URL('../src/client/CapabilityCenterPanel.tsx', import.meta.url))
const LOCALES = fileURLToPath(new URL('../src/client/locales.ts', import.meta.url))

/**
 * 宿主 `?source=local` 下发的"本机行"形状（`auth-gate.ts` 的 `localRows`）：
 * 扫盘得到，带 provenance 派生的 `installedOrigin` / `originChannel`；
 * `uploadStatus` 来自服务端 `?source=own` 的匹配行（下架后匹配不到 ⇒ undefined）。
 */
function localRow(
  kind: 'skill' | 'agent',
  name: string,
  originChannel: string,
  extra: Partial<CapabilityItem> = {},
): CapabilityItem {
  return {
    kind,
    source: 'local',
    name,
    displayName: name,
    ...kind === 'skill' ? { runtimeName: name } : {},
    version: '1.0.0',
    description: '本机说明',
    author: '',
    versions: [],
    isLocal: true,
    installedOrigin: 'store',
    originChannel,
    originAppId: name,
    dirty: false,
    ...extra,
  }
}

/** 目录行（`?source=org` / `?source=market`，host 已按磁盘状态补 installed 等）。 */
function catalogRow(kind: 'skill' | 'agent', name: string, extra: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    kind,
    source: 'org',
    name,
    displayName: name,
    version: '1.0.0',
    description: '目录说明',
    author: 'alice',
    status: 'approved',
    versions: ['1.0.0'],
    installed: true,
    installedVersion: '1.0.0',
    installedOrigin: 'store',
    ...extra,
  }
}

describe('R5-B-1 已下架：员工面能表达出来，且动作与状态一致', () => {
  it('目录里已经没有这一行（下架/撤权）⇒ 已下架，且页脚不再是「上传」', () => {
    const item = localRow('skill', 'r5b-skill', 'org')
    // 修前：`planCardAction` 退化成 {kind:'upload'}（这就是 finding 的现场）。
    expect(planCardAction(item)).not.toEqual({ kind: 'upload' })
    expect(isDelistedItem(item)).toBe(true)
    // 页脚给的是**真的可达**的那一个动作：本地卸载（既有端点）。
    expect(planCardAction(item)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/pico/shared-skills/r5b-skill/1.0.0/uninstall',
      localContent: false,
    })
  })

  it('对照：服务端在行上下发 `enabled:false`（权威判据）⇒ 即使本机是自制品也判已下架', () => {
    const draft: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'my-draft', displayName: 'my-draft',
      version: '1.0.0', description: '', author: '', versions: [], isLocal: true,
      installedOrigin: 'local', enabled: false,
    }
    // 没有商店溯源时**唯一**能判下架的就是这个字段（未知不得当可用）。
    expect(isDelistedItem({ ...draft, enabled: undefined })).toBe(false)
    expect(isDelistedItem(draft)).toBe(true)
    expect(planCardAction(draft).kind).toBe('uninstall')
  })

  it('对照：目录行照旧（本机自制、从未上传）⇒ 仍然出「上传」', () => {
    const draft: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'my-draft', displayName: 'my-draft',
      version: '1.0.0', description: '', author: '', versions: [], isLocal: true,
      installedOrigin: 'local',
    }
    expect(isDelistedItem(draft)).toBe(false)
    expect(planCardAction(draft)).toEqual({ kind: 'upload' })
  })

  it('对照：商店行还在（已授权/已通过）⇒ 归并结果 source 不是 local，照旧出卸载', () => {
    const merged = mergeItems([catalogRow('skill', 'codeql'), localRow('skill', 'codeql', 'org')])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.source).toBe('org')
    expect(isDelistedItem(merged[0]!)).toBe(false)
    expect(planCardAction(merged[0]!)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/pico/shared-skills/codeql/1.0.0/uninstall',
      localContent: false,
    })
  })

  it('目录行上的下架（`enabled:false` 且未安装）⇒ 出状态胶囊，不给「安装」', () => {
    const row = catalogRow('skill', 'gone', { installed: false, enabled: false, installedVersion: undefined })
    expect(isDelistedItem(row)).toBe(true)
    expect(planCardAction(row)).toEqual({ kind: 'delisted' })
  })

  it('`enabled` 在归并里 **false 优先**，未下发保持 undefined（不得读成上架）', () => {
    const flag = (rows: CapabilityItem[]): boolean | undefined => mergeItems(rows)[0]!.enabled
    expect(flag([catalogRow('skill', 'x', { enabled: true })])).toBe(true)
    expect(flag([localRow('skill', 'x', 'org')])).toBeUndefined()
    expect(flag([
      catalogRow('skill', 'x', { enabled: true }),
      localRow('skill', 'x', 'org', { enabled: false }),
    ])).toBe(false)
  })

  it('服务端在作者行上下发的 `delisted:true`（R5-B-1 的权威字段）⇒ 本机自制内容也判已下架', () => {
    // 这一条是本泳道**唯一**能覆盖"作者本机自制、从未从目录装过"的判据来源：
    // 那种行没有商店溯源、服务端也不下发 `enabled`，客户端自己推不出来。
    const mine: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'my-draft', displayName: 'my-draft',
      version: '1.0.0', description: '', author: '', versions: [], isLocal: true,
      installedOrigin: 'local', delisted: true,
    }
    expect(isDelistedItem(mine)).toBe(true)
    expect(planCardAction(mine).kind).not.toBe('upload')
    // 未下发 / 明确 false ⇒ 不宣称任何状态（未知不等于下架）。
    expect(isDelistedItem({ ...mine, delisted: undefined })).toBe(false)
    expect(isDelistedItem({ ...mine, delisted: false })).toBe(false)
    // 归并：任一行说下架就是下架（App 级事实）。
    const merged = mergeItems([{ ...mine, source: 'local' }, { ...mine, source: 'local', delisted: true }])
    expect(merged[0]!.delisted).toBe(true)
  })

  it('字典与面板都真的有「已下架」这一态（修前：两个文件零命中，员工面结构上说不出来）', () => {
    const panel = readFileSync(PANEL, 'utf8')
    const locales = readFileSync(LOCALES, 'utf8')
    expect(panel).toContain("capability.delisted")
    expect(locales).toContain('已下架')
    expect(locales).toContain('delisted')
    expect(zh['capability.delisted']).toBe('已下架')
    expect(en['capability.delisted']).not.toBe('')
    // 说明文字不是空壳：必须同时说清"为什么"与"本机这一份还能用"。
    expect(t('capability.delistedHint')).toContain('目录')
    setActiveLocale('en')
    expect(t('capability.delistedHint')).toContain('catalog')
    // 徽章与说明都必须被渲染层真的用上（纯函数测得再准，没接线也是死代码）。
    expect(panel).toContain("t('capability.delisted')")
    expect(panel).toContain("t('capability.delistedHint')")
    expect(panel).toContain('card-delisted-reason')
  })
})

describe('R5-B-3 下架后的智能体：本机行也要走到 agent 卸载端点', () => {
  it('智能体本机行 ⇒ 卸载动作指向 agent 端点（既有端点，未新增任何服务端接口）', () => {
    const item = localRow('agent', 'r5b-agent', 'org')
    expect(planCardAction(item)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/pico/agent-presets/r5b-agent/uninstall',
      localContent: false,
    })
    // 这条端点一直都在（宿主 auth-gate 的 `POST /api/pico/agent-presets/:name/uninstall`），
    // 修前只是 `planCardAction` 在 local 分支里永远走不到它。
    expect(uninstallEndpoint(item, '1.0.0')).toBe('/api/pico/agent-presets/r5b-agent/uninstall')
  })

  it('对照：智能体仍有商店行时照旧出卸载（行为不变）', () => {
    expect(planCardAction(catalogRow('agent', 'r5b-agent')).kind).toBe('uninstall')
  })

  it('对照：本机自制的智能体（无商店溯源）仍然出「上传」，不被这条修复吃掉', () => {
    const mine = localRow('agent', 'my-agent', '', { installedOrigin: 'local', originChannel: undefined })
    expect(isDelistedItem(mine)).toBe(false)
    expect(planCardAction(mine)).toEqual({ kind: 'upload' })
  })

  it('对照：builtin/plugin 的既有端点语义不变（`localRemoveEndpoint` 不放宽）', () => {
    const base: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'app-builder', displayName: '', version: '2.5.0',
      description: '', author: '', versions: [], isLocal: true, installedOrigin: 'store',
    }
    expect(localRemoveEndpoint({ ...base, originChannel: 'builtin' })).toBe('/api/pico/skills/builtin/app-builder/uninstall')
    expect(localRemoveEndpoint({ ...base, originChannel: 'plugin' })).toBe('/api/pico/skills/app-builder/uninstall')
    expect(localRemoveEndpoint({ ...base, originChannel: 'market' })).toBeUndefined()
    expect(localRemoveEndpoint({ ...base, kind: 'agent', originChannel: 'plugin' })).toBeUndefined()
  })
})

describe('R5-B-2 归属转移：按服务端 owner 字段呈现，不拿本地 author 兜底', () => {
  it('归并如实保留 `is_owner:false`（修前被抹成 undefined ⇒ 客户端说不出"不是你的"）', () => {
    const merged = mergeItems([
      catalogRow('skill', 'transferred', { isOwner: false, author: 'alice' }),
      localRow('skill', 'transferred', 'org', { uploadStatus: 'approved' }),
    ])
    expect(merged[0]!.isOwner).toBe(false)
    expect(isTransferredItem(merged[0]!)).toBe(true)
  })

  it('旧作者：本机行还在 + 服务端说不是你的 ⇒ 已转交，页脚不再给「上传/重新上传」', () => {
    const mine: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'transferred', displayName: 'transferred',
      version: '1.0.0', description: '', author: '', versions: [], isLocal: true,
      installedOrigin: 'local', uploadStatus: 'rejected', isOwner: false,
    }
    expect(isTransferredItem(mine)).toBe(true)
    expect(planCardAction(mine)).toEqual({ kind: 'transferred' })
    // 对照：同一条记录在归属还在自己名下时照旧给「重新上传」（行为不变）。
    expect(planCardAction({ ...mine, isOwner: true })).toEqual({ kind: 'reupload' })
  })

  it('新归属人：`is_owner:true` 的行照旧按上传状态走（有权续传，不被"已转交"吞掉）', () => {
    const merged = mergeItems([
      catalogRow('skill', 'transferred', { isOwner: true, author: 'bob' }),
      localRow('skill', 'transferred', 'org', { uploadStatus: 'approved' }),
    ])
    expect(merged[0]!.isOwner).toBe(true)
    expect(isTransferredItem(merged[0]!)).toBe(false)
  })

  it('判据不看本地缓存的 `author`（归属转移后它还是旧作者的名字）', () => {
    // author 写着别人、但服务端说归你 ⇒ 不是"已转交"。
    const mine: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'x', displayName: 'x', version: '1.0.0',
      description: '', author: 'someone-else', versions: [], isLocal: true,
      uploadStatus: 'approved', isOwner: true,
    }
    expect(isTransferredItem(mine)).toBe(false)
    // author 写着"我"（旧作者留下的行）、服务端说不是你 ⇒ 已转交。
    const theirs: CapabilityItem = { ...mine, isOwner: false }
    expect(isTransferredItem(theirs)).toBe(true)
  })

  it('别人上传、我装进来的商店行不得被误判成「已转交」（没有我的发布记录）', () => {
    const installed = catalogRow('skill', 'codeql', { isOwner: false, uploadStatus: undefined })
    expect(isTransferredItem(installed)).toBe(false)
    // 面板同款：徽章与页脚都走这个判据（说明文字也只在 true 时出现）。
    const panel = readFileSync(PANEL, 'utf8')
    expect(panel).toContain('isTransferredItem')
    expect(panel).toContain("t('capability.transferredHint')")
    expect(panel).toContain('card-transferred-reason')
  })
})

// @vitest-environment jsdom
/**
 * R5-B-1：能力中心的「已下架」徽章**真的被渲染**（第五轮复审 B-N2，2026-09-23）。
 *
 * 为什么需要这个文件（现场）：修复方三条客户端 spec 对"面板渲染了「已下架」"的判据
 * 是**源码字符串**断言（`expect(panel).toContain("t('capability.delisted')")` +
 * `toContain('card-delisted-reason')`）。这两串字面量都在**变量定义**那一行附近，
 * 而徽章是否被放进 JSX 是另一行（`{delistedBadge}`）—— 把它换成 `{null}`（定义与
 * 字面量原样保留）之后：修复方 33 条 + 复审方 9 条纯函数探针**全绿**，只有真挂载
 * 才能打红。本文件就是那条真挂载判据：真 `createRoot + act` 挂载真
 * `CapabilityCenterPanel`，喂真形状的 `?source=local` 载荷，断言 DOM。
 *
 * ## 为什么这条判据住在 `@picoaide/dsh-account-card` 而不是 enterprise
 *
 * enterprise（面板的归属包）的测试环境是 node —— 它**没有** jsdom / react-dom 依赖
 * （同包 `tests/capability-center-panel.spec.ts` 已就此写明取舍），所以那条包内只能
 * 用源码级守卫。account-card 是**唯一**同时满足下面三条的客户端包，故真挂载判据落在这里：
 *   1. `package.json` 已声明 `@picoaide/dsh-enterprise`（依赖边本来就存在 ⇒ 这里的跨包
 *      源码 import 不新增构建图边，`temp/wasm-client-only/cycle-check.mjs` 的
 *      "声明 == 实测" 不变量不受影响）；
 *   2. 自带 jsdom + react-dom（挂载类用例在文件头切 `@vitest-environment jsdom`）；
 *   3. `vitest.config.ts` 把 react / react-dom 钉到本包的安装副本 —— 跨包源码用例
 *      必须共用同一个 React 实例，否则 hooks 全部读到 `null`
 *      （`Cannot read properties of null (reading 'useState')`）。
 *
 * ## 判别力（变异必须打红）
 *   - `{delistedBadge}` → `{null}`（B-N2 的原形态）⇒ 「已下架徽章在卡片里」红；
 *   - 删掉 `data-role="card-delisted-reason"` 那一段 ⇒ 「说明段」红；
 *   - `isDelistedItem` 恒 false / `planCardAction` 退回 `upload` ⇒ 「没有上传按钮」
 *     与徽章两条同时红（本机自制行在旧实现里正是显示「上传」）；
 *   - 把两条 local 行的状态对调（正常行也标下架）⇒ 「正常行不出徽章/出上传」红
 *     （这条负向对照让本文件不可能"恒红"通过）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CapabilityCenterPanel,
  type CapabilityItem,
} from '../../../host/enterprise/src/client/CapabilityCenterPanel.tsx'
import { setActiveLocale, t } from '../../../host/enterprise/src/client/locales.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Call { url: string, init: RequestInit }
let container: HTMLDivElement
let root: Root
let calls: Call[]

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

/** 宿主 `?source=local` 下发的本机行形状（`auth-gate.ts` 的 localRows）。 */
function localRow(name: string, extra: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    kind: 'skill',
    source: 'local',
    name,
    displayName: name,
    version: '1.0.0',
    description: '',
    author: 'alice',
    versions: [],
    isLocal: true,
    installedOrigin: 'local',
    ...extra,
  }
}

/**
 * 两条本机行：`delisted-skill` 带服务端下发的 `delisted:true`（作者面权威字段，
 * 下架后 `?source=own` 匹配行才会带它），`live-skill` 未下架 —— 后者是负向对照。
 */
const DELISTED = localRow('delisted-skill', { delisted: true })
const LIVE = localRow('live-skill')

/**
 * **跨账号**那一条（R6-B-1，第六轮审计）：本机技能库是机器作用域的，这一份是
 * **另一个账号**在这台机器上从能力中心装的（商店溯源，但当前账号 own/market 都看不到
 * ⇒ 宿主只能给 `localOwnership: 'unknown'`）。修复前它被判「已下架」并被给出
 * "删除本机那一份"的动作（跨账号破坏性动作）。
 */
const OTHER_ACCOUNT = localRow('other-account-skill', {
  installedOrigin: 'store',
  originChannel: 'market',
  originAppId: 'other-account-skill',
  localOwnership: 'unknown',
})

beforeEach(() => {
  setActiveLocale('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    if (url.includes('source=local')) return jsonResponse(200, { items: [DELISTED, LIVE, OTHER_ACCOUNT] })
    if (url.includes('source=market')) return jsonResponse(200, { items: [] })
    return jsonResponse(200, {})
  }))
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

/** 挂载面板（真 useEffect ⇒ 真的取数、真的渲染）。 */
async function mountPanel(): Promise<void> {
  await act(async () => { root.render(<CapabilityCenterPanel onClose={() => {}} />) })
}

/** 按卡片里的标题文本取那张卡（本面板给技能卡的 className 是 `pico-skill-card`）。 */
function cardOf(name: string): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>('.pico-skill-card')]
    .find(element => (element.textContent ?? '').includes(name))
  if (card === undefined) throw new Error(`没有渲染出 ${name} 的卡片（DOM: ${container.textContent ?? ''}）`)
  return card
}

/** 卡片里"文本恰好等于某串"的叶子元素（= 徽章那种小型状态胶囊）。 */
function leafTexts(scope: HTMLElement, text: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('*')]
    .filter(element => element.children.length === 0 && (element.textContent ?? '').trim() === text)
}

const buttonTexts = (scope: HTMLElement): string[] =>
  [...scope.querySelectorAll('button')].map(button => (button.textContent ?? '').trim())

describe('R5-B-1 已下架徽章的真挂载判据（B-N2）', () => {
  it('下架行：卡片里真的渲染出「已下架」徽章 + 说明段，且没有「上传」按钮', async () => {
    await mountPanel()
    const card = cardOf('delisted-skill')
    // ① 徽章：叶子元素文本**恰好**是字典里的「已下架」。
    //    删掉 JSX 里的 `{delistedBadge}`（定义与 `t('capability.delisted')` 原样保留）
    //    之后这里必然 0 命中 —— 这正是修复方源码字符串判据漏掉的形态。
    const badge = leafTexts(card, t('capability.delisted'))
      .filter(element => element.getAttribute('data-role') === null)
    expect(badge.length).toBeGreaterThan(0)
    // ② 说明段（为什么 + 还能做什么）与徽章同源，也必须真的在 DOM 里。
    const reason = card.querySelector('[data-role="card-delisted-reason"]')
    expect(reason).not.toBeNull()
    expect(reason?.textContent).toBe(t('capability.delistedHint'))
    // ③ 动作不得再伪造「上传」：本机这一份可达的动作是「卸载」。
    expect(buttonTexts(card)).toContain(t('capability.uninstall'))
    expect(buttonTexts(card)).not.toContain(t('capability.upload'))
    expect(buttonTexts(card)).not.toContain(t('capability.install'))
  })

  it('未下架的本机行：不出徽章、不出说明段，照旧给「上传」（负向对照，判据不恒红）', async () => {
    await mountPanel()
    const card = cardOf('live-skill')
    expect(leafTexts(card, t('capability.delisted'))
      .filter(element => element.getAttribute('data-role') === null)).toHaveLength(0)
    expect(card.querySelector('[data-role="card-delisted-reason"]')).toBeNull()
    expect(buttonTexts(card)).toContain(t('capability.upload'))
  })

  it('两条行都在同一份 DOM 里（载荷真的被面板消费 —— 不是空面板碰巧没报错）', async () => {
    await mountPanel()
    const text = container.textContent ?? ''
    expect(text).toContain('delisted-skill')
    expect(text).toContain('live-skill')
    expect(calls.some(call => call.url.includes('source=local'))).toBe(true)
  })

  /**
   * R6-B-1：**证明不了归属**的行不得判已下架、不得给删除动作。
   *
   * 这一条与上面「带 `delisted:true` 的权威行」成对：前者钉"真下架的呈现没有被改弱"，
   * 这一条钉"拿未知当已知不再导致跨账号的破坏性动作"。变异：把 `isDelistedItem`
   * 第 3 条判据里的 `localOwnership === 'mine'` 去掉（= 修复前的形态）⇒ 徽章、
   * 说明段与卸载按钮三处同时出现，本用例必红。
   */
  it('同机另一账号装的商店内容（localOwnership=unknown）：不出下架徽章、不出卸载按钮', async () => {
    await mountPanel()
    const card = cardOf('other-account-skill')
    expect(leafTexts(card, t('capability.delisted'))
      .filter(element => element.getAttribute('data-role') === null)).toHaveLength(0)
    expect(card.querySelector('[data-role="card-delisted-reason"]')).toBeNull()
    expect(buttonTexts(card)).not.toContain(t('capability.uninstall'))
    // 落回「上传」：那是一个**无副作用**的动作（服务端会以名称占用拒掉）。
    expect(buttonTexts(card)).toContain(t('capability.upload'))
  })
})

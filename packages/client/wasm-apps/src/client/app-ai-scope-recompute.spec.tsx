// @vitest-environment jsdom
/**
 * `AppAiPanel` 首次授权闸门的**真挂载**判据：`scope` 在同一次挂载内变化时，
 * "有没有问过"必须**在渲染期同步重算**（R22-V1-N5）。
 *
 * ## 缺陷原形态
 *
 * `const [consented, setConsented] = useState(() => hasAppAiConsent(scope, appId, storage))`
 * 的初始化器**只跑一次**，而 `scope` 是动态 prop、生产里唯一父组件
 * `AppCenterPanel` 的 identity 是**异步**加载的（必然经历 `null → {userId, serverURL}`）。
 * 于是一次挂载内：
 *
 *  - `null → 已授权`：已授权的用户被**再问一次**（fail-safe，只是烦）；
 *  - `已授权 A → 换成 B`（另一台服务端）：**跳过说明卡直接给输入框** —— 用户发出
 *    第一条消息才吃 403，正是首次授权闸门要消灭的形态。
 *
 * ## 判据
 *
 * 真挂载（jsdom + 唯一 React 实例）驱动 `scope` 的四种变化，断言"有没有输入框"
 * 与"有没有说明卡"都随作用域走：
 *
 *  1. `null → A(已授权)` ⇒ 必须认出已授权（给输入框，不再问）；
 *  2. `A(已授权) → B(未授权)` ⇒ 必须回到说明卡（危险方向）；
 *  3. `A → B → A`（来回） ⇒ 每一次都按**当前**作用域的记录判定（不是"第一次算的那份"）；
 *  4. 同挂载内换 `appId` ⇒ 同样重算（授权键含应用维度）。
 *
 * ## 变异验证（拆掉修复必红）
 *
 * 把渲染期重算改回"只算一次"（`useState` 初始化器 + 不再重算）⇒ 第 1、2、3、4 条红
 * （第 1 条退化成"再问一次"、第 2/3/4 条退化成"跳过说明卡"）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppAiPanel } from './AppAiPanel.tsx'
import { grantAppAiConsent, type AppAiConsentStore, type AppAiScope } from './app-ai.ts'

// React 18.3 在非测试构建下要求这个全局标记才认 `act()`。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A: AppAiScope = { userId: 'alice', serverURL: 'https://a.harness.example' }
const B: AppAiScope = { userId: 'alice', serverURL: 'https://b.harness.example' }

function memoryStore(seed: Array<[string, string]> = []): AppAiConsentStore & { map: Map<string, string> } {
  const map = new Map<string, string>(seed)
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
  }
}

let container: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  container.remove()
})

const hasInput = (): boolean => container.querySelector('textarea, input[type="text"]') !== null
const hasExplainCard = (): boolean => container.textContent?.includes('允许') === true && !hasInput()

/** 用同一棵根重新渲染（模拟"同一次挂载内 prop 变化"）。 */
async function rerender(props: { appId: string, scope: AppAiScope | null, store: AppAiConsentStore }): Promise<void> {
  await act(async () => { root?.render(<AppAiPanel appId={props.appId} scope={props.scope} store={props.store} />) })
}

describe('R22-V1-N5 AppAiPanel：scope 在同一次挂载内变化必须重算"已问过"', () => {
  it('null → 已授权的 A：必须认出已授权（不许再问一次）', async () => {
    const store = memoryStore()
    grantAppAiConsent(A, 'roster', store)
    await rerender({ appId: 'roster', scope: null, store })
    expect(hasInput(), '前置：scope=null 时不给输入框').toBe(false)

    await rerender({ appId: 'roster', scope: A, store })
    expect(hasInput(), 'scope 到位后必须认出已授权（初始化器只跑一次 ⇒ 会再问一次）').toBe(true)
  })

  it('已授权的 A → 换成未授权的 B：必须回到说明卡（危险方向）', async () => {
    const store = memoryStore()
    grantAppAiConsent(A, 'roster', store)
    await rerender({ appId: 'roster', scope: A, store })
    expect(hasInput(), '前置：A 上已授权 ⇒ 直接给输入框').toBe(true)

    await rerender({ appId: 'roster', scope: B, store })
    expect(hasInput(), 'B 上没授权 ⇒ 必须回到说明卡（否则用户发首条消息才吃 403）').toBe(false)
    expect(hasExplainCard(), '说明卡必须真的渲染出来').toBe(true)
  })

  it('来回换（A 已授权 → B → A）：每一次都按**当前**作用域的记录判定', async () => {
    const store = memoryStore()
    grantAppAiConsent(A, 'roster', store)
    await rerender({ appId: 'roster', scope: A, store })
    expect(hasInput(), 'A：已授权').toBe(true)

    await rerender({ appId: 'roster', scope: B, store })
    expect(hasInput(), 'B：必须重新问').toBe(false)

    await rerender({ appId: 'roster', scope: A, store })
    expect(hasInput(), '回到 A：又必须认出已授权（不是"冻结在 B 的判断上"）').toBe(true)
  })

  it('同挂载内换 appId：授权键含应用维度，同样必须重算', async () => {
    const store = memoryStore()
    grantAppAiConsent(A, 'roster', store)
    await rerender({ appId: 'roster', scope: A, store })
    expect(hasInput(), '前置：roster 上已授权').toBe(true)

    await rerender({ appId: 'ledger', scope: A, store })
    expect(hasInput(), '另一个应用没授权 ⇒ 必须回到说明卡').toBe(false)
  })
})

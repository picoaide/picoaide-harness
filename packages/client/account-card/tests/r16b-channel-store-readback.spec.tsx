// @vitest-environment jsdom
/**
 * R16B-06 回归判据（2026-09-25，第十六轮审计泳道 B，P2）。
 *
 * ## 缺陷
 *
 * `useChannel()` 的初值在 **render 期**取（`useState(current)`），监听装在
 * **passive effect** 里 —— 中间隔着整个 commit（同一次提交里其它组件的 layout
 * effect 都会先跑）。落在这个窗口里的 `set()`（Host 推送 / 随包品牌播种）没有
 * 任何监听者 ⇒ 组件**永远**停在旧值，直到下一次 `set()` 才追上：渠道内容变了而
 * 品牌名、hero 文案一直是旧的，且没有任何报错。
 *
 * ## 怎么把那个窗口做成确定性判据
 *
 * React 保证**同一次提交里所有 layout effect 都早于任何 passive effect**。于是：
 *  1. 探针组件在 render 期读到旧值；
 *  2. 兄弟组件的 `useLayoutEffect` 在探针的 passive effect **之前**把 store 换成
 *     新值（= 真实世界里"提交与 passive effect 之间到货"的那一次）；
 *  3. 修复后探针的 passive effect 里那次"回读 `current`"把新值取回来。
 * 这不是人为排序：它就是 React 的提交顺序本身。另两拍覆盖"装完监听后的正常推送"
 * 与"首帧就拿到当前值"（防止把修复做成"先渲染空再补"）。
 *
 * ## 为什么这条判据住在 `@picoaide/dsh-account-card` 而不是 enterprise
 *
 * 与同目录 `capability-delisted-badge.spec.tsx` 同一取舍：enterprise（`channel-store`
 * 的归属包）的测试环境是 node，**没有** jsdom / react-dom 依赖；account-card 是唯一
 * 同时满足「已声明 `@picoaide/dsh-enterprise` 依赖边（不新增构建图边）」「自带 jsdom +
 * react-dom」「vitest 把 react/react-dom 钉到本包安装副本（跨包源码用例必须共用同一个
 * React 实例）」三条的客户端包。`channel-content.ts` 是零 import 的叶子模块，跨包
 * 源码 import 不会再牵出别的边。
 *
 * ---- 变异验证（实跑过，逐条单独一次调用）----
 *   - 去掉 passive effect 里的 `l()` 回读（回到修前形态）⇒ 用例①红（停在旧值）；
 *   - 初值改成恒 `null` ⇒ 用例①也红（连旧值都读不到，说明该用例不是恒绿）；
 *   - 去掉监听注册（只回读）⇒ 用例②红（正常推送失效）。
 */
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startChannelStore, useChannel } from '../../../host/enterprise/src/client/channel-store.ts'
import type { ChannelConfig } from '../../../host/enterprise/src/channel-content.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FIRST: ChannelConfig = { channel_id: 'example-a', client: { display_name: 'Example-A' } }
const SECOND: ChannelConfig = { channel_id: 'example-b', client: { display_name: 'Example-B' } }

let container: HTMLDivElement
let root: Root
let stopStore: () => void
/** Host 事件监听器（`pico/channel-changed`）—— 测试用它当"渠道内容变了"的入口。 */
let emitChannel: (channel: ChannelConfig | null) => void

beforeEach(() => {
  emitChannel = () => { throw new Error('the channel store did not subscribe to pico/channel-changed') }
  // 随包品牌的播种请求：本用例只关心事件路径，让播种失败（保持 store 不变）。
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
  const ctx = {
    on: (event: string, handler: (channel: ChannelConfig | null) => void) => {
      if (event === 'pico/channel-changed') emitChannel = handler
      return () => {}
    },
  }
  stopStore = startChannelStore(ctx as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  stopStore()
  emitChannel(null)
  vi.unstubAllGlobals()
})

/** 只读一个字段的探针组件：把 store 的值投影到 DOM 文本上。 */
function Probe(): React.JSX.Element {
  const channel = useChannel()
  return <span data-probe="true">{channel?.client?.display_name ?? '(none)'}</span>
}

/** 兄弟组件：在 **layout effect** 里换渠道 —— 早于探针的 passive effect。 */
function SwapDuringCommit({ to }: { to: ChannelConfig }): null {
  useLayoutEffect(() => { emitChannel(to) }, [to])
  return null
}

function probeText(): string {
  const node = container.querySelector('[data-probe="true"]')
  expect(node).not.toBeNull()
  return node!.textContent ?? ''
}

describe('R16B-06 useChannel 订阅后必须回读 current', () => {
  it('① 值在"render 读到旧值"与"passive effect 装监听"之间变化 ⇒ 必须跟上', async () => {
    await act(async () => { emitChannel(FIRST) })
    // 同一批提交里：探针 render 期读到 FIRST，兄弟组件的 layout effect 把 store 换成 SECOND。
    await act(async () => {
      root.render(<><Probe /><SwapDuringCommit to={SECOND} /></>)
    })
    expect(probeText(), '落在 commit 与 passive effect 之间的那次更新被漏掉了').toBe('Example-B')
  })

  it('② 装完监听之后的正常推送仍然生效（不是只靠回读）', async () => {
    await act(async () => { emitChannel(FIRST) })
    await act(async () => { root.render(<Probe />) })
    expect(probeText()).toBe('Example-A')

    await act(async () => { emitChannel(SECOND) })
    expect(probeText()).toBe('Example-B')
  })

  it('③ 首帧就必须拿到 store 的当前值（不是先渲染成空再补）', async () => {
    await act(async () => { emitChannel(SECOND) })
    await act(async () => { root.render(<Probe />) })
    expect(probeText()).toBe('Example-B')
  })
})

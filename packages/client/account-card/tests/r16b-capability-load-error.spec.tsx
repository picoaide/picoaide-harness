// @vitest-environment jsdom
/**
 * R16B-26 回归判据（2026-09-25，第十六轮审计泳道 B，P2，与 R16B-08 同族）。
 *
 * ## 缺陷
 *
 * 能力中心分区加载的 `catch` 把抛出的 cause **整个丢掉**：两个 fetcher 抛的都是
 * `HTTP <status>`（服务端业务信封原文优先），而渲染出去的一律是字典里的
 * 「加载失败」——401（登录态没了）/ 403（没权限）/ 404（版本没了）/ 5xx（服务端炸了）
 * 在界面上完全同形，用户不知道该怎么办，"重试"对其中一半根本没有意义。且**零日志**
 * （打包版没有可见控制台 ⇒ 支持也拿不到线索）。
 *
 * ## 现在的契约
 *
 * `catch (cause)` ⇒ 有可读 message 时：
 *   - 可见文案 = 「加载失败：HTTP <status>」（本地化 + 机器可读部分）；
 *   - `console.warn` 打一条可检索的行（`[capability] loading the <section> section failed: …`）。
 * 没有 message（形状漂移/非 Error）时保持原来那句「加载失败」。
 *
 * 为什么这条判据住在 `@picoaide/dsh-account-card`：与同目录
 * `capability-delisted-badge.spec.tsx` 同一取舍（enterprise 的测试环境是 node，
 * 没有 jsdom/react-dom；account-card 已声明该依赖边且自带 jsdom）。
 *
 * ---- 变异验证（实跑过，逐条单独一次调用）----
 *   - `catch` 退回丢 cause（`catch { … t('capability.loadError') }`）⇒ 用例①③红；
 *   - 带上文案但不打 warn ⇒ 用例②红；
 *   - 把 detail 换成固定串（不读 cause）⇒ 用例①红（拿不到状态码）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityCenterPanel } from '../../../host/enterprise/src/client/CapabilityCenterPanel.tsx'
import { setActiveLocale, t } from '../../../host/enterprise/src/client/locales.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setActiveLocale('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  warn.mockRestore()
  vi.unstubAllGlobals()
})

async function mountPanel(): Promise<void> {
  await act(async () => { root.render(<CapabilityCenterPanel onClose={() => {}} />) })
}

describe('R16B-26 分区加载失败必须保留状态码（可见文案 + 日志）', () => {
  it('① 服务端 401 ⇒ 界面上能读出 401（不是笼统的一句「加载失败」）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '缺少认证令牌' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )))
    await mountPanel()
    // 两个分区都失败 ⇒ 至少一处渲染出带状态码的文案。
    expect(container.textContent ?? '').toContain(t('capability.loadErrorDetail', { error: 'HTTP 401' }))
    expect(container.textContent ?? '').not.toContain(t('capability.loadError') + t('capability.loadErrorDetail'))
  })

  it('② 同一跳必须留下可检索的日志（打包版没有可见控制台）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    await mountPanel()
    const lines = warn.mock.calls.map(call => String(call[0]))
    expect(lines.some(line => line.includes('[capability]') && line.includes('HTTP 503'))).toBe(true)
  })

  it('③ 没有可读 message 时仍回落原来那句（不把 undefined 漏进界面）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'not-an-error' }))
    await mountPanel()
    const text = container.textContent ?? ''
    expect(text).toContain(t('capability.loadError'))
    expect(text).not.toContain('undefined')
  })
})

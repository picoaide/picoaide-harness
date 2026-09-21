/**
 * 「更多」字典：zh 是 key 源，en 必须逐 key 镜像（项目惯例，见 account-card）。
 *
 * ---- 变异验证 ----
 *   - en 少一个 key（或写成空串）⇒ 对应用例红；
 *   - `setActiveLocale('en')` 后 `t()` 不换文案 ⇒「跟随语言」红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { en, setActiveLocale, t, zh } from '../src/client/locales.ts'

afterEach(() => { setActiveLocale('zh') })

describe('foot-menu 字典', () => {
  it('en 与 zh 的 key 集合完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('没有空文案', () => {
    for (const [key, value] of Object.entries({ ...zh, ...en })) expect(value, key).not.toBe('')
  })

  it('zh 是 key 源（key 与取值一一对应，取值本身也是中文）', () => {
    expect(zh['footMenu.more']).toBe('更多')
    expect(zh['footMenu.label']).toBe('更多功能')
    expect(zh['footMenu.labelAttention']).toContain('更多功能')
    expect(zh['footMenu.attention']).toContain('AI')
  })

  it('未要求时用中文，切到 en 后立刻换英文', () => {
    expect(t('footMenu.more')).toBe('更多')
    setActiveLocale('en')
    expect(t('footMenu.more')).toBe('More')
    expect(t('footMenu.label')).toBe('More')
    expect(t('footMenu.labelAttention')).toContain('More')
    expect(t('footMenu.attention')).toBe('The AI is waiting for you')
  })

  it('区域化 locale id 按前缀判定（en-US 走英文），未知语言回落中文', () => {
    setActiveLocale('en-US')
    expect(t('footMenu.more')).toBe('More')
    setActiveLocale('zh-Hans')
    expect(t('footMenu.more')).toBe('更多')
    setActiveLocale('fr')
    expect(t('footMenu.more')).toBe('更多')
  })
})

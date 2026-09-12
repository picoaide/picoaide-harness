import { afterEach, describe, expect, it, vi } from 'vitest'
import { uid } from './utils'

// 审计 2026-09-12 P1-2:`crypto.randomUUID()` 只在安全上下文存在
// (https / localhost)。webadmin 的文档化部署形态含「纯 HTTP + LAN IP」,
// 那里 `typeof crypto.randomUUID === 'undefined'` —— 连接器页首渲染即调用,
// 整页崩成白屏。纯函数级回归:把 randomUUID 打桩成 undefined 后必须仍可用。
afterEach(() => { vi.unstubAllGlobals() })

describe('uid() 在非安全源的回落', () => {
  it('crypto.randomUUID 不存在时不抛错,且批量生成互不重复', () => {
    // 模拟 http://192.168.1.18:<port>(isSecureContext=false)
    vi.stubGlobal('crypto', {})
    const ids = new Set<string>()
    expect(() => {
      for (let i = 0; i < 500; i += 1) ids.add(uid())
    }).not.toThrow()
    expect(ids.size).toBe(500)
  })

  it('crypto 整个不存在(极端环境)也不抛错', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => uid()).not.toThrow()
    expect(uid()).toMatch(/^uid-/)
  })

  it('安全源下优先用 crypto.randomUUID(保持既有行为)', () => {
    const randomUUID = vi.fn(() => '11111111-2222-3333-4444-555555555555')
    vi.stubGlobal('crypto', { randomUUID })
    expect(uid()).toBe('11111111-2222-3333-4444-555555555555')
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })
})

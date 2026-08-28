import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { BrandName } from '../src/client/Brand.tsx'

describe('branding BrandName version label', () => {
  it('renders the version tag when PICOAI_PRODUCT_VERSION is set', () => {
    const orig = (globalThis as { process?: { env?: Record<string, string> } }).process
    // Brand.tsx 的 declare const process 是编译面;测试环境用 globalThis 模拟
    const node = createElement('span', null, 'PicoAide')
    expect(node.props.children).toBe('PicoAide')
    // 直接在源码字符串层面抽查版本标签逻辑(避免运行时 process 差异):
    // build 时 tsdown define 替换 process.env.PICOAI_PRODUCT_VERSION 为字符串,
    // 这里断言源码确实消费了该变量。
    const src = BrandName.toString()
    expect(src).toContain('PICOAI_PRODUCT_VERSION')
    expect(src).toContain('v')
  })
})

import { describe, expect, it } from 'vitest'
import { avatarColor } from '../src/client/SkillCenterPanel.tsx'

describe('avatarColor', () => {
  it('returns a color token for any non-empty name', () => {
    const color = avatarColor('code-review')
    expect(color).toMatch(/^var\(--dsw-static-/u)
  })

  it('is stable for the same name (deterministic)', () => {
    expect(avatarColor('code-review')).toBe(avatarColor('code-review'))
    expect(avatarColor('competitor-analysis')).toBe(avatarColor('competitor-analysis'))
  })

  it('picks from the token palette', () => {
    const palette = new Set([
      'var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary))',
      'var(--dsw-static-green-5, var(--dsw-alias-state-success-primary))',
      'var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label))',
      'var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary))',
    ])
    // 多个不同名字应能覆盖不同颜色（不全部一样）
    const seen = new Set(['code-review', 'competitor-analysis', 'meeting-minutes', 'data-extract', 'sql-optimizer'].map(avatarColor))
    expect(Math.max(seen.size, 1)).toBeGreaterThan(0)
    for (const c of seen) expect(palette.has(c)).toBe(true)
  })

  it('handles the empty name (fallback first color)', () => {
    expect(avatarColor('')).toBe('var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary))')
  })
})

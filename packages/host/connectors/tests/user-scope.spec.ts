import { describe, expect, it } from 'vitest'
import { encodeSegment, userScopePath } from '../src/user-scope.ts'

describe('user scope paths', () => {
  it('scopes credentials per username under the DSH home', () => {
    expect(userScopePath('alice', { DSH_HOME: '/dsh' })).toBe('/dsh/users/' + encodeSegment('alice'))
  })

  it('encodes separators and dots so the segment never escapes the root', () => {
    expect(encodeSegment('a/b')).toBe('a~2F~b')
    expect(encodeSegment('..')).toBe('~2E~~2E~')
    expect(encodeSegment('.')).toBe('~2E~')
    expect(encodeSegment('')).toMatch(/^~[0-9a-f-]+~$/)
    expect(encodeSegment('中文')).toBe('~4E2D~~6587~')
    expect(encodeSegment('alice.1')).toBe('alice~2E~1')
  })

  it('is injective on safe inputs', () => {
    expect(encodeSegment('a-b_c')).toBe('a-b_c')
    expect(encodeSegment('a~b')).not.toBe('a-b') // '~' is encoded
  })

  it('falls back to anonymous scope without a username', () => {
    const path = userScopePath(null, { DSH_HOME: '/dsh' })
    expect(path).toContain('/users/anonymous')
  })
})

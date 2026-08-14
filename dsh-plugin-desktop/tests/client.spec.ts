import { describe, expect, it } from 'vitest'
import { desktopPlatformFromUrl } from '../src/client.ts'

describe('desktop renderer marker', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('accepts %s', (platform) => {
    expect(desktopPlatformFromUrl(`http://127.0.0.1:3000/?dsh-desktop-platform=${platform}`)).toBe(platform)
  })

  it('rejects an absent or unsupported marker', () => {
    expect(desktopPlatformFromUrl('http://127.0.0.1:3000/')).toBeUndefined()
    expect(desktopPlatformFromUrl('http://127.0.0.1:3000/?dsh-desktop-platform=freebsd')).toBeUndefined()
  })
})

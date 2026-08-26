import { describe, expect, it } from 'vitest'
import { CLI_MANIFESTS, resolveDshHome, dwsEnv } from '@picoaide/dsh-cli-tools'

describe('cli-skill-bridge: manifest + home', () => {
  it('CLI_MANIFESTS exposes the supported commands', () => {
    const names = [...CLI_MANIFESTS.keys()]
    expect(names).toContain('dws')
    expect(names).toContain('wecom-cli')
    expect(names).toContain('lark-cli')
    expect(names).toContain('beisen-cli')
  })

  it('resolves product home (DSH_HOME first, ~/.picoaide-harness default)', () => {
    expect(resolveDshHome({ DSH_HOME: '/x' })).toBe('/x')
    const home = resolveDshHome({})
    expect(home).toMatch(/\.picoaide-harness$/)
    expect(home).not.toMatch(/\.dsh$/)
  })

  it('dwsEnv points config+keychain at product home', () => {
    const env = dwsEnv({ DSH_HOME: '/custom' })
    expect(env.DWS_CONFIG_DIR).toBe('/custom')
    expect(env.DWS_KEYCHAIN_DIR).toBe('/custom/dws/keychain')
  })
})

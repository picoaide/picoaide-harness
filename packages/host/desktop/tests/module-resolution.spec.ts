import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { installProfilePackageResolver } from '../src/module-resolution.ts'

/** A profile whose flat node_modules cannot see any in-box package (the
 * packaged asar layout: its symlinks point into app.asar, which the CJS
 * resolver cannot traverse — the equivalent of "no node_modules here"). */
function profileWithoutPackages(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-resolver-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe-profile', private: true }) + '\n')
  return dir
}

const disposers: Array<() => void> = []
const tempDirs: string[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const KNOWN_BUNDLE = '@deepseek-ai/dsh-client-modules/package.json'

describe('installProfilePackageResolver (CJS fallback)', () => {
  it('resolves in-box packages from the desktop tree when the profile walk fails', () => {
    const profile = profileWithoutPackages()
    tempDirs.push(profile)
    const baseUrl = pathToFileURL(join(profile, 'package.json')).href
    const cjs = createRequire(baseUrl)
    // Without the resolver the profile cannot see the package (simulating the
    // packaged layout where the only link is a symlink into app.asar).
    expect(() => cjs.resolve(KNOWN_BUNDLE)).toThrow('Cannot find module')
    disposers.push(installProfilePackageResolver(baseUrl))
    const resolved = cjs.resolve(KNOWN_BUNDLE)
    expect(resolved).toMatch(/dsh-client-modules[\\/]package\.json$/u)
  })

  it('still throws MODULE_NOT_FOUND for unknown bare packages', () => {
    const profile = profileWithoutPackages()
    tempDirs.push(profile)
    const baseUrl = pathToFileURL(join(profile, 'package.json')).href
    disposers.push(installProfilePackageResolver(baseUrl))
    const cjs = createRequire(baseUrl)
    expect(() => cjs.resolve('@deepseek-ai/dsh-no-such-package/package.json')).toThrow('Cannot find module')
  })

  it('restores the original resolver after disposal', () => {
    const profile = profileWithoutPackages()
    tempDirs.push(profile)
    const baseUrl = pathToFileURL(join(profile, 'package.json')).href
    const cjs = createRequire(baseUrl)
    const dispose = installProfilePackageResolver(baseUrl)
    disposers.push(dispose)
    expect(() => cjs.resolve(KNOWN_BUNDLE)).not.toThrow()
    dispose()
    expect(() => cjs.resolve(KNOWN_BUNDLE)).toThrow('Cannot find module')
  })
})

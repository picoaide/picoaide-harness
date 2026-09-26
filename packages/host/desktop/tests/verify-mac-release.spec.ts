import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  verifyMacRelease,
  type MacReleaseVerificationOptions,
} from '../scripts/verify-mac-release.ts'
import { MACOS_ARM64_NATIVE_ENTRIES } from '../scripts/mac-runtime.ts'
import { writeValidMacBundle } from './helpers/mac-bundle-fixture.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function options(overrides: Partial<MacReleaseVerificationOptions> = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const removeMountPoint = vi.fn()
  const value: MacReleaseVerificationOptions = {
    distDir: '/release/dist',
    productName: 'PicoAide Harness',
    listDmgs: () => ['/release/dist/PicoAide Harness-2.0.0-arm64.dmg'],
    makeMountPoint: () => '/private/tmp/dsh-desktop-dmg-test',
    run: (command, args) => { calls.push({ command, args: [...args] }) },
    removeMountPoint,
    ...overrides,
  }
  return { calls, removeMountPoint, value }
}

describe('macOS release artifact verification', () => {
  it('mounts one DMG and verifies signature, Gatekeeper, and the stapled ticket', () => {
    const harness = options()
    const appPath = join('/private/tmp/dsh-desktop-dmg-test', 'PicoAide Harness.app')

    expect(verifyMacRelease(harness.value)).toEqual({
      appPath: '/private/tmp/dsh-desktop-dmg-test/PicoAide Harness.app',
      dmgPath: '/release/dist/PicoAide Harness-2.0.0-arm64.dmg',
    })

    expect(harness.calls).toEqual([
      {
        command: 'hdiutil',
        args: [
          'attach', '/release/dist/PicoAide Harness-2.0.0-arm64.dmg',
          '-mountpoint', '/private/tmp/dsh-desktop-dmg-test', '-nobrowse', '-readonly',
        ],
      },
      {
        command: 'lipo',
        args: [join(appPath, 'Contents', 'MacOS', 'PicoAide Harness'), '-verify_arch', 'arm64'],
      },
      ...MACOS_ARM64_NATIVE_ENTRIES.map(entry => ({
        command: 'lipo',
        args: [
          join(appPath, 'Contents', 'Resources', 'app', entry.path),
          '-verify_arch', entry.arch,
        ],
      })),
      {
        command: 'codesign',
        args: ['--verify', '--deep', '--strict', '--verbose=2', '/private/tmp/dsh-desktop-dmg-test/PicoAide Harness.app'],
      },
      {
        command: 'spctl',
        args: ['--assess', '--type', 'execute', '--verbose=4', '/private/tmp/dsh-desktop-dmg-test/PicoAide Harness.app'],
      },
      {
        command: 'xcrun',
        args: ['stapler', 'validate', '/private/tmp/dsh-desktop-dmg-test/PicoAide Harness.app'],
      },
      {
        command: 'hdiutil',
        args: ['detach', '/private/tmp/dsh-desktop-dmg-test'],
      },
    ])
    expect(harness.removeMountPoint).toHaveBeenCalledWith('/private/tmp/dsh-desktop-dmg-test')
  })

  it('rejects absent or ambiguous release images before mounting', () => {
    for (const dmgs of [[], ['/one.dmg', '/two.dmg']]) {
      const harness = options({ listDmgs: () => dmgs })
      expect(() => verifyMacRelease(harness.value)).toThrow(`found ${String(dmgs.length)}`)
      expect(harness.calls).toEqual([])
    }
  })

  it('detaches the image and preserves verification and cleanup failures', () => {
    const verifyFailure = new Error('Gatekeeper rejected the app')
    const detachFailure = new Error('detach failed')
    const harness = options({
      run: (command, args) => {
        harness.calls.push({ command, args: [...args] })
        if (command === 'spctl') throw verifyFailure
        if (command === 'hdiutil' && args[0] === 'detach') throw detachFailure
      },
    })

    let caught: unknown
    try {
      verifyMacRelease(harness.value)
    } catch (cause) {
      caught = cause
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([verifyFailure, detachFailure])
    expect(harness.removeMountPoint).toHaveBeenCalledOnce()
  })

  // 签名/Gatekeeper/票据全过之后，包内一致性判据仍必须在**真实挂载点形态**下跑到
  // （2026-09-25：macOS「图标变问号 + 打不开」的现场反馈里，前三条命令都可能全绿）。
  it('accepts a real, self-consistent bundle on a real mount point', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-release-'))
    temporaryRoots.push(root)
    writeValidMacBundle(join(root, 'PicoAide Harness.app'), 'PicoAide Harness')
    const harness = options({ makeMountPoint: () => root })
    expect(verifyMacRelease(harness.value).appPath).toBe(join(root, 'PicoAide Harness.app'))
  })

  it('rejects a real bundle whose declared icon is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-release-'))
    temporaryRoots.push(root)
    writeValidMacBundle(join(root, 'PicoAide Harness.app'), 'PicoAide Harness')
    rmSync(join(root, 'PicoAide Harness.app', 'Contents', 'Resources', 'icon.icns'))
    const harness = options({ makeMountPoint: () => root })

    let caught: unknown
    try {
      verifyMacRelease(harness.value)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors
      .map(inner => (inner instanceof Error ? inner.message : String(inner)))
      .join('\n')).toContain('CFBundleIconFile=icon.icns')
  })

  // 产物身份（B1-02）：签名/公证/Gatekeeper 全绿也不代表包声称的身份是本次构建声明的那个。
  // 变异：发布路径的调用点退回 `assertMacBundleConsistency(appPath)` ⇒ 本用例红。
  it('rejects a real bundle whose CFBundleIdentifier is not the identity this build declares', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-release-'))
    temporaryRoots.push(root)
    writeValidMacBundle(join(root, 'PicoAide Harness.app'), 'PicoAide Harness', {
      identifier: 'com.example-vendor.other',
    })
    const harness = options({ makeMountPoint: () => root })

    let caught: unknown
    try {
      verifyMacRelease(harness.value)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors
      .map(inner => (inner instanceof Error ? inner.message : String(inner)))
      .join('\n')).toContain('but this build declares')
  })
})

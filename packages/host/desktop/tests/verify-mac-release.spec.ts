import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertBundledRuntimesSigned,
  verifyMacRelease,
  type MacReleaseVerificationOptions,
} from '../scripts/verify-mac-release.ts'
import { MACOS_ARM64_NATIVE_ENTRIES } from '../scripts/mac-runtime.ts'
import {
  MAC_BUNDLE_FIXTURE_IDENTIFIER,
  MAC_BUNDLE_RUNTIME_VERSIONS,
  writeBundledRuntimesFixture,
  writeValidMacBundle,
  type BundledRuntimesFixtureOptions,
  type MacBundleFixtureOptions,
} from './helpers/mac-bundle-fixture.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 造一个"真挂载点"：自洽的 `.app` **加上**随包运行时载荷（发布判据要求两者同时在场）。 */
function writeReleaseBundle(
  root: string,
  bundle: MacBundleFixtureOptions = {},
  runtimes: BundledRuntimesFixtureOptions = {},
): string {
  const appPath = join(root, 'PicoAide Harness.app')
  writeValidMacBundle(appPath, 'PicoAide Harness', bundle)
  writeBundledRuntimesFixture(appPath, runtimes)
  return appPath
}

function options(overrides: Partial<MacReleaseVerificationOptions> = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const captures: Array<{ command: string; args: readonly string[] }> = []
  const removeMountPoint = vi.fn()
  const value: MacReleaseVerificationOptions = {
    distDir: '/release/dist',
    productName: 'PicoAide Harness',
    // 期望身份**显式注入**（B-3）：缺省实现会去读工作树里那份 gitignored 的
    // `build/channel.json`，一次渠道构建残留就让本文件红，且被说成"产物声称了另一个身份"。
    expectedIdentifier: MAC_BUNDLE_FIXTURE_IDENTIFIER,
    listDmgs: () => ['/release/dist/PicoAide Harness-2.0.0-arm64.dmg'],
    makeMountPoint: () => '/private/tmp/dsh-desktop-dmg-test',
    run: (command, args) => { calls.push({ command, args: [...args] }) },
    // 随包运行时的版本判据**真的执行**三个 shim：夹具里是假字节，所以这里按 shim 名
    // 回答（真实 spawn 既慢又要求夹具可执行）。判据的错配分支另有专门用例。
    capture: (command, args) => {
      captures.push({ command, args: [...args] })
      const name = basename(command)
      if (name === 'python3') return `Python ${MAC_BUNDLE_RUNTIME_VERSIONS.python}`
      if (name === 'pnpm') return MAC_BUNDLE_RUNTIME_VERSIONS.pnpm
      return `v${MAC_BUNDLE_RUNTIME_VERSIONS.node}`
    },
    removeMountPoint,
    ...overrides,
  }
  return { calls, captures, removeMountPoint, value }
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
    writeReleaseBundle(root)
    const harness = options({ makeMountPoint: () => root })
    expect(verifyMacRelease(harness.value).appPath).toBe(join(root, 'PicoAide Harness.app'))
  })

  // 随包运行时（2026-10-08）：`codesign --verify --deep --strict` 不保证 `Contents/Resources`
  // 下的嵌套 Mach-O 被重签过、更不保证它们真能执行 —— 所以发布路径必须**逐个验签**并
  // **真跑一次**三个入口。变异：删掉 `verify-mac-release.ts` 里那一行调用 ⇒ 本用例红。
  it('codesigns every bundled runtime entry and really runs the three shims', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-release-'))
    temporaryRoots.push(root)
    const appPath = writeReleaseBundle(root)
    const harness = options({ makeMountPoint: () => root })
    verifyMacRelease(harness.value)

    const runtimeRoot = join(appPath, 'Contents', 'Resources', 'runtimes')
    for (const relative of ['node/bin/node', 'pnpm/bin/pnpm.mjs', 'python/bin/python3']) {
      expect(harness.calls).toContainEqual({
        command: 'codesign',
        args: ['--verify', '--strict', '--verbose=2', join(runtimeRoot, relative)],
      })
    }
    expect(harness.captures).toEqual([
      { command: join(runtimeRoot, 'bin', 'node'), args: ['-v'] },
      { command: join(runtimeRoot, 'bin', 'pnpm'), args: ['-v'] },
      { command: join(runtimeRoot, 'bin', 'python3'), args: ['-V'] },
    ])
  })

  // 版本不符 = 载荷与清单不是一份东西（复制错平台目录、缓存串味）。变异：把版本比对
  // 换成"只要跑起来就算过" ⇒ 本用例红。
  it('rejects a bundled runtime whose version is not the one the payload pins', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-release-'))
    temporaryRoots.push(root)
    writeReleaseBundle(root)
    const harness = options({
      makeMountPoint: () => root,
      capture: () => 'v24.20.0',
    })

    // 挂载期失败会被聚合成 AggregateError（消息只有 DMG 名），判据文案在 errors 里。
    let caught: unknown
    try {
      verifyMacRelease(harness.value)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors
      .map(inner => (inner instanceof Error ? inner.message : String(inner)))
      .join('\n')).toContain('the payload pins v24.21.0')
  })

  it('rejects a real bundle whose declared icon is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-release-'))
    temporaryRoots.push(root)
    const appPath = writeReleaseBundle(root)
    rmSync(join(appPath, 'Contents', 'Resources', 'icon.icns'))
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

  // 产物身份（B1-02/B-3）：签名/公证/Gatekeeper 全绿也不代表包声称的身份是本次构建声明的那个。
  // 变异：发布路径的调用点退回 `assertMacBundleConsistency(appPath)`、或退回内联
  // `packagedAppId()`（= 忽略注入项、去读工作树）⇒ 本用例红。
  it('rejects a real bundle whose CFBundleIdentifier is not the identity this build declares', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-release-'))
    temporaryRoots.push(root)
    writeReleaseBundle(root, { identifier: 'com.example-vendor.other' })
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

  it('期望身份是注入项：注入值与产物不同即红（可注入性判据，B-3）', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-release-'))
    temporaryRoots.push(root)
    writeReleaseBundle(root)
    const harness = options({
      makeMountPoint: () => root,
      expectedIdentifier: 'com.example-vendor.harness',
    })

    let caught: unknown
    try {
      verifyMacRelease(harness.value)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors
      .map(inner => (inner instanceof Error ? inner.message : String(inner)))
      .join('\n')).toContain('but this build declares com.example-vendor.harness')
  })
})

describe('bundled agent runtimes are signed into the release bundle', () => {
  /** 建一个只带运行时载荷的包（判据只需要 `Contents/Resources/runtimes`）。 */
  function runtimeApp(runtimes: BundledRuntimesFixtureOptions = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mac-runtimes-'))
    temporaryRoots.push(root)
    const appPath = join(root, 'PicoAide Harness.app')
    writeBundledRuntimesFixture(appPath, runtimes)
    return appPath
  }

  function signed(appPath: string, capture?: (command: string, args: readonly string[]) => string) {
    const runs: Array<{ command: string; args: readonly string[] }> = []
    const captureSpy = vi.fn(capture ?? (() => `v${MAC_BUNDLE_RUNTIME_VERSIONS.node}`))
    assertBundledRuntimesSigned(
      appPath,
      (command, args) => { runs.push({ command, args: [...args] }) },
      captureSpy,
    )
    return { runs, captureSpy }
  }

  it('验证三个入口并按清单版本真跑三个 shim', () => {
    const appPath = runtimeApp()
    const runtimeRoot = join(appPath, 'Contents', 'Resources', 'runtimes')
    const { runs, captureSpy } = signed(appPath, (command) => {
      const name = basename(command)
      if (name === 'python3') return `Python ${MAC_BUNDLE_RUNTIME_VERSIONS.python}`
      if (name === 'pnpm') return MAC_BUNDLE_RUNTIME_VERSIONS.pnpm
      return `v${MAC_BUNDLE_RUNTIME_VERSIONS.node}`
    })

    expect(runs).toEqual([
      { command: 'codesign', args: ['--verify', '--strict', '--verbose=2', join(runtimeRoot, 'node', 'bin', 'node')] },
      { command: 'codesign', args: ['--verify', '--strict', '--verbose=2', join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs')] },
      { command: 'codesign', args: ['--verify', '--strict', '--verbose=2', join(runtimeRoot, 'python', 'bin', 'python3')] },
    ])
    expect(captureSpy.mock.calls).toEqual([
      [join(runtimeRoot, 'bin', 'node'), ['-v']],
      [join(runtimeRoot, 'bin', 'pnpm'), ['-v']],
      [join(runtimeRoot, 'bin', 'python3'), ['-V']],
    ])
  })

  it('载荷清单缺失即红（构建声明了运行时就必须随包）', () => {
    expect(() => signed(runtimeApp({ omitManifest: true })))
      .toThrow(/but the application carries none/)
  })

  it('脚本入口（真载荷里的 pnpm.mjs）不做独立验签，但仍要真跑（2026-10-08 tag 的假红）', () => {
    // 真载荷：node / python3 是 Mach-O（必须 Developer ID 重签），pnpm 是**脚本**。
    // `codesign --verify --strict pnpm.mjs` ⇒ "code object is not signed at all" ⇒
    // v2.8.3-beta.1 的 macOS job 在发布校验处退 1。修法=按魔数分流：脚本不送验签，
    // 但它的可运行性由 shim 真跑兜住 —— 这一条同时钉住两侧（少验签 vs 少跑）。
    const appPath = runtimeApp({ entryKinds: { pnpm: 'script' } })
    const runtimeRoot = join(appPath, 'Contents', 'Resources', 'runtimes')
    const { runs, captureSpy } = signed(appPath, (command) => {
      const name = basename(command)
      if (name === 'python3') return `Python ${MAC_BUNDLE_RUNTIME_VERSIONS.python}`
      if (name === 'pnpm') return MAC_BUNDLE_RUNTIME_VERSIONS.pnpm
      return `v${MAC_BUNDLE_RUNTIME_VERSIONS.node}`
    })

    expect(runs).toEqual([
      { command: 'codesign', args: ['--verify', '--strict', '--verbose=2', join(runtimeRoot, 'node', 'bin', 'node')] },
      { command: 'codesign', args: ['--verify', '--strict', '--verbose=2', join(runtimeRoot, 'python', 'bin', 'python3')] },
    ])
    expect(captureSpy.mock.calls).toEqual([
      [join(runtimeRoot, 'bin', 'node'), ['-v']],
      [join(runtimeRoot, 'bin', 'pnpm'), ['-v']],
      [join(runtimeRoot, 'bin', 'python3'), ['-V']],
    ])
  })

  it('三个入口都是 Mach-O 时逐个验签（脚本跳过不得把 Mach-O 一起放过）', () => {
    // 与上一条成对：同一个函数，只有魔数不同 —— 三条验签 vs 两条验签。把 Mach-O 一起
    // 跳过（例如"凡 `.mjs`/脚本判据写反"）会让这条红。
    const appPath = runtimeApp()
    const runtimeRoot = join(appPath, 'Contents', 'Resources', 'runtimes')
    const { runs } = signed(appPath, (command) => {
      const name = basename(command)
      if (name === 'python3') return `Python ${MAC_BUNDLE_RUNTIME_VERSIONS.python}`
      if (name === 'pnpm') return MAC_BUNDLE_RUNTIME_VERSIONS.pnpm
      return `v${MAC_BUNDLE_RUNTIME_VERSIONS.node}`
    })
    expect(runs.map(entry => entry.args[entry.args.length - 1])).toEqual([
      join(runtimeRoot, 'node', 'bin', 'node'),
      join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs'),
      join(runtimeRoot, 'python', 'bin', 'python3'),
    ])
  })

  it('清单 schema 不认即红', () => {
    expect(() => signed(runtimeApp({ schema: 2 }))).toThrow(/declares schema 2/)
  })

  it('清单声明的命令数不是 3 即红', () => {
    expect(() => signed(runtimeApp({ commandCount: 2 }))).toThrow(/declares 2 runtime commands, expected 3/)
  })

  it('入口载荷不在即红（且点名是哪一个）', () => {
    expect(() => signed(runtimeApp({ omitEntry: 'python3' })))
      .toThrow(/bundled runtime python3 is missing at/)
  })

  it('shim 不在即红', () => {
    expect(() => signed(runtimeApp({ omitShim: 'pnpm' })))
      .toThrow(/bundled runtime shim .*bin\/pnpm is missing/)
  })

  it('版本与清单不符即红', () => {
    expect(() => signed(runtimeApp(), () => 'not-a-version'))
      .toThrow(/bundled node reported "not-a-version"/)
  })
})

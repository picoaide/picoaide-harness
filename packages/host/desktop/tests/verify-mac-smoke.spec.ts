import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  verifyMacSmoke,
  type MacSmokeVerificationOptions,
} from '../scripts/verify-mac-smoke.ts'
import { MACOS_ARM64_NATIVE_ENTRIES } from '../scripts/mac-runtime.ts'
import { MAC_BUNDLE_FIXTURE_IDENTIFIER, minimalAsar, writeValidMacBundle } from './helpers/mac-bundle-fixture.ts'

const temporaryRoots: string[] = []

interface AppFixture {
  readonly root: string
  readonly infoPlist: string
  readonly executable: string
  readonly appAsar: string
  readonly modeOverrides: Map<string, number>
}

function fixture(overrides: { readonly identifier?: string } = {}): AppFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-smoke-'))
  temporaryRoots.push(root)
  const contents = join(root, 'PicoAide Harness.app', 'Contents')
  const macos = join(contents, 'MacOS')
  const resources = join(contents, 'Resources')
  const infoPlist = join(contents, 'Info.plist')
  const executable = join(macos, 'PicoAide Harness')
  const appAsar = join(resources, 'app.asar')
  const modeOverrides = new Map<string, number>()
  // 包内一致性判据要求图标键指向真实 icns、且 ElectronAsarIntegrity 与 asar 头部一致，
  // 所以夹具用共享的 mac-bundle-fixture 写一份自洽的最小包。`identifier` 缺省 = 官方
  // 身份（= 未做渠道构建时 `packagedAppId()` 的取值），传别的值用于身份判据的反向用例。
  writeValidMacBundle(join(root, 'PicoAide Harness.app'), 'PicoAide Harness', overrides)
  modeOverrides.set(executable, 0o755)
  for (const entry of MACOS_ARM64_NATIVE_ENTRIES) {
    const path = join(`${appAsar}.unpacked`, entry.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'native')
    if (entry.path.endsWith('/spawn-helper')) {
      chmodSync(path, 0o755)
      modeOverrides.set(path, 0o755)
    }
  }
  return { root, infoPlist, executable, appAsar, modeOverrides }
}

function options(
  overrides: Partial<MacSmokeVerificationOptions> = {},
  modeOverrides: ReadonlyMap<string, number> = new Map(),
) {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const removeMountPoint = vi.fn()
  const value: MacSmokeVerificationOptions = {
    distDir: '/release/dist',
    productName: 'PicoAide Harness',
    // 期望身份**显式注入**（B-3）：不注入时缺省会去读工作树里那份 gitignored 的
    // `build/channel.json`，一次渠道构建残留就让本文件红一片，且被说成"产物声称了另一个
    // 身份"。取值就是夹具写入的缺省身份，所以正向用例仍然自洽。
    expectedIdentifier: MAC_BUNDLE_FIXTURE_IDENTIFIER,
    listDmgs: () => ['/release/dist/PicoAide Harness-2.0.1.dmg'],
    makeMountPoint: () => '/private/tmp/dsh-desktop-dmg-smoke-test',
    run: (command, args) => { calls.push({ command, args: [...args] }) },
    removeMountPoint,
    exists: existsSync,
    stat: path => {
      const result = statSync(path)
      return {
        size: result.size,
        isFile: result.isFile(),
        mode: modeOverrides.get(path) ?? result.mode,
      }
    },
    ...overrides,
  }
  return { calls, removeMountPoint, value }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function expectSmokeFailure(
  harness: ReturnType<typeof options>,
  expectedDetail: string,
): void {
  let caught: unknown
  try {
    verifyMacSmoke(harness.value)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AggregateError)
  const details = (caught as AggregateError).errors
    .map(inner => (inner instanceof Error ? inner.message : String(inner)))
  expect(details.join('\n')).toContain(expectedDetail)
}

describe('macOS DMG smoke artifact verification', () => {
  it('mounts one DMG and accepts a well-formed unsigned application bundle', () => {
    const value = fixture()
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)
    const appPath = join(value.root, 'PicoAide Harness.app')

    expect(verifyMacSmoke(harness.value)).toEqual({
      appPath,
      dmgPath: '/release/dist/PicoAide Harness-2.0.1.dmg',
    })

    expect(harness.calls).toEqual([
      {
        command: 'hdiutil',
        args: [
          'attach', '/release/dist/PicoAide Harness-2.0.1.dmg',
          '-mountpoint', value.root, '-nobrowse', '-readonly',
        ],
      },
      { command: 'plutil', args: ['-lint', value.infoPlist] },
      { command: 'lipo', args: [value.executable, '-verify_arch', 'arm64'] },
      ...MACOS_ARM64_NATIVE_ENTRIES.map(entry => ({
        command: 'lipo',
        args: [join(`${value.appAsar}.unpacked`, entry.path), '-verify_arch', entry.arch],
      })),
      { command: 'hdiutil', args: ['detach', value.root] },
    ])
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects the mount when no DMG is present', () => {
    const harness = options({ listDmgs: () => [] })

    expect(() => verifyMacSmoke(harness.value)).toThrow('requires exactly one DMG')
    expect(harness.calls).toEqual([])
    expect(harness.removeMountPoint).not.toHaveBeenCalled()
  })

  it('rejects a missing Info.plist and still detaches', () => {
    const value = fixture()
    rmSync(value.infoPlist)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'Info.plist')
    expect(harness.calls).toEqual([
      {
        command: 'hdiutil',
        args: ['attach', '/release/dist/PicoAide Harness-2.0.1.dmg', '-mountpoint', value.root, '-nobrowse', '-readonly'],
      },
      { command: 'hdiutil', args: ['detach', value.root] },
    ])
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects an application without its declared main executable', () => {
    const value = fixture()
    rmSync(value.executable)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'main executable')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects a non-executable main file', () => {
    const value = fixture()
    chmodSync(value.executable, 0o644)
    value.modeOverrides.set(value.executable, 0o644)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'invalid main executable')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects a missing or empty application archive', () => {
    const value = fixture()
    rmSync(value.appAsar)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'app.asar')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects a bundle whose declared icon is not inside Resources', () => {
    const value = fixture()
    rmSync(join(value.infoPlist, '..', 'Resources', 'icon.icns'))
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'CFBundleIconFile=icon.icns')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects a bundle whose CFBundleIdentifier is not the identity this build declares', () => {
    // 产物身份（B1-02/B-3）：冒烟判据把**注入的**期望身份传进包内一致性判据。
    // 变异：调用点退回 `assertMacBundleConsistency(appPath)`、或退回内联
    // `packagedAppId()`（= 忽略注入项、去读工作树）⇒ 本用例红。
    const value = fixture({ identifier: 'com.example-vendor.other' })
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'but this build declares')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('期望身份是注入项：注入"本次构建声明的身份"以外的值必须红（可注入性判据）', () => {
    // 反向：夹具写的是官方身份，而注入项说本次构建声明的是另一个 ⇒ 必须红。
    // 这条同时钉住"注入项真的被用上了"，而不是被函数体里的 `packagedAppId()` 覆盖。
    const value = fixture()
    const harness = options({
      makeMountPoint: () => value.root,
      expectedIdentifier: 'com.example-vendor.harness',
    }, value.modeOverrides)

    expectSmokeFailure(harness, 'but this build declares com.example-vendor.harness')
  })

  it('把 asar 布局摘要写进日志，链接条目数在其中可见（B-5）', () => {
    // `linkEntries` 的存在理由是"这份归档里有链接、判据没有建模它的字节账"**在日志里可见**，
    // 而三处调用点此前都丢弃了返回值（只在测试里可见）。这里在真实调用点上断言那行日志。
    // 变异：删掉调用点的 console.log ⇒ 本用例红。
    const value = fixtureWithLinkedAsar()
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      verifyMacSmoke(harness.value)
      const lines = logged.mock.calls.map(call => String(call[0]))
      const layout = lines.filter(line => line.includes('mac bundle asar layout'))
      expect(layout, '冒烟验证必须把 asar 布局摘要打进日志').toHaveLength(1)
      expect(layout[0]).toContain('1 link')
      expect(layout[0]).toContain(value.appAsar)
    } finally {
      logged.mockRestore()
    }
  })
})

/** 带一条**可解**符号链接（`link → package.json`）的 `.app` 夹具。 */
function fixtureWithLinkedAsar(): AppFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-smoke-linked-'))
  temporaryRoots.push(root)
  const appPath = join(root, 'PicoAide Harness.app')
  writeValidMacBundle(appPath, 'PicoAide Harness', {
    asar: minimalAsar(Buffer.from('{}'), { links: [['link', 'package.json']] }),
  })
  const contents = join(appPath, 'Contents')
  const executable = join(contents, 'MacOS', 'PicoAide Harness')
  const appAsar = join(contents, 'Resources', 'app.asar')
  const modeOverrides = new Map<string, number>()
  modeOverrides.set(executable, 0o755)
  for (const entry of MACOS_ARM64_NATIVE_ENTRIES) {
    const path = join(`${appAsar}.unpacked`, entry.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'native')
    if (entry.path.endsWith('/spawn-helper')) {
      chmodSync(path, 0o755)
      modeOverrides.set(path, 0o755)
    }
  }
  return {
    root,
    infoPlist: join(contents, 'Info.plist'),
    executable,
    appAsar,
    modeOverrides,
  }
}

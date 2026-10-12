/**
 * macOS 原地自更新的纯逻辑判据。
 *
 * 覆盖三件事：
 * 1. **什么时候能原地更新**（{@link canInstallMacosInPlace}）——判据错了的后果是
 *    在只读/translocated 的位置上尝试替换，或者在能做的时候让用户回去手动拖；
 * 2. **准备阶段**（挂载 + 身份/版本/TeamID/空间）——影像里的东西不是同一个应用时必须抛错，
 *    而不是"换一种交付方式"；
 * 3. **帮手脚本的契约**（位置参数顺序、先校验后动手、回滚分支、失败码与文案表同源）。
 */
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MACOS_UPDATE_FAILURE_LIMIT,
  MACOS_UPDATE_HELPER_SOURCE,
  MacosCommandFailure,
  assertSameApplication,
  canInstallMacosInPlace,
  clearAllMacosUpdateFailures,
  clearMacosUpdateFailures,
  clearMacosUpdateLeftovers,  clearMacosUpdateRecord,
  hasSpaceForUpdate,
  macAppBundlePath,
  machOArchitectures,
  macosUpdateHelperScript,
  macosUpdatePaths,
  normalizeVersion,
  prepareMacosInPlaceUpdate,
  readMacAppIdentity,
  readMacosUpdateFailureCount,
  readMacosUpdateOutcome,
  readMacosUpdateRecord,
  readTeamIdentifier,
  recordMacosUpdateFailure,
  removeMacosUpdateBackup,
  singleApplicationInImage,
  spawnMacosUpdateHelper,
  sweepMacosUpdateScripts,
  updateSidecarPaths,
  writeMacosUpdateBootFailureMarker,
  writeMacosUpdateBootMarker,
  writeMacosUpdateHelper,
  type MacAppIdentity,
  type MacosCommandRunner,
} from '../src/macos-update-install.ts'
import { desktopUpdateDialogCopy } from '../src/tray-locale.ts'

/**
 * 子进程边界替身：本文件里的 `spawnMacosUpdateHelper` 判据只看"什么时候 resolve /
 * reject / unref"。缺省的命令执行边界（`runMacosCommand`）也是 `spawnSync`，一并给上，
 * 免得模块导入期就拿到 undefined。
 */
const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('node:child_process', () => childProcess)

const temporary: string[] = []

/**
 * `chmod` 之后 `accessSync(W_OK)` 是否真的会失败。
 *
 * 以 root 跑的容器里（CI 的 ubuntu gate job 就是一例）权限位对 root 不起作用，
 * "目录不可写"这个现象根本造不出来 —— 那两条用例必须跳过，而不是假红。
 */
const CAN_MAKE_UNWRITABLE = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'dsh-macos-update-probe-'))
  try {
    chmodSync(probe, 0o500)
    try {
      accessSync(probe, fsConstants.W_OK)
      return false
    } catch {
      return true
    }
  } finally {
    try {
      chmodSync(probe, 0o700)
    } catch {
      // 探测目录的权限位恢复失败只影响清理。
    }
    rmSync(probe, { recursive: true, force: true })
  }
})()

/** 一个真实的临时目录（准备阶段的 fs 判据用真 fs，命令边界才替身）。 */
function makeTempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-macos-update-'))
  temporary.push(path)
  return path
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** 写一个最小的、`plutil` 读得懂的 Info.plist。 */
function writeInfoPlist(bundlePath: string, identifier: string, version: string, executable = 'App'): void {
  mkdirSync(join(bundlePath, 'Contents'), { recursive: true })
  writeFileSync(
    join(bundlePath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`,
    'utf8',
  )
}

/** plist 文件 → `plutil -convert json -o -` 会吐出的 JSON。 */
function plistJson(plistPath: string): string {
  const raw = readFileSync(plistPath, 'utf8')
  const value = (key: string): string => new RegExp(`<key>${key}</key><string>([^<]*)</string>`, 'u').exec(raw)?.[1] ?? ''
  return JSON.stringify({
    CFBundleIdentifier: value('CFBundleIdentifier'),
    CFBundleExecutable: value('CFBundleExecutable'),
    CFBundleShortVersionString: value('CFBundleShortVersionString'),
  })
}

interface FakeCommands {
  readonly run: MacosCommandRunner
  readonly calls: { readonly command: string; readonly args: readonly string[] }[]
  /** `hdiutil attach` 时把影像内容"挂"出来的钩子。 */
  onAttach?: (mountPoint: string) => void
  /** 这些命令名会被当作失败（抛错）。 */
  readonly failing: Set<string>
  /** 按包路径给出签名团队（默认两边都是同一个团队）。 */
  teamsFor: (bundlePath: string) => string | undefined
  kilobytes: number
  /**
   * `pgrep`（占用判据）的答案：false = 没有进程在跑（`pgrep` 的真实"无匹配"退出码 1），
   * true = 有进程在跑（返回一行 pid）。
   *
   * 审计复核 P1 之后，`pgrep` 的答案改成 **fail-closed**：只有"退出码 1"才算没人占用，
   * 其它失败一律按占用处理 —— 所以替身必须显式模拟"退出码 1"，而不是让未知命令一律返回成功。
   */
  inUse: boolean
}

/** 一个记录调用并按 `hdiutil attach` 钩子"挂载"影像的命令替身。 */
function fakeCommands(): FakeCommands {
  const state: FakeCommands = {
    calls: [],
    failing: new Set<string>(),
    teamsFor: () => 'TEAM123456',
    kilobytes: 1024,
    inUse: false,
    run: (command, args) => {
      state.calls.push({ command, args })
      if (state.failing.has(command)) throw new Error(`${command} failed (injected)`)
      if (command === 'pgrep') {
        if (!state.inUse) throw new MacosCommandFailure('pgrep: no match', 1)
        return '4242\n'
      }
      if (command === 'plutil') return plistJson(args[args.length - 1] ?? '')  // 末位参数就是 plist 路径
      if (command === 'codesign') {
        return `Identifier=ai.test.app\nTeamIdentifier=${state.teamsFor(args[args.length - 1] ?? '') ?? 'not set'}\n`
      }
      if (command === 'du') return `${String(state.kilobytes)}\t${args[args.length - 1] ?? ''}\n`
      if (command === 'hdiutil') {
        const attachIndex = args.indexOf('-mountpoint')
        if (attachIndex >= 0) state.onAttach?.(args[attachIndex + 1] ?? '')
        return ''
      }
      return ''
    },
  }
  return state
}

/** 搭一个"当前应用 + 影像里的新应用"现场，返回两边路径。 */
function stageFixture(options: {
  readonly currentVersion?: string
  readonly nextVersion?: string
  readonly sourceIdentifier?: string
} = {}): {
  root: string
  current: string
  source: string
  commands: FakeCommands
} {
  const root = makeTempDirectory()
  const current = join(root, 'Applications', 'PicoAide Harness.app')
  const source = join(root, 'Volume', 'PicoAide Harness.app')
  writeInfoPlist(current, 'ai.deepseek.dsh.desktop', options.currentVersion ?? '1.0.0')
  writeInfoPlist(source, options.sourceIdentifier ?? 'ai.deepseek.dsh.desktop', options.nextVersion ?? '1.1.0')
  const commands = fakeCommands()
  commands.onAttach = (mountPoint) => {
    mkdirSync(mountPoint, { recursive: true })
    const mounted = join(mountPoint, 'PicoAide Harness.app')
    rmSync(mounted, { recursive: true, force: true })
    mkdirSync(join(mounted, 'Contents'), { recursive: true })
    writeFileSync(join(mounted, 'Contents', 'Info.plist'), readFileSync(join(source, 'Contents', 'Info.plist')))
  }
  return { root, current, source, commands }
}

describe('macAppBundlePath', () => {
  it('takes the outermost .app so nested helpers are never the replacement target', () => {
    expect(macAppBundlePath('/Applications/PicoAide Harness.app/Contents/MacOS/PicoAide Harness'))
      .toBe('/Applications/PicoAide Harness.app')
    expect(macAppBundlePath(
      '/Applications/X.app/Contents/Frameworks/X Helper.app/Contents/MacOS/X Helper',
    )).toBe('/Applications/X.app')
  })

  it('returns undefined when there is no bundle to replace', () => {
    expect(macAppBundlePath('/usr/local/bin/node')).toBeUndefined()
    expect(macAppBundlePath('relative/X.app/Contents/MacOS/X')).toBeUndefined()
    expect(macAppBundlePath('/X.app')).toBe('/X.app')
  })
})

describe('normalizeVersion', () => {
  it('strips exactly one leading v', () => {
    expect(normalizeVersion('v2.8.3-beta.1')).toBe('2.8.3-beta.1')
    expect(normalizeVersion('2.8.3')).toBe('2.8.3')
    expect(normalizeVersion('vv2')).toBe('v2')
  })
})

describe('canInstallMacosInPlace', () => {
  const packed = { platform: 'darwin' as const, isPackaged: true, executablePath: '/Applications/X.app/Contents/MacOS/X' }

  it('accepts a packaged macOS app in a writable location', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    mkdirSync(join(bundle, 'Contents'), { recursive: true })
    expect(canInstallMacosInPlace({ ...packed, executablePath: join(bundle, 'Contents', 'MacOS', 'X') })).toBeUndefined()
  })

  it('refuses every environment that cannot be replaced in place', () => {
    expect(canInstallMacosInPlace({ ...packed, platform: 'linux', executablePath: '/Applications/X.app/Contents/MacOS/X' }))
      .toBe('unsupported-platform')
    expect(canInstallMacosInPlace({ ...packed, isPackaged: false })).toBe('not-packaged')
    expect(canInstallMacosInPlace({ ...packed, executablePath: '/usr/local/bin/dsh' })).toBe('unrecognized-bundle')
    expect(canInstallMacosInPlace({
      ...packed,
      executablePath: '/private/var/folders/xx/AppTranslocation/9AB1/d/X.app/Contents/MacOS/X',
    })).toBe('read-only-location')
  })

  it.skipIf(!CAN_MAKE_UNWRITABLE)('refuses a bundle whose directory the user cannot write (root install / read-only volume)', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    chmodSync(root, 0o500)
    try {
      expect(canInstallMacosInPlace({ ...packed, executablePath: join(bundle, 'Contents', 'MacOS', 'X') }))
        .toBe('unwritable-location')
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it.skipIf(!CAN_MAKE_UNWRITABLE)('refuses a bundle that is itself read-only even when its directory is writable', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    chmodSync(bundle, 0o500)
    try {
      expect(canInstallMacosInPlace({ ...packed, executablePath: join(bundle, 'Contents', 'MacOS', 'X') }))
        .toBe('unwritable-location')
    } finally {
      chmodSync(bundle, 0o700)
    }
  })
})

describe('readMacAppIdentity', () => {
  it('reads identifier, version, executable and the signing team', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    writeInfoPlist(bundle, 'ai.test.app', '3.2.1')
    expect(readMacAppIdentity(fakeCommands().run, bundle)).toEqual({
      identifier: 'ai.test.app',
      version: '3.2.1',
      executable: 'App',
      teamIdentifier: 'TEAM123456',
    })
  })

  it('treats an unsigned or ad-hoc bundle as having no team instead of failing', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    writeInfoPlist(bundle, 'ai.test.app', '3.2.1')
    const unsigned = fakeCommands()
    unsigned.failing.add('codesign')
    expect(readTeamIdentifier(unsigned.run, bundle)).toBeUndefined()
    const adHoc = fakeCommands()
    adHoc.teamsFor = () => undefined
    expect(readTeamIdentifier(adHoc.run, bundle)).toBeUndefined()
    expect(readMacAppIdentity(unsigned.run, bundle).teamIdentifier).toBeUndefined()
  })

  it('rejects something that is not an application bundle', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    mkdirSync(join(bundle, 'Contents'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist version="1.0"><dict/></plist>', 'utf8')
    expect(() => readMacAppIdentity(fakeCommands().run, bundle)).toThrow(/does not look like an application bundle/u)
  })
})

describe('singleApplicationInImage', () => {
  it('finds the one bundle and ignores the /Applications symlink beside it', () => {
    const mount = makeTempDirectory()
    mkdirSync(join(mount, 'PicoAide Harness.app'), { recursive: true })
    // electron-builder 的 DMG 卷根就是"应用 + 指向 /Applications 的符号链接"：
    // 用 statSync 判目录会把那个链接也算进来，于是"不止一个应用"。
    symlinkSync('/Applications', join(mount, 'Applications'))
    writeFileSync(join(mount, '.DS_Store'), '', 'utf8')
    expect(singleApplicationInImage(mount)).toBe(join(mount, 'PicoAide Harness.app'))
  })

  it('fails loudly when the image holds no application or more than one', () => {
    const empty = makeTempDirectory()
    expect(() => singleApplicationInImage(empty)).toThrow(/contains no application bundle/u)
    const many = makeTempDirectory()
    mkdirSync(join(many, 'A.app'))
    mkdirSync(join(many, 'B.app'))
    expect(() => singleApplicationInImage(many)).toThrow(/contains 2 application bundles/u)
  })
})

describe('assertSameApplication', () => {
  const current: MacAppIdentity = {
    identifier: 'ai.deepseek.dsh.desktop',
    version: '1.0.0',
    executable: 'App',
    teamIdentifier: 'TEAM123456',
  }

  it('accepts the same application at the expected version', () => {
    expect(() => assertSameApplication(current, { ...current, version: '1.1.0' }, 'v1.1.0')).not.toThrow()
  })

  it('refuses a different application, a different version, or a different signing team', () => {
    expect(() => assertSameApplication(current, { ...current, identifier: 'com.other.app' }, '1.1.0'))
      .toThrow(/holds com.other.app, not ai.deepseek.dsh.desktop/u)
    expect(() => assertSameApplication(current, { ...current, version: '1.0.9' }, '1.1.0'))
      .toThrow(/holds 1.0.9, expected 1.1.0/u)
    expect(() => assertSameApplication(current, { ...current, version: '1.1.0', teamIdentifier: 'OTHERTEAM' }, '1.1.0'))
      .toThrow(/signed by OTHERTEAM, not TEAM123456/u)
    // 当前应用有 TeamID、影像里的没有 ⇒ 一样拒绝（自签/临时签名冒充不了有团队的包）。
    expect(() => assertSameApplication(current, { ...current, version: '1.1.0', teamIdentifier: undefined }, '1.1.0'))
      .toThrow(/signed by no team, not TEAM123456/u)
  })

  it('does not require a team when the running build has none (development builds)', () => {
    const dev: MacAppIdentity = { ...current, teamIdentifier: undefined }
    expect(() => assertSameApplication(dev, { ...dev, version: '1.1.0', teamIdentifier: undefined }, '1.1.0'))
      .not.toThrow()
  })
})

describe('updateSidecarPaths', () => {
  it('puts staging and backup next to the target so the swap is a rename', () => {
    expect(updateSidecarPaths('/Applications/My App.app', 'v2.0.0')).toEqual({
      stagingPath: '/Applications/.My App.app.update-2.0.0.app',
      backupPath: '/Applications/.My App.app.backup-2.0.0.app',
    })
  })
})

describe('clearMacosUpdateLeftovers', () => {
  it('removes only this application\'s staging/backup siblings and detaches the image', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    writeInfoPlist(bundle, 'ai.test.app', '1.0.0')
    mkdirSync(join(root, '.X.app.update-9.9.9.app'))
    mkdirSync(join(root, '.X.app.backup-9.9.9.app'))
    mkdirSync(join(root, '.Other.app.update-9.9.9.app'))
    mkdirSync(join(root, 'neighbour'))
    // 挂载点存在 = 上一次真的挂过影像 ⇒ 先卸载；不存在时不该 spawn `hdiutil`（这条路径
    // 在**每个** macOS 进程的启动路径上，每次多一个进程 + 一行假错误不可接受）。
    const mountPoint = join(root, 'image')
    mkdirSync(mountPoint)
    const commands = fakeCommands()

    clearMacosUpdateLeftovers(bundle, mountPoint, commands.run)

    expect(existsSync(join(root, '.X.app.update-9.9.9.app'))).toBe(false)
    expect(existsSync(join(root, '.X.app.backup-9.9.9.app'))).toBe(false)
    expect(existsSync(join(root, '.Other.app.update-9.9.9.app'))).toBe(true)
    expect(existsSync(join(root, 'neighbour'))).toBe(true)
    expect(existsSync(bundle)).toBe(true)
    expect(commands.calls).toContainEqual({ command: 'hdiutil', args: ['detach', mountPoint] })

    // 反向对照：没有挂载点就不该有任何命令。
    const quiet = fakeCommands()
    clearMacosUpdateLeftovers(bundle, join(root, 'never-mounted'), quiet.run)
    expect(quiet.calls).toEqual([])
  })
})

describe('prepareMacosInPlaceUpdate', () => {
  it('mounts the image, verifies identity and returns a rename-based plan', async () => {
    const { root, current, commands } = stageFixture()
    const preparation = await prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })

    expect(preparation.kind).toBe('prepared')
    if (preparation.kind !== 'prepared') throw new Error('unreachable')
    const paths = macosUpdatePaths(join(root, 'userData'))
    expect(preparation.plan).toEqual({
      bundlePath: current,
      mountPoint: paths.mountPoint,
      sourcePath: join(paths.mountPoint, 'PicoAide Harness.app'),
      stagingPath: join(root, 'Applications', '.PicoAide Harness.app.update-1.1.0.app'),
      backupPath: join(root, 'Applications', '.PicoAide Harness.app.backup-1.1.0.app'),
      bundleIdentifier: 'ai.deepseek.dsh.desktop',
    })
    expect(commands.calls.map(call => call.command)).toContain('hdiutil')
    const attach = commands.calls.find(call => call.command === 'hdiutil' && call.args[0] === 'attach')
    expect(attach?.args).toEqual(['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', paths.mountPoint, join(root, 'update.dmg')])
    // 成功时影像**保持挂载**（帮手要用）：挂载之后不能再有 detach（挂载之前的那一次
    // 是清残留挂载点）。
    const attachIndex = commands.calls.indexOf(attach as never)
    expect(commands.calls.slice(attachIndex + 1).some(call => call.command === 'hdiutil' && call.args[0] === 'detach')).toBe(false)
  })

  it('unmounts the image when it decides to fall back after mounting it', async () => {
    const { root, current, commands } = stageFixture()
    commands.kilobytes = Number.MAX_SAFE_INTEGER
    const preparation = await prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })
    expect(preparation).toEqual({ kind: 'fallback', reason: 'insufficient-space' })
    // 回落之后影像必须被卸载（这次不会再有帮手上场）。
    expect(commands.calls).toContainEqual({
      command: 'hdiutil',
      args: ['detach', macosUpdatePaths(join(root, 'userData')).mountPoint],
    })
  })

  it('falls back before touching the disk when the environment cannot be updated in place', async () => {
    const { root, current, commands } = stageFixture()
    const preparation = await prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: false,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })
    expect(preparation).toEqual({ kind: 'fallback', reason: 'not-packaged' })
    expect(commands.calls).toEqual([])
  })

  it.each<[string, { sourceIdentifier?: string; nextVersion?: string }]>([
    ['a different application', { sourceIdentifier: 'com.other.app' }],
    ['a different version', { nextVersion: '1.0.5' }],
  ])('refuses %s in the image and unmounts it', async (_label, overrides) => {
    const { root, current, commands } = stageFixture(overrides)
    await expect(prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })).rejects.toThrow(/dsh-plugin-desktop/u)
    expect(commands.calls).toContainEqual({
      command: 'hdiutil',
      args: ['detach', macosUpdatePaths(join(root, 'userData')).mountPoint],
    })
  })

  it('refuses an image signed by another team', async () => {
    const { root, current, commands } = stageFixture()
    // 影像里的包签名团队与当前应用不同：`codesign --verify` 对自签/临时签名同样通过，
    // TeamIdentifier 才是这一层真正的来源判据。
    commands.teamsFor = path => (path.includes('/macos/image/') ? 'OTHERTEAM' : 'TEAM123456')
    await expect(prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })).rejects.toThrow(/signed by OTHERTEAM, not TEAM123456/u)
  })

  it('refuses when the target version is already installed', async () => {
    const { root, current, commands } = stageFixture({ currentVersion: '1.1.0' })
    await expect(prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })).rejects.toThrow(/already installed/u)
  })
})

describe('hasSpaceForUpdate', () => {
  it('requires room for a full second copy', () => {
    const root = makeTempDirectory()
    const huge = fakeCommands()
    huge.kilobytes = Number.MAX_SAFE_INTEGER
    expect(hasSpaceForUpdate(huge.run, root, root)).toBe(false)
    const tiny = fakeCommands()
    tiny.kilobytes = 1
    expect(hasSpaceForUpdate(tiny.run, root, root)).toBe(true)
  })

  it('lets the copy fail on its own when the size cannot be read', () => {
    const root = makeTempDirectory()
    const broken = fakeCommands()
    broken.kilobytes = Number.NaN
    expect(hasSpaceForUpdate(broken.run, root, root)).toBe(true)
  })
})

describe('macosUpdateHelperScript', () => {
  it('verifies the staged bundle before moving the user\'s application aside', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    const verify = script.indexOf('/usr/bin/codesign --verify --strict "$STAGING"')
    const firstMove = script.indexOf('/bin/mv "$TARGET" "$BACKUP"')
    expect(verify).toBeGreaterThan(0)
    expect(firstMove).toBeGreaterThan(verify)
  })

  it('keeps a rollback for every step that can destroy the installed application', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    // 落位失败 ⇒ 备份换回原名；新版起不来 ⇒ 新包挪开、备份换回原名；
    // 以及 EXIT 兜底：两次 mv 之间被杀时把缺失的目标补回来（审计 A5/A6）。
    expect(script.match(/\/bin\/mv "\$BACKUP" "\$TARGET"/gu)).toHaveLength(3)
    expect(script).toContain('/bin/rm -rf "$BROKEN"')
    // 一个字节都不动就放弃的两条：宿主没退出、暂存件签名不过。
    expect(script).toContain('application-still-running')
    expect(script).toContain('verification-failed')
    // 审计 A6：每条出口都要卸载影像（原实现只有成功路径卸）。
    expect(script).toContain('trap cleanup EXIT')
  })

  it('never interpolates a path into the script', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    // 全部位置参数：脚本里出现的是变量引用，而不是宿主的路径。
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(script).toContain(index <= 9 ? `"$${String(index)}"` : `"\${${String(index)}}"`)
    }
    expect(script).not.toContain('@@')
  })

  it('confirms the boot with an exact line and never a prefix match', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    // 审计 A1：`grep -q "version=$VERSION"` 是子串匹配，会被版本号前缀吃掉
    // （目标 2.8.3 命中标记里的 2.8.3-beta.1 / 2.8.3-beta.10）⇒ 误判成功并删掉唯一备份。
    //
    // 注意这条是**拼写判据**：它能钉住"当前实现用的是整行定串"，但拦不住"换一种同样错的
    // 子串写法"。语义判据（真喂一个前缀标记、要求回滚）在 darwin-only 的
    // `tests/macos-update-helper.integration.spec.ts` 里，由 `desktop-macos` job 真跑。
    expect(script).toContain('/usr/bin/grep -qxF "version=$VERSION" "$BOOT_FILE"')
    expect(script).not.toContain('/usr/bin/grep -q "version=$VERSION"')
    // 审计复核 P1：**不许**把"目标路径下有进程"当成功判据 —— `pgrep -f` 是命令行文本匹配，
    // 把 TARGET 改名成 BACKUP 之后旧实例的 argv 仍然命中，会同时做出"不回滚 + 删掉正在运行的
    // 那份文件 + 记成 ok"三件事。确认只认标记。
    expect(script).not.toContain('target_running')
    expect(script).not.toContain('backup_running')
    expect(script).not.toContain('/usr/bin/pgrep')
  })

  it('unmounts the image and restores a missing target on every exit path', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    // 审计 A5/A6：EXIT 兜底同时做"补回缺失目标"与"卸载影像"。
    expect(script).toContain('cleanup() {')
    expect(script).toContain('if [ ! -e "$TARGET" ] && [ -e "$BACKUP" ]; then')
    expect(script).toContain('/usr/bin/hdiutil detach "$MOUNT" >/dev/null 2>&1 || true')
    expect(script).toContain('trap cleanup EXIT')
    expect(script).toContain("trap 'exit 1' INT TERM HUP")
  })

  it('only interpolates the tuned values, and refuses unsafe ones', () => {
    const tuned = macosUpdateHelperScript({ relaunchCommand: '/usr/bin/true', bootWaitTicks: 4, exitWaitTicks: 6 })
    expect(tuned).toContain('relaunch() { /usr/bin/true "$1"')
    expect(tuned).toContain('-ge 6 ]; then')
    expect(tuned).toContain('-lt 4 ]; do')
    expect(() => macosUpdateHelperScript({ relaunchCommand: '/bin/sh -c "rm -rf /"' })).toThrow(/unsafe/u)
    expect(() => macosUpdateHelperScript({ relaunchCommand: 'open' })).toThrow(/unsafe/u)
    expect(() => macosUpdateHelperScript({ bootWaitTicks: 0 })).toThrow(/positive integers/u)
  })

  it('keeps every failure code the script writes in the localized copy table', () => {
    const codes = new Set(
      [...MACOS_UPDATE_HELPER_SOURCE.matchAll(/record failed \S+ (\S+)/gu)].map(match => match[1] ?? ''),
    )
    expect(codes.size).toBeGreaterThanOrEqual(7)
    for (const locale of ['en', 'zh'] as const) {
      const copy = desktopUpdateDialogCopy(locale)
      for (const code of codes) {
        // 表里没有的码会原样回显（可诊断），但"脚本里有、文案里没登记"就是漏翻译：
        // 这里要求它至少不是原码。
        expect(copy.darwinUpdateFailureReason(code), `${locale} is missing a reason for ${code}`).not.toBe(code)
        expect(copy.darwinUpdateFailureReason(code)).not.toBe('')
      }
    }
  })
})

describe('writeMacosUpdateHelper', () => {
  it('writes the script under userData and passes every path as a positional argument', () => {
    const userDataPath = makeTempDirectory()
    const helper = writeMacosUpdateHelper({
      plan: {
        bundlePath: '/Applications/My App.app',
        mountPoint: '/tmp/mnt',
        sourcePath: '/Volumes/X/My App.app',
        stagingPath: '/Applications/.My App.app.update-2.0.0.app',
        backupPath: '/Applications/.My App.app.backup-2.0.0.app',
        bundleIdentifier: 'ai.test.app',
      },
      userDataPath,
      version: 'v2.0.0',
      pid: 4242,
      fromVersion: 'v1.0.0',
    })
    const paths = macosUpdatePaths(userDataPath)
    // 审计 N8：脚本名带 pid —— 固定名 + 覆盖重写会让仍在运行的上一条 `/bin/sh`
    // 读到错位内容（bash 按偏移增量读脚本）。
    const scriptPath = join(dirname(paths.scriptPath), 'apply-update-4242.sh')
    expect(helper.scriptPath).toBe(scriptPath)
    expect(helper.command).toBe('/bin/sh')
    expect(helper.args).toEqual([
      scriptPath,
      '4242',
      '/Applications/My App.app',
      '/Volumes/X/My App.app',
      '/Applications/.My App.app.update-2.0.0.app',
      '/Applications/.My App.app.backup-2.0.0.app',
      '/tmp/mnt',
      paths.resultPath,
      paths.logPath,
      '2.0.0',
      paths.bootMarkerPath,
      '1.0.0',
      paths.bootFailurePath,
    ])
    // 脚本逐字等于生产脚本：路径没有以任何形式被拼进去。
    expect(readFileSync(scriptPath, 'utf8')).toBe(MACOS_UPDATE_HELPER_SOURCE)
    expect(readFileSync(scriptPath, 'utf8')).not.toContain('My App.app')
  })
})

describe('spawnMacosUpdateHelper', () => {
  /** 一个只会记监听器的手柄替身。 */
  function fakeChild(): {
    child: { once: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
    listeners: Map<string, (...args: unknown[]) => void>
  } {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const child = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
        return child
      }),
      off: vi.fn(() => child),
      unref: vi.fn(),
    }
    return { child, listeners }
  }

  it('resolves only after the kernel confirms the spawn, and detaches the child', async () => {
    const { child, listeners } = fakeChild()
    childProcess.spawn.mockReturnValueOnce(child)

    let settled = false
    const pending = spawnMacosUpdateHelper({
      scriptPath: '/tmp/apply.sh',
      command: '/bin/sh',
      args: ['/tmp/apply.sh'],
      resultPath: '/tmp/result',
      logPath: '/tmp/log',
      bootMarkerPath: '/tmp/boot',
    }).then(() => { settled = true })

    expect(childProcess.spawn).toHaveBeenLastCalledWith(
      '/bin/sh',
      ['/tmp/apply.sh'],
      { detached: true, stdio: 'ignore', shell: false },
    )
    await Promise.resolve()
    // spawn 事件到达之前绝不能 resolve：宿主紧接着就要退出。
    expect(settled).toBe(false)
    listeners.get('spawn')?.()
    await pending
    expect(settled).toBe(true)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects when the helper cannot be started at all', async () => {
    const { child, listeners } = fakeChild()
    childProcess.spawn.mockReturnValueOnce(child)
    const pending = spawnMacosUpdateHelper({
      scriptPath: '/tmp/apply.sh',
      command: '/bin/sh',
      args: ['/tmp/apply.sh'],
      resultPath: '/tmp/result',
      logPath: '/tmp/log',
      bootMarkerPath: '/tmp/boot',
    })
    listeners.get('error')?.(new Error('blocked'))
    await expect(pending).rejects.toThrow('blocked')
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('routes a failure that happens after a successful spawn to the logger', async () => {
    const { child, listeners } = fakeChild()
    childProcess.spawn.mockReturnValueOnce(child)
    const late = vi.fn()
    const pending = spawnMacosUpdateHelper({
      scriptPath: '/tmp/apply.sh',
      command: '/bin/sh',
      args: ['/tmp/apply.sh'],
      resultPath: '/tmp/result',
      logPath: '/tmp/log',
      bootMarkerPath: '/tmp/boot',
    }, late)
    listeners.get('spawn')?.()
    await pending
    // spawn 之后再注册的错误监听：只记日志，不影响已经 resolve 的交接。
    listeners.get('error')?.(new Error('killed'))
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ message: 'killed' }))
  })
})

describe('update bookkeeping', () => {
  it('round-trips the helper result file and hands the caller a conclusion', () => {
    const userDataPath = makeTempDirectory()
    writeMacosUpdateBootMarker(userDataPath, 'v2.0.0', '/Applications/X.app', '2026-10-09T00:00:00.000Z')
    // 标记里必须带 `bundle=`（审计复核 P1：只认版本号会被同版本的另一份副本或 yarn dev 伪造）。
    expect(readFileSync(macosUpdatePaths(userDataPath).bootMarkerPath, 'utf8'))
      .toBe('version=2.0.0\nbundle=/Applications/X.app\nat=2026-10-09T00:00:00.000Z\n')

    // 没有结果文件 ⇒ 什么都不做。
    expect(readMacosUpdateRecord(userDataPath)).toBeUndefined()
    expect(readMacosUpdateOutcome(userDataPath, '1.0.0')).toBeUndefined()

    const resultPath = macosUpdatePaths(userDataPath).resultPath
    mkdirSync(join(userDataPath, 'updates', 'macos'), { recursive: true })
    writeFileSync(resultPath, [
      'status=failed', 'phase=rolling-back', 'reason=application-did-not-start',
      'version=2.0.0', 'from=1.0.0', 'target=/Applications/X.app',
      'backup=/Applications/.X.app.backup-2.0.0.app', 'log=/tmp/log', '',
    ].join('\n'), 'utf8')
    expect(readMacosUpdateRecord(userDataPath)).toEqual({
      status: 'failed',
      phase: 'rolling-back',
      reason: 'application-did-not-start',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      targetPath: '/Applications/X.app',
      backupPath: '/Applications/.X.app.backup-2.0.0.app',
      logPath: '/tmp/log',
    })
    const outcome = readMacosUpdateOutcome(userDataPath, '1.0.0')
    expect(outcome?.kind).toBe('failed')

    // 目标版本就是当前版本 ⇒ 更新已生效（帮手没写完也算），删备份。
    expect(readMacosUpdateOutcome(userDataPath, 'v2.0.0')).toEqual({
      kind: 'applied',
      toVersion: '2.0.0',
      backupPath: '/Applications/.X.app.backup-2.0.0.app',
      logPath: '/tmp/log',
    })

    clearMacosUpdateRecord(userDataPath)
    expect(existsSync(resultPath)).toBe(false)
    clearMacosUpdateRecord(userDataPath)
  })

  it('reports an interrupted attempt (helper killed before it wrote a status)', () => {
    const userDataPath = makeTempDirectory()
    mkdirSync(join(userDataPath, 'updates', 'macos'), { recursive: true })
    writeFileSync(macosUpdatePaths(userDataPath).resultPath, 'status=running\nphase=swapping\nversion=2.0.0\nfrom=1.0.0\n', 'utf8')
    const outcome = readMacosUpdateOutcome(userDataPath, '1.0.0')
    expect(outcome).toMatchObject({ kind: 'failed', record: { reason: '', phase: 'swapping' } })
    // 版本对上了 ⇒ 是"帮手被杀在替换之后"，更新其实生效了，不该报失败。
    expect(readMacosUpdateOutcome(userDataPath, '2.0.0')?.kind).toBe('applied')
  })

  it('ignores a damaged result file', () => {
    const userDataPath = makeTempDirectory()
    mkdirSync(join(userDataPath, 'updates', 'macos'), { recursive: true })
    writeFileSync(macosUpdatePaths(userDataPath).resultPath, 'status=weird\nversion=\n', 'utf8')
    expect(readMacosUpdateRecord(userDataPath)).toBeUndefined()
  })

  it('removes the backup and tolerates a missing one', () => {
    const root = makeTempDirectory()
    const backup = join(root, '.X.app.backup-2.0.0.app')
    mkdirSync(backup)
    // 显式给"无匹配"（`pgrep` 退出码 1）：占用判据是 fail-closed，缺省替身回答不了它。
    const idle: MacosCommandRunner = () => { throw new MacosCommandFailure('pgrep: no match', 1) }
    removeMacosUpdateBackup(backup, () => {}, idle)
    expect(existsSync(backup)).toBe(false)
    expect(() => removeMacosUpdateBackup(join(root, 'gone'), () => {}, idle)).not.toThrow()
    expect(() => removeMacosUpdateBackup('')).not.toThrow()
  })
})

/**
 * 2026-10-12 审计修复批的判据。
 *
 * 每一条都对应审计报告里的一个编号（A1…N8）；编号写在用例名里，便于把"修复"与
 * "判据"逐条对上 —— 本仓对"只改实现不补判据"的口径是当成没修。
 */
describe('macOS in-place update audit fixes (2026-10-12)', () => {
  /** 主程序位置：与 `writeInfoPlist` 的缺省 `CFBundleExecutable`（`App`）对齐。 */
  function stagedExecutablePath(mountPoint: string): string {
    return join(mountPoint, 'PicoAide Harness.app', 'Contents', 'MacOS', 'App')
  }

  const THIN_ARM64 = [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]
  const THIN_X86_64 = [0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]

  const prepareBase = {
    platform: 'darwin' as const,
    isPackaged: true,
  }

  it('A8: reads thin and fat Mach-O headers without shelling out to lipo', () => {
    expect(machOArchitectures(Uint8Array.from(THIN_ARM64))).toEqual(['arm64'])
    expect(machOArchitectures(Uint8Array.from(THIN_X86_64))).toEqual(['x86_64'])
    // 胖二进制：0xcafebabe + nfat_arch=2 + 两条 20 字节表项。
    const fat = new Uint8Array(8 + 2 * 20)
    const view = new DataView(fat.buffer)
    view.setUint32(0, 0xcafebabe, false)
    view.setUint32(4, 2, false)
    view.setUint32(8, 0x01000007, false)
    view.setUint32(8 + 20, 0x0100000c, false)
    expect(machOArchitectures(fat)).toEqual(['x86_64', 'arm64'])
    // 认不出来的一律 undefined（调用方据此"放行并记日志"，不是当成不兼容）。
    expect(machOArchitectures(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBeUndefined()
    expect(machOArchitectures(Uint8Array.from(THIN_ARM64).subarray(0, 4))).toBeUndefined()
  })

  it('A8: rejects an image built for another architecture', async () => {
    const { root, current, commands } = stageFixture()
    const base = commands.onAttach
    commands.onAttach = (mountPoint) => {
      base?.(mountPoint)
      const executable = stagedExecutablePath(mountPoint)
      mkdirSync(dirname(executable), { recursive: true })
      writeFileSync(executable, Buffer.from(THIN_ARM64))
    }
    await expect(prepareMacosInPlaceUpdate({
      ...prepareBase,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
      arch: 'x64',
    })).rejects.toThrow(/supports arm64, not x86_64/u)
  })

  it('A8: accepts an image that carries the current architecture', async () => {
    const { root, current, commands } = stageFixture()
    const base = commands.onAttach
    commands.onAttach = (mountPoint) => {
      base?.(mountPoint)
      const executable = stagedExecutablePath(mountPoint)
      mkdirSync(dirname(executable), { recursive: true })
      writeFileSync(executable, Buffer.from(THIN_ARM64))
    }
    const preparation = await prepareMacosInPlaceUpdate({
      ...prepareBase,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
      arch: 'arm64',
    })
    expect(preparation.kind).toBe('prepared')
  })

  it('A9: refuses to replace the running application with an older version', async () => {
    const { root, current, commands } = stageFixture({ currentVersion: '2.0.0', nextVersion: '1.0.0' })
    await expect(prepareMacosInPlaceUpdate({
      ...prepareBase,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.0.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })).rejects.toThrow(/refusing to replace 2\.0\.0 with the older 1\.0\.0/u)
  })

  it('A13: falls back when the image cannot be attached', async () => {
    const { root, current, commands } = stageFixture()
    commands.failing.add('hdiutil')
    const preparation = await prepareMacosInPlaceUpdate({
      ...prepareBase,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })
    expect(preparation).toEqual({ kind: 'fallback', reason: 'image-unavailable' })
  })

  it('A13: falls back when the mount point is still occupied', async () => {
    const { root, current, commands } = stageFixture()
    const paths = macosUpdatePaths(join(root, 'userData'))
    mkdirSync(join(paths.mountPoint, 'leftover-from-last-time'), { recursive: true })
    const preparation = await prepareMacosInPlaceUpdate({
      ...prepareBase,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })
    expect(preparation).toEqual({ kind: 'fallback', reason: 'image-busy' })
  })

  it('A15: stops retrying a version that already failed the allowed number of times', async () => {
    const { root, current, commands } = stageFixture()
    const paths = macosUpdatePaths(join(root, 'userData'))
    mkdirSync(dirname(paths.failuresPath), { recursive: true })
    writeFileSync(paths.failuresPath, `1.1.0=${String(MACOS_UPDATE_FAILURE_LIMIT)}\n`, 'utf8')
    const preparation = await prepareMacosInPlaceUpdate({
      ...prepareBase,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })
    expect(preparation).toEqual({ kind: 'fallback', reason: 'too-many-failures' })
  })

  it('A15: records, reads and clears the failure ledger', () => {
    const userDataPath = makeTempDirectory()
    expect(readMacosUpdateFailureCount(userDataPath, '1.1.0')).toBe(0)
    expect(recordMacosUpdateFailure(userDataPath, 'v1.1.0')).toBe(1)
    expect(recordMacosUpdateFailure(userDataPath, '1.1.0')).toBe(2)
    // 只记目标版本：别的版本互不影响。
    expect(recordMacosUpdateFailure(userDataPath, '1.2.0')).toBe(1)
    expect(readMacosUpdateFailureCount(userDataPath, '1.1.0')).toBe(2)
    clearMacosUpdateFailures(userDataPath, '1.1.0')
    expect(readMacosUpdateFailureCount(userDataPath, '1.1.0')).toBe(0)
    expect(readMacosUpdateFailureCount(userDataPath, '1.2.0')).toBe(1)
    // 清全账是**显式**接口（审计复核 P3：省略版本的默认值 = 静默删掉退避机制）。
    clearAllMacosUpdateFailures(userDataPath)
    expect(readMacosUpdateFailureCount(userDataPath, '1.2.0')).toBe(0)
  })

  it('A4: sweeps the .broken leftover the old shape never matched', () => {
    const root = makeTempDirectory()
    const applications = join(root, 'Applications')
    const bundle = join(applications, 'X.app')
    mkdirSync(bundle, { recursive: true })
    const broken = join(applications, '.X.app.update-2.0.0.app.broken')
    mkdirSync(broken, { recursive: true })
    clearMacosUpdateLeftovers(bundle, join(root, 'missing-mount'), () => '')
    expect(existsSync(broken)).toBe(false)
  })

  it('A2: keeps the backup the failure report names', () => {
    const root = makeTempDirectory()
    const applications = join(root, 'Applications')
    const bundle = join(applications, 'X.app')
    mkdirSync(bundle, { recursive: true })
    const backup = join(applications, '.X.app.backup-2.0.0.app')
    mkdirSync(backup, { recursive: true })
    // 审计复核 P1：占用判据搬进了清理函数（原来只有 removeMacosUpdateBackup 有，
    // 而清理发生在它之前 ⇒ 保护等于没有）。
    const busy: MacosCommandRunner = () => '4242\n'
    clearMacosUpdateLeftovers(bundle, join(root, 'missing-mount'), busy, () => {}, {})
    expect(existsSync(backup)).toBe(true)
    // `keep` 仍然管用（失败要通报的那一份）；无人占用时照旧清掉。
    const idle: MacosCommandRunner = () => { throw new MacosCommandFailure('pgrep: no match', 1) }
    clearMacosUpdateLeftovers(bundle, join(root, 'missing-mount'), idle, () => {}, { keep: backup })
    expect(existsSync(backup)).toBe(true)
    clearMacosUpdateLeftovers(bundle, join(root, 'missing-mount'), idle)
    expect(existsSync(backup)).toBe(false)
  })

  it('N8: sweeps per-attempt helper scripts', () => {
    const root = makeTempDirectory()
    const scripts = join(root, 'updates', 'macos')
    mkdirSync(scripts, { recursive: true })
    writeFileSync(join(scripts, 'apply-update-4242.sh'), '', 'utf8')
    writeFileSync(join(scripts, 'apply-update.sh'), '', 'utf8')
    writeFileSync(join(scripts, 'unrelated.sh'), '', 'utf8')
    sweepMacosUpdateScripts(scripts)
    expect(existsSync(join(scripts, 'apply-update-4242.sh'))).toBe(false)
    expect(existsSync(join(scripts, 'apply-update.sh'))).toBe(false)
    expect(existsSync(join(scripts, 'unrelated.sh'))).toBe(true)
  })

  it('A10: keeps a backup that a process is still running from', () => {
    const root = makeTempDirectory()
    const backup = join(root, '.X.app.backup-2.0.0.app')
    mkdirSync(backup, { recursive: true })
    const inUse: MacosCommandRunner = () => ''
    const messages: string[] = []
    removeMacosUpdateBackup(backup, message => messages.push(message), inUse)
    expect(existsSync(backup)).toBe(true)
    expect(messages.join('\n')).toContain('kept the backup')
    // `pgrep` 的真实"无匹配"是**退出码 1**：只有这一种答案才算没人占用（fail-closed）。
    const idle: MacosCommandRunner = () => { throw new MacosCommandFailure('pgrep: no match', 1) }
    removeMacosUpdateBackup(backup, message => messages.push(message), idle)
    expect(existsSync(backup)).toBe(false)
    // 其它失败（`pgrep` 不存在、被信号打断）一律按**占用**处理 —— 方向不能朝删除。
    const broken: MacosCommandRunner = () => { throw new Error('spawnSync pgrep ENOENT') }
    mkdirSync(backup, { recursive: true })
    removeMacosUpdateBackup(backup, message => messages.push(message), broken)
    expect(existsSync(backup)).toBe(true)
  })

  it('P1: the boot confirmation must name this very bundle and yield to a failure report', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    // 正标记：版本 + bundle 都要整行命中（只认版本号会被同版本的另一份副本或 yarn dev 伪造）。
    expect(script).toContain('boot_marker_confirms()')
    expect(script).toContain('/usr/bin/grep -qxF "bundle=$TARGET" "$BOOT_FILE"')
    // 负向标记：新版自己报告致命启动失败 ⇒ 立刻回滚（这条路径会弹同步对话框、进程活很久，
    // 只看"目标主程序在跑"会把"根本没变成应用"判成成功）。
    expect(script).toContain('boot_failed()')
    expect(script).toContain('/usr/bin/grep -qxF "version=$VERSION" "$BOOT_FAIL_FILE"')
    expect(script).toContain('/usr/bin/grep -qxF "bundle=$TARGET" "$BOOT_FAIL_FILE"')
    expect(script).toContain('BOOT_FAIL_FILE="\${12}"')
    // 两个标记都在重开应用之前删掉：等到的标记只可能是本次启动写的。
    expect(script).toContain('/bin/rm -f "$BOOT_FILE" "$BOOT_FAIL_FILE"')
  })

  it('A9: lets an unorderable current version through and says so in the log', async () => {
    // 当前版本不是规范 semver（例如某次手改的构建）：版本序判据认不出大小关系，
    // 应当**放行并记日志**，而不是静默失效（审计复核：与架构判据对齐）。
    const { root, current, commands } = stageFixture({ currentVersion: 'dev-build', nextVersion: '1.1.0' })
    const messages: string[] = []
    const preparation = await prepareMacosInPlaceUpdate({
      ...prepareBase,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
      log: message => messages.push(message),
    })
    expect(preparation.kind).toBe('prepared')
    expect(messages.join('\n')).toContain('could not order 1.1.0 against dev-build')
  })

  it('A14: reports why the boot marker could not be written', () => {
    const root = makeTempDirectory()
    const notADirectory = join(root, 'file')
    writeFileSync(notADirectory, 'x', 'utf8')
    expect(writeMacosUpdateBootMarker(notADirectory, '2.0.0', '/Applications/X.app', 'now')).toBeTypeOf('string')
    const userDataPath = makeTempDirectory()
    expect(writeMacosUpdateBootMarker(userDataPath, '2.0.0', '/Applications/X.app', 'now')).toBeUndefined()
    expect(readFileSync(macosUpdatePaths(userDataPath).bootMarkerPath, 'utf8'))
      .toBe('version=2.0.0\nbundle=/Applications/X.app\nat=now\n')
    // 负向标记同一形状（审计复核 P1）：新版报告致命启动失败时写它，帮手据此回滚。
    expect(writeMacosUpdateBootFailureMarker(userDataPath, '2.0.0', '/Applications/X.app', 'now')).toBeUndefined()
    expect(readFileSync(macosUpdatePaths(userDataPath).bootFailurePath, 'utf8'))
      .toBe('version=2.0.0\nbundle=/Applications/X.app\nat=now\n')
  })
})

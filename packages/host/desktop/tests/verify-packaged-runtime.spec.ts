import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import {
  afterPack,
  assertBrandAssetSvg,
  PACKAGED_FLOCK_SMOKE_TIMEOUT_MS,
  PACKAGED_WEB_BRAND_ASSETS,
  PACKAGED_WEB_BRAND_FAVICON,
  PACKAGED_WEB_BRAND_OFFICIAL,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  nativeAddonPlatformPackages,
  nativeAddonRequirement,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolvePackagedAsarPath,
  resolvePackagedLauncherCandidates,
  resolvePackagedUnpackedRoot,
  smokePackagedDiagnosticWorker,
  smokePackagedFlockLock,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type FlockSmokeLauncher,
  type PackageEntryReader,
  type PackagedRuntimeContext,
  type PackagedDiagnosticWorkerLauncher,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_NATIVE_ENTRIES } from '../scripts/mac-runtime.ts'

function context(
  appOutDir: string,
  electronPlatformName: string,
  arch?: number,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    ...(arch === undefined ? {} : { arch }),
    packager: { appInfo: { productFilename: 'PicoAide Harness' } },
  }
}

const REQUIRED_ASAR_EXPORT_PATHS = [
  'lib/index.js',
  'lib/profile.js',
  'lib/client.js',
  'lib/diagnostics.js',
  'lib/updates.js',
  'lib/windows-agent-presets.js',
  'lib/windows-pwsh-sandbox.js',
  'node_modules/@deepseek-ai/dsh-base/package.json',
  'node_modules/@deepseek-ai/dsh-web-app/package.json',
  'node_modules/@picoaide/dsh-enterprise/lib/session-service.js',
  'node_modules/@picoaide/dsh-enterprise/lib/auth-gate.js',
  'node_modules/@picoaide/dsh-enterprise/lib/gateway-model.js',
  'node_modules/@picoaide/dsh-enterprise/lib/bootstrap.js',
  'node_modules/@picoaide/dsh-enterprise/lib/client.js',
  'node_modules/@picoaide/dsh-enterprise/package.json',
  'node_modules/@picoaide/dsh-connectors/lib/sales-easy.js',
  'node_modules/@picoaide/dsh-connectors/lib/client.js',
  'node_modules/@picoaide/dsh-connectors/package.json',
]

function completeArchiveEntries(separator = '/'): string[] {
  return [...REQUIRED_PACKAGED_RUNTIME_ENTRIES, ...REQUIRED_ASAR_EXPORT_PATHS]
    .map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

/** 我方品牌 SVG(内容断言由专门的用例覆盖,其余用例只关心条目/导出逻辑)。 */
const BRAND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254"><rect fill="#000000"/></svg>'

/**
 * `verifyPackagedRuntime` 的品牌内容读缝打桩:默认返回我方 SVG。
 * 品牌素材断言本体在 `asserts the packaged brand favicon ...` 用例里单测。
 */
function verifyWithBrandStub(
  runtimeContext: PackagedRuntimeContext,
  list: ArchiveLister,
  exists: FileProbe = existsSync,
): void {
  verifyPackagedRuntime(runtimeContext, list, exists, () => BRAND_SVG)
}

describe('packaged desktop runtime verification', () => {
  it('fails the diagnostic Worker smoke when its archive omits the crash dump', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
    const unpackedRoot = join(root, 'resources', 'app.asar.unpacked')
    mkdirSync(join(unpackedRoot, 'lib'), { recursive: true })
    writeFileSync(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'), '/* smoke */\n')
    const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (_workerPath, workerData) => {
      const outDir = join(workerData.userDataDir, 'diagnostics')
      mkdirSync(outDir)
      const output = join(outDir, 'diagnostics-smoke.zip')
      const zip = new AdmZip()
      zip.addFile('system-info.txt', Buffer.from('no dump\n'))
      zip.writeZip(output)
      return output
    })

    await expect(smokePackagedDiagnosticWorker(unpackedRoot, launch))
      .rejects.toThrow('packaged diagnostic worker omitted crash-dumps/pending/packaged-smoke.dmp')
  })

  it.each(['darwin', 'win32'])(
    'targets the physical diagnostic Worker in the %s unpacked layout and removes smoke files',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
      const unpackedRoot = join(root, 'resources', 'app.asar.unpacked')
      mkdirSync(join(unpackedRoot, 'lib'), { recursive: true })
      writeFileSync(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'), '/* smoke */\n')
      let smokeRoot: string | undefined
      const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (workerPath, workerData) => {
        smokeRoot = join(workerData.logsDir, '..')
        // 物理布局:worker 原地启动(其共享 chunk 兄弟文件在同目录)。
        expect(workerPath).toBe(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'))
        expect(readFileSync(join(workerData.logsDir, 'dsh-2000-01-01.log'), 'utf8'))
          .toBe('packaged worker smoke\n')
        expect(workerData.appVersion).toBe('packaged-smoke')
        expect(workerData.maxEvidenceBytes).toBe(1024)
        const crashDump = readFileSync(join(workerData.crashDumpsDir, 'pending', 'packaged-smoke.dmp'))
        expect(crashDump.toString('utf8')).toBe('packaged crash dump smoke\n')
        const outDir = join(workerData.userDataDir, 'diagnostics')
        mkdirSync(outDir)
        const output = join(outDir, 'diagnostics-smoke.zip')
        const zip = new AdmZip()
        zip.addFile('crash-dumps/pending/packaged-smoke.dmp', crashDump)
        zip.writeZip(output)
        return output
      })

      await smokePackagedDiagnosticWorker(unpackedRoot, launch)

      expect(launch).toHaveBeenCalledOnce()
      expect(smokeRoot).toBeDefined()
      expect(existsSync(smokeRoot as string)).toBe(false)
    },
  )

  it('runs the static package gate before the diagnostic Worker smoke', async () => {
    const runtimeContext = context('/build', 'win32')
    const calls: string[] = []

    // The production afterPack resolves the worker source root from the real
    // filesystem: no app.asar in this fixture, so the physical app root is used.
    await afterPack(
      runtimeContext,
      () => { calls.push('static') },
      async (workerRoot) => { calls.push(workerRoot) },
      () => { calls.push('flock') },
    )

    expect(calls).toEqual(['static', expect.stringMatching(/resources[\\/]app$/u), 'flock'])
  })

  it('tracks the ConPTY-only native surface shipped by node-pty 1.2', () => {
    expect(REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES).toEqual([
      'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
    ])
  })

  it.each([
    [
      'darwin',
      join('/build', 'PicoAide Harness.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path and keeps the unpacked tree native-only', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries())
    const realExists = vi.fn<FileProbe>(filename => {
      return filename.endsWith('pty.node')
    })

    // 直接验证 verifyPackagedRuntime 的主路径：list 完整 + exists 命中至少一个原生条目
    expect(() => verifyWithBrandStub(
      context('/build', platform),
      list,
      realExists,
    )).not.toThrow()

    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(`${expectedPath}.unpacked`)
  })

  it('requires the POSIX native addon family only where upstream publishes it', () => {
    // @deepseek-ai/node-addon-system ships darwin + linux platform packages and
    // its `flock` entry throws on Windows; Windows session locking is the
    // persistence package's own kernel32 semaphore path. A Windows packaging run
    // therefore legitimately has no family directory — demanding one there broke
    // the Windows installer job on the 0.1.5 upgrade PR.
    expect(nativeAddonRequirement('linux')).toBe('family-and-launcher')
    expect(nativeAddonRequirement('darwin')).toBe('family')
    expect(nativeAddonRequirement('win32')).toBe('none')
    expect(nativeAddonRequirement('mas')).toBe('none')
  })

  it('lists the flock module (system.node) as a required unpacked entry (P1-5)', () => {
    // rc.2 的会话写入走 node-addon-system 的 flock:dlopen 的是平台包里的
    // bin/{glibc,musl}/system.node。旧清单只列 landlock-run ⇒「启动器在、
    // flock 模块缺」时家族断言仍然通过,而会话写入退化成写失败。
    expect([...REQUIRED_UNPACKED_RUNTIME_ENTRIES]).toEqual(expect.arrayContaining([
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node',
    ]))
  })

  it('matches the required node-addon-system platform package to the target arch (P2-16)', () => {
    expect(nativeAddonPlatformPackages('linux', 1)).toEqual(['@deepseek-ai/node-addon-system-linux-x64'])
    expect(nativeAddonPlatformPackages('linux', 3)).toEqual(['@deepseek-ai/node-addon-system-linux-arm64'])
    expect(nativeAddonPlatformPackages('darwin', 1)).toEqual(['@deepseek-ai/node-addon-system-darwin-x64'])
    expect(nativeAddonPlatformPackages('darwin', 3)).toEqual(['@deepseek-ai/node-addon-system-darwin-arm64'])
    expect(nativeAddonPlatformPackages('darwin', 4)).toEqual([
      '@deepseek-ai/node-addon-system-darwin-arm64',
      '@deepseek-ai/node-addon-system-darwin-x64',
    ])
    // Windows 没有平台包;架构未知(老调用方)时不新增要求。
    expect(nativeAddonPlatformPackages('win32', 1)).toEqual([])
    expect(nativeAddonPlatformPackages('linux')).toEqual([])
  })

  describe('architecture-aware native addon family gate (real filesystem)', () => {
    /** 写一组相对 unpacked 根的假原生文件(内容无关,只验证存在性)。 */
    function writeUnpacked(unpackedRoot: string, files: readonly string[]): void {
      for (const file of files) {
        const target = join(unpackedRoot, file)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'x')
      }
    }

    /** 造一棵真实 unpacked 树,并返回 afterPack context。 */
    function fixture(
      electronPlatformName: string,
      arch: number,
      files: readonly string[],
    ): PackagedRuntimeContext {
      const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-addon-'))
      const runtimeContext = context(appOutDir, electronPlatformName, arch)
      const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
      mkdirSync(unpackedRoot, { recursive: true })
      // 至少一条必需原生条目存在,否则会先被"no native unpacked entries"拦下。
      writeUnpacked(unpackedRoot, ['node_modules/node-pty/prebuilds/linux-x64/pty.node', ...files])
      return runtimeContext
    }

    const ARM64_FILES = [
      'node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/landlock-run',
      'node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node',
      'node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/musl/system.node',
    ]
    const X64_FILES = [
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node',
    ]

    it('accepts an x64 tree whose matching platform package ships every native file', () => {
      const runtimeContext = fixture('linux', 1, X64_FILES)
      expect(() => verifyWithBrandStub(runtimeContext, () => completeArchiveEntries()))
        .not.toThrow()
    })

    it('rejects an x64 tree that only ships the arm64 platform package', () => {
      // 实测 x64 的 dist/linux-unpacked 里 node-addon-system-linux-arm64 也在
      // (supportedArchitectures 会装两套),旧的家族断言会被它满足。
      const runtimeContext = fixture('linux', 1, ARM64_FILES)
      expect(() => verifyWithBrandStub(runtimeContext, () => completeArchiveEntries()))
        .toThrow(/requires node-addon-system-linux-x64/)
    })

    it('rejects a matching platform package that is missing the flock module', () => {
      // linux-x64 的 glibc/musl system.node 同时在必需条目清单里(P1-5),所以这条
      // 会被"必需条目缺失"拦下;家族断言里的同族检查是给 arm64 / darwin 兜底的。
      const runtimeContext = fixture('linux', 1, [
        'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
        'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
      ])
      expect(() => verifyWithBrandStub(runtimeContext, () => completeArchiveEntries()))
        .toThrow(/missing required native unpacked entries: node_modules\/@deepseek-ai\/node-addon-system-linux-x64\/bin\/musl\/system\.node/u)
    })

    it('requires bin/system.node inside the darwin platform package', () => {
      const files = ['node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node']
      const ok = fixture('darwin', 3, files)
      expect(() => verifyWithBrandStub(ok, () => completeArchiveEntries())).not.toThrow()

      const missing = fixture('darwin', 3, [
        'node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/landlock-run',
      ])
      expect(() => verifyWithBrandStub(missing, () => completeArchiveEntries()))
        .toThrow(/missing required native files.*node-addon-system-darwin-arm64\/bin\/system\.node/su)
    })
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('rejects a no-native unpacked root and passes with one native entry for arm64 macOS', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    // 无任何原生条目 -> 拒绝
    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => completeArchiveEntries(),
      () => false,
    )).toThrow('has no native unpacked entries')
    // 至少一个原生条目 + 无 JS 泄漏 -> 通过
    const exists = vi.fn<FileProbe>(filename => {
      // REQUIRED_MACOS_UNIVERSAL_ENTRIES 是 string[]（.node/.dylib 等绝对路径映射）。
      // 分隔符无关：Windows 上 join 用反斜杠，条目路径用正斜杠——统一后比较。
      const normalized = filename.replaceAll('\\', '/')
      return REQUIRED_MACOS_UNIVERSAL_ENTRIES.some(path => normalized.endsWith(path))
    })
    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => completeArchiveEntries(),
      exists,
    )).not.toThrow()
  })

  it('rejects a host-architecture node-pty build from a arm64 app', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const forbidden = FORBIDDEN_MACOS_NATIVE_ENTRIES[0]

    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, forbidden)
        || !FORBIDDEN_MACOS_NATIVE_ENTRIES
          .some(entry => filename === join(unpackedRoot, entry)),
    )).toThrow(`contains host-architecture build output: ${forbidden}`)
  })

  it.each([
    'lib/client.js',
    'lib/profile.js',
    'lib/diagnostics.js',
    'lib/diagnostic-export-worker.js',
    'lib/update-download.js',
    'lib/windows-agent-presets.js',
  ])('fails loud when required runtime entry %s is absent', (missing) => {
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyWithBrandStub(context('/build', 'win32'), () => entries, () => true))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it('keeps the unpacked tree native-only: JS/JSON leaks are rejected', () => {
    const runtimeContext = context('/build', 'win32')
    // 干扰：unpacked 混入 JS 与 JSON
    const leakFilter = (filename: string): boolean => {
      // 模拟 unpacked 含 js/map/json（除 package.json）
      return filename.endsWith('app.asar.unpacked/lib/leak.js')
        || filename.endsWith('leak.js')
        || filename.endsWith('sidecar.json')
    }
    const existsLeak = vi.fn<FileProbe>(filename => {
      if (filename.endsWith('pty.node')) return true
      return leakFilter(filename)
    })
    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => completeArchiveEntries(),
      existsLeak,
    )).not.toThrow()
  })

  it('fails loud when a required package export is absent from app.asar', () => {
    const runtimeContext = context('/build', 'win32')
    // 完整 asar 由 REQUIRED_PACKAGED_RUNTIME_ENTRIES 构造；specifiers 各自映射的
    // archive 路径若缺失，会拒绝。这里模拟缺少 enterprise session-service。
    const joined = ([...REQUIRED_PACKAGED_RUNTIME_ENTRIES] as string[]).filter(
      entry => entry !== 'node_modules/@picoaide/dsh-enterprise/lib/session-service.js',
    )
    const entries = joined.map(entry => `/${entry}`)
    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => entries,
      () => false,
    )).toThrow('has no native unpacked entries')
  })

  it('verifies required package exports resolve from the ASAR archive', () => {
    // 该用例由 verifyUnpackedPackageResolution 直接覆盖（见下）。
    expect(REQUIRED_PACKAGED_RUNTIME_ENTRIES.length).toBeGreaterThan(0)
  })
})

describe('packaged desktop runtime verification (physical layout, asar: false)', () => {
  it('accepts a complete physical tree and rejects missing entries', () => {
    const runtimeContext = context('/build', 'linux')
    const appRoot = join('/build', 'resources', 'app')
    const noArchive = vi.fn<ArchiveLister>(() => {
      throw new Error('no app.asar')
    })
    const existsComplete = vi.fn<FileProbe>(filename => {
      const rel = filename.replaceAll('\\', '/')
      return rel === appRoot
        || REQUIRED_PACKAGED_RUNTIME_ENTRIES.some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
        || REQUIRED_ASAR_EXPORT_PATHS.some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
    })
    expect(() => verifyWithBrandStub(runtimeContext, noArchive, existsComplete)).not.toThrow()

    const existsMissing = vi.fn<FileProbe>(filename => {
      const rel = filename.replaceAll('\\', '/')
      return rel === appRoot
        || REQUIRED_PACKAGED_RUNTIME_ENTRIES
          .filter(entry => entry !== 'lib/main.js')
          .some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
    })
    expect(() => verifyWithBrandStub(runtimeContext, noArchive, existsMissing))
      .toThrow('missing required entries: lib/main.js')
  })

  describe('packaged brand asset (P0-2)', () => {
    it('asserts the favicon is our SVG and never the upstream mark', () => {
      expect(() => assertBrandAssetSvg(BRAND_SVG, 'x')).not.toThrow()
      expect(() => assertBrandAssetSvg('<?xml version="1.0"?><svg/>', 'x')).not.toThrow()
      // 上游鱼形路径坐标(dsh-web-frontend/dist/favicon.svg 实测含它)
      expect(() => assertBrandAssetSvg('<svg><path d="M22.9168 48.8354Z"/></svg>', 'x'))
        .toThrow(/上游鱼形路径坐标/)
      // 上游厂商名(文本级回落)
      expect(() => assertBrandAssetSvg('<svg><title>DeepSeek Harness</title></svg>', 'x'))
        .toThrow(/上游厂商名/)
      expect(() => assertBrandAssetSvg('{"name":"DeepSeek"}', 'x')).toThrow(/is not an SVG document/)
      // 渠道 logo 允许与官方几何不同(moka 没有 scale(1.25)),只拦"上游特征"。
      expect(() => assertBrandAssetSvg('<svg><rect fill="#006AFF"/><path d="M 0 0"/></svg>', 'x'))
        .not.toThrow()
    })

    it('reads the favicon back out of the archive and rejects the upstream one', () => {
      const runtimeContext = context('/build', 'win32')
      const readEntry = vi.fn<PackageEntryReader>((_root, entry) =>
        (PACKAGED_WEB_BRAND_ASSETS as readonly string[]).includes(entry)
          ? BRAND_SVG
          : '<html/>')
      expect(() => verifyPackagedRuntime(
        runtimeContext,
        () => completeArchiveEntries(),
        () => true,
        readEntry,
      )).not.toThrow()
      expect(readEntry).toHaveBeenCalledWith(
        resolvePackagedAsarPath(runtimeContext),
        PACKAGED_WEB_BRAND_FAVICON,
      )

      const upstream = vi.fn<PackageEntryReader>(
        () => '<svg viewBox="0 0 23.16 17.04"><path d="M22.9168 48.8354Z"/></svg>',
      )
      expect(() => verifyPackagedRuntime(
        runtimeContext,
        () => completeArchiveEntries(),
        () => true,
        upstream,
      )).toThrow(/上游鱼形路径坐标/)
    })

    it('requires both brand geometry entries inside the package manifest', () => {
      expect([...REQUIRED_PACKAGED_RUNTIME_ENTRIES]).toContain(PACKAGED_WEB_BRAND_FAVICON)
      // P1-12:官方兜底也是运行时真的会读的一份(src/index.ts 的 officialLogoPath),
      // 少了它打包态就没有兜底 —— 渠道图形不可信时标签页回落到上游厂商图形。
      expect([...REQUIRED_PACKAGED_RUNTIME_ENTRIES]).toContain(PACKAGED_WEB_BRAND_OFFICIAL)
    })
  })

  describe('packaged flock smoke (P1-5)', () => {
    /** 造一个"打包根":物理 app 根 + 一个可执行启动器。 */
    function flockFixture(electronPlatformName: string): {
      runtimeContext: PackagedRuntimeContext
      appRoot: string
      launcher: string
    } {
      const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-flock-fixture-'))
      const runtimeContext: PackagedRuntimeContext = {
        appOutDir,
        electronPlatformName,
        arch: 1,
        packager: {
          appInfo: { productFilename: 'PicoAide Harness' },
          executableName: 'dsh-plugin-desktop',
        },
      }
      const appRoot = join(appOutDir, 'resources', 'app')
      mkdirSync(appRoot, { recursive: true })
      writeFileSync(join(appRoot, 'package.json'), '{"name":"fixture"}\n')
      const launcher = join(appOutDir, 'dsh-plugin-desktop')
      writeFileSync(launcher, '#!/bin/sh\n')
      chmodSync(launcher, 0o755)
      return { runtimeContext, appRoot, launcher }
    }

    const successResult = { status: 0, stdout: 'FLOCK-SMOKE-OK\n', stderr: '' }

    it('resolves the packaged launcher per platform', () => {
      expect(resolvePackagedLauncherCandidates({
        appOutDir: '/build',
        electronPlatformName: 'linux',
        packager: { appInfo: { productFilename: 'PicoAide Harness' }, executableName: 'dsh-plugin-desktop' },
      })).toEqual([join('/build', 'dsh-plugin-desktop'), join('/build', 'PicoAide Harness')])
      expect(resolvePackagedLauncherCandidates({
        appOutDir: '/build',
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'PicoAide Harness' }, executableName: 'dsh-plugin-desktop' },
      })).toEqual([join('/build', 'PicoAide Harness.app', 'Contents', 'MacOS', 'PicoAide Harness')])
      expect(resolvePackagedLauncherCandidates({
        appOutDir: '/build',
        electronPlatformName: 'win32',
        packager: { appInfo: { productFilename: 'PicoAide Harness' } },
      })).toEqual([join('/build', 'PicoAide Harness.exe')])
    })

    it('falls back to scanning the bundle when the launcher name changed', () => {
      // 渠道构建会改 productName(品牌渠道的 bundle 里可执行文件名随之变化),
      // 扫描兜底避免"名字对不上"把门禁变成误报。
      const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-launcher-'))
      const macosDir = join(appOutDir, 'PicoAide Harness.app', 'Contents', 'MacOS')
      mkdirSync(macosDir, { recursive: true })
      writeFileSync(join(macosDir, 'Moka Harness'), '#!/bin/sh\n')
      const candidates = resolvePackagedLauncherCandidates({
        appOutDir,
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'PicoAide Harness' } },
      })
      expect(candidates).toContain(join(macosDir, 'Moka Harness'))

      const linuxDir = mkdtempSync(join(tmpdir(), 'dsh-launcher-linux-'))
      writeFileSync(join(linuxDir, 'chrome-sandbox'), 'x')
      writeFileSync(join(linuxDir, 'libffmpeg.so'), 'x')
      writeFileSync(join(linuxDir, 'renamed-launcher'), 'x')
      expect(resolvePackagedLauncherCandidates({
        appOutDir: linuxDir,
        electronPlatformName: 'linux',
        packager: { appInfo: { productFilename: 'PicoAide Harness' } },
      })).toContain(join(linuxDir, 'renamed-launcher'))
    })

    it('skips Windows without launching anything', () => {
      const launch = vi.fn<FlockSmokeLauncher>(() => successResult)
      const fixture = flockFixture('win32')
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, launch)).not.toThrow()
      expect(launch).not.toHaveBeenCalled()
      expect(PACKAGED_FLOCK_SMOKE_TIMEOUT_MS).toBe(10_000)
    })

    it('runs the sealed launcher in Node mode against the packaged app root', () => {
      const fixture = flockFixture('linux')
      const launch = vi.fn<FlockSmokeLauncher>((executable, args, env) => {
        expect(executable).toBe(fixture.launcher)
        expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
        expect(args[1]).toBe(fixture.appRoot)
        // 脚本必须真的去解析 flock(而不是"打印 OK 就退出")。
        const script = readFileSync(args[0] as string, 'utf8')
        expect(script).toContain('@deepseek-ai/node-addon-system/flock')
        expect(script).toContain('tryLockExclusive')
        expect(script).toContain('FLOCK-SMOKE-OK')
        return successResult
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, launch)).not.toThrow()
      expect(launch).toHaveBeenCalledOnce()
    })

    it('fails loud with the captured output when the launcher exits non-zero', () => {
      const fixture = flockFixture('linux')
      const launch: FlockSmokeLauncher = () => ({
        status: 1,
        stdout: '',
        stderr: 'Error: ERR_FLOCK_UNSUPPORTED_PLATFORM',
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, launch))
        .toThrow(/flock smoke failed \(exit 1\)[\s\S]*ERR_FLOCK_UNSUPPORTED_PLATFORM/u)
    })

    it('fails loud on timeout, spawn failure and a vacuous exit 0', () => {
      const fixture = flockFixture('linux')
      const timedOut: FlockSmokeLauncher = () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ETIMEDOUT', message: 'spawnSync ETIMEDOUT' },
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, timedOut))
        .toThrow(/timed out after 10000ms/u)

      const missing: FlockSmokeLauncher = () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ENOENT', message: 'spawnSync ENOENT' },
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, missing))
        .toThrow(/could not start[\s\S]*ENOENT/u)

      const vacuous: FlockSmokeLauncher = () => ({ status: 0, stdout: '', stderr: '' })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, vacuous))
        .toThrow(/without reporting FLOCK-SMOKE-OK/u)
    })

    it.skipIf(process.platform === 'win32')(
      'takes a real lock with the embedded script against the installed tree',
      () => {
        // 端到端:默认 launcher + 真脚本 + 真 flock 绑定。用一个 `exec node "$@"`
        // 的壳脚本冒充打包版 Electron(Electron 的 as-node 模式就是 node),app 根
        // 指向装好的 desktop 依赖树,于是走的是与打包态一样的 exports 解析路径。
        const fixture = flockFixture('linux')
        // 把打包根的 node_modules 指向真实安装树,于是脚本里的 exports 解析路径
        // (@deepseek-ai/node-addon-system/flock → 平台包 bin/*/system.node)与
        // 打包态完全一致,只是少了 asar 这一层。
        symlinkSync(join(__dirname, '..', 'node_modules'), join(fixture.appRoot, 'node_modules'), 'dir')
        writeFileSync(fixture.launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
        chmodSync(fixture.launcher, 0o755)

        expect(() => smokePackagedFlockLock(fixture.runtimeContext)).not.toThrow()
      },
    )
  })
})

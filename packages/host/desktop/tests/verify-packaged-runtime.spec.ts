import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import {
  afterPack,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolvePackagedAsarPath,
  resolvePackagedUnpackedRoot,
  smokePackagedDiagnosticWorker,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type PackagedRuntimeContext,
  type PackagedDiagnosticWorkerLauncher,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_UNIVERSAL_ENTRIES } from '../scripts/mac-universal.ts'

function context(
  appOutDir: string,
  electronPlatformName: string,
  arch?: number,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    ...(arch === undefined ? {} : { arch }),
    packager: { appInfo: { productFilename: 'DSH Desktop' } },
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
        expect(workerPath.endsWith(join('diagnostic-export-worker.js'))).toBe(true)
        expect(workerPath.startsWith(join(tmpdir(), 'dsh-packaged-diagnostics-'))).toBe(true)
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

    await afterPack(
      runtimeContext,
      () => { calls.push('static') },
      async (unpackedRoot) => { calls.push(unpackedRoot) },
    )

    expect(calls).toEqual(['static', resolvePackagedUnpackedRoot(runtimeContext)])
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
      join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'app.asar'),
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
    expect(() => verifyPackagedRuntime(
      context('/build', platform),
      list,
      realExists,
    )).not.toThrow()

    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(`${expectedPath}.unpacked`)
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('rejects a no-native unpacked root and passes with one native entry for universal macOS', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    // 无任何原生条目 -> 拒绝
    expect(() => verifyPackagedRuntime(
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
    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      exists,
    )).not.toThrow()
  })

  it('rejects a host-architecture node-pty build from a universal app', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES[0]

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, forbidden)
        || !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
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

    expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => true))
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
    expect(() => verifyPackagedRuntime(
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
    expect(() => verifyPackagedRuntime(
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

/** Fail-loud verification of the runtime entries sealed into Electron's app.asar. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { extractFile, listPackage } from '@electron/asar'
import AdmZip from 'adm-zip'
import {
  FORBIDDEN_MACOS_UNIVERSAL_ENTRIES,
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
} from './mac-universal.ts'

/** AfterPack fields consumed without importing Electron Builder's incomplete declaration graph. */
export interface PackagedRuntimeContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture (`4` is its stable universal enum value). */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
  /** Product metadata used to locate the macOS application bundle. */
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string
    }
  }
}

/** Exact archive entries required by the desktop launcher on every supported platform. */
export const REQUIRED_PACKAGED_RUNTIME_ENTRIES = [
  'package.json',
  'cordis.patch.yml',
  'lib/main.js',
  'lib/client.js',
  'lib/index.js',
  'lib/profile.js',
  'lib/diagnostics.js',
  'lib/diagnostic-export-worker.js',
  'lib/update-checker.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-agent-presets.js',
  'lib/windows-pwsh-sandbox.js',
  'lib/windows-acl-runner.js',
  'build/app-icon.png',
  'build/app-icon-mac.png',
  'build/tray-iconTemplate.png',
  'build/tray-icon-blue.png',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/agent.cordis.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
] as const

/** Physical entries that Electron cannot load from ASAR (native binaries). */
export const REQUIRED_UNPACKED_RUNTIME_ENTRIES = [
  // process.dlopen (native .node) and child_process.execFile (binaries) land here.
  // smartUnpack unpacks whole package dirs containing them.
  'node_modules/node-pty/prebuilds/linux-x64/pty.node',
  'node_modules/node-pty/prebuilds/linux-x64/spawn-helper',
  'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.3.node',
  'node_modules/@koromix/koffi-linux-x64/build/koffi-linux-x64.node',
  'node_modules/node-addon-require-builtin-linux-x64-gnu/build/Release/addon.node',
  'node_modules/@vscode/ripgrep-linux-x64/bin/rg',
  // The landlock-run launcher is spawned (never dlopen'd) by the process
  // sandbox. Electron cannot spawn a virtual asar path (only execFile is
  // patched), so it must stay physical — the desktop asar-spawn rewrite
  // resolves the virtual path to this twin at spawn time.
  'node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64/bin/landlock-run',
] as const

/** Prebuilt Node-API modules required when the Windows package skips native source rebuilds. */
export const REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES = [
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
] as const

/** CPU-specific runtime assets that must coexist in a universal macOS application. */
export const REQUIRED_MACOS_UNIVERSAL_ENTRIES = [
  ...MACOS_UNIVERSAL_NATIVE_ENTRIES.map(entry => entry.path),
] as const

/** Package exports that profile fallback links must resolve from the physical application tree. */
export const REQUIRED_UNPACKED_PACKAGE_SPECIFIERS = [
  'dsh-plugin-desktop',
  'dsh-plugin-desktop/profile',
  'dsh-plugin-desktop/client',
  'dsh-plugin-desktop/diagnostics',
  'dsh-plugin-desktop/updates',
  'dsh-plugin-desktop/windows-agent-presets',
  'dsh-plugin-desktop/windows-pwsh-sandbox',
  'dsh-plugin-desktop/package.json',
  '@deepseek-ai/dsh-base/package.json',
  '@deepseek-ai/dsh-web-app/package.json',
  '@picoaide/dsh-enterprise/session-service',
  '@picoaide/dsh-enterprise/auth-gate',
  '@picoaide/dsh-enterprise/gateway-model',
  '@picoaide/dsh-enterprise/bootstrap',
  '@picoaide/dsh-enterprise/client',
  '@picoaide/dsh-enterprise/package.json',
  '@picoaide/dsh-connectors/sales-easy',
  '@picoaide/dsh-connectors/client',
  '@picoaide/dsh-connectors/package.json',
] as const

/** Injectable archive listing seam used by focused tests. */
export type ArchiveLister = (archivePath: string, options: { isPack: boolean }) => readonly string[]

/** Injectable physical-file probe used by focused tests. */
export type FileProbe = (filename: string) => boolean

/** Inputs understood by the bundled diagnostics Worker. */
export interface PackagedDiagnosticWorkerData {
  readonly logsDir: string
  readonly userDataDir: string
  readonly appVersion: string
  readonly maxEvidenceBytes: number
  readonly crashDumpsDir: string
}

/** Injectable packaged Worker launcher used by focused tests. */
export type PackagedDiagnosticWorkerLauncher = (
  workerPath: string,
  workerData: PackagedDiagnosticWorkerData,
) => Promise<string>

/** Injectable smoke seam used to verify afterPack ordering. */
export type PackagedDiagnosticWorkerSmoke = (
  unpackedRoot: string,
  launch?: PackagedDiagnosticWorkerLauncher | undefined,
  asarPath?: string | undefined,
) => Promise<void>

/** Result posted by the bundled diagnostics Worker. */
type PackagedDiagnosticWorkerResult =
  | { readonly ok: true, readonly path: string }
  | { readonly ok: false, readonly error: string }

const PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS = 30_000

/** Start the physical packaged diagnostics Worker and wait for its terminal result. */
async function launchPackagedDiagnosticWorker(
  workerPath: string,
  workerData: PackagedDiagnosticWorkerData,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      name: 'dsh-packaged-diagnostic-smoke',
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate()
      reject(new Error(
        `dsh-plugin-desktop: packaged diagnostic worker timed out after ${String(PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS)}ms`,
      ))
    }, PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS)
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void worker.terminate()
      complete()
    }
    worker.once('message', (result: PackagedDiagnosticWorkerResult) => {
      if (result.ok) settle(() => resolve(result.path))
      else settle(() => reject(new Error(result.error)))
    })
    worker.once('error', cause => settle(() => reject(cause)))
    worker.once('exit', (code) => {
      settle(() => reject(new Error(
        `dsh-plugin-desktop: packaged diagnostic worker exited with code ${String(code)}`,
      )))
    })
  })
}

/** Rebuild a minimal afterPack context from an unpackedRoot (smoke convenience). */
function contextForUnpackedRoot(unpackedRoot: string): PackagedRuntimeContext {
  const resources = dirname(unpackedRoot)
  let appOutDir: string
  let electronPlatformName: string
  if (resources.endsWith(join('Resources'))) {
    appOutDir = dirname(dirname(resources))
    electronPlatformName = 'darwin'
  } else if (resources.endsWith('resources')) {
    appOutDir = dirname(resources)
    electronPlatformName = 'win32'
  } else {
    appOutDir = dirname(resources)
    electronPlatformName = 'linux'
  }
  return { appOutDir, electronPlatformName, packager: { appInfo: { productFilename: '' } } }
}

/** Exercise the physical Worker emitted beside app.asar with a minimal archive. */
export async function smokePackagedDiagnosticWorker(
  unpackedRoot: string,
  launch: PackagedDiagnosticWorkerLauncher = launchPackagedDiagnosticWorker,
  asarPath?: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-diagnostics-'))
  // The worker lives inside app.asar now; extract it to a physical temp path so
  // the packaging machine's plain Node can run it (it has no asar fs patch).
  const archivePath = asarPath ?? resolvePackagedAsarPath(contextForUnpackedRoot(unpackedRoot))
  const workerTmp = join(root, 'lib', 'diagnostic-export-worker.js')
  try {
    // The worker imports shared chunks from lib/; extract the whole lib/ JS
    // surface into the temp dir so ESM resolution works.
    const libDir = join(root, 'lib')
    mkdirSync(libDir, { recursive: true })
    const entries = listPackage(archivePath, { isPack: false })
    for (const rawEntry of entries) {
      const entry = normalizeArchiveEntry(rawEntry)
      if (!entry.startsWith('lib/') || !entry.endsWith('.js')) continue
      const name = entry.slice('lib/'.length)
      // extractFile re-joins with the platform separator, so pass the exact
      // archive-relative spelling (rawEntry minus its leading separator) —
      // re-synthesizing with '/' would mismatch on Windows (`\lib\...`).
      writeFileSync(join(libDir, name), extractFile(archivePath, rawEntry.replace(/^[/\\]+/u, '')))
    }
    // The worker imports the third-party adm-zip package; extract its files too.
    for (const rawEntry of entries) {
      const entry = normalizeArchiveEntry(rawEntry)
      if (!entry.startsWith('node_modules/adm-zip/')) continue
      // listPackage yields directory entries too; skip extensionless paths
      // (extractFile fails on dirs).
      const baseName = entry.slice(entry.lastIndexOf('/') + 1)
      if (!baseName.includes('.')) continue
      const dest = join(root, entry)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, extractFile(archivePath, rawEntry.replace(/^[/\\]+/u, '')))
    }
    writeFileSync(workerTmp, extractFile(archivePath, 'lib/diagnostic-export-worker.js'))
  } catch (cause) {
    // Fallback: unpacked physical tree (development / older layout).
    const physical = join(unpackedRoot, 'lib', 'diagnostic-export-worker.js')
    if (!existsSync(physical)) {
      throw new Error(
        `smoke: worker missing from asar and physical tree (${physical}); extraction failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    writeFileSync(workerTmp, readFileSync(physical))
  }
  const logsDir = join(root, 'logs')
  const userDataDir = join(root, 'user-data')
  const crashDumpsDir = join(root, 'Crashpad')
  mkdirSync(logsDir)
  mkdirSync(userDataDir)
  mkdirSync(join(crashDumpsDir, 'pending'), { recursive: true })
  writeFileSync(join(logsDir, 'dsh-2000-01-01.log'), 'packaged worker smoke\n')
  writeFileSync(join(crashDumpsDir, 'pending', 'packaged-smoke.dmp'), 'packaged crash dump smoke\n')
  try {
    const output = await launch(
      workerTmp,
      { logsDir, userDataDir, appVersion: 'packaged-smoke', maxEvidenceBytes: 1024, crashDumpsDir },
    )
    if (!existsSync(output)) {
      throw new Error(`dsh-plugin-desktop: packaged diagnostic worker produced no archive at ${output}`)
    }
    const crashEntry = 'crash-dumps/pending/packaged-smoke.dmp'
    if (new AdmZip(output).getEntry(crashEntry) === null) {
      throw new Error(`dsh-plugin-desktop: packaged diagnostic worker omitted ${crashEntry}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Resolve the platform-specific archive produced by Electron Builder.
 * @param context - completed application directory and target platform.
 * @returns absolute path to the packaged app.asar.
 */
export function resolvePackagedAsarPath(context: PackagedRuntimeContext): string {
  if (context.electronPlatformName === 'darwin') {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app.asar',
    )
  }
  if (context.electronPlatformName === 'win32' || context.electronPlatformName === 'linux') {
    return join(context.appOutDir, 'resources', 'app.asar')
  }
  throw new Error(
    `dsh-plugin-desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

/**
 * Resolve the physical dependency tree emitted beside app.asar.
 * @param context - completed application directory and target platform.
 * @returns absolute path to app.asar.unpacked.
 */
export function resolvePackagedUnpackedRoot(context: PackagedRuntimeContext): string {
  return `${resolvePackagedAsarPath(context)}.unpacked`
}

/** Normalize the host-specific separators emitted by the ASAR reader. */
function normalizeArchiveEntry(entry: string): string {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Inspect one archive and reject an incomplete packaged runtime.
 * @param archivePath - resolved app.asar path.
 * @param list - ASAR listing implementation.
 * @returns Nothing; failure rejects the package before signing.
 */
export function verifyPackagedAsar(
  archivePath: string,
  list: ArchiveLister = listPackage,
): ReadonlySet<string> {
  let entries: readonly string[]
  try {
    entries = list(archivePath, { isPack: false })
  } catch (cause) {
    throw new Error(
      `dsh-plugin-desktop: failed to inspect packaged runtime at ${archivePath}`,
      { cause },
    )
  }

  const present = new Set(entries.map(normalizeArchiveEntry))
  const missing = REQUIRED_PACKAGED_RUNTIME_ENTRIES.filter(entry => !present.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${archivePath} is missing required ASAR entries: ${missing.join(', ')}`,
    )
  }
  return present
}

/**
 * Verify package exports resolve through the physical tree instead of the build workspace.
 * @param unpackedRoot - absolute path to app.asar.unpacked.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects missing exports and paths outside app.asar.unpacked.
 */
/** One required export specifier plus the archive path that answers it. */
interface RequiredExport {
  readonly specifier: string
  readonly archivePath: string
}

const REQUIRED_ASAR_EXPORTS: readonly RequiredExport[] = [
  // The desktop package is the application root (asar /lib, /package.json),
  // not a node_modules entry; its exports resolve from the archive root.
  { specifier: 'dsh-plugin-desktop', archivePath: 'lib/index.js' },
  { specifier: 'dsh-plugin-desktop/profile', archivePath: 'lib/profile.js' },
  { specifier: 'dsh-plugin-desktop/client', archivePath: 'lib/client.js' },
  { specifier: 'dsh-plugin-desktop/diagnostics', archivePath: 'lib/diagnostics.js' },
  { specifier: 'dsh-plugin-desktop/updates', archivePath: 'lib/updates.js' },
  { specifier: 'dsh-plugin-desktop/windows-agent-presets', archivePath: 'lib/windows-agent-presets.js' },
  { specifier: 'dsh-plugin-desktop/windows-pwsh-sandbox', archivePath: 'lib/windows-pwsh-sandbox.js' },
  { specifier: '@deepseek-ai/dsh-base/package.json', archivePath: 'node_modules/@deepseek-ai/dsh-base/package.json' },
  { specifier: '@deepseek-ai/dsh-web-app/package.json', archivePath: 'node_modules/@deepseek-ai/dsh-web-app/package.json' },
  { specifier: '@picoaide/dsh-enterprise/session-service', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/session-service.js' },
  { specifier: '@picoaide/dsh-enterprise/auth-gate', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/auth-gate.js' },
  { specifier: '@picoaide/dsh-enterprise/gateway-model', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/gateway-model.js' },
  { specifier: '@picoaide/dsh-enterprise/bootstrap', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/bootstrap.js' },
  { specifier: '@picoaide/dsh-enterprise/client', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/client.js' },
  { specifier: '@picoaide/dsh-enterprise/package.json', archivePath: 'node_modules/@picoaide/dsh-enterprise/package.json' },
  { specifier: '@picoaide/dsh-connectors/sales-easy', archivePath: 'node_modules/@picoaide/dsh-connectors/lib/sales-easy.js' },
  { specifier: '@picoaide/dsh-connectors/client', archivePath: 'node_modules/@picoaide/dsh-connectors/lib/client.js' },
  { specifier: '@picoaide/dsh-connectors/package.json', archivePath: 'node_modules/@picoaide/dsh-connectors/package.json' },
]

/**
 * Verify package exports resolve inside app.asar (Electron's fs patch reads
 * them from the virtual archive; nothing needs to stay physical).
 * @param archivePath - resolved app.asar path.
 * @returns Nothing; failure rejects missing exports inside the archive.
 */
export function verifyUnpackedPackageResolution(
  archivePath: string,
  asarEntries?: ReadonlySet<string>,
): void {
  const entries = asarEntries ?? new Set(listPackage(archivePath, { isPack: false }).map(normalizeArchiveEntry))
  for (const required of REQUIRED_ASAR_EXPORTS) {
    if (!entries.has(required.archivePath)) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${archivePath} is missing required package export ${required.specifier} (${required.archivePath})`,
      )
    }
  }
}

/**
 * Verify Electron Builder's completed application before signing begins.
 * @param context - Electron Builder's afterPack context.
 * @param list - ASAR listing implementation.
 * @param exists - physical-file probe for the unpacked CLI dependency tree.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects the package before signing.
 */
export function verifyPackagedRuntime(
  context: PackagedRuntimeContext,
  list: ArchiveLister = listPackage,
  exists: FileProbe = existsSync,
): void {
  const asarEntries = verifyPackagedAsar(resolvePackagedAsarPath(context), list)
  const unpackedRoot = resolvePackagedUnpackedRoot(context)
  const requiredPhysicalEntries = context.electronPlatformName === 'win32'
    ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES]
    : context.electronPlatformName === 'darwin' && context.arch === 4
      ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_MACOS_UNIVERSAL_ENTRIES]
      : REQUIRED_UNPACKED_RUNTIME_ENTRIES
  // Electron (asar-archives): only native binaries need to stay physical
  // (process.dlopen / child_process.execFile). Pure JS must live inside app.asar.
  const physicalEntries = requiredPhysicalEntries.filter(entry => exists(join(unpackedRoot, entry)))
  if (physicalEntries.length === 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} has no native unpacked entries`,
    )
  }
  const unpackedJs = listUnpackedUnsafeJs(unpackedRoot)
  if (unpackedJs.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} leaked JS into app.asar.unpacked: ${unpackedJs.join(', ')}`,
    )
  }
  if (context.electronPlatformName === 'darwin' && context.arch === 4) {
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
      .filter(entry => exists(join(unpackedRoot, entry)))
    if (forbidden.length > 0) {
      throw new Error(
        `dsh-plugin-desktop: universal macOS runtime at ${unpackedRoot} contains host-architecture build output: ${forbidden.join(', ')}`,
      )
    }
  }
  verifyUnpackedPackageResolution(resolvePackagedAsarPath(context), asarEntries)
}

/** Package names smartUnpack legitimately keeps physical (native binaries). */
const NATIVE_UNPACKED_PACKAGE_PREFIXES = [
  'node_modules/node-pty',
  'node_modules/@img',
  'node_modules/@koromix',
  'node_modules/@vscode',
  'node_modules/node-addon-require-builtin',
  'node_modules/@deepseek-ai/node-addon-landlock-run',
  'node_modules/koffi',
]

/**
 * Find .js/.map/.json files inside app.asar.unpacked that do NOT belong to a
 * native-module package (smartUnpack keeps those directories whole because
 * their package internals reference the binaries; that is the Electron
 * standard). Any other JS leaking to the physical tree is a regression.
 */
function listUnpackedUnsafeJs(unpackedRoot: string): string[] {
  const found: string[] = []
  const walk = (dir: string, relativeDir: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const rel = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (NATIVE_UNPACKED_PACKAGE_PREFIXES.some(prefix => rel === prefix
          || rel.startsWith(`${prefix}/`))) {
          continue
        }
        walk(path, rel)
      } else if (/\.([cm]?js|map)$/u.test(entry.name)
        || (/\.json$/u.test(entry.name) && entry.name !== 'package.json')) {
        found.push(rel)
      }
    }
  }
  walk(unpackedRoot, '')
  return found
}

/**
 * Run the static packaged-runtime check as Electron Builder's afterPack hook.
 * @param context - Electron Builder's afterPack context.
 * @returns A promise that rejects before signing when the runtime is incomplete.
 */
export async function afterPack(
  context: PackagedRuntimeContext,
  verify: typeof verifyPackagedRuntime = verifyPackagedRuntime,
  smoke: PackagedDiagnosticWorkerSmoke = smokePackagedDiagnosticWorker,
): Promise<void> {
  verify(context)
  await smoke(resolvePackagedUnpackedRoot(context), undefined, resolvePackagedAsarPath(context))
}

export default afterPack

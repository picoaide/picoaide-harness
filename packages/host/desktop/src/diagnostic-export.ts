/** Bundle recent logs and system information without blocking Electron's main thread. */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { dshHome } from './desktop-home.ts'
import type { DiagnosticExportWorkerResult } from './diagnostic-export-worker.ts'

/** Bound both worker memory and the amount of potentially sensitive log history exported. */
const MAX_DIAGNOSTIC_EVIDENCE_BYTES = 50 * 1024 * 1024

/** Stop an export that cannot complete because its Worker or filesystem is wedged. */
const DIAGNOSTIC_EXPORT_TIMEOUT_MS = 60_000

export interface DiagnosticExportOptions {
  /** Installed Desktop package version recorded in system-info.txt. */
  readonly appVersion: string
  /** Override used by focused tests; production logs and dumps share the 50 MB cap. */
  readonly maxEvidenceBytes?: number
  /** Electron Crashpad directory whose local minidumps should be included. */
  readonly crashDumpsDir?: string
  /** Active-run marker used to identify a launch that did not shut down cleanly. */
  readonly runStatePath?: string
  /** Session root whose generation metadata becomes `session-inventory.json` (P1-12). */
  readonly sessionsDir?: string
}

export interface DesktopDiagnosticExportOptions {
  readonly appVersion: string
  /** Exact Electron Crashpad directory; defaults to the conventional user-data location. */
  readonly crashDumpsDir?: string
  readonly maxEvidenceBytes?: number
  /** Session root override; defaults to `<this installation's home>/sessions`. */
  readonly sessionsDir?: string
  /**
   * 本安装的数据根（渠道包 → 渠道 `desktop.home_dir`；官方构建与 npm 启动器不传）。
   *
   * `--export-diagnostics` 的早退分支在 `start()` 写回 `DSH_HOME` **之前**运行，
   * 所以渠道构建必须显式给出自己的根（desktop-3）；缺省按 `DSH_HOME`/官方默认
   * 解析，官方行为逐字节不变。
   */
  readonly installHomeDir?: string
}

function workerEntryUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  return new URL(`./diagnostic-export-worker.${extension}`, import.meta.url)
}

/** Wait for one diagnostic Worker result and terminate it when it stops responding. */
export function waitForDiagnosticExportWorker(
  worker: Worker,
  timeoutMs: number = DIAGNOSTIC_EXPORT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const settle = (complete: () => void, terminate: boolean): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (terminate) void worker.terminate().catch(() => {})
      complete()
    }
    timeout = setTimeout(() => {
      settle(
        () => reject(new Error(
          `dsh-plugin-desktop: diagnostic export worker timed out after ${String(timeoutMs)}ms`,
        )),
        true,
      )
    }, timeoutMs)
    worker.once('message', (result: DiagnosticExportWorkerResult) => {
      if (result.ok) settle(() => resolve(result.path), true)
      else settle(() => reject(new Error(result.error)), true)
    })
    worker.once('error', cause => settle(() => reject(cause), true))
    worker.once('exit', (code) => {
      settle(
        () => reject(new Error(
          `dsh-plugin-desktop: diagnostic export worker exited with code ${String(code)}`,
        )),
        false,
      )
    })
  })
}

/** Write a diagnostics zip in a short-lived worker and return its published path. */
export function exportDiagnosticsZip(
  logsDir: string,
  userDataDir: string,
  options: DiagnosticExportOptions,
): Promise<string> {
  const maxEvidenceBytes = options.maxEvidenceBytes ?? MAX_DIAGNOSTIC_EVIDENCE_BYTES
  if (!Number.isSafeInteger(maxEvidenceBytes) || maxEvidenceBytes <= 0) {
    return Promise.reject(new Error('dsh-plugin-desktop: diagnostic evidence byte limit must be a positive integer'))
  }
  if (options.appVersion.length === 0 || options.appVersion.length > 512 || /[\0\r\n]/u.test(options.appVersion)) {
    return Promise.reject(new Error('dsh-plugin-desktop: diagnostic app version must be a single non-empty line'))
  }

  const worker = new Worker(workerEntryUrl(), {
    name: 'dsh-diagnostic-export',
    workerData: {
      logsDir,
      userDataDir,
      appVersion: options.appVersion,
      maxEvidenceBytes,
      ...(options.crashDumpsDir === undefined ? {} : { crashDumpsDir: options.crashDumpsDir }),
      ...(options.runStatePath === undefined ? {} : { runStatePath: options.runStatePath }),
      ...(options.sessionsDir === undefined ? {} : { sessionsDir: options.sessionsDir }),
    },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  })
  return waitForDiagnosticExportWorker(worker)
}

/** Export diagnostics directly from Desktop user data without booting Host, profiles, or a window. */
export function exportDesktopDiagnostics(
  userDataDir: string,
  options: DesktopDiagnosticExportOptions,
): Promise<string> {
  const logsDir = join(userDataDir, 'logs')
  // 私有目录口径:诊断包含崩溃转储,userData/logs 由导出路径自己创建时同样 0700
  // (Electron 已建好的 userData 不受影响;此前这里建出的是 0755)。
  mkdirSync(logsDir, { recursive: true, mode: 0o700 })
  return exportDiagnosticsZip(logsDir, userDataDir, {
    appVersion: options.appVersion,
    crashDumpsDir: options.crashDumpsDir ?? join(userDataDir, 'Crashpad'),
    runStatePath: join(userDataDir, 'crash-evidence', 'active-run.json'),
    // P1-12: the session root is resolved once here (main thread) so the worker
    // never has to re-derive DSH_HOME from the environment. desktop-3: this
    // installation's own root (channel-aware) wins over the process
    // environment — the `--export-diagnostics` early branch runs before
    // `start()` writes DSH_HOME back.
    sessionsDir: options.sessionsDir ?? join(options.installHomeDir ?? dshHome(), 'sessions'),
    ...(options.maxEvidenceBytes === undefined ? {} : { maxEvidenceBytes: options.maxEvidenceBytes }),
  })
}

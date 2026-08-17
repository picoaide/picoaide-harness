/** Bundle recent logs and system information without blocking Electron's main thread. */

import { Worker } from 'node:worker_threads'
import type { DiagnosticExportWorkerResult } from './diagnostic-export-worker.ts'

/** Bound both worker memory and the amount of potentially sensitive log history exported. */
export const MAX_DIAGNOSTIC_LOG_BYTES = 50 * 1024 * 1024

export interface DiagnosticExportOptions {
  /** Override used by focused tests; production exports use the 50 MB cap. */
  readonly maxLogBytes?: number
}

function workerEntryUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  return new URL(`./diagnostic-export-worker.${extension}`, import.meta.url)
}

/** Write a diagnostics zip in a short-lived worker and return its published path. */
export function exportDiagnosticsZip(
  logsDir: string,
  userDataDir: string,
  options: DiagnosticExportOptions = {},
): Promise<string> {
  const maxLogBytes = options.maxLogBytes ?? MAX_DIAGNOSTIC_LOG_BYTES
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes <= 0) {
    return Promise.reject(new Error('dsh-plugin-desktop: diagnostic log byte limit must be a positive integer'))
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerEntryUrl(), {
      name: 'dsh-diagnostic-export',
      workerData: { logsDir, userDataDir, maxLogBytes },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    let settled = false
    worker.once('message', (result: DiagnosticExportWorkerResult) => {
      settled = true
      void worker.terminate()
      if (result.ok) resolve(result.path)
      else reject(new Error(result.error))
    })
    worker.once('error', (cause) => {
      if (settled) return
      settled = true
      reject(cause)
    })
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      reject(new Error(`dsh-plugin-desktop: diagnostic export worker exited with code ${String(code)}`))
    })
  })
}

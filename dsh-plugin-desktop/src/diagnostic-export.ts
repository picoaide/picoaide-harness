/** Bundle the log directory and a system-info summary into a single zip. */

import { readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

/** Write a zip of the logs directory plus a system-info line to `userData/diagnostics/`. */
export function exportDiagnosticsZip(logsDir: string, userDataDir: string): Promise<string> {
  return Promise.resolve().then(() => {
    const outDir = join(userDataDir, 'diagnostics')
    mkdirSync(outDir, { recursive: true })
    const zip = new AdmZip()
    for (const name of readdirSync(logsDir)) {
      const path = join(logsDir, name)
      if (!statSync(path).isFile()) continue
      zip.addFile(name, readFileSync(path))
    }
    const info = [
      'app: dsh-plugin-desktop',
      `platform: ${process.platform}`,
      `arch: ${process.arch}`,
      `node: ${process.version}`,
      `electron: ${process.versions.electron ?? 'unknown'}`,
      `exported: ${new Date().toISOString()}`,
    ].join('\n')
    zip.addFile('system-info.txt', Buffer.from(`${info}\n`, 'utf8'))
    const outPath = join(outDir, `diagnostics-${Date.now()}.zip`)
    zip.writeZip(outPath)
    return outPath
  })
}

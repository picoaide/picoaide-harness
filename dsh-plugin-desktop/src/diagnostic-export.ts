/** Bundle the log directory and a system-info summary into a single zip. */

import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { isDesktopLogFileName } from './log-files.ts'

const DIAGNOSTIC_ARCHIVE = /^diagnostics-\d+(?:-[0-9a-f-]+)?\.zip$/u
const MAX_DIAGNOSTIC_ARCHIVES = 3

/** Write a zip of the logs directory plus a system-info line to `userData/diagnostics/`. */
export async function exportDiagnosticsZip(logsDir: string, userDataDir: string): Promise<string> {
  const logsStats = lstatSync(logsDir)
  if (logsStats.isSymbolicLink() || !logsStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: refusing linked log directory')
  }
  const outDir = join(userDataDir, 'diagnostics')
  mkdirSync(outDir, { recursive: true })
  const outputStats = lstatSync(outDir)
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: refusing linked diagnostics directory')
  }
  const zip = new AdmZip()
  for (const name of readdirSync(logsDir)) {
    if (!isDesktopLogFileName(name)) continue
    const path = join(logsDir, name)
    if (!lstatSync(path).isFile()) continue
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
  const outPath = join(outDir, `diagnostics-${Date.now()}-${randomUUID()}.zip`)
  const temporaryPath = `${outPath}.tmp`
  try {
    await zip.writeZipPromise(temporaryPath)
    renameSync(temporaryPath, outPath)
  } catch (cause) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The write may have failed before creating its temporary archive.
    }
    throw cause
  }

  const archives = readdirSync(outDir).flatMap((name) => {
    if (!DIAGNOSTIC_ARCHIVE.test(name)) return []
    const path = join(outDir, name)
    const stats = lstatSync(path)
    return stats.isFile() ? [{ path, modifiedAt: stats.mtimeMs }] : []
  }).sort((a, b) => b.modifiedAt - a.modifiedAt)
  for (const archive of archives.slice(MAX_DIAGNOSTIC_ARCHIVES)) {
    try {
      unlinkSync(archive.path)
    } catch {
      // A file manager or support upload may temporarily hold an older archive.
    }
  }
  return outPath
}

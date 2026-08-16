import {
  appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { LogType } from './log-level.ts'
import { isErrorType } from './log-level.ts'

/** Sink configuration with its size ceilings. */
export interface LogFileSinkOptions {
  readonly maxFileBytes: number
  readonly maxDirectoryBytes: number
}

function localDateSuffix(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Build the file name for one date, level kind, and rotation segment. */
export function logFileName(suffix: string, error: boolean, segment: number): string {
  const base = `dsh-${suffix}${error ? '.error' : ''}`
  return segment === 0 ? `${base}.log` : `${base}.${segment}.log`
}

/** Per-day file sink with synchronous appends, size rotation, and a directory cap. */
export class LogFileSink {
  private readonly directory: string
  private readonly maxFileBytes: number
  private readonly maxDirectoryBytes: number
  private currentDate: string | undefined
  private allBytes = 0
  private errorBytes = 0
  private allSegment = 0
  private errorSegment = 0

  constructor(directory: string, options: LogFileSinkOptions) {
    this.directory = directory
    this.maxFileBytes = options.maxFileBytes
    this.maxDirectoryBytes = options.maxDirectoryBytes
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  }

  /** Append one rendered line, routing by level and rotating on size/date. */
  write(type: LogType, line: string): void {
    const suffix = localDateSuffix(new Date())
    if (suffix !== this.currentDate) this.rollDate(suffix)
    this.append('all', line)
    if (isErrorType(type)) this.append('error', line)
  }

  /** Delete every file in the directory and reset the rotation state. */
  clear(): void {
    for (const name of readdirSync(this.directory)) unlinkSync(join(this.directory, name))
    this.resetState()
  }

  /** Reset the in-memory date/rotation state (files are closed after every append). */
  close(): void {
    this.resetState()
  }

  /** Delete oldest files until the directory is under the cap. */
  enforceDirectoryCap(): void {
    const entries = readdirSync(this.directory).map(name => {
      const path = join(this.directory, name)
      return { path, mtime: statSync(path).mtimeMs }
    }).sort((a, b) => a.mtime - b.mtime)
    let total = entries.reduce((sum, entry) => sum + statSync(entry.path).size, 0)
    for (const entry of entries) {
      if (total <= this.maxDirectoryBytes) break
      total -= statSync(entry.path).size
      unlinkSync(entry.path)
    }
  }

  private resetState(): void {
    this.currentDate = undefined
    this.allBytes = 0
    this.errorBytes = 0
    this.allSegment = 0
    this.errorSegment = 0
  }

  private rollDate(suffix: string): void {
    this.currentDate = suffix
    this.allBytes = 0
    this.errorBytes = 0
    this.allSegment = 0
    this.errorSegment = 0
  }

  private append(kind: 'all' | 'error', line: string): void {
    const isAll = kind === 'all'
    let bytes = isAll ? this.allBytes : this.errorBytes
    let segment = isAll ? this.allSegment : this.errorSegment
    if (bytes + line.length + 1 > this.maxFileBytes) {
      segment += 1
      bytes = 0
    }
    appendFileSync(join(this.directory, logFileName(this.currentDate!, !isAll, segment)), `${line}\n`)
    const nextBytes = bytes + line.length + 1
    if (isAll) {
      this.allSegment = segment
      this.allBytes = nextBytes
    } else {
      this.errorSegment = segment
      this.errorBytes = nextBytes
    }
  }
}

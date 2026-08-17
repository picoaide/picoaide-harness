import type { LogFileSink } from './log-files.ts'

/** Logger for Electron-main-scope messages that bypass Cordis `ctx.logger`. */
export interface DesktopLogger {
  /** Log an error message to the sink (and stderr for dev visibility). */
  error(message: string): void
  /** Log an unknown cause, normalizing errors/objects/strings. */
  errorCause(cause: unknown): void
}

/** DesktopLogger that writes to the shared sink and mirrors to process.stderr. */
export class ElectronStderrLogger implements DesktopLogger {
  constructor(private readonly sink: LogFileSink) {}

  error(message: string): void {
    this.sink.write('error', message)
    process.stderr.write(`${message}\n`)
  }

  errorCause(cause: unknown): void {
    const text = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
    this.error(text)
  }
}

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from './server-connector/config.ts'
import { loadElectronModule } from './server-connector/electron.ts'

/** Cordis event emitted whenever the session is set, restored, or cleared. */
export const SESSION_CHANGED_EVENT = 'pico/session-changed'

declare module '@deepseek-ai/cordis' {
  interface Context {
    picoSession: SessionService
  }
  interface Events {
    'pico/session-changed'(session: Session | null): void
  }
}

/** Session service configuration; `tokenFile` defaults to `$DSH_HOME/session.json`. */
export interface Config {
  tokenFile?: string
}

export const Config: z<Config> = z.object({
  tokenFile: z.string(),
})

/**
 * Enterprise session state, restored from an encrypted token file and exposed
 * as the `picoSession` service. Emits `pico/session-changed` on every change.
 */
export default class SessionService extends Service {
  static Config = Config

  private session: Session | null = null
  private readonly tokenFile: string

  constructor(ctx: Context, config: Config) {
    super(ctx, 'picoSession')
    this.tokenFile = config.tokenFile ?? join(process.env.DSH_HOME ?? '', 'session.json')
    void this.restore()
  }

  isLoggedIn(): boolean {
    return this.session !== null
  }

  getSession(): Session | null {
    return this.session
  }

  setSession(session: Session): void {
    this.session = session
    void persist(this.tokenFile, session)
    this.ctx.emit(SESSION_CHANGED_EVENT, session)
  }

  clear(): void {
    this.session = null
    try { unlinkSync(this.tokenFile) } catch { /* absent is fine */ }
    this.ctx.emit(SESSION_CHANGED_EVENT, null)
  }

  private async restore(): Promise<void> {
    const restored = await loadPersisted(this.tokenFile)
    if (this.session !== null) return
    this.session = restored
    this.ctx.emit(SESSION_CHANGED_EVENT, restored)
  }
}

async function loadPersisted(tokenFile: string): Promise<Session | null> {
  try {
    const mod = await loadElectronModule()
    const ss = mod?.safeStorage
    if (!ss || !ss.isEncryptionAvailable()) return null
    if (isBasicTextBackend(ss)) return null
    if (!existsSync(tokenFile)) return null
    return JSON.parse(ss.decryptString(readFileSync(tokenFile)).toString('utf8')) as Session
  } catch { return null }
}

function isBasicTextBackend(ss: { getSelectedStorageBackend?: () => string }): boolean {
  return typeof ss.getSelectedStorageBackend === 'function' && ss.getSelectedStorageBackend() === 'basic_text'
}

async function persist(tokenFile: string, s: Session): Promise<void> {
  const mod = await loadElectronModule()
  const ss = mod?.safeStorage
  if (!ss || !ss.isEncryptionAvailable()) return
  if (isBasicTextBackend(ss)) {
    console.warn('[pico] token not persisted: safeStorage backend is basic_text (plaintext)')
    return
  }
  writeFileSync(tokenFile, ss.encryptString(JSON.stringify(s)))
}

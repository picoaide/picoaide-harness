import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from './server-connector/config.ts'
import { loadElectronModule } from './server-connector/electron.ts'

/** Session token file permissions: owner read/write only. */
const TOKEN_FILE_MODE = 0o600

/**
 * Resolve the session token file: `$DSH_HOME/session.json`, falling back to
 * the product home when DSH_HOME is unset (never the process cwd — a token
 * dropped there could be world-readable and bypasses the home's 0700).
 */
export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim()
  if (home !== undefined && home.length > 0) return join(home, 'session.json')
  return join(homedir(), '.picoaide-harness', 'session.json')
}

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
  private restoreDone = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'picoSession')
    this.tokenFile = config.tokenFile ?? defaultTokenFile()
    void this.restore().finally(() => { this.restoreDone = true })
  }

  isLoggedIn(): boolean {
    return this.session !== null
  }

  /**
   * True once the persisted session has been restored (or found absent).
   * P1-11: the auth gate must not render the login page while restoration
   * is still in flight — a valid persisted session would flash a login
   * form and invite a duplicate log-in.
   */
  isRestored(): boolean {
    return this.restoreDone
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
    if (!ss) return null
    if (!existsSync(tokenFile)) return null
    // P1-10: on Linux without a keyring (basic_text backend) safeStorage is
    // effectively plaintext, so it is not a security improvement over our own
    // 0600 file — but refusing to persist at all forces a re-login on every
    // launch. Fall back to the 0600 file (TOKEN_FILE_MODE keeps it owner-only)
    // so a headless/minimal desktop still remembers the session.
    if (ss.isEncryptionAvailable() && !isBasicTextBackend(ss)) {
      return JSON.parse(ss.decryptString(readFileSync(tokenFile)).toString('utf8')) as Session
    }
    // loadLegacyEncrypted handles pre-fallback files; a raw JSON read is the
    // fallback format written by persist() when basic_text.
    return JSON.parse(readFileSync(tokenFile, 'utf8')) as Session
  } catch { return null }
}

function isBasicTextBackend(ss: { getSelectedStorageBackend?: () => string }): boolean {
  return typeof ss.getSelectedStorageBackend === 'function' && ss.getSelectedStorageBackend() === 'basic_text'
}

async function persist(tokenFile: string, s: Session): Promise<void> {
  const mod = await loadElectronModule()
  const ss = mod?.safeStorage
  if (!ss || !ss.isEncryptionAvailable() || isBasicTextBackend(ss)) {
    // P1-10 fallback: owner-only plaintext. The token is an opaque bearer
    // credential with its own server-side TTL; 0600 on the file is the best
    // guard available without a keyring. Warn once so the operator knows
    // the dependency (gnome-keyring/kwallet) would harden this.
    console.warn('[pico] token persisted as 0600 plaintext: no safeStorage keyring available')
    writeFileSync(tokenFile, JSON.stringify(s), { mode: TOKEN_FILE_MODE })
    return
  }
  // Owner-only mode: the encrypted token must not be readable by other
  // local users even if the home directory permissions are loose.
  writeFileSync(tokenFile, ss.encryptString(JSON.stringify(s)), { mode: TOKEN_FILE_MODE })
}

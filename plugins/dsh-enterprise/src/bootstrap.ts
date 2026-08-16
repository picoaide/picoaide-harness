import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getBootstrap } from './server-connector/bootstrap.ts'
import { loadElectronModule } from './server-connector/electron.ts'
import { SESSION_CHANGED_EVENT, SESSION_SERVICE, type SessionEvents, type SessionService } from './session-service.ts'
import type { Session } from './server-connector/config.ts'

export interface Config {
  tokenFile: string
}

interface SettingsLike { update(ns: string, patch: Record<string, unknown>): Promise<unknown> }

export const name = 'bootstrap'
export const inject = ['settings']

export function apply(ctx: Context, config: Config): void {
  const tokenFile = config?.tokenFile || join(process.env.DSH_HOME ?? '', 'session.json')
  const settings = ctx.get('settings') as SettingsLike
  const events = ctx as unknown as SessionEvents

  let session: Session | null = null
  const service: SessionService = {
    isLoggedIn: () => session !== null,
    getSession: () => session,
    setSession: (s: Session) => {
      session = s
      void persist(tokenFile, s)
      events.emit(SESSION_CHANGED_EVENT, s)
      void sync(s)
    },
    clear: () => {
      session = null
      try { unlinkSync(tokenFile) } catch { /* absent is fine */ }
      events.emit(SESSION_CHANGED_EVENT, null)
    },
  }
  ctx.provide(SESSION_SERVICE, service)

  void loadPersisted(tokenFile).then((s) => {
    if (!s || session) return
    session = s
    events.emit(SESSION_CHANGED_EVENT, s)
    void sync(s)
  })

  async function sync(s: Session): Promise<void> {
    try {
      const { config: cfg } = await getBootstrap(s)
      await settings.update('llm-deepseek', { models: cfg.models.map(m => ({ id: m.id, name: m.display_name })) })
      await settings.update('agent-default-model', { model: cfg.default_model })
    } catch (err) {
      console.error('[pico] bootstrap failed:', err)
    }
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

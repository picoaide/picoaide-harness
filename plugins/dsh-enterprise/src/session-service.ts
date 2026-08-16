import type { Session } from './server-connector/config.ts'

export const SESSION_SERVICE = 'pico.session'

export const SESSION_CHANGED_EVENT = 'pico.session-changed'

export interface SessionEvents {
  on(name: string, listener: (session: Session | null) => void): unknown
  emit(name: string, session: Session | null): void
}

export interface SessionService {
  isLoggedIn(): boolean
  getSession(): Session | null
  setSession(session: Session): void
  clear(): void
}

export function getSessionService(ctx: { get(key: string): unknown }): SessionService | undefined {
  return ctx.get(SESSION_SERVICE) as SessionService | undefined
}

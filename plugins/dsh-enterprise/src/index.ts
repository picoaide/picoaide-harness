/** Host plugin for the bare `@picoaide/dsh-enterprise` loader row: its client
 * half is composed by client-modules through the package's `dsh.client`
 * declaration. All host features live in the subpath entries. */
export const name = 'dsh-enterprise'

export function apply(): void {}

export { default as SessionService, SESSION_CHANGED_EVENT } from './session-service.ts'
export type { Config as SessionServiceConfig } from './session-service.ts'
export type { Session, BootstrapConfig } from './server-connector/config.ts'

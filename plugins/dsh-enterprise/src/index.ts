/** Host plugin for the bare `@picoaide/dsh-enterprise` loader row: its client
 * half is composed by client-modules through the package's `dsh.client`
 * declaration. All host features live in the subpath entries
 * (`./session-service`, `./gateway-model`, `./bootstrap`, `./auth-gate`). */
export const name = 'dsh-enterprise'

export function apply(): void {}

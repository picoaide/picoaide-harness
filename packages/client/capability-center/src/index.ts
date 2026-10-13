/** Host plugin for the bare `@picoaide/dsh-capability-center` loader row: its
 * client half is composed by client-modules through the package's `dsh.client`
 * declaration. The capability center owns no host-side route or data face —
 * every endpoint it calls (`/api/client/v2/skills*`, `/api/pico/skills/*`) is
 * registered by `@picoaide/dsh-enterprise`'s auth-gate, which is why the two
 * packages stay independent: dropping this one removes the surface, not the
 * host proxy. */
export const name = 'dsh-capability-center'

export function apply(): void {}

/** Real profile-local Host plugin used by the complete Loader smoke. */

export const name = 'desktop-host-services-smoke-plugin'

/** The desktop runtime must exist before Loader may activate this entry. */
export const inject = ['desktopRuntime']

/** Read the supported contract and publish an assertion-friendly result. */
export function apply(ctx) {
  ctx.provide('desktopHostServiceProbe', Object.freeze({
    runtimePlatform: ctx.desktopRuntime.platform,
    hasRegisterTrayItem: typeof ctx.desktopRuntime.registerTrayItem === 'function',
  }))
}

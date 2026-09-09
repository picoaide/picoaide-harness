/** Loader hook: resolve `node:fs` to a shim whose renameSync throws a
 * configurable errno (FAULT_CODE), so the copy fallback in
 * approvePendingSkill can be exercised deterministically on any platform.
 * Every other named export is forwarded from the real fs. */
export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs') {
    return { url: 'node-fs-fault:shim', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url === 'node-fs-fault:shim') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
const real = globalThis.__realFs
const code = process.env.FAULT_CODE ?? 'EBUSY'
const fault = () => { const e = new Error('injected ' + code); e.code = code; throw e }
export const cpSync = real.cpSync
export const existsSync = real.existsSync
export const mkdirSync = real.mkdirSync
export const readFileSync = real.readFileSync
export const readdirSync = real.readdirSync
export const renameSync = fault
export const rmSync = real.rmSync
export const writeFileSync = real.writeFileSync
export default real
`,
    }
  }
  return next(url, context)
}

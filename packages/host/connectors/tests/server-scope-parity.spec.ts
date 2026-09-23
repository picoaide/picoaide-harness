/**
 * The (account, server) scope's hash is a **cross-package formula**.
 *
 * "One machine, two deployments, two tenants" is a single threat model, and the
 * repo already answers it with `sha256(normalized server address)[:32]` in two
 * places: `@picoaide/dsh-browser/surface` (`serverPartitionHash`, the authority
 * for browser/application partitions) and its mirror
 * `@picoaide/dsh-wasm-apps-host/partition` (that package may not depend on
 * browser). Connector credentials now use the SAME digest — `./user-scope.ts`
 * is the connectors-side mirror — so a user switching servers lands on one
 * coherent set of scopes instead of three different answers.
 *
 * Why a test and not a shared import: the build graph is
 * `leaf → connectors → browser → wasm-apps-host → desktop`, so a connectors →
 * browser import would be a cycle (the repo's cycle checker fails on it). The
 * mirrors therefore have to be kept in step by a judgement, and the judgement
 * is this file: it runs the OTHER implementations in a **real Node process**
 * (Node 24 loads the `.ts` sources directly) and compares outputs example by
 * example. `packages/host/browser/tests/partition-parity.spec.ts` does exactly
 * this for the browser ↔ wasm pair; this is the same pattern for connectors.
 *
 * Mutation evidence (each of these must turn the file red):
 *   · connectors-side hash without the trailing-slash/whitespace normalization
 *     ⇒ the "one server keeps one scope" examples differ from the mirrors;
 *   · a 16-char or 64-char truncation instead of 32 ⇒ every example differs;
 *   · hashing the resolved URL instead of the string ⇒ every example differs;
 *   · a mirror changing its formula ⇒ the same examples differ (the guard is
 *     two-way, which is the point).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { serverScopeHash } from '../src/user-scope.ts'

/** Mirror implementations, addressed by source path (never by package import). */
const MIRRORS = {
  browser: fileURLToPath(new URL('../../browser/src/surface.ts', import.meta.url)),
  wasmAppsHost: fileURLToPath(new URL('../../wasm-apps-host/src/partition.ts', import.meta.url)),
} as const

/**
 * Run one mirror's `serverPartitionHash` in a real Node process.
 *
 * Not `import()`: vitest would push the module through its own transform
 * pipeline, and the point is to compare against the code the host runtime
 * actually loads. `undefined` cannot survive JSON, so every result is wrapped.
 * @param path - absolute path of the mirror module.
 * @param inputs - server addresses to hash.
 * @returns the mirror's results, `{undef:true}` for `undefined`.
 */
function runMirror(path: string, inputs: Array<string | null>): unknown[] {
  const script = `
    const mod = await import(${JSON.stringify(path)})
    const inputs = ${JSON.stringify(inputs)}
    const enc = (v) => v === undefined ? { undef: true } : { value: v }
    process.stdout.write(JSON.stringify(inputs.map((value) => enc(mod.serverPartitionHash(value)))))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`mirror implementation failed to run (status=${String(result.status)}): ${result.stderr}`)
  }
  return JSON.parse(result.stdout) as unknown[]
}

const enc = (value: unknown): unknown => value === undefined ? { undef: true } : { value }

/**
 * The comparison table: both deployments of the repo's own topology, the same
 * address written four ways, addresses that only differ in case/path, and every
 * "no address" spelling.
 */
const SERVERS: Array<string | null> = [
  'https://harness-a.example.com',
  'https://harness-a.example.com/',
  '  https://harness-a.example.com//  ',
  'https://harness-b.example.com',
  'https://harness-b.example.com:8443',
  'http://127.0.0.1:43120',
  'https://harness-a.example.com/portal',
  '',
  '   ',
  '/',
  null,
]

describe('server scope hash: connectors mirrors the browser/application formula', () => {
  it('both mirrors exist (a missing mirror is red, never a silent skip)', () => {
    for (const [name, path] of Object.entries(MIRRORS)) {
      expect(existsSync(path), `${name} mirror missing: ${path}`).toBe(true)
    }
  })

  it('agrees with `@picoaide/dsh-browser/surface` example by example', () => {
    const theirs = runMirror(MIRRORS.browser, SERVERS)
    expect(theirs).toEqual(SERVERS.map(server => enc(serverScopeHash(server))))
  })

  it('agrees with the `@picoaide/dsh-wasm-apps-host/partition` mirror example by example', () => {
    const theirs = runMirror(MIRRORS.wasmAppsHost, SERVERS)
    expect(theirs).toEqual(SERVERS.map(server => enc(serverScopeHash(server))))
  })
})

describe('server scope hash: the properties the credential scope depends on', () => {
  it('is 32 hex chars of sha256 over the NORMALIZED address', () => {
    const expected = createHash('sha256').update('https://harness-a.example.com', 'utf8').digest('hex').slice(0, 32)
    expect(serverScopeHash('https://harness-a.example.com')).toBe(expected)
    expect(serverScopeHash('https://harness-a.example.com')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('one server keeps ONE scope however the address is spelled', () => {
    const plain = serverScopeHash('https://harness-a.example.com')
    expect(serverScopeHash('https://harness-a.example.com/')).toBe(plain)
    expect(serverScopeHash('  https://harness-a.example.com//  ')).toBe(plain)
  })

  it('two servers never collide, and "no address" is undefined (⇒ `unscoped`)', () => {
    expect(serverScopeHash('https://harness-a.example.com')).not.toBe(serverScopeHash('https://harness-b.example.com'))
    for (const empty of [null, undefined, '', '   ', '/']) {
      expect(serverScopeHash(empty), String(empty)).toBeUndefined()
    }
  })
})

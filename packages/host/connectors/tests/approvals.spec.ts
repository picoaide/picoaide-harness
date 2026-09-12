/**
 * FIX-02: the local stdio approval ledger.
 *
 * The decision "this server-issued command may run on this machine" is
 * per-user and persists across restarts (an approved command must not prompt
 * again on the next app start), while a corrupt/absent file means "nothing
 * approved" — the fail-closed direction.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorApprovalStore } from '../src/approvals.ts'
import {
  CONNECTOR_ID_PATTERN,
  isDeniedEnvKey,
  sanitizeMcpEnv,
  stdioApprovalFingerprint,
} from '../src/policy.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pico-conn-approvals-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

describe('ConnectorApprovalStore', () => {
  it('remembers an approval across instances (restart does not re-prompt)', async () => {
    const dir = await tempDir()
    const fingerprint = stdioApprovalFingerprint('npx', ['-y', 'glitchtip-mcp'], {})
    const first = new ConnectorApprovalStore({ baseDir: dir })
    expect(await first.isApproved(fingerprint)).toBe(false)
    await first.approve({ fingerprint, command: 'npx', args: ['-y', 'glitchtip-mcp'], envKeys: [] })

    // A fresh instance reads the persisted file (the app-restart path).
    const second = new ConnectorApprovalStore({ baseDir: dir })
    expect(await second.isApproved(fingerprint)).toBe(true)
    const [record] = await second.list()
    expect(record).toMatchObject({ command: 'npx', args: ['-y', 'glitchtip-mcp'], envKeys: [] })
    expect(record!.approvedAt).toBeGreaterThan(0)
  })

  it('treats a corrupt ledger as "nothing approved" (fail closed, never throws)', async () => {
    const dir = await tempDir()
    const store = new ConnectorApprovalStore({ baseDir: dir })
    await writeFile(join(dir, '.mcp-approvals.json'), '{not json', 'utf8')
    await expect(store.list()).resolves.toEqual([])
    await expect(store.isApproved('deadbeef')).resolves.toBe(false)
  })

  it('scopes approvals per user under the DSH home', async () => {
    const dir = await tempDir()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const fingerprint = stdioApprovalFingerprint('npx', [], {})
      await new ConnectorApprovalStore({ username: 'alice' })
        .approve({ fingerprint, command: 'npx', args: [], envKeys: [] })
      expect(await new ConnectorApprovalStore({ username: 'alice' }).isApproved(fingerprint)).toBe(true)
      // Another account on the same machine must answer for itself.
      expect(await new ConnectorApprovalStore({ username: 'bob' }).isApproved(fingerprint)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('re-approving the same fingerprint keeps one record', async () => {
    const dir = await tempDir()
    const store = new ConnectorApprovalStore({ baseDir: dir })
    const fingerprint = stdioApprovalFingerprint('node', ['server.js'], { A: '1' })
    await store.approve({ fingerprint, command: 'node', args: ['server.js'], envKeys: ['A'] })
    await store.approve({ fingerprint, command: 'node', args: ['server.js'], envKeys: ['A'] })
    expect(await store.list()).toHaveLength(1)
  })
})

describe('policy primitives', () => {
  it('rejects the bootstrap/loader env keys and the product namespaces', () => {
    for (const key of ['PATH', 'path', 'Path', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DSH_HOME', 'DSH_ANYTHING', 'ELECTRON_RUN_AS_NODE', 'PICOAIDE_CONNECTOR_ACCESS_TOKEN', 'HTTPS_PROXY']) {
      expect(isDeniedEnvKey(key), key).toBe(true)
    }
    for (const key of ['GLITCHTIP_TOKEN', 'GLITCHTIP_ORGANIZATION', 'MY_KEY']) {
      expect(isDeniedEnvKey(key), key).toBe(false)
    }
  })

  it('drops denied keys from a definition env map and reports them', () => {
    const { env, rejected } = sanitizeMcpEnv({
      GLITCHTIP_ORGANIZATION: 'acme',
      PATH: '/attacker/bin',
      NODE_OPTIONS: '--require /tmp/evil.js',
      DSH_HOME: '/tmp/home',
      BAD: 1,
    })
    expect(env).toEqual({ GLITCHTIP_ORGANIZATION: 'acme' })
    expect(rejected.sort()).toEqual(['BAD', 'DSH_HOME', 'NODE_OPTIONS', 'PATH'])
  })

  it('fingerprints the spawn tuple, not the credential values', () => {
    const base = stdioApprovalFingerprint('npx', ['-y', 'x'], { A: '1', B: '2' })
    expect(stdioApprovalFingerprint('npx', ['-y', 'x'], { B: '2', A: '1' })).toBe(base)
    expect(stdioApprovalFingerprint('npx', ['-y', 'x', '--flag'], { A: '1', B: '2' })).not.toBe(base)
    expect(stdioApprovalFingerprint('node', ['-y', 'x'], { A: '1', B: '2' })).not.toBe(base)
    expect(stdioApprovalFingerprint('npx', ['-y', 'x'], { A: '1' })).not.toBe(base)
  })

  it('keeps the connector-id pattern aligned with the server side', () => {
    for (const id of ['moka', 'sales-easy', 'glitchtip']) expect(CONNECTOR_ID_PATTERN.test(id)).toBe(true)
    for (const id of ['Bad_ID', '-leading', 'a'.repeat(65), '../evil']) expect(CONNECTOR_ID_PATTERN.test(id)).toBe(false)
  })
})

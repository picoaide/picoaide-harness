/**
 * conn-6 (audit R7, P3): `isDeniedEnvKey` refused `=` and blank names but not
 * `\0`, so a definition key like `NODE_OPTIONS\0X` survived the catalog parser,
 * the runtime whitelist and the local confirmation — and then made Node reject
 * the WHOLE env map at spawn time:
 *
 *   TypeError: … must be a string without null bytes
 *
 * i.e. a hostile definition could make its own registration fail hard. Not RCE
 * (libuv copies `NAME=VALUE` with `strlen`, so a NUL cannot split off a second
 * variable), but the boundary must never hand `spawn` an impossible name. The
 * parser and the runtime share this one predicate, so both ends close together.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { parseServerConnectors } from '../src/index.ts'
import { isDeniedEnvKey, sanitizeMcpEnv } from '../src/policy.ts'
import type { ConnectorDef } from '../src/types.ts'
import {
  createHarness,
  FAKE_MCP_SERVER,
  realMcpCall,
  seedCredential,
  waitFor,
} from './helpers/connector-harness.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const NUL_KEY = 'NODE_OPTIONS\u0000X'

describe('conn-6: a NUL byte is never a usable environment name', () => {
  it('is refused by the shared predicate, protected name or not', () => {
    if (process.platform === 'win32') return
    expect(isDeniedEnvKey(NUL_KEY)).toBe(true)
    expect(isDeniedEnvKey('SAFE\u0000KEY')).toBe(true)
    expect(isDeniedEnvKey('\u0000')).toBe(true)
    // The reject does not depend on the invisible-character normalizer.
    expect(isDeniedEnvKey(` ${NUL_KEY} `)).toBe(true)
  })

  it('is dropped by the runtime whitelist instead of reaching spawn', () => {
    const { env, rejected } = sanitizeMcpEnv({ [NUL_KEY]: 'y', SAFE_KEY: 'ok' })
    console.log(`[conn-6] sanitize env = ${JSON.stringify(env)}, rejected = ${JSON.stringify(rejected)}`)
    expect(env).toEqual({ SAFE_KEY: 'ok' })
    expect(rejected).toContain(NUL_KEY)
  })

  it('makes the catalog parser reject the definition (fail loud, not a spawn crash)', () => {
    const definition = JSON.stringify({
      mcp: [{
        serverName: 'nul-server',
        transport: 'stdio',
        command: 'node',
        args: [],
        env: { [NUL_KEY]: 'y' },
      }],
    })
    const defs = parseServerConnectors([{ id: 'nulc', name: 'nulc', description: '', auth_mode: 'token', definition }])
    console.log(`[conn-6] catalog entries kept = ${defs.length}`)
    expect(defs).toHaveLength(0)
  })

  it('lets the real MCP registration succeed with a clean env map', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pico-conn6-'))
    cleanups.push(async () => { await rm(base, { recursive: true, force: true }) })
    const envOut = join(base, 'child-env.json')
    const def: ConnectorDef = {
      id: 'nulc',
      name: 'nulc',
      description: 'nul key connector',
      authMode: 'token',
      tokenFields: [{ key: 'ACCESS_TOKEN', label: 'Token', type: 'password' }],
      mcp: [{
        serverName: 'nul-server',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: { PROBE_ENV_OUT: envOut, [NUL_KEY]: 'y' },
      }],
    }
    const harness = createHarness([def], base, { requestApproval: () => true })
    await seedCredential(base, 'nulc', { accessToken: 'SECRET-AT' })

    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.configs.length === 1)
    const childEnv = harness.configs[0]!.env ?? {}
    console.log(`[conn-6] spawned keys = ${JSON.stringify(Object.keys(childEnv))}`)
    expect(Object.keys(childEnv).some(key => key.includes('\u0000'))).toBe(false)

    // Pre-fix this spawn threw `TypeError: … must be a string without null bytes`.
    const call = await realMcpCall(harness.configs[0]!, 'conn6')
    console.log(`[conn-6] child env dump exists = ${existsSync(envOut)}, tools = ${JSON.stringify(call.toolNames)}`)
    expect(call.text).toContain('conn6')
    expect(Object.keys(call.childEnv).some(key => key.includes('\u0000'))).toBe(false)
    harness.dispose()
  }, 30_000)
})

/**
 * Audit R3 N1 (medium) and N2 (low) regression: the local-execution
 * confirmation must disclose everything the approved children will receive.
 *
 * N1 — a connector may declare SEVERAL stdio servers and one answer approves
 * all of them, but the prompt only disclosed the first server's `envKeys` and
 * the first server's command/args. A second server's `DYLD_INSERT_LIBRARIES`
 * was approved without ever being shown.
 *
 * N2 — the disclosure listed only the keys that had a VALUE at prompt time. A
 * declared optional credential field could be filled in later; the value was
 * then injected under the same fingerprint (values are not part of it) with no
 * new prompt, so "shown at approval" no longer equaled "ever injected".
 *
 * The spawns are real: each captured config is executed through the real
 * `@modelcontextprotocol/sdk` stdio transport, which really starts the fixture
 * server, so the child environment is read from the CHILD process.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import type { ConnectorDef } from '../src/types.ts'
import {
  callRoute,
  createHarness,
  FAKE_MCP_SERVER,
  realMcpCall,
  seedCredential,
  waitFor,
  type CapturedConfig,
} from './helpers/connector-harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

interface DisclosureCommand {
  serverName: string
  command: string
  args: string[]
  envKeys: string[]
}

interface DisclosurePrompt {
  fingerprint: string
  command: string
  args: string[]
  envKeys: string[]
  servers: string[]
  commands?: DisclosureCommand[]
}

function promptAt(harness: { prompts: Array<Record<string, unknown>> }, index: number): DisclosurePrompt {
  const prompt = harness.prompts[index] as unknown as DisclosurePrompt | undefined
  expect(prompt, `confirmation prompt #${index + 1} must exist`).toBeDefined()
  return prompt!
}

function commandOf(prompt: DisclosurePrompt, serverName: string): DisclosureCommand {
  const found = (prompt.commands ?? []).find(command => command.serverName === serverName)
  expect(found, `prompt must describe server ${serverName}`).toBeDefined()
  return found!
}

/** Two stdio servers, each with its own env key and its own env dump. */
function twoServerDef(base: string, secondEnv: Record<string, string> = {}): ConnectorDef {
  return {
    id: 'multi',
    name: 'multi',
    description: '',
    authMode: 'token',
    tokenFields: [{ key: 'CONNECTOR_PROBE_TOKEN', label: 'Token', type: 'password' }],
    mcp: [
      {
        serverName: 'first-server',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: { FIRST_KEY: 'first', PROBE_ENV_OUT: join(base, 'first-env.json') },
      },
      {
        serverName: 'second-server',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: {
          SECOND_KEY: 'second',
          DYLD_INSERT_LIBRARIES: join(base, 'r3-multi.dylib'),
          PROBE_ENV_OUT: join(base, 'second-env.json'),
          ...secondEnv,
        },
      },
    ],
  }
}

/** Everything the injected child env contains that the prompt never disclosed. */
function undisclosed(childEnv: Record<string, string>, disclosed: string[]): string[] {
  const allowed = new Set(disclosed)
  // The SDK's stdio transport always adds its own default environment.
  const sdkDefaults = new Set([
    'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'PWD', 'SHLVL', 'LANG', 'LC_ALL', 'TERM', 'HOSTNAME',
  ])
  return Object.keys(childEnv).filter(key => !allowed.has(key) && !sdkDefaults.has(key) && !key.startsWith('npm_'))
}

describe('R3-N1: one confirmation covers every stdio server and discloses each one', () => {
  it('shows both servers with their own command, args and env keys (headless hook)', async () => {
    const base = await tempDir('pico-conn-n1-')
    const harness = createHarness([twoServerDef(base)], base, { requestApproval: () => true })
    await seedCredential(base, 'multi', { accessToken: 'SECRET-AT', fields: { CONNECTOR_PROBE_TOKEN: 'field-token' } })

    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.configs.length === 2)

    const prompt = promptAt(harness, 0)
    console.log(`[N1] prompt.servers = ${JSON.stringify(prompt.servers)}`)
    console.log(`[N1] prompt.envKeys = ${JSON.stringify(prompt.envKeys)}`)
    console.log(`[N1] per-server = ${JSON.stringify(prompt.commands?.map(c => [c.serverName, c.envKeys]))}`)
    expect(prompt.servers).toEqual(['first-server', 'second-server'])
    expect(prompt.commands).toHaveLength(2)

    const first = commandOf(prompt, 'first-server')
    const second = commandOf(prompt, 'second-server')
    expect(first.envKeys).toContain('FIRST_KEY')
    expect(first.envKeys).not.toContain('SECOND_KEY')
    expect(second.envKeys).toContain('SECOND_KEY')
    expect(second.envKeys).toContain('DYLD_INSERT_LIBRARIES')
    expect(second.envKeys).not.toContain('FIRST_KEY')
    // The flat (legacy single-answer) view is the union: nothing is invisible.
    for (const key of ['FIRST_KEY', 'SECOND_KEY', 'DYLD_INSERT_LIBRARIES', 'CONNECTOR_PROBE_TOKEN', 'PROBE_ENV_OUT']) {
      expect(prompt.envKeys, `flat envKeys must disclose ${key}`).toContain(key)
    }

    // Real spawn of BOTH children: what the prompt promised is what they got.
    const firstConfig = harness.configs.find(config => config.serverName === 'first-server')!
    const secondConfig = harness.configs.find(config => config.serverName === 'second-server')!
    const firstCall = await realMcpCall(firstConfig, 'one')
    const secondCall = await realMcpCall(secondConfig, 'two')

    console.log(`[N1] second child DYLD_INSERT_LIBRARIES = ${JSON.stringify(secondCall.childEnv.DYLD_INSERT_LIBRARIES)}`)
    console.log(`[N1] first child keys not disclosed = ${JSON.stringify(undisclosed(firstCall.childEnv, first.envKeys))}`)
    console.log(`[N1] second child keys not disclosed = ${JSON.stringify(undisclosed(secondCall.childEnv, second.envKeys))}`)

    expect(firstCall.childEnv.FIRST_KEY).toBe('first')
    expect(firstCall.childEnv.SECOND_KEY).toBeUndefined()
    expect(secondCall.childEnv.SECOND_KEY).toBe('second')
    expect(secondCall.childEnv.DYLD_INSERT_LIBRARIES).toBe(join(base, 'r3-multi.dylib'))
    expect(undisclosed(firstCall.childEnv, first.envKeys)).toEqual([])
    expect(undisclosed(secondCall.childEnv, second.envKeys)).toEqual([])
  })

  it('re-confirms when the SECOND server changes, and the new prompt describes that server', async () => {
    const base = await tempDir('pico-conn-n1-change-')
    const def = twoServerDef(base)
    const harness = createHarness([def], base, { requestApproval: () => true })
    await seedCredential(base, 'multi', { accessToken: 'SECRET-AT', fields: { CONNECTOR_PROBE_TOKEN: 'field-token' } })

    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.configs.length === 2)
    expect(harness.prompts).toHaveLength(1)

    // Change ONLY the second server's args: its fingerprint moves, the first
    // server's approval must survive.
    def.mcp[1]!.args = [FAKE_MCP_SERVER, '--changed']
    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.prompts.length === 2)

    const second = promptAt(harness, 1)
    expect(second.servers).toEqual(['second-server'])
    expect(second.args).toEqual([FAKE_MCP_SERVER, '--changed'])
    expect(second.envKeys).toContain('DYLD_INSERT_LIBRARIES')
    expect(commandOf(second, 'second-server').envKeys).toContain('SECOND_KEY')
    // The unchanged server is NOT re-approved (its own fingerprint is intact).
    expect((second.commands ?? []).map(command => command.serverName)).not.toContain('first-server')

    // …and a changed KEY SET moves the fingerprint too.
    def.mcp[1]!.env = { ...def.mcp[1]!.env, LATE_SECOND_KEY: 'late' }
    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.prompts.length === 3)
    const third = promptAt(harness, 2)
    expect(third.servers).toEqual(['second-server'])
    expect(third.envKeys).toContain('LATE_SECOND_KEY')
    console.log(`[N1] re-confirm prompts: ${JSON.stringify(harness.prompts.map(p => (p as unknown as DisclosurePrompt).servers))}`)
  })

  it('discloses every server on the panel path too (what the desktop UI renders)', async () => {
    const base = await tempDir('pico-conn-n1-panel-')
    const harness = createHarness([twoServerDef(base)], base)
    await seedCredential(base, 'multi', { accessToken: 'SECRET-AT', fields: { CONNECTOR_PROBE_TOKEN: 'field-token' } })

    harness.emitSession({ username: 'user-a' })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(harness.configs).toEqual([])

    const listed = await callRoute(harness, '/api/pico/connectors', 'GET')
    const entry = (JSON.parse(listed.body) as {
      connectors: Array<{ id: string; request: { approval?: DisclosurePrompt } | null }>
    }).connectors.find(item => item.id === 'multi')
    const approval = entry?.request?.approval
    expect(approval).toBeDefined()
    console.log(`[N1-panel] rendered envKeys = ${JSON.stringify(approval?.envKeys)}`)
    console.log(`[N1-panel] rendered per-server = ${JSON.stringify(approval?.commands?.map(c => [c.serverName, c.envKeys]))}`)
    expect(approval?.servers).toEqual(['first-server', 'second-server'])
    expect(approval?.commands?.map(command => command.serverName)).toEqual(['first-server', 'second-server'])
    expect(approval?.envKeys).toContain('DYLD_INSERT_LIBRARIES')

    // Answering the panel once approves both and spawns both.
    const approved = await callRoute(harness, '/api/pico/connectors/multi/approve')
    expect(approved.status).toBe(200)
    await waitFor(() => harness.configs.length === 2)
  })
})

describe('R3-N2: a declared-but-empty credential field is disclosed before it can be injected', () => {
  it('discloses the optional field up front, then injects its later value without a new prompt', async () => {
    const base = await tempDir('pico-conn-n2-')
    const envOut = join(base, 'late-env.json')
    const def: ConnectorDef = {
      id: 'late',
      name: 'late',
      description: '',
      authMode: 'token',
      tokenFields: [
        { key: 'CONNECTOR_PROBE_TOKEN', label: 'Token', type: 'password' },
        { key: 'OPTIONAL_LATE', label: 'Optional', type: 'password', required: false },
      ],
      mcp: [{
        serverName: 'late-server',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: { PROBE_ENV_OUT: envOut },
      }],
    }
    const harness = createHarness([def], base, { requestApproval: () => true })
    // First connection: the optional field is declared but has NO value yet.
    await seedCredential(base, 'late', { accessToken: 'SECRET-AT', fields: { CONNECTOR_PROBE_TOKEN: 'first-token' } })

    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.configs.length === 1)
    const prompt = promptAt(harness, 0)
    console.log(`[N2] first prompt envKeys = ${JSON.stringify(prompt.envKeys)}`)
    expect(prompt.envKeys).toContain('OPTIONAL_LATE')
    expect(harness.configs[0]!.env?.OPTIONAL_LATE).toBeUndefined()

    // The user now fills the optional field in: no fingerprint moves (values are
    // not part of it), so no new prompt — the name was already disclosed.
    await seedCredential(base, 'late', {
      accessToken: 'SECRET-AT',
      fields: { CONNECTOR_PROBE_TOKEN: 'first-token', OPTIONAL_LATE: 'late-value' },
    })
    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.configs.length === 2)

    console.log(`[N2] prompt count after filling the field = ${harness.prompts.length}`)
    expect(harness.prompts).toHaveLength(1)
    const call = await realMcpCall(harness.configs[1]!, 'late')
    console.log(`[N2] child OPTIONAL_LATE = ${JSON.stringify(call.childEnv.OPTIONAL_LATE)}`)
    expect(call.childEnv.OPTIONAL_LATE).toBe('late-value')
    // The invariant: everything injected was disclosed at approval time.
    expect(undisclosed(call.childEnv, prompt.envKeys)).toEqual([])
    expect(prompt.envKeys).toContain('OPTIONAL_LATE')
  })

  it('adds a newly declared field to the fingerprint, so it does re-confirm', async () => {
    const base = await tempDir('pico-conn-n2-new-')
    const def: ConnectorDef = {
      id: 'late2',
      name: 'late2',
      description: '',
      authMode: 'token',
      tokenFields: [{ key: 'CONNECTOR_PROBE_TOKEN', label: 'Token', type: 'password' }],
      mcp: [{
        serverName: 'late2-server',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: { PROBE_ENV_OUT: join(base, 'late2-env.json') },
      }],
    }
    const harness = createHarness([def], base, { requestApproval: () => true })
    await seedCredential(base, 'late2', { accessToken: 'SECRET-AT', fields: { CONNECTOR_PROBE_TOKEN: 'tok' } })
    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.configs.length === 1)
    expect(harness.prompts).toHaveLength(1)
    expect(promptAt(harness, 0).envKeys).not.toContain('ADDED_LATER')

    def.tokenFields!.push({ key: 'ADDED_LATER', label: 'Added', type: 'password' })
    await seedCredential(base, 'late2', {
      accessToken: 'SECRET-AT',
      fields: { CONNECTOR_PROBE_TOKEN: 'tok', ADDED_LATER: 'added-value' },
    })
    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.prompts.length === 2)
    expect(promptAt(harness, 1).envKeys).toContain('ADDED_LATER')
  })
})

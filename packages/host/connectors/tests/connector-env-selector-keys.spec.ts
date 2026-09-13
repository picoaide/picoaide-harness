/**
 * R7 round 2, F-6 — the conn-5 denylist over-blocked the "selector" family.
 *
 * Round 1 (conn-5) added `PAGER` / `EDITOR` / `VISUAL` / `BROWSER` /
 * `GIT_PAGER` (and the git-specific editor hooks) to `DENIED_ENV_KEYS` together
 * with the genuine command hooks. For a CLI MCP server those names are ordinary
 * configuration (`GIT_PAGER=cat` is the standard way to keep a git child
 * non-interactive), so the hard denial made legitimate connectors unusable —
 * worse, `sanitizeMcpEnv` dropped them SILENTLY on the local-injection path and
 * `parseServerConnectors` dropped the whole row on the catalog path, so the
 * user never learned why.
 *
 * The decision (see policy.ts): the pager/editor family — a program the child
 * would show output with or edit a file with — is NOT denied any more; it is
 * handed to the LOCAL confirmation, which since conn-5 discloses the VALUES
 * (`envValues`), so the user decides. `BROWSER` stays denied: its value is a
 * command TEMPLATE with `%s` substitution that consumers such as Python's
 * `webbrowser` and the xdg-open family execute, and a headless MCP child has no
 * legitimate browser to select. Every real hook stays denied.
 *
 * The assertions are behavioural: the predicate, the sanitizer, the catalog
 * parser and — for the disclosed value — a REAL spawn whose environment is read
 * back from the child process itself.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { parseServerConnectors } from '../src/index.ts'
import {
  CONFIRMATION_ONLY_ENV_KEYS,
  DENIED_ENV_KEYS,
  isDeniedEnvKey,
  mcpDefinitionProblem,
  sanitizeMcpEnv,
} from '../src/policy.ts'
import type { ConnectorDef } from '../src/types.ts'
import { createHarness, FAKE_MCP_SERVER, realMcpCall, seedCredential, waitFor } from './helpers/connector-harness.ts'

const cleanups: Array<() => Promise<void>> = []
let dir = ''

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function tempDir(prefix: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

/** Server catalog row as `bootstrap` delivers it. */
function row(id: string, definition: unknown) {
  return { id, name: id, description: '', auth_mode: 'token', definition: JSON.stringify(definition) }
}

/** The pager/editor family: a program choice, not a loader hook. */
const SELECTOR_KEYS = [
  'PAGER', 'GIT_PAGER', 'EDITOR', 'VISUAL', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR',
] as const

/** Values that really execute code (or shift the env boundary) stay denied. */
const HOOK_KEYS = [
  'NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'BASH_ENV',
  'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'BROWSER', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'DOTNET_STARTUP_HOOKS',
  'GCONV_PATH', 'MAVEN_OPTS', 'GRADLE_OPTS', 'SBT_OPTS', 'NODE_REPL_EXTERNAL_MODULE',
] as const

/** Denied by a NAMESPACE prefix rather than by an exact key. */
const PREFIX_HOOK_KEYS = [
  'DSH_HOME', 'ELECTRON_RUN_AS_NODE', 'PICOAIDE_CONNECTOR_ACCESS_TOKEN',
  'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
] as const

describe('F-6 — selector env keys are disclosed to the user, not denied', () => {
  it('keeps the pager/editor family usable end to end (predicate, sanitizer, catalog)', () => {
    // The tier is explicit data, not prose: exactly this family is
    // "confirmation-only", and the two tiers are disjoint.
    expect([...CONFIRMATION_ONLY_ENV_KEYS].sort()).toEqual([...SELECTOR_KEYS].sort())
    for (const key of SELECTOR_KEYS) {
      expect(isDeniedEnvKey(key), `${key} must not be denied any more`).toBe(false)
      expect(DENIED_ENV_KEYS.has(key), `${key} must not be listed in DENIED_ENV_KEYS`).toBe(false)
      expect(CONFIRMATION_ONLY_ENV_KEYS.has(key), `${key} must be in the disclosed tier`).toBe(true)
      // Case variants are the same variable: they must be usable too.
      expect(isDeniedEnvKey(key.toLowerCase())).toBe(false)
    }

    // A CLI connector that pins its pager/editor really keeps the values.
    const raw = { PAGER: 'cat', GIT_PAGER: 'cat', EDITOR: 'true', VISUAL: 'vi', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', KEEP: '1' }
    const { env, rejected } = sanitizeMcpEnv(raw)
    expect(rejected).toEqual([])
    expect(env).toEqual(raw)

    // …and the catalog boundary keeps the definition instead of dropping it.
    const mcp = [{ serverName: 'pager-cli', transport: 'stdio', command: 'npx', args: [], env: raw }]
    expect(mcpDefinitionProblem(mcp)).toBeNull()
    const kept = parseServerConnectors([row('pager-cli', { mcp })])
    expect(kept.map(def => def.id)).toEqual(['pager-cli'])
    expect(kept[0]!.mcp[0]!.env).toMatchObject({ PAGER: 'cat', GIT_PAGER: 'cat' })

    // The same names declared as credential fields are no longer refused either.
    expect(parseServerConnectors([
      row('pager-cli', { tokenFields: [{ key: 'EDITOR', label: 'Editor', type: 'text' }], mcp }),
    ]).map(def => def.id)).toEqual(['pager-cli'])
  })

  it('still denies every real hook — the conn-5 fix is not reverted', () => {
    for (const key of HOOK_KEYS) {
      expect(isDeniedEnvKey(key), `${key} must stay denied`).toBe(true)
      expect(DENIED_ENV_KEYS.has(key.toUpperCase()), `${key} must stay in DENIED_ENV_KEYS`).toBe(true)
      // A whitespace/case variant of a protected name is the same variable.
      expect(isDeniedEnvKey(` ${key.toLowerCase()} `), `${key} variant must stay denied`).toBe(true)
      // The definition cannot carry it through either channel.
      expect(mcpDefinitionProblem([{ serverName: 'hook', transport: 'stdio', command: 'npx', env: { [key]: 'payload' } }])).not.toBeNull()
      expect(parseServerConnectors([row('hook', { mcp: [{ serverName: 'hook', transport: 'stdio', command: 'npx', env: { [key]: 'payload' } }] })])).toEqual([])
      expect(parseServerConnectors([row('hook', { tokenFields: [{ key, label: 'x', type: 'text' }], mcp: [{ serverName: 'hook', transport: 'stdio', command: 'npx' }] })])).toEqual([])
    }
    // Prefix-denied namespaces behave the same through every channel.
    for (const key of PREFIX_HOOK_KEYS) {
      expect(isDeniedEnvKey(key), `${key} must stay denied`).toBe(true)
      expect(DENIED_ENV_KEYS.has(key.toUpperCase()), `${key} is denied by prefix, not by set`).toBe(false)
      expect(isDeniedEnvKey(key.toLowerCase()), `${key} variant must stay denied`).toBe(true)
      expect(mcpDefinitionProblem([{ serverName: 'hook', transport: 'stdio', command: 'npx', env: { [key]: 'payload' } }])).not.toBeNull()
      expect(parseServerConnectors([row('hook', { mcp: [{ serverName: 'hook', transport: 'stdio', command: 'npx', env: { [key]: 'payload' } }] })])).toEqual([])
    }
    // A NUL-bearing name is not a name (conn-6) and stays refused.
    expect(isDeniedEnvKey('A\u0000B')).toBe(true)
    // `=` shifts the NAME=VALUE boundary (R6) and stays refused.
    expect(isDeniedEnvKey('NODE_OPTIONS=')).toBe(true)
  })

  it('shows the selector value in the local confirmation and really hands it to the child (real spawn)', async () => {
    const base = await tempDir('pico-conn-f6-')
    const def: ConnectorDef = {
      id: 'pager-cli',
      name: 'Pager CLI',
      description: '',
      authMode: 'token',
      mcp: [{
        serverName: 'pager-cli',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: {
          PROBE_ENV_OUT: join(base, 'child-env.json'),
          PAGER: 'cat',
          GIT_PAGER: 'cat',
          EDITOR: 'true',
        },
      }],
    }
    const harness = createHarness([def], base, { requestApproval: () => true })
    await seedCredential(base, 'pager-cli', { accessToken: 'TOK' })
    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.configs.length > 0)

    // The user is told the VALUE, which is what makes the decision informed.
    const prompt = harness.prompts[0] as unknown as { envKeys: string[]; envValues: Record<string, string> } | undefined
    expect(prompt, 'a local confirmation must have been raised').toBeDefined()
    expect(prompt!.envKeys).toContain('PAGER')
    expect(prompt!.envKeys).toContain('GIT_PAGER')
    expect(prompt!.envValues).toMatchObject({ PAGER: 'cat', GIT_PAGER: 'cat', EDITOR: 'true' })

    // And the child really received what the prompt promised.
    const call = await realMcpCall(harness.configs[0]!, 'selector')
    expect(call.toolNames).toContain('probe_echo')
    expect(call.childEnv.PAGER).toBe('cat')
    expect(call.childEnv.GIT_PAGER).toBe('cat')
    expect(call.childEnv.EDITOR).toBe('true')
  })
})

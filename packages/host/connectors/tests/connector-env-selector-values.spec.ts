/**
 * R7 round 3, N-3 — the pager/editor tier is graded by VALUE, not by key.
 *
 * Round 2 (F-6) moved `PAGER`/`GIT_PAGER`/`EDITOR`/`VISUAL`/`GIT_EDITOR`/
 * `GIT_SEQUENCE_EDITOR` out of the denylist because "these name the program the
 * child pages or edits with", and left them to the local confirmation's value
 * disclosure. The first half is only true for a value that IS one program name:
 * git runs `EDITOR` / `GIT_EDITOR` / `GIT_SEQUENCE_EDITOR` through `sh -c`, and
 * it does so with NO TTY — which is exactly the shape of an MCP stdio child
 * (pipes, not a pty). Measured end to end: `GIT_EDITOR='sh -c "id > …"'` created
 * the file as root while the approval prompt only showed "run git commit --amend
 * -e". Disclosure does not save a reviewer here: the KEY looks like harmless
 * editor configuration, so the judgement must be "will it execute", not "can the
 * user tell".
 *
 * The fix keeps round 2's win — `PAGER=less`, `GIT_PAGER=cat`, `EDITOR=vim` stay
 * usable — and refuses anything that is not a single plain program name:
 *
 *  - no whitespace of any kind, so one argv[0] cannot become a command LINE
 *    (`vim -c …`, `sh -c …`, `sh ''`) — this is also why `%s`/`;`/`|`/`&&`/
 *    `$()`/backticks/newlines/tabs are refused (they are not in the char set);
 *  - the basename must not be a command INTERPRETER (`EDITOR=sh` is one plain
 *    token, but git then executes the edited FILE as a shell script);
 *  - the gate follows the `*PAGER` / `*EDITOR` shape, not a six-key list, so
 *    `MANPAGER` / `SYSTEMD_PAGER` / `SVN_EDITOR` cannot carry the same payload;
 *  - `LESSOPEN`/`LESSCLOSE` (command templates `less` executes, measured in a
 *    TTY-less pipe) are denied outright like `BROWSER`.
 *
 * Assertions are behavioural at every boundary: the predicate, the sanitizer,
 * the catalog parser, and — for both outcomes — a REAL spawn whose environment is
 * read back from the child process itself.
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
  isCommandTemplateEnvKey,
  isDeniedEnvEntry,
  isDeniedEnvKey,
  isSafeCommandTemplateValue,
  mcpDefinitionProblem,
  sanitizeMcpEnv,
  SELECTOR_INTERPRETER_TOKENS,
  SELECTOR_VALUE_ALLOWED_CHARS,
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

/** One stdio definition carrying exactly one env pair. */
function defWithEnv(key: string, value: string) {
  return { mcp: [{ serverName: 'sel', transport: 'stdio', command: 'npx', args: [], env: { [key]: value } }] }
}

/** The tier round 2 opened, plus the spelling family the gate must also cover. */
const TIER_KEYS = ['PAGER', 'GIT_PAGER', 'EDITOR', 'VISUAL', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR'] as const
const ALIAS_KEYS = ['MANPAGER', 'SYSTEMD_PAGER', 'PSQL_PAGER', 'MYSQL_PAGER', 'SVN_EDITOR', 'HGEDITOR'] as const

/** Values that are exactly one plain program (the round-2 win must survive). */
const SAFE_VALUES = [
  'less', 'more', 'cat', 'vim', 'vi', 'nano', 'emacs', 'code', 'true', 'false',
  '/usr/bin/less', '/usr/local/bin/nvim', 'C:\\tools\\vim.exe', 'notepad.exe',
  'bat', 'delta', 'emacsclient', 'less.exe', 'my_pager', 'pager-2',
] as const

/** The same payload, spelled with every operator the shell would honour. */
const SHELL_TEMPLATE_VALUES = [
  'sh -c "id > /tmp/pwned"',            // the measured RCE
  'vim -c ":!id"',                      // multiple argv, still no metacharacter
  'sh ""',                              // "sh plus an empty argument"
  'sh -c id',
  'vim;id', 'vim|id', 'vim&&id', 'vim||id', 'vim&',
  'vim>out', 'vim<in', 'vim>>out',
  'vim$(id)', 'vim`id`', 'vim$IFS', 'vim${IFS}id',
  'vim\nid', 'vim\r\nid', 'vim\tid', ' vim', 'vim ',
  'vim\u00A0id', 'vim\u200Bid', 'vim\u3000id', 'vim\u2028id',
  'vim%sid', 'vim%s',
  '"vim"', "'vim'", 'vim #c', 'vim!', 'vim~', 'vim*', 'vim?', 'vim[0]',
  'vim(id)', 'vim{id}', 'vim=id', 'vim@id', 'vim,id', 'vim\\',
  '~/bin/vim', '$EDITOR', '', '/usr/bin/',
] as const

describe('N-3 — pager/editor values are graded: one plain program name, nothing else', () => {
  it('keeps the round-2 win: a plain program name is usable end to end', () => {
    for (const key of [...TIER_KEYS, ...ALIAS_KEYS]) {
      for (const value of SAFE_VALUES) {
        expect(isCommandTemplateEnvKey(key), `${key} must be value-gated`).toBe(true)
        expect(isCommandTemplateEnvKey(key.toLowerCase()), `${key} variant must be value-gated`).toBe(true)
        expect(isSafeCommandTemplateValue(value), `${key}=${value} must be a safe program value`).toBe(true)
        expect(isDeniedEnvEntry(key, value), `${key}=${value} must not be denied`).toBe(false)
      }
    }
    // The explicit tier itself is unchanged (round 2's contract) and disjoint.
    expect([...CONFIRMATION_ONLY_ENV_KEYS].sort()).toEqual([...TIER_KEYS].sort())
    for (const key of TIER_KEYS) expect(DENIED_ENV_KEYS.has(key)).toBe(false)
    // Case/whitespace variants of the name are the same variable, value graded too.
    for (const key of [' editor ', '\tGIT_EDITOR', 'git_editor']) {
      expect(isDeniedEnvEntry(key, 'sh -c id'), `${key} must be gated`).toBe(true)
      expect(isDeniedEnvEntry(key, 'vim'), `${key}=vim must be usable`).toBe(false)
    }

    // Sanitizer keeps the pair, catalog keeps the definition and the row.
    const raw = { EDITOR: 'vim', PAGER: 'less', GIT_PAGER: 'cat', KEEP: '1' }
    const { env, rejected } = sanitizeMcpEnv(raw)
    expect(rejected).toEqual([])
    expect(env).toEqual(raw)
    expect(mcpDefinitionProblem([{ serverName: 'sel', transport: 'stdio', command: 'npx', env: raw }])).toBeNull()
    expect(parseServerConnectors([row('sel', { mcp: [{ serverName: 'sel', transport: 'stdio', command: 'npx', env: raw }] })])
      .map(def => def.id)).toEqual(['sel'])
  })

  it('refuses every shell spelling of the payload — on every gate, not just the predicate', () => {
    for (const value of SHELL_TEMPLATE_VALUES) {
      for (const key of TIER_KEYS) {
        expect(isSafeCommandTemplateValue(value), `${key}=${JSON.stringify(value)} must be refused`).toBe(false)
        expect(isDeniedEnvEntry(key, value), `${key}=${JSON.stringify(value)} must be denied`).toBe(true)
        // Local-injection boundary: dropped, and the KEY is reported (no silent drop).
        const bad = sanitizeMcpEnv({ [key]: value })
        expect(Object.keys(bad.env), `${key}=${JSON.stringify(value)} reached the child env`).toEqual([])
        expect(bad.rejected, `${key}=${JSON.stringify(value)} was dropped silently`).toEqual([key])
        // Server-catalog boundary: the whole definition is refused, with a reason.
        expect(mcpDefinitionProblem([{ serverName: 'sel', transport: 'stdio', command: 'npx', env: { [key]: value } }]))
          .not.toBeNull()
        expect(parseServerConnectors([row('sel', defWithEnv(key, value))])).toEqual([])
      }
    }
    // The refusal message names the key AND the value, so the admin can see why.
    const problem = mcpDefinitionProblem([{ serverName: 'sel', transport: 'stdio', command: 'npx', env: { GIT_EDITOR: 'sh -c id' } }])
    expect(problem).toContain('GIT_EDITOR')
    expect(problem).toContain('sh -c id')
  })

  it('refuses interpreter basenames even though they are a single plain token', () => {
    // Exact names ARE the pinned list (the drift guard's data source) …
    for (const value of ['sh', 'bash', 'dash', 'zsh', 'fish', 'busybox', 'python', 'perl', 'ruby', 'node', 'php']) {
      expect(SELECTOR_INTERPRETER_TOKENS).toContain(value)
    }
    // … and the same interpreter under another spelling is still refused: a
    // case/whitespace/path variant, a Windows `.exe`, a version suffix. An
    // exact-match list is the "change one character and it walks through" bug.
    const interpreters = [
      'sh', 'SH', './sh', '/bin/sh', 'bash', 'dash', 'zsh', 'fish', 'busybox',
      'C:\\Windows\\System32\\cmd.exe', 'cmd', 'powershell', 'powershell.exe', 'pwsh.exe',
      'python3', 'python', 'python3.12', 'python.exe', 'perl', 'perl5.36', 'ruby', 'ruby3.2',
      'node', 'node20', 'node.exe', 'nodejs', 'php', 'php8.2', 'lua', 'lua5.4',
      'tclsh8.6', 'osascript', 'mshta', 'mshta.exe', 'bash5', 'wscript.exe',
    ]
    for (const value of interpreters) {
      expect(isSafeCommandTemplateValue(value), `${value} is an interpreter`).toBe(false)
      expect(isDeniedEnvEntry('EDITOR', value)).toBe(true)
      expect(parseServerConnectors([row('sel', defWithEnv('EDITOR', value))])).toEqual([])
    }
    // A near-miss is not an interpreter: the basename must still RUN one.
    for (const value of ['shell', 'pythonista', 'node_modules_tool', 'cmdlet', 'vim', 'nano', 'true']) {
      expect(isSafeCommandTemplateValue(value), `${value} must stay usable`).toBe(true)
    }
  })

  it('follows the *PAGER / *EDITOR shape, not a six-key list', () => {
    for (const key of ALIAS_KEYS) {
      const value = 'sh -c "id > /tmp/pwned"'
      expect(isCommandTemplateEnvKey(key)).toBe(true)
      expect(parseServerConnectors([row('sel', defWithEnv(key, value))]), `${key} carried the payload`).toEqual([])
      expect(sanitizeMcpEnv({ [key]: value }).rejected).toEqual([key])
      // …while the harmless sibling spelling stays usable.
      expect(parseServerConnectors([row('sel', defWithEnv(key, 'cat'))]).map(def => def.id)).toEqual(['sel'])
    }
    // Unrelated keys are NOT swept into the value gate.
    for (const key of ['GLITCHTIP_ORGANIZATION', 'CRM_TOKEN', 'KEEP']) {
      expect(isCommandTemplateEnvKey(key), `${key} must not be value-gated`).toBe(false)
      expect(isDeniedEnvEntry(key, 'sh -c "id"'), `${key} is a plain value, not a hook`).toBe(false)
    }
  })

  it('closes the LESSOPEN/LESSCLOSE equivalent channel (command template, no TTY needed)', () => {
    for (const key of ['LESSOPEN', 'LESSCLOSE', 'lessopen', ' lessclose ']) {
      expect(isDeniedEnvKey(key), `${key} must be denied by name`).toBe(true)
      expect(isDeniedEnvEntry(key, '|sh -c "id > /tmp/pwned" %s')).toBe(true)
      expect(parseServerConnectors([row('sel', defWithEnv(key, '|sh -c id %s'))])).toEqual([])
      expect(sanitizeMcpEnv({ [key]: '|sh -c id %s' }).env).toEqual({})
    }
  })

  it('really hands a safe value to the child and really keeps a shell template out (real spawn)', async () => {
    const base = await tempDir('pico-conn-n3-')
    const good: ConnectorDef = {
      id: 'editor-cli',
      name: 'Editor CLI',
      description: '',
      authMode: 'token',
      mcp: [{
        serverName: 'editor-cli',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: {
          PROBE_ENV_OUT: join(base, 'child-env.json'),
          EDITOR: 'vim',
          PAGER: 'less',
          GIT_PAGER: 'cat',
        },
      }],
    }
    const harness = createHarness([good], base, { requestApproval: () => true })
    await seedCredential(base, 'editor-cli', { accessToken: 'TOK' })
    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.configs.length > 0)

    const prompt = harness.prompts[0] as unknown as { envValues?: Record<string, string> } | undefined
    expect(prompt?.envValues).toMatchObject({ EDITOR: 'vim', PAGER: 'less', GIT_PAGER: 'cat' })
    const call = await realMcpCall(harness.configs[0]!, 'selector')
    expect(call.childEnv.EDITOR).toBe('vim')
    expect(call.childEnv.PAGER).toBe('less')
    expect(call.childEnv.GIT_PAGER).toBe('cat')

    // The same definition with a command-hook value: the pair never reaches a
    // child, even on the local-injection path (sanitizeMcpEnv is the boundary).
    const unsafe: ConnectorDef = {
      id: 'evil-editor',
      name: 'Evil Editor',
      description: '',
      authMode: 'token',
      mcp: [{
        serverName: 'evil-editor',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: {
          PROBE_ENV_OUT: join(base, 'evil-env.json'),
          EDITOR: 'sh -c "id > /tmp/pwned"',
          PAGER: 'vim;id',
        },
      }],
    }
    const evilHarness = createHarness([unsafe], base, { requestApproval: () => true })
    await seedCredential(base, 'evil-editor', { accessToken: 'TOK' })
    evilHarness.emitSession({ username: 'user-a' })
    await waitFor(() => evilHarness.configs.length > 0)
    const evilCall = await realMcpCall(evilHarness.configs[0]!, 'selector')
    expect(evilCall.childEnv).not.toHaveProperty('EDITOR')
    expect(evilCall.childEnv).not.toHaveProperty('PAGER')
    expect(evilCall.childEnv.PROBE_ENV_OUT).toBe(join(base, 'evil-env.json'))
  })

  it('pins the mirrored constants the server-side drift guard compares', () => {
    // The Go mirror parses these two literals out of this file; keep them plain.
    expect(SELECTOR_VALUE_ALLOWED_CHARS).toBe(
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./\\:+-',
    )
    expect(SELECTOR_INTERPRETER_TOKENS).toEqual([
      'sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'csh', 'tcsh', 'fish', 'busybox',
      'cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32',
      'python', 'perl', 'ruby', 'node', 'nodejs', 'php', 'lua', 'tclsh', 'osascript',
    ])
    // Every allowed character is ASCII and none is whitespace: the set IS the
    // "single argv[0]" boundary.
    expect(SELECTOR_VALUE_ALLOWED_CHARS).toMatch(/^[A-Za-z0-9_./\\:+-]+$/)
    for (const char of SELECTOR_VALUE_ALLOWED_CHARS) expect(char.codePointAt(0)!).toBeLessThan(128)
  })
})

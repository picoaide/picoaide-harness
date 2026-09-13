/**
 * The streamable-http fence patches a class it must SHARE with
 * `dsh-mcp-client`. The check that proves it resolves the SDK twice — once from
 * this module, once from mcp-client's entry — and compares the answers.
 *
 * That check was wrong on Windows, in the field (2026-07-13 Moka
 * `streamable-http` connector, client 2.7.2-beta.8):
 *
 *   … 传输不可加固: McpTransportFenceUnavailableError: MCP streamable-http
 *   传输加固目标与 mcp-client 不一致（本包 C:\Program Files\PicoAide Harness\
 *   resources\app.asar\node_modules\@modelcontextprotocol\sdk\dist\esm\client\
 *   streamableHttp.js / mcp-client C:\Program Files\…\streamableHttp.js），拒绝注册
 *
 * The two paths are byte-identical. The refusal came from the check BEFORE the
 * comparison: the package marker is written with `/`
 * (`node_modules/@modelcontextprotocol/sdk`) while Windows `fileURLToPath`
 * answers with `\`, so `lastIndexOf` found nothing and "unknown package" was
 * read as "wrong class" — the `||` short-circuited and no path comparison ever
 * ran. Linux CI could never see it: there `fileURLToPath` returns `/`.
 *
 * The decision is therefore driven here as a pure function with `win32` and
 * `linux` supplied explicitly, so the rule is asserted on every platform
 * instead of only on the one that failed:
 *
 * 1. one file, two spellings (separators, `\\?\`, and case where the platform
 *    folds it) → accept;
 * 2. two files, both readable (the measured CJS twin / a nested duplicate) →
 *    still refuse, loudly, with both paths in the report;
 * 3. a path the process cannot stat → do not turn "I could not read it" into
 *    "it is a different file"; the behavioural probe decides.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  canonicalMcpTargetPath,
  claimMcpTransportFenceTargetWarning,
  decideMcpTargets,
  installMcpTransportRedirectFence,
  isMcpTransportFenceTargetMismatch,
  isMcpTransportRedirectFenceInstalled,
  mcpTransportFenceTargetWarning,
  uninstallMcpTransportRedirectFence,
  type TargetResolution,
} from '../src/mcp-transport-fence.ts'

/**
 * The field report's two paths, verbatim (backslashes), under both spellings a
 * `realpathSync` may or may not return. The acceptance criterion is the one the
 * product needs: these are one file, so the connector must be allowed to
 * register.
 */
const FIELD_OURS = 'C:\\Program Files\\PicoAide Harness\\resources\\app.asar\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\client\\streamableHttp.js'
const FIELD_THEIRS = 'C:\\Program Files\\PicoAide Harness\\resources\\app.asar\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\client\\streamableHttp.js'
const FIELD_REAL = 'C:\\Program Files\\PicoAide Harness\\resources\\app.asar\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\client\\streamableHttp.js'

/** A resolution as the reader would produce it, without touching the disk. */
function target(path: string, options: { realpath?: string | null; error?: string | null; foldCase?: boolean } = {}): TargetResolution {
  const realpath = options.realpath === undefined ? path : options.realpath
  return {
    path,
    canonical: canonicalMcpTargetPath(realpath ?? path, options.foldCase ?? false),
    realpath,
    error: options.error ?? null,
  }
}

const SDK_TAIL = 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'
const CJS_TAIL = 'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js'

let root = ''
let esm = ''
let cjs = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pico-fence-target-'))
  esm = join(root, SDK_TAIL)
  cjs = join(root, CJS_TAIL)
  for (const file of [esm, cjs]) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '// fixture\n')
  }
})

afterEach(() => {
  uninstallMcpTransportRedirectFence()
})

describe('fence target identity: the field failure (Windows, backslash paths)', () => {
  it('accepts the two identical field paths on win32 instead of refusing them', () => {
    const ours = target(FIELD_OURS, { foldCase: true })
    const theirs = target(FIELD_THEIRS, { foldCase: true })
    const verdict = decideMcpTargets(ours, theirs, true)
    // The regression is the assertion: before the fix this was
    // 'inconclusive' with a missing marker → install path refused.
    expect(verdict.kind).toBe('ok')
    expect(verdict.kind === 'ok' && verdict.ours.canonical).toContain('node_modules/@modelcontextprotocol/sdk')
  })

  it('accepts the field paths even when the reader could not stat them', () => {
    // `app.asar` virtual paths are the reason this shape exists at all.
    const ours = target(FIELD_OURS, { realpath: null, error: 'ENOENT', foldCase: true })
    const theirs = target(FIELD_THEIRS, { realpath: null, error: 'ENOENT', foldCase: true })
    const verdict = decideMcpTargets(ours, theirs, true)
    expect(verdict.kind).toBe('ok')
  })

  it('accepts one file spelled with backslashes or an extended-length prefix', () => {
    const spellings = [
      esm.replace(/\//g, '\\'),
      `\\\\?\\${esm.replace(/\//g, '\\')}`,
      `//?/${esm}`,
    ]
    for (const spelling of spellings) {
      uninstallMcpTransportRedirectFence()
      for (const foldCase of [false, true]) {
        const verdict = decideMcpTargets(target(esm, { foldCase }), target(spelling, { foldCase }), foldCase)
        expect(verdict.kind, `${spelling} (foldCase=${String(foldCase)})`).toBe('ok')
      }
    }
  })

  it('treats a case-only difference as the same file exactly where the platform folds case', () => {
    const upper = esm.toUpperCase()
    expect(canonicalMcpTargetPath(upper, true)).toBe(canonicalMcpTargetPath(esm, true))
    expect(canonicalMcpTargetPath(upper, false)).not.toBe(canonicalMcpTargetPath(esm, false))
    // Case-insensitive filesystems also RESOLVE the other spelling; a
    // case-sensitive one does not even find it. Both are correct — assert the
    // platform's own answer rather than an assumption about the runner.
    const resolvesAnyway = existsSync(upper)
    const verdict = decideMcpTargets(target(esm, { foldCase: true }), target(upper, {
      realpath: resolvesAnyway ? canonicalMcpTargetPath(upper, true) : null,
      error: resolvesAnyway ? null : 'ENOENT',
      foldCase: true,
    }), true)
    expect(verdict.kind).toBe('ok')
  })

  it('folds case only where the platform folds it', () => {
    expect(canonicalMcpTargetPath(esm.toUpperCase(), true)).toBe(canonicalMcpTargetPath(esm, true))
    expect(canonicalMcpTargetPath(esm.toUpperCase(), false)).not.toBe(canonicalMcpTargetPath(esm, false))
    expect(canonicalMcpTargetPath(esm.replace(/\//g, '\\'))).toBe(canonicalMcpTargetPath(esm))
    expect(canonicalMcpTargetPath('\\\\?\\C:\\x', true)).toBe('c:/x')
    expect(canonicalMcpTargetPath('C:\\x', true)).toBe('c:/x')
    expect(canonicalMcpTargetPath('C:\\x', false)).toBe('C:/x')
  })

  it('still refuses — with both paths in the report — when the two readable paths are different files', () => {
    const verdict = decideMcpTargets(target(esm), target(cjs), false)
    expect(verdict.kind).toBe('proven-other')
  })

  it('does not refuse when one of the two paths cannot be read (app.asar / EPERM)', () => {
    const unreadable = target(join(root, 'app.asar', SDK_TAIL), { realpath: null, error: 'EPERM' })
    const verdict = decideMcpTargets(target(esm), unreadable, false)
    expect(verdict.kind).toBe('inconclusive')
  })
})

describe('fence target identity: the install path acts on the verdict', () => {
  it('installs and stays silent when the two resolutions agree', () => {
    installMcpTransportRedirectFence({ ours: esm, theirs: esm })
    expect(isMcpTransportRedirectFenceInstalled()).toBe(true)
    expect(mcpTransportFenceTargetWarning()).toBeNull()
    expect(isMcpTransportFenceTargetMismatch()).toBe(false)
    expect(claimMcpTransportFenceTargetWarning()).toBe(false)
  })

  it('refuses, remembers and reports both paths for two readable different files', () => {
    let caught: Error | null = null
    try {
      installMcpTransportRedirectFence({ ours: esm, theirs: cjs })
    } catch (error) {
      caught = error as Error
    }
    expect(caught?.message).toMatch(/不一致/)
    expect(caught?.message).toContain(esm)
    expect(caught?.message).toContain(cjs)
    expect(isMcpTransportRedirectFenceInstalled()).toBe(false)
    expect(isMcpTransportFenceTargetMismatch()).toBe(true)
    expect(claimMcpTransportFenceTargetWarning()).toBe(false)
  })

  it('installs with a one-shot warning when one path cannot be read', () => {
    const unreadable = join(root, 'app.asar', SDK_TAIL)
    expect(() => installMcpTransportRedirectFence({ ours: esm, theirs: unreadable })).not.toThrow()
    expect(isMcpTransportRedirectFenceInstalled()).toBe(true)
    const warning = mcpTransportFenceTargetWarning()
    expect(warning).toContain(esm)
    expect(warning).toContain(unreadable)
    expect(warning).toContain('unreadable:ENOENT')
    expect(claimMcpTransportFenceTargetWarning()).toBe(true)
    expect(claimMcpTransportFenceTargetWarning()).toBe(false)
  })

  it('forgets the verdict when the fence is uninstalled', () => {
    expect(() => installMcpTransportRedirectFence({ ours: esm, theirs: cjs })).toThrow()
    expect(isMcpTransportFenceTargetMismatch()).toBe(true)
    uninstallMcpTransportRedirectFence()
    expect(isMcpTransportFenceTargetMismatch()).toBe(false)
    expect(mcpTransportFenceTargetWarning()).toBeNull()
  })
})

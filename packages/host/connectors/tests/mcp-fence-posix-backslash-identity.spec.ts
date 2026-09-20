/**
 * conn-3 (audit R7, P2): `canonicalMcpTargetPath` folded `\` into `/` on every
 * platform, and `sameFile` compared only the canonical forms. On POSIX `\` is
 * an ordinary filename byte, so ONE real file whose NAME contains the SDK tail
 * (`node_modules\@modelcontextprotocol\client\...\index.mjs`) canonicalised
 * onto a DIFFERENT real file's path: `decideTargets` answered `ok` and
 * `installMcpTransportRedirectFence` installed silently — breaking R5's
 * "two readable different files are refused" rule and this module's own
 * contract ("Make two spellings of one file compare equal — **and only
 * those**").
 *
 * The fix folds separators only where the platform folds them (win32, or an
 * input that is Windows-shaped: drive letter / UNC / extended-length prefix),
 * and `sameFile` compares the resolved bytes before it falls back to the
 * canonical form. The Windows spellings from the R5 field report must keep
 * comparing equal — asserted here as well as in
 * `mcp-fence-target-identity.spec.ts`.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  canonicalMcpTargetPath,
  decideMcpTargets,
  installMcpTransportRedirectFence,
  isMcpTransportFenceTargetMismatch,
  isMcpTransportRedirectFenceInstalled,
  uninstallMcpTransportRedirectFence,
  type TargetResolution,
} from '../src/mcp-transport-fence.ts'

// v2 (2026-09-20): the SDK is one ESM bundle under `@modelcontextprotocol/client`.
const SDK_TAIL = 'node_modules/@modelcontextprotocol/client/dist/index.mjs'

/** A resolution exactly as `resolveTarget` builds it (real `realpathSync`). */
function resolved(path: string, foldCase = false): TargetResolution {
  let realpath: string | null = null
  let error: string | null = null
  try {
    realpath = realpathSync(path)
  } catch (cause) {
    error = (cause as { code?: string }).code ?? String(cause)
  }
  return { path, canonical: canonicalMcpTargetPath(realpath ?? path, foldCase), realpath, error }
}

/** A resolution the process cannot stat (the `app.asar` / EPERM shape). */
function unreadable(path: string, foldCase = false): TargetResolution {
  return { path, canonical: canonicalMcpTargetPath(path, foldCase), realpath: null, error: 'ENOENT' }
}

afterEach(() => {
  uninstallMcpTransportRedirectFence()
})

describe('conn-3: POSIX backslash folding no longer merges two different files', () => {
  it('keeps a POSIX filename containing backslashes distinct from the SDK path', () => {
    const root = mkdtempSync(join(tmpdir(), 'pico-fence-bslash-'))
    const realDir = join(root, 'a')
    mkdirSync(join(realDir, 'node_modules/@modelcontextprotocol/client/dist'), { recursive: true })
    const realFile = join(realDir, SDK_TAIL)
    writeFileSync(realFile, '// real sdk copy\n')

    // ONE POSIX file whose NAME is the whole SDK tail spelled with backslashes.
    const fakeFile = join(realDir, SDK_TAIL.split('/').join('\\'))
    writeFileSync(fakeFile, '// a different file\n')

    const fakeReal = realpathSync(fakeFile)
    const realReal = realpathSync(realFile)
    console.log(`[conn-3] canonical(fake) = ${canonicalMcpTargetPath(fakeReal, false)}`)
    console.log(`[conn-3] canonical(real) = ${canonicalMcpTargetPath(realReal, false)}`)
    expect(fakeReal).not.toBe(realReal)
    expect(canonicalMcpTargetPath(fakeReal, false)).toBe(fakeReal)
    expect(canonicalMcpTargetPath(fakeReal, false)).not.toBe(canonicalMcpTargetPath(realReal, false))

    // Two readable, different files: the R5 rule is a hard refusal.
    const verdict = decideMcpTargets(resolved(realFile), resolved(fakeFile), false)
    console.log(`[conn-3] verdict = ${verdict.kind}`)
    expect(verdict.kind).toBe('proven-other')

    let caught: Error | null = null
    try {
      installMcpTransportRedirectFence({ ours: realFile, theirs: fakeFile })
    } catch (error) {
      caught = error as Error
    }
    console.log(`[conn-3] install threw: ${caught?.message.slice(0, 90) ?? 'no'}`)
    expect(caught?.message).toMatch(/不一致/)
    expect(isMcpTransportRedirectFenceInstalled()).toBe(false)
    expect(isMcpTransportFenceTargetMismatch()).toBe(true)
  })

  it('no longer answers plain "ok" when the backslash-named file is this package side', () => {
    const root = mkdtempSync(join(tmpdir(), 'pico-fence-bslash-ours-'))
    const realDir = join(root, 'a')
    mkdirSync(join(realDir, 'node_modules/@modelcontextprotocol/client/dist'), { recursive: true })
    const realFile = join(realDir, SDK_TAIL)
    writeFileSync(realFile, '// real sdk copy\n')
    const fakeFile = join(realDir, SDK_TAIL.split('/').join('\\'))
    writeFileSync(fakeFile, '// a different file\n')

    // A file that is not an SDK copy is the documented markerless case
    // (r7c-5): a warning, never a silent "these are the same file".
    const verdict = decideMcpTargets(resolved(fakeFile), resolved(realFile), false)
    console.log(`[conn-3] markerless-ours verdict = ${verdict.kind}`)
    expect(verdict.kind).not.toBe('ok')
  })
})

describe('conn-3: the Windows spellings from the R5 field report still compare equal', () => {
  it('folds drive-letter and UNC spellings on every platform', () => {
    expect(canonicalMcpTargetPath('C:\\x', false)).toBe('C:/x')
    expect(canonicalMcpTargetPath('C:\\x', true)).toBe('c:/x')
    expect(canonicalMcpTargetPath('\\\\?\\C:\\x', true)).toBe('c:/x')
    expect(canonicalMcpTargetPath('//?/C:/x', false)).toBe('C:/x')
    expect(canonicalMcpTargetPath('\\\\server\\share\\sdk.js', false)).toBe('//server/share/sdk.js')
    // A POSIX name with backslashes is NOT a Windows spelling.
    expect(canonicalMcpTargetPath('/opt/app/node_modules\\@modelcontextprotocol\\client', false))
      .toBe('/opt/app/node_modules\\@modelcontextprotocol\\client')
  })

  it('accepts one unreadable app.asar file spelled with an extended-length prefix', () => {
    const plain = 'C:\\Program Files\\PicoAide Harness\\resources\\app.asar\\node_modules\\@modelcontextprotocol\\client\\dist\\index.mjs'
    // Identical spellings: same file, byte for byte.
    expect(decideMcpTargets(unreadable(plain, true), unreadable(plain, true), true).kind).toBe('ok')
    // One spelling carries the extended-length prefix the packaged app adds.
    expect(decideMcpTargets(unreadable(plain, true), unreadable(`\\\\?\\${plain}`, true), true).kind).toBe('ok')
    // …while a genuinely different drive path is still refused once readable.
    const moved = plain.replace('C:\\Program Files', 'C:\\Users\\public')
    expect(canonicalMcpTargetPath(plain, true)).not.toBe(canonicalMcpTargetPath(moved, true))
  })
})

/**
 * Generic i18n dictionary hygiene.
 *
 * `i18n-keys.spec.ts` guards key *usage* but only for an explicit allowlist of
 * packages, so a new dictionary could ship untranslated or half-mirrored values
 * unnoticed (the 2026-09-16 audit found 79 dead keys in `dsh-enterprise` for
 * exactly that reason). This spec discovers every client dictionary in the
 * workspace instead of listing them, and pins the two invariants that are cheap
 * to check and expensive to miss:
 *
 * 1. **Key parity** — the `en` block mirrors the `zh` block exactly. The typed
 *    `Record<keyof typeof zh, string>` already enforces this at compile time,
 *    but only for the packages that spell it that way; this catches the rest.
 * 2. **No Chinese in `en` values** — a copy-pasted `zh` value is invisible in
 *    review and shows Chinese to an English user. The 2026-09-15 BUG-07 class.
 *
 * Discovery is deliberately broad: a dictionary that stops being found would
 * otherwise make this guard pass vacuously, so the discovered set is asserted
 * to be non-trivial.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** Any CJK ideograph, including the extension-A range. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/u

/**
 * Dictionaries that live outside the `src/client/locales.ts` convention.
 *
 * `dsh-memory-evolve` inlines its (797-key) dictionary in the plugin entry
 * instead of a dedicated module; list it here rather than reshaping a vendored
 * package for the sake of a scanner.
 */
const EXTRA_DICTIONARY_SOURCES = [
  'packages/vendor/memory-evolve/src/client/index.ts',
]

/**
 * Find every `src/client/locales.ts` under `packages/`.
 * @returns repo-relative paths, sorted for stable failure output.
 */
function discoverDictionaryFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.includes('locales.ts') && dir.endsWith(join('src', 'client'))) {
      found.push(relative(REPO_ROOT, join(dir, 'locales.ts')))
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'lib' || entry === 'dist' || entry === 'build') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path, depth + 1)
    }
  }
  walk(join(REPO_ROOT, 'packages'), 0)
  return [...found, ...EXTRA_DICTIONARY_SOURCES].sort()
}

/**
 * Parse the `zh` / `en` object literals out of a dictionary source.
 *
 * Only the flat `'key': 'value'` shape the workspace uses is understood; a
 * nested value would be reported as a missing key rather than silently ignored.
 * @param source - dictionary file contents.
 * @returns the two key→value maps (empty when the block is absent).
 */
function parseDictionaries(source: string): { zh: Record<string, string>; en: Record<string, string> } {
  const block = (name: string): Record<string, string> => {
    const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*\\{`, 'u').exec(source)
    if (match === null) return {}
    // Walk braces from the opening `{` so a nested object cannot truncate us early.
    let depth = 0
    let end = match.index + match[0].length - 1
    for (let index = end; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    const body = source.slice(match.index + match[0].length, end)
    const out: Record<string, string> = {}
    for (const entry of body.matchAll(/^\s{2}'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|`([^`]*)`)\s*,/gmu)) {
      out[entry[1]!] = entry[2] ?? entry[3] ?? ''
    }
    return out
  }
  return { zh: block('zh'), en: block('en') }
}

const DICTIONARY_FILES = discoverDictionaryFiles()

describe('i18n dictionaries stay complete and untranslated-free', () => {
  it('discovers the workspace dictionaries (guards against a vacuous pass)', () => {
    expect(DICTIONARY_FILES.length, `discovered: ${DICTIONARY_FILES.join(', ')}`).toBeGreaterThanOrEqual(6)
    for (const required of [
      'packages/host/connectors/src/client/locales.ts',
      'packages/host/cron/src/client/locales.ts',
      'packages/host/enterprise/src/client/locales.ts',
      'packages/host/browser/src/client/locales.ts',
      'packages/host/desktop/src/client/locales.ts',
      'packages/client/account-card/src/client/locales.ts',
      'packages/client/branding/src/client/locales.ts',
    ]) {
      expect(DICTIONARY_FILES, `missing ${required}`).toContain(required)
    }
  })

  for (const file of DICTIONARY_FILES) {
    describe(file, () => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      const { zh, en } = parseDictionaries(source)

      it('declares both blocks with keys', () => {
        expect(Object.keys(zh).length, `${file}: zh block`).toBeGreaterThan(0)
        expect(Object.keys(en).length, `${file}: en block`).toBeGreaterThan(0)
      })

      it('mirrors the key set exactly', () => {
        const zhKeys = Object.keys(zh).sort()
        const enKeys = Object.keys(en).sort()
        const missing = zhKeys.filter(key => !(key in en))
        const extra = enKeys.filter(key => !(key in zh))
        expect(missing, `${file}: keys without an English value`).toEqual([])
        expect(extra, `${file}: English keys with no zh source`).toEqual([])
      })

      it('has no Chinese left in the English values', () => {
        const leaked = Object.entries(en)
          .filter(([, value]) => CJK.test(value))
          .map(([key, value]) => `${key} = ${value}`)
        expect(leaked, `${file}: en values still containing Chinese`).toEqual([])
      })

      it('has no empty or whitespace-only values', () => {
        for (const [key, value] of Object.entries(en)) {
          expect(value.trim(), `${file}: en['${key}'] is blank`).not.toBe('')
        }
        for (const [key, value] of Object.entries(zh)) {
          expect(value.trim(), `${file}: zh['${key}'] is blank`).not.toBe('')
        }
      })
    })
  }
})

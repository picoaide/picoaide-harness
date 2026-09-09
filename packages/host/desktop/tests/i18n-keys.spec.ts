/**
 * i18n dead-key guard (audit 2026-09-08 P3, `temp/audit-electron/i18n-check.mjs`
 * promoted into the package test suite).
 *
 * Two invariants for every client dictionary this workspace owns:
 * 1. every key the client code asks for via `t('…')` exists in the dictionary;
 * 2. every dictionary key is referenced by the client code — zero dead keys.
 * The desktop package has no `t()` dictionary; its typed tray copy is checked
 * the same way (every `DesktopTrayLabelKey` must be consumed by a call site).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** Packages with a client dictionary (`src/client/locales.ts`). */
const DICTIONARY_PACKAGES = [
  'packages/client/account-card',
  'packages/host/browser',
  'packages/host/connectors',
  'packages/host/cron',
]

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (['.ts', '.tsx'].includes(extname(path))) out.push(path)
  }
  return out
}

/** Dictionary keys declared as `  'key': …` (zh + en blocks share the shape). */
function dictionaryKeys(source: string): string[] {
  return [...source.matchAll(/^\s{2}'([^']+)':/gmu)].map(match => match[1]!)
}

describe('i18n dictionaries have no dead or missing keys', () => {
  for (const pkg of DICTIONARY_PACKAGES) {
    it(`${pkg} keys are all used and all used keys exist`, () => {
      const localeFile = join(REPO_ROOT, pkg, 'src', 'client', 'locales.ts')
      const dictionary = readFileSync(localeFile, 'utf8')
      const sources = walk(join(REPO_ROOT, pkg, 'src'))
        .filter(file => file !== localeFile)
        .map(file => readFileSync(file, 'utf8'))
        .join('\n')
      const keys = new Set(dictionaryKeys(dictionary))
      expect(keys.size, `${pkg} dictionary must declare keys`).toBeGreaterThan(0)

      const used = new Set([...sources.matchAll(/\bt\(\s*'([^']+)'/gu)].map(match => match[1]!))
      const missing = [...used].filter(key => !keys.has(key)).sort()
      expect(missing, `${pkg}: t('key') without a dictionary entry`).toEqual([])

      // A key is "referenced" when its literal appears anywhere in the package
      // sources — this also covers dynamically dispatched keys such as cron's
      // `t(preset.key)` where the literals live in a typed preset table.
      const dead = [...keys].filter(key => !sources.includes(`'${key}'`)).sort()
      expect(dead, `${pkg}: dictionary keys nobody references`).toEqual([])
    })
  }

  it('every desktop tray label key has a call site', () => {
    const trayLocale = readFileSync(join(REPO_ROOT, 'packages/host/desktop/src/tray-locale.ts'), 'utf8')
    const union = /export type DesktopTrayLabelKey =([\s\S]*?)\n\n/u.exec(trayLocale)?.[1] ?? ''
    const keys = [...union.matchAll(/'([A-Za-z]+)'/gu)].map(match => match[1]!)
    expect(keys.length).toBeGreaterThan(0)
    const sources = walk(join(REPO_ROOT, 'packages/host/desktop/src'))
      .filter(file => !file.endsWith('tray-locale.ts'))
      .map(file => readFileSync(file, 'utf8'))
      .join('\n')
    const dead = keys.filter(key => !sources.includes(`'${key}'`)).sort()
    expect(dead, 'desktop tray label keys nobody references').toEqual([])
  })
})

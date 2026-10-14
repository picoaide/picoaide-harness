/**
 * 能力中心客户端字典（`src/client/locales.ts`）的卫生回归。
 *
 * 2026-10-13：本文件由 `@picoaide/dsh-enterprise` 的 `tests/locales-hygiene.spec.ts`
 * **同形搬来并覆盖同一组判据**（那里的 75 个 `capability.*` 键随能力中心的客户端面
 * 整块搬进本包）：
 *   1. zh/en 键集完全一致（编译器之外再钉一次，防止 en 多出孤儿键）；
 *   2. en 的值里没有任何 CJK 字符；
 *   3. 两个块里都没有空值；
 *   4. **零死键**：每个键都在本包源码里有引用点（与 desktop `i18n-keys.spec.ts`
 *      的 DICTIONARY_PACKAGES 判据同源，本包已登记进那份名单）；
 *   5. **零缺失**：每个 `t('key')` 都有字典条目；
 *   6. 带参数的键在**两种语言**下都能替换模板（`capability.nameTaken` 是搬出前的
 *      现场键，逐字保留）。
 *
 * 为什么还要在包内再钉一遍（desktop 那两条守卫已覆盖本包）：那两条跑在桌面包的
 * `check` 里，而本包的字典在**搬包**这种改动里最容易静默走样（键路径、命名空间、
 * 引用点三者任一错位都不影响 `tsc`）；包内判据让失败落在改动者正在跑的那个包里。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { en, setActiveLocale, t, zh } from '../src/client/locales.ts'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOCALE_FILE = join(PKG_ROOT, 'src', 'client', 'locales.ts')
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (['.ts', '.tsx'].includes(extname(path))) out.push(path)
  }
  return out
}

/** 包内除字典本身以外的全部源码（含客户端面）。 */
function packageSources(): string {
  return walk(join(PKG_ROOT, 'src'))
    .filter(file => file !== LOCALE_FILE)
    .map(file => readFileSync(file, 'utf8'))
    .join('\n')
}

afterEach(() => { setActiveLocale('zh') })

describe('能力中心字典卫生', () => {
  it('zh/en 键集完全一致（编译器之外再钉一次，防止 en 多出孤儿键）', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(0)
  })

  it('en 的值里没有任何 CJK 字符（英文界面不许漏中文）', () => {
    const offenders = Object.entries(en)
      .filter(([, value]) => CJK.test(value))
      .map(([key, value]) => `${key}=${value}`)
    expect(offenders).toEqual([])
  })

  it('两个块里都没有空值', () => {
    for (const [key, value] of Object.entries(en)) expect(value.trim(), `en['${key}'] 是空的`).not.toBe('')
    for (const [key, value] of Object.entries(zh)) expect(value.trim(), `zh['${key}'] 是空的`).not.toBe('')
  })

  it('零死键：每个键都在包内源码里被引用（与 desktop i18n-keys 守卫同判据）', () => {
    const sources = packageSources()
    const dead = Object.keys(zh).filter(key => !sources.includes(`'${key}'`)).sort()
    expect(dead, '字典键没有任何引用点').toEqual([])
  })

  it("零缺失：每个 t('key') 都有字典条目", () => {
    const sources = packageSources()
    const used = new Set([...sources.matchAll(/\bt\(\s*'([^']+)'/gu)].map(match => match[1]!))
    const missing = [...used].filter(key => !(key in zh)).sort()
    expect(missing, "t('key') 缺字典条目").toEqual([])
  })

  it('带参数的键在两种语言下都能替换模板', () => {
    expect(t('capability.nameTaken', { name: 'demo' })).toContain('demo')
    expect(t('capability.title')).toBe('能力中心')
    setActiveLocale('en')
    expect(t('capability.nameTaken', { name: 'demo' })).toContain('demo')
    expect(t('capability.nameTaken', { name: 'demo' })).not.toMatch(CJK)
    expect(t('capability.title')).toBe('Capability Hub')
  })
})

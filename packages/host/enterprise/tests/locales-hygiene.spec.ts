/**
 * 企业客户端字典（`src/client/locales.ts`）的卫生回归（2026-09-16 i18n）。
 *
 * 背景：这份字典有 **79 个死键**（171 个里 46%）—— 独立的技能中心 / 共享 Agent
 * 面板被能力中心取代后，`skill.*`(36) / `agent.*`(31) / `session.*`(6) 与
 * `capability.*` 的 5 个以及 `account.password.success` 留在原地没人删。死键本身
 * 不影响运行，但会让"这块文案还在用"的错觉持续存在，也让
 * `packages/host/desktop/tests/i18n-keys.spec.ts` 的 DICTIONARY_PACKAGES 名单
 * 永远加不进 enterprise（那份守卫要求**零死键 + 零缺失键**）。
 *
 * 本文件把同一套判据（外加 zh/en 对齐与 en 无中文）本地化钉住，这样：
 *   1. 死键不会重新长回来；
 *   2. 新键（本次新增 capability.nameTaken / hero.tagline）一定有引用点；
 *   3. 桌面包把 enterprise 加进 allowlist 时能直接通过。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { en, setActiveLocale, t, zh } from '../src/client/locales.ts'
import { afterEach } from 'vitest'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOCALE_FILE = join(PKG_ROOT, 'src', 'client', 'locales.ts')
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u

/** 本次删除的 79 个死键（前缀 + 例外清单）。 */
const DELETED_PREFIXES = ['skill.', 'agent.', 'session.'] as const
const DELETED_EXACT = [
  'capability.tabOrg', 'capability.installing', 'capability.uploading',
  'capability.emptyOrg', 'capability.versionCount',
  'account.password.success',
] as const

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (['.ts', '.tsx'].includes(extname(path))) out.push(path)
  }
  return out
}

/** 包内除字典本身以外的全部源码（含 client 面与宿主面）。 */
function packageSources(): string {
  return walk(join(PKG_ROOT, 'src'))
    .filter(file => file !== LOCALE_FILE)
    .map(file => readFileSync(file, 'utf8'))
    .join('\n')
}

afterEach(() => { setActiveLocale('zh') })

describe('企业字典卫生', () => {
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

  it('79 个死键已从两个块里删除', () => {
    const source = readFileSync(LOCALE_FILE, 'utf8')
    const declared = new Set([...source.matchAll(/^\s{2}'([^']+)':/gmu)].map(m => m[1]!))
    const stillThere = [...declared].filter(key =>
      DELETED_PREFIXES.some(prefix => key.startsWith(prefix))
      || (DELETED_EXACT as readonly string[]).includes(key))
    expect(stillThere).toEqual([])
    // 反向保护：别把仍在用的键当死键删掉（这些是能力中心/账号/更新面的核心）。
    for (const key of ['capability.title', 'capability.nameTaken', 'hero.tagline', 'account.password.errOld', 'update.upToDate']) {
      expect(declared.has(key), `${key} 必须保留`).toBe(true)
    }
  })

  it('零死键：每个键都在包内源码里被引用（与 desktop i18n-keys 守卫同判据）', () => {
    const sources = packageSources()
    const dead = Object.keys(zh).filter(key => !sources.includes(`'${key}'`)).sort()
    expect(dead, '字典键没有任何引用点').toEqual([])
  })

  it('零缺失：每个 t(\'key\') 都有字典条目', () => {
    const sources = packageSources()
    const used = new Set([...sources.matchAll(/\bt\(\s*'([^']+)'/gu)].map(m => m[1]!))
    const missing = [...used].filter(key => !(key in zh)).sort()
    expect(missing, "t('key') 缺字典条目").toEqual([])
  })

  it('新增键在两种语言下都有可用文案', () => {
    expect(t('capability.nameTaken', { name: 'demo' })).toContain('demo')
    expect(t('hero.tagline')).toBe('企业版')
    setActiveLocale('en')
    expect(t('capability.nameTaken', { name: 'demo' })).toContain('demo')
    expect(t('capability.nameTaken', { name: 'demo' })).not.toMatch(CJK)
    expect(t('hero.tagline')).toBe('Enterprise')
  })
})

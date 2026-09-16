/**
 * S4（2026-09-16）：浏览器侧私有字典必须**跟随界面语言**，而不是操作系统语言。
 *
 * 事故形态（静默）：随包客户端里有 7 处自带 zh/en 双语的私有字典
 * （CoIView / PromptView / BroadcastView / AdvisorPanel / MemoryQueueView /
 * TodoView / SyncView），它们此前用
 *
 *     const LANG = navigator.language?.startsWith('en') ? 'en' : 'zh'
 *
 * 判定语言 —— 两个错叠在一起：①看的是**操作系统语言**而非界面语言；
 * ②在**模块加载期求值一次**。于是用户在「设置 → 通用 → 语言」里切到英文
 * （或系统英文、用户切中文）时，这些界面停在旧语言，且没有任何报错。
 *
 * 修复后的契约：所有私有字典经 `clientLang()` 取语言；client 入口在 apply()
 * 里注册**调用期**解析器（读 locale 快照的 active）。本文件钉两件事：
 *   1. `clientLang()` 的解析契约（注册/未注册/非法值/注销）；
 *   2. 源码里不得再有 `navigator.language` 直接判定 + 不得有模块级
 *      `LANG` 常量（防回归）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientLang, setClientLocaleResolver } from '../lib/i18n.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_ROOT = join(PACKAGE_ROOT, 'src', 'client')

function clientSources() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/u.test(entry)) out.push(path)
    }
  }
  walk(CLIENT_ROOT)
  return out
}

/**
 * 未注册解析器时的回落值 = 运行环境的 `navigator.language`（node --test 会带上
 * 宿主机的语言，实测 'en-US'），没有 navigator 时才是 'zh'。测试**不能硬编码**
 * 宿主机语言，否则同一份代码在不同机器上红绿不一。
 */
function navigatorFallback() {
  const language = globalThis.navigator?.language
  return typeof language === 'string' && language.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

test('clientLang：未注册时回落 navigator.language（老行为保底）', () => {
  setClientLocaleResolver(null)
  try {
    assert.equal(clientLang(), navigatorFallback())
  } finally {
    setClientLocaleResolver(null)
  }
})

test('clientLang：注册后按解析器返回值，且是**调用期**解析（语言可随时变）', () => {
  let active = 'zh'
  setClientLocaleResolver(() => active)
  try {
    assert.equal(clientLang(), 'zh')
    active = 'en'
    assert.equal(clientLang(), 'en', '解析器变化必须立刻反映（这就是 S4 的修复点）')
  } finally {
    setClientLocaleResolver(null)
  }
})

test('clientLang：解析器返回非法值时回落，不返回 undefined', () => {
  setClientLocaleResolver(() => 'ja')
  try {
    assert.equal(clientLang(), navigatorFallback())
  } finally {
    setClientLocaleResolver(null)
  }
})

test('clientLang：注销后回到回落路径', () => {
  setClientLocaleResolver(() => 'en')
  assert.equal(clientLang(), 'en')
  setClientLocaleResolver(null)
  assert.equal(clientLang(), navigatorFallback())
})

test('源码里不得再用 navigator.language 判定语言（除注释）', () => {
  const offenders = []
  for (const path of clientSources()) {
    const source = readFileSync(path, 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      if (!line.includes('navigator.language')) continue
      const trimmed = line.trim()
      // 注释里提到历史做法是允许的
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      offenders.push(`${path.replace(PACKAGE_ROOT, '')}:${index + 1}: ${trimmed.slice(0, 80)}`)
    }
  }
  assert.deepEqual(offenders, [], `私有字典必须经 clientLang() 取语言：\n${offenders.join('\n')}`)
})

test('源码里不得再有模块级冻结语言的 LANG 常量', () => {
  const offenders = []
  for (const path of clientSources()) {
    const source = readFileSync(path, 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      if (/^const\s+LANG\b/u.test(line.trim())) offenders.push(`${path.replace(PACKAGE_ROOT, '')}:${index + 1}`)
    }
  }
  assert.deepEqual(offenders, [], `模块级 LANG 常量会在加载期钉死语言：\n${offenders.join('\n')}`)
})

test('client 入口**注册**了解析器（承重接线，删掉即静默回退系统语言）', async () => {
  // NF-A5（2026-09-16 对抗复核）：整条"跟随界面语言"链路的承重件是
  // src/client/index.ts 里那一行 setClientLocaleResolver(() => ctx.locale…)。
  // 删掉它，987 例曾全部照绿，而所有私有字典会静默退回 navigator.language。
  const entry = readFileSync(join(CLIENT_ROOT, 'index.ts'), 'utf8')
  assert.match(
    entry,
    /setClientLocaleResolver\(\(\) => \{?[\s\S]{0,200}?ctx\.locale\.getSnapshot\(\)\.active/u,
    'client 入口必须把 locale 快照的 active 注册给 clientLang（否则私有字典退回系统语言）',
  )
  assert.match(entry, /ctx\.effect\([\s\S]{0,400}?setClientLocaleResolver\(null\)/u, '必须在 effect 清理里注销解析器')
  // 打包产物里也必须真的有这两个符号（src 改了但没重建 bundle = 用户看不到）
  const bundle = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(bundle.includes('setClientLocaleResolver'), 'lib/client.js 必须已重建（含 resolver）')
  assert.ok(bundle.includes('getSnapshot()'), 'lib/client.js 里应有 locale 快照读取')
})

test('仍带私有字典的文件都 import 了 clientLang', () => {
  // 2026-09-16 i18n 收敛：CoIView / PromptView / AdvisorPanel 的私有字典已
  // **迁入注册字典**（src/client/index.ts 的 zh/en，键前缀 coi./prompt./advisor.）
  // 并经 slot 注入的 t 取值，不再需要 clientLang。剩下的这 4 个文件仍自带
  // zh/en 私有字典，必须经 clientLang 跟随界面语言（S4 契约）。
  const dictionaryFiles = [
    'BroadcastView.tsx',
    'MemoryQueueView.tsx',
    'TodoView.tsx',
    'SyncView.tsx',
  ]
  for (const relative of dictionaryFiles) {
    const source = readFileSync(join(CLIENT_ROOT, relative), 'utf8')
    assert.match(
      source,
      /import \{[^}]*clientLang[^}]*\} from '[^']*i18n\.js'/u,
      `${relative} 必须 import clientLang`,
    )
  }
})

test('已迁入注册字典的视图：无私有 DICT、键带前缀、经注入的 t 取值', () => {
  // 迁移必须留下可复查的痕迹，否则"绕开 ctx.locale 的第二份真源"会悄悄回来。
  // ⚠️ 断言只看**代码**：迁移说明的注释里会点名旧实现（DICT / LEVEL_LABEL），
  // 拿整份源码断言会自己绊自己。
  const codeOnly = (source) => source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//u.test(line))
    .join('\n')
  const migrated = [
    { file: 'CoIView.tsx', prefix: 'coi.' },
    { file: 'PromptView.tsx', prefix: 'prompt.' },
    { file: join('advisor', 'AdvisorPanel.tsx'), prefix: 'advisor.' },
    { file: join('advisor', 'advisor-store.ts'), prefix: 'advisor.' },
  ]
  for (const { file, prefix } of migrated) {
    const source = codeOnly(readFileSync(join(CLIENT_ROOT, file), 'utf8'))
    assert.doesNotMatch(source, /^const DICT = \{/mu, `${file} 不应再有私有 DICT 字典`)
    assert.doesNotMatch(source, /LEVEL_LABEL|OUTCOME_ZH|OUTCOME_EN/u, `${file} 不应再留模块级标签常量`)
    assert.match(
      source,
      new RegExp(`'${prefix.replace('.', '\\.')}[A-Za-z0-9_.]+'`, 'u'),
      `${file} 的字典键必须带 '${prefix}' 前缀（真源在 src/client/index.ts）`,
    )
  }
})

test('字典真源（index.ts）：zh/en 键集完全一致、en 列无 CJK 残留', () => {
  // en: Record<MemoryEvolveKey, string> 只在 tsc 下成立，而本包门禁是 node --test
  // （不做类型检查）—— 这里补一条运行期断言，防止"改了 zh 忘了 en"静默漂移。
  const entry = readFileSync(join(CLIENT_ROOT, 'index.ts'), 'utf8')
  const lines = entry.split('\n')
  const zhStart = lines.findIndex((line) => line.startsWith('export const zh = {'))
  const enStart = lines.findIndex((line) => line.startsWith('export const en: Record<MemoryEvolveKey, string> = {'))
  assert.ok(zhStart > 0 && enStart > zhStart, '必须能定位 zh / en 两个字典块（改名即红）')
  const blockEnd = (from) => {
    for (let i = from + 1; i < lines.length; i += 1) if (lines[i] === '}') return i
    throw new Error('字典块未见结束大括号')
  }
  const zhEnd = blockEnd(zhStart)
  const enEnd = blockEnd(enStart)
  const keysOf = (from, to) => lines
    .slice(from + 1, to)
    .map((line) => /^ {2}'([^']+)':/u.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1])
  const zhKeys = keysOf(zhStart, zhEnd)
  const enKeys = keysOf(enStart, enEnd)
  assert.ok(zhKeys.length > 900, `zh 字典键数异常（${zhKeys.length}），疑似解析失效`)
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), 'zh/en 必须一一对应（键集完全相同）')
  const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/u
  const offenders = lines
    .slice(enStart + 1, enEnd)
    .filter((line) => /^ {2}'[^']+':/u.test(line))
    .filter((line) => CJK.test(line.replace(/\\n/gu, ' ')))
    // 唯一的例外：workspace 快照提示里的【Workspace activity】中文标记是刻意保留的
    .filter((line) => !line.includes("broadcast.settings.wsCoord.snapshot.hint"))
  assert.deepEqual(offenders, [], `en 列不得残留中文：\n${offenders.join('\n')}`)
})

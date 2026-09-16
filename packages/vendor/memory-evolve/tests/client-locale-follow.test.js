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

test('每个私有字典文件都 import 了 clientLang', () => {
  const dictionaryFiles = [
    'CoIView.tsx',
    'PromptView.tsx',
    'BroadcastView.tsx',
    'MemoryQueueView.tsx',
    'TodoView.tsx',
    'SyncView.tsx',
    join('advisor', 'AdvisorPanel.tsx'),
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

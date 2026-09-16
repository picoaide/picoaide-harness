/**
 * Advisor 标签与私有字典收敛的 i18n 回归（2026-09-16）。
 *
 * 两类缺陷形态：
 *   1. `advisor-store.ts` 的 `LEVEL_LABEL` 是**模块级常量**（`{ global: '全局约束', … }`）
 *      —— 模块求值早于 apply，`t()` 那时只能拿到默认语言；面板与本 store 的
 *      notice 都读它，等于把语言钉死。
 *   2. `AdvisorPanel.tsx` 里约 18 处状态/严重度/结果标签走手写的 `isEn()`
 *      （读 `navigator.language` = 操作系统语言），无视应用内语言设置。
 *
 * store / 面板都是 React 组件（Node 不能直接加载 .tsx，store 又 import 'react'），
 * 故此文件按**源码结构 + 字典真源**钉不变量（与本包既有风格一致）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_ROOT = join(PACKAGE_ROOT, 'src', 'client')
const ADVISOR_DIR = join(CLIENT_ROOT, 'advisor')


/**
 * 去注释后的代码（本文件的断言只看代码：迁移说明的注释里会提到 isEn/clientLang
 * 等旧标识符，拿整份源码断言会自己绊自己）。块注释整段删；`//` 行注释按行删。
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//u.test(line))
    .join('\n')
}

/** 从 index.ts 的两个字典块里取键集合（避免引入 TS 依赖）。 */
function dictionaryKeys() {
  const lines = readFileSync(join(CLIENT_ROOT, 'index.ts'), 'utf8').split('\n')
  const start = (marker) => lines.findIndex((line) => line.startsWith(marker))
  const zhStart = start('export const zh = {')
  const enStart = start('export const en: Record<MemoryEvolveKey, string> = {')
  assert.ok(zhStart > 0 && enStart > zhStart, '必须能定位 zh / en 字典块')
  const end = (from) => {
    for (let i = from + 1; i < lines.length; i += 1) if (lines[i] === '}') return i
    throw new Error('字典块未见结束大括号')
  }
  const keys = (from, to) => new Set(lines
    .slice(from + 1, to)
    .map((line) => /^ {2}'([^']+)':/u.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]))
  return { zh: keys(zhStart, end(zhStart)), en: keys(enStart, end(enStart)) }
}

test('LEVEL_KEYS：四层级都映射到 advisor.level.*，且键在 zh/en 双语字典里都有', () => {
  const store = codeOnly(readFileSync(join(ADVISOR_DIR, 'advisor-store.ts'), 'utf8'))
  assert.doesNotMatch(store, /export const LEVEL_LABEL/u, 'LEVEL_LABEL 模块级常量会把语言钉死')
  assert.match(store, /export const LEVEL_KEYS/u)
  assert.match(store, /export function levelLabel\(level[^)]*\)[^{]*\{\s*return t\(LEVEL_KEYS\[level\]\)/u,
    'levelLabel 必须是 t 的函数（调用期求值）')
  const { zh, en } = dictionaryKeys()
  for (const level of ['global', 'project', 'session', 'conversation']) {
    assert.match(store, new RegExp(`'advisor\\.level\\.${level}'`, 'u'), `LEVEL_KEYS 缺 ${level}`)
    assert.ok(zh.has(`advisor.level.${level}`), `zh 字典缺 advisor.level.${level}`)
    assert.ok(en.has(`advisor.level.${level}`), `en 字典缺 advisor.level.${level}`)
  }
})

test('AdvisorPanel：isEn()/navigator.language 判语言已移除，标签走 (t) 的函数', () => {
  const panel = codeOnly(readFileSync(join(ADVISOR_DIR, 'AdvisorPanel.tsx'), 'utf8'))
  assert.doesNotMatch(panel, /\bisEn\b/u, 'isEn（读 navigator.language）必须删除')
  assert.doesNotMatch(panel, /OUTCOME_ZH|OUTCOME_EN/u, '私有结果标签表必须并入注册字典')
  assert.doesNotMatch(panel, /STATUS_META\[[^\]]*\]\.label/u, 'STATUS_META 只存键，文案经 statusMeta(status, t)')
  assert.match(panel, /function statusMeta\(status[^)]*t: Translate/u)
  assert.match(panel, /function severityMeta\(severity[^)]*t: Translate/u)
  assert.match(panel, /function outcomeLabel\(outcome[^)]*t: Translate/u)
  assert.match(panel, /function formatAgo\(ts[^)]*t: Translate/u)
})

test('advisor-store：notice/错误文案经注入的 t（不再有硬编码中文）', () => {
  const store = codeOnly(readFileSync(join(ADVISOR_DIR, 'advisor-store.ts'), 'utf8'))
  assert.match(store, /constructor\(sessionId: string, t: Translate\)/u, 't 必须在构造期注入')
  assert.match(store, /setTranslate\(t: Translate\)/u, '热重载/多实例要能同步最新 t')
  assert.match(store, /useAdvisorSessionStore\(sessionId: string, t: Translate\)/u)
  assert.match(store, /function errorText\(error: unknown, t: Translate\)/u)
  const cjk = store.split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/u.test(line))
    .filter(({ line }) => /[\u4e00-\u9fff]/u.test(line))
  assert.deepEqual(cjk, [], 'store 源码（非注释）不得再残留中文文案')
})

test('已迁入注册字典的视图：键前缀正确、无私有 DICT', () => {
  const cases = [
    ['CoIView.tsx', 'coi.'],
    ['PromptView.tsx', 'prompt.'],
  ]
  for (const [file, prefix] of cases) {
    const source = codeOnly(readFileSync(join(CLIENT_ROOT, file), 'utf8'))
    assert.doesNotMatch(source, /^const DICT = \{/mu, `${file} 不应再有私有 DICT`)
    assert.doesNotMatch(source, /clientLang/u, `${file} 不应再依赖 clientLang（已并入注册字典）`)
    assert.match(source, new RegExp(`Extract<MemoryEvolveKey, \`${prefix.replace('.', '\\.')}\\$\\{string\\}\`>`, 'u'),
      `${file} 的键类型必须收窄到 '${prefix}' 前缀（漏键编译期报错）`)
    assert.doesNotMatch(source, /keyof typeof DICT/u, `${file} 不应再引用旧 DICT 类型`)
  }
})

test('coi.* / prompt.* 键在 zh/en 双语字典里都存在且一一对应', () => {
  const { zh, en } = dictionaryKeys()
  for (const prefix of ['coi.', 'prompt.']) {
    const zhOwn = [...zh].filter((key) => key.startsWith(prefix))
    const enOwn = [...en].filter((key) => key.startsWith(prefix))
    assert.ok(zhOwn.length > 100, `${prefix} 迁移后的键数偏少（${zhOwn.length}）`)
    assert.deepEqual(zhOwn.sort(), enOwn.sort(), `${prefix} 键集必须双语一致`)
  }
})

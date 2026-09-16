/**
 * 画板类型标签的 i18n 回归（2026-09-16）。
 *
 * 缺陷形态：`constants.ts` 里 `TYPE_LABEL: Record<CanvasNodeType, string>`
 * 是**模块级常量**（`{ folder: '文件夹', … }`）——模块求值早于插件 apply，
 * 那时 `t()` 只能拿到默认语言，等于把界面语言钉死；而 `helpers.matchesQuery`
 * 又拿它当**搜索匹配词**，所以"把标签改成 t()"还必须同步保证搜索结果不变。
 *
 * 本文件直接 import 真实 TS 模块（Node 24 原生 type stripping；constants /
 * helpers 只有 type-only import，可在 node --test 下加载），钉三件事：
 *   1. `typeLabel(type, t)` 在**调用期**取语言（切语言立刻变，无模块级冻结）；
 *   2. 搜索匹配与界面语言无关，且仍命中历史中文标签（行为不缩水）；
 *   3. 死代码（预置示例卡 + loadCanvasState）已删除，不会以"要不要翻译"的形式复活。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TYPE_LABEL_KEYS, TYPE_SEARCH_TERMS, typeLabel } from '../src/client/canvas-grok/constants.ts'
import { matchesQuery } from '../src/client/canvas-grok/helpers.ts'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CANVAS_DIR = join(PACKAGE_ROOT, 'src', 'client', 'canvas-grok')
const TYPES = ['folder', 'markdown', 'plainText', 'image', 'media', 'file']

/** 假的 locale 绑定：语言可在两次调用之间切换（正是"跟随界面语言"的判据）。 */
function fakeTranslate(locale) {
  const dict = {
    zh: { 'canvas.type.folder': '文件夹', 'canvas.type.plainText': '纯文本' },
    en: { 'canvas.type.folder': 'Folder', 'canvas.type.plainText': 'Plain text' },
  }
  return (key) => dict[locale][key] ?? `{${locale}:${key}}`
}

test('typeLabel：每次调用都向 t 要当前语言（模块级常量冻结语言即红）', () => {
  let locale = 'zh'
  const t = (key) => fakeTranslate(locale)(key)
  assert.equal(typeLabel('folder', t), '文件夹')
  locale = 'en'
  assert.equal(typeLabel('folder', t), 'Folder', '切语言后标签必须立刻跟随（这就是修复点）')
  locale = 'zh'
  assert.equal(typeLabel('plainText', t), '纯文本')
})

test('typeLabel：六种类型都映射到 canvas.type.* 字典键', () => {
  assert.deepEqual(Object.keys(TYPE_LABEL_KEYS).sort(), [...TYPES].sort())
  for (const type of TYPES) {
    assert.equal(TYPE_LABEL_KEYS[type], `canvas.type.${type}`)
    assert.equal(typeof typeLabel(type, (key) => key), 'string')
    assert.equal(typeLabel(type, (key) => key), `canvas.type.${type}`, '标签必须经 t 取值，不许内联文案')
  }
})

test('constants：模块级 TYPE_LABEL 常量已删除（改回常量即红）', () => {
  const source = readFileSync(join(CANVAS_DIR, 'constants.ts'), 'utf8')
  assert.doesNotMatch(source, /export const TYPE_LABEL\b/u, 'TYPE_LABEL 常量会让语言在模块求值期被钉死')
  assert.match(source, /export function typeLabel\(/u)
})

test('搜索匹配：与界面语言无关，且仍命中历史中文标签 + 英文标签', () => {
  const node = { id: 'canvas_1', type: 'folder', title: 'docs', scope: 'session' }
  // 历史行为（中文标签可命中）不得缩水
  assert.equal(matchesQuery(node, '文件夹'), true, '中文标签必须仍可命中（历史行为）')
  assert.equal(matchesQuery(node, '目录'), true)
  // 新增英文别名（英文界面里输入 folder 也要能搜到）
  assert.equal(matchesQuery(node, 'folder'), true)
  assert.equal(matchesQuery(node, 'FOLDER'), true, '匹配大小写不敏感')
  // 非命中词不受影响
  assert.equal(matchesQuery(node, '不存在的词'), false)
  assert.equal(matchesQuery(node, ''), true, '空查询=全部可见')
})

test('搜索匹配：命中表按类型齐全，且不引用会随语言变化的展示标签', () => {
  assert.deepEqual(Object.keys(TYPE_SEARCH_TERMS).sort(), [...TYPES].sort())
  for (const type of TYPES) {
    assert.ok(TYPE_SEARCH_TERMS[type].length >= 2, `${type} 至少要有中文与英文两个匹配词`)
  }
  const source = readFileSync(join(CANVAS_DIR, 'helpers.ts'), 'utf8')
  assert.match(source, /TYPE_SEARCH_TERMS\[node\.type\]/u, 'matchesQuery 必须走语言无关的匹配词表')
  assert.doesNotMatch(source, /TYPE_LABEL\b/u, 'matchesQuery 不得再引用展示标签（否则切语言会改搜索结果）')
})

test('死代码已删除：预置示例卡 / loadCanvasState 不再存在（不必翻译死中文）', () => {
  const constants = readFileSync(join(CANVAS_DIR, 'constants.ts'), 'utf8')
  const store = readFileSync(join(CANVAS_DIR, 'store.ts'), 'utf8')
  assert.doesNotMatch(constants, /export function createSeedNodes|export function createSeedState/u)
  assert.doesNotMatch(store, /export function loadCanvasState|function parseState/u)
  assert.match(store, /export function createDebouncedSaver/u, '防抖保存仍是画板在用路径，必须保留')
  assert.match(store, /export function saveCanvasState/u)
})

test('画板 Tab 名来自字典（不再是模块级「画板」字面量）', () => {
  // canvas-grok/index.ts 会 import CanvasView.tsx（Node 无法直接加载 .tsx），
  // 故此条按源码结构断言：标签必须在 label 回调里经 opts.t 求值。
  const source = readFileSync(join(CANVAS_DIR, 'index.ts'), 'utf8')
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/u.test(line))
    .join('\n')
  assert.doesNotMatch(code, /'画板'/u, 'Tab 名不得再是模块级中文字面量')
  assert.match(code, /opts\.t\('canvas\.tab\.label'\)/u, '默认 Tab 名必须来自字典')
  assert.match(code, /const slotLabel = \(\): string =>/u, 'label 必须在回调里求值（求值期取当前语言）')
})

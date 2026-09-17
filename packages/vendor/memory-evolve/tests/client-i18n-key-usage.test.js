/**
 * 键**使用**守卫（2026-09-17，审计 `i18n-core-3` / F3）。
 *
 * 缺陷形态（审计实测，M6 变异）：旧的一批 i18n 守卫只钉"已迁移文件里不得再出现
 * 代码态中文"（`client-i18n-coverage.test.js`）与"zh/en 键集镜像 / en 列无中文"
 * （`i18n-dictionary-integrity.test.js`、desktop 的 `i18n-dictionary-hygiene`），
 * **没有任何一条**校验"调用点用到的键是否存在"。于是把仍被 `t('coi.ago.justNow')`
 * 引用的键整条删掉，47 例守卫全绿；同一盲区也让 `39692cac6e` 的两次迁移漏改
 * （CoIView 对 `scope.<id>` 旧键名的引用、`dict()` 包装器丢模板参数）静默通过。
 *
 * 本文件补上这条缺口，钉四件事（全部对 `src/client/**` 生效）：
 *   1. 字典自身非平凡（键数 + zh/en 键集同名），避免守卫"空过"；
 *   2. 字面量键：`t('key')` / `say('key')` 用到的键在 **zh 与 en 两张字典**里都存在；
 *   3. 模板键：`` t(`prefix.${expr}`) `` —— 若 expr 能在同文件解析成 `as const`
 *      数组，则**逐个展开**校验（SCOPES 这类枚举漂移会被抓住）；否则退化为
 *      "存在以该前缀开头的键"（动态值无法静态枚举）；
 *   4. 键收窄包装器：`dict()` 必须把第二个形参透传给 t —— 审计 F1 的成因正是
 *      `(key) => t(key)` 静默丢弃 `{count}`/`{value}` 参数（本包门禁不做类型检查，
 *      TS 本可拦住的 TS2554 不会让 `node --test` 变红）。
 *
 * 已知边界（有意为之）：只扫直传的字面量/模板（间接经 `mt()`/`st()` 的键会误报，
 * 文档已说明）；动态值（`t(\`todo.track.${item.target}\`)`）只做前缀存在性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_ROOT = join(PACKAGE_ROOT, 'src', 'client')
const ENTRY = join(CLIENT_ROOT, 'index.ts')

/** 字典块的起止标记（zh 是键集真源，en 由 `Record<MemoryEvolveKey, string>` 强制镜像）。 */
const ZH_MARKER = 'export const zh = {'
const EN_MARKER = 'export const en:'

/** 解析 `export const <zh|en> = { 'key': 'value', … }` 的键集合。 */
function dictionaryKeys(source, marker) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(marker))
  assert.notEqual(start, -1, `字典块未找到：${marker}`)
  const keys = new Set()
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') break
    const m = /^ {2}'([^']+)':/u.exec(lines[i])
    if (m !== null) keys.add(m[1])
  }
  return keys
}

/** `src/client/**` 下的全部 TS/TSX（不含 index.ts 之外的构建产物；src 下没有）。 */
function walkSources(dir = CLIENT_ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walkSources(path, out)
    else if (/\.tsx?$/u.test(entry)) out.push(path)
  }
  return out
}

/**
 * 去过注释的代码（与 `client-i18n-coverage.test.js` 的 codeOnly 同一口径）：
 * 文档注释里举例写的 `t('旧键名')` 不该让守卫假红。`//` 只在空白之后才算注释起点，
 * 这样 `'https://…'` 这类字符串不会被误删。
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/[^\n]*/u, '$1'))
    .join('\n')
}

/** 同文件里 `const X = [...] as const` 的字面量数组（用于展开模板键的枚举）。 */
function constArrays(source) {
  const map = new Map()
  for (const m of source.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\[([^\]]*)\]\s*as\s+const/gu,
  )) {
    const items = [...m[2].matchAll(/'([^']*)'/gu)].map((x) => x[1])
    if (items.length > 0) map.set(m[1], items)
  }
  return map
}

/** 抠出每个 `function dict(...) { … }` 的形参表与函数体（按大括号配对）。 */
function dictWrappers(source) {
  const found = []
  for (const head of source.matchAll(/function\s+dict\s*\(([^)]*)\)\s*(?::[^{]*)?\{/gu)) {
    let depth = 0
    for (let i = head.index + head[0].length - 1; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}' && (depth -= 1) === 0) {
        found.push({ params: head[1], body: source.slice(head.index + head[0].length, i) })
        break
      }
    }
  }
  return found
}

const DICTIONARY = readFileSync(ENTRY, 'utf8')
const ZH_KEYS = dictionaryKeys(DICTIONARY, ZH_MARKER)
const EN_KEYS = dictionaryKeys(DICTIONARY, EN_MARKER)
const SOURCES = walkSources().map((path) => ({
  relative: relative(CLIENT_ROOT, path),
  source: codeOnly(readFileSync(path, 'utf8')),
}))

test('字典非平凡且 zh/en 键集一致（守卫不会空过）', () => {
  assert.ok(ZH_KEYS.size > 1000, `zh 字典键数异常偏少：${ZH_KEYS.size}`)
  const onlyZh = [...ZH_KEYS].filter((key) => !EN_KEYS.has(key))
  const onlyEn = [...EN_KEYS].filter((key) => !ZH_KEYS.has(key))
  assert.deepEqual(
    { onlyZh, onlyEn }, { onlyZh: [], onlyEn: [] },
    `zh/en 键集不一致（onlyZh=${onlyZh.length}, onlyEn=${onlyEn.length}）`,
  )
})

test("字面量键 t('key') / say('key') 必须存在于 zh 与 en 两张字典", () => {
  const offenders = []
  for (const { relative: file, source } of SOURCES) {
    for (const m of source.matchAll(/\b(?:t|say)\(\s*'([^']*)'/gu)) {
      const key = m[1]
      const line = source.slice(0, m.index).split('\n').length
      if (!ZH_KEYS.has(key)) offenders.push(`${file}:${line}: t('${key}') 不在 zh 字典`)
      else if (!EN_KEYS.has(key)) offenders.push(`${file}:${line}: t('${key}') 不在 en 字典`)
    }
  }
  assert.deepEqual(
    offenders, [],
    `以下调用点引用了字典里不存在的键（会渲染成裸键名）：\n${offenders.join('\n')}`,
  )
})

test('模板键 t(`prefix.${expr}`) 展开后必须存在于 zh 与 en 两张字典', () => {
  const offenders = []
  for (const { relative: file, source } of SOURCES) {
    const arrays = constArrays(source)
    for (const m of source.matchAll(/\b(?:t|say)\(\s*`([^`]*)`/gu)) {
      const template = m[1]
      const line = source.slice(0, m.index).split('\n').length
      const dollar = template.indexOf('${')
      // 无插值的模板等价于字面量键
      const prefix = dollar === -1 ? template : template.slice(0, dollar)
      const missing = (key) => (!ZH_KEYS.has(key) ? 'zh' : !EN_KEYS.has(key) ? 'en' : null)
      if (dollar === -1) {
        const miss = missing(prefix)
        if (miss !== null) offenders.push(`${file}:${line}: t(\`${template}\`) 不在 ${miss} 字典`)
        continue
      }
      const holes = [...template.matchAll(/\$\{([^}]*)\}/gu)].map((h) => h[1].trim())
      const expandable = holes.length === 1 && /^[A-Za-z_$][\w$]*$/u.test(holes[0]) && arrays.has(holes[0])
      const candidates = expandable ? arrays.get(holes[0]).map((item) => `${prefix}${item}`) : null
      if (candidates !== null) {
        for (const key of candidates) {
          const miss = missing(key)
          if (miss !== null) offenders.push(`${file}:${line}: t(\`${template}\`) 展开出 '${key}' 不在 ${miss} 字典`)
        }
        continue
      }
      // 动态值无法静态枚举：退化为"前缀必须至少命中一个键"
      if (![...ZH_KEYS].some((key) => key.startsWith(prefix))) {
        offenders.push(`${file}:${line}: t(\`${template}\`) 的前缀 '${prefix}' 在 zh 字典里没有任何键`)
      } else if (![...EN_KEYS].some((key) => key.startsWith(prefix))) {
        offenders.push(`${file}:${line}: t(\`${template}\`) 的前缀 '${prefix}' 在 en 字典里没有任何键`)
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    `以下模板键展开后不在字典里（会渲染成裸键名）：\n${offenders.join('\n')}`,
  )
})

test('dict() 包装器必须把模板参数透传给 t（审计 F1：丢了就渲染 {count}）', () => {
  const wrappers = []
  for (const { relative: file, source } of SOURCES) {
    for (const { params, body } of dictWrappers(source)) {
      wrappers.push({
        file,
        params,
        // 要求形如 (key, params) => t(key, params)：两个形参都声明、两个实参都转发
        forwards: /\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*(\w+)\(\s*\1\s*,\s*\2\s*\)/u.test(body),
        // 包装器的入参必须就是 Translate（否则这个断言盯错了东西）
        translate: /\b\w+\s*:\s*Translate\b/u.test(params),
      })
    }
  }
  assert.ok(wrappers.length >= 2, `键收窄包装器数量异常偏少：${wrappers.length}（CoIView/PromptView 各一）`)
  const offenders = wrappers
    .filter((w) => !w.forwards || !w.translate)
    .map((w) => `${w.file}: dict(${w.params.trim()}) 没有写成 (key, params) => t(key, params)`)
  assert.deepEqual(
    offenders, [],
    `以下包装器会把模板参数静默丢掉（带占位符的文案原样渲染 {count}）：\n${offenders.join('\n')}`,
  )
})

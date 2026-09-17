/**
 * 键**使用**守卫（2026-09-17，审计 `i18n-core-3` / F3）。
 *
 * ## ★ 定位（2026-09-17 类型系统轮改写）：本守卫是**兜底**，主防线是 typecheck
 *
 * 主防线 = `packages/vendor/memory-evolve/package.json` 的 **`typecheck`**
 * （`tsc -p tsconfig.json`，随 `scripts/check-workspaces.mjs` 的
 * `dsh-memory-evolve` 任务与 `test` 一起进 `yarn check` / CI）。
 * 它靠类型系统覆盖**整类**键错误：`ctx.locale.bind(NS)` 返回
 * `TranslateNS<'memory-evolve'>`（键 = 本包 `zh` 字典键 ∪ 平台 `common` 词表），
 * 这个窄类型随 props 流到每个视图，任何 `t('…')` 都在编译期对照字典校验。
 *
 * 本文件**只钉几类结构不变量**——它们是类型系统看不见的（不是"还没实现的形态"）：
 *   1. 字典自身非平凡（键数 + zh/en 键集同名），避免守卫"空过"；
 *   2. `dict()` / `say` 这类**包装器必须透传第二个参数**：`(key) => t(key)` 会静默
 *      丢掉 `{count}`，而两边都是 `Translate` 类型 ⇒ **tsc 抓不到**（审计 F1 的成因）；
 *   3. `lib/client.js`（发布产物，运行时真源）与 `src` 的键收窄包装器必须同形——
 *      防"改了源码没重建"；产物是 JS，**tsc 抓不到**；
 *   4. 字面量 / 模板 / 成员表达式的键存在性 —— 类型系统已完整覆盖，这里保留为
 *      **纵深防御**（类型链一旦被新的 `as unknown as` 断言掐断，这条仍会响）。
 *
 * ## ★ 本守卫**不追求形态完备**（有意为之，附收敛数据）
 *
 * 2026-09-17 的 11 轮审计里，本守卫对"键使用形态"逐形态打补丁，**6 轮不收敛**：
 *
 * | 轮次 | 本守卫闭合形态 | 该轮新暴露/遗留的未闭合形态 |
 * |---|---|---|
 * | R7 → R8 | 成员表达式值域整类 | 4 通道只闭合 2 个（`meta.key`、`TYPE_LABEL_KEYS` 仍绿） |
 * | R8 → R9 | +19 个键 | 别名一跳缺失；`severity` 5 键被"先到先得"保护成静默 |
 * | R9 → R10 | +9 个键 | 别名**重名**取并集缺并集 → 又静默 5 键 |
 * | R10 → R11 | +5 个键（40/40） | 形态面**净增 1**（第 5 段无计数采集）；21 键的前缀兜底是假边界 |
 * | R11 | 本可再 +14/21 | R8 列的 8 个等价重构到 HEAD **一个都没闭合** |
 *
 * 结论：**形态维度不收敛**（修一个形状 → 下轮又漏一个形状），所以不再靠它覆盖
 * "值域怎么包"这一类问题。等价重构（`Object.freeze({…} as const)`、双重断言、
 * 值域跨文件、解构别名、spread 组合）在本守卫下**重构本身 GREEN、删键仍 GREEN**，
 * 而 typecheck 对这 5 种形态**逐个 RED**（原始输出见
 * `.multiagent/audit-beta3-introduced/typesystem/TYPESYSTEM-REPORT.md` 第 4 节）。
 * 新增形态时请**先问类型系统**能不能覆盖；只有它覆盖不到的结构不变量才加到这里。
 *
 * ## 缺陷形态（审计实测，M6 变异）：旧的守卫为什么不够
 *
 * 旧的一批 i18n 守卫只钉"已迁移文件里不得再出现代码态中文"（`client-i18n-coverage.test.js`）
 * 与"zh/en 键集镜像 / en 列无中文"（`i18n-dictionary-integrity.test.js`、desktop 的
 * `i18n-dictionary-hygiene`），**没有任何一条**校验"调用点用到的键是否存在"。于是把仍被
 * `t('coi.ago.justNow')` 引用的键整条删掉，47 例守卫全绿；同一盲区也让 `39692cac6e` 的两次
 * 迁移漏改（CoIView 对 `scope.<id>` 旧键名的引用、`dict()` 包装器丢模板参数）静默通过。
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

/**
 * 宿主 side 的 row key 清单（2026-09-17 第 7 轮 R7-i18n-2）。
 *
 * 真源 = 同包产物 `lib/memory-tab.js` 里的 `rows = [{ key: '<x>' }, …]` —— 它们是
 * **硬编码字面量**，不是"宿主下发的运行时数据"。`memoryTab.desc.agents` 只在这里出现，
 * 客户端 `src/` 里没有它的字面量，所以必须跨半边读；否则删它会静默放过（第 6/7 轮实测）。
 * 本测试文件本来就在读同包的 `lib/client.js`（见 D4 对拍），跨半边读值域一致成立。
 */
const HOST_ROW_KEYS = (() => {
  try {
    const bundle = readFileSync(join(PACKAGE_ROOT, 'lib', 'memory-tab.js'), 'utf8')
    return [...bundle.matchAll(/\{\s*key:\s*'([^']+)'/gu)].map((m) => m[1])
  } catch {
    return []
  }
})()

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

/**
 * 从一段文本里取出静态字面量值（统一的取值器）。
 *
 * 2026-09-17 第 6 轮 R6-i18n-1：此前三条收集正则**各自实现取值**，于是"数组识别"
 * 与"元素类型"耦合在一起 —— 数字元素、元组、Set、**不带 `as const`** 的显式类型
 * 数组逐个漏网，而把 `([0,7,30] as const)` 提成 `const X: number[] = [0,7,30]`
 * 只是一次常规重构。现在识别与取值分离，所有形态共用本函数。
 */
function literalItems(text) {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"|\b(\d+)\b/gu)].map((x) => x[1] ?? x[2] ?? x[3])
}

/**
 * 值域表：变量名 → 该变量的静态可枚举取值。
 *
 * 覆盖 TS 里最常见的几种写法（第 5/6 轮证明"逐形态打补丁"是打不完的）：
 *   1. `const NAME = ['a','b'] as const`
 *   2. `const NAME: T[] = ['a','b']`（**无 as const** —— 之前正是这里漏）
 *   3. `const NAME = ['a','b']`（裸数组）
 *   4. `const NAME = new Set(['a','b'])`（`.has(x)` 守卫，见 tupleColumns 之外的 Set 用法）
 */
const MEMBER_DOMAINS = { objectLiteral: [], objectArray: [] }
function valueDomains(source) {
  const memberDomains = MEMBER_DOMAINS
  const map = new Map()
  // 形态 1–3：具名数组（`as const` / 显式类型 / 裸数组都收）。
  //
  // 2026-09-17 第 8 轮 R8-i18n-1 踩坑：必须**排除对象数组**（`[{ id: 'x', key: 'k' }]`）——
  // 否则本正则会把 `id` 与 `key` 的**所有**字面量混成一个值域（实测 `tabs` 被登记成
  // `['guide','coi.guide','tasks',…]`），进而让 `t(tab.key)` 报出一堆假缺失。
  // 对象数组交给形态 6 只取 `key:` 字段。
  for (const m of source.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\[([^\]]*)\]\s*(?:as\s+const|satisfies[^\n]*)?/gu,
  )) {
    if (/\{/.test(m[2])) continue
    const items = literalItems(m[2])
    if (items.length > 0 && !map.has(m[1])) map.set(m[1], items)
  }
  // 形态 4：Set 字面量
  for (const m of source.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*new\s+Set\(\s*\[([^\]]*)\]/gu,
  )) {
    const items = literalItems(m[2])
    if (items.length > 0 && !map.has(m[1])) map.set(m[1], items)
  }
  // 形态 5（2026-09-17 第 8 轮 R8-i18n-1）：对象字面量映射 —— **值是键名本身**。
  //   `const LEVEL_KEYS = { conversation: 'advisor.level.conversation', … } as const`
  //   活调用点：`t(LEVEL_KEYS[level])`、`t(OUTCOME_KEYS[outcome])`、`t(TYPE_LABEL_KEYS[type])`。
  //   之前完全没登记（守卫只认数组/Set/元组/回调），导致这类键删掉后整套门禁全绿。
  //   用**大括号配对**取对象体：`as const` 对象里常有注释与嵌套（`OUTCOME_KEYS` 的
  //   每个成员后面都跟一行注释），非贪婪 `\{[\s\S]*?\}` 会在第一个 `}` 处截断
  //   （实测漏掉整个 OUTCOME_KEYS，导致 `t(OUTCOME_KEYS[outcome])` 的 8 个键无覆盖）。
  for (const head of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{/gu)) {
    const open = head.index + head[0].length - 1
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}' && (depth -= 1) === 0) { end = i; break }
    }
    if (end === -1) continue
    // 2026-09-17 第 9 轮 R9-i18n-1：**不再硬要求 `as const`**。
    // `const X: Record<T, {key:string}> = { … }`（STATUS_META / SEVERITY_META /
    // TYPE_LABEL_KEYS）同样持有 i18n 键，却因缺 `as const` 从未进表 ⇒ 14 个活键静默。
    // 只排除"明显不是映射表"的紧跟 token（函数调用/运算符），其余一律收。
    // 只收"值是 i18n 键"的成员（含 `.` 或 `_`）—— 避免把 `{ id: 'guide', key: 'coi.guide' }`
    // 里的 id 值混进值域。
    const items = [...source.slice(open + 1, end).matchAll(/[:{]\s*'([^']+)'|[:{]\s*"([^"]+)"/gu)]
      .map((x) => x[1] ?? x[2])
      .filter((v) => /[._]/.test(v))
    if (items.length > 0 && !map.has(head[1])) { map.set(head[1], items); memberDomains.objectLiteral.push(head[1]) }
  }
  // 形态 6：对象数组（`[{ key: 'a' }, { key: 'b' }]`）—— 取出每个对象的 `key` 字段。
  for (const m of source.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]\s*(?:as\s+const|satisfies[^\n]*)?/gu,
  )) {
    const keys = [...m[2].matchAll(/\{[^{}]*\bkey\s*:\s*'([^']+)'/gu)].map((x) => x[1])
    if (keys.length > 0 && !map.has(m[1])) { map.set(m[1], keys); memberDomains.objectArray.push(m[1]) }
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
  let enumerated = 0
  let enumeratedNamed = 0
  let prefixFallbacks = 0
  const srcTotals = { named: 0, inline: 0, set: 0, tuple: 0, callback: 0, forOf: 0, member: 0, objectArray: 0 }
  /** 键缺失判定：返回缺失的语言标签，或 null（两侧都在）。 */
  const missing = (key) => (!ZH_KEYS.has(key) ? 'zh' : !EN_KEYS.has(key) ? 'en' : null)
  for (const { relative: file, source } of SOURCES) {
    // 统一值域表（2026-09-17 第 6 轮 R6-i18n-1：识别与取值解耦，不再按形态打补丁）
    // ★ 每个文件重置（2026-09-17 第 9 轮自查发现：原来声明在循环外 ⇒ 跨文件累加，
    // 且 `srcTotals[k] += src[k]` 每次把已累计值再加一遍 ⇒ 二次膨胀到 628，
    // 于是"某类收集被打断"根本触发不了下限 —— 元断言形同虚设）。
    const src = { named: 0, inline: 0, set: 0, tuple: 0, callback: 0, forOf: 0, member: 0, objectArray: 0 }
    MEMBER_DOMAINS.objectLiteral.length = 0
    MEMBER_DOMAINS.objectArray.length = 0
    const domains = valueDomains(source)
    src.member = MEMBER_DOMAINS.objectLiteral.length
    src.objectArray = MEMBER_DOMAINS.objectArray.length
    // 洞 → 可枚举取值。三种来源合并到一张表：
    //   ① 洞本身是变量名，且该变量有静态值域（数组/Set）
    //   ② 洞是 `.map()`/`.forEach()` 的回调形参 ⇒ 用被遍历变量的值域
    //   ③ 洞是 `for (const x of NAME)` 的循环变量 ⇒ 同上
    const holeDomains = new Map()
    // 来源计数（2026-09-17 第 7 轮 R7-i18n-3）：必须**按来源**分别下下限。
    // 第 6 轮只钉总数 ⇒ 本提交的"解耦"丢掉了内联数组识别（9 个键失去覆盖），
    // 而总数反而从 21 涨到 36（新纳入 TARGETS/BOARD_QUADRANTS/ENTRY_KEYS 补上了数量）
    // ⇒ 数量型元断言完全看不出来。按来源钉死才能防下一次"重构顺手删掉一段"。
    for (const [name, items] of domains) {
      holeDomains.set(name, items)
      src.named += 1
    }
    // 形态甲（第 4 轮加、第 6 轮**被我误删**、第 7 轮加回并加来源断言）：
    // 内联一维字面量数组 + 紧随的 `.map()/.forEach()`：
    //   `(['unread','all','read'] as const).map((f) => t(`broadcast.filter.${f}`))`
    //   `([0, 7, 30] as const).map((d) => …)`、`([0,7,30] as const)` 亦可无 as const
    for (const m of source.matchAll(
      /\[\s*((?:'[^']*'|"[^"]*"|\d+)(?:\s*,\s*(?:'[^']*'|"[^"]*"|\d+))*)\s*,?\s*\]\s*(?:as\s+const|satisfies[^\n]*)?\s*\)?\s*\.(?:map|forEach)\(\s*\(?\s*(\w+)\s*\)?\s*=>/gsu,
    )) {
      const items = literalItems(m[1])
      if (items.length === 0) continue
      if (!holeDomains.has(m[2])) { holeDomains.set(m[2], items); src.inline += 1 }
    }
    // 具名数组 / Set 的遍历点与 for-of（回调形参允许带类型标注 `(s: string) =>`）
    for (const m of source.matchAll(/\b(\w+)\.(?:map|forEach)\(\s*\(?\s*(\w+)\s*(?::[^)]*)?\)?\s*=>/gu)) {
      const items = domains.get(m[1])
      if (items === undefined) continue
      if (!holeDomains.has(m[2])) { holeDomains.set(m[2], items); src.callback += 1 }
    }
    for (const m of source.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+(\w+)\s*\)/gu)) {
      const items = domains.get(m[2])
      if (items === undefined) continue
      if (!holeDomains.has(m[1])) { holeDomains.set(m[1], items); src.forOf += 1 }
    }
    // 元组数组（具名或内联）+ 解构回调 ⇒ 按列登记到解构形参
    const tupleArrays = new Map()
    for (const m of source.matchAll(
      /(?:const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*)?\[\s*((?:\[[^\]]*\]\s*,\s*)*\[[^\]]*\])\s*,?\s*\]\s*(?:as\s+const|satisfies[^\n]*)?/gsu,
    )) {
      const tuples = [...m[2].matchAll(/\[([^\]]*)\]/gu)].map((t) => literalItems(t[1]))
      if (tuples.length === 0) continue
      if (m[1] !== undefined) tupleArrays.set(m[1], tuples)
      src.tuple += 1
      // 紧跟其后的 `.map(([a, b]) => …)` / `.forEach(...)`（内联场景）
      const after = source.slice(m.index + m[0].length, m.index + m[0].length + 120)
      const cb = /^\s*\)?\s*\.(?:map|forEach)\(\s*\(\s*\[([^\]]*)\]\s*\)\s*=>/u.exec(after)
      if (cb !== null) {
        cb[1].split(',').map((n) => n.trim()).filter(Boolean).forEach((name, idx) => {
          const col = tuples.map((t) => t[idx]).filter((v) => v !== undefined)
          if (col.length > 0) holeDomains.set(name, col)
        })
      }
    }
    // 具名元组数组的遍历点：`NAME.map(([a, b]) => …)` / `NAME.forEach(...)`
    for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.(?:map|forEach)\(\s*\(\s*\[([^\]]*)\]\s*\)\s*=>/gu)) {
      const tuples = tupleArrays.get(m[1])
      if (tuples === undefined) continue
      m[2].split(',').map((n) => n.trim()).filter(Boolean).forEach((name, idx) => {
        const col = tuples.map((t) => t[idx]).filter((v) => v !== undefined)
        if (col.length > 0 && !holeDomains.has(name)) holeDomains.set(name, col)
      })
    }
    // `SET.has(x)` 守卫：值域并入 x（MemoryTabView 的 `!ENTRY_KEYS.has(activeRow.key)` 形态）。
    //
    // ★ 第 7 轮修正（R7-i18n-2）：此前这里声明"`activeRow.key` 的值域是宿主下发的
    // 运行时数据、无法静态枚举"—— **该理由是事实错误**。9 个 row key 是**硬编码字面量**，
    // 真源在同包产物 `lib/memory-tab.js` 的 `rows = [{ key: '<x>' }, …]`（含 `agents`）。
    // 本测试文件本来就在读同包的 `lib/client.js`，跨半边读值域完全成立 —— 见文件顶部
    // `HOST_ROW_KEYS` 与下方 hostKeys 块。故删掉旧的"接受边界"声明。
    for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\.has\(\s*([A-Za-z_$][\w$.]*)\s*\)/gu)) {
      const items = domains.get(m[1])
      if (items === undefined) continue
      const target = m[2]
      if (!holeDomains.has(target)) holeDomains.set(target, items)
      else {
        const merged = new Set([...holeDomains.get(target), ...items])
        holeDomains.set(target, [...merged])
      }
      // 属性访问形态 `x.y`：把最后一段也登记（`activeRow.key` ⇒ `key`）
      const last = target.split('.').pop()
      if (last !== target && !holeDomains.has(last)) holeDomains.set(last, items)
    }
    // ★ 别名解析（2026-09-17 第 9 轮 R9-i18n-1）：`const meta = STATUS_META[status]`
    // 之后再 `t(meta.key)` —— 消费端按**基对象名**查表，所以必须把别名的值域接上。
    // 支持 `const A = BASE[...]` / `const A = BASE.x` / `let A = BASE[...]`（同文件内）。
    // 迭代两轮以覆盖 `a = b = BASE[x]` 这类链式别名。
    //
    // ★★ 重名必须**取并集**（2026-09-17 第 10 轮 R10-i18n-1）：`AdvisorPanel.tsx` 里
    // `statusMeta()` 与 `severityMeta()` **各自声明了 `const meta`**（分别指向
    // STATUS_META / SEVERITY_META）。原实现 `!holeDomains.has(name)` 让后者被永久跳过
    // ⇒ `t(meta.key)` 只拿到 status 表，`advisor.severity.*` 5 个键静默。
    // 重名时取并集是**安全的失败方向**（可能假阳性，但绝不静默漏）。
    // 更彻底的解法是流敏感绑定或类型系统（见 round-10 报告 B 节）。
    for (let pass = 0; pass < 2; pass += 1) {
      for (const m of source.matchAll(
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\]|\.[A-Za-z_$][\w$]*)/gu,
      )) {
        const items = holeDomains.get(m[2]) ?? domains.get(m[2])
        if (items === undefined) continue
        const cur = holeDomains.get(m[1])
        holeDomains.set(m[1], cur === undefined ? items : [...new Set([...cur, ...items])])
      }
    }
    // ★ 宿主 side 值域（2026-09-17 第 7 轮 R7-i18n-2）：`memoryTab.desc.${activeRow.key}`
    // 的 `activeRow.key` 值域来自 **lib/memory-tab.js 的硬编码 rows**（9 项，含 `agents`）。
    // 第 6/7 轮实测：删 `memoryTab.desc.agents` 时整套 1017 例 fail 0 —— 因为
    // `ENTRY_KEYS` 只含 8 项、`agents` 不在其中。这里把宿主读到的 9 个 key 并入
    // `activeRow.key` 与 `key` 两个洞名（属性形态按最后一段查）。
    if (/memoryTab\.desc\./.test(source) && HOST_ROW_KEYS.length > 0) {
      for (const hole of ['activeRow.key', 'key']) {
        const cur = holeDomains.get(hole) ?? []
        holeDomains.set(hole, [...new Set([...cur, ...HOST_ROW_KEYS])])
      }
    }
    for (const m of source.matchAll(/\b(?:t|say)\(\s*`([^`]*)`/gu)) {
      const template = m[1]
      const line = source.slice(0, m.index).split('\n').length
      const dollar = template.indexOf('${')
      // 无插值的模板等价于字面量键
      const prefix = dollar === -1 ? template : template.slice(0, dollar)
      if (dollar === -1) {
        const miss = missing(prefix)
        if (miss !== null) offenders.push(`${file}:${line}: t(\`${template}\`) 不在 ${miss} 字典`)
        continue
      }
      const holes = [...template.matchAll(/\$\{([^}]*)\}/gu)].map((h) => h[1].trim())
      const holeName = holes.length === 1 ? holes[0] : null
      // 洞 → 值域：统一查上面合并好的 holeDomains（数组/Set/元组列/for-of/解构都进了这张表）。
      // 洞本身是变量名时直接查；是属性访问（`activeRow.key`）时查最后一段。
      let items = null
      let fromNamed = false
      if (holeName !== null) {
        if (holeDomains.has(holeName)) {
          items = holeDomains.get(holeName)
          fromNamed = true
        } else {
          const last = holeName.split('.').pop()
          if (last !== holeName && holeDomains.has(last)) {
            items = holeDomains.get(last)
            fromNamed = true
          }
        }
      }
      const candidates = items === null ? null : items.map((item) => `${prefix}${item}`)
      if (candidates !== null) {
        enumerated += candidates.length
        if (fromNamed) enumeratedNamed += candidates.length
        for (const key of candidates) {
          const miss = missing(key)
          if (miss !== null) offenders.push(`${file}:${line}: t(\`${template}\`) 展开出 '${key}' 不在 ${miss} 字典`)
        }
        continue
      }
      prefixFallbacks += 1
      // 动态值无法静态枚举（洞是真正的表达式，如 `${state.status ?? 'unknown'}`、
      // 或值域不在本文件内）：退化为"前缀必须至少命中一个键"。
      //
      // ★ 已知边界（**本守卫不追求形态完备**）：这类洞下「只被该模板引用的键」被删仍
      // 不会被本守卫发现（前缀还有别的键）。这把这一类问题**交给主防线 typecheck**：
      // `version.status.*` / `version.note.*` / `version.error.*` / `canvas.error.*`
      // 共 21 个键现在都有值域联合类型（`VersionTabView.tsx` 的 `UpdateStatus` /
      // `UpdateNoteCode` / `UpdateErrorCode`、`canvas-grok/api-client.ts` 的
      // `CanvasApiErrorCode`），删任一键 ⇒ tsc 报 TS2345 并指名是哪个字面量。
      // 实测：21/21 逐键 RED（第 11 轮 `R11-i18n-1` 的 P2 由此结构性关闭）。
      // 这里保留前缀检查只是纵深防御，**不为它再补形态**——R7→R11 六轮实测该维度
      // 不收敛（见文件头收敛表）。
      // `prefixFallbacks` 计数被元断言钉住，防止"枚举面悄悄退化、大量洞回落到前缀检查"
      // （2026-09-17 第 6 轮 A3-10）。
      if (![...ZH_KEYS].some((key) => key.startsWith(prefix))) {
        offenders.push(`${file}:${line}: t(\`${template}\`) 的前缀 '${prefix}' 在 zh 字典里没有任何键`)
      } else if (![...EN_KEYS].some((key) => key.startsWith(prefix))) {
        offenders.push(`${file}:${line}: t(\`${template}\`) 的前缀 '${prefix}' 在 en 字典里没有任何键`)
      }
    }
    // 形态丙（2026-09-17 第 5 轮 R5-i18n-1，第 6 轮统一到 holeDomains）：
    // **整个变量当键** —— `TRACKS.map(([t, k]) => t(k))`，真实活形态 SyncView.tsx:411。
    // 它不是模板洞，上面的模板扫描覆盖不到；变量若在 holeDomains 里有值域就逐个校验。
    // （注意：`t(x.y)` 的属性形态也走这里，值域按最后一段查。）
    for (const m of source.matchAll(/(?:^|[^\w.$])(?:t|say)\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\[[^\]]*\])?\s*\)/gu)) {
      const variable = m[1]
      // 成员/下标形态（第 8 轮 R8-i18n-1）：`t(LEVEL_KEYS[level])` / `t(meta.key)` ——
      // 值域来自**基对象**的名字（LEVEL_KEYS / meta），下标或属性只是取用方式。
      const items = holeDomains.get(variable)
        ?? holeDomains.get(variable.split('.')[0])
        ?? holeDomains.get(variable.split('.').pop())
      if (items === undefined) continue
      const line = source.slice(0, m.index).split('\n').length
      for (const key of items) {
        const miss = missing(key)
        if (miss !== null) offenders.push(`${file}:${line}: t(${variable}) 展开出 '${key}' 不在 ${miss} 字典`)
        else enumerated += 1
      }
    }
    for (const k of Object.keys(src)) srcTotals[k] += src[k]
  }
  assert.deepEqual(
    offenders, [],
    `以下模板键展开后不在字典里（会渲染成裸键名）：\n${offenders.join('\n')}`,
  )
  // ★ 元断言（2026-09-17 第 5/6 轮收紧）：
  // 原来只有 `enumerated >= 4`，而真实值 21（具名 + 内联 + 元组列 + for-of 等）
  // ⇒ 任一条正则失配后仍可能过线、全绿，元断言守不住它被加进来要守的事。
  // 现在按**来源**分别下下限，并额外钉住**回落到前缀检查的调用点数**，防止
  // "枚举面悄悄退化、大家全走前缀分支"这种静默失效（第 6 轮 A3-10/A3-11）。
  // ★ 来源级下限（2026-09-17 第 7 轮 R7-i18n-3）：只钉总数会被"数量替换"掩盖 ——
  // 第 6 轮的解耦丢掉了**内联数组**识别（9 个键失去覆盖），而总数反而从 21 涨到 36。
  // 每个来源必须各自有下限，删掉任一段收集代码都会立刻红。
  const SOURCE_FLOORS = { named: 12, inline: 3, set: 0, tuple: 1, callback: 3, forOf: 0, member: 4, objectArray: 1 }
  const starved = Object.entries(SOURCE_FLOORS)
    .filter(([k, floor]) => srcTotals[k] < floor)
    .map(([k, floor]) => `${k}=${srcTotals[k]} < ${floor}`)
  assert.deepEqual(
    starved, [],
    `以下枚举来源低于下限（某段收集代码可能已被删除/失配，该类形态将静默失去覆盖）：\n${starved.join('\n')}` +
    `\n实测来源分布：${JSON.stringify(srcTotals)}`,
  )
  assert.ok(
    enumeratedNamed >= 8,
    `具名值域枚举面异常偏小（named=${enumeratedNamed}）—— 具名收集可能已失配`,
  )
  assert.ok(
    enumerated >= 18,
    `枚举总数异常偏小（total=${enumerated}, named=${enumeratedNamed}）—— ` +
    '某条收集正则可能已失配（守卫会静默退化成前缀检查，比没有更危险）',
  )
  assert.ok(
    prefixFallbacks <= 14,
    `回落到"前缀存在即可"的模板调用点异常偏多（${prefixFallbacks}）—— ` +
    '枚举面可能大面积失效（此时删单个键不会被发现）',
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
        // 包装器的入参必须是翻译函数类型（宽 `Translate`，或 2026-09-17 类型系统轮
        // 收窄后的 `MemoryEvolveTranslate`）——否则这个断言盯错了东西。
        translate: /\b\w+\s*:\s*(?:MemoryEvolve)?Translate\b/u.test(params),
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

test('任何「键收窄」箭头包装器都必须透传第二个参数（审计 F1 同形态潜伏项）', () => {
  // 2026-09-17 证伪轮发现：F1 的形态不止 `function dict(...)` —— PromptView 里
  // `const say = (key: DictKey): string => t(key)` 是**完全同形态**的收窄包装器，
  // 只是当前调用点都用 .replace('{n}', …) 手工替换、没带第二个实参，所以没炸。
  // 一旦有人写 say('k', { n }) 就会静默丢参数（正是 F1 的事故）。
  // 这里把断言推广到所有 `(key: <Dict 类型>, …) => <t>(key, …)` 形态的箭头函数。
  //
  // 注意：正则必须**同时**匹配"坏形态"（1 参 1 实参）与"好形态"（2 参 2 实参），
  // 否则修好之后 seen 会变成 0、把安全断言误判成失配（第一版就踩了这个坑）。
  const offenders = []
  const seen = []
  for (const { relative: file, source } of SOURCES) {
    for (const m of source.matchAll(
      /const\s+(\w+)\s*=\s*\(([^)]*)\)\s*(?::[^=]*)?=>\s*(\w+)\(([^)]*)\)/gu,
    )) {
      const [, name, rawParams, callee, rawArgs] = m
      const params = rawParams.split(',').map((p) => p.trim()).filter(Boolean)
      const args = rawArgs.split(',').map((a) => a.trim()).filter(Boolean)
      // 只盯"键收窄"包装器：首参类型是字典键类型，且只转发给一个 callee。
      if (!/:\s*[\w.<>[\]]*(?:Key|Keys|Dict)\b/u.test(params[0] ?? '')) continue
      if (params.length === 0) continue
      seen.push(`${file}:${name}`)
      const forwardsSecond = params.length >= 2 && args.length >= 2
      if (!forwardsSecond) {
        offenders.push(
          `${file}: const ${name} = (${rawParams.trim()}) => ${callee}(${rawArgs.trim()})` +
          ' 只转发一个实参 —— 带占位符的文案会渲染成字面量 {x}；应写成 (key, params) => t(key, params)',
        )
      }
    }
  }
  // 至少应看到已知的两处形态（dict() 是 function 声明不计入；PromptView.say 应在此）。
  assert.ok(seen.length >= 1, `未发现任何键收窄箭头包装器（seen=${seen.length}）—— 守卫正则可能已失配`)
  assert.deepEqual(
    offenders, [],
    `以下键收窄包装器会静默丢掉模板参数：\n${offenders.join('\n')}`,
  )
})

test('lib/client.js（发布产物）与 src 的键收窄包装器必须同形（防「改了源码没重建」）', () => {
  // 2026-09-17 第 3 轮审计 D4（P2）：`lib/client.js` 是**已跟踪、且是运行时真源**
  // 的构建产物（package.json 的 exports["./client"] 指向它，cordis 客户端注册表
  // 也加载它），而本包门禁只有 `test`、**CI 永远不会重建 lib/**。实测：只把
  // lib 里的 `say` 退回一参、src 保持正确 ⇒ 全套 1015 pass / 0 fail 全绿。
  // 同包已有先例（client-config-save.test.js 的 bundle↔src 键集合对拍），这里
  // 把"包装器是否透传参数"这一条也纳入对拍。
  const bundle = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  // 与源码侧同一条判据：`(key, params) => t(key, params)` 形态必须两个实参都转发。
  //
  // 2026-09-17 第 4 轮审计 R4-d4-1:必须**同时**收集两种声明形态 ——
  // 箭头（`const say = (key: DictKey, …) => t(…)`）与函数声明
  // （`function dict(t: Translate) { return (key, params) => t(key, params) }`）。
  // 原实现只收箭头 ⇒ 只改 lib 里的 `dict`（F1 的**原始形态**）仍全绿。
  // 收集**两种形态**并保留出现顺序：(name, 源码位置) → 用于与产物里的同名声明**按序**对拍。
  // 2026-09-17 第 5 轮 R5-d4-1：产物侧 `dict`(CoIView) 与 `dict2`(PromptView) 是两个同形函数，
  // 而源码侧收集到的**名字都是 `dict`**。旧实现用 `function\s+${name}\s*\(` 取**首个**匹配
  // ⇒ `dict` 被查 2 次、`dict2` 从未被查（改坏它整套门禁全绿）。按序对拍即可闭合。
  const sourceWrappers = []
  for (const { relative: file, source } of SOURCES) {
    const arrow = [...source.matchAll(/const\s+(\w+)\s*=\s*\(([^)]*)\)\s*(?::[^=]*)?=>\s*(\w+)\(([^)]*)\)/gu)]
      .filter((m) => /:\s*[\w.<>[\]]*(?:Key|Keys|Dict)\b/u.test(m[2] ?? ''))
      .map((m) => ({ file, name: m[1], kind: 'arrow' }))
    const fn = [...source.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*(?::[^{]*)?\{([\s\S]*?)\n\}/gu)]
      .filter((m) => /\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\w+\(\s*\w+\s*,\s*\w+\s*\)/u.test(m[3])
        && /Translate|Dict(Key)?\b/u.test(m[2]))
      .map((m) => ({ file, name: m[1], kind: 'function' }))
    sourceWrappers.push(...arrow, ...fn)
  }
  // 元断言改为**名字集合**（计数会被同名塌缩掩盖 —— R5-d4-2）。
  const wrapperNames = new Set(sourceWrappers.map((w) => w.name))
  assert.ok(
    wrapperNames.has('dict') && wrapperNames.has('say'),
    `源码侧包装器名字集合异常（${[...wrapperNames].join(',')}）—— 必须同时覆盖函数声明（dict）与箭头（say）`,
  )
  const offenders = []
  // 产物里同名声明可能出现多次（esbuild 去重后叫 dict / dict2）：按**出现顺序**逐个对应。
  const seenCount = new Map()
  for (const { file, name } of sourceWrappers) {
    const ordinal = seenCount.get(name) ?? 0
    seenCount.set(name, ordinal + 1)
    // 产物里同一包装器可能是箭头形态（`const NAME = (k, p) => X(k, p)`），
    // 也可能被 esbuild 保留为函数声明内含的返回箭头（`function NAME(t) { return (k, p) => … }`）。
    // 先试箭头，再退化到"函数声明体内找箭头"。
    const arrowRe = new RegExp(
      `const\\s+${name}\\s*=\\s*\\(([^)]*)\\)\\s*=>\\s*\\w+\\(([^)]*)\\)`,
      'u',
    )
    let hit = arrowRe.exec(bundle)
    if (hit === null) {
      // 函数声明：**先把该函数的花括号体抠出来**，再在体内找两参转发。
      // 不能直接用 `function NAME(...) { [\s\S]*? (a,b)=>X(a,b)` —— 非贪婪的
      // `[\s\S]*?` 会跨过 `}` 漂到**后面另一个函数**里，于是被改坏的 NAME 也匹配成功
      // （2026-09-17 第 4 轮实测：把 dict 退成一参仍全绿，就是这个 bug）。
      // esbuild 对同名顶层声明会**去重改名**（第 2 个 `dict` 变成 `dict2`），
      // 所以候选名是 `dict`、`dict2`、`dict3`…；按 ordinal 取第 ordinal 个命中的候选。
      // 2026-09-17 第 5 轮 R5-d4-1：这正是 `dict2` 漏检的根因（旧实现只按原名取首个）。
      const candidates = [name, ...Array.from({ length: 8 }, (_, i) => `${name}${i + 2}`)]
      const matchedCandidates = candidates
        .map((candidate) => {
          const m = new RegExp(`function\\s+${candidate}\\s*\\(`, 'u').exec(bundle)
          return m === null ? null : { text: m[0], index: m.index }
        })
        .filter((x) => x !== null)
      const head = matchedCandidates[ordinal] ?? null
      let fnHit = null
      if (head !== null) {
        // 从 `{` 起按大括号配对取出函数体
        const open = bundle.indexOf('{', head.index + head.text.length)
        if (open !== -1) {
          let depth = 0
          let end = -1
          for (let i = open; i < bundle.length; i += 1) {
            if (bundle[i] === '{') depth += 1
            else if (bundle[i] === '}' && (depth -= 1) === 0) { end = i; break }
          }
          if (end !== -1) {
            const body = bundle.slice(open + 1, end)
            fnHit = /\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\w+\(\s*\w+\s*,\s*\w+\s*\)/u.test(body)
              ? [null, 'k, p', 'k, p'] : null
          }
        }
      }
      if (fnHit !== null) hit = fnHit
      else {
        // 兜底：函数声明存在但体内**没有**两参转发 ⇒ 记为不一致
        const existsRe = new RegExp(`function\\s+${name}\\s*\\(`, 'u')
        if (existsRe.test(bundle)) {
          offenders.push(`${file}: ${name}#${ordinal} 在 lib/client.js 里未透传两个参数（产物未与源码同步）`)
        } else {
          offenders.push(`${file}: ${name}#${ordinal} 在 lib/client.js 里找不到（产物可能未重建）`)
        }
        continue
      }
    }
    if (hit === null) {
      offenders.push(`${name}: lib/client.js 里找不到该包装器（产物可能未重建）`)
      continue
    }
    const params = hit[1].split(',').map((p) => p.trim()).filter(Boolean)
    const args = hit[2].split(',').map((a) => a.trim()).filter(Boolean)
    if (params.length < 2 || args.length < 2) {
      offenders.push(
        `${name}: lib/client.js 里是 (${hit[1].trim()}) => …(${hit[2].trim()})` +
        ' —— 产物未与源码同步（改了 src 必须重建 lib）',
      )
    }
  }
  assert.deepEqual(offenders, [], `发布产物与源码不一致：\n${offenders.join('\n')}`)
})

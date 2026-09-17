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
  let enumerated = 0
  for (const { relative: file, source } of SOURCES) {
    const arrays = constArrays(source)
    // 2026-09-17 第 3 轮审计 R3-i18n-1:模板键的洞**几乎从不**是数组名本身,
    // 真实形状是 `SCOPES.map((s) => t(`coi.scope.${s}`))` —— 洞是回调形参。
    // 原实现只认 `arrays.has(hole)`,于是永远走不到枚举分支、退化成"前缀存在即可",
    // 导致「只被模板引用的键」被删掉也全绿（实测 zh+en 删 3 个模板专有键 → 5/5 绿）。
    // 这里先把 `NAME.map((VAR) => …)` / `NAME.map(VAR => …)` 的 VAR→NAME 关系建出来。
    //
    // 2026-09-17 第 4 轮审计 R4-i18n-1:内联数组也必须能枚举 —— 真实形状
    // `(['unread','all','read'] as const).map((f) => t(`broadcast.filter.${f}`))`
    // 根本没有数组名，只认具名数组会漏枚举、模板专有键被删仍全绿。
    const inlineArrays = new Map()
    for (const m of source.matchAll(
      /\[\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\]\s*as\s+const\s*\)?\s*\.map\(\s*\(?\s*(\w+)\s*\)?\s*=>/gu,
    )) {
      const items = [...m[1].matchAll(/'([^']*)'/gu)].map((x) => x[1])
      if (items.length > 0) inlineArrays.set(m[2], items)
    }
    const mapVars = new Map()
    for (const m of source.matchAll(/\b(\w+)\.map\(\s*\(?\s*(\w+)\s*\)?\s*=>/gu)) {
      mapVars.set(m[2], m[1])
    }
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
      const holeName = holes.length === 1 ? holes[0] : null
      // 洞可以解析成数组:① 洞本身就是数组名;② 洞是 `.map()` 的回调形参 ⇒ 用它的数组
      let items = null
      if (holeName !== null && /^[A-Za-z_$][\w$]*$/u.test(holeName)) {
        if (arrays.has(holeName)) items = arrays.get(holeName)
        else if (inlineArrays.has(holeName)) items = inlineArrays.get(holeName)
        else if (mapVars.has(holeName)) {
          const name = mapVars.get(holeName)
          if (arrays.has(name)) items = arrays.get(name)
          else if (inlineArrays.has(holeName)) items = inlineArrays.get(holeName)
        }
      }
      const candidates = items === null ? null : items.map((item) => `${prefix}${item}`)
      if (candidates !== null) {
        enumerated += candidates.length
        for (const key of candidates) {
          const miss = missing(key)
          if (miss !== null) offenders.push(`${file}:${line}: t(\`${template}\`) 展开出 '${key}' 不在 ${miss} 字典`)
        }
        continue
      }
      // 动态值无法静态枚举（洞是表达式，如 `${state.status ?? 'unknown'}`、
      // `${activeRow.key}`）：退化为"前缀必须至少命中一个键"。
      //
      // ★ 已知边界（2026-09-17 第 3 轮审计 R3-i18n-1 残留）：这类**表达式洞**下，
      // 「只被该模板引用的键」被删掉仍不会被发现（前缀仍有别的键）。要真正覆盖
      // 需要类型检查（本包门禁不做 tsc）或运行时键审计，超出本守卫能力，故显式
      // 记录而非假装覆盖。可枚举的形态（数组名或 `.map()` 回调形参）已真正展开。
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
  // ★ 元断言（2026-09-17 第 4 轮 R4-i18n-1）：枚举面本身必须达到已知下限。
  // 否则将来正则失配 ⇒ 全部退化成"前缀存在即可" ⇒ 守卫静默失去增量保护，
  // 而 offenders 仍为空、看起来一切正常。这是"守卫自身的守卫"。
  assert.ok(
    enumerated >= 4,
    `模板键枚举面异常偏小（enumerated=${enumerated}）—— 枚举正则可能已失配，` +
    '守卫会静默退化成前缀检查（比没有更危险：它看起来仍有覆盖）',
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
  const sourceWrappers = []
  for (const { relative: file, source } of SOURCES) {
    for (const m of source.matchAll(/const\s+(\w+)\s*=\s*\(([^)]*)\)\s*(?::[^=]*)?=>\s*(\w+)\(([^)]*)\)/gu)) {
      const params = m[2].split(',').map((p) => p.trim()).filter(Boolean)
      if (!/:\s*[\w.<>[\]]*(?:Key|Keys|Dict)\b/u.test(params[0] ?? '')) continue
      sourceWrappers.push(m[1])
    }
    // 函数声明形态：`function dict(t: Translate) { … return (key, params) => t(key, params) }`
    for (const m of source.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*(?::[^{]*)?\{([\s\S]*?)\n\}/gu)) {
      const name = m[1]
      const body = m[3]
      // 只收"返回键收窄包装器"的函数（体内出现 (key, params) => X(key, params) 形态）
      if (!/\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\w+\(\s*\w+\s*,\s*\w+\s*\)/u.test(body)) continue
      if (!/Translate|Dict(Key)?\b/u.test(m[2])) continue
      sourceWrappers.push(name)
    }
  }
  assert.ok(
    sourceWrappers.length >= 2,
    `源码侧的键收窄包装器收集数异常偏小（${sourceWrappers.length}: ${sourceWrappers.join(',')}）—— ` +
    '必须同时覆盖箭头（say）与函数声明（dict）两种形态，否则对拍只闭一半（R4-d4-1）',
  )
  const offenders = []
  for (const name of sourceWrappers) {
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
      const headRe = new RegExp(`function\\s+${name}\\s*\\(`, 'u')
      const head = headRe.exec(bundle)
      let fnHit = null
      if (head !== null) {
        // 从 `{` 起按大括号配对取出函数体
        const open = bundle.indexOf('{', head.index + head[0].length)
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
          offenders.push(`${name}: lib/client.js 里的函数声明未透传两个参数（产物未与源码同步）`)
        } else {
          offenders.push(`${name}: lib/client.js 里找不到该包装器（产物可能未重建）`)
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

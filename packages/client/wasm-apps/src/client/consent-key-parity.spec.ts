/// <reference types="node" />
/**
 * **授权作用域的跨端对拍**：客户端那份"已经问过用户了"的 UI 记忆（`app-ai.ts`）
 * 必须与宿主闸门（`wasm-apps-host/src/ai-authorization.ts` 的 `aiConsentKey`/`keyFor`）
 * **逐段同源** —— 同段数、同段序、同归一化、同"拿不到就拒绝"的方向。
 *
 * ## 为什么必须有这条判据（R21 FIX-7 ①）
 *
 * 宿主闸门在第二十一轮（B2-R21-01）从 `(用户, 应用)` 升成 `(用户, 服务端, 应用)`
 * 并落盘 `version: 2`；而渲染层那份本地记忆当时还停在两段。两段/三段之间的缝是
 * **静默失败**：换过服务端（本仓测试/正式并存 + 同机第二栈是常态）之后面板跳过
 * 说明卡，用户发第一条消息才吃 403。反过来也一样：客户端若比宿主多一段，面板会
 * 反复问同一件事（用户点了「允许」还是继续问）。
 *
 * ## 为什么读对方源码，而不是各钉自己的字面量
 *
 * `['user','server','app']` 这种断言是**假绿**：两端各改各的（比如宿主把段序换成
 * `app\0user\0server`），各自的"字面量副本"仍然自洽，运行时却永远匹配不上。
 * 所以本文件用 `node:fs` 读宿主源码与客户端源码，从**两边的构键点**里各自抽出：
 *
 *   1. **段序**：返回模板里按顺序出现的段标识符（`user`/`server`/`app`，等价别名
 *      `userId`/`serverURL`/`appId` 归一化后比较）；
 *   2. **每段的归一化表达式**：`const <name> = typeof … ? ….trim() : ''`（把访问器
 *      换成 `SEG` 后逐字比较）；
 *   3. **每段的拒绝守卫**：判空（`<name> === ''`）与判 NUL（`hasNul(<name>)`）都在。
 *
 * 三条都对拍 ⇒ 两端任一侧改了段序、漏了归一化、或不再拒绝缺失段，本文件当场变红。
 * 抽不出结构（函数被改名/搬走/换写法）同样**直接失败**，不 skip —— 与
 * `appcfg-contract.spec.ts` 的同款纪律（skip 会让契约漂移完全静默）。
 *
 * ---- 变异验证 ----
 *   - `appAiConsentKey` 丢掉 `serverURL` 段（回到两段）⇒「段序一致」与「行为：换服务端
 *     必须重新问」红；
 *   - 段序换成 `app, server, user`（写进模板）⇒「段序一致」红；
 *   - `normalizeAppAiScope` 去掉 `trim()`（或去掉判 NUL）⇒ 对应的对拍条红；
 *   - 宿主 `aiConsentKey` 把段序改成 `user\0app\0server` ⇒ 对拍条红（反向也成立）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_AI_CONSENT_PREFIX, appAiConsentKey } from './app-ai.ts'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上走五级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/** 宿主侧的构键点（授权闸门；`aiConsentKey` 是它唯一的键构造实现）。 */
const HOST_KEY_FILE = 'packages/host/wasm-apps-host/src/ai-authorization.ts'
/** 客户端侧的构键点（本泳道改的就是它）。 */
const CLIENT_KEY_FILE = 'packages/client/wasm-apps/src/client/app-ai.ts'

/**
 * 读仓库内文件；读不到或为空 ⇒ **抛**（不是返回空串：那样抽不出结构时的失败会看起来
 * 像"两边都没有"，判据静默变假绿）。
 * @param relative - 仓库相对路径。
 * @returns 文件正文。
 */
function readRepoFile(relative: string): string {
  let text: string
  try {
    text = readFileSync(join(REPO_ROOT, relative), 'utf8')
  } catch (cause) {
    throw new Error(`跨端对拍：读不到 ${relative}（${cause instanceof Error ? cause.message : String(cause)}）`)
  }
  if (text.trim() === '') throw new Error(`跨端对拍：${relative} 是空文件`)
  return text
}

/**
 * 取出一个具名函数/箭头函数的函数体（含嵌套花括号；找不到 ⇒ 抛）。
 *
 * 两种形态都要认：宿主 `aiConsentKey` 是 `export function`，而 `keyFor` 是
 * `const keyFor = (…) => …`（箭头函数）。只认前者会让"把构键点改成箭头函数"变成
 * 一条静默的空判据。
 * @param source - 文件正文。
 * @param name - 函数名。
 * @returns 花括号内的正文。
 */
function functionBody(source: string, name: string): string {
  const patterns = [`function ${name}(`, `function ${name}<`, `const ${name} = (`, `const ${name} = function(`, `const ${name} = function (`]
  let start = -1
  for (const pattern of patterns) {
    start = source.indexOf(pattern)
    if (start >= 0) break
  }
  if (start < 0) throw new Error(`跨端对拍：找不到函数 ${name}`)
  const arrow = source.indexOf('=>', start)
  const brace = source.indexOf('{', start)
  // 表达式体箭头函数（宿主 `keyFor` 就是这一形态）：体内没有花括号，取到语句末尾即可 ——
  // 按"第一个 `{`"去截会把解构参数当成函数体（那正是第一版的 bug）。
  if (arrow >= 0 && (brace < 0 || arrow < brace)) {
    // 跳过 `=>` 之后的空白（表达式体常见换行 + 缩进），否则第一个换行就把体截成空串。
    let begin = arrow + 2
    while (begin < source.length && /\s/u.test(source[begin]!)) begin += 1
    let depth = 0
    for (let i = begin; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '(' || ch === '[') depth += 1
      else if (ch === ')' || ch === ']') depth -= 1
      else if (ch === '\n' && depth <= 0) return source.slice(begin, i)
    }
    return source.slice(begin)
  }
  if (brace < 0) throw new Error(`跨端对拍：${name} 没有函数体`)
  let depth = 0
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(brace + 1, i)
    }
  }
  throw new Error(`跨端对拍：${name} 的花括号不闭合`)
}

/** 段标识符的等价别名（两端各自的命名习惯）。 */
const SEGMENT_ALIASES: Record<string, string> = {
  user: 'user',
  userId: 'user',
  server: 'server',
  serverURL: 'server',
  app: 'app',
  appId: 'app',
}

/**
 * 归一化一个段标识符；不认识的标识符 ⇒ 抛（改名后必须显式登记，否则对拍会静默放过）。
 * @param raw - 模板里出现的标识符（可能带 `parts.` 之类的对象前缀）。
 * @returns 归一化后的段名（`user`/`server`/`app`）。
 */
function segmentName(raw: string): string {
  // 容许插值里带包装与对象前缀：`encodeURIComponent(userId)` / `normalized.userId` 都取
  // 最内层的那个标识符（包装函数不改变段序，段序由模板里的先后决定）。
  const identifier = raw.trim()
    .replace(/\)+$/u, '')
    .split('(')
    .pop()!
    .trim()
    .split('.')
    .pop()!
  const mapped = SEGMENT_ALIASES[identifier]
  if (mapped === undefined) throw new Error(`跨端对拍：未知的段标识符 \`${raw}\`（新增维度必须登记在 SEGMENT_ALIASES）`)
  return mapped
}

/**
 * 从构键函数体里抽**段序**：返回模板里按顺序出现的段（忽略前缀常量这类非段插值）。
 * @param body - 构键函数的正文。
 * @returns 段名数组（至少两段，否则抛）。
 */
function segmentOrder(body: string): string[] {
  const returns = [...body.matchAll(/return\s+`([^`]*)`/gu)].map(match => match[1]!)
  if (returns.length === 0) throw new Error('跨端对拍：构键函数里没有返回模板字符串（键的拼法变了？）')
  const template = returns[returns.length - 1]!
  const interpolations = [...template.matchAll(/\$\{([^}]*)\}/gu)].map(match => match[1]!)
  // 只认**独立标识符**形态的段引用：`APP_AI_CONSENT_PREFIX` 这类常量名里虽然含 "APP"，
  // 但它不是段（大小写敏感 + 词边界）；前缀常量由下一条用例单独钉住。
  const segments = interpolations
    .filter(raw => /\b(?:user|userId|server|serverURL|app|appId)\b/u.test(raw))
    .map(segmentName)
  if (segments.length < 2) throw new Error(`跨端对拍：只抽出 ${String(segments.length)} 段（键至少要有用户与服务端两段）`)
  if (new Set(segments).size !== segments.length) throw new Error(`跨端对拍：段有重复（${segments.join(',')}）`)
  return segments
}

/**
 * 从构键相关代码里抽**每段的归一化表达式**（`const <name> = <expr>`）。
 * @param text - 参与构键的函数体（可多段拼接）。
 * @returns 段名 → 归一化表达式（访问器已归一化为 `SEG`；缺任一段 ⇒ 抛）。
 */
function normalizers(text: string): Record<string, string> {
  const found: Record<string, string> = {}
  const declaration = /const\s+(user|userId|server|serverURL|app|appId)\s*=\s*([^\n]+)/gu
  for (const match of text.matchAll(declaration)) {
    const name = segmentName(match[1]!)
    const expression = match[2]!
      .replace(/\b(?:scope\.)?(?:user|server|app)(?:Id|URL)?\b/gu, 'SEG')
      .replace(/\s+/gu, ' ')
      .trim()
    if (found[name] !== undefined && found[name] !== expression) {
      throw new Error(`跨端对拍：段 ${name} 有两份不同的归一化表达式（${found[name]} / ${expression}）`)
    }
    found[name] = expression
  }
  return found
}

/**
 * 从构键相关代码里抽**每段的拒绝守卫**（判空 + 判 NUL 各一条）。
 * @param text - 参与构键的函数体（可多段拼接）。
 * @param segments - 段序（用它来判定"每一段都判过"）。
 * @returns 段名 → 该段命中的守卫种类集合。
 */
function guards(text: string): Record<string, Set<string>> {
  const statements = text.split('\n').filter(line => /^\s*if\s*\(/u.test(line))
  const result: Record<string, Set<string>> = {}
  for (const name of ['user', 'server', 'app']) {
    const hits = new Set<string>()
    for (const statement of statements) {
      if (new RegExp(`\\b${name}\\s*===\\s*''`, 'u').test(statement)) hits.add('empty')
      if (new RegExp(`hasNul\\(\\s*${name}\\s*\\)`, 'u').test(statement)) hits.add('nul')
    }
    result[name] = hits
  }
  return result
}

/** 宿主侧的构键点（含 `keyFor`：它是 store 里唯一的键构造调用点）。 */
function hostText(): string {
  const source = readRepoFile(HOST_KEY_FILE)
  return `${functionBody(source, 'aiConsentKey')}\n${functionBody(source, 'keyFor')}`
}

/** 客户端侧的构键点（`normalizeAppAiScope` + `appAiConsentKey`；判空/NUL 在归一化那一段）。 */
function clientText(): string {
  const source = readRepoFile(CLIENT_KEY_FILE)
  return `${functionBody(source, 'normalizeAppAiScope')}\n${functionBody(source, 'appAiConsentKey')}`
}

describe('授权键跨端对拍：客户端 UI 记忆 ↔ 宿主闸门（R21 FIX-7 ①）', () => {
  it('两端都真的从对方源码里抽到了结构（抽不出 ⇒ 失败，不 skip）', () => {
    expect(hostText()).toContain('aiConsentKey({')
    expect(hostText()).toContain('hasNul')
    expect(clientText()).toContain('normalizeAppAiScope')
    // 两边的段序都不是"单段"：用户与服务端都必须参与（否则下面的对拍就是空的）。
    expect(segmentOrder(hostText()).length).toBeGreaterThanOrEqual(2)
    expect(segmentOrder(clientText()).length).toBeGreaterThanOrEqual(2)
  })

  it('段序一致（宿主 `aiConsentKey` ↔ 客户端 `appAiConsentKey`，逐段比较而非各钉字面量）', () => {
    expect(segmentOrder(clientText())).toEqual(segmentOrder(hostText()))
  })

  it('每段的归一化表达式一致（trim / 形状收窄逐字同源）', () => {
    expect(normalizers(clientText())).toEqual(normalizers(hostText()))
  })

  it('每段的拒绝守卫一致（判空 + 判 NUL：拿不到就拒绝的方向相同）', () => {
    const host = guards(hostText())
    const client = guards(clientText())
    for (const name of segmentOrder(hostText())) {
      expect(client[name], `${name} 段的守卫`).toEqual(host[name])
      expect(host[name], `${name} 段必须同时判空与判 NUL`).toEqual(new Set(['empty', 'nul']))
    }
  })

  it('行为：客户端键里的三段顺序与抽出的段序一致（值按抽出的名字取值）', () => {
    const order = segmentOrder(hostText())
    const values: Record<string, string> = { user: 'SENTINEL-USER', server: 'SENTINEL-SERVER', app: 'SENTINEL-APP' }
    const key = appAiConsentKey({ userId: values.user!, serverURL: values.server! }, values.app!)
    expect(key).not.toBeNull()
    const positions = order.map(name => key!.indexOf(values[name]!))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('行为：换服务端 ⇒ 客户端键不同（回退到两段即红）', () => {
    const app = 'roster'
    const scopeA = { userId: 'alice', serverURL: 'https://a.harness.example.com' }
    const scopeB = { userId: 'alice', serverURL: 'https://b.harness.example.com' }
    expect(appAiConsentKey(scopeA, app)).not.toBe(appAiConsentKey(scopeB, app))
  })

  it('客户端键里带前缀（键空间与其它 localStorage 使用者隔开）', () => {
    const key = appAiConsentKey({ userId: 'alice', serverURL: 'https://a.harness.example.com' }, 'roster')
    expect(key!.startsWith(`${APP_AI_CONSENT_PREFIX}:`)).toBe(true)
  })
})

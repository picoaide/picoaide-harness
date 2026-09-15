/**
 * 2026-09-15 全量审计实测缺陷的回归（快照侧）。
 *
 * 本文件用一个**够真的最小 DOM** 跑**真探针源码**（`extractSnapshot*` 下发的
 * 表达式原样 `new Function` 执行），断言三件事：
 *
 * 1. P1 选择器不锚定（默认路径必踩）：`selectorOf` 曾最多向上 3 层拼
 *    `tag:nth-of-type(n)`，而 `document.querySelector` 从**文档根**解析 ——
 *    重复结构页面（两张同构表格）里同一个相对路径会命中**另一个**元素，
 *    点击照旧报成功。下面的 fixture 把这件事钉成可复现事实：同一条旧路径在
 *    这个 DOM 上解析到 Left-B（不是目标 Right-B），新路径解析回目标本身。
 * 2. P1 id 分支放过点号：`<input id="user.name">` 旧实现生成 `#user.name`，
 *    语义变成 `id=user && class=name`（解析到诱饵元素）。新实现走 CSS.escape
 *    或 `[id="…"]`，并且**唯一性校验通过才采用 id 快路径**。
 * 3. P2 静默截断/盲区：探针到上限直接 break，输出既没有命中总数也没有截断
 *    标记，子帧与 shadow root 完全不可见。现在返回 `{elements,total,truncated,
 *    frames,shadowRoots,…}`，`snapshotNote()` 给出可读提示。
 *
 * 最小 DOM 支持的选择器子集 = 探针真实生成的语法（`#id` / `[id="…"]` /
 * `tag:nth-of-type(n)` / `>` 组合 / 候选选择器的逗号组与 `:not(...)`），
 * 并且**故意实现真实的 CSS 语义**（`#user.name` = id + class），否则"旧实现
 * 会点错元素"这条反向对照就证不出来。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_TEXT_LIMIT,
  SNAPSHOT_TEXT_LIMIT,
  extractSnapshot,
  extractSnapshotWithMeta,
  extractTextWithMeta,
  snapshotNote,
  type SnapshotExtractionMeta,
} from '../src/snapshot.ts'

// ------------------------------------------------------------- 最小 DOM

class El {
  nodeType = 1
  readonly children: El[] = []
  parentElement: El | null = null
  disabled = false
  innerText = ''
  textContent = ''
  value = ''
  type = ''
  shadowRoot: unknown = undefined
  private readonly attrs: Record<string, string> = {}

  constructor(readonly tagName: string, attrs: Record<string, string> = {}, text = '') {
    for (const [name, value] of Object.entries(attrs)) this.attrs[name.toLowerCase()] = value
    this.innerText = text
    this.textContent = text
    if (typeof attrs['type'] === 'string') this.type = attrs['type']
  }

  get id(): string { return this.attrs['id'] ?? '' }
  set id(value: string) { this.attrs['id'] = value }
  get previousElementSibling(): El | null {
    const parent = this.parentElement
    if (parent === null) return null
    const index = parent.children.indexOf(this)
    return index > 0 ? parent.children[index - 1]! : null
  }
  getAttribute(name: string): string | null { return this.attrs[name.toLowerCase()] ?? null }
  getBoundingClientRect(): { width: number; height: number; top: number; bottom: number; left: number; right: number } {
    return { width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }
  }
  append(child: El): El {
    child.parentElement = this
    this.children.push(child)
    return child
  }
  /** 文档顺序的整棵子树（含自身）。 */
  walk(): El[] {
    return [this, ...this.children.flatMap((child) => child.walk())]
  }
  /** 元素级 querySelectorAll：从所属文档根解析，只匹配后代（真实语义）。 */
  querySelectorAll(selector: string): El[] {
    let root: El = this
    while (root.parentElement !== null) root = root.parentElement
    return queryCss(root, selector, false)
  }
}

/** 简易 CSS 解析：只覆盖探针/候选选择器用到的语法。 */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (const char of text) {
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '(') depth++
    if (char === ']' || char === ')') depth--
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.filter((part) => part.trim() !== '')
}

function nthOfType(el: El): number {
  const parent = el.parentElement
  const siblings = parent === null ? [el] : parent.children.filter((child) => child.tagName === el.tagName)
  return siblings.indexOf(el) + 1
}

function matchingParen(text: string, from: number): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '(') depth++
    if (text[i] === ')') {
      if (depth === 0) return i
      depth--
    }
  }
  return text.length
}

/** 把 `tag#id.class[attr="v"]:nth-of-type(n):not(...)` 解析成判定函数数组。 */
function parseCompound(text: string): Array<(el: El) => boolean> {
  const simples: Array<(el: El) => boolean> = []
  let i = 0
  while (i < text.length) {
    const char = text[i]!
    if (char === '*') { i++; continue }
    if (char === '#') {
      let j = i + 1
      let raw = ''
      while (j < text.length && !'.[:'.includes(text[j]!)) {
        if (text[j] === '\\') {
          j++
          if (j < text.length) raw += text[j]!
          j++
          continue
        }
        raw += text[j]!
        j++
      }
      const id = raw
      simples.push((el) => el.id === id)
      i = j
      continue
    }
    if (char === '.') {
      let j = i + 1
      let raw = ''
      while (j < text.length && !'.[:#'.includes(text[j]!)) { raw += text[j]!; j++ }
      const className = raw
      simples.push((el) => (el.getAttribute('class') ?? '').split(/\s+/u).includes(className))
      i = j
      continue
    }
    if (char === '[') {
      const close = text.indexOf(']', i)
      const body = text.slice(i + 1, close)
      const equal = body.indexOf('=')
      const name = (equal < 0 ? body : body.slice(0, equal)).toLowerCase()
      if (equal < 0) {
        simples.push((el) => el.getAttribute(name) !== null)
        i = close + 1
        continue
      }
      const value = JSON.parse(body.slice(equal + 1)) as string
      simples.push((el) => el.getAttribute(name) === value)
      i = close + 1
      continue
    }
    if (char === ':') {
      if (text.startsWith(':nth-of-type(', i)) {
        const close = text.indexOf(')', i)
        const n = Number(text.slice(':nth-of-type('.length + i, close))
        simples.push((el) => nthOfType(el) === n)
        i = close + 1
        continue
      }
      if (text.startsWith(':not(', i)) {
        const close = matchingParen(text, i + ':not('.length)
        const inner = parseCompound(text.slice(i + ':not('.length, close))
        simples.push((el) => !inner.every((fn) => fn(el)))
        i = close + 1
        continue
      }
      throw new Error(`最小的 CSS 引擎不支持伪类: ${text.slice(i)}`)
    }
    let j = i
    let tag = ''
    while (j < text.length && !'.[:#'.includes(text[j]!)) { tag += text[j]!; j++ }
    const lower = tag.toLowerCase()
    simples.push((el) => el.tagName.toLowerCase() === lower)
    i = j
  }
  return simples
}

/** 从文档根解析选择器（真实 CSS 语义：`#user.name` = id=user + class=name）。
 * `includeRoot` = `document.querySelectorAll`（可命中 html 自身）与元素级
 * `querySelectorAll`（只匹配后代）的区别。 */
function queryCss(root: El, selector: string, includeRoot = true): El[] {
  const matches: El[] = []
  for (const group of splitTop(selector, ',')) {
    const segments = splitTop(group, '>').map((segment) => parseCompound(segment.trim()))
    let current: El[] = [root]
    let first = true
    for (const compound of segments) {
      const candidates = first
        ? (includeRoot ? root.walk() : root.walk().slice(1))
        : current.flatMap((base) => base.walk().slice(1))
      first = false
      current = [...new Set(candidates.filter((el) => compound.every((fn) => fn(el))))]
      if (current.length === 0) break
    }
    for (const el of root.walk()) if (current.includes(el) && !matches.includes(el)) matches.push(el)
  }
  return matches
}

/** 与浏览器一致的 CSS.escape 子集（本 fixture 只用到 ASCII 标识符）。 */
const CSS_STUB = { escape: (value: string) => String(value).replace(/[^A-Za-z0-9_-]/gu, (char) => `\\${char}`) }

function documentStub(root: El): { body: El; documentElement: El; querySelectorAll: (selector: string) => El[] } {
  return { body: root, documentElement: root, querySelectorAll: (selector: string) => queryCss(root, selector) }
}

/** 跑真探针（`extractSnapshot*` 下发的表达式原样执行），返回探针的原始结果。 */
async function runProbeValue(
  root: El,
  options: { limit?: number; textLimit?: number; css?: boolean } = {},
): Promise<unknown> {
  const document = documentStub(root)
  let raw: unknown
  const send = async (_method: string, params?: Record<string, unknown>): Promise<never> => {
    const expression = String(params?.['expression'])
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', 'CSS', `return (${expression})`)
    raw = evaluate(
      document,
      () => ({ display: 'block', visibility: 'visible' }),
      1024,
      768,
      options.css === false ? undefined : CSS_STUB,
    )
    return { result: { value: raw } } as never
  }
  if (options.textLimit !== undefined) {
    await extractTextWithMeta(send, undefined, options.textLimit)
    return raw
  }
  await extractSnapshotWithMeta(send, options.limit ?? 200)
  return raw
}

async function snapshot(root: El, limit = 200): Promise<{ elements: Array<{ text: string; selector: string }>; meta: SnapshotExtractionMeta }> {
  const document = documentStub(root)
  const send = async (_method: string, params?: Record<string, unknown>): Promise<never> => {
    const expression = String(params?.['expression'])
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', 'CSS', `return (${expression})`)
    return { result: { value: evaluate(document, () => ({ display: 'block', visibility: 'visible' }), 1024, 768, CSS_STUB) } } as never
  }
  return await extractSnapshotWithMeta(send, limit)
}

// ------------------------------------------------------------- fixtures

interface Tables {
  html: El
  body: El
  leftB: El
  rightB: El
}

/** 两张**同构**的表格：Left-A/Left-B 与 Right-A/Right-B。目标 = Right-B。 */
function buildTables(): Tables {
  const html = new El('HTML')
  const body = html.append(new El('BODY'))
  const buttons: El[] = []
  for (const [tableId, label] of [['left', 'Left'], ['right', 'Right']] as const) {
    const table = body.append(new El('TABLE', { id: tableId }))
    const tbody = table.append(new El('TBODY'))
    for (const row of [1, 2] as const) {
      const td = tbody.append(new El('TR')).append(new El('TD'))
      buttons.push(td.append(new El('BUTTON', {}, `${label}-${row === 1 ? 'A' : 'B'}`)))
    }
  }
  return { html, body, leftB: buttons[1]!, rightB: buttons[3]! }
}

/** 旧实现（最多 3 层、相对路径、id 正则放点号）的等价复制，仅用于反向对照。 */
function legacySelectorOf(el: El): string {
  if (el.id !== '' && /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(el.id)) return `#${el.id}`
  const parts: string[] = []
  let node: El | null = el
  while (node !== null && node.nodeType === 1 && parts.length < 3) {
    let nth = 1
    let sibling = node.previousElementSibling
    while (sibling !== null) {
      if (sibling.tagName === node.tagName) nth++
      sibling = sibling.previousElementSibling
    }
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${nth})`)
    node = node.parentElement
  }
  return parts.join(' > ')
}

// ------------------------------------------------- 1. 选择器锚定 + 唯一

describe('2026-09-15 P1：快照 selector 必须从根锚定且唯一', () => {
  it('重复结构页面：生成的 selector 解析回**同一个**元素', async () => {
    const { html, rightB } = buildTables()
    const { elements } = await snapshot(html)
    const target = elements.find((entry) => entry.text === 'Right-B')
    expect(target, '前置条件：目标元素出现在快照里').toBeDefined()

    const resolved = queryCss(html, target!.selector)
    expect(resolved, `selector=${target!.selector}`).toHaveLength(1)
    expect(resolved[0]).toBe(rightB)
    // 从根锚定：路径以 html 段或唯一 id 锚点开头，而不是三段相对路径
    expect(target!.selector.startsWith('html:nth-of-type(1)') || target!.selector.startsWith('#')).toBe(true)
  })

  it('反向对照：旧的三层相对路径在这张表上命中**另一个**元素（Left-B）', async () => {
    const { html, leftB, rightB } = buildTables()
    const legacy = legacySelectorOf(rightB)
    // 旧算法对同一个元素给出的正是这条路径（3 段、无锚点）
    expect(legacy).toBe('tr:nth-of-type(2) > td:nth-of-type(1) > button:nth-of-type(1)')
    const resolved = queryCss(html, legacy)
    expect(resolved[0]).not.toBe(rightB)
    expect(resolved[0]).toBe(leftB)
    // 而新算法不会给出这条路径
    const { elements } = await snapshot(html)
    const target = elements.find((entry) => entry.text === 'Right-B')!
    expect(target.selector).not.toBe(legacy)
  })

  it('重复结构页面里每个元素的 selector 都唯一且自指（全量对拍）', async () => {
    const { html } = buildTables()
    const { elements } = await snapshot(html)
    expect(elements.length).toBeGreaterThanOrEqual(4)
    for (const entry of elements) {
      const resolved = queryCss(html, entry.selector)
      expect(resolved, `${entry.text} ⇒ ${entry.selector}`).toHaveLength(1)
      expect(resolved[0]!.innerText).toBe(entry.text)
    }
  })

  it('id 含点号：CSS.escape 后的 `#user\\.name` 解析回同一个 input，而不是诱饵', async () => {
    const html = new El('HTML')
    const body = html.append(new El('BODY'))
    const dotted = body.append(new El('INPUT', { id: 'user.name', name: 'login' }, ''))
    const decoy = body.append(new El('INPUT', { id: 'user', class: 'name' }, ''))

    const { elements } = await snapshot(html)
    const first = elements.find((entry) => entry.text === '' && entry.selector.includes('user'))!
    expect(first.selector).toBe('#user\\.name')
    const resolved = queryCss(html, first.selector)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toBe(dotted)
    expect(resolved[0]).not.toBe(decoy)

    // 反向对照：旧实现生成 `#user.name`，语义变成 id=user && class=name
    expect(queryCss(html, '#user.name')).toEqual([decoy])
  })

  it('CSS.escape 不可用时退回属性选择器（同样自指）', async () => {
    const html = new El('HTML')
    const body = html.append(new El('BODY'))
    const dotted = body.append(new El('INPUT', { id: 'user.name' }, ''))
    body.append(new El('INPUT', { id: 'user', class: 'name' }, ''))

    const document = documentStub(html)
    const send = async (_method: string, params?: Record<string, unknown>): Promise<never> => {
      const expression = String(params?.['expression'])
      // eslint-disable-next-line no-new-func
      const evaluate = new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', 'CSS', `return (${expression})`)
      return { result: { value: evaluate(document, () => ({ display: 'block', visibility: 'visible' }), 1024, 768, undefined) } } as never
    }
    const { elements } = await extractSnapshotWithMeta(send)
    expect(elements[0]!.selector).toBe('[id="user.name"]')
    expect(queryCss(html, elements[0]!.selector)).toEqual([dotted])
  })

  it('没有 id 的深层元素也锚定到根（不是三层截断）', async () => {
    const html = new El('HTML')
    const body = html.append(new El('BODY'))
    const section = body.append(new El('SECTION'))
    const div = section.append(new El('DIV'))
    const span = div.append(new El('SPAN'))
    span.append(new El('BUTTON', {}, 'deep'))

    const { elements } = await snapshot(html)
    const deep = elements.find((entry) => entry.text === 'deep')!
    expect(deep.selector).toBe(
      'html:nth-of-type(1) > body:nth-of-type(1) > section:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1) > button:nth-of-type(1)',
    )
    expect(queryCss(html, deep.selector)).toEqual([span.children[0]])
  })
})

// ------------------------------------------------- 5. 截断与盲区提示

describe('2026-09-15 P2：快照的截断与盲区必须对模型可见', () => {
  it('上限截断：total/truncated 与可读提示都在', async () => {
    const html = new El('HTML')
    const body = html.append(new El('BODY'))
    for (let i = 0; i < 5; i++) body.append(new El('BUTTON', {}, `B${i}`))

    const { elements, meta } = await snapshot(html, 3)
    expect(elements).toHaveLength(3)
    expect(meta.total).toBe(5)
    expect(meta.listed).toBe(3)
    expect(meta.truncated).toBe(true)
    expect(meta.limit).toBe(3)
    const note = snapshotNote(meta)
    expect(note).toBeDefined()
    expect(note).toContain('only 3 of 5')
    expect(note).toContain('limit 3')
  })

  it('计数上界：超出 COUNT_CAP 时 total 是下限且提示写明 at least', async () => {
    const html = new El('HTML')
    const body = html.append(new El('BODY'))
    // limit=1 ⇒ COUNT_CAP = 1001；给 1002 个候选，第 1002 个触发上界
    for (let i = 0; i < 1002; i++) body.append(new El('BUTTON', {}, `b${i}`))

    const { meta } = await snapshot(html, 1)
    expect(meta.countCapped).toBe(true)
    expect(meta.total).toBe(1001)
    expect(meta.truncated).toBe(true)
    expect(snapshotNote(meta)).toContain('at least 1001')
  })

  it('盲区：子帧与 shadow root 未包含时必须说明（并给出取用方式）', async () => {
    const { html, body } = buildTables()
    body.append(new El('IFRAME', { src: 'https://frame.example/' }))
    const host = body.append(new El('DIV'))
    host.shadowRoot = { mode: 'open' }

    const { meta } = await snapshot(html)
    expect(meta.frames).toBe(1)
    expect(meta.shadowRoots).toBe(1)
    // 盲区不是"列表被截断"，所以 truncated 仍为 false —— 提示走 note（两者都在
    // 工具输出里，模型不会只看到一半）。
    expect(meta.truncated).toBe(false)
    const note = snapshotNote(meta)!
    expect(note).toContain('1 sub-frame')
    expect(note).toContain('1 shadow root')
    expect(note).toContain('NOT included')
    expect(note).toContain('browser_eval(frame:N)')
  })

  it('既没截断也没盲区时不产生噪音提示', async () => {
    const { html } = buildTables()
    const { meta, elements } = await snapshot(html)
    expect(elements.length).toBeGreaterThan(0)
    expect(meta.frames).toBe(0)
    expect(meta.shadowRoots).toBe(0)
    expect(meta.truncated).toBe(false)
    expect(snapshotNote(meta)).toBeUndefined()
  })

  it('探针仍然兼容裸数组返回（历史桩/旧探针）', async () => {
    const send = async (): Promise<never> => ({ result: { value: [{ kind: 'button', text: 'x', selector: '#a', visible: true, disabled: false }] } }) as never
    const { elements, meta } = await extractSnapshotWithMeta(send)
    expect(elements).toHaveLength(1)
    expect(meta.truncated).toBe(false)
    expect(snapshotNote(meta)).toBeUndefined()
  })
})

// ------------------------------------------------- 4. 真实 truncated

describe('2026-09-15 P2：get_text 的 truncated 由提取侧给出（不是工具推算）', () => {
  const sendWith = (value: unknown) => async (): Promise<never> => ({ result: { value } }) as never

  it('textLimit=65536 + 40000 字符 ⇒ truncated=true（生效上限其实是 32768）', async () => {
    const out = await extractTextWithMeta(sendWith('a'.repeat(40_000)), undefined, 65_536)
    expect(MAX_TEXT_LIMIT).toBe(32 * 1024)
    expect(out.text).toHaveLength(32 * 1024)
    expect(out.truncated).toBe(true)
    // 反向对照：工具旧口径 `text.length >= runtime.options.textLimit` 会判 false
    expect(out.text.length >= 65_536).toBe(false)
  })

  it('恰好等于生效上限、其实没截断 ⇒ truncated=false（旧 `>=` 的误报消失）', async () => {
    const out = await extractTextWithMeta(sendWith('a'.repeat(32 * 1024)), undefined, 32 * 1024)
    expect(out.text).toHaveLength(32 * 1024)
    expect(out.truncated).toBe(false)
    // 反向对照：旧公式在这里给 true
    expect(out.text.length >= 32 * 1024).toBe(true)
  })

  it('投影（脱敏）之后仍然超长 ⇒ truncated=true', async () => {
    const secret = 'S3cr3tPass-xyz'
    const raw = 'x'.repeat(32 * 1024 - 4) + secret
    const out = await extractTextWithMeta(sendWith(raw), undefined, 32 * 1024, (text) => text.split(secret).join('****'))
    expect(out.text).toHaveLength(32 * 1024)
    expect(out.truncated).toBe(true)
    expect(out.text.endsWith('****')).toBe(true)
  })

  it('短文本不报截断（也不受元素级 80 字符窗口影响）', async () => {
    const out = await extractTextWithMeta(sendWith('hello'), undefined, 32 * 1024)
    expect(out).toEqual({ text: 'hello', truncated: false, total: 5 })
    expect(SNAPSHOT_TEXT_LIMIT).toBe(80)
  })
})

// ------------------------------------------------- 探针结构断言

describe('探针源码的静态断言（防回归）', () => {
  it('下发到页面的表达式带上了三个上界与选择器辅助', async () => {
    let expression = ''
    const send = async (_method: string, params?: Record<string, unknown>): Promise<never> => {
      expression = String(params?.['expression'])
      return { result: { value: { elements: [], total: 0, truncated: false, frames: 0, shadowRoots: 0 } } } as never
    }
    await extractSnapshotWithMeta(send, 7)
    expect(expression).toContain('CSS.escape')
    expect(expression).toContain('querySelectorAll')
    expect(expression).toContain('shadowRoot')
    expect(expression).toContain('iframe,frame')
    expect(expression).toContain('const MAX = 7;')
    expect(expression).toContain('const COUNT_CAP = 1007;')
    // 不再出现旧的三层截断
    expect(expression).not.toContain('parts.length < 3')
  })

  it('extractSnapshot 的返回类型不变（薄封装）', async () => {
    const rows = [{ kind: 'link', text: 'Docs', selector: '#docs', visible: true, disabled: false }]
    const send = async (): Promise<never> => ({ result: { value: rows } }) as never
    await expect(extractSnapshot(send)).resolves.toEqual([
      { index: 1, kind: 'link', text: 'Docs', selector: '#docs', visible: true, disabled: false },
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { extractSnapshot, extractText } from '../src/snapshot.ts'
import type { BrowserSnapshotElement } from '../src/types.ts'

type Send = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

function sendWith(value: unknown, exceptionDetails?: unknown): Send {
  return vi.fn(async () => ({ result: { value }, exceptionDetails }) as never)
}

function sendArgs(send: Send): [string, Record<string, unknown>] {
  const call = (send as ReturnType<typeof vi.fn>).mock.calls[0]!
  return [call[0] as string, call[1] as Record<string, unknown>]
}

function entry(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'button',
    text: 'Click me',
    selector: '#go',
    visible: true,
    disabled: false,
    ...partial,
  }
}

/**
 * 2026-09-12（P0-A）：探针是唯一把页面**值**搬进模型可读快照的地方，而
 * 2026-09-12 之前 11 个用例全部只断言 kind/selector/visible/disabled——
 * 从不断言 `text` 里出现了什么，这正是"密码明文回传模型"能长期存活的原因。
 * 下面用一个最小 DOM 桩**真跑**探针脚本，断言的是内容级事实。
 */
class FakeElement {
  nodeType = 1
  id = ''
  disabled = false
  innerText = ''
  textContent = ''
  parentElement: FakeElement | null = null
  previousElementSibling: FakeElement | null = null
  private readonly attrs: Record<string, string>
  constructor(
    readonly tagName: string,
    attrs: Record<string, string> = {},
    /** The DOM property (input value), not the attribute value. */
    public value = '',
    public type = '',
  ) {
    this.attrs = attrs
  }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null }
  getBoundingClientRect(): { width: number; height: number; top: number; bottom: number; left: number; right: number } {
    return { width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }
  }
}

/** Run the REAL probe script (as `extractSnapshot` sends it) against a fake DOM. */
async function snapshotFakeDom(nodes: FakeElement[]): Promise<BrowserSnapshotElement[]> {
  const root = {
    nodeType: 1,
    tagName: 'BODY',
    querySelectorAll: () => nodes,
  }
  const send: Send = async (_method: string, params?: Record<string, unknown>) => {
    const expression = String(params?.expression)
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', `return (${expression})`)
    const value = evaluate(
      { body: root, documentElement: root },
      () => ({ display: 'block', visibility: 'visible' }),
      1024,
      768,
    )
    return { result: { value } } as never
  }
  return await extractSnapshot(send)
}

describe('extractSnapshot', () => {
  it('collects interactable entries in DOM order with 1-based indexes', async () => {
    const send = sendWith([entry({ kind: 'link', text: 'Docs', selector: '#docs' }), entry({})])
    const snapshot = await extractSnapshot(send)
    expect(snapshot).toHaveLength(2)
    expect(snapshot[0]).toEqual({
      index: 1, kind: 'link', text: 'Docs', selector: '#docs', visible: true, disabled: false,
    })
    expect(snapshot[1]!.index).toBe(2)
    expect(snapshot[1]!.kind).toBe('button')
  })

  it('runs the bounded probe script without awaiting promises', async () => {
    const send = sendWith([])
    await extractSnapshot(send)
    const [method, params] = sendArgs(send)
    expect(method).toBe('Runtime.evaluate')
    expect(params.returnByValue).toBe(true)
    expect(params.awaitPromise).toBe(false)
    const expression = String(params.expression)
    expect(expression).toContain('querySelectorAll')
    expect(expression).not.toContain('setTimeout')
  })

  it('throws when the probe threw on the page', async () => {
    await expect(extractSnapshot(sendWith(null, { text: 'boom' }))).rejects.toThrow('browser: snapshot probe failed on this page')
  })

  it('returns [] for a non-array result', async () => {
    await expect(extractSnapshot(sendWith({ not: 'array' }))).resolves.toEqual([])
    await expect(extractSnapshot(sendWith(undefined))).resolves.toEqual([])
  })

  it('normalizes malformed entries and caps at the snapshot limit', async () => {
    const rows = [
      entry({ kind: 'input', text: 42 }), // non-string text → ''
      entry({ kind: 'weird', selector: '#x' }), // unknown kind → 'other'
      entry({ selector: 7 }), // invalid: no string selector → dropped
      null, // non-object → dropped
      'nope', // non-object → dropped
      ...Array.from({ length: 300 }, () => entry({ selector: '#n' })),
    ]
    const send = sendWith(rows)
    // raw.slice(limit) happens BEFORE the malformed-entry filter: 200 raw
    // entries in, 3 malformed dropped → 197.
    const snapshot = await extractSnapshot(send, 200)
    expect(snapshot).toHaveLength(197)
    expect(snapshot[0]!.kind).toBe('input')
    expect(snapshot[0]!.text).toBe('')
    expect(snapshot[1]!.kind).toBe('other')
    expect(snapshot[1]!.selector).toBe('#x')
  })

  it('clamps consumer-specified limits into 1..MAX', async () => {
    const send = sendWith([entry({})])
    await expect(extractSnapshot(send, 0)).resolves.toHaveLength(1)
    await expect(extractSnapshot(send, 10_000)).resolves.toHaveLength(1)
  })
})

describe('extractSnapshot: 内容级断言 — 密码值绝不进 text（P0-A，2026-09-12）', () => {
  // 关键词形状之外的密码：任何"按关键词掩码"的方案都救不了这一条。
  const SECRET = 'hunter2-xyz9-quartz'

  it('type=password 的 el.value 从不出现在快照 text 里', async () => {
    const password = new FakeElement('INPUT', { name: 'password' }, SECRET, 'password')
    const snapshot = await snapshotFakeDom([password])
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]!.text).not.toContain(SECRET)
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
    // 元素本身仍可被 click/type 定位（编号/selector/kind 不变）
    expect(snapshot[0]!.kind).toBe('input')
    expect(snapshot[0]!.selector).toBe('input:nth-of-type(1)')
    // 没有任何页面标签时给出一个中性的、非机密的占位符
    expect(snapshot[0]!.text).toBe('(password field)')
  })

  it('有 placeholder/aria-label 的密码框保留标签，但仍不读 value', async () => {
    const withPlaceholder = new FakeElement('INPUT', { name: 'pin', placeholder: '6-digit PIN' }, SECRET, 'password')
    const withLabel = new FakeElement('INPUT', { name: 'pw2', 'aria-label': 'Password' }, SECRET, 'password')
    const snapshot = await snapshotFakeDom([withPlaceholder, withLabel])
    expect(snapshot[0]!.text).toBe('6-digit PIN')
    expect(snapshot[1]!.text).toBe('Password')
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
  })

  it('普通输入框的值照常返回（修复不是"一刀切不读 value"）', async () => {
    const text = new FakeElement('INPUT', { name: 'username' }, 'alice', 'text')
    const noType = new FakeElement('INPUT', { name: 'q' }, 'hello', '')
    const snapshot = await snapshotFakeDom([text, noType])
    expect(snapshot[0]!.text).toBe('alice')
    expect(snapshot[1]!.text).toBe('hello')
  })

  it('大小写/属性形态的 password 类型一律不读 value', async () => {
    const upper = new FakeElement('INPUT', { name: 'p1', type: 'PASSWORD' }, SECRET, 'PASSWORD')
    const snapshot = await snapshotFakeDom([upper])
    expect(snapshot[0]!.text).toBe('(password field)')
  })

  it('探针源码本身不再对 password 落 el.value（防回归的静态断言）', async () => {
    const send = sendWith([])
    await extractSnapshot(send)
    const expression = String(sendArgs(send)[1].expression)
    expect(expression).toContain('(password field)')
    expect(expression).toContain("toLowerCase() === 'password'")
  })
})

describe('extractText', () => {
  it('extracts body text bounded to the default limit', async () => {
    const send = sendWith('hello world')
    const text = await extractText(send, undefined)
    expect(text).toBe('hello world')
    expect(String(sendArgs(send)[1].expression)).toContain('document.body.innerText')
  })

  it('queries a selector when given', async () => {
    const send = sendWith('target text')
    await extractText(send, '.article')
    expect(String(sendArgs(send)[1].expression)).toContain('.article')
  })

  it('treats blank selectors as body text', async () => {
    const send = sendWith('x')
    await extractText(send, '   ')
    expect(String(sendArgs(send)[1].expression)).toContain('document.body.innerText')
  })

  it('returns "" for non-string values and throws on probe failure', async () => {
    await expect(extractText(sendWith(123), undefined)).resolves.toBe('')
    await expect(extractText(sendWith(null, { text: 'boom' }), undefined)).rejects.toThrow('browser: text extraction failed on this page')
  })

  it('truncates to a bounded limit', async () => {
    const send = sendWith('a'.repeat(100_000))
    const text = await extractText(send, undefined, 32 * 1024)
    expect(text.length).toBe(32 * 1024)
  })
})

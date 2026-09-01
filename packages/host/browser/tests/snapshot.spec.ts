import { describe, expect, it, vi } from 'vitest'
import { extractSnapshot, extractText } from '../src/snapshot.ts'

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

/**
 * Page-content extraction for the embedded browser: an interactable-element
 * snapshot the model uses to target clicks/types, and plain-text extraction.
 * Extraction runs through CDP `Runtime.evaluate` with a fixed, self-contained
 * probe script; results are data-only (never executed), and every output is
 * bounded so a hostile page cannot flood the model context.
 * @module @picoaide/dsh-browser
 */

import type { BrowserSnapshotElement } from './types.ts'

/** Cap on snapshot entries per call. */
export const SNAPSHOT_LIMIT = 200
/** Cap on extracted text characters per call. */
export const TEXT_LIMIT = 32 * 1024

/**
 * Probe script: collect interactable elements in DOM order. The page can see
 * and influence this code, so it must (a) produce plain JSON only, (b) never
 * touch anything outside the page, and (c) fail softly on every element.
 */
const SNAPSHOT_PROBE = `
(() => {
  const out = [];
  const seen = new Set();
  const MAX = 200;
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox' || t === 'radio') return 'input';
      return 'input';
    }
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (el.getAttribute && el.getAttribute('role') === 'button') return 'button';
    return null;
  };
  const textOf = (el) => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.value || '').slice(0, 80);
    }
    if (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) {
      return (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 80);
    }
    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, 80);
  };
  const selectorOf = (el) => {
    if (el.id) {
      const id = String(el.id);
      if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(id)) return '#' + id;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 3) {
      const tag = node.tagName.toLowerCase();
      let nth = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) nth++; sib = sib.previousElementSibling; }
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const visibleOf = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const walk = (root) => {
    if (out.length >= MAX) return;
    const nodes = root.querySelectorAll('a,button,input,select,textarea,[role="button"],[tabindex]:not([tabindex="-1"])');
    for (const el of nodes) {
      if (out.length >= MAX) break;
      if (seen.has(el)) continue;
      seen.add(el);
      const kind = kindOf(el);
      if (!kind) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      out.push({
        kind,
        text: textOf(el),
        selector: selectorOf(el),
        visible: visibleOf(el),
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      });
    }
  };
  walk(document.body || document.documentElement);
  return out;
})()
`

/**
 * Extract the interactable-element snapshot of the current page through the
 * given CDP session. Bounded to `snapshotLimit` entries; each entry carries a
 * stable `index` (1-based) that click/type/select target.
 */
export async function extractSnapshot(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  snapshotLimit = SNAPSHOT_LIMIT,
): Promise<BrowserSnapshotElement[]> {
  const result = await send<{ result?: { value?: unknown }, exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression: SNAPSHOT_PROBE,
    returnByValue: true,
    awaitPromise: false,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error('browser: snapshot probe failed on this page')
  }
  const raw = result.result?.value
  if (!Array.isArray(raw)) return []
  const limit = Math.max(1, Math.min(snapshotLimit, SNAPSHOT_LIMIT))
  const out: BrowserSnapshotElement[] = []
  for (const entry of raw.slice(0, limit)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kind, text, selector, visible, disabled } = entry as Record<string, unknown>
    if (typeof kind !== 'string' || typeof selector !== 'string') continue
    out.push({
      index: out.length + 1,
      kind: ['link', 'button', 'input', 'select', 'textarea', 'other'].includes(kind) ? kind as BrowserSnapshotElement['kind'] : 'other',
      text: typeof text === 'string' ? text.slice(0, 80) : '',
      selector,
      visible: visible === true,
      disabled: disabled === true,
    })
  }
  return out
}

/** Extract visible text of the page (or of `selector` when given), bounded. */
export async function extractText(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  selector: string | undefined,
  textLimit = TEXT_LIMIT,
): Promise<string> {
  const expression = selector === undefined || selector.trim() === ''
    ? `(document.body ? document.body.innerText : '')`
    : `(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); return el ? (el.innerText || el.textContent || '') : ''; })()`
  const result = await send<{ result?: { value?: unknown }, exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error('browser: text extraction failed on this page')
  }
  const text = typeof result.result?.value === 'string' ? result.result.value : ''
  const limit = Math.max(1, Math.min(textLimit, TEXT_LIMIT))
  return text.slice(0, limit)
}

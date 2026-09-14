/**
 * Page-content extraction for the embedded browser: an interactable-element
 * snapshot the model uses to target clicks/types, and plain-text extraction.
 * Extraction runs through CDP `Runtime.evaluate` with a fixed, self-contained
 * probe script; results are data-only (never executed), and every output is
 * bounded so a hostile page cannot flood the model context.
 * @module @picoaide/dsh-browser
 */

import type { BrowserSnapshotElement } from './types.ts'

/** Default cap on snapshot entries per call. */
const SNAPSHOT_LIMIT = 200
/** Hard safety cap on snapshot entries (a deployment may raise the limit up to
 * this bound; the probe itself is bounded so a hostile page cannot flood). */
const SNAPSHOT_MAX_LIMIT = 2_000
/** Cap on extracted text characters per call. */
const TEXT_LIMIT = 32 * 1024
/** Model-facing cap on one snapshot element's text (the probe's documented
 * "80 chars"). Applied by {@link extractSnapshot} AFTER the caller's value
 * projection, never inside the page (R7). */
export const SNAPSHOT_TEXT_LIMIT = 80
/**
 * Page-side cap on one element's text (R7, 2026-09-13).
 *
 * Deliberately far above {@link SNAPSHOT_TEXT_LIMIT}: the model-facing 80-char
 * window used to be applied INSIDE the probe, i.e. before the host could redact
 * the tab's injected values — a credential straddling the window came back as a
 * plaintext tail fragment (`Audit note: …S3cr3tPass`) that no value rule could
 * recognize. The probe still needs a bound (a hostile page could otherwise ship
 * a megabyte of `innerText` per element over CDP); the real cap now runs
 * host-side, after redaction.
 */
const ELEMENT_TEXT_CAP = 1_024

/**
 * Probe script: collect interactable elements in DOM order. The page can see
 * and influence this code, so it must (a) produce plain JSON only, (b) never
 * touch anything outside the page, and (c) fail softly on every element.
 * The entry cap is injected (`__MAX__`) so a configured `snapshotLimit` above
 * the default actually reaches the page instead of being silently clamped to
 * 200 (P3).
 */
const SNAPSHOT_PROBE = `
(() => {
  const out = [];
  const seen = new Set();
  const MAX = __MAX__;
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
      const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
      // A password field's DOM property holds the real credential: unlike the
      // browser UI (dots), the property is plaintext, and the host itself puts
      // connector credentials there via browser_fill_credentials. Never read
      // it — keep the element (it must stay clickable/typeable by number) and
      // label it with the page's own placeholder, or a neutral marker.
      if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password') {
        return (placeholder || '(password field)').slice(0, __TEXT_CAP__);
      }
      return (placeholder || el.value || '').slice(0, __TEXT_CAP__);
    }
    if (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) {
      return (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, __TEXT_CAP__);
    }
    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, __TEXT_CAP__);
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
 *
 * `projectText` (R7, 2026-09-13) is the caller's model-facing value projection
 * (the runtime passes the tab's secret redactor). It runs on the FULL element
 * text and the {@link SNAPSHOT_TEXT_LIMIT} cap is applied afterwards, so a
 * credential that straddles the cap is masked whole instead of being clipped
 * into a plaintext fragment.
 */
export async function extractSnapshot(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  snapshotLimit = SNAPSHOT_LIMIT,
  projectText: (text: string) => string = (text) => text,
): Promise<BrowserSnapshotElement[]> {
  const limit = Math.max(1, Math.min(snapshotLimit, SNAPSHOT_MAX_LIMIT))
  const result = await send<{ result?: { value?: unknown }, exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression: SNAPSHOT_PROBE
      .replace('__MAX__', String(limit))
      .replaceAll('__TEXT_CAP__', String(ELEMENT_TEXT_CAP)),
    returnByValue: true,
    awaitPromise: false,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error('browser: snapshot probe failed on this page')
  }
  const raw = result.result?.value
  if (!Array.isArray(raw)) return []
  const out: BrowserSnapshotElement[] = []
  for (const entry of raw.slice(0, limit)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kind, text, selector, visible, disabled } = entry as Record<string, unknown>
    if (typeof kind !== 'string' || typeof selector !== 'string') continue
    const rawText = typeof text === 'string' ? text.slice(0, ELEMENT_TEXT_CAP) : ''
    out.push({
      index: out.length + 1,
      kind: ['link', 'button', 'input', 'select', 'textarea', 'other'].includes(kind) ? kind as BrowserSnapshotElement['kind'] : 'other',
      // Redact first, cut second (R7): the model-facing cap must not slice a
      // credential into a fragment no value rule can recognize.
      text: projectText(rawText).slice(0, SNAPSHOT_TEXT_LIMIT),
      selector,
      visible: visible === true,
      disabled: disabled === true,
    })
  }
  return out
}

/**
 * Extract visible text of the page (or of `selector` when given).
 *
 * `projectText` (R7, 2026-09-13) runs on the WHOLE extracted text and the cap is
 * applied afterwards: the previous order (slice 32KiB, then redact) left the
 * first characters of a credential that straddled the cap in cleartext.
 */
export async function extractText(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  selector: string | undefined,
  textLimit = TEXT_LIMIT,
  projectText: (text: string) => string = (text) => text,
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
  return projectText(text).slice(0, limit)
}

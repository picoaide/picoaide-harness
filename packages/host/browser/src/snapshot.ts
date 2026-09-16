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

/** Hard cap on extracted text characters per call (exported: the effective
 * limit is `min(textLimit, this)` and BOTH the extraction and every caller that
 * reasons about truncation must use the same one — see
 * {@link effectiveTextLimit}).
 *
 * 2026-09-15 审计 P2：`browser_get_text` 曾用 `text.length >= runtime.options.
 * textLimit` 自己推算 `truncated`，而真正生效的上限是 `min(textLimit, 32768)`
 * ——`textLimit=65536` 时工具会拿 65536 去比一条已经被 32KiB 截断的文本，标记
 * 与实际相反。 */
export const MAX_TEXT_LIMIT = TEXT_LIMIT

/** The character cap {@link extractText} actually applies (single source). */
function effectiveTextLimit(textLimit: number): number {
  return Math.max(1, Math.min(textLimit, TEXT_LIMIT))
}

/** How far past the entry cap the probe keeps COUNTING interactable elements
 * (2026-09-15 审计 P2): the model must be told how many elements were left out
 * ("another N not listed"), and a hostile page must not turn that count into an
 * unbounded walk — beyond `limit + this` the total is reported as a lower bound
 * (`countCapped`). */
const SNAPSHOT_ELEMENT_COUNT_EXTRA = 1_000
/** Bound on the `document.querySelectorAll('*')` scan used to report shadow
 * roots (a hostile page must not turn a snapshot into an O(page) walk). */
const SNAPSHOT_SHADOW_SCAN_CAP = 20_000
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
 *
 * 2026-09-15 审计 P2：返回值从裸数组改成 `{ elements, total, truncated,
 * frames, shadowRoots, … }` —— 截断与盲区必须对模型可见（旧实现到 MAX 直接
 * break，输出既没有命中总数也没有截断标记）。{@link extractSnapshot} 仍然
 * 兼容裸数组（历史桩/旧探针），只是那种形状拿不到计数。
 */
const SNAPSHOT_PROBE = `
(() => {
  const out = [];
  const seen = new Set();
  const MAX = __MAX__;
  const COUNT_CAP = __COUNT_CAP__;
  const SHADOW_SCAN_CAP = __SHADOW_SCAN_CAP__;
  const SEL = 'a,button,input,select,textarea,[role="button"],[tabindex]:not([tabindex="-1"])';
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
    // 2026-09-15 审计 P1（默认路径必踩）：旧实现最多向上 3 层拼
    // 'tag:nth-of-type(n)'，而 document.querySelector 是**从文档根**解析的——
    // 在重复结构页面（卡片/表格行）里同一个相对路径会命中另一个元素，点击
    // 照旧报成功（点错元素且模型以为成功）。id 分支的正则还允许点号：
    // <input id="user.name"> 生成 '#user.name'，语义变成 id=user && class=name。
    //
    // 现在的口径：**从根锚定且唯一**。
    //  · 自身 id：用 CSS.escape 生成（点号等特殊字符被正确转义），并且必须
    //    document.querySelectorAll(sel).length === 1 且就是本元素才采用；
    //    CSS.escape 不可用时退回属性选择器 [id="…"]（JSON.stringify 负责转义）。
    //  · 否则自底向上拼到根（html），遇到带唯一 id 的祖先就把它当作锚点停下
    //    （等价于 DevTools 的 Copy selector 口径）：'#main > div:nth-of-type(2)
    //    > button:nth-of-type(1)'。锚点唯一 ⇒ 整条路径唯一，不会再命中兄弟分支。
    const idSelector = (id) => {
      const text = String(id);
      try {
        if (typeof CSS !== 'undefined' && CSS !== null && typeof CSS.escape === 'function') return '#' + CSS.escape(text);
      } catch (e) { /* 老引擎/测试桩：退回属性形式 */ }
      return '[id=' + JSON.stringify(text) + ']';
    };
    const resolvesToSelf = (selector, el) => {
      try {
        const found = document.querySelectorAll(selector);
        return found.length === 1 && found[0] === el;
      } catch (e) { return false; }
    };
    if (el.id) {
      const own = idSelector(el.id);
      if (resolvesToSelf(own, el)) return own;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      let nth = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) nth++; sib = sib.previousElementSibling; }
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      const parent = node.parentElement;
      if (!parent || parent.nodeType !== 1) break;
      if (parent.id) {
        const anchor = idSelector(parent.id);
        if (resolvesToSelf(anchor, parent)) { parts.unshift(anchor); break; }
      }
      node = parent;
    }
    return parts.join(' > ');
  };
  const visibleOf = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const walk = (root) => {
    if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return;
    const nodes = root.querySelectorAll(SEL);
    for (const el of nodes) {
      // 2026-09-15 审计 P2：命中总数必须**越过 MAX 继续数**，否则"被截断"对
      // 模型不可见（旧实现到 MAX 直接 break，输出既没有计数也没有截断标记，
      // 模型会把一个不完整的列表当成完整列表）。计数本身也要有上界：COUNT_CAP
      // 之外不再统计（countCapped=true 表示 total 只是下限）。
      if (examined >= COUNT_CAP) { countCapped = true; return; }
      examined++;
      if (seen.has(el)) continue;
      seen.add(el);
      const kind = kindOf(el);
      if (!kind) continue;
      let style = null;
      try { style = getComputedStyle(el); } catch (e) { style = null; }
      if (style !== null && (style.display === 'none' || style.visibility === 'hidden')) continue;
      total++;
      if (out.length >= MAX) continue;
      out.push({
        kind,
        text: textOf(el),
        selector: selectorOf(el),
        visible: visibleOf(el),
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      });
    }
  };
  let total = 0;
  let examined = 0;
  let countCapped = false;
  walk(document.body || document.documentElement);
  // 盲区（2026-09-15 审计 P2）：探针只在主帧、只在 light DOM 里走，子帧和
  // shadow root 里的可交互元素一个都收不到。以前这件事对模型完全不可见；
  // 现在把数量报出来，让模型知道"没看到"不等于"不存在"。
  let frames = 0;
  let shadowRoots = 0;
  let shadowScanCapped = false;
  try { frames = document.querySelectorAll('iframe,frame').length; } catch (e) { /* 老引擎/测试桩 */ }
  try {
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (i >= SHADOW_SCAN_CAP) { shadowScanCapped = true; break; }
      if (all[i].shadowRoot) shadowRoots++;
    }
  } catch (e) { /* 老引擎/测试桩 */ }
  return {
    elements: out,
    total: total,
    countCapped: countCapped,
    truncated: countCapped || total > out.length,
    frames: frames,
    shadowRoots: shadowRoots,
    shadowScanCapped: shadowScanCapped,
  };
})()
`

/**
 * What one snapshot extraction found beyond the list itself (2026-09-15 审计 P2).
 *
 * The list was already capped before; what was missing is that the model could
 * not tell a complete list from a cut one, and could not tell that sub-frames /
 * shadow roots are outside the probe's reach entirely.
 */
export interface SnapshotExtractionMeta {
  /** Interactable elements the probe counted (a LOWER BOUND when `countCapped`). */
  total: number
  /** Entries actually listed (= `elements.length`). */
  listed: number
  /** True when entries were dropped by the cap (or counting itself was capped). */
  truncated: boolean
  /** The entry cap that was in effect for this extraction. */
  limit: number
  /** Sub-frames (`iframe`/`frame`) in the main document — NOT included above. */
  frames: number
  /** Shadow roots found in the main document — their content is NOT included. */
  shadowRoots: number
  /** The shadow-root scan itself hit its bound (`shadowRoots` is a lower bound). */
  shadowScanCapped: boolean
  /** Counting hit its bound (`total` is a lower bound). */
  countCapped: boolean
}

/** Result of {@link extractSnapshotWithMeta}. */
export interface SnapshotExtraction {
  elements: BrowserSnapshotElement[]
  meta: SnapshotExtractionMeta
}

/**
 * Human-readable blind-spot/truncation note for the model, or `undefined` when
 * the list is provably complete.
 *
 * 2026-09-15 审计 P2：静默截断与盲区都要有可读提示。文案是模型面字符串，
 * 与本包其它模型面文案一致用英文（注释/内部报告用中文）。
 */
export function snapshotNote(meta: SnapshotExtractionMeta): string | undefined {
  const parts: string[] = []
  if (meta.truncated) {
    const missing = Math.max(meta.total - meta.listed, 0)
    parts.push(
      missing > 0
        ? `only ${meta.listed} of ${meta.countCapped ? `at least ${meta.total}` : meta.total} interactable elements are listed (limit ${meta.limit})`
        : `the element list was cut at the limit of ${meta.limit}`,
    )
  }
  const blind: string[] = []
  if (meta.frames > 0) blind.push(`${meta.frames} sub-frame${meta.frames === 1 ? '' : 's'}`)
  if (meta.shadowRoots > 0) blind.push(`${meta.shadowRoots}${meta.shadowScanCapped ? '+' : ''} shadow root${meta.shadowRoots === 1 && !meta.shadowScanCapped ? '' : 's'}`)
  if (blind.length > 0) {
    parts.push(`${blind.join(' and ')} are NOT included — use browser_eval(frame:N) or browser_get_text(selector) if the element you need is inside one`)
  }
  return parts.length === 0 ? undefined : `snapshot: ${parts.join('; ')}.`
}

/** Normalize the probe's return value: the object form carries the counts, a
 * bare array (older probe / a test stub) does not. */
function normalizeProbeValue(raw: unknown, limit: number): { entries: unknown[], meta: SnapshotExtractionMeta } {
  const empty: SnapshotExtractionMeta = {
    total: Array.isArray(raw) ? raw.length : 0,
    listed: 0,
    truncated: false,
    limit,
    frames: 0,
    shadowRoots: 0,
    shadowScanCapped: false,
    countCapped: false,
  }
  if (Array.isArray(raw)) return { entries: raw, meta: empty }
  if (typeof raw !== 'object' || raw === null) return { entries: [], meta: empty }
  const record = raw as Record<string, unknown>
  const entries = Array.isArray(record.elements) ? record.elements : []
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  return {
    entries,
    meta: {
      total: Math.max(number(record.total), entries.length),
      listed: 0,
      truncated: record.truncated === true,
      limit,
      frames: number(record.frames),
      shadowRoots: number(record.shadowRoots),
      shadowScanCapped: record.shadowScanCapped === true,
      countCapped: record.countCapped === true,
    },
  }
}

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
 *
 * 2026-09-15 审计 P2：另有 {@link extractSnapshotWithMeta} 返回命中总数与
 * 截断/盲区统计（数出"另有 N 个元素未列出、M 个子帧与 shadow root 未包含"）。
 * 本函数保持原返回类型（`BrowserSnapshotElement[]`），是它的薄封装。
 */
export async function extractSnapshot(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  snapshotLimit = SNAPSHOT_LIMIT,
  projectText: (text: string, context: SnapshotTextContext) => string = (text) => text,
): Promise<BrowserSnapshotElement[]> {
  return (await extractSnapshotWithMeta(send, snapshotLimit, projectText)).elements
}

/**
 * What the host knows about one element text when it redacts it
 * (2026-09-15 审计 P1「>1024 的长凭据只剩头部」).
 *
 * The probe cuts every element's text at {@link ELEMENT_TEXT_CAP} **page-side**,
 * i.e. before the host can redact it. For a credential longer than that cap which
 * sits inside a longer text, the head therefore survives as a fragment no value
 * rule can recognize (`out.includes(secret)` is false, the text is not itself a
 * prefix of the secret). The redactor is told when the cut may have happened so
 * it can mask the tail instead of guessing (R-4/F-2 refused to guess from the
 * text alone, and that refusal stands: without this flag nothing changes).
 */
export interface SnapshotTextContext {
  /** The probe's cap was hit, so the text may end in the head of a value. */
  truncated: boolean
}

/** {@link extractSnapshot} plus the counts/blind-spot metadata. */
export async function extractSnapshotWithMeta(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  snapshotLimit = SNAPSHOT_LIMIT,
  projectText: (text: string, context: SnapshotTextContext) => string = (text) => text,
): Promise<SnapshotExtraction> {
  const limit = Math.max(1, Math.min(snapshotLimit, SNAPSHOT_MAX_LIMIT))
  const result = await send<{ result?: { value?: unknown }, exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression: SNAPSHOT_PROBE
      .replace('__MAX__', String(limit))
      .replace('__COUNT_CAP__', String(limit + SNAPSHOT_ELEMENT_COUNT_EXTRA))
      .replace('__SHADOW_SCAN_CAP__', String(SNAPSHOT_SHADOW_SCAN_CAP))
      .replaceAll('__TEXT_CAP__', String(ELEMENT_TEXT_CAP)),
    returnByValue: true,
    awaitPromise: false,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error('browser: snapshot probe failed on this page')
  }
  const { entries, meta } = normalizeProbeValue(result.result?.value, limit)
  const out: BrowserSnapshotElement[] = []
  for (const entry of entries.slice(0, limit)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kind, text, selector, visible, disabled } = entry as Record<string, unknown>
    if (typeof kind !== 'string' || typeof selector !== 'string') continue
    const rawText = typeof text === 'string' ? text.slice(0, ELEMENT_TEXT_CAP) : ''
    out.push({
      index: out.length + 1,
      kind: ['link', 'button', 'input', 'select', 'textarea', 'other'].includes(kind) ? kind as BrowserSnapshotElement['kind'] : 'other',
      // Redact first, cut second (R7): the model-facing cap must not slice a
      // credential into a fragment no value rule can recognize.
      text: projectText(rawText, { truncated: rawText.length >= ELEMENT_TEXT_CAP }).slice(0, SNAPSHOT_TEXT_LIMIT),
      selector,
      visible: visible === true,
      disabled: disabled === true,
    })
  }
  // `listed` is the post-filter count the model actually receives; `truncated`
  // must not claim a cut when the probe over-counted (malformed entries).
  const listed = out.length
  return {
    elements: out,
    meta: { ...meta, listed, truncated: meta.truncated || listed < Math.min(meta.total, limit) },
  }
}

/** One text extraction: the (projected, capped) text plus whether the cap cut
 * it — measured here, never guessed by the caller (2026-09-15 审计 P2). */
export interface TextExtraction {
  text: string
  /** The page text was longer than the effective cap (or the projected text
   * still is): characters of the document did not come back. */
  truncated: boolean
  /** Length of the PAGE text, before projection and before the cap. */
  total: number
}

/**
 * Extract visible text of the page (or of `selector` when given).
 *
 * `projectText` (R7, 2026-09-13) runs on the WHOLE extracted text and the cap is
 * applied afterwards: the previous order (slice 32KiB, then redact) left the
 * first characters of a credential that straddled the cap in cleartext.
 *
 * 2026-09-15 审计 P2：截断标记由这里（唯一知道投影前长度与生效上限的地方）
 * 算出来，工具不再用 `Math.min(textLimit, 32768)` 自己推算。
 */
export async function extractTextWithMeta(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  selector: string | undefined,
  textLimit = TEXT_LIMIT,
  projectText: (text: string) => string = (text) => text,
): Promise<TextExtraction> {
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
  const limit = effectiveTextLimit(textLimit)
  const projected = projectText(text)
  // 2026-09-15 审计 P2（真实 truncated）：两条路径都要算。
  //  · `text.length > limit`：页面文本本身就超过生效上限 ⇒ 无论擦除与否都有
  //    字符留在页面上（`textLimit=65536` + 40000 字符的实测形状走这条）。
  //  · `projected.length > limit`：擦除**之后**仍然超长 ⇒ 这次返回被切了尾巴。
  // 旧实现把判定放在工具里用 `text.length >= runtime.options.textLimit` 推算，
  // 上限取错（65536 vs 生效的 32768）且 `>=` 在"恰好等于上限、其实没截断"时误报。
  return { text: projected.slice(0, limit), truncated: text.length > limit || projected.length > limit, total: text.length }
}

/** {@link extractTextWithMeta}'s text half (unchanged string contract). */
export async function extractText(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  selector: string | undefined,
  textLimit = TEXT_LIMIT,
  projectText: (text: string) => string = (text) => text,
): Promise<string> {
  return (await extractTextWithMeta(send, selector, textLimit, projectText)).text
}

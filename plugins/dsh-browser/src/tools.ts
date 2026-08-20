/**
 * Model-facing `browser_*` tool suite over the embedded browser runtime.
 * This module owns schemas, argument validation, prompt guidance, and
 * presentation; execution delegates to the BrowserRuntime (which owns the
 * view hierarchy, CDP, mutex, and guards).
 * @module @picoaide/dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolResult } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
// Type-only: makes `ctx.attachments` resolve to the AttachmentService type.
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { isPasswordTarget, isSubmitTarget } from './guard.ts'
import type { BrowserRuntime } from './runtime.ts'
import type { BrowserWaitUntil } from './types.ts'

/** Cooperative tool-call timeout budget for every browser tool (ms). */
const BROWSER_TOOL_TIMEOUT_MS = 30_000

/** Valid waitUntil values for navigation tools. */
const WAIT_UNTILS: readonly BrowserWaitUntil[] = ['domcontentloaded', 'load', 'networkidle']

/** The tool guidance band shown to the model (after the 100-199 per-tool band). */
const BROWSER_GUIDANCE = `You have an embedded browser. Drive it like a human user:
1. Start with browser_open or browser_new_tab, then browser_navigate to a URL.
2. Before interacting, call browser_get_snapshot to list the numbered interactable elements (links, buttons, inputs, selects).
3. Target elements by their snapshot number (e.g. target: 12); you may pass a CSS selector instead when you know one.
4. After navigation or any action that changes the page, call browser_get_snapshot again — the page may have re-rendered and renumbered everything.
5. Take a browser_screenshot only when you need visual confirmation; prefer snapshots and text to save tokens.
6. browser_type fills the focused input; use browser_press for Enter/Tab/Escape.
7. Filling a password field or submitting a form will ask the user for approval; do not work around that.
8. browser_eval executes JavaScript in the page; it is powerful and prompts for approval — prefer the other tools.
9. Do not navigate away from a page you were asked to inspect without saying so first.
10. Close tabs you no longer need with browser_close_tab.`

/** Resolve `target` (snapshot number or CSS selector) to a selector. */
async function resolveTarget(runtime: BrowserRuntime, tabId: number, target: number | string): Promise<string> {
  if (typeof target === 'string') {
    if (target.trim() === '') throw new Error('target selector must not be empty')
    return target.trim()
  }
  if (!Number.isInteger(target) || target < 1) throw new Error('target number must be a positive integer')
  const snapshot = await runtime.snapshot(tabId)
  const entry = snapshot.find((item) => item.index === target)
  if (entry === undefined) {
    throw new Error(`browser: no snapshot element ${target} — call browser_get_snapshot first (${snapshot.length} elements)`)
  }
  return entry.selector
}

/** Present a pending browser operation as a generic card. */
function present(title: string): (args: unknown) => GenericCallView {
  return (args) => ({ card: 'generic', kind: 'other', title, rawInput: args as Record<string, unknown> })
}

/** Result meta projection helpers. */
function metaFrom(value: JsonValue): JsonValue {
  return value
}

/**
 * Register the full browser tool suite.
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param runtime - the embedded browser runtime (owns tabs, mutex, guards).
 * @param attachments - whether `ctx.attachments` is available (screenshot
 *   needs it); screenshots fail with a clear message otherwise.
 */
export function applyBrowserTools(ctx: Context, runtime: BrowserRuntime): void {
  ctx.systemPrompt.section({
    name: 'tool:browser',
    order: 111,
    text: BROWSER_GUIDANCE,
  })

  const tabOf = async (tab: number | undefined): Promise<number> => {
    if (tab !== undefined) return tab
    const current = runtime.currentTabId()
    if (current === undefined) throw new Error('browser: no tab open — call browser_open first')
    return current
  }

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open the embedded browser (creating the first tab) and optionally navigate to a URL. Use this as the first browser action.',
    parameters: {
      url: { type: 'string', description: 'Optional URL to open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tab: { type: 'integer' }, url: { type: 'string' }, title: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: formatTabOpened(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Open browser'),
    async execute(args, exec) {
      const { url } = args as { url?: string }
      const tab = await runtime.open(url ?? undefined)
      exec.signal.throwIfAborted()
      return { tab: tab.id, url: tab.url, title: tab.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_new_tab',
    description: 'Open a new tab (optionally navigating to a URL) and switch to it.',
    parameters: {
      url: { type: 'string', description: 'Optional URL to load in the new tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tab: { type: 'integer' }, url: { type: 'string' }, title: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: formatTabOpened(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('New browser tab'),
    async execute(args, exec) {
      const { url } = args as { url?: string }
      const tab = await runtime.open(url ?? undefined)
      exec.signal.throwIfAborted()
      return { tab: tab.id, url: tab.url, title: tab.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Navigate the tab to a URL. http/https only; other schemes are denied.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      url: { type: 'string', required: true, description: 'The URL to navigate to.' },
      waitUntil: { type: 'string', enum: WAIT_UNTILS, description: 'Load milestone to wait for (default domcontentloaded).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { url: { type: 'string' }, title: { type: 'string' }, loading: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: formatNavigation(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Navigate'),
    async execute(args, exec) {
      const { tab, url, waitUntil } = args as { tab?: number; url: string; waitUntil?: BrowserWaitUntil }
      if (typeof url !== 'string' || url.trim() === '') throw new Error('url must be a non-empty string')
      const tabId = await tabOf(tab)
      await runtime.navigate(tabId, url.trim(), waitUntil ?? 'domcontentloaded')
      exec.signal.throwIfAborted()
      const state = runtime.tabState(tabId)
      return { url: state.url, title: state.title, loading: state.loading }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_reload',
    description: 'Reload the current page of a tab.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Reloaded ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Reload page'),
    async execute(args, exec) {
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.reload(tabId)
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_go_back',
    description: 'Navigate back in the tab history.',
    parameters: { tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Back to ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Go back'),
    async execute(args, exec) {
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.goBack(tabId)
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_go_forward',
    description: 'Navigate forward in the tab history.',
    parameters: { tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Forward to ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Go forward'),
    async execute(args, exec) {
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.goForward(tabId)
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element, targeted by its snapshot number or a CSS selector. Submitting forms or clicking buttons prompts the user for approval.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      target: { oneOf: [{ type: 'integer' }, { type: 'string' }], required: true, description: 'Snapshot element number or CSS selector.' },
      submit: { type: 'boolean', description: 'Set true when this click submits a form (triggers the approval prompt).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Clicked.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Click'),
    async execute(args, exec) {
      const { tab, target, submit } = args as { tab?: number; target: number | string; submit?: boolean }
      const tabId = await tabOf(tab)
      const snapshot = await runtime.snapshot(tabId)
      const entry = typeof target === 'number' ? snapshot.find((item) => item.index === target) : undefined
      const selector = await resolveTarget(runtime, tabId, target)
      if (submit === true || (entry !== undefined && isSubmitTarget(entry.kind, entry.text, entry.selector))) {
        const allowed = await runtime.requireApproval({
          agent: exec.agent,
          toolName: 'browser_click',
          callId: exec.callId,
          reason: `提交表单或点击按钮: ${entry?.text ?? selector}`,
          signal: exec.signal,
        })
        if (!allowed) throw new Error('browser: form submission was not approved by the user')
      }
      const point = await runtime.locateElement(tabId, selector)
      await runtime.clickAt(tabId, point)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an input (snapshot number or CSS selector). Filling a password field prompts the user for approval.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      target: { oneOf: [{ type: 'integer' }, { type: 'string' }], required: true, description: 'Snapshot element number or CSS selector.' },
      text: { type: 'string', required: true, description: 'The text to type (any Unicode).' },
      clear: { type: 'boolean', description: 'Clear the field before typing (default true).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Typed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Type'),
    async execute(args, exec) {
      const { tab, target, text, clear } = args as { tab?: number; target: number | string; text: string; clear?: boolean }
      if (typeof text !== 'string' || text.length > 16 * 1024) throw new Error('text must be a string ≤ 16KB')
      const tabId = await tabOf(tab)
      const selector = await resolveTarget(runtime, tabId, target)
      if (isPasswordTarget(selector)) {
        const allowed = await runtime.requireApproval({
          agent: exec.agent,
          toolName: 'browser_type',
          callId: exec.callId,
          reason: '向密码字段输入内容',
          signal: exec.signal,
        })
        if (!allowed) throw new Error('browser: password entry was not approved by the user')
      }
      await runtime.typeInto(tabId, selector, text, clear !== false)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_press',
    description: 'Press a key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, space).',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      key: { type: 'string', required: true, description: 'The key to press.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Key pressed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Press key'),
    async execute(args, exec) {
      const { tab, key } = args as { tab?: number; key: string }
      if (typeof key !== 'string' || key.length === 0) throw new Error('key must be a non-empty string')
      const tabId = await tabOf(tab)
      await runtime.pressKey(tabId, key)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_select',
    description: 'Select an option in a dropdown (snapshot number or CSS selector).',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      target: { oneOf: [{ type: 'integer' }, { type: 'string' }], required: true, description: 'Snapshot element number or CSS selector.' },
      value: { type: 'string', required: true, description: 'The option value to select.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Selected.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Select option'),
    async execute(args, exec) {
      const { tab, target, value } = args as { tab?: number; target: number | string; value: string }
      const tabId = await tabOf(tab)
      const selector = await resolveTarget(runtime, tabId, target)
      await runtime.selectOption(tabId, selector, value)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the page by a vertical delta, or bring a snapshot element into view.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      deltaY: { type: 'integer', description: 'Vertical scroll amount in pixels (negative scrolls up).' },
      target: { oneOf: [{ type: 'integer' }, { type: 'string' }], description: 'Snapshot element number or CSS selector to bring into view.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Scrolled.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Scroll'),
    async execute(args, exec) {
      const { tab, deltaY, target } = args as { tab?: number; deltaY?: number; target?: number | string }
      const tabId = await tabOf(tab)
      const selector = target === undefined ? undefined : await resolveTarget(runtime, tabId, target)
      await runtime.scroll(tabId, deltaY ?? 0, selector)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the visible page as a JPEG image (bounded width). Use sparingly — snapshots and text are cheaper.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        const image = (value as { image?: ImageAttachmentRef }).image
        return image === undefined
          ? [{ type: 'text', text: 'Screenshot failed.' }]
          : [{ type: 'image', attachment: image }]
      },
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Screenshot'),
    async execute(args, exec) {
      const tabId = await tabOf((args as { tab?: number }).tab)
      const dataUrl = await runtime.screenshot(tabId)
      exec.signal.throwIfAborted()
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const data = Buffer.from(base64, 'base64')
      const refs = await ctx.attachments.saveImages([{
        data: new Uint8Array(data),
        mediaType: 'image/jpeg' as const,
        name: `browser-tab-${tabId}.jpg`,
      }])
      const ref = refs[0]
      if (ref === undefined) throw new Error('browser: screenshot could not be stored')
      return { image: ref }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_get_snapshot',
    description: 'List the numbered interactable elements of the page (links, buttons, inputs, selects, textareas). The numbers are the targets for click/type/select/scroll.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          elements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                kind: { type: 'string' },
                text: { type: 'string' },
                selector: { type: 'string' },
                visible: { type: 'boolean' },
                disabled: { type: 'boolean' },
              },
            },
          },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Page snapshot'),
    async execute(args, exec) {
      const tabId = await tabOf((args as { tab?: number }).tab)
      const elements = await runtime.snapshot(tabId)
      exec.signal.throwIfAborted()
      return { elements, url: runtime.tabState(tabId).url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_get_text',
    description: 'Extract the visible text of the page, or of one element (CSS selector). Bounded output.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      selector: { type: 'string', description: 'Optional CSS selector; without it the whole page text is returned.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, truncated: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: formatText(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Page text'),
    async execute(args, exec) {
      const { tab, selector } = args as { tab?: number; selector?: string }
      const tabId = await tabOf(tab)
      const text = await runtime.text(tabId, selector)
      exec.signal.throwIfAborted()
      return { text, truncated: text.length >= runtime.options.textLimit }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_list_tabs',
    description: 'List all open tabs with their ids, URLs, titles, and which is visible.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                url: { type: 'string' },
                title: { type: 'string' },
                loading: { type: 'boolean' },
                visible: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatTabs(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('List tabs'),
    async execute() {
      const tabs = runtime.listTabs()
      return { tabs }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_switch_tab',
    description: 'Switch the visible tab.',
    parameters: { tab: { type: 'integer', required: true, description: 'The tab id to show.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tab: { type: 'integer' }, url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Switched to tab ${String((value as { tab?: number }).tab ?? '')}.` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Switch tab'),
    async execute(args, exec) {
      const tabId = (args as { tab: number }).tab
      await runtime.switchTab(tabId)
      exec.signal.throwIfAborted()
      return { tab: tabId, url: runtime.tabState(tabId).url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close_tab',
    description: 'Close one tab and destroy its resources.',
    parameters: { tab: { type: 'integer', required: true, description: 'The tab id to close.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Tab closed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Close tab'),
    async execute(args, exec) {
      await runtime.closeTab((args as { tab: number }).tab)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close the whole embedded browser and release all tabs.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Browser closed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Close browser'),
    async execute(_, exec) {
      await runtime.closeAll()
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_eval',
    description: 'Execute JavaScript in the page context and return the JSON result. Powerful — every call prompts the user for approval. Prefer the other tools.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      expression: { type: 'string', required: true, description: 'The JavaScript expression to evaluate (≤ 64KB).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: formatEval(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Evaluate JS'),
    async execute(args, exec) {
      const { tab, expression } = args as { tab?: number; expression: string }
      const tabId = await tabOf(tab)
      const allowed = await runtime.requireApproval({
        agent: exec.agent,
        toolName: 'browser_eval',
        callId: exec.callId,
        reason: `在页面中执行 JavaScript: ${expression.slice(0, 120)}`,
        signal: exec.signal,
      })
      if (!allowed) throw new Error('browser: eval was not approved by the user')
      const result = await runtime.eval(tabId, expression)
      exec.signal.throwIfAborted()
      return { result: String(result) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_fill_credentials',
    description: 'Fill the login form with credentials stored for a connector (e.g. an enterprise account). Prompts the user for approval. Does not submit the form.',
    parameters: {
      tab: { type: 'integer', description: 'Tab id (defaults to the visible tab).' },
      connectorId: { type: 'string', required: true, description: 'The connector id whose stored credentials to use.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'boolean' },
          password: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatCredentialFill(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Fill credentials'),
    async execute(args, exec) {
      const { tab, connectorId } = args as { tab?: number; connectorId: string }
      if (typeof connectorId !== 'string' || connectorId.trim() === '') {
        throw new Error('connectorId must be a non-empty string')
      }
      const tabId = await tabOf(tab)
      const allowed = await runtime.requireApproval({
        agent: exec.agent,
        toolName: 'browser_fill_credentials',
        callId: exec.callId,
        reason: `向登录表单注入连接器凭据: ${connectorId}`,
        signal: exec.signal,
      })
      if (!allowed) throw new Error('browser: credential injection was not approved by the user')
      const filled = await runtime.fillCredentials(tabId, connectorId.trim())
      exec.signal.throwIfAborted()
      return filled
    },
  }))
}

/** Format a credential-fill result for the model. */
function formatCredentialFill(value: unknown): string {
  const v = value as { username?: boolean; password?: boolean }
  const parts: string[] = []
  if (v.username === true) parts.push('username')
  if (v.password === true) parts.push('password')
  return parts.length > 0 ? `Filled ${parts.join(' and ')} from stored credentials (not submitted).` : 'Form fields filled (not submitted).'
}

/** Format a tab-open result for the model. */
function formatTabOpened(value: unknown): string {
  const v = value as { tab?: number; url?: string; title?: string }
  return `Opened tab ${String(v.tab ?? '')} — ${v.title !== '' ? `${String(v.title)} — ` : ''}${String(v.url ?? '')}`
}

/** Format a navigation result. */
function formatNavigation(value: unknown): string {
  const v = value as { url?: string; title?: string; loading?: boolean }
  return `Navigated to ${String(v.url ?? '')}${v.title !== undefined && v.title !== '' ? ` (${String(v.title)})` : ''}${v.loading === true ? ' [loading]' : ''}`
}

/** Format a snapshot for the model. */
function formatSnapshot(value: unknown): string {
  const v = value as { elements?: Array<{ index: number; kind: string; text: string; selector: string; visible: boolean; disabled: boolean }>; url?: string }
  const elements = v.elements ?? []
  if (elements.length === 0) {
    return `No interactable elements found${v.url !== undefined ? ` on ${String(v.url)}` : ''}.`
  }
  const lines = elements.map((e) => {
    const flags = `${e.visible ? '' : ' (off-screen)'}${e.disabled ? ' (disabled)' : ''}`
    return `${e.index}: [${e.kind}] ${e.text || '(no text)'}${flags}`
  })
  return `Interactable elements${v.url !== undefined ? ` on ${String(v.url)}` : ''}:\n${lines.join('\n')}`
}

/** Format page text. */
function formatText(value: unknown): string {
  const v = value as { text?: string; truncated?: boolean }
  const text = v.text ?? ''
  return text === '' ? '(no text)' : `${text}${v.truncated === true ? '\n…(truncated)' : ''}`
}

/** Format the tab list. */
function formatTabs(value: unknown): string {
  const v = value as { tabs?: Array<{ id: number; url: string; title: string; loading: boolean; visible: boolean }> }
  const tabs = v.tabs ?? []
  if (tabs.length === 0) return 'No tabs open.'
  return tabs.map((t) => `${t.id}: ${t.title || t.url}${t.visible ? ' (visible)' : ''}${t.loading ? ' [loading]' : ''}`).join('\n')
}

/** Format an eval result. */
function formatEval(value: unknown): string {
  const v = value as { result?: string }
  return v.result === undefined ? '(no result)' : String(v.result)
}

/** Present result meta passthrough (kept for future card projections). */
export function browserMetaFromResult(meta: unknown): JsonValue | undefined {
  return meta as JsonValue | undefined
}

/** Present call view helper exported for tests. */
export function presentBrowserCall(kind: string, title: string, args: Record<string, unknown>): GenericCallView {
  return { card: 'generic', kind: kind === 'screenshot' ? 'fetch' : 'other', title, rawInput: args }
}

export type { ToolResult }

/**
 * Model-facing `browser_*` tool suite v4 over the grouped browser runtime.
 * This module owns schemas, argument validation, prompt guidance, group
 * permission checks (every call resolves its session group; cross-group tab
 * references are rejected) and semantic presentation; execution delegates to
 * the BrowserRuntime.
 * @module @picoaide/dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { BrowserRuntime, type WaitForOptions } from './runtime.ts'
import { browserError } from './errors.ts'
import type { BrowserWaitUntil } from './types.ts'

/** Cooperative tool-call timeout budget for every browser tool (ms). */
const BROWSER_TOOL_TIMEOUT_MS = 30_000

/** Valid waitUntil values for navigation tools. */
const WAIT_UNTILS: readonly BrowserWaitUntil[] = ['domcontentloaded', 'load', 'networkidle']

const WAIT_CONDITIONS = ['element-present', 'element-visible', 'text-appear', 'url-change', 'network-idle', 'settled'] as const

/** Tool guidance band shown to the model (v4 wording). */
const BROWSER_GUIDANCE = `You have an embedded browser shared with the user. Rules:
1. Start with browser_open (url optional), then browser_navigate. browser_get_snapshot lists numbered interactable elements; target them by number or CSS selector.
2. After navigation or any page change, take a fresh snapshot — pages re-render and renumber.
3. browser_screenshot only for visual confirmation; snapshots/text are cheaper. browser_eval is READ-ONLY (single expression; assignments and write APIs are rejected).
4. The user may take over at any time (按钮: 我来操作). Your queued actions then wait; release continues them — do not fight the user.
5. Use wait_for before acting on dynamic pages (SPAs) instead of sleeping.
6. Bookmarks/history/downloads are shared with the user; save important pages with bookmarks_add; check your results via downloads_list (paths are usable by file tools).
7. Close tabs you no longer need with browser_close_tab. Tabs are GLOBAL: every session and the user share one tab pool.`

/** Resolve `target` (snapshot number or CSS selector) to a selector. */
async function resolveTarget(runtime: BrowserRuntime, tabId: number, target: number | string, signal?: AbortSignal): Promise<string> {
  if (typeof target === 'string') {
    if (target.trim() === '') throw new Error('target selector must not be empty')
    return target.trim()
  }
  if (!Number.isInteger(target) || target < 1) throw new Error('target number must be a positive integer')
  const snapshot = await runtime.snapshot(tabId, signal)
  const entry = snapshot.find((item) => item.index === target)
  if (entry === undefined) {
    throw browserError('not-found', `browser: no snapshot element ${target} — call browser_get_snapshot first (${snapshot.length} elements)`)
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

/** Snapshot the calling agent's identity (oplog attribution). */
function noteAgent(runtime: BrowserRuntime, agent: unknown): void {
  const id = (agent as { id?: string } | undefined)?.id
  runtime.setAgentContext(id)
}

/** The live agent/session shape inspected for the workspace path (defensive —
 * fields vary across DSH versions). */
interface AgentProjectInfo {
  id?: string
  session?: {
    header?: { cwd?: string }
    meta?: { cwd?: string }
    cwd?: string
  }
}

/** Upload whitelist: downloads dir (always) + the calling session's cwd. */
function uploadAllowDirs(runtime: BrowserRuntime, session: AgentProjectInfo['session']): string[] {
  const dirs = [runtime.options.downloadDir]
  const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') dirs.push(cwd.trim())
  return dirs
}

/**
 * Register the full browser tool suite (v4, 32 tools).
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param runtime - the grouped embedded browser runtime.
 */
export function applyBrowserTools(ctx: Context, runtime: BrowserRuntime, enabledGroups: ReadonlySet<string> = DEFAULT_GROUPS): void {
  // Dedicated helper so per-group enablement (enterprise policy, P2) filters
  // registrations without changing the tool definitions.
  const register = (definition: ReturnType<typeof defineTool>): void => {
    const group = GROUP_OF[definition.name] ?? 'control'
    if (enabledGroups.has(group)) ctx.tools.register(definition)
  }
  ctx.systemPrompt.section({
    name: 'tool:browser',
    order: 111,
    text: BROWSER_GUIDANCE,
  })

  const tabOf = async (tab: number | undefined): Promise<number> => {
    return runtime.resolveTab(tab)
  }

  // ----------------------------------------------------------- Navigate (8)

  register(defineTool({
    name: 'browser_open',
    description: '[导航] Open the browser (shared single tab pool) and optionally navigate a new tab to a URL. Use this as the first browser action.',
    parameters: {
      url: { type: 'string', description: 'Optional URL to open in the new tab.' },
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
      noteAgent(runtime, exec.agent)
      const tab = await runtime.open(url, exec.signal)
      exec.signal.throwIfAborted()
      return { tab: tab.id, url: tab.url, title: tab.title }
    },
  }))

  register(defineTool({
    name: 'browser_navigate',
    description: '[导航] Navigate a tab of your session to a URL (http/https only).',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
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
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      await runtime.navigate(tabId, url.trim(), waitUntil ?? 'domcontentloaded', exec.signal)
      exec.signal.throwIfAborted()
      const state = runtime.tabState(tabId)
      return { url: state.url, title: state.title, loading: state.loading }
    },
  }))

  register(defineTool({
    name: 'browser_reload',
    description: '[导航] Reload a tab of your session.',
    parameters: { tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Reloaded ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Reload page'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.reload(tabId, exec.signal)
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  register(defineTool({
    name: 'browser_go_back',
    description: '[导航] Navigate back in a tab of your session.',
    parameters: { tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Back to ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Go back'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.goBack(tabId, exec.signal)
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  register(defineTool({
    name: 'browser_go_forward',
    description: '[导航] Navigate forward in a tab of your session.',
    parameters: { tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Forward to ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Go forward'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.goForward(tabId, exec.signal)
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  register(defineTool({
    name: 'browser_list_tabs',
    description: '[导航] List ALL tabs of the shared browser pool (every session and the user share one pool) with ids, urls, titles and the active marker.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string' },
              status: { type: 'string' },
              busy: { type: 'boolean' },
              busyTool: { type: 'string' },
              foreground: { type: 'boolean' },
            },
          },
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
                active: { type: 'boolean' },
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
    async execute(_args, exec) {
      noteAgent(runtime, exec.agent)
      const tabs = runtime.listTabs()
      return {
        tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, active: t.visible })),
      }
    },
  }))

  register(defineTool({
    name: 'browser_switch_tab',
    description: '[导航] Make a tab of your session its active tab.',
    parameters: { tab: { type: 'integer', required: true, description: 'Your tab id to activate.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tab: { type: 'integer' }, url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Switched to tab ${String((value as { tab?: number }).tab ?? '')}.` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Switch tab'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = (args as { tab: number }).tab
      await runtime.switchTab(tabId, false, exec.signal)
      exec.signal.throwIfAborted()
      return { tab: tabId, url: runtime.tabState(tabId).url }
    },
  }))

  register(defineTool({
    name: 'browser_close_tab',
    description: '[导航] Close a tab of the shared pool (defaults to your active tab).',
    parameters: { tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Tab closed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Close tab'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.closeTab(tabId, false, exec.signal)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  // ---------------------------------------------------------- Interact (7)

  const interactSpecs: Array<{
    name: string
    title: string
    description: string
    run: (r: BrowserRuntime, id: number, sel: string, signal: AbortSignal | undefined, args: Record<string, unknown>) => Promise<unknown> | unknown
  }> = [
    { name: 'browser_click', title: 'Click', description: '[交互] Click an element of your tab (snapshot number or CSS selector).', run: (r, id, sel, signal) => (async () => {
      const point = await r.locateElement(id, sel, signal)
      await r.clickAt(id, point, signal)
      return { ok: true }
    })() },
    { name: 'browser_type', title: 'Type', description: '[交互] Type text into an input of your tab (snapshot number or CSS selector); clears the field first by default.', run: (r, id, sel, signal, args) => r.typeInto(id, sel, String((args as { text: string }).text), (args as { clear?: boolean }).clear !== false, signal) },
    { name: 'browser_select', title: 'Select option', description: '[交互] Select an option in a dropdown of your tab (snapshot number or CSS selector).', run: (r, id, sel, signal, args) => r.selectOption(id, sel, (args as { value: string }).value, signal) },
  ]
  for (const spec of interactSpecs) {
    register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: {
        tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
        target: { oneOf: [{ type: 'integer' }, { type: 'string' }], required: true, description: 'Snapshot element number or CSS selector.' },
        ...(spec.name === 'browser_type' ? { text: { type: 'string', required: true, description: 'The text to type (any Unicode).' }, clear: { type: 'boolean', description: 'Clear the field before typing (default true).' } } : {}),
        ...(spec.name === 'browser_select' ? { value: { type: 'string', required: true, description: 'The option value to select.' } } : {}),
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
        render: () => [{ type: 'text', text: `${spec.title}.` }],
      },
      timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      presentCall: present(spec.title),
      async execute(args, exec) {
        noteAgent(runtime, exec.agent)
        const tabId = await tabOf((args as { tab?: number }).tab)
        const selector = await resolveTarget(runtime, tabId, (args as { target: number | string }).target, exec.signal)
        await spec.run(runtime, tabId, selector, exec.signal, args)
        exec.signal.throwIfAborted()
        return { ok: true }
      },
    }))
  }

  register(defineTool({
    name: 'browser_press',
    description: '[交互] Press a key in your tab (Enter, Tab, Escape, Backspace, Delete, Arrows, Home, End, PageUp, PageDown, space).',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
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
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      await runtime.pressKey(tabId, key, exec.signal)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  register(defineTool({
    name: 'browser_scroll',
    description: '[交互] Scroll your tab by a vertical delta, or bring a snapshot element into view.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
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
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      const selector = target === undefined ? undefined : await resolveTarget(runtime, tabId, target, exec.signal)
      await runtime.scroll(tabId, deltaY ?? 0, selector, exec.signal)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  register(defineTool({
    name: 'browser_fill_form',
    description: '[交互] Fill a form of your tab by field names/labels/placeholders (batch) and optionally submit. Prefer over multiple type calls.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      fields: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: 'string', required: true, description: 'Input name/id/placeholder/aria-label or label text.' },
            value: { type: 'string', required: true, description: 'Value to fill.' },
          },
        },
      },
      submit: { type: 'boolean', description: 'Submit the enclosing form after filling (default false).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { filled: { type: 'integer' }, submitted: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: formatFillForm(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Fill form'),
    async execute(args, exec) {
      const { tab, fields, submit } = args as { tab?: number; fields: Array<{ field: string; value: string }>; submit?: boolean }
      if (!Array.isArray(fields) || fields.length === 0) throw new Error('fields must be a non-empty array')
      for (const f of fields) {
        if (typeof f?.field !== 'string' || typeof f?.value !== 'string') throw new Error('each field must have string field and value')
      }
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      return await runtime.fillForm(tabId, fields, submit === true, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_upload_file',
    description: '[交互] Upload local files through the page file input (default first input[type=file]; no dialogs). Only paths inside the downloads dir or the current workspace are allowed.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Absolute paths to upload (allowed: downloads dir + current workspace).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { uploaded: { type: 'integer' } } },
      render: (_args, value) => [{ type: 'text', text: `Uploaded ${String((value as { uploaded?: number }).uploaded ?? 0)} file(s).` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Upload file'),
    async execute(args, exec) {
      const { tab, paths } = args as { tab?: number; paths: string[] }
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be a non-empty array of absolute paths')
      const allowedDirs = uploadAllowDirs(runtime, (exec.agent as AgentProjectInfo | undefined)?.session)
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      return await runtime.uploadFile(tabId, paths, exec.signal, allowedDirs)
    },
  }))

  // -------------------------------------------------------------- Read (5)

  register(defineTool({
    name: 'browser_get_snapshot',
    description: '[读取] List the numbered interactable elements of your tab (links, buttons, inputs, selects, textareas) plus page header info (url/title). Numbers are the targets for click/type/select/scroll.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
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
          title: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Page snapshot'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      const elements = await runtime.snapshot(tabId, exec.signal)
      exec.signal.throwIfAborted()
      const state = runtime.tabState(tabId)
      return { elements, url: state.url, title: state.title }
    },
  }))

  register(defineTool({
    name: 'browser_get_text',
    description: '[读取] Extract the visible text of your tab, or of one element (CSS selector). Bounded output.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
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
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      const text = await runtime.text(tabId, selector, exec.signal)
      exec.signal.throwIfAborted()
      return { text, truncated: text.length >= runtime.options.textLimit }
    },
  }))

  register(defineTool({
    name: 'browser_screenshot',
    description: '[读取] Capture the visible page of your tab as a JPEG image. Use sparingly — snapshots and text are cheaper.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
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
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      const dataUrl = await runtime.screenshot(tabId, exec.signal)
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

  register(defineTool({
    name: 'browser_wait_for',
    description: '[读取] Wait for a page condition (element/text/url/network-idle/settled) before acting — use instead of sleeping on dynamic pages.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      condition: { type: 'string', enum: WAIT_CONDITIONS, required: true, description: 'What to wait for.' },
      selector: { type: 'string', description: 'CSS selector (element-present / element-visible).' },
      text: { type: 'string', description: 'Text to appear (text-appear).' },
      timeoutMs: { type: 'integer', description: 'Budget in ms (default 30000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: formatWait(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS + 10_000,
    isConcurrencySafe: () => false,
    presentCall: present('Wait for condition'),
    async execute(args, exec) {
      const { tab, condition, selector, text, timeoutMs } = args as { tab?: number; condition: WaitForOptions['condition']; selector?: string; text?: string; timeoutMs?: number }
      if (!WAIT_CONDITIONS.includes(condition)) throw new Error(`condition must be one of: ${WAIT_CONDITIONS.join(', ')}`)
      if ((condition === 'element-present' || condition === 'element-visible') && (selector === undefined || selector === '')) {
        throw new Error('selector is required for element conditions')
      }
      if (condition === 'text-appear' && (text === undefined || text === '')) {
        throw new Error('text is required for text-appear')
      }
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      return await runtime.waitFor(tabId, { condition, selector, text, timeoutMs }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_eval',
    description: '[读取] READ-ONLY evaluate one JavaScript expression in your tab (single expression; assignments/write APIs rejected) and return its JSON result — for non-explicit page data (SSR globals, hidden fields, datasets).',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      expression: { type: 'string', required: true, description: 'One expression (no statements/assignments). Helpers: readText(sel)/readAttr(sel,name)/readJson(sel)/readVar(path).' },
      frame: { type: 'integer', description: 'Frame index (0 = main frame, default).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: formatEval(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Evaluate JS (read-only)'),
    async execute(args, exec) {
      const { tab, expression, frame } = args as { tab?: number; expression: string; frame?: number }
      if (typeof expression !== 'string' || expression.trim() === '') throw new Error('expression is required')
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      const result = await runtime.eval(tabId, expression, frame, exec.signal)
      exec.signal.throwIfAborted()
      return { result }
    },
  }))

  // ------------------------------------------------------------- Memory (4)

  register(defineTool({
    name: 'browser_bookmarks_add',
    description: '[记忆] Bookmark a tab of your session (shared work-set; same URL is idempotent).',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      title: { type: 'string', description: 'Optional custom title.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' }, url: { type: 'string' }, title: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Bookmarked ${String((value as { title?: string }).title ?? '')} (${String((value as { url?: string }).url ?? '')})` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Bookmark page'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      return runtime.addBookmark(tabId, (args as { title?: string }).title)
    },
  }))

  register(defineTool({
    name: 'browser_bookmarks_list',
    description: '[记忆] List bookmarks (shared with the user), newest first.',
    parameters: {
      q: { type: 'string', description: 'Search text in url/title.' },
      limit: { type: 'integer', description: 'Max entries (default 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bookmarks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                url: { type: 'string' },
                title: { type: 'string' },
                createdAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatBookmarks(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('List bookmarks'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const { q, limit } = args as { q?: string; limit?: number }
      return { bookmarks: runtime.listBookmarks({ q, limit }).map((b) => ({ id: b.id, url: b.url, title: b.title, createdAt: b.createdAt })) }
    },
  }))

  register(defineTool({
    name: 'browser_bookmarks_remove',
    description: '[记忆] Remove a bookmark by id.',
    parameters: { id: { type: 'integer', required: true, description: 'Bookmark id from browser_bookmarks_list.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: (value as { ok?: boolean }).ok === true ? 'Bookmark removed.' : 'Bookmark not found.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Remove bookmark'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      return { ok: runtime.removeBookmark((args as { id: number }).id) }
    },
  }))

  register(defineTool({
    name: 'browser_history_search',
    description: '[记忆] Search the shared visit history (your session + the user\'s), newest first.',
    parameters: {
      q: { type: 'string', description: 'Search text in url/title.' },
      group: { type: 'string', description: 'Optional session group label/key filter.' },
      limit: { type: 'integer', description: 'Max entries (default 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'integer' },
                url: { type: 'string' },
                title: { type: 'string' },
                actor: { type: 'string' },
                group: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatHistory(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('Search history'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const { q, limit, group } = args as { q?: string; limit?: number; group?: string }
      return { entries: runtime.history({ q, limit, group }).map((h) => ({ time: h.time, url: h.url, title: h.title, actor: h.actor, group: h.group })) }
    },
  }))

  // ----------------------------------------------------------- Artifacts (3)

  register(defineTool({
    name: 'browser_download',
    description: '[产物] Trigger a download of a URL through your session (saved to the programmatic downloads dir; no dialogs).',
    parameters: {
      url: { type: 'string', required: true, description: 'Direct download URL.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { started: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Download started (see downloads_list for progress).' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Download file'),
    async execute(args, exec) {
      const { url } = args as { url: string }
      if (typeof url !== 'string' || url.trim() === '') throw new Error('url is required')
      noteAgent(runtime, exec.agent)
      await runtime.downloadUrl(url.trim(), exec.signal)
      exec.signal.throwIfAborted()
      return { started: true }
    },
  }))

  register(defineTool({
    name: 'browser_downloads_list',
    description: '[产物] List downloads (shared) with paths usable by file tools; newest first.',
    parameters: {
      status: { type: 'string', enum: ['in-progress', 'done', 'cancelled', 'rejected'], description: 'Filter by status.' },
      limit: { type: 'integer', description: 'Max entries (default 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          downloads: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                url: { type: 'string' },
                fileName: { type: 'string' },
                path: { type: 'string' },
                size: { type: 'integer' },
                status: { type: 'string' },
                createdAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatDownloads(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('List downloads'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const { status, limit } = args as { status?: 'in-progress' | 'done' | 'cancelled' | 'rejected'; limit?: number }
      return { downloads: runtime.downloads({ status, limit }).map((d) => ({ id: d.id, url: d.url, fileName: d.fileName, path: d.path, size: d.size, status: d.status, createdAt: d.createdAt })) }
    },
  }))

  register(defineTool({
    name: 'browser_downloads_remove',
    description: '[产物] Remove a download record by id.',
    parameters: { id: { type: 'integer', required: true, description: 'Download id from downloads_list.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Download record removed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Remove download'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      return { ok: runtime.removeDownload((args as { id: number }).id) }
    },
  }))

  // ------------------------------------------------------------- Control (5)

  register(defineTool({
    name: 'browser_takeover',
    description: '[控制] Hand control to the user (pauses ALL browser actions until release). Usually the user clicks 我来操作; this tool exists for guided flows.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Control handed to the user.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Hand control to user'),
    async execute(_args, exec) {
      noteAgent(runtime, exec.agent)
      runtime.setUserControl(true, 'ai')
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  register(defineTool({
    name: 'browser_release',
    description: '[控制] Release control back to the session (resumes queued actions).',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Control released.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Release control'),
    async execute(_args, exec) {
      noteAgent(runtime, exec.agent)
      runtime.setUserControl(false, 'ai')
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  register(defineTool({
    name: 'browser_fill_credentials',
    description: '[控制] Fill the login form of your tab with credentials stored for a connector (shown to the user; never submitted automatically).',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
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
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      return await runtime.fillCredentials(tabId, connectorId.trim(), exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_credentials_list',
    description: '[控制] List available stored credentials (connector id + username only; never secrets).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          credentials: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatCredentials(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('List credentials'),
    async execute(_args, exec) {
      noteAgent(runtime, exec.agent)
      const list = await runtime.credentialsList()
      return { credentials: list }
    },
  }))

  register(defineTool({
    name: 'browser_clear_data',
    description: '[控制] Clear site data (storage/cache) for your tabs. Clearing EVERYTHING incl. cookies (all-data) requires the user to confirm in the browser window menu — the tool refuses it.',
    parameters: {
      scope: { type: 'string', enum: ['group', 'all-data'], description: 'What to clear (default group).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Browsing data cleared.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Clear browsing data'),
    async execute(args, exec) {
      const scope = (args as { scope?: string }).scope
      if (scope === 'all-data') {
        // Design §7.3-4: all-data needs the USER's shell confirmation — the
        // tool surface refuses; users clear everything via the browser menu.
        throw browserError('policy', 'browser: clear_data all-data requires a user confirmation in the browser window menu — use the ⋮ menu → 清除数据')
      }
      noteAgent(runtime, exec.agent)
      await runtime.clearData(false)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))
}

// ------------------------------------------------------------------ formats

function formatCredentialFill(value: unknown): string {
  const v = value as { username?: boolean; password?: boolean }
  const parts: string[] = []
  if (v.username === true) parts.push('username')
  if (v.password === true) parts.push('password')
  return parts.length > 0 ? `Filled ${parts.join(' and ')} from stored credentials (not submitted).` : 'Form fields filled (not submitted).'
}

function formatTabOpened(value: unknown): string {
  const v = value as { tab?: number; url?: string; title?: string }
  return `Opened tab ${String(v.tab ?? '')} — ${v.title !== '' ? `${String(v.title)} — ` : ''}${String(v.url ?? '')}`
}

function formatNavigation(value: unknown): string {
  const v = value as { url?: string; title?: string; loading?: boolean }
  return `Navigated to ${String(v.url ?? '')}${v.title !== undefined && v.title !== '' ? ` (${String(v.title)})` : ''}${v.loading === true ? ' [loading]' : ''}`
}

function formatSnapshot(value: unknown): string {
  const v = value as { elements?: Array<{ index: number; kind: string; text: string; selector: string; visible: boolean; disabled: boolean }>; url?: string; title?: string }
  const elements = v.elements ?? []
  const header = [v.title !== undefined && v.title !== '' ? String(v.title) : '', v.url !== undefined ? String(v.url) : ''].filter(Boolean).join(' · ')
  const head = header === '' ? '' : `Page: ${header}\n`
  if (elements.length === 0) {
    return `${head}No interactable elements found.`
  }
  const lines = elements.map((e) => {
    const flags = `${e.visible ? '' : ' (off-screen)'}${e.disabled ? ' (disabled)' : ''}`
    return `${e.index}: [${e.kind}] ${e.text || '(no text)'}${flags}`
  })
  return `${head}Interactable elements:\n${lines.join('\n')}`
}

function formatText(value: unknown): string {
  const v = value as { text?: string; truncated?: boolean }
  const text = v.text ?? ''
  return text === '' ? '(no text)' : `${text}${v.truncated === true ? '\n…(truncated)' : ''}`
}

function formatTabs(value: unknown): string {
  const v = value as { group?: { label?: string; status?: string; busy?: boolean; busyTool?: string; foreground?: boolean }; tabs?: Array<{ id: number; url: string; title: string; loading: boolean; active: boolean }> }
  const tabs = v.tabs ?? []
  const group = v.group
  if (tabs.length === 0) return 'No tabs open in this session.'
  const head = group !== undefined
    ? `Session "${String(group.label ?? '')}" (${String(group.status ?? '')}${group.busy === true ? `, running ${String(group.busyTool ?? '')}` : ''}${group.foreground === true ? ', shown in window' : ''})\n`
    : ''
  return head + tabs.map((t) => `${t.id}: ${t.title || t.url}${t.active ? ' (active)' : ''}${t.loading ? ' [loading]' : ''}`).join('\n')
}

function formatFillForm(value: unknown): string {
  const v = value as { filled?: number; submitted?: boolean }
  return `Filled ${String(v.filled ?? 0)} field(s)${v.submitted === true ? ' and submitted the form' : ''}.`
}

function formatWait(value: unknown): string {
  const v = value as { ok?: boolean; reason?: string }
  return v.ok === true
    ? 'Condition met.'
    : `Condition NOT met: ${String(v.reason ?? '')}`
}

function formatEval(value: unknown): string {
  const v = value as { result?: string }
  return v.result === undefined ? '(no result)' : String(v.result)
}

function formatBookmarks(value: unknown): string {
  const v = value as { bookmarks?: Array<{ id: number; url: string; title: string; createdAt: number }> }
  const items = v.bookmarks ?? []
  if (items.length === 0) return 'No bookmarks.'
  return items.map((b) => `${b.id}: ${b.title} — ${b.url}`).join('\n')
}

function formatHistory(value: unknown): string {
  const v = value as { entries?: Array<{ time: number; url: string; title: string; actor: string; group: string }> }
  const items = v.entries ?? []
  if (items.length === 0) return 'No history entries.'
  return items.map((h) => `${new Date(h.time).toLocaleString()} [${h.actor}] ${h.title || h.url} — ${h.url}`).join('\n')
}

function formatDownloads(value: unknown): string {
  const v = value as { downloads?: Array<{ id: number; url: string; fileName: string; path: string; size: number; status: string; createdAt: number }> }
  const items = v.downloads ?? []
  if (items.length === 0) return 'No downloads.'
  return items.map((d) => `${d.id}: ${d.fileName} (${d.status}) ${d.path || ''}`).join('\n')
}

function formatCredentials(value: unknown): string {
  const v = value as { credentials?: Array<{ id: string; username?: string }> }
  const items = v.credentials ?? []
  if (items.length === 0) return 'No stored credentials.'
  return items.map((c) => `${c.id}${c.username !== undefined ? ` (${c.username})` : ''}`).join('\n')
}

/** Tool → group map used by the enterprise toolGroups policy (P2 §15). */
const GROUP_OF: Record<string, 'navigate' | 'interact' | 'read' | 'memory' | 'artifacts' | 'control'> = {
  browser_open: 'navigate', browser_navigate: 'navigate', browser_reload: 'navigate',
  browser_go_back: 'navigate', browser_go_forward: 'navigate', browser_list_tabs: 'navigate',
  browser_switch_tab: 'navigate', browser_close_tab: 'navigate',
  browser_click: 'interact', browser_type: 'interact', browser_press: 'interact',
  browser_select: 'interact', browser_scroll: 'interact', browser_fill_form: 'interact',
  browser_upload_file: 'interact',
  browser_get_snapshot: 'read', browser_get_text: 'read', browser_screenshot: 'read',
  browser_wait_for: 'read', browser_eval: 'read',
  browser_bookmarks_add: 'memory', browser_bookmarks_list: 'memory',
  browser_bookmarks_remove: 'memory', browser_history_search: 'memory',
  browser_download: 'artifacts', browser_downloads_list: 'artifacts', browser_downloads_remove: 'artifacts',
  browser_takeover: 'control', browser_release: 'control', browser_fill_credentials: 'control',
  browser_clear_data: 'control', browser_credentials_list: 'control',
}

/** Default: every tool group enabled. */
export const DEFAULT_GROUPS: ReadonlySet<string> = new Set(['navigate', 'interact', 'read', 'memory', 'artifacts', 'control'])

/** Parse a toolGroups config value into a set (unknown values ignored). */
export function parseToolGroups(value: string[] | undefined): ReadonlySet<string> {
  if (value === undefined) return DEFAULT_GROUPS
  const allowed = new Set(['navigate', 'interact', 'read', 'memory', 'artifacts', 'control'])
  const set = new Set<string>()
  for (const item of value) if (allowed.has(item)) set.add(item)
  return set.size === 0 ? DEFAULT_GROUPS : set
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

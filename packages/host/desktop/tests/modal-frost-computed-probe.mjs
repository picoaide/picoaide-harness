/**
 * 左栏毛玻璃修复（issue #128 D2）的**真实 CSS 引擎**判据。
 *
 * 本包 vitest 是 Node 环境、故意不装 jsdom（`advanced-shell.spec.ts` 里有记录），
 * 所以「构造带 role="dialog" aria-modal="true" 的 DOM 之后，左栏的计算样式不再是透明」
 * 只能在真 Chromium 里量。这个探针就是那条判据：
 *
 *   node packages/host/desktop/tests/modal-frost-computed-probe.mjs
 *   node packages/host/desktop/tests/modal-frost-computed-probe.mjs --mutate=drop-rule
 *
 * 页面里放的都是**真家伙**：上游 design-platform.css 的 token、上游
 * SidebarRoot.module.css 的 .root（它会读 --dsw-specific-sidebar-fill）、上游
 * SettingsRoot.module.css 的 .mask 声明（backdrop-filter 的宿主），以及由生产函数
 * installAdvancedStyles() 现场产出的我们那张样式表。没有 Xvfb 时自动套 xvfb-run。
 *
 * 判据（任一不成立即非零退出）：
 *   1. 该 Chromium 支持 :has()（选择器能力）；
 *   2. 无模态时：规则不命中、左栏仍是透明（原生材质照旧透出）；
 *   3. 模态存在时：规则命中、表面背景与变量都 alpha=1，且**与对话列同色**（两侧一致）；
 *   4. 上游 .root（真正读那个变量的消费者）也随之不透明；
 *   5. 内联 alertdialog（无整视口蒙版）不触发——不许无缘无故关掉原生材质；
 *   6. **暗色主题**下重跑 2–4：亮色下 `--dsw-alias-bg-layer-2` 与 `--dsw-alias-bg-base`
 *      同色，"换成另一个不透明的 token"能逃逸；暗色下二者是 rgb(44,44,46) vs
 *      rgb(21,21,23)，只有"与会话列同源"才拦得住（2026-09-23 审计 M4）；
 *   7. 前提钉子：上游 `.mask` 仍带 `backdrop-filter: var(--dsw-mask-blur)`。
 *
 * `--mutate=<kind>` 反向验证：把修复改坏后，上面某几条必须变红（打印 DETECTED）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..', '..', '..')
const UPSTREAM = join(workspaceRoot, 'deepseek-harness', 'packages', 'client')
const PLATFORM_CSS = join(UPSTREAM, 'ui-theme', 'src', 'styles', 'design-platform.css')
const SIDEBAR_ROOT_CSS = join(UPSTREAM, 'ui-sidebar', 'src', 'client', 'SidebarRoot.module.css')
const SETTINGS_ROOT_CSS = join(UPSTREAM, 'ui-settings-general', 'src', 'client', 'SettingsRoot.module.css')
const APP_ENTRY = join(here, 'modal-frost-probe-app.mjs')

/** 修复规则的选择器（与 tests/modal-frost-sidebar.spec.ts 同一份判据）。 */
const SELECTOR = 'html:has([role="dialog"][aria-modal="true"]) .dshDesktopSidebarSurface'

const mutation = (process.argv.find(argument => argument.startsWith('--mutate=')) ?? '').slice('--mutate='.length)

/** 现场跑生产函数，拿到真正会被注入的那张样式表。 */
async function injectedStyles() {
  const style = { dataset: {}, textContent: '', remove() {} }
  const previous = globalThis.document
  globalThis.document = { createElement: () => style, head: { appendChild() {} } }
  try {
    const module = await import(new URL('../src/client/styles.ts', import.meta.url).href)
    module.installAdvancedStyles()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
  return style.textContent
}

/** 切出一条规则（选择器与 { 之间只允许空白）。 */
function ruleSpan(css, selector) {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`probe: missing rule ${selector}`)
  const open = css.indexOf('{', start + selector.length)
  if (open < 0 || !/^\s*$/u.test(css.slice(start + selector.length, open))) {
    throw new Error(`probe: ambiguous rule ${selector}`)
  }
  const close = css.indexOf('}', open)
  return [start, close + 1]
}

/** 取上游某个 CSS-module 类的声明体（hash 由打包器加，文件里就是裸类名）。 */
function upstreamDeclarations(css, selector) {
  const [start, end] = ruleSpan(css.replace(/\/\*[\s\S]*?\*\//gu, ''), selector)
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, '').slice(start, end)
  return text.slice(text.indexOf('{') + 1, -1).trim()
}

/** 只改修复规则内部，避免误伤别的规则（变异必须精准）。 */
function mutateRule(css, edit) {
  const [start, end] = ruleSpan(css, SELECTOR)
  return css.slice(0, start) + edit(css.slice(start, end)) + css.slice(end)
}

const MUTATIONS = {
  'drop-rule': css => mutateRule(css, () => ''),
  'background-transparent': css => mutateRule(css, rule => rule.replace(/background:[^;]+;/u, 'background: transparent;')),
  'drop-var': css => mutateRule(css, rule => rule.replace(/--dsw-specific-sidebar-fill:[^;]+;/u, '')),
  // 审计 M4：换成同样不透明、只是不同色的 token。亮色下与会话列同色 ⇒ 只有暗色场景能抓。
  'layer-2-token': css => mutateRule(css, rule => rule.replace(/var\(--dsw-alias-bg-base\)/gu, 'var(--dsw-alias-bg-layer-2)')),
}

const EXPECTED_MUTATION_RED = {
  // 注意 `modal-selector-matches` 是**能力判据**（Element.matches 只看 DOM，与样式表无关）：
  // 删掉规则它照样是绿的，所以它不进任何变异期望。
  'drop-rule': [
    'open-opaque-surface', 'open-opaque-var', 'open-matches-conversation', 'open-root-fill',
    'dark-open-opaque-surface', 'dark-open-matches-conversation', 'dark-open-root-fill',
  ],
  'background-transparent': ['open-opaque-surface', 'open-matches-conversation', 'dark-open-opaque-surface'],
  'drop-var': ['open-opaque-var', 'open-root-fill', 'dark-open-opaque-var', 'dark-open-root-fill'],
  'layer-2-token': ['dark-open-matches-conversation'],
}

/** 与 spec 里同一套 alpha 判定（解析失败一律抛，不许静默通过）。 */
function alpha(value) {
  const text = String(value).trim().toLowerCase()
  if (text === 'transparent' || text === 'rgba(0, 0, 0, 0)') return 0
  if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/u.test(text)) {
    return text.length === 9 ? Number.parseInt(text.slice(7), 16) / 255 : 1
  }
  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/u.exec(text)
  if (fn !== null) return fn[4] === undefined ? 1 : Number(fn[4])
  if (text === '') return 0
  throw new Error(`probe: unsupported color ${value}`)
}

/** 把真声明套到探针页的元素上（只换宿主选择器，声明逐字保留）。 */
function readMaskDeclarations() {
  return readFile(SETTINGS_ROOT_CSS, 'utf8').then(css => upstreamDeclarations(css, '.mask'))
}

/** 上游蒙版是否仍是"半透明底 + backdrop-filter: var(--dsw-mask-blur)"（修复赖以成立的前提）。 */
function maskStillBlurs(mask) {
  return /backdrop-filter\s*:\s*var\(--dsw-mask-blur\)/u.test(mask)
}

const MODAL_MARKUP = '<div role="presentation"><div id="probe-mask"></div>'
  + '<div role="dialog" aria-modal="true">settings</div></div>'

async function buildPage(styles, mask) {
  const [tokens, sidebarRoot] = await Promise.all([
    readFile(PLATFORM_CSS, 'utf8'),
    readFile(SIDEBAR_ROOT_CSS, 'utf8'),
  ])
  const guard = text => text.replace(/<\/style/giu, '<\\/style')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>${guard(tokens)}</style>
<style>${guard(sidebarRoot)}</style>
<style>#probe-mask { ${guard(mask)} }</style>
<style>${guard(styles)}</style>
</head><body>
<div class="dshDesktopFrame" data-desktop-platform="darwin">
  <aside class="dshDesktopSidebarSurface">
    <div class="dshDesktopUpstreamSidebar">
      <div class="root" id="probe-sidebar-root">nav</div>
    </div>
  </aside>
  <div class="dshDesktopConversationSurface" id="probe-conversation">chat</div>
</div>
<div id="probe-modal-host"></div>
<script>
  var SELECTOR = ${JSON.stringify(SELECTOR)}
  function measure() {
    var surface = document.querySelector('.dshDesktopSidebarSurface')
    var root = document.getElementById('probe-sidebar-root')
    var conversation = document.getElementById('probe-conversation')
    var computed = getComputedStyle(surface)
    return {
      match: surface.matches(SELECTOR),
      surfaceBackground: computed.backgroundColor,
      surfaceFillVar: computed.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      rootBackground: getComputedStyle(root).backgroundColor,
      conversationBackground: getComputedStyle(conversation).backgroundColor,
    }
  }
  var host = document.getElementById('probe-modal-host')
  var result = { supportsHas: CSS.supports('selector(html:has([aria-modal="true"]))') }
  result.closed = measure()
  // 上游设置弹窗的真实形状：整视口蒙版（真 .mask 声明）+ role=dialog/aria-modal 面板。
  host.innerHTML = ${JSON.stringify(MODAL_MARKUP)}
  result.open = measure()
  // 面板内的内联确认块（role=alertdialog + aria-modal，但没有整视口蒙版）。
  host.innerHTML = '<div role="alertdialog" aria-modal="true">confirm</div>'
  result.alertOnly = measure()
  // 暗色主题：同样的场景再量一遍。亮色下 bg-base 与 bg-layer-2 同色，"换成另一个不透明的
  // token"能逃逸；暗色下二者不同色，只有"与会话列同源"才拦得住（审计 M4）。
  host.innerHTML = ''
  document.body.setAttribute('data-ds-dark-theme', '')
  result.darkClosed = measure()
  host.innerHTML = ${JSON.stringify(MODAL_MARKUP)}
  result.darkOpen = measure()
  // 关闭模态后必须回到透明（暗色下再验一次"原生材质照旧透出"）。
  host.innerHTML = ''
  result.darkClosedAgain = measure()
  window.__PROBE__ = result
</script>
</body></html>`
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('probe: timed out')) }, 60_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function main() {
  const require = createRequire(import.meta.url)
  const electron = require('electron')
  let styles = await injectedStyles()
  if (mutation !== '') {
    const edit = MUTATIONS[mutation]
    if (edit === undefined) throw new Error(`probe: unknown mutation ${mutation}`)
    styles = edit(styles)
  }
  const directory = await mkdtemp(join(tmpdir(), 'modal-frost-'))
  const page = join(directory, 'probe.html')
  const mask = await readMaskDeclarations()
  await writeFile(page, await buildPage(styles, mask))
  process.stdout.write(`probe page: ${page}\n`)

  const headless = process.env.DISPLAY === undefined || process.env.DISPLAY === ''
  // --no-sandbox 必须是**真实 argv**：root 下 Electron 在进入 JS 之前就 FATAL 了，
  // app.commandLine.appendSwitch 来不及。
  const [command, args] = headless
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', electron, APP_ENTRY, page, '--no-sandbox']]
    : [electron, [APP_ENTRY, page, '--no-sandbox']]
  const { code, stdout, stderr } = await run(command, args, {
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  })
  if (stderr.trim() !== '') process.stderr.write(`${stderr}\n`)
  process.stdout.write(stdout)
  const line = stdout.split('\n').find(entry => entry.startsWith('PROBE_RESULT '))
  if (line === undefined) throw new Error(`probe: no result (exit ${code})`)

  const measured = JSON.parse(line.slice('PROBE_RESULT '.length))
  const checks = {
    'has-support': measured.supportsHas === true,
    'closed-matched': measured.closed.match === false,
    'closed-transparent': alpha(measured.closed.surfaceBackground) === 0
      && measured.closed.surfaceFillVar === 'transparent',
    // 能力判据：这条选择器在真 Chromium 里能被 :has() 正确匹配到真实模态 DOM。
    // 它证明的是"触发条件成立"，不是"规则存在"（Element.matches 与样式表无关）。
    'modal-selector-matches': measured.open.match === true,
    'open-opaque-surface': alpha(measured.open.surfaceBackground) === 1,
    'open-opaque-var': alpha(measured.open.surfaceFillVar) === 1,
    'open-matches-conversation': measured.open.surfaceBackground === measured.open.conversationBackground,
    'open-root-fill': alpha(measured.open.rootBackground) === 1,
    'alertdialog-ignored': measured.alertOnly.match === false
      && alpha(measured.alertOnly.surfaceBackground) === 0,
    // 暗色场景（审计 D4/M4）。反空转：先证明暗色主题真的生效（会话列换色了），
    // 否则下面的"相等"可能只是两套主题解析出同一个值。
    'dark-theme-is-real': alpha(measured.darkOpen.conversationBackground) === 1
      && measured.darkOpen.conversationBackground !== measured.open.conversationBackground,
    'dark-closed-transparent': alpha(measured.darkClosed.surfaceBackground) === 0
      && measured.darkClosed.surfaceFillVar === 'transparent',
    'dark-open-opaque-surface': alpha(measured.darkOpen.surfaceBackground) === 1,
    'dark-open-opaque-var': alpha(measured.darkOpen.surfaceFillVar) === 1,
    // 关键一条：暗色下"同样不透明但不同色"的 token 会在这里露馅（M4）。
    'dark-open-matches-conversation': measured.darkOpen.surfaceBackground === measured.darkOpen.conversationBackground,
    'dark-open-root-fill': alpha(measured.darkOpen.rootBackground) === 1,
    'dark-closed-again-transparent': alpha(measured.darkClosedAgain.surfaceBackground) === 0
      && alpha(measured.darkClosedAgain.surfaceFillVar) === 0
      && measured.darkClosedAgain.match === false,
    // 前提钉子（审计 D4）：上游 .mask 必须仍是"半透明压暗 + backdrop-filter: var(--dsw-mask-blur)"。
    // 上游哪天不再模糊蒙版，本规则修的东西就不存在了，必须有人回来重读这条判据。
    'mask-still-blurs': maskStillBlurs(mask),
  }
  const red = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
  process.stdout.write(`MEASURED ${JSON.stringify(measured)}\n`)
  process.stdout.write(`CHECKS ${JSON.stringify(checks)}\n`)

  if (mutation === '') {
    if (red.length > 0) {
      process.stdout.write(`FIX-PROBE RED: ${red.join(', ')}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`FIX-PROBE GREEN: ${Object.keys(checks).length}/${Object.keys(checks).length}\n`)
    return
  }
  const expected = EXPECTED_MUTATION_RED[mutation]
  const missing = expected.filter(name => !red.includes(name))
  if (missing.length > 0) {
    process.stdout.write(`MUTATION ${mutation}: NOT DETECTED (still green: ${missing.join(', ')})\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`MUTATION ${mutation}: DETECTED (red: ${expected.join(', ')})\n`)
}

await main()

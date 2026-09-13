/**
 * Real-machine harness for the embedded browser (R-1…R-4, 2026-09-13).
 *
 * Runs the ACTUAL `src/runtime.ts` + `src/electron-adapter.ts` + the real
 * `browser_*` tool registrations inside a real Electron main process, against
 * real loopback pages, over real CDP. Nothing here is a mock: a fake transport
 * cannot show that `Page.getFrameTree` omits a cross-origin iframe, that
 * `Target.setAutoAttach` hands out a usable flat session, or that a fetch
 * really does leave the renderer.
 *
 * Run (from packages/host/browser):
 *   NODE_OPTIONS=--experimental-transform-types \
 *   xvfb-run -a node_modules/electron/dist/electron --no-sandbox \
 *     tests/probes/<probe>.mjs
 *
 * `--experimental-transform-types` is required: the sources use TypeScript
 * parameter properties, which Node's strip-only mode rejects.
 */
import * as electron from 'electron'
import { app, BrowserWindow } from 'electron'
import http from 'node:http'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Repo-relative root of the browser package (probes live in tests/probes). */
export const PACKAGE_ROOT = new URL('../../../', import.meta.url).pathname

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Load the real modules under Electron's Node (type-transform enabled). */
export async function loadBrowserModules() {
  const [runtime, adapter, store, tools] = await Promise.all([
    import('../../../src/runtime.ts'),
    import('../../../src/electron-adapter.ts'),
    import('../../../src/store.ts'),
    import('../../../src/tools.ts'),
  ])
  return { BrowserRuntime: runtime.BrowserRuntime, createRealElectronAdapter: adapter.createRealElectronAdapter, BrowserStore: store.BrowserStore, applyBrowserTools: tools.applyBrowserTools }
}

/** Static HTTP server; `routes` maps a path to an HTML body (or a handler). */
export async function serve(routes) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, method: req.method })
    const path = (req.url ?? '').split('?')[0]
    const prefixKey = Object.keys(routes).find((key) => key.endsWith('*') && path.startsWith(key.slice(0, -1)))
    const route = routes[req.url] ?? (prefixKey === undefined ? undefined : routes[prefixKey]) ?? routes['*']
    if (typeof route === 'function') {
      route(req, res)
      return
    }
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const body = String(route)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, origin: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() }
}

/**
 * Build a real runtime over the real Electron adapter, plus the real tool
 * suite registered into a minimal `tools` registry (the same seam the plugin
 * uses), so probes can assert on the exact model-facing return values.
 */
export async function makeRealRuntime({ credentials, workDir } = {}) {
  const { BrowserRuntime, createRealElectronAdapter, BrowserStore, applyBrowserTools } = await loadBrowserModules()
  const dir = workDir ?? join(PACKAGE_ROOT, 'node_modules', '.probe', `store-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  // The real adapter lazily `require('electron')`s; under the probe's ESM loader
  // `require` does not exist, so hand it the module explicitly (same object).
  const adapter = createRealElectronAdapter(electron)
  const store = new BrowserStore({ dir })
  // Keep downloads inside the disposable probe dir: the default
  // `.picoaide-downloads` would litter the package checkout.
  const downloads = join(dir, 'downloads')
  mkdirSync(downloads, { recursive: true })
  const runtime = new BrowserRuntime(adapter, { downloadDir: downloads }, credentials, undefined, { store })
  const tools = new Map()
  // Captured images: `browser_screenshot` stores its JPEG through the
  // attachment service, which is exactly what the model receives. The probe
  // keeps the bytes so it can decode the model-facing exit instead of a
  // side channel (a screenshot the model never got proves nothing).
  const images = []
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
    attachments: {
      saveImages: async (items) => items.map((item) => {
        images.push(item)
        return { attachmentId: `probe-image-${images.length - 1}`, mediaType: item.mediaType, bytes: item.data.byteLength, name: item.name }
      }),
    },
  }
  applyBrowserTools(ctx, runtime)
  return {
    runtime,
    tools,
    store,
    dir,
    images,
    /** The last captured image as a `data:` URL (JPEG), or null. */
    lastImageDataUrl() {
      const last = images.at(-1)
      if (last === undefined) return null
      return `data:${last.mediaType};base64,${Buffer.from(last.data).toString('base64')}`
    },
    async call(name, args = {}, exec = { signal: new AbortController().signal, agent: undefined }) {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`probe: no tool ${name}`)
      return await tool.execute(args, exec)
    },
    dispose() {
      try { runtime.dispose() } catch { /* teardown */ }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}

/** Assertion recorder: results are written to `PROBE_OUT` as JSON. */
export function createRecorder() {
  const results = []
  return {
    results,
    /** `pass` is the property that must hold (green); `detail` is evidence. */
    record(name, pass, detail) {
      results.push({ name, pass: pass === true, detail })
      return pass === true
    },
    write(outPath, extra = {}) {
      const out = process.env['PROBE_OUT'] ?? outPath
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify({ results, ...extra }, null, 2))
      return out
    },
  }
}

/** Wait until `probe()` returns a truthy value (or throw). */
export async function waitFor(probe, { timeoutMs = 15000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`probe: ${label} not met within ${timeoutMs}ms`)
    await sleep(intervalMs)
  }
}

/** Boilerplate: run `main()` once Electron is ready, then exit. */
export function runProbe(main) {
  app.commandLine.appendSwitch('no-sandbox')
  // A probe that closes its scratch window must not take the app down with it:
  // Electron's default `window-all-closed` handler quits, which destroyed the
  // views created afterwards ("Object has been destroyed").
  app.on('window-all-closed', () => {})
  app.whenReady().then(async () => {
    try {
      const code = await main()
      app.exit(code ?? 0)
    } catch (error) {
      console.error('PROBE_ERROR', (error && error.stack) || error)
      app.exit(3)
    }
  })
}

export { BrowserWindow, existsSync }

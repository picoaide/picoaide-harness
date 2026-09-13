/**
 * Real Electron + real CDP probe: what does the frame index actually see on a
 * page that mixes a CROSS-ORIGIN (OOPIF) iframe with a same-process iframe?
 * Writes evidence JSON; used to design/verify the frame-index fail-loud fix.
 * Usage: xvfb-run -a <electron> --no-sandbox tests/probes/oopif-probe.mjs <out.json>
 */
import { app, BrowserWindow } from 'electron'
import http from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const outPath = process.env.PROBE_OUT ?? '/tmp/oopif-probe.json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const innerHtml = `<!doctype html><html><body><h1>inner</h1><input id="cc" type="password" placeholder="CVC"><script>window.__PAY__={provider:"acme-pay"};</script></body></html>`
const innerHits = []
const innerSrv = http.createServer((req, res) => {
  innerHits.push(req.url)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(innerHtml) })
  res.end(innerHtml)
})

app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  await new Promise((r) => innerSrv.listen(0, '127.0.0.1', r))
  const innerPort = innerSrv.address().port
  // cross-origin (localhost vs 127.0.0.1) FIRST, same-process srcdoc SECOND.
  const outerHtml = `<!doctype html><html><body><h1>Checkout</h1>
<iframe id="pay" src="http://localhost:${innerPort}/pay" width="300" height="80"></iframe>
<iframe id="same" srcdoc="<p id='sp'>same-process</p><script>window.__SAME__=1;</script>" width="300" height="80"></iframe>
</body></html>`
  const outerSrv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(outerHtml) })
    res.end(outerHtml)
  })
  await new Promise((r) => outerSrv.listen(0, '127.0.0.1', r))
  const outerPort = outerSrv.address().port

  const win = new BrowserWindow({ show: false, width: 900, height: 600 })
  await win.loadURL(`http://127.0.0.1:${outerPort}/`)
  await sleep(2500)

  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const out = { innerPort, outerPort, innerHits, steps: {} }
  const send = (m, p, sessionId) => (sessionId === undefined ? dbg.sendCommand(m, p) : dbg.sendCommand(m, p, sessionId))

  // 1. DOM order of frame owners in the main document.
  const dom = await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('iframe,frame')].map(f=>({id:f.id, src:f.getAttribute('src'), srcdoc:f.hasAttribute('srcdoc')}))`,
    returnByValue: true,
  })
  out.steps.domFrameOwners = dom.result?.value

  // 2. Page.getFrameTree
  await send('Page.enable', {})
  await sleep(300)
  const tree = await send('Page.getFrameTree')
  const frames = []
  const walk = (n, depth, parent) => {
    if (n.frame?.id) frames.push({ depth, parent, id: n.frame.id, url: n.frame.url, mime: n.frame.mimeType })
    for (const c of n.childFrames || []) walk(c, depth + 1, n.frame?.id)
  }
  walk(tree.frameTree, 0, null)
  out.steps.frameTree = frames

  // 3. default-world execution contexts
  const contexts = []
  const listener = (_e, method, params) => {
    if (method === 'Runtime.executionContextCreated' && params?.context) contexts.push({ id: params.context.id, frameId: params.context.auxData?.frameId, isDefault: params.context.auxData?.isDefault === true, origin: params.context.origin })
    if (method === 'Target.attachedToTarget') out.steps.attached = [...(out.steps.attached ?? []), { sessionId: params.sessionId, type: params.targetInfo?.type, url: params.targetInfo?.url }]
    if (method === 'Target.detachedFromTarget') out.steps.detached = [...(out.steps.detached ?? []), params.sessionId]
  }
  dbg.on('message', listener)
  await send('Runtime.enable', {})
  await sleep(700)
  out.steps.contexts = contexts

  // 4. can we auto-attach to OOPIF targets (flat sessions)?
  for (const params of [
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
  ]) {
    try {
      const r = await send('Target.setAutoAttach', params)
      out.steps[`setAutoAttach:${JSON.stringify(params)}`] = { ok: true, r }
    } catch (e) {
      out.steps[`setAutoAttach:${JSON.stringify(params)}`] = { ok: false, error: String(e?.message ?? e) }
    }
    await sleep(800)
  }

  // 5. if a flat session exists, try to evaluate inside the OOPIF.
  const att = out.steps.attached ?? []
  out.steps.attachedFinal = att
  if (att.length > 0) {
    const s = att[att.length - 1]
    try {
      const r = await send('Runtime.evaluate', { expression: `JSON.stringify(window.__PAY__ ?? null)`, returnByValue: true }, s.sessionId)
      out.steps.oopifEval = { sessionId: s.sessionId, ok: true, value: r.result?.value ?? null, exception: r.exceptionDetails?.text ?? null }
    } catch (e) {
      out.steps.oopifEval = { sessionId: s.sessionId, ok: false, error: String(e?.message ?? e) }
    }
    try {
      const r = await send('Page.getFrameTree', {}, s.sessionId)
      out.steps.oopifFrameTree = r.frameTree?.frame
    } catch (e) {
      out.steps.oopifFrameTree = { error: String(e?.message ?? e) }
    }
  }

  // 6. per-frame DOM child count probe (the cheap OOPIF detector)
  out.steps.domChildCounts = {}
  for (const f of frames) {
    try {
      const ctx = contexts.find((c) => c.frameId === f.id && c.isDefault)
      const r = await send('Runtime.evaluate', { expression: `document.querySelectorAll('iframe,frame').length`, returnByValue: true, ...(ctx ? { contextId: ctx.id } : {}) })
      out.steps.domChildCounts[f.id] = { depth: f.depth, url: f.url, count: r.result?.value ?? null }
    } catch (e) {
      out.steps.domChildCounts[f.id] = { error: String(e?.message ?? e) }
    }
  }

  dbg.removeListener('message', listener)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(out, null, 2))
  dbg.detach()
  innerSrv.close(); outerSrv.close()
  app.exit(0)
}).catch((e) => { console.error('PROBE_ERROR', (e && e.stack) || e); app.exit(3) })

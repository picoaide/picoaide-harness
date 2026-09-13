/**
 * R-4 real-machine probe: is `browser_eval`'s `frame: N` the frame the model
 * means, on a real site-isolated page?
 *
 * RED  (old algorithm, reproduced here on the live page): indexing
 *      `Page.getFrameTree` makes `frame: 1` mean the SECOND iframe when the
 *      FIRST is cross-origin, because the out-of-process frame is absent from
 *      the page session's frame tree. The probe evaluates through that old
 *      mapping and shows the model would have received the wrong frame's data.
 * GREEN (same page, real runtime): `runtime.eval(tab, expr, 1)` reaches the
 *      cross-origin payment frame's own globals; `frame: 2` reaches the
 *      same-process srcdoc frame; a page the index cannot pair 1:1 (two
 *      redirecting cross-origin frames) is refused with an explicit error
 *      instead of being pointed at a neighbour.
 *
 * Run: NODE_OPTIONS=--experimental-transform-types \
 *      xvfb-run -a node_modules/electron/dist/electron --no-sandbox \
 *      tests/probes/frame-index-probe.mjs
 */
import { BrowserWindow } from 'electron'
import { createRecorder, makeRealRuntime, runProbe, serve, sleep, waitFor } from './lib/harness.mjs'

const PAY_HTML = `<!doctype html><html><body><h1>pay</h1><input id="cc" type="password">
<script>window.__PAY__ = { provider: 'acme-pay' };</script></body></html>`
const SAME_HTML = `<p id="sp">same-process</p><script>window.__SAME__ = 42;</script>`
const redirect = (to) => (_req, res) => { res.writeHead(302, { location: to }); res.end() }

const mixedOuter = (payOrigin) => `<!doctype html><html><body><h1>Checkout</h1>
<iframe id="pay" src="${payOrigin}/pay" width="300" height="80"></iframe>
<iframe id="same" srcdoc="${SAME_HTML.replace(/"/g, '&quot;')}" width="300" height="80"></iframe>
</body></html>`

// Two cross-origin frames whose owner `src` cannot be matched to the frame's
// final URL (both redirect) => the index cannot be proven 1:1.
const redirectOuter = (payOrigin) => `<!doctype html><html><body><h1>Two redirecting frames</h1>
<iframe id="a" src="${payOrigin}/redir-a" width="200" height="80"></iframe>
<iframe id="b" src="${payOrigin}/redir-b" width="200" height="80"></iframe>
</body></html>`

runProbe(async () => {
  const rec = createRecorder()
  const inner = await serve({ '/pay': PAY_HTML, '/redir-a': redirect('/pay'), '/redir-b': redirect('/pay') })
  const outer = await serve({
    '/mixed': mixedOuter(`http://localhost:${inner.port}`),
    '/redirects': redirectOuter(`http://localhost:${inner.port}`),
    '/plain': `<!doctype html><html><body><iframe src="${SAME_HTML.replace(/"/g, '&quot;').replace('<p', '<p')}" srcdoc="${SAME_HTML.replace(/"/g, '&quot;')}"></iframe></body></html>`,
  })

  // ---------------------------------------------------------------- RED half
  // Drive a plain BrowserWindow to reproduce the pre-fix mapping on the SAME
  // live page (no git worktree, no stubbed protocol).
  const probeWin = new BrowserWindow({ show: false, width: 900, height: 600 })
  await probeWin.loadURL(`${outer.origin}/mixed`)
  await sleep(1500)
  const dbg = probeWin.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('Page.enable', {})
  await sleep(200)
  const tree = await dbg.sendCommand('Page.getFrameTree', {})
  const frameTreeFrames = []
  const walk = (node) => {
    if (node.frame?.id) frameTreeFrames.push({ id: node.frame.id, url: node.frame.url })
    for (const child of node.childFrames ?? []) walk(child)
  }
  walk(tree.frameTree)
  const domOwners = (await dbg.sendCommand('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('iframe,frame')].map((el) => el.hasAttribute('srcdoc') ? 'about:srcdoc' : el.src)`,
    returnByValue: true,
  })).result?.value
  const oldFrame1 = frameTreeFrames[1]
  const oldEval = oldFrame1 === undefined ? null : await dbg.sendCommand('Runtime.evaluate', {
    expression: `(typeof window.__PAY__ === 'undefined' ? 'undefined' : JSON.stringify(window.__PAY__))`,
    returnByValue: true,
  })
  // The old mapping for frame 1 in the live page (contextId of frameTreeFrames[1]).
  const contexts = []
  const listener = (_e, method, params) => { if (method === 'Runtime.executionContextCreated') contexts.push(params.context) }
  dbg.on('message', listener)
  await dbg.sendCommand('Runtime.enable', {})
  await sleep(500)
  dbg.removeListener('message', listener)
  const oldFrame1Context = contexts.find((c) => c.auxData?.frameId === oldFrame1?.id && c.auxData?.isDefault === true)
  const oldFrame1Eval = oldFrame1Context === undefined ? null : (await dbg.sendCommand('Runtime.evaluate', {
    expression: `(typeof window.__PAY__ === 'undefined' ? (typeof window.__SAME__ === 'undefined' ? 'neither' : 'SAME-FRAME:' + window.__SAME__) : 'PAY-FRAME:' + JSON.stringify(window.__PAY__))`,
    returnByValue: true,
    contextId: oldFrame1Context.id,
  })).result?.value

  rec.record('R4.red.dom-order-says-frame-1-is-cross-origin',
    Array.isArray(domOwners) && String(domOwners[0]).includes('/pay'),
    { domOwners })
  rec.record('R4.red.old-index-frame-1-is-the-second-iframe (silent mis-target)',
    oldFrame1?.url === 'about:srcdoc' && String(oldFrame1Eval).startsWith('SAME-FRAME'),
    { frameTreeFrames, oldFrame1IndexAnswer: oldFrame1Eval, globalReadWithOldIndex: oldEval?.result?.value })
  // The pre-fix rule was literally `frames[index]` over this array; that the
  // array has 2 entries while the page has 3 frames is the whole defect.
  rec.record('R4.red.frame-tree-array-shorter-than-the-page',
    frameTreeFrames.length === 2 && Array.isArray(domOwners) && domOwners.length === 2,
    { frameTreeFrames: frameTreeFrames.map((f) => f.url), domOwners })
  dbg.detach()
  probeWin.destroy()

  // -------------------------------------------------------------- GREEN half
  const h = await makeRealRuntime({
    credentials: async (id) => (id === 'corp' ? { username: 'alice', password: 'S3cr3t-Passw0rd!' } : null),
  })
  try {
    const tab = await h.runtime.open(`${outer.origin}/mixed`)
    const tabId = tab.id
    await waitFor(async () => (await h.runtime.eval(tabId, 'document.readyState')) === '"complete"', { label: 'load' })

    // Diagnostics: the tab's own CDP view of the page (TS `private` is a
    // compile-time notion; the probe reaches the same session the runtime uses).
    const rawTab = h.runtime.tab(tabId)
    const diag = {
      frameTree: await rawTab.cdp.send('Page.getFrameTree'),
      domOwners: (await rawTab.cdp.send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('iframe,frame')].map((el) => el.hasAttribute('srcdoc') ? 'about:srcdoc' : (el.src || 'about:blank'))`,
        returnByValue: true,
      })).result?.value,
      oopifFrames: [...rawTab.oopifFrames.entries()],
      trackingReady: rawTab.frameTrackingReady,
    }
    console.log('TAB_DIAGNOSTICS', JSON.stringify(diag))

    // Walk every frame index the page could plausibly have and record what each
    // one reaches: the fix must make each index mean exactly one DOM position.
    const reached = {}
    for (const index of [0, 1, 2, 3]) {
      const expression = index === 0
        ? '(document.querySelector("h1") || {}).textContent || ""'
        : `(typeof window.__PAY__ === "undefined" ? (typeof window.__SAME__ === "undefined" ? "neither" : "SAME:" + window.__SAME__) : "PAY:" + JSON.stringify(window.__PAY__))`
      reached[index] = await h.runtime.eval(tabId, expression, index).then((value) => ({ value }), (error) => ({ error: error.message, code: error.code }))
    }
    rec.record('R4.green.frame-1-is-the-cross-origin-payment-frame',
      reached[1]?.value === '"PAY:{\\"provider\\":\\"acme-pay\\"}"', { reached })
    rec.record('R4.green.frame-2-is-the-same-process-srcdoc-frame', reached[2]?.value === '"SAME:42"', { reached })
    rec.record('R4.green.frame-0-unchanged', typeof reached[0]?.value === 'string' && reached[0].value.includes('Checkout'), { frame0: reached[0] })
    rec.record('R4.green.out-of-range-fails-loud-with-frame-count',
      reached[3]?.code === 'not-found' && /does not exist/u.test(reached[3]?.error ?? ''), { frame3: reached[3] })

    // A page whose cross-origin frames redirect: 2 DOM owners cannot be paired
    // with 2 reachable frames => refuse, never guess.
    const redirectTab = await h.runtime.open(`${outer.origin}/redirects`)
    await waitFor(async () => (await h.runtime.eval(redirectTab.id, 'document.readyState')) === '"complete"', { label: 'redirects load' })
    const refusal = await h.runtime.eval(redirectTab.id, 'typeof window.__PAY__', 1).then(() => null, (error) => error)
    rec.record('R4.green.unpairable-frames-refused-with-explanation',
      refusal !== null && refusal.code === 'not-found' && /frame index is not reliable/u.test(refusal.message) && /cannot pair/u.test(refusal.message),
      { message: refusal?.message })
    const mainStillWorks = await h.runtime.eval(redirectTab.id, '(document.querySelector("h1") || {}).textContent || ""')
    rec.record('R4.green.frame-0-still-usable-on-a-refused-page', mainStillWorks === '"Two redirecting frames"', { mainStillWorks })
  } finally {
    h.dispose()
    inner.close()
    outer.close()
  }
  const failures = rec.results.filter((r) => !r.pass)
  console.log(JSON.stringify({ results: rec.results, failures: failures.map((f) => f.name) }, null, 2))
  rec.write('frame-index-probe.json', { innerPort: inner.port, outerPort: outer.port })
  return failures.length === 0 ? 0 : 1
})

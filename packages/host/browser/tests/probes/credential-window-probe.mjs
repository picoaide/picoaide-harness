/**
 * R-4 (2026-09-13) real-machine probe: credential-activity window + the three
 * remaining real-device defects (text outlets, OOPIF-nested frame index,
 * short-secret false positives).
 *
 * Runs the ACTUAL `src/runtime.ts` + the real Electron adapter + the real
 * `browser_*` tools inside a real Electron 43 main process (Xvfb) against real
 * loopback pages over real CDP. Nothing is mocked: the leak must be readable
 * from the model-facing return values themselves.
 *
 * The same script is run BEFORE and AFTER the fix and its result file is kept
 * as evidence:
 *   - `RED.*` assertions describe the DEFECT and pass on the pre-fix code;
 *   - `GREEN.*` assertions describe the FIX and pass on the fixed code.
 * So the pre-fix log shows `RED true / GREEN false`, the post-fix log the
 * mirror image — that pair is the red→green evidence.
 *
 * Run (from packages/host/browser):
 *   bash tests/probes/run-realmachine.sh              # fixed tree (GREEN)
 *   bash tests/probes/run-realmachine.sh --pristine   # HEAD sources (RED)
 * or directly:
 *   NODE_OPTIONS=--experimental-transform-types \
 *   xvfb-run -a node_modules/electron/dist/electron --no-sandbox \
 *     tests/probes/credential-window-probe.mjs
 * Evidence: $PROBE_OUT (default <package>/node_modules/.probe-out/<probe>.json).
 */
import { nativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import { createRecorder, makeRealRuntime, runProbe, serve, sleep, waitFor } from './lib/harness.mjs'

const PASSWORD = 'V4ult-Pass!x7'
const SHORT = 'abc123'
const T11 = 'T11'
const T12 = 'T12'
const T13 = 'T13'
const T14 = 'T14'
const T3 = 'T3'
const T4 = 'T4'
const DLTOK = 'DLTOK1'

/** Page that renders the *injected* input value as a black/white bit grid on
 * a canvas (8 bits per character, 20x20 CSS-pixel cells, 20 cells per row).
 * Binary cells are immune to the ±1 luminance rounding a JPEG round trip
 * introduces — the same reason the round-3 verifier could decode the whole
 * password out of the model-facing JPEG. `paint()` runs on the `input`/`change`
 * events `browser_fill_credentials` dispatches. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
<style>html,body{margin:0}canvas{display:block}</style></head><body>
<canvas id="cv" width="400" height="440"></canvas>
<h1>Login</h1>
<form id="f" action="/after" method="get">
  <input id="user" name="username" type="text">
  <input id="pw" name="password" type="password">
  <button id="submit" type="submit">Sign in</button>
</form>
<button id="push" onclick="history.pushState({}, '', '#b')">no-reload nav</button>
<p id="echo">stored: <span id="echoval">(empty)</span></p>
<p id="paren">Item (${SHORT}) shipped</p>
<p id="quoted">Ref "${SHORT}" noted</p>
<p id="kv">password=${SHORT}</p>
<p id="keyed-bracket">token=[${SHORT}]</p>
<script>
  const CAL = 'PICOAI';
  const bitsOf = (text) => { let bits = ''; for (const ch of text) bits += (ch.charCodeAt(0) & 255).toString(2).padStart(8, '0'); return bits; };
  const drawBits = (ctx, text, oy) => {
    const bits = bitsOf(text);
    for (let i = 0; i < 160; i++) {
      const col = i % 20, row = (i / 20) | 0;
      ctx.fillStyle = (i < bits.length && bits[i] === '1') ? '#000' : '#fff';
      ctx.fillRect(col * 20, oy + row * 20, 20, 20);
    }
  };
  const paint = () => {
    const value = document.querySelector('#pw').value;
    document.querySelector('#echoval').textContent = value;
    const ctx = document.querySelector('#cv').getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 400, 440);
    drawBits(ctx, CAL, 0);
    drawBits(ctx, value + '\\u0000', 220);
  };
  document.querySelector('#pw').addEventListener('input', paint);
  document.querySelector('#pw').addEventListener('change', paint);
</script>
</body></html>`

const SIMPLE = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>ok</h1></body></html>`

/** Decode the bit grid of a captured JPEG back into the rendered string.
 *
 * `innerWidth` (CSS px) gives the capture scale (`screenshotMaxWidth` may have
 * resized the image). Each bit is a 20x20 CSS-pixel black/white cell; the
 * MEDIAN of a 3x3 sample grid inside it decides the bit, so JPEG ringing and a
 * stray pixel cannot flip it. `oy` is the CSS y of the block's first row. */
function decodeBits(dataUrl, oy, innerWidth, chars) {
  const image = nativeImage.createFromDataURL(dataUrl)
  const size = image.getSize()
  const scale = size.width / innerWidth
  const bitmap = image.toBitmap()
  const read = (x, y) => {
    const px = Math.min(size.width - 1, Math.max(0, Math.round(x * scale)))
    const py = Math.min(size.height - 1, Math.max(0, Math.round(y * scale)))
    const offset = (py * size.width + px) * 4
    return (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3
  }
  let bits = ''
  for (let i = 0; i < chars * 8; i++) {
    const cx = (i % 20) * 20 + 10
    const cy = oy + ((i / 20) | 0) * 20 + 10
    const grid = []
    for (const dy of [-6, 0, 6]) for (const dx of [-6, 0, 6]) grid.push(read(cx + dx, cy + dy))
    grid.sort((a, b) => a - b)
    bits += grid[4] < 128 ? '1' : '0'
  }
  let text = ''
  for (let c = 0; c < chars; c++) text += String.fromCharCode(parseInt(bits.slice(c * 8, c * 8 + 8), 2))
  return { text, bits, scale, width: size.width, height: size.height }
}

/** Progress markers on stderr: the probe prints its verdict only at the end, so
 * a hung real-machine run would otherwise be a silent log. */
const step = (name) => console.error(`[probe] ${name}`)

runProbe(async () => {
  const rec = createRecorder()
  step('serve')
  const server = await serve({
    '/dl*': (_req, res) => {
      // The credential sits in the PATH; `getFilename()` hands it back decoded
      // while `getURL()` keeps the %2D — the shape the old rule could not see.
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="report-${DLTOK}.zip"`,
      })
      res.end('zip-bytes')
    },
    '/nested': (_req, res) => {
      const body = `<!doctype html><html><head><title>NESTED</title></head><body>
        <iframe id="cross" src="http://localhost:${server.port}/oopif"></iframe>
        <iframe id="same" src="/same"></iframe></body></html>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    },
    '/oopif': (_req, res) => {
      const body = `<!doctype html><html><head><title>OOPIF-ROOT</title></head><body>
        <iframe id="deep" src="http://localhost:${server.port}/deep"></iframe></body></html>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    },
    '/deep': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE('DEEP-FRAME')) },
    '/same': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE('SAME-FRAME')) },
    '/after': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE('After login')) },
    '/title-bare': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`token=${T12}`)) },
    '/title-rel': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`Sign in /cb?%73id=${T11}`)) },
    '/title-query': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`Login failed: code=${T14}&amp;state=x`)) },
    '/title-abs': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`Sign in http://127.0.0.1:${server.port}/cb?token=${T13}`)) },
    '*': (_req, res) => {
      const body = PAGE
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`

  const h = await makeRealRuntime({ credentials: async (id) => (id === 'short' ? { username: 'alice', password: SHORT } : { username: 'alice', password: PASSWORD }) })
  const evalOut = async (tab, expression, frame) => await h.call('browser_eval', frame === undefined ? { tab, expression } : { tab, expression, frame })
    .then((value) => ({ ok: true, result: value.result }))
    .catch((error) => ({ ok: false, code: error.code, message: String(error.message) }))
  const shotOut = async (tab) => await h.call('browser_screenshot', { tab })
    .then(() => ({ ok: true, dataUrl: h.lastImageDataUrl(), attachment: h.images.at(-1)?.name }))
    .catch((error) => ({ ok: false, code: error.code, message: String(error.message) }))

  try {
    step('window: browser_open')
    const login = await h.call('browser_open', { url: `${origin}/login` })
    const tab = login.tab
    step('window: showWindow')
    // A hidden window has no display surface on this box (`capturePage` fails
    // with "Current display surface not available" and the CDP fallback then
    // hangs), so the window is shown for the probe: that is also the real
    // scenario in which a screenshot of a credential page is model-facing.
    await h.runtime.showWindow()
    step('window: waitFor page')
    await waitFor(async () => (await h.call('browser_get_text', { tab, selector: '#submit' })).text !== '', { label: 'login page' })
    step('window: ready')

    // RED premise: before injection the tab is an ordinary tab (eval works).
    const beforeFill = await evalOut(tab, '1 + 1')
    rec.record('W.red.eval-works-before-fill', beforeFill.ok && beforeFill.result === '2', beforeFill)

    step('window: fill')
    await h.call('browser_fill_credentials', { tab, connectorId: 'corp' })
    const filledState = h.runtime.tab(tab)
    rec.record('W.premise.credential-values-recorded-on-fill', filledState.filledSecrets.length > 0, { filledSecrets: filledState.filledSecrets.length })

    // RED: read-side transforms hand the credential back (value-level masking
    // cannot see them — that is why the window must close eval entirely).
    const b64 = await evalOut(tab, "btoa(document.querySelector('#pw').value)")
    const decoded = b64.ok ? Buffer.from(JSON.parse(b64.result), 'base64').toString('utf8') : null
    rec.record('W.red.eval-btoa-returns-credential', decoded === PASSWORD, { ...b64, decoded })
    const sliced = await evalOut(tab, "[...document.querySelector('#pw').value].join('-')")
    rec.record('W.red.eval-slice-join-returns-credential', sliced.ok && String(sliced.result).includes(PASSWORD.split('').join('-')), sliced)
    const head = await evalOut(tab, "document.querySelector('#pw').value.slice(0,5)")
    rec.record('W.red.eval-prefix-returns-credential', head.ok && String(head.result).includes(PASSWORD.slice(0, 5)), head)

    // RED: the screenshot channel carries the credential as pixels. The scale
    // comes from a raw CDP read (probe plumbing, not a model-facing exit).
    const innerWidth = (await h.runtime.tab(tab).cdp.send('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true })).result?.value
    const shot = await shotOut(tab)
    const canDecode = shot.ok && shot.dataUrl !== null && typeof innerWidth === 'number' && innerWidth > 0
    // The calibration row makes a wrong scale/offset visible instead of
    // silently "decoding" garbage.
    const calibration = canDecode ? decodeBits(shot.dataUrl, 0, innerWidth, 6) : null
    const fromImage = canDecode ? decodeBits(shot.dataUrl, 220, innerWidth, PASSWORD.length) : null
    rec.record('W.red.screenshot-returns-credential-as-pixels',
      fromImage !== null && calibration !== null && calibration.text === 'PICOAI' && fromImage.text === PASSWORD,
      { ok: shot.ok, code: shot.code, message: shot.message, innerWidth, scale: fromImage?.scale, calibration: calibration?.text, decoded: fromImage?.text, size: fromImage === null ? null : { width: fromImage.width, height: fromImage.height } })

    // GREEN: both channels are refused inside the window, with an assertable text.
    rec.record('W.green.eval-refused-in-window',
      !b64.ok && b64.code === 'policy' && /credential window/u.test(b64.message) && /browser_fill_credentials/u.test(b64.message),
      b64)
    rec.record('W.green.screenshot-refused-in-window',
      !shot.ok && shot.code === 'policy' && /credential window/u.test(shot.message) && /browser_screenshot/u.test(shot.message),
      shot)

    // GREEN: the text outlets still work inside the window and still mask the value.
    const echo = await h.call('browser_get_text', { tab, selector: '#echo' })
    rec.record('W.green.text-outlet-still-works-and-masks-value',
      !echo.text.includes(PASSWORD) && echo.text.includes('****'), { text: echo.text })

    step('window: same-document nav')
    // GREEN: a same-document navigation must NOT end the window.
    await h.call('browser_click', { tab, target: '#push' })
    await sleep(300)
    const afterPush = await evalOut(tab, '1 + 1')
    rec.record('W.green.same-document-nav-keeps-window', !afterPush.ok && afterPush.code === 'policy', afterPush)

    step('window: submit')
    // GREEN: a real submit (form -> /after) ends it; eval and screenshot work again.
    await h.call('browser_click', { tab, target: '#submit' })
    const exited = await waitFor(async () => {
      const out = await evalOut(tab, '1 + 1')
      return out.ok ? out : false
    }, { timeoutMs: 8000, label: 'eval resumes after navigation' }).catch(() => null)
    const afterNavUrl = h.runtime.tab(tab).url
    // R-6 (2026-09-13): the window closes on navigation, the VALUE set stays for
    // the tab's lifetime (a page can stash the value before navigating — see
    // `r6-outlet-probe.mjs` F5/F6), so `filledSecrets` is expected to survive.
    rec.record('W.green.submit-navigation-exits-window',
      exited !== null && exited.result === '2' && afterNavUrl.includes('/after') && h.runtime.tab(tab).filledSecrets.length === 1,
      { exited, url: afterNavUrl, filledSecrets: h.runtime.tab(tab).filledSecrets.length })
    const shotAfter = await shotOut(tab)
    rec.record('W.green.screenshot-resumes-after-navigation', shotAfter.ok, { ok: shotAfter.ok, code: shotAfter.code, message: shotAfter.message })

    step('window: ordinary tab')
    // GREEN: an ordinary tab is untouched by any of this.
    const free = await h.call('browser_open', { url: `${origin}/free` })
    await waitFor(async () => (await h.call('browser_get_text', { tab: free.tab, selector: '#kv' })).text !== '', { label: 'free page' })
    const freeEval = await evalOut(free.tab, '1 + 1')
    const freeShot = await shotOut(free.tab)
    rec.record('W.green.ordinary-tab-unaffected', freeEval.ok && freeEval.result === '2' && freeShot.ok, { freeEval, shotOk: freeShot.ok, message: freeShot.message })

    step('text outlets')
    // ================================================== text outlets (R-1)
    const titles = [
      ['bare', '/title-bare', T12],
      ['relpath', '/title-rel', T11],
      ['query', '/title-query', T14],
      ['absurl', '/title-abs', T13],
    ]
    const observed = {}
    for (const [name, path, secret] of titles) {
      const opened = await h.call('browser_navigate', { tab, url: `${origin}${path}` })
      await waitFor(async () => (await h.call('browser_get_text', { tab })).text.includes('ok'), { label: `${name} page` })
      const tabs = await h.call('browser_list_tabs')
      const row = tabs.tabs.find((t) => t.id === tab) ?? {}
      const snapshot = await h.call('browser_get_snapshot', { tab })
      observed[name] = { secret, listTitle: row.title, snapTitle: snapshot.title, navigated: opened.url }
      // The absolute-URL title was already masked before this round (the `://`
    // rule) — it is the CONTROL that the other three were not.
    const leaks = name !== 'absurl'
    rec.record(`T.${leaks ? 'red' : 'control'}.title-${name}-${leaks ? 'cleartext-in-list-tabs' : 'already-redacted'}`,
      leaks ? String(row.title).includes(secret) : !String(row.title).includes(secret) && String(row.title).includes('token=****'), observed[name])
    }
    // disk: history.jsonl must not keep the same cleartext
    const history = readFileSync(`${h.dir}/history.jsonl`, 'utf8')
    const leaking = titles.filter(([name]) => name !== 'absurl')
    rec.record('T.red.titles-cleartext-in-history.jsonl',
      leaking.every(([, , secret]) => history.includes(secret)),
      { sample: history.split('\n').filter((line) => line.includes('token=') || line.includes('code=')).slice(0, 3) })
    rec.record('T.green.titles-redacted-in-list-tabs-and-disk',
      observed['bare'].listTitle === 'token=****'
      && observed['relpath'].listTitle === `Sign in /cb?%73id=****`
      && observed['query'].listTitle === 'Login failed: code=****&state=x'
      && observed['absurl'].listTitle.includes('token=****')
      && titles.every(([, , secret]) => !history.includes(secret))
      && history.includes('code=****'),
      { observed, historySample: history.split('\n').filter((line) => line.includes('token=') || line.includes('code=')).slice(0, 4) })

    // double-encoded key + `;` separator in the URL field itself
    await h.call('browser_navigate', { tab, url: `${origin}/double?%2573id=${T3}` })
    await waitFor(async () => (await h.call('browser_get_text', { tab })).text.includes('ok'), { label: 'double page' })
    await h.call('browser_navigate', { tab, url: `${origin}/semi?a=1;token=${T4}` })
    await waitFor(async () => (await h.call('browser_get_text', { tab })).text.includes('ok'), { label: 'semi page' })
    const tabs2 = await h.call('browser_list_tabs')
    const urls = tabs2.tabs.map((t) => t.url).filter((u) => u.includes('/double') || u.includes('/semi'))
    const disk2 = readFileSync(`${h.dir}/history.jsonl`, 'utf8')
    rec.record('T.red.double-encoded-and-semicolon-cleartext', urls.some((u) => u.includes(T3)) || disk2.includes(T3) || disk2.includes(T4), { urls, diskHasT3: disk2.includes(T3), diskHasT4: disk2.includes(T4) })
    rec.record('T.green.double-encoded-and-semicolon-masked',
      urls.every((u) => !u.includes(T3) && !u.includes(T4)) && !disk2.includes(T3) && !disk2.includes(T4) && urls.some((u) => u.includes('****')),
      { urls })

    step('download')
    // download name with a percent-encoded path segment
    await h.call('browser_download', { url: `${origin}/dl/report%2D${DLTOK}.zip?token=${DLTOK}` })
    await sleep(900)
    const downloads = await h.call('browser_downloads_list')
    const entry = downloads.downloads[0] ?? {}
    rec.record('T.red.download-percent-encoded-fileName-cleartext',
      String(entry.fileName).includes(DLTOK), { entry })
    // Documented residual, asserted in BOTH states: `path` stays the real
    // on-disk handle (downloads_open + the file tools need it) and the same name
    // is visible by listing the downloads directory, so masking it would remove
    // the capability without hiding the string.
    rec.record('T.residual.download-path-on-disk-truthful-by-design',
      readFileSync(`${h.dir}/downloads.jsonl`, 'utf8').includes(DLTOK),
      { raw: readFileSync(`${h.dir}/downloads.jsonl`, 'utf8').slice(0, 300) })
    rec.record('T.green.download-percent-encoded-fileName-masked',
      entry.fileName === '****' && String(entry.url).includes('token=****'), { entry })

    step('R-3')
    // ===================================================== R-3 false positives
    const shortTab = (await h.call('browser_open', { url: `${origin}/short` })).tab
    await waitFor(async () => (await h.call('browser_get_text', { tab: shortTab, selector: '#kv' })).text !== '', { label: 'short page' })
    await h.call('browser_fill_credentials', { tab: shortTab, connectorId: 'short' })
    const text = await h.call('browser_get_text', { tab: shortTab })
    rec.record('R3.red.paren-prose-corrupted', text.text.includes('Item (****) shipped'), { paren: text.text.split('\n').find((line) => line.startsWith('Item')) })
    rec.record('R3.red.quoted-prose-corrupted', text.text.includes('Ref "****" noted'), { quoted: text.text.split('\n').find((line) => line.startsWith('Ref')) })
    rec.record('R3.green.prose-preserved',
      text.text.includes(`Item (${SHORT}) shipped`) && text.text.includes(`Ref "${SHORT}" noted`),
      { text: text.text.slice(0, 300) })
    rec.record('R3.green.keyed-forms-still-masked',
      text.text.includes('password=****') && text.text.includes('token=[****]'),
      { kv: text.text.split('\n').find((line) => line.startsWith('password=')), keyed: text.text.split('\n').find((line) => line.startsWith('token=')) })
    rec.record('R3.red.bracket-without-key-masked-by-the-old-rule', text.text.includes('token=[****]'), { note: 'control: a keyed bracket value must stay masked' })

    step('R-4 nested')
    // ============================================= R-4 nested OOPIF frame index
    const nested = (await h.call('browser_open', { url: `${origin}/nested` })).tab
    await sleep(1500)
    const frameOf = async (index) => await evalOut(nested, 'document.title', index)
    const f1 = await frameOf(1)
    const f2 = await frameOf(2)
    const f3 = await frameOf(3)
    const f9 = await frameOf(9)
    rec.record('R4.red.nested-oopif-child-not-indexed', !f2.ok && String(f2.message).includes('frame index is not reliable'), { f1, f2, f3 })
    rec.record('R4.green.nested-frames-in-dom-order',
      f1.ok && JSON.parse(String(f1.result)) === 'OOPIF-ROOT'
      && f2.ok && JSON.parse(String(f2.result)) === 'DEEP-FRAME'
      && f3.ok && JSON.parse(String(f3.result)) === 'SAME-FRAME',
      { f1, f2, f3 })
    rec.record('R4.green.nested-out-of-range-fails-loud',
      !f9.ok && f9.code === 'not-found' && String(f9.message).includes('4 frames: 0-3'),
      f9)
  } finally {
    h.dispose()
    server.close()
  }

  // Polarity: `*.red.*` assertions describe the DEFECT (they are expected to
  // pass on pre-fix sources), everything else describes the FIX. PROBE_EXPECT
  // picks which half is judged, so `run-realmachine.sh [--pristine]` can use the
  // exit code for both the red and the green run.
  const expect = process.env['PROBE_EXPECT'] === 'red' ? 'red' : 'green'
  const judged = rec.results.filter((result) => result.name.includes('.red.') === (expect === 'red'))
  const failures = judged.filter((result) => !result.pass)
  rec.write('credential-window-probe.json', { expect })
  console.log(JSON.stringify({ expect, judged: judged.length, failures: failures.map((f) => f.name), results: rec.results }, null, 2))
  return failures.length === 0 ? 0 : 1
})

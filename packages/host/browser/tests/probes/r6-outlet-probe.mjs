/**
 * R-6 (2026-09-13) real-machine probe: the eight outlets the fifth-round
 * independent re-verification walked around (`temp/r5-verify-browser/REPORT.md`).
 *
 * Runs the ACTUAL `src/runtime.ts` + the real Electron adapter + the real
 * `browser_*` tools inside a real Electron 43 main process (Xvfb) against real
 * loopback pages over real CDP. Nothing is mocked: every leak is read back from
 * the model-facing return values themselves.
 *
 * Polarity contract (same as the R-4 probe):
 *   - `R6.red.*`   assertions describe the DEFECT and pass on the pre-fix tree;
 *   - everything else describes the FIX and passes on the fixed tree.
 * `PROBE_EXPECT=red` (run with `run-realmachine.sh --pristine`) judges the first
 * half, the default judges the second: the red→green pair is the evidence.
 *
 * Covered findings:
 *   F1 title cleartext (`list_tabs`/snapshot)          — page sets document.title
 *   F3 page-chosen URL (replaceState/hash)             — `?pw=<value>`
 *   F4 download name/path cleartext                    — `<a download=<value>.txt>`
 *   F5 post-navigation cleartext on every text exit    — value kept in sessionStorage
 *   F6 history.jsonl / history_search persistence      — same value, next navigation
 *   F7 window.open child tab URL cleartext             — popup inherits the value set
 *   F8 mask-table gaps (spaces/entity/full-width/JSON) — title carries each form
 *   F2 transformed text: DECLARED residual, asserted as such (never "solved")
 *
 * Run (from packages/host/browser):
 *   bash tests/probes/run-realmachine.sh              # fixed tree (GREEN)
 *   bash tests/probes/run-realmachine.sh --pristine   # HEAD sources (RED)
 * Evidence: $PROBE_OUT (default <package>/node_modules/.probe-out/<probe>.json).
 */
import { readFileSync } from 'node:fs'
import { createRecorder, makeRealRuntime, runProbe, serve, sleep, waitFor } from './lib/harness.mjs'

const PASSWORD = 'V4ult-Pass!x7'
const SHORT = 'abc123'
const T12 = 'T12'
const T13 = 'T13'
const T14 = 'T14'
const T15 = 'T15'
const T16 = 'T16'

/** Decode percent-escapes so an encoded value in a popup URL is comparable. */
const decoded = (text) => { try { return decodeURIComponent(String(text)) } catch { return String(text) } }

/**
 * Hostile login page: every handler runs on the `input`/`change` events that
 * `browser_fill_credentials` dispatches, i.e. the model did nothing but fill.
 *
 *  - `document.title = value`            (F1)
 *  - `history.replaceState('?pw=' + v)`  (F3)
 *  - `<a download=v + '.txt'>` clicked   (F4; `/dl` sends no Content-Disposition)
 *  - `window.open('/popup?pw=' + v)`     (F7)
 *  - `sessionStorage.setItem('pw', v)`   (F5/F6: outlives the document)
 */
const HOSTILE = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<h1>Login</h1>
<form id="f" action="/after" method="get">
  <input id="user" name="username" type="text">
  <input id="pw" name="password" type="password">
  <button id="submit" type="submit">Sign in</button>
</form>
<p id="echo">stored: <span id="echoval">(empty)</span></p>
<textarea id="stash"></textarea>
<script>
  const stash = (value) => {
    document.title = value;
    sessionStorage.setItem('pw', value);
    document.querySelector('#echoval').textContent = value;
    document.querySelector('#stash').value = value;
    try { history.replaceState({}, '', '?pw=' + encodeURIComponent(value)); } catch (err) {}
  };
  const dl = (value) => {
    const a = document.createElement('a');
    a.href = '/dl';
    a.download = value + '.txt';
    document.body.appendChild(a);
    a.click();
  };
  document.querySelector('#pw').addEventListener('input', () => {
    const value = document.querySelector('#pw').value;
    stash(value);
    dl(value);
    try { window.open('/popup?pw=' + encodeURIComponent(value), '_blank'); } catch (err) {}
  });
  document.querySelector('#pw').addEventListener('change', () => stash(document.querySelector('#pw').value));
</script>
</body></html>`

/** Landing page after the (script-driven) navigation: reads the stored copy
 * back and renders it, plus the transformed forms of the same value. */
const AFTER = `<!doctype html><html><head><meta charset="utf-8"><title>After</title></head><body>
<h1>Welcome</h1>
<p id="leak">stashed: (empty)</p>
<textarea id="stash2"></textarea>
<p id="b64"></p><p id="rev"></p><p id="spaced"></p>
<script>
  const value = sessionStorage.getItem('pw') || '(none)';
  document.querySelector('#leak').textContent = 'stashed: ' + value;
  document.querySelector('#stash2').value = value;
  document.title = value;
  document.querySelector('#b64').textContent = btoa(value);
  document.querySelector('#rev').textContent = [...value].reverse().join('');
  document.querySelector('#spaced').textContent = [...value].join(' ');
</script>
</body></html>`

const POPUP = (value) => `<!doctype html><html><head><meta charset="utf-8"><title>popup</title></head><body>
<h1>popup</h1><p id="here">${value}</p></body></html>`

const SHORT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>short</title></head><body>
<h1>short</h1>
<form><input id="user" name="username" type="text"><input id="pw" name="password" type="password"></form>
<p id="kv">password=${SHORT} next line</p>
<p id="paren">Item (${SHORT}) shipped</p>
</body></html>`

const SIMPLE = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>ok</h1></body></html>`

/** Progress markers on stderr (the verdict is printed only at the end). */
const step = (name) => console.error(`[probe] ${name}`)

runProbe(async () => {
  const rec = createRecorder()
  step('serve')
  const server = await serve({
    '/dl': (_req, res) => {
      // No Content-Disposition on purpose: the name comes from the page's own
      // `download` attribute (R-5 F4).
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('download-bytes')
    },
    '/after': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(AFTER) },
    '/popup': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(POPUP('popup')) },
    '/short': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SHORT_PAGE) },
    // F8: each page title carries one separator spelling the pre-fix table missed.
    '/f8-space': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`token = ${T12}`)) },
    '/f8-entity': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`token&amp;#61;${T13}`)) },
    '/f8-full': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`token＝${T14}`)) },
    '/f8-json': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`{"code":"${T15}"}`)) },
    '/f8-path': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIMPLE(`https://x/token=${T16}/next`)) },
    '*': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HOSTILE)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`

  const h = await makeRealRuntime({
    credentials: async (id) => (id === 'short' ? { username: 'alice', password: SHORT } : { username: 'alice', password: PASSWORD }),
  })
  const evalOut = async (tab, expression) => await h.call('browser_eval', { tab, expression })
    .then((value) => ({ ok: true, result: value.result }))
    .catch((error) => ({ ok: false, code: error.code, message: String(error.message) }))
  const tabsNow = async () => (await h.call('browser_list_tabs')).tabs
  const tabRow = async (tab) => (await tabsNow()).find((row) => row.id === tab) ?? {}
  const textOf = async (tab, selector) => (await h.call('browser_get_text', selector === undefined ? { tab } : { tab, selector })).text
  const downloadsNow = async () => (await h.call('browser_downloads_list')).downloads

  try {
    step('open hostile page')
    const opened = await h.call('browser_open', { url: `${origin}/login` })
    const tab = opened.tab
    await h.runtime.showWindow()
    await waitFor(async () => (await textOf(tab, '#submit')) !== '', { label: 'login page' })

    step('fill credentials (page handlers fire)')
    await h.call('browser_fill_credentials', { tab, connectorId: 'corp' })
    // The page mutated title/URL and clicked a download link from its `input`
    // handler; give Electron's events + the download a moment.
    await sleep(1200)

    // ---------------------------------------------------------------- F1 title
    const rowAfterFill = await tabRow(tab)
    const snapshotAfterFill = await h.call('browser_get_snapshot', { tab })
    rec.record('R6.red.title-cleartext-in-list-tabs-and-snapshot',
      String(rowAfterFill.title).includes(PASSWORD) && String(snapshotAfterFill.title).includes(PASSWORD),
      { listTitle: rowAfterFill.title, snapshotTitle: snapshotAfterFill.title })
    rec.record('R6.green.title-masked-in-list-tabs-and-snapshot',
      rowAfterFill.title === '****' && snapshotAfterFill.title === '****',
      { listTitle: rowAfterFill.title, snapshotTitle: snapshotAfterFill.title })
    // The credential window is still open here (same document): eval stays refused.
    const evalInWindow = await evalOut(tab, '1 + 1')
    rec.record('R6.green.eval-still-refused-inside-window',
      !evalInWindow.ok && evalInWindow.code === 'policy' && /credential window/u.test(evalInWindow.message),
      evalInWindow)

    // ------------------------------------------------------------------ F3 URL
    rec.record('R6.red.page-chosen-url-cleartext-in-list-tabs',
      decoded(rowAfterFill.url).includes(PASSWORD),
      { url: rowAfterFill.url })
    rec.record('R6.green.page-chosen-url-masked-in-list-tabs',
      !decoded(rowAfterFill.url).includes(PASSWORD) && String(rowAfterFill.url).includes('pw=****'),
      { url: rowAfterFill.url })

    // ------------------------------------------------------------ F4 download
    const downloads = await downloadsNow()
    const entry = downloads[0] ?? {}
    const truthful = h.store.queryDownloads({})[0] ?? {}
    rec.record('R6.red.download-name-cleartext-in-downloads-list',
      String(entry.fileName).includes(PASSWORD) && String(entry.path).includes(PASSWORD),
      { fileName: entry.fileName, path: entry.path })
    rec.record('R6.green.download-name-and-path-masked-in-downloads-list',
      !String(entry.fileName).includes(PASSWORD) && !String(entry.path).includes(PASSWORD)
      && String(entry.fileName).includes('****') && String(entry.path).includes('****'),
      { fileName: entry.fileName, path: entry.path })
    // Declared residual, asserted in BOTH states: the store keeps the truthful
    // handle (downloads_open + the file tools need it) and the name is visible
    // by listing the downloads directory.
    rec.record('R6.residual.download-disk-path-truthful-by-design',
      String(truthful.path).includes(PASSWORD) && readFileSync(`${h.dir}/downloads.jsonl`, 'utf8').includes(PASSWORD),
      { storePath: truthful.path })

    // ------------------------------------------------------------------ F7 popup
    const popupTab = (await tabsNow()).find((row) => row.id !== tab)
    rec.record('R6.red.popup-url-cleartext-in-list-tabs',
      popupTab !== undefined && decoded(popupTab.url).includes(PASSWORD),
      { popupTab })
    rec.record('R6.green.popup-url-masked-in-list-tabs',
      popupTab !== undefined && !decoded(popupTab.url).includes(PASSWORD) && String(popupTab.url).includes('pw=****'),
      { popupTab })

    // ------------------------------------------------------- F5/F6 out-of-window
    step('navigate out of the document')
    await h.call('browser_navigate', { tab, url: `${origin}/after` })
    await waitFor(async () => (await textOf(tab, '#leak')).includes('stashed:'), { label: 'after page' })
    await sleep(300)
    const afterText = await textOf(tab)
    const afterRow = await tabRow(tab)
    const afterEval = await evalOut(tab, "sessionStorage.getItem('pw')")
    const afterSnapshot = await h.call('browser_get_snapshot', { tab })
    const historyDisk = readFileSync(`${h.dir}/history.jsonl`, 'utf8')
    const historyTool = await h.call('browser_history_search', { q: 'stashed' })

    rec.record('R6.red.after-navigation-get-text-cleartext', afterText.includes(PASSWORD), { afterText: afterText.slice(0, 200) })
    rec.record('R6.green.after-navigation-get-text-masked',
      !afterText.includes(PASSWORD) && afterText.includes('stashed: ****'),
      { afterText: afterText.slice(0, 200) })
    rec.record('R6.red.after-navigation-title-cleartext', String(afterRow.title).includes(PASSWORD), { title: afterRow.title })
    rec.record('R6.green.after-navigation-title-masked',
      !String(afterRow.title).includes(PASSWORD) && String(afterRow.title).includes('****'),
      { title: afterRow.title })
    rec.record('R6.red.after-navigation-eval-cleartext',
      afterEval.ok && String(afterEval.result).includes(PASSWORD),
      afterEval)
    rec.record('R6.green.after-navigation-eval-masked-and-window-closed',
      afterEval.ok && !String(afterEval.result).includes(PASSWORD) && String(afterEval.result).includes('****'),
      afterEval)
    rec.record('R6.red.after-navigation-snapshot-cleartext',
      JSON.stringify(afterSnapshot).includes(PASSWORD),
      { snapshot: JSON.stringify(afterSnapshot).slice(0, 240) })
    rec.record('R6.green.after-navigation-snapshot-masked',
      !JSON.stringify(afterSnapshot).includes(PASSWORD),
      { snapshot: JSON.stringify(afterSnapshot).slice(0, 240) })
    rec.record('R6.red.after-navigation-history-cleartext',
      historyDisk.includes(PASSWORD) || JSON.stringify(historyTool).includes(PASSWORD),
      { historySample: historyDisk.split('\n').filter((line) => line.includes('stashed')).slice(0, 2) })
    rec.record('R6.green.after-navigation-history-masked',
      !historyDisk.includes(PASSWORD) && !JSON.stringify(historyTool).includes(PASSWORD),
      { historySample: historyDisk.split('\n').filter((line) => line.includes('stashed')).slice(0, 2) })

    // ------------------------------------------------------ F8 mask-table gaps
    step('F8 mask table')
    const f8 = [
      ['space', '/f8-space', T12, 'token = ****'],
      ['entity', '/f8-entity', T13, 'token&#61;****'],
      ['fullwidth', '/f8-full', T14, 'token＝****'],
      ['json', '/f8-json', T15, '{"code":"****"}'],
    ]
    for (const [name, path, token, expected] of f8) {
      await h.call('browser_navigate', { tab, url: `${origin}${path}` })
      await sleep(150)
      const title = (await tabRow(tab)).title
      rec.record(`R6.red.f8-${name}-cleartext-in-title`, String(title).includes(token) && !String(title).includes('****'), { title })
      rec.record(`R6.green.f8-${name}-masked-in-title`, title === expected, { title, expected })
    }
    // Over-masking control: the old rule swallowed `/next` whole.
    await h.call('browser_navigate', { tab, url: `${origin}/f8-path` })
    await sleep(150)
    const pathTitle = (await tabRow(tab)).title
    rec.record('R6.red.f8-url-path-overmasked', !String(pathTitle).includes('/next'), { title: pathTitle })
    rec.record('R6.green.f8-url-path-kept', pathTitle === 'https://x/token=****/next', { title: pathTitle })

    // ------------------------------------------------ short password + trailing text
    step('short password trailing text')
    const shortTab = (await h.call('browser_open', { url: `${origin}/short` })).tab
    await waitFor(async () => (await textOf(shortTab, '#kv')) !== '', { label: 'short page' })
    await h.call('browser_fill_credentials', { tab: shortTab, connectorId: 'short' })
    const shortText = await textOf(shortTab)
    rec.record('R6.red.short-password-trailing-text-cleartext',
      shortText.includes(`password=${SHORT} next line`),
      { line: shortText.split('\n').find((line) => line.startsWith('password=')) })
    rec.record('R6.green.short-password-trailing-text-masked',
      shortText.includes('password=**** next line') && shortText.includes(`Item (${SHORT}) shipped`),
      { text: shortText.slice(0, 200) })

    // ------------------------------------------- F2 transformed text: residual
    rec.record('R6.residual.transformed-forms-still-readable-by-design',
      afterText.includes(Buffer.from(PASSWORD, 'utf8').toString('base64'))
      && afterText.includes([...PASSWORD].reverse().join(''))
      && afterText.includes([...PASSWORD].join(' '))
      && !afterText.includes(PASSWORD),
      {
        note: 'declared residual: value-level redaction covers VERBATIM occurrences only',
        b64: Buffer.from(PASSWORD, 'utf8').toString('base64'),
        reversed: [...PASSWORD].reverse().join(''),
      })
    const fillDescription = h.tools.get('browser_fill_credentials').description
    const textDescription = h.tools.get('browser_get_text').description
    rec.record('R6.green.tool-descriptions-declare-the-transform-residual',
      /VERBATIM|transformed/u.test(fillDescription) && /VERBATIM|transformed/u.test(textDescription)
      && !/values stay redacted/u.test(fillDescription),
      { fill: fillDescription.slice(-220), text: textDescription.slice(-180) })
  } finally {
    h.dispose()
    server.close()
  }

  // Polarity: `*.red.*` assertions describe the DEFECT (expected to pass on the
  // pre-fix sources), everything else describes the FIX.
  const expect = process.env['PROBE_EXPECT'] === 'red' ? 'red' : 'green'
  const judged = rec.results.filter((result) => result.name.includes('.red.') === (expect === 'red'))
  const failures = judged.filter((result) => !result.pass)
  rec.write('r6-outlet-probe.json', { expect })
  console.log(JSON.stringify({ expect, judged: judged.length, failures: failures.map((f) => f.name), results: rec.results }, null, 2))
  return failures.length === 0 ? 0 : 1
})

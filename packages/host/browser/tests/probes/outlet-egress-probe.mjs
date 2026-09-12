/**
 * R-1 / R-2 / R-3 real-machine probe (2026-09-13).
 *
 * Runs the ACTUAL runtime + tools inside real Electron against real loopback
 * pages over real CDP:
 *
 *  R-1  every model-facing exit (snapshot envelope url/title, list_tabs,
 *       open/navigate returns, shellState, downloads, page text, refusal error)
 *       is checked for cleartext credentials on a URL that genuinely carries
 *       them — the same string the pre-fix envelope shipped, read from the
 *       tab's own live state.
 *  R-2  a real `fetch` driven through `browser_eval` is shown to reach the
 *       server BEFORE credentials are injected, then to be refused (statically
 *       and by the page-side shim, including through a page-authored relay
 *       function) after `browser_fill_credentials`, with the API restored
 *       afterwards.
 *  R-3  a short injected password no longer corrupts ordinary page text, while
 *       the read-back and value-shaped occurrences stay masked; the long
 *       password contrast keeps working.
 *
 * Run: NODE_OPTIONS=--experimental-transform-types \
 *      xvfb-run -a node_modules/electron/dist/electron --no-sandbox \
 *      tests/probes/outlet-egress-probe.mjs
 */
import { createRecorder, existsSync, makeRealRuntime, runProbe, serve, sleep, waitFor } from './lib/harness.mjs'

const LONG = 'S3cr3t-Passw0rd!'
const SHORT = 'abc123'
const CODE = 'OPAQUECODE123'
const SAML = 'SAMLRESP1'
const FRAG = 'FRAGACC1'
const DLTOKEN = 'DLTOKEN999'

const page = (self) => `<!doctype html><html><head><meta charset="utf-8">
<title>Sign in - ${self}/login?code=${CODE}&SAMLResponse=${SAML}#access_token=${FRAG}</title></head><body>
<h1>Login</h1>
<form><input id="user" name="username" type="text"><input id="pw" name="password" type="password" value="${LONG}"><button id="go">Sign in</button></form>
<p id="echo">the stored password ${LONG} is weak</p>
<p id="short">order ${SHORT} confirmed</p>
<p id="kv">password=${SHORT}</p>
<script>
  window.__relay = (value) => fetch('/exfil?pw=' + encodeURIComponent(value));
  window.__probe = { seen: [] };
</script>
</body></html>`

runProbe(async () => {
  const rec = createRecorder()
  const exfil = []
  const server = await serve({
    '/exfil*': (req, res) => {
      exfil.push(req.url)
      res.writeHead(204)
      res.end()
    },
    '/dl*': (_req, res) => {
      // The credential sits in the PATH here: the file name derived from it is
      // exactly the shape a key-shaped redactor cannot recognize.
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="report-${DLTOKEN}.zip"`,
      })
      res.end('zip-bytes')
    },
    '*': (req, res) => {
      const body = page(`http://127.0.0.1:${server.port}`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    },
  })
  const secretUrl = `http://127.0.0.1:${server.port}/login?code=${CODE}&SAMLResponse=${SAML}#access_token=${FRAG}`
  const leaks = (text) => [CODE, SAML, FRAG, DLTOKEN].filter((secret) => String(text).includes(secret))

  const h = await makeRealRuntime({
    credentials: async (id) => (id === 'short' ? { username: 'alice', password: SHORT } : id === 'long' ? { username: 'alice', password: LONG } : null),
  })
  try {
    const opened = await h.call('browser_open', { url: secretUrl })
    const tabId = opened.tab
    await waitFor(async () => (await h.call('browser_get_text', { tab: tabId, selector: '#go' })).text !== '', { label: 'page ready' })

    // The RED premise, on the live tab: the page URL really carries the
    // secrets (this is the exact string the pre-fix envelope returned).
    const rawTab = h.runtime.tab(tabId)
    const rawUrl = rawTab.url
    const liveLocation = (await rawTab.cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value
    rec.record('R1.red.live-tab-url-carries-credentials', leaks(rawUrl).length === 3 && leaks(liveLocation).length === 3, { rawUrl, liveLocation })
    // The pre-fix envelope was literally `{ url: state.url, title: state.title }`
    // over the tab's own fields — reproduced here on the live tab.
    const oldEnvelope = JSON.stringify({ url: rawUrl, title: rawTab.title })
    rec.record('R1.red.old-envelope-would-leak', leaks(oldEnvelope).length === 3, { oldEnvelope })

    // ---------------------------------------------------------------- R-1
    const snapshot = await h.call('browser_get_snapshot', { tab: tabId })
    rec.record('R1.snapshot-envelope.url-redacted', leaks(snapshot.url).length === 0 && String(snapshot.url).includes('login'), { url: snapshot.url })
    rec.record('R1.snapshot-envelope.title-redacted', leaks(snapshot.title).length === 0 && String(snapshot.title).includes('Sign in'), { title: snapshot.title })
    rec.record('R1.open-envelope.redacted', leaks(JSON.stringify(opened)).length === 0, { opened })

    const tabs = await h.call('browser_list_tabs')
    rec.record('R1.list-tabs.redacted', leaks(JSON.stringify(tabs)).length === 0, { tabs })

    const shell = h.runtime.shellState()
    rec.record('R1.shell-state.redacted', leaks(JSON.stringify(shell.tabs)).length === 0, { shellTabs: shell.tabs })

    const nav = await h.call('browser_navigate', { tab: tabId, url: `ftp://user:pw@127.0.0.1/cb?token=ERRTOKEN777` }).then(() => null, (error) => error)
    rec.record('R1.refusal-error.redacted', nav !== null && nav.message.includes('token=****') && !nav.message.includes('ERRTOKEN777'), { message: nav?.message })

    const download = await h.call('browser_download', { url: `http://127.0.0.1:${server.port}/dl/report-${DLTOKEN}.zip?token=${DLTOKEN}` })
    await sleep(700)
    const downloads = await h.call('browser_downloads_list')
    const entry = downloads.downloads[0] ?? {}
    const downloadJson = JSON.stringify(downloads)
    rec.record('R1.downloads.fileName-and-url-redacted',
      download.started === true && entry.fileName === '****' && String(entry.url).includes('token=****') && !downloadJson.includes(CODE),
      { downloads })
    // Documented residual, asserted so it cannot regress silently: `path` stays
    // the real on-disk handle (downloads_open + file tools need it) and the
    // directory listing shows the same name anyway.
    const pathExists = typeof entry.path === 'string' && existsSync(entry.path)
    rec.record('R1.downloads.path-truthful-by-design (documented residual)',
      pathExists,
      { path: entry.path, exists: pathExists, note: 'basename is server/URL-derived; masking it would break downloads_open without hiding the string' })

    // The persisted ledger must not hold the cleartext URL either (the host
    // calls saveLedger on every state change; the probe triggers it directly).
    h.runtime.saveLedger()
    await sleep(200)
    const groups = await import('node:fs').then((fs) => {
      try { return fs.readFileSync(`${h.dir}/groups.jsonl`, 'utf8') } catch { return '' }
    })
    rec.record('R1.ledger-on-disk.redacted', groups.includes('****') && leaks(groups).length === 0, { groups: groups.slice(0, 240) })

    // ---------------------------------------------------------------- R-3
    await h.call('browser_fill_credentials', { tab: tabId, connectorId: 'short' })
    const text = await h.call('browser_get_text', { tab: tabId })
    rec.record('R3.short-secret.does-not-corrupt-prose', text.text.includes(`order ${SHORT} confirmed`), { text: text.text.slice(0, 200) })
    rec.record('R3.short-secret.value-shaped-occurrence-masked', text.text.includes('password=****'), { text: text.text.slice(0, 200) })
    // The pre-fix rule was a bare `text.includes(secret)` — reproduced on the
    // live page text to show what it did to ordinary prose.
    const oldRuleText = text.text.split(SHORT).join('****')
    rec.record('R3.red.bare-includes-would-corrupt-prose',
      oldRuleText.includes(`order **** confirmed`) && !oldRuleText.includes(`order ${SHORT} confirmed`),
      { oldRuleText: oldRuleText.slice(0, 200) })
    const shortReadBack = await h.call('browser_eval', { tab: tabId, expression: "document.querySelector('#pw').value" })
    rec.record('R3.short-secret.read-back-masked', !shortReadBack.result.includes(SHORT), { result: shortReadBack.result })

    await h.call('browser_fill_credentials', { tab: tabId, connectorId: 'long' })
    const longText = await h.call('browser_get_text', { tab: tabId })
    rec.record('R3.long-secret.still-masked-in-prose', !longText.text.includes(LONG) && longText.text.includes('is weak'), { text: longText.text.slice(0, 200) })

    // ---------------------------------------------------------------- R-2
    // RED premise part 1: on a tab WITHOUT injected credentials the same fetch
    // really leaves the renderer (the gate has something to close).
    const freeTab = await h.call('browser_open', { url: `http://127.0.0.1:${server.port}/free` })
    await waitFor(async () => (await h.call('browser_get_text', { tab: freeTab.tab, selector: '#go' })).text !== '', { label: 'free page ready' })
    exfil.length = 0
    const relayBefore = await h.call('browser_eval', { tab: freeTab.tab, expression: "__relay(document.querySelector('#pw').value)" })
    await sleep(600)
    rec.record('R2.red.uncCredentialed-tab-can-exfiltrate-via-eval', exfil.length === 1 && exfil[0].includes(encodeURIComponent(LONG)), { exfil: [...exfil], returned: relayBefore.result })

    // GREEN: the same expression on the credential tab is refused and nothing
    // reaches the network.
    exfil.length = 0
    const relayAfter = await h.call('browser_eval', { tab: tabId, expression: "__relay(document.querySelector('#pw').value)" }).then(() => null, (error) => error)
    await sleep(600)
    rec.record('R2.green.credential-tab.blocked-by-page-shim',
      relayAfter !== null && relayAfter.code === 'policy' && exfil.length === 0,
      { error: { code: relayAfter?.code, message: relayAfter?.message }, exfil: [...exfil] })

    // RED premise part 2, on the live credential tab: the page really holds the
    // injected password and a raw CDP fetch really carries it off — the gate,
    // not the page, is what closes this.
    exfil.length = 0
    const rawRead = (await rawTab.cdp.send('Runtime.evaluate', { expression: "document.querySelector('#pw').value", returnByValue: true })).result?.value
    await rawTab.cdp.send('Runtime.evaluate', { expression: "__relay(document.querySelector('#pw').value)", returnByValue: true, awaitPromise: true })
    await sleep(600)
    rec.record('R2.red.raw-cdp-on-credential-tab-still-exfiltrates',
      rawRead === LONG && exfil.length === 1 && exfil[0].includes(encodeURIComponent(LONG)),
      { rawRead, exfil: [...exfil], note: 'bypasses the runtime gate on purpose: the page itself has no defence' })
    exfil.length = 0

    const namedFetch = await h.call('browser_eval', { tab: tabId, expression: "fetch('/exfil?named=1')" }).then(() => null, (error) => error)
    await sleep(400)
    rec.record('R2.green.credential-tab.named-api-refused-statically',
      namedFetch !== null && namedFetch.code === 'policy' && exfil.length === 0,
      { error: { code: namedFetch?.code, message: namedFetch?.message }, exfil: [...exfil] })

    const xhr = await h.call('browser_eval', { tab: tabId, expression: "typeof XMLHttpRequest" }).then(() => null, (error) => error)
    rec.record('R2.green.credential-tab.xhr-named-anywhere-refused',
      xhr !== null && xhr.code === 'policy' && /XMLHttpRequest|xmlhttprequest/u.test(xhr.message), { error: xhr?.message })
    const beacon = await h.call('browser_eval', { tab: tabId, expression: "typeof navigator.sendBeacon" }).then(() => null, (error) => error)
    rec.record('R2.green.credential-tab.sendBeacon-refused', beacon !== null && beacon.code === 'policy', { error: beacon?.message })

    // Read-only access still works on the credential tab.
    const stillReads = await h.call('browser_eval', { tab: tabId, expression: "document.querySelectorAll('input').length" })
    rec.record('R2.green.credential-tab.reads-still-work', stillReads.result === '2', { result: stillReads.result })

    // The shim must restore the page's own APIs after the call.
    const restored = (await rawTab.cdp.send('Runtime.evaluate', { expression: 'typeof fetch', returnByValue: true })).result?.value
    const restoredXhr = (await rawTab.cdp.send('Runtime.evaluate', { expression: 'typeof XMLHttpRequest.prototype.open', returnByValue: true })).result?.value
    rec.record('R2.green.page-apis-restored-after-the-call', restored === 'function' && restoredXhr === 'function', { restored, restoredXhr })
  } finally {
    h.dispose()
    server.close()
  }

  const failures = rec.results.filter((r) => !r.pass)
  console.log(JSON.stringify({ results: rec.results, failures: failures.map((f) => f.name) }, null, 2))
  rec.write('outlet-egress-probe.json', { port: server.port, exfil: [...exfil] })
  return failures.length === 0 ? 0 : 1
})

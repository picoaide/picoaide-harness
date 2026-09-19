#!/usr/bin/env node
'use strict'

// 收编说明（L4 / 2026-09-20）：本文件由 **L2** 产出（temp/wasm-client-only/probe-browser-storage.cjs，
// 收编时 sha256=eec6fc1a00a901a3ed2a323823de3c14ae9473128fbea56111888aa5b869dea4）。L4 只做三处**附加**标注、未改动任何存储判定逻辑：
//   1) 平台覆盖声明（非 Linux 打印 [skip-note]，PROBE_REQUIRE_COVERED_PLATFORM=1 时按 77 显式 SKIP）；
//   2) OUT_PATH 支持 PROBE_OUT_DIR（门禁把证据落到 temp/wasm-client-only/gate-logs/），
//      缺省落点也从 __dirname 改为仓库内 temp/wasm-client-only（避免脚本目录出现未跟踪生成物）；
//   3) output.runtime 里补 platformCovered。
// W0D-14 已按主控裁定改为**反向期望**（put 被拒且错误含 scheme 不支持 ⇒ PASS）。

/**
 * W0-D — 自定义协议 origin 的浏览器存储隔离探针（真 Electron 主进程，不是 ELECTRON_RUN_AS_NODE）。
 *
 * 回答六个问题（设计文档 §7.5 / §17 认账 2 / §11.1 末行）：
 *   1. `picoaide-app://demo-a` 这类 standard+secure 自定义 scheme origin 里 localStorage 是否可用；
 *   2. indexedDB 是否可用；
 *   3. caches（Cache Storage）是否可用（`caches.open` 能成功；另单独判 `cache.put` 写能力）；
 *   4. 三个存储面各自是否按 origin 隔离（demo-a 写的 demo-b 读不到）；
 *   5. 同一 origin + 同一 persist: 分区里，写 → 重新加载页面 → 读回；
 *   6. 不同 persist: 分区之间同一 origin 是否隔离。
 *
 * 两条**实测踩过的坑**（写进产物，供复核）：
 *   a. `new BrowserWindow({ session })` 是**无效选项**（Electron 只认 `webPreferences.session`
 *      / `webPreferences.partition`）。用错时窗口静默跑在默认 session，于是分区里的
 *      handler/存储根本没被用到 —— 本探针因此记录每个窗口 `webContents.session.getPartition()`
 *      的**实际值**，不拿构造参数当证据（控制组 C1/C3 正是这条的对照）。
 *   b. `indexedDB.databases()` 在自定义 scheme origin 上**不 settle**（实测挂起）：任何
 *      "先列库再决定要不要 open" 的写法都会把整个探针卡死。本探针对每一步都加超时，
 *      并把该 API 的行为单独记为诊断项。
 *
 * 用法（必须与 xvfb-run 同一条命令，容器内 root 需 --no-sandbox）：
 *   cd /data/picoaide-harness && mkdir -p /tmp/probe-home/.config && \
 *     HOME=/tmp/probe-home XDG_CONFIG_HOME=/tmp/probe-home/.config xvfb-run -a \
 *     packages/host/desktop/node_modules/electron/dist/electron --no-sandbox \
 *     temp/wasm-client-only/probe-browser-storage.cjs
 *
 * 退出码：0 = 全部必须项 PASS；1 = 探针跑完但有 FAIL/UNKNOWN；2 = 探针无法运行（致命）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const electron = require('electron')
if (!electron || typeof electron !== 'object' || !electron.app) {
  console.error('[W0-D] FATAL: 不是真 Electron 主进程（require("electron") 返回的不是 API 对象）。')
  console.error('[W0-D] 本探针不能用 ELECTRON_RUN_AS_NODE / 纯 node 运行。')
  process.exit(2)
}
const { app, BrowserWindow, protocol, session } = electron

// ---------------------------------------------------------------------------
// 平台覆盖声明（**显式 skip，不静默**，L4 收编时统一加的约定）：本探针的结论目前只对
// Linux 有效 —— Windows / macOS 上的自定义协议行为未实测（设计总纲 §17 认账 1 /
// §16 W6 三平台待补）。非 Linux 仍照常执行全部断言，但额外打印 [skip-note] 且
// VERDICT 里 platformCovered=false；设 PROBE_REQUIRE_COVERED_PLATFORM=1 时按退出码 77
// 显式 SKIP（门禁 scripts/verify-wasm-client-only.sh 第 6 组对 77 记 SKIP 不记 FAIL）。
const PROBE_PLATFORM = process.platform
const PROBE_COVERED = PROBE_PLATFORM === "linux"
const PROBE_REQUIRE_COVERED = process.env.PROBE_REQUIRE_COVERED_PLATFORM === "1"
if (!PROBE_COVERED) {
  console.log(`[skip-note] platform=${PROBE_PLATFORM} 未覆盖：Windows/macOS 的自定义协议行为尚未实测（§17 认账 1 / W6 待补）；本平台结论不作为验收证据`)
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SCHEME = 'picoaide-app'
const PARTITION_X = 'persist:probe-x'
const PARTITION_Y = 'persist:probe-y'
const PARTITION_CTL = 'persist:probe-ctl'
const ORIGIN_A = `${SCHEME}://demo-a`
const ORIGIN_B = `${SCHEME}://demo-b`

const LS_KEY = 'probe:marker'
const IDB_NAME = 'probe-idb'
const CACHE_NAME = 'probe-cache'

const OUT_PATH = path.join(
  process.env.PROBE_OUT_DIR || path.join(__dirname, '..', '..', '..', 'temp', 'wasm-client-only'),
  'probe-browser-storage.json',
)
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const USER_DATA_DIR = path.join(os.tmpdir(), `picoaide-w0d-probe-${RUN_ID}`)
const KEEP_USER_DATA = process.argv.includes('--keep-userdata')

const POLL_TIMEOUT_MS = 8_000
const HARD_TIMEOUT_MS = 240_000
const STORAGE_SETTLE_MS = 350

/** 访问计划标签（buildChecks 与 main 共用）。 */
const PLAN_LABEL = {
  X_A_WRITE: 'X.A.write',
  X_A_READ: 'X.A.read.afterWrite',
  X_B_READ_BEFORE: 'X.B.read.beforeWrite',
  X_B_WRITE: 'X.B.write',
  X_B_READ_AFTER: 'X.B.read.afterWrite',
  X_A_READ_AFTER_B: 'X.A.read.afterBWrite',
  Y_A_READ_BEFORE: 'Y.A.read.beforeWrite',
  Y_A_WRITE: 'Y.A.write',
  Y_A_READ_AFTER: 'Y.A.read.afterWrite',
}

// 与 packages/host/wasm-apps-host/src/electron-adapter.ts:61-71 逐字一致的权限位。
const SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: false,
  stream: true,
  codeCache: true,
}

// ---------------------------------------------------------------------------
// 主页面脚本（被 toString() 后内联进 HTML；只能引用浏览器全局）
// ---------------------------------------------------------------------------

function pageEntry() {
  var LS_KEY = 'probe:marker'
  var IDB_NAME = 'probe-idb'
  var IDB_STORE = 'kv'
  var IDB_KEY = 'marker'
  var CACHE_NAME = 'probe-cache'
  var CACHE_ENTRY = '/probe-entry'
  var STEP_TIMEOUT_MS = 3000
  var LIST_TIMEOUT_MS = 1500

  function describeError(e) {
    if (e === null || e === undefined) return 'thrown:' + String(e)
    var name = e && e.name ? String(e.name) : (e && e.constructor && e.constructor.name) || 'Error'
    var msg = e && e.message !== undefined ? String(e.message) : String(e)
    return name + ': ' + msg
  }

  /** 每一步都有上限：任何 API 不 settle 都不能把整个探针拖死（实测 databases() 会挂起）。 */
  function withTimeout(promise, ms, label) {
    return Promise.race([
      Promise.resolve(promise).then(
        function (v) { return { ok: true, value: v } },
        function (e) { return { ok: false, error: describeError(e) } },
      ),
      new Promise(function (resolve) {
        setTimeout(function () { resolve({ ok: false, error: 'TIMEOUT after ' + ms + 'ms: ' + label }) }, ms)
      }),
    ])
  }

  function safeType(reader) {
    try { return typeof reader() } catch (e) { return 'throws(' + describeError(e) + ')' }
  }

  function listKeys(store) {
    try {
      var out = []
      for (var i = 0; i < store.length; i++) out.push(store.key(i))
      return out
    } catch (e) { return null }
  }

  // --- localStorage（同步 API，但仍隔离异常）--------------------------------
  function localStorageSurface(op, marker) {
    var out = {
      surface: 'localStorage', present: false, error: null, writeError: null,
      observed: null, wrote: false, keysBefore: null, keysAfter: null, timedOut: false,
    }
    var store
    try {
      store = window.localStorage
      if (store === undefined || store === null) { out.error = 'localStorage is ' + String(store); return out }
    } catch (e) { out.error = describeError(e); return out }
    out.present = true
    out.keysBefore = listKeys(store)
    try {
      if (op === 'write') { store.setItem(LS_KEY, marker); out.wrote = true }
      out.observed = store.getItem(LS_KEY)
      out.keysAfter = listKeys(store)
    } catch (e) {
      if (op === 'write') out.writeError = describeError(e)
      else out.error = describeError(e)
    }
    return out
  }

  // --- IndexedDB ------------------------------------------------------------
  // 实测坑（同页面内对拍，见 W0D-D3 证据）：自定义协议 origin 上 `indexedDB.databases()`
  // 的 **req.onsuccess 永不触发**（4s 无事件），但 **IDBRequest.then() 6ms 就返回**。
  // 因此这里只用 promise 形式；其它 IDB 调用（open/put/get 的 onsuccess/oncomplete）实测正常。
  function idbListNames(idb) {
    if (typeof idb.databases !== 'function') return Promise.resolve(null)
    try {
      return Promise.resolve(idb.databases()).then(
        function (rows) { return (rows || []).map(function (d) { return d && d.name }) },
        function () { return null },
      )
    } catch (e) { return Promise.resolve(null) }
  }

  /** 一次性对拍：同一 API 的回调写法在该 origin 上是否触发（证据落盘，不参与判定门控）。 */
  function idbEventFormProbe(idb) {
    return new Promise(function (resolve) {
      try {
        var req = idb.databases()
        var settled = false
        req.onsuccess = function () {
          if (settled) return
          settled = true
          try { resolve({ fired: true, databaseNames: (req.result || []).map(function (d) { return d && d.name }) }) } catch (e) { resolve({ fired: true, error: describeError(e) }) }
        }
        req.onerror = function () { if (!settled) { settled = true; resolve({ fired: 'error' }) } }
        setTimeout(function () {
          if (!settled) { settled = true; resolve({ fired: false, note: 'req.onsuccess never fired within 1500ms (promise form works)' }) }
        }, 1500)
      } catch (e) { resolve({ fired: 'threw', error: describeError(e) }) }
    })
  }

  function idbOpen(idb) {
    return new Promise(function (resolve, reject) {
      var req = idb.open(IDB_NAME, 1)
      req.onupgradeneeded = function () {
        var db = req.result
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
      }
      req.onsuccess = function () { resolve(req.result) }
      req.onerror = function () { reject(req.error || new Error('indexedDB.open error')) }
      req.onblocked = function () { reject(new Error('indexedDB.open blocked')) }
    })
  }

  function idbWrite(idb, marker) {
    return new Promise(function (resolve, reject) {
      idbOpen(idb).then(function (db) {
        var tx = db.transaction(IDB_STORE, 'readwrite')
        tx.objectStore(IDB_STORE).put(marker, IDB_KEY)
        tx.oncomplete = function () { db.close(); resolve(true) }
        tx.onerror = function () { db.close(); reject(tx.error || new Error('idb tx error')) }
        tx.onabort = function () { db.close(); reject(tx.error || new Error('idb tx abort')) }
      }, reject)
    })
  }

  function idbRead(idb) {
    return new Promise(function (resolve, reject) {
      idbOpen(idb).then(function (db) {
        var tx = db.transaction(IDB_STORE, 'readonly')
        var req = tx.objectStore(IDB_STORE).get(IDB_KEY)
        req.onsuccess = function () { var v = req.result; db.close(); resolve(v === undefined ? null : v) }
        req.onerror = function () { db.close(); reject(req.error || new Error('idb get error')) }
      }, reject)
    })
  }

  function indexedDBSurface(op, marker, wantEventFormProbe) {
    var out = {
      surface: 'indexedDB', present: false, error: null, writeError: null, observed: null,
      wrote: false, openSucceeded: false, databaseNames: null, databasesApi: 'not-run',
      databasesError: null, databasesEventForm: null, timedOut: false, note: null,
    }
    var idb
    try {
      idb = window.indexedDB
      if (idb === undefined || idb === null) { out.error = 'indexedDB is ' + String(idb); return Promise.resolve(out) }
    } catch (e) { out.error = describeError(e); return Promise.resolve(out) }
    out.present = true

    // 只在第一个访问点做一次"回调写法 vs promise 写法"对拍（证据落盘，1.5s 一次性成本）。
    var finish = function () {
      if (!wantEventFormProbe) return Promise.resolve(out)
      return idbEventFormProbe(idb).then(function (r) { out.databasesEventForm = r; return out })
    }

    return withTimeout(idbListNames(idb), LIST_TIMEOUT_MS, 'indexedDB.databases()').then(function (listed) {
      if (listed.ok && listed.value) { out.databasesApi = 'ok(promise form)'; out.databaseNames = listed.value }
      else if (listed.ok) { out.databasesApi = 'unsupported' }
      else {
        out.databasesApi = listed.error.indexOf('TIMEOUT') === 0 ? 'TIMEOUT' : 'error'
        out.databasesError = listed.error
      }

      if (op !== 'write') {
        // 读路径必须是**纯读**：先看 databases() 的列表，库里没有就根本不要 open
        // （open 会创建空库，反而污染"这里本来什么都没有"的证据 —— 踩过）。
        var names = out.databaseNames
        if (Array.isArray(names) && names.indexOf(IDB_NAME) < 0) {
          out.observed = null
          out.note = 'database absent per indexedDB.databases(); open() skipped so this read creates nothing'
          return finish()
        }
        out.openSucceeded = true
        return withTimeout(idbRead(idb), STEP_TIMEOUT_MS, 'idb read').then(function (r) {
          if (!r.ok) {
            if (r.error.indexOf('TIMEOUT') === 0) out.timedOut = true
            out.error = r.error
            return out
          }
          out.observed = r.value
          return out
        }).then(finish)
      }

      return withTimeout(idbWrite(idb, marker), STEP_TIMEOUT_MS, 'idb write tx').then(function (w) {
        if (!w.ok) {
          if (w.error.indexOf('TIMEOUT') === 0) out.timedOut = true
          out.writeError = w.error
          return out
        }
        out.wrote = true
        out.openSucceeded = true
        return withTimeout(idbRead(idb), STEP_TIMEOUT_MS, 'idb readback').then(function (r) {
          if (!r.ok) { out.writeError = r.error; return out }
          out.observed = r.value
          out.writeReadback = r.value
          return withTimeout(idbListNames(idb), LIST_TIMEOUT_MS, 'idb databases after write').then(function (l2) {
            if (l2.ok && l2.value) out.databaseNamesAfterWrite = l2.value
            return out
          })
        }).then(finish)
      })
    })
  }

  // --- Cache Storage --------------------------------------------------------
  function cacheStorageSurface(op, marker) {
    var out = {
      surface: 'cacheStorage', present: false, error: null, writeError: null, matchError: null,
      observed: null, wrote: false, openSucceeded: false, cacheNames: null, cacheNamesAfter: null,
      putSupported: null, putError: null, hasEntry: null, timedOut: false, note: null,
    }
    var cs
    try {
      cs = window.caches
      if (cs === undefined || cs === null) { out.error = 'caches is ' + String(cs); return Promise.resolve(out) }
    } catch (e) { out.error = describeError(e); return Promise.resolve(out) }
    out.present = true

    return withTimeout(cs.keys(), STEP_TIMEOUT_MS, 'caches.keys()').then(function (k) {
      if (!k.ok) { out.error = k.error; return out }
      out.cacheNames = k.value

      if (op === 'write') {
        return withTimeout(cs.open(CACHE_NAME), STEP_TIMEOUT_MS, 'caches.open()').then(function (o) {
          if (!o.ok) { out.writeError = o.error; return out }
          out.openSucceeded = true
          out.wrote = true
          return withTimeout(
            o.value.put(new Request(CACHE_ENTRY), new Response(marker, { headers: { 'content-type': 'text/plain' } })),
            STEP_TIMEOUT_MS, 'cache.put()',
          ).then(function (p) {
            if (p.ok) out.putSupported = true
            else { out.putSupported = false; out.putError = p.error }
            if (!out.putSupported) return out
            return withTimeout(o.value.match(CACHE_ENTRY), STEP_TIMEOUT_MS, 'cache.match()').then(function (m) {
              if (!m.ok) { out.matchError = m.error; return out }
              out.hasEntry = !!m.value
              if (!m.value) return out
              return withTimeout(m.value.text(), STEP_TIMEOUT_MS, 'response.text()').then(function (t) {
                if (t.ok) out.observed = t.value
                else out.matchError = t.error
                return out
              })
            })
          })
        }).then(function (res) {
          return withTimeout(cs.keys(), STEP_TIMEOUT_MS, 'caches.keys() after write').then(function (k2) {
            if (k2.ok) out.cacheNamesAfter = k2.value
            return res
          })
        })
      }

      if ((out.cacheNames || []).indexOf(CACHE_NAME) < 0) {
        out.observed = null
        out.note = 'this origin has no cache named ' + CACHE_NAME
        return out
      }
      out.openSucceeded = true
      return withTimeout(cs.open(CACHE_NAME), STEP_TIMEOUT_MS, 'caches.open() read').then(function (o) {
        if (!o.ok) { out.error = o.error; return out }
        return withTimeout(o.value.match(CACHE_ENTRY), STEP_TIMEOUT_MS, 'cache.match()').then(function (m) {
          if (!m.ok) { out.matchError = m.error; return out }
          out.hasEntry = !!m.value
          if (!m.value) { out.observed = null; return out }
          return withTimeout(m.value.text(), STEP_TIMEOUT_MS, 'response.text()').then(function (t) {
            if (t.ok) out.observed = t.value
            else out.matchError = t.error
            return out
          })
        })
      })
    })
  }

  // --- driver --------------------------------------------------------------
  function runProbe() {
    var params = new URLSearchParams(location.search)
    var op = params.get('op') || 'read'
    var runId = params.get('run') || 'no-run-id'
    var wantEventFormProbe = params.get('idbEventProbe') === '1'
    var marker = runId + '|' + location.host
    var result = {
      label: params.get('label') || '',
      op: op,
      runId: runId,
      marker: marker,
      origin: location.origin,
      href: location.href,
      host: location.host,
      protocol: location.protocol,
      isSecureContext: !!window.isSecureContext,
      crossOriginIsolated: !!window.crossOriginIsolated,
      apiTypes: {
        localStorage: safeType(function () { return window.localStorage }),
        indexedDB: safeType(function () { return window.indexedDB }),
        caches: safeType(function () { return window.caches }),
      },
      trace: [],
      surfaces: {},
    }
    function mark(step) { result.trace.push(step + '@' + Date.now()) }

    return Promise.resolve()
      .then(function () { mark('start'); result.surfaces.localStorage = localStorageSurface(op, marker); mark('localStorage') })
      .then(function () { return indexedDBSurface(op, marker, wantEventFormProbe) })
      .then(function (s) { result.surfaces.indexedDB = s; mark('indexedDB') })
      .then(function () { return cacheStorageSurface(op, marker) })
      .then(function (s) { result.surfaces.cacheStorage = s; mark('cacheStorage') })
      .then(function () { mark('done'); return result })
  }

  window.__probe = { done: false, result: null, error: null }
  try {
    runProbe().then(function (r) {
      window.__probe = { done: true, result: r, error: null }
      try { console.log('[W0-D] ' + JSON.stringify(r)) } catch (e) { /* ignore */ }
    }, function (e) {
      window.__probe = { done: true, result: null, error: describeError(e) }
      console.log('[W0-D][page-error] ' + describeError(e))
    })
  } catch (e) {
    window.__probe = { done: true, result: null, error: describeError(e) }
    console.log('[W0-D][page-error] ' + describeError(e))
  }
}

/** 控制组页面：与主页面脚本**完全独立**（主脚本出问题时控制组仍能判定）。 */
function controlEntry() {
  var out = { done: true, origin: location.origin, href: location.href, secure: !!window.isSecureContext, ls: null }
  try {
    window.localStorage.setItem('ctl', 'ctl-value')
    out.ls = window.localStorage.getItem('ctl')
  } catch (e) {
    out.ls = 'ERR ' + ((e && e.name) || String(e))
  }
  window.__ctl = out
}

const MAIN_HTML = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>W0-D browser storage probe</title></head>',
  '<body><p id="w0d">W0-D storage probe</p>',
  '<script>(' + pageEntry.toString() + ')();<\/script>',
  '</body></html>',
].join('\n')

const CONTROL_HTML = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>W0-D control</title></head>',
  '<body><p id="ctl">control</p>',
  '<script>(' + controlEntry.toString() + ')();<\/script>',
  '</body></html>',
].join('\n')

// ---------------------------------------------------------------------------
// 启动期设置
// ---------------------------------------------------------------------------

fs.mkdirSync(USER_DATA_DIR, { recursive: true })
app.setPath('userData', USER_DATA_DIR)
app.commandLine.appendSwitch('disable-dev-shm-usage')
app.disableHardwareAcceleration()

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: SCHEME_PRIVILEGES }])

const hardTimer = setTimeout(() => {
  console.error(`[W0-D] FATAL: hard timeout after ${HARD_TIMEOUT_MS}ms`)
  process.exit(2)
}, HARD_TIMEOUT_MS)
hardTimer.unref?.()

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 每次协议请求的记录：**哪一个 session 的 handler 真的服务了这次导航**，
 *  这是"窗口是否真的绑在该分区上"最硬的运行期证据（Electron 43.4.0 没有 Session.getPartition()）。 */
const protocolLog = []

/** 每个 session 只允许注册一次（同一 session 重复 `protocol.handle` 会抛 Failed to register protocol）。 */
const registeredSessions = new WeakSet()

function registerHandler(ses, label, html) {
  if (registeredSessions.has(ses)) throw new Error(`protocol.handle(${SCHEME}) already registered for ${label}`)
  registeredSessions.add(ses)
  ses.protocol.handle(SCHEME, makeHandler(label, html))
}

function makeHandler(label, html) {
  return (request) => {
    protocolLog.push({ session: label, method: request.method, url: request.url, at: Date.now() })
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

/** 窗口**实际生效**的 session 证据（不拿构造参数当证据）。
 *  注：`Session.getPartition()` 在 Electron 43.4.0 不存在（electron.d.ts 只有 getStoragePath），
 *  所以用「对象同一性 + 存储路径 + 服务该导航的 handler 标签」三件套代替。 */
function sessionEvidence(win, expectedSession, expectedLabel, logFrom) {
  let actual = null
  try { actual = win.webContents.session } catch (e) { actual = null }
  let storagePath = null
  try { storagePath = actual.getStoragePath() } catch (e) { storagePath = 'unavailable:' + String((e && e.message) || e) }
  return {
    expectedLabel: expectedLabel || null,
    servedBy: protocolLog.slice(logFrom === undefined ? 0 : logFrom).map((e) => e.session),
    sameObjectAsIntendedSession: expectedSession ? actual === expectedSession : null,
    isDefaultSession: actual === session.defaultSession,
    storagePath,
    getPartitionApi: typeof (actual && actual.getPartition) === 'function' ? 'present' : 'ABSENT in Electron 43.4.0 (use session identity + storagePath + servedBy)',
  }
}

async function pollPageResult(webContents, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let raw = null
    try {
      raw = await webContents.executeJavaScript(
        '(window.__probe && window.__probe.done) ? JSON.stringify(window.__probe) : ""',
        true,
      )
    } catch (e) { raw = null }
    if (typeof raw === 'string' && raw.length > 0) return JSON.parse(raw)
    if (Date.now() > deadline) throw new Error('timed out waiting for in-page probe result')
    await delay(120)
  }
}

async function visit(win, label, host, op, visits) {
  const idbEventProbe = label === PLAN_LABEL.X_A_WRITE ? '&idbEventProbe=1' : ''
  const url = `${SCHEME}://${host}/visit?op=${op}&run=${encodeURIComponent(RUN_ID)}&label=${encodeURIComponent(label)}${idbEventProbe}&t=${Date.now()}`
  const logFrom = protocolLog.length
  const record = {
    label, host, op, expectedOrigin: `${SCHEME}://${host}`, url,
    result: null, error: null, diagnostics: null, console: [], session: null,
  }
  const onConsole = (...args) => {
    const first = args[0]
    let message
    if (first && typeof first === 'object' && typeof first.message === 'string') message = first.message
    else if (typeof args[1] === 'string') message = args[1]
    else message = String(first)
    if (record.console.length < 20) record.console.push(message.slice(0, 4000))
  }
  win.webContents.on('console-message', onConsole)
  try {
    await win.loadURL(url)
    const envelope = await pollPageResult(win.webContents, POLL_TIMEOUT_MS)
    if (envelope.error) throw new Error('page reported error: ' + envelope.error)
    if (!envelope.result) throw new Error('page returned no result')
    record.result = envelope.result
  } catch (e) {
    record.error = String((e && e.message) || e)
    try {
      record.diagnostics = await win.webContents.executeJavaScript(
        `JSON.stringify({
          readyState: document.readyState, href: location.href, origin: location.origin,
          probeType: typeof window.__probe, probe: window.__probe || null,
          isSecureContext: window.isSecureContext
        })`, true,
      )
    } catch (e2) {
      record.diagnostics = 'diagnostics failed: ' + String((e2 && e2.message) || e2)
    }
  } finally {
    win.webContents.removeListener('console-message', onConsole)
  }
  record.session = sessionEvidence(win, null, null, logFrom)
  visits.push(record)
  console.log(`[W0-D][visit] ${label} -> ${record.error ? 'ERROR ' + record.error : 'ok origin=' + record.result.origin} servedBy=${JSON.stringify(record.session.servedBy)} storagePath=${record.session.storagePath}`)
  if (record.error) {
    for (const line of record.console) console.log(`[W0-D][visit-console] ${label}: ${line}`)
    if (record.diagnostics) console.log(`[W0-D][visit-diagnostics] ${label}: ${record.diagnostics}`)
  }
  return record
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

const SURFACE_LABEL = {
  localStorage: 'localStorage',
  indexedDB: 'indexedDB',
  cacheStorage: 'Cache Storage (caches)',
}

function surfaceAt(byLabel, label, surface) {
  const v = byLabel[label]
  if (!v || !v.result || !v.result.surfaces) return null
  return v.result.surfaces[surface] || null
}

/** 该访问点是否读回了自己的 marker（Cache 在 put 不受支持时退化为缓存名存在性）。 */
function sawOwnMarker(surface, point, marker, writePoint) {
  if (!point) return { ok: false, mode: 'none', detail: 'no page result' }
  if (point.present !== true) return { ok: false, mode: 'none', detail: `API 不可用: ${point.error || 'not present'}` }
  if (surface === 'cacheStorage' && writePoint && writePoint.putSupported !== true) {
    const names = point.cacheNames || []
    return { ok: names.indexOf(CACHE_NAME) >= 0, mode: 'cache-name', detail: { mode: 'cache-name (entry level impossible: cache.put unsupported)', cacheNames: names } }
  }
  return { ok: point.observed === marker, mode: 'value', detail: { observed: point.observed } }
}

/** 该访问点是否"什么都没有"（本 run 从未写过东西到这里）。 */
function sawNothing(surface, point) {
  if (!point) return { ok: false, detail: 'no page result' }
  if (point.present !== true) return { ok: false, detail: `API 不可用: ${point.error || 'not present'}` }
  const detail = {
    observed: point.observed, databaseNames: point.databaseNames,
    cacheNames: point.cacheNames, note: point.note || null,
  }
  if (surface === 'localStorage') return { ok: point.observed === null, detail }
  if (surface === 'indexedDB') {
    const names = point.databaseNames
    const dbAbsent = names === null ? true : names.indexOf(IDB_NAME) < 0
    return { ok: point.observed === null && dbAbsent, detail }
  }
  const names = point.cacheNames
  const nameAbsent = names === null ? true : names.indexOf(CACHE_NAME) < 0
  return { ok: point.observed === null && nameAbsent, detail }
}

function slim(point) {
  if (!point) return null
  return {
    present: point.present, error: point.error, writeError: point.writeError, wrote: point.wrote,
    openSucceeded: point.openSucceeded, observed: point.observed, cacheNames: point.cacheNames,
    putSupported: point.putSupported, putError: point.putError, databaseNames: point.databaseNames,
    databaseNamesAfterWrite: point.databaseNamesAfterWrite,
    databasesApi: point.databasesApi, databasesEventForm: point.databasesEventForm,
    timedOut: point.timedOut, note: point.note || null,
  }
}

function availabilityProblems(surface, writeA, writeB, markerA, markerB) {
  const problems = []
  for (const [who, point, marker] of [['demo-a', writeA, markerA], ['demo-b', writeB, markerB]]) {
    if (!point) { problems.push(`${who}: 无页面结果`); continue }
    if (point.present !== true) problems.push(`${who}: API 不存在 (${point.error || 'not present'})`)
    if (point.error) problems.push(`${who}: ${point.error}`)
    if (point.writeError) problems.push(`${who}: 写入异常 ${point.writeError}`)
    if (point.wrote !== true) problems.push(`${who}: 写入未执行`)
    if (surface === 'cacheStorage') {
      // 判据只到 caches.open（本项定义），写入能力另立 W0D-14。
      if (point.openSucceeded !== true) problems.push(`${who}: caches.open() 未成功`)
      if (point.putSupported === true && point.observed !== marker) {
        problems.push(`${who}: 回读 ${JSON.stringify(point.observed)} !== marker`)
      }
    } else if (point.observed !== marker) {
      problems.push(`${who}: 回读 ${JSON.stringify(point.observed)} !== 写入的 marker`)
    }
  }
  return problems
}

function buildChecks(visits, controls) {
  const byLabel = {}
  for (const v of visits) byLabel[v.label] = v

  const markerA = `${RUN_ID}|demo-a`
  const markerB = `${RUN_ID}|demo-b`
  const checks = []
  const surfaces = ['localStorage', 'indexedDB', 'cacheStorage']

  // W0D-00 正向对照：默认 session 能加载自定义协议并跑通页面 JS
  const c3 = controls.c3 || null
  const c3ok = !!(c3 && c3.load && c3.load.ok && c3.page && c3.page.done === true)
  checks.push({
    id: 'W0D-00-positive-control-default-session',
    title: `正向对照：默认 session 下 loadURL(${ORIGIN_A}/…) 成功且页面 JS 跑通（区分"探针坏"与"分区内不可加载"）`,
    required: true,
    verdict: c3ok ? 'PASS' : 'FAIL',
    evidence: { windowSession: c3 && c3.session, load: c3 && c3.load, page: c3 && c3.page },
  })

  // W0D-01..03 可用性
  const availabilityIdx = {}
  surfaces.forEach((surface, i) => {
    const writeA = surfaceAt(byLabel, PLAN_LABEL.X_A_WRITE, surface)
    const writeB = surfaceAt(byLabel, PLAN_LABEL.X_B_WRITE, surface)
    const problems = availabilityProblems(surface, writeA, writeB, markerA, markerB)
    availabilityIdx[surface] = checks.length
    const crit = surface === 'cacheStorage'
      ? 'caches.open() 成功（caches 存在且是对象）'
      : '写入后回读得到自己的 marker'
    checks.push({
      id: `W0D-0${1 + i}-available-${surface}`,
      title: `${SURFACE_LABEL[surface]} 在 ${ORIGIN_A} / ${ORIGIN_B} 可用（${crit}；非 SecurityError / 非 undefined）`,
      required: true,
      verdict: problems.length === 0 ? 'PASS' : 'FAIL',
      evidence: { originA: ORIGIN_A, originB: ORIGIN_B, partition: PARTITION_X, problems, raw: { 'demo-a': slim(writeA), 'demo-b': slim(writeB) } },
    })
  })

  // W0D-04..06 origin 隔离
  surfaces.forEach((surface, i) => {
    const writeA = surfaceAt(byLabel, PLAN_LABEL.X_A_WRITE, surface)
    const writeB = surfaceAt(byLabel, PLAN_LABEL.X_B_WRITE, surface)
    const avail = checks[availabilityIdx[surface]].verdict
    const bBefore = surfaceAt(byLabel, PLAN_LABEL.X_B_READ_BEFORE, surface)
    const aAfterB = surfaceAt(byLabel, PLAN_LABEL.X_A_READ_AFTER_B, surface)
    const nothing = sawNothing(surface, bBefore)
    const ownA = sawOwnMarker(surface, aAfterB, markerA, writeA)
    const leakB = aAfterB && aAfterB.observed === markerB
    let verdict = 'UNKNOWN'
    const problems = []
    if (avail !== 'PASS') {
      problems.push(`${SURFACE_LABEL[surface]} 可用性未 PASS，无法判定隔离`)
    } else {
      if (!nothing.ok) problems.push(`demo-b 在写入前就看到数据（应为空）: ${JSON.stringify(nothing.detail)}`)
      if (!ownA.ok) problems.push(`demo-a 在 demo-b 写入后读不到自己的值: ${JSON.stringify(ownA.detail)}`)
      if (leakB) problems.push('demo-a 读到了 demo-b 的 marker')
      if (!(writeB && writeB.wrote === true)) problems.push('demo-b 的写入未执行（无法证明其存储面自身可用）')
      verdict = problems.length === 0 ? 'PASS' : 'FAIL'
    }
    checks.push({
      id: `W0D-0${4 + i}-origin-isolation-${surface}`,
      title: `${SURFACE_LABEL[surface]} 按 origin 隔离：${ORIGIN_A} 写的数据在 ${ORIGIN_B} 读不到`,
      required: true,
      verdict,
      evidence: {
        partition: PARTITION_X, level: surface === 'cacheStorage' ? 'cache-name' : 'value',
        demoBBeforeAnyWrite: nothing.detail, demoAAfterBWrite: ownA.detail,
        demoBMarkerLeakedIntoA: !!leakB, markerA, markerB, problems,
        cacheEntryLevelNote: surface === 'cacheStorage'
          ? 'entry level impossible on this scheme: cache.put() rejects (Request scheme unsupported)'
          : null,
      },
    })
  })

  // W0D-07..09 同 origin + 同分区 往返
  surfaces.forEach((surface, i) => {
    const writeA = surfaceAt(byLabel, PLAN_LABEL.X_A_WRITE, surface)
    const readA = surfaceAt(byLabel, PLAN_LABEL.X_A_READ, surface)
    const avail = checks[availabilityIdx[surface]].verdict
    let verdict = 'UNKNOWN'
    const problems = []
    if (avail !== 'PASS') {
      problems.push(`${SURFACE_LABEL[surface]} 可用性未 PASS，无法判定往返`)
    } else {
      const seen = sawOwnMarker(surface, readA, markerA, writeA)
      if (!seen.ok) problems.push(`重新加载页面后读回 ${JSON.stringify(seen.detail)}，期望 marker=${markerA}`)
      verdict = problems.length === 0 ? 'PASS' : 'FAIL'
    }
    checks.push({
      id: `W0D-0${7 + i}-roundtrip-same-origin-same-partition-${surface}`,
      title: `${SURFACE_LABEL[surface]} 同 origin + 同分区往返可读（写 → 重新加载页面 → 读回）`,
      required: true,
      verdict,
      evidence: {
        partition: PARTITION_X, origin: ORIGIN_A, writtenMarker: markerA,
        level: surface === 'cacheStorage' ? 'cache-name' : 'value',
        observedAfterReload: slim(readA), problems,
        cacheEntryLevelNote: surface === 'cacheStorage'
          ? 'entry level impossible on this scheme: cache.put() rejects (Request scheme unsupported)'
          : null,
      },
    })
  })

  // W0D-10..12 跨分区隔离
  surfaces.forEach((surface, i) => {
    const yBefore = surfaceAt(byLabel, PLAN_LABEL.Y_A_READ_BEFORE, surface)
    const yWrite = surfaceAt(byLabel, PLAN_LABEL.Y_A_WRITE, surface)
    const yAfter = surfaceAt(byLabel, PLAN_LABEL.Y_A_READ_AFTER, surface)
    const avail = checks[availabilityIdx[surface]].verdict
    let verdict = 'UNKNOWN'
    const problems = []
    if (avail !== 'PASS') {
      problems.push(`${SURFACE_LABEL[surface]} 可用性未 PASS，无法判定跨分区隔离`)
    } else {
      const nothing = sawNothing(surface, yBefore)
      if (!nothing.ok) problems.push(`新分区 ${PARTITION_Y} 里 ${ORIGIN_A} 一开始就有数据（应从 ${PARTITION_X} 隔离）: ${JSON.stringify(nothing.detail)}`)
      if (!(yWrite && yWrite.wrote === true)) problems.push('新分区里的写入未执行')
      const own = sawOwnMarker(surface, yAfter, markerA, yWrite)
      if (!own.ok) problems.push(`新分区里自己写的值读不回: ${JSON.stringify(own.detail)}`)
      verdict = problems.length === 0 ? 'PASS' : 'FAIL'
    }
    const yBeforeVisit = byLabel[PLAN_LABEL.Y_A_READ_BEFORE]
    const yAfterVisit = byLabel[PLAN_LABEL.Y_A_READ_AFTER]
    checks.push({
      id: `W0D-1${i}-partition-isolation-${surface}`,
      title: `${SURFACE_LABEL[surface]} 按 persist: 分区隔离（${PARTITION_X} 与 ${PARTITION_Y} 各自独立）`,
      required: true,
      verdict,
      evidence: {
        origin: ORIGIN_A,
        partitionX: PARTITION_X, partitionY: PARTITION_Y,
        windowSessionInY: yBeforeVisit && yBeforeVisit.session,
        freshPartitionReadBeforeAnyWrite: slim(yBefore),
        freshPartitionAfterOwnWrite: slim(yAfter),
        level: surface === 'cacheStorage' ? 'cache-name' : 'value',
        problems,
      },
    })
  })

  // W0D-13 窗口真的绑在分区上（servedBy + session 同一性 + 存储路径，不拿构造参数当证据）
  const xVisit = byLabel[PLAN_LABEL.X_A_WRITE]
  const yVisit = byLabel[PLAN_LABEL.Y_A_WRITE]
  const yLaterVisit = byLabel[PLAN_LABEL.Y_A_READ_AFTER]
  const c1 = controls.c1 || null
  const bindingProblems = []
  const servedByX = (xVisit && xVisit.session && xVisit.session.servedBy) || []
  const servedByY = (yVisit && yVisit.session && yVisit.session.servedBy) || []
  if (servedByX.length !== 1 || servedByX[0] !== PARTITION_X) {
    bindingProblems.push(`X 分区的导航不是由 ${PARTITION_X} 的 handler 服务的：servedBy=${JSON.stringify(servedByX)}`)
  }
  if (servedByY.length !== 1 || servedByY[0] !== PARTITION_Y) {
    bindingProblems.push(`Y 分区的导航不是由 ${PARTITION_Y} 的 handler 服务的：servedBy=${JSON.stringify(servedByY)}`)
  }
  const xPath = xVisit && xVisit.session && xVisit.session.storagePath
  const yPath = yLaterVisit && yLaterVisit.session && yLaterVisit.session.storagePath
  if (!(typeof xPath === 'string' && xPath.indexOf('probe-x') >= 0)) {
    bindingProblems.push(`X 窗口的 session 存储路径不含 probe-x：${JSON.stringify(xPath)}`)
  }
  if (!(typeof yPath === 'string' && yPath.indexOf('probe-y') >= 0)) {
    bindingProblems.push(`Y 窗口的 session 存储路径不含 probe-y：${JSON.stringify(yPath)}`)
  }
  if (!(c1 && c1.session && c1.session.isDefaultSession === true)) {
    bindingProblems.push(`控制组 C1：顶层 session 选项的窗口实际应落在默认 session，实测 ${JSON.stringify(c1 && c1.session)}`)
  }
  if (!(c1 && c1.load && c1.load.ok === false)) {
    bindingProblems.push('控制组 C1：未绑定分区的窗口本应加载失败（分区 handler 不生效）')
  }
  checks.push({
    id: 'W0D-13-window-partition-binding',
    title: '每个窗口都真的绑在目标分区上（servedBy + session 同一性 + getStoragePath() 实证；顶层 session 选项无效由控制组 C1 证）',
    required: true,
    verdict: bindingProblems.length === 0 ? 'PASS' : 'FAIL',
    evidence: {
      X: xVisit && xVisit.session, Y: yLaterVisit && yVisit && yVisit.session,
      C1_invalidTopLevelSessionOption: c1,
      note: 'new BrowserWindow({ session }) 是无效选项；必须 webPreferences.session / webPreferences.partition。'
        + ' Electron 43.4.0 无 Session.getPartition()（electron.d.ts:13162 只有 getStoragePath()），故用三件套代替。',
      problems: bindingProblems,
    },
  })

  // W0D-14 Cache Storage 写能力（自定义 scheme 上的实测结论）
  //
  // **反向期望**（主控 2026-09-19 裁定，对齐总纲 §3 F13）：在自定义协议 origin 上
  // `caches.open()` 可以成功，但 `cache.put()` 抛
  // `TypeError: Failed to execute 'put' on 'Cache': Request scheme '<scheme>' is unsupported`
  // ⇒ 冻结口径是"允许 localStorage / IndexedDB，**禁止依赖 Cache Storage**"。
  // 把 put 成功当 required 会永远红，且会把"平台限制"误报成"探针失败"。
  const cacheWriteA = surfaceAt(byLabel, PLAN_LABEL.X_A_WRITE, 'cacheStorage')
  const cacheWriteB = surfaceAt(byLabel, PLAN_LABEL.X_B_WRITE, 'cacheStorage')
  /** put 被拒且拒绝原因是"scheme 不支持"⇒ 与冻结口径一致。 */
  const rejectedAsFrozen = (surface) => !!(
    surface
    && surface.putSupported !== true
    && typeof surface.putError === 'string'
    && /scheme/i.test(surface.putError)
    && /unsupported|not supported/i.test(surface.putError)
  )
  const frozenBehaviour = rejectedAsFrozen(cacheWriteA) && rejectedAsFrozen(cacheWriteB)
  const putAccepted = !!(cacheWriteA && cacheWriteA.putSupported === true && cacheWriteB && cacheWriteB.putSupported === true)
  checks.push({
    id: 'W0D-14-cacheStorage-write-capability',
    title: 'Cache Storage 在自定义 scheme 上不可写（冻结口径：§3 F13 —— 允许 localStorage/IndexedDB，禁止依赖 Cache Storage）',
    required: true,
    // PASS = put 被拒且原因是 scheme 不支持；put 竟然成功 ⇒ FAIL（口径要重新裁定）。
    verdict: frozenBehaviour ? 'PASS' : (putAccepted ? 'FAIL' : 'UNVERIFIABLE'),
    evidence: {
      verdictReason: frozenBehaviour
        ? 'cache.put() rejects with an unsupported-scheme TypeError on this origin => Cache Storage 只能 open 出空壳，无法承载任何数据（冻结口径，见设计总纲 §3 F13）'
        : (putAccepted ? 'cache.put() was ACCEPTED on this origin — the frozen F13 wording must be reconsidered' : 'cache.put() neither succeeded nor failed with a scheme error; see the raw errors'),
      'demo-a': cacheWriteA ? { putSupported: cacheWriteA.putSupported, putError: cacheWriteA.putError, cacheNamesAfter: cacheWriteA.cacheNamesAfter } : null,
      'demo-b': cacheWriteB ? { putSupported: cacheWriteB.putSupported, putError: cacheWriteB.putError, cacheNamesAfter: cacheWriteB.cacheNamesAfter } : null,
    },
  })

  // 诊断项
  const anyResult = byLabel[PLAN_LABEL.X_A_WRITE] && byLabel[PLAN_LABEL.X_A_WRITE].result
  const idbWriteA = surfaceAt(byLabel, PLAN_LABEL.X_A_WRITE, 'indexedDB')
  checks.push({
    id: 'W0D-D1-secure-context',
    title: '诊断：自定义协议 origin 是 secure context（secure:true 特权生效）',
    required: false,
    verdict: anyResult ? (anyResult.isSecureContext ? 'PASS' : 'FAIL') : 'UNKNOWN',
    evidence: { origin: anyResult && anyResult.origin, isSecureContext: anyResult && anyResult.isSecureContext },
  })
  checks.push({
    id: 'W0D-D2-origin-shape',
    title: '诊断：standard:true 生效 —— origin 形状为 scheme://host',
    required: false,
    verdict: anyResult ? (anyResult.origin === ORIGIN_A ? 'PASS' : 'FAIL') : 'UNKNOWN',
    evidence: { observedOrigin: anyResult && anyResult.origin, href: anyResult && anyResult.href },
  })
  checks.push({
    id: 'W0D-D3-indexedDB-databases-api',
    title: '诊断：indexedDB.databases() 的两种取结果写法在自定义 scheme origin 上的差异（promise 可用 / req.onsuccess 不触发）',
    required: false,
    verdict: idbWriteA ? (idbWriteA.databasesApi === 'ok(promise form)' ? 'PASS' : 'FAIL') : 'UNKNOWN',
    evidence: {
      databasesApi: idbWriteA && idbWriteA.databasesApi,
      databasesError: idbWriteA && idbWriteA.databasesError,
      databaseNames: idbWriteA && idbWriteA.databaseNames,
      headToHead: idbWriteA && idbWriteA.databasesEventForm,
      note: '同一页面内对拍：IDBRequest.then() 可用；req.onsuccess 在自定义协议 origin 上不触发（探针因此不得用回调写法门控）',
    },
  })
  checks.push({
    id: 'W0D-D4-partition-scoped-handler-sufficient-when-bound',
    title: '诊断：窗口真正绑定分区时，只注册分区 handler 即可加载（控制组 C2；无需默认 session 也注册）',
    required: false,
    verdict: controls.c2 ? (controls.c2.load && controls.c2.load.ok && controls.c2.page && controls.c2.page.done === true ? 'PASS' : 'FAIL') : 'UNKNOWN',
    evidence: controls.c2 || null,
  })

  return { checks, markerA, markerB }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function newWindow(sessionRef, extra) {
  return new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: Object.assign({
      session: sessionRef,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    }, extra || {}),
  })
}

async function runControls() {
  const controls = {}

  // C1（负向）：只有分区 handler；窗口按**无效**的顶层 session 选项构造 —— 实际跑在默认
  // session（此时默认 session 还没有 handler）=> 加载必须失败，且 getPartition() 必须是 ''。
  const sesCtl = session.fromPartition(PARTITION_CTL)
  registerHandler(sesCtl, 'ctl', CONTROL_HTML)
  const c1win = new BrowserWindow({
    show: false,
    session: sesCtl, // 故意用无效选项（根因复现）
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  const c1 = { intendedPartition: PARTITION_CTL, session: null, load: null, page: null }
  try {
    await c1win.loadURL(`${SCHEME}://demo-a/control-c1?t=${Date.now()}`)
    c1.load = { ok: true, url: c1win.webContents.getURL() }
  } catch (e) {
    c1.load = { ok: false, error: String((e && e.message) || e) }
  }
  c1.session = sessionEvidence(c1win, sesCtl, PARTITION_CTL)
  c1win.destroy()
  controls.c1 = c1
  console.log(`[W0-D][control-C1] top-level session option -> ${JSON.stringify(c1.session)} load=${JSON.stringify(c1.load)}`)

  // C2（正向，分区作用域）：只注册分区 handler（默认 session 仍无 handler），窗口用
  // webPreferences.session 绑定 => 必须加载成功且页面 JS 跑通。
  const sesC2 = session.fromPartition(`${PARTITION_CTL}-c2`)
  registerHandler(sesC2, `${PARTITION_CTL}-c2`, CONTROL_HTML)
  const c2win = newWindow(sesC2)
  const c2logFrom = protocolLog.length
  const c2 = { partition: `${PARTITION_CTL}-c2`, session: null, load: null, page: null }
  try {
    await c2win.loadURL(`${SCHEME}://demo-a/control-c2?t=${Date.now()}`)
    c2.load = { ok: true, url: c2win.webContents.getURL() }
    c2.page = JSON.parse(await c2win.webContents.executeJavaScript('JSON.stringify(window.__ctl || null)', true))
  } catch (e) {
    c2.load = { ok: false, error: String((e && e.message) || e) }
  }
  c2.session = sessionEvidence(c2win, sesC2, `${PARTITION_CTL}-c2`, c2logFrom)
  c2win.destroy()
  controls.c2 = c2
  console.log(`[W0-D][control-C2] partition-bound window (partition-only handler) ${JSON.stringify(c2.session)} load=${JSON.stringify(c2.load)} page=${JSON.stringify(c2.page)}`)

  // C3（正向对照）：注册默认 session handler；未绑定分区的窗口 => 加载成功 + 页面 JS 跑通。
  registerHandler(session.defaultSession, 'default', CONTROL_HTML)
  const c3win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const c3logFrom = protocolLog.length
  const c3 = { session: null, load: null, page: null }
  try {
    await c3win.loadURL(`${SCHEME}://demo-a/control-c3?t=${Date.now()}`)
    c3.load = { ok: true, url: c3win.webContents.getURL() }
    c3.page = JSON.parse(await c3win.webContents.executeJavaScript('JSON.stringify(window.__ctl || null)', true))
  } catch (e) {
    c3.load = { ok: false, error: String((e && e.message) || e) }
  }
  c3.session = sessionEvidence(c3win, session.defaultSession, 'default', c3logFrom)
  c3win.destroy()
  controls.c3 = c3
  console.log(`[W0-D][control-C3] default session window ${JSON.stringify(c3.session)} load=${JSON.stringify(c3.load)} page=${JSON.stringify(c3.page)}`)

  return controls
}

async function main() {
  const controls = await runControls()

  // 正式访问：默认 session 也注册（与 electron-adapter 的 handleAppScheme + handleInSession
  // 两个注册点一致），X/Y 各自注册自己的 handler，窗口用 webPreferences.session 绑定。
  const sesX = session.fromPartition(PARTITION_X)
  const sesY = session.fromPartition(PARTITION_Y)
  registerHandler(sesX, PARTITION_X, MAIN_HTML)
  registerHandler(sesY, PARTITION_Y, MAIN_HTML)

  const winX = newWindow(sesX)
  const winY = newWindow(sesY)

  const visits = []
  const plan = [
    [winX, PLAN_LABEL.X_A_WRITE, 'demo-a', 'write'],
    [winX, PLAN_LABEL.X_A_READ, 'demo-a', 'read'],
    [winX, PLAN_LABEL.X_B_READ_BEFORE, 'demo-b', 'read'],
    [winX, PLAN_LABEL.X_B_WRITE, 'demo-b', 'write'],
    [winX, PLAN_LABEL.X_B_READ_AFTER, 'demo-b', 'read'],
    [winX, PLAN_LABEL.X_A_READ_AFTER_B, 'demo-a', 'read'],
    [winY, PLAN_LABEL.Y_A_READ_BEFORE, 'demo-a', 'read'],
    [winY, PLAN_LABEL.Y_A_WRITE, 'demo-a', 'write'],
    [winY, PLAN_LABEL.Y_A_READ_AFTER, 'demo-a', 'read'],
  ]
  for (const [win, label, host, op] of plan) {
    await visit(win, label, host, op, visits)
    if (op === 'write') {
      try { win.webContents.session.flushStorageData() } catch (e) { /* best effort */ }
      await delay(STORAGE_SETTLE_MS)
    }
  }

  const { checks } = buildChecks(visits, controls)
  const required = checks.filter((c) => c.required)
  const failed = required.filter((c) => c.verdict === 'FAIL')
  const unknown = required.filter((c) => c.verdict === 'UNKNOWN')
  const exitCode = failed.length === 0 && unknown.length === 0 ? 0 : 1

  const output = {
    probe: 'W0-D browser storage isolation probe',
    generatedAt: new Date().toISOString(),
    runId: RUN_ID,
    command: process.argv.join(' '),
    runtime: {
      electron: process.versions.electron, chrome: process.versions.chrome,
      node: process.versions.node, v8: process.versions.v8,
      platform: process.platform, platformCovered: PROBE_COVERED, arch: process.arch,
    },
    environment: {
      HOME: process.env.HOME || null, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || null,
      DISPLAY: process.env.DISPLAY || null, noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      userDataDir: USER_DATA_DIR, userDataDirRemoved: false,
    },
    customScheme: {
      name: SCHEME, privileges: SCHEME_PRIVILEGES, origins: [ORIGIN_A, ORIGIN_B],
      registration: {
        defaultSessionHandler: true,
        partitionHandlers: [PARTITION_X, PARTITION_Y, PARTITION_CTL],
        windowBinding: 'webPreferences.session (top-level { session } is IGNORED by Electron)',
      },
    },
    partitions: { X: PARTITION_X, Y: PARTITION_Y },
    markers: { a: `${RUN_ID}|demo-a`, b: `${RUN_ID}|demo-b` },
    control: {
      defaultSessionPositive: controls.c3,
      invalidTopLevelSessionOption: controls.c1,
      partitionScopedHandlerBound: controls.c2,
    },
    controls,
    checks,
    summary: {
      required: required.length,
      pass: required.filter((c) => c.verdict === 'PASS').length,
      fail: failed.length,
      unknown: unknown.length,
      failedIds: failed.map((c) => c.id),
      unknownIds: unknown.map((c) => c.id),
      exitCode,
    },
    pageVisits: visits.map((v) => ({
      label: v.label, host: v.host, op: v.op, url: v.url, session: v.session,
      error: v.error, diagnostics: v.diagnostics,
      origin: v.result && v.result.origin, isSecureContext: v.result && v.result.isSecureContext,
      trace: v.result && v.result.trace, apiTypes: v.result && v.result.apiTypes,
      surfaces: v.result && v.result.surfaces, console: v.console,
    })),
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8')

  console.log('')
  console.log('[W0-D] ================= verdict table =================')
  for (const c of checks) {
    console.log(`[W0-D] ${c.verdict.padEnd(7)} ${c.required ? 'required   ' : 'diagnostic '} ${c.id}`)
    if (c.verdict !== 'PASS' && Array.isArray(c.evidence.problems)) {
      for (const p of c.evidence.problems) console.log(`[W0-D]           - ${p}`)
    }
  }
  console.log(`[W0-D] runtime: electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node}`)
  console.log(`[W0-D] required=${required.length} pass=${output.summary.pass} fail=${failed.length} unknown=${unknown.length}`)
  console.log(`[W0-D] results: ${OUT_PATH}`)
  console.log(`[W0-D] exit code: ${exitCode}`)

  if (!KEEP_USER_DATA) {
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
      output.environment.userDataDirRemoved = true
      fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8')
    } catch (e) {
      console.error(`[W0-D] userData cleanup failed: ${e && e.message}`)
    }
  }

  clearTimeout(hardTimer)
  app.exit(exitCode)
}

app.whenReady().then(() => {
  if (!PROBE_COVERED && PROBE_REQUIRE_COVERED) {
    console.log(`[skip] PROBE_REQUIRE_COVERED_PLATFORM=1 且平台未覆盖（${PROBE_PLATFORM}），按显式 SKIP 退出（77）`)
    app.exit(77)
    return
  }
  if (process.argv.includes('--dump-page')) {
    const target = path.join(__dirname, 'page-dump.html')
    fs.writeFileSync(target, `${MAIN_HTML}\n<!-- control page -->\n${CONTROL_HTML}`, 'utf8')
    console.log(`[W0-D] page html dumped to ${target}`)
    app.exit(0)
    return
  }
  main().catch((e) => {
    console.error(`[W0-D] FATAL: ${(e && e.stack) || e}`)
    process.exit(2)
  })
})

app.on('window-all-closed', () => {
  // 隐藏窗口：退出时机由 main() 决定。
})

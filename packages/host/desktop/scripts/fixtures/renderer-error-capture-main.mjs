/**
 * 行为级渲染采集 smoke 的 Electron 主进程入口（F-11 / 2026-09-16 修复轮 1）。
 *
 * 它**不是**产品代码，只是被 `scripts/verify-renderer-error-capture.mjs` 拉起的
 * 真实 Electron 窗口：用**生产那组 webPreferences**（`contextIsolation: true` /
 * `nodeIntegration: false` / `sandbox: true` + 产品 preload 产物）建窗口，页面在
 * **主世界**抛真错误，看主进程是否经 IPC 收到。
 *
 * 为什么必须真机：单元测试里 `window` 是手写替身，"主世界 vs 隔离世界"这个
 * 唯一的失败模式在其中根本不存在 —— 修复前的实现 52 个单测全绿，而真机上
 * 0 条到达（F-01）。本入口把那个失败模式变成可断言的行为。
 *
 * 输出（stdout 单行 JSON，前缀 `RENDERER_CAPTURE_SMOKE_RESULT `）：
 *   { preloadPath, webPreferences, pageWorldSaw, hits, errors }
 * 退出码：0 = 探针跑完（判定交给 runner）；1 = 探针自身失败。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { normalizeRendererErrorReport, RENDERER_ERROR_CHANNEL } from '../../lib/renderer-error-contract.js'

/** 与产品一致的应用 CSP（`APP_CONTENT_SECURITY_POLICY`）——证明注入不受 CSP 影响。 */
const APP_CSP = [
  "default-src 'self' data: blob: ws:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
].join('; ')

const MARKER_THROW = 'SMOKE_RENDERER_UNCAUGHT_THROW'
const MARKER_REJECTION = 'SMOKE_RENDERER_UNHANDLED_REJECTION'

/**
 * 产品 preload 产物（固定文件名，与 `window-options.ts` 里的解析一致）。
 *
 * 这里**不** import `window-options.js`：它被内联进带哈希的 electron-runtime chunk，
 * 没有稳定路径。生产 webPreferences 的取值由单测钉住（`tests/window-options.spec.ts`
 * 与 `tests/renderer-error-capture.spec.ts` 断言 contextIsolation:true /
 * nodeIntegration:false / sandbox:true + preload 指向这个产物），本 smoke 负责
 * "在这组取值下行为是否真的成立"。
 */
const PRELOAD = fileURLToPath(new URL('../../lib/preload/renderer-error.cjs', import.meta.url))

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>renderer-capture-smoke</title></head><body>
<script>
  window.__pageWorldSaw = [];
  window.addEventListener('error', function (event) {
    window.__pageWorldSaw.push('error:' + event.message);
  });
  window.addEventListener('unhandledrejection', function (event) {
    window.__pageWorldSaw.push('rejection:' + ((event.reason && event.reason.message) || String(event.reason)));
  });
  setTimeout(function () { throw new Error(${JSON.stringify(MARKER_THROW)}); }, 60);
  setTimeout(function () { Promise.reject(new Error(${JSON.stringify(MARKER_REJECTION)})); }, 90);
</script>
</body></html>`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 收集主进程收到的报告。 */
const hits = []
// 与 `installRendererErrorCapture()` 同一条收口逻辑（通道 + 不可信输入归一化）。
// 这里刻意**不** import 那个模块：它在构建产物里被内联进带哈希的 electron-runtime
// chunk，路径不稳定；本 smoke 要钉的是 preload 的**世界选择**（F-01），主进程收口
// 已有单测 + 打包态 e2e:client 断言覆盖。
ipcMain.on(RENDERER_ERROR_CHANNEL, (_event, payload) => {
  const normalized = normalizeRendererErrorReport(payload)
  if (normalized.ok) hits.push(normalized.report)
})

const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'

function emit(payload, code) {
  process.stdout.write(`RENDERER_CAPTURE_SMOKE_RESULT ${JSON.stringify(payload)}\n`)
  app.exit(code)
}

app.whenReady().then(async () => {
  const errors = []
  try {
    if (!existsSync(PRELOAD)) throw new Error(`built preload missing: ${PRELOAD}`)
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('Content-Security-Policy', APP_CSP)
      res.end(PAGE)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    // 生产那组 webPreferences（见文件头说明：取值由单测钉住）。
    // 负向对照（测试用）：`RENDERER_CAPTURE_SMOKE_PRELOAD` 可换成别的 preload，
    // 证明这条 smoke 真的会因"监听装错世界"而失败（空转反证）。
    const webPreferences = {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: process.env.RENDERER_CAPTURE_SMOKE_PRELOAD || PRELOAD,
    }
    const window = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences })
    await window.loadURL(`http://127.0.0.1:${port}/`)
    // 页面在 60/90ms 抛错；等注入 → 桥 → IPC → 收口走完。
    await sleep(800)

    const pageWorldSaw = await window.webContents.executeJavaScript('window.__pageWorldSaw')
    server.close()
    emit(
      {
        platform,
        preloadPath: String(webPreferences.preload),
        webPreferences: {
          contextIsolation: webPreferences.contextIsolation,
          nodeIntegration: webPreferences.nodeIntegration,
          sandbox: webPreferences.sandbox,
        },
        pageWorldSaw,
        hits,
        errors,
      },
      0,
    )
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : String(cause))
    emit({ hits, errors }, 1)
  }
})

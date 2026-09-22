/**
 * 左栏毛玻璃探针的 **Electron 侧**（由 `modal-frost-computed-probe.mjs` 启动，不要手工跑）。
 *
 * `import { app, BrowserWindow } from 'electron'` 必须是静态导入：ESM main 里 ready 在模块
 * 求值**完成之后**才发，顶层 await app.whenReady() 会与之死锁（本仓 2026-09-22 实测）。
 */
import { app, BrowserWindow } from 'electron'

const page = process.argv[2]
// 本机以 root 跑 Electron 必须显式关沙箱，否则启动即 FATAL。
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 800 })
  await window.loadFile(page)
  // 页面脚本在 load 时同步算完（getComputedStyle 会强制样式重算）。
  const result = await window.webContents.executeJavaScript('window.__PROBE__')
  process.stdout.write(`PROBE_RESULT ${JSON.stringify(result)}\n`)
  app.exit(0)
}).catch((error) => {
  process.stderr.write(`PROBE_ERROR ${String(error?.stack ?? error)}\n`)
  app.exit(1)
})

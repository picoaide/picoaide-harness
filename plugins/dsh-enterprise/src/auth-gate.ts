import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { login } from './server-connector/auth.ts'
import { loadElectronModule } from './server-connector/electron.ts'
import { SESSION_CHANGED_EVENT } from './session-service.ts'

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PicoAide 登录</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f1115; color: #e6e6e6; }
  form { display: flex; flex-direction: column; gap: 12px; width: 320px; }
  input { padding: 10px 12px; border-radius: 8px; border: 1px solid #333; background: #1a1d24; color: #e6e6e6; font-size: 14px; }
  button { padding: 10px; border-radius: 8px; border: none; background: #2563eb; color: #fff; font-size: 14px; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .err { color: #f87171; font-size: 13px; min-height: 16px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
</style>
</head>
<body>
<form id="f">
  <h1>PicoAide 企业登录</h1>
  <input id="server" placeholder="服务端地址 (https://...)" value="__DEFAULT_SERVER__">
  <input id="username" placeholder="账号" autocomplete="username">
  <input id="password" type="password" placeholder="密码" autocomplete="current-password">
  <button type="submit" id="btn">登录</button>
  <div class="err" id="err"></div>
</form>
<script>
  const f = document.getElementById('f')
  const err = document.getElementById('err')
  const btn = document.getElementById('btn')
  f.addEventListener('submit', async (e) => {
    e.preventDefault()
    err.textContent = ''
    err.style.color = '#f87171'
    const body = {
      server: document.getElementById('server').value.trim(),
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    }
    btn.disabled = true
    try {
      const res = await fetch('/api/pico/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        err.style.color = '#4ade80'
        err.textContent = '登录成功'
        return
      }
      const data = await res.json().catch(() => ({}))
      err.textContent = data.error?.message || data.error || ('登录失败 (' + res.status + ')')
    } catch (e2) {
      err.textContent = '网络错误'
    } finally {
      btn.disabled = false
    }
  })
</script>
</body>
</html>`

export interface Config {
  defaultServer?: string
}

export const Config: z<Config> = z.object({
  defaultServer: z.string(),
})

export const name = 'auth-gate'
export const inject = ['webServer', 'picoSession']

interface LoginWindow {
  isDestroyed(): boolean
  close(): void
}

/**
 * Client-owned login surface: a dedicated native window serves the login form,
 * the user submits server address plus credentials, and the client calls the
 * gateway API. The main Web window is never replaced by a login page.
 */
export function apply(ctx: Context, config: Config): void {
  const loginHTML = LOGIN_HTML.replaceAll('__DEFAULT_SERVER__', config.defaultServer ?? '')

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  let loginWindow: LoginWindow | undefined

  const openLoginWindow = async (): Promise<void> => {
    if (loginWindow !== undefined) return
    const mod = await loadElectronModule()
    if (loginWindow !== undefined) return
    if (ctx.picoSession.isLoggedIn()) return
    const BrowserWindow = mod.BrowserWindow
    if (typeof BrowserWindow !== 'function') return
    const win = new BrowserWindow({
      width: 440,
      height: 620,
      title: 'PicoAide 登录',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      show: false,
    })
    win.once('ready-to-show', () => { win.show() })
    win.on('closed', () => { if (loginWindow === win) loginWindow = undefined })
    loginWindow = win
    void win.loadURL(`http://127.0.0.1:${String(ctx.webServer.port)}/login`)
  }

  const closeLoginWindow = (): void => {
    const win = loginWindow
    loginWindow = undefined
    if (win !== undefined && !win.isDestroyed()) win.close()
  }

  ctx.effect(() => () => { closeLoginWindow() }, 'pico login window')

  // The session restore is asynchronous, so the initial state may settle
  // before or after this apply: check it now and follow every change.
  ctx.on(SESSION_CHANGED_EVENT, (session) => {
    if (session === null) void openLoginWindow()
    else closeLoginWindow()
  })
  if (!ctx.picoSession.isLoggedIn()) void openLoginWindow()

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact', path: '/login',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(loginHTML)
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/login',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          let body: { server?: unknown; username?: unknown; password?: unknown }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
          if (typeof body.server !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') {
            return json(res, 400, { error: 'missing fields' })
          }
          let parsed: URL
          try { parsed = new URL(body.server) } catch { return json(res, 400, { error: 'invalid server url' }) }
          const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
          if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localhost)) {
            return json(res, 400, { error: 'server must use https (http only for localhost)' })
          }
          try {
            ctx.picoSession.setSession(await login(body.server, body.username, body.password))
            json(res, 200, { ok: true })
          } catch (err) {
            json(res, 401, { error: err instanceof Error ? err.message : 'login failed' })
          }
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/state',
        handler: (_req: IncomingMessage, res: ServerResponse) => json(res, 200, { loggedIn: ctx.picoSession.isLoggedIn() }),
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/logout',
        handler: (_req: IncomingMessage, res: ServerResponse) => { ctx.picoSession.clear(); json(res, 200, { ok: true }) },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico auth-gate routes')
}

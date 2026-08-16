import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { login } from './server-connector/auth.ts'
import { getSessionService } from './session-service.ts'

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
  <button type="submit">登录</button>
  <div class="err" id="err"></div>
</form>
<script>
  const f = document.getElementById('f')
  const err = document.getElementById('err')
  f.addEventListener('submit', async (e) => {
    e.preventDefault()
    err.textContent = ''
    const body = {
      server: document.getElementById('server').value.trim(),
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    }
    try {
      const res = await fetch('/api/pico/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) { location.replace('/'); return }
      const data = await res.json().catch(() => ({}))
      err.textContent = data.error?.message || data.error || ('登录失败 (' + res.status + ')')
    } catch (e2) {
      err.textContent = '网络错误'
    }
  })
</script>
</body>
</html>`

export interface Config {
  defaultServer: string
}

export const name = 'auth-gate'
export const inject = ['webServer']

export function apply(ctx: Context, config: Config): void {
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  ctx.webServer.register({
    kind: 'exact', path: '/login',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(LOGIN_HTML.replaceAll('__DEFAULT_SERVER__', config?.defaultServer ?? ''))
    },
  })

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
      const svc = getSessionService(ctx)
      if (!svc) return json(res, 500, { error: 'session service missing' })
      try {
        svc.setSession(await login(body.server, body.username, body.password))
        json(res, 200, { ok: true })
      } catch (err) {
        json(res, 401, { error: err instanceof Error ? err.message : 'login failed' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact', path: '/api/pico/auth/state',
    handler: (_req: IncomingMessage, res: ServerResponse) => json(res, 200, { loggedIn: getSessionService(ctx)?.isLoggedIn() ?? false }),
  })

  ctx.webServer.register({
    kind: 'exact', path: '/api/pico/auth/logout',
    handler: (_req: IncomingMessage, res: ServerResponse) => { getSessionService(ctx)?.clear(); json(res, 200, { ok: true }) },
  })

  ctx.webServer.tapIndex((html) => {
    if (getSessionService(ctx)?.isLoggedIn()) return html
      return html.replace(
      '</head>',
      `<script>location.replace('/login')</script></head>`,
    )
  })
}

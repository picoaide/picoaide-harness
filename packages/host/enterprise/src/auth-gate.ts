import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AuthError, fetchJSON, gatewayFetch, login } from './server-connector/auth.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import {
  installSkillArchive,
  listInstalledSkills,
  resolveSkillsDir,
  uninstallSkill,
  validateSkillName,
} from './skill-install.ts'
import { MAX_ARCHIVE_BYTES } from './archive-util.ts'

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PicoAide 登录</title>
<style>
  :root {
    --bg: #ffffff;
    --fg: #1a1d24;
    --input-bg: #ffffff;
    --border: #d0d5dd;
    --err: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --fg: #e6e6e6;
      --input-bg: #1a1d24;
      --border: #333333;
      --err: #f87171;
    }
  }
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: var(--bg); color: var(--fg); }
  form { display: flex; flex-direction: column; gap: 12px; width: 320px; }
  input { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--input-bg); color: var(--fg); font-size: 14px; }
  button { padding: 10px; border-radius: 8px; border: none; background: #2563eb; color: #fff; font-size: 14px; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .err { color: var(--err); font-size: 13px; min-height: 16px; }
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
    const body = {
      server: document.getElementById('server').value.trim(),
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    }
    // Loading state: disable the button and show progress so repeated
    // clicks are impossible and the user sees the request is in flight.
    btn.disabled = true
    const btnLabel = btn.textContent
    btn.textContent = '登录中…'
    try {
      const res = await fetch('/api/pico/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) { location.replace('/' + location.search); return }
      const data = await res.json().catch(() => ({}))
      // Localize raw gateway error codes; keep the server message when the
      // gateway already shipped a human-readable one.
      const raw = String(data.error?.message || data.error || '')
      err.textContent = friendlyLoginError(raw) || ('登录失败 (' + res.status + ')')
    } catch (e2) {
      err.textContent = '网络错误，请检查服务端地址后重试'
    } finally {
      btn.disabled = false
      btn.textContent = btnLabel
    }
  })
  // Friendly message for common raw gateway error codes (server sends
  // machine-readable codes; the login page must not show them verbatim).
  // NOTE: this runs inside an inline <script> — plain JS only, no TS syntax.
  const friendlyLoginError = (raw) => {
    const code = raw.toLowerCase()
    if (code.includes('invalid_credentials') || code.includes('invalid credentials') || code.includes('unauthorized')) {
      return '账号或密码错误'
    }
    if (code.includes('rate') || code.includes('too many')) return '登录尝试过于频繁，请稍后再试'
    if (code.includes('network') || code.includes('timeout') || code.includes('econnrefused')) return '无法连接服务端，请检查地址与网络'
    if (code.includes('disabled') || code.includes('inactive')) return '账号已被禁用，请联系管理员'
    return raw
  }
</script>
</body>
</html>`

export interface Config {
  defaultServer?: string
}

export const Config: z<Config> = z.object({
  defaultServer: z.string(),
})

// P1-11: transient page shown while the persisted session is still being
// restored; it re-requests the index (which now resolves to the app or the
// login form) without a user-visible login-form flash.
const RESTORING_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PicoAide</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fff; color: #616267; }
</style>
</head>
<body>
<p>正在恢复登录状态…</p>
<script>
  // Once the restoration completes, the next index request serves the app
  // (or the login form). Poll briefly, then reload for good measure.
  setTimeout(function () { location.reload() }, 1200)
<\/script>
</body>
</html>`

export const name = 'auth-gate'
export const inject = ['webServer', 'picoSession']

/**
 * Client-owned login surface served as the main window's first page when no
 * session exists. The user fills the server address and logs in through the
 * client's local API, which calls the gateway; on success the page reloads
 * into the DSH Web app in the same window.
 */
export function apply(ctx: Context, config: Config): void {
  const loginHTML = LOGIN_HTML.replaceAll('__DEFAULT_SERVER__', config.defaultServer ?? '')

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const session = (): { serverURL: string; token: string } | null => ctx.picoSession.getSession()

  /**
   * Trust fence for every local route: loopback socket + Host + same-origin
   * markers. Refuses cross-site browser pages (CSRF / DNS-rebinding) and
   * non-loopback callers alike.
   */
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
    json(res, 403, { error: 'forbidden' })
    return false
  }

  const gatewayError = (res: ServerResponse, cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause)
    json(res, 502, { error: `gateway error: ${message}` })
  }

  /**
   * Session-lost tripwire injected into the DSH app page: polls the local
   * auth state and reloads into the login page when the session is cleared
   * server-side (token revoked/expired/disabled). 5s cadence keeps the
   * window short without long-lived connections.
   */
  const SESSION_LOST_SCRIPT = `<script>
(function () {
  var known = true
  setInterval(function () {
    fetch('/api/pico/auth/state').then(function (r) { return r.json() }).then(function (d) {
      if (known && d.loggedIn === false) location.reload()
      known = d.loggedIn === true
    }).catch(function () {})
  }, 5000)
})()
<\/script>`

  ctx.effect(() => {
    const disposers = [
      // The main window's first page: the login form while logged out, the
      // DSH Web app once a session exists. Server-side replacement (not a
      // client redirect) keeps the initial loadURL from being aborted.
      // While logged in, inject the session-lost tripwire into the app page.
      ctx.webServer.tapIndex((html) => {
      // P1-11: while the persisted session is still restoring, serve a
      // lightweight "loading" page that re-requests the index once ready —
      // never flash the login form over an existing valid session.
      if (!ctx.picoSession.isRestored()) return RESTORING_HTML
      if (!ctx.picoSession.isLoggedIn()) return loginHTML
      return html.replace('</head>', SESSION_LOST_SCRIPT + '</head>')
      }),

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
          if (!guard(req, res)) return
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          let body: { server?: unknown; username?: unknown; password?: unknown }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
          if (typeof body.server !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') {
            return json(res, 400, { error: 'missing fields' })
          }
          try {
            ctx.picoSession.setSession(await login(body.server, body.username, body.password))
            json(res, 200, { ok: true })
          } catch (err) {
            // AuthError carries a user-facing message (账号或密码错误 etc.).
            const status = err instanceof AuthError && err.kind === 'network' ? 502 : 401
            json(res, status, { error: err instanceof Error ? err.message : 'login failed' })
          }
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/state',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          const s = session()
          json(res, 200, s === null
            ? { loggedIn: false }
            : { loggedIn: true, username: ctx.picoSession.getSession()?.username, serverURL: s.serverURL })
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/logout',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          // Revoke the gateway token server-side before clearing locally
          // (M1): the server token must not outlive the local session.
          const s = session()
          if (s !== null) {
            try {
              await fetchJSON(s.serverURL, '/api/auth/logout', { token: s.token, method: 'POST' })
            } catch {
              // The local session is still cleared even if the server is
              // unreachable; the token expires via its own TTL.
            }
          }
          ctx.picoSession.clear()
          json(res, 200, { ok: true })
        },
      }),

      // Skill store proxy: /api/pico/skills (catalog), /archive (download),
      // and /install (verify + unpack into the user skill root), all
      // forwarded to the gateway. Method dispatch lives inside one handler:
      // the route table has no per-method matching.
      ctx.webServer.register({
        kind: 'prefix', path: '/api/pico/skills',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          if (pathname === '/api/pico/skills' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/marketplace/skills', { token: s.token })
              // Augment the gateway catalog with the locally installed skill
              // names so the panel can render per-skill install state.
              const installed = await listInstalledSkills(resolveSkillsDir())
              json(res, 200, { ...data, installed })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // The session is no longer valid: clear it so the injected
                // tripwire reloads into the login page (M2).
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodeURIComponent(installMatch[1]!)
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${s.serverURL}/api/marketplace/skills/${encodeURIComponent(name)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
              const length = Number(upstream.headers.get('content-length') ?? '0')
              if (length > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: 'archive too large' })
              }
              const archive = Buffer.from(await upstream.arrayBuffer())
              const checksum = upstream.headers.get('x-skill-checksum') ?? undefined
              const version = upstream.headers.get('x-skill-version') ?? undefined
              const result = await installSkillArchive({
                name,
                archive,
                checksum,
                version,
                skillsDir: resolveSkillsDir(),
              })
              json(res, 200, { ok: true, name: result.name, version: result.version })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              // Install refusals (checksum, unsafe archive, no SKILL.md) are
              // client errors; gateway/IO failures are upstream errors.
              const message = cause instanceof Error ? cause.message : String(cause)
              const isRefusal = /checksum|archive|SKILL\.md|invalid skill name|link entry|too large|traversal|empty path/u.test(message)
              json(res, isRefusal ? 422 : 502, { error: message })
            }
            return
          }
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodeURIComponent(uninstallMatch[1]!)
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              // Purely local operation — no gateway round-trip needed.
              await uninstallSkill(resolveSkillsDir(), name)
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /not installed/u.test(message) ? 404 : 500, { error: message })
            }
            return
          }
          const archiveMatch = req.method === 'GET'
            ? /^\/api\/pico\/skills\/([^/]+)\/archive$/u.exec(pathname)
            : null
          if (archiveMatch === null) return json(res, 404, { error: 'not found' })
          const name = decodeURIComponent(archiveMatch[1]!)
          try {
            const upstream = await gatewayFetch(
              `${s.serverURL}/api/marketplace/skills/${encodeURIComponent(name)}/archive`,
              { headers: { Authorization: `Bearer ${s.token}` } },
            )
            if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
            // P1-12: bound the download like the install path — a huge or
            // anomalous archive must not be buffered into memory wholesale.
            const declared = upstream.headers.get('content-length')
            if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
            const content = Buffer.from(await upstream.arrayBuffer())
            if (content.length > MAX_ARCHIVE_BYTES) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
            // Pass through the upstream integrity headers (M3): the server
            // signs archives with X-Skill-Checksum / X-Skill-Version.
            const headers: Record<string, string> = {
              'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
              'Content-Length': String(content.length),
            }
            const disposition = upstream.headers.get('content-disposition')
            headers['Content-Disposition'] = disposition ?? `attachment; filename="${name}.tar.gz"`
            for (const key of ['x-skill-checksum', 'x-skill-version']) {
              const value = upstream.headers.get(key)
              if (value !== null) headers[key] = value
            }
            res.writeHead(200, headers)
            res.end(content)
          } catch (cause) {
            if (cause instanceof AuthError && cause.kind === 'auth_expired') {
              ctx.picoSession.clear()
              return json(res, 401, { error: 'auth expired' })
            }
            gatewayError(res, cause)
          }
        },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico auth-gate routes')
}

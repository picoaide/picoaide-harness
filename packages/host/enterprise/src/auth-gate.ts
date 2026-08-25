import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ApiError, AuthError, fetchJSON, gatewayFetch, login } from './server-connector/auth.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import {
  installSkillArchive,
  listInstalledSkills,
  listLocalSkills,
  packSkill,
  resolveSkillsDir,
  uninstallSkill,
  validateSkillName,
} from './skill-install.ts'
import { MAX_ARCHIVE_BYTES } from './archive-util.ts'
import {
  installPresetArchive,
  listInstalledPresets,
  mapLocalPresets,
  packPreset,
  resolvePresetsDir,
  uninstallPreset,
  validatePresetId,
} from './agent-preset-install.ts'

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

  /**
   * 流式读取上游 body 并带字节上限(审计 2026-08-25 P2-1/P2-2)。
   * 此前 install/archive 分支用 `Buffer.from(await upstream.arrayBuffer())`
   * 整段读入后才判 16MB——content-length 头可被不可信上游伪造/省略,真实
   * 大 body 会把 Host 进程内存打满。此函数边读边计数,超限即 cancel 并抛错。
   */
  const readBodyLimited = async (body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> => {
    if (body === null) return Buffer.alloc(0)
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limit) {
          await reader.cancel().catch(() => undefined)
          throw new Error(`body exceeds ${limit} bytes`)
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }

  /**
   * 收集本地 POST body 并带上限(审计 2026-08-25 P2-2):login/upload 此前
   * `for await (const chunk of req)` 无界收集,同机恶意进程可打满内存。
   */
  const collectBody = async (req: IncomingMessage, limit: number): Promise<Buffer> => {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      total += (chunk as Buffer).byteLength
      if (total > limit) {
        req.destroy()
        throw new Error(`request body exceeds ${limit} bytes`)
      }
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
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
          // 审计 2026-08-25 P2-2:body 上限 64KB(登录表单远小于此)。
          const raw = await collectBody(req, 64 * 1024).catch(() => null)
          if (raw === null) return json(res, 413, { error: 'body too large' })
          let body: { server?: unknown; username?: unknown; password?: unknown }
          try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
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
              // 审计 2026-08-25 P2-1:流式读取+上限(头可能被伪造/省略)。
              const archive = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (archive === null) return json(res, 413, { error: 'archive too large' })
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
            const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
            if (content === null) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
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

      // Shared-agent proxy: /api/pico/agent-presets (list + upload + install
      // + uninstall + archive). Uploads pack a locally authored preset (the
      // 创造模式 roster's user root) and forward the archive to the gateway;
      // installs download an approved archive, verify it, and unpack it into
      // the same root so the upstream roster discovers it.
      ctx.webServer.register({
        kind: 'prefix', path: '/api/pico/agent-presets',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const presetsDir = resolvePresetsDir()

          // GET /api/pico/agent-presets -> gateway catalog + installed + local.
          if (pathname === '/api/pico/agent-presets' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/agent-presets', { token: s.token })
              const installed = await listInstalledPresets(presetsDir)
              const local = await mapLocalPresets(presetsDir, data.presets ?? [])
              json(res, 200, { ...data, installed, local })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }

          // POST /api/pico/agent-presets/upload { name } -> pack + gateway.
          if (pathname === '/api/pico/agent-presets/upload' && req.method === 'POST') {
            // 审计 2026-08-25 P2-2:body 上限 64KB(upload 只带 name/元数据)。
            const raw = await collectBody(req, 64 * 1024).catch(() => null)
            if (raw === null) return json(res, 413, { error: 'body too large' })
            let body: { name?: unknown }
            try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            if (name === '') return json(res, 400, { error: 'missing name' })
            try {
              const packed = await packPreset(presetsDir, name)
              const gateway = await fetchJSON(s.serverURL, '/api/agent-presets', {
                token: s.token,
                method: 'POST',
                body: {
                  name: packed.name,
                  // Display title travels with the archive so the review
                  // board and the shared library show the friendly name
                  // (not the directory id).
                  ...packed.displayName === undefined ? {} : { display_name: packed.displayName },
                  ...packed.description === undefined ? {} : { description: packed.description },
                  archive: packed.archive.toString('base64'),
                },
                timeoutMs: 30000,
              })
              json(res, 200, { ok: true, preset: gateway.preset })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              if (cause instanceof ApiError) {
                // Gateway envelope: surface its human-readable message with
                // the code-appropriate status (NAME_TAKEN→409, PENDING_LIMIT→429).
                const code = cause.code as string
                const status = code === 'PENDING_LIMIT' ? 429 : code === 'NAME_TAKEN' ? 409 : 422
                return json(res, status, { error: cause.message })
              }
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /too large|过大/u.test(message) ? 413 : 422, { error: message })
            }
            return
          }

          // POST /api/pico/agent-presets/:name/install -> download + verify + unpack.
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodeURIComponent(installMatch[1]!)
            try {
              validatePresetId(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${s.serverURL}/api/agent-presets/${encodeURIComponent(name)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
              const declared = upstream.headers.get('content-length')
              if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
              const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (content === null) {
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
              const checksum = upstream.headers.get('x-preset-checksum') ?? undefined
              await installPresetArchive({ name, archive: content, checksum, presetsDir })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              const message = cause instanceof Error ? cause.message : String(cause)
              const isRefusal = /checksum|archive|agent\.cordis\.yml|invalid preset id|link entry|too large|traversal|empty path|already exists/u.test(message)
              json(res, isRefusal ? 422 : 502, { error: message })
            }
            return
          }

          // POST /api/pico/agent-presets/:name/uninstall -> local removal.
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodeURIComponent(uninstallMatch[1]!)
            try {
              await uninstallPreset(presetsDir, name)
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /not installed/u.test(message) ? 404 : 500, { error: message })
            }
            return
          }

          // GET /api/pico/agent-presets/:name/archive -> passthrough download.
          const archiveMatch = req.method === 'GET'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/archive$/u.exec(pathname)
            : null
          if (archiveMatch === null) return json(res, 404, { error: 'not found' })
          const name = decodeURIComponent(archiveMatch[1]!)
          try {
            const upstream = await gatewayFetch(
              `${s.serverURL}/api/agent-presets/${encodeURIComponent(name)}/archive`,
              { headers: { Authorization: `Bearer ${s.token}` } },
            )
            if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
            const declared = upstream.headers.get('content-length')
            if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
            const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
            if (content === null) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
            const headers: Record<string, string> = {
              'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
              'Content-Length': String(content.length),
            }
            const disposition = upstream.headers.get('content-disposition')
            headers['Content-Disposition'] = disposition ?? `attachment; filename="${name}.tar.gz"`
            for (const key of ['x-preset-checksum', 'x-preset-version']) {
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

      // Shared-skill proxy: /api/pico/shared-skills (list + upload + install
      // + uninstall). Lists the gateway's shared store (approved versions),
      // the local skill root (disk), and the installed set; uploads pack a
      // locally authored skill directory and forward it; installs download an
      // approved archive, verify it, and unpack it into the user skill root.
      ctx.webServer.register({
        kind: 'prefix', path: '/api/pico/shared-skills',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const skillsDir = resolveSkillsDir()

          if (pathname === '/api/pico/shared-skills' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/shared-skills', { token: s.token })
              const installed = await listInstalledSkills(skillsDir)
              const local = await listLocalSkills(skillsDir)
              json(res, 200, { ...data, installed, local })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }

          if (pathname === '/api/pico/shared-skills/upload' && req.method === 'POST') {
            // 审计 2026-08-25 P2-2:body 上限 64KB。
            const raw = await collectBody(req, 64 * 1024).catch(() => null)
            if (raw === null) return json(res, 413, { error: 'body too large' })
            let body: { name?: unknown; version?: unknown }
            try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            const version = typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim() : '1.0.0'
            if (name === '') return json(res, 400, { error: 'missing name' })
            try {
              const packed = await packSkill(skillsDir, name, version)
              const gateway = await fetchJSON(s.serverURL, '/api/shared-skills', {
                token: s.token,
                method: 'POST',
                body: {
                  name: packed.name,
                  ...packed.displayName === undefined ? {} : { display_name: packed.displayName },
                  version: packed.version,
                  ...packed.description === undefined ? {} : { description: packed.description },
                  archive: packed.archive.toString('base64'),
                },
                timeoutMs: 30000,
              })
              json(res, 200, { ok: true, skill: gateway.skill })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              if (cause instanceof ApiError) {
                const code = cause.code as string
                const status = code === 'PENDING_LIMIT' ? 429 : code === 'NAME_TAKEN' ? 409 : 422
                return json(res, status, { error: cause.message })
              }
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /too large|过大/u.test(message) ? 413 : 422, { error: message })
            }
            return
          }

          // POST /api/pico/shared-skills/:name/:version/install -> download + verify + unpack.
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/shared-skills\/([^/]+)\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodeURIComponent(installMatch[1]!)
            const version = decodeURIComponent(installMatch[2]!)
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${s.serverURL}/api/shared-skills/${encodeURIComponent(name)}/${encodeURIComponent(version)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
              const declared = upstream.headers.get('content-length')
              if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
              const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (content === null) {
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
              const checksum = upstream.headers.get('x-skill-checksum') ?? undefined
              const ver = upstream.headers.get('x-skill-version') ?? version
              await installSkillArchive({ name, archive: content, checksum, skillsDir, version: ver })
              json(res, 200, { ok: true, name, version: ver })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              const message = cause instanceof Error ? cause.message : String(cause)
              const isRefusal = /checksum|archive|SKILL\.md|invalid skill name|link entry|too large|traversal|empty path/u.test(message)
              json(res, isRefusal ? 422 : 502, { error: message })
            }
            return
          }

          // POST /api/pico/shared-skills/:name/:version/uninstall -> local removal.
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/shared-skills\/([^/]+)\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodeURIComponent(uninstallMatch[1]!)
            try {
              await uninstallSkill(skillsDir, name)
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /not installed/u.test(message) ? 404 : 500, { error: message })
            }
            return
          }

          return json(res, 404, { error: 'not found' })
        },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico auth-gate routes')
}

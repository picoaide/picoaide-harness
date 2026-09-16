/**
 * 2026-09-16 R9 审计回归：无桌面壳（浏览器部署）下的语言一致性。
 *
 * `GET /` 的索引变换**拿不到请求对象**（上游 `tapIndex(html => …)` 只给 HTML），
 * 所以 `Accept-Language` 在首屏永远轮不到 —— 英文浏览器访问 `/` 得到中文登录页，
 * 同一浏览器访问 `/login` 却是英文（首屏恰好是 `/`）。用户的显式语言选择存在
 * 客户端同一份设置（`locale` 命名空间）里，宿主可以直接读，于是把它插在 launcher
 * 实时值之下、请求头之上：桌面端行为不变，浏览器部署两侧一致。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/auth-gate.ts'

interface BootOptions {
  /** Probed `desktopRuntime` (absent in a browser deployment). */
  runtimeLocale?: string | undefined
  /** Stored client language preference (the `locale` settings namespace). */
  preference?: unknown
}

function bootWebFace(options: BootOptions = {}): { index: (html: string) => string, login: () => string } {
  let index: ((html: string) => string) | undefined
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const services: Record<string, unknown> = {
    ...(options.runtimeLocale === undefined ? {} : { desktopRuntime: { locale: options.runtimeLocale } }),
    ...(options.preference === undefined ? {} : { settings: { get: () => ({ preference: options.preference }) } }),
  }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => services[name],
    picoSession: { isRestored: () => true, isLoggedIn: () => false, getSession: () => null },
    webServer: {
      tapIndex: (callback: (html: string) => string) => { index = callback; return () => {} },
      register: (route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  }
  apply(ctx as never, {})
  return {
    index: index!,
    login: () => {
      let body = ''
      const req = {
        method: 'GET',
        headers: { 'accept-language': 'en-US,en;q=0.9' },
        url: '/login',
      } as unknown as IncomingMessage
      const res = {
        writeHead: () => res,
        end: (chunk?: unknown) => { body = typeof chunk === 'string' ? chunk : String(chunk ?? '') },
      } as unknown as ServerResponse
      routes.get('/login')!(req, res)
      return body
    },
  }
}

const lang = (page: string): string | undefined => /<html lang="([^"]+)"/u.exec(page)?.[1]

describe('无桌面壳部署：索引与 /login 的语言来源一致', () => {
  it('prefers the stored client preference on BOTH surfaces', () => {
    const face = bootWebFace({ preference: 'en' })
    expect(lang(face.index('<!DOCTYPE html><html><head></head><body></body></html>'))).toBe('en')
    expect(lang(face.login())).toBe('en')
    const zhFace = bootWebFace({ preference: 'zh-CN' })
    expect(lang(zhFace.index('<!DOCTYPE html><html><head></head><body></body></html>'))).toBe('zh-CN')
    expect(lang(zhFace.login())).toBe('zh-CN')
  })

  it('keeps the launcher runtime authoritative over the stored preference', () => {
    const face = bootWebFace({ runtimeLocale: 'zh', preference: 'en' })
    expect(lang(face.index('<!DOCTYPE html><html><head></head><body></body></html>'))).toBe('zh-CN')
    expect(lang(face.login())).toBe('zh-CN')
  })

  it('falls back to Accept-Language, then the product default', () => {
    // No runtime, no stored preference: /login reads the header. The index
    // render has no request at all, so it stays on the product default — the one
    // divergence a request-less transform cannot close.
    const face = bootWebFace({ preference: 'auto' })
    expect(lang(face.login())).toBe('en')
    expect(lang(face.index('<!DOCTYPE html><html><head></head><body></body></html>'))).toBe('zh-CN')
  })

  it('ignores an unusable stored value (a future language pack must not shadow the header)', () => {
    const face = bootWebFace({ preference: 'ja' })
    expect(lang(face.login())).toBe('en')
  })
})

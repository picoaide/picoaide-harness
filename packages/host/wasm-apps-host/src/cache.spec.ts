/**
 * 本机应用内容缓存回归（契约 §7.5 + §5.1b；台账 DAT-10/DAT-11/DAT-12、R1-SEC-3/SEC-4、R2C-3）。
 *
 * 这一层跑**真实临时目录**（`mkdtemp(os.tmpdir())`）而不是 mock 文件系统：要断言的
 * 性质（0700 权限、原子替换后的可见性、LRU 的 mtime 语义、损坏文件当 miss）全都
 * 是落盘之后才成立的。时钟经 `now` 注入，所以与墙钟无关。
 *
 * 变异验证（改回危险实现即红）：
 *  - 落盘路径去掉 `serverHash`/`userHash` ⇒「两个账号不互读」「两个服务端不互读」必红；
 *  - `isStaticSubresource` 放行 `/api/*` 或 HTML ⇒「静态子资源判定」「304 范围」必红；
 *  - `conditional` 不看 `isStaticSubresource` ⇒「304 范围」必红；
 *  - 命中时直接交回落盘的头（不叠加 `securityHeaders()`）⇒「安全头重写」必红；
 *  - 写入策略不看 `no-store`/status/容量 ⇒「写入策略」必红；
 *  - `clearApp` 改删整个缓存根 ⇒「清缓存按作用域隔离」必红。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WasmAppsCache, securityHeaders, type CacheEntryInput, type CacheScope } from './cache.ts'

/**
 * 原子替换的观测点：`cache.ts` 的 `rename` 走这份 mock（默认直通真实实现，
 * 只有测试打开开关时才记录），见「写入走临时文件 + rename」用例。
 */
const renameWatch = vi.hoisted(() => ({ active: false, calls: [] as Array<{ from: string, to: string }> }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      if (renameWatch.active) renameWatch.calls.push({ from: String(from), to: String(to) })
      return actual.rename(from, to)
    },
  }
})

const roots: string[] = []

/** 单调递增的假时钟（同毫秒写入会让 LRU 断言变得不确定）。 */
let tick = 1_700_000_000_000

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

/** 临时根 + 缓存实例（缺省 warn 收集到数组，便于断言「损坏但不抛」）。 */
async function makeCache(
  options: { maxBytes?: number, warn?: (message: string) => void } = {},
): Promise<{ cache: WasmAppsCache, root: string, warnings: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'wasm-apps-cache-'))
  roots.push(root)
  const warnings: string[] = []
  const cache = new WasmAppsCache({
    root,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    now: () => tick++,
    warn: options.warn ?? ((message: string) => { warnings.push(message) }),
  })
  return { cache, root, warnings }
}

const scope = (serverHash: string, userHash: string): CacheScope => ({ serverHash, userHash })

/** 一个可落盘的条目；`headers` 只放白名单内的头（其余由实现丢弃）。 */
function entry(overrides: Partial<CacheEntryInput> = {}): CacheEntryInput {
  return {
    appId: 'demo',
    version: '1.0.0',
    path: '/index.js',
    body: new TextEncoder().encode('console.log(1)'),
    headers: { ETag: '"v1"', 'Content-Type': 'application/javascript' },
    status: 200,
    ...overrides,
  }
}

/** 键的摘要（与实现同源：sha256 十六进制）—— 用来定位目录，不复制实现逻辑。 */
function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** `<root>/<serverHash>/<userHash>/<appId>`（该作用域下该应用的目录）。 */
function appDir(root: string, s: string, u: string, appId = 'demo'): string {
  return join(root, digest(s), digest(u), digest(appId))
}

/** `<root>/<serverHash>/<userHash>/<appId>/<version>`（一条键的目录）。 */
function versionDir(root: string, s: string, u: string, version: string, appId = 'demo'): string {
  return join(appDir(root, s, u, appId), digest(version))
}

/** 该目录下的唯一文件（后缀过滤）。 */
async function onlyFile(directory: string, suffix: string): Promise<string> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(suffix))
  expect(files).toHaveLength(1)
  return join(directory, files[0] ?? '')
}

/** 该键的响应体文件。 */
async function bodyFile(root: string, s: string, u: string, version = '1.0.0'): Promise<string> {
  return onlyFile(versionDir(root, s, u, version), '.bin')
}

/** 列出目录项（`withFileTypes` 的窄重载：vitest 的 spy 类型只认它）。 */
async function listDirectory(directory: string): Promise<Dirent[]> {
  return readdir(directory, { withFileTypes: true })
}

/** 递归列出缓存根下的所有条目（相对根的路径，POSIX 分隔符）。 */
async function listTree(root: string, prefix = ''): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await listDirectory(join(root, prefix))
  } catch {
    return []
  }
  const out: string[] = []
  for (const dirent of entries) {
    const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
    if (dirent.isDirectory()) out.push(...await listTree(root, relative))
    else out.push(relative)
  }
  return out
}

/** 缓存里的记录条数（meta 文件是「这条记录存在」的提交点）。 */
async function metaCount(root: string): Promise<number> {
  return (await listTree(root)).filter((path) => path.endsWith('.json')).length
}

/** 缓存总占用（字节）。 */
async function cacheBytes(root: string): Promise<number> {
  let total = 0
  for (const path of await listTree(root)) total += (await stat(join(root, path))).size
  return total
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body)

/** 大小写不敏感地取一个头（缓存里的头名统一小写，断言不该依赖这一点）。 */
function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

describe('缓存键的双作用域（§7.5 R1-SEC-3 / DAT-10）', () => {
  it('不同账号的同一应用不互读（缓存路径含 userHash）', async () => {
    const { cache, root } = await makeCache()
    await cache.put(scope('server-a', 'user-a'), entry({ body: bytes('A') }))
    await cache.put(scope('server-a', 'user-b'), entry({ body: bytes('B') }))
    // 两份独立目录（不是「都写进同一处」）：
    expect((await readdir(join(root, digest('server-a')))).length).toBe(2)
    // 各自只读到自己那一份：
    expect(text((await cache.get(scope('server-a', 'user-a'), 'demo', '1.0.0', '/index.js'))?.body)).toBe('A')
    expect(text((await cache.get(scope('server-a', 'user-b'), 'demo', '1.0.0', '/index.js'))?.body)).toBe('B')
    // B 账号读不到 A 账号独有的一条：
    await cache.put(scope('server-a', 'user-a'), entry({ path: '/only-a.js', body: bytes('only-a') }))
    expect(await cache.get(scope('server-a', 'user-b'), 'demo', '1.0.0', '/only-a.js')).toBeNull()
  })

  it('不同服务端的同一应用不互读（缓存路径含 serverHash）', async () => {
    const { cache, root } = await makeCache()
    await cache.put(scope('server-a', 'user-a'), entry({ body: bytes('A') }))
    await cache.put(scope('server-b', 'user-a'), entry({ body: bytes('B') }))
    expect(await readdir(root)).toHaveLength(2)
    expect(text((await cache.get(scope('server-a', 'user-a'), 'demo', '1.0.0', '/index.js'))?.body)).toBe('A')
    expect(text((await cache.get(scope('server-b', 'user-a'), 'demo', '1.0.0', '/index.js'))?.body)).toBe('B')
    // A 服务端独有的一条，B 服务端读不到：
    await cache.put(scope('server-a', 'user-a'), entry({ path: '/only-a.js', body: bytes('only-a') }))
    expect(await cache.get(scope('server-b', 'user-a'), 'demo', '1.0.0', '/only-a.js')).toBeNull()
  })

  it('版本来自调用方：版本变化后旧版本读不到，两个版本各占一个目录', async () => {
    const { cache, root } = await makeCache()
    const target = scope('server-a', 'user-a')
    await cache.put(target, entry({ version: '1.0.0', body: bytes('v1') }))
    await cache.put(target, entry({ version: '2.0.0', body: bytes('v2') }))
    expect(await readdir(appDir(root, 'server-a', 'user-a'))).toHaveLength(2)
    expect(await cache.get(target, 'demo', '3.0.0', '/index.js')).toBeNull()
    expect(text((await cache.get(target, 'demo', '1.0.0', '/index.js'))?.body)).toBe('v1')
    expect(text((await cache.get(target, 'demo', '2.0.0', '/index.js'))?.body)).toBe('v2')
  })

  it('path 与 query 一起进键：不同 path / 不同 query 不互读', async () => {
    const { cache } = await makeCache()
    const target = scope('server-a', 'user-a')
    await cache.put(target, entry({ path: '/data.json?page=1', body: bytes('p1') }))
    await cache.put(target, entry({ path: '/data.json?page=2', body: bytes('p2') }))
    await cache.put(target, entry({ path: '/other.json', body: bytes('other') }))
    expect(await cache.get(target, 'demo', '1.0.0', '/data.json?page=3')).toBeNull()
    expect(text((await cache.get(target, 'demo', '1.0.0', '/data.json?page=1'))?.body)).toBe('p1')
    expect(text((await cache.get(target, 'demo', '1.0.0', '/data.json?page=2'))?.body)).toBe('p2')
    expect(text((await cache.get(target, 'demo', '1.0.0', '/other.json'))?.body)).toBe('other')
  })
})

describe('静态子资源判定（§7.5 DAT-11 / R2C-3）', () => {
  const cache = new WasmAppsCache({ root: join(tmpdir(), 'wasm-apps-cache-pure') })
  const navigation = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

  it('/api/* 一律 false（本地缓存不得成为 API 的第二入口）', () => {
    expect(cache.isStaticSubresource('/api/notes.json', {})).toBe(false)
    expect(cache.isStaticSubresource('/api/notes.js', {})).toBe(false)
    expect(cache.isStaticSubresource('/api', {})).toBe(false)
    expect(cache.isStaticSubresource('/api/data.json?v=1', {})).toBe(false)
  })

  it('文档导航一律 false（Accept 或 Content-Type 声明 HTML）', () => {
    expect(cache.isStaticSubresource('/index.html', navigation)).toBe(false)
    expect(cache.isStaticSubresource('/', navigation)).toBe(false)
    expect(cache.isStaticSubresource('/index.html', { Accept: '*/*' })).toBe(false)
    expect(cache.isStaticSubresource('/app', { 'Content-Type': 'text/html; charset=utf-8' })).toBe(false)
    expect(cache.isStaticSubresource('/deep/link', {})).toBe(false)
  })

  it('静态资源扩展名或静态 Content-Type ⇒ true', () => {
    for (const path of [
      '/index.js',
      '/app.css',
      '/logo.png?v=2',
      '/icon.svg',
      '/font.woff2',
      '/data.json',
      '/deep/nested/module.mjs',
    ]) {
      expect(cache.isStaticSubresource(path, {}), path).toBe(true)
    }
    expect(cache.isStaticSubresource('/asset', { 'Content-Type': 'image/png' })).toBe(true)
    expect(cache.isStaticSubresource('/asset', { 'Content-Type': 'font/woff2' })).toBe(true)
  })
})

describe('304 只允许静态子资源（§7.5 DAT-11 / R2C-3）', () => {
  const target = scope('server-a', 'user-a')

  /** 三类资源各写一条：`/api/*`、文档导航、静态子资源。 */
  async function seeded(): Promise<WasmAppsCache> {
    const { cache } = await makeCache()
    await cache.put(target, entry({ path: '/api/notes.json', headers: { ETag: '"api"' } }))
    await cache.put(target, entry({ path: '/index.html', headers: { ETag: '"doc"' } }))
    await cache.put(target, entry({ path: '/index.js', headers: { ETag: '"js"' } }))
    return cache
  }

  it('/api/* 带一致的 If-None-Match 也不短路（一律 miss 回源）', async () => {
    const cache = await seeded()
    expect(await cache.conditional(target, 'demo', '1.0.0', '/api/notes.json', '"api"')).toBe('miss')
  })

  it('文档导航带一致的 If-None-Match 也不短路（一律 miss 回源）', async () => {
    const cache = await seeded()
    expect(await cache.conditional(target, 'demo', '1.0.0', '/index.html', '"doc"')).toBe('miss')
  })

  it('静态子资源且 ETag 一致 ⇒ 304 语义', async () => {
    const cache = await seeded()
    expect(await cache.conditional(target, 'demo', '1.0.0', '/index.js', '"js"')).toEqual({ status: 304 })
  })

  it('静态子资源但 ETag 不一致 / 没有 ETag / 没有 If-None-Match ⇒ miss', async () => {
    const cache = await seeded()
    expect(await cache.conditional(target, 'demo', '1.0.0', '/index.js', '"other"')).toBe('miss')
    expect(await cache.conditional(target, 'demo', '1.0.0', '/index.js', undefined)).toBe('miss')
    expect(await cache.conditional(target, 'demo', '1.0.0', '/missing.js', '"js"')).toBe('miss')
    await cache.put(target, entry({ path: '/no-etag.json', headers: {} }))
    expect(await cache.conditional(target, 'demo', '1.0.0', '/no-etag.json', '"whatever"')).toBe('miss')
  })
})

describe('命中缓存必须重写宿主安全头（§7.5 R1-SEC-4）', () => {
  const target = scope('server-a', 'user-a')

  it('securityHeaders() 含四项硬性安全头', () => {
    const headers = securityHeaders()
    const csp = headers['Content-Security-Policy'] ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['Referrer-Policy']).toBe('no-referrer')
  })

  it('缓存里即使含旧 CSP（上一个会话/上一个宿主写的），读出时也一定是当前宿主安全头', async () => {
    const { cache, root } = await makeCache()
    await cache.put(target, entry())
    // 直接改落盘元数据 = 模拟「历史版本把旧 CSP 写进了缓存」。
    const metaPath = await onlyFile(versionDir(root, 'server-a', 'user-a', '1.0.0'), '.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { headers: Record<string, string> }
    meta.headers['content-security-policy'] = "default-src 'none'; connect-src 'none'"
    meta.headers['x-frame-options'] = 'SAMEORIGIN'
    meta.headers['referrer-policy'] = 'unsafe-url'
    await writeFile(metaPath, JSON.stringify(meta))

    const read = await cache.get(target, 'demo', '1.0.0', '/index.js')
    const current = securityHeaders()
    expect(read?.headers['Content-Security-Policy']).toBe(current['Content-Security-Policy'])
    expect(read?.headers['Content-Security-Policy']).toContain("connect-src 'self'")
    expect(read?.headers['Content-Security-Policy']).not.toContain("connect-src 'none'")
    expect(read?.headers['X-Frame-Options']).toBe('DENY')
    expect(read?.headers['Referrer-Policy']).toBe('no-referrer')
  })

  it('安全头不进缓存：并上宿主安全头的响应仍按平台响应缓存，落盘元数据里没有任何宿主安全头', async () => {
    const { cache, root } = await makeCache()
    // 注意：宿主安全头**不含** `Cache-Control` —— 否则这条响应会被当成平台
    // `no-store` 而永不缓存（这正是本用例钉住的边界）。
    await cache.put(target, entry({ headers: { ...securityHeaders(), 'Content-Type': 'application/javascript' } }))
    const metaPath = await onlyFile(versionDir(root, 'server-a', 'user-a', '1.0.0'), '.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { headers: Record<string, string> }
    const names = Object.keys(meta.headers).map((key) => key.toLowerCase())
    expect(names).not.toContain('content-security-policy')
    expect(names).not.toContain('x-frame-options')
    expect(names).not.toContain('x-content-type-options')
    expect(names).not.toContain('referrer-policy')
    expect(names).toContain('content-type')
    expect(await cache.get(target, 'demo', '1.0.0', '/index.js')).not.toBeNull()
  })

  it('命中时白名单头保留，白名单外的头一律丢弃', async () => {
    const { cache } = await makeCache()
    await cache.put(target, entry({
      headers: {
        ETag: '"v1"',
        'Content-Type': 'application/javascript',
        'Set-Cookie': 'sid=secret',
        'X-Secret': 'leak',
        'Content-Length': '999',
      },
    }))
    const read = await cache.get(target, 'demo', '1.0.0', '/index.js')
    expect(read?.status).toBe(200)
    expect(read?.headers.ETag ?? read?.headers.etag).toBe('"v1"')
    expect(header(read?.headers, 'content-type')).toBe('application/javascript')
    const names = Object.keys(read?.headers ?? {}).map((key) => key.toLowerCase())
    expect(names).not.toContain('set-cookie')
    expect(names).not.toContain('x-secret')
    expect(names).not.toContain('content-length')
  })
})

describe('写入策略：no-store / 非 2xx / 超容量 LRU（§7.5）', () => {
  const target = scope('server-a', 'user-a')

  it('no-store 一律不缓存', async () => {
    const { cache, root } = await makeCache()
    await cache.put(target, entry({ headers: { 'Cache-Control': 'no-store', ETag: '"v1"' } }))
    await cache.put(target, entry({ path: '/private.js', headers: { 'Cache-Control': 'private, no-store, max-age=0' } }))
    expect(await cache.get(target, 'demo', '1.0.0', '/index.js')).toBeNull()
    expect(await metaCount(root)).toBe(0)
    // 也不能留下临时文件（跳过写入 = 一个字节都不落）。
    expect(await listTree(root)).toHaveLength(0)
  })

  it('非 2xx 不缓存，2xx 才缓存', async () => {
    const { cache, root } = await makeCache()
    for (const status of [301, 404, 410, 500, 502]) {
      await cache.put(target, entry({ status, path: `/error-${status}.json` }))
    }
    expect(await metaCount(root)).toBe(0)
    await cache.put(target, entry({ status: 204, path: '/empty.json' }))
    expect(await metaCount(root)).toBe(1)
  })

  it('超过 maxBytes ⇒ 按 mtime 淘汰最旧，直到放下', async () => {
    // 一条记录的真实占用先量出来（meta 里躺着 CSP，条目大小不等于 body 大小），
    // 于是「装得下 2 条、装不下 3 条」这件事不依赖硬编码的字节数假设。
    const probe = await makeCache()
    await probe.cache.put(target, entry({ path: '/probe.js', body: bytes('p'.repeat(700)) }))
    const perEntry = await cacheBytes(versionDir(probe.root, 'server-a', 'user-a', '1.0.0'))
    expect(perEntry).toBeGreaterThan(700)

    const maxBytes = Math.floor(perEntry * 3)
    const { cache, root } = await makeCache({ maxBytes })
    await cache.put(target, entry({ path: '/old.js', body: bytes('o'.repeat(700)) }))
    const oldBody = await bodyFile(root, 'server-a', 'user-a')
    await cache.put(target, entry({ path: '/middle.js', body: bytes('m'.repeat(700)) }))
    await cache.put(target, entry({ path: '/fresh.js', body: bytes('f'.repeat(700)) }))
    // 前三条刚好在限额内 ⇒ 还没触发淘汰。
    expect(await cacheBytes(root)).toBeLessThanOrEqual(maxBytes)
    // 把最旧那条钉到过去：LRU = 按 mtime 判新旧，不依赖墙钟。
    await utimes(oldBody, new Date(1_000), new Date(1_000))

    await cache.put(target, entry({ path: '/newest.js', body: bytes('n'.repeat(700)) }))
    expect(await cacheBytes(root)).toBeLessThanOrEqual(maxBytes)
    expect(await cache.get(target, 'demo', '1.0.0', '/old.js')).toBeNull()
    expect(await cache.get(target, 'demo', '1.0.0', '/newest.js')).not.toBeNull()
  })

  it('单条就超过整个上限 ⇒ 不写且不触发淘汰', async () => {
    const { cache, root } = await makeCache({ maxBytes: 1024 })
    await cache.put(target, entry({ path: '/small.json', body: bytes('s'.repeat(100)) }))
    await cache.put(target, entry({ path: '/huge.json', body: bytes('h'.repeat(4096)) }))
    expect(await cache.get(target, 'demo', '1.0.0', '/huge.json')).toBeNull()
    expect(await cache.get(target, 'demo', '1.0.0', '/small.json')).not.toBeNull()
    expect(await cacheBytes(root)).toBeLessThanOrEqual(1024)
  })
})

describe('耐久与清理：权限 / 原子写 / 损坏读 / 作用域清理（§7.5）', () => {
  const scopeA = scope('server-a', 'user-a')
  const scopeB = scope('server-b', 'user-b')

  it('每一级缓存目录权限都是 0700', async () => {
    const { cache, root } = await makeCache()
    await cache.put(scopeA, entry())
    const levels = [
      root,
      join(root, digest('server-a')),
      join(root, digest('server-a'), digest('user-a')),
      appDir(root, 'server-a', 'user-a'),
      versionDir(root, 'server-a', 'user-a', '1.0.0'),
    ]
    for (const level of levels) {
      expect((await stat(level)).mode & 0o777, level).toBe(0o700)
    }
  })

  it('写入走「临时文件 + rename」原子替换（提交点是 meta 的 rename）', async () => {
    const { cache } = await makeCache()
    renameWatch.calls.length = 0
    renameWatch.active = true
    try {
      await cache.put(scopeA, entry())
    } finally {
      renameWatch.active = false
    }
    expect(renameWatch.calls.length).toBeGreaterThan(0)
    for (const call of renameWatch.calls) {
      // 源一定是 `*.tmp`（同目录临时文件），目标是最终名 —— 覆盖替换是原子的。
      expect(call.from.endsWith('.tmp'), call.from).toBe(true)
      expect(call.to.endsWith('.tmp'), call.to).toBe(false)
    }
    expect(renameWatch.calls.some((call) => call.to.endsWith('.bin'))).toBe(true)
    expect(renameWatch.calls.some((call) => call.to.endsWith('.json'))).toBe(true)
  })

  it('并发写同一键不留半条记录，也不留临时文件', async () => {
    const { cache, root } = await makeCache()
    const bodies = Array.from({ length: 8 }, (_, index) => bytes(`body-${index}`))
    await Promise.all(bodies.map((body) => cache.put(scopeA, entry({ body }))))
    const read = await cache.get(scopeA, 'demo', '1.0.0', '/index.js')
    expect(read).not.toBeNull()
    expect(bodies.map((body) => text(body))).toContain(text(read?.body))
    const tree = await listTree(root)
    expect(tree.filter((path) => path.endsWith('.tmp'))).toHaveLength(0)
    expect(tree.filter((path) => path.endsWith('.json'))).toHaveLength(1)
    expect(tree.filter((path) => path.endsWith('.bin'))).toHaveLength(1)
  })

  it('元数据损坏（非法 JSON）⇒ 当 miss + warn，不抛', async () => {
    const { cache, root, warnings } = await makeCache()
    await cache.put(scopeA, entry())
    await writeFile(await onlyFile(versionDir(root, 'server-a', 'user-a', '1.0.0'), '.json'), '{ 这不是 JSON')
    await expect(cache.get(scopeA, 'demo', '1.0.0', '/index.js')).resolves.toBeNull()
    expect(warnings.some((message) => message.includes('元数据'))).toBe(true)
  })

  it('元数据缺字段 / 字段类型不符 ⇒ 当 miss + warn，不抛', async () => {
    const missingStatus = await makeCache()
    await missingStatus.cache.put(scopeA, entry())
    await writeFile(
      await onlyFile(versionDir(missingStatus.root, 'server-a', 'user-a', '1.0.0'), '.json'),
      JSON.stringify({ headers: {} }),
    )
    await expect(missingStatus.cache.get(scopeA, 'demo', '1.0.0', '/index.js')).resolves.toBeNull()
    expect(missingStatus.warnings.some((message) => message.includes('缺字段'))).toBe(true)

    const badType = await makeCache()
    await badType.cache.put(scopeA, entry())
    await writeFile(
      await onlyFile(versionDir(badType.root, 'server-a', 'user-a', '1.0.0'), '.json'),
      JSON.stringify({ status: 200, headers: { etag: 42 } }),
    )
    await expect(badType.cache.get(scopeA, 'demo', '1.0.0', '/index.js')).resolves.toBeNull()
    expect(badType.warnings.some((message) => message.includes('缺字段'))).toBe(true)
  })

  it('响应体缺失 ⇒ 当 miss + warn，不抛', async () => {
    const { cache, root, warnings } = await makeCache()
    await cache.put(scopeA, entry())
    await rm(await bodyFile(root, 'server-a', 'user-a'))
    await expect(cache.get(scopeA, 'demo', '1.0.0', '/index.js')).resolves.toBeNull()
    expect(warnings.some((message) => message.includes('响应体'))).toBe(true)
  })

  it('键形态非法（路径穿越 / 空段）⇒ 拒绝落盘且缓存为空', async () => {
    const { cache, root } = await makeCache()
    await cache.put(scope('../../etc', 'user-a'), entry())
    await cache.put(scopeA, entry({ appId: '../../escape' }))
    await cache.put(scopeA, entry({ version: '../../../etc/passwd' }))
    await cache.put(scopeA, entry({ path: '   ' }))
    expect(await metaCount(root)).toBe(0)
    expect(await readdir(root)).toHaveLength(0)
  })

  it('clearApp 只删当前 scope 下该应用的目录，别的 scope 仍在', async () => {
    const { cache } = await makeCache()
    await cache.put(scopeA, entry({ version: '1.0.0' }))
    await cache.put(scopeA, entry({ version: '2.0.0' }))
    await cache.put(scopeB, entry({ version: '1.0.0' }))
    await expect(cache.clearApp(scopeA, 'demo')).resolves.toBeUndefined()
    expect(await cache.get(scopeA, 'demo', '1.0.0', '/index.js')).toBeNull()
    expect(await cache.get(scopeA, 'demo', '2.0.0', '/index.js')).toBeNull()
    expect(await cache.get(scopeB, 'demo', '1.0.0', '/index.js')).not.toBeNull()
  })

  it('clearAll 之后缓存为空，且根目录以 0700 重建', async () => {
    const { cache, root } = await makeCache()
    await cache.put(scopeA, entry())
    await cache.put(scopeB, entry())
    await cache.clearAll()
    expect(await cache.get(scopeA, 'demo', '1.0.0', '/index.js')).toBeNull()
    expect(await metaCount(root)).toBe(0)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
  })
})

/**
 * `/api/pico/agent-presets` 写面路由（独立复审 2026-09-23 **N2** + **A12**）。
 *
 * 现场：
 *  - **N2（P2）**：这条路由**不读任何 query**，而 `installPresetArchive` 对已存在
 *    目录一律拒收 ⇒ 面板「更新智能体」必然失败（`preset "x" already exists locally`），
 *    「覆盖确认 / `?overwrite=1`」整条是死面（技能侧早已支持）。
 *  - **A12（P2）**：安装/卸载的失败仍是**裸分类 + 原文** ⇒ 系统级错误
 *    （`ENOTDIR: not a directory, mkdir '/home/<user>/…'`）把本机绝对路径透给 UI。
 *
 * 本用例走**真实路由**（真 apply、真 holder、真磁盘）：
 *  1. 带 `?overwrite=1` 与不带，覆盖一个"本机自制"的同名预设 —— 409 `LOCAL_CONTENT`
 *     与 200 各一次，且拒绝时磁盘一字未动；
 *  2. 商店来源（能力中心装的）的同名预设可直接更新（不带 query）；
 *  3. 系统级失败（安装根不是目录 ⇒ `ENOTDIR`）的错误文案里**不含本机绝对路径**，
 *     且状态码不是 422/500 的原样透传。
 *
 * 变异验证：
 *  - 路由里去掉 `overwrite` 的读取（`const overwrite = …` 恒 false）⇒ 第 1、2 条红；
 *  - 把错误分支换回 `isRefusal ? 422 : 502` + 原文 ⇒ 第 3 条红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import { resolvePresetsDir } from '../src/agent-preset-install.ts'
import type { Session } from '../src/server-connector/config.ts'

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

const COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: hi
`

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeReq(url: string, method = 'GET', host = '127.0.0.1:3080'): IncomingMessage {
  return {
    method,
    url,
    headers: {
      origin: `http://${host}`,
      host,
      'sec-fetch-site': 'same-origin',
      cookie: `dsh-auth-${host}=v1.signature`,
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      try {
        body = JSON.parse(chunk === undefined ? '{}' : Buffer.from(chunk).toString())
      } catch {
        body = undefined
      }
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

function harness(): { call: (url: string, method?: string) => Promise<{ code: number, body: any }> } {
  const routes: Route[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection'
      ? { requestRejection: (request: { headers: Record<string, unknown> }) => (request.headers['cookie'] === undefined ? (401 as const) : undefined) }
      : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => true,
      getSession: () => SESSION,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {} as Config)
  const handler = routes.find(r => r.kind === 'prefix' && r.path === '/api/pico/agent-presets')?.handler
  if (handler === undefined) throw new Error('agent-presets route not registered')
  return {
    call: async (url: string, method = 'GET') => {
      const { res, read } = fakeRes()
      await handler(fakeReq(url, method), res)
      return read()
    },
  }
}

/** 把一组文件打成与 Go 侧同口径的 tar.gz（客户端安装链路的夹具）。 */
async function presetArchive(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'pico-preset-src-'))
  try {
    const names: string[] = []
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
      names.push(path)
    }
    const chunks: Buffer[] = []
    const tar = await import('tar')
    const stream = tar.c({ gzip: true, cwd: dir, portable: true, noMtime: true }, names)
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
    return Buffer.concat(chunks)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 假网关：只实现 agent-presets 的归档下载（带 sha256 头，与真实服务端同形状）。 */
function stubGateway(archive: Buffer): void {
  const checksum = createHash('sha256').update(archive).digest('hex')
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (/\/api\/client\/v2\/agent-presets\/[^/]+\/archive$/u.test(href)) {
      return new Response(archive, {
        status: 200,
        headers: {
          'content-type': 'application/gzip',
          'x-preset-checksum': checksum,
          'x-preset-version': '2.0.0',
        },
      })
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  }))
}

/** 手写一个本机自制预设目录（有 composition、**没有** provenance ⇒ 非商店来源）。 */
async function makeLocalPreset(dir: string, name: string): Promise<string> {
  const target = join(dir, name)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'agent.cordis.yml'), COMPOSITION)
  await writeFile(join(target, 'notes.md'), 'my own notes\n')
  return target
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-agent-presets-route-'))
  vi.stubEnv('DSH_HOME', home)
  // DSH_HOME 指向系统关键目录的守卫在 dsh-home 里，这里只需一个普通临时目录。
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('/api/pico/agent-presets 的覆盖确认（N2：两端都真读 ?overwrite=1）', () => {
  it('本机自制同名预设：无 query ⇒ 409 LOCAL_CONTENT 且磁盘一字未动', async () => {
    const presetsDir = resolvePresetsDir()
    expect(presetsDir).toBe(join(home, '.agent-presets'))
    const mine = await makeLocalPreset(presetsDir, 'dup')
    stubGateway(await presetArchive({ 'agent.cordis.yml': COMPOSITION, 'preset.yml': 'name: store\n' }))

    const h = harness()
    const refused = await h.call('/api/pico/agent-presets/dup/install', 'POST')
    expect(refused.code).toBe(409)
    expect(refused.body.code).toBe('LOCAL_CONTENT')
    expect(await readFile(join(mine, 'notes.md'), 'utf8')).toBe('my own notes\n')
    // 拒绝时不留 staging（点号目录本来就是安装器的私有面）。
    expect((await readdir(presetsDir)).filter(n => n.startsWith('.'))).toEqual([])
  })

  it('本机自制同名预设：带 ?overwrite=1（用户已确认）⇒ 200 且整树替换', async () => {
    const presetsDir = resolvePresetsDir()
    const mine = await makeLocalPreset(presetsDir, 'dup')
    stubGateway(await presetArchive({ 'agent.cordis.yml': COMPOSITION, 'preset.yml': 'name: store\n' }))

    const h = harness()
    const ok = await h.call('/api/pico/agent-presets/dup/install?overwrite=1', 'POST')
    expect(ok.code, JSON.stringify(ok.body)).toBe(200)
    await expect(readFile(join(mine, 'notes.md'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(mine, 'preset.yml'), 'utf8')).toBe('name: store\n')
  })

  it('商店来源（能力中心装的）同名预设：不带 query 也直接更新（N2 的「更新智能体」路径）', async () => {
    const presetsDir = resolvePresetsDir()
    stubGateway(await presetArchive({ 'agent.cordis.yml': COMPOSITION, 'preset.yml': 'name: v1\n' }))

    const h = harness()
    const first = await h.call('/api/pico/agent-presets/dup/install', 'POST')
    expect(first.code, JSON.stringify(first.body)).toBe(200)

    stubGateway(await presetArchive({ 'agent.cordis.yml': COMPOSITION, 'preset.yml': 'name: v2\n' }))
    const second = await h.call('/api/pico/agent-presets/dup/install', 'POST')
    expect(second.code, JSON.stringify(second.body)).toBe(200)
    expect(await readFile(join(presetsDir, 'dup', 'preset.yml'), 'utf8')).toBe('name: v2\n')
    // 更新成功不留 staging / backup 残渣。
    expect((await readdir(presetsDir)).filter(n => n.startsWith('.'))).toEqual([])
  })

  it('卸载也读同一个标记：无 query ⇒ 409，带 ?overwrite=1 ⇒ 200', async () => {
    const presetsDir = resolvePresetsDir()
    await makeLocalPreset(presetsDir, 'mine')
    stubGateway(await presetArchive({ 'agent.cordis.yml': COMPOSITION }))
    const h = harness()

    const refused = await h.call('/api/pico/agent-presets/mine/uninstall', 'POST')
    expect(refused.code).toBe(409)
    expect(refused.body.code).toBe('LOCAL_CONTENT')
    expect(await readFile(join(presetsDir, 'mine', 'agent.cordis.yml'), 'utf8')).toBe(COMPOSITION)

    const ok = await h.call('/api/pico/agent-presets/mine/uninstall?overwrite=1', 'POST')
    expect(ok.code, JSON.stringify(ok.body)).toBe(200)
    expect(await readdir(presetsDir)).toEqual([])
  })
})

describe('/api/pico/agent-presets 的失败文案（A12：唯一实现 + 脱敏）', () => {
  it('系统级失败不回显本机绝对路径（errno + 人话，路径被剥掉）', async () => {
    const presetsDir = resolvePresetsDir()
    // 安装根位置放一个**普通文件** ⇒ 安装器的 mkdir 抛系统级 errno（真实失败路径）。
    await writeFile(presetsDir, 'not a directory')
    stubGateway(await presetArchive({ 'agent.cordis.yml': COMPOSITION }))

    const h = harness()
    const res = await h.call('/api/pico/agent-presets/dup/install', 'POST')
    expect(res.code).not.toBe(200)
    const message = String(res.body.error)
    expect(message).not.toContain(home)
    expect(message).not.toContain(presetsDir)
    // 脱敏保留 errno 与原因（人话），只去掉路径 —— 与技能侧 sanitizeArchiveErrorText 同源。
    expect(message).toMatch(/^E[A-Z]+: /u)
    expect(message).not.toMatch(/tmp[\\/]/u)
  })

  it('未安装的预设 ⇒ 404 NOT_INSTALLED（不是 500，也不是原文透传）', async () => {
    stubGateway(await presetArchive({ 'agent.cordis.yml': COMPOSITION }))
    const h = harness()
    const res = await h.call('/api/pico/agent-presets/ghost/uninstall', 'POST')
    expect(res.code).toBe(404)
    expect(res.body.code).toBe('NOT_INSTALLED')
    expect(String(res.body.error)).not.toContain(home)
  })

  it('归档不合规（缺 composition）⇒ 422 且文案可读（拒绝类不被当上游 502）', async () => {
    stubGateway(await presetArchive({ 'README.md': 'hi' }))
    const h = harness()
    const res = await h.call('/api/pico/agent-presets/nocomp/install', 'POST')
    expect(res.code).toBe(422)
    expect(String(res.body.error)).toContain('agent.cordis.yml')
    expect(String(res.body.error)).not.toContain(home)
  })
})

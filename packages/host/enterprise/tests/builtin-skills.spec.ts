/**
 * 「平台内置技能」客户端链路（2026-09-18）。
 *
 * 用户要求：**skill 内置到服务端，客户端按需安装**。服务端那一半由
 * `server/internal/wasmapp/skillseed` 提供（清单 + tar.gz 包，带 sha256 头）；
 * 本用例钉住客户端这一半：
 *
 *  1. `GET /api/pico/skills/builtin` → 服务端清单 + 本机已装列表；
 *  2. `POST /api/pico/skills/builtin/:name/install` → **复用既有安装链路**
 *     （`installSkillArchive`）把整棵树落到 `<dshHome>/skills`，文件逐字节一致；
 *  3. 完整性头缺失 / 对不上 ⇒ 拒绝（内置技能是我们自己的服务端下发的，缺
 *     checksum 没有任何理由放行 —— 而 skill-install 在"没有头"时会静默跳过校验）；
 *  4. 带 `../` 的归档 ⇒ 拒绝，且磁盘上不留任何东西；
 *  5. 认证：未登录 401、auditor 写面 403（与市场安装同口径）。
 *
 * 变异验证（去掉对应防护后哪条会红）：
 *  - 去掉「缺 checksum 就拒」→ 第 3 条红；
 *  - 去掉 installSkillArchive 的 sha256 对照 → 第 3 条（对不上）红；
 *  - 去掉归档安全扫描 → 第 4 条红；
 *  - 去掉 writeGuard → 第 5 条红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import { builtinAction, builtinInstallEndpoint, builtinRowState, selectBuiltinCards, type BuiltinSkill } from '../src/client/BuiltinSkillsStrip.tsx'
import { APP_BUILDER_SKILL, builtinSkillInstallHint, isBuiltinSkillInstalled } from '../src/builtin-skills.ts'
import { readProvenance, resolveSkillsDir } from '../src/skill-install.ts'
import type { Session } from '../src/server-connector/config.ts'

const SOURCE_SKILL_DIR = join(__dirname, '..', '..', '..', '..', 'server', 'skills', 'app-builder')

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

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

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any, raw: Buffer } } {
  let code = 0
  let raw = Buffer.alloc(0)
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      raw = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk)
      try {
        body = JSON.parse(raw.toString())
      } catch {
        body = undefined
      }
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body, raw }) }
}

/** 宿主侧 `connection` 服务的持有性证明栅栏（与既有 auth-gate 用例同口径）。 */
function browserFence(): { requestRejection: (r: { headers: Record<string, unknown> }) => 401 | undefined } {
  return {
    requestRejection: (request: { headers: Record<string, unknown> }) =>
      (request.headers['cookie'] === undefined ? (401 as const) : undefined),
  }
}

function harness(session: Session | null): { call: (url: string, method?: string) => Promise<{ code: number, body: any, raw: Buffer }> } {
  const routes: Route[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? browserFence() : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => session !== null,
      getSession: () => session,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {} as Config)
  const handler = routes.find(r => r.kind === 'prefix' && r.path === '/api/pico/skills')?.handler
  if (handler === undefined) throw new Error('skills route not registered')
  return {
    call: async (url: string, method = 'GET') => {
      const { res, read } = fakeRes()
      await handler(fakeReq(url, method), res)
      return read()
    },
  }
}

/**
 * 把真实技能目录打成 tar.gz（与 Go 侧 PackDir 同口径：条目排序、gzip 收流）。
 * 这里只当**夹具**：被测的是客户端拿到归档之后做了什么，不是打包本身
 * （打包由 server/internal/wasmapp/skillseed 的 Go 用例钉住）。
 */
async function packSkillTarGz(sourceDir: string): Promise<Buffer> {
  const names: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        // 只列文件：`tar.c` 对目录项会**递归**打包，同时又显式列了里面的文件
        // 就会产生重复条目（安装器按设计拒绝重复条目）。真实归档（Go 侧
        // PackDir）带目录条目，那条路径由 Go 用例与跨语言 E2E 脚本覆盖。
        await walk(join(dir, entry.name), rel)
        continue
      } else {
        names.push(rel)
      }
    }
  }
  await walk(sourceDir, '')
  const chunks: Buffer[] = []
  const stream = tar.c({ gzip: true, cwd: sourceDir, portable: true, noMtime: true }, names)
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

/**
 * 手搓一个 tar.gz（可带任意条目名 —— 用来构造 `../` 穿越这种恶意归档）。
 * 只用 512 字节 ustar 头 + gzip，不借第三方写入 API：`tar.c` 只接受真实文件，
 * 而"名字里有 `..` 的文件"在文件系统上根本造不出来。
 */
function packRawTarGz(entries: ReadonlyArray<{ name: string, body: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body, 'utf8')
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** 组装一个假服务端：只实现内置技能的两个端点（与真实服务端同形状）。 */
function stubServer(archive: Buffer, opts: { checksum?: string | null, version?: string | null, status?: number } = {}): void {
  const checksum = opts.checksum === undefined ? createHash('sha256').update(archive).digest('hex') : opts.checksum
  const version = opts.version === undefined ? '1.0.0' : opts.version
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.endsWith('/api/client/v2/skills/builtin')) {
      if (opts.status !== undefined) return new Response('{}', { status: opts.status })
      return new Response(JSON.stringify({
        skills: [{ name: 'app-builder', version: '1.0.0', title: 'PicoAide 应用构建', description: '写一个 WASM 应用', source: 'builtin' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/api/client/v2/skills/builtin/') && href.endsWith('/archive')) {
      if (opts.status !== undefined) return new Response('{}', { status: opts.status })
      const headers: Record<string, string> = { 'content-type': 'application/gzip' }
      if (checksum !== null) headers['x-skill-checksum'] = checksum
      if (version !== null) headers['x-skill-version'] = version
      return new Response(archive, { status: 200, headers })
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  }))
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-builtin-skills-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

describe('内置技能：清单与按需安装（服务端下发 → 本机技能库）', () => {
  it('GET /api/pico/skills/builtin 透传服务端清单并附上本机已装列表', async () => {
    const archive = await packSkillTarGz(SOURCE_SKILL_DIR)
    stubServer(archive)
    const h = harness(SESSION)
    const res = await h.call('/api/pico/skills/builtin')
    expect(res.code).toBe(200)
    expect(res.body.skills?.[0]?.name).toBe('app-builder')
    expect(res.body.installed).toEqual([])
  })

  it('POST …/install 复用既有安装链路：整树落 <dshHome>/skills，文件逐字节一致', async () => {
    const archive = await packSkillTarGz(SOURCE_SKILL_DIR)
    stubServer(archive)
    const h = harness(SESSION)
    const res = await h.call('/api/pico/skills/builtin/app-builder/install', 'POST')
    expect(res.code, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ ok: true, name: 'app-builder', version: '1.0.0' })

    // 落点就是能力中心市场技能那个根（上游 skill-filesystem 的 user-dsh root）。
    const skillsDir = resolveSkillsDir()
    expect(skillsDir).toBe(join(home, 'skills'))
    const installed = join(skillsDir, 'app-builder')

    // 源目录的每个文件都必须在，且逐字节一致（整目录：正文 + references + examples）。
    const source = await listFiles(SOURCE_SKILL_DIR)
    expect(source.length).toBeGreaterThanOrEqual(10)
    for (const rel of source) {
      const want = await readFile(join(SOURCE_SKILL_DIR, rel))
      const got = await readFile(join(installed, rel))
      expect(got.equals(want), `${rel} 必须逐字节一致`).toBe(true)
    }
    // 安装器写的版本标记 + 溯源标记（渠道 = builtin）。
    expect((await readFile(join(installed, '.install-version'), 'utf8')).trim()).toBe('1.0.0')
    const prov = await readProvenance(installed)
    expect(prov?.channel).toBe('builtin')
    expect(prov?.version).toBe('1.0.0')
    expect(prov?.server).toBe('https://harness.example')
    // 落点之外不留暂存目录。
    const leftovers = (await readdir(skillsDir)).filter(n => n.startsWith('.'))
    expect(leftovers).toEqual([])
  })

  it('清单里的 sha256 头与服务端下发字节对不上 → 拒绝安装（sha256 对照真的生效）', async () => {
    const archive = await packSkillTarGz(SOURCE_SKILL_DIR)
    stubServer(archive, { checksum: 'deadbeef'.repeat(8) })
    const h = harness(SESSION)
    const res = await h.call('/api/pico/skills/builtin/app-builder/install', 'POST')
    expect(res.code).toBe(422)
    expect(String(res.body.error)).toMatch(/checksum/u)
    // 拒绝时必须什么都没落下（不能留半安装状态）。
    await expect(stat(join(resolveSkillsDir(), 'app-builder'))).rejects.toThrow()
  })

  it('完整性头缺失 → fail-closed 拒绝（内置技能没有"跳过校验"这条路径）', async () => {
    const archive = await packSkillTarGz(SOURCE_SKILL_DIR)
    stubServer(archive, { checksum: null })
    const h = harness(SESSION)
    const missingChecksum = await h.call('/api/pico/skills/builtin/app-builder/install', 'POST')
    expect(missingChecksum.code).toBe(502)
    expect(String(missingChecksum.body.error)).toMatch(/integrity headers/u)

    stubServer(archive, { version: null })
    const h2 = harness(SESSION)
    const missingVersion = await h2.call('/api/pico/skills/builtin/app-builder/install', 'POST')
    expect(missingVersion.code).toBe(502)
    await expect(stat(join(resolveSkillsDir(), 'app-builder'))).rejects.toThrow()
  })

  it('归档含 ../ 穿越 → 拒绝，且磁盘上不留任何东西', async () => {
    // 手搓一个带 `../evil.txt` 的 tar.gz（绕过打包侧）：安装器必须拒。
    const traversing = packRawTarGz([
      { name: '../evil.txt', body: 'pwned' },
      { name: 'SKILL.md', body: '---\nname: app-builder\ndescription: x\n---\nbody' },
    ])

    stubServer(traversing)
    const h = harness(SESSION)
    const res = await h.call('/api/pico/skills/builtin/app-builder/install', 'POST')
    expect(res.code).toBe(422)
    expect(String(res.body.error)).toMatch(/traversal|unsafe|absolute/u)
    await expect(stat(join(resolveSkillsDir(), 'app-builder'))).rejects.toThrow()
  })

  it('认证与审计角色：未登录 401、auditor 写面 403（与市场安装同口径）', async () => {
    const archive = await packSkillTarGz(SOURCE_SKILL_DIR)
    stubServer(archive)
    const anon = harness(null)
    const anonList = await anon.call('/api/pico/skills/builtin')
    expect(anonList.code).toBe(401)

    stubServer(archive)
    const auditor = harness({ ...SESSION, role: 'auditor' })
    const denied = await auditor.call('/api/pico/skills/builtin/app-builder/install', 'POST')
    expect(denied.code).toBe(403)
    await expect(stat(join(resolveSkillsDir(), 'app-builder'))).rejects.toThrow()
  })

  it('旧版服务端没有内置技能端点 → 原样透传状态码（面板据此隐藏整块）', async () => {
    const archive = await packSkillTarGz(SOURCE_SKILL_DIR)
    stubServer(archive, { status: 404 })
    const h = harness(SESSION)
    const res = await h.call('/api/pico/skills/builtin')
    expect(res.code).toBe(404)
  })

  it('安装动作只认内置技能的路径（市场安装分支未被这条新路径污染）', async () => {
    const archive = await packSkillTarGz(SOURCE_SKILL_DIR)
    stubServer(archive)
    const h = harness(SESSION)
    // 单段路径仍是市场安装（会去 marketplace 端点，假服务端给 404）。
    const marketplace = await h.call('/api/pico/skills/codeql/install', 'POST')
    expect(marketplace.code).toBe(404)
  })
})

describe('工具面用的共享判定：技能装了没有 + 指路文案', () => {
  it('isBuiltinSkillInstalled 只看磁盘事实（<dshHome>/skills/<name>/SKILL.md）', async () => {
    expect(APP_BUILDER_SKILL).toBe('app-builder')
    expect(await isBuiltinSkillInstalled()).toBe(false)
    const dir = join(resolveSkillsDir(), 'app-builder')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: app-builder\ndescription: x\n---\nbody', 'utf8')
    expect(await isBuiltinSkillInstalled()).toBe(true)
    // 目录在但没有 SKILL.md 不算装好（半安装状态不得被当成可用）。
    expect(await isBuiltinSkillInstalled('other-skill')).toBe(false)
  })

  it('指路文案按宿主语言取，并点名技能与可执行入口（能力中心）', () => {
    const zh = builtinSkillInstallHint('zh')
    expect(zh).toContain('app-builder')
    expect(zh).toContain('能力中心')
    expect(zh).toContain('安装')
    const en = builtinSkillInstallHint('en')
    expect(en).toContain('app-builder')
    expect(en).toContain('Capability Hub')
    expect(en).toContain('Install')
    expect(zh).not.toBe(en)
  })
})

describe('内置技能区：按钮语义与端点（纯函数）', () => {
  const skill: BuiltinSkill = { name: 'app-builder', version: '1.2.0' }

  it('未装 → 安装；已装同版本 → 已安装；已装旧版本 → 更新（版本比较是数值感知的）', () => {
    expect(builtinAction('1.0.0', undefined, false)).toBe('install')
    expect(builtinAction('1.0.0', '1.0.0', true)).toBe('installed')
    expect(builtinAction('1.10.0', '1.9.0', true)).toBe('update')
    expect(builtinAction('1.9.0', '1.10.0', true)).toBe('installed')
    // 版本未知（provenance 读不到）时保守判"已安装"，不谎报可更新。
    expect(builtinAction('9.9.9', undefined, true)).toBe('installed')
    expect(builtinAction('9.9.9', '', true)).toBe('installed')
  })

  it('安装端点固定走宿主代理（不直连服务端），覆盖安装带 force', () => {
    expect(builtinInstallEndpoint(skill.name, false)).toBe('/api/pico/skills/builtin/app-builder/install')
    expect(builtinInstallEndpoint(skill.name, true)).toBe('/api/pico/skills/builtin/app-builder/install?force=1')
    // 名字里的路径字符必须被转义（不给服务端拼路径的机会）。
    expect(builtinInstallEndpoint('../evil', false)).toBe('/api/pico/skills/builtin/..%2Fevil/install')
  })
})

// ---------------------------------------------------------------------------
// 一行的按钮区状态（独立审计 2026-09-18 P2-5 的回归网）
// ---------------------------------------------------------------------------

describe('内置技能行的按钮区状态：失败只影响那一行', () => {
  it('未装 ⇒ action；装好 ⇒ installed；正在装 ⇒ busy', () => {
    const none = { installed: [], busy: null, failedName: null }
    expect(builtinRowState('app-builder', none)).toBe('action')
    expect(builtinRowState('app-builder', { ...none, installed: ['app-builder'] })).toBe('installed')
    expect(builtinRowState('app-builder', { ...none, busy: 'app-builder' })).toBe('busy')
  })

  it('**一行失败不影响其它行**（曾经的形态：全局 failed ⇒ 所有行变错误文案、无按钮、无重试）', () => {
    const state = { installed: [] as string[], busy: null, failedName: 'broken-skill' }
    // 失败的那一行：显示错误 + 重试（渲染层据此出重试按钮）。
    expect(builtinRowState('broken-skill', state)).toBe('failed')
    // 其它行：**仍然是可点的 action**，不能被一句全局错误连坐。
    expect(builtinRowState('app-builder', state)).toBe('action')
    expect(builtinRowState('another-skill', state)).toBe('action')
  })

  it('已装的行永远显示已安装，即使别的行正在装/刚失败', () => {
    const state = { installed: ['done-skill'], busy: 'busy-skill', failedName: 'busy-skill' }
    expect(builtinRowState('done-skill', state)).toBe('installed')
  })
})

// ---------------------------------------------------------------------------
// 内置技能以"普通技能卡片"渲染（2026-09-18 用户口径）
// ---------------------------------------------------------------------------
//
// 用户现场反馈：能力中心里内置技能被渲染成**顶部置顶的一条横幅**，而其它技能都是
// 网格里的普通卡片。现在内置技能只在**未安装**时以普通卡片出现在「我的」网格里
// （已装的由本机技能库扫描出来的那张普通卡片代表它，避免同一个技能两张卡）。

describe('内置技能以普通卡片渲染：只渲染未安装的、参与搜索与筛选', () => {
  const ROWS = [
    { name: 'app-builder', version: '1.0.0', title: 'PicoAide 应用构建（WASM 应用）', description: '用 Go 写一个应用平台上的 WASM 应用', author: 'PicoAide', category: '应用开发' },
    { name: 'another-builtin', version: '2.0.0', title: '另一个内置技能', description: '无关描述' },
  ]

  it('未安装 ⇒ 渲染成卡片', () => {
    const rows = selectBuiltinCards({ rows: ROWS, installedNames: new Set(), query: '', kindFilter: 'all' })
    expect(rows.map(r => r.name)).toEqual(['app-builder', 'another-builtin'])
  })

  it('已安装 ⇒ 不再渲染（本机技能库里的普通卡片就是它）', () => {
    const rows = selectBuiltinCards({
      rows: ROWS,
      installedNames: new Set(['app-builder']),
      query: '',
      kindFilter: 'all',
    })
    expect(rows.map(r => r.name)).toEqual(['another-builtin'])
  })

  it('两个事实源任一说"已装"都按已装处理（宁可少一张入口卡，也不要重复卡）', () => {
    // 服务端 installed[] 与面板本地列表可能不同步：并集后仍必须排除。
    const union = new Set(['app-builder'])
    expect(selectBuiltinCards({ rows: ROWS, installedNames: union, query: '', kindFilter: 'skill' })).toHaveLength(1)
  })

  it('参与搜索：按标题/名字/描述/作者/分类命中（与普通卡片同口径）', () => {
    const byTitle = selectBuiltinCards({ rows: ROWS, installedNames: new Set(), query: '应用构建', kindFilter: 'all' })
    expect(byTitle.map(r => r.name)).toEqual(['app-builder'])
    const byDesc = selectBuiltinCards({ rows: ROWS, installedNames: new Set(), query: 'wasm', kindFilter: 'all' })
    expect(byDesc.map(r => r.name)).toEqual(['app-builder'])
    const byAuthor = selectBuiltinCards({ rows: ROWS, installedNames: new Set(), query: 'picoaide', kindFilter: 'all' })
    expect(byAuthor.map(r => r.name)).toEqual(['app-builder'])
    const noHit = selectBuiltinCards({ rows: ROWS, installedNames: new Set(), query: '不存在的东西', kindFilter: 'all' })
    expect(noHit).toEqual([])
  })

  it('类型筛选为"智能体"时不渲染（内置的目前都是技能）', () => {
    expect(selectBuiltinCards({ rows: ROWS, installedNames: new Set(), query: '', kindFilter: 'agent' })).toEqual([])
  })
})

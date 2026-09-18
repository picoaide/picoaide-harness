/**
 * 跨语言端到端：**服务端真正会下发的那串字节** → **真的安装器** → `<dshHome>/skills`。
 *
 * 与 `builtin-skills.spec.ts` 的区别只在归档从哪来：那份是 CI 常跑回归（夹具用
 * node-tar 现打），这份把**Go 侧 `skillseed.PackDir` 真正产出的字节**喂进同一条
 * 安装链路 —— 打包格式（目录条目 / 排序 / gzip 头）与客户端解包器之间的兼容性
 * 只有这条链路能证。
 *
 * 默认跳过（需要 Go 工具链，CI 的 gate job 没有）：它不是常规回归用例，而是
 * 取证出口。跑法：
 *   cd packages/host/enterprise
 *   SKILLSEED_GO_E2E=1 HOME=<可写的 home> ./node_modules/.bin/vitest run tests/builtin-skills-go-e2e.spec.ts
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import { resolveSkillsDir } from '../src/skill-install.ts'
import type { Session } from '../src/server-connector/config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const SERVER_DIR = join(REPO_ROOT, 'server')
const SOURCE_SKILL_DIR = join(REPO_ROOT, 'packages', 'vendor', 'memory-evolve', 'skills', 'picoaide-app-builder')

const enabled = process.env.SKILLSEED_GO_E2E === '1'
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

function fakeReq(url: string, method: string): IncomingMessage {
  const host = '127.0.0.1:3080'
  return {
    method,
    url,
    headers: { origin: `http://${host}`, host, 'sec-fetch-site': 'same-origin', cookie: `dsh-auth-${host}=v1.signature` },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let raw = Buffer.alloc(0)
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => { raw = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk) },
  } as unknown as ServerResponse
  return {
    res,
    read: () => {
      let body: unknown
      try { body = JSON.parse(raw.toString()) } catch { body = undefined }
      return { code, body }
    },
  }
}

function skillsRoute(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes: Route[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection'
      ? { requestRejection: (r: { headers: Record<string, unknown> }) => (r.headers['cookie'] === undefined ? 401 as const : undefined) }
      : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => true,
      getSession: () => SESSION,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: { tapIndex: () => () => {}, register: (route: Route) => { routes.push(route); return () => {} } },
  }
  apply(ctx as never, {} as Config)
  const handler = routes.find(r => r.kind === 'prefix' && r.path === '/api/pico/skills')?.handler
  if (handler === undefined) throw new Error('skills route not registered')
  return handler
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

let work: string
let home: string
let archive: Buffer
let goReportedSha: string

beforeAll(async () => {
  if (!enabled) return
  work = await mkdtemp(join(tmpdir(), 'skillseed-go-e2e-'))
  home = join(work, 'home')
  const out = join(work, 'builtin.tar.gz')
  // 用 Go 侧真正的打包器产出归档（打包逻辑只在 server 里实现一次）。
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SKILLSEED_E2E_OUT: out,
    GOCACHE: process.env.GOCACHE ?? join(work, 'gocache'),
    GOMODCACHE: process.env.GOMODCACHE ?? join(work, 'gomodcache'),
    GOPATH: process.env.GOPATH ?? join(work, 'gopath'),
  }
  const log = execFileSync('go', ['test', './internal/wasmapp/skillseed/', '-run', 'TestExportArchiveForE2E', '-count=1', '-v'], {
    cwd: SERVER_DIR, env, encoding: 'utf8',
  })
  const match = /sha256=([0-9a-f]{64})/u.exec(log)
  if (match === null) throw new Error(`Go 侧未报告 sha256：${log}`)
  goReportedSha = match[1]!
  archive = await readFile(out)
  vi.stubEnv('DSH_HOME', home)
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (work !== undefined) await rm(work, { recursive: true, force: true })
})

it.skipIf(!enabled)('服务端（Go）打的包 → 真安装器 → <dshHome>/skills，逐字节一致', async () => {
  const jsSha = createHash('sha256').update(archive).digest('hex')
  // 三方对拍：Go 侧日志里的 sha256 == JS 侧算的 sha256 == 服务端会放进响应头的值。
  expect(jsSha).toBe(goReportedSha)
  expect(archive.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])) // gzip 魔数

  // 归档条目（不含目录）：整目录都在，且路径已归一化。
  const entries: string[] = []
  await tar.t({ file: join(work, 'builtin.tar.gz'), onentry: e => { if (e.type !== 'Directory') entries.push(e.path) } })
  expect(entries).toContain('SKILL.md')
  expect(entries).toContain('references/publishing.md')
  expect(entries).toContain('examples/go/main.go')
  expect(entries.every(p => !p.startsWith('/') && !p.split('/').includes('..'))).toBe(true)

  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.endsWith('/api/client/v2/skills/builtin/picoaide-app-builder/archive')) {
      return new Response(archive, {
        status: 200,
        headers: { 'content-type': 'application/gzip', 'x-skill-checksum': jsSha, 'x-skill-version': '1.0.0' },
      })
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  }))

  const handler = skillsRoute()
  const { res, read } = fakeRes()
  await handler(fakeReq('/api/pico/skills/builtin/picoaide-app-builder/install', 'POST'), res)
  const result = read()
  expect(result.code, JSON.stringify(result.body)).toBe(200)

  const installed = join(resolveSkillsDir(), 'picoaide-app-builder')
  expect(resolveSkillsDir()).toBe(join(home, 'skills'))
  const source = await listFiles(SOURCE_SKILL_DIR)
  for (const rel of source) {
    const want = await readFile(join(SOURCE_SKILL_DIR, rel))
    const got = await readFile(join(installed, rel))
    expect(got.equals(want), `${rel} 必须逐字节一致`).toBe(true)
  }
  // 安装器额外写的两个标记（不属于技能内容）。
  expect(await stat(join(installed, '.install-version'))).toBeDefined()
  expect(await stat(join(installed, '.picoaide', 'release.json'))).toBeDefined()
  console.log(`[skillseed-go-e2e] installed ${String(source.length)} files, archive ${String(archive.byteLength)}B, sha256=${jsSha}`)
}, 60_000)

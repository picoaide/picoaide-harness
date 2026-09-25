/**
 * R18B-01（2026-09-25 第十八轮审计 · 泳道 B）：**项目根技能**（`<project>/.dsh/skills`
 * rank 100、`<project>/.agents/skills` rank 200）排在能力中心落点（`<dshHome>/skills`
 * rank 400）**之前**。
 *
 * 缺陷形态（修前，探针 `temp/r18/probe/project-root.spec.ts` 实测）：
 *   - **安装**报成功 → 运行时（带 cwd）加载的却是项目里那一份；
 *   - **卸载**返回成功 + `listCrossRootSkillResidues = []` + `listInstalledSkills = []`
 *     → 运行时照旧加载项目根那一份（根表里根本没有项目根）；
 *   - 项目根在**工作区**里 = 沙箱可写根 ⇒ 随仓库克隆进来、或 agent 自己
 *     `write`/`bash` 写下，都是一条持久的系统提示词注入面。
 *
 * 修法：安装/卸载的本机路由从 `ctx.workspaceRegistry`（宿主侧权威）取已登记工作区，
 * 经 `workspaceProjectRoots`（逐条镜像上游 `findProjectRoot`）折成项目根，并传进
 * `runtimeSkillRoots`；安装侧新增 `listOutrankingSkillResidues`（只算 rank **小于**
 * 落点的根 —— 排名在后的同名技能赢不了落点，拿它们报 RESIDUE 是假报警），
 * 卸载侧沿用 `listCrossRootSkillResidues`（删掉之后**任何**同名条目都会接管）。
 *
 * 判据分三层，全部以**真 pinned 上游注册表**（`tests/helpers/upstream-skill-registry.ts`）
 * 或**真 HTTP 路由**（`apply()` + 伪造回环请求）为准 —— 不钉我们自己的规则复述：
 *   ① 项目根推导与上游逐例对拍（`.git` 在 cwd / 在祖先 / 不存在三种形态）；
 *   ② 安装器/卸载器的拒绝（含反向对照：rank 500 的 agent 根**不得**误报）；
 *   ③ 生产路由端到端（POST install / POST uninstall ⇒ 422 RESIDUE，且项目里那份一字未动）。
 *
 * 变异（改坏必红，逐条实跑见 temp/r18/P/REPORT.md）：
 *   - 去掉安装侧的 `listOutrankingSkillResidues` 调用 ⇒ ①②③ 的安装面变红；
 *   - 去掉 `runtimeRoots: skillRuntimeRootsForHost(...)` 的接线 ⇒ ③ 变红；
 *   - 去掉 `listOutrankingSkillResidues` 里的 rank 过滤 ⇒ 反向对照（agent 根不得误报）变红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import { ArchiveInstallRefusal, installSkillArchive, uninstallSkill, writeProvenance } from '../src/skill-install.ts'
import { resolveWorkspaceProjectRoot, runtimeSkillRoots, workspaceProjectRoots } from '../src/skill-runtime-roots.ts'
import type { Session } from '../src/server-connector/config.ts'
import { listRuntimeSkills } from './helpers/upstream-skill-registry.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

// 两个**非托管**根（agent / bundled）指到确定的空目录：本文件的用例只谈项目根，
// 开发机上真实存在的 `~/.agents/skills/<name>` 不该影响判据。
beforeEach(isolateRuntimeSkillRoots)

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker}\n---\n\nbody ${marker}\n`
}

async function seed(root: string, entry: string, name: string, marker: string): Promise<string> {
  await mkdir(join(root, entry), { recursive: true })
  await writeFile(join(root, entry, 'SKILL.md'), skillMd(name, marker))
  return join(root, entry)
}

/** 跑一个"必须被拒绝"的调用并取回原因（类型安全，不用 `catch(e => e as Error)`）。 */
async function captureRefusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected the call to be refused, but it resolved')
}

/** 与安装器期望一致的最小 tar.gz（SKILL.md 在归档根）。 */
async function skillArchive(name: string, marker: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'r18b1-archive-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), skillMd(name, marker), 'utf8')
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const stream = tar.c({ gzip: true, cwd: dir, portable: true }, ['.'])
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve())
    })
    return Buffer.concat(chunks)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// ① 项目根推导：与 pinned 上游 `findProjectRoot` 逐例对拍（行为，不是文本）
// ---------------------------------------------------------------------------

describe('R18B-01 ①：会话工作区目录 → 项目根（上游 findProjectRoot 的镜像）', () => {
  const cases: Array<{ label: string, gitAt: 'cwd' | 'ancestor' | 'none', expected: 'cwd' | 'ancestor' }> = [
    { label: '`.git` 就在工作区里 ⇒ 项目根 = 工作区', gitAt: 'cwd', expected: 'cwd' },
    { label: '`.git` 在工作区的祖先（monorepo 子目录）⇒ 项目根 = 那个祖先', gitAt: 'ancestor', expected: 'ancestor' },
    { label: '一路没有 `.git` ⇒ 回落成工作区本身（上游同判据）', gitAt: 'none', expected: 'cwd' },
  ]

  it.each(cases)('$label', async ({ gitAt, expected }) => {
    const base = await mkdtemp(join(tmpdir(), 'r18b1-projroot-'))
    try {
      const home = join(base, 'dsh')
      const skillsDir = join(home, 'skills')
      await mkdir(skillsDir, { recursive: true })
      const repo = join(base, 'repo')
      const workspace = gitAt === 'ancestor' ? join(repo, 'packages', 'app') : join(base, 'plain')
      await mkdir(workspace, { recursive: true })
      if (gitAt === 'cwd') await mkdir(join(workspace, '.git'), { recursive: true })
      if (gitAt === 'ancestor') await mkdir(join(repo, '.git'), { recursive: true })

      const projectRoot = resolveWorkspaceProjectRoot(workspace)
      const upstreamRoot = expected === 'cwd' ? workspace : repo
      expect(projectRoot, '推导出的项目根').toBe(upstreamRoot)
      // 去重 + 过滤空取值：同一项目根给两次只算一个。
      expect(workspaceProjectRoots([workspace, workspace, '  ', projectRoot])).toEqual([projectRoot])

      // **行为对拍**：上游带 cwd 时真的会读 `<项目根>/.dsh/skills` —— 判据必须与
      // 我们推导出来的目录逐字相同（推导错了这里就看不到这个技能）。
      await seed(join(projectRoot, '.dsh', 'skills'), 'from-project', 'from-project', 'PROJECT')
      const runtime = await listRuntimeSkills(skillsDir, { agentsHome: join(base, 'agents'), cwd: workspace })
      console.log(`[①/${gitAt}] projectRoot =`, projectRoot, '｜ runtime =', JSON.stringify(runtime.map(s => [s.name, s.description])))
      expect(runtime.find(s => s.name === 'from-project')?.description, '上游读的正是我们推导的那个项目根').toBe('PROJECT')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('根表：项目根贡献 rank 100/200 两条，且**排在**能力中心落点（400）之前', () => {
    const roots = runtimeSkillRoots({
      skillsDir: '/tmp/r18b1-home/skills',
      projectRoots: ['/tmp/r18b1-repo', '/tmp/r18b1-repo'],
      env: { DSH_AGENTS_HOME: '/tmp/r18b1-home/.agents' },
    })
    console.log('[①/根表] =', JSON.stringify(roots.map(r => [r.source, r.path, r.rank, r.managed])))
    expect(roots.map(r => r.source)).toEqual(['project-dsh', 'project-agents', 'user-dsh', 'user-agents'])
    expect(roots.map(r => r.rank)).toEqual([100, 200, 400, 500])
    // 去重：两个相同的项目根只产出一组（否则 rank 序里会出现重复项）。
    expect(roots.filter(r => r.source === 'project-dsh')).toHaveLength(1)
    expect(roots.filter(r => r.managed).map(r => r.path)).toEqual(['/tmp/r18b1-home/skills'])
    // 不传项目根时**不**出现 project 根（既有调用点行为不变）。
    expect(runtimeSkillRoots({ skillsDir: '/tmp/r18b1-home/skills', env: {} }).map(r => r.source))
      .toEqual(['user-dsh', 'user-agents'])
  })
})

// ---------------------------------------------------------------------------
// ② 安装器 / 卸载器的拒绝（含"不得误报"的反向对照）
// ---------------------------------------------------------------------------

/** 一棵临时 home + 一个项目工作区（`.git` 在工作区里）。 */
async function withProject(
  run: (world: { home: string, skillsDir: string, project: string }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'r18b1-world-'))
  try {
    const home = join(base, 'dsh')
    const skillsDir = join(home, 'skills')
    const project = join(base, 'repo')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(join(project, '.git'), { recursive: true })
    await run({ home, skillsDir, project })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

describe('R18B-01 ②：安装/卸载对项目根同名技能的处置', () => {
  it('安装：项目根有同名 ⇒ RESIDUE（点名条目 + 根 + 来源），绝不返回裸成功', async () => {
    await withProject(async ({ skillsDir, project }) => {
      await seed(join(project, '.dsh', 'skills'), 'alpha', 'alpha', 'FROM-PROJECT')
      const roots = runtimeSkillRoots({ skillsDir, projectRoots: workspaceProjectRoots([project]) })

      const archive = await skillArchive('alpha', 'FROM-HUB')
      const failure = await captureRefusal(() => installSkillArchive({
        name: 'alpha',
        archive,
        skillsDir,
        version: '1.0.0',
        channel: 'market',
        runtimeRoots: roots,
      }))
      console.log('[②/安装] 拒绝文案 =', failure.message)
      expect(failure).toBeInstanceOf(ArchiveInstallRefusal)
      expect((failure as ArchiveInstallRefusal).code).toBe('RESIDUE')
      expect(failure.message).toContain('"alpha" in')
      expect(failure.message).toContain(join(project, '.dsh', 'skills'))
      expect(failure.message).toContain('project-dsh')

      // 运行时（带 cwd）确实加载项目那一份 ⇒ 拒绝返回成功是正确的（不是假报警）。
      const runtime = await listRuntimeSkills(skillsDir, { agentsHome: join(project, '..', 'agents'), cwd: project })
      expect(runtime.find(s => s.name === 'alpha')?.description).toBe('FROM-PROJECT')
    })
  })

  it('安装：**反向对照** —— rank 500 的 agent 根里有同名**不得**误报（它赢不了落点）', async () => {
    await withProject(async ({ home, skillsDir, project }) => {
      // agent 根（rank 500）里的同名技能：落点（400）排在它前面 ⇒ 安装是**生效的**。
      await seed(join(home, '.agents', 'skills'), 'beta', 'beta', 'FROM-AGENTS-ROOT')
      const roots = runtimeSkillRoots({
        skillsDir,
        projectRoots: workspaceProjectRoots([project]),
        env: { DSH_AGENTS_HOME: join(home, '.agents') },
      })
      const result = await installSkillArchive({
        name: 'beta',
        archive: await skillArchive('beta', 'FROM-HUB'),
        skillsDir,
        version: '1.0.0',
        channel: 'market',
        runtimeRoots: roots,
      })
      console.log('[②/反向] 安装成功 =', result.targetDir)
      expect(result.targetDir).toBe(join(skillsDir, 'beta'))

      // 运行时赢家必须是刚落地的这一份（这是"不误报"的**证明**，不是我们自己的说法）。
      const runtime = await listRuntimeSkills(skillsDir, { agentsHome: join(home, '.agents'), cwd: project })
      expect(runtime.find(s => s.name === 'beta')?.description).toBe('FROM-HUB')
    })
  })

  it('卸载：删掉落点之后项目根那份会接管 ⇒ RESIDUE，且项目里那份一字未动', async () => {
    await withProject(async ({ skillsDir, project }) => {
      const projectCopy = await seed(join(project, '.dsh', 'skills'), 'gamma', 'gamma', 'FROM-PROJECT')
      const projectMd = await readFile(join(projectCopy, 'SKILL.md'), 'utf8')
      await installSkillArchive({
        name: 'gamma',
        archive: await skillArchive('gamma', 'FROM-HUB'),
        skillsDir,
        version: '1.0.0',
        channel: 'market',
        overwrite: true,
      })

      const roots = runtimeSkillRoots({ skillsDir, projectRoots: workspaceProjectRoots([project]) })
      const failure = await captureRefusal(() => uninstallSkill(skillsDir, 'gamma', { overwrite: true, runtimeRoots: roots }))
      console.log('[②/卸载] 拒绝文案 =', failure.message)
      expect((failure as ArchiveInstallRefusal).code).toBe('RESIDUE')
      expect(failure.message).toContain(join(project, '.dsh', 'skills'))
      expect(failure.message).toContain('project-dsh')

      // 别的根一个字都不动（那是项目/仓库的内容）。
      expect(await readFile(join(projectCopy, 'SKILL.md'), 'utf8')).toBe(projectMd)
      // 项目那份删掉之后，卸载才真的成功（闭环）。
      await rm(projectCopy, { recursive: true, force: true })
      await installSkillArchive({
        name: 'gamma',
        archive: await skillArchive('gamma', 'FROM-HUB'),
        skillsDir,
        version: '1.0.0',
        channel: 'market',
        overwrite: true,
      })
      const removed = await uninstallSkill(skillsDir, 'gamma', { overwrite: true, runtimeRoots: roots })
      expect(removed).toBe(join(skillsDir, 'gamma'))
    })
  })
})

// ---------------------------------------------------------------------------
// ③ 生产路由端到端（真 HTTP handler + 真 workspaceRegistry 形状）
// ---------------------------------------------------------------------------

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

function fakeReq(method: string, url: string, body?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      // 持有性证明（真页面 cookie）：本文件测的是技能库面，不是写面围栏。
      cookie: 'dsh-auth-127.0.0.1:3080=v1.signature',
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk },
  } as unknown as IncomingMessage
}

interface Harness {
  handler: (path: string) => Route['handler']
  logger: { warn: ReturnType<typeof vi.fn> }
  gateway: string[]
}

/**
 * 一条**工作区登记项**（上游 `Workspace` 的最小形状：路径 + 挂账会话）。
 *
 * R19A-S2-05/06 的夹具前提修正（2026-09-26）：判据现在要求"目录仍在 + 有会话背书"
 * （`selectLiveWorkspacePaths`），所以夹具必须像真注册表一样带 `sessionIds` ——
 * 旧夹具只给 `{ path }`，那是**任何真实注册表都不会有的形状**（上游 `Workspace`
 * 的 `sessionIds` 是启动/实时校验过的挂账会话，bootstrap 出来的工作区至少有一个）。
 * 语义没变松：本文件 ③ 的两条用例（带会话背书）照样必须报 422。
 */
interface WorkspaceFixture {
  readonly path: string
  /** 挂账会话（缺省一个）；传 `[]` = 没有任何会话的工作区。 */
  readonly sessionIds?: readonly string[]
}

/**
 * 装一个 auth-gate：`workspaceRegistry` 只登记给定的工作区目录（宿主侧权威的形状）。
 * `options.registryThrows` = `list()` 抛错（R19A-S2-07 的异常路径；共享装具
 * `tests/helpers/auth-gate-harness.ts` 有同一开关）。
 */
function harness(
  session: Session | null,
  workspaces: readonly (string | WorkspaceFixture)[],
  options: { registryThrows?: boolean } = {},
): Harness {
  const routes: Route[] = []
  const gateway: string[] = []
  const loggerWarn = vi.fn()
  const fence = {
    requestRejection: (request: { headers: Record<string, unknown> }) =>
      request.headers['cookie'] === undefined ? (401 as const) : undefined,
  }
  const entries = workspaces.map((item) => {
    const fixture: WorkspaceFixture = typeof item === 'string' ? { path: item } : item
    return { path: fixture.path, sessionIds: fixture.sessionIds ?? ['session-fixture-1'] }
  })
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection'
      ? fence
      : name === 'workspaceRegistry'
        ? {
            list: () => {
              if (options.registryThrows === true) {
                throw new Error('workspace registry order references missing workspace')
              }
              return entries
            },
          }
        : undefined),
    logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn() },
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
  return {
    logger: { warn: loggerWarn },
    gateway,
    handler: (path: string) => {
      const route = routes.find(r => r.kind === 'prefix' && r.path === path)
        ?? routes.find(r => r.kind === 'exact' && r.path === path)
      if (route === undefined) throw new Error(`no route ${path}`)
      return route.handler
    },
  }
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

/** 网关替身：市场归档请求返回可安装的 tar.gz（**没有** checksum 头 = 老服务端的宽松口径）。 */
function stubGateway(h: Harness, archive: Buffer): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const href = String(url)
    h.gateway.push(href)
    if (href.includes('/archive')) {
      return new Response(new Uint8Array(archive), {
        status: 200,
        headers: { 'content-type': 'application/gzip', 'x-skill-version': '1.0.0' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}

let world: { home: string, skillsDir: string, project: string }

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'r18b1-route-'))
  const home = join(base, 'dsh')
  const project = join(base, 'repo')
  world = { home, skillsDir: join(home, 'skills'), project }
  await mkdir(world.skillsDir, { recursive: true })
  await mkdir(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(world.home, { recursive: true, force: true })
  await rm(world.project, { recursive: true, force: true })
})

describe('R18B-01 ③：本机路由端到端（安装/卸载都不再返回裸成功）', () => {
  it('POST /api/pico/skills/:name/install ⇒ 422 RESIDUE（项目根同名）', async () => {
    await seed(join(world.project, '.dsh', 'skills'), 'alpha', 'alpha', 'FROM-PROJECT')
    const h = harness(SESSION, [world.project])
    stubGateway(h, await skillArchive('alpha', 'FROM-HUB'))

    const { res, read } = fakeRes()
    await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/alpha/install'), res)
    console.log('[③/安装] HTTP =', read().code, JSON.stringify(read().body))
    expect(read().code).toBe(422)
    expect(read().body.code).toBe('RESIDUE')
    expect(read().body.error).toContain(join(world.project, '.dsh', 'skills'))
    // 路由真的出站拿了归档（拒绝发生在"读完归档、写完落点之后"的复核环节）。
    expect(h.gateway.some(u => u.includes('/marketplace/skills/alpha/archive'))).toBe(true)
  })

  it('POST /api/pico/skills/:name/uninstall ⇒ 422 RESIDUE（项目根那份会接管）', async () => {
    const projectCopy = await seed(join(world.project, '.dsh', 'skills'), 'alpha', 'alpha', 'FROM-PROJECT')
    const projectMd = await readFile(join(projectCopy, 'SKILL.md'), 'utf8')
    await installSkillArchive({
      name: 'alpha',
      archive: await skillArchive('alpha', 'FROM-HUB'),
      skillsDir: world.skillsDir,
      version: '1.0.0',
      channel: 'market',
      server: SESSION.serverURL,
    })
    const h = harness(SESSION, [world.project])

    const { res, read } = fakeRes()
    await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/alpha/uninstall'), res)
    console.log('[③/卸载] HTTP =', read().code, JSON.stringify(read().body))
    expect(read().code).toBe(422)
    expect(read().body.code).toBe('RESIDUE')
    expect(await readFile(join(projectCopy, 'SKILL.md'), 'utf8')).toBe(projectMd)
  })

  it('**反向对照**：没有登记工作区（或工作区里没有同名）⇒ 安装/卸载照常 200', async () => {
    const archive = await skillArchive('alpha', 'FROM-HUB')
    const noWorkspaces = harness(SESSION, [])
    stubGateway(noWorkspaces, archive)
    const install = fakeRes()
    await noWorkspaces.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/alpha/install'), install.res)
    expect(install.read().code, '没有项目根时不得误报 RESIDUE').toBe(200)

    // 登记了工作区、但项目根里没有同名技能：同样放行。
    const withWorkspace = harness(SESSION, [world.project])
    stubGateway(withWorkspace, archive)
    const uninstall = fakeRes()
    await withWorkspace.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/alpha/uninstall'), uninstall.res)
    console.log('[③/反向] uninstall =', uninstall.read().code, JSON.stringify(uninstall.read().body))
    expect(uninstall.read().code).toBe(200)
    await expect(stat(join(world.skillsDir, 'alpha'))).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// R19A-S2-05/06/07（第十九轮审计 A 泳道）：**根表来源**的三个形态
// ---------------------------------------------------------------------------

describe('R19A-S2-05/06/07：项目根只来自"仍在使用的工作区"', () => {
  it('R19A-S2-05 陈旧登记项（目录已删）不得经 `.git` 上溯贡献**祖先**当项目根', async () => {
    const base = await mkdtemp(join(tmpdir(), 'r19v-stale-ws-'))
    try {
      const outer = join(base, 'outer')
      await mkdir(join(outer, '.git'), { recursive: true })
      const gone = join(outer, 'gone-workspace')
      await mkdir(gone, { recursive: true })
      // 祖先目录里放一个同名技能：修前它会经 `.git` 上溯变成"项目根"，把安装 422 挡下。
      await seed(join(outer, '.dsh', 'skills'), 'delta', 'delta', 'FROM-OUTER')
      await rm(gone, { recursive: true, force: true }) // 登记之后目录被删

      const h = harness(SESSION, [gone])
      stubGateway(h, await skillArchive('delta', 'FROM-HUB'))
      const { res, read } = fakeRes()
      await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/delta/install'), res)
      console.log('[S2-05] HTTP =', read().code, '| logger.warn =', JSON.stringify(h.logger.warn.mock.calls.map(c => String(c[0]))))
      expect(read().code, '陈旧登记项不得贡献项目根').toBe(200)
      expect(existsSync(join(world.skillsDir, 'delta', 'SKILL.md'))).toBe(true)
      // 可诊断：被跳过的登记项必须留下一条点名"目录已不存在"的日志。
      const logs = h.logger.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(logs).toMatch(/skipped the registered workspace/su)
      expect(logs).toContain(gone)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('R19A-S2-06 与当前会话无关（没有任何会话挂账）的工作区不得把安装 422 挡下', async () => {
    const base = await mkdtemp(join(tmpdir(), 'r19v-nosession-ws-'))
    try {
      const projA = join(base, 'projA')
      const projB = join(base, 'projB')
      await mkdir(join(projA, '.git'), { recursive: true })
      await mkdir(join(projB, '.git'), { recursive: true })
      await seed(join(projB, '.dsh', 'skills'), 'gamma', 'gamma', 'FROM-PROJB')

      const h = harness(SESSION, [{ path: projA }, { path: projB, sessionIds: [] }])
      stubGateway(h, await skillArchive('gamma', 'FROM-HUB'))
      const { res, read } = fakeRes()
      await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/gamma/install'), res)
      console.log('[S2-06] HTTP =', read().code, '| logger.warn =', JSON.stringify(h.logger.warn.mock.calls.map(c => String(c[0]))))
      expect(read().code, '没有会话的工作区不可能成为任何会话的 cwd ⇒ 不参与判定').toBe(200)
      expect(existsSync(join(world.skillsDir, 'gamma', 'SKILL.md'))).toBe(true)

      // **反向对照**：同一条 projB 一旦有会话挂账（= 真的可能被扫描），就必须照旧报 422。
      await rm(join(world.skillsDir, 'gamma'), { recursive: true, force: true })
      const live = harness(SESSION, [{ path: projB, sessionIds: ['session-1'] }])
      stubGateway(live, await skillArchive('gamma', 'FROM-HUB'))
      const liveRes = fakeRes()
      await live.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/gamma/install'), liveRes.res)
      console.log('[S2-06/反向] HTTP =', liveRes.read().code, JSON.stringify(liveRes.read().body).slice(0, 200))
      expect(liveRes.read().code).toBe(422)
      expect(String(liveRes.read().body.error)).toContain(projB)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('R19A-S2-07 根表来源抛错：不再"零日志"（fail-open 方向如实登记）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'r19v-throw-ws-'))
    try {
      const projB = join(base, 'projB')
      await mkdir(join(projB, '.git'), { recursive: true })
      await seed(join(projB, '.dsh', 'skills'), 'gamma', 'gamma', 'FROM-PROJB')

      const h = harness(SESSION, [projB], { registryThrows: true })
      stubGateway(h, await skillArchive('theta', 'FROM-HUB'))
      const { res, read } = fakeRes()
      await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/theta/install'), res)
      console.log('[S2-07] HTTP =', read().code, '| logger.warn =', JSON.stringify(h.logger.warn.mock.calls.map(c => String(c[0]))))
      // 方向仍是"放行"（注册表读不出来时不能把整个安装面卡死），但**必须留痕**：
      // 修前 logger.warn 零调用 ⇒ 判据静默退化成 R18B-01 修前的世界。
      expect(read().code).toBe(200)
      const logs = h.logger.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(logs, '异常路径必须 fail-loud 记日志').toMatch(/workspace registry could not be listed/su)
      expect(logs).toMatch(/WITHOUT project skill roots/su)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('R19A-S2-09 跨根残留：判据前移到删除之前 ⇒ 拒绝时落点一字未动', async () => {
    const base = await mkdtemp(join(tmpdir(), 'r19v-preflight-'))
    try {
      vi.stubEnv('DSH_AGENTS_HOME', join(base, 'agents'))
      await seed(join(base, 'agents', 'skills'), 'epsilon', 'epsilon', 'FROM-AGENTS')
      const target = join(world.skillsDir, 'epsilon')
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'SKILL.md'), skillMd('epsilon', 'FROM-HUB'))
      await writeProvenance(target, {
        appId: 'epsilon', version: '1.0.0', channel: 'builtin', server: SESSION.serverURL, installedAt: '2026-01-01T00:00:00Z',
      })

      const h = harness(SESSION, [])
      const { res, read } = fakeRes()
      await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/builtin/epsilon/uninstall'), res)
      console.log('[S2-09] HTTP =', read().code, JSON.stringify(read().body).slice(0, 200))
      expect(read().code).toBe(422)
      expect(read().body.code).toBe('RESIDUE')
      expect(String(read().body.error)).toMatch(/not uninstalled/su)
      expect(String(read().body.error)).toMatch(/nothing was removed/su)
      expect(existsSync(target), '拒绝时落点必须原样保留（修前是"报失败但已删掉"）').toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

/**
 * C2-1（2026-10 审计）：**证明不了归属时，随包技能的机器级墓碑不得写下**。
 *
 * 缺陷形态（审计探针 `probe/ownership-gate.probe.spec.ts`，跑 HEAD 真实模块）：
 * 面板新增的「证明不了归属就不出删除动作」（R6-B-1 `localOwnership`）**没有覆盖
 * builtin/plugin 卸载支**（`planCardAction` 在 `localRemoveEndpoint` 那一支先返回，
 * `localOwnership` 根本没被读）：
 *   ```
 *   {"channel":"plugin","mergedLocalOwnership":"unknown","plan":{"kind":"uninstall", …}}
 *   {"channel":"market","mergedLocalOwnership":"unknown","plan":{"kind":"upload"}}      ← 同条件正确拒发
 *   ```
 * 而技能库是**机器作用域**的（`<DSH_HOME>/skills`，同机换账号被支持）。宿主卸载随包技能
 * 时还会写 `<skills>/.skill-removed/<name>.json` 这个**机器级**墓碑，随包同步此后对
 * **所有账号**都不再装回，而面板没有"重新安装随包技能"的入口（不可逆）。
 *
 * 本文件判的是**最小加固**（不改"plugin 行是否给卸载"这个 UI 承诺 —— 那要产品拍板）：
 * 归属证明不了时**不写墓碑**，删除只生效到下一次随包同步（安全的失败模式）。判据是
 * **端到端**的：真实 vendored 随包同步器 + 真实 auth-gate 路由 + 真实安装器，
 * 断言的是"下一次同步到底装不装回来"，不是"源码里出现过某个标识符"。
 *
 *  ① `?ownership=unknown`（面板在 `localOwnership !== 'mine'` 时拼上）⇒ 200、落点已删、
 *     **没有墓碑**，且下一轮同步 `synced`（删了还会回来 = 安全失败模式）；
 *  ② 反向对照：不带该参数 ⇒ 墓碑照写、下一轮同步 `skipped`（老行为不变 —— 这条同时
 *     保证 ① 的断言不是恒真）；
 *  ③ 只认字面值：`?ownership=mine` 与不带参数逐字同效（不会因为多带一个参数就改变行为）。
 *
 * 变异（逐条实跑见 `temp/audit-v282/fixes/C2-P2-batch.md`）：
 *  - 去掉 `uninstallSkill` 的 `options.localOwnership !== 'unknown'` 门 ⇒ ① 红；
 *  - 去掉面板的 `uninstallRequestUrl` 接线（回到 `withOverwrite`）⇒ ① 红（参数没带上）；
 *  - 让路由忽略 `ownership` ⇒ ① 红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error vendored plain JS (no types)
import { BUILTIN_SKILLS, syncBuiltinSkills } from '../../../vendor/memory-evolve/lib/coi/skills-sync.js'
import { apply, type Config } from '../src/auth-gate.ts'
import { SKILL_REMOVED_DIR } from '../src/skill-install.ts'
import {
  localRemoveEndpoint,
  planCardAction,
  uninstallRequestUrl,
} from '../src/client/CapabilityCenterPanel.tsx'
import type { Session } from '../src/server-connector/config.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

/**
 * 一行的形状（`CapabilityItem` 在源文件里**没有导出** —— 它只是各纯函数的形参类型，
 * 所以这里用 `Parameters<>` 取同一份类型，而不是去 import 一个不存在的导出；
 * 既有 `capability-center-panel.spec.ts` 里那句 `type CapabilityItem` 的 import
 * 在 `tsc` 下是 TS2459，只是 enterprise 的 tsconfig 不含 `tests/` 所以没人跑到）。
 */
type CapabilityItem = Parameters<typeof planCardAction>[0]

const NAME = BUILTIN_SKILLS[0] as string

let root = ''
let skillsDir = ''
let pluginSkills = ''

beforeEach(async () => {
  // 非托管运行时根（agent/bundled）指到确定的空目录：本文件的判据只谈"随包同步装不装
  // 回来"，不该变成"这台机器上装了哪些技能"的函数。
  isolateRuntimeSkillRoots()
  root = await mkdtemp(join(tmpdir(), 'pico-c21-'))
  skillsDir = join(root, 'skills')
  pluginSkills = join(root, 'plugin-skills')
  await mkdir(skillsDir, { recursive: true })
  await mkdir(pluginSkills, { recursive: true })
  vi.stubEnv('DSH_HOME', root)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

/** 造随包技能源目录（`x-version` 决定"是否比已装的新"）。 */
async function seedPluginSkill(xVersion: number): Promise<void> {
  await mkdir(join(pluginSkills, NAME, 'scripts'), { recursive: true })
  await writeFile(join(pluginSkills, NAME, 'SKILL.md'),
    `---\nname: ${NAME}\ndescription: bundled\nx-version: ${xVersion}\n---\n\nbundled body v${xVersion}\n`)
  await writeFile(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), `// HELPER v${xVersion}\n`)
}

/** 跑一轮随包同步，取回该技能的条目（`action` 就是判据）。 */
function syncEntry(): { name: string, action: string, code?: string } {
  const results = syncBuiltinSkills(pluginSkills, skillsDir) as Array<{ name: string, action: string, code?: string }>
  const entry = results.find(r => r.name === NAME)
  if (entry === undefined) throw new Error(`同步结果里没有 ${NAME}：${JSON.stringify(results)}`)
  return entry
}

const tombstonePath = (): string => join(skillsDir, SKILL_REMOVED_DIR, `${NAME}.json`)

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

function fakeReq(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      // 持有性证明（真页面 cookie）：本文件测的是墓碑语义，不是写面围栏。
      cookie: 'dsh-auth-127.0.0.1:3080=v1.signature',
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { /* 无请求体 */ },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      try {
        body = JSON.parse(chunk === undefined ? '' : Buffer.from(chunk).toString())
      } catch {
        body = undefined
      }
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

/** 起真实 auth-gate，按 pathname 最长前缀分派（POST 走同一条 prefix 路由）。 */
function harness(): { call: (method: string, url: string) => Promise<{ code: number, body: any }> } {
  const routes: Route[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection'
      ? { requestRejection: (r: { headers: Record<string, unknown> }) => (r.headers['cookie'] === undefined ? (401 as const) : undefined) }
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
  const prefixes = routes.filter(r => r.kind === 'prefix')
  return {
    call: async (method, url) => {
      const pathname = url.split('?')[0] ?? url
      const handler = prefixes
        .filter(r => pathname === r.path || pathname.startsWith(`${r.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]?.handler
      if (handler === undefined) throw new Error(`no route registered for ${pathname}`)
      const { res, read } = fakeRes()
      await handler(fakeReq(method, url), res)
      return read()
    },
  }
}

/** 装一个"随包同步下来的"技能，并断言前置事实（渠道必须是 plugin，否则下面判的不是墓碑面）。 */
async function installViaSync(): Promise<void> {
  await seedPluginSkill(1)
  expect(syncEntry().action, '前置事实：随包同步必须真的把技能装下来').toBe('synced')
  const prov = JSON.parse(await readFile(join(skillsDir, NAME, '.picoaide', 'release.json'), 'utf8')) as { channel?: string }
  expect(prov.channel, '前置事实：落点溯源必须是 plugin（墓碑只对这一档存在）').toBe('plugin')
}

describe('C2-1：归属证明不了时不得写机器级墓碑（随包技能）', () => {
  it('① `?ownership=unknown`：删除生效、墓碑不写、下一轮同步装回来（安全失败模式）', async () => {
    await installViaSync()
    const gate = harness()
    const res = await gate.call('POST', `/api/pico/skills/${NAME}/uninstall?overwrite=1&ownership=unknown`)
    expect(res.code, JSON.stringify(res.body)).toBe(200)
    expect(existsSync(join(skillsDir, NAME)), '删除本身必须照常生效（UI 承诺不变）').toBe(false)
    expect(existsSync(tombstonePath()), '证明不了归属 ⇒ 不得替所有账号下永久判词').toBe(false)
    // 安全失败模式：下一轮随包同步会（重新）装回来。
    await seedPluginSkill(2)
    expect(syncEntry().action, '没有墓碑 ⇒ 同步照常装回（"删了还会回来"）').toBe('synced')
    expect(existsSync(join(skillsDir, NAME, 'SKILL.md'))).toBe(true)
  })

  it('② 反向对照：不带 `ownership` ⇒ 墓碑照写、下一轮同步 skipped（老行为不变）', async () => {
    await installViaSync()
    const gate = harness()
    const res = await gate.call('POST', `/api/pico/skills/${NAME}/uninstall?overwrite=1`)
    expect(res.code, JSON.stringify(res.body)).toBe(200)
    expect(existsSync(tombstonePath()), '老路径必须仍然写墓碑（否则这条判据对 ① 没有判别力）').toBe(true)
    const tombstone = JSON.parse(await readFile(tombstonePath(), 'utf8')) as { appId?: string, channel?: string }
    expect(tombstone).toMatchObject({ appId: NAME, channel: 'plugin' })
    await seedPluginSkill(2)
    expect(syncEntry().action, '有墓碑 ⇒ 同步尊重用户选择').toBe('skipped')
    expect(existsSync(join(skillsDir, NAME))).toBe(false)
  })

  it('③ 只认字面值 `unknown`：`?ownership=mine` 与不带参数同效', async () => {
    await installViaSync()
    const gate = harness()
    const res = await gate.call('POST', `/api/pico/skills/${NAME}/uninstall?overwrite=1&ownership=mine`)
    expect(res.code, JSON.stringify(res.body)).toBe(200)
    expect(existsSync(tombstonePath()), '`mine` 不是"证明不了" ⇒ 按老行为写墓碑').toBe(true)
  })
})

/**
 * 面板那一半：`?ownership=unknown` 必须真的被拼进请求（否则上面的端到端判据会被
 * "手工构造参数"绕过 —— 判据与生产的请求构造必须是同一条路径）。
 */
describe('C2-1 面板接线：归属证明不了时把 `ownership=unknown` 拼进卸载请求', () => {
  const pluginRow = (extra: Partial<CapabilityItem> = {}): CapabilityItem => ({
    kind: 'skill', source: 'local', name: 'bundled-x', displayName: 'bundled-x', version: '1.0.0',
    description: '', author: '', versions: [], installed: true, isLocal: true,
    installedOrigin: 'store', originChannel: 'plugin',
    ...extra,
  })

  it('`unknown` ⇒ 拼上；`mine` ⇒ 与老行为逐字相同（只多一个参数是危险的）', () => {
    expect(uninstallRequestUrl(pluginRow({ localOwnership: 'unknown' }), { overwrite: true }))
      .toBe('/api/pico/skills/bundled-x/uninstall?overwrite=1&ownership=unknown')
    expect(uninstallRequestUrl(pluginRow({ localOwnership: 'mine' }), { overwrite: true }))
      .toBe('/api/pico/skills/bundled-x/uninstall?overwrite=1')
    // 未确认（不带 overwrite）时同样只多这一个参数。
    expect(uninstallRequestUrl(pluginRow({ localOwnership: 'unknown' })))
      .toBe('/api/pico/skills/bundled-x/uninstall?ownership=unknown')
  })

  it('本机行缺 `localOwnership`（旧宿主/字段被裁剪）按保守方向处理', () => {
    const row = pluginRow()
    expect('localOwnership' in row, '夹具必须真的不带这个键').toBe(false)
    expect(uninstallRequestUrl(row, { overwrite: true })).toContain('ownership=unknown')
  })

  it('UI 承诺不变：plugin 行照旧给「卸载」，端点串逐字不变（C2-1 只动墓碑语义）', () => {
    const row = pluginRow({ localOwnership: 'unknown' })
    expect(planCardAction(row)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/pico/skills/bundled-x/uninstall',
      localContent: false,
    })
    expect(localRemoveEndpoint(row)).toBe('/api/pico/skills/bundled-x/uninstall')
  })
})

/**
 * 接线判据（源码级）：渲染层里"某个回调传了什么"只能靠读源码钉住 —— 本仓既有先例
 * （`capability-center-panel.spec.ts` 的 A2/A3/A11/A15 那一组、`wasm-app-open-route-parity`
 * 读 main.ts、`sandbox-acl-grant-hint` 读产物）。纯函数用例钉不住**调用点**：
 * 把 `uninstall()` 改回 `withOverwrite(uninstallEndpoint(...))` 时，
 * `uninstallRequestUrl` 自己的用例照样全绿（实测过）。
 */
describe('C2-1 接线判据：卸载请求真的走 uninstallRequestUrl', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/client/CapabilityCenterPanel.tsx', import.meta.url)), 'utf8')

  it('卸载那一发用 uninstallRequestUrl 拼 URL（旧写法不得留在卸载路径上）', () => {
    expect(source).toContain("fetch(uninstallRequestUrl(item, { overwrite: true }), { method: 'POST' })")
    expect(source, '卸载路径退回自拼 URL ⇒ `ownership` 永远不会被带上').not.toContain('fetch(withOverwrite(uninstallEndpoint(item, item.version), true)')
  })
})

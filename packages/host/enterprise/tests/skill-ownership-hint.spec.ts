/**
 * C2-1 取值面（2026-10-04）：`?ownership` 只接受三种形态，**其余必须 fail-loud**。
 *
 * 背景（C2-1 主 finding 见 `temp/audit-v282/fixes/C2-P2-batch.md` §C2-1）：卸载路由用
 * 一个 query 参数接收"面板算出的归属事实"。收口前它写的是
 * `searchParams.get('ownership') === 'unknown' ? 'unknown' : undefined` —— 于是
 * **任何**无法识别的取值（拼错、大小写、空串、将来版本的新值）都被静默折叠成"缺省"，
 * 而"缺省"是**最宽松**的那一档（照写机器级墓碑）。一个拼写错误就静默变成
 * "替所有账号下永久判词"，而且两端都不报错、日志里也没有痕迹。
 *
 * 本文件钉两件事（都不看源码字符串，断言的是**响应 + 磁盘 + 下一轮同步的真实结果**）：
 *
 *  ① **非法取值 ⇒ 400 `INVALID_OWNERSHIP`**，且**在任何破坏性动作之前**拒绝
 *     （落点目录必须原样还在 —— 这证明校验在路由入口，不是"删完再报错"）；
 *  ② **合法三形态的语义一字未改**（这条是交叉断言：证明 ① 的收口没有顺手改语义）：
 *     `unknown` ⇒ 删除生效但不写墓碑、下一轮同步会装回；
 *     `mine` 与**缺省** ⇒ 照写墓碑、下一轮同步 `skipped`（R4-B-4「卸载随包技能是
 *     持久终态」的既有承诺；"缺省与 mine 同义"是**故意**的，见 auth-gate.ts 的取值
 *     契约注释）。
 *
 * 变异（隔离副本里实跑，见 `temp/audit-v282/evidence-p6/mutate-ent.sh`）：
 *  - 删掉路由的取值校验（退回静默当缺省）⇒ ① 红；
 *  - 把安装器的判据从"只有 unknown 不写"改成"只有 mine 才写"（即 C2-1 主体那个
 *    **被否掉的 A 方案**）⇒ ② 红，且既有 `tests/skill-tombstone-ownership.spec.ts`
 *    的用例 ②/③ 同时红 —— 这就是"缺省是产品语义、不是自由实现细节"的证据。
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
import type { Session } from '../src/server-connector/config.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

const NAME = BUILTIN_SKILLS[0] as string

let root = ''
let skillsDir = ''
let pluginSkills = ''

beforeEach(async () => {
  isolateRuntimeSkillRoots()
  root = await mkdtemp(join(tmpdir(), 'pico-p6-own-'))
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

/** 跑一轮随包同步，取回该技能的条目（`action` 就是"装回来了没有"的判据）。 */
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
      // 持有性证明（真页面 cookie）：本文件测的是取值面，不是写面围栏。
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

/** 装一个"随包同步下来的"技能，并断言前置事实（渠道必须是 plugin）。 */
async function installViaSync(): Promise<void> {
  await seedPluginSkill(1)
  expect(syncEntry().action, '前置事实：随包同步必须真的把技能装下来').toBe('synced')
  const prov = JSON.parse(await readFile(join(skillsDir, NAME, '.picoaide', 'release.json'), 'utf8')) as { channel?: string }
  expect(prov.channel, '前置事实：落点溯源必须是 plugin（墓碑只对这一档存在）').toBe('plugin')
}

describe('C2-1 取值面：无法识别的 `?ownership` 必须 fail-loud（400）', () => {
  // 拼错 / 大小写 / 空串 / 未来版本的新值 / 尾随空格 —— 收口前全部被静默折叠成"缺省"
  // （= 最宽松那一档：照写机器级墓碑）。
  const illegal = ['unkown', 'MINE', 'Mine', '', 'yes', 'unknown ', ' unknown', 'none', 'true']

  it('① 九种非法取值一律 400 INVALID_OWNERSHIP，且**在任何破坏性动作之前**拒绝', async () => {
    await installViaSync()
    const gate = harness()
    for (const value of illegal) {
      const res = await gate.call('POST', `/api/pico/skills/${NAME}/uninstall?overwrite=1&ownership=${encodeURIComponent(value)}`)
      expect(res.code, `ownership=${JSON.stringify(value)} ⇒ ${JSON.stringify(res.body)}`).toBe(400)
      expect(res.body?.code, `ownership=${JSON.stringify(value)}`).toBe('INVALID_OWNERSHIP')
      // 消息必须点名那个非法取值（否则调用方拿不到可行动的线索）。
      expect(String(res.body?.error), `ownership=${JSON.stringify(value)}`).toContain(JSON.stringify(value))
      // fail-loud 必须是**入口**语义：落点还在 = 校验跑在删除之前（不是"删完再报错"）。
      expect(existsSync(join(skillsDir, NAME)), `ownership=${JSON.stringify(value)}：非法取值不得产生任何删除`).toBe(true)
      expect(existsSync(tombstonePath()), `ownership=${JSON.stringify(value)}：非法取值不得写墓碑`).toBe(false)
    }
  })

  it('② 合法三形态语义未变：unknown ⇒ 不写墓碑（同步装回）；mine 与缺省 ⇒ 写墓碑（同步 skipped）', async () => {
    const gate = harness()

    // unknown：删除生效、没有墓碑、下一轮同步装回来。
    await installViaSync()
    const unknownRes = await gate.call('POST', `/api/pico/skills/${NAME}/uninstall?overwrite=1&ownership=unknown`)
    expect(unknownRes.code, JSON.stringify(unknownRes.body)).toBe(200)
    expect(existsSync(join(skillsDir, NAME)), 'unknown：删除本身必须照常生效').toBe(false)
    expect(existsSync(tombstonePath()), 'unknown：证明不了归属 ⇒ 不得替所有账号下永久判词').toBe(false)
    await seedPluginSkill(2)
    expect(syncEntry().action, 'unknown：没有墓碑 ⇒ 同步照常装回').toBe('synced')

    // mine 与缺省：两者**同义**（都表示"是当前账号的"）⇒ 写墓碑、同步 skipped。
    // 这不是自由实现细节：R4-B-4「卸载随包技能是持久终态」就是靠"缺省也写"成立的，
    // 由 tests/skill-tombstone-ownership.spec.ts 用例 ②/③ 与
    // tests/skill-overwrite-dirty.spec.ts 的 R4-B-4 组钉住。
    for (const [label, suffix] of [['mine', '&ownership=mine'], ['缺省', '']] as const) {
      await rm(join(skillsDir, NAME), { recursive: true, force: true })
      await rm(tombstonePath(), { force: true })
      await installViaSync()
      const res = await gate.call('POST', `/api/pico/skills/${NAME}/uninstall?overwrite=1${suffix}`)
      expect(res.code, `${label}: ${JSON.stringify(res.body)}`).toBe(200)
      expect(existsSync(join(skillsDir, NAME)), `${label}：删除必须生效`).toBe(false)
      expect(existsSync(tombstonePath()), `${label}：必须写机器级墓碑（R4-B-4 的既有承诺）`).toBe(true)
      const tombstone = JSON.parse(await readFile(tombstonePath(), 'utf8')) as { appId?: string, channel?: string }
      expect(tombstone, `${label}`).toMatchObject({ appId: NAME, channel: 'plugin' })
      await seedPluginSkill(2)
      expect(syncEntry().action, `${label}：有墓碑 ⇒ 下一次同步不得装回`).toBe('skipped')
    }
  })
})

/**
 * 接线判据（源码级）：本仓既有先例（`capability-center-panel.spec.ts` 的 A2/A3/A11/A15
 * 一组、`wasm-app-open-route-parity` 读 main.ts）。纯行为用例钉不住"校验长在哪一段" ——
 * 把校验挪到写盘之后，① 仍然可能全绿。
 */
describe('C2-1 取值面接线：校验必须在算 localOwnership 之前、且在卸载分支之前', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url)), 'utf8')

  it('非法取值早退（400 INVALID_OWNERSHIP）出现在 `const localOwnership =` 之前', () => {
    const guard = source.indexOf("code: 'INVALID_OWNERSHIP'")
    const binding = source.indexOf('const localOwnership =')
    expect(guard, '找不到取值校验（400 INVALID_OWNERSHIP）').toBeGreaterThan(-1)
    expect(binding, '找不到 localOwnership 的绑定点').toBeGreaterThan(-1)
    expect(guard, '校验必须排在 localOwnership 绑定之前（否则非法值已经被折叠成缺省）').toBeLessThan(binding)
    expect(source, '只允许 `mine` / `unknown` 两个字面值 + 缺省').toContain("ownershipHint !== 'mine'")
  })
})

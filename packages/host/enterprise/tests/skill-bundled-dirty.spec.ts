/**
 * tests/skill-bundled-dirty.spec.ts — 独立复审 **N1**（2026-09-23）的端到端判据：
 * 随包 `plugin` 渠道技能必须与市场侧**共用同一份「已本地修改」事实**。
 *
 * 现象（复审探针 `zz-verify-plugin-dirty.spec.ts` 实测）：同步侧写溯源时刻意不写
 * `archiveChecksum`、企业侧 `isInstalledSkillDirty` 没有基准就返回 `false` ⇒
 * `dirty` 对随包技能**结构性恒假**：
 *   `PROBE plugin provenance = {"appId":…,"channel":"plugin"} / dirty=false /
 *    second sync action=synced / userFileSurvives=false / bodyHasUserEdit=false`
 * 而随包同步是**唯一不需要用户动作**就会覆盖内容的写者（每次开机自动跑）⇒
 * 用户改了随包技能之后，下一次随包升版把它连同用户字节整树换掉、零提示，
 * 面板也不显示「已本地修改」。
 *
 * 修复：同步侧每次自己写内容之后写一份 `archiveChecksum`（= 企业侧
 * `computeSkillContentHash` 的同源实现 `skillContentChecksum`），换入前比对基准、
 * 不一致就 `refused` + `SKILL_LOCAL_CONTENT`（自动路径没有 UI ⇒ 与市场侧"跳过并
 * 如实报告"同一口径，不做需要交互的"点了才覆盖"）。
 *
 * 本文件判的是**跨包的那条链**（真实 vendored 同步器 + 真实安装器 + 真实 auth-gate
 * 聚合面），不是某一侧的单元：
 *   1. 同步落下来的技能带基准且 `dirty=false`；用户改动后 `dirty=true`（面板徽章的
 *      唯一事实源，`CapabilityCenterPanel` 的 `capability.dirty` 徽章吃这一个字段）；
 *   2. 升版时同步器拒收、用户字节一个不少（自动路径的"不静默替换"）；
 *   3. 宿主聚合面（`/api/pico/capabilities?source=local`）对这份技能下发
 *      `dirty:true` + `installedOrigin:'store'` —— 即"面板/状态面复用既有 dirty 口径"，
 *      没有第二套状态。
 *
 * ## N1b（同批追加，复审 R5-B-4）：平台自己写的元数据不算"用户改了内容"
 *
 * 「技能管理」的禁用开关把 `disable-model-invocation` 写进 SKILL.md frontmatter
 * （写入端 `vendor/memory-evolve/lib/skills-manager.js` → `lib/skill-manifest.js`），
 * 而内容哈希此前把它当成"用户改了内容" ⇒ ①能力中心误显示「已本地修改」；
 * ②此后每次更新/卸载都要多一张确认条。判据因此收窄为「**用户改过内容**」：
 * 该字段（以及将来任何由平台管理的 frontmatter 字段）不进内容哈希，
 * 但正文/其它文件改动照样判脏。
 *
 * ---- 变异验证（实跑见 temp/round5-2026-09-23/fix-n1-bundled-dirty.md）----
 *   ① 拆掉同步侧的基准写入 ⇒ 第 1 条红（`archiveChecksum` 缺失、`dirty` 恒假）；
 *   ② 拆掉同步侧的"跳过/保留"分支（改回静默整树覆盖）⇒ 第 2 条红；
 *   ③ 反向对照：未修改的随包技能升版照旧 `synced` ⇒ 第 2 条里的对照断言不许红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error vendored plain JS (no types)
import { syncBuiltinSkills, BUILTIN_SKILLS } from '../../../vendor/memory-evolve/lib/coi/skills-sync.js'
// @ts-expect-error vendored plain JS (no types)
import { toggleDisableFlag } from '../../../vendor/memory-evolve/lib/skill-manifest.js'
import {
  classifyInstalledSkill,
  computeSkillContentHash,
  isInstalledSkillDirty,
  readProvenance,
} from '../src/skill-install.ts'
import { apply, type Config } from '../src/auth-gate.ts'
import type { Session } from '../src/server-connector/config.ts'

const NAME = BUILTIN_SKILLS[0] as string

let root = ''
let skillsDir = ''
let pluginSkills = ''

/** 造随包技能源目录（`x-version` 决定"是否比已装的新"）。 */
async function seedPluginSkill(xVersion: number): Promise<void> {
  await mkdir(join(pluginSkills, NAME, 'scripts'), { recursive: true })
  await writeFile(join(pluginSkills, NAME, 'SKILL.md'),
    `---\nname: ${NAME}\ndescription: bundled\nx-version: ${xVersion}\n---\n\nbundled body v${xVersion}\n`)
  await writeFile(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), `// HELPER v${xVersion}\n`)
}

/** 本轮同步里该技能的条目。 */
function entryFor(results: Array<{ name: string, action: string, code?: string }>) {
  return results.find((r) => r.name === NAME)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pico-bundled-dirty-'))
  skillsDir = join(root, 'skills')
  pluginSkills = join(root, 'plugin-skills')
  await mkdir(skillsDir, { recursive: true })
  await mkdir(pluginSkills, { recursive: true })
  vi.stubEnv('DSH_HOME', root)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

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

function fakeReq(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      cookie: 'dsh-auth-127.0.0.1:3080=v1.signature',
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
        body = JSON.parse(chunk === undefined ? '' : Buffer.from(chunk).toString())
      } catch {
        body = undefined
      }
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

/** 起真实 auth-gate，按 pathname 最长前缀分派。 */
function harness(): { call: (url: string) => Promise<{ code: number, body: any }> } {
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
    call: async (url: string) => {
      const pathname = url.split('?')[0] ?? url
      const handler = prefixes
        .filter(r => pathname === r.path || pathname.startsWith(`${r.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]?.handler
      if (handler === undefined) throw new Error(`no route registered for ${pathname}`)
      const { res, read } = fakeRes()
      await handler(fakeReq(url), res)
      return read()
    },
  }
}

describe('N1 随包技能进入同一套 dirty 判据（同步侧建立可比基准）', () => {
  it('同步落下来的随包技能：基准 = 盘上内容哈希，未改过 dirty=false、改过后 dirty=true', async () => {
    await seedPluginSkill(1)
    expect(entryFor(syncBuiltinSkills(pluginSkills, skillsDir)).action).toBe('synced')

    const dir = join(skillsDir, NAME)
    const prov = await readProvenance(dir)
    expect(prov?.channel, '随包落点的归属必须是 plugin').toBe('plugin')
    expect(prov?.archiveChecksum, '没有基准 ⇒ dirty 结构性恒假（正是 N1 的根因）').toMatch(/^[0-9a-f]{64}$/u)
    expect(
      prov?.archiveChecksum,
      '同步侧写下的基准必须与安装器 computeSkillContentHash 逐字节同源（跨包各自实现 + 对拍，见 skill-channel-parity.spec.ts）',
    ).toBe(await computeSkillContentHash(dir))

    expect(await isInstalledSkillDirty(dir, prov), '刚同步下来的内容不得判脏（否则每次更新都多一张确认条）').toBe(false)
    expect(await classifyInstalledSkill(dir, NAME), '随包落点按"商店来源"对待（面板据此渲染来源徽章）').toBe('store')

    // 用户改正文 + 加自己的文件。
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${NAME}\n---\n\nUSER EDITED (my own notes)\n`)
    await writeFile(join(dir, 'my-notes.md'), 'user notes\n')
    expect(
      await isInstalledSkillDirty(dir, await readProvenance(dir)),
      '用户改动必须可判（面板「已本地修改」徽章与宿主覆盖/删除闸门吃这一个字段）',
    ).toBe(true)
  })

  it('升版时自动同步拒收（不静默替换）', async () => {
    await seedPluginSkill(1)
    syncBuiltinSkills(pluginSkills, skillsDir)
    const dir = join(skillsDir, NAME)
    await writeFile(join(dir, 'SKILL.md'), '---\nname: whatever\n---\n\nUSER EDITED\n')
    await writeFile(join(dir, 'my-notes.md'), 'user notes\n')

    await seedPluginSkill(2)
    const entry = entryFor(syncBuiltinSkills(pluginSkills, skillsDir))
    expect(entry?.action, '自动路径没有 UI ⇒ 只能如实拒收').toBe('refused')
    expect(entry?.code).toBe('SKILL_LOCAL_CONTENT')
    expect(existsSync(join(dir, 'my-notes.md')), '用户文件必须原样保留').toBe(true)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('USER EDITED')
    expect(await readFile(join(dir, 'scripts', 'helper.mjs'), 'utf8'), '整树都不动').toBe('// HELPER v1\n')
  })

  it('反向对照：未修改的随包技能升版照旧 synced（不许被本闸门挡住）', async () => {
    await seedPluginSkill(1)
    syncBuiltinSkills(pluginSkills, skillsDir)
    const dir = join(skillsDir, NAME)

    await seedPluginSkill(2)
    expect(entryFor(syncBuiltinSkills(pluginSkills, skillsDir))?.action).toBe('synced')
    expect(await readFile(join(dir, 'scripts', 'helper.mjs'), 'utf8')).toBe('// HELPER v2\n')
    expect(await isInstalledSkillDirty(dir, await readProvenance(dir)), '换入后的新基准必须成立').toBe(false)

    await seedPluginSkill(3)
    expect(entryFor(syncBuiltinSkills(pluginSkills, skillsDir))?.action, '连续升版也不得被挡住').toBe('synced')
    expect(await readFile(join(dir, 'scripts', 'helper.mjs'), 'utf8')).toBe('// HELPER v3\n')
  })
})

describe('N1 面板/状态面复用既有 dirty 口径（auth-gate 聚合面的宿主行）', () => {
  it('宿主行带 dirty:true + installedOrigin:store（面板徽章 = 这一份事实，不是第二套状态）', async () => {
    await seedPluginSkill(1)
    syncBuiltinSkills(pluginSkills, skillsDir)
    const dir = join(skillsDir, NAME)
    await writeFile(join(dir, 'my-notes.md'), 'user notes\n')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const res = await harness().call('/api/pico/capabilities?source=local')
    expect(res.code).toBe(200)
    const rows = (res.body.items as Array<Record<string, unknown>>).filter(i => i.source === 'local' && i.name === NAME)
    expect(rows.length, '随包技能必须出现在「我的」本机行里').toBe(1)
    expect(rows[0]?.dirty, '面板「已本地修改」徽章（capability.dirty）吃这一个字段').toBe(true)
    expect(rows[0]?.installedOrigin, '来源仍是"商店来源"（dirty 与来源是两件事）').toBe('store')
    expect(rows[0]?.originChannel).toBe('plugin')
  })
})

describe('N1b 禁用开关 ≠ 本地修改（复审 R5-B-4）', () => {
  it('仅切换禁用：dirty 仍为 false（面板不显示徽章、也不多弹确认条）', async () => {
    await seedPluginSkill(1)
    syncBuiltinSkills(pluginSkills, skillsDir)
    const dir = join(skillsDir, NAME)

    // 与「技能管理」禁用开关**同一份实现**（vendored skill-manifest.js）写标记。
    const file = join(dir, 'SKILL.md')
    const flagged = toggleDisableFlag(await readFile(file, 'utf8'), true) as string
    await writeFile(file, flagged)
    expect(flagged).toContain('disable-model-invocation: true')

    const prov = await readProvenance(dir)
    expect(await isInstalledSkillDirty(dir, prov), '平台自己写的字段不得被判成"用户改了内容"').toBe(false)

    // 面板/状态面：宿主行必须给 dirty:false ⇒ `needsOverwriteConfirm` 不会多弹一条。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    const res = await harness().call('/api/pico/capabilities?source=local')
    const row = (res.body.items as Array<Record<string, unknown>>).find(i => i.source === 'local' && i.name === NAME)
    expect(row?.dirty, '禁用不是"本地修改"').toBe(false)
    expect(row?.installedOrigin).toBe('store')
  })

  it('禁用状态下随包升版：照旧 synced，且禁用标记随新内容保留（文件与 state 不分叉）', async () => {
    await seedPluginSkill(1)
    syncBuiltinSkills(pluginSkills, skillsDir)
    const dir = join(skillsDir, NAME)
    const file = join(dir, 'SKILL.md')
    await writeFile(file, toggleDisableFlag(await readFile(file, 'utf8'), true) as string)

    await seedPluginSkill(2)
    expect(entryFor(syncBuiltinSkills(pluginSkills, skillsDir))?.action, '禁用不是"用户改过内容"，不得被闸门挡住').toBe('synced')
    const text = await readFile(file, 'utf8')
    expect(text, '换入必须保留禁用标记（否则文件说启用、state 说禁用）').toContain('disable-model-invocation: true')
    expect(text, '内容本身必须换成新版本').toContain('bundled body v2')
    expect(await isInstalledSkillDirty(dir, await readProvenance(dir)), '换入后的新基准同样成立').toBe(false)
  })

  it('反向对照：禁用之后用户**真的改了正文** ⇒ 仍然判 dirty（归一化只剔除平台字段）', async () => {
    await seedPluginSkill(1)
    syncBuiltinSkills(pluginSkills, skillsDir)
    const dir = join(skillsDir, NAME)
    const file = join(dir, 'SKILL.md')
    const flagged = toggleDisableFlag(await readFile(file, 'utf8'), true) as string
    await writeFile(file, `${flagged}\nUSER EDITED BODY\n`)

    expect(await isInstalledSkillDirty(dir, await readProvenance(dir))).toBe(true)
    await seedPluginSkill(2)
    expect(entryFor(syncBuiltinSkills(pluginSkills, skillsDir))?.code).toBe('SKILL_LOCAL_CONTENT')
    expect(await readFile(file, 'utf8')).toContain('USER EDITED BODY')
  })
})

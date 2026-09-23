/**
 * R6-B-1（第六轮审计，2026-09-23）：**「已下架」的推断判据必须有归属维度**。
 *
 * 缺陷形态（审计方在 `5869bc8481` 上复现）：技能库/预设目录是**机器作用域**的
 * （`resolveSkillsDir()` = `<DSH_HOME>/skills`，不按账号分目录，见 `skill-install.ts`），
 * 而同机换账号是被支持的操作。于是"本机有一份**商店来源**的内容、当前账号在
 * own/market 两个视图里都看不到它"这个形状对应两种完全不同的处境：
 *   - 它确实是当前账号的内容（授权撤回 / 旧服务端没下发 `delisted`），或
 *   - 它是**另一个账号**在这台机器上装的（当前账号既不是作者、也没有授权）。
 * 修复前，`isDelistedItem` 的第 3 条推断把两者都读成"已被管理员下架"，并把页脚换成
 * **删除本机那一份**（`planCardAction` 的 local 分支）—— 一个跨账号的破坏性动作；
 * `dirty` 时确认条还会把**别人**的改动说成"你改过的"。
 *
 * 判据（本文件钉住的不变量）：
 *   - `localOwnership !== 'mine'`（证明不了归属）⇒ **不判已下架、不给删除类动作**；
 *   - `delisted === true` / `enabled === false`（服务端权威字段）⇒ 照旧判已下架并给
 *     卸载（**判据没有被改弱**，也不依赖归属判据）；
 *   - 可证明属于当前账号的行 ⇒ 推断判据照旧生效（行为与第五轮一致）。
 *
 * 判据的判别力（变异验证见 `temp/r6b-fix/MUTATION.md`）：
 *   - 把 `isDelistedItem` 第 3 条的 `item.localOwnership === 'mine'` 去掉（= 修复前的形态）
 *     ⇒ 本文件「跨账号」三条红（面板又给出 uninstall）；
 *   - 把 `delisted === true` 那一行删掉 ⇒ 「权威字段」两条红；
 *   - 宿主不再下发 `localOwnership` ⇒ 「可证明属于我的行」两条红。
 *
 * 本文件与 `capability-catalog-proxy.spec.ts` 同一套夹具：**真** auth-gate 路由
 * （真扫盘 + 真服务端载荷解析 + 真 provenance 解析）→ **真**面板纯函数
 * （`mergeItems` / `isDelistedItem` / `planCardAction`）。任何一段单独绿都不算数。
 * 真挂载（DOM）那一条在 `@picoaide/dsh-account-card` 的
 * `tests/capability-delisted-badge.spec.tsx`（本包没有 jsdom）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import type { Session } from '../src/server-connector/config.ts'
import { computeSkillContentHash, writeProvenance } from '../src/skill-install.ts'
import {
  isDelistedItem,
  mergeItems,
  planCardAction,
  type CapabilityItem,
} from '../src/client/CapabilityCenterPanel.tsx'

const SKILL = 'finance-report'

const SKILL_MD = `---
name: finance-report
title: 财务月报
version: 1.0.0
description: 另一个账号在这台机器上从能力中心装下来的技能,当前账号既不是作者也没有授权。
author: someone-else
category: finance
---
这份技能的正文只用于回归测试,内容本身没有实际用途,长度也刻意写到足以通过发布前预检的
正文长度下限,以免夹具本身成为失败原因。
`

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'bob',
  token: 'BOB-TOKEN',
  role: 'employee',
}

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeReq(url: string, host = '127.0.0.1:3080'): IncomingMessage {
  return {
    method: 'GET',
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
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

function harness(session: Session | null): { call: (url: string) => Promise<{ code: number, body: any }> } {
  const routes: Route[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection'
      ? { requestRejection: () => undefined }
      : undefined),
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
  const handler = routes.find(r => r.kind === 'prefix' && r.path === '/api/pico/capabilities')?.handler
  if (handler === undefined) throw new Error('capabilities route not registered')
  return {
    call: async (url: string) => {
      const { res, read } = fakeRes()
      await handler(fakeReq(url), res)
      return read()
    },
  }
}

/**
 * 服务端三个来源的载荷（own 由用例决定；market/org 默认空 = 目录里没有它）。
 * 字段名刻意写成 `xxxRows`：`scripts/check-no-real-domains.mjs` 会把"标识符 + 公共后缀"
 * 的形状判成裸主机名（本仓已踩过同类误报），**描述这条坑时也不要抄具体后缀示例**。 */
function stubServer(payloads: { ownRows?: unknown[], marketRows?: unknown[], orgRows?: unknown[] }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const href = String(url)
    const items = href.includes('source=own') ? payloads.ownRows ?? []
      : href.includes('source=market') ? payloads.marketRows ?? []
        : href.includes('source=org') ? payloads.orgRows ?? []
          : []
    return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}

let home: string

/** 本机技能库里的那一份**商店来源**技能（provenance: channel=market, appId=目录名）。 */
async function seedStoreSkill(extraFile?: string): Promise<void> {
  const dir = join(home, 'skills', SKILL)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), SKILL_MD, 'utf8')
  await writeProvenance(dir, {
    appId: SKILL,
    version: '1.0.0',
    channel: 'market',
    server: 'https://harness.example',
    archiveChecksum: await computeSkillContentHash(dir),
    installedAt: '2026-09-20T00:00:00Z',
  })
  // 内容基准算完之后再加文件 ⇒ 哈希不一致 ⇒ dirty=true（"另一个账号改过它"）。
  if (extraFile !== undefined) await writeFile(join(dir, extraFile), 'A 的本地笔记\n', 'utf8')
}

/** 本机行 → 面板看到的卡片（真归并 + 真判定 + 真页脚动作）。 */
async function localCard(): Promise<{ local: CapabilityItem, item: CapabilityItem }> {
  const h = harness(SESSION)
  const res = await h.call('/api/pico/capabilities?source=local')
  expect(res.code).toBe(200)
  const local = (res.body.items as Array<Record<string, unknown>>)
    .find(i => i.source === 'local' && i.name === SKILL)
  expect(local, '本机那一份必须作为 local 行返回（机器作用域技能库的扫描结果）').toBeDefined()
  const item = mergeItems([local as unknown as CapabilityItem])[0]!
  return { local: local as unknown as CapabilityItem, item }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-r6b-owner-home-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('R6-B-1 跨账号：同机另一账号装的商店内容，当前账号不得判已下架、不得被给删除动作', () => {
  it('own/market 两个视图都看不到它 ⇒ localOwnership=unknown、不判已下架、页脚不是「卸载」', async () => {
    await seedStoreSkill()
    stubServer({})   // bob 既不是作者（own 空），也没有授权（market/org 空）
    const { local, item } = await localCard()

    // ① 宿主这一层：磁盘事实成立（商店来源 + 内容未改），归属**证明不了**。
    expect(local.installedOrigin).toBe('store')
    expect(local.originChannel).toBe('market')
    expect(local.dirty).toBe(false)
    expect(local.uploadStatus).toBeUndefined()
    expect(local.localOwnership, 'own 面没有匹配行 ⇒ 归属只能是 unknown（证明不了）').toBe('unknown')

    // ② 面板这一层：不判已下架、不给删除本机那一份的动作。
    expect(isDelistedItem(item), '证明不了归属时不得下"已下架"这个判词').toBe(false)
    expect(planCardAction(item)).toEqual({ kind: 'upload' })
  })

  it('另一账号改过内容（dirty）时同样不给删除入口 —— "你改过的"那句确认条结构上到不了', async () => {
    await seedStoreSkill('MY-NOTES.md')
    stubServer({})
    const { local, item } = await localCard()
    expect(local.dirty).toBe(true)
    expect(local.localOwnership).toBe('unknown')
    expect(isDelistedItem(item)).toBe(false)
    const plan = planCardAction(item)
    expect(plan.kind).not.toBe('uninstall')
    expect(plan).toEqual({ kind: 'upload' })
  })

  it('智能体预设同款（目录同样是机器作用域的，不能只在技能面收口）', async () => {
    const dir = join(home, '.agent-presets', 'ppt-gen')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent.cordis.yml'), 'name: ppt-gen\n', 'utf8')
    await writeFile(join(dir, 'preset.yml'), 'name: PPT 生成\n', 'utf8')
    await writeProvenance(dir, {
      appId: 'ppt-gen',
      version: '1.0.0',
      channel: 'org',
      server: 'https://harness.example',
      archiveChecksum: await computeSkillContentHash(dir),
      installedAt: '2026-09-20T00:00:00Z',
    })
    stubServer({})

    const h = harness(SESSION)
    const res = await h.call('/api/pico/capabilities?source=local')
    const local = (res.body.items as Array<Record<string, unknown>>)
      .find(i => i.source === 'local' && i.name === 'ppt-gen') as unknown as CapabilityItem
    expect(local).toBeDefined()
    expect(local.localOwnership).toBe('unknown')
    const item = mergeItems([local])[0]!
    expect(isDelistedItem(item)).toBe(false)
    expect(planCardAction(item)).toEqual({ kind: 'upload' })
  })
})

describe('R6-B-1 对照：真下架的判据没有被改弱', () => {
  it('服务端在作者行上下发 delisted:true ⇒ 照旧「已下架」+ 卸载（不依赖归属判据）', async () => {
    await seedStoreSkill()
    stubServer({
      ownRows: [{ kind: 'skill', name: SKILL, version: '1.0.0', status: 'approved', source: 'market', is_owner: true, delisted: true }],
    })
    const { local, item } = await localCard()
    expect(local.delisted).toBe(true)
    expect(isDelistedItem(item)).toBe(true)
    expect(planCardAction(item)).toMatchObject({
      kind: 'uninstall',
      endpoint: `/api/pico/shared-skills/${SKILL}/1.0.0/uninstall`,
    })
  })

  it('目录行下发 enabled:false（权威判据）⇒ 同样判已下架并给卸载', async () => {
    await seedStoreSkill()
    stubServer({
      ownRows: [{ kind: 'skill', name: SKILL, version: '1.0.0', status: 'approved', source: 'market', is_owner: true, versions: [] }],
      marketRows: [{ kind: 'skill', name: SKILL, version: '1.0.0', status: 'approved', source: 'market', enabled: false, versions: [] }],
    })
    const h = harness(SESSION)
    const market = await h.call('/api/pico/capabilities?source=market')
    const local = await h.call('/api/pico/capabilities?source=local')
    const rows = [
      ...(market.body.items as CapabilityItem[]),
      ...(local.body.items as CapabilityItem[]).filter(i => i.source === 'local'),
    ]
    const item = mergeItems(rows).find(i => i.name === SKILL)!
    expect(isDelistedItem(item)).toBe(true)
    expect(planCardAction(item).kind).toBe('uninstall')
  })

  it('可证明属于我的行（own 面有同名行）⇒ 推断判据照旧生效（第五轮行为不变）', async () => {
    await seedStoreSkill()
    // 旧服务端/未下发 delisted：只有 own 匹配能证明归属 —— 这一档仍走推断。
    stubServer({
      ownRows: [{ kind: 'skill', name: SKILL, version: '1.0.0', status: 'approved', source: 'market', is_owner: true }],
    })
    const { local, item } = await localCard()
    expect(local.localOwnership).toBe('mine')
    expect(isDelistedItem(item)).toBe(true)
    expect(planCardAction(item)).toMatchObject({
      kind: 'uninstall',
      endpoint: `/api/pico/shared-skills/${SKILL}/1.0.0/uninstall`,
    })
  })

  /**
   * 权威判据的**孤立**用例：这一行既没有商店溯源（推断判据用不上）、也没有归属判据，
   * 唯一能让它判"已下架"的就是服务端字段本身。删掉 `delisted === true` / `enabled === false`
   * 任一条 ⇒ 本用例红（第一条变异验证里正是这条把"判据有没有被改弱"钉住的）。
   */
  it('纯权威判据：只有 delisted:true（无商店溯源、无归属）也照旧判已下架', () => {
    const catalogRow: CapabilityItem = {
      kind: 'skill', source: 'market', name: 'gone', displayName: 'gone',
      version: '1.0.0', description: '', author: 'alice', versions: ['1.0.0'],
      installed: true, installedVersion: '1.0.0', delisted: true,
    }
    expect(isDelistedItem(catalogRow)).toBe(true)
    expect(planCardAction(catalogRow).kind).toBe('uninstall')
    // 对照：抽掉这唯一的权威信号 ⇒ 立刻不再判已下架（判据不是恒真）。注意"已安装
    // 且无新版"的商店行**本来就**给「卸载」，所以这里用未安装形态对照。
    const withoutAuthority: CapabilityItem = {
      ...catalogRow, delisted: undefined, installed: false, installedVersion: undefined,
    }
    expect(isDelistedItem({ ...catalogRow, delisted: undefined })).toBe(false)
    expect(planCardAction(withoutAuthority)).toEqual({ kind: 'install' })
  })

  it('纯权威判据：只有 enabled:false 的目录行也照旧判已下架（未安装 ⇒ 只报状态）', () => {
    const catalogRow: CapabilityItem = {
      kind: 'skill', source: 'org', name: 'gone', displayName: 'gone',
      version: '1.0.0', description: '', author: 'alice', versions: ['1.0.0'],
      installed: false, enabled: false,
    }
    expect(isDelistedItem(catalogRow)).toBe(true)
    expect(planCardAction(catalogRow)).toEqual({ kind: 'delisted' })
    expect(isDelistedItem({ ...catalogRow, enabled: undefined })).toBe(false)
    expect(planCardAction({ ...catalogRow, enabled: undefined }).kind).toBe('install')
  })
})

describe('R6-B-1 归并：归属判据只认本机行那一份', () => {
  it('mergeItems 保留本机行的 localOwnership；目录行上的同名字段不参与（缺省 undefined）', () => {
    const local: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'x', displayName: 'x', version: '1.0.0',
      description: '', author: '', versions: [], isLocal: true,
      installedOrigin: 'store', originChannel: 'market', localOwnership: 'unknown',
    }
    expect(mergeItems([local])[0]!.localOwnership).toBe('unknown')
    // 目录行（source=market）经归并后 source 不是 local ⇒ 推断判据整条不适用；
    // 且它自己带的 localOwnership 不会被当成"本机那一份"的归属。
    const catalog: CapabilityItem = { ...local, source: 'market', isLocal: undefined, localOwnership: 'mine' }
    const merged = mergeItems([catalog, local])[0]!
    expect(merged.source).toBe('market')
    expect(merged.localOwnership, '只有本机行那一份说明磁盘上的归属').toBe('unknown')
    expect(isDelistedItem(merged)).toBe(false)
  })

  /**
   * **边界①（第六轮独立复审 V2）**：`mergeItems` 的缺省方向此前**没有任何判据** ——
   * 把 `localOwnership: local?.localOwnership` 改成 `?? 'mine'`（= 把"证明不了"读成
   * "属于当前账号"）时，本文件与能力中心其余用例**全部照绿**（变异存活）。
   *
   * 现场形状：宿主**没有**在本机行上写 `localOwnership`（旧宿主 / 字段被裁剪 / 将来
   * 新增的取数路径）。这一行的语义与第一条用例里的 `'unknown'` 完全一样 ——
   * 「证明不了就不出卸载」，所以缺省必须落在同一边。
   */
  it('本机行**不带** `localOwnership`（宿主未下发）⇒ 缺省取保守方向：不判已下架、不给删除动作', () => {
    // 形状 = 没有该键（不是 `localOwnership: undefined`；两种写法都要落在同一侧）。
    const local: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'x', displayName: 'x', version: '1.0.0',
      description: '', author: '', versions: [], isLocal: true,
      installedOrigin: 'store', originChannel: 'market',
    }
    expect('localOwnership' in local, '本用例的夹具必须真的**不带**这个键').toBe(false)

    const item = mergeItems([local])[0]!
    expect(item.localOwnership, '缺省必须归一化成保守取值（证明不了 ⇒ unknown），不得读成 mine').toBe('unknown')
    expect(isDelistedItem(item), '缺省不得被读成"我的内容被下架"').toBe(false)
    expect(planCardAction(item), '缺省下唯一可达的是无副作用的「上传」，绝不是删除').toEqual({ kind: 'upload' })
  })

  /**
   * 同一形状的**权威判据对照**（边界①的"别把判据改弱"那一半）：`delisted` / `enabled`
   * 是服务端下发的事实，与归属维度**无关** —— 缺省归一化之后它们必须**各自独立成立**。
   * 这条把 `isDelistedItem` 前两条判据与第 3 条的归属维度解耦：谁把它们并进归属分支，
   * 或者谁为了"保守"顺手把权威判据也一起收窄，本用例立刻红。
   */
  it('归属缺省不影响权威判据：不带 `localOwnership` 的行上，`delisted:true` / `enabled:false` 照旧成立', () => {
    const base: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'x', displayName: 'x', version: '1.0.0',
      description: '', author: '', versions: [], isLocal: true,
      installedOrigin: 'store', originChannel: 'market',
    }
    // ① 作者面权威字段：服务端在作者自己的行上下发 `delisted:true`。
    const delisted = mergeItems([{ ...base, delisted: true }])[0]!
    expect(delisted.localOwnership).toBe('unknown')
    expect(isDelistedItem(delisted), '权威判据不依赖归属维度').toBe(true)
    expect(planCardAction(delisted)).toMatchObject({
      kind: 'uninstall',
      endpoint: `/api/pico/shared-skills/x/1.0.0/uninstall`,
    })

    // ② 目录面权威字段：下架行带 `enabled:false`（本机这一份仍在本机行上）。
    const enabledOff = mergeItems([{ ...base, enabled: false }])[0]!
    expect(enabledOff.localOwnership).toBe('unknown')
    expect(isDelistedItem(enabledOff)).toBe(true)
    expect(planCardAction(enabledOff).kind).toBe('uninstall')
  })

  it('本机自制（无商店溯源）恒不受这条判据影响：仍出「上传」', () => {
    const draft: CapabilityItem = {
      kind: 'skill', source: 'local', name: 'my-draft', displayName: 'my-draft',
      version: '1.0.0', description: '', author: '', versions: [], isLocal: true,
      installedOrigin: 'local',
    }
    expect(isDelistedItem(draft)).toBe(false)
    expect(planCardAction(draft)).toEqual({ kind: 'upload' })
  })
})

/**
 * tests/skill-uninstall-long-name.spec.ts — R21-A1-04 的仓内回归判据。
 *
 * ## 缺陷原形态
 *
 * 目录段长度上限（`MAX_SKILL_NAME_LENGTH = 64`）是**写侧**规则，却被放进了
 * `validateSkillName` —— 而卸载路径复用的正是它（`uninstallSkill` 第一行 + 四条
 * 路由的入口校验）。上游正则**不限长**，发现面（`discoverRuntimeSkills`）也刻意
 * 不设上限（注释明写"用户手放的超长名字运行时确实会加载 ⇒ 必须如实列出"），于是：
 *
 *   >64 字符名字的技能 **运行时会加载、面板列得出**，但**所有卸载入口一律 400
 *   `NAME_INVALID`**，产品内没有任何路径能删掉它（也没有本地删除路由）。
 *
 * ## 判据
 *
 *  1. 前提（因果）：超长名字确实被 pinned 上游注册表加载、被 `listInstalledSkills`
 *     列出 —— 所以"删不掉"是真缺陷，不是我们多列了一行；
 *  2. 安装器：`uninstallSkill` 必须删得掉（旧实现抛 `NAME_INVALID`）；
 *  3. 路由面（三类入口都过）：市场 `/api/pico/skills/:name/uninstall`、
 *     内置 `/api/pico/skills/builtin/:name/uninstall`、
 *     组织 `/api/pico/shared-skills/:name/:version/uninstall` 三条都回 200；
 *  4. 反向对照（写侧上限**不许**放宽）：同一个名字走 `install` 与 `packSkill` 仍然
 *     400/抛 —— 写侧规则只决定"我们装什么"，不决定"能不能删掉盘上那一份"。
 *
 * ## 变异验证
 *
 *  - `uninstallSkill` 换回 `validateSkillName(name)` ⇒ 第 2、3 组红；
 *  - 把三条路由的 `validateRuntimeSkillName` 换回 `validateSkillName` ⇒ 第 3 组红；
 *  - 把 `isRuntimeLoadableSkillName` 也加上长度上限 ⇒ 第 2、3 组红。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArchiveInstallRefusal,
  isLoadableSkillName,
  isRuntimeLoadableSkillName,
  listInstalledSkills,
  MAX_SKILL_NAME_LENGTH,
  packSkill,
  uninstallSkill,
  writeProvenance,
} from '../src/skill-install.ts'
import type { Session } from '../src/server-connector/config.ts'
import { fakeReq, fakeRes, harness } from './helpers/auth-gate-harness.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'
import { listRuntimeSkills } from './helpers/upstream-skill-registry.ts'

/** 一个**合法的 kebab 名字**，但远超写侧上限（20 段 × 5 字符 ≈ 100 字符）。 */
const LONG_NAME = Array.from({ length: 20 }, (_, index) => `seg${String(index).padStart(2, '0')}`).join('-')

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: long name probe\nversion: 1.0.0\n---\n\nbody of the long-named skill\n`
}

const dirs: string[] = []

async function seedLongNamedSkill(skillsDir: string): Promise<string> {
  const dir = join(skillsDir, LONG_NAME)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillMd(LONG_NAME), 'utf8')
  await writeProvenance(dir, {
    appId: LONG_NAME,
    version: '1.0.0',
    channel: 'market',
    server: SESSION.serverURL,
    installedAt: new Date().toISOString(),
  })
  return dir
}

beforeEach(isolateRuntimeSkillRoots)

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('R21-A1-04 超长名字：运行时加载/面板列得出 ⇒ 删除面必须收', () => {
  it('前提：名字 >64 字符（写侧拒），但运行时正则接受、上游注册表真的加载它', async () => {
    expect(LONG_NAME.length).toBeGreaterThan(MAX_SKILL_NAME_LENGTH)
    expect(isLoadableSkillName(LONG_NAME), '写侧必须继续拒（安装/打包的规则不变）').toBe(false)
    expect(isRuntimeLoadableSkillName(LONG_NAME), '运行时判据（只判 kebab 正则）必须收').toBe(true)

    const home = await mkdtemp(join(tmpdir(), 'r21a1-long-'))
    dirs.push(home)
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await seedLongNamedSkill(skillsDir)
    expect(await listInstalledSkills(skillsDir), '企业侧必须如实列出它').toEqual([LONG_NAME])
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name), '上游注册表真的加载它').toEqual([LONG_NAME])
  })

  it('安装器卸载路径：`uninstallSkill` 必须删得掉（旧实现抛 NAME_INVALID）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'r21a1-long-un-'))
    dirs.push(home)
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const dir = await seedLongNamedSkill(skillsDir)

    const target = await uninstallSkill(skillsDir, LONG_NAME, { serverURL: SESSION.serverURL }).catch((cause: unknown) => cause)
    expect(target, `卸载不得抛 NAME_INVALID：${String(target)}`).toBe(dir)
    expect(existsSync(dir)).toBe(false)
    expect(await listInstalledSkills(skillsDir)).toEqual([])
  })

  it('路由面三条卸载入口都回 200（市场 / 内置 / 组织）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'r21a1-long-route-'))
    dirs.push(home)
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))

    // 三条入口分属两个 prefix 路由（技能面 / 组织共享面）。
    const routes: ReadonlyArray<readonly [label: string, route: string, url: string]> = [
      ['市场', '/api/pico/skills', `/api/pico/skills/${LONG_NAME}/uninstall`],
      ['内置', '/api/pico/skills', `/api/pico/skills/builtin/${LONG_NAME}/uninstall`],
      ['组织', '/api/pico/shared-skills', `/api/pico/shared-skills/${LONG_NAME}/1.0.0/uninstall`],
    ]
    for (const [label, route, url] of routes) {
      await seedLongNamedSkill(skillsDir)
      const h = harness(SESSION)
      const { res, read } = fakeRes()
      await h.handler(route)(fakeReq('POST', url), res)
      const { code, body } = read()
      expect(code, `${label}卸载入口必须收下这个名字（旧实现 400 NAME_INVALID）：${JSON.stringify(body)}`).toBe(200)
      expect(existsSync(join(skillsDir, LONG_NAME)), `${label}卸载后目录必须消失`).toBe(false)
    }
  })

  it('反向对照（写侧上限不许放宽）：同一名字走 install 仍 400，packSkill 仍抛 NAME_INVALID', async () => {
    const home = await mkdtemp(join(tmpdir(), 'r21a1-long-write-'))
    dirs.push(home)
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const h = harness(SESSION)
    const { res, read } = fakeRes()
    await h.handler('/api/pico/skills')(fakeReq('POST', `/api/pico/skills/${LONG_NAME}/install`), res)
    expect(read().code, '安装面（写侧）必须继续拒超长名字').toBe(400)

    const dir = await seedLongNamedSkill(skillsDir)
    const refusal = await packSkill(skillsDir, LONG_NAME).catch((cause: unknown) => cause)
    expect(refusal).toBeInstanceOf(ArchiveInstallRefusal)
    expect((refusal as ArchiveInstallRefusal).code).toBe('NAME_INVALID')
    expect(existsSync(dir)).toBe(true)
  })
})

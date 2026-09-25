/**
 * tests/skill-provenance-session.spec.ts — 第十九轮审计 A 泳道 **R19A-S2-04**（以及
 * P3 的 **R19A-S2-08**）的回归判据。
 *
 * ## R19A-S2-04（P2）：`session.json` 缺 `serverURL` ⇒ 真外部来源被 200 零确认删除
 *
 * 旧判定把"调用方没给当前服务端"与"没有溯源标记可比"合并成同一档
 * （`provenanceServerVerdict` 的 `not-compared`）⇒ 标记写着"别台服务端装的"时
 * `isForeignServerProvenance` 仍是 false ⇒ 该目录被当成"本机商店内容" ⇒
 * **面板不用确认就删掉了别人的内容**（同一条路由在正常会话下是 409）。
 * 输入源是盘上的持久会话（`session-service` 的 `JSON.parse(...) as Session` 零字段校验），
 * 深链路径给的是空串（会被拒），所以触发前提是畸形/被改写的 `session.json`。
 *
 * 修法：缺字段走**保守档**（`unknown-current`，与 `unknown` 同等要求确认），文案点名
 * "这次会话没有服务端地址"这一真实成因。本文件用**真路由**做 A/B 对照：
 * 正常会话与畸形会话对同一个目录必须给同一个结论（409 + 落点还在）。
 *
 * ## R19A-S2-08（P3，如实登记为"同权"）
 *
 * `channel: 'plugin'` 是**自声明字段**，被它标记的目录在覆盖/删除判据里零确认。
 * 登记的事实：写这个标记需要技能库内的写权限（同权者本来就能直删），而**随包之外
 * 的写入路径都到不了这里** —— 归档自带的溯源标记在解包后被安装器独占面清掉
 * （审计 A13 的 `rmInstallerOwnedMarkers`），下面第 2 条用例把这个前提钉住：
 * 一旦哪天归档能伪造 `.picoaide/release.json`，这一档就从 P3 升级为可利用的越权。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSkillArchive, provenanceServerVerdict, writeProvenance } from '../src/skill-install.ts'
import type { Session } from '../src/server-connector/config.ts'
import { fakeReq, fakeRes, harness, stubGateway } from './helpers/auth-gate-harness.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

beforeEach(isolateRuntimeSkillRoots)

const SERVER = 'https://mine.example'
const OTHER = 'https://other.example'

const SESSION: Session = { serverURL: SERVER, username: 'alice', token: 'USER-TOKEN-abc', role: 'employee' }

/** 畸形持久会话：盘上 `session.json` 被改成缺 `serverURL`（`as Session` 零校验）。 */
const MALFORMED_SESSION = { username: 'alice', token: 'USER-TOKEN-abc', role: 'employee' } as unknown as Session

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker}\n---\n\nbody ${marker}\n`
}

async function skillArchive(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'r19v-prov-arc-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(join(dir, rel, '..'), { recursive: true })
      await writeFile(join(dir, rel), content, 'utf8')
    }
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

/** 一棵临时 home（`<home>/skills` 是能力中心管的根）。 */
async function world(): Promise<{ home: string, skillsDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'r19v-prov-'))
  roots.push(base)
  const home = join(base, 'dsh')
  const skillsDir = join(home, 'skills')
  await mkdir(skillsDir, { recursive: true })
  return { home, skillsDir }
}

/** 造一个"别台服务端装进来的"商店技能（溯源写着 `OTHER`）。 */
async function foreignSkill(skillsDir: string, name: string): Promise<string> {
  const target = join(skillsDir, name)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), skillMd(name, 'FROM-OTHER-SERVER'))
  await writeProvenance(target, {
    appId: name, version: '1.0.0', channel: 'market', server: OTHER, installedAt: '2026-01-01T00:00:00Z',
  })
  return target
}

describe('R19A-S2-04：会话缺 `serverURL` 不再是 fail-open（真路由 A/B 对照）', () => {
  it('① 真外部来源：正常会话 409、畸形会话同样 409，且落点两次都在', async () => {
    const { home, skillsDir } = await world()
    vi.stubEnv('DSH_HOME', home)
    const target = await foreignSkill(skillsDir, 'alpha')

    // A 面：正常会话 ⇒ 409 LOCAL_CONTENT（既有行为，作为对照）。
    const good = harness(SESSION)
    const goodRes = fakeRes()
    await good.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/builtin/alpha/uninstall'), goodRes.res)
    console.log('[S2-04/正常会话] =', goodRes.read().code, JSON.stringify(goodRes.read().body).slice(0, 140))
    expect(goodRes.read().code).toBe(409)
    expect(existsSync(target)).toBe(true)

    // B 面：畸形会话（`session.json` 缺 `serverURL`）⇒ 修前是 200 + 落点被删。
    const bad = harness(MALFORMED_SESSION)
    const badRes = fakeRes()
    await bad.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/builtin/alpha/uninstall'), badRes.res)
    console.log('[S2-04/畸形会话] =', badRes.read().code, JSON.stringify(badRes.read().body).slice(0, 200))
    expect(badRes.read().code, '缺字段必须走保守分支').toBe(409)
    expect(badRes.read().body.code).toBe('LOCAL_CONTENT')
    expect(String(badRes.read().body.error)).toMatch(/this client session does not carry a server address/su)
    expect(existsSync(target), '保守分支下不得删掉任何东西').toBe(true)
  })

  it('② 纯判据矩阵：三档"无法证明属于本机"都不放行（unknown / unknown-current / foreign）', () => {
    const store = { appId: 'alpha', version: '1.0.0', channel: 'market' as const, installedAt: '' }
    expect(provenanceServerVerdict({ ...store }, SERVER), '老标记').toBe('unknown')
    expect(provenanceServerVerdict({ ...store, server: OTHER }, SERVER)).toBe('foreign')
    expect(provenanceServerVerdict({ ...store, server: OTHER }, undefined)).toBe('unknown-current')
    // 只有"证明与本机同一台"（含书写变体）或"随包"才放行。
    expect(provenanceServerVerdict({ ...store, server: `${SERVER}/` }, SERVER)).toBe('same')
    expect(provenanceServerVerdict({ ...store, channel: 'plugin' }, undefined)).toBe('bundled')
  })

  it('③ 覆盖安装面同样收紧：别台同名技能 + 没有当前服务端 ⇒ 要求确认后才替换', async () => {
    const { skillsDir } = await world()
    const target = await foreignSkill(skillsDir, 'beta')

    // 与路由同一条判据路径（`classifyInstalledSkill` + `requiresOverwriteConfirmation`）：
    // `server` 就是畸形会话能给出的东西（undefined）。修前 `not-compared` ⇒ 静默整树替换。
    //
    // 边界（如实登记）：市场安装路由在畸形会话下**到不了**这里 —— 它先用
    // `normalizeServerURL(s.serverURL)` 拼上游 URL，undefined 会直接抛（502）。
    // 因此这一档是"同一条判据的收紧证明"，不是新的可达攻击面。
    const refusal = await installSkillArchive({
      name: 'beta',
      archive: await skillArchive({ 'SKILL.md': skillMd('beta', 'FROM-HUB') }),
      skillsDir,
      version: '2.0.0',
      channel: 'market',
      server: undefined,
    }).then(() => undefined, (cause: unknown) => cause as Error)
    console.log('[S2-04/覆盖] =', refusal?.message)
    expect(refusal?.message).toMatch(/installed from a server \(https:\/\/other\.example/su)
    expect(refusal?.message).toMatch(/this client session does not carry a server address/su)
    expect(await (await import('node:fs/promises')).readFile(join(target, 'SKILL.md'), 'utf8')).toContain('FROM-OTHER-SERVER')

    // 反向对照：会话地址与标记一致 ⇒ 正常更新（同一渠道、内容未改）。
    await installSkillArchive({
      name: 'beta',
      archive: await skillArchive({ 'SKILL.md': skillMd('beta', 'FROM-HUB') }),
      skillsDir,
      version: '2.0.0',
      channel: 'market',
      server: OTHER,
    })
    expect(await (await import('node:fs/promises')).readFile(join(target, 'SKILL.md'), 'utf8')).toContain('FROM-HUB')
  })
})

describe('R19A-S2-08：`channel: plugin` 只能由库内写者落下（归档伪造被剥掉）', () => {
  it('归档自带的溯源/版本标记在安装时被清掉 ⇒ 市场归档拿不到"零确认"档', async () => {
    const { home, skillsDir } = await world()
    vi.stubEnv('DSH_HOME', home)
    const archive = await skillArchive({
      'SKILL.md': skillMd('forged', 'FROM-ARCHIVE'),
      // 归档试图自带一份"随包"溯源：若能落地，卸载就可以零确认（A13 的形态）。
      '.picoaide/release.json': JSON.stringify({ appId: 'forged', version: '9.9.9', channel: 'plugin', installedAt: '' }),
      '.install-version': '9.9.9',
    })
    // 故意**不给** version：安装器就不会覆写 `.install-version`，归档那份是否还在盘上
    // 完全取决于"安装器独占面"的清除（这就是这条判据咬得到的地方）。
    await installSkillArchive({ name: 'forged', archive, skillsDir, channel: 'market', server: SERVER })
    const { INSTALL_VERSION_FILE, readProvenance } = await import('../src/skill-install.ts')
    const prov = await readProvenance(join(skillsDir, 'forged'))
    console.log('[S2-08] 落地后的溯源 =', JSON.stringify(prov))
    expect(prov?.channel, '归档不得自证"随包"').toBe('market')
    expect(prov?.version).toBe('')
    // 归档自带的版本标记必须被清掉：留着它会让面板按归档伪造的版本号判「已是最新」。
    expect(existsSync(join(skillsDir, 'forged', INSTALL_VERSION_FILE)), '归档不得自证版本').toBe(false)
  })
})

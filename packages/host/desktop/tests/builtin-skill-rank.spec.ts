/**
 * 落点 rank 的**可观察**证据：两个技能根同名时，`<dshHome>/skills` 那一份胜出
 * （2026-09-18）。
 *
 * 背景：上游 `skill-filesystem` 给两个用户级根不同的 rank（`user-dsh` = 400、
 * `user-agents` = 500），而 **rank 小者胜**（`dsh-skill` 的 SkillCandidate 注释）。
 * 平台当前把「能力中心安装」与「插件随包同步」都落在 `<dshHome>/skills`（rank 400），
 * 所以**同名技能不会同时出现在两个根里**；这个用例钉的是上游那条归并/优选语义本身
 * —— 产品在"用户自己在 `~/.agents/skills` 放了一份同名技能"时仍然依赖它（那时候
 * 必须是 `<dshHome>/skills` 那份赢，而不是随机取一份）。
 *
 * 只读 rank 常量不算证据（两处常量在别人包里，随时可能变），所以这里**起真的
 * 上游注册表 + 真的文件系统 provider**，把两份同名技能放进去，断言最终解析出来的
 * 正文来自 `<dshHome>/skills` 那一份、`source` 是 `user-dsh`。
 *
 * 反向对照（证明断言不是空转）：只放 `~/.agents/skills` 那一份时，解析结果必须是
 * `user-agents` —— 也就是说，如果哪天 rank 被对调、或根被写错，第一个用例会红。
 *
 * ⚠️ 平台技能 `app-builder` **不再**由插件随包同步（用户口径「按需安装」，
 * 见 `memory-evolve/lib/coi/skills-sync.js` 的 `PLATFORM_SKILLS`；2026-09-19 起
 * 它的源目录也不在客户端包里了，真源是 `server/skills/app-builder/`），所以这里的
 * "两份副本"是**构造**出来的场景、不是生产形态；用它的名字只是复用一份现成的
 * frontmatter 夹具，与那个技能的分发路径无关。
 */
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SERVER_BODY = 'SERVER-DELIVERED-COPY（能力中心安装，<dshHome>/skills）'
const BUNDLED_BODY = 'BUNDLED-COPY（用户自己放在 ~/.agents/skills 的同名副本）'

function skillMd(description: string, marker: string): string {
  return `---
name: app-builder
description: ${description}
version: 1.0.0
---
${marker}
`
}

async function plant(root: string, marker: string): Promise<void> {
  const dir = join(root, 'skills', 'app-builder')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillMd('用于 rank 回归测试的技能描述，长度足够通过解析。', marker), 'utf8')
}

/** 起一套真实的上游技能栈（注册表 + 文件系统 provider），返回解析入口。 */
async function bootRegistry(dshHome: string, agentsHome: string): Promise<{
  list: () => Promise<Array<{ name: string, source: string }>>
  body: (name: string) => Promise<string | undefined>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  // 两个插件都按 cordis 语义装载：注册表提供 `skills` 服务，provider 注入它。
  // 记下 fiber：cordis 的清理入口是 fiber.dispose()（Context 本身没有 dispose）。
  const registryFiber = ctx.plugin(SkillRegistry, {})
  const providerFiber = ctx.plugin(skillFilesystem, {
    dshHome,
    agentsHome,
    // 只测用户级两个根（project/custom/bundled 与本议题无关）。
    includeDefaultRoots: true,
  })
  // cordis 的同步插件在 ctx.plugin() 内即完成装载；让出一轮微任务仅为了
  // 让 provider 的首次发现有机会落定。
  await Promise.resolve()
  const skills = (ctx as unknown as {
    skills: {
      list: (o?: unknown) => Promise<Array<{ name: string, source: string }>>
      get: (n: string, o?: unknown) => Promise<{ content: string } | undefined>
    }
  }).skills
  if (skills === undefined) throw new Error('skills 服务未注册（上游装载失败）')
  return {
    list: () => skills.list(),
    body: async (name: string) => (await skills.get(name))?.content,
    dispose: async () => {
      await providerFiber.dispose().catch(() => {})
      await registryFiber.dispose().catch(() => {})
    },
  }
}

let root: string
let dshHome: string
let agentsHome: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pico-skill-rank-'))
  dshHome = join(root, 'harness-home')      // DSH_HOME（渠道数据根）
  agentsHome = join(root, 'agents-home')    // ~/.agents
  await mkdir(dshHome, { recursive: true })
  await mkdir(agentsHome, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('技能落点 rank：<dshHome>/skills（user-dsh 400）压过 ~/.agents/skills（user-agents 500）', () => {
  it('两个根同名并存时，加载的是 <dshHome>/skills 那一份（rank 400 胜 500）', async () => {
    await plant(dshHome, SERVER_BODY)
    await plant(agentsHome, BUNDLED_BODY)
    const reg = await bootRegistry(dshHome, agentsHome)
    try {
      const rows = await reg.list()
      const mine = rows.filter(r => r.name === 'app-builder')
      expect(mine, '同名技能必须归并成一条（不是两条）').toHaveLength(1)
      expect(mine[0]?.source).toBe('user-dsh')
      const body = await reg.body('app-builder')
      expect(body).toContain('SERVER-DELIVERED-COPY')
      expect(body).not.toContain('BUNDLED-COPY')
    } finally {
      await reg.dispose()
    }
  })

  it('反向对照：只在 ~/.agents/skills 放一份时解析结果来自 user-agents（断言不是空转）', async () => {
    await plant(agentsHome, BUNDLED_BODY)
    const reg = await bootRegistry(dshHome, agentsHome)
    try {
      const rows = await reg.list()
      const mine = rows.filter(r => r.name === 'app-builder')
      expect(mine).toHaveLength(1)
      expect(mine[0]?.source).toBe('user-agents')
      expect(await reg.body('app-builder')).toContain('BUNDLED-COPY')
    } finally {
      await reg.dispose()
    }
  })
})

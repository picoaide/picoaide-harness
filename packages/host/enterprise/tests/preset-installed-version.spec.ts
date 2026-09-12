import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedVersionFor, readInstalledPresetVersion } from '../src/auth-gate.ts'
import { writeProvenance } from '../src/skill-install.ts'
import { hasUpdateFor, type CapabilityItem } from '../src/client/CapabilityCenterPanel.tsx'

/**
 * 审计 2026-09-12 P1-6(回归):能力中心的「更新到 vX」对**共享 Agent**
 * 恒不出现 —— auth-gate 的 enriched 分支把 installedVersion 写成
 * `kind === 'skill' ? localSkillVersions.get(name) : undefined`(注释却说
 * "取 '1.0.0' 兜底"),而客户端 `hasUpdateFor()` 一见 undefined 就 false。
 *
 * 这里对**真实代码路径**做端到端断言:磁盘写真的 provenance → 读出已装版本
 * → 按 kind 选表 → 喂给真实 hasUpdateFor(),必须返回 true。
 */

async function presetDirWithProvenance(name: string, version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'picoaide-preset-ver-'))
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'preset.yml'), '- id: persona\n  name: x\n', 'utf8')
  await writeProvenance(dir, {
    appId: `app-${name}`,
    version,
    channel: 'org',
    installedAt: new Date().toISOString(),
  })
  return dir
}

describe('共享 Agent 的已装版本(FIX-27)', () => {
  it('从磁盘 provenance 读出 preset 版本(与技能同一套落盘)', async () => {
    const dir = await presetDirWithProvenance('reviewer', '1.0.0')
    expect(await readInstalledPresetVersion(dir)).toBe('1.0.0')
  })

  it('无 provenance 时回落到 .install-version 标记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'picoaide-preset-ver-'))
    const dir = join(root, 'legacy')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.install-version'), '0.9.0\n', 'utf8')
    expect(await readInstalledPresetVersion(dir)).toBe('0.9.0')
  })

  it('两者都没有 ⇒ undefined(保守:宁可不提示,不可误报)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'picoaide-preset-ver-'))
    const dir = join(root, 'bare')
    await mkdir(dir, { recursive: true })
    expect(await readInstalledPresetVersion(dir)).toBeUndefined()
  })

  it('installedVersionFor 按 kind 选表;agent 不再恒 undefined', () => {
    const skills = new Map<string, string | undefined>([['codeql', '2.0.0']])
    const presets = new Map<string, string | undefined>([['reviewer', '1.0.0']])
    expect(installedVersionFor('skill', 'codeql', skills, presets)).toBe('2.0.0')
    expect(installedVersionFor('agent', 'reviewer', skills, presets)).toBe('1.0.0')
    // 改前形态:`kind === 'skill' ? skills.get(n) : undefined` —— 共享 Agent 恒 undefined
    expect(installedVersionFor('agent', 'reviewer', new Map(), presets)).toBe('1.0.0')
  })

  it('端到端:本地已装 v1 + 远端 approved v2 ⇒ 面板必须显示「可更新」', async () => {
    const dir = await presetDirWithProvenance('reviewer', '1.0.0')
    const installedVersion = await readInstalledPresetVersion(dir)
    expect(installedVersion).toBe('1.0.0')

    // 远端目录行经与 auth-gate 完全相同的选表逻辑
    const versions = installedVersionFor('agent', 'reviewer', new Map(), new Map([['reviewer', installedVersion]]))
    const item: CapabilityItem = {
      kind: 'agent', source: 'org', name: 'reviewer', displayName: 'Reviewer',
      version: '2.0.0', description: '', author: '', status: 'approved',
      versions: ['1.0.0', '2.0.0'], installed: true, installedVersion: versions,
    }
    expect(hasUpdateFor(item)).toBe(true)

    // 改前形态的对照:installedVersion 为 undefined ⇒ 恒 false(缺陷本身)
    expect(hasUpdateFor({ ...item, installedVersion: undefined })).toBe(false)
  })
})

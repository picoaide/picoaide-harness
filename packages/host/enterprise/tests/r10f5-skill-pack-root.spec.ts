/**
 * R10-F5 regression — the skill archive's traversal ROOT.
 *
 * R10-B-03: `packSkill` proved the skill existed with `stat(join(dir,
 * 'SKILL.md'))` and then walked `dir`. `stat` FOLLOWS symbolic links, and the
 * per-entry guard inside the walk only refused links found INSIDE the tree — so
 * `<skills>/<name>` being a link (a developer's `ln -s` of a working copy into
 * the skill library is the everyday shape) packed whatever the link pointed at,
 * including files that are not part of the skill and live outside the library.
 * Measured pre-fix: the archive contained `secret.txt` from the link target.
 *
 * The disposition is fail-loud, not silent-skip: a pre-existing link is refused
 * with a message that names it, so the local skill library can never be the
 * source of an upload that carries outside content. The controls below keep the
 * refusal from being over-broad — a real directory still packs, and a symlinked
 * SKILL ROOT (a legitimate deployment) still works.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { listInstalledSkills, packSkill, uninstallSkill } from '../src/skill-install.ts'

/** A sentinel that must never appear in an archive built from inside a skill. */
const OUTSIDE = 'R10F5-OUTSIDE-SENTINEL'

function skillMd(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'version: 1.0.0',
    'title: Probe Skill',
    'description: A probe skill used by the round-10 audit.',
    'author: audit',
    'category: engineering',
    '---',
    '',
    'Probe body text long enough for the manifest precheck minimum length rule.',
    '',
  ].join('\n')
}

interface Fixture {
  root: string
  skills: string
  outside: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'r10f5-skill-'))
  const skills = join(root, 'skills')
  const outside = join(root, 'outside')
  await mkdir(skills, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'SKILL.md'), skillMd('linked'))
  await writeFile(join(outside, 'secret.txt'), OUTSIDE)
  return { root, skills, outside }
}

/** Run `packSkill` without letting the refusal escape, for a readable verdict. */
async function attemptPack(
  skills: string,
  name: string,
): Promise<{ ok: true, archive: Buffer, entries: string[] } | { ok: false, error: Error }> {
  return await packSkill(skills, name).then(
    (value) => {
      const zip = new AdmZip(value.archive)
      return { ok: true as const, archive: value.archive, entries: zip.getEntries().map(entry => entry.entryName).sort() }
    },
    (error: unknown) => ({ ok: false as const, error: error as Error }),
  )
}

describe('R10-B-03: packSkill refuses a skill root that is a symlink', () => {
  it('a symlinked skill directory is refused, and nothing from the link target is archived', async () => {
    const { skills, outside } = await fixture()
    await symlink(outside, join(skills, 'linked'), 'dir')

    const packed = await attemptPack(skills, 'linked')
    if (packed.ok) {
      throw new Error(
        '技能根是符号链接时必须拒收：实际接受了，归档条目='
        + `${JSON.stringify(packed.entries)}（其中 ${JSON.stringify('secret.txt')} 来自技能库外）`,
      )
    }
    expect(packed.error.message, '拒绝文案必须点名符号链接（用户要看得懂）').toMatch(/符号链接|symbolic link/u)
    expect(
      await listInstalledSkills(skills),
      '同一处置：符号链接不是技能（列表与打包入口必须一致）',
    ).toEqual([])
  }, 30_000)

  it('control: a real skill directory next to it still packs, and carries no outside bytes', async () => {
    const { skills, outside } = await fixture()
    await symlink(outside, join(skills, 'linked'), 'dir')
    const real = join(skills, 'plain-skill')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'SKILL.md'), skillMd('plain-skill'))
    await writeFile(join(real, 'note.md'), 'hello')

    const packed = await attemptPack(skills, 'plain-skill')
    if (!packed.ok) throw packed.error
    expect(packed.entries, '归档根就是技能目录，条目只有它自己的内容').toEqual(['SKILL.md', 'note.md'])
    expect(
      packed.archive.includes(Buffer.from(OUTSIDE)),
      '归档里不得出现技能库外的任何字节（符号链接目标的哨兵）',
    ).toBe(false)
    expect(await listInstalledSkills(skills), '列表只认真实目录').toEqual(['plain-skill'])
  }, 30_000)

  it('an inner symlink to a FILE is still refused (the existing entry-level rule)', async () => {
    const { skills, outside } = await fixture()
    const real = join(skills, 'real-skill')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'SKILL.md'), skillMd('real-skill'))
    await symlink(join(outside, 'secret.txt'), join(real, 'sneak.txt'))

    const packed = await attemptPack(skills, 'real-skill')
    if (packed.ok) throw new Error(`树内符号链接必须拒收：实际接受了 ${JSON.stringify(packed.entries)}`)
    expect(packed.error.message).toMatch(/symlink refused in package/u)
  }, 30_000)

  it('an inner symlink to a DIRECTORY is refused too (lstat decides per entry)', async () => {
    const { skills, outside } = await fixture()
    const real = join(skills, 'real-skill')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'SKILL.md'), skillMd('real-skill'))
    await symlink(outside, join(real, 'sub'), 'dir')

    const packed = await attemptPack(skills, 'real-skill')
    if (packed.ok) {
      throw new Error(
        `目录形态的树内符号链接同样是越界引用，必须拒收：实际接受了 ${JSON.stringify(packed.entries)}`,
      )
    }
    expect(packed.error.message).toMatch(/symlink refused in package/u)
    expect(existsSync(join(outside, 'secret.txt')), '拒收不得动到链接目标').toBe(true)
  }, 30_000)

  it('control: a symlinked SKILLS ROOT is a legitimate deployment and still packs', async () => {
    const { root, skills } = await fixture()
    const real = join(skills, 'plain-skill')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'SKILL.md'), skillMd('plain-skill'))
    await writeFile(join(real, 'note.md'), 'hello')
    // `<DSH_HOME>/skills` itself pointing at a working tree is normal; only the
    // skill directory has to be a real directory.
    const linkedRoot = join(root, 'skills-link')
    await symlink(skills, linkedRoot, 'dir')

    const packed = await attemptPack(linkedRoot, 'plain-skill')
    if (!packed.ok) throw packed.error
    expect(packed.entries).toEqual(['SKILL.md', 'note.md'])
  }, 30_000)

  it('control: uninstalling a symlinked "skill" still only removes the link', async () => {
    const { skills, outside } = await fixture()
    await symlink(outside, join(skills, 'linked'), 'dir')

    await uninstallSkill(skills, 'linked', { overwrite: true })
    expect(existsSync(join(skills, 'linked')), '链接本身必须被摘掉').toBe(false)
    expect(existsSync(join(outside, 'secret.txt')), '链接目标一字未动（rm 不跟随符号链接）').toBe(true)
    expect((await readdir(outside)).sort()).toEqual(['SKILL.md', 'secret.txt'])
  }, 30_000)
})

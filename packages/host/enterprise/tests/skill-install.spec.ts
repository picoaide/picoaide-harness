import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
import AdmZip from 'adm-zip'
import {
  classifyInstalledSkill,
  computeSkillContentHash,
  describeArchiveFailure,
  installSkillArchive,
  isLoadableSkillName,
  listInstalledSkills,
  listLocalSkills,
  listShadowingSkills,
  packSkill,
  readProvenance,
  resolveSkillsDir,
  sanitizeArchiveErrorText,
  SKILL_LOCK_DIR,
  SKILL_NAME_PATTERN,
  ArchiveInstallRefusal,
  sweepInstallerOwnedShadowSkills,
  sweepStaleSkillTemps,
  uninstallSkill,
  validateSkillName,
  writeProvenance,
} from '../src/skill-install.ts'
import { MAX_ARCHIVE_BYTES } from '../src/archive-util.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

// R13-GH3（H2 跨根）：卸载的"成功"覆盖运行时**全部已知根**（`<dshHome>/skills` +
// `<agentsHome>/skills` + bundled），而 `<agentsHome>` 默认指向**真实 `~/.agents`** ⇒ 不隔离时
// 本文件的用例会变成"开发机上装了哪些技能"的函数（命中同名就正确地报 422 RESIDUE）。
// 隔离实现与实测形态见 tests/helpers/runtime-skill-roots.ts。
beforeEach(isolateRuntimeSkillRoots)

/**
 * R19A-S2-04（2026-09-26）：**缺服务端地址不再等于"不比较"** —— 溯源标记里有来源、
 * 而这一次调用没有当前会话地址时，来源判据走保守档（`unknown-current` ⇒ 与
 * `unknown` 同样要求确认）。因此凡是要建模"这台服务端的商店内容"的用例，都必须
 * 像真路由那样把服务端地址一起给出（生产路由恒传 `s.serverURL`）。
 */
const STORE_SERVER = 'https://harness.example'

/** Pack a directory into a gzipped tar buffer (relative paths, portable). */
async function packDir(dir: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    const stream = tar.c({ gzip: true, cwd: dir, portable: true }, ['.'])
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return Buffer.concat(chunks)
}

/** Build a gzipped tar from the given files ({ path -> content }). */
async function makeArchive(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'pico-skill-archive-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
    }
    return await packDir(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Build a zip from the given files (new preferred skill bundle format). */
function makeZipArchive(files: Record<string, string>): Buffer {
  const z = new AdmZip()
  for (const [path, content] of Object.entries(files)) {
    z.addFile(path, Buffer.from(content), '', 0o644)
  }
  return z.toBuffer()
}

/** Build a tar whose entries use a leading `../` name via a fileList entry. */
async function makeTraversalArchive(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'pico-skill-archive-'))
  const outsideName = `evil-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    // Pack a file from OUTSIDE the cwd: tar.c records the entry path as
    // `../<outsideName>`, which the listing pass must reject.
    await writeFile(join(dir, 'SKILL.md'), '# demo\n')
    await writeFile(join(dir, '..', outsideName), 'escape')
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const stream = tar.c({ gzip: true, cwd: dir, portable: true }, [`../${outsideName}`])
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('error', reject)
      stream.on('end', () => resolve())
    })
    return Buffer.concat(chunks)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(join(dir, '..', outsideName), { force: true })
  }
}

const SKILL_MD = '# Demo Skill\n\nDemo instructions.\n'

describe('validateSkillName', () => {
  it('accepts safe single-segment names', () => {
    expect(validateSkillName('code-review')).toBe('code-review')
    expect(validateSkillName('a1')).toBe('a1')
    expect(validateSkillName('skill-v2')).toBe('skill-v2')
    // 审计 A1:安装器的名字规则必须与运行时**逐字一致**——点号/下划线/连续连字符
    // 装得上但运行时永远不加载,因此这里一律拒绝。
    expect(SKILL_NAME_PATTERN.test('skill.v2_3')).toBe(false)
    expect(() => validateSkillName('skill.v2_3')).toThrow(/invalid skill name/)
    expect(() => validateSkillName('my_skill')).toThrow(/invalid skill name/)
    expect(() => validateSkillName('alpha--beta')).toThrow(/invalid skill name/)
    expect(() => validateSkillName('skill-')).toThrow(/invalid skill name/)
    expect(() => validateSkillName('-lead')).toThrow(/invalid skill name/)
  })

  it('rejects traversal, absolute, and empty names', () => {
    expect(() => validateSkillName('../evil')).toThrow(/invalid skill name/)
    expect(() => validateSkillName('/etc/passwd')).toThrow(/invalid skill name/)
    expect(() => validateSkillName('a/b')).toThrow(/invalid skill name/)
    expect(() => validateSkillName('')).toThrow(/invalid skill name/)
    expect(() => validateSkillName('UPPER')).toThrow(/invalid skill name/)
  })
})

describe('installSkillArchive', () => {
  it('installs a valid archive and places SKILL.md at the target', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      const archive = await makeArchive({
        'SKILL.md': SKILL_MD,
        'metadata.yaml': 'name: demo\nversion: 1.0.0\n',
        'scripts/run.sh': '#!/bin/sh\necho hi\n',
      })
      const checksum = createHash('sha256').update(archive).digest('hex')
      const result = await installSkillArchive({ name: 'demo-skill', archive, checksum, skillsDir, version: '1.0.0' })
      expect(result.targetDir).toBe(join(skillsDir, 'demo-skill'))
      const installedMd = await readFile(join(skillsDir, 'demo-skill', 'SKILL.md'), 'utf8')
      // 审计 A1:合成出来的 frontmatter `name` 恒等于技能 ID(目录名),metadata.yaml 的
      // 展示名进 title —— 旧实现照抄 `name: demo` 会让运行时判 invalid skill name。
      expect(installedMd).toMatch(/^---\nname: demo-skill\ndescription: demo-skill skill\ntitle: demo\nversion: 1\.0\.0\n---\n# Demo Skill/)
      expect(installedMd).toContain(SKILL_MD)
      expect(await readFile(join(skillsDir, 'demo-skill', 'scripts', 'run.sh'), 'utf8')).toContain('echo hi')
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  it('installs a zip archive (preferred new format) with the same result', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      const archive = makeZipArchive({
        'SKILL.md': SKILL_MD,
        'metadata.yaml': 'name: zip-demo\nversion: 1.0.0\n',
        'scripts/run.sh': '#!/bin/sh\necho hi\n',
      })
      const checksum = createHash('sha256').update(archive).digest('hex')
      const result = await installSkillArchive({ name: 'zip-demo', archive, checksum, skillsDir, version: '1.0.0' })
      expect(result.targetDir).toBe(join(skillsDir, 'zip-demo'))
      expect(await readFile(join(skillsDir, 'zip-demo', 'SKILL.md'), 'utf8')).toContain('# Demo Skill')
      expect(await readFile(join(skillsDir, 'zip-demo', 'scripts', 'run.sh'), 'utf8')).toContain('echo hi')
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  it('installs a zip archive carrying a `./` root directory entry (zip -r . style)', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      // `zip -r skill.zip .` 类打包的典型产物: 根目录条目以 `./` 出现。
      const z = new AdmZip()
      z.addFile('./', Buffer.alloc(0), '', 0o755)
      z.addFile('./SKILL.md', Buffer.from(SKILL_MD), '', 0o644)
      z.addFile('./metadata.yaml', Buffer.from('name: dot-demo\nversion: 1.0.0\n'), '', 0o644)
      const archive = z.toBuffer()
      const result = await installSkillArchive({ name: 'dot-demo', archive, skillsDir, version: '1.0.0' })
      expect(result.targetDir).toBe(join(skillsDir, 'dot-demo'))
      expect(await readFile(join(skillsDir, 'dot-demo', 'SKILL.md'), 'utf8')).toContain('# Demo Skill')
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  it('refuses a checksum mismatch', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      const archive = await makeArchive({ 'SKILL.md': SKILL_MD })
      await expect(installSkillArchive({ name: 'demo', archive, checksum: '0'.repeat(64), skillsDir }))
        .rejects.toThrow(/checksum mismatch/)
      await expect(readFile(join(skillsDir, 'demo', 'SKILL.md'))).rejects.toThrow()
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  it('refuses an archive without SKILL.md', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      const archive = await makeArchive({ 'readme.txt': 'no skill here' })
      await expect(installSkillArchive({ name: 'demo', archive, skillsDir }))
        .rejects.toThrow(/SKILL\.md/)
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  it('refuses parent-traversal entries', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      const archive = await makeTraversalArchive()
      await expect(installSkillArchive({ name: 'demo', archive, skillsDir }))
        .rejects.toThrow(/parent traversal|link entry refused/)
      // Nothing escaped the skill root.
      await expect(readFile(join(skillsDir, 'evil'))).rejects.toThrow()
    } finally {      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  it('replaces an existing installation on reinstall', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      const v1 = await makeArchive({ 'SKILL.md': '# v1\n' })
      await installSkillArchive({ name: 'demo', archive: v1, skillsDir, server: STORE_SERVER })
      expect(await readFile(join(skillsDir, 'demo', 'SKILL.md'), 'utf8')).toContain('v1')
      const v2 = await makeArchive({ 'SKILL.md': '# v2\n', 'extra.txt': 'x' })
      await installSkillArchive({ name: 'demo', archive: v2, skillsDir, server: STORE_SERVER })
      expect(await readFile(join(skillsDir, 'demo', 'SKILL.md'), 'utf8')).toContain('v2')
      expect(await readFile(join(skillsDir, 'demo', 'extra.txt'), 'utf8')).toContain('x')
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  it('rejects oversized archives', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      const big = Buffer.alloc(MAX_ARCHIVE_BYTES + 1, 0x61)
      await expect(installSkillArchive({ name: 'demo', archive: big, skillsDir }))
        .rejects.toThrow(/too large/)
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })

  it('resolves the skill root from DSH_HOME with a product fallback', () => {
    expect(resolveSkillsDir({ DSH_HOME: '/tmp/home' })).toBe('/tmp/home/skills')
    expect(resolveSkillsDir({ DSH_HOME: '  ' })).toContain('.picoaide-harness')
  })
})

describe('synthesizeSkillFrontmatter', () => {
  it('prepends frontmatter from metadata.yaml when SKILL.md lacks it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pico-skill-fm-'))
    try {
      await writeFile(join(dir, 'SKILL.md'), '# 代码审查技能\n\n正文\n')
      await writeFile(join(dir, 'metadata.yaml'), 'name: code-review\ndescription: 代码审查\nversion: 1.0.0\n')
      await import('../src/skill-install.ts').then(async (m) => {
        await m.synthesizeSkillFrontmatter(dir, 'code-review')
      })
      const out = await readFile(join(dir, 'SKILL.md'), 'utf8')
      expect(out).toMatch(/^---\nname: code-review\ndescription: 代码审查(\nversion: 1\.0\.0)?\n---\n# 代码审查技能/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves a SKILL.md that already has frontmatter untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pico-skill-fm-'))
    try {
      const existing = '---\nname: keep\ndescription: keep me\n---\n# Body\n'
      await writeFile(join(dir, 'SKILL.md'), existing)
      const m = await import('../src/skill-install.ts')
      await m.synthesizeSkillFrontmatter(dir, 'fallback')
      expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(existing)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the archive name without metadata.yaml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pico-skill-fm-'))
    try {
      await writeFile(join(dir, 'SKILL.md'), '# Body\n')
      const m = await import('../src/skill-install.ts')
      await m.synthesizeSkillFrontmatter(dir, 'demo')
      const out = await readFile(join(dir, 'SKILL.md'), 'utf8')
      expect(out).toMatch(/^---\nname: demo\n/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('install end-to-end produces a discoverable SKILL.md with frontmatter', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'pico-skill-skills-'))
    try {
      const archive = await makeArchive({
        'SKILL.md': '# 代码审查技能\n\n按规范审查。\n',
        'metadata.yaml': 'name: code-review\ndescription: 代码审查\nversion: 1.0.0\n',
        'scripts/review.py': '#!/usr/bin/env python3\nprint("ok")\n',
      })
      await installSkillArchive({ name: 'code-review', archive, skillsDir })
      const out = await readFile(join(skillsDir, 'code-review', 'SKILL.md'), 'utf8')
      // 新合成 frontmatter 会带上 metadata.yaml 的 version(installedVersion
      // 依据);断言 name/description 始终存在,version 可选。
      expect(out).toMatch(/^---\nname: code-review\ndescription: 代码审查(\nversion: 1\.0\.0)?\n---\n/)
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  })
})

describe('listInstalledSkills', () => {
  it('lists skill directories carrying SKILL.md, sorted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-skill-root-'))
    try {
      await mkdir(join(root, 'alpha'), { recursive: true })
      await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: demo\n---\n# a\n')
      // No SKILL.md — not an installed skill.
      await mkdir(join(root, 'beta'), { recursive: true })
      // A loose markdown file at the root — not an installed skill either.
      await writeFile(join(root, 'note.md'), 'x')
      await mkdir(join(root, 'gamma'), { recursive: true })
      await writeFile(join(root, 'gamma', 'SKILL.md'), '---\nname: gamma\ndescription: demo\n---\n# g\n')
      expect(await listInstalledSkills(root)).toEqual(['alpha', 'gamma'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns an empty list for a missing or unreadable root', async () => {
    expect(await listInstalledSkills(join(tmpdir(), 'no-such-pico-skills-dir'))).toEqual([])
  })
})

describe('uninstallSkill', () => {
  it('removes an installed skill directory (商店来源无需确认)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-skill-root-'))
    try {
      await mkdir(join(root, 'alpha'), { recursive: true })
      await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: demo\n---\n# a\n')
      // 带能力中心写的溯源 ⇒ 直接删(不带 overwrite 也允许)。
      await writeProvenance(join(root, 'alpha'), {
        appId: 'alpha', version: '1.0.0', channel: 'market', server: STORE_SERVER, installedAt: new Date().toISOString(),
      })
      await expect(uninstallSkill(root, 'alpha', { serverURL: STORE_SERVER })).resolves.toBe(join(root, 'alpha'))
      await expect(readFile(join(root, 'alpha', 'SKILL.md'), 'utf8')).rejects.toThrow()
      expect(await listInstalledSkills(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('本机自制同名技能必须显式确认才能卸载(审计 A3)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-skill-root-'))
    try {
      await mkdir(join(root, 'self-made'), { recursive: true })
      await writeFile(join(root, 'self-made', 'SKILL.md'), '---\nname: self-made\ndescription: demo\n---\n# mine\n')
      await writeFile(join(root, 'self-made', 'notes.md'), 'my notes\n')
      // 无溯源 = 用户自制:默认拒绝,且不许动磁盘上任何东西。
      await expect(uninstallSkill(root, 'self-made')).rejects.toThrow(/not installed by the Capability Hub/)
      await expect(readFile(join(root, 'self-made', 'notes.md'), 'utf8')).resolves.toBe('my notes\n')
      // 用户确认后才删。
      await expect(uninstallSkill(root, 'self-made', { overwrite: true })).resolves.toBe(join(root, 'self-made'))
      expect(await listInstalledSkills(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to uninstall a skill that is not installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-skill-root-'))
    try {
      await expect(uninstallSkill(root, 'missing')).rejects.toThrow(/not installed/)
      // A directory without SKILL.md is not an installed skill.
      await mkdir(join(root, 'notes'), { recursive: true })
      await writeFile(join(root, 'notes', 'scratch.txt'), 'x')
      await expect(uninstallSkill(root, 'notes')).rejects.toThrow(/not installed/)
      // The non-skill directory must survive the refusal.
      await expect(readFile(join(root, 'notes', 'scratch.txt'), 'utf8')).resolves.toBe('x')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses invalid names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-skill-root-'))
    try {
      await expect(uninstallSkill(root, '../evil')).rejects.toThrow(/invalid skill name/)
      await expect(uninstallSkill(root, '')).rejects.toThrow(/invalid skill name/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('packSkill', () => {
  const skillMd = (name: string, version?: string): string =>
    `---\nname: ${name}\ntitle: ${name} 技能\n${version === undefined ? '' : `version: ${version}\n`}` +
    `description: 用于单测的技能包描述,需满足最短长度。\nauthor: tester\ncategory: 测试\n---\n\n本技能用于单元测试:正文需要足够长才能通过空壳校验,因此这里补充两句完整的说明文字,确保长度稳稳超过五十字的下限要求。\n`

  it('takes the version from the package frontmatter (包内即真相)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-pack-'))
    try {
      await mkdir(join(root, 'demo-skill'), { recursive: true })
      await writeFile(join(root, 'demo-skill', 'SKILL.md'), skillMd('demo-skill', '2.3.0'))
      const packed = await packSkill(root, 'demo-skill')
      // 此前这里恒为 '1.0.0'(默认参数),服务端因此永远看不到真实版本。
      expect(packed.version).toBe('2.3.0')
      expect(packed.checksum).toMatch(/^[0-9a-f]{64}$/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to pack a skill whose SKILL.md has no version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-pack-'))
    try {
      await mkdir(join(root, 'demo-skill'), { recursive: true })
      await writeFile(join(root, 'demo-skill', 'SKILL.md'), skillMd('demo-skill'))
      await expect(packSkill(root, 'demo-skill')).rejects.toThrow(/version/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still honours an explicit version override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-pack-'))
    try {
      await mkdir(join(root, 'demo-skill'), { recursive: true })
      await writeFile(join(root, 'demo-skill', 'SKILL.md'), skillMd('demo-skill', '1.0.0'))
      const packed = await packSkill(root, 'demo-skill', '9.9.9')
      expect(packed.version).toBe('9.9.9')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('溯源标记与本地改动检测', () => {
  const makeArchive = (name: string): Buffer => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from(
      `---\nname: ${name}\ntitle: ${name} 技能\nversion: 1.2.0\n` +
      `description: 用于单测的技能包描述,需满足最短长度。\nauthor: t\ncategory: 测试\n---\n\n本技能用于单元测试:正文需要足够长才能通过空壳校验,因此这里补充两句完整的说明文字,确保长度稳稳超过五十字的下限要求。\n`))
    zip.addFile('references/a.md', Buffer.from('参考\n'))
    return zip.toBuffer()
  }

  it('安装后写入 .picoaide/release.json,可回答「来自哪个应用哪个版本」', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-prov-'))
    try {
      await installSkillArchive({
        name: 'demo-skill', archive: makeArchive('demo-skill'), skillsDir: root,
        version: '1.2.0', channel: 'market', server: 'https://harness.example.com',
      })
      const prov = await readProvenance(join(root, 'demo-skill'))
      expect(prov?.appId).toBe('demo-skill')
      expect(prov?.version).toBe('1.2.0')
      expect(prov?.channel).toBe('market')
      expect(prov?.server).toBe('https://harness.example.com')
      expect(prov?.archiveChecksum).toMatch(/^[0-9a-f]{64}$/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('本地改动会让内容哈希与安装时记录不一致(dirty 判定)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-prov-'))
    try {
      await installSkillArchive({ name: 'demo-skill', archive: makeArchive('demo-skill'), skillsDir: root, version: '1.2.0' })
      const prov = await readProvenance(join(root, 'demo-skill'))
      // 未改动:一致。
      expect(await computeSkillContentHash(join(root, 'demo-skill'))).toBe(prov?.archiveChecksum)
      // 改动一个文件后:不一致。
      await writeFile(join(root, 'demo-skill', 'references', 'a.md'), '被本地改过\n')
      expect(await computeSkillContentHash(join(root, 'demo-skill'))).not.toBe(prov?.archiveChecksum)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('打包时排除 .picoaide/,避免重新上传被服务端判为伪造归属', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-prov-'))
    try {
      await installSkillArchive({ name: 'demo-skill', archive: makeArchive('demo-skill'), skillsDir: root, version: '1.2.0' })
      const packed = await packSkill(root, 'demo-skill')
      const names = new AdmZip(packed.archive).getEntries().map((e) => e.entryName)
      expect(names.some((n) => n.startsWith('.picoaide'))).toBe(false)
      expect(names).toContain('SKILL.md')
      // 版本仍取自包内 frontmatter。
      expect(packed.version).toBe('1.2.0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 独立审计 2026-09-23 A1 / A2 / A3 / A7 / A8 / A12 / A13 + 跨泳道契约 S2 的回归
// ---------------------------------------------------------------------------

/** Frontmatter with an arbitrary `name` (used by the loadability gate matrix). */
function skillMdWith(name: string, extra = ''): string {
  return `---\nname: ${name}\n${extra}description: demo skill body\n---\n# body\n`
}

/** 造一个"能力中心装的"技能目录（带溯源标记）。 */
async function makeStoreSkill(root: string, name: string, channel: 'market' | 'org' | 'builtin' | 'plugin' = 'market'): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillMdWith(name, 'version: 1.0.0\n'))
  await writeProvenance(dir, { appId: name, version: '1.0.0', channel, server: STORE_SERVER, installedAt: new Date().toISOString() })
  return dir
}

describe('A1 安装期"可加载性"门禁（装得上就必须加载得到）', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pico-a1-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('名字规则与 pinned 上游 isSkillName 逐字一致（运行时规则单一真源）', async () => {
    const upstream = await import('@deepseek-ai/dsh-skill')
    const matrix = [
      'a', 'a1', 'alpha-skill', 'skill-v2', 'con',
      'my.skill', 'my_skill', 'alpha--beta', 'skill-', '-lead', 'A', 'a/b', '', 'a..b', 'a.', 'ünïcode', 'a b', '.hidden',
    ]
    for (const name of matrix) {
      expect(isLoadableSkillName(name), `name=${JSON.stringify(name)}`).toBe(upstream.isSkillName(name))
    }
    // 长度上限是我们额外加的（上游正则不限长），只对超长名断言"我们更严"。
    const long = 'x'.repeat(65)
    expect(upstream.isSkillName(long)).toBe(true)
    expect(isLoadableSkillName(long)).toBe(false)
  })

  it('缺 description / frontmatter 非法 / name 与技能 ID 不一致 ⇒ 拒绝安装（附人话原因）', async () => {
    const cases: Array<{ label: string, files: Record<string, string> }> = [
      // 注意：完全没有 frontmatter **不是**拒绝项 —— 旧网关格式靠 metadata.yaml/技能 ID
      // 合成（见 synthesizeSkillFrontmatter 的用例），只有"有 frontmatter 但不可加载"才拒。
      { label: 'missing-description', files: { 'SKILL.md': '---\nname: gated\n---\n# body\n' } },
      { label: 'dotted-name', files: { 'SKILL.md': skillMdWith('my.skill') } },
      { label: 'underscore-name', files: { 'SKILL.md': skillMdWith('my_skill') } },
      { label: 'name-mismatch', files: { 'SKILL.md': skillMdWith('other-skill') } },
      { label: 'broken-yaml', files: { 'SKILL.md': '---\nname: [unclosed\n---\n# body\n' } },
    ]
    for (const c of cases) {
      const archive = await makeArchive(c.files)
      await expect(
        installSkillArchive({ name: 'gated', archive, skillsDir: root }),
        c.label,
      ).rejects.toThrow(/frontmatter|not a loadable skill name|must equal the skill id/u)
      // 拒绝必须 fail-loud 且**不留任何落盘**（含 staging）。
      expect(await listInstalledSkills(root), c.label).toEqual([])
    }
    // 除 per-name 锁的私有区（`.skill-locks`）之外不留任何落盘（含 staging）。
    expect((await readdir(root)).filter(name => name !== SKILL_LOCK_DIR)).toEqual([])
    expect(await readdir(join(root, SKILL_LOCK_DIR)).catch(() => []), '拒绝安装不得留下锁').toEqual([])
  })

  it('frontmatter 完整且 name == 技能 ID ⇒ 安装成功（对照组）', async () => {
    const archive = await makeArchive({ 'SKILL.md': skillMdWith('gated', 'version: 1.0.0\n') })
    await expect(installSkillArchive({ name: 'gated', archive, skillsDir: root })).resolves.toMatchObject({ name: 'gated' })
    expect(await listInstalledSkills(root)).toEqual(['gated'])
  })

  it('metadata.yaml 的展示名不再顶替 frontmatter name（进 title）', async () => {
    const archive = await makeArchive({
      'SKILL.md': '# body\n',
      'metadata.yaml': 'name: "Epsilon 技能"\nversion: 1.0.0\n',
    })
    await installSkillArchive({ name: 'epsilon-skill', archive, skillsDir: root })
    const md = await readFile(join(root, 'epsilon-skill', 'SKILL.md'), 'utf8')
    expect(md).toContain('name: epsilon-skill')
    expect(md).toContain('title: Epsilon 技能')
  })
})

describe('A2/A3 覆盖与删除按 provenance 判定（本机自制内容必须显式确认）', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pico-a23-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('安装到同名本机自制目录 ⇒ 无 overwrite 一律拒绝，且用户内容一字不动', async () => {
    await mkdir(join(root, 'mine'), { recursive: true })
    await writeFile(join(root, 'mine', 'SKILL.md'), skillMdWith('mine'))
    await writeFile(join(root, 'mine', 'notes.md'), 'my own notes\n')
    const archive = await makeArchive({ 'SKILL.md': skillMdWith('mine', 'version: 1.0.0\n') })
    await expect(installSkillArchive({ name: 'mine', archive, skillsDir: root })).rejects.toThrow(/not installed by the Capability Hub/u)
    expect(await readFile(join(root, 'mine', 'notes.md'), 'utf8')).toBe('my own notes\n')
    // 用户确认后才整树替换（用户文件按设计消失，但这一次是用户点过确认的）。
    await expect(installSkillArchive({ name: 'mine', archive, skillsDir: root, overwrite: true })).resolves.toMatchObject({ name: 'mine' })
    await expect(readFile(join(root, 'mine', 'notes.md'), 'utf8')).rejects.toThrow()
    expect((await readProvenance(join(root, 'mine')))?.channel).toBe('market')
  })

  it('同名但 provenance.appId 对不上（目录被改名/被占用）⇒ 同样按自制内容处理', async () => {
    const dir = await makeStoreSkill(root, 'squatter')
    await writeProvenance(dir, { appId: 'someone-else', version: '1.0.0', channel: 'market', server: STORE_SERVER, installedAt: '' })
    const archive = await makeArchive({ 'SKILL.md': skillMdWith('squatter', 'version: 2.0.0\n') })
    await expect(installSkillArchive({ name: 'squatter', archive, skillsDir: root })).rejects.toThrow(/not installed by the Capability Hub/u)
  })

  it('商店来源、同渠道更新不需要确认即可更新；卸载同样不需要确认', async () => {
    for (const channel of ['market', 'org', 'builtin', 'plugin'] as const) {
      await makeStoreSkill(root, `store-${channel}`, channel)
      const archive = await makeArchive({ 'SKILL.md': skillMdWith(`store-${channel}`, 'version: 2.0.0\n') })
      await expect(
        installSkillArchive({ name: `store-${channel}`, archive, skillsDir: root, version: '2.0.0', channel, server: STORE_SERVER }),
        channel,
      ).resolves.toMatchObject({ name: `store-${channel}` })
      await expect(uninstallSkill(root, `store-${channel}`, { serverURL: STORE_SERVER }), channel).resolves.toBe(join(root, `store-${channel}`))
    }
    expect(await listInstalledSkills(root)).toEqual([])
  })

  /**
   * W4 P1-2（2026-09-23）：同一目录的 provenance 渠道发生变化时（market ↔ plugin
   * 等）必须有显式确认 —— 旧实现把 `plugin` 也算进"商店来源 ⇒ 无需确认"，于是市场里
   * 点一次「安装」就静默吃掉随包插件同步进来的同名技能，而插件下次开机会把内容换回去
   * （内容与徽章归属错位，`dirty` 还会翻真）。
   */
  it('跨渠道覆盖（市场 × 随包插件技能）无 overwrite 一律拒绝，内容与溯源一字不动', async () => {
    const dir = await makeStoreSkill(root, 'memory-consolidate', 'plugin')
    const skillBefore = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const provenanceBefore = await readFile(join(dir, '.picoaide', 'release.json'), 'utf8')
    await writeFile(join(dir, 'extra-notes.md'), 'vendor-owned extra\n')

    const archive = await makeArchive({ 'SKILL.md': skillMdWith('memory-consolidate', 'version: 3.0.0\n') })
    await expect(
      installSkillArchive({ name: 'memory-consolidate', archive, skillsDir: root, version: '3.0.0' }),
    ).rejects.toThrow(/another channel/u)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(skillBefore)
    expect(await readFile(join(dir, '.picoaide', 'release.json'), 'utf8')).toBe(provenanceBefore)
    expect(await readFile(join(dir, 'extra-notes.md'), 'utf8')).toBe('vendor-owned extra\n')

    // 用户确认后才真的换渠道：内容换成市场版，溯源也必须跟着变成 market（内容与归属一致）。
    await expect(
      installSkillArchive({ name: 'memory-consolidate', archive, skillsDir: root, version: '3.0.0', overwrite: true }),
    ).resolves.toMatchObject({ name: 'memory-consolidate' })
    const prov = await readProvenance(dir)
    expect(prov?.channel).toBe('market')
    expect(prov?.version).toBe('3.0.0')
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toMatch(/version: 3\.0\.0/u)
  })

  it('跨渠道与"用户自制"是两条判据：无 provenance 的目标仍按自制内容拒绝（互不掩盖）', async () => {
    await mkdir(join(root, 'hand-written'), { recursive: true })
    await writeFile(join(root, 'hand-written', 'SKILL.md'), skillMdWith('hand-written'))
    const archive = await makeArchive({ 'SKILL.md': skillMdWith('hand-written', 'version: 1.0.0\n') })
    await expect(
      installSkillArchive({ name: 'hand-written', archive, skillsDir: root, channel: 'builtin' }),
    ).rejects.toThrow(/not installed by the Capability Hub/u)
    // 反向：同渠道覆盖（builtin 装到 builtin 上）不需要确认。
    const dir = await makeStoreSkill(root, 'from-builtin', 'builtin')
    const same = await makeArchive({ 'SKILL.md': skillMdWith('from-builtin', 'version: 2.0.0\n') })
    await expect(
      installSkillArchive({ name: 'from-builtin', archive: same, skillsDir: root, version: '2.0.0', channel: 'builtin', server: STORE_SERVER }),
    ).resolves.toMatchObject({ name: 'from-builtin' })
    expect((await readProvenance(dir))?.channel).toBe('builtin')
  })

  it('readProvenance 把 plugin 原样返回（不回落成 market，跨泳道契约 S2）', async () => {
    const dir = await makeStoreSkill(root, 'bundled-skill', 'plugin')
    expect((await readProvenance(dir))?.channel).toBe('plugin')
    expect(await classifyInstalledSkill(dir, 'bundled-skill')).toBe('store')
    // 未知渠道不回落成 market：按"非商店来源"处理。
    await writeProvenance(dir, { appId: 'bundled-skill', version: '1.0.0', channel: 'unknown-channel', installedAt: '' })
    expect((await readProvenance(dir))?.channel).toBe('unknown-channel')
    expect(await classifyInstalledSkill(dir, 'bundled-skill')).toBe('local')
  })
})

describe('A7 并发与残留目录（备份目录不再污染技能库）', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pico-a7-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('staging 残留在 .skill-tmp 之下：listInstalledSkills 与运行时都看不到它们', async () => {
    // 模拟"换入被打断"：备份目录里有完整 SKILL.md（旧实现会把它当技能加载）。
    await mkdir(join(root, '.skill-tmp', 'install-abc123', 'backup'), { recursive: true })
    await writeFile(join(root, '.skill-tmp', 'install-abc123', 'backup', 'SKILL.md'), skillMdWith('ghost'))
    // 旧布局的 staging（≤2.8.1）：`.install-*` 里的是**第二层**（unpacked/），
    // 直接子条目上并没有 SKILL.md ⇒ 运行时也看不见。
    await mkdir(join(root, '.install-ghost-def456', 'unpacked'), { recursive: true })
    await writeFile(join(root, '.install-ghost-def456', 'unpacked', 'SKILL.md'), skillMdWith('ghost'))
    expect(await listInstalledSkills(root)).toEqual([])
  })

  it('旧布局的 `.<name>.backup-<pid>-<ts>` 在直接子目录层级 ⇒ 两侧都必须看得见（R13-B P1-2）', async () => {
    // 这条断言是**反向**的：此前这里写的是 `toEqual([])`，而那正是被审的缺陷 ——
    // 备份目录是技能库的**直接子条目**、根上就有完整 SKILL.md、frontmatter 名与真目录
    // 相同，而点号按 `localeCompare` 排在前面 ⇒ pinned 上游**会加载它、并且它赢**。
    // "已安装集合"必须与运行时同源 ⇒ 期望它**出现**；清除由
    // `sweepInstallerOwnedShadowSkills`（安装/卸载收口）负责。
    await mkdir(join(root, '.ghost.backup-123-456'), { recursive: true })
    await writeFile(join(root, '.ghost.backup-123-456', 'SKILL.md'), skillMdWith('ghost'))
    expect(await listInstalledSkills(root)).toEqual(['ghost'])
    const leftovers = await listShadowingSkills(root, 'ghost')
    expect(leftovers.map(row => row.entryName)).toEqual(['.ghost.backup-123-456'])
    expect(leftovers[0]?.installerOwned, '安装器自己写下的形态可以无确认清除').toBe(true)
    expect(await sweepInstallerOwnedShadowSkills(root, 'ghost')).toHaveLength(1)
    expect(await listInstalledSkills(root)).toEqual([])
  })

  it('源码判据：staging 与备份都在 .skill-tmp 之下，备份名不再以技能名开头（A7 的原始形态）', () => {
    // 为什么这条必须读源码：备份目录一旦是技能库的**直接子目录**（旧形态
    // `<skills>/.<name>.backup-<pid>-<ts>`），唯一能观测到它的消费者是上游运行时
    // `skill-filesystem`（本包的用例驱动不到它）；而"它在直接子目录层级"这件事
    // 正是 p13 探针实测出"卸载后技能仍然可用"的根因。位置契约在这里钉死。
    const source = readFileSync(fileURLToPath(new URL('../src/skill-install.ts', import.meta.url)), 'utf8')
    expect(source).toContain("const staging = await mkdtemp(join(tempRoot, 'install-'))")
    // R19A-S2-02（2026-09-26）：临时区不再直接用字符串路径拼（`.skill-tmp` 是库外链接/
    // junction/挂载点时 staging 会被建到**库外**），而是走**过闸**的唯一入口 —— 位置契约
    // 的方向不变（仍是 `.skill-tmp` 的第二层），只是"从哪拿 tempRoot"收口到一处。
    expect(source).toContain('const tempRoot = await ensureLibraryTempRoot(skillsDir)')
    expect(source).toContain('anchorLibraryPath(skillsDir, SKILL_TEMP_DIR')
    // R17B-03 更新了这一条位置契约（方向不变、更严）：备份仍在 `.skill-tmp` 的第二层
    // （运行时看不见），但**不再放在 staging 之内** —— 旧形态 `<staging>/backup` 的
    // 祖先是 `install-*`，进程死在两处 `rename` 之间时"旧内容的唯一副本"落在 24h
    // 清扫面内被无日志删除。现在落点是 `.skill-tmp/backup-<name>-<ts>`：清扫器只删
    // `install-*`，它天然免疫，由 recoverInterruptedSkillSwaps 放回落点（行为判据见
    // `audit-r17z-skill-library.spec.ts` 的崩溃自愈用例）。
    expect(source).toContain('`${BACKUP_PREFIX}${name}-${Date.now()}`')
    expect(source).not.toContain("const backupDir = join(staging, 'backup')")
    // 旧形态（备份是技能库直接子目录、名字以技能名开头）不得回来。
    expect(source).not.toMatch(/join\(skillsDir, `?\.\$\{name\}\.backup-/u)
  })

  it('卸载后立刻 list 不再出现该技能（含同名备份残留）', async () => {
    await makeStoreSkill(root, 'zeta-skill')
    // 卸载期间留下的备份残留（同名、含真 frontmatter）。
    await mkdir(join(root, '.skill-tmp', 'install-x', 'backup'), { recursive: true })
    await writeFile(join(root, '.skill-tmp', 'install-x', 'backup', 'SKILL.md'), skillMdWith('zeta-skill'))
    await uninstallSkill(root, 'zeta-skill', { serverURL: STORE_SERVER })
    expect(await listInstalledSkills(root)).toEqual([])
    // 备份残留仍在磁盘上（由清扫器按年龄处理），但**任何**列表/发现都不得把它算成技能。
    expect(await listLocalSkills(root)).toEqual([])
  })

  it('并发 install + uninstall 被 per-name 锁串行化：最后一次操作说了算，且无孤儿备份', async () => {
    const archive = await makeArchive({ 'SKILL.md': skillMdWith('race-skill', 'version: 2.0.0\n') })
    await makeStoreSkill(root, 'race-skill')
    const [installed, uninstalled] = await Promise.all([
      installSkillArchive({ name: 'race-skill', archive, skillsDir: root, version: '2.0.0', server: STORE_SERVER }),
      uninstallSkill(root, 'race-skill', { serverURL: STORE_SERVER }),
    ])
    expect(installed.name).toBe('race-skill')
    expect(uninstalled).toBe(join(root, 'race-skill'))
    // 调用顺序 = 锁获取顺序 ⇒ 后到的卸载是最终态（旧实现会"两边都成功但技能还在"）。
    expect(await listInstalledSkills(root)).toEqual([])
    // 技能库里除 .skill-tmp（安装器私有区）与 .skill-locks（per-name 锁落点）之外
    // 不得留下任何东西；两者都必须是空的（没有 staging/备份/锁残留）。
    expect(await readdir(join(root, SKILL_LOCK_DIR)).catch(() => []), '并发 install/uninstall 后不得留下锁').toEqual([])
    const leftovers = (await readdir(root)).filter(name => name !== '.skill-tmp' && name !== SKILL_LOCK_DIR)
    expect(leftovers).toEqual([])
  })

  it('sweepStaleSkillTemps 清陈旧暂存、留新鲜的、永不碰 orphan-*', async () => {
    const stale = join(root, '.skill-tmp', 'install-stale')
    const fresh = join(root, '.skill-tmp', 'install-fresh')
    const orphan = join(root, '.skill-tmp', 'orphan-123-keepme')
    for (const dir of [stale, fresh, orphan]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), skillMdWith('x'))
    }
    // 把 stale 的 mtime 拨到 3 天前。
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    const legacy = join(root, '.install-legacy-abc')
    await mkdir(legacy, { recursive: true })
    await utimes(legacy, old, old)
    expect(await sweepStaleSkillTemps(root)).toBe(2)
    expect(await readdir(join(root, '.skill-tmp'))).toEqual(['install-fresh', 'orphan-123-keepme'])
    await expect(stat(legacy)).rejects.toThrow()
  })
})

describe('A8 tar 通道与 zip 通道权限口径一致（剥掉 setuid/setgid/sticky）', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pico-a8-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('归档里的 0o4755 / 0o2755 / 0o1777 落盘后不含 0o7000 位（两条通道同判据）', async () => {
    // tar：真实文件带 setuid/setgid/sticky 位 → tar.c 记录进头。
    const src = await mkdtemp(join(tmpdir(), 'pico-a8-src-'))
    try {
      await writeFile(join(src, 'SKILL.md'), skillMdWith('mode-skill', 'version: 1.0.0\n'))
      await writeFile(join(src, 'suid.sh'), '#!/bin/sh\necho hi\n', { mode: 0o4755 })
      await writeFile(join(src, 'sgid.sh'), '#!/bin/sh\necho hi\n', { mode: 0o2755 })
      await writeFile(join(src, 'sticky.sh'), '#!/bin/sh\necho hi\n', { mode: 0o1777 })
      const archive = await packDir(src)
      await installSkillArchive({ name: 'mode-skill', archive, skillsDir: root })
      for (const file of ['suid.sh', 'sgid.sh', 'sticky.sh']) {
        const st = await stat(join(root, 'mode-skill', file))
        expect(st.mode & 0o7000, `${file} mode=${st.mode.toString(8)}`).toBe(0)
      }
      // 可执行位必须保留（0o4755 → 0o755，不是 0o644）。
      expect((await stat(join(root, 'mode-skill', 'suid.sh'))).mode & 0o111).not.toBe(0)
    } finally {
      await rm(src, { recursive: true, force: true })
    }

    // zip：同一位在 external attr 里（zip 通道本来就有 & 0o777 掩码，这里对拍防漂移）。
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from(skillMdWith('zip-mode-skill', 'version: 1.0.0\n')), '', 0o644)
    zip.addFile('suid.sh', Buffer.from('#!/bin/sh\n'), '', 0o4755)
    await installSkillArchive({ name: 'zip-mode-skill', archive: zip.toBuffer(), skillsDir: root })
    expect((await stat(join(root, 'zip-mode-skill', 'suid.sh'))).mode & 0o7000).toBe(0)
  })
})

describe('A12 失败文案脱敏 + 陈旧 staging 清扫', () => {
  it('sanitizeArchiveErrorText 去掉本机路径、保留 errno 与原因', () => {
    const raw = "ENOTEMPTY: directory not empty, rename '/home/user/.picoaide-harness/skills/.install-x/unpacked' -> '/home/user/.picoaide-harness/skills/zeta'"
    const clean = sanitizeArchiveErrorText(raw)
    expect(clean).toBe('ENOTEMPTY: target directory not empty (a concurrent install/uninstall may be running)')
    expect(clean).not.toContain('/home')
    // 未知 errno / 无 errno 的文案：整体脱敏，路径只剩 basename。
    const other = sanitizeArchiveErrorText("EACCES: permission denied, open '/root/secret/skills/a/SKILL.md'")
    expect(other).toBe('EACCES: permission denied')
    const weird = sanitizeArchiveErrorText("boom at '/tmp/one/two/three.txt' and C:\\Users\\me\\x.txt")
    expect(weird).not.toContain('/tmp/one')
    expect(weird).not.toContain('C:\\Users')
    expect(weird).toContain('three.txt')
  })

  it('describeArchiveFailure 把失败映射成稳定状态码（409/422/404/413/502）', () => {
    expect(describeArchiveFailure(new ArchiveInstallRefusal('LOCAL_CONTENT', 'x'))).toMatchObject({ status: 409, code: 'LOCAL_CONTENT', refusal: true })
    expect(describeArchiveFailure(new ArchiveInstallRefusal('NOT_INSTALLED', 'x'))).toMatchObject({ status: 404, code: 'NOT_INSTALLED' })
    expect(describeArchiveFailure(new ArchiveInstallRefusal('ARCHIVE_TOO_LARGE', 'x'))).toMatchObject({ status: 413 })
    expect(describeArchiveFailure(new ArchiveInstallRefusal('CHECKSUM_MISMATCH', 'archive checksum mismatch; refused'))).toMatchObject({ status: 422 })
    // archive-util 的普通 Error 也是拒绝（关键词兜底），不是上游 502。
    expect(describeArchiveFailure(new Error('parent traversal in archive: ../evil'))).toMatchObject({ status: 422, refusal: true })
    const system = describeArchiveFailure(new Error("EACCES: permission denied, mkdir '/home/u/.picoaide-harness/skills'"))
    expect(system).toMatchObject({ status: 502, refusal: false })
    expect(system.message).not.toContain('/home/u')
  })

  it('系统级失败的裸错误不把本机绝对路径透给 UI（真实安装失败用例）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-a12-'))
    try {
      // skillsDir 指向一个**文件**：mkdir/mkdtemp 必然失败，错误里带本机路径。
      const asFile = join(root, 'not-a-dir')
      await writeFile(asFile, 'x')
      const archive = await makeArchive({ 'SKILL.md': skillMdWith('x', 'version: 1.0.0\n') })
      const cause = await installSkillArchive({ name: 'x', archive, skillsDir: asFile }).catch((e: unknown) => e)
      const described = describeArchiveFailure(cause)
      expect(described.status).toBe(502)
      expect(described.message).not.toContain(root)
      expect(described.message).not.toContain(asFile)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('安装入口顺手清掉陈旧的 .install-* 残留（SIGKILL 遗留）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-a12sweep-'))
    try {
      const stale = join(root, '.install-legacy-zzz')
      await mkdir(stale, { recursive: true })
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      await utimes(stale, old, old)
      const archive = await makeArchive({ 'SKILL.md': skillMdWith('fresh', 'version: 1.0.0\n') })
      await installSkillArchive({ name: 'fresh', archive, skillsDir: root })
      await expect(stat(stale)).rejects.toThrow()
      expect(await listInstalledSkills(root)).toEqual(['fresh'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('A13 安装器自有标记文件净化（打包与安装两端）', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pico-a13-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('packSkill 不再把 .install-version 打进上传包', async () => {
    // 手工造一个能过 packSkill 预检的目录（预检要求 title/author/category/正文长度）。
    const dir = join(root, 'packed-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), [
      '---',
      'name: packed-skill',
      'version: 1.0.0',
      'title: 打包用例',
      'description: 用于打包用例的技能描述,长度必须超过预检的下限要求。',
      'author: tester',
      'category: 测试',
      '---',
      '',
      '本技能只用于单元测试:正文需要足够长才能通过空壳校验,因此这里补充说明文字,确保长度稳稳超过五十字的下限要求,避免因为正文过短而被预检拒绝。',
      '',
    ].join('\n'))
    await writeFile(join(dir, '.install-version'), '1.0.0\n')
    const packed = await packSkill(root, 'packed-skill')
    const names = new AdmZip(packed.archive).getEntries().map(e => e.entryName)
    expect(names).toContain('SKILL.md')
    expect(names).not.toContain('.install-version')
    expect(names.some(n => n.startsWith('.picoaide'))).toBe(false)
  })

  it('归档自带的 .install-version / .picoaide 会被安装器丢弃（不能伪造版本与来源）', async () => {
    const archive = await makeArchive({
      'SKILL.md': skillMdWith('forged-skill', 'version: 1.0.0\n'),
      '.install-version': '9.9.9',
      '.picoaide/release.json': JSON.stringify({ appId: 'forged-skill', version: '9.9.9', channel: 'builtin', installedAt: '' }),
    })
    // 服务端没给版本头（x-skill-version 缺失是可能状态，见 A11 调查）。
    await installSkillArchive({ name: 'forged-skill', archive, skillsDir: root, channel: 'market' })
    await expect(readFile(join(root, 'forged-skill', '.install-version'), 'utf8')).rejects.toThrow()
    const prov = await readProvenance(join(root, 'forged-skill'))
    expect(prov?.channel).toBe('market')
    expect(prov?.version).toBe('')
  })
})

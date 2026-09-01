import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import AdmZip from 'adm-zip'
import {
  computeSkillContentHash,
  installSkillArchive,
  listInstalledSkills,
  packSkill,
  readProvenance,
  resolveSkillsDir,
  SKILL_NAME_PATTERN,
  synthesizeSkillFrontmatter,
  uninstallSkill,
  validateSkillName,
} from '../src/skill-install.ts'
import { MAX_ARCHIVE_BYTES } from '../src/archive-util.ts'

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
    expect(SKILL_NAME_PATTERN.test('skill.v2_3')).toBe(true)
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
      // metadata.yaml supplies name: demo; description falls back.
      expect(installedMd).toMatch(/^---\nname: demo\ndescription: demo-skill skill(\nversion: 1\.0\.0)?\n---\n# Demo Skill/)
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
      await installSkillArchive({ name: 'demo', archive: v1, skillsDir })
      expect(await readFile(join(skillsDir, 'demo', 'SKILL.md'), 'utf8')).toContain('v1')
      const v2 = await makeArchive({ 'SKILL.md': '# v2\n', 'extra.txt': 'x' })
      await installSkillArchive({ name: 'demo', archive: v2, skillsDir })
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
  it('removes an installed skill directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-skill-root-'))
    try {
      await mkdir(join(root, 'alpha'), { recursive: true })
      await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: demo\n---\n# a\n')
      await expect(uninstallSkill(root, 'alpha')).resolves.toBe(join(root, 'alpha'))
      await expect(readFile(join(root, 'alpha', 'SKILL.md'), 'utf8')).rejects.toThrow()
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

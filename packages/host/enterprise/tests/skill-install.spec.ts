import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import {
  installSkillArchive,
  listInstalledSkills,
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

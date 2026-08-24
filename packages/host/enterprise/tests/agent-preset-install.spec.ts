import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import {
  installPresetArchive,
  listInstalledPresets,
  mapLocalPresets,
  packPreset,
  uninstallPreset,
  validatePresetId,
} from '../src/agent-preset-install.ts'

const COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: hi
`

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
  const dir = await mkdtemp(join(tmpdir(), 'pico-preset-archive-'))
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

async function newPresetsDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'pico-presets-'))
}

describe('validatePresetId', () => {
  it('accepts upstream-compatible ids', () => {
    expect(validatePresetId('coding-agent')).toBe('coding-agent')
    expect(validatePresetId('v1')).toBe('v1')
  })

  it('rejects unsafe ids', () => {
    for (const bad of ['', 'Caps', 'a/b', '../x', '_x', 'a b']) {
      expect(() => validatePresetId(bad)).toThrow()
    }
  })
})

describe('packPreset', () => {
  it('packs a preset directory and reads preset.yml metadata', async () => {
    const dir = await newPresetsDir()
    try {
      const presetDir = join(dir, 'ppt-gen')
      await mkdir(presetDir, { recursive: true })
      await writeFile(join(presetDir, 'agent.cordis.yml'), COMPOSITION)
      await writeFile(join(presetDir, 'preset.yml'), 'name: PPT 生成\ndescription: 生成 PPT 演示文稿\n')
      const result = await packPreset(dir, 'ppt-gen')
      expect(result.name).toBe('ppt-gen')
      expect(result.displayName).toBe('PPT 生成')
      expect(result.description).toBe('生成 PPT 演示文稿')
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/u)
      // The archive root carries the composition: install it into a scratch
      // root (the installer repeats the composition check).
      expect(result.archive.byteLength).toBeGreaterThan(0)
      const scratch = await newPresetsDir()
      try {
        await installPresetArchive({ name: 'ppt-gen', archive: result.archive, presetsDir: scratch })
        expect(await listInstalledPresets(scratch)).toEqual(['ppt-gen'])
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('packs the whole preset directory (skills/ and assets travel with it)', async () => {
    const dir = await newPresetsDir()
    try {
      const presetDir = join(dir, 'ppt-gen')
      await mkdir(join(presetDir, 'skills', 'demo'), { recursive: true })
      await mkdir(join(presetDir, 'assets'), { recursive: true })
      await writeFile(join(presetDir, 'agent.cordis.yml'), COMPOSITION)
      await writeFile(join(presetDir, 'preset.yml'), 'name: PPT 生成\n')
      await writeFile(join(presetDir, 'skills', 'demo', 'SKILL.md'), '# demo\n')
      await writeFile(join(presetDir, 'assets', 'note.txt'), 'hello')
      const result = await packPreset(dir, 'ppt-gen')
      // Round-trip through the installer: the whole tree must be reproduced,
      // because a preset may reference its own skills/ root.
      const scratch = await newPresetsDir()
      try {
        await installPresetArchive({ name: 'ppt-gen', archive: result.archive, presetsDir: scratch })
        const installed = await readdir(join(scratch, 'ppt-gen'))
        expect(installed.sort()).toEqual(['agent.cordis.yml', 'assets', 'preset.yml', 'skills'])
        expect((await readFile(join(scratch, 'ppt-gen', 'skills', 'demo', 'SKILL.md'), 'utf8')).trim()).toBe('# demo')
        expect(await readFile(join(scratch, 'ppt-gen', 'assets', 'note.txt'), 'utf8')).toBe('hello')
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a preset whose directory carries a symlink', async () => {
    const dir = await newPresetsDir()
    try {
      const presetDir = join(dir, 'linky')
      await mkdir(presetDir, { recursive: true })
      await writeFile(join(presetDir, 'agent.cordis.yml'), COMPOSITION)
      await symlink('/etc/passwd', join(presetDir, 'secret'))
      await expect(packPreset(dir, 'linky')).rejects.toThrow(/link entry refused/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a preset directory without a composition', async () => {
    const dir = await newPresetsDir()
    try {
      await mkdir(join(dir, 'no-comp'), { recursive: true })
      await writeFile(join(dir, 'no-comp', 'preset.yml'), 'name: x\n')
      await expect(packPreset(dir, 'no-comp')).rejects.toThrow(/agent\.cordis\.yml/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a missing preset directory', async () => {
    const dir = await newPresetsDir()
    try {
      await expect(packPreset(dir, 'nope')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('installPresetArchive', () => {
  it('installs a valid archive and lists it', async () => {
    const dir = await newPresetsDir()
    try {
      const archive = await makeArchive({
        'agent.cordis.yml': COMPOSITION,
        'preset.yml': 'name: PPT 生成\n',
      })
      const result = await installPresetArchive({ name: 'ppt-gen', archive, presetsDir: dir })
      expect(result.targetDir).toBe(join(dir, 'ppt-gen'))
      expect(await listInstalledPresets(dir)).toEqual(['ppt-gen'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses an archive without a composition', async () => {
    const dir = await newPresetsDir()
    try {
      const archive = await makeArchive({ 'README.md': 'hi' })
      await expect(installPresetArchive({ name: 'no-comp', archive, presetsDir: dir }))
        .rejects.toThrow(/agent\.cordis\.yml/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a checksum mismatch', async () => {
    const dir = await newPresetsDir()
    try {
      const archive = await makeArchive({ 'agent.cordis.yml': COMPOSITION })
      await expect(installPresetArchive({
        name: 'bad-sum', archive, presetsDir: dir, checksum: '0'.repeat(64),
      })).rejects.toThrow(/checksum/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to overwrite an existing preset', async () => {
    const dir = await newPresetsDir()
    try {
      const archive = await makeArchive({ 'agent.cordis.yml': COMPOSITION })
      await installPresetArchive({ name: 'dup', archive, presetsDir: dir })
      await expect(installPresetArchive({ name: 'dup', archive, presetsDir: dir })).rejects.toThrow(/already exists/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a traversal entry', async () => {
    const dir = await newPresetsDir()
    // Pack a file from OUTSIDE the cwd: tar.c records the entry path as the
    // archive's relative path — a `../escape` entry is what the installer's
    // pass-1 scan must refuse.
    const outside = await mkdtemp(join(tmpdir(), 'pico-preset-outside-'))
    await writeFile(join(outside, 'escape.txt'), 'x')
    const archive: Buffer = await new Promise((resolveP, rejectP) => {
      const chunks: Buffer[] = []
      const stream = tar.c({ gzip: true, portable: true }, [join(outside, 'escape.txt')])
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('error', rejectP)
      stream.on('end', () => resolveP(Buffer.concat(chunks)))
    })
    try {
      await expect(installPresetArchive({ name: 'traversal', archive, presetsDir: dir }))
        .rejects.toThrow()
    } finally {
      await rm(outside, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('uninstallPreset', () => {
  it('removes an installed preset and refuses a missing one', async () => {
    const dir = await newPresetsDir()
    try {
      const archive = await makeArchive({ 'agent.cordis.yml': COMPOSITION })
      await installPresetArchive({ name: 'gone', archive, presetsDir: dir })
      expect(await uninstallPreset(dir, 'gone')).toBe(join(dir, 'gone'))
      await expect(uninstallPreset(dir, 'gone')).rejects.toThrow(/not installed/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('mapLocalPresets', () => {
  it('merges local disk presets with gateway upload state', async () => {
    const dir = await newPresetsDir()
    try {
      const a = join(dir, 'fruit-new-arrival')
      const b = join(dir, 'local-only')
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      await writeFile(join(a, 'agent.cordis.yml'), COMPOSITION)
      await writeFile(join(a, 'preset.yml'), 'name: 水果新到\n')
      await writeFile(join(b, 'agent.cordis.yml'), COMPOSITION)
      const map = await mapLocalPresets(dir, [
        { name: 'fruit-new-arrival', status: 'pending' },
      ])
      expect(map['fruit-new-arrival']).toMatchObject({ name: 'fruit-new-arrival', displayName: '水果新到', status: 'pending' })
      expect(map['local-only']).toMatchObject({ name: 'local-only' })
      expect(map['local-only'].status).toBeUndefined()
      expect(Object.keys(map).length).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

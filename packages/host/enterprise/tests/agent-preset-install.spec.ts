import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'
import { parse as parseYaml } from 'yaml'
import {
  installPresetArchive,
  listInstalledPresets,
  mapLocalPresets,
  packPreset,
  uninstallPreset,
  validatePresetId,
} from '../src/agent-preset-install.ts'
import { ArchiveInstallRefusal, readProvenance } from '../src/skill-install.ts'

const COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: hi
`

/**
 * Load the rc2 `@deepseek-ai/dsh-persona` Config schema.
 *
 * Installed presets are mounted by the desktop profile, so the schema that
 * judges a composition is the persona package installed for that profile's
 * resolution root. It is reached through the `dsh-plugin-desktop` devDependency
 * that is already declared here rather than through a dependency of this
 * package: nothing in this package imports the row at runtime, and a new
 * dependency edge would need a lockfile update.
 *
 * 解析路径必须走**真正声明它的包**：persona 不是任何 bundle 的 row
 * （各 bundle 的 `cordis.patch.yml` 零命中），它只是 `@deepseek-ai/dsh`
 * 自己的依赖。0.1.6-alpha.2 起 `nmHoistingLimits: workspaces` 把它放在
 * `@deepseek-ai/dsh/node_modules/` 下而不是桌面包顶层，因此按桌面包解析会
 * "Cannot find module '@deepseek-ai/dsh-persona'"（2026-09-20 升级实测）。
 * 跟随依赖边解析，与提升布局无关。
 * @returns the Config validator (throws when a row omits `prefix`).
 */
async function loadPersonaConfig(): Promise<(input: Record<string, unknown>) => { prefix: string }> {
  const desktopManifest = createRequire(import.meta.url).resolve('dsh-plugin-desktop/package.json')
  const fromDesktop = createRequire(desktopManifest)
  const umbrellaManifest = fromDesktop.resolve('@deepseek-ai/dsh/package.json')
  const persona = await import(pathToFileURL(createRequire(umbrellaManifest).resolve('@deepseek-ai/dsh-persona')).href) as {
    Config: (input: Record<string, unknown>) => { prefix: string }
  }
  return persona.Config
}

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
      // 新格式为 zip(PK 魔数)。
      expect(result.archive.subarray(0, 2).toString('latin1')).toBe('PK')
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
        // .picoaide 是安装器写入的溯源标记(与技能同构),不属于包内容。
        expect(installed.sort()).toEqual(['.picoaide', 'agent.cordis.yml', 'assets', 'preset.yml', 'skills'])
        const prov = JSON.parse(await readFile(join(scratch, 'ppt-gen', '.picoaide', 'release.json'), 'utf8')) as { appId: string, channel: string }
        expect(prov.appId).toBe('ppt-gen')
        expect(prov.channel).toBe('org')
        // 重新打包时溯源目录必须被排除,否则再次上传会被判为伪造归属。
        const repacked = await packPreset(scratch, 'ppt-gen')
        const AdmZipCtor = (await import('adm-zip')).default
        const names = new AdmZipCtor(repacked.archive).getEntries().map((e) => e.entryName)
        expect(names.some((n) => n.startsWith('.picoaide'))).toBe(false)
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
      await expect(packPreset(dir, 'linky')).rejects.toThrow(/link entry refused|symlink refused/u)
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

  it('truncates display metadata to the gateway bound (500 chars)', async () => {
    const dir = await newPresetsDir()
    try {
      const presetDir = join(dir, 'long-meta')
      await mkdir(presetDir, { recursive: true })
      await writeFile(join(presetDir, 'agent.cordis.yml'), COMPOSITION)
      await writeFile(join(presetDir, 'preset.yml'), `name: ${'n'.repeat(600)}\ndescription: ${'x'.repeat(600)}\n`)
      const result = await packPreset(dir, 'long-meta')
      expect(result.displayName?.length).toBe(500)
      expect(result.description?.length).toBe(500)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('preset composition contract', () => {
  it('writes the persona keys the rc2 Config parses (prefix, not the rc1 text)', async () => {
    const Config = await loadPersonaConfig()
    const rows = parseYaml(COMPOSITION) as Array<{ id?: string, name?: string, config?: Record<string, unknown> }>
    const persona = rows.find(row => row.name === '@deepseek-ai/dsh-persona')
    if (persona?.config === undefined) {
      throw new Error('the fixture composition has no @deepseek-ai/dsh-persona row with a config')
    }

    // rc2 split the row's single `text` key into `prefix` (required) + `suffix`.
    // Nothing validates a row's config at pack or install time, so a composition
    // still carrying `text` installs cleanly and only fails when a session
    // mounts the preset; parsing it against the row's own schema is the earliest
    // gate this contract has.
    expect(Config(persona.config).prefix).toBe('hi')
    expect(() => Config({ text: 'hi' })).toThrow()
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

  /**
   * 审计 2026-09-23 **N2**：面板的「更新智能体」此前**必然失败** —— 安装器对已存在
   * 目录一律拒收（`preset "x" already exists locally`），而宿主又不读 `?overwrite=1`。
   * 现在与技能侧同口径（来源判定复用 `isStoreProvenance`）：
   *  - 能力中心装的那一份（磁盘上有 `.picoaide/release.json` 且渠道 ∈ 商店来源、
   *    appId == 目录名）⇒ 直接更新；
   *  - 本机自制 / 来源不明 ⇒ 没有 `overwrite: true` 一律拒收 `LOCAL_CONTENT`，
   *    且**磁盘一字未动**；显式确认后才整树替换。
   */
  it('N2：商店来源的已装预设可直接更新（面板「更新智能体」不再必然失败）', async () => {
    const dir = await newPresetsDir()
    try {
      const v1 = await makeArchive({ 'agent.cordis.yml': COMPOSITION, 'preset.yml': 'name: v1\n' })
      await installPresetArchive({ name: 'dup', archive: v1, presetsDir: dir, version: '1.0.0' })
      // 第一次安装写下的 provenance（channel 缺省 org + appId == name）⇒ 商店来源。
      expect((await readProvenance(join(dir, 'dup')))?.channel).toBe('org')

      const v2 = await makeArchive({ 'agent.cordis.yml': COMPOSITION, 'preset.yml': 'name: v2\n' })
      const updated = await installPresetArchive({ name: 'dup', archive: v2, presetsDir: dir, version: '2.0.0' })
      expect(updated.targetDir).toBe(join(dir, 'dup'))
      expect(await readFile(join(dir, 'dup', 'preset.yml'), 'utf8')).toBe('name: v2\n')
      expect((await readProvenance(join(dir, 'dup')))?.version).toBe('2.0.0')
      // 更新不留 staging / backup 残渣。
      expect((await readdir(dir)).filter(n => n.startsWith('.'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('N2：本机自制同名预设无确认 ⇒ 拒收且磁盘一字未动，带 overwrite 才替换', async () => {
    const dir = await newPresetsDir()
    try {
      // 用户自己写的预设：有 composition、**没有** provenance。
      const mine = join(dir, 'dup')
      await mkdir(mine, { recursive: true })
      await writeFile(join(mine, 'agent.cordis.yml'), COMPOSITION)
      await writeFile(join(mine, 'notes.md'), 'my own notes\n')

      const archive = await makeArchive({ 'agent.cordis.yml': COMPOSITION, 'preset.yml': 'name: store\n' })
      const refused = await installPresetArchive({ name: 'dup', archive, presetsDir: dir }).catch((cause: unknown) => cause)
      expect(refused).toBeInstanceOf(ArchiveInstallRefusal)
      expect((refused as ArchiveInstallRefusal).code).toBe('LOCAL_CONTENT')
      expect(await readFile(join(mine, 'notes.md'), 'utf8')).toBe('my own notes\n')
      // 拒绝时不留任何残留（staging 也被清掉）。
      expect((await readdir(dir)).filter(n => n.startsWith('.'))).toEqual([])

      await installPresetArchive({ name: 'dup', archive, presetsDir: dir, overwrite: true })
      await expect(readFile(join(mine, 'notes.md'), 'utf8')).rejects.toThrow()
      expect(await readFile(join(mine, 'preset.yml'), 'utf8')).toBe('name: store\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('N2：卸载同样来源感知（本机自制无确认 ⇒ 拒收；带 overwrite 才删）', async () => {
    const dir = await newPresetsDir()
    try {
      const mine = join(dir, 'mine')
      await mkdir(mine, { recursive: true })
      await writeFile(join(mine, 'agent.cordis.yml'), COMPOSITION)

      const refused = await uninstallPreset(dir, 'mine').catch((cause: unknown) => cause)
      expect(refused).toBeInstanceOf(ArchiveInstallRefusal)
      expect((refused as ArchiveInstallRefusal).code).toBe('LOCAL_CONTENT')
      expect(await listInstalledPresets(dir)).toEqual(['mine'])

      expect(await uninstallPreset(dir, 'mine', { overwrite: true })).toBe(mine)
      expect(await listInstalledPresets(dir)).toEqual([])
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
        { name: 'fruit-new-arrival', status: 'rejected', reason: '缺少 skills/' },
      ])
      expect(map['fruit-new-arrival']).toMatchObject({ name: 'fruit-new-arrival', displayName: '水果新到', status: 'rejected', reason: '缺少 skills/' })
      expect(map['local-only']).toMatchObject({ name: 'local-only' })
      expect(map['local-only'].status).toBeUndefined()
      expect(Object.keys(map).length).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

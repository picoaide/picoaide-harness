import { describe, expect, it } from 'vitest'
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPresetArchive, packPreset } from '../src/agent-preset-install.ts'

/** The pinned upstream 创造模式 preset: the real shape a user copy starts from. */
const CORDIS = fileURLToPath(new URL('../../../../deepseek-harness/apps/cli/config/agent-presets/cordis', import.meta.url))

describe('real 创造模式 preset round-trip', () => {
  it('ships skills/ with the composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'presets-real-'))
    const scratch = await mkdtemp(join(tmpdir(), 'presets-install-'))
    try {
      await cp(CORDIS, join(root, 'my-creator'), { recursive: true, dereference: true })
      const source = (await readdir(join(root, 'my-creator'))).sort()
      expect(source).toEqual(['agent.cordis.yml', 'preset.yml', 'skills'])

      const packed = await packPreset(root, 'my-creator')
      expect(packed.displayName).toBe('创造模式')
      await installPresetArchive({ name: 'my-creator', archive: packed.archive, checksum: packed.checksum, presetsDir: scratch })

      const installed = (await readdir(join(scratch, 'my-creator'))).sort()
      expect(installed).toEqual(['agent.cordis.yml', 'preset.yml', 'skills'])
      const skills = (await readdir(join(scratch, 'my-creator', 'skills'))).sort()
      expect(skills).toEqual(['cordis-plugin-development', 'editing-cordis-compositions'])
      await expect(stat(join(scratch, 'my-creator', 'skills', 'editing-cordis-compositions', 'SKILL.md'))).resolves.toBeDefined()
      // Size sanity: real preset is ~30KB packed, well under the 16MB bound.
      expect(packed.archive.byteLength).toBeLessThan(200 * 1024)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

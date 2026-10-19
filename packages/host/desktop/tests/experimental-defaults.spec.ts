import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')

const BUNDLES = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
]

describe('default experimental composition', () => {
  it('declares and composes every default experimental bundle', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    const profile = read('src/profile.ts')
    for (const name of BUNDLES) {
      expect(pkg.dependencies[name], `${name} dependency`).toBe('0.2.1-rc.2')
      expect(profile, `${name} profile layer`).toContain(`'${name}'`)
    }
  })

  it('disables legacy delegation tools in the default presets (Agent Teams owns them)', () => {
    for (const preset of ['standard', 'ptc', 'cordis']) {
      const yaml = read(`node_modules/@deepseek-ai/dsh-web-app/presets/${preset}.patch.yml`)
      for (const id of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork']) {
        expect(yaml, `${preset} is missing the disabled ${id} row`).toMatch(
          new RegExp(`- id: ${id}\\n\\s*name: [^\\n]+\\n\\s*disabled: true`),
        )
      }
    }
  })

  it('keeps the schedule owner-scoping patch markers in the installed package', () => {
    const source = read('node_modules/@deepseek-ai/dsh-schedule/lib/index.js')
    expect(source).toContain('function picoOwner(ctx)')
    expect(source).toContain('function ownerMatches(ctx, owner)')
    expect(source).toContain('owner: picoOwner(this.ctx)')
    expect(source).toContain('ownerMatches(this.ctx, task.owner)')
    expect(source).toContain('ownerMatches(this.ctx, current.owner)')
  })

  it('excludes the upstream DSH badge artwork/readmes from the packaged files', () => {
    const pkg = JSON.parse(read('package.json')) as { build: { files: string[] } }
    for (const pattern of [
      '!**/node_modules/@deepseek-ai/dsh-skill-badge/assets/dsh-badge.png',
      '!**/node_modules/@deepseek-ai/dsh-skill-badge/icon.svg',
      '!**/node_modules/@deepseek-ai/dsh-skill-badge/README*.md',
      '!**/node_modules/@deepseek-ai/dsh-experimental-badge-skill-bundle/icon.svg',
      '!**/node_modules/@deepseek-ai/dsh-experimental-badge-skill-bundle/README*.md',
    ]) {
      expect(pkg.build.files, pattern).toContain(pattern)
    }
  })
})

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const PATCHES = join(REPO, 'patches')
const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  resolutions?: Record<string, string>
}
const lock = readFileSync(join(REPO, 'yarn.lock'), 'utf8')

const MARKERS: Record<string, string> = {
  'app-builder-lib': 'async function importCerts',
  'dsh-client-ui-brand-official': 'Desktop-owned branding',
  'dsh-client-ui-sidebar-documentpreview': 'desktop host ships no LibreOffice engine',
  'dsh-experimental-badge-skill-bundle': '"title": "徽章技能"',
  'dsh-fs-local': 'statNanoseconds(info, "mtime")',
  'dsh-mcp-client': 'authProvider',
  'dsh-sandbox-windows-acl': 'Desktop patch (PicoAide Harness, 2026-09-17)',
  'dsh-schedule': 'function picoOwner',
  'dsh-skill-badge': 'FALLBACK_PRODUCT_NAME',
  'dsh-subprocess-local': 'ELECTRON_RUN_AS_NODE',
  'dsh-tool-ralph': 'Agent Teams teammates',
  'dsh-tool-workflow': 'spawn_teammate',
  'dsh-web-app': 'disabled: true',
  'dsh-web-fetch-http': 'ADDRESS_POLICY_ALLOWS_ALL = true',
}

function walkInstalled(dir: string, depth = 0, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      let scoped
      try { scoped = readdirSync(join(dir, entry.name), { withFileTypes: true }) } catch { continue }
      for (const child of scoped) if (child.isDirectory()) out.push(join(dir, entry.name, child.name))
    } else {
      out.push(join(dir, entry.name))
    }
    if (depth < 2) walkInstalled(join(dir, entry.name, 'node_modules'), depth + 1, out)
  }
  return out
}

function installedRoots(): string[] {
  const roots = [join(REPO, 'node_modules')]
  for (const group of readdirSync(join(REPO, 'packages'))) {
    for (const pkg of readdirSync(join(REPO, 'packages', group))) {
      roots.push(join(REPO, 'packages', group, pkg, 'node_modules'))
    }
  }
  return roots
}

function packageNameOf(short: string, version: string): string {
  for (const key of Object.keys(rootPkg.resolutions ?? {})) {
    if (!key.endsWith(`@npm:${version}`) && !key.endsWith(`@npm:^${version}`)) continue
    const name = key.slice(0, key.lastIndexOf('@npm:'))
    if (name === short || name.endsWith(`/${short}`)) return name
  }
  return short
}

const installedNames = [...new Set(walkInstalled(join(REPO, 'node_modules')))].length

describe('every Yarn patch is applied to every installed copy', () => {
  const files = readdirSync(PATCHES).filter(file => file.endsWith('.patch')).sort()
  const copies = installedRoots().flatMap(root => walkInstalled(root))
  const packages = copies.flatMap(dir => {
    try {
      return [{ dir, name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name as string }]
    } catch { return [] }
  })

  it('has a non-empty installed tree to check', () => {
    expect(installedNames).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} applies cleanly and has its intended effect`, () => {
      const base = file.slice(0, -'.patch'.length)
      const at = base.lastIndexOf('@')
      const short = base.slice(0, at)
      const version = base.slice(at + 1)
      const patchPath = join(PATCHES, file)
      const name = packageNameOf(short, version)

      // Resolution (exact + caret; app-builder-lib is the documented exact-only exemption).
      expect(rootPkg.resolutions?.[`${name}@npm:${version}`], `${name} exact resolution`).toBeDefined()
      if (name !== 'app-builder-lib') {
        expect(rootPkg.resolutions?.[`${name}@npm:^${version}`], `${name} caret resolution`).toBeDefined()
      }
      expect(lock, `${file} lock descriptor`).toContain(`#./patches/${file}`)

      const targets = packages.filter(pkg => pkg.name === name)
      expect(targets.length, `${name} installed copy`).toBeGreaterThan(0)

      const changedFiles = [...readFileSync(patchPath, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gmu)].flatMap(m => (m[1] === undefined ? [] : [m[1]]))
      const marker = MARKERS[short]
      expect(marker, `${file} marker registration`).toBeDefined()
      if (marker === undefined) throw new Error(`${file} marker registration`)
      const markerText: string = marker

      for (const target of targets) {
        // Reverse-applying means the installed bytes are exactly the patch result.
        expect(
          () => execFileSync('git', ['apply', '--reverse', '--check', patchPath], { cwd: target.dir, stdio: 'pipe' }),
          `${file} is not applied in ${target.dir}`,
        ).not.toThrow()
        const hit = changedFiles.some(rel => {
          try { return readFileSync(join(target.dir, rel), 'utf8').includes(markerText) } catch { return false }
        })
        expect(hit, `${file} effect marker missing in ${target.dir}`).toBe(true)
      }
    })
  }
})

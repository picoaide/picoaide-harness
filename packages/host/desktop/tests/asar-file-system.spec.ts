import { describe, expect, it } from 'vitest'
import { repairAsarLinkPath } from '../src/asar-file-system.ts'

const ASAR_DIR = '/opt/PicoAide Harness/resources/app.asar/node_modules/@deepseek-ai/dsh-agent-presets'
const LINK_DIR = 'C:/Users/lost/.picoaide-harness/profiles/node_modules/@deepseek-ai/dsh-agent-presets'

/** Build an lstat/readlink pair over a map of symlink paths. */
function linkWalk(links: Record<string, string>, existent: string[] = []) {
  const linkEntries = new Map<string, string>(Object.entries(links))
  const existentSet = new Set(existent)
  const lstat = (path: string): { isSymbolicLink(): boolean } => {
    if (linkEntries.has(path)) return { isSymbolicLink: () => true }
    if (existentSet.has(path)) return { isSymbolicLink: () => false }
    if (path === '/' || path === 'C:') return { isSymbolicLink: () => false }
    throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: 'ENOTDIR' })
  }
  const readlink = (path: string): string => {
    const target = linkEntries.get(path)
    if (target === undefined) throw new Error(`EINVAL: ${path}`)
    return target
  }
  return { lstat, readlink }
}

describe('repairAsarLinkPath', () => {
  it('repairs a Windows-style path through an asar-pointing symlink', () => {
    const { lstat, readlink } = linkWalk({ [LINK_DIR]: ASAR_DIR })
    const input = `${LINK_DIR}/agent.cordis.yml`
    const expected = `${ASAR_DIR}/agent.cordis.yml`
    expect(repairAsarLinkPath(input, lstat, readlink)).toBe(expected)
  })

  it('repairs a POSIX-style path through an asar-pointing symlink', () => {
    const linkDir = '/home/u/.picoaide-harness/profiles/node_modules/@deepseek-ai/dsh-agent-presets'
    const asarDir = '/opt/app/resources/app.asar/node_modules/@deepseek-ai/dsh-agent-presets'
    const { lstat, readlink } = linkWalk({ [linkDir]: asarDir })
    expect(repairAsarLinkPath(`${linkDir}/package.json`, lstat, readlink)).toBe(`${asarDir}/package.json`)
  })

  it('repairs nested paths preserving the full suffix', () => {
    const linkDir = '/home/u/profiles/node_modules/@deepseek-ai/dsh-agent-presets'
    const asarDir = '/opt/app/resources/app.asar/node_modules/@deepseek-ai/dsh-agent-presets'
    const { lstat, readlink } = linkWalk({ [linkDir]: asarDir })
    expect(repairAsarLinkPath(`${linkDir}/lib/index.js`, lstat, readlink)).toBe(`${asarDir}/lib/index.js`)
  })

  it('repairs a Windows-only path with Windows separators end to end', () => {
    const linkDir = 'C:\\Users\\lost\\.picoaide-harness\\profiles\\node_modules\\@deepseek-ai\\dsh-agent-presets'
    const asarDir = 'C:\\Program Files\\PicoAide Harness\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-agent-presets'
    const { lstat, readlink } = linkWalk({ [linkDir]: asarDir })
    expect(repairAsarLinkPath(`${linkDir}\\agent.cordis.yml`, lstat, readlink)).toBe(`${asarDir}\\agent.cordis.yml`)
    expect(repairAsarLinkPath(`${linkDir}\\lib\\index.js`, lstat, readlink)).toBe(`${asarDir}\\lib\\index.js`)
  })

  it('returns the path unchanged when no asar-pointing symlink exists', () => {
    const linkDir = '/home/u/profiles/node_modules/@deepseek-ai/dsh-agent-presets'
    const { lstat, readlink } = linkWalk({ [linkDir]: '/opt/app/resources/node_modules/@deepseek-ai/dsh-agent-presets' })
    const input = `${linkDir}/agent.cordis.yml`
    expect(repairAsarLinkPath(input, lstat, readlink)).toBe(input)
  })

  it('returns the path unchanged when every component lstat fails (missing file)', () => {
    const { lstat, readlink } = linkWalk({}, [])
    const input = '/home/u/.picoaide-harness/profiles/node_modules/@deepseek-ai/dsh-agent-presets/agent.cordis.yml'
    expect(repairAsarLinkPath(input, lstat, readlink)).toBe(input)
  })

  it('returns the path unchanged for a direct (already-in-archive) path', () => {
    const { lstat, readlink } = linkWalk({})
    const input = `${ASAR_DIR}/agent.cordis.yml`
    expect(repairAsarLinkPath(input, lstat, readlink)).toBe(input)
  })
})

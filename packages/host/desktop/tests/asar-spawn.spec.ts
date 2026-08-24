import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  installAsarSpawnRewrite,
  mapExecutableToUnpacked,
} from '../src/asar-spawn.ts'

/** The shared builtin instance the implementation patches (same module shell Node/Electron serves). */
function sharedChildProcess(): typeof import('node:child_process') {
  return createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
}

const ASAR_ROOT = '/opt/app/resources/app.asar'
const VIRTUAL_LANDLOCK = `${ASAR_ROOT}/node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64/bin/landlock-run`
const PHYSICAL_LANDLOCK = `${ASAR_ROOT}.unpacked/node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64/bin/landlock-run`

describe('mapExecutableToUnpacked', () => {
  it('maps a virtual asar path to an existing physical twin', () => {
    const exists = vi.fn((candidate: string) => candidate === PHYSICAL_LANDLOCK)
    expect(mapExecutableToUnpacked(VIRTUAL_LANDLOCK, exists)).toBe(PHYSICAL_LANDLOCK)
    expect(exists).toHaveBeenCalledWith(PHYSICAL_LANDLOCK)
  })

  it('leaves a virtual asar path unchanged when no physical twin exists', () => {
    const exists = vi.fn(() => false)
    expect(mapExecutableToUnpacked(VIRTUAL_LANDLOCK, exists)).toBe(VIRTUAL_LANDLOCK)
  })

  it('never rewrites the already-physical unpacked path', () => {
    const exists = vi.fn(() => true)
    expect(mapExecutableToUnpacked(PHYSICAL_LANDLOCK, exists)).toBe(PHYSICAL_LANDLOCK)
    expect(exists).not.toHaveBeenCalled()
  })

  it('never rewrites a bare PATH name or a relative path', () => {
    const exists = vi.fn(() => true)
    expect(mapExecutableToUnpacked('bwrap', exists)).toBe('bwrap')
    expect(mapExecutableToUnpacked('./landlock-run', exists)).toBe('./landlock-run')
    expect(exists).not.toHaveBeenCalled()
  })

  it('never rewrites a non-asar absolute path', () => {
    const exists = vi.fn(() => false)
    expect(mapExecutableToUnpacked('/usr/bin/bash', exists)).toBe('/usr/bin/bash')
    expect(exists).not.toHaveBeenCalled()
  })

  it('matches single-archive and node_modules.asar layouts', () => {
    const single = '/opt/app/resources/app.asar/bin/tool'
    const multi = '/opt/app/resources/node_modules.asar/tool'
    const exists = vi.fn(() => true)
    expect(mapExecutableToUnpacked(single, exists)).toBe('/opt/app/resources/app.asar.unpacked/bin/tool')
    expect(mapExecutableToUnpacked(multi, exists)).toBe('/opt/app/resources/node_modules.asar.unpacked/tool')
  })
})

describe('installAsarSpawnRewrite', () => {
  it('patches the shared spawn/spawnSync and disposes cleanly', () => {
    const cp = sharedChildProcess()
    const originalSpawn = cp.spawn
    const originalSpawnSync = cp.spawnSync
    const disposer = installAsarSpawnRewrite()
    try {
      expect(cp.spawn).not.toBe(originalSpawn)
      expect(cp.spawnSync).not.toBe(originalSpawnSync)
    } finally {
      disposer()
    }
    expect(cp.spawn).toBe(originalSpawn)
    expect(cp.spawnSync).toBe(originalSpawnSync)
  })

  it('spawns a real process through the patched function', async () => {
    const disposer = installAsarSpawnRewrite()
    try {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("ok")'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const out = await new Promise<string>((resolve, reject) => {
        let text = ''
        child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString() })
        child.on('error', reject)
        child.on('close', () => resolve(text))
      })
      expect(out).toBe('ok')
    } finally {
      disposer()
    }
  })

  it('spawnSync runs a real process through the patched function', () => {
    const disposer = installAsarSpawnRewrite()
    try {
      const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: 'ignore',
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
    } finally {
      disposer()
    }
  })

  it('does not touch a shell-command spawn', async () => {
    const disposer = installAsarSpawnRewrite()
    try {
      const child = spawn('printf ok', { shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const out = await new Promise<string>((resolve, reject) => {
        let text = ''
        child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString() })
        child.on('error', reject)
        child.on('close', () => resolve(text))
      })
      expect(out.trim()).toBe('ok')
    } finally {
      disposer()
    }
  })
})

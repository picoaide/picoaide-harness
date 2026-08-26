import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { CliInstaller, ensureCliInstalled } from '../src/cli-installer.ts'
import { dwsEnv, resolveDshHome } from '../src/home.ts'
import { extractArchive, readArchiveEntries } from '../src/archive.ts'
import type { CliBinaryManifest } from '../src/cli-manifest.ts'

/* ---------------------------------- fixtures ---------------------------------- */

function tgz(entries: { name: string; data?: Buffer }[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    const header = Buffer.alloc(512)
    header.write(entry.name.slice(0, 100), 0, 'utf8')
    header.write('0000644\0', 100, 'latin1')
    header.write('0000000\0', 108, 'latin1')
    header.write('0000000\0', 116, 'latin1')
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1')
    header.write('00000000000\0', 136, 'latin1')
    header.write('        ', 148, 'latin1')
    header.write('0', 156, 'latin1')
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'latin1')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
    blocks.push(header)
    if (data.length > 0) {
      blocks.push(data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex')

function manifestFor(command: string, checksum: string): CliBinaryManifest {
  return {
    command,
    version: '1.0.0',
    binaryName: command,
    displayName: `${command} CLI`,
    license: 'MIT',
    source: {
      kind: 'direct',
      url: (platform) => platform === 'linux-x64' ? `http://127.0.0.1:0/${command}-${platform}.tar.gz` : null,
      checksums: { [`${command}-linux-x64.tar.gz`]: checksum },
    },
  }
}

/* ---------------------------------- install ---------------------------------- */

describe('cli installer', () => {
  const dirs = new Set<string>()
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.clear()
  })
  const tmpDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-install-'))
    dirs.add(dir)
    return dir
  }

  it('downloads, verifies, extracts and caches the pinned binary', async () => {
    // Local HTTP server serving a fake gz archive with the binary inside.
    const binary = Buffer.from('#!/bin/sh\necho hi\n')
    const archive = tgz([{ name: 'bin/demo-cli', data: binary }])
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(archive)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const cache = tmpDir()
      const checksum = sha256(archive)
      const manifest = manifestFor('demo-cli', checksum)
      // Patch the URL to our local server
      manifest.source = {
        kind: 'direct',
        url: () => `http://127.0.0.1:${port}/demo.tar.gz`,
        checksums: { 'demo.tar.gz': checksum },
      }
      const installer = new CliInstaller({ cacheDir: cache, manifests: new Map([['demo-cli', manifest]]) })
      const first = await installer.ensure('demo-cli')
      expect(first).not.toBeNull()
      expect(first!.fromCache).toBe(false)
      const binaryPath = first!.binaryPath
      const stat = await fs.stat(binaryPath)
      expect(stat.mode & 0o100).toBeTruthy() // executable
      expect(await fs.readFile(binaryPath, 'utf8')).toContain('echo hi')
      // Second call hits the cache (fromCache=true, no re-download).
      const second = await installer.ensure('demo-cli')
      expect(second!.fromCache).toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('rejects a tampered archive via the pinned checksum', async () => {
    const binary = Buffer.from('#!/bin/sh\n')
    const archive = tgz([{ name: 'bin/bad', data: binary }])
    const cache = tmpDir()
    const manifest = manifestFor('bad-cli', 'deadbeef'.repeat(8))
    manifest.source = {
      kind: 'direct',
      url: () => `data:application/octet-stream;base64,${archive.toString('base64')}`,
      checksums: { 'bad.tar.gz': 'deadbeef'.repeat(8) },
    }
    // Note: fetch of data: URL works in Node 18+; checksum mismatch must throw.
    const installer = new CliInstaller({ cacheDir: cache, manifests: new Map([['bad-cli', manifest]]) })
    await expect(installer.ensure('bad-cli')).rejects.toThrow(/校验和|checksum/i)
  })

  it('returns null for an unknown command (no manifest)', async () => {
    const installer = new CliInstaller({ cacheDir: tmpDir(), manifests: new Map() })
    expect(await installer.ensure('nope')).toBeNull()
  })

  it('ensureCliInstalled throws a clear error for unknown commands', async () => {
    await expect(ensureCliInstalled('nope', { manifests: new Map() })).rejects.toThrow(/未找到/)
  })

  it('serves a build-prefetched binary from bundledDir without downloading', async () => {
    const cache = tmpDir()
    const bundled = tmpDir()
    const binDir = join(bundled, 'demo-cli', '1.0.0')
    await fs.mkdir(binDir, { recursive: true })
    await fs.writeFile(join(binDir, 'demo-cli'), '#!/bin/sh\necho bundled\n', { mode: 0o755 })
    const manifest = manifestFor('demo-cli', 'x'.repeat(64))
    const installer = new CliInstaller({ cacheDir: cache, bundledDir: bundled, manifests: new Map([['demo-cli', manifest]]) })
    const result = await installer.ensure('demo-cli')
    expect(result!.fromCache).toBe(true)
    expect(result!.binaryPath).toBe(join(binDir, 'demo-cli'))
  })
})

/* ---------------------------------- home ---------------------------------- */

describe('cli-tools home / dwsEnv', () => {
  it('resolves the product home with $DSH_HOME precedence', () => {
    expect(resolveDshHome({ DSH_HOME: '/custom' })).toBe('/custom')
  })

  it('defaults to ~/.picoaide-harness (product, not upstream ~/.dsh)', () => {
    const home = resolveDshHome({})
    expect(home).toMatch(/\.picoaide-harness$/)
    expect(home).not.toMatch(/\.dsh$/)
  })

  it('points dws config and keychain at the product home', () => {
    const env = dwsEnv({ DSH_HOME: '/custom-home' })
    expect(env.DWS_CONFIG_DIR).toBe('/custom-home')
    expect(env.DWS_KEYCHAIN_DIR).toBe('/custom-home/dws/keychain')
  })
})

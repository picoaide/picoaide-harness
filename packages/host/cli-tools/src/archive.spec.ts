import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, promises as fs } from 'node:fs'

import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { extractArchive, findEntry, readArchiveEntries, readTarEntries, readZipEntries } from '../src/archive.ts'



/* ---------------------------------- fixtures ---------------------------------- */

function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 'utf8')
  header.write('0000644\0', 100, 'latin1')
  header.write('0000000\0', 108, 'latin1')
  header.write('0000000\0', 116, 'latin1')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1')
  header.write('00000000000\0', 136, 'latin1')
  header.write('        ', 148, 'latin1')
  header.write(typeflag, 156, 'latin1')
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return header
}

function tar(entries: { name: string; data?: Buffer; type?: string }[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    blocks.push(tarHeader(entry.name, data.length, entry.type ?? '0'))
    if (data.length > 0) {
      blocks.push(data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const tgz = (entries: { name: string; data?: Buffer; type?: string }[]): Buffer => gzipSync(tar(entries))

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(entries: { name: string; data?: Buffer; method?: 0 | 8 }[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 8
    const payload = method === 0 ? data : deflateRawSync(data)
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, payload)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += local.length + nameBuf.length + payload.length
  }
  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralBuf, eocd])
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex')

/* ---------------------------------- archive.ts ---------------------------------- */

describe('archive extraction', () => {
  const dirs = new Set<string>()
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.clear()
  })
  const tmpDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'conn-archive-'))
    dirs.add(dir)
    return dir
  }

  it('extracts tar.gz files and directories', async () => {
    const archive = tgz([
      { name: 'dws', data: Buffer.from('#!/bin/sh\necho hi\n') },
      { name: 'docs/README.md', data: Buffer.from('# readme') },
      { name: 'empty-dir/', type: '5' },
    ])
    const written = await extractArchive(archive, tmpDir())
    expect(written).toEqual(expect.arrayContaining(['dws', 'docs/README.md']))
  })

  it('handles GNU long names (>100 chars) and PAX path overrides', () => {
    const longName = `package/assets/${'x'.repeat(120)}`
    const entries = readTarEntries(tar([
      { name: '././@LongLink', type: 'L', data: Buffer.from(longName) },
      { name: 'placeholder', data: Buffer.from('content') },
      { name: 'pax', type: 'x', data: Buffer.from('24 path=renamed-by-pax\n') },
      { name: 'pax-target', data: Buffer.from('paxed') },
    ]))
    expect(findEntry(entries, longName)?.data.toString()).toBe('content')
    expect(findEntry(entries, 'renamed-by-pax')?.data.toString()).toBe('paxed')
  })

  it('rejects path traversal and absolute paths in tar', () => {
    expect(() => readTarEntries(tar([{ name: '../evil', data: Buffer.from('x') }]))).toThrow(/unsafe/)
    expect(() => readTarEntries(tar([{ name: '/etc/passwd', data: Buffer.from('x') }]))).toThrow(/unsafe/)
    expect(() => readTarEntries(tar([{ name: 'a\\b', data: Buffer.from('x') }]))).toThrow(/unsafe/)
  })

  it('never materializes tar symlinks or hardlinks', async () => {
    const entries = readTarEntries(tar([
      { name: 'real', data: Buffer.from('x') },
      { name: 'link', type: '2', data: Buffer.from('real') },
      { name: 'hard', type: '1', data: Buffer.from('real') },
    ]))
    expect(entries.map((e) => e.name)).toEqual(['real'])
    await extractArchive(tar([{ name: 'real', data: Buffer.from('x') }]), tmpDir())
  })

  it('extracts zip store + deflate entries and rejects traversal/symlinks', async () => {
    const archive = zip([
      { name: 'beisen-cli', data: Buffer.from('#!/bin/sh\necho beisen\n'), method: 8 },
      { name: 'README.txt', data: Buffer.from('readme'), method: 0 },
    ])
    const dest = tmpDir()
    await extractArchive(archive, dest)
    await expect(fs.readFile(join(dest, 'beisen-cli'), 'utf8')).resolves.toBe('#!/bin/sh\necho beisen\n')
    expect(() => readZipEntries(zip([{ name: '../evil', data: Buffer.from('x') }]))).toThrow(/unsafe/)
  })

  it('rejects unknown archive formats', () => {
    expect(() => readArchiveEntries(Buffer.from('not an archive'))).toThrow(/不支持的压缩格式/)
  })
})

/* ---------------------------------- cli-runtime.ts ---------------------------------- */


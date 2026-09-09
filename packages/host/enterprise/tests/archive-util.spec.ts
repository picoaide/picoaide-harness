/** Archive validator regressions (audit 2026-09-08 P2-11: duplicate entries). */
import AdmZip from 'adm-zip'
import { gzipSync, gzipSync as gzip } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assertArchiveSafe } from '../src/archive-util.ts'

/** Minimal POSIX ustar header + payload (the tar validator only reads paths). */
function tarEntry(name: string, content: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644', 100, 8, 'utf8')
  header.write('0000000', 108, 8, 'utf8')
  header.write('0000000', 116, 8, 'utf8')
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
  header.write('00000000000 ', 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write('0', 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  body.write(content, 0, 'utf8')
  return Buffer.concat([header, body])
}

function tarGz(entries: Array<[string, string]>): Buffer {
  const parts = entries.map(([name, content]) => tarEntry(name, content))
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

describe('assertArchiveSafe duplicate entries (P2-11)', () => {
  it('rejects the same zip path twice (reviewer first-match vs installer last-wins)', async () => {
    const zip = new AdmZip()
    // AdmZip de-duplicates by name on add, so craft the second entry name
    // directly — exactly the shape a hostile archive ships.
    zip.addFile('SKILL.md', Buffer.from('first'))
    zip.addFile('other.md', Buffer.from('second'))
    zip.getEntries()[1]!.entryName = 'SKILL.md'
    await expect(assertArchiveSafe(zip.toBuffer())).rejects.toThrow(/duplicate entry/u)
  })

  it('rejects a case-only collision (macOS/Windows overwrite the first)', async () => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('first'))
    zip.addFile('skill.md', Buffer.from('second'))
    await expect(assertArchiveSafe(zip.toBuffer())).rejects.toThrow(/duplicate entry/u)
  })

  it('rejects duplicate paths in a tar.gz archive', async () => {
    await expect(assertArchiveSafe(tarGz([['SKILL.md', 'a'], ['SKILL.md', 'b']])))
      .rejects.toThrow(/duplicate entry/u)
  })

  it('still accepts distinct paths in both formats', async () => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('a'))
    zip.addFile('references/a.md', Buffer.from('b'))
    await expect(assertArchiveSafe(zip.toBuffer())).resolves.toBeUndefined()
    await expect(assertArchiveSafe(tarGz([['SKILL.md', 'a'], ['references/a.md', 'b']])))
      .resolves.toBeUndefined()
  })
})

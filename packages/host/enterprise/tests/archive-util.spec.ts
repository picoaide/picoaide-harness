/** Archive validator regressions (audit 2026-09-08 P2-11: duplicate entries). */
import AdmZip from 'adm-zip'
import { gzipSync, gzipSync as gzip } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assertArchiveSafe } from '../src/archive-util.ts'

/**
 * Minimal POSIX ustar header + payload (the tar validator only reads paths).
 * @param typeflag - ustar type flag：`'0'` 普通文件（缺省）、`'5'` 目录、`'2'` 符号链接、
 *   `'6'` FIFO、`'3'` 字符设备 —— 后三类是"合法技能包里不该出现"的形态。
 */
function tarEntry(name: string, content: string, typeflag = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644', 100, 8, 'utf8')
  header.write('0000000', 108, 8, 'utf8')
  header.write('0000000', 116, 8, 'utf8')
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
  header.write('00000000000 ', 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write(typeflag, 156, 1, 'utf8')
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

/** 手工拼一个只带 typeflag 的条目（内容为空，用于特殊文件类型用例）。 */
function tarGzTyped(name: string, typeflag: string): Buffer {
  return gzipSync(Buffer.concat([tarEntry(name, '', typeflag), Buffer.alloc(1024)]))
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

describe('assertArchiveSafe 条目数与特殊文件类型（审计 2026-09-18 P2-2 / P2-3）', () => {
  it('tar.gz 与 zip 一样按 MAX_ENTRIES 拒绝（此前只有 zip 分支计数）', async () => {
    // 10001 个条目 —— Go 侧 archiveutil.MaxEntries 也是 10000，两端同口径。
    const many: Array<[string, string]> = []
    for (let i = 0; i <= 10_000; i++) many.push([`f/${i}.txt`, 'x'])
    await expect(assertArchiveSafe(tarGz(many))).rejects.toThrow(/too many entries/u)
  })

  it('条目数刚好在上限内仍然接受（边界：> 而不是 >=）', async () => {
    const many: Array<[string, string]> = []
    for (let i = 0; i < 10_000; i++) many.push([`f/${i}.txt`, 'x'])
    await expect(assertArchiveSafe(tarGz(many))).resolves.toBeUndefined()
  })

  it('tar.gz 里的 FIFO / 字符设备条目被拒（技能包里合法的只有普通文件与目录）', async () => {
    await expect(assertArchiveSafe(tarGzTyped('pipe', '6'))).rejects.toThrow(/link entry refused/u)
    await expect(assertArchiveSafe(tarGzTyped('dev', '3'))).rejects.toThrow(/link entry refused/u)
    await expect(assertArchiveSafe(tarGzTyped('blk', '4'))).rejects.toThrow(/link entry refused/u)
  })
})

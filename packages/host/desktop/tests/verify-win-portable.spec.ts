import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  verifyWindowsPortable,
  type WindowsPortableVerificationOptions,
} from '../scripts/verify-win-portable.ts'

const temporaryRoots: string[] = []

function portableExecutable(): Buffer {
  const executable = Buffer.alloc(132)
  executable.write('MZ', 0, 'ascii')
  executable.writeUInt32LE(128, 0x3c)
  executable.write('PE\0\0', 128, 'binary')
  return executable
}

function fixture(version = '2.0.0'): { readonly root: string; readonly portable: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-win-portable-'))
  temporaryRoots.push(root)
  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  const portable = join(dist, `PicoAide-Harness-${version}-x64-Portable.zip`)
  const archive = new AdmZip()
  archive.addFile('PicoAide Harness.exe', portableExecutable())
  archive.addFile('resources/app.asar', Buffer.from('asar'))
  archive.writeZip(portable)
  return { root, portable }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * 官方渠道的期望名与固定版本。
 *
 * 渠道化改造后便携包名/可执行名来自渠道包（channel-build.ts），官方渠道的值
 * 与改造前逐字节一致 —— 这里显式写死，保证官方构建的回归不放松。
 */
function OFFICIAL_OPTIONS(desktopRoot: string): WindowsPortableVerificationOptions {
  return {
    desktopRoot,
    version: '2.0.0',
    archiveName: 'PicoAide-Harness-2.0.0-x64-Portable.zip',
    executableName: 'PicoAide Harness.exe',
  }
}

describe('Windows portable artifact verification', () => {
  it('accepts the exact versioned portable ZIP archive', () => {
    const value = fixture()

    expect(verifyWindowsPortable(OFFICIAL_OPTIONS(value.root))).toBe(value.portable)
  })

  it('rejects a stale portable archive from a different version', () => {
    const value = fixture('1.9.0')

    expect(() => verifyWindowsPortable(OFFICIAL_OPTIONS(value.root)))
      .toThrow('PicoAide-Harness-2.0.0-x64-Portable.zip')
  })

  it('rejects an application entry without a Windows PE header', () => {
    const value = fixture()
    const invalid = portableExecutable()
    invalid.write('NO', 0, 'ascii')
    const archive = new AdmZip()
    archive.addFile('PicoAide Harness.exe', invalid)
    archive.addFile('resources/app.asar', Buffer.from('asar'))
    archive.writeZip(value.portable)

    expect(() => verifyWindowsPortable(OFFICIAL_OPTIONS(value.root)))
      .toThrow('does not have a Windows PE header')
  })
})

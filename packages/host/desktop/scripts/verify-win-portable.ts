/** Verify the unsigned Windows x64 portable ZIP archive. */

import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { assertPortableExecutableBuffer } from './verify-win-installer.ts'
import { channelArtifactName, resolveChannelBuildContext } from './channel-build.ts'

export interface WindowsPortableVerificationOptions {
  /** Desktop package root containing package.json and dist. */
  readonly desktopRoot: string
  /** Product version embedded in the expected artifact name. */
  readonly version: string
  /** 期望的便携包文件名（渠道化：名字来自渠道包）。 */
  readonly archiveName: string
  /** 期望的可执行文件名（= 产品名，渠道化后随渠道）。 */
  readonly executableName: string
}

function readVersion(desktopRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`desktop package at ${desktopRoot} has no valid version`)
  }
  return manifest.version
}

function defaultOptions(): WindowsPortableVerificationOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const version = readVersion(desktopRoot)
  const channel = resolveChannelBuildContext()
  return {
    desktopRoot,
    version,
    archiveName: channelArtifactName(channel, 'win', { version, arch: 'x64', ext: 'zip' }),
    executableName: `${channel.productName}.exe`,
  }
}

/** Verify the exact versioned portable archive and its application entry. */
export function verifyWindowsPortable(
  options: WindowsPortableVerificationOptions = defaultOptions(),
): string {
  const portablePath = join(options.desktopRoot, 'dist', options.archiveName)
  const stat = statSync(portablePath)
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Windows portable archive is not a non-empty regular file: ${portablePath}`)
  }
  const archive = new AdmZip(portablePath)
  const entries = archive.getEntries().filter(entry => !entry.isDirectory)
  const executable = entries.find(entry => entry.entryName.replaceAll('\\', '/') === options.executableName)
  if (executable === undefined) {
    throw new Error(`Windows portable archive is missing ${options.executableName}: ${portablePath}`)
  }
  if (!entries.some(entry => entry.entryName.replaceAll('\\', '/') === 'resources/app.asar')
    && !entries.some(entry => entry.entryName.replaceAll('\\', '/') === 'resources/app/package.json')) {
    throw new Error(`Windows portable archive is missing the packaged runtime (resources/app.asar or resources/app): ${portablePath}`)
  }
  assertPortableExecutableBuffer(
    executable.getData(),
    'Windows portable application',
    `${portablePath}:${options.executableName}`,
  )
  return portablePath
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Windows portable verification passed: ${verifyWindowsPortable()}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

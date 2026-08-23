/**
 * Prefetch connector CLI binaries at build time and stage them under
 * `build/cli/` so a packaged app ships them as `resources/cli` — first
 * connect then needs no download and no network (CN enterprise friendly).
 *
 * Binaries are fetched from each manifest's pinned source (npmmirror first
 * for CN networks) and sha256-verified against the manifest checksums — the
 * same integrity contract the runtime downloader enforces. The script runs
 * as part of the desktop build (`build` script) and writes
 * `build/cli/<command>/<version>/<binaryName>` for the CURRENT platform only
 * (CI builds per-OS, so each platform's artifact carries its own binaries);
 * electron-builder `extraResources` moves the tree into the app as
 * `resources/cli` and the connector runtime serves it from
 * `process.resourcesPath/cli`.
 *
 * Extraction reuses the connectors package's archive extractor (`./archive`
 * subpath, same module the runtime downloader uses), so archive handling and
 * path-traversal protections stay consistent with runtime downloads.
 *
 * Exit codes: 0 = fetched or up-to-date; 1 = network/checksum/extraction
 * failure.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// The connectors package exposes its pinned manifest table through the
// `./cli-manifest` subpath (same table the runtime uses).
let CLI_MANIFESTS
let archiveHelpers
try {
  CLI_MANIFESTS = require('@picoaide/dsh-connectors/cli-manifest').CLI_MANIFESTS
  archiveHelpers = require('@picoaide/dsh-connectors/archive')
} catch (error) {
  console.error('prefetch-cli: cannot load @picoaide/dsh-connectors cli-manifest/archive — run the connectors build first')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(root, 'build', 'cli')

const cliPlatformKey = (platform, arch) => {
  switch (`${platform}-${arch}`) {
    case 'darwin-x64': return 'darwin-x64'
    case 'darwin-arm64': return 'darwin-arm64'
    case 'linux-x64': return 'linux-x64'
    case 'linux-arm64': return 'linux-arm64'
    case 'win32-x64': return 'win32-x64'
    case 'win32-arm64': return 'win32-arm64'
    default: return null
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const retry = async (fn, retries = 2, delay = 1500) => {
  let lastError
  for (let i = 0; i <= retries; i++) {
    try { return await fn() } catch (e) { lastError = e; if (i < retries) await sleep(delay) }
  }
  throw lastError
}

const digest = buf => createHash('sha256').update(buf).digest('hex')

async function download(url, retries = 2) {
  return retry(async () => {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'picoaide-connectors/0.1' } })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return Buffer.from(await res.arrayBuffer())
  }, retries)
}

const readMarker = path => {
  try {
    const [archiveName, checksum, binarySize] = readFileSync(path, 'utf8').trim().split(' ')
    return { archiveName, checksum, binarySize: Number(binarySize) }
  } catch {
    return null
  }
}

/** Recursively find a file by basename inside a directory tree. */
async function findNamedFile(dir, name) {
  const { promises: fs } = await import('node:fs')
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        const found = await walk(full)
        if (found) return found
      } else if (entry.name === name) {
        return full
      }
    }
    return null
  }
  return walk(dir)
}

async function main() {
  const platform = cliPlatformKey(process.platform, process.arch)
  if (!platform) {
    console.warn(`prefetch-cli: unsupported platform ${process.platform}-${process.arch}, skipping`)
    return
  }
  console.log(`prefetch-cli: staging connector CLI binaries for ${platform} → ${outRoot}`)
  mkdirSync(outRoot, { recursive: true })

  const { extractArchive, readArchiveEntries, findEntry } = archiveHelpers
  let any = false
  for (const manifest of CLI_MANIFESTS.values()) {
    const source = manifest.source
    // Derive the expected archive name + checksum exactly like the runtime.
    let archiveName = null
    let checksum = null
    if (source.kind === 'npm-package') {
      archiveName = source.asset(platform)
      checksum = archiveName ? source.checksums[archiveName] : null
      if (!archiveName) continue
      if (!checksum) throw new Error(`${manifest.command}: missing checksum for ${archiveName}`)
    } else {
      const url = source.url(platform)
      if (!url) continue
      archiveName = url.split('/').at(-1)
      checksum = source.checksums[archiveName]
      if (!checksum) throw new Error(`${manifest.command}: missing checksum for ${archiveName}`)
    }

    const binaryName = `${manifest.binaryName}${process.platform === 'win32' ? '.exe' : ''}`
    const dest = join(outRoot, manifest.command, manifest.version, binaryName)
    const marker = join(outRoot, manifest.command, manifest.version, '.checksum')
    const existing = readMarker(marker)
    if (existing?.archiveName === archiveName && existing.checksum === checksum && existsSync(dest)) {
      console.log(`prefetch-cli: ${manifest.command}@${manifest.version} up-to-date`)
      continue
    }

    let url
    if (source.kind === 'npm-package') {
      const registry = (source.registries ?? ['https://registry.npmmirror.com'])[0]
      url = `${registry.replace(/\/+$/, '')}/${source.packageName}/-/${source.packageName}-${source.packageVersion}.tgz`
    } else {
      url = source.url(platform)
    }
    console.log(`prefetch-cli: downloading ${manifest.command}@${manifest.version} from ${new URL(url).host}…`)
    const bytes = await download(url)
    // The pinned checksum covers the platform archive: for npm-package
    // sources the platform archive is the inner entry of the npm tarball
    // (the runtime verifies that inner entry), for direct sources the whole
    // download is the archive. Verify the same bytes the runtime would.
    let binaryBytes = null
    const tmp = join(outRoot, `.tmp-${manifest.command}-${Date.now().toString(36)}`)
    try {
      mkdirSync(tmp, { recursive: true })
      if (source.kind === 'npm-package') {
        const inner = findEntry(readArchiveEntries(bytes), source.innerPath(archiveName))
        if (!inner) throw new Error(`npm 包内未找到 ${source.innerPath(archiveName)}`)
        if (digest(inner.data) !== checksum) {
          throw new Error(`${manifest.command}: checksum mismatch for ${archiveName}`)
        }
        await extractArchive(inner.data, tmp)
      } else {
        if (digest(bytes) !== checksum) {
          throw new Error(`${manifest.command}: checksum mismatch for ${archiveName}`)
        }
        await extractArchive(bytes, tmp)
      }
      // The extracted tree holds the binary at its root or inside a package
      // dir; locate it by name.
      binaryBytes = await findNamedFile(tmp, binaryName).then(found => found ? readFileSync(found) : null)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    if (!binaryBytes) throw new Error(`${manifest.command}: binary ${binaryName} not found in ${archiveName}`)

    const versionDir = dirname(dest)
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(dest, binaryBytes)
    chmodSync(dest, 0o755)
    writeFileSync(marker, `${archiveName} ${checksum} ${binaryBytes.length}\n`)
    console.log(`prefetch-cli: staged ${manifest.command}@${manifest.version} (${Math.round(binaryBytes.length / 1024)} KiB)`)
    any = true
  }
  if (!any) console.log('prefetch-cli: no binaries needed for this platform')
  console.log('prefetch-cli: done')
}

main().catch(error => {
  console.error(`prefetch-cli: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

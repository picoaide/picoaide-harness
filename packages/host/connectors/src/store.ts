/** Per-user connector credential store under the config dir. */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Per-user files under the config dir. Tokens live in
 * `~/.picoaide/connectors/` with private permissions (0700/0600, atomic
 * replace, symlink rejection — mirroring the desktop launcher's state files).
 */
const CONNECTORS_DIR = join(homedir(), '.picoaide', 'connectors')
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_CREDENTIAL_BYTES = 64 * 1024

/**
 * Connector ids come from marketplace-derived definitions, so they are
 * validated before crossing into the filesystem (no separators, no dot
 * segments, no NUL, bounded length).
 */
const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export interface ConnectorCredential {
  /** OAuth access token. */
  accessToken?: string
  /** OAuth refresh token. */
  refreshToken?: string
  /** OAuth client info (client id/secret) when the provider issues its own. */
  clientId?: string
  clientSecret?: string
  /** Token-form field values (password fields stored as-is; plaintext on disk is the price of the lazy design). */
  fields?: Record<string, string>
  updatedAt: number
}

export interface ConnectorStoreOptions {
  /** Override the base directory (tests). */
  baseDir?: string
}

function assertConnectorId(id: string): string {
  if (!CONNECTOR_ID_PATTERN.test(id)) {
    throw new Error(`invalid connector id ${JSON.stringify(id)}`)
  }
  return id
}

/** Reject a symlinked or non-directory store root before touching it. */
async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIRECTORY_MODE })
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`connector store directory is not a real directory: ${dir}`)
  }
  await fs.chmod(dir, DIRECTORY_MODE)
}

export class ConnectorStore {
  private readonly dir: string

  constructor(options: ConnectorStoreOptions = {}) {
    this.dir = options.baseDir ?? CONNECTORS_DIR
  }

  private path(id: string): string {
    const safe = assertConnectorId(id)
    const resolved = resolve(this.dir, `${safe}.json`)
    if (dirname(resolved) !== resolve(this.dir)) {
      throw new Error(`connector path escaped the store directory: ${id}`)
    }
    return resolved
  }

  async readCredential(id: string): Promise<ConnectorCredential | null> {
    const file = this.path(id)
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CREDENTIAL_BYTES) return null
      const content = await fs.readFile(file, 'utf8')
      if (Buffer.byteLength(content, 'utf8') > MAX_CREDENTIAL_BYTES) return null
      const value: unknown = JSON.parse(content)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      if (typeof (value as { updatedAt?: unknown }).updatedAt !== 'number') return null
      return value as ConnectorCredential
    } catch {
      return null
    }
  }

  async writeCredential(id: string, credential: ConnectorCredential): Promise<void> {
    await ensurePrivateDirectory(this.dir)
    const file = this.path(id)
    const temporary = join(this.dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temporary, 'wx', FILE_MODE)
      try {
        await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.chmod(temporary, FILE_MODE)
      await fs.rename(temporary, file)
    } finally {
      await fs.unlink(temporary).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      })
    }
  }

  async updateCredential(id: string, patch: Partial<ConnectorCredential>): Promise<ConnectorCredential> {
    const current = (await this.readCredential(id)) ?? { updatedAt: 0 }
    const next: ConnectorCredential = { ...current, ...patch, updatedAt: Date.now() }
    await this.writeCredential(id, next)
    return next
  }

  async clearCredential(id: string): Promise<void> {
    try {
      await fs.unlink(this.path(id))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }

  async hasCredential(id: string): Promise<boolean> {
    return (await this.readCredential(id)) !== null
  }
}

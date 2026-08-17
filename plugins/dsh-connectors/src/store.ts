import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Token/state persistence for connectors (mirrors WorkBuddy's ConnectorOAuthStore:
 * per-user files under the config dir). Tokens live in `~/.picoaide/connectors/`.
 */
const CONNECTORS_DIR = join(homedir(), '.picoaide', 'connectors')

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

export class ConnectorStore {
  private readonly dir: string

  constructor(options: ConnectorStoreOptions = {}) {
    this.dir = options.baseDir ?? CONNECTORS_DIR
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  async readCredential(id: string): Promise<ConnectorCredential | null> {
    try {
      return JSON.parse(await fs.readFile(this.path(id), 'utf-8')) as ConnectorCredential
    } catch {
      return null
    }
  }

  async writeCredential(id: string, credential: ConnectorCredential): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(this.path(id), JSON.stringify(credential, null, 2), 'utf-8')
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
    } catch {
      /* already gone */
    }
  }

  async hasCredential(id: string): Promise<boolean> {
    return (await this.readCredential(id)) !== null
  }
}

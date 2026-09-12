/**
 * Local approval ledger for server-issued stdio MCP commands (FIX-02 P0).
 *
 * The product decision keeps the gateway's ability to ship stdio MCP servers,
 * but the FIRST spawn of every distinct `(command, args, env)` fingerprint must
 * be confirmed locally. Approved fingerprints are remembered per user so a
 * reconnect (or every later app start) does not ask again; an unapproved
 * command is simply never spawned — the connector row stays "需要授权" until
 * the user decides.
 *
 * Storage: `<user scope>/connectors/.mcp-approvals.json`, mode 0600, written
 * atomically (tmp + rename). The leading dot keeps the name outside the
 * connector-id charset, so it can never collide with `<id>.json` credentials.
 * A missing or corrupt file reads as "nothing approved" (fail closed).
 *
 * @module
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { userScopePath } from './user-scope.ts'

const FILE_NAME = '.mcp-approvals.json'
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const MAX_FILE_BYTES = 512 * 1024

/** One remembered approval. */
export interface McpApprovalRecord {
  /** `sha256` of the approved (command, args, sanitized env) tuple. */
  fingerprint: string
  /** Executable that was approved (kept for the user-facing audit trail). */
  command: string
  args: string[]
  /** Env KEY names the definition declared (values may carry no secrets). */
  envKeys: string[]
  approvedAt: number
}

export interface ConnectorApprovalStoreOptions {
  /** Override the base directory (tests). */
  baseDir?: string
  /** The logged-in username; per-user scoping when omitted/missing. */
  username?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRecord(value: unknown): McpApprovalRecord | null {
  if (!isRecord(value)) return null
  const { fingerprint, command, args, envKeys, approvedAt } = value
  if (typeof fingerprint !== 'string' || fingerprint === '') return null
  if (typeof command !== 'string') return null
  if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) return null
  if (!Array.isArray(envKeys) || !envKeys.every(item => typeof item === 'string')) return null
  if (typeof approvedAt !== 'number') return null
  return { fingerprint, command, args, envKeys, approvedAt }
}

export class ConnectorApprovalStore {
  private readonly dir: string
  private cache: McpApprovalRecord[] | null = null

  constructor(options: ConnectorApprovalStoreOptions = {}) {
    this.dir = options.baseDir ?? join(userScopePath(options.username), 'connectors')
  }

  private path(): string {
    return join(this.dir, basename(FILE_NAME))
  }

  /** Every remembered approval (empty when the file is absent or corrupt). */
  async list(): Promise<McpApprovalRecord[]> {
    if (this.cache !== null) return [...this.cache]
    try {
      const stat = await fs.lstat(this.path())
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
        this.cache = []
        return []
      }
      const parsed: unknown = JSON.parse(await fs.readFile(this.path(), 'utf8'))
      const approved = isRecord(parsed) && Array.isArray(parsed.approved) ? parsed.approved : []
      this.cache = approved.map(parseRecord).filter((record): record is McpApprovalRecord => record !== null)
    } catch {
      // Missing/corrupt ledger = nothing approved (fail closed, never throw:
      // a broken approval file must not brick every connector).
      this.cache = []
    }
    return [...this.cache]
  }

  /** Whether one fingerprint was approved before. */
  async isApproved(fingerprint: string): Promise<boolean> {
    return (await this.list()).some(record => record.fingerprint === fingerprint)
  }

  /** Remember one approval (idempotent per fingerprint) and persist atomically. */
  async approve(record: Omit<McpApprovalRecord, 'approvedAt'> & { approvedAt?: number }): Promise<McpApprovalRecord> {
    const next: McpApprovalRecord = {
      fingerprint: record.fingerprint,
      command: record.command,
      args: [...record.args],
      envKeys: [...record.envKeys],
      approvedAt: record.approvedAt ?? Date.now(),
    }
    const current = await this.list()
    const merged = [...current.filter(item => item.fingerprint !== next.fingerprint), next]
    await fs.mkdir(this.dir, { recursive: true, mode: DIRECTORY_MODE })
    const target = this.path()
    const temporary = join(this.dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temporary, 'wx', FILE_MODE)
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, approved: merged }, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.chmod(temporary, FILE_MODE)
      await fs.rename(temporary, target)
    } finally {
      await fs.unlink(temporary).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      })
    }
    this.cache = merged
    return next
  }
}

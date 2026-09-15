/** Per-user connector credential store under the product home. */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { userScopePath } from './user-scope.ts'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_CREDENTIAL_BYTES = 64 * 1024

/**
 * 凭据结构比对（唯一实现）：写后补偿用它判断"盘上还是不是我写的那一份"。
 * 逐字段比，不做 JSON 字符串比较——那会受键序影响而漏判。
 */
export function sameCredential(a: ConnectorCredential, b: ConnectorCredential): boolean {
  const fields = (value: ConnectorCredential): string =>
    Object.entries(value.fields ?? {}).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k}=${v}`).join('\u0000')
  return a.updatedAt === b.updatedAt
    && a.accessToken === b.accessToken
    && a.refreshToken === b.refreshToken
    && a.clientId === b.clientId
    && a.clientSecret === b.clientSecret
    && a.expiresAt === b.expiresAt
    && a.refreshedAt === b.refreshedAt
    && a.publicMcp === b.publicMcp
    && fields(a) === fields(b)
}

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
  /**
   * Absolute expiry of `accessToken` (epoch ms), derived from the token
   * endpoint's `expires_in` at exchange/refresh time. Optional: a credential
   * written by an older build, or by a server that omits `expires_in`, has no
   * recorded expiry — refresh correctness never depends on it (the 401 path is
   * the safety net); it drives the proactive sweep and the panel's
   * "valid until …" line.
   */
  expiresAt?: number
  /** When the last successful token refresh happened (epoch ms). */
  refreshedAt?: number
  /**
   * The MCP endpoint answered without an authorization challenge during
   * discovery (spec 2025-06-18 "public" server), so no token exists or is ever
   * issued. Persisted so a restart can tell "no credential needed" apart from
   * "authorization pending": without the marker the oauth-mode check demanded
   * an accessToken and the connector silently disappeared from every restart.
   */
  publicMcp?: boolean
  updatedAt: number
}

export interface ConnectorStoreOptions {
  /** Override the base directory (tests). */
  baseDir?: string
  /** The logged-in username; per-user scoping when omitted/missing. */
  username?: string | null
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
    // Default root: `<dshHome>/users/<encoded-user>/connectors`; a real user
    // (enterprise session) scopes credentials per account. `anonymous` is the
    // fallback so unauthenticated state never collides with a user's dir.
    this.dir = options.baseDir ?? join(userScopePath(options.username), 'connectors')
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
      // A hand-edited (or truncated) timestamp must not poison the refresh
      // cadence: only a finite positive number is a usable `expiresAt`.
      const record = value as ConnectorCredential
      if (record.expiresAt !== undefined && (!Number.isFinite(record.expiresAt) || record.expiresAt <= 0)) {
        delete record.expiresAt
      }
      if (record.refreshedAt !== undefined && !Number.isFinite(record.refreshedAt)) {
        delete record.refreshedAt
      }
      return record
    } catch {
      return null
    }
  }

  async writeCredential(id: string, credential: ConnectorCredential): Promise<void> {
    await this.exclusive(() => this.writeCredentialUnlocked(id, credential))
  }

  private async writeCredentialUnlocked(id: string, credential: ConnectorCredential): Promise<void> {
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
    // 读-改-写必须在同一段独占区里：否则两个并发 update 会互相覆盖（写后补偿的
    // 复核把这条竞态也一并暴露出来）。
    return await this.exclusive(async () => {
      const current = (await this.readCredential(id)) ?? { updatedAt: 0 }
      const next: ConnectorCredential = { ...current, ...patch, updatedAt: Date.now() }
      await this.writeCredentialUnlocked(id, next)
      return next
    })
  }

  async clearCredential(id: string): Promise<void> {
    await this.exclusive(() => this.clearCredentialUnlocked(id))
  }

  private async clearCredentialUnlocked(id: string): Promise<void> {
    try {
      await fs.unlink(this.path(id))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }

  /**
   * 原子 compare-and-delete（2026-09-15 复核实测的"读→清"竞态）。
   *
   * 场景：写后补偿原先在 store 外面做 `readCredential → 比对 → clearCredential`，
   * 读与清之间没有任何原子性 —— 更新的写入若恰好落在这个窗口里，就会被旧补偿
   * **删掉**（不是覆盖，是消失；用户新提交的凭据静默丢失、下次启动不上线）。
   * 把比较与删除放进同一段独占区，窗口即关闭。
   *
   * 并发边界（认账）：独占区是**本实例**的（同一进程内），跨进程写入不在保护范围；
   * 产品里连接器凭据只有本插件写，故此处足够。
   * @returns 真的删掉了返回 true；磁盘内容已经被别的写入换掉时返回 false。
   */
  async clearCredentialIfUnchanged(id: string, expected: ConnectorCredential): Promise<boolean> {
    return await this.exclusive(async () => {
      const current = await this.readCredential(id)
      if (current === null || !sameCredential(current, expected)) return false
      await this.clearCredentialUnlocked(id)
      return true
    })
  }

  /** 进程内串行化：凭据的读-改-写与比较-删除都排在同一条链上。 */
  private chain: Promise<unknown> = Promise.resolve()
  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => undefined, () => undefined)
    return await run
  }

  async hasCredential(id: string): Promise<boolean> {
    return (await this.readCredential(id)) !== null
  }
}

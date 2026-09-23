/**
 * Per-(account, server) connector credential store under the product home.
 *
 * Scope = `<dshHome>/users/<encoded-user>/servers/<server-hash>/connectors`
 * (`./user-scope.ts` is the single place the layout and the hash are defined).
 *
 * Upgrade cost (R6-B-2, 2026-09-24) — read this before touching the layout:
 * a credential written by an older build has no server marker, so it cannot be
 * attributed to any tenant. This store therefore does NOT adopt it: the legacy
 * directory `<dshHome>/users/<encoded-user>/connectors` is only ever probed for
 * existence, the affected connector reports "授权需要重来" /
 * "needs a fresh authorization", and the user re-authorizes each connector
 * ONCE. That is the intended, fail-closed price: the alternative (adopting the
 * file for whichever server happens to be current) is exactly the cross-tenant
 * secret replay this scope exists to stop. Deleting the old files is NOT part
 * of the migration — they are the user's record of what was authorized.
 */

import { promises as fs } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { connectorScopePath, unscopedConnectorPath } from './user-scope.ts'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_CREDENTIAL_BYTES = 64 * 1024

/**
 * 凭据结构比对（唯一实现）：写后补偿用它判断"盘上还是不是我写的那一份"。
 * 逐字段比，不做 JSON 字符串比较——那会受键序影响而漏判。
 */
export function sameCredential(a: ConnectorCredential, b: ConnectorCredential): boolean {
  // 规范化：键排序 + **长度前缀**（纯 `k=v` 用 NUL 连接时，值里含 NUL 会让两份不同
  // 凭据判成相同 —— 2026-09-15 第三轮复核给出的反例：{a:'x',b:'y'} 与
  // {a:'x\u0000b=y'}。长度前缀让拼接无歧义）。
  const fields = (value: ConnectorCredential): string =>
    Object.entries(value.fields ?? {})
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([k, v]) => `${String(k.length)}:${k}=${String(v.length)}:${v}`)
      .join('|')
  return a.updatedAt === b.updatedAt
    && a.accessToken === b.accessToken
    && a.refreshToken === b.refreshToken
    && a.clientId === b.clientId
    && a.clientSecret === b.clientSecret
    && a.expiresAt === b.expiresAt
    && a.refreshedAt === b.refreshedAt
    && a.issuer === b.issuer
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
   * The SDK's SEP-2352 `issuer` stamp: the authorization server this credential
   * was issued by.
   *
   * The SDK stamps every value it hands to `saveTokens` and checks the stamp on
   * every read (`discardIfIssuerMismatch`) — a credential stamped for another
   * authorization server reads back as "no tokens", which is what stops a
   * credential from being replayed against a different AS. The provider used to
   * drop it on the way to disk, so the isolation never engaged and the SDK
   * warned on every read (audit 2026-09-23, CN-2). Absent on credentials written
   * before this field existed; the SDK back-stamps them on first use.
   */
  issuer?: string
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
  /**
   * Override the base directory (tests).
   *
   * Bypasses the product scope resolution entirely (including the legacy
   * probe): a test base dir is a live directory by definition.
   */
  baseDir?: string
  /** The logged-in username; per-user scoping when omitted/missing. */
  username?: string | null
  /**
   * The current session's server address — the SECOND half of the scope.
   *
   * One account on two deployments (a test and a production one, two channel
   * stacks on one host) is TWO tenants: the same connector id points at two
   * different MCP endpoints, so credentials are scoped by (account, server).
   * When it is missing (logged out, no session address) the store falls back
   * to `servers/unscoped` — never to the old unscoped directory, which is
   * exactly the path that handed tenant A's secret to tenant B's endpoint.
   */
  serverURL?: string | null
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

/**
 * Connector ids whose `<id>.json` sits in `dir` — names only, never contents.
 *
 * One implementation for both the live scope ({@link ConnectorStore.credentialIds})
 * and the legacy one ({@link ConnectorStore.unscopedCredentialIds}): the filter
 * is what keeps `.mcp-approvals.json` (and any other dot file) out of a list of
 * connector ids, and it is the same `CONNECTOR_ID_PATTERN` the read path uses.
 * An unreadable/missing directory reads as "none", like every other read here.
 * @param dir - absolute directory to enumerate.
 * @returns sorted connector ids.
 */
async function listCredentialIds(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir)
    return entries
      .filter(name => name.endsWith('.json') && CONNECTOR_ID_PATTERN.test(name.slice(0, -'.json'.length)))
      .map(name => name.slice(0, -'.json'.length))
      .sort()
  } catch {
    return []
  }
}

export class ConnectorStore {
  /**
   * The resolved per-(account, server) directory this store writes to.
   *
   * Callers that outlive a session reconfiguration (an in-flight SDK 401 write,
   * a refresh) compare THIS to decide whether they still write to the account
   * they started on. Comparing store instance identity would wrongly reject a
   * same-account reconfiguration — the new instance points at the same
   * directory and the write is both safe and necessary (2026-09-16 audit R2).
   *
   * R6-B-2 (audit 2026-09-23): the server dimension is part of this identity,
   * so `TokenRefresher`'s `scopeAtStart` and the dead-grant markers keyed on it
   * (both read `store.dir`) became per-(account, server) in the same step as
   * the directory layout — one key construction point, no "judged under one key,
   * recorded under another".
   */
  readonly dir: string

  /**
   * The legacy, unscoped directory (`<dshHome>/users/<user>/connectors`), or
   * `null` when this store is a test `baseDir` override.
   *
   * Read-only by contract: {@link hasUnscopedCredential} /
   * {@link unscopedCredentialIds} only ever stat/name entries. A pre-upgrade
   * credential lives here and is NEVER adopted — the plugin turns its connector
   * into "needs a fresh authorization" instead, and leaves the bytes alone so a
   * user (or an operator) can still find them.
   */
  readonly unscopedDir: string | null

  constructor(options: ConnectorStoreOptions = {}) {
    // Default root: `<dshHome>/users/<encoded-user>/servers/<server-hash>/connectors`;
    // a real user (enterprise session) scopes credentials per account AND per
    // server. `anonymous` is the fallback so unauthenticated state never
    // collides with a user's dir; `unscoped` is the fallback for "no server
    // identity" (and never the legacy directory — see `unscopedDir`).
    this.dir = options.baseDir ?? connectorScopePath(options.username, options.serverURL)
    this.unscopedDir = options.baseDir === undefined || options.baseDir === null
      ? unscopedConnectorPath(options.username)
      : null
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
      if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
        // A hand-edited 1e999 parses to Infinity and JSON.stringify writes null
        // on the next save, after which the credential becomes unreadable. A
        // value above 2^53 also breaks `+1` monotonicity. Treat it as "no
        // timestamp": writes start from 0 and repair the file.
        record.updatedAt = 0
      }
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
      // Strictly increasing per id: two writes inside one millisecond must still
      // be ordered, because `adoptLatestRefresh` compares this value to decide
      // whether a refresh is newer than a registration's credential snapshot.
      // `Date.now()` alone collides at ms resolution and would make that
      // comparison skip a genuine catch-up (or, with `>=`, adopt a stale one).
      const now = Date.now()
      const base = Number.isSafeInteger(current.updatedAt) && current.updatedAt >= 0 ? current.updatedAt : 0
      const updatedAt = now > base ? now : base + 1
      const next: ConnectorCredential = { ...current, ...patch, updatedAt }
      await this.writeCredentialUnlocked(id, next)
      return next
    })
  }

  /**
   * Compare-and-update: apply `patch` only while the stored credential is still
   * exactly the snapshot `expected` describes.
   *
   * Refresh writes must go through this. A refresh reads a credential, spends up
   * to the outbound budget on the network, and would otherwise overwrite a newer
   * interactive re-authorization (stale tokens winning the write order) or
   * resurrect a credential the user disconnected in the meantime (the file is
   * deleted, yet `updateCredential` recreates it from `{updatedAt:0}`). Called on
   * a different user's store the comparison also fails, so a refresh that
   * outlives a user switch cannot write one account's tokens into another's.
   * @param id - connector id.
   * @param expected - the credential snapshot the refresh started from.
   * @param patch - fields to merge when the snapshot still holds.
   * @returns the persisted credential, or null when nothing was written.
   */
  async updateCredentialIfUnchanged(
    id: string,
    expected: ConnectorCredential,
    patch: Partial<ConnectorCredential>,
  ): Promise<ConnectorCredential | null> {
    return await this.exclusive(async () => {
      const current = await this.readCredential(id)
      if (current === null || !sameCredential(current, expected)) return null
      const now = Date.now()
      const base = Number.isSafeInteger(current.updatedAt) && current.updatedAt >= 0 ? current.updatedAt : 0
      const updatedAt = now > base ? now : base + 1
      const next: ConnectorCredential = { ...current, ...patch, updatedAt }
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
  /**
   * 独占区**非重入**（2026-09-15 第三轮复核）：在独占任务里再调用公开写方法
   * （`writeCredential`/`updateCredential`/`clearCredential`/`clearCredentialIfUnchanged`）
   * 会排到自己后面，凭据链路**无声挂死**（无报错、无超时）。内部实现一律用
   * `*Unlocked` 变体；这里用 AsyncLocalStorage 把误用变成显式异常 —— 并发的
   * 外部调用者不在同一 async 上下文里，不受影响。
   */
  private static readonly exclusiveScope = new AsyncLocalStorage<true>()
  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (ConnectorStore.exclusiveScope.getStore() === true) {
      throw new Error('ConnectorStore: exclusive section is not re-entrant — use the *Unlocked internals')
    }
    const run = this.chain.then(
      () => ConnectorStore.exclusiveScope.run(true, task),
      () => ConnectorStore.exclusiveScope.run(true, task),
    )
    this.chain = run.then(() => undefined, () => undefined)
    return await run
  }

  async hasCredential(id: string): Promise<boolean> {
    return (await this.readCredential(id)) !== null
  }

  /**
   * Did an **unscoped** (pre-2026-09-24) credential for `id` survive the
   * upgrade in the legacy directory?
   *
   * Existence only: the file's BYTES are never read, never parsed and never
   * returned. That is the point — a credential of unknown provenance must not
   * even enter the process, let alone get injected into the current server's
   * endpoint. The caller uses this to report "needs a fresh authorization"
   * instead of silently staying disconnected, and the file itself is left
   * exactly where it is.
   * @param id - connector id (validated before it touches the filesystem).
   * @returns true when the legacy directory holds a regular `<id>.json`.
   */
  async hasUnscopedCredential(id: string): Promise<boolean> {
    if (this.unscopedDir === null) return false
    const file = resolve(this.unscopedDir, `${assertConnectorId(id)}.json`)
    if (dirname(file) !== resolve(this.unscopedDir)) return false
    try {
      const stat = await fs.lstat(file)
      return stat.isFile() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  }

  /**
   * Ids of the credentials stored in THIS (account, server) scope.
   *
   * Names only — callers that need the material call {@link readCredential}.
   * Added for the in-process consumers that used to enumerate the directory
   * themselves with the user-scope helper (the browser's credential resolver):
   * once the layout gained the server dimension, a second enumeration site
   * would be a second place to get the scope wrong.
   * @returns sorted connector ids.
   */
  async credentialIds(): Promise<string[]> {
    return await listCredentialIds(this.dir)
  }

  /**
   * Ids of every unscoped credential file left in the legacy directory, for the
   * ONE searchable log line the plugin writes per restore pass.
   *
   * Names only (no `readCredential`, no sizes, no contents); unreadable or
   * missing directories read as "none", like every other read here.
   * @returns sorted connector ids (empty when there is nothing to report).
   */
  async unscopedCredentialIds(): Promise<string[]> {
    return this.unscopedDir === null ? [] : await listCredentialIds(this.unscopedDir)
  }
}

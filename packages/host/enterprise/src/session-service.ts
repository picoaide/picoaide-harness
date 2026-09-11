import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from './server-connector/config.ts'
import { loadElectronModule } from './server-connector/electron.ts'
import { dshHomeSafe } from 'dsh-plugin-desktop/desktop-home'
import { installDeepLinkListener } from './deep-link.ts'

/** Session token file permissions: owner read/write only. */
const TOKEN_FILE_MODE = 0o600

/**
 * Resolve the session token file: `$DSH_HOME/session.json`, falling back to
 * the product home when DSH_HOME is unset (never the process cwd — a token
 * dropped there could be world-readable and bypasses the home's 0700).
 * 审计 2026-08-25 P2-3:DSH_HOME 若指向系统关键目录则拒绝(同机注入面,
 * bearer token 不得落到攻击者可读位置)。
 *
 * 2026-09-11:缺省值走共享的 `dshHomeSafe()`(数据目录唯一权威),不再自己拼
 * `~/.picoaide-harness` —— 数据根随渠道(渠道客户端由主进程写 DSH_HOME),
 * 这里抄一份常量就会在改渠道目录时漏掉,于是 token 落回官方目录。
 */
export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHomeSafe({ env }), 'session.json')
}

/** Cordis event emitted whenever the session is set, restored, or cleared. */
export const SESSION_CHANGED_EVENT = 'pico/session-changed'

/**
 * 订阅会话变更，并**补发启动时那一次**。
 *
 * 为什么不能只用 `ctx.on(SESSION_CHANGED_EVENT, …)`：`restore()` 在
 * `SessionService` 的**构造期**就启动了（见构造函数），而它完成得比后续插件的
 * `apply` 早还是晚，取决于动态 import（electron）与文件读的耗时 —— 与插件装载
 * 顺序无关。于是"应用重启后带着有效会话"这一最常见的启动路径上，首个事件经常在
 * 消费方订阅**之前**就发完了：消费方要等到下一次登录/登出才同步。
 *
 * 现场证据（2026-09-05，v2.6.4）：升级后旧会话下视觉模型缺 `inputModalities`、
 * 上传图片被拒，重新登录即恢复（bootstrap 的同步就这么被跳过了）。
 * 2026-09-10 同一根因又表现为白标 logo 裂图：客户端 store 的首次播种拿到的是本地
 * 端点的载荷，而服务端驱动的渠道内容（绝对化的 logo/名称/主题色）一直没到。
 *
 * 判据用现成的 `isRestored()`：它在 `restore()` 的 `finally` 里置位，而事件是在那
 * 之前 `emit` 的。所以 `isRestored() === false` ⇒ 那次 emit 还没发生（后续必然收到），
 * `=== true` ⇒ 已经错过（这里立即补一次）。两个方向都不重不漏。
 * @param ctx - 宿主插件上下文（需注入 `picoSession`）。
 * @param listener - 收到会话（或 null）时的回调。
 * @returns 取消订阅的函数。
 */
export function subscribeSession(
  ctx: Context,
  listener: (session: Session | null) => void,
): () => void {
  const off = ctx.on(SESSION_CHANGED_EVENT, listener)
  // 补发只针对"恢复完成"那一刻的状态；此刻 session 可能是 null（没有持久化会话），
  // 那也是消费方必须知道的状态（等于"未登录"），与事件语义一致。
  if (ctx.picoSession.isRestored()) listener(ctx.picoSession.getSession())
  return off
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    picoSession: SessionService
  }
  interface Events {
    'pico/session-changed'(session: Session | null): void
  }
}

/**
 * Session service configuration.
 *
 * `tokenFile` defaults to `$DSH_HOME/session.json`. `deepLinkScheme` 由桌面壳在
 * 组装期注入（渠道构建是客户自己的 scheme，如 `acmeai`）；缺省官方值。
 */
export interface Config {
  tokenFile?: string
  deepLinkScheme?: string
}

export const Config: z<Config> = z.object({
  tokenFile: z.string(),
  deepLinkScheme: z.string(),
})

/**
 * Enterprise session state, restored from an encrypted token file and exposed
 * as the `picoSession` service. Emits `pico/session-changed` on every change.
 */
export default class SessionService extends Service {
  static Config = Config

  private session: Session | null = null
  private readonly tokenFile: string
  private restoreDone = false
  // F7(审计 2026-09-11):持久化代际 —— persist 是异步的(先 await 动态
  // import),若期间 clear()/setSession() 已发生,迟到的写入会让已登出的
  // token 在磁盘"复活"。每次会话变化递增,persist 写盘前校验代际。
  private persistEpoch = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'picoSession')
    this.tokenFile = config.tokenFile ?? defaultTokenFile()
    // picoaide:// deep-link auth (OIDC/OpenID callback): store the session
    // when a valid link arrives. Emits pico/session-changed → auth-gate
    // reloads into the app (login page poll sees loggedIn).
    // scheme 用桌面壳注入的本安装值（渠道构建是自己的），见 installDeepLinkListener。
    installDeepLinkListener(ctx, (session) => {
      this.setSession(session)
    }, () => this.getSession(), config.deepLinkScheme)
    void this.restore().finally(() => { this.restoreDone = true })
  }

  isLoggedIn(): boolean {
    return this.session !== null
  }

  /**
   * True once the persisted session has been restored (or found absent).
   * P1-11: the auth gate must not render the login page while restoration
   * is still in flight — a valid persisted session would flash a login
   * form and invite a duplicate log-in.
   */
  isRestored(): boolean {
    return this.restoreDone
  }

  getSession(): Session | null {
    return this.session
  }

  setSession(session: Session): void {
    this.session = session
    const epoch = ++this.persistEpoch
    // P1-13: a failed token write ($DSH_HOME read-only / ENOSPC / ROFS / a
    // missing parent dir) must never become an unhandled rejection — the
    // desktop fail-loud handler treats those as fatal and exits the whole app.
    // Degrade: keep the in-memory session for this run, warn once per failure,
    // and let the next successful login persist again.
    void persist(this.tokenFile, session, () => epoch === this.persistEpoch).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.ctx.logger?.warn(`[pico] session token could not be persisted (${this.tokenFile}): ${message}`)
    })
    this.ctx.emit(SESSION_CHANGED_EVENT, session)
  }

  clear(): void {
    this.session = null
    this.persistEpoch++ // F7: 使所有在途 persist 失效,不再复活旧 token
    try { unlinkSync(this.tokenFile) } catch { /* absent is fine */ }
    this.ctx.emit(SESSION_CHANGED_EVENT, null)
  }

  private async restore(): Promise<void> {
    const restored = await loadPersisted(this.tokenFile)
    if (this.session !== null) return
    this.session = restored
    this.ctx.emit(SESSION_CHANGED_EVENT, restored)
  }
}

async function loadPersisted(tokenFile: string): Promise<Session | null> {
  try {
    const mod = await loadElectronModule()
    const ss = mod?.safeStorage
    if (!ss) return null
    if (!existsSync(tokenFile)) return null
    const raw = readFileSync(tokenFile)
    // 双格式恢复(2026-09-01 审计):safeStorage 后端可在两次运行间切换
    // (有 keyring ↔ basic_text)——旧加密文件遇 basic_text 会走明文解析失败、
    // 旧明文文件遇可用 keyring 会走 decryptString 失败;两端分别回退,
    // 避免跨后端切换后丢失已存 session 被迫重新登录(旧注释引用不存在的
    // loadLegacyEncrypted,实际从未实现该兼容)。
    // P1-10: on Linux without a keyring (basic_text backend) safeStorage is
    // effectively plaintext, so it is not a security improvement over our own
    // 0600 file — but refusing to persist at all forces a re-login on every
    // launch. Fall back to the 0600 file (TOKEN_FILE_MODE keeps it owner-only)
    // so a headless/minimal desktop still remembers the session.
    let keyringAvailable = false
    if (ss.isEncryptionAvailable() && !isBasicTextBackend(ss)) {
      try {
        return JSON.parse(ss.decryptString(raw).toString('utf8')) as Session
      } catch {
        keyringAvailable = true // 解密失败:文件可能是 basic_text 期间写的明文
      }
    }
    try {
      return JSON.parse(raw.toString('utf8')) as Session
    } catch {
      // 有 keyring 但明文解析失败:回退 decrypt(跨后端切回来的加密文件)。
      if (keyringAvailable) {
        return JSON.parse(ss.decryptString(raw).toString('utf8')) as Session
      }
      return null
    }
  } catch { return null }
}

function isBasicTextBackend(ss: { getSelectedStorageBackend?: () => string }): boolean {
  return typeof ss.getSelectedStorageBackend === 'function' && ss.getSelectedStorageBackend() === 'basic_text'
}

async function persist(tokenFile: string, s: Session, stillCurrent: () => boolean): Promise<void> {
  const mod = await loadElectronModule()
  if (!stillCurrent()) return // F7: 期间已登出/换号,丢弃过期写入
  const ss = mod?.safeStorage
  if (!ss || !ss.isEncryptionAvailable() || isBasicTextBackend(ss)) {
    // P1-10 fallback: owner-only plaintext. The token is an opaque bearer
    // credential with its own server-side TTL; 0600 on the file is the best
    // guard available without a keyring. Warn once so the operator knows
    // the dependency (gnome-keyring/kwallet) would harden this.
    console.warn('[pico] token persisted as 0600 plaintext: no safeStorage keyring available')
    if (!stillCurrent()) return // F7(二次校验:await 之后仍可能变化)
    writeFileSync(tokenFile, JSON.stringify(s), { mode: TOKEN_FILE_MODE })
    return
  }
  // Owner-only mode: the encrypted token must not be readable by other
  // local users even if the home directory permissions are loose.
  if (!stillCurrent()) return // F7
  writeFileSync(tokenFile, ss.encryptString(JSON.stringify(s)), { mode: TOKEN_FILE_MODE })
}

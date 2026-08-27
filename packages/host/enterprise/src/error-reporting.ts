import type { Context } from '@deepseek-ai/cordis'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { getBootstrap } from './server-connector/bootstrap.ts'
import type { Session } from './server-connector/config.ts'

/**
 * 客户端错误监控(feat/error-monitoring 2026-08):
 * 会话建立后,从服务端 bootstrap 的 `web.error_reporting_dsn` 读取 Sentry
 * 兼容 DSN(如自托管 GlitchTip),初始化 @sentry/electron 主进程采集;
 * 未捕获异常/未处理 rejection/console.error(Error 级)自动上报。
 *
 * 安全约束:DSN 一律由服务端下发(管理员在 webadmin 网关页配置),
 * 源码与本地配置不含任何上报地址。
 */
export const name = 'error-reporting'

/** Services consumed: the session service providing login/logout lifecycle. */
export const inject = ['picoSession']

/** Desktop release 版本:与 enterprise package.json 对齐(0.1.0);
 * 后续如需注入产品版本,改为 tsdown define + typeof 防护,避免未定义引用。 */
const VERSION = '0.1.0'

/** Active Sentry instance (only one at a time; null = not initialized). */
type SentryModule = { close: (timeout: number) => Promise<boolean> }
let sentry: SentryModule | null = null

/**
 * 初始化(或重置)Sentry。DSN 空串 = 停止上报并关闭旧实例。
 * 用 @sentry/node(无 Electron app ready 时序限制):登录后动态拿 DSN 可
 * 随时 init/close;采集主进程未捕获异常/未处理 rejection。
 * 渲染进程采集(extension 集成)后续阶段接入。
 */
export async function initSentry(dsn: string, release: string): Promise<void> {
  if (sentry !== null) {
    // 重新初始化前先关闭旧实例(登出/切换 DSN)
    try {
      sentry.close(0)
    } catch { /* ignore */ }
    sentry = null
  }
  const normalized = dsn.trim()
  if (!normalized) return
  try {
    const mod = await import('@sentry/node')
    const init = (mod as unknown as { init: (o: Record<string, unknown>) => void }).init
    init({
      dsn: normalized,
      release,
      // defaultIntegrations 缺省为 true(7.x);显式传 true 会因版本差异
      // 触发 forEach 报错,故不传
    })
    sentry = mod as unknown as SentryModule
  } catch (cause) {
    // DSN 非法/加载失败静默降级(不影响客户端主体功能)
    console.warn('error-reporting: Sentry init 失败(降级不启用):', cause)
    sentry = null
  }
}

/** Apply: watch session changes and keep Sentry in sync with the server DSN. */
export function apply(ctx: Context): void {
  // release 用桌面客户端包版本(粗粒度够用;sourcemap 可按需细化)。
  // 编译期由 tsdown define 注入;缺省回退 "0.1.0"(与 enterprise package.json 一致)。
  const release = `picoaide-desktop@${VERSION}`

  const sync = async (session: Session | null): Promise<void> => {
    if (session === null) {
      await initSentry('', release)
      return
    }
    try {
      const { config } = await getBootstrap(session)
      const dsn = config.web?.error_reporting_dsn ?? ''
      await initSentry(dsn, release)
    } catch (cause) {
      // bootstrap 失败不阻断;登录成功但上报配置拿不到时静默
      ctx.logger?.warn?.('error-reporting: bootstrap 失败,不上报:', cause)
    }
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch((cause) => ctx.logger.error(cause)) })
}

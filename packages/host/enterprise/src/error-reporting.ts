import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { getBootstrap } from './server-connector/bootstrap.ts'
import type { Session } from './server-connector/config.ts'
// 静态 import @sentry/node(external,运行时加载节点模块;动态 import 会被
// tsdown 拆 chunk 导致运行时解析挂起——已加日志确认 dsn 拿到后 init 卡住)。
import * as SentryNode from '@sentry/node'

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

/** Desktop release 版本:从 dsh-plugin-desktop 包读取真实产品版本(如 2.4.0),
 * 用于 GlitchTip 按版本区分报错(release 字段)。读取失败回退 0.1.0。 */
const DESKTOP_PACKAGE_REQUIRE = createRequire(import.meta.url)
const DESKTOP_VERSION: string = (() => {
  try {
    return (DESKTOP_PACKAGE_REQUIRE('dsh-plugin-desktop/package.json') as { version?: string }).version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
})()

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
    const mod = SentryNode as unknown as { init: (o: Record<string, unknown>) => void; captureMessage: (m: string, l?: unknown) => void }
    mod.init({
      dsn: normalized,
      release,
      // defaultIntegrations 缺省为 true(7.x);显式传 true 会因版本差异
      // 触发 forEach 报错,故不传
    })
    sentry = SentryNode as unknown as SentryModule
    // 链路自检(联调 2026-08-27):init 成功后发一条 info 级事件,
    // 验证「客户端 → GlitchTip」上报通;正式版本可移除或降级为 debug。
    try {
      mod.captureMessage(`客户端已启动,错误监控已启用 (${release})`, 'info' as unknown as undefined)
    } catch { /* 自检失败不影响 */ }
  } catch (cause) {
    // DSN 非法/加载失败静默降级(不影响客户端主体功能)
    console.warn('error-reporting: Sentry init 失败(降级不启用):', cause)
    sentry = null
  }
}

/** Apply: watch session changes and keep Sentry in sync with the server DSN. */
export function apply(ctx: Context): void {
  // 诊断日志(联调 2026-08-27):确认插件挂载与 session 事件触发
  console.log('[error-reporting] plugin applied')
  // release 用桌面客户端包版本(粗粒度够用;sourcemap 可按需细化)。
  // 编译期由 tsdown define 注入;缺省回退 "0.1.0"(与 enterprise package.json 一致)。
  const release = `picoaide-desktop@${DESKTOP_VERSION}`

  const sync = async (session: Session | null): Promise<void> => {
    console.log('[error-reporting] session-changed:', session ? session.username : 'null')
    if (session === null) {
      await initSentry('', release)
      return
    }
    try {
      const { config } = await getBootstrap(session)
      const dsn = config.web?.error_reporting_dsn ?? ''
      console.log('[error-reporting] dsn from bootstrap:', dsn ? dsn.slice(0, 30) + '...' : '(empty)')
      await initSentry(dsn, release)
    } catch (cause) {
      // bootstrap 失败不阻断;登录成功但上报配置拿不到时静默
      console.warn('[error-reporting] bootstrap 失败,不上报:', cause)
      ctx.logger?.warn?.('error-reporting: bootstrap 失败,不上报:', cause)
    }
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch((cause) => ctx.logger.error(cause)) })
  // 兜底(联调 2026-08-27):UI 登录可能在事件注册后但 getSession 尚未
  // 赋值时发生;1s 间隔轮询当前 session(最多 60s),发现登录即同步。
  // 与 auth-gate 相同,直接使用注入的 ctx.picoSession(TS 声明已提供,
  // 此前误用类型断言导致访问到未注入实例返回 null)。
  // CI 修复(2026-08-27):定时器必须跟随 context 生命周期清理,避免
  // context 关闭后回调访问 picoSession 抛 "inactive context" 崩溃。
  if (!ctx.picoSession) {
    console.warn('[error-reporting] picoSession 服务不可用,仅事件驱动')
  } else {
    let polls = 0
    let finished = false
    const timer = setInterval(() => {
      if (finished) return
      polls += 1
      try {
        const session = ctx.picoSession.getSession()
        if (session) {
          finished = true
          clearInterval(timer)
          void sync(session).catch((cause) => ctx.logger.error(cause))
        } else if (polls >= 60) {
          finished = true
          clearInterval(timer)
        }
      } catch {
        // context 已关闭等异常:停止轮询,不再崩溃
        finished = true
        clearInterval(timer)
      }
    }, 1000)
    // context 生命周期清理:插件卸载时停掉轮询(effect,与 try/catch 双重防护)
    ctx.effect(() => {
      return () => {
        finished = true
        clearInterval(timer)
      }
    })
  }
}

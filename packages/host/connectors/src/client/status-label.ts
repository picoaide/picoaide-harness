/**
 * 连接器状态列文案（2026-09-15 审计 BUG-07 的判别力修复）。
 *
 * 独立成模块的原因：旧实现是 `ConnectorsSection.tsx` 里的**模块级常量**
 * （`const statusText = { disconnected: t('status.disconnected'), … }`），`t()`
 * 在模块求值期（apply 之前）就把默认语言捕获死了。把它抽出来，回归用例才能
 * 直接断言"切语言后标签跟着变"——留在组件文件里，测试只能渲染组件，而
 * "模块级常量"这个根因是渲染测试抓不到的（复核实测：把实现改回常量形态，
 * 整个 connectors 包 291 个用例全绿）。
 */
import { t, type ConnectorsKey } from './locales.ts'

const STATUS_KEYS = {
  disconnected: 'status.disconnected',
  connecting: 'status.connecting',
  connected: 'status.connected',
  unauthorized: 'status.unauthorized',
  error: 'status.error',
} as const

/** 状态 → 当次渲染该用的文案（未知状态原样透出）。 */
export function statusLabel(status: string): string {
  const key = (STATUS_KEYS as Record<string, ConnectorsKey | undefined>)[status]
  return key === undefined ? status : t(key)
}

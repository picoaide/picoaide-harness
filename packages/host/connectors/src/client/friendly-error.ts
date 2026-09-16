/**
 * 连接器/CLI 原始错误 → 用户可读文案（P3-6）。
 *
 * 独立于 `locales.ts` 的原因（2026-09-15 BUG-07 修复时踩到）：桌面包的 i18n
 * 死键守卫（`packages/host/desktop/tests/i18n-keys.spec.ts`）要求每个字典键都被
 * **字典文件之外**的客户端源码引用；把映射逻辑留在字典文件里会让它新加的
 * `error.*` 键被判成死键。
 */
import { t } from './locales.ts'

/** Map raw connector/CLI errors to user-facing copy (P3-6). */
export function friendlyConnectorError(raw: string): string {
  if (raw.includes('退出码')) return t('error.exitCode')
  // The node side names the missing binary and its install command; show it
  // verbatim so the user knows what to install (e.g. npm install -g beisen-cli).
  if (raw.includes('未找到命令')) return raw
  // Download-on-demand errors carry specific detail; surface them verbatim.
  if (raw.includes('下载')) return raw
  if (raw.includes('ENOENT')) return t('error.commandMissing')
  if (raw.includes('token') || raw.includes('授权') || raw.includes('登录')) return raw
  return t('error.generic', { message: raw })
}

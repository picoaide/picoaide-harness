/**
 * 连接器/CLI 原始错误 → 用户可读文案（P3-6）。
 *
 * 独立于 `locales.ts` 的原因（2026-09-15 BUG-07 修复时踩到）：桌面包的 i18n
 * 死键守卫（`packages/host/desktop/tests/i18n-keys.spec.ts`）要求每个字典键都被
 * **字典文件之外**的客户端源码引用；把映射逻辑留在字典文件里会让它新加的
 * `error.*` 键被判成死键。
 *
 * 2026-09-16 i18n 契约变更（**这是本文件的重点**）
 * ----------------------------------------------
 * 旧实现按**中文字串**分类（`raw.includes('退出码' | '未找到命令' | '下载' |
 * '授权' | 'token' | '登录')`）。Host 文案一旦随语言走，这些匹配在英文界面下
 * 全部落空：`需要先完成授权…` 的英文文本不含 `授权`，于是每条具体错误都退化成
 * 通用兜底（"Connection failed: …"）。字串匹配还把"文案"变成了跨进程的隐式
 * 契约 —— 改一个字就静默坏掉。
 *
 * 现在的契约（见 `../connector-error.ts`）：
 *  1. Host 给"它自己产生、会跨到面板的错误"挂一个语言无关的 code，随状态一起
 *     下发（`errorCode` 字段，或请求响应体里的同名字段）；
 *  2. 客户端只按 code 映射；唯一的字串判据是 OS 级的 `ENOENT`（不是自然语言，
 *     任何语言下都一样）；
 *  3. **什么都不匹配的原始信息仍然回落到通用兜底**，信息不丢（附录在文案里）。
 */
import { type ConnectorErrorCode } from '../connector-error.ts'
import { t } from './locales.ts'

/**
 * Map a raw connector/CLI error to user-facing copy.
 * @param raw - the raw message as the host (or the OS) produced it.
 * @param code - the host's stable, locale-independent code when it sent one.
 * @returns the copy to render.
 */
export function friendlyConnectorError(raw: string, code?: ConnectorErrorCode): string {
  if (code === 'exit-code') return t('error.exitCode')
  // The node side names the missing binary and its install command; show it
  // verbatim so the user knows what to install (e.g. npm install -g beisen-cli).
  if (code === 'command-missing') return raw
  // Download-on-demand errors carry specific detail; surface them verbatim.
  if (code === 'download') return raw
  // "Authorize again" errors already say what to do (and in which server/tool
  // they happened); the wrapper would only bury that detail.
  if (code === 'auth-required') return raw
  // Locale-independent OS-level fallback: a spawn failure for a missing binary
  // reads `ENOENT` in every language.
  if (raw.includes('ENOENT')) return t('error.commandMissing')
  // Nothing classified this message (an older host build, another producer, an
  // unexpected failure): keep the raw detail inside the generic wrapper rather
  // than swallowing it.
  return t('error.generic', { message: raw })
}

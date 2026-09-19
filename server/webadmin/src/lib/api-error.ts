/**
 * 服务端错误信封的统一渲染(P1-6,2026-09-19)。
 *
 * 三种结构必须**一次读全**,否则管理端会把服务端已经说清楚的原因丢掉:
 *   - `error.message` —— 人话结论;
 *   - `error.details.field` —— "是哪个字段被拒"(表单类错误的关键信息,
 *     没有它管理员只能对着一个 400 猜);
 *   - `error.hints` —— 可操作建议(设计基线明写"第一消费者是 AI":hints 说的
 *     是"下一步改什么",不是复述错误码)。
 *
 * 取值只走 `ApiError`(api.ts 已把三段解析进 hints/details),页面**不要**再自己
 * `err?.hints` —— 曾经 `AppCenter.tsx` 就是这么写的,而 ApiError 上根本没有
 * hints,那段是死代码,测试还用手工挂属性的方式让它恒绿。
 */

/** 错误信封里 details 段的最小形状(只声明我们渲染的字段)。 */
interface ErrorLike {
  message?: string
  hints?: unknown
  details?: unknown
}

/** 归一化 hints:只认非空字符串(服务端理论上恒为 string[],这里防御脏数据)。 */
export function errorHints(err: unknown): string[] {
  const raw = (err as ErrorLike | null | undefined)?.hints
  if (!Array.isArray(raw)) return []
  return raw.filter((h): h is string => typeof h === 'string' && h.trim() !== '')
}

/** details.field(如有):服务端用 field 指出被拒的字段名。 */
export function errorField(err: unknown): string {
  const details = (err as ErrorLike | null | undefined)?.details
  if (details === null || typeof details !== 'object') return ''
  const field = (details as Record<string, unknown>).field
  return typeof field === 'string' ? field : ''
}

/**
 * 把错误渲染成一行可读文本:`message + (字段 X) + hints`。
 *
 * 顺序固定:先说结论,再说"哪个字段",最后给建议 —— 管理员从上往下读就能知道
 * 发生了什么、该改什么。fallback 只在服务端连 message 都没给时使用。
 */
export function errorText(err: unknown, fallback: string): string {
  const message = ((err as ErrorLike | null | undefined)?.message as string | undefined) || fallback
  const field = errorField(err)
  const parts = [message]
  if (field !== '') parts.push(`(字段 ${field})`)
  parts.push(...errorHints(err))
  return parts.join(' ')
}

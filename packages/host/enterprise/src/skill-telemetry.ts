import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSkillsDir } from './skill-install.ts'

/**
 * 技能使用量上报客户端(0040):
 * 客户端在技能被真正调用后(模型侧 `skill` 工具执行成功,或用户 `/name`
 * 手势内容注入),向后端 `POST /api/client/v2/telemetry/skill-call` 上报 name+version,
 * 服务端累加 shared_skills(有版本)或 skills(市场)行的调用计数。
 *
 * 设计约束:
 * - 两条调用路径都会上报(同一技能一次加载 = 一次计数):
 *   ①模型调 `skill` 工具 → `tools/result` 观察者(执行成功,非错误);
 *   ②用户 `/name` 手势 → `agent/pre-step` 注入的 skill-invocation 用户消息
 *     (session/event `user/message`,source.kind='skill-invocation')。
 * - 版本从安装目录 `.install-version` 尽力读取(共享技能按版本计数);
 *   读不到报空版本,服务端回落按名字计数(市场行)。
 * - 上报失败静默(不阻塞/不重试风暴);callId/消息 id 作为幂等键。
 * - 未登录(无 session)不报。
 */

export const name = 'skill-telemetry'

/** Services consumed: the session service (bearer token). */
export const inject = ['picoSession', 'tools']

// ---- 可靠性窗口:同一调用只报一次 ----
const reported = new Set<string>()

function reportKey(name: string, version: string | undefined, id: string): string {
  return `${name}@${version ?? ''}#${id}`
}

/**
 * 统一上报入口(尽力而为)。返回是否已发送(未登录/已报过不重复)。
 * @param session - 当前会话(null = 未登录)。
 * @param name - 技能名。
 * @param version - 已安装版本(未知时 undefined,服务端按名字计数)。
 * @param id - 幂等键(工具 callId 或用户消息 id)。
 */
export async function reportSkillCall(
  session: Session | null,
  name: string,
  version: string | undefined,
  id: string,
): Promise<boolean> {
  if (session === null) return false
  if (name === '' || name.includes('/') || name.includes('\\')) return false
  const key = reportKey(name, version, id)
  if (reported.has(key)) return false
  reported.add(key)
  try {
    await fetchJSON(session.serverURL, '/api/client/v2/telemetry/skill-call', {
      token: session.token,
      method: 'POST',
      body: { name, version: version ?? '' },
      timeoutMs: 5000,
    })
    return true
  } catch (cause) {
    // 上报失败不影响主链路;key 已入集,同一调用不会反复重试风暴。
    console.warn('[skill-telemetry] 上报失败:', cause instanceof Error ? cause.message : cause)
    return false
  }
}

/** 尽力读取已安装技能版本(`.install-version`,安装器写入;读失败 = 未知)。 */
async function installedVersion(name: string): Promise<string | undefined> {
  try {
    const v = await readFile(join(resolveSkillsDir(), name, '.install-version'), 'utf8')
    const trimmed = v.trim()
    return trimmed === '' ? undefined : trimmed
  } catch {
    // 未安装/目录不可用(含 DSH_HOME 未设置时 resolveSkillsDir 抛出的
    // 安全拒绝)——按未知版本继续上报(服务端按名字计数)。
    return undefined
  }
}

/**
 * 插件入口:注册两个观察者。
 * - `tools/result`:模型 `skill` 工具成功返回 → 上报。
 * - `session/event`:skill-invocation 用户消息(用户 `/name` 手势注入内容)
 *   → 上报。
 */
export function apply(ctx: Context): void {
  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    if (exec.name !== 'skill') return
    if (result.isError) return
    const args = exec.arguments as { name?: unknown } | null
    const skillName = typeof args?.name === 'string' ? args.name : ''
    if (skillName === '') return
    void installedVersion(skillName)
      .then((version) => reportSkillCall(ctx.picoSession.getSession(), skillName, version, String(exec.callId)))
  })

  ctx.on('session/event', (_session, event: SessionEvent) => {
    if (event.type !== 'user/message') return
    const source = event.data.source as { kind?: unknown; name?: unknown }
    if (source?.kind !== 'skill-invocation') return
    const skillName = typeof source.name === 'string' ? source.name : ''
    if (skillName === '') return
    void installedVersion(skillName)
      .then((version) => reportSkillCall(ctx.picoSession.getSession(), skillName, version, String(event.data.id)))
  })

  // picoSession 声明依赖 + 会话变更时无需重挂监听(会话在调用时惰性读取)。
  ctx.on(SESSION_CHANGED_EVENT, () => { /* lazily read at call time */ })
}

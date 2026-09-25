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
 * - 幂等键带**作用域**:当前登录账号 + 服务端(见 {@link reportScope})。同一个技能在
 *   两个账号/两个服务端下各自计数 —— 只按名字记,一个账号的"已上报"会把此后所有
 *   账号的同名调用拦在 POST 之前(服务端技能用量系统性少计)。
 * - 幂等集合是**有界 LRU**({@link REPORTED_LIMIT} 条,超限淘汰最旧)。会话/账号变更
 *   时**不清空**:作用域已经在键里,清空只会让同一账号的同一调用被重复计数。
 * - **无 id 的调用不参与去重**。上游适配器在不回传 `tool_calls[].id` 时给出的 callId
 *   是空串(`llm-deepseek` 的 chat-completions 适配器写 `block.callId ?? ''`,中间汇编器
 *   也拦不住空串),此时**无法区分**"同一次调用的重复观察"与"两次真实调用"。两条观察
 *   路径各自只触发一次(tools/result 的 callId / session/event 的消息 id),所以宁可
 *   如实各计一次,也不能让一个空 id 把此后所有会话与账号的同一技能都拦在 POST 之前
 *   —— 一次多计的误差有界,系统性少计没有。有 id 时(非空)仍按 id 去重。
 */

export const name = 'skill-telemetry'

/** Services consumed: the session service (bearer token). */
export const inject = ['picoSession', 'tools']

// ---- 可靠性窗口:同一调用只报一次(键带账号+服务端作用域,集合有上界) ----

/**
 * 幂等集合的条目上限(超出淘汰最旧的一条)。
 *
 * 为什么必须有上界:集合是**进程级**的,而一台长跑客户端上的调用 id 是无限的
 * (每次工具调用一个 callId),没有上界就是一条只增不减的内存泄漏。512 条足以覆盖
 * "同一次调用被两条观察路径先后看到"的时间窗(两条路径在同一回合内),同时把常驻
 * 内存钉在常数级别。
 */
export const REPORTED_LIMIT = 512

/**
 * 一次上报的**作用域**:当前登录账号 + 服务端,两段各自 trim 归一(服务端去掉尾斜杠,
 * 否则 `https://h` 与 `https://h/` 会被当成两个作用域、同一账号被重复计数)。
 *
 * 与既有 `deadGrants` 同形:判定/记账/清账共用这一个键构造点,而不是各自拼字符串。
 * 只按技能名记会让一个账号的"已上报"去重掉另一个账号的真实调用。
 */
export function reportScope(session: Session): string {
  let server = session.serverURL.trim()
  // 循环而非正则(与本文件外的 normalizeServerURL 同风格:不引入反斜杠转义)。
  while (server.endsWith('/')) server = server.slice(0, -1)
  return `${server}\u0000${session.username.trim()}`
}

/**
 * 幂等键。四段用 `\u0000` 分隔(作用域/名字/版本/id):技能名与版本里可能出现 `@`/`#`/`:`,
 * 裸拼接会让不同的三元组撞成同一个键(`a`+`b@c` 与 `a@b`+`c`),NUL 不可能出现在这些
 * 取值里(路径与 JSON 文本都进不来 NUL),因此不会歧义。
 */
export function reportKey(session: Session, name: string, version: string | undefined, id: string): string {
  return `${reportScope(session)}\u0000${name}\u0000${version ?? ''}\u0000${id}`
}

/** 幂等集合:插入序 = 最近使用序(LRU),命中前移,超限淘汰最旧。 */
const reported = new Map<string, true>()

/** 记入幂等集合:命中/重新上报都前移到最新,并把集合收在上限内。 */
function remember(key: string): void {
  reported.delete(key)
  reported.set(key, true)
  while (reported.size > REPORTED_LIMIT) {
    const oldest = reported.keys().next()
    if (oldest.done === true) break
    reported.delete(oldest.value)
  }
}

/**
 * **仅供测试**:当前幂等集合的条目数。
 * 存在的理由:内存态本身没有对外读数,"长跑不涨"这条判据就只能靠断言返回值,
 * 而返回值对有界/无界两种实现是一样的(都必须每调用一次发一次)。
 */
export function __reportedSizeForTest(): number {
  return reported.size
}

/**
 * 把观察点给的 id 归一成"可用的幂等键"(空串 = 没有 id)。
 * `String(undefined)` 会变成字面量 `"undefined"`,那会把所有缺 id 的调用坍缩成同一个键
 * —— 与空串同一个故障形态,所以在取值处就归一(不退化成按字面量判断)。
 */
function callIdOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  return text.trim() === '' ? '' : text
}

/**
 * 统一上报入口(尽力而为)。返回是否已发送(未登录/已报过不重复)。
 *
 * 去重只在**有非空 id**时生效;空 id 每次都发(理由见模块头:无法区分重复观察与真实
 * 调用,而一次多计 << 系统性少计)。
 * @param session - 当前会话(null = 未登录)。
 * @param name - 技能名。
 * @param version - 已安装版本(未知时 undefined,服务端按名字计数)。
 * @param id - 幂等键(工具 callId 或用户消息 id);空白/缺失 = 不做去重。
 */
export async function reportSkillCall(
  session: Session | null,
  name: string,
  version: string | undefined,
  id: string,
): Promise<boolean> {
  if (session === null) return false
  if (name === '' || name.includes('/') || name.includes('\\')) return false
  const callId = callIdOf(id)
  const key = reportKey(session, name, version, callId)
  if (callId !== '') {
    if (reported.has(key)) {
      // 命中也是"最近使用":不前移的话,一条反复命中的旧键会被后来的新键顶掉,
      // 同一调用就会被重复计数(这正是 LRU 与"插入序 FIFO"的区别所在)。
      remember(key)
      return false
    }
    remember(key)
  }
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
      .then((version) => reportSkillCall(ctx.picoSession.getSession(), skillName, version, callIdOf(exec.callId)))
  })

  ctx.on('session/event', (_session, event: SessionEvent) => {
    if (event.type !== 'user/message') return
    const source = event.data.source as { kind?: unknown; name?: unknown }
    if (source?.kind !== 'skill-invocation') return
    const skillName = typeof source.name === 'string' ? source.name : ''
    if (skillName === '') return
    void installedVersion(skillName)
      .then((version) => reportSkillCall(ctx.picoSession.getSession(), skillName, version, callIdOf(event.data.id)))
  })

  // picoSession 声明依赖 + 会话变更时无需重挂监听(会话在调用时惰性读取)。
  //
  // 会话/账号变更时**刻意不清空**幂等集合:作用域(账号 + 服务端)已经在键里,所以
  // 换账号后别人的条目根本不会被命中;清空反而会把同一账号在同一次会话里已经上报过
  // 的调用再发一遍(重复计数)。集合的收敛交给 LRU 上界,不交给"切换即清"。
  ctx.on(SESSION_CHANGED_EVENT, () => { /* lazily read at call time; dedupe set is scoped, not cleared */ })
}

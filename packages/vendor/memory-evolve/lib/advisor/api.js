/**
 * Advisor HTTP API（实施规划 §五 契约 v2）。
 *
 * Base：/memory-evolve/api/advisor。端点：
 *
 *   GET    /status?sessionId=            → 会话状态（契约字段）
 *   GET    /events?sessionId=&after=&limit= → live 事件（seq 游标 + gap）
 *   GET    /records?sessionId=&workspace=&severity=&before=&limit= → 终态记录
 *   POST   /instructions   { sessionId, text } → 发指令
 *   GET    /instructions?sessionId=      → 待处理指令
 *   DELETE /instructions?sessionId=      → 清空 pending
 *   POST   /toggle         { sessionId, enabled } → 会话级开关
 *   GET    /config                       → 全局配置（只读）
 *   PATCH  /config         { patch }     → 写全局配置（走 ctrl.reconfigure）
 *   GET    /scopes?sessionId=            → 四层级约束（项目/会话/评审会话）
 *   PUT    /scopes         { sessionId, level, text } → 保存某层约束
 *
 * 安全（双审 MAJOR-9）：写接口强制 application/json + Origin/Host 同源 +
 * body ≤64KB；错误统一 { ok:false, code, error } + 恰当状态码；未知端点
 * 404。请求策略自 2026-09-13（FIX-27 / me-3）起走**共享实现**
 * lib/http-guard.js（guardRequestReasoned）——此前这里是第 10 份手写副本，
 * 缺共享实现的读侧策略（跨站 GET → 403）且无体 content-type 规则不等价；
 * 本地只保留"reason → advisor 自己的 400/403/413/415 契约"的映射。
 *
 * @module dsh-memory-evolve/advisor/api
 */

import { URL } from 'node:url'
import { guardRequestReasoned, readBody } from '../http-guard.js'

const BASE = '/memory-evolve/api/advisor'
const BODY_MAX_BYTES = 64 * 1024
const EVENTS_MAX_LIMIT = 200

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** 错误统一体。 */
function sendError(res, status, code, error) {
  sendJson(res, status, { ok: false, code, error })
}

/**
 * 共享守卫（lib/http-guard.js）的拒绝结果 → **advisor 自有错误契约**。
 *
 * advisor 的写接口按失败原因分状态码（MAJOR-8 复审口径：content-type 非
 * JSON → 415；缺/跨站 Origin → 403；body 非对象/非法 JSON → 400；超限 →
 * 413），与其余注册点"统一 400 bad-request"不同。策略必须只有一份，所以这里
 * 只做映射，不复制任何判定（reason 由共享实现给出）。
 *
 * @param {{status: number, reason: string, body: {code: string, error: string}}} denied
 * @returns {[number, string, string]} [status, code, message]
 */
function guardDenialToContract(denied) {
  switch (denied.reason) {
    case 'cross-site': // 读侧跨站：共享守卫响应体与 advisor 契约同形，原样透传
      return [denied.status, denied.body.code, denied.body.error]
    case 'origin-missing':
    case 'origin-cross':
      return [403, 'FORBIDDEN', denied.body.error]
    case 'content-type':
      return [415, 'UNSUPPORTED_MEDIA_TYPE', denied.body.error]
    case 'body-too-large':
      return [413, 'PAYLOAD_TOO_LARGE', denied.body.error]
    case 'bad-json':
      return [400, 'BAD_JSON', denied.body.error]
    case 'body-not-object':
      return [400, 'BAD_BODY', denied.body.error]
    default:
      return [denied.status, 'BAD_REQUEST', denied.body.error]
  }
}

/** 会话存在性校验（无效 sessionId 返回 null，避免制造孤儿状态）。 */
function sessionExists(ctrl, sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' && ctrl.sessionExists(sessionId)
}

/**
 * @param {object} ctx - web 上下文（httpServer）
 * @param {object} ctrl - installAdvisor 返回的控制器（扩充 sessionExists）
 * @returns {() => void} httpServer 注销函数
 */
export function installAdvisorApi(ctx, ctrl) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const params = url.searchParams
    try {
      // MAJOR-8：先按 method/path 分发——未知端点 404 优先（不落入写操作
      // 的同源 guard，避免"未知 GET 无 Origin 返回 403"的错位）
      const sub = path.startsWith(BASE) ? path.slice(BASE.length) : null
      const known = sub !== null && (
        (req.method === 'GET' && ['/status', '/events', '/records', '/instructions', '/config', '/scopes'].includes(sub))
        || (req.method === 'POST' && ['/instructions', '/conversation/reset', '/toggle'].includes(sub))
        || (req.method === 'DELETE' && ['/instructions'].includes(sub))
        || (req.method === 'PATCH' && ['/config'].includes(sub))
        || (req.method === 'PUT' && ['/scopes'].includes(sub))
      )
      if (!known) return sendError(res, 404, 'NOT_FOUND', `未知端点: ${req.method} ${path}`)

      // 统一前置守卫（共享实现；FIX-27 / me-3）：读侧拒绝浏览器标注的跨站
      // GET（Sec-Fetch-Site: cross-site → 403），写侧强制 Origin 同源 +
      // JSON content-type + JSON 对象体（含无体请求声明非 JSON 的规则）。
      // 拒绝结果按 advisor 自己的契约映射（见 guardDenialToContract）。
      const denied = await guardRequestReasoned(req, BODY_MAX_BYTES)
      if (denied !== null) {
        const [status, code, message] = guardDenialToContract(denied)
        return sendError(res, status, code, message)
      }

      // ---- 读操作 ----
      if (req.method === 'GET' && sub === '/status') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        return sendJson(res, 200, { ok: true, ...ctrl.status(sessionId) })
      }
      if (req.method === 'GET' && sub === '/events') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        const afterRaw = params.get('after')
        const after = afterRaw === null ? undefined : Number(afterRaw)
        // MAJOR-8：after 必须是非负安全整数（旧实现 abc 可致游标错乱）
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
          return sendError(res, 400, 'BAD_CURSOR', 'after 必须是非负整数')
        }
        const limitRaw = Number(params.get('limit') ?? 100)
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), EVENTS_MAX_LIMIT) : 100
        const result = ctrl.queryEvents(sessionId, after, limit)
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'GET' && sub === '/records') {
        const severity = params.get('severity')
        if (severity !== null && severity !== 'info' && severity !== 'nit' && severity !== 'concern' && severity !== 'blocker' && severity !== 'answer') {
          return sendError(res, 400, 'BAD_SEVERITY', 'severity 必须是 info/nit/concern/blocker/answer')
        }
        const limitRaw = params.get('limit')
        const limit = limitRaw === null ? undefined : Number(limitRaw)
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
          return sendError(res, 400, 'BAD_LIMIT', 'limit 必须是 1..100 的整数')
        }
        const result = ctrl.queryRecords({
          sessionId: params.get('sessionId') ?? undefined,
          workspace: params.get('workspace') ?? undefined,
          severity: severity ?? undefined,
          before: params.get('before') ?? undefined,
          limit,
        })
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'GET' && sub === '/instructions') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        return sendJson(res, 200, { ok: true, pending: ctrl.instructionsOf(sessionId) })
      }
      if (req.method === 'GET' && sub === '/config') {
        return sendJson(res, 200, { ok: true, config: ctrl.configSnapshot() })
      }
      if (req.method === 'GET' && sub === '/scopes') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        return sendJson(res, 200, { ok: true, scopes: ctrl.scopesOf(sessionId) })
      }

      // ---- 写操作（守卫已在上方通过；body 由守卫解析并缓存）----
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        if (error instanceof Error && error.message === 'body too large') {
          return sendError(res, 413, 'PAYLOAD_TOO_LARGE', '请求体超限（≤64KB）')
        }
        return sendError(res, 400, 'BAD_JSON', '请求体不是合法 JSON')
      }

      if (req.method === 'POST' && sub === '/instructions') {
        const { sessionId, text } = body
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        if (typeof text !== 'string') return sendError(res, 400, 'BAD_TEXT', 'text 必须为字符串')
        try {
          ctrl.tell(sessionId, text)
          return sendJson(res, 200, { ok: true, pending: ctrl.instructionsOf(sessionId) })
        } catch (error) {
          return sendError(res, 400, 'BAD_TEXT', error instanceof Error ? error.message : String(error))
        }
      }
      if (req.method === 'DELETE' && sub === '/instructions') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        return sendJson(res, 200, { ok: true, ...ctrl.clearInstructions(sessionId) })
      }
      if (req.method === 'POST' && sub === '/conversation/reset') {
        // Q3：新建评审会话——清空评审员持续上下文 + 去重记忆（epoch 自增）
        const { sessionId } = body
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        const result = ctrl.resetConversation(sessionId)
        if (result === null) {
          return sendError(res, 400, 'NOT_RUNNING', '本会话 Advisor 未启用或运行时不可用，无法新建评审会话')
        }
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'PUT' && sub === '/scopes') {
        const { sessionId, level, text } = body
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        if (typeof level !== 'string' || !['global', 'project', 'session', 'conversation'].includes(level)) {
          return sendError(res, 400, 'BAD_LEVEL', 'level 必须是 global/project/session/conversation')
        }
        if (typeof text !== 'string') return sendError(res, 400, 'BAD_TEXT', 'text 必须为字符串')
        try {
          const scopes = ctrl.saveScope(sessionId, level, text)
          return sendJson(res, 200, { ok: true, scopes })
        } catch (error) {
          return sendError(res, 400, 'BAD_SCOPE', error instanceof Error ? error.message : String(error))
        }
      }
      if (req.method === 'POST' && sub === '/toggle') {
        const { sessionId, enabled } = body
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        if (typeof enabled !== 'boolean') return sendError(res, 400, 'BAD_ENABLED', 'enabled 必须为布尔值')
        const s = ctrl.setSessionOverride(sessionId, enabled)
        return sendJson(res, 200, { ok: true, ...s })
      }
      if (req.method === 'PATCH' && sub === '/config') {
        const { patch } = body
        if (patch === undefined || typeof patch !== 'object' || Array.isArray(patch)) {
          return sendError(res, 400, 'BAD_PATCH', 'patch 必须是对象')
        }
        try {
          const config = ctrl.patchConfig(patch)
          return sendJson(res, 200, { ok: true, config })
        } catch (error) {
          return sendError(res, 400, 'BAD_PATCH', error instanceof Error ? error.message : String(error))
        }
      }

      return sendError(res, 404, 'NOT_FOUND', `未知端点: ${req.method} ${path}`)
    } catch (error) {
      return sendError(res, 400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: BASE, handler })
}

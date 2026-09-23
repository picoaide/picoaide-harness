/**
 * 应用详情页里的 **AI 对话面板**（§21 的前端桥消费者）。
 *
 * 与 `app-ai.ts` 的分工：那边是传输与状态（SSE 读法、错误分层、授权存储，纯逻辑、
 * 可在 node 环境单测），这边只做渲染与生命周期：
 *
 *  - **首次授权闸门**（§21.1 第 9 条）：没授权就不渲染输入框，只给一次性说明卡
 *    （"允许" / "不允许"）；授权按 **用户×应用** 记，面板上给「撤销授权」这个出口。
 *    ⚠️ 这里是**唯一**的撤销入口（2026-09-20 核对：设置页里没有这个入口，此前注释
 *    与技能文档都写成"设置页也能撤"，与实现不符）；
 *  - **流式渲染**（§21.2）：`onDelta` 的累计正文直接渲染（不缓冲到结束再显示）；
 *  - **仅前台**（§21.1 第 15 条）：组件卸载 = 页面关闭 ⇒ `AbortController.abort()`，
 *    那一轮由宿主 cancel（用例断言 abort 真的发出去了）；
 *  - **错误分层**（§21.2）：失败渲染成 `code + message`（本地化文案 + 英文诊断），
 *    `ai_cancelled` 只当"你停了"（不是错误样式）。
 *
 * @module @picoaide/dsh-wasm-apps/client/AppAiPanel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  defaultAppAiConsentStore,
  grantAppAiConsent,
  hasAppAiConsent,
  revokeAppAiConsent,
  streamAppAiChat,
  syncAppAiConsent,
  type AppAiConsentStore,
  type AppAiDeps,
  type AppAiFailure,
  type AppAiFailureCode,
  type AppAiMessage,
} from './app-ai.ts'
import { t, type AppCenterKey } from './locales.ts'

/** 失败 code → 用户可见文案的字典键（§21.2 的五个信封 code + 两条客户端分类）。 */
const AI_ERROR_KEYS: Record<AppAiFailureCode, AppCenterKey> = {
  app_ai_denied: 'appCenter.ai.error.denied',
  app_ai_unavailable: 'appCenter.ai.error.unavailable',
  // 字典键**不能**写成服务端的错误码（`ai_balance_insufficient` 里的 "balance" 会撞
  // R36 的额度词守卫 —— 那一条查的是整个字典的序列化结果，键名也算）。
  ai_balance_insufficient: 'appCenter.ai.error.insufficient',
  ai_rate_limited: 'appCenter.ai.error.rateLimited',
  ai_cancelled: 'appCenter.ai.error.cancelled',
  app_ai_transport: 'appCenter.ai.error.transport',
  app_ai_protocol: 'appCenter.ai.error.protocol',
}

const BOX: React.CSSProperties = {
  marginTop: 10,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
}

const BUTTON: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  padding: '4px 10px',
}

const TEXT: React.CSSProperties = {
  ...BUTTON,
  width: '100%',
  boxSizing: 'border-box',
  cursor: 'text',
  fontFamily: 'inherit',
  resize: 'vertical',
}

const MESSAGE: React.CSSProperties = { margin: '4px 0' }
const ROLE: React.CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

/**
 * 应用 AI 面板。
 * @param props - 应用标识、当前用户标识、可注入的存储与 fetch（测试用）。
 */
export function AppAiPanel({ appId, userId, store, deps }: {
  appId: string
  /** 当前登录用户标识（授权按 用户×应用 记；空串 ⇒ 每次都问）。 */
  userId: string
  /** 授权存储（缺省 `localStorage`）。 */
  store?: AppAiConsentStore | null
  /** 传输依赖（缺省全局 fetch）。 */
  deps?: AppAiDeps
}) {
  const storage = useMemo(() => (store === undefined ? defaultAppAiConsentStore() : store), [store])
  const [consented, setConsented] = useState(() => hasAppAiConsent(userId, appId, storage))
  const [denied, setDenied] = useState(false)
  const [revoked, setRevoked] = useState(false)
  /**
   * 写宿主失败的方向（**不是**一句话）：三个方向各有各的真实后果与文案。
   *
   * 审计 C-24：此前只有一个 `syncFailed` 字符串，撤销失败时既宣称"已撤销"、
   * 又渲染"这次不能放行"（那是"允许"失败的方向）—— 与宿主闸门**仍然开着**的事实相反。
   */
  const [syncFailure, setSyncFailure] = useState<'allow' | 'revoke' | 'deny' | null>(null)
  const [messages, setMessages] = useState<AppAiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<AppAiFailure | null>(null)
  const controller = useRef<AbortController | null>(null)
  /**
   * 登录身份还没到（`userId` 为空串）：授权按 用户×应用 记，身份缺席时写入与读取都会
   * 早退 —— 这时「允许」必须是**禁用 + 说明**，而不是点了没反应的按钮。
   */
  const identityPending = userId === ''

  // 仅前台（§21.1 第 15 条）：组件卸载（页面关闭/切走）⇒ 取消在跑的那一轮。
  useEffect(() => () => { controller.current?.abort() }, [])

  /**
   * 允许（§21.1 第 9 条）。
   *
   * 两处都要写：宿主（`syncAppAiConsent`，真正决定闸门放不放行）与渲染层
   * （`localStorage`，决定"还要不要再弹说明卡"）。宿主写失败 ⇒ **不放行** UI：
   * 让用户看到"已允许"但下一次调用 403，比让他再点一次糟糕得多。
   */
  const allow = useCallback((): void => {
    void (async () => {
      const synced = await syncAppAiConsent(appId, true, deps)
      if (!synced.ok) {
        setSyncFailure('allow')
        setConsented(false)
        return
      }
      setSyncFailure(null)
      grantAppAiConsent(userId, appId, storage)
      setDenied(false)
      setRevoked(false)
      setConsented(hasAppAiConsent(userId, appId, storage))
    })()
  }, [appId, deps, storage, userId])

  /**
   * 撤销授权（与「不允许」同一条写面路径）。
   *
   * **失败必须如实报错且不改变任何状态**（审计 C-24）：宿主写失败 ⇒ 闸门仍然放行，
   * 此时宣称"已撤销"并把撤销入口收起来，等于把用户唯一的补救动作（重试撤销）也拿掉，
   * 而下一次调用其实还是能花他的额度。只有 `synced.ok` 才清 UI 记忆、置 `revoked`。
   */
  const revoke = useCallback((): void => {
    void (async () => {
      const synced = await syncAppAiConsent(appId, false, deps)
      if (!synced.ok) {
        setSyncFailure('revoke')
        return
      }
      revokeAppAiConsent(userId, appId, storage)
      setSyncFailure(null)
      setConsented(false)
      setDenied(false)
      setRevoked(true)
    })()
  }, [appId, deps, storage, userId])

  /**
   * 不允许（审计 C-25）：**必须真的关掉宿主闸门**。
   *
   * 此前它只 `setDenied(true)` —— 一句界面标记而已：用户读到"这个应用不能使用 AI"，
   * 而应用照样能经 `/__picoaide/ai/chat` 花掉他的额度。现在与「允许」走**同一条写面
   * 路径**（`syncAppAiConsent(appId, false)`），并同步清掉渲染层的 UI 记忆（否则下次
   * 打开面板会因为 localStorage 里还留着 `granted` 而跳过说明卡，与关掉的闸门自相矛盾）。
   * 写失败 ⇒ 不宣称已拒绝（闸门可能还开着），如实报错。
   */
  const deny = useCallback((): void => {
    void (async () => {
      const synced = await syncAppAiConsent(appId, false, deps)
      if (!synced.ok) {
        setSyncFailure('deny')
        return
      }
      revokeAppAiConsent(userId, appId, storage)
      setSyncFailure(null)
      setConsented(false)
      setRevoked(false)
      setDenied(true)
    })()
  }, [appId, deps, storage, userId])

  const send = useCallback(async (): Promise<void> => {
    const content = draft.trim()
    if (content === '' || busy) return
    const next: AppAiMessage[] = [...messages, { role: 'user', content }]
    setMessages(next)
    setDraft('')
    setStreaming('')
    setFailure(null)
    setBusy(true)
    const abort = new AbortController()
    controller.current = abort
    const result = await streamAppAiChat(next, {
      ...(deps === undefined ? {} : { deps }),
      signal: abort.signal,
      onDelta: (_delta, accumulated) => { setStreaming(accumulated) },
    })
    controller.current = null
    setBusy(false)
    if (result.ok) {
      setMessages([...next, { role: 'assistant', content: result.content }])
      setStreaming('')
      return
    }
    // 取消不是"错误"：保留用户那句话，不追加 assistant 消息，也不弹错误样式。
    if (result.failure.code === 'ai_cancelled') {
      setStreaming('')
      setFailure(result.failure)
      return
    }
    setStreaming('')
    setFailure(result.failure)
  }, [appId, busy, deps, draft, messages, userId])

  const stop = useCallback((): void => { controller.current?.abort() }, [])

  return (
    <div style={BOX} className="pico-app-ai" data-role="app-ai">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong data-role="ai-title">{t('appCenter.ai.title')}</strong>
        {consented && (
          <button type="button" className="pico-app-ai-revoke" data-action="ai-revoke" style={{ ...BUTTON, marginLeft: 'auto' }} onClick={revoke}>
            {t('appCenter.ai.revoke')}
          </button>
        )}
      </div>
      <div style={{ marginTop: 4, color: 'var(--dsw-alias-label-secondary)' }} data-role="ai-tools-note">
        {t('appCenter.ai.toolsNote')}
      </div>

      {/* 首次使用：一次性说明卡（未授权时不渲染输入框 —— 闸门必须在输入之前）。 */}
      {!consented && (
        <div style={{ marginTop: 8 }} data-role="ai-consent">
          <div data-role="ai-intro">{t('appCenter.ai.intro')}</div>
          {denied && <div data-role="ai-denied">{t('appCenter.ai.denied')}</div>}
          {revoked && !denied && <div data-role="ai-revoked">{t('appCenter.ai.revoked')}</div>}
          {/* 宿主没记住授权（写失败/拿不到持有性证明）：如实说，不放行输入框。 */}
          {syncFailure === 'allow' && <div data-role="ai-consent-failed">{t('appCenter.ai.consentFailed')}</div>}
          {/* 「不允许」没能关掉闸门：不许宣称已拒绝（审计 C-25）。 */}
          {syncFailure === 'deny' && <div data-role="ai-deny-failed">{t('appCenter.ai.denyFailed')}</div>}
          {/*
            身份未就绪时的「允许」是**静默 no-op**（2026-09-21 审计）：授权按 用户×应用 记，
            `grantAppAiConsent`/`hasAppAiConsent` 在 userId 为空串时直接早退 ⇒ 点击后
            `consented` 仍为 false，说明卡不动、没有任何提示（而宿主闸门其实已经打开）。
            这里如实置灰并说明原因：身份到达后（父组件用新的 userId 重渲染）按钮自动可用。
          */}
          {identityPending && <div data-role="ai-identity-pending">{t('appCenter.ai.identityPending')}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="pico-app-ai-allow"
              data-action="ai-allow"
              style={{ ...BUTTON, ...(identityPending ? { opacity: 0.55, cursor: 'default' } : {}) }}
              disabled={identityPending}
              onClick={allow}
            >
              {t('appCenter.ai.allow')}
            </button>
            <button type="button" className="pico-app-ai-deny" data-action="ai-deny" style={BUTTON} onClick={deny}>
              {t('appCenter.ai.deny')}
            </button>
          </div>
        </div>
      )}

      {consented && (
        <div style={{ marginTop: 8 }}>
          {/*
            撤销写宿主失败（审计 C-24）：闸门**仍然开着**，所以这里既不能宣称"已撤销"、
            也不能收掉撤销按钮；如实说明失败并让用户重试。
          */}
          {syncFailure === 'revoke' && <div data-role="ai-revoke-failed">{t('appCenter.ai.revokeFailed')}</div>}
          {messages.length === 0 && streaming === '' && (
            <div style={{ color: 'var(--dsw-alias-label-tertiary)' }} data-role="ai-empty">{t('appCenter.ai.empty')}</div>
          )}
          {messages.map((message, index) => (
            <div style={MESSAGE} key={`${message.role}:${String(index)}`} data-role="ai-message" data-role-name={message.role}>
              <span style={ROLE}>{`${message.role === 'user' ? t('appCenter.ai.you') : t('appCenter.ai.assistant')}: `}</span>
              <span data-role="ai-content">{message.content}</span>
            </div>
          ))}
          {busy && streaming === '' && <div style={ROLE} data-role="ai-pending">{t('appCenter.ai.pending')}</div>}
          {streaming !== '' && (
            <div style={MESSAGE} data-role="ai-message" data-role-name="assistant">
              <span style={ROLE}>{`${t('appCenter.ai.assistant')}: `}</span>
              <span data-role="ai-stream">{streaming}</span>
            </div>
          )}
          <textarea
            className="pico-app-ai-input"
            style={{ ...TEXT, marginTop: 6 }}
            rows={2}
            value={draft}
            placeholder={t('appCenter.ai.placeholder')}
            aria-label={t('appCenter.ai.placeholder')}
            onChange={event => { setDraft(event.target.value) }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" className="pico-app-ai-send" data-action="ai-send" style={BUTTON} disabled={busy || draft.trim() === ''} onClick={() => { void send() }}>
              {t('appCenter.ai.send')}
            </button>
            {busy && (
              <button type="button" className="pico-app-ai-stop" data-action="ai-stop" style={BUTTON} onClick={stop}>
                {t('appCenter.ai.cancel')}
              </button>
            )}
          </div>
        </div>
      )}

      {failure !== null && (
        <div style={{ marginTop: 8 }} data-role="ai-error" data-code={failure.code}>
          <div data-role="ai-error-message">{t(AI_ERROR_KEYS[failure.code])}</div>
          <div style={{ color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 }} data-role="ai-error-detail">{failure.message}</div>
        </div>
      )}
    </div>
  )
}

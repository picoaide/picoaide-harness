import { useCallback, useEffect, useRef, useState } from 'react'
import { t, type AppCenterKey } from './locales.ts'
import { ACCESS_MODES, DEFAULT_ACCESS, type AccessMode } from './appcfg-contract.ts'
import {
  type PublishDraft,
  type PublishFailure,
  type PublishFile,
  type PublishPhase,
  type PublishSuccess,
  type ValidationIssue,
  splitWhitelist,
  submitPublish,
  validatePublishDraft,
} from './publish-app.ts'

/**
 * 发布表单（FIX-38）：应用中心里的**员工发布入口**。
 *
 * 为什么必须存在：发布编排（90 s / 分片 / 续传）在宿主里已经完备，但过去**没有任何
 * 调用方** —— 面板只有目录，AI 也没有 `wasm_app_*` 工具面 ⇒ `/publish` 零调用方，
 * 整条链路在产品里不可达。本组件就是那个调用方，并且**由页面上下文发起**（页面天然
 * 持有 `dsh-auth-*` 持有性证明，不需要任何新的信任机制）。
 *
 * 三条纪律：
 *  - **不复制编排**：只 `POST /api/pico/apps/wasm/publish`；`base64 > 8 MiB` 的分片与
 *    续传由宿主那一份实现负责（面板不自己切、也不加"小文件直传"的第二条路）；
 *  - **不显示额度/用量**（R36）：这一页只有产物与版本信息；
 *  - **失败必须可见**：服务端 `code`/`message`/`details`/`hints` 原样显示 —— 只显示
 *    "失败"等于把可自修的信息丢掉（第一消费者是 AI，也是给员工看的）。
 *
 * 状态：没有假进度条（服务端 publish 是**同步**的），只有"读取中 → 上传/编译中 →
 * 成功/失败"四个真实状态；进行中可取消（AbortController）。
 *
 * @module @picoaide/dsh-wasm-apps/client/PublishForm
 */

const FIELD: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 10,
}

const LABEL: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

const INPUT: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: 32,
  padding: '4px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
}

const TEXTAREA: React.CSSProperties = { ...INPUT, height: 64, resize: 'vertical' }

const BUTTON: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  padding: '6px 12px',
}

// 用上游真实的按钮 token（`check-theme-tokens` 守卫：`bg-invert`/`label-invert` 并不存在，
// 写成带字面量兜底的 var() 会让按钮在暗色主题下不跟随主题）。
const PRIMARY: React.CSSProperties = { ...BUTTON, borderColor: 'transparent', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' }

const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }

const BOX: React.CSSProperties = {
  marginTop: 8,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
  wordBreak: 'break-word',
}

const DETAILS: React.CSSProperties = {
  margin: '6px 0 0',
  maxHeight: 160,
  overflow: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  lineHeight: '16px',
  whiteSpace: 'pre-wrap',
}

const HINT_LIST: React.CSSProperties = { margin: '4px 0 0', paddingLeft: 18 }

/** 访问级别选择器（三选一）的外框。 */
const FIELDSET: React.CSSProperties = {
  margin: 0,
  padding: '8px 12px 4px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
}

const LEGEND: React.CSSProperties = { ...LABEL, padding: '0 4px' }

/** 单个访问级别选项（一行单选框 + 一行帮助文字）。 */
const ACCESS_OPTION: React.CSSProperties = { marginBottom: 6 }

const ACCESS_HINT: React.CSSProperties = {
  margin: '0 0 0 24px',
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
}

/** "必填"标记（跟随字段标题，不单独占一行）。 */
const REQUIRED_MARK: React.CSSProperties = { marginLeft: 6, color: 'var(--dsw-alias-label-tertiary)' }

/** 访问级别的选项文案（zh/en 键）。 */
const ACCESS_LABEL_KEYS: Record<AccessMode, AppCenterKey> = {
  public: 'appCenter.access.public',
  login: 'appCenter.access.login',
  whitelist: 'appCenter.access.whitelist',
}

/**
 * 访问级别的帮助文字。
 *
 * `whitelist` 的那条必须写清**平台不比对名单、由应用自己判**：这是 R24 的用户可见面
 * —— 作者若以为"填了名单平台就会拦"，他会写出一个对所有人开放的应用。
 */
const ACCESS_HINT_KEYS: Record<AccessMode, AppCenterKey> = {
  public: 'appCenter.access.publicHint',
  login: 'appCenter.access.loginHint',
  whitelist: 'appCenter.access.whitelistHint',
}

/** 表单状态机：`idle` 可以提交，其余状态在途（`done`/`failed` 回到可提交的展示态）。 */
type FormState =
  | { kind: 'idle' }
  | { kind: 'busy', phase: PublishPhase }
  | { kind: 'done', result: PublishSuccess }
  | { kind: 'failed', failure: PublishFailure }

/**
 * 发布表单。
 * @param props - `onClose` 返回目录；`onPublished` 在成功后被调用（面板据此刷新目录）。
 */
export function PublishForm({ onClose, onPublished }: { onClose: () => void, onPublished: () => void }) {
  const [file, setFile] = useState<PublishFile | null>(null)
  const [fileName, setFileName] = useState('')
  const [appId, setAppId] = useState('')
  const [version, setVersion] = useState('')
  const [title, setTitle] = useState('')
  const [changelog, setChangelog] = useState('')
  // 访问级别三选一，缺省 login（"登录后使用（默认全员）"）——写漏不该意外变成匿名可达。
  const [access, setAccess] = useState<AccessMode>(DEFAULT_ACCESS)
  const [whitelistText, setWhitelistText] = useState('')
  const [purpose, setPurpose] = useState('')
  const [dataSensitivity, setDataSensitivity] = useState('internal')
  const [owner, setOwner] = useState('')
  const [state, setState] = useState<FormState>({ kind: 'idle' })
  const [localIssues, setLocalIssues] = useState<ValidationIssue[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const busy = state.kind === 'busy'

  // 卸载时取消在途请求：面板被关掉之后不该还在跑一次 44 MiB 的上传。
  useEffect(() => () => { abortRef.current?.abort() }, [])

  const pickFile = useCallback(async (selected: File | null): Promise<void> => {
    setLocalIssues([])
    if (selected === null) {
      setFile(null)
      setFileName('')
      return
    }
    try {
      const bytes = new Uint8Array(await selected.arrayBuffer())
      setFile({ name: selected.name, bytes })
      setFileName(selected.name)
      // 文件名常常就是 app_id / 版本线索：只在对应字段还空着时预填，不覆盖用户输入。
      setAppId(current => (current === '' ? selected.name.replace(/\.wasm$/iu, '').replace(/[^a-z0-9-]/giu, '-').toLowerCase() : current))
    } catch (cause) {
      setFile(null)
      setFileName('')
      setLocalIssues([{ field: 'wasm_file', code: 'file_read_failed', message: `${t('appCenter.readFailed')}: ${cause instanceof Error ? cause.message : String(cause)}` }])
    }
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    const draft: PublishDraft = {
      appId,
      version,
      title,
      changelog,
      config: {
        access,
        whitelist: splitWhitelist(whitelistText),
        purpose: purpose.trim(),
        dataSensitivity: dataSensitivity.trim(),
        owner: owner.trim(),
      },
    }
    // 预校验（与服务端 registry/appcfg 同口径）：文件是页面这一侧的事，
    // 其余全部走 validatePublishDraft —— 规则只有一份实现，不在组件里再抄一遍。
    const issues: ValidationIssue[] = []
    if (file === null) {
      issues.push({ field: 'wasm_file', code: 'wasm_file_required', message: t('appCenter.needFile') })
    }
    issues.push(...validatePublishDraft(draft))
    if (issues.length > 0 || file === null) {
      setLocalIssues(issues)
      return
    }
    setLocalIssues([])
    const controller = new AbortController()
    abortRef.current = controller
    setState({ kind: 'busy', phase: 'reading' })
    const result = await submitPublish(draft, file, {
      signal: controller.signal,
      onPhase: phase => { setState({ kind: 'busy', phase }) },
    })
    abortRef.current = null
    // 被取消时不留"失败"面板：回到可提交的空闲态（用户刚按的就是取消）。
    if (!result.ok && result.code === 'ABORTED') {
      setState({ kind: 'idle' })
      return
    }
    if (result.ok) {
      setState({ kind: 'done', result })
      onPublished()
      return
    }
    setState({ kind: 'failed', failure: result })
  }, [access, appId, changelog, dataSensitivity, file, onPublished, owner, purpose, title, version, whitelistText])

  const cancel = useCallback((): void => {
    if (busy) {
      abortRef.current?.abort()
      return
    }
    onClose()
  }, [busy, onClose])

  return (
    <div className="pico-app-center-publish-form" data-view="publish">
      <p style={{ ...LABEL, marginTop: 0 }}>{t('appCenter.publishHint')}</p>

      <div style={FIELD}>
        <label style={LABEL} htmlFor="pico-publish-file">{t('appCenter.file')}</label>
        <div style={ROW}>
          <input
            id="pico-publish-file"
            className="pico-app-center-file"
            data-field="wasm_file"
            type="file"
            accept=".wasm,application/wasm"
            disabled={busy}
            onChange={event => { void pickFile(event.target.files?.[0] ?? null) }}
          />
          <span style={LABEL} data-role="file-state">
            {fileName === '' ? t('appCenter.fileNone') : `${t('appCenter.fileChosen')}: ${fileName}`}
          </span>
        </div>
      </div>

      <div style={FIELD}>
        <label style={LABEL} htmlFor="pico-publish-app-id">{t('appCenter.appId')}</label>
        <input
          id="pico-publish-app-id"
          className="pico-app-center-app-id"
          data-field="app_id"
          style={INPUT}
          value={appId}
          disabled={busy}
          placeholder="shift-notes"
          onChange={event => { setAppId(event.target.value) }}
        />
        <span style={LABEL}>{t('appCenter.appIdHint')}</span>
      </div>

      <div style={FIELD}>
        <label style={LABEL} htmlFor="pico-publish-version">{t('appCenter.version')}</label>
        <input
          id="pico-publish-version"
          className="pico-app-center-version"
          data-field="version"
          style={INPUT}
          value={version}
          disabled={busy}
          placeholder="1.0.0"
          onChange={event => { setVersion(event.target.value) }}
        />
      </div>

      <div style={FIELD}>
        <label style={LABEL} htmlFor="pico-publish-title">
          {t('appCenter.titleField')}
          <span style={REQUIRED_MARK}>{t('appCenter.requiredTitle')}</span>
        </label>
        <input
          id="pico-publish-title"
          className="pico-app-center-title"
          data-field="title"
          style={INPUT}
          value={title}
          disabled={busy}
          onChange={event => { setTitle(event.target.value) }}
        />
        <span style={LABEL}>{t('appCenter.titleHint')}</span>
      </div>

      <div style={FIELD}>
        <label style={LABEL} htmlFor="pico-publish-changelog">{t('appCenter.changelog')}</label>
        <textarea
          id="pico-publish-changelog"
          className="pico-app-center-changelog"
          data-field="changelog"
          style={TEXTAREA}
          value={changelog}
          disabled={busy}
          onChange={event => { setChangelog(event.target.value) }}
        />
      </div>

      <div style={FIELD}>
        <span style={LABEL}>{t('appCenter.config')}</span>
        {/*
          访问权限 = 三选一（`access` 取代了旧的 visible 勾选 + login_required 勾选）。
          三个选项各自带帮助文字：谁会被拦、平台做不做什么。whitelist 那条必须写清
          "平台不比对名单"，否则作者会以为填了名单平台就会拦（R24 的用户可见面）。
        */}
        <fieldset style={FIELDSET} data-field="access">
          <legend style={LEGEND}>{t('appCenter.access')}</legend>
          {ACCESS_MODES.map(mode => (
            <div key={mode} style={ACCESS_OPTION}>
              <div style={{ ...ROW, marginBottom: 0 }}>
                <input
                  id={`pico-publish-access-${mode}`}
                  className={`pico-app-center-access-${mode}`}
                  data-field="access"
                  data-access={mode}
                  type="radio"
                  name="pico-publish-access"
                  value={mode}
                  checked={access === mode}
                  disabled={busy}
                  onChange={() => { setAccess(mode) }}
                />
                <label style={LABEL} htmlFor={`pico-publish-access-${mode}`}>{t(ACCESS_LABEL_KEYS[mode])}</label>
              </div>
              <p style={ACCESS_HINT} data-role={`access-hint-${mode}`}>{t(ACCESS_HINT_KEYS[mode])}</p>
            </div>
          ))}
        </fieldset>

        {/*
          名单输入**只在选中 whitelist 时出现**，并标为必填 —— 服务端对
          `access=whitelist` + 空名单一律拒（那种应用对所有人都不可用）。
        */}
        {access === 'whitelist' && (
          <div style={{ ...FIELD, marginTop: 10, marginBottom: 0 }}>
            <label style={LABEL} htmlFor="pico-publish-whitelist">
              {t('appCenter.whitelist')}
              <span style={REQUIRED_MARK}>{t('appCenter.whitelistRequired')}</span>
            </label>
            <input
              id="pico-publish-whitelist"
              className="pico-app-center-whitelist"
              data-field="whitelist"
              style={INPUT}
              value={whitelistText}
              disabled={busy}
              required
              aria-required="true"
              placeholder={t('appCenter.whitelist')}
              onChange={event => { setWhitelistText(event.target.value) }}
            />
            <span style={LABEL}>{t('appCenter.whitelistHint')}</span>
          </div>
        )}

        <div style={{ ...ROW, marginTop: 10 }}>
          <input
            className="pico-app-center-purpose"
            data-field="purpose"
            style={INPUT}
            value={purpose}
            disabled={busy}
            aria-label={t('appCenter.purpose')}
            placeholder={t('appCenter.purpose')}
            onChange={event => { setPurpose(event.target.value) }}
          />
          <input
            className="pico-app-center-data-sensitivity"
            data-field="data_sensitivity"
            style={INPUT}
            value={dataSensitivity}
            disabled={busy}
            aria-label={t('appCenter.dataSensitivity')}
            placeholder={t('appCenter.dataSensitivity')}
            onChange={event => { setDataSensitivity(event.target.value) }}
          />
          <input
            className="pico-app-center-owner"
            data-field="owner"
            style={INPUT}
            value={owner}
            disabled={busy}
            aria-label={t('appCenter.owner')}
            placeholder={t('appCenter.owner')}
            onChange={event => { setOwner(event.target.value) }}
          />
        </div>
        <span style={LABEL}>{t('appCenter.declarationsHint')}</span>
      </div>

      {localIssues.length > 0 && (
        <div style={BOX} data-role="local-error" role="alert">
          <ul style={HINT_LIST} data-role="local-error-list">
            {localIssues.map(issue => (
              <li key={`${issue.field}:${issue.code}`} data-field={issue.field} data-code={issue.code}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {state.kind === 'busy' && (
        <div style={BOX} data-role="phase" aria-live="polite">
          {state.phase === 'reading' ? t('appCenter.phaseReading') : t('appCenter.phaseUploading')}
        </div>
      )}

      {state.kind === 'failed' && <PublishErrorBlock failure={state.failure} />}
      {state.kind === 'done' && <PublishSuccessBlock result={state.result} />}

      <div style={{ ...ROW, marginTop: 12, marginBottom: 0 }}>
        <button
          type="button"
          className="pico-app-center-submit"
          data-action="publish-submit"
          style={{ ...PRIMARY, ...(busy ? { opacity: 0.6 } : {}) }}
          disabled={busy}
          onClick={() => { void submit() }}
        >
          {t('appCenter.submit')}
        </button>
        <button
          type="button"
          className="pico-app-center-cancel"
          data-action="publish-cancel"
          style={BUTTON}
          onClick={cancel}
        >
          {busy ? t('appCenter.cancel') : t('appCenter.back')}
        </button>
        {state.kind === 'done' && (
          <button
            type="button"
            className="pico-app-center-back-to-list"
            data-action="back-to-list"
            style={BUTTON}
            onClick={onClose}
          >
            {t('appCenter.backToList')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 失败块：`code` / `message` / `details` / `hints` **逐字段显示**（服务端信封原样）。
 *
 * 不合并、不摘要、不翻译：这些字段的第一消费者是 AI（它照着 `hints` 自修），第二消费者
 * 是员工（他要能把 `details` 复制给维护者）。
 * @param props - 结构化失败。
 */
export function PublishErrorBlock({ failure }: { failure: PublishFailure }) {
  return (
    <div style={BOX} data-role="publish-error" role="alert">
      <div><strong>{t('appCenter.failed')}</strong></div>
      <div data-role="error-code">{`${t('appCenter.errorCode')}: ${failure.code}`}</div>
      <div data-role="error-message">{failure.message}</div>
      {failure.details !== undefined && (
        <>
          <div>{`${t('appCenter.errorDetails')}:`}</div>
          <pre style={DETAILS} data-role="error-details">
            {typeof failure.details === 'string' ? failure.details : JSON.stringify(failure.details, null, 2)}
          </pre>
        </>
      )}
      {failure.hints.length > 0 && (
        <>
          <div>{`${t('appCenter.errorHints')}:`}</div>
          <ul style={HINT_LIST} data-role="error-hints">
            {failure.hints.map(hint => <li key={hint}>{hint}</li>)}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * 成功块：版本 / 状态（已生效 or 待审核）/ 入口链接 —— 员工提交完立刻知道"生效了没有"。
 * @param props - 结构化成功结果。
 */
export function PublishSuccessBlock({ result }: { result: PublishSuccess }) {
  return (
    <div style={BOX} data-role="publish-success">
      <div><strong>{t('appCenter.published')}</strong></div>
      <div data-role="published-version">{`${t('appCenter.versionLabel')}: ${result.version}`}</div>
      <div data-role="published-status">
        {result.pending ? t('appCenter.publishedPending') : t('appCenter.publishedLive')}
      </div>
      {result.entryURL !== '' && (
        <div data-role="published-entry">{`${t('appCenter.entry')}: ${result.entryURL}`}</div>
      )}
    </div>
  )
}

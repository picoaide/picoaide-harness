import { useCallback, useEffect, useRef, useState } from 'react'
import { t, type AppCenterKey } from './locales.ts'
import { WASM_MAX_BYTES, WRITABLE_ACCESS_MODES, type AccessMode } from './appcfg-contract.ts'
import { appShareLink } from './deep-link.ts'
import {
  type AppIdAvailability,
  type PublishDraft,
  type PublishFailure,
  type PublishFile,
  type PublishPhase,
  type PublishSuccess,
  type PublishTarget,
  type PublishFormInitial,
  type ValidationIssue,
  checkAppIdAvailability,
  changesAccess,
  initialFormState,
  splitWhitelist,
  submitPublish,
  validatePublishDraft,
  windowSpecFromText,
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

/**
 * 访问级别的选项文案（zh/en 键）。
 *
 * 2026-09-19（冻结契约 §4.4）：写侧只有 `login | whitelist`（匿名面已删除），
 * 所以这里没有 `public` —— 选项集合见 {@link WRITABLE_ACCESS_MODES}。
 */
const ACCESS_LABEL_KEYS: Record<AccessMode, AppCenterKey> = {
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
  login: 'appCenter.access.loginHint',
  whitelist: 'appCenter.access.whitelistHint',
}

/** 表单状态机：`idle` 可以提交，其余状态在途（`done`/`failed` 回到可提交的展示态）。 */
type FormState =
  | { kind: 'idle' }
  | { kind: 'busy', phase: PublishPhase }
  /** `access` = **本次提交**的访问级别（成功块回显它，见 P1-3）。 */
  | { kind: 'done', result: PublishSuccess, access: AccessMode }
  | { kind: 'failed', failure: PublishFailure }

/**
 * 标识查重的界面态。
 *
 * `idle` 是"还没问"（空输入 / 正在防抖 / 已有本地形态错误），`unknown` 是"问了但
 * 没问成"。两者**都不是**"可用" —— 查重结果只用于**提示与拦下确定的坏情况**，
 * 权威判据永远是提交那一刻服务端的 409（见 {@link checkAppIdAvailability}）。
 */
type AvailabilityState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'known', verdict: AppIdAvailability }
  | { kind: 'unknown' }

/**
 * 查重防抖间隔（毫秒）。
 *
 * 400 ms 是"停下来才问"的量级：比逐字符请求少一个数量级的往返，又不至于让人等出
 * "界面没反应"的感觉。刻意不做节流（throttle）—— 每敲一个字都发一次请求，对一个
 * 需要查库的端点没有意义。
 */
const AVAILABILITY_DEBOUNCE_MS = 400

/**
 * 字节数 → 人类可读（只在错误文案里用；不做单位美化，保留一位小数就够）。
 * @param bytes - 字节数。
 * @returns 形如 `33.0 MiB`。
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${String(bytes)} B`
}

/**
 * 把查重状态翻成一行给用户看的话。
 *
 * 几条刻意的取舍：
 *  - `taken` 时**优先显示服务端的 `message`**：它就是发布那一刻 409 的那句话，
 *    两条链路给出同一句话，用户不会以为"查重说占用、提交说别的"是两回事；
 *  - `invalid` 同理（服务端指名了到底是哪条规则；本地文案只是兜底）；
 *  - `taken` 追加一条 `takenHint`，把"永久占用、下架/删除也不释放"讲清楚 ——
 *    否则用户会去下架自己的旧应用然后奇怪为什么名字还是拿不回来；
 *  - `checking` / `unknown` **都说"不确定"**，绝不说"可用"。
 * @param availability - 当前查重态。
 * @returns 展示文案（空串 = 不显示）。
 */
function availabilityText(availability: AvailabilityState): string {
  switch (availability.kind) {
    case 'idle':
      return ''
    case 'checking':
      return t('appCenter.availabilityChecking')
    case 'unknown':
      return t('appCenter.availabilityUnknown')
    case 'known': {
      const { verdict } = availability
      switch (verdict.reason) {
        case 'available':
          return t('appCenter.availabilityFree')
        case 'yours':
          return t('appCenter.availabilityYours')
        case 'taken': {
          const head = verdict.message === '' ? t('appCenter.availabilityTaken') : verdict.message
          return `${head} — ${t('appCenter.availabilityTakenHint')}`
        }
        case 'invalid':
          return verdict.message === '' ? t('appCenter.availabilityInvalid') : verdict.message
      }
    }
  }
}

/**
 * 发布表单。
 *
 * 三条与"当前值"有关的纪律（P1-3）：
 *  - **对已有应用发新版时全部预填**（`target`）：作者不动单选框 ⇒ 提交的就是现状，
 *    不会静默改写线上 `access`；
 *  - **改动访问范围要显式确认**：选中值与当前值不同时必须勾选确认框才能提交，
 *    文案写清"当前 X → 提交后 Y"；
 *  - **`data_sensitivity` 永不预填**：平台没有这个字段的默认值
 *    （`appcfg.json`：\"不要指望界面或平台替你填\"），留空并在界面上标注要作者声明。
 *
 * @param props - `onClose` 返回目录；`onPublished` 在成功后被调用（面板据此刷新目录）；
 *   `target` 是"对已有应用发新版"的目录行基线（首版发布时不传）。
 */
export function PublishForm({ onClose, onPublished, target }: { onClose: () => void, onPublished: () => void, target?: PublishTarget }) {
  // 预填只发生一次（挂载时）：之后 `target` 再变（目录刷新）也不该覆盖用户的输入。
  const [initial] = useState<PublishFormInitial>(() => initialFormState(target))
  const [file, setFile] = useState<PublishFile | null>(null)
  const [fileName, setFileName] = useState('')
  const [appId, setAppId] = useState(initial.appId)
  const [version, setVersion] = useState('')
  const [title, setTitle] = useState(initial.title)
  const [changelog, setChangelog] = useState('')
  // 访问级别：首版缺省 login（"登录后使用"，写漏不该意外变成匿名可达）；
  // 发新版时是**当前线上的值**（`initial.access`）。
  const [access, setAccess] = useState<AccessMode>(initial.access)
  const [whitelistText, setWhitelistText] = useState(initial.whitelistText)
  const [purpose, setPurpose] = useState(initial.purpose)
  // **平台没有 data_sensitivity 的默认值**：硬填一个（如 internal）等于把每个应用的
  // 合规声明统一抹平成同一个值，而作者以为自己声明过了。初值恒为空串。
  const [dataSensitivity, setDataSensitivity] = useState('')
  const [owner, setOwner] = useState(initial.owner)
  // 窗口声明（F3/§6）：三项都可留空 = 不声明（**不是**"锁了缺省比例"）。
  const [windowRatioText, setWindowRatioText] = useState(initial.windowRatioText)
  const [windowWidthText, setWindowWidthText] = useState(initial.windowWidthText)
  const [windowHeightText, setWindowHeightText] = useState(initial.windowHeightText)
  // 访问范围被改动时的显式确认（勾选后才允许提交）。
  const [accessConfirmed, setAccessConfirmed] = useState(false)
  const [state, setState] = useState<FormState>({ kind: 'idle' })
  const [localIssues, setLocalIssues] = useState<ValidationIssue[]>([])
  // 标识查重（2026-09-20）：用户敲 app_id 时防抖问服务端一次，提交前再问一次。
  const [availability, setAvailability] = useState<AvailabilityState>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  // 查重自己的取消器：与提交的 abortRef 分开 —— 关面板时提交要取消（可能正在传
  // 44 MiB），查重也要取消（一个 200 ms 的 GET 没有理由活过组件）。
  const availabilityAbortRef = useRef<AbortController | null>(null)
  // 单调递增序号：只有"最后一次"发出的查重可以落地。防抖 + 在途响应会出现
  // "先发的后回"，不做序号判断就会用旧输入的结论覆盖新输入的结论。
  const availabilitySeqRef = useRef(0)

  const busy = state.kind === 'busy'
  const accessChanged = changesAccess(initial, access)

  // 卸载时取消在途请求：面板被关掉之后不该还在跑一次 44 MiB 的上传。
  useEffect(() => () => { abortRef.current?.abort() }, [])

  /**
   * 标识查重：**防抖**地在用户停止输入后问服务端一次。
   *
   * 四条纪律：
   *  1. **空输入与本地形态错误不发请求**：名字还没成形时服务端只会回"非法"，
   *     而本地预校验（`validatePublishDraft` 的同一套规则）已经能给出同一条文案
   *     —— 何必每次敲击都换一次往返。这里用 `initial` 判"已有应用发新版"：
   *     那种情况下 app_id 不可改，查重没有意义。
   *  2. **序号 + AbortController 双保险**：防抖窗口内多次输入只发最后一次；即便
   *     前一次已经在途，"先发后回"也不能覆盖新结论（序号判定），并且立刻 abort。
   *  3. **查重失败不阻断**（`kind: 'unknown'`）：宿主故障时既不能说"可用"（会放行
   *     注定失败的发布）也不能说"被占用"（会误杀合法名字），只提示"暂时无法确认"。
   *  4. **对已有应用发新版不做可发布性拦截**：`target` 存在时 app_id 是既成事实，
   *     `reason: 'yours'` 是正常态，不能被当成"被占用"。
   */
  useEffect(() => {
    // 已有应用发新版：app_id 不可改，不查重（也没有"唯一性"问题）。
    if (initial.currentAccess !== undefined) {
      setAvailability({ kind: 'idle' })
      return
    }
    const candidate = appId.trim()
    if (candidate === '') {
      setAvailability({ kind: 'idle' })
      return
    }
    // 本地形态不过关 ⇒ 不发请求（本地文案与服务端同源，见 validatePublishDraft）。
    const localShape = validatePublishDraft({
      appId: candidate,
      version: '0.0.0',
      title: 'x',
      changelog: '',
      config: { access: 'login', whitelist: [], purpose: 'x', dataSensitivity: 'i', owner: 'o' },
    }).some(issue => issue.field === 'app_id')
    if (localShape) {
      setAvailability({ kind: 'idle' })
      return
    }
    setAvailability({ kind: 'checking' })
    const timer = setTimeout(() => {
      const seq = availabilitySeqRef.current + 1
      availabilitySeqRef.current = seq
      availabilityAbortRef.current?.abort()
      const controller = new AbortController()
      availabilityAbortRef.current = controller
      void checkAppIdAvailability(candidate, { signal: controller.signal }).then(outcome => {
        // 迟到的响应一律丢弃：只有最后一次发出的查重可以改界面。
        if (availabilitySeqRef.current !== seq) return
        if (outcome.ok) {
          setAvailability({ kind: 'known', verdict: outcome.availability })
          return
        }
        // 被自己取消（换输入/卸载）不算"查重失败"，保持 checking 交给下一轮覆盖。
        if (outcome.code === 'ABORTED') return
        setAvailability({ kind: 'unknown' })
      })
    }, AVAILABILITY_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [appId, initial.currentAccess])

  // 卸载时一并取消在途查重。
  useEffect(() => () => { availabilityAbortRef.current?.abort() }, [])

  /**
   * 提交前的**权威复检**：拿服务端当下的事实再判一次，不信任界面上那份结论。
   *
   * 为什么不能只靠 `availability` 状态：它可能来自几百毫秒前的输入（防抖窗口里
   * 用户又改了名字），也可能因为防抖/网络根本没跑过 —— 拿它放行等于把"提交"押在
   * 一个可能过期的缓存上。这里**主动再问一次**，并且：
   *  - 明确"被别人占用"⇒ 返回一条本地 issue，**不上传**（省掉一次 32 MiB 往返）；
   *  - 明确"是你的"或"空闲"⇒ 放行；
   *  - 查重本身失败（宿主故障）⇒ **放行**，让服务端在发布那一刻给出权威判定 ——
   *    查重是体验优化，不能变成新的单点故障（它挂了不该让所有人都发不出去）。
   * @returns 拦下提交的本地 issue；`null` = 可以继续提交。
   */
  const verifyAppIdBeforeSubmit = useCallback(async (candidate: string): Promise<ValidationIssue | null> => {
    // 已有应用发新版：标识不可改，归属由服务端 ownedApp 判，不在这里重复判。
    if (initial.currentAccess !== undefined) return null
    const outcome = await checkAppIdAvailability(candidate)
    if (!outcome.ok) return null
    const verdict = outcome.availability
    if (verdict.reason === 'taken') {
      return {
        field: 'app_id',
        code: 'app_id_taken',
        message: verdict.message === '' ? t('appCenter.availabilityTaken') : verdict.message,
      }
    }
    if (verdict.reason === 'invalid') {
      return {
        field: 'app_id',
        code: 'app_id_invalid',
        // 服务端原文优先（它指名了到底是哪一条规则），本地文案兜底。
        message: verdict.message === '' ? t('appCenter.availabilityInvalid') : verdict.message,
      }
    }
    return null
  }, [initial.currentAccess])

  const pickFile = useCallback(async (selected: File | null): Promise<void> => {
    setLocalIssues([])
    if (selected === null) {
      setFile(null)
      setFileName('')
      return
    }
    // **体积闸门必须在读文件之前**（P1-10）：`arrayBuffer()` + base64 + JSON.stringify
    // 会让渲染进程主线程持 3–4 倍文件大小的峰值内存，超限文件先卡死界面再回
    // `UPLOAD_TOO_LARGE`。这里按宿主同一个上限（`WASM_MAX_BYTES`）就地拒掉。
    if (typeof selected.size === 'number' && selected.size > WASM_MAX_BYTES) {
      setFile(null)
      setFileName('')
      setLocalIssues([{
        field: 'wasm_file',
        code: 'wasm_file_too_large',
        message: `${t('appCenter.fileTooLarge')} (${formatBytes(selected.size)} > ${formatBytes(WASM_MAX_BYTES)})`,
      }])
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
    const declaredWindow = windowSpecFromText(windowRatioText, windowWidthText, windowHeightText)
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
        ...(declaredWindow === undefined ? {} : { window: declaredWindow }),
      },
    }
    // 预校验（与服务端 registry/appcfg 同口径）：文件是页面这一侧的事，
    // 其余全部走 validatePublishDraft —— 规则只有一份实现，不在组件里再抄一遍。
    const issues: ValidationIssue[] = []
    if (file === null) {
      issues.push({ field: 'wasm_file', code: 'wasm_file_required', message: t('appCenter.needFile') })
    } else if (file.bytes.byteLength > WASM_MAX_BYTES) {
      // 兜底（正常在选文件时已被拦下）：体积闸门不能只活在一条路径上。
      issues.push({ field: 'wasm_file', code: 'wasm_file_too_large', message: t('appCenter.fileTooLarge') })
    }
    // 改动访问范围必须显式确认（P1-3）：静默改写线上 access 是安全语义问题，
    // 不是"多问一句"的体验问题。
    if (accessChanged && !accessConfirmed) {
      issues.push({ field: 'access', code: 'access_change_unconfirmed', message: t('appCenter.accessChangeUnconfirmed') })
    }
    issues.push(...validatePublishDraft(draft))
    if (issues.length > 0 || file === null) {
      setLocalIssues(issues)
      return
    }
    setLocalIssues([])
    // 提交前的**唯一性复检**（2026-09-20）：本地形态校验只证明"名字长得对"，
    // 证明不了"名字还没被占"。这一步真的问一次服务端，被占就**连文件都不读、
    // 一个字节都不上传**地拦下（省掉一次 ≤32 MiB 的往返 + 一次编译）。
    // 查重自身失败不阻断（见 verifyAppIdBeforeSubmit）：权威判据是发布那一刻的 409。
    setAvailability({ kind: 'checking' })
    const blocked = await verifyAppIdBeforeSubmit(appId.trim())
    if (blocked !== null) {
      setAvailability({ kind: 'idle' })
      setLocalIssues([blocked])
      return
    }
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
      setState({ kind: 'done', result, access })
      onPublished()
      return
    }
    setState({ kind: 'failed', failure: result })
  }, [access, accessChanged, accessConfirmed, appId, changelog, dataSensitivity, file, onPublished, owner, purpose, title, verifyAppIdBeforeSubmit, version, whitelistText])

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

      {/*
        「对已有应用发新版」的上下文条（P1-3）：把"这一次发布的基线是哪一版"写在
        最上面 —— 预填的每一个字段都来自这一行的当前值，作者要能看见这一点。
      */}
      {initial.currentAccess !== undefined && (
        <div style={BOX} data-role="publish-target">
          <div>
            {`${t('appCenter.publishingExisting')}: ${initial.appId}`}
            {initial.currentVersion !== '' && ` · ${t('appCenter.currentVersion')}: ${initial.currentVersion}`}
          </div>
          <div data-role="current-access">
            {`${t('appCenter.currentAccess')}: ${t(ACCESS_LABEL_KEYS[initial.currentAccess])}`}
          </div>
        </div>
      )}

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
        {/*
          查重结论（2026-09-20）：四态各自可辨，`data-availability` 是给断言用的稳定钩子。
          `aria-live=polite` 让读屏用户在结论变化时得到通知（不是每次敲击都打断）。
        */}
        <span
          style={LABEL}
          data-role="app-id-availability"
          data-availability={availability.kind === 'known' ? availability.verdict.reason : availability.kind}
          aria-live="polite"
        >
          {availabilityText(availability)}
        </span>
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
          {WRITABLE_ACCESS_MODES.map(mode => (
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
                  // 换一个取值就**撤销**上一次的确认：确认框写的是"当前 X → 提交后 Y"，
                  // 用户确认的是那一对**具体取值**，不是"随便改点什么"。
                  onChange={() => { setAccess(mode); setAccessConfirmed(false) }}
                />
                <label style={LABEL} htmlFor={`pico-publish-access-${mode}`}>{t(ACCESS_LABEL_KEYS[mode])}</label>
              </div>
              <p style={ACCESS_HINT} data-role={`access-hint-${mode}`}>{t(ACCESS_HINT_KEYS[mode])}</p>
            </div>
          ))}
        </fieldset>

        {/*
          访问范围被改动 ⇒ 必须显式确认（P1-3）。文案写清"当前 X → 提交后 Y"：
          这一改动会立刻决定谁能打开该应用，服务端还会为此写一条
          `wasm_app_access_change` 审计 —— 它不该发生在"作者没注意单选框"的时候。
        */}
        {accessChanged && (
          <div style={{ ...BOX, marginTop: 8 }} data-role="access-change">
            <div data-role="access-change-detail">
              {`${t('appCenter.accessChange')}: ${t(ACCESS_LABEL_KEYS[initial.currentAccess!])} → ${t(ACCESS_LABEL_KEYS[access])}`}
            </div>
            <label style={{ ...LABEL, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                className="pico-app-center-access-confirm"
                data-role="access-change-confirm"
                type="checkbox"
                checked={accessConfirmed}
                disabled={busy}
                onChange={event => { setAccessConfirmed(event.target.checked) }}
              />
              {t('appCenter.accessChangeConfirm')}
            </label>
          </div>
        )}

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
        {/*
          `data_sensitivity` **没有平台默认值**（`appcfg.json` 的 hints 原话：
          "不要指望界面或平台替你填"）——所以这一行必须写出来，而不是让作者以为
          界面已经替他声明过了（P1-3 第二条：硬填 internal 会把所有应用的合规声明
          统一抹平成同一个值）。
        */}
        <span style={LABEL} data-role="data-sensitivity-note">{t('appCenter.dataSensitivityNoDefault')}</span>
        <span style={LABEL}>{t('appCenter.declarationsHint')}</span>

        {/*
          窗口声明（F3/§6）：比例与首次打开的尺寸。**留空 = 不声明** ——
          客户端不替作者填缺省值，也不在界面上声称"已锁比例"（锁定由窗口侧按这里
          声明的比例执行；没声明就没有可锁的比例）。
        */}
        <div style={{ ...ROW, marginTop: 10 }}>
          <input
            className="pico-app-center-window-ratio"
            data-field="window.ratio"
            style={INPUT}
            value={windowRatioText}
            disabled={busy}
            aria-label={t('appCenter.windowRatio')}
            placeholder={t('appCenter.windowRatio')}
            onChange={event => { setWindowRatioText(event.target.value) }}
          />
          <input
            className="pico-app-center-window-width"
            data-field="window.width"
            style={INPUT}
            value={windowWidthText}
            disabled={busy}
            aria-label={t('appCenter.windowWidth')}
            placeholder={t('appCenter.windowWidth')}
            onChange={event => { setWindowWidthText(event.target.value) }}
          />
          <input
            className="pico-app-center-window-height"
            data-field="window.height"
            style={INPUT}
            value={windowHeightText}
            disabled={busy}
            aria-label={t('appCenter.windowHeight')}
            placeholder={t('appCenter.windowHeight')}
            onChange={event => { setWindowHeightText(event.target.value) }}
          />
        </div>
        <span style={LABEL} data-role="window-hint">{t('appCenter.windowHint')}</span>
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
      {state.kind === 'done' && <PublishSuccessBlock result={state.result} access={state.access} />}

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
 *
 * `title` / `role` 可覆盖：作者生命周期（下架/删除/诊断，`AppCenterPanel`）复用**同一份**
 * 渲染 —— 一次 403 在发布块与下架块上必须逐字段同形，两处各写一份必然漂移。
 * @param props - 结构化失败、可选标题与 `data-role`。
 */
export function PublishErrorBlock({ failure, title, role = 'publish-error' }: {
  failure: PublishFailure
  title?: string
  role?: string
}) {
  return (
    <div style={BOX} data-role={role} role="alert">
      <div><strong>{title ?? t('appCenter.failed')}</strong></div>
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
 * 成功块：版本 / 状态（已生效 / 待审核 / **已下架**）/ 访问范围 / **分享深链** ——
 * 员工提交完立刻知道"生效了没有、谁能用、怎么发给同事"。
 *
 * 状态三分支（R1-uxc-1）：`app.enabled === false` 时**绝不能**显示"已生效" ——
 * 服务端确实把版本落了库（`release.status=approved`、`current=true`），但应用处于下架
 * 状态，打开会被拒，界面说"已生效"就是谎报。这一支必须同时给出**下一步**
 * （先上架），否则作者只知道"没生效"而不知道怎么办。
 *
 * 回显 `access`（P1-3 的兜底要求）：发布是"整体替换配置"的语义，回显是作者唯一
 * 能事后核对"线上访问范围到底是什么"的地方（服务端发布响应里没有 `access`，
 * 所以回显的是**本次提交**的值 —— 服务端若没接受它就不会走到这个块）。
 *
 * 分享形态（2026-09-19，冻结契约 §4.5）：应用**没有**可贴进浏览器的地址，服务端也
 * 不再下发 `entry_url`；能发给同事的是**渠道深链** `<渠道 scheme>://app/<app_id>`
 * （scheme 由随渠道构建/桌面壳注入，见 `deep-link.ts`）。scheme 拿不到时这一行不渲染
 * —— 宁可少一行，也不显示一条打不开的链接。
 * @param props - 结构化成功结果 + 本次提交的访问级别 + 可选分享 scheme。
 */
export function PublishSuccessBlock({ result, access, shareScheme }: { result: PublishSuccess, access?: AccessMode, shareScheme?: string }) {
  const shareLink = appShareLink(result.appId, shareScheme)
  return (
    <div style={BOX} data-role="publish-success">
      <div><strong>{t('appCenter.published')}</strong></div>
      <div data-role="published-version">{`${t('appCenter.versionLabel')}: ${result.version}`}</div>
      {!result.enabled
        ? (
            <>
              <div data-role="published-status" data-enabled="false">{t('appCenter.publishedDisabled')}</div>
              <div data-role="published-disabled-hint">{t('appCenter.publishedDisabledHint')}</div>
            </>
          )
        : (
            <div data-role="published-status" data-enabled="true">
              {result.pending ? t('appCenter.publishedPending') : t('appCenter.publishedLive')}
            </div>
          )}
      {access !== undefined && (
        <div data-role="published-access" data-access={access}>
          {`${t('appCenter.access')}: ${t(ACCESS_LABEL_KEYS[access])}`}
        </div>
      )}
      {shareLink !== null && (
        <div data-role="published-share">{`${t('appCenter.shareLink')}: ${shareLink}`}</div>
      )}
    </div>
  )
}

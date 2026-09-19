import { useCallback, useEffect, useState } from 'react'
import { PublishForm } from './PublishForm.tsx'
import { openAppEntry } from './open-app.ts'
import { safeEntryURL } from './open-app.ts'
import { ACCESS_MODES, DEFAULT_ACCESS, type AccessMode } from './appcfg-contract.ts'
import { parseErrorEnvelope, type PublishTarget } from './publish-app.ts'
import { t, type AppCenterKey } from './locales.ts'

/**
 * 应用中心（App Center，R34）——「同事做的小工具」的目录。
 *
 * 四条产品约定（都来自设计基线，不是自由发挥）：
 *
 *  - **目录一律展示全部应用**（2026-09-18 拍板）。**不再按可见性过滤**：`visible` 字段
 *    已从契约里删除，"公开 / 登录后使用 / 仅白名单"只决定**谁能用**，不决定**谁能看见**
 *    （白名单应用也列出来，点开由应用自己判并返回它的 403 页）。服务端
 *    `GET /api/client/v2/apps/wasm/catalog` 给什么就渲染什么，客户端不新增第二条筛选规则
 *    —— 两份规则迟早给出不同答案，而"为什么这个应用看不到"会变成无法回答的问题。
 *  - **标出访问级别**：用服务端下发的 `access`（三模式之一），让"点开会被拦吗"在点击
 *    之前就有答案。`access` 尚未就绪时的过渡兼容见 {@link resolveAccess}。
 *  - **下架的条目也要展示**（`enabled=false` 显示"已下架"并禁用打开）：下架不等于不存在，
 *    直接从目录里消失会让用户以为是自己看错了。
 *  - **R36：不显示额度/用量**。额度唯一的入口是桌面客户端本来的账号卡；这一页只有
 *    名称 / 一句话说明 / 负责人 / 访问级别 / 入口链接。**不做安装语义**：应用在子域上，
 *    点开即用（没有"装到本地"这一步）。
 *
 * @module @picoaide/dsh-wasm-apps/client/AppCenterPanel
 */

/** 目录条目（服务端 `catalog` 的字段子集；未知字段一律忽略）。 */
export interface AppCenterItem {
  appId: string
  title: string
  description: string
  responsible: string
  entryURL: string
  /** 访问级别（服务端 `access`）：决定"点开会不会被应用拦下"。 */
  access: AccessMode
  /** 是否上架（服务端 `enabled`）；`false` = 已下架，仍然展示但禁用打开。 */
  enabled: boolean
  /**
   * 当前线上版本（服务端 `current_version`；空串 = 服务端没有版本行）。
   *
   * 为什么这一页必须有它（P1-4）：`wasm_app_list` 的工具描述要求模型"先查当前版本，
   * 新版本号必须严格大于它"，而目录行原先**没有版本字段** ⇒ 模型只能猜；
   * 猜错的代价是一次完整上传（≤32 MiB）+ 审计拒绝 + 消耗上传额度。
   * 同一份目录也是面板的"当前版本"来源，两处同源。
   */
  currentVersion: string
  /**
   * 调用者是不是这个应用的发布者（服务端 `is_owner`）。
   *
   * 用途：①只有发布者能发新版（服务端 `ownedApp` 对非发布者一律 404），
   * UI 据此给出/隐藏"发新版"入口；②`purpose` / `whitelist` **只对发布者下发**
   * （账号名单不外泄，见 `appcfg-contract.ts` 的 `CATALOG_ROW_AUTHOR_FIELDS`）。
   */
  isOwner: boolean
  /** 用途声明（**仅发布者本人**的目录行有；发新版时预填，见 P1-3）。 */
  purpose?: string
  /** 准入名单（**仅发布者本人**的目录行有；发新版时预填）。 */
  whitelist?: string[]
}

/**
 * 解析一条目录行的访问级别。
 *
 * **过渡兼容（可删）**：`access` 三模式与服务端 `api/read.go` 的 catalog 是同一批改动
 * 的两半，落地过程中服务端可能还在下发旧的 `login_required` / `whitelist`。因此
 * `access` 缺失时按旧字段回落读取：
 *
 * ```
 * access ?? (login_required === false ? 'public' : (whitelist?.length ? 'whitelist' : 'login'))
 * ```
 *
 * 这条分支**只在 `access` 缺席时生效**（服务端一旦返回 `access` 它就永远不会被走到）。
 * 它的价值是"迁移期间不要把每个应用都误标成登录后使用"；确认服务端已下发 `access`
 * 之后（`appcfg-contract.spec.ts` 的对拍 + 一次真实目录响应）即可删除。
 * @param row - 服务端目录行。
 * @returns 三模式之一；服务端给了非法值时回落成 `login`（缺省模式，不放大权限）。
 */
export function resolveAccess(row: Record<string, unknown>): AccessMode {
  const raw = row.access
  if (typeof raw === 'string') {
    if ((ACCESS_MODES as readonly string[]).includes(raw)) return raw as AccessMode
    // **给了但非法**（不是缺失）⇒ 按缺省模式处理，绝不落到下面的旧字段分支：
    // 那一条会把"服务端下发了一个我们还不认识的新模式"翻译成 `public`
    // （`login_required === false` 时），也就是**把权限放大**。
    // 独立审计 2026-09-18 在 DOM 上复现过这条（`access: 'org'` + `login_required: false`
    // 渲染成「公开」）；不认识的值一律按最保守的缺省显示。
    return DEFAULT_ACCESS
  }
  // ---- 以下是过渡兼容分支（**只在 access 缺失时**生效，见函数注释）：access 就绪后删除 ----
  if (row.login_required === false) return 'public'
  if (Array.isArray(row.whitelist) && row.whitelist.length > 0) return 'whitelist'
  return DEFAULT_ACCESS
}

/** 访问级别徽标的字典键。 */
const ACCESS_BADGE_KEYS: Record<AccessMode, AppCenterKey> = {
  public: 'appCenter.accessBadge.public',
  login: 'appCenter.accessBadge.login',
  whitelist: 'appCenter.accessBadge.whitelist',
}

/**
 * 访问级别的展示文案（短标签，目录行里用）。
 * @param access - 访问级别。
 * @returns 当前语言下的短标签。
 */
export function accessBadge(access: AccessMode): string {
  return t(ACCESS_BADGE_KEYS[access])
}

/** 面板状态机。 */
export type AppCenterState =
  | { kind: 'loading' }
  | { kind: 'error', error: AppCenterError }
  | { kind: 'ready', items: AppCenterItem[] }

/**
 * 错误态的可执行信息（P1-5）。
 *
 * 宿主与服务端给的都是 `{error:{code,message,details,hints}}` 信封，而面板原先
 * 在非 2xx 时**丢掉响应体**、只拼一句 `加载失败 (HTTP 502)` —— 于是"服务端到底说了
 * 什么、该怎么修"全部消失。这里逐字段带上，渲染成与发布失败块同一形状。
 */
export interface AppCenterError {
  /** 人可读的主要文案（401 时换成"登录后可以查看应用中心"）。 */
  message: string
  /** 稳定错误码（服务端信封的 `code`，缺失时回落 `HTTP_<status>` / `NETWORK_ERROR`）。 */
  code: string
  /** 可执行建议（信封的 `hints` 原样）。 */
  hints: string[]
  /** 诊断原文（目录形状对不上时是服务端下发的原始行样本）。 */
  details?: string
}

/** {@link parseCatalogReport} 的结果：条目 + 行数统计（P2-10 的诊断用）。 */
export interface CatalogReport {
  /** 归一化后的条目。 */
  items: AppCenterItem[]
  /** 服务端下发的行数；`apps` 不是数组时为 0。 */
  rows: number
  /** 因为没有合法 `app_id` 而被跳过的行数。 */
  skipped: number
  /** 被跳过行的**原文**样本（截断；面板据此报"下发的到底是什么形状"）。 */
  sample: string
}

/** 诊断样本的字节上限（够看清字段名，不至于把整页日志灌满）。 */
const CATALOG_SAMPLE_MAX = 400

/**
 * 解析目录载荷并**统计跳过的行**（纯函数，便于单测）。
 *
 * 字段名与 server 的 `catalog` 行一一对应（`app_id`/`title`/`description`/
 * `responsible`/`entry_url`/`access`/`enabled`/`current_version`/`is_owner`，
 * 发布者本人另有 `purpose`/`whitelist`）；`title` 缺失时回落到 `app_id`
 * （应用名就是域名，至少能让人认出是哪个）。
 *
 * **不丢任何一行**：这里只有"这条不是合法对象 / 没有合法 app_id"才跳过，没有任何
 * 按可见性/权限/上下架的筛选（目录展示全部应用）。但**跳过必须是可诊断的**：
 * 字段改名（`visible`→`access` 那次就是）会让每一行都被跳过，面板那时显示的是
 * 空态"还没有可用的应用" —— 一个把契约漂移说成"你没有应用"的假答案。
 * @param payload - `GET /api/pico/apps/wasm` 的响应体。
 * @returns 条目 + 行数统计（结构不对时 `rows = 0`、`items` 为空）。
 */
export function parseCatalogReport(payload: unknown): CatalogReport {
  const rows = (payload as { apps?: unknown } | null)?.apps
  if (!Array.isArray(rows)) return { items: [], rows: 0, skipped: 0, sample: '' }
  const items: AppCenterItem[] = []
  const skippedRows: unknown[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      skippedRows.push(row)
      continue
    }
    const entry = row as Record<string, unknown>
    const appId = typeof entry.app_id === 'string' ? entry.app_id : ''
    if (appId === '') {
      skippedRows.push(row)
      continue
    }
    items.push({
      appId,
      title: typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title : appId,
      description: typeof entry.description === 'string' ? entry.description : '',
      responsible: typeof entry.responsible === 'string' ? entry.responsible : '',
      entryURL: typeof entry.entry_url === 'string' ? entry.entry_url : '',
      access: resolveAccess(entry),
      // 服务端**会**下发 enabled（下架条目也照样列在目录里，见 api/read.go），
      // 所以这里只在字段缺失时才按"上架"兜底。
      enabled: entry.enabled !== false,
      // 版本缺失 ⇒ 空串（服务端版本行被保留策略回收时会这样）；面板显示为"未知"，
      // **不编造**一个版本号。
      currentVersion: typeof entry.current_version === 'string' ? entry.current_version : '',
      // 归属缺失 ⇒ false：不给"发新版"入口（服务端仍会兜底拒绝，见 ownedApp）。
      isOwner: entry.is_owner === true,
      // 这两个字段只对发布者下发（作者预填用）；缺席时保持缺席，
      // 让"没拿到"和"拿到空值"在类型上可区分。
      ...(typeof entry.purpose === 'string' ? { purpose: entry.purpose } : {}),
      ...(Array.isArray(entry.whitelist)
        ? { whitelist: entry.whitelist.filter((account): account is string => typeof account === 'string') }
        : {}),
    })
  }
  return {
    items,
    rows: rows.length,
    skipped: skippedRows.length,
    sample: skippedRows.length === 0 ? '' : truncate(JSON.stringify(skippedRows.slice(0, 3)), CATALOG_SAMPLE_MAX),
  }
}

/**
 * 解析目录载荷（{@link parseCatalogReport} 的条目部分）。
 * @param payload - `GET /api/pico/apps/wasm` 的响应体。
 * @returns 归一化后的条目；结构不对时返回空数组。
 */
export function parseCatalog(payload: unknown): AppCenterItem[] {
  return parseCatalogReport(payload).items
}

/**
 * 截断字符串（诊断样本用；超长时明说被截断了）。
 * @param text - 原文。
 * @param max - 字节上限。
 * @returns 截断后的文本。
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(truncated)`
}

/**
 * 入口链接的展示文本（只显示主机名：完整 URL 太长，而 <app_id>.<基域> 的
 * 主机名本身就是"这是什么应用"的第二个答案）。
 * @param entryURL - 服务端下发的入口链接。
 * @returns 主机名，或原串（解析失败时）。
 */
export function entryHostLabel(entryURL: string): string {
  const url = safeEntryURL(entryURL)
  if (url === null) return entryURL
  try {
    return new URL(url).host
  } catch {
    return entryURL
  }
}

const OVERLAY: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const MASK: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--dsw-alias-bg-mask-1)',
  backdropFilter: 'var(--dsw-mask-blur)',
}

const PANEL: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column',
  width: 720,
  maxWidth: 'calc(100vw - 48px)',
  height: 'min(680px, calc(100vh - 48px))',
  borderRadius: 24,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'var(--dsw-shadow-lv3)',
}

const HEADER: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 54,
  boxSizing: 'border-box',
  padding: '14px 18px',
}

const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  lineHeight: '24px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
}

const SUBTITLE: React.CSSProperties = {
  margin: '2px 0 0',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

const CLOSE: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 18,
  lineHeight: '24px',
  padding: '2px 6px',
}

/** 面板头部右侧的发布入口（FIX-38：整条发布链路唯一的员工调用方）。 */
const PUBLISH_ENTRY: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  padding: '4px 12px',
}

const BODY: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '4px 18px 18px',
}

const CARD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 14px',
  marginBottom: 8,
  borderRadius: 14,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
}

const ROW_MAIN: React.CSSProperties = { flex: 1, minWidth: 0 }

const TITLE_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }

/** 访问级别徽标（短标签；放在标题右侧，让"点开会不会被拦"在点击前可见）。 */
const BADGE: React.CSSProperties = {
  flex: 'none',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l2)',
  padding: '0 8px',
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'nowrap',
}

/** 已下架徽标（比访问级别更弱一等：状态而不是能力）。 */
const DISABLED_BADGE: React.CSSProperties = { ...BADGE, color: 'var(--dsw-alias-label-tertiary)' }

const ROW_TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '22px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const ROW_DESC: React.CSSProperties = {
  margin: '2px 0 0',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

const ROW_META: React.CSSProperties = {
  margin: '4px 0 0',
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const OPEN_BUTTON: React.CSSProperties = {
  flex: 'none',
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

const HINT: React.CSSProperties = {
  padding: '28px 18px',
  textAlign: 'center',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  lineHeight: '20px',
}

/** 建议列表（错误信封的 `hints`；与发布失败块的形状一致）。 */
const HINT_LIST: React.CSSProperties = { margin: '6px 0 0', paddingLeft: 18 }

/** 诊断原文（服务端下发的原始行样本 / 非 JSON body）。 */
const DETAILS: React.CSSProperties = {
  margin: '8px 0 0',
  maxHeight: 160,
  overflow: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  lineHeight: '16px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}

/**
 * 应用中心面板（模态）。
 *
 * 两个视图（FIX-38）：**目录**（默认，只读）与**发布**（员工发布入口）。发布由页面
 * 上下文 `POST /api/pico/apps/wasm/publish` —— 页面天然持 `dsh-auth-*` 持有性证明，
 * 因此不需要任何新的信任机制；分片/续传/90 s 预算全部复用宿主那一份编排。
 *
 * @param props - `onClose` 由触发按钮提供（关闭时卸载面板）。
 */
export function AppCenterPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<AppCenterState>({ kind: 'loading' })
  const [view, setView] = useState<'catalog' | 'publish'>('catalog')
  // 发布基线（P1-3）：目录行的"发新版"按钮把它带进表单；`undefined` = 首版发布。
  const [publishTarget, setPublishTarget] = useState<PublishTarget | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const response = await fetch('/api/pico/apps/wasm')
      if (!response.ok) {
        // 非 2xx 时**必须解析响应体**（P1-5）：宿主/服务端给的是可执行的
        // `{error:{code,message,details,hints}}`（例如网关的 GATEWAY_UNAVAILABLE +
        // "检查网络与服务端地址"），只拼状态码等于把可自修的信息全丢掉。
        const text = await response.text().catch(() => '')
        let payload: unknown = null
        try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
        const failure = parseErrorEnvelope(response.status, payload, text === '' ? t('appCenter.error') : text.slice(0, CATALOG_SAMPLE_MAX))
        setState({
          kind: 'error',
          error: {
            code: failure.code,
            // 401 = 未登录（宿主路由的 AUTH_REQUIRED）：这是可读的常态，不是崩溃。
            message: response.status === 401 ? t('appCenter.notLoggedIn') : failure.message,
            hints: failure.hints,
            ...(failure.details === undefined ? {} : { details: typeof failure.details === 'string' ? failure.details : JSON.stringify(failure.details) }),
          },
        })
        return
      }
      const report = parseCatalogReport(await response.json())
      // 服务端**下发了行**却一行都没解析出来 ⇒ 契约漂移（字段改名），必须报错而不是
      // 显示"还没有可用的应用"：后者把"我们的解析坏了"说成"你没有应用"（P2-10）。
      if (report.rows > 0 && report.items.length === 0) {
        setState({
          kind: 'error',
          error: {
            code: 'CATALOG_SHAPE_MISMATCH',
            message: t('appCenter.catalogShapeMismatch'),
            hints: [t('appCenter.catalogShapeHint')],
            details: report.sample,
          },
        })
        return
      }
      setState({ kind: 'ready', items: report.items })
    } catch (cause) {
      setState({
        kind: 'error',
        error: {
          code: 'NETWORK_ERROR',
          message: cause instanceof Error ? cause.message : String(cause),
          hints: [],
        },
      })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Esc 关闭：模态的可预期出口（与能力中心一致的口径）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  return (
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label={t('appCenter.title')} className="pico-app-center">
      <div style={MASK} onClick={onClose} />
      <div style={PANEL}>
        <div style={HEADER}>
          <div>
            <h2 style={TITLE}>{t('appCenter.title')}</h2>
            <p style={SUBTITLE}>{view === 'publish' ? t('appCenter.publishTitle') : t('appCenter.subtitle')}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {view === 'catalog' && (
              <button
                type="button"
                className="pico-app-center-publish"
                data-action="open-publish"
                style={PUBLISH_ENTRY}
                aria-label={t('appCenter.publishAria')}
                // 表头的"发布"= **首版**发布：不带基线，因此不预填任何"当前值"。
                onClick={() => { setPublishTarget(undefined); setView('publish') }}
              >
                {t('appCenter.publish')}
              </button>
            )}
            <button type="button" style={CLOSE} onClick={onClose} aria-label={t('appCenter.close')}>✕</button>
          </div>
        </div>
        <div style={BODY}>
          {view === 'catalog'
            ? (
                <AppCenterBody
                  state={state}
                  onRetry={() => { void load() }}
                  onPublish={() => { setPublishTarget(undefined); setView('publish') }}
                  onPublishNewVersion={item => {
                    // 把目录行的当前值交给表单（P1-3）：预填是"不静默改写线上配置"
                    // 的唯一手段 —— 作者不动单选框时提交的就是现状。
                    setPublishTarget({
                      appId: item.appId,
                      title: item.title,
                      access: item.access,
                      currentVersion: item.currentVersion,
                      owner: item.responsible,
                      ...(item.purpose === undefined ? {} : { purpose: item.purpose }),
                      ...(item.whitelist === undefined ? {} : { whitelist: item.whitelist }),
                    })
                    setView('publish')
                  }}
                />
              )
            : (
                <PublishForm
                  {...(publishTarget === undefined ? {} : { target: publishTarget })}
                  onClose={() => { setView('catalog') }}
                  onPublished={() => { void load() }}
                />
              )}
        </div>
      </div>
    </div>
  )
}

/**
 * 面板正文：把四种状态渲染成 DOM（loading / error / empty / list）。
 *
 * 单独导出而不是内联在 {@link AppCenterPanel} 里，是为了让"目录渲染 / 空态 /
 * 不含额度字段"这三条断言可以**直接渲染**；而"挂载后真的取数"这条链路由
 * `app-center-mount.spec.tsx` 用真挂载（跑 `useEffect`）+ 真路由覆盖（FIX-42）。
 * @param props - 当前状态、重试回调、"去发布"回调与"给该应用发新版"回调。
 */
export function AppCenterBody({ state, onRetry, onPublish, onPublishNewVersion }: {
  state: AppCenterState
  onRetry: () => void
  onPublish?: () => void
  onPublishNewVersion?: (item: AppCenterItem) => void
}) {
  return (
    <>
      {state.kind === 'loading' && <div style={HINT}>{t('appCenter.loading')}</div>}
      {state.kind === 'error' && (
        <div style={HINT} data-role="catalog-error">
          {/* 错误信封逐字段显示（P1-5）：code + message + hints（+ 可选原文）。 */}
          <div data-role="error-code">{`${t('appCenter.errorCode')}: ${state.error.code}`}</div>
          <div data-role="error-message">{state.error.message}</div>
          {state.error.hints.length > 0 && (
            <ul style={{ ...HINT_LIST, textAlign: 'left' }} data-role="error-hints">
              {state.error.hints.map(hint => <li key={hint}>{hint}</li>)}
            </ul>
          )}
          {state.error.details !== undefined && state.error.details !== '' && (
            <pre style={{ ...DETAILS, textAlign: 'left' }} data-role="error-details">{state.error.details}</pre>
          )}
          <button type="button" className="pico-app-center-retry" style={{ ...OPEN_BUTTON, marginTop: 12 }} onClick={onRetry}>
            {t('appCenter.retry')}
          </button>
        </div>
      )}
      {state.kind === 'ready' && state.items.length === 0 && (
        <div style={HINT}>
          <div>{t('appCenter.empty')}</div>
          <div style={{ marginTop: 6 }}>{t('appCenter.emptyHint')}</div>
          {onPublish !== undefined && (
            <button type="button" className="pico-app-center-empty-publish" style={{ ...OPEN_BUTTON, marginTop: 12 }} onClick={onPublish}>
              {t('appCenter.publish')}
            </button>
          )}
        </div>
      )}
      {state.kind === 'ready' && state.items.map(item => (
        <AppCenterRow
          key={item.appId}
          item={item}
          {...(onPublishNewVersion === undefined ? {} : { onPublishNewVersion })}
        />
      ))}
    </>
  )
}

/**
 * 一行应用：名称 / 访问级别 / 当前版本 / 一句话说明 / 负责人 / 入口链接 / 打开 /
 * （发布者本人）发新版。
 *
 * 下架的条目（`enabled=false`）**照常展示**并标出"已下架"，只是打开按钮禁用 ——
 * 直接从目录消失会让用户以为是自己看错了。
 *
 * 点击"打开"走 {@link openAppEntry}（内置浏览器优先、系统浏览器兜底）；
 * 链接非法（或已下架）时按钮禁用 —— 一个点不动的按钮比一个什么都不做的按钮诚实。
 * @param props - 目录条目与"发新版"回调。
 */
export function AppCenterRow({ item, onPublishNewVersion }: { item: AppCenterItem, onPublishNewVersion?: (item: AppCenterItem) => void }) {
  const [opening, setOpening] = useState(false)
  const openable = item.enabled && safeEntryURL(item.entryURL) !== null
  const open = (): void => {
    if (!openable) return
    setOpening(true)
    void openAppEntry(item.entryURL).finally(() => { setOpening(false) })
  }
  // "发新版"只给发布者本人（P1-3 的入口）：服务端 `ownedApp` 对非发布者一律 404，
  // 给别人一个必然失败的按钮不如不给。
  const canPublish = item.isOwner && onPublishNewVersion !== undefined
  return (
    <div style={CARD} className="pico-app-center-card">
      <div style={ROW_MAIN}>
        <div style={TITLE_ROW}>
          <h3 style={ROW_TITLE} title={item.title}>{item.title}</h3>
          <span
            style={BADGE}
            className="pico-app-center-access"
            data-role="access-level"
            data-access={item.access}
          >
            {accessBadge(item.access)}
          </span>
          {!item.enabled && (
            <span style={DISABLED_BADGE} className="pico-app-center-disabled" data-role="app-disabled">
              {t('appCenter.disabled')}
            </span>
          )}
        </div>
        {item.description !== '' && <p style={ROW_DESC}>{item.description}</p>}
        <p style={ROW_META}>
          {/* 当前版本（P1-4）：发新版前必须能看见它 —— 新版本号要严格大于它。 */}
          {item.currentVersion !== '' && (
            <span className="pico-app-center-current-version" data-role="current-version">
              {`${t('appCenter.currentVersion')}: ${item.currentVersion}`}
            </span>
          )}
          {item.currentVersion !== '' && <span>{' · '}</span>}
          {item.responsible !== '' && <span>{`${t('appCenter.responsible')}: ${item.responsible}`}</span>}
          {item.responsible !== '' && item.entryURL !== '' && <span>{' · '}</span>}
          {item.entryURL !== '' && <span className="pico-app-center-entry">{entryHostLabel(item.entryURL)}</span>}
        </p>
      </div>
      {canPublish && (
        <button
          type="button"
          className="pico-app-center-publish-new"
          data-action="publish-new-version"
          style={OPEN_BUTTON}
          aria-label={`${t('appCenter.publishNewVersionAria')} ${item.title}`}
          onClick={() => { onPublishNewVersion?.(item) }}
        >
          {t('appCenter.publishNewVersion')}
        </button>
      )}
      <button
        type="button"
        style={{ ...OPEN_BUTTON, ...(openable && !opening ? {} : { opacity: 0.5, cursor: 'default' }) }}
        onClick={open}
        disabled={!openable || opening}
        aria-label={`${t('appCenter.openAria')} ${item.title}`}
      >
        {t('appCenter.open')}
      </button>
    </div>
  )
}

/**
 * 画板浮层：路径上板 / 便签上板 / 搜索上板 / 预览 / 移除确认。
 * 搜索上板：走宿主真实搜索（searchLocalFiles，复用 search-docs 的
 * mdfind/rg/walk provider，与 memory_evolve_search_local_files 同源）；
 * 范围可选本机全部（缺省）/ 当前项目。预览：后端可用时图片/文本/PDF
 * 走文件代理，否则占位色块。
 */
import { useCallback, useRef, useState } from 'react'
import type { MemoryEvolveTranslate } from '../index.ts'
import { TYPE_GLYPH, typeLabel } from './constants.ts'
import { inferTypeFromPath, placeholderHue } from './helpers.ts'
import { fileProxyUrl, searchFilesBackend } from './api-client.ts'
import type { CanvasDialogKind, CanvasNode, CanvasNodeType } from './types.ts'

export interface PathSubmit {
  path: string
}

export interface NoteSubmit {
  title: string
  type: 'markdown' | 'plainText'
  content: string
}

export interface CanvasDialogsProps {
  /** 插件 locale 翻译函数（i18n：文案一律经它取，不再硬编码中文）。 */
  t: MemoryEvolveTranslate
  kind: CanvasDialogKind
  previewNode: CanvasNode | null
  removeNode: CanvasNode | null
  /** 迁移归属对话框的目标节点（2026-08-14）。 */
  migrateNode: CanvasNode | null
  /** 后端可用标记：true 时预览走宿主文件代理。 */
  backendReady: boolean
  /** 当前会话 id（真实搜索按它定位默认搜索目录=会话工作目录）。 */
  sessionId: string
  onClose: () => void
  onPath: (payload: PathSubmit) => void
  onNote: (payload: NoteSubmit) => void
  onCatalog: (title: string, path: string, type: CanvasNodeType, size?: string) => void
  onConfirmRemove: () => void
  onToast: (text: string) => void
  /** 系统默认应用打开上板文件（2026-08-14 接入真实实现）。 */
  onOpen: (id: string) => void
  /** 迁移节点归属（2026-08-14 用户拍板：仅用户手动触发）。 */
  onMigrate: (nodeId: string, scope: 'session' | 'project' | 'global') => void
}

function PathDialog(props: { t: MemoryEvolveTranslate; onClose: () => void; onPath: (p: PathSubmit) => void }): JSX.Element {
  const { t } = props
  const [path, setPath] = useState('')
  const guessed = inferTypeFromPath(path)
  return (
    <div className="cg-dialog" role="dialog" aria-label={t('canvas.dialog.path.title')}>
      <h3>{t('canvas.dialog.path.title')}</h3>
      <p>{t('canvas.dialog.path.desc')}</p>
      <div className="cg-field">
        <label htmlFor="cg-path-input">{t('canvas.dialog.path.label')}</label>
        <input
          id="cg-path-input"
          autoFocus
          value={path}
          placeholder="/Users/me/Documents/contract.pdf"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && path.trim()) props.onPath({ path })
            if (e.key === 'Escape') props.onClose()
          }}
        />
      </div>
      <div className="cg-hint">
        {t('canvas.dialog.path.detected', { glyph: TYPE_GLYPH[guessed], label: typeLabel(guessed, t) })}
      </div>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>{t('canvas.action.cancel')}</button>
        <button
          type="button"
          className="cg-btn cg-primary"
          disabled={!path.trim()}
          onClick={() => props.onPath({ path })}
        >
          {t('canvas.action.pin')}
        </button>
      </div>
    </div>
  )
}

function NoteDialog(props: { t: MemoryEvolveTranslate; onClose: () => void; onNote: (p: NoteSubmit) => void }): JSX.Element {
  const { t } = props
  const [title, setTitle] = useState(t('canvas.dialog.note.defaultTitle'))
  const [type, setType] = useState<'markdown' | 'plainText'>('markdown')
  const [content, setContent] = useState('')
  return (
    <div className="cg-dialog" role="dialog" aria-label={t('canvas.dialog.note.aria')}>
      <h3>{t('canvas.dialog.note.title')}</h3>
      <p>{t('canvas.dialog.note.desc')}</p>
      <div className="cg-field">
        <label htmlFor="cg-note-title">{t('canvas.dialog.field.title')}</label>
        <input id="cg-note-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="cg-field">
        <label htmlFor="cg-note-type">{t('canvas.dialog.field.type')}</label>
        <select
          id="cg-note-type"
          value={type}
          onChange={(e) => setType(e.target.value === 'plainText' ? 'plainText' : 'markdown')}
        >
          <option value="markdown">Markdown</option>
          <option value="plainText">{t('canvas.type.plainText')}</option>
        </select>
      </div>
      <div className="cg-field">
        <label htmlFor="cg-note-body">{t('canvas.dialog.field.content')}</label>
        <textarea id="cg-note-body" value={content} onChange={(e) => setContent(e.target.value)} />
      </div>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>{t('canvas.action.cancel')}</button>
        <button
          type="button"
          className="cg-btn cg-primary"
          onClick={() => props.onNote({ title: title.trim() || t('canvas.dialog.note.defaultTitle'), type, content })}
        >
          {t('canvas.action.pin')}
        </button>
      </div>
    </div>
  )
}

function CatalogDialog(props: {
  t: MemoryEvolveTranslate
  onClose: () => void
  onCatalog: (title: string, path: string, type: CanvasNodeType, size?: string) => void
  /** 后端可用标记：true 时走宿主真实搜索。 */
  backendReady: boolean
  /** 当前会话 id（后端按它解析项目搜索范围）。 */
  sessionId: string
}): JSX.Element {
  const { t } = props
  const [q, setQ] = useState('')
  // 搜索范围（2026-08-14 用户反馈：默认只能搜项目目录）：
  //   local（缺省）= 全盘搜索；project = 当前会话工作目录。
  const [scope, setScope] = useState<'local' | 'project'>('local')
  const [remoteRows, setRemoteRows] = useState<Array<{ title: string; path: string; type: string; size: string }> | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const searchSeq = useRef(0)

  // 2026-08-14 用户反馈：输入即搜（350ms 防抖）误触发太多——打字过程
  // 中光标还没移开就弹出结果/打断思路。改为**显式触发**：点「搜索」
  // 按钮或在输入框按回车才执行；输入/切范围只改状态不自动搜。
  const runSearch = useCallback(() => {
    const needle = q.trim()
    if (!props.backendReady) return
    if (!needle) {
      setRemoteRows(null)
      setSearchError(null)
      return
    }
    setSearching(true)
    setSearchError(null)
    const seq = ++searchSeq.current
    void searchFilesBackend(needle, { sessionId: props.sessionId, scope, limit: 20 }).then((rows) => {
      if (searchSeq.current !== seq) return // 过期响应丢弃（如切换范围后旧请求晚到）
      setSearching(false)
      setRemoteRows(rows)
      if (rows === null) setSearchError(t('canvas.dialog.catalog.error'))
    })
  }, [props.backendReady, props.sessionId, q, scope, t])

  // 切换搜索范围：旧范围的结果作废（避免「当前项目」下显示全盘结果
  // 的误导），清空并提示重新搜索；不自动搜，等用户点「搜索」。
  const changeScope = useCallback((next: 'local' | 'project') => {
    if (next === scope) return
    searchSeq.current++ // 使在途请求过期
    setScope(next)
    setRemoteRows(null)
    setSearchError(null)
    setSearching(false)
  }, [scope])

  const rows = props.backendReady && remoteRows !== null ? remoteRows : []
  return (
    <div className="cg-dialog" role="dialog" aria-label={t('canvas.dialog.catalog.title')}>
      <h3>{t('canvas.dialog.catalog.title')}</h3>
      <p>{t('canvas.dialog.catalog.desc')}</p>
      <div className="cg-field">
        <label htmlFor="cg-cat-q">{t('canvas.dialog.catalog.keyword')}</label>
        <div className="cg-search-row">
          <input
            id="cg-cat-q"
            autoFocus
            value={q}
            placeholder={t('canvas.dialog.catalog.placeholder')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch() }}
          />
          <button type="button" className="cg-btn cg-primary" onClick={runSearch} disabled={!q.trim()}>
            {t('canvas.action.search')}
          </button>
        </div>
      </div>
      <div className="cg-seg cg-scope" role="group" aria-label={t('canvas.dialog.catalog.scopeAria')}>
        <button type="button" className={scope === 'local' ? 'cg-on' : ''} onClick={() => changeScope('local')}>
          {t('canvas.dialog.catalog.scopeLocal')}
        </button>
        <button type="button" className={scope === 'project' ? 'cg-on' : ''} onClick={() => changeScope('project')}>
          {t('canvas.dialog.catalog.scopeProject')}
        </button>
      </div>
      {searching ? <div className="cg-hint">{t('canvas.dialog.catalog.searching')}</div> : null}
      {searchError ? <div className="cg-hint cg-hint-error">{searchError}</div> : null}
      <div className="cg-catalog">
        {!searching && rows.length === 0 ? (
          <div className="cg-hint">
            {q.trim() ? t('canvas.dialog.catalog.noMatch') : t('canvas.dialog.catalog.prompt')}
          </div>
        ) : null}
        {rows.map((item) => (
          <button
            key={item.path}
            type="button"
            className="cg-catalog-row"
            onClick={() => props.onCatalog(item.title, item.path, item.type as CanvasNodeType, item.size)}
          >
            <span aria-hidden>{TYPE_GLYPH[item.type as CanvasNodeType] ?? '▤'}</span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.path} · {item.size ?? ''}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>{t('canvas.action.close')}</button>
      </div>
    </div>
  )
}

function PreviewDialog(props: {
  t: MemoryEvolveTranslate
  node: CanvasNode
  /** 后端可用标记：true 时预览走宿主文件代理（真实文件内容）。 */
  backendReady: boolean
  onClose: () => void
  onToast: (text: string) => void
  /** 系统默认应用打开上板文件（2026-08-14 接入真实实现）。 */
  onOpen: (id: string) => void
}): JSX.Element {
  const { t, node } = props
  const light = node.type === 'markdown' || node.type === 'plainText' || node.type === 'image' || node.type === 'media'
  const hue = placeholderHue(node.id)
  const proxyUrl = props.backendReady ? fileProxyUrl(node.id) : ''
  return (
    <div className="cg-dialog cg-dialog-wide" role="dialog" aria-label={t('canvas.dialog.preview.aria')}>
      <h3>{TYPE_GLYPH[node.type]} {node.title}</h3>
      <p>
        {node.path ?? t('canvas.dialog.preview.noteOnly')}
        {node.unverified ? t('canvas.dialog.preview.unverified') : ''}
      </p>
      {node.type === 'markdown' || node.type === 'plainText' ? (
        <div className="cg-preview-body">{node.content || t('canvas.dialog.preview.empty')}</div>
      ) : null}
      {node.type === 'image' ? (
        proxyUrl ? (
          <img className="cg-preview-img" src={proxyUrl} alt={node.title} loading="lazy" decoding="async" />
        ) : (
          <div
            className="cg-ph"
            style={{
              minHeight: 180,
              background: `linear-gradient(145deg, hsl(${hue} 42% 46%), hsl(${(hue + 40) % 360} 38% 32%))`,
            }}
          >
            🖼
            <small>{t('canvas.dialog.preview.enableImage')}</small>
          </div>
        )
      ) : null}
      {node.type === 'media' ? (
        proxyUrl ? (
          /\.(mp3|wav|m4a|aac|ogg)$/i.test(node.path ?? '') ? (
            <audio className="cg-preview-media" src={proxyUrl} controls preload="metadata" />
          ) : (
            <video className="cg-preview-media" src={proxyUrl} controls preload="metadata" />
          )
        ) : (
          <div
            className="cg-ph"
            style={{
              minHeight: 160,
              background: `linear-gradient(160deg, hsl(${hue} 35% 38%), hsl(${(hue + 60) % 360} 30% 22%))`,
            }}
          >
            ▶
            <small>{t('canvas.dialog.preview.enableMedia')}</small>
          </div>
        )
      ) : null}
      {!light ? (
        <div>
          <p>{t('canvas.dialog.preview.unsupported')}</p>
          {node.path ? (
            <button
              type="button"
              className="cg-btn cg-ghost"
              onClick={() => props.onOpen(node.id)}
            >
              {t('canvas.action.openDefault')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-primary" onClick={props.onClose}>{t('canvas.action.close')}</button>
      </div>
    </div>
  )
}

function RemoveDialog(props: {
  t: MemoryEvolveTranslate
  node: CanvasNode
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const { t, node } = props
  return (
    <div className="cg-dialog" role="dialog" aria-label={t('canvas.dialog.remove.aria')}>
      <h3>{t('canvas.dialog.remove.title')}</h3>
      <p>
        {node.path
          ? t('canvas.dialog.remove.bodyWithPath', { title: node.title, path: node.path })
          : t('canvas.dialog.remove.body', { title: node.title })}
      </p>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>{t('canvas.action.cancel')}</button>
        <button type="button" className="cg-btn cg-primary" onClick={props.onConfirm}>{t('canvas.action.remove')}</button>
      </div>
    </div>
  )
}

/**
 * 迁移归属对话框（2026-08-14 用户拍板：改归属只能用户手动触发；
 * 目标会话 = 当前打开画板的会话）。三档去向：
 *   💬 本会话 → session 级（归当前会话 + 当前项目）
 *   📁 本项目 → project 级（项目内所有会话可见）
 *   🌐 所有项目可见 → global 级（所有视角可见）
 */
function MigrateDialog(props: {
  t: MemoryEvolveTranslate
  node: CanvasNode
  onClose: () => void
  onMigrate: (nodeId: string, scope: 'session' | 'project' | 'global') => void
}): JSX.Element {
  const { t } = props
  const [scope, setScope] = useState<'session' | 'project' | 'global'>(props.node.scope === 'global' ? 'global' : props.node.scope === 'project' ? 'project' : 'session')
  return (
    <div className="cg-dialog" role="dialog" aria-label={t('canvas.dialog.migrate.title')}>
      <h3>{t('canvas.dialog.migrate.title')}</h3>
      <p>{t('canvas.dialog.migrate.body', { title: props.node.title })}</p>
      <div className="cg-migrate-opts">
        <button type="button" className={`cg-migrate-opt${scope === 'session' ? ' cg-on' : ''}`} onClick={() => setScope('session')}>
          <strong>💬 {t('canvas.view.session')}</strong>
          <small>{t('canvas.dialog.migrate.sessionDesc')}</small>
        </button>
        <button type="button" className={`cg-migrate-opt${scope === 'project' ? ' cg-on' : ''}`} onClick={() => setScope('project')}>
          <strong>📁 {t('canvas.view.project')}</strong>
          <small>{t('canvas.dialog.migrate.projectDesc')}</small>
        </button>
        <button type="button" className={`cg-migrate-opt${scope === 'global' ? ' cg-on' : ''}`} onClick={() => setScope('global')}>
          <strong>🌐 {t('canvas.dialog.migrate.globalLabel')}</strong>
          <small>{t('canvas.dialog.migrate.globalDesc')}</small>
        </button>
      </div>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>{t('canvas.action.cancel')}</button>
        <button type="button" className="cg-btn cg-primary" onClick={() => props.onMigrate(props.node.id, scope)}>{t('canvas.action.migrate')}</button>
      </div>
    </div>
  )
}

export function CanvasDialogs(props: CanvasDialogsProps): JSX.Element | null {
  if (!props.kind) return null
  return (
    <div
      className="cg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      {props.kind === 'path' ? <PathDialog t={props.t} onClose={props.onClose} onPath={props.onPath} /> : null}
      {props.kind === 'note' ? <NoteDialog t={props.t} onClose={props.onClose} onNote={props.onNote} /> : null}
      {props.kind === 'catalog' ? (
        <CatalogDialog t={props.t} onClose={props.onClose} onCatalog={props.onCatalog} backendReady={props.backendReady} sessionId={props.sessionId} />
      ) : null}
      {props.kind === 'preview' && props.previewNode ? (
        <PreviewDialog t={props.t} node={props.previewNode} onClose={props.onClose} onToast={props.onToast} backendReady={props.backendReady} onOpen={props.onOpen} />
      ) : null}
      {props.kind === 'remove' && props.removeNode ? (
        <RemoveDialog t={props.t} node={props.removeNode} onClose={props.onClose} onConfirm={props.onConfirmRemove} />
      ) : null}
      {props.kind === 'migrate' && props.migrateNode ? (
        <MigrateDialog t={props.t} node={props.migrateNode} onClose={props.onClose} onMigrate={props.onMigrate} />
      ) : null}
    </div>
  )
}

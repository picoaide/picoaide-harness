/**
 * 单张素材卡片。
 *
 * 交互对齐参考项目 ResourceNodeCard：标题栏拖动手柄 + 类型图标 + 预览区 + 操作。
 * LOD（scale < 0.36）只渲染大图标，省掉 textarea / 占位图。
 * 位置用 left/top 写世界坐标，由外层世界层做 transform，卡片本身不跟视口重排。
 */
import { memo, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TYPE_GLYPH, typeLabel } from './constants.ts'
import { placeholderHue, scopeBadgeText } from './helpers.ts'
import type { CanvasNode } from './types.ts'
import { fileProxyUrl } from './api-client.ts'

export interface CanvasCardProps {
  /** 插件 locale 翻译函数（i18n：文案一律经它取，不再硬编码中文）。 */
  t: Translate
  node: CanvasNode
  /** 当前是否处于低细节档。变化才让 memo 失效。 */
  lod: boolean
  selected: boolean
  flashing: boolean
  dimmed: boolean
  highlighted: boolean
  /** 查看者会话 id：归属徽标按它判断「当前会话 / 其他会话」（2026-08-14）。 */
  currentSessionId?: string
  /** 后端可用：true 时图片/音视频卡片直接走文件代理渲染真实内容
   * （2026-08-14 用户反馈：卡片只有静态填充，至少图片要直接显示）。 */
  backendReady: boolean
  /** 双击「其他会话」徽标跳转对应会话（2026-08-14：主会话注入
   * ctx.sessions.open，与 web 通知铃铛同款路径）。 */
  openSession?: (sessionId: string) => void
  onSelect: (id: string) => void
  onDragStart: (id: string, event: ReactPointerEvent<HTMLElement>) => void
  /** 右下角缩放：id + 起始 pointer 事件（手势在 CanvasBoard 层统一管理）。 */
  onResizeStart: (id: string, event: ReactPointerEvent<HTMLElement>) => void
  onPreview: (id: string) => void
  /** 系统默认应用打开上板文件（2026-08-14：路径上板/搜索上板的一键打开）。 */
  onOpen: (id: string) => void
  /** 在系统文件管理器中打开上板文件**所在文件夹**（2026-08-14 用户
   * 要求：文件类型便签一键直达其所在目录）。 */
  onOpenFolder: (id: string) => void
  /** 保存文本/便签内容到本机文件（2026-08-14：弹系统保存对话框）。 */
  onSave: (id: string) => void
  /** 迁移节点归属（2026-08-14：仅用户手动触发，弹归属选择框）。 */
  onMigrate: (id: string) => void
  onCopy: (id: string, kind: 'id' | 'title' | 'path' | 'ref') => void
  onAskRemove: (id: string) => void
  onChangeContent: (id: string, content: string) => void
}

function extOf(path?: string): string {
  if (!path) return 'FILE'
  const base = path.split(/[/\\]/).pop() ?? path
  const i = base.lastIndexOf('.')
  if (i <= 0) return 'FILE'
  return base.slice(i + 1).toUpperCase().slice(0, 6)
}

function CardBody(props: { t: Translate; node: CanvasNode; backendReady: boolean; onChangeContent: CanvasCardProps['onChangeContent'] }): JSX.Element {
  const { t, node, backendReady, onChangeContent } = props
  const hue = placeholderHue(node.id)

  if (node.type === 'markdown' || node.type === 'plainText') {
    return (
      <>
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
        <textarea
          className="cg-editor"
          value={node.content ?? ''}
          placeholder={node.type === 'markdown' ? t('canvas.card.editorMarkdown') : t('canvas.card.editorPlain')}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          onChange={(e) => onChangeContent(node.id, e.target.value)}
        />
      </>
    )
  }

  if (node.type === 'image') {
    // 后端可用 + 有路径 → 卡片直接渲染真实图片（文件代理）；
    // 否则降级静态占位（2026-08-14 用户反馈：至少图片要直接显示）。
    const proxyUrl = backendReady && node.path ? fileProxyUrl(node.id) : ''
    return (
      <>
        {proxyUrl ? (
          <div className="cg-card-media-wrap">
            <img
              className="cg-card-media"
              src={proxyUrl}
              alt={node.title}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          </div>
        ) : (
          <div
            className="cg-ph"
            style={{
              background: `linear-gradient(145deg, hsl(${hue} 42% 46%), hsl(${(hue + 40) % 360} 38% 32%))`,
            }}
          >
            🖼
            <small>{t('canvas.card.imagePreview')}</small>
          </div>
        )}
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
      </>
    )
  }

  if (node.type === 'media') {
    // 后端可用 + 有路径 → 卡片直接渲染可播放的音视频（文件代理）；
    // 否则降级静态占位。
    const proxyUrl = backendReady && node.path ? fileProxyUrl(node.id) : ''
    const isAudio = Boolean(node.path?.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/))
    return (
      <>
        {proxyUrl ? (
          <div className="cg-card-media-wrap">
            {isAudio ? (
              <audio className="cg-card-media" src={proxyUrl} controls preload="metadata" />
            ) : (
              <video className="cg-card-media" src={proxyUrl} controls preload="metadata" />
            )}
          </div>
        ) : (
          <div
            className="cg-ph"
            style={{
              background: `linear-gradient(160deg, hsl(${hue} 35% 38%), hsl(${(hue + 60) % 360} 30% 22%))`,
            }}
          >
            ▶
            <small>{isAudio ? t('canvas.card.audio') : t('canvas.card.video')}</small>
          </div>
        )}
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
      </>
    )
  }

  if (node.type === 'folder') {
    return (
      <>
        <div className="cg-ph" style={{ fontSize: 32, minHeight: 56 }}>📁</div>
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
        <div className="cg-card-meta">{node.meta?.size ?? t('canvas.type.folder')}{t('canvas.card.folderNoBrowse')}</div>
      </>
    )
  }

  return (
    <>
      <span className="cg-file-ext">{extOf(node.path)}</span>
      {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
      <div className="cg-card-meta">
        {[node.meta?.size, node.meta?.mtime].filter(Boolean).join(' · ') || typeLabel(node.type, t)}
      </div>
    </>
  )
}

function CanvasCardInner(props: CanvasCardProps): JSX.Element {
  const { node, lod, selected, flashing, dimmed, highlighted } = props
  const { placement } = node

  const onHeadPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    props.onSelect(node.id)
    props.onDragStart(node.id, event)
  }, [node.id, props])

  /** 右下角缩放手柄：阻止冒泡（避免误触标题栏拖动），交给 CanvasBoard 手势。 */
  const onResizePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    props.onSelect(node.id)
    props.onResizeStart(node.id, event)
  }, [node.id, props])

  const className = [
    'cg-card',
    selected ? 'cg-selected' : '',
    flashing ? 'cg-flash' : '',
    dimmed ? 'cg-dimmed' : '',
    highlighted ? 'cg-fresh' : '',
    node.aiPlaced ? 'cg-ai' : '',
  ].filter(Boolean).join(' ')

  return (
    <article
      className={className}
      data-node-id={node.id}
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
        zIndex: placement.zIndex,
      }}
      onPointerDown={(e) => {
        // 点卡片本体提升选中，但不一定开拖（拖只从标题栏开始，避免和文本选择打架）
        if (e.button === 0) props.onSelect(node.id)
      }}
    >
      <header className="cg-card-head" onPointerDown={onHeadPointerDown}>
        <span className="cg-drag" aria-hidden>⋮⋮</span>
        <span className="cg-type-glyph" title={typeLabel(node.type, props.t)}>{TYPE_GLYPH[node.type]}</span>
        <strong className="cg-card-title" title={node.title}>{node.title}</strong>
        <span className="cg-badges">
          {node.aiPlaced ? <span className="cg-badge cg-badge-ai">{props.t('canvas.card.aiPlaced')}</span> : null}
          {node.unverified ? <span className="cg-badge cg-badge-warn">{props.t('canvas.card.unverified')}</span> : null}
          <span className="cg-badge" title={scopeBadgeText(node, props.currentSessionId, props.t)}>
            {scopeBadgeText(node, props.currentSessionId, props.t)}
          </span>
        </span>
      </header>

      {lod ? (
        <div className="cg-lod">
          {TYPE_GLYPH[node.type]}
          <span>{node.title}</span>
        </div>
      ) : (
        <>
          <div className="cg-card-body">
            <CardBody t={props.t} node={node} backendReady={props.backendReady} onChangeContent={props.onChangeContent} />
          </div>
          <footer className="cg-card-foot">
            <button type="button" onClick={() => props.onPreview(node.id)}>{props.t('canvas.card.preview')}</button>
            {(node.type === 'markdown' || node.type === 'plainText') && node.content
              ? (
                <button type="button" className="cg-open" onClick={() => props.onSave(node.id)} title={props.t('canvas.card.saveTitle')}>{props.t('canvas.card.save')}</button>
              ) : null}
            {node.path ? (
              <button type="button" className="cg-open" onClick={() => props.onOpen(node.id)} title={props.t('canvas.card.openTitle')}>{props.t('canvas.card.open')}</button>
            ) : null}
            {node.path ? (
              <button type="button" className="cg-open" onClick={() => props.onOpenFolder(node.id)} title={props.t('canvas.card.openFolderTitle')}>{props.t('canvas.card.openFolder')}</button>
            ) : null}
            <button type="button" onClick={() => props.onMigrate(node.id)} title={props.t('canvas.card.migrateTitle')}>{props.t('canvas.card.migrate')}</button>
            {props.openSession && node.scope === 'session' && node.sessionId && node.sessionId !== props.currentSessionId
              ? (
                <button type="button" className="cg-open" onClick={() => props.openSession?.(node.sessionId!)} title={props.t('canvas.card.jumpTitle')}>
                  {props.t('canvas.card.jump')}
                </button>
              ) : null}
            <button type="button" onClick={() => props.onCopy(node.id, 'id')}>{props.t('canvas.card.copyId')}</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'title')}>{props.t('canvas.card.copyTitle')}</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'path')} disabled={!node.path}>{props.t('canvas.card.copyPath')}</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'ref')}>{props.t('canvas.card.copyRef')}</button>
            <button type="button" className="cg-danger" onClick={() => props.onAskRemove(node.id)}>{props.t('canvas.card.remove')}</button>
          </footer>
        </>
      )}

      {/* 右下角缩放手柄：拖动改变卡片宽高（最小尺寸由 CSS/常量约束） */}
      <button
        type="button"
        className="cg-resize-handle"
        aria-label={props.t('canvas.card.resizeAria')}
        title={props.t('canvas.card.resizeTitle')}
        onPointerDown={onResizePointerDown}
      />
    </article>
  )
}

export const CanvasCard = memo(CanvasCardInner)
CanvasCard.displayName = 'CanvasCard'

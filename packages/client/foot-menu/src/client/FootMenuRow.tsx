/**
 * 侧边栏底部的「更多」行 + 向上浮层。
 *
 * ## 它替代了什么
 *
 * 改造前，五个插件各自往 `sidebar.footer.action` 注册**一整行**（定时任务 / 能力中心 /
 * 连接器 / 浏览器 / 应用中心），底部固定占掉约 210px。现在这一行是**唯一**的占用者：
 * 条目经客户端 Cordis 服务 `picoFootMenu` 收集（见 `contract.ts` 的"为什么是服务"）。
 *
 * ## 两个容易踩的点
 *
 * 1. **浮层必须 portal 到 `document.body`**：侧边栏列在收起动画里带 `overflow:hidden`，
 *    留在座位里的绝对定位会被裁掉。portal 出去之后用 `position:fixed` + 打开时按锚点
 *    矩形定位（`window` resize 与锚点 `ResizeObserver` 都会重算）。
 * 2. **关闭态是 `display:none`，不是卸载**：条目里的状态（浏览器插件的控制权轮询等）
 *    不能因为浮层收起而停；同时 `display:none` 让隐藏的条目既不进 tab 序列、也不可聚焦。
 *
 * 激活态文案（`更多 · 能力中心`）来自 `panel-surface` 的**唯一**激活态属性；面板关闭
 * 只删属性、不发事件，所以这里必须用 `MutationObserver`，不能只听 `PANEL_ACTIVATE_EVENT`。
 *
 * @module @picoaide/dsh-foot-menu/client/FootMenuRow
 */

import { useCallback, useEffect, useId, useReducer, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PANEL_ACTIVE_ATTR, activePanelId } from '@picoaide/dsh-panel-surface/client'
import { currentFootMenuService, type FootMenuEntry } from './contract.ts'
import { CHECK_GLYPH, CHEVRON_GLYPH, FootMenuGlyph, MORE_GLYPH } from './glyphs.tsx'
import { t } from './locales.ts'

/** 宽栏几何：与被替换掉的五行**逐字**一致（height 34 / margin 4 -4 4 / padding 6 2 6 10）。 */
const ROW_WIDE: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: 'calc(100% + 8px)',
  height: 34,
  margin: '4px -4px 4px',
  padding: '6px 2px 6px 10px',
  boxSizing: 'border-box',
  border: 'none',
  borderRadius: 12,
  // **不写 `background`**：行内样式优先级高于注入的 `.pico-foot-menu-trigger:hover`
  // 规则，写在这里 hover 就永远是死的（2026-09-21 与账户行走查发现同一坑）。
  // 透明底与 hover 底都进注入的样式表（见 index.ts）。
  cursor: 'pointer',
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
}

/** 窄轨（56px rail）：36×36 圆按钮，无文字无 chevron。 */
const ROW_RAIL: CSSProperties = {
  ...ROW_WIDE,
  width: 36,
  height: 36,
  margin: '8px 0 10px',
  justifyContent: 'center',
  gap: 0,
  padding: 0,
  borderRadius: '50%',
}

/** 行文案：吃满中间空间，尾部留给 chevron。 */
const ROW_LABEL: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  textAlign: 'left',
}

/** 警示态配色（与浏览器插件原本的"AI 在等你"同一取值）。 */
const WAITING_COLOR = '#d97706'

/** 行上的警示圆点（窄轨也要看得见 —— 那里没有文字位）。 */
const WAITING_DOT: CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: WAITING_COLOR,
  pointerEvents: 'none',
}

/** 浮层容器（`position`/`display` 由打开态与定位结果决定）。 */
const MENU: CSSProperties = {
  position: 'fixed',
  zIndex: 1100,
  boxSizing: 'border-box',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 10,
  padding: 4,
  boxShadow: 'var(--dsw-shadow-lv3)',
}

/** 浮层条目。`background` 同样只在注入的样式表里（见 `ROW_WIDE` 的说明）。 */
const ITEM: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  height: 32,
  padding: '0 8px',
  boxSizing: 'border-box',
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 13,
  textAlign: 'left',
}

/** 条目文案。 */
const ITEM_LABEL: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
}

/** 条目右侧的警示圆点。 */
const ITEM_DOT: CSSProperties = {
  flex: 'none',
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: WAITING_COLOR,
}

/** 浮层的定位结果（打开时按锚点矩形算）。 */
interface MenuBox {
  left: number
  bottom: number
  width: number
  maxWidth: number
}

/** 关闭态占位定位（`display:none` 时不可见，值只求"合法"）。 */
const CLOSED_BOX: MenuBox = { left: 0, bottom: 0, width: 200, maxWidth: 200 }

/** 没有条目时的稳定空快照（避免每次渲染都新建数组）。 */
const NO_ENTRIES: readonly FootMenuEntry[] = []

/**
 * 侧边栏底部的「更多」行。
 * @param props - 侧边栏底部槽位给出的列宽状态。
 * @returns 行 + 浮层；条目为 0 时整行渲染 `null`。
 */
export function FootMenuRow(props: PropsRuntime<'sidebar.footer.action'>): JSX.Element | null {
  const service = currentFootMenuService()
  const wide = props.wide === true
  const [, forceRender] = useReducer((count: number) => count + 1, 0)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<string | null>(() => (typeof document === 'undefined' ? null : activePanelId(document)))
  const [box, setBox] = useState<MenuBox | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rawId = useId()
  const panelId = `pico-foot-menu-${rawId.replace(/[^a-zA-Z0-9_-]/gu, '')}`

  // 每次渲染都重新取快照并**重新求值** title()/attention()：条目的这两个取值是函数，
  // 语言切换与轮询结果都靠"渲染时读取"生效（`touch()` 负责把变化推过来）。
  const entries = service === undefined ? NO_ENTRIES : service.snapshot()

  // 来源①：登记表发布（登记/注销/touch）。
  useEffect(() => {
    if (service === undefined) return undefined
    return service.subscribe(() => { forceRender() })
  }, [service])

  // 来源②：面板激活态属性。面板**关闭只删属性、不发事件**，所以必须观察属性变化。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const read = (): void => { setActive(activePanelId(document)) }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [PANEL_ACTIVE_ATTR] })
    return () => { observer.disconnect() }
  }, [])

  /** 浮层里当前可聚焦的条目按钮（按渲染顺序）。 */
  const menuItems = useCallback((): HTMLButtonElement[] =>
    itemRefs.current.filter((element): element is HTMLButtonElement => element !== null && element !== undefined), [])

  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setOpen(false)
    if (restoreFocus) anchorRef.current?.focus()
  }, [])

  /** 按锚点矩形重算浮层位置（向上展开：底边 = 视口高 - 锚点顶边 + 6）。 */
  const measure = useCallback((): void => {
    const anchor = anchorRef.current
    if (anchor === null || typeof window === 'undefined') return
    const rect = anchor.getBoundingClientRect()
    setBox({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 6,
      width: Math.max(rect.width, 200),
      maxWidth: window.innerWidth - 16,
    })
  }, [])

  // 打开时定位一次，并在窗口 resize / 锚点尺寸变化时重算（会话列表滚动不影响：
  // 锚点在底部固定区；这两条保证不出现"浮层飘走"）。
  useEffect(() => {
    if (!open) return undefined
    measure()
    if (typeof window === 'undefined') return undefined
    const onResize = (): void => { measure() }
    window.addEventListener('resize', onResize)
    const anchor = anchorRef.current
    const observer = typeof ResizeObserver === 'function' && anchor !== null
      ? new ResizeObserver(() => { measure() })
      : undefined
    observer?.observe(anchor as HTMLButtonElement)
    return () => {
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
    }
  }, [open, measure])

  // 打开时焦点落在激活条目（没有则第一条）。
  useEffect(() => {
    if (!open) return
    const items = menuItems()
    if (items.length === 0) return
    const index = entries.findIndex(entry => entry.id === active)
    items[index === -1 ? 0 : index]?.focus()
    // 只在"打开"这一跳抢焦点：打开期间条目集合变化不该夺走用户焦点。
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // 外部交互关闭（捕获阶段，落在锚点与浮层之外才算"外部"）。
  //
  // 同时听 `pointerdown` 与 `click`：真实鼠标/触控的第一次交互是 pointerdown；
  // 而程序化点击（`.click()`，测试与自动化探针常用）**只有 click**，只听 pointerdown
  // 会让浮层留在原地盖住别人（2026-09-21 行查：并道探针 `document.body.click()` 那条
  // 关闭路径）。点击锚点自己不算外部，所以"点一下开、再点一下关"仍然只走锚点的 onClick。
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const onOutside = (event: Event): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (anchorRef.current?.contains(target) === true) return
      if (panelRef.current?.contains(target) === true) return
      closeMenu(false)
    }
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('click', onOutside, true)
    return () => {
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('click', onOutside, true)
    }
  }, [open, closeMenu])

  // 键盘：Esc 关闭并还焦点；方向键/Home/End 在条目间移动。用**捕获**阶段，
  // 这样面板装载器的 Esc（document 冒泡）不会在同一按键上把整页面板也关掉。
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 浮层里可能再开一层真正的模态（确认框/表单）：那时 Esc 归那一层
        //（与 `mountPanelSurface` 的既有写法一致）。
        if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return
        // 焦点已经不在本浮层/锚点上（另一层浮层抢走了焦点，或程序化点击把用户带到
        // 别处）：Esc 归当前最上层，这里不许把别人的 Esc 吃掉。
        const focused = document.activeElement
        const panel = panelRef.current
        const ours = anchorRef.current === focused || (panel !== null && panel.contains(focused))
        if (!ours) return
        event.preventDefault()
        event.stopPropagation()
        closeMenu(true)
        return
      }
      const panel = panelRef.current
      if (panel === null || !panel.contains(document.activeElement)) return
      const items = menuItems()
      if (items.length === 0) return
      const current = items.findIndex(element => element === document.activeElement)
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        items[current === -1 ? 0 : (current + 1) % items.length]?.focus()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        items[current === -1 ? items.length - 1 : (current - 1 + items.length) % items.length]?.focus()
      } else if (event.key === 'Home') {
        event.preventDefault()
        items[0]?.focus()
      } else if (event.key === 'End') {
        event.preventDefault()
        items[items.length - 1]?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open, closeMenu, menuItems])

  if (service === undefined || entries.length === 0) return null

  const activeEntry = entries.find(entry => entry.id === active)
  // 警示条目：行上的圆点与 tooltip 都取自**第一个**在等的条目。tooltip 优先用条目
  // 自己给的可操作文案（`attentionTitle`），没有才退回通用那句（2026-09-21 对抗审计）。
  const waitingEntry = entries.find(entry => entry.attention?.() === true)
  const attention = waitingEntry !== undefined
  const attentionTitle = waitingEntry?.attentionTitle?.() ?? t('footMenu.attention')
  const label = activeEntry === undefined ? t('footMenu.more') : `${t('footMenu.more')} · ${activeEntry.title()}`
  const accessibleLabel = attention ? t('footMenu.labelAttention') : t('footMenu.label')
  const placement = box ?? CLOSED_BOX

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="pico-foot-menu-trigger"
        aria-label={accessibleLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        title={attention ? attentionTitle : t('footMenu.label')}
        style={{ ...(wide ? ROW_WIDE : ROW_RAIL), position: 'relative' }}
        onClick={() => {
          if (open) {
            closeMenu(true)
            return
          }
          setOpen(true)
        }}
      >
        <FootMenuGlyph glyph={MORE_GLYPH} size={wide ? 16 : 18} />
        {wide && <span style={ROW_LABEL}>{label}</span>}
        {wide && (
          <FootMenuGlyph
            glyph={CHEVRON_GLYPH}
            size={14}
            // 展开时朝上（旋转 180°）、收起时朝下 —— 见 glyphs.tsx 的几何说明。
            style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.12s ease' }}
          />
        )}
        {attention && <span style={WAITING_DOT} data-role="foot-menu-attention" aria-hidden="true" />}
      </button>
      {createPortal(
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label={t('footMenu.label')}
          style={{
            ...MENU,
            display: open ? 'block' : 'none',
            left: placement.left,
            bottom: placement.bottom,
            width: placement.width,
            maxWidth: placement.maxWidth,
          }}
        >
          {entries.map((entry, index) => {
            const isActive = entry.id === active
            const waiting = entry.attention?.() === true
            // 警示文案：条目自己给的可操作句子优先，没有才退回通用那句。
            const waitingText = waiting ? entry.attentionTitle?.() ?? t('footMenu.attention') : undefined
            return (
              <button
                key={entry.id}
                ref={(element) => { itemRefs.current[index] = element }}
                type="button"
                role="menuitem"
                className="pico-foot-menu-item"
                aria-current={isActive ? 'true' : undefined}
                aria-label={waitingText}
                title={waitingText}
                style={{ ...ITEM, ...(waiting ? { color: WAITING_COLOR } : null) }}
                onClick={() => {
                  entry.activate()
                  closeMenu(true)
                }}
              >
                {isActive
                  ? <FootMenuGlyph glyph={CHECK_GLYPH} size={14} />
                  : <span style={{ flex: 'none', width: 14 }} aria-hidden="true" />}
                <FootMenuGlyph id={entry.id} size={16} />
                <span style={{ ...ITEM_LABEL, fontWeight: isActive ? 600 : 400 }}>{entry.title()}</span>
                {waiting && <span style={ITEM_DOT} data-role="foot-menu-attention" aria-hidden="true" />}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

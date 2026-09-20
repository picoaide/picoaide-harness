/**
 * 面板图标集（线条风格统一：16 视图框、`currentColor`、圆头线帽、1.4 描边）。
 *
 * 为什么自绘而不是用文字符号：本仓在门户页上踩过 —— `↓`(U+2193) 会因字体回退渲染成
 * 歪斜的残字，而细描边图标在 13px 下会糊成浅色斑点。这里的 path 全部是**实心/统一线宽**
 * 的几何，且在 14–18px 下都可辨。
 *
 * @module @picoaide/dsh-panel-surface/client/icons
 */

/** 图标通用属性。 */
export interface PanelIconProps {
  /** 像素边长（宽高相同）。 */
  size?: number | undefined
  /** 额外的内联样式。 */
  style?: React.CSSProperties | undefined
  className?: string | undefined
}

function svgProps(props: PanelIconProps): React.SVGProps<SVGSVGElement> {
  return {
    width: props.size ?? 16,
    height: props.size ?? 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': true,
    focusable: false,
    ...(props.className === undefined ? {} : { className: props.className }),
    ...(props.style === undefined ? {} : { style: props.style }),
  }
}

const STROKE = { stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** 返回会话区（整页面板的唯一出口）。 */
export function IconBack(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><path d="M10 3.5 5.5 8l4.5 4.5" {...STROKE} /></svg>
}

/** 定时任务。 */
export function IconClock(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><circle cx="8" cy="8" r="5.7" {...STROKE} /><path d="M8 4.9V8l2.1 1.3" {...STROKE} /></svg>
}

/** 能力中心（技能 / 智能体）。 */
export function IconCapability(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6" {...STROKE} />
      <path d="M5.3 5.6h5.4M5.3 8h5.4M5.3 10.4h3.4" {...STROKE} />
    </svg>
  )
}

/** 连接器。 */
export function IconPlug(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.6" y="6.4" width="7.6" height="7.6" rx="1.6" {...STROKE} />
      <path d="M5.8 6.4V4.9a2 2 0 0 1 2-2h1.8a2 2 0 0 1 2 2v1.5M5.8 10.3h1.9" {...STROKE} />
    </svg>
  )
}

/** 应用中心。 */
export function IconApps(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.9" y="1.9" width="5.2" height="5.2" rx="1.4" {...STROKE} />
      <rect x="8.9" y="1.9" width="5.2" height="5.2" rx="1.4" {...STROKE} />
      <rect x="1.9" y="8.9" width="5.2" height="5.2" rx="1.4" {...STROKE} />
      <rect x="8.9" y="8.9" width="5.2" height="5.2" rx="1.4" {...STROKE} />
    </svg>
  )
}

/** 搜索。 */
export function IconSearch(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><circle cx="7.2" cy="7.2" r="4.4" {...STROKE} /><path d="m10.6 10.6 2.6 2.6" {...STROKE} /></svg>
}

/** 新建。 */
export function IconPlus(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><path d="M8 3.4v9.2M3.4 8h9.2" {...STROKE} /></svg>
}

/** 刷新。 */
export function IconRefresh(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" {...STROKE} />
      <path d="M13 2.8V5.4h-2.6" {...STROKE} />
    </svg>
  )
}

/** 展开/收起。 */
export function IconChevron(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><path d="m4.2 6.2 3.8 3.8 3.8-3.8" {...STROKE} /></svg>
}

/** 成功。 */
export function IconCheck(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><path d="m3.4 8.4 3 3 6.2-7" {...STROKE} /></svg>
}

/** 提示/警示。 */
export function IconAlert(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><circle cx="8" cy="8" r="5.8" {...STROKE} /><path d="M8 5.1v3.6M8 10.9h.01" {...STROKE} /></svg>
}

/** 信息。 */
export function IconInfo(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><circle cx="8" cy="8" r="5.8" {...STROKE} /><path d="M8 7.4v3.5M8 5.1h.01" {...STROKE} /></svg>
}

/** 打开 / 外链。 */
export function IconExternal(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M9.4 2.8h3.8v3.8" {...STROKE} />
      <path d="M13.2 2.8 7.6 8.4" {...STROKE} />
      <path d="M11.6 9.6v2.2a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6V6a1.6 1.6 0 0 1 1.6-1.6h2.2" {...STROKE} />
    </svg>
  )
}

/** 复制链接。 */
export function IconCopy(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="5.6" y="5.6" width="8" height="8" rx="1.8" {...STROKE} />
      <path d="M3.8 10.4H3.2A1.4 1.4 0 0 1 1.8 9V3.2A1.4 1.4 0 0 1 3.2 1.8H9a1.4 1.4 0 0 1 1.2 1.4v.6" {...STROKE} />
    </svg>
  )
}

/** 删除。 */
export function IconTrash(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.8 4.4h10.4M6.4 4.4V3.2A1.2 1.2 0 0 1 7.6 2h.8a1.2 1.2 0 0 1 1.2 1.2v1.2" {...STROKE} />
      <path d="M4.2 4.4l.6 8a1.4 1.4 0 0 0 1.4 1.3h3.6a1.4 1.4 0 0 0 1.4-1.3l.6-8" {...STROKE} />
    </svg>
  )
}

/** 人员 / 负责人。 */
export function IconUser(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><circle cx="8" cy="5.6" r="2.6" {...STROKE} /><path d="M3.4 13.2a4.9 4.9 0 0 1 9.2 0" {...STROKE} /></svg>
}

/** 权限 / 访问级别。 */
export function IconShield(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><path d="M8 1.9 13 3.7v4c0 3-2.1 5.4-5 6.4-2.9-1-5-3.4-5-6.4v-4L8 1.9Z" {...STROKE} /></svg>
}

/** 运行 / 执行。 */
export function IconPlay(props: PanelIconProps): JSX.Element {
  return <svg {...svgProps(props)}><path d="M5.4 3.6 12 8l-6.6 4.4V3.6Z" {...STROKE} /></svg>
}

/** 编辑。 */
export function IconEdit(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M9.6 2.9 13.1 6.4 6.4 13.1H2.9V9.6l6.7-6.7Z" {...STROKE} />
      <path d="M8.6 3.9 12.1 7.4" {...STROKE} />
    </svg>
  )
}

/** 未连接 / 断开。 */
export function IconUnplug(props: PanelIconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M6.2 6.2 2.6 9.8a1.7 1.7 0 0 0 0 2.4l1.2 1.2a1.7 1.7 0 0 0 2.4 0l3.6-3.6" {...STROKE} />
      <path d="m9.8 9.8 3.6-3.6a1.7 1.7 0 0 0 0-2.4l-1.2-1.2a1.7 1.7 0 0 0-2.4 0L6.2 6.2" {...STROKE} />
    </svg>
  )
}

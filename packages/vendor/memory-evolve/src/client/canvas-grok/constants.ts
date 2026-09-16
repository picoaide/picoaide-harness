/**
 * 画板常量：尺寸、LOD 阈值、存储键、类型字典键、当前「会话/项目」身份。
 * 全部集中在这里，方便后续接宿主时整块替换模拟身份。
 *
 * i18n（2026-09-16）：类型展示名此前是模块级常量 `TYPE_LABEL`
 * （`{ folder: '文件夹', … }`）—— 模块求值早于插件 apply，那时 `t()` 只会
 * 拿到默认语言，等于把语言钉死在中文。现在这里只保留**字典键**
 * （TYPE_LABEL_KEYS）并导出 `typeLabel(type, t)`，由渲染点在调用期求值。
 * 画板内搜索匹配另走 TYPE_SEARCH_TERMS（不随界面语言变化，见下）。
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CanvasNodeType,
  CanvasPlacement,
  CanvasViewport,
} from './types.ts'

/**
 * localStorage 键（正式键）。此前双外援并存验收期用过分键
 * `memory-evolve.canvas.grok.v1`，2026-08-13 用户拍板选 Grok 版后统一
 * 回正式键；历史分键数据不再读取（验收期演示数据，无保留价值）。
 */
export const STORAGE_KEY = 'memory-evolve.canvas.v1'

/** 样式标签标记，卸载时按这个选择器清理。 */
export const STYLE_ATTR = 'data-cg-canvas-css'

/** 参考项目 ResourceNodeCard 的 LOD 阈值：scale < 0.36 只渲染图标。 */
export const LOD_SCALE = 0.36

/** 缩放范围：过小看不见、过大单卡撑满也没意义。 */
export const MIN_SCALE = 0.15
export const MAX_SCALE = 2.8

/** 滚轮单次缩放倍率。 */
export const ZOOM_STEP = 1.08

/** 视口虚拟化外边距（世界坐标）。平移时提前挂上即将入屏的卡片。 */
export const VIRT_PAD = 280

/** 画板内搜索命中闪烁时长。 */
export const FLASH_MS = 1400

/** 新节点 / AI 投放高亮时长。 */
export const HIGHLIGHT_MS = 1800

/** 持久化防抖。 */
export const PERSIST_DEBOUNCE_MS = 220

/**
 * 模拟「当前会话 / 当前项目」。
 * 纯前端一期写死；主会话接入后改为从 ConvViewProps / sessions 读取。
 * 注：会话/项目**显示名**不在这里（它们要跟随界面语言，见 CanvasView 的
 * canvas.scope.* 字典键与后端下发的 currentProjectLabel）。
 */
export const CURRENT_SESSION_ID = 'sess-demo-current'
export const CURRENT_PROJECT_ID = 'proj-demo'
export const CURRENT_PROJECT_LABEL = 'dsh-memory-evolve'

/** AI 投放区（世界坐标）。AI 新节点只落在这里，用户再拖走。 */
export const AI_ZONE = { x: 80, y: 40, width: 560, height: 300 } as const

/** 各类型默认卡片尺寸（文本类调大：曾 268×208 内容挤，用户反馈看不清）。 */
export const DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number }> = {
  folder: { width: 248, height: 168 },
  markdown: { width: 360, height: 260 },
  plainText: { width: 340, height: 240 },
  image: { width: 320, height: 240 },
  media: { width: 320, height: 220 },
  file: { width: 260, height: 170 },
}

/**
 * 类型展示名的**字典键**。渲染点用 `typeLabel(type, t)` 取当前语言文案
 * （模块级不能再存中文常量：求值早于 apply，会钉死语言）。
 */
export const TYPE_LABEL_KEYS: Record<CanvasNodeType, string> = {
  folder: 'canvas.type.folder',
  markdown: 'canvas.type.markdown',
  plainText: 'canvas.type.plainText',
  image: 'canvas.type.image',
  media: 'canvas.type.media',
  file: 'canvas.type.file',
}

/** 类型展示名（当次渲染的语言）。 */
export function typeLabel(type: CanvasNodeType, t: Translate): string {
  return t(TYPE_LABEL_KEYS[type])
}

/**
 * 画板内搜索的**匹配词表**（每种类型可命中的别名）。
 *
 * ⚠️ 这是"匹配模式"而非界面文案：中文与英文同时收录，用户在哪国语言下
 * 输入「文件夹」或「folder」都能命中同一张卡。显示名走 TYPE_LABEL_KEYS
 * 的字典（会随语言变），但匹配词表**必须与界面语言无关**——否则切语言会
 * 改变搜索结果（历史行为：中文标签可命中；这里保留中文并补英文）。
 */
export const TYPE_SEARCH_TERMS: Record<CanvasNodeType, readonly string[]> = {
  folder: ['文件夹', 'folder', '目录', 'directory'],
  markdown: ['markdown', 'md'],
  plainText: ['纯文本', 'plain text', 'plaintext', 'txt', 'text'],
  image: ['图片', 'image', 'picture', 'photo'],
  media: ['音视频', 'media', 'audio', 'video'],
  file: ['文件', 'file'],
}

/** LOD / 卡片标题栏用的类型符号。 */
export const TYPE_GLYPH: Record<CanvasNodeType, string> = {
  folder: '📁',
  markdown: '📝',
  plainText: '📄',
  image: '🖼',
  media: '🎬',
  file: '📦',
}

/** 扩展名 → 类型。没匹配上且不像目录就归 file。 */
export const EXT_TYPE: Record<string, CanvasNodeType> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'plainText',
  text: 'plainText',
  log: 'plainText',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  mp3: 'media',
  wav: 'media',
  m4a: 'media',
  aac: 'media',
  ogg: 'media',
  flac: 'media',
  mp4: 'media',
  mov: 'media',
  webm: 'media',
  avi: 'media',
  mkv: 'media',
}

/** 默认视口：让 AI 投放区 + 预置卡片大致落在 Tab 中央偏上。 */
export const DEFAULT_VIEWPORT: CanvasViewport = { x: 48, y: 36, scale: 0.88 }

export function defaultPlacement(
  type: CanvasNodeType,
  x: number,
  y: number,
  zIndex = 1,
): CanvasPlacement {
  const size = DEFAULT_SIZE[type]
  return { x, y, width: size.width, height: size.height, zIndex }
}

/**
 * 2026-09-16：这里原有 `createSeedNodes(now)` / `createSeedState()`——首次
 * 打开时预置 4 张中文示例卡（团队共享规范.pdf / 本次会话备忘 / 上周评审白板
 * 等）。它们只被 `store.ts` 的 `loadCanvasState()` 引用，而 `loadCanvasState`
 * 全仓**零调用点**（画板自 2026-08-14 起"只走后端"：CanvasView 只 import
 * createDebouncedSaver，Tab 能出现即 canvasEnabled 已开）。即整块预置数据
 * 是死代码 —— 按 i18n 审计口径**直接删除**而不是把中文示例翻译成双语
 * （翻译死代码＝白背一份维护面）。`loadCanvasState` 一并删除。
 */

/**
 * 应用窗口管理（W-C 裁决：独立 `BrowserWindow` + surface 抽象；设计总纲 §7.2 与
 * §16.1「`windows.ts` 契约」逐条实现，条款编号写在下面对应位置）。
 *
 * 本模块拥有**窗口的生命周期与几何契约**，不拥有 Electron：
 * 建窗/聚焦/关窗/比例约束经 {@link WasmAppsWindowAdapter} 注入（桌面壳给真实实现，
 * 单测给替身）。这样"单应用单窗口 / 尺寸记忆 / 比例锁定 / 关窗时机"这些**容易写错
 * 又难验证**的规则可以在纯 Node 下逐条钉住。
 *
 * 冻结条款索引：
 *  - §7.2 单应用单窗口、聚焦导航、标题恒为 `<应用名> · <产品名>`（不采用应用 HTML
 *    的 `<title>`，防伪装）；
 *  - §7.2/§16.1 尺寸/比例：`min = max(320×240, 按 ratio 反算)`、ratio 夹到
 *    **0.25–4.0**、**程序化 resize（含恢复记忆尺寸）不受 `setAspectRatio` 约束 ⇒
 *    恢复路径必须自己按 ratio 校正**；
 *  - §16.1 状态文件 `<userData>/wasm-apps-windows.json`，schema
 *    `{version, apps: {<app_id>: {width,height,x,y,ratio?,lastPath?}}}`，原子写；
 *  - §7.2/§23.2 登出/切账号/切渠道 ⇒ **关闭全部应用窗口并清空映射**（上个用户的
 *    窗口不得在新用户下复活）；
 *  - §7.2 导航闸门**按 app_id 判**（N7）：应用窗口只允许同 app origin 的顶层导航，
 *    跨 app 拒绝，http(s) 外链一律不在应用窗口导航；
 *  - R1-CLI-14 旧账本迁移：浏览器 store 的 groups 账本里以 app scheme 开头的条目
 *    **丢弃并 warn**；
 *  - §6/F3 作者声明的几何（2026-09-21 审计 P0-2 补齐）：`window.ratio/width/height`
 *    只在**首次**建窗时决定尺寸，比例对每次打开都生效（{@link parseDeclaredWindowGeometry}
 *    / {@link resolveDeclaredWindowSize}，与 Go `appcfg.ResolvedWindow` 同判）；
 *  - §16.1 应用窗口 surface（2026-09-21 审计 P0-1 补齐）：建窗即注册进 browser runtime
 *    的 surface 注册表（`kind:'app'`，载荷含 `webContents`），关窗/登出注销
 *    （{@link AppSurfaceRegistrar}）。
 *
 * @module @picoaide/dsh-wasm-apps-host/windows
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
// 原子替换走上游 `@deepseek-ai/dsh-atomic-write`（2026-09-20 W6/W7 切换，见设计总纲 §16.1）。
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** 状态文件名（§16.1 冻结）。 */
export const APP_WINDOWS_STATE_FILE = 'wasm-apps-windows.json'

/** 状态文件 schema 版本（形状变了就换号，旧号一律当"没有记忆"）。 */
export const APP_WINDOWS_STATE_VERSION = 1

/** 最小尺寸下限（§19 Q8 冻结：320×240）。 */
export const APP_WINDOW_MIN_WIDTH = 320
export const APP_WINDOW_MIN_HEIGHT = 240

/** 宽高比合法区间（§6/§7.2/§19 Q8 冻结）。 */
export const APP_WINDOW_MIN_RATIO = 0.25
export const APP_WINDOW_MAX_RATIO = 4

/** 首次打开的缺省尺寸（§6：1280×720）。 */
export const APP_WINDOW_DEFAULT_WIDTH = 1280
export const APP_WINDOW_DEFAULT_HEIGHT = 720

/**
 * 作者声明的窗口几何（`window` 对象的宿主侧投影；F3/§6）。
 *
 * 与客户端 `AppWindowSpec`/服务端目录行的子字段**同名同义**：`ratio` 是宽/高比、
 * `width`/`height` 是像素。字段缺席 = 作者没声明它（不是 0）。
 *
 * 取值来源有两条，都归一化成这个形状：本机打开路由请求体的 `window`
 * （客户端手里那份目录数据）与 {@link ./window-catalog.ts} 的目录兜底。
 */
export interface DeclaredWindowGeometry {
  ratio?: number
  width?: number
  height?: number
}

/** 像素尺寸判据（正的安全整数；与客户端 `isPixelSize` 同口径）。 */
function isPixelSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * 解析一块 `window` 值（本机路由请求体与目录行都走它）。
 *
 * **逐字段独立解析**：非法的单个字段被丢弃而不是让整块作废（声明了比例但尺寸写坏时，
 * 比例仍然可用）。一个可用字段都没有 ⇒ `null`（= 作者没声明，调用方用缺省 1280×720）。
 * 绝不抛：打开动作不能因为一块畸形几何而失败。
 * @param raw - `window` 的原始值（任意 JSON 值）。
 * @returns 归一化后的几何，或 `null`。
 */
export function parseDeclaredWindowGeometry(raw: unknown): DeclaredWindowGeometry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as { ratio?: unknown, width?: unknown, height?: unknown }
  const geometry: DeclaredWindowGeometry = {}
  // ratio 走**同一个**夹取函数（0.25–4.0）：区间在两处各写一份，迟早会出现
  // "详情页按 4.0 显示、窗口按 3.9 锁"。
  const ratio = clampAspectRatio(row.ratio)
  if (ratio !== undefined) geometry.ratio = ratio
  if (isPixelSize(row.width)) geometry.width = row.width
  if (isPixelSize(row.height)) geometry.height = row.height
  return Object.keys(geometry).length === 0 ? null : geometry
}

/**
 * 最终生效的**首次**开窗尺寸（与 Go `appcfg.ResolvedWindow` 逐条同判）。
 *
 * 规则（§6："缺省 1280×720 并按 ratio 校正"）：
 *  1. 起点 = 作者给的值，缺省 1280×720；
 *  2. 没写 ratio ⇒ 原样返回（不做任何校正）；
 *  3. 写了 ratio ⇒ 以**作者显式给出的那一边**为准推另一边（宽度优先）：
 *     只给 width ⇒ height = round(width/ratio)；只给 height ⇒ width = round(height*ratio)；
 *     两个都给了 ⇒ 以 width 为锚；两个都没给 ⇒ 以缺省宽度 1280 为锚。
 *
 * 为什么不能只把三个值分别传下去：那样"比例与尺寸冲突"的裁决会落到
 * `setAspectRatio` 与 `clampToWorkArea` 两个不同口径上，而**详情页显示的是服务端
 * `ResolvedWindow` 的结果** —— 三处不一致就是"显示 16:9、窗口 4:3"这个具体缺陷。
 * @param geometry - 已解析的几何（缺省 ⇒ 缺省尺寸）。
 * @returns 首次开窗的宽高（恒为正整数）。
 */
export function resolveDeclaredWindowSize(geometry: DeclaredWindowGeometry | null | undefined): { width: number, height: number } {
  const declaredWidth = geometry?.width
  const declaredHeight = geometry?.height
  const ratio = geometry?.ratio
  if (ratio === undefined) {
    return {
      width: declaredWidth ?? APP_WINDOW_DEFAULT_WIDTH,
      height: declaredHeight ?? APP_WINDOW_DEFAULT_HEIGHT,
    }
  }
  if (declaredWidth !== undefined) {
    return { width: declaredWidth, height: Math.round(declaredWidth / ratio) }
  }
  if (declaredHeight !== undefined) {
    return { width: Math.round(declaredHeight * ratio), height: declaredHeight }
  }
  return { width: APP_WINDOW_DEFAULT_WIDTH, height: Math.round(APP_WINDOW_DEFAULT_WIDTH / ratio) }
}

/** 一个应用的窗口记忆（§16.1 的 schema，字段名逐字一致）。 */
export interface AppWindowMemory {
  width: number
  height: number
  x?: number
  y?: number
  /** 作者声明的宽高比（`window.ratio`），已夹到 0.25–4.0。 */
  ratio?: number
  /** 上次所在路径（重启后"聚焦已有窗口"要回到用户离开的地方）。 */
  lastPath?: string
}

/** 状态文件内容（§16.1 冻结）。 */
export interface AppWindowsState {
  version: number
  apps: Record<string, AppWindowMemory>
}

/** 工作区（显示器可用区域；`x/y` 可为负——多显示器左侧）。 */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 把作者声明的比值夹到合法区间（§7.2：极端值以"先夹到 0.25–4.0 → 再按工作区裁剪"
 * 为准）。非有限/非正数一律当"没有声明"。
 * @param value - 作者声明的 `window.ratio`（数字或 `"W:H"` 字符串已被上游归一）。
 * @returns 夹取后的比值，或 undefined。
 */
export function clampAspectRatio(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(APP_WINDOW_MAX_RATIO, Math.max(APP_WINDOW_MIN_RATIO, value))
}

/**
 * 按比例校正尺寸（**恢复记忆尺寸路径必须自己调它**：`setAspectRatio` 不约束
 * 程序化 resize，§7.2 冻结）。
 * @param width - 期望宽度。
 * @param height - 期望高度。
 * @param ratio - 目标比值（`width/height`）；undefined ⇒ 不改。
 * @returns 校正后的尺寸（保持面积量级：以较接近的一边为准放大另一边）。
 */
export function correctForRatio(width: number, height: number, ratio: number | undefined): { width: number, height: number } {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  if (ratio === undefined) return { width: safeWidth, height: safeHeight }
  const current = safeWidth / safeHeight
  if (Math.abs(current - ratio) < 1e-6) return { width: safeWidth, height: safeHeight }
  // 以"面积不变"为口径校正：宽高同时缩放，视觉上最接近用户上一次的窗口大小。
  const scale = Math.sqrt(current / ratio)
  return { width: Math.max(1, Math.round(safeWidth / scale)), height: Math.max(1, Math.round(safeHeight * scale)) }
}

/**
 * 最小尺寸（§7.2：`max(320×240, 按 ratio 反算的最小值)`）。
 * @param ratio - 已夹取的比值。
 * @returns 最小宽高。
 */
export function minimumWindowSize(ratio: number | undefined): { width: number, height: number } {
  if (ratio === undefined) return { width: APP_WINDOW_MIN_WIDTH, height: APP_WINDOW_MIN_HEIGHT }
  return {
    width: Math.max(APP_WINDOW_MIN_WIDTH, Math.ceil(APP_WINDOW_MIN_HEIGHT * ratio)),
    height: Math.max(APP_WINDOW_MIN_HEIGHT, Math.ceil(APP_WINDOW_MIN_WIDTH / ratio)),
  }
}

/**
 * 把窗口矩形裁进工作区（§7.2：显示器变化时按工作区裁剪；不做逐显示器记忆）。
 * @param rect - 记忆的矩形。
 * @param workArea - 当前显示器工作区。
 * @param ratio - 目标比值（裁剪后再校正一次，避免裁出畸形比例）。
 * @returns 安全的矩形（尺寸不小于最小值）。
 */
export function clampToWorkArea(
  rect: { width: number, height: number, x?: number, y?: number },
  workArea: WorkArea,
  ratio: number | undefined,
): { width: number, height: number, x: number, y: number } {
  const minimum = minimumWindowSize(ratio)
  const corrected = correctForRatio(rect.width, rect.height, ratio)
  const width = Math.min(Math.max(corrected.width, minimum.width), Math.max(minimum.width, workArea.width))
  const height = Math.min(Math.max(corrected.height, minimum.height), Math.max(minimum.height, workArea.height))
  const fallbackX = workArea.x + Math.round((workArea.width - width) / 2)
  const fallbackY = workArea.y + Math.round((workArea.height - height) / 2)
  const x = typeof rect.x === 'number' && Number.isFinite(rect.x) ? rect.x : fallbackX
  const y = typeof rect.y === 'number' && Number.isFinite(rect.y) ? rect.y : fallbackY
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  return {
    width,
    height,
    x: Math.min(Math.max(x, workArea.x), Math.max(workArea.x, maxX)),
    y: Math.min(Math.max(y, workArea.y), Math.max(workArea.y, maxY)),
  }
}

/** 读状态文件（不存在/损坏/版本不符 ⇒ 空状态：记忆是**优化**，不是数据）。 */
export async function readWindowsState(userDataDir: string): Promise<AppWindowsState> {
  const file = join(userDataDir, APP_WINDOWS_STATE_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { version: APP_WINDOWS_STATE_VERSION, apps: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { version: APP_WINDOWS_STATE_VERSION, apps: {} }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { version: APP_WINDOWS_STATE_VERSION, apps: {} }
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== APP_WINDOWS_STATE_VERSION) return { version: APP_WINDOWS_STATE_VERSION, apps: {} }
  const apps = record.apps
  if (typeof apps !== 'object' || apps === null || Array.isArray(apps)) {
    return { version: APP_WINDOWS_STATE_VERSION, apps: {} }
  }
  const out: Record<string, AppWindowMemory> = {}
  for (const [appId, value] of Object.entries(apps as Record<string, unknown>)) {
    const memory = readMemory(value)
    if (memory !== null) out[appId] = memory
  }
  return { version: APP_WINDOWS_STATE_VERSION, apps: out }
}

/** 读取单条记忆（形状不符 ⇒ null：不把畸形值带进原生窗口 API）。 */
function readMemory(value: unknown): AppWindowMemory | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const width = record.width
  const height = record.height
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const memory: AppWindowMemory = { width: Math.round(width), height: Math.round(height) }
  if (typeof record.x === 'number' && Number.isFinite(record.x)) memory.x = Math.round(record.x)
  if (typeof record.y === 'number' && Number.isFinite(record.y)) memory.y = Math.round(record.y)
  const ratio = clampAspectRatio(record.ratio)
  if (ratio !== undefined) memory.ratio = ratio
  if (typeof record.lastPath === 'string' && record.lastPath.startsWith('/')) memory.lastPath = record.lastPath
  return memory
}

/**
 * 写状态文件（原子替换 + 目录 0700；失败只记 warn，**不让记忆文件挡住窗口**）。
 *
 * 原子写走上游 `writeFileAtomic`（`wx` 临时兄弟 + rename，见设计总纲 §16.1 的切换记录）；
 * 权限位 0600/0700 在这里逐处声明。
 * @param userDataDir - `<userData>` 目录。
 * @param state - 完整状态（整体覆盖，不做增量合并）。
 */
export async function writeWindowsState(userDataDir: string, state: AppWindowsState): Promise<void> {
  await writeFileAtomic(join(userDataDir, APP_WINDOWS_STATE_FILE), JSON.stringify(state), { mode: 0o600, dirMode: 0o700 })
}

/**
 * 旧账本迁移（R1-CLI-14 冻结）：内置浏览器的 groups 账本里可能存在
 * `<app-scheme>://…` 条目（基线把应用开在浏览器标签里）⇒ 启动恢复时**丢弃**这些
 * 条目并记 warn，避免 W2 之后出现"浏览器窗口里的孤儿应用标签"。
 * @param entries - 账本条目（只读 URL 字段）。
 * @param appScheme - 本安装的应用源 scheme（渠道注入）。
 * @returns 保留下来的条目与丢弃计数。
 */
export function dropAppSchemeLedgerEntries<T extends { url?: unknown }>(
  entries: readonly T[],
  appScheme: string,
): { kept: T[], dropped: number } {
  const prefix = `${appScheme}:`
  const kept: T[] = []
  let dropped = 0
  for (const entry of entries) {
    const url = typeof entry.url === 'string' ? entry.url.trim().toLowerCase() : ''
    if (url.startsWith(prefix)) {
      dropped += 1
      continue
    }
    kept.push(entry)
  }
  return { kept, dropped }
}

/** 一次导航的分类结论（应用窗口的闸门；§7.2 + §23.2 N7）。 */
export type AppWindowNavigationVerdict =
  | { verdict: 'allow' }
  | { verdict: 'deny', reason: 'foreign-app' | 'external' | 'malformed' }

/**
 * 应用窗口的导航闸门（**按 app_id 判**，N7；顶层与子框架共用的**唯一判据**）。
 *
 * 规则：`<scheme>://<同一个 app_id>` 的导航放行；同 scheme 但别的 app_id ⇒
 * `foreign-app`（换壳钓鱼 —— **子框架同样适用**：在 A 的窗口里内嵌 B 的界面与
 * 顶层导航到 B 是同一件事）；http(s) 与其它一切 ⇒ `external`（外链改走内置浏览器新
 * 标签 + 提示条，F12/§19 Q9，而不是在应用窗口里导航）。
 *
 * 唯一例外（{@link isMainFrame} = false 时）：**子框架的 http(s) 外链放行**。
 * 理由：顶层闸门管的是"应用窗口被导航走了"，而 iframe 里的第三方内容并不会改变窗口
 * 所在的文档 —— 拒掉它只会让"应用里嵌一个视频/图表"整页失效。真正的兜底在平台侧：
 * 平台给每个应用文档强制写 `default-src 'none'`（`frame-src` 随之 `'none'`）+
 * `frame-ancestors 'none'`，生产里应用**嵌不进任何东西**；这条依赖由
 * `platform-frame-fence.spec.ts` 对着服务端源码钉住（它一被拿掉，这条放行就不再成立）。
 * 非 http(s) 的子框架外链（`file:`/`javascript:`/别的自定义 scheme）仍旧一律拒。
 *
 * @param rawUrl - 目标 URL。
 * @param appId - 本窗口所属应用。
 * @param appScheme - 本安装的应用源 scheme。
 * @param isMainFrame - 是否发生在顶层文档（`will-frame-navigate`/`will-redirect` 的
 *   `details.isMainFrame`；缺省 true = 顶层语义）。
 * @returns 分类结论。
 */
export function classifyAppWindowNavigation(
  rawUrl: unknown,
  appId: string,
  appScheme: string,
  isMainFrame = true,
): AppWindowNavigationVerdict {
  if (typeof rawUrl !== 'string' || rawUrl === '') return { verdict: 'deny', reason: 'malformed' }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { verdict: 'deny', reason: 'malformed' }
  }
  if (url.protocol !== `${appScheme}:`) {
    if (!isMainFrame && (url.protocol === 'http:' || url.protocol === 'https:')) return { verdict: 'allow' }
    return { verdict: 'deny', reason: 'external' }
  }
  return url.hostname === appId ? { verdict: 'allow' } : { verdict: 'deny', reason: 'foreign-app' }
}

/** 窗口标识（宿主内部；每个应用一个）。 */
export type AppWindowHandle = unknown

/**
 * 应用窗口 surface 的**注册面**（§16.1 冻结的 `kind:'app'` 那一半）。
 *
 * 归属说明（为什么是一个结构化接口而不是直接 import browser 包的类）：真实的注册表
 * 由 `@picoaide/dsh-browser` 经 Cordis 服务 `browserSurface` **provide** 出来
 * （`@picoaide/dsh-browser/surface` 的 `BROWSER_SURFACE_SERVICE`），而它可能晚于本插件
 * apply（profile 里两个行同层、本插件在前）。窗口管理器只认这个最小形状：注册 / 注销，
 * 于是"建窗时注册、关窗时注销"这条接线可以在**纯 Node** 下被逐条钉住。
 */
export interface AppSurfaceRegistrar {
  /**
   * 注册/更新一个应用窗口 surface。
   *
   * `webContents` 是不透明句柄（注册表不解释它；browser 侧的 CDP 附着路径要用它把
   * 工具操作指到这个窗口）。`scope` = 该窗口所在的会话分区（切账号时按它清理）。
   */
  registerApp(input: {
    id: number
    appId: string
    appScheme: string
    webContents?: unknown
    scope?: string
  }): { id: number }
  /** 注销（窗口关闭/被用户关掉/登出）。 */
  unregister(id: number): void
}

/**
 * 宿主自己分配的应用 surface id 起点。
 *
 * 为什么不让注册表按 webContents id 去撞：surface id 空间里还有**浏览器标签**
 * （池子按 1..N 分配），而注册表的去重只在"同 id 且已有条目是浏览器标签"时把应用窗口
 * 往上让。两个应用窗口拿同一个 id 时它**不会**让（kind 是 app）⇒ 后注册的会覆盖先注册
 * 的，另一个应用从此无法按 `app_id` 寻址。所以 id 由本模块**单调分配、永不复用**。
 * 起点取 100 万：浏览器标签是 1..16 量级（上限 16 个），够不到这里。
 */
export const APP_SURFACE_ID_BASE = 1_000_000

/** 建窗适配器：桌面壳实现真实 Electron 窗口，单测给替身。 */
export interface WasmAppsWindowAdapter {
  /** 建窗（已按几何契约算好尺寸/位置/比例）。 */
  createAppWindow(options: {
    appId: string
    url: string
    title: string
    /**
     * 该窗口所在的 Electron session 分区（**按用户**，§7.2/R2S-8 冻结：应用窗口复用
     * 内置浏览器的按用户分区）。
     *
     * 为什么是**显式参数**而不是适配器自己算：分区名是"当前登录用户"的函数，而适配器
     * （原生面）看不到会话服务 —— 让它去猜就等于把 `browserPartitionFor` 的实现复制到
     * 第二个地方，两边一旦发散，应用窗口会落在一个**没人注册协议 handler** 的 session
     * 上（症状：应用页 `ERR_UNKNOWN_URL_SCHEME` 空白窗口）。调用方（插件，持有会话）
     * 算好传进来，适配器只负责照办。
     */
    partition: string
    width: number
    height: number
    x: number
    y: number
    ratio?: number
    minimumWidth: number
    minimumHeight: number
  }): AppWindowHandle
  /** 聚焦并导航到 URL（已有窗口时用）。 */
  focusAppWindow(handle: AppWindowHandle, url: string): void
  /** 关闭窗口。 */
  closeAppWindow(handle: AppWindowHandle): void
  /** 锁定宽高比（`extraSize` = 自绘 chrome 的额外高度；程序化 resize 不受它约束）。 */
  setAspectRatio(handle: AppWindowHandle, ratio: number, extraSize: { width: number, height: number }): void
  /** 安装应用面闸门（`will-navigate` / `will-frame-navigate` / `will-redirect` /
   * `setWindowOpenHandler` + session 级 `onBeforeRequest`；归属 = 应用窗口模块，
   * 见 §16.1）。 */
  installAppWindowGuards?(handle: AppWindowHandle, appId: string): void
  /**
   * 创建窗口**之前**确保该分区装了权限守卫（§16.1：守卫归属 = 分区初始化）。
   *
   * 宿主在协议注册点已经装过（幂等），这里再要求一次是**显式**保证：应用窗口可以在
   * 一张浏览器标签都没开过时创建，而 Electron 缺 check handler 时默认放行 camera/mic。
   *
   * 分区是**必填参数**（与 `createAppWindow` 同源同值）：守卫必须装在应用窗口真正
   * 落地的那个 session 上。缺席时它会落到默认 session —— 那既保护不了应用窗口，
   * 又会用 last-wins 覆盖掉主窗口在默认 session 上装的剪贴板白名单（2026-09-20
   * 审计点名的无判据耦合）。
   * @param partition - 应用窗口所在的 session 分区（与 `createAppWindow` 同值）。
   */
  ensureSessionGuard?(partition: string): void
  /**
   * 该窗口的 `webContents.id`（session 级请求闸门按它判发起者，§23.2 N6）。
   *
   * 缺席 ⇒ 闸门一律把请求当"非应用窗口"取消（fail-closed：应用页面打不开好过
   * 任意网页能借用员工令牌触发应用请求）。
   */
  webContentsId?(handle: AppWindowHandle): number | undefined
  /**
   * 该窗口的 `webContents`（**不透明句柄**，§16.1：注册应用窗口 surface 时交给
   * browser runtime 的 CDP 附着路径）。
   *
   * 与 {@link webContentsId} 分开是因为两者消费者不同：id 是**闸门判据**（必须存在，
   * 否则 fail-closed），webContents 是**工具面句柄**（缺席只是"AI 还不能驱动这个窗口"，
   * 不影响建窗与闸门）。实现方缺席 ⇒ surface 仍然注册（`kind:'app'` 可见、`app_id`
   * 可寻址），只是 `webContents` 为空。
   */
  webContents?(handle: AppWindowHandle): unknown
  /**
   * 窗口是否**还活着**（§7.2 单应用单窗口的另一半）。
   *
   * 为什么契约里必须有这一条：用户点窗口的关闭按钮时，原生窗口是 Electron 自己
   * 销毁的，宿主收不到任何回调。没有存活判据时管理器会一直把已销毁的句柄当"已打开"
   * ⇒ 第二次 `open` 回 `focused`、`has()` 为真、屏幕上却**一个窗口都没有**
   * （正是"契约对、现象空"那类缺陷）。实现方缺席 ⇒ 按"永远活着"处理（旧替身不受影响）。
   */
  isAlive?(handle: AppWindowHandle): boolean
  /**
   * 当前显示器工作区（多显示器：每次打开重新求值）。
   *
   * 归适配器而不是管理器：只有原生侧知道鼠标在哪块屏（`screen` API）。缺席 ⇒
   * 管理器回落一个 1280×800 的保守工作区（纯 Node 宿主/单测）。
   */
  workArea?(): WorkArea
}

/** 窗口管理器的构造参数。 */
export interface WasmAppsWindowsOptions {
  adapter: WasmAppsWindowAdapter
  appScheme: string
  productName: string
  userDataDir: string
  /**
   * 当前用户的应用窗口 session 分区（§7.2/R2S-8：复用内置浏览器的按用户分区）。
   *
   * **必填**，且必须是**函数**（每次 open 求值）：分区是当前登录用户的函数，登录态
   * 可以在进程存活期间变化（登出/切账号）—— 在构造期求值一次会把上一个用户的分区
   * 钉死给下一个用户。由插件（唯一持有会话服务的一方）提供，管理器只透传。
   */
  partition: () => string
  /** 打开：`<scheme>://<app_id><path>`（唯一实现由调用方给：它同时被本机路由与深链用）。 */
  urlFor: (appId: string, path: string) => string
  /** 应用标题解析（来自目录/平台；拿不到时回落到 app_id）。 */
  titleFor?: ((appId: string) => string | undefined) | undefined
  /**
   * 应用窗口 surface 的注册表（§16.1；browser 插件 `provide` 的 `browserSurface`）。
   *
   * **是 thunk 不是值**：`browserSurface` 可能晚于本插件 apply（profile 里本行在前），
   * 而窗口可以在此之前就被打开（深链、本机路由）。用 thunk 让"注册表晚到"这件事在
   * 类型上可见：`registerOpenWindows()` 在它到达时把已开着的窗口补注册一遍。
   *
   * 缺席/晚到 ⇒ 只影响 AI 能否寻址这个窗口，**不影响**建窗、闸门、权限守卫。
   */
  surfaces?: (() => AppSurfaceRegistrar | undefined) | undefined
  /** 当前工作区（多显示器：每次打开重新求值）。 */
  workArea: () => WorkArea
  warn?: ((message: string) => void) | undefined
}

/** 打开结论（§5.2 冻结：`window` 是 `opened`|`focused`，客户端据此给反馈）。 */
export interface AppWindowOpenResult {
  window: 'opened' | 'focused'
  appId: string
  url: string
}

/** 应用窗口管理器。 */
export interface WasmAppsWindows {
  /**
   * 打开或聚焦（单应用单窗口，§7.2）。
   * @param appId - 已校验的 app_id。
   * @param path - 已净化的相对路径（缺省 `/`）。
   * @param geometry - 作者声明的窗口几何（`window.ratio/width/height`，F3/§6）。
   *   **只在首次建窗时**决定初始尺寸；比例（ratio）对每次打开都生效（含聚焦已有窗口后
   *   的锁定）。缺省 ⇒ 1280×720 且不锁比例。
   */
  open(appId: string, path?: string, geometry?: DeclaredWindowGeometry | null): Promise<AppWindowOpenResult>
  /** 是否存在窗口。 */
  has(appId: string): boolean
  /** 打开着的应用 id（诊断/测试）。 */
  openApps(): readonly string[]
  /** 关闭单个应用的窗口（下架/冻结/删除）。 */
  close(appId: string): Promise<void>
  /** 关闭全部并清空映射（登出/切账号/切渠道，§7.2 冻结）。 */
  closeAll(): Promise<void>
  /**
   * 把当前所有活着的应用窗口补注册进 surface 注册表（§16.1）。
   *
   * 为什么需要它：注册表可能**晚于**窗口出现（browser 行在本插件之后加载；深链可以在
   * 那之前就把窗口开出来）。幂等（已注册的窗口不重复注册）。
   */
  registerOpenWindows(): void
  /**
   * 该 `webContentsId` 是否是本管理器创建的应用窗口（session 级请求闸门的判据）。
   * @param webContentsId - Electron `webRequest` details 的发起者 id。
   */
  isAppSurfaceWebContents(webContentsId: number | undefined): boolean
}

/**
 * 构造应用窗口管理器。
 * @param options - 适配器/几何来源/状态文件位置。
 * @returns 窗口管理器（状态文件读写是 best-effort：失败只 warn）。
 * @throws 当 `partition` 不是函数时（**构造期** fail-loud：JS 调用方漏传时，晚到
 *   `open()` 里才炸会表现成"点打开报一个看不懂的 TypeError"，而这条缺失的真实后果是
 *   "应用窗口落回默认 session" —— 必须在最早、最清楚的地方拦下）。
 */
export function createWasmAppsWindows(options: WasmAppsWindowsOptions): WasmAppsWindows {
  if (typeof options.partition !== 'function') {
    throw new Error('createWasmAppsWindows: options.partition must be a function returning the per-user session partition')
  }
  const warn = options.warn ?? ((): void => {})
  const windows = new Map<string, AppWindowHandle>()
  /** 应用窗口的 webContents id（请求闸门的唯一白名单来源）。 */
  const webContentsIds = new Set<number>()
  const memory = new Map<string, AppWindowMemory>()
  /** 已注册进 surface 注册表的窗口（app_id → surface id；注销要按它）。 */
  const surfaceIds = new Map<string, number>()
  let surfaceSeq = 0
  let loaded = false

  /**
   * 把一个应用窗口注册进 surface 注册表（§16.1 的 `kind:'app'`）。
   *
   * 幂等：已注册过的 app_id 直接返回。注册表缺席（browser 行还没加载/纯 Node 宿主）
   * 时**什么都不做**，等 {@link WasmAppsWindows.registerOpenWindows} 被调用时补。
   * @param appId - 应用 id。
   * @param handle - 窗口句柄。
   */
  const registerSurface = (appId: string, handle: AppWindowHandle): void => {
    if (surfaceIds.has(appId)) return
    const registry = options.surfaces?.()
    if (registry === undefined) return
    surfaceSeq += 1
    const webContents = options.adapter.webContents?.(handle)
    try {
      const surface = registry.registerApp({
        id: APP_SURFACE_ID_BASE + surfaceSeq,
        appId,
        appScheme: options.appScheme,
        ...(webContents === undefined ? {} : { webContents }),
        scope: options.partition(),
      })
      surfaceIds.set(appId, surface.id)
    } catch (cause) {
      // 注册失败不得影响建窗（AI 能不能驱动它是能力，不是准入）。
      warn(`pico-wasm-apps-host: registering the application surface for ${appId} failed (${cause instanceof Error ? cause.message : String(cause)})`)
    }
  }
  /** 注销一个应用的 surface（窗口关闭/被用户关掉/登出）。 */
  const unregisterSurface = (appId: string): void => {
    const id = surfaceIds.get(appId)
    if (id === undefined) return
    surfaceIds.delete(appId)
    try {
      options.surfaces?.()?.unregister(id)
    } catch (cause) {
      warn(`pico-wasm-apps-host: unregistering the application surface for ${appId} failed (${cause instanceof Error ? cause.message : String(cause)})`)
    }
  }

  const load = async (): Promise<void> => {
    if (loaded) return
    loaded = true
    const state = await readWindowsState(options.userDataDir)
    for (const [appId, entry] of Object.entries(state.apps)) memory.set(appId, entry)
  }
  const persist = async (): Promise<void> => {
    try {
      await writeWindowsState(options.userDataDir, {
        version: APP_WINDOWS_STATE_VERSION,
        apps: Object.fromEntries(memory),
      })
    } catch (cause) {
      warn(`pico-wasm-apps-host: persisting the app window memory failed (${cause instanceof Error ? cause.message : String(cause)})`)
    }
  }

  const titleOf = (appId: string): string =>
    `${options.titleFor?.(appId) ?? appId} · ${options.productName}`

  /** 丢掉一个已被原生侧销毁的句柄（用户手动关窗；见 `isAlive` 的契约注释）。 */
  const forget = (appId: string, handle: AppWindowHandle): void => {
    windows.delete(appId)
    // 窗口没了 ⇒ 它在 browser runtime 里的 surface 也必须消失：留着会让模型
    // 按 `app_id` 寻址到一个已经销毁的 webContents（工具面会报一个看不懂的错）。
    unregisterSurface(appId)
    const wcId = options.adapter.webContentsId?.(handle)
    if (typeof wcId === 'number') webContentsIds.delete(wcId)
  }
  /** 该应用当前活着的窗口句柄（已销毁的顺手清掉）。 */
  const liveHandle = (appId: string): AppWindowHandle | undefined => {
    const handle = windows.get(appId)
    if (handle === undefined) return undefined
    if (options.adapter.isAlive?.(handle) === false) {
      forget(appId, handle)
      return undefined
    }
    return handle
  }

  return {
    async open(appId, path = '/', geometry) {
      await load()
      const url = options.urlFor(appId, path)
      const existing = liveHandle(appId)
      if (existing !== undefined) {
        // 聚焦已有窗口 ⇒ 软闸门（§5.1b：保留内容 + 导航到目标路径，不换错误页）。
        options.adapter.focusAppWindow(existing, url)
        const remembered = memory.get(appId)
        memory.set(appId, { ...(remembered ?? { width: APP_WINDOW_DEFAULT_WIDTH, height: APP_WINDOW_DEFAULT_HEIGHT }), lastPath: path })
        await persist()
        return { window: 'focused', appId, url }
      }
      const remembered = memory.get(appId)
      // 作者声明的几何（F3/§6）：**只决定首次开窗尺寸** —— 已经有记忆（用户拖过/上次
      // 运行留下的状态）时以记忆为准，声明不是"每次复位"。
      // 比例（ratio）在两条路径上都生效：声明 > 记忆里的旧比例（改版后新比例必须生效，
      // 否则"详情页显示 16:9"与真实窗口又会分叉）。
      const declaredRatio = clampAspectRatio(geometry?.ratio ?? remembered?.ratio)
      const declaredSize = remembered === undefined
        ? resolveDeclaredWindowSize(geometry)
        : { width: remembered.width, height: remembered.height }
      const rect = clampToWorkArea(
        {
          width: declaredSize.width,
          height: declaredSize.height,
          ...(remembered?.x === undefined ? {} : { x: remembered.x }),
          ...(remembered?.y === undefined ? {} : { y: remembered.y }),
        },
        options.workArea(),
        declaredRatio,
      )
      const minimum = minimumWindowSize(declaredRatio)
      // 分区在**每次打开**时求值（登录态可变）；同一次打开里的"装守卫"与"建窗"
      // 必须用**同一个**值，否则守卫会落在与窗口不同的 session 上（等于没装）。
      const partition = options.partition()
      // 先保证守卫再建窗：顺序反了会出现"窗口存在但权限面无守卫"的窗口期。
      options.adapter.ensureSessionGuard?.(partition)
      const handle = options.adapter.createAppWindow({
        appId,
        url,
        title: titleOf(appId),
        partition,
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
        ...(declaredRatio === undefined ? {} : { ratio: declaredRatio }),
        minimumWidth: minimum.width,
        minimumHeight: minimum.height,
      })
      windows.set(appId, handle)
      const wcId = options.adapter.webContentsId?.(handle)
      if (typeof wcId === 'number') webContentsIds.add(wcId)
      else warn('pico-wasm-apps-host: the window adapter did not report a webContents id; application-scheme subresource requests will be refused (fail-closed)')
      options.adapter.installAppWindowGuards?.(handle, appId)
      if (declaredRatio !== undefined) options.adapter.setAspectRatio(handle, declaredRatio, { width: 0, height: 0 })
      // §16.1：**建窗即注册** surface（`kind:'app'`）—— 注册表里没有它，AI 的
      // `browser_list_tabs` 永远看不到应用窗口、`app_id` 寻址永远报"没有这个应用窗口"。
      // 必须在窗口句柄进入 `windows` 之后（注销路径按同一个映射找 id）。
      registerSurface(appId, handle)
      memory.set(appId, {
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
        ...(declaredRatio === undefined ? {} : { ratio: declaredRatio }),
        lastPath: path,
      })
      // 记忆必须在 open() 返回前落盘：否则"刚打开就重启"会丢掉刚记下的尺寸。
      await persist()
      return { window: 'opened', appId, url }
    },
    has(appId) {
      return liveHandle(appId) !== undefined
    },
    openApps() {
      for (const appId of [...windows.keys()]) liveHandle(appId)
      return [...windows.keys()]
    },
    registerOpenWindows() {
      for (const [appId, handle] of [...windows.entries()]) {
        if (liveHandle(appId) === undefined) continue
        registerSurface(appId, handle)
      }
    },
    async close(appId) {
      const handle = windows.get(appId)
      if (handle === undefined) return
      windows.delete(appId)
      unregisterSurface(appId)
      const wcId = options.adapter.webContentsId?.(handle)
      if (typeof wcId === 'number') webContentsIds.delete(wcId)
      options.adapter.closeAppWindow(handle)
    },
    async closeAll() {
      for (const handle of windows.values()) options.adapter.closeAppWindow(handle)
      for (const appId of [...surfaceIds.keys()]) unregisterSurface(appId)
      windows.clear()
      webContentsIds.clear()
    },
    isAppSurfaceWebContents(webContentsId) {
      return webContentsId !== undefined && webContentsIds.has(webContentsId)
    },
  }
}

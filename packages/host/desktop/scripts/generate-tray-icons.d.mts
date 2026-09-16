/**
 * `generate-tray-icons.mjs` 的类型声明。
 *
 * 纯 JS 模块（sharp 渲染托盘位图），但被测试与脚本以类型化方式调用 ——
 * 没有这份声明，TS 在 strict 下会以 TS7016 拒绝编译（tsconfig.tests.json 覆盖
 * scripts 下的 .ts）。声明与实现同源：改签名必须同步改这里。
 */

/** 一个托盘位图变体：输出文件名、边长、替换后的品牌色与是否 macOS 模板图。 */
export interface TrayVariant {
  readonly file: string
  readonly size: number
  readonly color: string
  /**
   * `true` = macOS 模板图（只有 mark、背景透明、颜色规整成黑）。
   * 系统只拿 alpha 当遮罩，所以这类位图**不能**带不透明底板。
   */
  readonly template?: boolean
}

/** `generateTrayIcons()` 的可覆盖输入。 */
export interface TrayIconOptions {
  /** 品牌 SVG 源文件（缺省 `brands/official/logo.svg`）。 */
  readonly source?: string
  /** 输出目录（缺省 `packages/host/desktop/build`）。 */
  readonly buildRoot?: string
  /** 变体表（缺省内置的 6 个）。 */
  readonly variants?: readonly TrayVariant[]
}

/**
 * 按品牌 SVG 渲染全部托盘位图。
 * @param options - 源文件、输出目录与变体表。
 * @returns 渲染出的文件名列表。
 * @throws 源 SVG 不是固定品牌色或含 `<style>` 时抛错（几何单一权威）。
 */
export function generateTrayIcons(options?: TrayIconOptions): Promise<string[]>

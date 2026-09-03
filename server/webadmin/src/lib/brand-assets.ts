// 编译期品牌注入(单一权威源 brands/official/logo.svg):
// 所有兜底 logo / 品牌 mark 一律引用这里注入的权威 SVG URL, 禁止在页面源码内
// 手写 SVG 几何——旧版 P 字 logo 已退役, 且曾因手写几何导致预览与权威 logo
// 不一致(2026-09: 品牌配置页实时预览 mark 缩小版)。Vite 会在构建时将 <4KB
// 的资产内联为 data URL, Go embed 产物自包含。
import officialLogoSvg from '../../../../brands/official/logo.svg?url'

/** 官方品牌 logo(brands/official/logo.svg): 黑圆角方块 + 白花括号/连接线/双节点, 1.25x。 */
export const BRAND_LOGO_URL: string = officialLogoSvg

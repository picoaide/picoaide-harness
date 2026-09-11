// 站点 favicon：直接输出品牌几何真源，不在 public/ 里放副本。
//
// Starlight 的默认 favicon 指向 `/favicon.svg`，而品牌资产唯一权威是
// `brands/official/logo.svg`（见根 AGENTS.md「品牌标识」）。这里用构建期
// 端点把它原样发布到 `/favicon.svg`，避免第二份几何副本。
import logo from '../../../brands/official/logo.svg?raw'

export const prerender = true

export function GET(): Response {
  return new Response(logo, {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
  })
}

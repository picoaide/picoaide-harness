/**
 * webadmin API 路径集中常量(2026-09,与 Go internal/router 命名空间对齐):
 * 全仓库 API 命名空间唯一真源是 server/internal/router 包的
 * NamespaceServer / NamespaceClientV2 常量;本文件是管理前端的镜像——
 * 页面/组件不得散落硬编码 `/api/server/admin` 与 `/api/client/v2` 前缀,
 * 一律引用这两个常量(可枚举、可审计、避免旧前缀回归)。
 *
 * 命名空间规则(见 server/AGENTS.md §7.0):
 *   - /api/server/admin/*   管理面(webadmin, session + CSRF + RBAC)
 *   - /api/client/v2/*      客户端员工面(公开端点如 brand 也在此)
 *   - 旧前缀(/api/admin、/api/brand、/api/marketplace 等)已迁移移除。
 */

/** 管理面 API 前缀(与 router.NamespaceServer + "/admin" 一致)。 */
export const ADMIN_API = '/api/server/admin'

/** 客户端员工面 API 前缀(与 router.NamespaceClientV2 一致)。 */
export const CLIENT_API = '/api/client/v2'

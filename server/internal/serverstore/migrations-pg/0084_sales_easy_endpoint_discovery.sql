-- 0084: 默认的第三方 MCP 连接器改为「端点自述授权」（2026-10-08）。
--
-- 0042 给这台目录种的 sales-easy 行是**手写静态端点**（authorize/token/register 三条 URL
-- 逐一钉死），那是本功能出现之前唯一可用的写法。它有两个后果：
--
--   ① 绕过 MCP 授权规范里的资源指示（RFC 8707）：客户端只在拿到 discovery 结果时才发送
--      `resource` 参数，而静态端点那条路径没有这个参数，端点自己声明的资源却是
--      `https://mcp.xiaoshouyi.com/mcp`；
--   ② 端点一旦搬迁或换域名，配置就静默失效（管理员得去读厂商文档重填三条 URL）。
--
-- 端点实际完全自述（2026-10-08 实测）：`POST /mcp` → 401 + `WWW-Authenticate:
-- Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"` → 元数据给出
-- authorization_servers 与 scopes_supported → 根 well-known 的 RFC 8414 文档给出
-- authorize/token/**register**（动态客户端注册）+ `token_endpoint_auth_methods_supported:
-- ["none"]` + PKCE S256 + offline_access。默认行因此只需要一个 URL。
--
-- **只改「没被动过」的行**：`WHERE definition = <0042 原文>` 逐字节比对。管理员自己改过
-- 这一行（换成别的租户端点、加了 headers、改了示例提示词）就一个字都不动 —— 迁移不该
-- 覆盖人的决定。
--
-- 模式仍是 `auth_mode='oauth'`（不写 `auto`）：`discoveryUrl` 这条形状在**旧客户端**上
-- 也早已支持（本目录 `example-mcp` 种子一直在用），所以"服务器先升级、员工客户端后升级"
-- 的滚动窗口里这一行照常可用；`auto` 留给新建连接器（标准 mcpServers 导入那条路径）。
--
-- 回滚口径（两步，与 0082/0083 同款）：① `DELETE FROM schema_migrations WHERE version = 84;`
-- ② 换回旧镜像。**本迁移只改数据、不改结构**，所以旧二进制起得来；但被改写的那一行不会
-- 自动变回去 —— 需要原文时按 0042 的定义粘回管理端编辑框即可（或从 0042 迁移文件里取）。

UPDATE connectors
   SET definition = '{"auth":{"discoveryUrl":"https://mcp.xiaoshouyi.com/mcp","pkce":true,"publicClient":true},"authMode":"oauth","examples":["查询最近赢单的 10 个商机","统计各行业客户数量","帮我找一下联系人张三"],"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.xiaoshouyi.com/mcp"}]}'
 WHERE id = 'sales-easy'
   AND auth_mode = 'oauth'
   AND definition = '{"auth":{"authorizeUrl":"https://mcp.xiaoshouyi.com/oauth/authorize","tokenUrl":"https://mcp.xiaoshouyi.com/oauth/token","registrationEndpoint":"https://mcp.xiaoshouyi.com/oauth/register","clientId":"","redirectUri":"","scopes":"offline_access","pkce":true,"publicClient":true},"examples":["查询最近赢单的 10 个商机","统计各行业客户数量","帮我找一下联系人张三"],"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.xiaoshouyi.com/mcp"}]}';

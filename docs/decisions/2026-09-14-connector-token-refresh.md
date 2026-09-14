# 连接器/MCP 令牌自动刷新（官方 MCP 授权规范）

- 日期：2026-09-14
- 状态：已实施（待提交）
- 影响面：`packages/host/connectors`（全部连接器与未来任何 MCP 服务器来源）、`patches/dsh-mcp-client@0.1.5-rc.2.patch`（上游一行透传 + schema 声明）

## 1. 问题

连接器的 OAuth 访问令牌**只在启动/重新登录时刷新一次**（旧实现：`restoreAll()` 里调一次 `refreshOAuthToken`）。表现：

- 应用长时间开着 → access token 过期 → 所有 MCP 工具调用报 `invalid_token`，界面仍显示「已连接」；
- 唯一的恢复手段是重启应用或重新走一遍授权（重新授权还会换来一个新的动态注册 clientId）；
- `expires_in` 在换 token 与刷新两处都被丢弃，界面上**不可能**告诉用户"有效期到几点"；
- stdio 型 MCP 服务器的令牌是在 spawn 时写进子进程 `env` 的，天然刷不了，只能靠重启。

## 2. 决策：用官方协议实现，不自创刷新机制

MCP 授权规范（2025-06-18，叠 RFC 9728 / RFC 8414 / RFC 7591 / RFC 6749 §6 / RFC 8707）已经定义了完整的令牌生命周期，`@modelcontextprotocol/sdk` 1.30.0 的 `StreamableHTTPClientTransport` 内置实现：拿到 `authProvider`（`OAuthClientProvider`）后，它会

1. 用 `provider.tokens()` 里的 bearer token 发请求；
2. 服务端回 401 时调用官方 `auth()` 编排器：读 `tokens()` → 有 refresh token 就用元数据里的 token endpoint 跑 RFC 6749 §6 刷新 → `provider.saveTokens()` 持久化轮换结果 → **重试原请求**；
3. refresh token 失效时抛标准 OAuth 错误（`InvalidGrantError` 等），并且**不会**在没有回调地址的情况下打开浏览器。

因此本仓库**不新增任何自研刷新协议**：我们只实现官方 `OAuthClientProvider` 的存储侧（`src/mcp-oauth-provider.ts`），其余全部交给 SDK。

### 为什么不是"401 时自己 POST 一次刷新"

自研刷新会分叉出第二套端点推导（规范里由 RFC 9728/RFC 8414 元数据决定），在"只有 discoveryUrl、没有静态 tokenUrl"的连接器（Moka）与"只有静态端点、没有元数据"的连接器（销售易）上必须各写一套，而且刷新失败分类、令牌轮换、并发单飞都要自己维护。探针实测（`temp/mcp-auth-probe/`）证明官方 `authProvider` 路径在这两种形态下都成立。

## 3. 实施

### 3.1 上游补丁（唯一的上游改动）

`patches/dsh-mcp-client@0.1.5-rc.2.patch`：

- `lib/index.js`：streamable-http 分支把可选 `authProvider` 交给 `StreamableHTTPClientTransport`；
- `lib/index.js` 的 Config schema：显式声明 `authProvider: z.any()` —— Schemastery 会**剥掉未声明字段**，不声明则函数值在归一化时静默消失；
- `lib/types/index.d.ts`：`StreamableHttpConfig.authProvider?: OAuthClientProvider`。

resolutions 按仓库既有惯例登记 exact + `^` 两个键；护栏 `packages/host/desktop/tests/mcp-client-auth-provider.spec.ts`（schema 必须原样保留函数值 + 产物里必须同时存在透传点与 schema 声明）。

### 3.2 连接器侧

| 位置 | 作用 |
|---|---|
| `src/mcp-oauth-provider.ts` | 官方 `OAuthClientProvider` 的存储实现 + `resolveAuthorizationServer()`（复用 `auth.ts` 里已有的、过 SSRF 策略的 RFC 9728/RFC 8414 发现）+ `TokenRefresher`（per-id 单飞、失败分类） |
| `src/token-lifetime.ts` | `expires_in` 解析、`REFRESH_LEAD_MS=60s`、`REFRESH_SWEEP_INTERVAL_MS=60s` |
| `src/store.ts` | 凭据新增 `expiresAt` / `refreshedAt`（读取时对非法时间戳做净化） |
| `src/auth.ts` | 换 token 与旧刷新路径都把 `expires_in` 落成绝对 `expiresAt`；导出 `discoverMcpOAuth` 供刷新路径复用（保持唯一发现实现） |
| `src/index.ts` | 注册 MCP 时挂 `authProvider`（HTTP）；每 60s 心跳按 `expiresAt` 提前续期；`pico/connector-credentials-changed` 事件让 stdio 服务器重新注册（新令牌进子进程 env）；新增 `POST /api/pico/connectors/:id/refresh`；列表返回 `expiresAt/refreshedAt/canRefresh/refreshing` |
| `src/client/ConnectorsSection.tsx` | 卡片显示「令牌有效期至 …」/「上次刷新 …」，连接状态下多一个「刷新令牌」按钮 |

### 3.3 失败语义（用户可见）

| 情况 | 结果 |
|---|---|
| 刷新成功 | 写入新 access token（含轮换 refresh token）与 `expiresAt`，界面刷新有效期 |
| refresh token 失效（`invalid_grant`/`invalid_client`） | 行状态置 `unauthorized` + 明确文案「需要重新授权」，不再假装已连接 |
| 网络/5xx | `transient`：保留旧凭据并保持 `error` 提示，下次心跳/调用再试 |
| 非 OAuth（token 表单 / server-side） | 不做刷新，`canRefresh=false` |

### 3.4 刷新触发点（三条，互补）

1. **调用时**：SDK 的 401 → `auth()` → 刷新 → 重试（无需重注册，实测同一连接内可连续自愈）；
2. **心跳**：每 60s 对 `expiresAt` 临近（60s 提前量）或没有记录过期时间的凭据主动续期；
3. **手动**：面板「刷新令牌」按钮（`force`，不打开授权页）。

## 4. 验证

- 探针 `temp/mcp-auth-probe/`（`@modelcontextprotocol/sdk` 1.30.0 + 假授权/假 MCP 服务器，不触网）：provider 持有效令牌 → 自动注入；令牌过期 → 401 触发刷新重试；中途轮换 → 自动恢复；refresh token 失效 → 抛 `InvalidGrantError` 且**零浏览器尝试**；无凭据 → 干净报错。
- 单测 `packages/host/connectors/tests/token-refresh.spec.ts`（15 例，真实 HTTP 假授权服务器）：发现形态 / 静态端点形态 / 轮换保留 / 死 grant → `reauthorize` / 5xx → `transient` / 并发单飞只发一次 grant / 心跳只刷一次 / 手动刷新路由（响应不含任何令牌材料）/ stdio 令牌变更后重新注册 / **心跳在无任何工具调用时把过期令牌刷新并重注册 stdio 服务器**。
- 门禁：`yarn workspace @picoaide/dsh-connectors check` 与整仓 `yarn check`（含 `verify-patches` 在仓库外对 pristine tarball 的 dry-run 与逐字节对拍）。
- 未做真机（需客户 IdP 交互授权）：Moka 线上刷新未在真实服务端跑过，首次升级后建议观察一次令牌到期是否自动续期。

## 4.1 两处实现细节（踩过才定下来的）

- **`auth()` 必须有 `serverUrl`**：即使命中已保存的 discovery state，SDK 仍会用它推导 RFC 8707 resource 并做匹配校验；省略会以 `Invalid URL` 失败。因此刷新路径始终传 `discoveryUrl ?? resourceUrl ?? 发现的 resource ?? 授权服务器`。
- **静态端点形态的 resource 校验放宽**：只有静态端点的定义会把自己发布的 resource 与"我们的 server URL 的 origin/路径"比对，两者不一致时 SDK 默认拒绝（实测错误：`Protected resource … does not match expected …`）。定义里的 MCP URL 才是 bearer 令牌的权威资源，所以 provider 实现 `validateResourceURL`：同源即接受，否则返回 `undefined`（不附带 resource 参数）。这条只影响我们自己的服务端下发定义（出站 URL 在 `policy.ts` 已过策略）。

## 5. 后续

- 上游若在 `createTransport` 里自带 `authProvider` 透传，本补丁应删除（登记在 `patches/` 惯例里，升级时必须重切）。
- 复用姿势：任何新的 MCP 服务器来源（插件、市场包）只要把官方 `OAuthClientProvider` 交给 `dsh-mcp-client`，就能直接获得同一套刷新能力；刷新引擎（`TokenRefresher`）只认"令牌端点 + refresh_token"，不认识连接器定义。

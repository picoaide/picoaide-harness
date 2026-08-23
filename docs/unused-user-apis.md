# 未使用的用户 API 清单（2026-08-21 盘点）

> 盘点范围：`server/`（PicoAide-Next Go 服务端）注册的全部**用户侧 API**（Bearer token / 登录态，
> 不含 `/api/admin/*` 管理端接口），对照实际客户端（`packages/host/enterprise` 企业客户端插件 +
> DSH `llm-deepseek` 适配器）与 `server/webadmin` 的调用点。

## 结论速览

- 服务端共注册 **17 个用户侧 API**（含 2 个 OIDC 可选路由与 1 个健康探针）。
- 实际客户端（dsh-enterprise + llm-deepseek）**只用了 6 个**。
- **11 个用户 API 没有任何客户端调用**（webadmin 只调 `/api/admin/*`，也不使用它们）。

## 客户端已使用的 API（6 个）

| 方法 | 路径 | 调用点 |
|---|---|---|
| POST | `/api/auth/login` | `plugins/dsh-enterprise/src/server-connector/auth.ts:72` |
| POST | `/api/auth/logout` | `plugins/dsh-enterprise/src/auth-gate.ts:214` |
| GET | `/api/config/bootstrap` | `plugins/dsh-enterprise/src/server-connector/bootstrap.ts:17` |
| GET | `/api/marketplace/skills` | `plugins/dsh-enterprise/src/auth-gate.ts:238` |
| GET | `/api/marketplace/skills/:name/archive` | `plugins/dsh-enterprise/src/auth-gate.ts:266,325` |
| POST | `/v1/chat/completions` | `gateway-model.ts` 配置 baseURL=`{server}/v1`，`deepseek-harness/packages/llm/llm-deepseek/src/adapter.ts:341` |

> **2026-08-21 更新**：`GET /api/auth/usage` 已由新插件 `packages/client/account-card` 消费
> （底部账号卡片余额展示：agent loop 完成后刷新 + 10s 轮询 + 手动刷新），不再是未使用 API。

## 客户端未使用的 API（11 个）

### 1. 认证与账号

| 方法 | 路径 | 说明 | 潜在使用方 |
|---|---|---|---|
| GET | `/api/auth/me` | 当前登录用户信息（`server/internal/serverauth/handler.go:98`） | 客户端目前依赖 bootstrap 后本地 session，从不拉取 me |
| GET | `/api/auth/oidc/login` | OIDC 登录入口（仅 `auth.mode=oidc` 时注册，`handler.go:101`） | 客户端登录页只支持 local 账号密码（`auth-gate.ts` LOGIN_HTML），未做 OIDC 流程 |
| GET | `/api/auth/oidc/callback` | OIDC 回调 | 同上 |

### 2. LLM 网关

| 方法 | 路径 | 说明 | 潜在使用方 |
|---|---|---|---|
| GET | `/v1/models` | 模型列表（`llmgateway/routes.go:29`） | `llm-deepseek` 适配器用**静态配置** `connection.models`（`adapter.ts:185/194`），从不拉取 `/models`；模型上架/下架靠管理员手动配置同步 |
| POST | `/v1/embeddings` | 向量接口（`routes.go:28`） | 服务端知识库向量化走内部 `llmgateway.Embedder` 直连上游（`embedding.go:94`），**不经该 HTTP 接口**；客户端也不调用 |

### 3. 商城（技能/MCP）

| 方法 | 路径 | 说明 | 潜在使用方 |
|---|---|---|---|
| GET | `/api/marketplace/skills/updates` | 技能更新检查（`skill_api.go:58`） | 客户端只列目录+装/卸，不做更新提醒 |
| GET | `/api/marketplace/skills/:name` | 技能详情（`skill_api.go:59`） | 客户端列表已含所需字段，不拉单条详情 |
| GET | `/api/marketplace/mcp` | MCP 服务器列表（`skill_api.go:61`） | 客户端无 MCP 目录/安装流程 |
| GET | `/api/marketplace/mcp/:id/config` | MCP 配置下发（`skill_api.go:62`） | 同上 |

### 4. 知识库

| 方法 | 路径 | 说明 | 潜在使用方 |
|---|---|---|---|
| POST | `/api/mcp/knowledge/message` | 知识库 JSON-RPC（kb_search/kb_read/kb_list，`knowledge/mcp.go:49`） | 面向 **MCP 客户端**（如 Claude Desktop / 其他 MCP host）接入检索；DSH 客户端未以 MCP client 方式接入知识库 |

### 5. 其他

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查（`bootstrap/bootstrap.go:42`）——仓库内无调用，属部署探针（systemd/docker/Caddy）用途，不算客户端 API |

## 附注

- **webadmin 管理端**（`server/webadmin/src/`）只调用 `/api/admin/*`（login/me/logout/users/departments/usage/providers/models/gateway/channels/skills/mcp/mcp-downloads/kb/*），**未调用任何用户侧 API**。
- 高价值清理候选：`/api/auth/usage`（契约已文档化但客户端无消费方）、`/api/marketplace/mcp*`、`/api/mcp/knowledge/message`（均无任何接入方）。
- `/v1/embeddings` 与 `/v1/models` 若删除不影响现有客户端；但 `/v1/embeddings` 保留可服务于未来客户端侧 RAG 场景。

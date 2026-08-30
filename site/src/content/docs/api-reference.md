---
title: API 参考
description: PicoAide Harness 服务端 HTTP API 参考：认证、LLM 网关、商城与共享内容、能力中心、品牌门户与管理端点。
---

> 本页是服务端 HTTP 接口的公开摘要。所有端点以代码为准（`server/internal/router` 为路由唯一真源）。错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`。

**命名空间**：
- `/api/server/*` — 管理面（webadmin / 运维 / 审计；session + CSRF + RBAC）
- `/api/client/v2/*` — 客户端员工面（企业客户端与第三方接入；Bearer）
- `/v1/*` — LLM 网关（OpenAI / Anthropic 兼容，Bearer；另有官方原生无 `/v1` 变体）

## 错误码

| code | HTTP | 说明 |
|---|---|---|
| `AUTH_REQUIRED` | 401 | 缺少认证令牌 |
| `AUTH_FAILED` | 401 | 令牌无效或已过期 / 凭证错误 |
| `FORBIDDEN` | 403 | 权限不足（管理端） |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION` | 400 | 参数校验失败 |
| `UPSTREAM` | 502 | 上游 LLM 错误 |
| `RATE_LIMITED` | 429 | 触发限流 |
| `QUOTA_EXCEEDED` | 429 | 员工本月 token 或金额配额 / 部门预算超限（admin 豁免） |
| `INTERNAL` | 500 | 内部错误 |

## 认证（员工面）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/client/v2/auth/login` | 密码登录（local / LDAP）：`{username, password}` → `{token}` |
| POST | `/api/client/v2/auth/logout` | 吊销当前 token |
| GET | `/api/client/v2/auth/me` | 当前用户（含 `role` / `permissions`） |
| GET | `/api/client/v2/auth/usage` | 员工用量概览：余额、今日/昨日/本月/累计 tokens + 费用、部门预算链 |
| GET | `/api/client/v2/auth/methods` | 登录方式发现（公开） |
| GET | `/api/client/v2/auth/:provider/login` `/callback` | OIDC / OpenID 浏览器授权（provider 由服务端配置注册） |

## LLM 网关（`/v1/*`，Bearer）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 兼容 chat 代理（stream 可选） |
| POST | `/v1/embeddings` | 向量接口 |
| POST | `/v1/completions` / `/v1/responses` | 原生/兼容形态 |
| POST | `/v1/messages` | Anthropic Messages 兼容（0043，web_search 服务端代理） |
| GET | `/v1/models` | 可用模型列表（仅 enabled provider） |

> 无 `/v1` 前缀的官方原生变体同样挂载（`base_url=server` 使用）；鉴权 / 限流 / 配额 / 计量与 `/v1/chat/completions` 一致。

## 启动配置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/client/v2/config/bootstrap` | 登录后统一下发：`{default_model, models, skills, web, connectors}` |

## 品牌与门户（公开）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/client/v2/brand` | 登录页 / 客户端品牌配置（logo、名称、欢迎语） |
| GET/HEAD | `/api/client/v2/brand/logo/:name` | logo 文件（`login` / `client` / `favicon`） |
| GET | `/api/client/v2/portal` | 门户首页配置（欢迎语 + 三平台客户端下载链接） |

## 市场与共享内容（员工面）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/client/v2/marketplace/skills` | 技能目录（授权可见） |
| GET | `/api/client/v2/marketplace/skills/updates?installed=...` | 技能版本检测：上报已装 `name:version`（≤100 项），返回较新的 `{updates, count}` |
| GET | `/api/client/v2/marketplace/skills/:name/archive` | 下载技能包（`X-Skill-Version` / `X-Skill-Checksum`） |
| GET | `/api/client/v2/shared-skills` | 共享技能清单（approved 且已授权 + 自己上传的全部状态） |
| POST | `/api/client/v2/shared-skills` | 上传共享技能（归档 base64，≤16MB，含顶层 `SKILL.md`），直存 DB |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | 下载共享技能包 |
| GET | `/api/client/v2/agent-presets` | 共享 Agent 清单（同上双门制） |
| POST | `/api/client/v2/agent-presets` | 上传共享 Agent（含顶层 `agent.cordis.yml`） |
| GET | `/api/client/v2/agent-presets/:name/:version/archive` | 下载共享 Agent 包 |
| GET | `/api/client/v2/capabilities?source=market|org&type=&q=` | 能力中心统一目录：市场 + 组织合并视图 |
| POST | `/api/client/v2/telemetry/skill-call` | 上报技能调用（累加 `calls`） |

> 共享内容可见性 = **审核通过 + 授权**（用户/部门）双门制；admin 恒全量；未授权 404 不泄露存在性。

## 管理端（`/api/server/admin/*`，session + CSRF + RBAC）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/server/admin/login` | 管理员登录（`super_admin` / `auditor`；`user` → 403） |
| GET | `/api/server/admin/me` `/logout` | 当前管理员 / 登出 |
| GET/POST/PUT/DELETE | `/users` `/departments` | 用户与部门 CRUD（含配额、角色、部门预算） |
| GET | `/usage` `/server-info` `/audit` | 用量汇总 / 服务器信息 / 审计日志 |
| GET/POST/PUT/DELETE | `/providers` `/models` `/gateway` | 网关上游、模型（含定价/缓存价/峰谷折扣）、网关配置 |
| GET/POST/PUT | `/skills` `/:name/archive` `/:name/grants` | 技能商城管理（上架 / 上传归档 / 授权） |
| GET/POST | `/shared-skills/*` `/agent-presets/*` | 共享内容审核（approve / reject / delete / quality / grants） |
| GET | `/capabilities/approvals` | 能力中心统一审批队列（只读，动作走原域端点） |
| GET/PUT | `/brand` `/portal` | 品牌与门户配置（logo 上传、快照恢复） |
| GET/PUT | `/connectors` | 连接器目录管理 |
| GET | `/channels` | 渠道列表 |

## 其他

| 路径 | 说明 |
|---|---|
| `/`、`/portal` | 门户首页（品牌 + 客户端下载；产品 HTML 面） |
| `/admin/` | webadmin SPA |
| `/healthz` | 健康探针（JSON，DB Ping，503 = DB 不可用） |

> 未列出的端点与完整字段说明见仓库 `server/docs/03-api-reference.md`。

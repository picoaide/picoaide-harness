# PicoAide-Next 系统架构

> 企业内网 AI 办公智能体服务端与管理系统。本文描述系统总体架构、进程模型、数据流与安全设计,与 `AGENTS.md` 保持一致;端点/表名以实际代码为准。
>
> **2026-08-19 变更**:自研 Electron 客户端(desktop/)与浏览器插件(browser-extension/)已下线删除。本文聚焦**服务端 + webadmin 管理端**;原客户端相关章节(进程模型/事件协议/审批门控)不再适用,已移除。

## 1. 总体形态

```
第三方客户端 / 员工接入 ──HTTPS + Bearer token──▶
┌──────────────────────────────────────────────────────────────────────────┐
│ Go 服务端(gin + PostgreSQL)                                       │
│   ├─ 认证:local/LDAP/OIDC + api_tokens(90 天过期,哈希存储)+ /api/client/v2/auth/*   │
│   ├─ AI 网关:/v1/chat/completions|embeddings|models 代理                  │
│   │   + per-user 限流 + usage 计量(费用/峰谷折算)                         │
│   ├─ bootstrap:/api/client/v2/config/bootstrap(默认模型+建议清单)                   │
│   ├─ 商城:skills(建议清单)+ 授权制                                    │
│   └─ 管理端 webadmin(go:embed 内嵌,/admin/,shadcn)                        │
│       用户/网关/用量/商城/部门 —— 全部配置入口                      │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 进程模型(单进程服务端)

| 角色 | 说明 |
|------|------|
| **服务端 Go 进程** | 认证、网关代理、技能商城、计量计费、管理端静态资源。密钥只存在服务端。 |
| **webadmin SPA** | 内嵌进服务端二进制(go:embed dist),`/admin/` 访问;管理员会话(session + CSRF)。 |
| **接入方客户端** | 任何 HTTP 客户端(自研/第三方),持 Bearer token 调 `/api/client/v2/*`(auth/bootstrap/marketplace 等)、`/v1/*`;用量余额经 `GET /api/client/v2/auth/usage` 自查询。 |

## 3. 端到端数据流

1. **接入方登录**:`POST /api/client/v2/auth/login` → Bearer token(90 天);`GET /api/client/v2/config/bootstrap` 拉默认模型与建议清单。
2. **LLM 调用**:`POST /v1/chat/completions`(stream 可选)→ 服务端限流 → 配额检查(token/金额/部门预算,任一超限 429 `QUOTA_EXCEEDED`)→ 按模型匹配上游 provider 代理 → 计量写入 usage(含 `cost`,记录时按定价×峰谷折算)。
3. **管理配置**:管理员登录 `/admin/` → 用户/部门/网关/模型价格/峰谷窗口/配额/预算/商城 CRUD(全部经 `/api/server/admin/*`,session+CSRF+RBAC,审计落 audit_logs)。

## 4. 计量计费与配额(0021-0024)

- **费用**:`usage.cost` = 输入×input_price/1e6 + 输出×output_price/1e6;高峰窗口(settings `usage.peak_windows`,北京时间)外 × 模型 `offpeak_discount`。改价/改窗口只影响之后产生的费用(记录时定价)。
- **配额链**(任一超限即 429,admin 豁免):
  1. 员工 token 配额(`users.quota_tokens`,NULL=跟随全局默认,0=不限)
  2. 员工金额配额(`users.quota_money`)
  3. 部门预算(`groups.budget_money`,归属部门+祖先链全部生效,树内 SUM(cost))
- **员工自查询**:`GET /api/client/v2/auth/usage` 返回余额(配额−本月已用,不限=null)与今日/昨日/本月/累计 tokens+费用、部门预算链。

## 5. 安全设计摘要

- 上游密钥 AES-GCM(`enc:v1:`,master key 文件),永不落明文;API token 只存哈希。
- 严格默认拒绝:商城资源未授权一律 404;授权对象 = 用户或部门组(NOCASE),admin 恒全量不落表;授权变更审计。
- 改密/降权/禁用自动吊销全部 API token(与用户更新同事务)。
- 管理端 session 24h + CSRF;登录限流(10 次/5min/键)。
- 错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`;健康探针 `/healthz`。
- 接入方 TLS:登录页/客户端拒绝非 HTTPS 远程地址(TOFU 由接入方实现)。

## 6. 目录结构(代码现状)

```
cmd/server/            # 服务端入口(--bootstrap-admin 等)
internal/              # serverauth/llmgateway/marketplace/knowledge/serverstore/util/bootstrap
webadmin/              # 管理端(Vite React + shadcn,dist 内嵌进服务端二进制)
docs/superpowers/      # 架构设计 + 实施计划(权威文档)
scripts/               # install-server.sh(oh-my-zsh 式一键部署)+ deploy.sh(容器化部署生命周期)+ mock-upstream.go(假上游)
data/                  # 服务端运行时数据(0700,gitignore)
```

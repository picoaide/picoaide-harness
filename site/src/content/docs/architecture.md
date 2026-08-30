---
title: 系统架构
description: PicoAide Harness 的系统架构：客户端与服务端分层、LLM 网关与计量计费、配额体系与安全设计。
---

PicoAide Harness 是一个「桌面客户端 + 企业服务端」的一体化平台。本页是面向管理员与集成方的架构总览；完整 API 端点见 [API 参考](./api-reference)，公开接口以实际代码为准。

## 总体形态

```
员工客户端 / 第三方接入 ──HTTPS + Bearer token──▶
┌────────────────────────────────────────────────────────────┐
│ Go 服务端（gin + PostgreSQL）                          │
│   ├─ 认证：local / LDAP / OIDC + api_tokens（90 天哈希存储）│
│   ├─ AI 网关：/v1/* 代理 + per-user 限流 + 用量计量（费用/峰谷）│
│   ├─ 启动配置：/api/client/v2/config/bootstrap             │
│   ├─ 商城与共享：技能商城 / 共享技能 / 共享 Agent（授权制·双门制）│
│   └─ 管理端 webadmin（go:embed 内嵌，/admin/）              │
└────────────────────────────────────────────────────────────┘
```

- **服务端**是唯一控制面：上游密钥（AES-GCM 加密）、模型价格、配额、授权、审批全部集中在服务端；
- **桌面客户端**负责体验（对话、能力中心、连接器、定时任务、浏览器），经 `/api/client/v2/*` 与 `/v1/*` 接入；
- **管理后台**（webadmin）覆盖用户、部门、网关、用量、市场、能力中心、品牌与门户——员工接触不到它。

## 数据流

1. **登录**：`POST /api/client/v2/auth/login` → Bearer token（90 天）；`GET /api/client/v2/config/bootstrap` 拉默认模型、建议清单与连接器目录。
2. **LLM 调用**：`POST /v1/chat/completions`（stream 可选）→ 服务端限流 → 配额检查（token / 金额 / 部门预算，任一超限 429 `QUOTA_EXCEEDED`）→ 按模型匹配上游 provider 代理 → 计量写入 usage（含费用，记录时按定价 × 峰谷折算）。
3. **管理配置**：管理员登录 `/admin/` → 用户/部门/网关/模型价格/峰谷窗口/配额/预算/商城/共享审批（全部经 `/api/server/admin/*`，session + CSRF + RBAC，审计落 audit_logs）。

## 计量计费与配额

- **费用**：`usage.cost` = 输入 × input_price/1e6 + 输出 × output_price/1e6（缓存命中另按 `cache_input_price_per_1m`）；高峰窗口（北京时间，可配）外 × 模型 `offpeak_discount`。改价/改窗口只影响之后产生的费用（记录时定价）。
- **配额链**（任一超限即 429，admin 豁免）：
  1. 员工 token 配额（`quota_tokens`：NULL = 跟随全局默认，0 = 不限）；
  2. 员工金额配额（`quota_money`）；
  3. 部门预算（`budget_money`，归属部门 + 祖先链全部生效，树内 SUM(cost)）。
- **员工自查询**：`GET /api/client/v2/auth/usage` 返回余额（配额 − 本月已用，不限 = null）与今日/昨日/本月/累计 tokens + 费用、部门预算链。

## 安全设计

- 上游密钥 AES-GCM（`enc:v1:`，master key 文件），永不落明文；API token 只存哈希；
- **严格默认拒绝**：市场与共享内容未授权一律 404（不泄露存在性）；授权对象 = 用户或部门组（大小写不敏感），admin 恒全量不落表；授权变更审计；
- 改密 / 降权 / 禁用自动吊销全部 API token（与用户更新同事务）；
- 管理端 session 12h（硬上限 + 60min 空闲滑动过期）+ CSRF；登录限流（双桶：IP 与账号，10 次/5 分钟）；
- 错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`；健康探针 `/healthz`；
- 接入方 TLS：登录页/客户端拒绝非 HTTPS 远程地址（TOFU 由接入方实现）。

## 数据库

- PostgreSQL（PG-only，内置容器或外部实例），迁移 `migrations-pg/` 0001–0048；
- usage 明细按月原生分区（保留 N 月可配，默认 6），日/月账本永久保留（历史统计 10 年不丢）；
- 共享技能 / Agent 归档直存 DB；品牌快照、审计哈希链（防篡改）、RBAC 角色。

## 深入阅读

- [API 参考](./api-reference) — 全部 HTTP 端点
- [私有化部署](./deployment) — 容器化部署、备份恢复、离线安装
- [管理后台](./admin) — webadmin 操作指南

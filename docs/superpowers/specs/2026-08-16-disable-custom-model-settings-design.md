# 企业版禁用模型自定义设置页（模型仅由登录下发）

日期：2026-08-16
分支：feat/enterprise

## 背景与目标

企业版要求模型配置不可由用户自定义，模型必须通过登录从服务端获取。

现状缺口：上游 `@deepseek-ai/dsh-client-ui-settings-models` 在设置页注册「模型」入口
（`settings.section` slot，order 10），用户可添加自定义 provider/模型；而登录后
`packages/host/enterprise/src/bootstrap.ts` 已把网关 `/api/config/bootstrap` 下发的模型
catalog 同步进 `llm-deepseek` 设置（models 列表 + `agent-default-model`），登出时清空。

目标：模型设置入口完全消失；模型仅来自登录后的网关下发。模型下发闭环已存在，本次
不改动。

## 方案

组合层禁用：在 `packages/host/enterprise/cordis.patch.yml` 追加一条 patch，按 id 定位
上游 web-app bundle 的 `ui-settings-models` 行并置 `disabled: true`。

- 企业 patch 由 `prepareDesktopProfile`（dsh-plugin-desktop/src/profile.ts）在 web-app
  bundle patch 之后应用，同层单遍 patch 算法按 id 索引，可命中上游行。
- `disabled` 行不进 Loader entry 图，其 client bundle 不进 client-modules 组合图，
  设置页入口消失。
- 备选「client 插件层隐藏」不可行：slots API 只有 register/inject，无移除他人 entry
  的接口；改上游扩展点违反只改自己插件的约束。故组合层禁用是唯一插件内路径。

## 改动清单

### packages/host/enterprise/cordis.patch.yml（功能改动）

追加：

```yaml
# Enterprise model governance: models come from the gateway after login only.
# The upstream models settings page lets users define custom providers, so it
# is disabled from the composition. bootstrap.ts keeps the gateway catalog in
# llm-deepseek and clears it on logout.
- id: ui-settings-models
  disabled: true
```

### dsh-plugin-desktop/scripts/verify-profile-boot.mjs（测试适配）

advanced 组合图断言中追加否定断言：`@deepseek-ai/dsh-client-ui-settings-models` 不得
出现在 `__DSH_BOOT__` 的 entry ids 中。

## 数据流（不变，仅记录闭环）

1. 登录成功 → `picoSession` 事件 → `bootstrap.ts` 拉取
   `GET /api/config/bootstrap`（Bearer token）。
2. `settings.update(llm-deepseek, { models: catalog.map(id+name) })` +
   `settings.replace(agent-default-model, { provider: 'deepseek-official', model: default })`。
3. 登出 → 两个 namespace 均清空。base bundle 仅 `llm-deepseek` 一个 provider，
   无其他模型来源。

## 错误处理

- 登录后 bootstrap 拉取失败：现有行为不变（记日志，模型列表为空直到下次事件）。
- 设置页禁用后无新增失败路径（组合层静态决定）。

## 验证

1. `yarn workspace @picoaide/dsh-enterprise check`（build + typecheck + 单测）。
2. `yarn workspace dsh-plugin-desktop run verify:profile`（含新增否定断言）。
3. `yarn workspace dsh-plugin-desktop run verify:loader`。
4. 完整 `yarn check`。
5. xvfb 实测：登录前主窗口为登录页；登录后设置页无「模型」入口；模型选择器
   仅列出网关下发的模型。

## 范围外

- 不修改 `deepseek-harness/`、`server/` 及任何其他服务包。
- 不改 bootstrap/网关模型下发逻辑。

---
title: PicoAide Harness 2.3.0 发布
description: 能力中心归一（市场/组织合并）、CLI 工具化整体移除（技能 + MCP 双标准形态）、纯 MCP 连接器、git tag 权威版本源与 Docker 镜像自动发布。
pubDate: 2026-08-26
version: 2.3.0
author: PicoAide Team
tags:
  - 发布
  - 产品
  - 架构
---

PicoAide Harness 2.3.0 正式发布。本版本完成了一次重要的**产品形态收敛**：能力分发统一为「技能商店 + MCP 连接器」两种标准形态，所有入口归一为「能力中心」。

## 能力中心归一：市场 / 组织合并

- 客户端侧边栏统一为**单一「能力中心」入口**（Capability Hub），替代早期「技能商城」「共享技能库」「共享 Agent」三个平行面板；
- 信息架构收敛为两个正交维度：**内容类型**（技能 / 智能体）× **来源**（市场 / 组织 / 本地）——顶部 Tab 只有「我的 / 市场」，来源与状态以徽章表达；
- 服务端 `/api/capabilities` 聚合面：市场（授权制）与组织（审核 + 授权双门制）同名内容合并为一条权威行，**跨源同名冲突强制阻断（409）**；
- 管理后台新增**能力中心统一审批队列**：共享技能与共享智能体同屏审核，支持官方 / 精选质量标记（`quality`，仅 approved 可设）；
- 客户端修复来源切换、搜索、跨源归并三处 UI 缺陷，多版本归并与历史展开。

## CLI 工具化整体移除：技能 + MCP 双标准形态

- 早期「CLI 即 skill」方案（自动安装 dws / wecom-cli / lark-cli / beisen-cli 等命令行工具）**整体移除**——CLI 直接 spawn 存在跨平台分发、安全与运维复杂度问题；
- **最终架构定案**：厂商 CLI 能力改由**技能商店以 SKILL.md 分发**（上传 → 审批 → 授权 → 员工安装），模型读 skill 按引导操作；MCP 能力统一走连接器框架；
- 连接器同步收敛为**纯 MCP 连接器**：删除 urlCommand 与 CLI 连接器，只保留 OAuth / streamable-http 形态（当前内置**销售易 NeoCRM** 与 **Moka HR 智能体**）；
- dws 凭证落盘统一指向产品 DSH HOME。

## 发布链路加固

- **版本号统一 git tag 权威源**：新增 `scripts/version.mjs`（set/check/get），git tag 为唯一真值，一键同步 root 与 desktop 两处 package.json（semver 白名单 + 形状校验）；
- **Docker 镜像自动构建发布**：推送 `v*` tag 后 CI 自动构建推送 `ghcr.io/picoaide/picoaide-server`（amd64 + arm64 多平台，SBOM / provenance），标签 `latest` + `vX.Y.Z` + `vX.Y`，构建参数注入版本并做实机验证（`--version` + `/healthz` + multi-arch manifest）。

## 其他

- 能力中心 Tab 与筛选激活态样式修复（非激活不再显示边框/下划线）；
- 兼容性测试与类型断言同步 v2.3.0；
- 完整门禁（build / typecheck / 全部测试）通过。

完整变更请查看 [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases)。

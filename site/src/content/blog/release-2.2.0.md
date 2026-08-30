---
title: PicoAide Harness 2.2.0 发布
description: 新增 PostgreSQL 存储支持与共享技能/Agent 预设库，能力中心聚合展示，企业版功能增强。
pubDate: 2026-08-25
version: 2.2.0
author: PicoAide Team
tags:
  - 发布
  - 产品
---

> 注：本发布说明为历史快照，SQLite 双后端与迁移工具已于 2026-08 随 PG-only 迁移下线。

PicoAide Harness 2.2.0 正式发布。本版本带来以下变化：

## PostgreSQL 存储支持

服务端存储新增 PostgreSQL 双驱动支持（`-db-driver` 切换），提供 SQLite → PostgreSQL 数据迁移工具，满足企业内网对集中化数据库部署的要求；同时新增 Docker 化 PostgreSQL 部署方案（compose 私有网段 + Caddy 双证书）。

## 共享技能库与共享 Agent 预设

服务端新增共享技能库与共享 Agent 预设存储，支持多版本管理与审批流（`pending → approved | rejected`）。客户端能力中心支持本地技能上传、共享库浏览与审批状态展示，Web 管理后台新增共享技能/Agent 审批页面与授权弹窗，实现全员共享的协作闭环。

## 能力中心聚合面板

客户端新增能力中心聚合面，统一展示技能、连接器、Agent 预设等能力，带质量标记与统一审批入口；组织分区仅展示 approved 状态，历史版本与 installedVersion 状态更可靠。

## 企业版功能增强

- 客户端 Agent 预设分享面板：本地预设行展示、两文件打包上传、完整目录打包修复
- 预设安装强制路径穿越防护（真实遍历拒绝 + 测试覆盖）
- asar 打包后的子进程 spawn 与 asar 链接读取修复（打包沙箱内路径重写）

## 安全审计与修复

- 多智能体审计修复：越权、数据丢失、多版本断链、部署安全
- collectBody 超限不再 destroy socket（413 响应可送达）
- 认证配置审计修复 + LDAP/OIDC 安全增强
- 明示 Windows/Linux 未签名并给出 SHA-256 校验指引（双语 README）

## 性能与体验

- Web 管理后台全站加载优化：路由懒加载、VChart 按需、字体自托管、缓存头
- Web 管理后台按设计系统重构全局 UI（数据面板风）
- 服务端模型缓存命中计费（DeepSeek 缓存价）、高峰时段分级计价

## 其他改进

- 上游 DeepSeek Harness 固定版本升级至 0.1.1-rc.2
- 全新官网/博客/Wiki 一体站（Astro + Starlight，Cloudflare Pages 直连部署）
- CI 修复：macOS 临时目录误拒、Windows 打包构建顺序、cache:yarn 顺序问题

完整变更请查看 [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases)。

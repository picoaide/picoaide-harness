---
title: PicoAide Harness 2.1.0 发布
description: 桌面客户端升级源切换至 GitHub Releases，新增 Linux 支持与自动化发布流水线。
pubDate: 2026-08-23
version: 2.1.0
author: PicoAide Team
tags:
  - 发布
  - 产品
---

> 注：本发布说明为历史快照。文中「客户端升级源 = GitHub Releases」的链路已于 2026-09 被替换 ——
> 客户端现在只从**它登录的那台服务端**取更新。当前交付方式见[交付方式说明](/blog/delivery-model/)。

PicoAide Harness 2.1.0 正式发布。本版本带来以下变化：

## 升级源切换至 GitHub Releases

桌面客户端的自动升级检查改从 GitHub Releases 获取最新版本，安装包下载附带 SHA-256 完整性校验，升级链路更透明、可审计。

## 新增 Linux 支持

除 Windows 与 macOS 外，新增 Linux x64 安装包（AppImage 与 deb），覆盖更多企业内网环境。

## 自动化发布流水线

推送版本 tag 后，CI 自动构建三平台安装包并发布 GitHub Release（含 SHA256SUMS.txt 摘要），无需人工上传。

## 修复与改进

- macOS universal 打包的 CLI 二进制豁免，解决跨架构合并报错
- 桌面端 smoke 验证器从配置读取真实产品名
- 多用户会话隔离、连接器安全加固等持续改进

完整变更请查看 [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases)。

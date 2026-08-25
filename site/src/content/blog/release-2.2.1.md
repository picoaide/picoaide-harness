---
title: PicoAide Harness 2.2.1 发布
description: 修复升级下载静默失败，新增会话右上角升级提示徽章。
pubDate: 2026-08-25
version: 2.2.1
author: PicoAide Team
tags:
  - 发布
  - 产品
---

PicoAide Harness 2.2.1 正式发布。本版本带来以下变化：

## 修复升级下载静默失败

2.2.0 版本的 SHA256SUMS.txt 清单条目带 `./` 前缀，客户端升级校验时 `checksum-missing` 导致"提示升级但下载不执行"。本版本修复请求解析（兼容 `./` 前缀），并重新发布校验清单；同时修复确认下载后二次检查失败导致的静默无下载——现在网络波动时仍使用已确认版本继续下载。

## 会话右上角升级提示徽章

桌面窗口会话头部右上角新增升级提示徽章：有新版本时显示蓝色圆点与版本号，点击即可触发下载；下载中显示进度动画。界面内升级状态与系统托盘菜单同步。

## 其他

- 升级状态桥与手动检查触发路由（同源校验）
- 完整门禁（build / typecheck / 全部测试）通过

完整变更请查看 [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases)。

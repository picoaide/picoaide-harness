---
title: 快速开始
description: 10 分钟上手 PicoAide Harness：下载、首次启动、登录与四个核心入口。
---

## 安装客户端

从 [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases/latest) 下载对应平台安装包：

| 平台 | 安装方式 |
|---|---|
| Windows x64 | 运行 NSIS 安装程序（`PicoAide-Harness-<v>-x64-Setup.exe`） |
| macOS（Apple 芯片） | 打开 DMG，把 PicoAide Harness 拖入 Applications |
| Linux x64 | 授予执行权限后运行 AppImage（`-x86_64.AppImage`）；也提供 deb |

> **安装前建议校验**：每个 Release 附带 `SHA256SUMS.txt`。Windows/Linux 安装包由 CI 自动发布、**暂未签名**，SmartScreen 可能提示「未知发布者」——请先在 Releases 下载并核对 SHA-256 摘要后再运行。

## 首次启动

- 首次启动会创建默认 `desktop` profile，并在本机启动官方 DSH Web 界面；
- 安装包已经包含 Electron、Node.js、pnpm 与固定版本 DSH 依赖——**不需要**另行安装 Node.js、pnpm 或 DSH；
- 关闭窗口默认隐藏到托盘；从托盘选择**退出**才会结束应用与本地服务。

## 登录

- **企业版（服务端模式）**：填写服务端地址、账号密码登录；账号由管理员在管理后台创建（local / LDAP / OIDC），配额与额度由服务端决定；
- **单机模式**：无需登录即可使用本地模型与能力；
- 退出登录即解除全部会话（连接器、浏览器、定时任务令牌）。

## 开始使用：四个核心入口

1. **新会话**：选择工作区（项目目录）开始对话；模型可调用的工具按权限门控审批；
2. **能力中心**：安装市场技能/智能体（需管理员授权）、查看「我的」本地创作与上传审核状态；
3. **定时任务**：把高频工作交给 Agent 到点自动执行（cron + 提示词 + 工作区 + 权限），执行详情随时可查；
4. **连接器 / 浏览器**：OAuth 授权连接销售易、Moka 等 MCP 服务；让 Agent 接管浏览器执行操作。

## 下一步

- 想理解产品设计理念，读[产品哲学](./philosophy)；
- 想深入每个界面，读[桌面客户端](./desktop)；
- 企业管理员请读[管理后台](./admin)与[私有化部署](./deployment)。

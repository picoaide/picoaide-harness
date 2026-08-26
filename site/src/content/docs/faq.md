---
title: 常见问题
description: PicoAide Harness 常见问题：与 DeepSeek Harness 的关系、数据位置、CLI 架构演进、签名与升级安全等。
---

## PicoAide Harness 与 DeepSeek Harness 是什么关系？

PicoAide Harness 基于固定版本的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（当前 pin `0.1.1-rc.2`）构建。上游提供核心智能体、插件系统与 Web UI；本项目提供桌面封装、本地服务管理与企业级后台。**上游源码原样运行，不魔改**——升级只跟随版本号，不破坏本地扩展。

## 这是 DeepSeek 官方产品吗？

不是。PicoAide Harness 是独立的开源社区项目（MIT License），与 DeepSeek 官方没有隶属关系，也未获得其背书。DeepSeek 是 DeepSeek AI 的商标。

## 数据保存在哪里？

默认全部在本机：所有 profile、会话、设置、连接器凭据统一落在 `~/.picoaide-harness`（`DSH_HOME` 环境变量优先）。凭据以 0600/0700 权限原子写入，防符号链接与路径逃逸。**是否向外部发送内容取决于你配置的模型或工具提供商**——使用云端模型时，相应请求仍会发给该提供商。

## 需要安装 Node.js、pnpm 或 DSH 吗？

不需要。安装包已包含 Electron、Node.js、pnpm 与固定版本 DSH 依赖。普通用户下载安装后即可启动；应用不会修改系统全局 PATH 或 shell 配置（终端内的 `dsh`/`pnpm`/`node` 是私有 shim，只作用于该终端进程）。

## 支持哪些操作系统？

Windows x64、macOS（Apple 芯片，Universal DMG）、Linux x64（AppImage + deb）。当前不支持 Intel Mac 的正式安装包。

## 安装包为什么没签名？

CI 自动发布的 Windows 安装程序与 Linux 安装包**暂未签名**（macOS 正式发布版已签名/公证）。Windows SmartScreen 可能提示「未知发布者」——请先在 Releases 下载 `SHA256SUMS.txt` 核对后再运行；Linux 同理。

## 应用如何更新？

后台检查 GitHub Releases（`releases/latest`），发现新版本先征得确认才下载；下载安装包并核对 **SHA-256 摘要**（兼容 `./` 前缀），校验失败不安装。下载/安装失败不破坏当前版本。会话头部右上角有升级徽章，托盘菜单同步升级状态。

## 连接器为什么只有两家？

产品遵循「技能 + MCP」两种标准形态（2026-08-26 最终架构）：**CLI 厂商能力改由技能商店以 SKILL.md 分发，MCP 能力统一走连接器框架**。早期 CLI 连接器（钉钉/飞书/企业微信/北森等厂商 CLI）已整体移除；当前内置 MCP 连接器为**销售易 NeoCRM** 与 **Moka HR 智能体**，连接器定义可扩展，第三方可注册自己的 MCP def。

## CLI 工具化为什么没了？

CLI 直接 spawn 的「CLI 即 skill」方案（自动安装 dws/wecom-cli 等命令）存在跨平台分发、安全与运维复杂度问题。改为：厂商能力以 **SKILL.md 上传到技能商店 → 审批 → 授权** 分发，模型读 skill 按引导操作；MCP 类能力走连接器。两种标准形态可审计、可审批、可卸载。

## 任务看板去哪了？

任务看板与定时任务语义重叠，已于 **v2.3.0 并入定时任务**（dsh-task 插件整体删除）。现在定时任务中心统一承载：cron 表达式 + 提示词 + 工作区 + 智能体预设 + 权限，执行详情（会话/结果/错误）随时可查，支持手动立即执行与会话跳转。

## 可以安装 DSH 插件吗？

可以。从托盘打开 DSH Terminal，运行 `dsh plugin add <plugin>` / `remove` / `update`，默认作用于当前激活 profile，`--profile <name>` 显式指定；插件变更后需重启应用。

## Desktop profile 和已有 web profile 会自动同步吗？

不会自动复制插件。每个 profile 有自己的 bundle 与依赖组合；切换 profile 后终端默认命令作用于当前 profile。

## 在哪里下载和报告问题？

从 [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases/latest) 下载安装包。遇到问题先看[桌面客户端](./desktop)的排查部分，仍无法解决再提交 [GitHub Issue](https://github.com/picoaide/picoaide-harness/issues)，并附上操作系统、应用版本、复现步骤与错误信息。

---
title: 常见问题
description: PicoAide Harness 常见问题：与 DeepSeek Harness 的关系、数据位置、CLI 架构演进、签名与升级安全等。
---

## PicoAide Harness 与 DeepSeek Harness 是什么关系？

PicoAide Harness 基于固定版本的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（当前 pin `0.1.2-rc.1`）构建。上游提供核心智能体、插件系统与 Web UI；本项目提供桌面封装、本地服务管理与企业级后台。**上游源码原样运行，不魔改**——升级只跟随版本号，不破坏本地扩展。

## 这是 DeepSeek 官方产品吗？

不是。PicoAide Harness 是独立的开源社区项目（MIT License），与 DeepSeek 官方没有隶属关系，也未获得其背书。DeepSeek 是 DeepSeek AI 的商标。

## 数据保存在哪里？

默认全部在本机：所有 profile、会话、设置、连接器凭据统一落在 `~/.picoaide-harness`（`DSH_HOME` 环境变量优先）。凭据以 0600/0700 权限原子写入，防符号链接与路径逃逸。**是否向外部发送内容取决于你配置的模型或工具提供商**——使用云端模型时，相应请求仍会发给该提供商。

## 需要安装 Node.js、pnpm 或 DSH 吗？

不需要。安装包已包含 Electron、Node.js、pnpm 与固定版本 DSH 依赖。普通用户下载安装后即可启动；应用不会修改系统全局 PATH 或 shell 配置。

## 首次启动需要下载运行环境吗？

不需要另行下载 Node.js 或 Harness 核心。安装包较大，是因为运行时和固定版本依赖已经包含在内，以换取更确定的首次启动和版本组合。使用云端模型、检查更新或下载新版本时仍然需要网络。

## 支持哪些操作系统？

Windows x64（NSIS 安装程序）、macOS（Apple 芯片 / arm64，DMG）、Linux x64（AppImage）。
企业交付面不含 Linux deb（deb 只在本地构建时产出）。

## 安装包为什么没签名？

Windows 安装程序与 Linux AppImage **暂未签名**（macOS 正式发布版已签名 + 公证）。
Windows SmartScreen 可能提示「未知发布者」——向管理员索取安装包时一并核对 SHA-256 摘要后再运行。

## 应用如何更新？

**升级源是客户端登录的那台服务端**（`GET /api/client/v2/updates/manifest`）：启动 60 秒后首次检查、
之后每 6 小时一次，托盘与「设置 → 关于」可手动检查。清单里的 SHA-256 会在下载时流式校验，
校验失败不安装；下载/安装失败不破坏当前版本。**因此客户端升级的正确做法是升级服务端**——
服务端升级后客户端包自动跟着换新，员工端无需操作。未连接服务端时客户端不做任何外发更新检查。

升级方式：Windows 走安装程序，macOS 打开 DMG 覆盖安装，Linux AppImage 下载完成后由用户替换当前文件
（AppImage 无静默自安装）。

## 连接器为什么只有两家？

产品遵循「技能 + MCP」两种标准形态（2026-08-26 最终架构）：**CLI 厂商能力改由技能商店以 SKILL.md 分发，MCP 能力统一走连接器框架**。早期 CLI 连接器（钉钉/飞书/企业微信/北森等厂商 CLI）已整体移除；当前内置 MCP 连接器为**销售易 NeoCRM** 与 **Moka HR 智能体**，连接器定义可扩展，第三方可注册自己的 MCP def。

## CLI 工具化为什么没了？

CLI 直接 spawn 的「CLI 即 skill」方案（自动安装 dws/wecom-cli 等命令）存在跨平台分发、安全与运维复杂度问题。改为：厂商能力以 **SKILL.md 上传到技能商店 → 审批 → 授权** 分发，模型读 skill 按引导操作；MCP 类能力走连接器。两种标准形态可审计、可审批、可卸载。

## 任务看板去哪了？

任务看板与定时任务语义重叠，已于 **v2.3.0 并入定时任务**（dsh-task 插件整体删除）。现在定时任务中心统一承载：cron 表达式 + 提示词 + 工作区 + 智能体预设 + 权限，执行详情（会话/结果/错误）随时可查，支持手动立即执行与会话跳转。

## 可以安装 DSH 插件吗？

可以。从系统 shell 运行 `dsh plugin --profile desktop add <plugin>` / `remove` / `update`（应用固定运行 desktop profile，没有终端/Profile 切换的托盘入口），`--profile <name>` 显式指定；插件变更后需重启应用。

## Desktop profile 和已有 web profile 会自动同步吗？

应用固定运行 `desktop` profile；没有 `web` profile 默认项，也没有切换入口。

## 在哪里下载和报告问题？

客户端安装包**随服务端镜像发布**，不单独挂在下载站：

- 企业员工：从企业服务器的门户页下载（`https://<企业域名>/`），或直接向管理员索取；
- 想先试用：取官方镜像包后导出 `client/` 目录即可获得三平台安装包，步骤见[快速开始](/getting-started/)。

服务端部署与升级方式见[私有化部署](/deployment/)。遇到问题先看[桌面客户端](/desktop/)的排查部分，
仍无法解决再提交 [GitHub Issue](https://github.com/picoaide/picoaide-harness/issues)，
并附上操作系统、应用版本、复现步骤与错误信息。

# PicoAide Harness 常见问题

[English](faq.en.md)

本页回答当前正式版本最常见的安装、平台、运行环境和插件问题。功能范围以[最新 GitHub Release](https://github.com/picoaide/picoaide-harness/releases/latest)和[用户指南](user-guide.md)为准。

## PicoAide Harness 是什么？

PicoAide Harness 是面向 Windows、macOS 和 Linux 的开源 DeepSeek Harness 桌面客户端。它把官方 Harness 的本地 Web UI、Host 服务和插件系统装进原生桌面应用，并提供窗口、系统托盘、更新和企业级管理能力。

## 这是 DeepSeek 官方产品吗？

不是。PicoAide Harness 是社区维护的独立开源项目，不隶属于 DeepSeek，也未获得 DeepSeek 官方背书。项目名称仅用于说明它与官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的技术关系。

## 支持哪些操作系统？

当前正式安装包支持 Windows x64、macOS（universal DMG，Apple Silicon 与 Intel）和 Linux x64（AppImage + deb）。桌面壳固定高级显示呈现；Linux 使用标准系统窗口边框（无 Mica/hidden-inset 等平台原生材质），但界面布局与 macOS/Windows 一致。

## 需要安装 Node.js、pnpm 或 DSH 吗？

不需要。安装包已经包含 Electron、Node.js、pnpm 和固定版本的 DSH 依赖。普通用户下载安装后即可启动，PicoAide Harness 也不会修改系统全局 PATH 或用户的 shell 配置。

## 首次启动需要下载运行环境吗？

不需要另行下载 Node.js 或 Harness 核心。安装包较大，是因为运行时和固定版本依赖已经包含在内，以换取更确定的首次启动和版本组合。使用云端模型、检查更新或下载新版本时仍然需要网络。

## PicoAide Harness 会修改官方 Harness 吗？

不会。仓库固定一个未修改的官方 Harness 上游版本。桌面壳通过 PicoAide Harness 自有插件增加桌面布局和原生窗口效果（固定高级模式），不直接修改上游源码。

## 数据是否保存在本地？

Desktop Host、profile 和 DSH home 位于本机。是否向外部服务发送内容取决于用户配置的模型或工具提供商；使用云端模型时，相应请求仍会发送给该提供商。

## 可以安装 DSH 插件吗？

可以。PicoAide Harness 使用官方 Harness 插件体系。从系统 shell 运行 `dsh plugin --profile desktop add`、`remove` 和 `update`（应用固定运行 `desktop` profile）；插件变更后需要重启 Desktop。

## Desktop profile 和已有 web profile 会自动同步吗？

不会。应用固定运行一个 `desktop` profile，没有 `web` 默认项，也没有 profile 切换入口。每个 profile 都有自己的 bundle 和依赖组合；使用 `dsh plugin --profile <name>` 可显式指定其他 profile。

## 应用如何更新？

打包后的应用会在后台检查稳定版本，但不会静默安装。发现新版本后先征得用户确认；macOS 下载并打开 DMG，Windows 下载并启动 NSIS 安装程序（Linux 不下载安装包，AppImage/deb 从发布页获取）。网络或下载失败不会破坏当前安装。

## 在哪里下载和报告问题？

从[最新 GitHub Release](https://github.com/picoaide/picoaide-harness/releases/latest)下载安装包。遇到问题时先查看[用户指南的排查部分](user-guide.md#排查)，仍无法解决再提交 [GitHub Issue](https://github.com/picoaide/picoaide-harness/issues/new/choose)，并附上操作系统、应用版本、复现步骤和错误信息。

<h1 align="center">DeepSeek Harness Desktop</h1>

<p align="center">
  <a href="https://github.com/anywhere-labs/deepseek-harness-desktop"><img src="https://img.shields.io/github/stars/anywhere-labs/deepseek-harness-desktop?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/Desktop-App-47848F?style=flat" alt="Desktop application">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <a href="https://discord.gg/TJeGqKRNM"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&amp;logo=discord&amp;logoColor=white" alt="Join Discord"></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Supported platforms: macOS and Windows">
</p>

<p align="center"><sub>中文 · <a href="README.en.md">English</a></sub></p>

<h3 align="center">为DeepSeek Harness生态打造的现代化桌面端体验（<a href="#插件生态">插件</a>）</h3>

<h4 align="center">
  DeepSeek Harness 官方目前通过命令行启动本地 Web UI。本项目将服务启动、运行管理和桌面窗口整合为开箱即用的桌面体验，让用户无需配置 Node.js 或执行命令，即可直接使用。
</h4>

<a id="run"></a>

<h3 align="center"><a href="https://www.deepseekdesktop.com"><ins>Download Desktop</ins></a></h3>

<p align="center">
  <img src="assets/desktop-preview.png" alt="DeepSeek Harness Desktop 界面预览" width="100%">
</p>

## 主要功能

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Desktop</h3>
      <p>把官方 DeepSeek Harness 的本地 Web UI 带到原生桌面。应用自动启动和管理本地 Harness 服务，集成系统托盘与桌面窗口，无需安装 Node.js 或执行命令。</p>
    </td>
    <td width="50%" valign="top">
      <h3>手机远程控制 <img src="https://img.shields.io/badge/%E5%8D%B3%E5%B0%86%E6%8E%A8%E5%87%BA-F59E0B?style=flat-square" alt="即将推出"></h3>
      <p>通过 iOS 和 Android 远程连接 Desktop，在手机上发起任务、查看 Agent 进度，并在需要时继续跟进。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>插件市场 <img src="https://img.shields.io/badge/%E5%8D%B3%E5%B0%86%E6%8E%A8%E5%87%BA-F59E0B?style=flat-square" alt="即将推出"></h3>
      <p>Harness 遵循“一切皆插件”的架构。桌面端插件市场将提供插件的发现、安装、更新和管理，让模型、工具、界面与工作流能力按需组合。</p>
    </td>
    <td width="50%" valign="top">
      <h3>Channels <img src="https://img.shields.io/badge/%E5%8D%B3%E5%B0%86%E6%8E%A8%E5%87%BA-F59E0B?style=flat-square" alt="即将推出"></h3>
      <p>接入微信、飞书、Discord、WhatsApp 等 IM 通道，直接在日常聊天工具中向 Agent 发起任务、接收进度并继续对话。</p>
    </td>
  </tr>
</table>

## 插件生态

DeepSeek Harness 基于 [Cordis](https://github.com/cordiverse/cordis) 构建，并采用“一切皆插件”的架构。模型适配器、工具注册表、会话日志和 Agent Loop 等核心能力都以插件参与运行，可以通过配置自由组合或替换；外部插件也可以通过 profile 与 bundle 接入现有运行时。详见官方的[架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)和[插件管理文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md#plugin-management)。

我们希望 Desktop 不只是一个独立的桌面封装，而是 DeepSeek Harness 插件生态中的桌面入口。后续计划将桌面能力按官方插件机制重新组织，让服务管理、系统集成和插件市场可以沿用 Harness 的组合方式接入。

> **即将推出：** Desktop 目前还不是以 DeepSeek Harness 插件形式交付，上述插件化能力仍在开发中。

## 与官方项目的关系

本项目基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 构建。

DeepSeek Harness 的核心能力、插件系统和 Web UI 来自官方项目。本项目主要负责：

- 桌面应用封装
- 本地服务生命周期管理
- 桌面窗口和系统托盘集成
- macOS、Windows 安装包构建与发布
- 桌面环境下的界面适配

如果你希望通过命令行运行 Harness，或者参与核心功能开发，请优先查看官方仓库。

<a id="run-from-source"></a>

## 开发

桌面端代码位于：

```text
apps/desktop
```

安装依赖并启动桌面应用：

```sh
pnpm install
pnpm run dev:desktop
```

## 社区交流

可选择常用的平台参与讨论，交流使用问题、插件开发和项目进展。

<table>
  <thead>
    <tr>
      <th align="center">微信群</th>
      <th align="center">QQ群</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wechat-group.png" alt="DeepSeek Harness Desktop 微信群二维码" width="180" height="180"></td>
      <td align="center"><img src="assets/community-qq-group.jpg" alt="DeepSeek Harness Desktop QQ群二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

Discord：[加入 DeepSeek Harness Desktop 社区](https://discord.gg/TJeGqKRNM)

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区桌面版本，并非 DeepSeek 官方产品。

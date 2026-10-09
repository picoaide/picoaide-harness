---
title: 插件生态
description: 上游生态与本项目的关系、随包分发的插件清单、四条扩展路径的对比与选择，以及插件解决不了什么。
---

PicoAide Harness 的插件生态不是一个市场，而是**一套组合约定 + 一份随包分发的清单**：上游提供框架与模块表，本项目把产品能力作为插件组合进去，第三方作者走同一条路径。这一页回答三个问题：现在到底装了哪些插件、要加一个能力该走四条路径里的哪条、哪些事插件做不到。

## 官方上游与本项目的关系

上游是 DeepSeek Harness（`deepseek-ai/deepseek-harness`），本项目以**固定版本原样运行**它：当前 pin `dsh-v0.2.0-rc.2`，真源是仓库根的 `upstream.json`。两边分工清楚：

| | 上游 | 本项目 |
|---|---|---|
| 提供什么 | Cordis 插件框架、agent/会话/工具/沙箱等核心能力、Web UI、`@deepseek-ai/dsh-*` 包族与官方 bundle（`dsh-base`、`dsh-web-app` 与各预设）、给 agent 用的插件创作技能 | 桌面壳与三平台客户端、企业服务端（认证/网关/计量/能力中心/审计）、渠道白标、十层自有组装补丁与少量带判据的上游补丁 |
| 怎么装插件 | Loader 组合：bundle 层 → profile 层 → 用户层 → overlay；包从 npm 装进 profile | 同一套 Loader 语义；额外固定一个 `desktop` profile，并向裸 Electron 能力收窄接口 |
| 生态形态 | **不提供插件市场**；安装路径是"把能力打成 bundle，用包管理器装进 profile" | 不建市场。第三方插件两条路：用户补丁层（重启生效）或随包分发（见[插件开发](/plugin-development/)） |

三件必须知道的事：

- **上游升级是外部依赖变更，不是内部重构**。每次升级都会带来新的行与新默认值（例如新的可选 bundle、新的遥测行、新的鉴权适配器行），本项目逐行处置：启用、禁用、接管，并把理由写在 `packages/host/desktop/cordis.patch.yml` 同一行旁边。判定"这行该不该开"的依据是产品口径（会话正文是否出境、是否与自研面板冲突、是否有平台原生依赖），不是"上游默认开就跟着开"。
- **上游发的是接口，不是承诺**。行 id、Config 默认值、客户端 CSS 类名、可选 bundle 的内部组成都会变；插件作者与维护者都要按"契约"而不是"实现"来依赖。
- **社区互操作标准化还在草案阶段**。本仓 `community/fabric/` 是 DSH 社区互操作 RFC 的**文档**（Manifest、Capability、Host Descriptor、事件）：没有运行时、没有已发布的 schema、没有安装器，工作插件仍使用现有 DSH/Cordis 接口。它明确一条安全边界——**同一进程里的 JavaScript 不能被伪装成安全沙箱**；只有具备真实隔离证据的宿主才能声称权限被技术强制执行。

## 生态靠什么规则运转

三条规则同时是对插件作者的要求，也是本项目自己遵守的规则：

1. **组合优先**：通过官方的 bundle 层、service、slot 与 patch 组合能力，不要假设或覆盖别的插件的内部实现。本仓的桌面壳就是范例——它只是十层补丁层加一个 `desktopRuntime` 注册契约，没有特权。
2. **声明清晰**：显式声明依赖的 service 与 slot，并显式声明外置的模块请求；不依赖运行期巧合（例如"某个槽大概已经被声明了"）。
3. **兼容优先**：优先用上游稳定的接缝（服务、槽位、配置 schema），而不是行顺序、DOM 结构或内部字段。

配套的门禁也就落在这些规则上：模块表漂移、清单漂移、profile 装不起来、打包产物缺条目、客户端 bundle 的跨包值 import——全部是构建期的红灯，不是运行期的惊喜。

## 随包分发的插件清单

桌面客户端装配的插件都在下表里。**面**列表示这个包提供宿主面（Node，Electron main 进程内）、客户端面（沙箱渲染进程）还是两面；**挂载行**列是它在 Loader 组合里的行 id 前缀。

| 包 | 提供什么能力 | 面 | 主要挂载行 |
|---|---|---|---|
| `dsh-plugin-desktop` | 桌面壳：窗口与导航策略、托盘、更新检查与安装交接、诊断导出、完成/提问/审批通知、asar 文件系统与读取提示、高级呈现的 layout 与主题投影 | 两面 | `desktop-shell`、`desktop-diagnostics`、`desktop-updates`、`desktop-loop-notify`、`desktop-asar-fs` |
| `@picoaide/dsh-enterprise` | 企业登录门（预认证登录页、服务端地址、登录方式）、会话与令牌、网关模型目录接入、启动引导、错误上报、技能遥测、渠道内容同步、能力中心入口 | 两面 | `picoaide-auth-gate`、`picoaide-session`、`picoaide-gateway-llm`、`picoaide-bootstrap`、`picoaide-channel-sync` |
| `@picoaide/dsh-connectors` | 连接器框架（MCP 注册、认证、凭据存储与续期）+ 连接器中心面板 + 每个已连接连接器的斜杠命令 | 两面 | `pico-connectors` |
| `@picoaide/dsh-cron` | 定时任务：作业账本、5 个模型工具（`cron_create` / `cron_list` / `cron_set_enabled` / `cron_run` / `cron_remove`）、执行历史与面板 | 两面 | `pico-cron` |
| `@picoaide/dsh-browser` | 内置浏览器：独立窗口（`WebContentsView` + CDP）、控制权模型、op log、`browser_*` 工具组、侧栏入口与状态提示 | 两面 | `pico-browser` |
| `@picoaide/dsh-wasm-apps-host` | 应用窗口的宿主侧：自定义协议处理器、请求转发到平台、窗口生命周期与分区 | 宿主面 | `pico-wasm-apps-host` |
| `@picoaide/dsh-wasm-apps` | 应用中心面板：目录、打开应用、发布入口 | 客户端面 | `picoaide-wasm-apps` |
| `@picoaide/dsh-foot-menu` | 侧栏底部「⋯ 更多」行与上弹面板宿主（五个功能面板入口的承载行） | 客户端面 | `picoaide-foot-menu` |
| `@picoaide/dsh-account-card` | 侧栏底部账户卡：用户名、登出、网关用量余额 | 客户端面 | `picoaide-account-card` |
| `dsh-memory-evolve` | 五轨记忆（用户档案 / 全局事实 / 项目关键记忆 / 项目日志 / 每日日志）+ 四轨待办 + 技能自进化；**vendored 社区插件**，按三方合并方式升级 | 两面 | `dsh-memory-evolve` |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | 语音输入：SenseVoiceSmall + Silero VAD 跑在本机子进程，音频不出机器；上游可选 bundle，本项目默认装配 | 两面 | 上游 bundle 插入的四行 |
| `@picoaide/dsh-host-locale`、`@picoaide/dsh-host-home` | 宿主侧语言解析与数据根派生；**零依赖叶子包**（只 import Node 内置模块），库而不是行 | 宿主面 | 无（被别的包 import） |
| `@picoaide/dsh-panel-surface` | 中列整页面板的容器与共享视觉语言（两个插件用它挂面板） | 客户端面 | 无（被别的包 import） |
| `@picoaide/dsh-branding` | 品牌 mark、favicon、主题注入；**只在 Web 组装里，桌面组合不装**（桌面由 enterprise 的客户端面负责 favicon） | 客户端面 | 无（不在桌面 profile） |

清单里没有的东西同样重要：**没有插件市场**（没有市场页、没有安装器、没有审核目录）；**没有把上游 UI 插件管理页装进来**（那一行被显式关闭，它占用的面板席位与自研四面板的 DOM 接管不互通）。

## 四条扩展路径

要加一个能力，先判断它属于哪一类。四条路径互不替代：

| | 插件 | 连接器（MCP） | 技能（SKILL.md） | 应用（WASM） |
|---|---|---|---|---|
| **你要写什么** | 一个 npm 包：`dsh.bundle.patch` + 可选的 `dsh.client` 浏览器 bundle | 一条标准 MCP 配置（`type` + `url`，或 `command`/`args`/`env`）+ 标题说明，不写代码 | 一个目录 + 带 frontmatter 的 `SKILL.md` | 一份静态前端 + 一个 `wasm32-wasip1` 模块 + `picoaide.app.json` |
| **运行在哪** | 员工机器：Electron main 里的 DSH Host + 沙箱渲染进程 | MCP 服务自己那台机器；客户端作为 MCP 客户端连接 | 不运行；模型读文件后按它调用**已有**工具 | 服务端 wazero 沙箱执行；员工在客户端独立窗口打开 |
| **能做到什么** | 注册模型工具与系统提示词、加同源 HTTP 路由、加界面面板与槽位、接本地能力（子进程 / 文件 / 托盘）、提供 Cordis 服务供别的插件复用 | 把外部系统的能力以工具形式交给模型；认证自动判定（有 tokenFields → 静态 token，streamable-http → OAuth + 动态注册，否则免凭据），令牌自动续期 | 把流程、口径、话术、检查清单固化成可复用的指引；项目级与用户级多个技能根都会被扫描；可经能力中心上传、审核、按部门授权 | 给业务同事一个自建小工具：一个应用库、一份随包静态资源、宿主调用（读资源 / 日志 / SQL），外加客户端 AI loop |
| **做不到什么** | 跨包客户端值 import；给自己扩权；绕过服务端鉴权与计费；把未登记的原生依赖带进包 | 只能提供 MCP 服务已实现的能力；客户端对它的出站与凭据有硬策略（拒绝的环境变量键、地址段管控） | 技能本身不新增任何能力：不加工具、不改权限、不装依赖 | 不能主动发起网络请求、不能读写文件、不能开线程或定时器；同一应用内数据对所有用户共享；名单改动 = 发新版 |
| **生效方式** | 运行期安装：改补丁层后**重启应用**；随包分发：随版本 | 管理员在后台维护目录并控制下发；员工侧连接即用 | 放进技能根即可被扫描 | 作者发布 → 平台校验与编译 → 员工在应用中心打开 |

选择建议（从最轻到最重）：

- 只想让模型**按你的规矩做事**（流程、口径、模板、检查清单）→ **技能**。零代码，改起来最快。
- 能力**已经在别处实现了**（自建服务、第三方 SaaS、别人给的 MCP 服务）→ **连接器**。不要为了接一个 HTTP 接口去写插件。
- 需要**产品级能力**：新工具、新面板、新服务、本机资源 → **插件**。这是唯一能进入宿主面与界面组合的路径。
- 要给业务同事一个**自建小工具**（登记表、清单、计算器）→ **应用**。它跑在服务端沙箱里，员工在客户端独立窗口打开，不需要为它准备公网入口或证书。

## 边界：插件解决不了什么

这一节是刻意写的清单——以下六类需求不要指望用插件绕过去。

1. **插件不能给自己（或别人）做隔离。** 所有插件与宿主在同一个进程里跑，社区互操作草案也明确"同进程 JavaScript 不是安全沙箱"。文件效果约束由上游沙箱 provider 提供（Linux 先 bwrap 后 Landlock、macOS Seatbelt、Windows 受限令牌 + ACL），档位由会话权限决定——插件既改不了它，也不能把别的插件关进去。真正的隔离只能靠**能力不存在**：WASM 应用的运行时只挂 WASI、零 preopen、不传 args/env，所以它没有 socket、没有 spawn、没有文件系统。
2. **需要原生二进制的插件必须逐条过打包清单。** `asarUnpack`、`REQUIRED_PACKAGED_RUNTIME_ENTRIES`、`REQUIRED_UNPACKED_RUNTIME_ENTRIES`、`MACOS_ARM64_NATIVE_ENTRIES` 四张表逐条声明；未登记的原生依赖会留在 `app.asar` 里无法 spawn，而**四张清单对它的零覆盖不会有任何门禁报警**（Office 转 PDF 那一行就是因为拉进五个平台引擎包且清单零覆盖而被关闭）。运行期安装的第三方插件不在这个保障内。
3. **服务端权限不能靠客户端插件绕过。** 上游 API Key 只存服务端（AES-GCM 加密 + 独立主密钥文件）、余额是唯一计费闸门、权限点/审批/审计都在服务端。客户端插件改本地代码最多骗自己：服务端照拒。要在服务端加能力只能加 Go 模块（见[插件开发](/plugin-development/)）。
4. **打包版读不到 asar 里的普通文件路径。** 宿主进程自己的文件读能打开 asar 内部，但 shell 命令、搜索工具（走原生 ripgrep 进程）、`node`、包管理器都打不开。随包资源要用宿主文件 API 读。
5. **应用（WASM）不是通用执行环境。** 无网络、无文件、无线程与定时器；每个应用一个库（体积上限 100 MB）、单实例内存 64 MiB、guest 单次执行 10 秒；官方支持的语言只有 Go（Rust/Zig 可用但不承诺）；同一应用内所有用户共享数据，"每人只看自己的"要靠自己加列并在代码里判；访问名单改动等于发一个新版本。
6. **上游契约会变。** 行 id、Config 默认值、客户端 CSS 类名、可选 bundle 的组成都是外部依赖；升级要逐行复核处置，客户端 bundle 的模块边界（跨包值 import 构建期即拒）是硬约束而不是建议。

## 相关

- [插件开发](/plugin-development/) — 从零写一个插件、本地调试、打进客户端或装到服务端
- [系统架构](/architecture/) — 三层拓扑与启动顺序
- [桌面客户端](/desktop/) — 用户侧的插件管理、随包运行时与出站策略
- [Community Fabric (RFC 草案，仓库)](https://github.com/picoaide/picoaide-harness/tree/master/community/fabric) — 插件 Manifest、Capability、Host Descriptor 与事件草案

# Agent Note: Desktop release 发现与终端环境

Status: implemented

[English](2026-08-15-desktop-release-discovery-and-terminal.md) | 中文

## 问题

DSH Desktop 需要两项不属于上游 Web 呈现的原生操作。用户需要在不持续关注仓库的情况下发现较新的 stable desktop release；只使用安装器的用户也需要一个终端，在无需另外安装 DSH CLI 或 pnpm 的情况下运行普通 `dsh --profile desktop` 插件工作流。

这些操作必须保留兼容模式与高级模式已经建立的产品边界。固定的上游 checkout 保持不变；兼容模式继续使用没有 override 的官方 Web client；沙箱 renderer 不获得 Electron、Node、文件系统、进程或终端能力。desktop package 也不能修改用户的全局 `PATH` 或 shell 启动文件。

当前 release channel 尚未发布安全跨平台自动更新所需的完整签名安装包 metadata。因此，release 发现不能暗示下载、替换、安装或重启行为。

## 决策

Desktop 原生操作是围绕同一个 Electron adapter 组合的独立 Cordis Host contribution。profile 会在普通 Web bundle 之后组合 `desktop-shell`、`desktop-terminal` 与 `desktop-updates`。Electron runtime 拥有实体托盘并提供有序 item registry；每个 Host plugin 都在 `ctx.effect()` 中注册命令，并在该 generation dispose 时移除命令。Shell 继续拥有窗口与模式生命周期，terminal 与 update plugin 只拥有各自的命令状态。

该组合在兼容模式与高级模式中完全相同，不增加 Client face、preload bridge、Electron IPC 方法或 renderer global API。托盘菜单构造只对 contribution 分组，不检查上游或第三方 Web 元素。Linux 会在 profile 中禁用 terminal row；如果在 Linux 上直接激活该 Host plugin，则会明确失败，而不会显示一个无法启动的命令。

## Stable release 发现

`desktop-updates` 会查询 `anywhere-labs/deepseek-harness-desktop` 的固定 GitHub latest-release endpoint。其显式配置默认启用后台检查：首次延迟 60 秒，每次检查完成六小时后安排下一次，并为每个请求设置 15 秒期限。只有 Electron 报告为打包应用时才会自动调度。开发运行与其他未打包启动会保留手工托盘命令，但不会主动发起后台网络流量。

手工检查与定时检查共用一个 in-flight request。Checker 接受带有可选小写 `v` 前缀的 strict SemVer tag，拒绝 draft 与 prerelease，把响应正文限制为 64 KiB，并要求返回的 release 页面准确匹配固定仓库与编码后的 tag。Electron 通过 Host adapter 提供 `net.fetch`、原生通知与默认浏览器 release 打开能力。只有经过该校验的 release URL 才能传入 `shell.openExternal()`。

Updater 会在 Electron user-data 目录下原子写入 version-1 JSON 文档。文件上限为 4 KiB，只记录与一次检查关联的已安装版本、有界条件请求 ETag、最后通知的 stable 版本，以及经过校验且可用的缓存 release。POSIX mode 会请求 `0700` 父目录与 `0600` 文件。状态不存在时从空状态开始；格式损坏、体积超限或包含不安全值的状态会产生 warning 并被重置，而不会被信任。已安装版本发生变化时会丢弃条件请求与可用 release 缓存，同时保留通知历史。

托盘 label 会显示空闲、检查中或可用版本。手工检查会产生原生结果通知或失败通知。后台失败只写日志，不打断用户；同一个版本的后台更新通知跨进程重启最多显示一次。选择可用版本只会打开经过校验的 GitHub release 页面。

该能力是 release 发现，不是自动安装更新。Plugin 不会下载 asset、选择 installer、验证代码签名、替换应用文件、调用 installer 或请求应用重启。在所有目标平台都能发布签名更新产物及所需 update metadata 之前，这些步骤仍是用户显式操作。

## 隔离终端环境

Launcher 会在 Host plugin 能够提供 terminal 命令之前，用解析后的当前激活 profile 目录与 DSH home 对 Electron adapter 完成一次配置。在 macOS 与 Windows 上，`desktop-terminal` 会注册 **Open DSH Terminal**。每次调用都会在应用 user-data 的 `cli` 目录下重新生成私有启动文件，并以 profile 目录为工作目录打开一个独立的 system terminal。

生成的 `bin` 目录包含 `dsh`、`pnpm` 与 `node` shim。它们会复用打包后的 Electron executable 的 Node mode，而不依赖系统 Node 安装。Electron Builder 会把生产依赖树输出到 `app.asar.unpacked`，desktop CLI 与 pnpm shim 会进入这棵物理依赖树；因此 profile fallback 的符号链接会指向真实 package 目录，而不是虚拟 ASAR 路径。`dsh` shim 会使用 `--expose-internals` 启动 Node mode，从而保留普通 profile 与 HMR 所需的 internal ESM hook，随后进入 desktop 自有 bootstrap。在这个专用终端中，只有当调用没有选择 profile 时，该 bootstrap 才会补充打开终端时选择的 profile，包括裸 `dsh`、`dsh --dump-config` 与 plugin 子命令；显式 `--profile` 与上游 `web` alias 仍然拥有最终决定权。随后，它会在导入固定且已 unpack 的 `@deepseek-ai/dsh` CLI 入口前，移除所有大小写形式的 `ELECTRON_RUN_AS_NODE`。通用 Node 与 pnpm shim 只在自身子进程树中启用 Node mode。pnpm shim 还会局部设置 `npm_config_runtime=electron`、打包 Electron 版本与 Electron headers URL，使安装到所选 profile 的原生依赖面向当前 Electron ABI。

Terminal child 启动时会移除 Electron Node mode，把 `DSH_HOME` 固定为 Launcher 当前使用的 home，以 desktop profile 为工作目录，并且只在该 child 的 `PATH` 前置生成的 `bin` 目录。Electron main process 环境、操作系统环境与用户 shell 文件都不会被修改。欢迎信息会显示 DSH Desktop 版本、profile、profile 目录与 DSH home，随后给出配置 dump、插件 add、remove、update 命令，以及必须重启应用的提示。

在 macOS 上，LaunchServices 会打开生成的 `welcome.command`。受控的交互式 zsh 或 bash 启动会先读取用户普通的交互式 rc 文件，随后移除 Electron Node mode 并恢复 desktop 自有 home 与 shim path，避免用户 rc 意外丢弃这些值。在 Windows 上，Launcher 会依次解析 PowerShell 7、Windows PowerShell 与命令提示符，并优先使用新的 Windows Terminal 窗口承载所选 shell。如果 `wt.exe` 不可用，生成的 batch broker 会通过内置 `start` 命令分配可见控制台。Windows command 文件与 PowerShell welcome 源码只包含 ASCII；本地化 profile 名称和路径通过 Unicode child environment 传入，而不依赖当前 code page。Electron 进程始终使用 executable 与 argv 并设置 `shell: false` 来调用 launcher；同步启动失败、异步 spawn 错误与 broker 非正常退出都会进入原生错误对话框。生成的 PowerShell 或 batch welcome 文件会完成最终环境设置。

System terminal 是由本地用户显式发起的能力，而不是 renderer 或模型能力。Web 内容无法通过 JavaScript 调用该命令，也没有原始 process handle 或 terminal stream 穿过 loopback Web carrier。插件安装仍以本地用户普通权限执行，并修改持久化 desktop profile，因此欢迎信息会要求先重启 desktop，当前 Cordis generation 才能使用这些变化。

## 验证

Headless update 测试覆盖 strict SemVer 顺序、固定 origin 与 stable-release 校验、正文上限、ETag 行为、私有状态解析、定时与手工请求共享、超时取消、通知去重、动态托盘 label，以及 effect disposal。Electron adapter 测试会在不打开窗口的情况下覆盖原生通知 URL 处理，以及有序、可 dispose 的托盘 contribution registry。

Headless terminal 测试会检查生成的 macOS 与 Windows 文件、空格与 shell metacharacter quoting、通过 child environment 携带本地化路径的 ASCII Windows 模板、私有 POSIX mode、`DSH_HOME` 与 `PATH` 隔离、`--expose-internals`、不会覆盖显式 profile 或 `web` alias 的 default-desktop 参数注入、继承 Electron Node mode 的移除、交互式 shell 启动、Windows Terminal 选择、可见控制台 broker、PowerShell 与命令提示符 fallback、launcher 错误处理，以及对不支持平台或不安全生成脚本值的明确拒绝。Packaged-runtime gate 会在签名前要求 `app.asar` 包含 terminal 与 update 模块及 desktop CLI bootstrap，并要求 `app.asar.unpacked` 以物理文件形式包含上游 DSH CLI、Web runtime sentinel 与内置 pnpm 入口。

测试不会启动图形终端、显示操作系统通知、访问真实 GitHub endpoint、安装第三方原生 package 或执行签名 installer。这些行为仍是打包后 macOS 与 Windows 产物的目标平台检查。

## 考虑过的替代方案

**立即使用 `electron-updater`。** 自动下载与安装需要特定目标平台的签名产物、update metadata 和当前 release channel 尚未提供的端到端验证。固定且经过校验的 release 页面交接可以提供有效发现，而不会夸大交付流水线能力。

**在 Web renderer 中嵌入终端。** 嵌入式终端需要 renderer UI、preload 与 IPC protocol、pseudo-terminal 所有权、进程 teardown，以及更大的安全面。所需的插件管理工作流只需要一个具有受控环境且由用户显式打开的 system terminal。

**将 PowerShell 或命令提示符作为 detached Electron child 启动。** Electron 的内嵌 Node 进程会隐藏控制台子进程，而 Windows detached-process 标志不会分配新控制台。两者组合会让交互式 shell 在没有可见窗口的情况下运行。因此 Windows Terminal 是首选 host，并由生成的 `cmd start` broker 提供兼容 fallback。

**修改用户的全局 `PATH` 或 shell rc。** 全局修改会在应用退出后继续存在，与其他 DSH 或 Node 安装产生冲突，并且需要卸载修复路径。私有生成 shim 会把所有权与清理保留在 DSH Desktop 内。

**要求系统安装 Node、DSH 与 pnpm。** 这会保留本功能原本要解决的 installer-only 缺口，并使行为依赖无关的宿主版本。打包 Electron Node mode 与内置 CLI 入口能提供版本匹配的环境。

**在 Electron tray builder 中硬编码所有命令。** 单体原生菜单会耦合无关操作并绕过 Cordis disposal。Effect-scoped item registration 可以保留 plugin 所有权、确定性顺序与未来 Host 组合能力。

## 结果

打包后的 DSH Desktop 可以提示较新的 stable release，并提供普通 desktop-profile 插件工作流，而无需修改上游 checkout 或削弱 renderer 隔离。Release 安装仍需手工执行，生成的 CLI 环境也只存在于从托盘打开的终端内。

GitHub stable release tag 与准确 release 页面现在是版本发现权威。Desktop package 也开始拥有内置 pnpm 版本和生成 shim 行为，这会扩大打包 runtime closure，并且必须持续与 Electron ABI 对齐。Linux 保留兼容模式与更新发现，但在形成独立 native-terminal 设计前不会提供 desktop 终端。

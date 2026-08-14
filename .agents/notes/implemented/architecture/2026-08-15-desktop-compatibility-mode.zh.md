# Agent Note: Desktop 兼容模式

Status: implemented

[English](2026-08-15-desktop-compatibility-mode.md) | 中文

## Problem

DSH Desktop 需要原生应用生命周期和应用内模式选择器，但兼容模式不能因此成为官方 Web 呈现的隐式 fork。如果 desktop client 在每次启动时都替换 root、layout 或 sidebar，安全路径就会依赖产品自有呈现代码。但是，纯 Host package 无法贡献标准 Desktop settings 页，用户也就无法通过与 DSH 其他设置相同的持久化系统查看和更改模式。

## Decision

`desktop-shell` Cordis row 提供 `mode: compatibility | advanced`，标准 `dsh-desktop` settings namespace 会把 `mode` 默认为 `compatibility`。desktop package 同时声明 `dsh.bundle` 与 `dsh.client`；其 Client face 会在两种模式中加载。

在兼容模式下，该 Client face 只有一个范围受限的职责：在规范的 `settings.section` slot 中注册本地化 **桌面程序** 页面。该页面从已验证 renderer URL 获取当前 `compatibility`/`advanced` 值，并且只通过 desktop 自有、同源且仅允许 POST 的 endpoint 提交新模式。其样式仅属于该页面。兼容模式不会调用 advanced-shell installer，不提供或替换 `layout` service，不注册 `root` 或 `sidebar` occupant，也不改动 conversation surface。

最终兼容组合会保持官方 `ui-layout`、`ui-sidebar` 与 `ui-conversation` Loader row 处于启用状态。因此，官方 `dsh-web-app` 模块图仍拥有 root 与呈现，其中包括渲染 desktop contribution 的 settings shell。Renderer URL 会携带经过校验的 desktop 模式与平台 marker，使同一个 Client artifact 能选择范围受限的行为；这些 marker 不会暴露任何 Electron 能力。

持久化 `desktop` profile 仍按保留后的顺序包含 `dsh-base`、`dsh-web-app` 与用户安装的 bundle。第三方 client plugin 使用普通 `dsh.client` 元数据，由官方 Web 客户端模块图发现。Electron 不维护第二套插件 roster。

Launcher 会在用户 patch 之后添加一层平台安全 overlay。在 Windows 上，它禁用自适应目录选择 row，并插入现有 browse Host backend 与匹配的 browse client surface。原生目录选择 package 不会在 Electron main 进程中激活。macOS 与 Linux 保留上游自适应 row。

`desktop-shell` row 会在 profile 激活期间登记原生 shell spec，但不会从自身 Loader entry 内等待全局 Loader settlement。Launcher 只在 `app-boot` 返回后挂载该登记项，从而在首个 renderer 请求前保留激活审计，以及完整的官方、desktop 与第三方 client manifest。

## Settings and restart boundary

DSH home `settings.yaml` 文档是 `dsh-desktop.mode` 的唯一持久化事实源。Launcher 会在组合之前读取当前 `dsh-settings-file` row 解析到的文件。Host plugin 向标准 settings service 注册同一 namespace 与 schema，并声明 `applies: restart`。profile manifest 中不存在第二个值。

上游 settings description API 只暴露 allowlist，不会发布第三方 namespace，因此 Client 不能通过 `ctx.settingsScope` 读取 `dsh-desktop`。Renderer 改为只信任已被校验并写入 URL 的模式，并 POST 到 `/api/dsh-desktop/mode`。Host 会拒绝在非 `127.0.0.1` Web server 上注册该路由。其 handler 要求精确的 loopback Host 与 Origin、`POST`、`application/json`、最多 128 字节的请求，以及唯一字段为受支持 `mode` 的对象。它会把有效值委托给 Host 已注册 settings scope 并返回 `204`；被拒绝的更新会返回有上限且不包含 Host 细节的错误。该路由不暴露通用 settings mutation，renderer 也不会打开或重写 `settings.yaml`。

Settings endpoint 与托盘命令都会更新该已注册 namespace。已提交的模式修改会请求 Electron runtime 执行一次有序重启。Cordis disposal 会在 exit coordinator 为成功的零退出码 shutdown 调用 `app.relaunch()` 之前，释放 Client contribution、Host row、托盘与窗口。兼容模式绝不会在存活 generation 内热替换官方 slot。

## Native lifecycle and security

兼容适配器创建普通 `BrowserWindow`，并且不设置自定义边框、标题栏、透明、vibrancy 或原生材质选项。macOS 会阻止可见页面标题更新。Windows 保留原生标题栏图标与固定的 `DeepSeek Harness Desktop` 标题，同时移除窗口菜单栏。原生标题栏颜色与外观由操作系统拥有。

所有受支持平台使用同一张 iOS Default 应用图标。托盘在 macOS 使用由品牌 SVG 派生的模板图，在 Windows 与 Linux 使用固定品牌蓝图。兼容模式仍保留 renderer 隔离、Chromium sandbox、禁用 Node integration、精确同源导航、托盘所有权、关闭后隐藏、单实例唤醒，以及显式退出时有界 dispose Cordis 的行为。

## Verification

Package 测试要求 `./client` 导出与普通 `dsh.client` 依赖边。Profile 测试验证兼容模式保持官方 layout、sidebar 与 conversation row 启用，并验证 Windows 组合包含 browse picker 且不包含 native picker row。Client 测试验证模式/平台 marker、严格模式请求、response handling 与 desktop layout 隔离。Host 测试验证标准 namespace 注册、仅 POST endpoint handling、范围受限的 `settings.update({ mode })` 路径、只在值变化后重启，以及持久化前的 Linux 校验。

Runtime 测试验证登记过程不会重新进入 Loader settlement，并且只有 Launcher 挂载已登记 generation 后才会构造 `BrowserWindow`。窗口选项测试会拒绝兼容构造器中的高级原生选项。Headless Loader smoke 会激活 Host shell 与 profile 本地第三方插件，然后在不导入 Electron 也不打开窗口的情况下启动已发布 Web profile。

Desktop deploy root 会直接提供生产依赖图中的每个必需第一方 peer。Closure 检查会拒绝缺失声明，完整 profile smoke 则验证已发布 profile 可以访问 HTTP 根页面与 client manifest，而不依赖其他 package manager 自动安装 peer。

## Alternatives considered

**让兼容模式保持完全 Host-only。** 这会保留尽可能小的 client graph，但无法把模式选择放入规范的 settings shell。为一个标准 `settings.section` contribution 与一条窄同源控制路径加载 desktop Client，可以在不复制呈现的前提下保持范围受限的集成。

**让 desktop Client 在两种模式中都替换 root 或 sidebar。** 共享呈现所有权会使兼容模式依赖 advanced shell，并降低它作为上游参考路径的价值。因此 advanced installer 只在 advanced generation 中调用。

**Patch 官方 UI 以添加模式控件。** 上游 patch 会违反 pinned-submodule 边界，并让浏览器 DSH 感知 Electron 产品策略。标准 settings slot 的存在正是为了让 desktop package 纯新增地拥有自己的页面。

**在 Electron package 内发布复制的 Web 前端。** 复制 client roster 会重复 Cordis 组合，并要求 desktop release 跟随每次上游 client 变化。兼容模式改为加载当前 profile 的官方 Web surface。

**Web server 绑定后立即打开窗口。** 已绑定的 socket 可以提供准确端口，但不能证明 frontend fallback、boot manifest 注入或后续 client entry 已激活。因此 Launcher 使用完成的 `app-boot` 激活作为挂载时点。

**Settings 写入后热切换模式。** 两种模式在 Loader row、service 所有权、root slot 声明与原生 `BrowserWindow` 选项上都不同。在 settings 边界重启可以得到一个一致 generation，而不是分别修改这些维度。

## Consequences

兼容模式仍是上游参考呈现，但多了一个纯新增 desktop settings 页。它跟随官方 UI 与第三方 client 行为，把持久化与重启策略保留在 Host 标准 settings service 内，并在不拥有 root、layout、sidebar 或 conversation 呈现的情况下提供原生生命周期。

兼容 client graph 不再与浏览器 Web 完全字面相同，因为它包含 desktop settings contribution 与经校验的 environment marker。这项差异被有意限制在可测试范围内。无边框窗口、半透明材质、desktop 几何与 renderer chrome 仍专属于单独记录的 [advanced shell](2026-08-15-desktop-advanced-shell.zh.md)。

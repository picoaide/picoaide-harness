# Agent Note: Desktop 兼容模式

Status: implemented

[English](2026-08-15-desktop-compatibility-mode.md) | 中文

## Problem

DSH Desktop 需要原生应用生命周期，但 Electron package 不能因此隐式 fork 官方 Web 客户端。即使 desktop renderer module 只标记 DOM，每次启动都加载它也会改变客户端模块图，并让用户没有选择的呈现代码进入兼容路径。

## Decision

`desktop-shell` Cordis row 提供 `mode: compatibility | advanced`，默认值为 `compatibility`。兼容模式是当前唯一已实现的呈现模式。选择 `advanced` 会在构造 `BrowserWindow` 之前失败，因此不可用的呈现不会静默降级。

兼容模式是纯 Host overlay。`dsh-plugin-desktop` 声明 `dsh.bundle`，但不声明 `dsh.client`，也不导出 client artifact。renderer URL 是不含 desktop 查询参数的原始 loopback Web 根页面。官方 `dsh-web-app` 客户端 roster 保持启用，并由其中的 `ui-layout`、`ui-sidebar` 与 `ui-conversation` 等 row 拥有渲染后的应用。

持久化 `desktop` profile 仍按既有顺序包含 `dsh-base`、`dsh-web-app` 与用户安装的 bundle。第三方客户端插件使用普通 `dsh.client` 元数据，由官方 Web 客户端模块图发现。Electron 不维护第二套插件 roster。

`desktop-shell` row 会在 profile 激活期间登记原生 shell spec，但不会从自身 Loader entry 内等待全局 Loader settlement。Launcher 只在 `app-boot` 返回后挂载该登记项，从而在首个 renderer 请求前保留激活审计，以及完整的官方与第三方 client manifest。

## Native lifecycle and security

兼容适配器创建普通 `BrowserWindow`，并且不设置自定义边框、标题栏、透明、vibrancy 或原生材质选项。它仍保留 renderer 隔离、Chromium sandbox、禁用 Node integration、精确同源导航、托盘所有权、关闭后隐藏、单实例唤醒，以及显式退出时有界 dispose Cordis 的行为。

高级呈现需要 desktop 自有的 client plugin，并且只由 advanced profile 组合加入。该插件可以替换文档化的 slot 或 service，但不会出现在兼容模式的客户端模块图中。

## Verification

Package 测试会拒绝导出 `./client` 或声明 `dsh.client` 的兼容 package。Profile 测试验证官方 layout、sidebar 与 conversation row 保持启用。Runtime 测试验证登记过程不会重新进入 Loader settlement，并且只有 launcher 挂载已登记 generation 后才会构造 `BrowserWindow`。窗口选项测试会拒绝兼容构造器中的高级原生选项。一个构建后的 Loader smoke 会激活 Host shell 和 profile 本地第三方插件；另一个会启动完整的已发布 Web profile，并验证其 HTTP 根页面与 client manifest。两者均不会导入 Electron 或打开窗口。

Desktop deploy root 会直接提供其 197 个 package 的生产依赖图中的每个必需第一方 peer。Closure 检查会拒绝缺失声明，完整 profile smoke 则验证已发布 profile 可以访问 HTTP 根页面与官方 client manifest，而不依赖其他 package manager 自动安装 peer。

## Alternatives considered

**在兼容模式加载 no-op desktop client。** 即使只写入 DOM marker，也会改变客户端模块图、bundle manifest 与 renderer 生命周期。因此兼容模式不包含 desktop client artifact。

**为两种模式共同 patch 官方 UI。** 共享的 DOM 与 CSS 改动会使上游升级和浏览器行为依赖 desktop 产品。呈现改动属于显式 advanced 组合。

**在 Electron package 内发布复制的 Web 前端。** 复制 client roster 会重复 Cordis 组合，并要求 desktop release 跟随每次上游 client 变化。兼容模式改为加载当前 profile 的官方 Web surface。

**Web server 绑定后立即打开窗口。** 已绑定的 socket 可以提供准确端口，但不能证明 frontend fallback、boot manifest 注入或后续 client entry 已激活。因此 launcher 使用完成的 `app-boot` 激活作为挂载时点。

**把不可用的 advanced 模式当作 compatibility。** 静默降级会让原生窗口选项与 renderer 组合不符合所选配置。在 Host 与 Client 两侧都存在之前，advanced 会在原生 mount 前失败。

## Consequences

兼容模式以最少的 desktop 自有 runtime 跟随上游 UI 和第三方客户端行为。它提供原生应用生命周期，但有意不提供无边框窗口、半透明材质、桌面专用几何与 renderer chrome。高级呈现需要独立的 client contribution 和显式组合，而不是修改兼容路径。

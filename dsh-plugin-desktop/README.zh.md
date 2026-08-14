# DSH Desktop

[English](README.md) | 中文

`dsh-plugin-desktop` 在 Electron 中运行 DSH，同时仍然参与普通 Cordis 组合。安装后的应用名称为 **DSH Desktop**。该包提供 `dsh-plugin-desktop` 可执行命令和 `dsh-desktop` 别名；已注册的 npm 包名是可靠的 `npx` 入口。

## 架构

Electron 可执行文件只包含最小启动代码。它获取单实例锁、准备持久化 `desktop` profile、提供原生运行时能力，并在 Electron main 进程中启动 Host Cordis 根。`desktop-shell` Host 插件通过一个 Cordis effect 拥有 `BrowserWindow`、托盘、导航策略以及关闭与退出生命周期。

首个纯新增版本有意复用现有 loopback Web carrier。profile 挂载普通 `dsh-base` 与 `dsh-web-app` bundle；Host 把 HTTP 与 WebSocket surface 绑定到 `127.0.0.1` 的临时端口；Electron 在沙箱 renderer 中加载该同源页面。Electron 不维护插件花名册，renderer 也不会获得原始 Electron API。

启动器只修复由安装方拥有的 profile 前缀。由 `dsh plugin --profile desktop add third-party-plugin` 创建的 profile 会变为 `dsh-base`、`dsh-web-app`，随后是保持原有相对顺序的第三方 bundle。启动器在 `dsh-web-app` 之后插入自己的 desktop layer，但不会把自身持久化到由用户管理的 bundle 列表。

Cordis 的裸插件导入从持久化 profile 解析。一个范围受限的 Node resolve hook 只处理由 `@deepseek-ai/cordis-plugin-loader` 发起的导入，因此即使打包后的 Electron 不暴露 Node 内部 ESM Loader，profile 本地第三方包与修复后的启动器 fallback 仍使用同一条解析路径。

## 兼容模式

`desktop-shell.mode` 默认为 `compatibility`。该模式创建带有操作系统原生边框的普通窗口，并加载当前 DSH profile 未经修改的 Web 根页面。desktop package 不导出 client artifact，不贡献 DOM marker 或样式表，不替换任何 slot 或 service，并保持官方 `ui-layout`、`ui-sidebar` 与 `ui-conversation` row 处于启用状态。

该 package 为单独组合的 desktop client shell 保留 `advanced` 模式名。当前选择该模式会在安排原生窗口之前明确失败，不会静默降级为兼容模式。

## 开发

该包由仓库根目录的 Yarn workspace 管理。相邻的 `deepseek-harness/` checkout 仍是独立的上游 pnpm 项目，不属于 Yarn workspace。请从仓库根目录安装并验证 DSH Desktop：

```sh
yarn install
yarn check
```

该检查包含一个基于构建产物的 headless Loader smoke，会通过包名分别激活启动器拥有的 desktop row 与 profile 本地第三方 row。

有图形会话时，显式启动桌面应用：

```sh
yarn dev
```

`dev` 会在启动前自动构建，不需要另行手动构建。

以下 headless-safe 启动器入口不会导入或启动 Electron：

```sh
node lib/bin.js --help
node lib/bin.js --version
```

## 插件工作流

使用普通 DSH 命令管理持久化 profile：

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
```

随后可以通过 npm 启动该包：

```sh
npx dsh-plugin-desktop
```

第三方 Host 插件只需提供普通 `dsh.bundle` patch。包含浏览器 UI 的插件还要发布普通 `dsh.client` 元数据，将 `platform` 设为 `"web"`，并导出 `./client` 产物。兼容模式由上游 Web 客户端模块图发现这些插件；Electron 不要求单独的客户端构建，也不引入桌面专用注册 API。

## 原生生命周期

关闭窗口会隐藏窗口，Host Cordis 树继续运行。托盘可以重新打开窗口或请求显式退出。原生退出、`SIGINT` 与 `SIGTERM` 都会先请求 dispose Cordis 树，再退出 Electron；超过五秒或收到重复请求时会强制完成最终退出。导航与重定向被限制在确切的 loopback origin；外部 HTTP、HTTPS 与邮件链接由操作系统打开；renderer 启用 `contextIsolation` 与 Chromium sandbox，并关闭 Node integration。

## 打包

`yarn package:dir` 为当前宿主平台创建未封装目录。原始 `build/icon.png` 同时作为 macOS、Windows 和 Linux 应用图标。签名安装包、公证、打包后依赖闭包验证与目标平台 CI 属于后续发布工作，不在本次首个 checkpoint 的完成声明内。

## 模型体验

无。桌面包只改变应用组合与原生呈现，不增加任何模型可见的指令、工具、事件或请求字段。

#### KV Cache 影响

无。模型请求仍由同一套 DSH Host 与客户端插件图组装。

## 已知限制与暂缓事项

- 添加或删除 profile bundle 后必须重启 DSH Desktop；首个版本不监听 profile manifest。
- 兼容模式不提供无边框窗口、半透明侧边栏、桌面专用布局或其他 renderer 呈现覆盖；这些功能需要单独组合的 advanced client shell。
- 上游 `dsh plugin` 命令会把参数转发给 pnpm，因此目前仍需另外安装 `dsh` CLI 与 pnpm。该运行时要求与 DSH Desktop 自身使用 Yarn workspace 相互独立。安装器必须先暴露或内置该管理路径，只有安装器的用户才能添加 package。
- 纯新增 transport 使用 loopback HTTP 与 WebSocket，而不是 Electron IPC。替换 carrier 需要上游 DSH 提供 transport 扩展点，不属于该独立包的范围。
- 该项目目前固定使用已发布的 DSH `0.1.0-rc.6` family，而相邻的 `deepseek-harness/` 源码 checkout 早于该版本。因此，测试验证的是已发布包接口，而非上游未发布源码。
- `package:dir` 是用于 smoke 的未封装产物，而非可分发安装包。运行时闭包、签名、公证、Windows Authenticode 与安装行为仍未验证。

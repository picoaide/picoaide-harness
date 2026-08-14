# DSH Desktop

[English](README.md) | 中文

`dsh-plugin-desktop` 在 Electron 中运行 DSH，同时仍然参与普通 Cordis 组合。安装后的应用名称为 **DSH Desktop**。该包提供 `dsh-plugin-desktop` 可执行命令和 `dsh-desktop` 别名；已注册的 npm 包名是可靠的 `npx` 入口。

## 架构

Electron 可执行文件只包含最小启动代码。它获取单实例锁、准备持久化 `desktop` profile、提供原生运行时能力，并在 Electron main 进程中启动 Host Cordis 根。`desktop-shell` Host 插件通过 Cordis effect 拥有 `BrowserWindow`、托盘、导航策略、settings namespace，以及关闭与退出生命周期。

两种呈现模式都复用现有 loopback Web carrier。profile 挂载普通 `dsh-base` 与 `dsh-web-app` bundle；Host 把 HTTP 与 WebSocket surface 绑定到 `127.0.0.1` 的临时端口；Electron 在沙箱 renderer 中加载该同源页面。Electron 不维护自有插件 roster，不使用 preload bridge，renderer 也不会获得原始 Electron API。

desktop package 拥有普通 Host 与 Web Client 两个 face。它的 Client face 会在两种模式下校验 Host 提供的模式与平台 marker。兼容模式随后直接返回，不注册 service、slot、样式或呈现；高级模式则安装下文所述的 desktop layout service 与 root 呈现。两种模式下，第三方 Web client 都继续使用普通 DSH 模块图。

Launcher 只修复由安装方拥有的 profile 前缀。经 `dsh plugin --profile desktop add third-party-plugin` 修改的 profile 会包含 `dsh-base`、`dsh-web-app`，随后是保持原有相对顺序的第三方 bundle。Launcher 在 `dsh-web-app` 后插入自有 desktop layer，但不会把自身持久化到由用户管理的 bundle 列表。

Cordis 的裸插件导入从持久化 profile 解析。一个范围受限的 Node resolve hook 只处理由 `@deepseek-ai/cordis-plugin-loader` 发起的导入，因此即使打包后的 Electron 不暴露 Node 内部 ESM Loader，profile 本地第三方包与修复后的 launcher fallback 仍使用同一条解析路径。

## 模式设置与重启边界

DSH home `settings.yaml` 文档中的 `dsh-desktop.mode` 字段是单一事实源：

```yaml
dsh-desktop:
  mode: compatibility # 或 advanced
```

Launcher 会在组合一个 generation 之前，读取当前 `@deepseek-ai/dsh-settings-file` row 解析到的同一份文件。Host 通过标准 settings service 注册 `dsh-desktop` namespace。profile manifest 中没有平行的模式值。

用户可以从托盘选择另一种模式，也可以手工编辑 DSH home 中的 `settings.yaml` 文档。托盘会更新已注册的 `dsh-desktop` settings namespace，手工编辑则修改 settings provider 观察的同一文件。修改提交后会请求一次有序重启：先 dispose 当前 Cordis 树，仅当零退出码的 shutdown 成功时才让 Electron relaunch。应用绝不会在存活的 renderer generation 中热切换 root slot、原生窗口材质或 Loader row。

Linux 只支持兼容模式。其托盘模式命令会被禁用，advanced 值会被拒绝，而不会静默降级。

## 兼容模式

`dsh-desktop.mode` 默认为 `compatibility`。该模式创建带有操作系统原生边框的普通窗口，并加载当前 DSH profile 中的官方 Web surface。macOS 会隐藏可见的页面标题。Windows 保留原生标题栏图标并显示 `DeepSeek Harness Desktop`，但会移除窗口菜单栏。原生标题栏颜色与外观由操作系统拥有。

desktop Client module 会校验模式与平台 marker，随后在兼容模式下不产生任何 effect。它不提供或替换 `layout` service，不注册 `root` 或 `sidebar` occupant，不安装样式，也不改动官方 conversation surface。最终 profile 会保持官方 `ui-layout`、`ui-sidebar` 与 `ui-conversation` row 处于启用状态。

Cordis row 会在 profile 激活期间登记原生窗口参数。Launcher 只在 `app-boot` 完成并审计整个 profile 后创建窗口，因此首个 renderer manifest 会包含所有已激活的官方、desktop 与第三方 client plugin，同时插件自身不会在 Loader entry 内等待整棵 Loader tree。

在 Windows 上，Launcher 会固定使用现有 browse 目录选择 backend 与 client surface，而不使用自适应 native chooser。因此 workspace 选择始终在 Web UI 内完成，也不会在 Electron main 进程中加载原生 N-API 对话框 worker。macOS 与 Linux 仍使用上游自适应 chooser。

在两种呈现模式下，Windows PowerShell 都会保留上游 `pwsh-sandbox` 行为与 Windows ACL confinement。Desktop profile 只会把该 Host provider 替换为同一 package 中的 `dsh-plugin-desktop/windows-pwsh-sandbox` 子路径。对于与上游 ACL runner 完全匹配的 argv，adapter 会让打包后的 Electron executable 通过私有 trampoline 以 Node 模式启动，在创建受限 PowerShell 进程前移除 Node-mode 环境变量，然后把全部 policy 与失败处理重新委托给上游 runner。直接使用 `danger-full-access` 的 PowerShell、macOS 与 Linux 执行路径保持不变；Windows confinement 失败时不会自动回退到不受限执行。

## 高级模式

高级模式是为 macOS 与 Windows 显式组合的 desktop 呈现。Launcher 会在读取全部用户 patch 后禁用官方 `ui-layout` Loader row，保持官方 `ui-sidebar` 与 `ui-conversation` row 启用，并把所选模式应用到 `desktop-shell`。

desktop Client 随后在自身 Cordis fiber 生命期内提供 `layout` service，并且只注册 `root` slot occupant。其 root 为不变的上游 sidebar、conversation、details 与 overlay contribution 声明 seat。官方 sidebar 继续作为 `sidebar` occupant，并继续声明 workspace browser、settings shell 与纯新增 footer action seat。这样会保留其组件行为、收起动画与第三方扩展点，而 desktop package 只拥有 frame 几何与原生材质。

高级 theme presenter 会把当前上游 theme snapshot 投影到 document，包括 color scheme、解析后的 token 值、深色模式 marker 与 theme-color metadata。它订阅普通 theme 变化，generation dispose 时只移除由自身投影的状态。

desktop sidebar surface 会把上游 sidebar-fill token 局部设为透明，因此官方 sidebar 与 session 列表渐隐可以透出原生材质，而无需改变其组件样式。

在 macOS 上，高级窗口使用透明 hidden-inset 标题栏、定位后的红黄绿按钮与原生 `sidebar` vibrancy。其 90 CSS 像素收起列会把官方 56 像素 rail 居中放在 desktop 自有的红绿灯顶部 inset 下方。在 Windows 上，官方 sidebar 保持兼容模式几何：收起 56 像素、默认展开 280 像素，并沿用相同的上游过渡行为；透明 surface 会透出 Mica。窗口使用带原生控件的隐藏标题栏、透明 overlay、Mica 背景材质、阴影、圆角与粗可调整边框。Electron 仅在 Windows 11 22H2 及以上版本提供由系统绘制的 Mica 材质。Desktop 自有的 48 CSS 像素 caption row 会横跨 Windows 的 conversation 与 details 两列；完整的上游 slot surface 从该行下方开始，因此官方与第三方 Header contribution 会保持原有相对布局，无需针对具体元素设置 caption offset。Linux 会拒绝高级模式，而不会静默降级到与持久化设置不同的呈现。

## 开发

该包由仓库根目录的 Yarn workspace 管理。相邻的 `deepseek-harness/` checkout 仍是独立的上游 pnpm 项目，不属于 Yarn workspace。请从仓库根目录安装并验证 DSH Desktop：

```sh
yarn install
yarn check
```

该检查会验证生产依赖图中的每个必需第一方 peer 都由 desktop deploy root 声明。Headless Loader smoke 会激活 launcher 拥有的 desktop row 与 profile 本地第三方 row，然后启动已发布 Web profile 并检查其 loopback 根页面与 client manifest。单元和类型测试覆盖两种 profile 组合、重启栅栏、client environment 校验、desktop layout 状态与各平台原生窗口选项。

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

第三方 Host 插件只需提供普通 `dsh.bundle` patch。包含浏览器 UI 的插件还要发布普通 `dsh.client` 元数据，将 `platform` 设为 `"web"`，并导出 `./client` 产物。上游 Web 客户端模块图会在两种模式下发现它；Electron 不要求单独的客户端构建，也不引入 desktop 专用注册 API。高级模式 contribution 必须面向该显式组合中存在的 service 与 slot，不能假设官方 layout 或 sidebar occupant 拥有它们。

## 原生生命周期

关闭窗口会隐藏窗口，Host Cordis 树继续运行。托盘可以重新打开窗口、通过标准 settings namespace 更改模式，或请求显式退出。原生退出、`SIGINT` 与 `SIGTERM` 都会先请求 dispose Cordis 树，再退出 Electron；超过五秒或收到重复请求时会强制完成最终退出。导航与重定向被限制在确切的 loopback origin；外部 HTTP、HTTPS 与邮件链接由操作系统打开；renderer 启用 `contextIsolation` 与 Chromium sandbox，并关闭 Node integration。

## 打包

`yarn package:dir` 为当前宿主平台创建未封装目录。`build/app-icon.png` 是 macOS、Windows 与 Linux 共用且未经修改的 iOS Default 应用图标。`build/tray-icon.svg` 是品牌蓝托盘源文件：构建过程会派生由 macOS 系统自动着色的模板图，以及固定品牌蓝的 Windows 与 Linux 托盘图。签名安装包、公证、打包后依赖闭包验证与目标平台 CI 仍属于独立的发布工作。

## 模型体验

无。desktop package 只改变应用组合与原生呈现，不增加任何模型可见的指令、工具、事件或请求字段。

#### KV Cache 影响

无。模型请求仍由同一套 DSH Host 与 client feature plugin 组装。

## 已知限制与暂缓事项

- 添加或删除 profile bundle 后必须重启 DSH Desktop；Launcher 不监听 profile manifest。
- 切换 compatibility/advanced 模式按设计必然重启应用；存活的 generation 不会热切换 Loader row、slot 所有权或原生材质。
- Linux 不支持高级模式。Linux 继续使用兼容呈现。
- 上游 `dsh plugin` 命令会把参数转发给 pnpm，因此目前仍需另外安装 `dsh` CLI 与 pnpm。该运行时要求与 DSH Desktop 自身使用 Yarn workspace 相互独立。安装器必须先暴露或内置该管理路径，只有安装器的用户才能添加 package。
- 共享 carrier 使用 loopback HTTP 与 WebSocket，而不是 Electron IPC。替换它需要上游 DSH 提供 transport 扩展点，不属于该独立包的范围。
- 该项目目前固定使用已发布的 DSH `0.1.0-rc.6` family，而相邻的 `deepseek-harness/` 源码 checkout 早于该版本。因此，测试验证的是已发布包接口，而非上游未发布源码。
- `package:dir` 是用于 smoke 的未封装产物，而非可分发安装包。源码安装中的组合运行时闭包已经过 headless 验证；打包后闭包、签名、公证、Windows Authenticode、安装行为，以及每台目标机器上的原生材质外观仍未验证。

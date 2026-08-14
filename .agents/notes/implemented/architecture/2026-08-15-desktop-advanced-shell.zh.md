# Agent Note: Desktop 高级 Shell

Status: implemented

[English](2026-08-15-desktop-advanced-shell.md) | 中文

## Problem

DSH Desktop 需要在 macOS 与 Windows 上提供原生材质呈现，但不能编辑 pinned 上游 checkout，也不能复制官方 Web 应用。该呈现会同时改变多个维度：原生窗口构造、root/sidebar slot 所有权、`layout` service 与 document 级 theme 投影。如果只应用其中一部分，或在正在运行的 renderer 中改变它们，Host 组合与 Client 呈现就会不一致。

无论用户选择应用托盘命令，还是手工编辑 settings 文件，模式选择都必须使用同一个持久化事实源，并让每次修改跨越相同的重启边界。

## Decision

高级模式是由 `dsh-desktop.mode: advanced` 选中的完整 desktop 自有 generation。它仍然使用上游 loopback Web carrier 与普通 Client 模块 Loader；只改变明确由 desktop 拥有的呈现与原生窗口 seam。

### 一个 settings 事实源

DSH home `settings.yaml` 文档是单一事实源。Launcher 通过当前 `@deepseek-ai/dsh-settings-file` row 解析该文件，并在生成最终 Loader patch 之前读取 `dsh-desktop.mode`。它不会在 profile manifest、Electron preference、命令行 flag 或其他 desktop 文件中持久化平行的模式值。

`desktop-shell` Host plugin 使用包含 `mode: compatibility | advanced` 的 schema 与 `applies: restart` 来注册 `settingsNamespace('dsh-desktop')`。托盘调用该已注册 scope 范围受限的 `settings.update({ mode })` 路径。用户也可以直接编辑同一份 `settings.yaml` 文档；file provider 与已注册 namespace 会观察这个唯一的持久化值。

Linux 只支持兼容模式。托盘会在该平台禁用模式命令，advanced 值也会被拒绝，而不会映射到另一种呈现。

### 重启是组合边界

Settings watcher 会比较已提交模式与当前 generation，并在两者不同时请求一次 Electron 重启。Restart coordinator 会把 exit 标记为 relaunch，然后进入普通的有界 shutdown 路径。Cordis disposal 首先释放 Client effect、Host row、托盘与 `BrowserWindow`；仅当该 generation 以零代码完成最终退出时才调用 `app.relaunch()`。失败 generation 会直接退出而不 relaunch，重复 restart 请求是幂等的，现有强制 shutdown 截止时间仍会给 disposal 设限。

应用绝不会热切换模式。原生材质选项在 `BrowserWindow` 构造时固定，当前 Client graph 必须与启动前所选的 Loader row 与 root slot 声明保持一致。

### 高级 Client 组合

在 bundle、profile 与 home patch 完成组合后，Launcher 会验证预期官方 row 身份。其最终高级 overlay 禁用官方 `ui-layout` 与 `ui-sidebar` row，并明确保持 `ui-conversation` 启用。兼容模式对前两个呈现 row 采取相反设置，同样保持 conversation 启用。

desktop Client 会在安装高级 effect 前校验 Host 提供的模式与平台 URL marker。它通过 Cordis reflection 在一个 plugin fiber 生命期内提供由 `DesktopLayoutState` 支撑的 `layout` service。该 service 拥有 sidebar toggle 与 details open/close transition，并与安装它的同一 effect 一起消失。

Client 注册 `root` occupant，并为 `sidebar`、`conversation`、`details` 与纯新增 `shell.overlay` entry 声明子 seat。它还会单独注册 `sidebar` occupant，并为上游 workspace browser、标准 settings shell 与纯新增 footer action 声明 seat。不变的 `ui-conversation` plugin 继续拥有 conversation 与 details surface；上游 workspace 与 settings feature 继续拥有对应 sidebar surface。第三方 feature 可以向该组合中存在的已文档化 seat 贡献内容。

desktop frame 只拥有几何与 chrome：可折叠 sidebar rail、中心宽度下限、可选 details 列、resize handle、原生 drag region 与 desktop sidebar 控件。它不会复制 session、workspace、conversation、settings 或 feature 状态。

### Theme 投影

禁用官方 layout 会移除通常把当前 theme 投影到 document 的呈现层。因此，高级模式包含一个范围受限的 `DesktopThemePresenter`。它会读取普通上游 theme service，把解析后的 color scheme 与 token 值应用到 document，维护深色 theme marker 与 `theme-color` metadata，并订阅标准 `theme/change` 事件。Disposal 只会移除由该 presenter 拥有的 attribute、token 与 metadata。

### 原生材质

在 macOS 上，高级 `BrowserWindow` 使用 `titleBarStyle: hiddenInset`、定位后的红黄绿按钮、透明背景、`vibrancy: sidebar` 与 `visualEffectState: followWindow`。Renderer 在原生 vibrancy 上保持透明 sidebar surface，conversation surface 则使用解析后的 DSH theme token。

workspace seat 会把官方 session 列表的渐隐 token 局部设为透明。官方列表会保留滚动与间距行为，但不会把 Web 侧边栏的不透明填充色绘制到原生材质上。

在 Windows 上，高级窗口使用带原生标题栏 overlay 控件的隐藏标题栏、透明背景、`backgroundMaterial: acrylic`、原生阴影、圆角与粗可调整边框。Renderer 会保留 drag region，并把控件、输入框、对话框与交互内容标记为不可拖动。

高级模式不支持 Linux。Host 校验、托盘与原生窗口构造器都会强制同一边界，而不会静默降级。

## Security and carrier boundary

高级模式不会向 renderer 添加 preload script、Electron IPC transport 或 Node 能力。它保留 `contextIsolation`、Chromium sandbox、禁用 Node integration、精确 loopback origin 导航，以及把外部链接委托给操作系统的行为。HTTP/WebSocket carrier 与第三方 package 发现路径与兼容模式相同。

## Verification

Profile 测试会向临时 `settings.yaml` 写入 `dsh-desktop.mode: advanced`，并验证它被投影到 `desktop-shell`、官方 layout/sidebar row 已禁用，以及 conversation 已启用。Host 测试覆盖共享 settings namespace、值变化后重启、托盘更新路径，以及持久化前的 Linux 拒绝。Client 测试覆盖 environment 校验、作用域化 layout-service disposal、响应式列规则、slot 注册与 theme 投影。类型检查会根据已发布 rc.6 slot 与 service contract 验证 desktop 声明。

窗口选项与 Electron-runtime 测试验证 macOS hidden-inset vibrancy、Windows acrylic/原生控件、Linux 拒绝，以及托盘更新到相反模式。Shutdown 测试验证仅在成功零退出码 disposal 后 relaunch，且失败 generation 不会 relaunch。Client 与 Host bundle 均可 headless 构建；图形化原生材质外观仍是目标机器验证边界。

## Alternatives considered

**就地 patch 官方 layout 与 sidebar。** 这会修改上游拥有的实现，或让浏览器 DSH 依赖 Electron 呈现规则。禁用两个官方呈现 row 并添加 desktop 自有 occupant，可以保留机械可验证的所有权边界。

**保持官方 layout 激活，仅 shadow 其 root occupant。** 官方 plugin 仍会提供 `layout` service 并拥有子声明，从而造成分裂所有权与含糊 disposal。高级模式会把 service 与对应 root/sidebar 声明作为一个 generation 替换。

**把 conversation、workspace 或其他 feature surface 复制到 desktop package。** 这些是 feature surface，而非 desktop chrome。保持它们的官方 plugin 激活可避免重复状态，并让上游与第三方改进继续流入 desktop 组合。

**从托盘写入单独 Electron preference。** 两个 store 可能不一致。因此，托盘会更新 Host 已注册的 `dsh-desktop` namespace，手工修改也会指向同一份 `settings.yaml` 文档。

**更改模式后热重载 Client shell。** 这无法原子地重建原生窗口材质、Loader row、service 所有权与 root 声明。有界 relaunch 是最小一致 transition。

**在 Linux 上提供不带原生材质的高级模式。** 持久化同一个模式名，却在平台上使用实质不同的语义，会让配置产生误导。在存在明确 Linux 高级设计前，Linux 只暴露兼容模式。

## Consequences

DSH Desktop 在不修改上游 submodule、不复制 Web 应用，也不引入第二套插件或 transport 系统的前提下，获得了 macOS 与 Windows 原生材质呈现。托盘修改与手工编辑 `settings.yaml` 会聚合到一个持久化值，重启会创建一个一致的 Host、Client 与原生窗口 generation。

desktop package 现在拥有真实 Client 呈现代码，并且必须跟踪它使用的已发布 slot、theme 与 service contract。高级模式按设计与浏览器 Web 及兼容模式具有不同的呈现 row 组合。原生外观也取决于操作系统支持，必须在真实目标机器上验证；Linux 仍只支持兼容模式。

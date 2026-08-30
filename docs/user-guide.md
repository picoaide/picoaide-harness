# PicoAide Harness 用户指南

## 安装与首次启动

从产品下载入口获取 Windows/macOS/Linux 安装包。安装后的 PicoAide Harness 自带运行所需的 Electron、Node 和 DSH 依赖，普通用户不需要另行安装 Node.js 或 pnpm。

首次启动时，应用会准备默认 `desktop` profile，并在本机启动官方 DSH Web surface。关闭窗口通常只会隐藏窗口；可以从托盘重新打开，选择 **退出** 才会结束应用和 Host 进程。

## Profile

应用固定运行一个 `desktop` profile（一组 DSH bundle、依赖和 patch 的组合）。托盘没有 Profile 切换菜单；需要管理插件时，使用官方 `dsh plugin` 命令并显式指定目标 profile。

自定义配置（patch）如果主动改写持久化路径，则以该 profile 自己的设置为准。插件变更后需要重启 PicoAide Harness，才能让新的 bundle 进入 Loader 组合。

## 本地 Web 端口

Desktop 默认让系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），可避免与其他服务发生端口冲突。依赖浏览器 `localStorage` 的界面插件按 origin 隔离数据；如果这类插件需要在 Desktop 重启后继续读取设置，请在设置中指定一个固定端口：

```yaml
dsh-desktop:
  port: 43189
```

端口必须是 `0` 到 `65535` 之间的整数。修改后应用会有序重启，服务仍只监听 `127.0.0.1`。固定端口如果已被其他程序占用，Desktop 将无法启动；此时需要释放该端口，或把设置改回 `0` 或另一个空闲端口。

## 插件管理

插件是给 DSH 添加能力的扩展包，例如模型、工具、界面和工作流。PicoAide Harness 使用的就是官方 Harness 的插件体系，官方插件可以直接安装使用；多个插件遵循统一的约定，可以一起安装、一起工作。

普通 DSH 插件仍使用官方 CLI 语义（从系统 shell 运行）：

```sh
dsh plugin --profile desktop add <plugin>
dsh plugin --profile desktop remove <plugin>
dsh plugin --profile desktop update
```

应用固定运行 `desktop` profile；显式 `--profile <name>` 始终优先。插件变更后需要重启 PicoAide Harness，才能让新的 bundle 进入 Loader 组合。

## 更新

打包后的 macOS/Windows 应用会在后台通过 GitHub Releases 检查稳定版本。后台检查不阻塞启动；网络错误、非 200、非法版本或服务端版本不新时保持静默。Linux 不会下载安装包（AppImage/deb 由发布页直接提供）。

托盘中的 **Check for Updates…** 是手动检查：即使已经是当前版本，也会显示结果；检查失败会提示稍后重试。只有服务端版本严格高于本地版本时，应用才会询问是否下载。用户取消不会访问计数下载入口。

确认下载后，应用才会请求当前平台的固定下载地址。macOS 会打开 DMG，由用户把应用替换到 Applications；Windows 会准备 NSIS 安装器，再询问是否退出并启动安装。下载和安装失败不会破坏当前版本，托盘仍可重试。

## 排查

- **应用能够进入托盘**：右键托盘图标，选择 **导出诊断信息…**。确认隐私提示后，PicoAide Harness 会生成 `diagnostics-*.zip` 并在文件管理器中显示它。
- **应用持续闪退，无法进入托盘**：在 PowerShell 中直接运行安装后的程序并加上恢复参数。默认安装位置的命令如下；如果安装时修改过目录，请替换为实际的 EXE 路径。

  ```powershell
  & "$env:LOCALAPPDATA\Programs\PicoAide Harness\PicoAide Harness.exe" --export-diagnostics
  ```

  通过 npm 安装过桌面启动器时，也可以运行 `dsh-desktop --export-diagnostics`。这个命令不会启动 Host、profile、插件或窗口；完成后会在终端输出诊断 ZIP 的绝对路径。
- **诊断包内容**：包含最近的应用日志、本地 Crashpad `.dmp`、当前运行标记和 `system-info.txt`。系统信息会记录 Desktop、Electron、Node、平台和架构版本。日志会对可识别的认证凭据脱敏，但本地路径、工作区 ID、会话 ID 和崩溃时的内存片段仍可能存在。公开上传前必须检查；不适合公开的 dump 应通过可信渠道提供。
- **窗口消失了**：先检查系统托盘，关闭窗口不是退出。
- **插件没有出现**：确认命令作用于目标 profile（应用固定使用 `desktop`），并重启应用。
- **终端命令找不到**：`dsh` 需从系统 shell 读取；PicoAide Harness 不修改系统全局 PATH。
- **更新没有提示**：后台错误会静默；使用托盘手动检查查看结果。

更底层的生命周期、打包和平台限制属于开发者文档，见[文档索引](README.md)。

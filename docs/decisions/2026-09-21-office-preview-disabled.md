# 决策：桌面端不提供 Office 预览，走内置「不可预览」空态（2026-09-21）

## 现象

beta 客户端在右栏文档预览里打开 `.docx / .xlsx / .pptx`（以及 `.doc / .xls / .ppt`）时显示：

> 读取失败：Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。

这句指引在桌面端**无法执行** —— 这里的「主机」就是桌面客户端本机，服务端没有任何开关。

## 原因（完整链路）

1. 上游 0.1.6 起，web bundle 默认启用 `office-to-pdf` 行；客户端 `ui-sidebar-documentpreview`
   **无条件**为六个 Office 后缀注册渲染器（`src/client/office/index.ts:44-48`）。
2. 我方 `packages/host/desktop/cordis.patch.yml:90` 把该行 `disabled: true`：它会拉进仓库外
   npm 包 `@deepseek-ai/libreoffice-kit*`，而四张打包清单（`asarUnpack` /
   `REQUIRED_PACKAGED_RUNTIME_ENTRIES` / `REQUIRED_UNPACKED_RUNTIME_ENTRIES` /
   `MACOS_ARM64_NATIVE_ENTRIES`）对它们零覆盖，且 macOS 侧引擎是**嵌套的
   `LibreOfficeDev.app` + 无扩展名可执行文件** ⇒ 2026-09-20 实测打红 `codesign`
   （`bundle format unrecognized, invalid, or unsuitable`），属发布阻塞级。
3. 于是 host 端不存在 `officeToPdf` 服务，而客户端**仍然注册了渲染器** ⇒ 每次打开都是
   「读 → 请求 host 转换 → 失败」，落到那句误导文案（`office/locales.ts:13`）。

## 上游的引擎规则与代价（决定不随包的依据，2026-09-21 实测）

| 平台 | 引擎 | 未压缩 | 规则 |
| --- | --- | --- | --- |
| macOS arm64 | `libreoffice-kit-darwin-arm64` | 255.1 MB | **必须原生**，缺失抛错、不回落 WASM |
| Windows x64 | `libreoffice-kit-win32-x64` | 325.1 MB | 同上 |
| Linux x64 | `libreoffice-kit-wasm` | 185.4 MB | 无原生包（npm 404）⇒ 只能 WASM |

- 选择规则在 `libreoffice-kit/lib/index.js:646-668`；kit 本体只有 180 KB，引擎在
  `optionalDependencies` 里按平台分发。
- 没有任何环境变量/配置项可以指向系统安装的 LibreOffice（只有 `fontDirectories` 能加字体目录）。
- WASM 引擎本机实测（真实 `createConverter`）：869 B docx → 12 KB PDF **2.3 s**；
  13.7 KB docx（1200 段 + 200×8 表格）→ 122 KB PDF **6.5 s**；进程 RSS
  45 MB → 930 MB → 1206 MB，`dispose()` 后**不归还**；引擎磁盘 185.4 MB，
  压缩后 gzip -9 **52.7 MB** / xz -9 **34.1 MB**。
- 结论：跟随上游 = 每个客户端多背 185–325 MB（mac/win 压缩后估 +90–130 MB）外加
  macOS 嵌套签名返工；而这次需求只是内部试用时点开了一个 docx。

## 决定

新增一处上游补丁 `patches/dsh-client-ui-sidebar-documentpreview@<pin>.patch`：摘掉
`apply()` 末尾的 `apply$1(ctx, config.office);` 调用（只改这一处，函数体成为死代码）。

于是六个 Office 后缀**没有任何渲染器认领**，落入上游内置空态 ——
`TextPreview.tsx:210-226` 的 `selected === undefined && unviewable` 分支
（`document/unviewable.ts:10-28` 的 `UNVIEWABLE_BINARY_EXTENSIONS` 已含这六个后缀）：
**不读文件、不发请求**，只渲染 `data-textpreview-unsupported` +
`t('unsupportedFile')` =**「该格式文件暂时无法预览」**，与 `zip / mp4 / odt` 完全一致。

PDF / Markdown / 代码 / 图片 / HTML / 文本预览不受影响（各自的注册在同文件其它 `apply$N`）。

## 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| 自研渲染器覆盖（`priority: 'extension'`） | 渲染器选择器（`candidates.length > 1`）仍会列出上游 office 条目，用户切过去仍看到误导文案；且要自写组件/样式/测试，比打补丁更重 |
| 整条 `disabled: ui-sidebar-documentpreview` | 连 PDF / Markdown / 代码 / 图片 / 文本预览一起下线，粒度太粗 |
| 随包本地引擎（上游默认） | 见上表的体积与 macOS 签名代价，当前无真实需求 |
| 服务端转换（宿主代理到自托管服务端） | 需自研端点 + 适配上游 provider/remote 契约，且文件字节要上传；等真实需求再评估 |
| 运行时/启动时按需安装引擎 | 上游明确不支持（kit 注释 *without downloads or compilation*，`resolveEngine` 只做 `require.resolve`）；还要绕过 `libreoffice-kit-wasm` 的 `os: ["linux"]` 安装门禁、自建分发/校验/解压/离线兜底 —— 为省 50 MB 不值 |

## 判据

- `packages/host/desktop/tests/office-preview-disabled.spec.ts`（产物级）：
  ① 产物里没有注册调用、`apply$1(` 只剩死函数定义；② 内置空态 `data-textpreview-unsupported`
  与文案仍在。**变异验证**：把调用加回产物 ⇒ 第一条用例红（已实测，且还原后逐字节一致）。
- 补丁三件套在 `yarn check` 内：`verify-patch-resolutions`（exact + `^` 键成对）、
  `verify-patches`（仓库外 pristine 树干净应用、与 cache 封存副本逐字节一致）、
  `check-patch-pin`（目标版本 == `upstream.json` 的 pin）。
- **升级上游必须重切本补丁**（DSH 包补丁的既有纪律；`check-patch-pin` 会强制版本绑定，
  漏切会红灯而不是静默失效）。

## 认账

- 桌面端**没有** Office 预览能力（`.doc/.docx/.xls/.xlsx/.ppt/.pptx`，以及本就没有渲染器的
  `odt/ods/odp/pages/numbers`），预览面板只给一句话，不提供"用本地 Office 打开"的动作。
- 「该格式文件暂时无法预览」是**所有**不可预览二进制共用的文案（zip / 视频 / 音频 / 字体 /
  磁盘镜像 …），修改它会影响全部这些格式。
- 若日后要真支持 Office 预览，本文记录的实测数据（引擎体积、WASM 的耗时与内存）可直接用于
  选型；两条候选路线是「随包引擎」与「服务端转换」。

# PicoAide Harness 文档

[English documentation](README.en.md)

这里是 PicoAide Harness 的产品与开发文档入口。**用户文档已迁移到官网 Wiki**（[桌面客户端](https://www.picoaide.com/docs/desktop/) · [产品哲学](https://www.picoaide.com/docs/philosophy/) · [常见问题](https://www.picoaide.com/docs/faq/)）；本目录保留维护者视角的文档。想参与贡献？见[参与贡献](../CONTRIBUTING.md)。

## 按目标阅读

普通用户直接从官网 Wiki 开始即可（[快速开始](https://www.picoaide.com/docs/getting-started/)），不需要阅读开发者文档。

### 用户内容（官网 Wiki 单源）

| 内容 | 官网页面 |
| --- | --- |
| 安装 / 使用 / 排障 | [桌面客户端](https://www.picoaide.com/docs/desktop/) · [快速开始](https://www.picoaide.com/docs/getting-started/) |
| 常见问题 | [FAQ](https://www.picoaide.com/docs/faq/) |
| 产品定位与设计哲学 | [产品哲学](https://www.picoaide.com/docs/philosophy/) |
| 插件开发 / 生态 | [插件开发](https://www.picoaide.com/docs/plugin-development/) · [插件生态](https://www.picoaide.com/docs/plugin-ecosystem/) |
| 系统架构 / API | [系统架构](https://www.picoaide.com/docs/architecture/) · [API 参考](https://www.picoaide.com/docs/api-reference/) |

> 仓库内对应文件（`user-guide*`、`faq*`、`why-desktop*`、`plugin-ecosystem*`、`plugin-development*`）已改为指向官网的指引页，不再维护独立内容。

### 开发者与维护者文档（仓库内）

| 文档 | 你会得到什么 |
| --- | --- |
| [插件生态倡议书](plugin-ecosystem.md) | 指向官网插件生态页 |
| [插件开发](plugin-development.md) | 指向官网插件开发页 |
| [Community Fabric Draft](../community/fabric/README.zh.md) | 从 Manifest/Capability 基础，到 Runtime/Presentation、service composition 和溯源诊断的社区互操作提案 |
| [Fabric 社区意见处置记录](../community/fabric/docs/research/community-issue-23-review.zh.md) | Issue #23 中哪些建议已采纳、拆成独立 RFC、延期或不进入可移植核心 |
| [Fabric 框架与插件需求调研](../community/fabric/docs/research/mature-plugin-frameworks.zh.md) | Koishi、Chrome、VS Code 的成熟模式，以及真实 DSH 插件的功能需求 |
| [VS Code 扩展模型调研](../community/fabric/docs/research/vscode-extension-model.zh.md) | VS Code 已实现的声明、Provider、UI、运行位置和生命周期模式，以及它们对 Fabric RFC 的具体约束 |

| [架构说明](architecture.md) | Electron、Host、loopback Web、固定 profile 和打包之间的关系（维护者视角） |
| [Desktop service 参考](../packages/host/desktop/docs/plugin-services.md) | `desktopRuntime`/`desktopActions` 的稳定 contract 和 TypeScript 示例 |
| [包级参考](../packages/host/desktop/README.md) | 完整的构建、运行、发布和已知限制 |
| [服务端 API 完整参考](../server/docs/03-api-reference.md) | 全部 HTTP 端点（官网只放公开摘要） |

## README 文件怎么分工

目前外层仓库有两份正式的产品 README，另保留一个旧链接兼容入口：

- [`README.md`](../README.md)：中文产品入口。
- [`README.en.md`](../README.en.md)：英文产品入口，与中文 README 保持同一产品范围。
- [`README.zh.md`](../README.zh.md)：旧中文路径的兼容页，不维护独立内容。

`README.i18n.yaml` 只记录这两个正式入口的双语 hash，不是用户指南。`dsh-plugin-desktop/README.md` 和 `dsh-plugin-desktop/README.zh.md` 是 npm 包随包发布的包级参考；它们比根 README 更技术化。`dsh-plugin-desktop/docs/` 是稳定 API 合同，不是营销页。`.agents/notes/implemented/` 是日期化的维护者决策记录，适合追溯取舍，不替代用户文档。

`deepseek-harness/` 是固定版本的官方上游子模块。它自己的 README 和 `docs/` 属于上游项目，不能当作 Desktop 文档，也不在本仓库的产品文档统计中。

## 状态约定

文档会明确区分已实现能力、平台限制和 roadmap。桌面壳固定高级呈现：Desktop 自有的布局和原生材质始终安装（Linux 使用标准系统窗口边框，布局一致）。社区市场仍处于文档阶段（见 [`community/fabric`](../community/fabric/README.zh.md)），尚无可用页面或安装器；手机远程和 Channels 也仍是独立 roadmap，不代表当前安装包已经提供这些产品入口。

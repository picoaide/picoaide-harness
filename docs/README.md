# DSH Desktop 文档

[English documentation](README.en.md)

这里是 DSH Desktop 的产品与开发文档入口。根目录的 [`README.md`](../README.md) 适合第一次了解项目；本目录解释项目为什么存在、如何使用，以及如何为 Desktop 编写插件。

## 按目标阅读

| 读者 | 文档 | 你会得到什么 |
| --- | --- | --- |
| 第一次使用 | [用户指南](user-guide.md) | 安装、profile、模式、终端、插件命令和更新 |
| 想了解项目 | [为什么做 Desktop](why-desktop.md) | Desktop 与官方 Harness 的边界，以及为什么坚持插件化 |
| 插件作者 | [插件开发](plugin-development.md) | 普通 DSH 插件、Desktop 服务、兼容模式和生命周期 |
| 架构/维护者 | [架构说明](architecture.md) | Electron、Host、loopback Web、profile 和打包之间的关系 |
| Desktop service 参考 | [`dsh-plugin-desktop/docs/plugin-services.md`](../dsh-plugin-desktop/docs/plugin-services.md) | `desktopProfiles`、`desktopPnpm` 的稳定 contract 和 TypeScript 示例 |
| 包级参考 | [`dsh-plugin-desktop/README.md`](../dsh-plugin-desktop/README.md) | 完整的构建、运行、发布和已知限制 |

## README 文件怎么分工

目前外层仓库有两份正式的产品 README，另保留一个旧链接兼容入口：

- [`README.md`](../README.md)：中文产品入口。
- [`README.en.md`](../README.en.md)：英文产品入口，与中文 README 保持同一产品范围。
- [`README.zh.md`](../README.zh.md)：旧中文路径的兼容页，不维护独立内容。

`README.i18n.yaml` 只记录这两个正式入口的双语 hash，不是用户指南。`dsh-plugin-desktop/README.md` 和 `dsh-plugin-desktop/README.zh.md` 是 npm 包随包发布的包级参考；它们比根 README 更技术化。`dsh-plugin-desktop/docs/` 是稳定 API 合同，不是营销页。`.agents/notes/implemented/` 是日期化的维护者决策记录，适合追溯取舍，不替代用户文档。

`deepseek-harness/` 是固定版本的官方上游子模块。它自己的 README 和 `docs/` 属于上游项目，不能当作 Desktop 文档，也不在本仓库的产品文档统计中。

## 状态约定

文档会明确区分已实现能力、平台限制和 roadmap。Desktop 的兼容模式保留上游默认 Web 客户端；高级模式才安装 Desktop 自有的布局和原生材质。插件市场、手机远程和 Channels 仍是独立 roadmap，不代表当前安装包已经提供这些产品入口。

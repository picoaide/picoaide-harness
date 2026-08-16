# DSH Community Fabric

[English](README.md)

DSH Community Fabric 是一项面向 DSH 插件与宿主的社区互操作标准提案。目标很简单：插件只需要用同一种方式描述“我是谁、我需要什么”，Desktop、Web UI、TUI、启动器和分发工具都能一致地理解这份声明。

> **当前状态：Draft，仅有文档。** 这个 workspace 还没有 Fabric runtime、SDK、正式 schema、兼容认证或可加载插件。本仓库当前的插件仍使用现有 DSH 与 Cordis 接口。

## 为什么需要这个项目

DSH 社区已经出现不同界面、启动器、插件集合与分发渠道。插件作者不应该靠猜测判断一个宿主能否运行自己的插件，用户也不应该等安装失败后才知道“不兼容”。

Fabric 提议共同维护四块基础：

1. 静态 manifest，让工具无需执行插件代码就能检查基本信息。
2. 带版本的 capability，描述插件申请什么、宿主支持什么。
3. 可预测的激活、停用与事件 contract。
4. 机器可读的兼容结果和一致性测试。

这个提案是互操作层，不会替代 DSH、Cordis，也不会要求各宿主放弃自己的内部架构。宿主可以继续使用原生插件系统，只需通过 adapter 向兼容插件提供统一的社区 contract。

## 必须说清楚的安全边界

Capability 声明有助于兼容判断、用户确认和审计，但它**不会自动变成安全沙箱**。如果一个受信任的 JavaScript 插件与宿主运行在同一个 Node.js 进程中，它仍可能绕过 `ctx`，直接调用操作系统接口。

只有真正实现隔离执行、受控模块加载和受管 IPC 的宿主，才能声称某项权限被技术强制执行。标准必须向用户分别展示插件申请了什么、用户授权了什么、哪些组合经过实测，以及宿主是否真正隔离。

## 第一个里程碑

首个实验版本会刻意保持很小：

- 静态 JSON manifest 与 JSON Schema；
- 机器可读的 Host Descriptor；
- required / optional capability 协商；
- 顺序确定的生命周期 hook；
- 一个不可修改的 `messages.observe` 事件；
- fixtures 与可在 headless 环境运行的一致性测试。

可修改的 `before-*` 事件、文件与网络等敏感权限、复杂的跨端 UI、市场认证和隔离执行，都需要独立提案与实际证据。

## 阅读与参与

- [兼容层与开发框架设计](docs/architecture/compatibility-layer.zh.md)
- [RFC 0001：Plugin Manifest、Capability 与事件模型](docs/rfcs/0001-plugin-manifest-capabilities-events.zh.md)
- [当前可用的 DSH 插件开发方式](../docs/plugin-development.md)
- [DSH 插件生态倡议书](../docs/plugin-ecosystem.md)

RFC 是社区讨论稿，不是 DeepSeek 或 DSH 官方标准。欢迎通过 issue、discussion 或 PR 提出修改；插件作者、GUI / Web UI / TUI 维护者、启动器与市场维护者、安全研究者和普通用户都可以参与。

DSH Community Fabric 与 FabricMC 没有关联；这里的 Fabric 表示连接 DSH 社区各宿主与插件的兼容网络。

## License

提案与未来参考代码遵循 [MIT License](LICENSE)。

# DSH Desktop

DSH Desktop 是 DeepSeek Harness 的桌面发行项目。官方 Harness 源码以固定提交的 Git 子模块保留，我们的 Electron 与 Cordis 实现位于独立的 Yarn workspace；桌面功能不得直接修改上游源码。

## 仓库结构

```text
deepseek-harness-desktop/
├── deepseek-harness/       # 官方 deepseek-ai/deepseek-harness 子模块
├── dsh-plugin-desktop/     # DSH Desktop Cordis 插件与 Electron 启动器
├── scripts/                # 产品仓库检查与发布脚本
├── package.json
└── yarn.lock
```

`deepseek-harness` 保持官方的 pnpm workspace 和 lockfile。外层仓库及 `dsh-plugin-desktop` 使用 Yarn 4，并通过 `node_modules` linker 支持 Cordis 动态插件解析、Electron 和原生依赖。

当前 GitHub 官方 `master` 的源码版本是 `0.1.0-rc.5`，npm 官方 Registry 发布的运行时 family 是 `0.1.0-rc.6`。两者分别记录在 `upstream.json`；在官方发布可对应的 source tag 或 commit 前，不把 npm artifact 推断为子模块中的源码。

## 初始化

```sh
git clone --recurse-submodules https://github.com/anywhere-labs/deepseek-harness-desktop.git
cd deepseek-harness-desktop
corepack enable
yarn install --immutable
yarn check
```

已有 checkout 初始化子模块：

```sh
git submodule update --init --recursive
```

图形环境中启动桌面应用：

```sh
yarn dev
```

`dev` 会先构建桌面包，不需要手动运行 `yarn build`。

## 上游边界

- `deepseek-harness` 只通过独立提交更新 gitlink，不在本仓库内打补丁。
- 根 Yarn workspace 不包含 `deepseek-harness`。
- 普通桌面构建依赖已发布的 DSH npm 包；子模块用于源码审计和显式的兼容性验证。
- `yarn check:layout` 会拒绝脏子模块、错误远端、错误提交以及重新引入的嵌套 pnpm workspace。

需要验证官方源码时，使用它自己的 pnpm 配置：

```sh
yarn upstream:install
yarn upstream:build
```

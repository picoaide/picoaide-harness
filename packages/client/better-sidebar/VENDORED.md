# dsh-better-sidebar (vendored)

本包是从 <https://github.com/omdsh-dev/DSH-better-sidebar>（v0.13.1，MIT）vendor
进 PicoAide Harness 产品仓库的第三方插件，作为桌面客户端的右侧面板/底部工作台。

- **上游**：<https://github.com/omdsh-dev/DSH-better-sidebar>（commit 随 vendor 日期记录在 THIRD_PARTY_NOTICES.md）
- **许可**：MIT，版权归 dsh-external（见 LICENSE）。
- **维护策略**：本目录为上游代码的只读镜像。升级 = 从上游拉取并替换本目录内容；
  不在本目录内做产品定制（定制应放 dsh-task / dsh-cron 消费侧或 profile 组合层）。
- **双挂载守卫**：包内 `cordis.patch.yml` 的 `!!js disabled` 表达式会在聚合/重复
  挂载时自动退让，保持原样。

## 集成适配记录

- 2026-08-19：`package.json.devDependencies` 增加 `@deepseek-ai/cordis: 4.0.1`（上游 devDeps 遗漏该 peer；缺它时 host 半在 workspace 布局下解析 `@deepseek-ai/dsh-settings` 失败，桌面 profile boot 崩溃）。除依赖声明外未改动上游内容。
- 2026-08-19（追加）：`devDependencies` 合并全部 `peerDependencies`（Yarn 4 peer 自动安装不递归传递依赖，`dsh-tools → dsh-scope` 链解析失败导致 profile boot 崩溃；显式 devDeps 才完整安装）。

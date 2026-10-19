# RETIRED — 自动化任务已改用官方 Schedule（2026-10-18）

本包（`@picoaide/dsh-cron`）**已从桌面组合中移除**，不再加载 Host 定时器、HTTP 路由、
`cron_*` 工具、设置卡与任务面板。自研「定时任务」由上游 0.2.1 默认装配的
`@deepseek-ai/dsh-schedule` + `@deepseek-ai/dsh-client-ui-schedule` + `@deepseek-ai/dsh-tool-schedule`
取代；入口仍保留在侧栏「更多」浮层的原位（第一位，文案「自动化任务」），点击打开官方
`schedules` 面板。

源码保留一个版本用于对照回滚，**不要**重新加入 `packages/host/desktop` 的 dependencies 或
`REQUIRED_BUNDLES`。旧任务账本仍在数据根 `cron/ledger.json`（只读保留），官方 Schedule
不会自动导入这些任务；需要继续运行的任务请在官方「自动化任务」页重建。

决策记录：`docs/decisions/2026-10-18-official-schedule-replaces-cron.md`。

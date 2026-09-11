# PicoAide Harness 客户端 E2E 自动化

一键运行客户端端到端测试（mock gateway + 打包应用 + CDP 驱动 + 15 项断言 + 截图 + 报告）。

```bash
# 前置：打包产物 + Xvfb :99（或 DISPLAY 环境变量）
yarn workspace dsh-plugin-desktop package:dir

# 运行（自动启动 gateway/应用，或复用已有 CDP）
yarn workspace dsh-plugin-desktop e2e:client

# 自定义
node packages/host/desktop/scripts/e2e-client.mjs --app <binary> --port 9223 --no-screenshot
```

## 覆盖点（15 项断言 + 截图）

| # | 检查点 | 截图 |
| --- | --- | --- |
| 1 | 应用启动并暴露 CDP | — |
| 2 | 登录成功（mock gateway） | 01-login-main.png |
| 3 | 客户端插件图已装载（`__DSH_BOOT__` 非空，含 memory-evolve 升级后加载） | — |
| 4 | 主界面侧边栏导航完整（定时任务/技能/连接器/浏览器/设置） | — |
| 4 | 连接器面板可打开且含预期内容 | 03-connectors.png |
| 5 | 技能中心面板可打开（模态） | 04-skills.png |
| 6 | 设置面板可打开 | 05-settings.png |
| 7 | 定时任务中心面板挂载 | 06-cron.png |
| 8 | 聊天输入区可用 | 08-chat.png |
| 9 | 高级模式固定生效（mode=advanced） | — |
| 10 | 工作区选择器可打开 | 09-workspace.png |
| 12 | 账号页可打开（设置内） | 10-account.png |
| 13 | 账户卡余额数据链路（mock `/auth/usage` 真实契约:直接字段） | — |
| 14 | 账户卡在宽布局以余额为主数字渲染（balance_enabled） | 10-account.png |
| 15 | 会话输入区可输入消息 | 11-input.png |

## 输出
- 报告：`packages/host/desktop/.e2e-report.md`
- 截图：`packages/host/desktop/.e2e-shots/`
- 退出码：非 0 = 有失败项（可接 CI）

## 设计
- `e2e-fixture-gateway.mjs`：mock 网关（登录/bootstrap/workspaces/skills/cron/models），端口 34567。
  注意 `/api/client/v2/auth/usage` 必须按**真实服务端契约**返回直接字段（无 `data` 外壳）——
  此前 fixture 多包了一层，账户卡字段静默全空却"测试通过"（2026-09-11 修复）
- `e2e-client.mjs`：CDP 驱动（`ui-cdp-main` 模式）→ 登录 → 逐面板断言 → 截图 → Markdown 报告
- 复用已有 CDP（`--port` 已有应用时不重复 spawn）

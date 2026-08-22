# DSH Desktop 测试覆盖矩阵

三层覆盖：**单测**（44 个 vitest 文件）、**verify 脚本**（打包/加载/许可）、**E2E 自动化**（e2e-client.mjs，13 项断言）。

## 客户端功能覆盖

| 功能点 | 单测 | verify 脚本 | E2E 自动化 | 备注 |
| --- | --- | --- | --- | --- |
| 登录（mock） | — | — | ✅ 断言 + 截图 | e2e |
| 主界面（高级 shell 固定） | window-options/plugin | verify-profile-boot | ✅ mode=advanced | 三平台窗口选项 |
| 聊天输入区 | — | verify-loader | ✅ 可输入消息 | |
| 连接器中心 | desktop-plugins | verify-profile | ✅ 面板+内容+截图 | 真实环境已验（r01） |
| 技能中心 | — | — | ✅ 模态打开 | 真实环境已验（r02 真实技能） |
| 任务看板面板 | — | — | ✅ 挂载 | 真实环境已验（r04） |
| 定时任务面板 | cron 53 单测 | — | ✅ 挂载 | 真实环境已验（r05） |
| 设置面板 | plugin.spec | — | ✅ + 账号页 | |
| 工作区选择器 | directory-picker | — | ✅ 打开 | Windows 原生 bridge 单测 |
| 浏览器面板 | browser 47 单测 | — | ◐ 需单独 WebContentsView 断言 | 真实环境已验（34-browser） |
| 托盘菜单 | electron-runtime | — | ◐ 源码级（无系统托盘） | 无终端/模式/profile 项已确认 |
| 诊断导出 | diagnostic-export | verify-packaged | ◐ 原生 dialog（单测覆盖逻辑） | |
| 更新检查 | update-checker/download | verify-win | ◐ 单测覆盖逻辑 | |
| 模型选择 | — | — | ◐ 未直接断言 | 真实环境已验（r03 设置） |
| 记忆插件 | memory-evolve | — | ◐ 未直接断言 | 需会话上下文 |

## 打包/分发覆盖（verify 脚本）
- verify-packaged-runtime：app.asar/unpacked 条目与 exports 完整性
- verify-loader-boot / verify-profile-boot：Loader/配置组合 headless smoke
- verify-runtime-closure：200 首个方节点闭环
- verify-licenses / verify-notices：702 生产包许可 + 通告
- verify-win-installer / verify-win-portable / verify-mac-smoke/release：三平台产物

## E2E 工具
- 入口：`yarn workspace dsh-plugin-desktop e2e:client`
- 脚本：`packages/host/desktop/scripts/e2e-client.mjs`（+e2e-fixture-gateway.mjs）
- 报告：`.e2e-report.md`；截图：`.e2e-shots/`；退出码可接 CI

## 已知缺口（可选后续）
1. 浏览器面板 E2E 断言（WebContentsView 独立 target）
2. 模型选择器精确断言（依赖真实模型接口）
3. 记忆插件五轨视图（需真实会话数据）
4. 托盘菜单 X11 断言（无系统托盘环境）

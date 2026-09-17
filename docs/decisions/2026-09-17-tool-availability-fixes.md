# 内置工具自检报告的三个问题定案（2026-09-17）

状态：已实施（待 PR：`packages/host/browser` 截图回落预算、`packages/host/cron` 删除工具、
`patches/dsh-sandbox-windows-acl@0.1.5-rc.2.patch`）

来源：用户提供的 Windows 客户端自检报告（会话 `session-77720e3e-9280-4c95-8053-e44f2e984c6e`，
PicoAide Harness `2.7.5-beta.4` / Electron 43.4.0 / Windows，工作区 `D:\project\urlfy`）。
报告逐工具做了真实无害调用，列出三个"需要关注"的问题：`pwsh` 必须提权、`browser_screenshot`
连续两次 30s 超时、cron 缺少删除工具。

## 一、逐条取证

### 1. `browser_screenshot` 30s 超时 —— 真缺陷：回落无预算

报告形态：`example.com` 与 `the-internet` 各一次 `tool call timed out after 30000ms`；同一时段
其余浏览器工具（含 `get_snapshot`/`eval`/`click`/`type`）全部正常 ⇒ 不是 CDP 整体卡死。

源码事实（`packages/host/browser`）：

| 位置 | 事实 |
|---|---|
| `budgets.ts:32-33` | 不变量原文写的是"截图有 **8s 原生预算 + 5s 渲染器回落**"，都必须在 30s 工具预算之内 |
| `runtime.ts` `screenshot()` | 原生 `capturePage()` 走 `withScreenshotBudget(..., screenshotPrimaryBudgetMs())`（≤8s）**有界** |
| 同上（改造前） | CDP 回落 `captureScreenshotViaCdp(...)` 是**无界 await** —— `SCREENSHOT_FALLBACK_RESERVE_MS` 只被用来**算**原生的预算，从没被拿来**约束**回落 |
| `runtime.ts:714` | CDP send 自身超时 = `options.timeoutMs`（30s），与工具 deadline **同一个数**，救不了 |

⇒ 渲染器不产帧时，回落一直挂着，直到上游 `guard/timeout-policy` 在 deadline 把整个结果**替换**成
`tool call timed out after 30000ms`：模型与用户都看不到"卡在哪一段"。这与 2026-09-16 用户闸那次
（`budgets.ts` 头注释记录的同一类缺陷）**同根**：内部等待必须短于工具预算，否则再清楚的错误也送不出去。

### 2. cron 缺少删除工具 —— 真缺口：只有模型面没有

- 工具面（`packages/host/cron/src/tools.ts`）改造前只有 `cron_create` / `cron_list` /
  `cron_set_enabled` / `cron_run` ⇒ 模型能建任务，**永远删不掉**（报告里自检遗留的占位任务只能让用户
  去 GUI 面板手动清理）。
- GUI 面板本来就有删除（`CronJobTab.tsx` → `controller.remove`），底层 `delete` 动作在
  `protocol.ts` / `host-ledger.ts`（含 owner 强制）**一直存在**，缺的只是模型面出口。

### 3. `pwsh` 必须提权 —— 上游 fail-closed + 原文零可行动信息

报告原文：默认「工作区内修改」下连 `hello` 都跑不了，`Error: SetNamedSecurityInfoW failed
(Win32 5): grantWrite(D:\project\urlfy)`，两次调用均同；提权 `danger-full-access` 后正常。

- 出错点是上游 `@deepseek-ai/dsh-sandbox-windows-acl` 的 `grantWrite()`：给工作区根目录加 write ACE
  时 `SetNamedSecurityInfoW` 返回 **Win32 5 = ERROR_ACCESS_DENIED**。
- 该模块自己写明的**前置条件**是"目录必须归调用者所有（owner 隐含 WRITE_DAC）"。写 DACL 被拒的
  常见成因：映射网络驱动器 / junction 或符号链接指向别处 / 云同步占位文件 / 非 NTFS 卷 /
  别的账户创建的目录 / 安全软件保护的 DACL。
- 这条路径**按设计 fail-closed**（`sandbox-local.materializeAclGrant` 半途失败会回滚），行为本身正确；
  问题是错误文本只有 API 名 + 错误码 + 路径，用户和模型都拿不到任何可行动信息。
- 本机是 Linux，**无法复现**该 Windows 失败；因此本次不改判定逻辑，只补原因与出路。

## 二、决策

1. **截图两次尝试都必须有界**（`runtime.ts`）：新增 `screenshotFallbackBudgetMs()` =
   `min(5s, timeoutMs − primary − 1s)`，并把 CDP 回落包进 `withScreenshotBudget`。默认部署下
   8s + 5s + 1s 余量 < 30s ⇒ 卡住时模型拿到的是自带原因的失败（原生原因 + 回落原因 + "窗口必须能渲染"
   的建议），而不是一句 `tool call timed out`。回归：`tests/hidden-window-fallbacks.spec.ts` 新增
   "渲染器侧抓帧永不 settle"用例（变异验证：把回落预算改回无界即红）。
2. **新增 `cron_remove`**：走与 GUI 相同的 `delete` 动作；先过 `listVisibleJobs()` owner 过滤
   （看不见的任务按"不存在"报错），**正在执行的任务拒删**（删除不会取消在跑的会话，只会让执行记录
   凭空消失 —— `settle()` 对已删任务是静默 no-op）。文案进 `host-copy.ts`（zh 为源、en 镜像），
   系统提示词公告同步列出 5 个工具名。回归：`tests/tool-remove.spec.ts`（5 例，含跨账号与运行中）。
3. **给 ACL 授权失败加"可行动原因"**（上游补丁，不改 fail-closed）：`SetNamedSecurityInfoW` 失败且
   码为 5 时，在错误尾部追加：写 DACL 需要拥有该目录（或持有 WRITE_DAC）、哪些目录形态会撞上、
   以及两条出路（把工作区换成本账户创建的本地 NTFS 目录 / 该会话改用完全权限预设）。**其它错误码
   不加提示**（避免把真正的 API 缺陷误诊成"工作区不可授权"）。守卫：
   `packages/host/desktop/tests/sandbox-acl-grant-hint.spec.ts`（真实桩 binding 跑
   `AclWriteGrant.create/add` 三例 + 产物/resolutions 断言；变异验证：装回 pristine 包即红）。

**明确不做**：ACL 失败时静默降级成"不限制写"。那是把 fail-closed 换成安全回归，不是修复；
出路只能是"换目录"或"用户显式选择完全权限"。

## 三、待取证（需要那台 Windows 机器）

`D:\project\urlfy` 为什么会被拒，本机无法判定。取证三连（PowerShell，不需管理员）：

```powershell
icacls D:\project\urlfy            # 看 Owner: 是不是当前账户、有没有 DENY / 继承被切断
fsutil fsinfo volumeinfo D:        # 看卷是不是 NTFS（exFAT/FAT32 不支持 DACL）
fsutil reparsepoint query D:\project\urlfy   # 非零退出=不是 junction/符号链接（是则看目标在哪）
```

若 `Owner:` 不是当前登录账户，或该目录经 junction/云同步/网络驱动器到达，则提示里的两条出路就是
最终处置；截图那条也仍需真机复现（本次只保证"卡住会说话"，是否 Windows 隐藏窗口不产帧导致的挂起，
要靠 `%APPDATA%` 下客户端 op 日志里新的失败原因确认）。

## 四、验证记录

- `packages/host/browser`：`vitest run tests/hidden-window-fallbacks.spec.ts tests/shots.spec.ts
  tests/tool-diagnosis-2026-09-12.spec.ts tests/audit-0916-user-gate.spec.ts` → 36 passed。
- `packages/host/cron`：`vitest run tests/tool-remove.spec.ts tests/tools.spec.ts` → 10 passed。
- `packages/host/desktop`：`vitest run tests/sandbox-acl-grant-hint.spec.ts` → 3 passed。
- `node scripts/verify-patches.mjs` → 10 个补丁在 pristine tarball 上干净应用且与 yarn 封存副本逐字节一致；
  `node scripts/verify-patch-resolutions.mjs --strict-lock` → 10 个补丁包 exact + `^` 键一一对应。
- 整仓 `corepack yarn check`（build + typecheck + test + 6 个 guard）→ **16/16 通过，exit 0**（日志
  `temp/check-2026-09-17.log`）。
- 变异验证：截图回落预算改回无界 → 新用例红；把 pristine ACL 包覆盖回安装位 → 守卫 3 例中 2 例红。

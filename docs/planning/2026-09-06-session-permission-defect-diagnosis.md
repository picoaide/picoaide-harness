# 2026-09-06「新建会话失败 + 权限跳回」诊断报告（含修复与验证）

诊断对象：桌面产品 PicoAide Harness v2.6.7-beta.2（win32，Electron 43.4.0，DSH 0.1.2-rc.1），数据源：用户诊断包
`diagnostics-1788670585487-08ffd48e-5e0d-4120-8b96-3537b7e8c270.zip`（09-06 导出，含 10 份日志 + 1 份 crash dump）
+ 用户真实环境截图（会话内 `resume failed … preset "standard" failed to mount: 23 rows name plugins that cannot be resolved`
+ `(gateway/internal)`）+ 本地打包版复现 + 真实服务端（picoaide-next.kq0575.cn / user001）端到端验证。

## 一句话结论（修订）

**「新建会话失败」的真正主因 = 打包布局(app.asar)与 DSH 0.1.2 预设健康检查不兼容**，已在 2026-09-06 修复并
线上验证通过；「权限跳回」的另一半 = 上游空白会话复用缺陷（见下文，产品侧为残留项，官方未修）。

## 症状 1：设置完全权限后「跳回去」——空白会话复用（主根因）

链路（全部在上游）：

1. 空白会话在**创建时**就被钉住当时默认权限：`dsh-permission-presets` 的 `pinInitialPermission` 在
   `session/created` 时把 `defaultPreset` 以 `permission/preset` + `sandbox/mode` + `approval/policy` 三个事件写入该会话日志。
2. 用户把「默认权限」改为完全权限（设置→权限，写入 `$DSH_HOME/settings.yaml` 的 `permission.defaultPreset`，已实测持久化正常）。
3. 用户点「新会话」→ 上游 `ui-workspace` 的 `connectWorkspace`
   （`packages/client/ui-workspace/src/client/navigation.ts`）**优先复用工作区里已有的空白会话**
   （条件：`summary.blank && summary.cwd === workspace.path && sessionIds 包含 && 未归档`），**完全不校验该空白会话的权限默认**。
4. 复用了旧空白会话 → 新开的「会话」里 composer 权限徽标显示旧默认「工作区内修改」→ 用户看到「跳回去」。

「有时候」的成因：只有存在可复用的陈旧空白会话时才跳回（比如以前点过一次但没发消息的会话、某个失败尝试留下的空会话）。
没有陈旧空白会话时正常创建新会话、默认权限生效。

上游已知同类缺陷且未修：[Discussion #3018「changing the default agent preset does not apply when a workspace
reuses an existing blank session」](https://github.com/deepseek-ai/deepseek-harness/discussions/3018)（agent 预设场景的孪生问题）；
已核对上游 `origin/master`（0.1.3-alpha.1 线）该文件与 rc.1 相同——**官方所有已发布/未发布版本均未修复**。
配套讨论：[#3615 空白会话切换 preset 后 agent-scoped 残留](https://github.com/deepseek-ai/deepseek-harness/discussions/3615)。

## 症状 2：新建会话「有时候会失败」——主因 = 打包布局与 0.1.2 预设检查不兼容（已修复）

**主根因（2026-09-06 确认 + 修复 + 线上验证）：**

1. DSH 0.1.2 的 `dsh-agent-presets` 发现层新增磁盘健康检查：每个预设行用裸 `existsSync(<fallback>/<pkg>/package.json)`
   判定包是否存在（`discovery.ts` 的 `rowResolves` / `packageInstalled`）。
2. 桌面打包（`asar` + `asarUnpack` 仅原生）把模块树封进 `resources/app.asar`；模块回退目录
   `$DSH_HOME/profiles/node_modules/*` 是**指向 asar 内的符号链接**。**Electron 的 fs 补丁不跟进 asar 的符号链接**
   （桌面 `module-resolution.ts` 已实测验证：直连 `.asar` 路径可解析，symlink-into-asar 报 MODULE_NOT_FOUND / ENOTDIR）。
3. ⇒ `existsSync` 对全部 23 个预设行返回 false → 预设 `standard` 被判 broken → `session create / resume` 全部以
   `agent-preset/invalid: … 23 rows name plugins that cannot be resolved` 拒绝——**用户的截图（resume failed + 23 rows）与
   本地打包版复现完全一致**；官方 pkg 单文件二进制（`process.pkg`）走 proxy 回退路径所以不受影响——**这是 Electron 打包形态
   专属缺陷（我们的产品打包形状 vs 上游仅测试 pkg+文件树两种形态）**，不是 token、不是插件冲突、也不是老文件。

**为什么是「有时候」**：0.1.1（2.6.5 及之前）没有该预检（挂载可直接走 asar 直连路径）→ 老会话正常创建；
0.1.2 预检生效后，新建/恢复全面失败；用户观感收敛在新版升级后（09-06 升级 beta.2 后立即出现）。

**已实施的修复（产品侧，不触碰上游）：**

- `packages/host/desktop/package.json`：`"asar": false`——桌面打包退回**物理目录**（`resources/app/`，与官方
  文件树形态一致），回退目录符号链接指向真实文件，预设检查/GUI 加载/编辑器工具全链路恢复。配套了打包验证器：
- `scripts/verify-packaged-runtime.ts`：`verifyPackagedRuntime` 支持物理布局分支（`resolvePackagedAppRoot` +
  `verifyPhysicalRuntime` + 诊断 worker 原地启动）；`afterPack` 按是否存在 asar 选择 worker 源路径。
- `scripts/verify-mac-smoke.ts` / `scripts/verify-mac-release.ts` / `scripts/verify-win-portable.ts`：三平台验证器
  支持物理布局（`Resources/app`、`resources/app`）。
- 测试：`verify-packaged-runtime.spec.ts` 新增物理布局用例；`package.spec.ts` / `verify-mac-release.spec.ts` 断言适配。

**验证结果（真实服务端 https://picoaide-next.kq0575.cn/，user001，物理布局打包版）：**
登录 → 新建会话 ×3 全部成功（composer 权限徽标出现）→ 权限切换「工作区内修改→完全权限」保持 → 设置默认权限
「完全权限」写入 settings.yaml 并持久化 → 改默认后再新建会话徽标=完全权限；全程无 console 错误。
本地门禁：typecheck 全绿、desktop 487 测试通过、package:dir（afterPack 验证器）通过。

### 残留项

- **空白会话复用**（下方症状 1）仍存在：当工作区有旧的空白会话时，新建会复用它（旧权限/旧预设默认），
  官方未修；产品侧缓解方案（启动时归档「默认权限已过期」的空白会话 / e2e 补建会话断言）待产品拍板。

## 已排查并排除的方向

- **「老版本升级后，旧文件导致新版本不能创建会话」**：逐项验证 0.1.1-rc.2 → 0.1.2-rc.1（2.5.x → 2.6.x）的持久化兼容，
  **未找到硬证据**（详见下方升级兼容矩阵）。老文件唯一真实风险点是「旧的自定义 agent 预设」与「版本交替启动的
  re-heal」，均不构成新建失败的主因。
- **设置行自身会跳回**：未复现。设置→权限→完全权限→勾选确认→`settings.yaml` 正确写入
  `permission:\n  defaultPreset: danger-full-access`，行值保持「完全权限」（Revision 语义按命名空间隔离，非 bug）。
- **我们的插件写 permission 命名空间**：全仓搜索无任何命中（唯一匹配是 cron 的 action 字段校验，无关）。
- **权限切换本身不生效**：`PermissionPresetService.apply` 走日志事件 + 投影回读，链路正确。
- **advanced 桌面壳 vs 官方 ui-layout**：已按 2026-09-05 定案禁用 ui-layout、由 desktop 自持 layout 服务，无二次声明。
- **`desktop-shell` mode 冲突**：enterprise patch 写 `mode: compatibility`，但 `profile.ts` 最终以 `mode: advanced` 覆盖，无害。

## 诊断包暴露的独立问题（另一优先级）

1. **OOM 崩溃（严重）**：crash dump 内 `electron\shell\common\node_bindings.cc:190] OOM error in V8:
   ExternalEntityTable::AllocateEntry Allocation failed - process out of memory`（09-04 16:27，pid 31876，v2.6.5）→
   「previous desktop run did not shut down cleanly」（09-04、09-06 均出现过）。崩溃会丢内存态，放大一切
   「奇怪」观感（会话列表错乱、状态回退）。建议单独追踪内存增长（候选：会话投影缓存 / 长时间运行不释放）。
2. **`agent/disposed listener threw: TypeError: Cannot read properties of undefined (reading 'catch')`**（09-04 11:11 与 11:32 各一次）
   ——某个 agent 生命周期监听者的缺陷，被 agent 注册表容错为 warn，但应定位（配合 OOM 会话异常更频繁）。
3. **`session-title-llm: title output reached maxOutputTokens`** 高频（08-31～09-04 每天多次）——标题服务输出
   达到上限，无害但说明模型侧配置（maxTokens 映射与标题请求）值得顺手核查。

## 升级兼容矩阵（0.1.1-rc.2 → 0.1.2-rc.1 持久化文件逐项验证）

| 旧文件 | 0.1.1-rc.2 | 0.1.2-rc.1 | 结论 |
| --- | --- | --- | --- |
| `storages/workspace.json` | 域 version 2（single） | 域 version 2（single），记录结构仅 `SessionId`→`brandString` 类型级变换 | 旧文件直接可读 ✓ |
| `sessions/<project>/<session-id>/session.jsonl(.zstd)` | 同目录布局；物理头 `SESSION_FORMAT_VERSION=0`；事件行/`chunk-rows` 压缩行编码同构（0.1.2 仅加 `SessionSeq` 类型标注与 `-0` 校验） | 一致 | 旧会话可读 ✓ |
| `storages/session_projcache.json` | single 布局域 v3（单文件） | **改为 per-record 布局域 v5**（`compatibleVersions:[3,4]`、`invalidRecords: backup-and-skip`；单文件路径被放弃） | 旧缓存被静默放弃→逐会话冷重建，启动安全 ✓ |
| `profiles/node_modules/*` | 符号链接 | 打包版改为 **proxy 目录**（含 package.json 的 ESM 代理）；`moduleFallbackCurrent` 检测到旧 symlink→整体重 heal | 自愈 ✓ |
| `profiles/desktop/package.json`（bundles 列表） | 旧列表 | `ensureDesktopProfile` 每次启动强制修复为当前 `REQUIRED_BUNDLES` | 自愈 ✓ |
| `settings.yaml` | 旧命名空间值 | 按命名空间 schema 校验，坏值保留 last-good；`permission`/`agent-presets` 段形状两版一致 | 兼容 ✓ |
| `$DSH_HOME/.agent-presets/`（用户自制预设） | 旧行（标准预设两版内容相同，仅从 `apps/cli/config` 迁到包内） | 旧副本与新版标准同构 | 兼容；**若为旧版自定义预设且被设为默认，建议人工确认** |
| workspace 域 `pendingMutation` 恢复 | 同 schema | `recoverPendingMutation` 启动恢复（对应 OOM 崩溃中断场景） | 兼容 ✓ |

## 建议动作

1. **上游修复（根因）**：向上游提 issue/PR——`connectWorkspace` 复用空白会话前校验该会话 permission 投影与当前
   `defaultPreset` 等价（及 agent preset 默认），不等价则新建；或直接把陈旧空白会话排除出复用池。
   官方 #3018 是同一 bug 的预设版本，可合并为一个修复。
2. **上游修复（静默失败）**：`startSession` 的 `clear()` 分支与失败分支应给用户可见反馈；phase 未 ready 时点击应
   排队或提示"正在加载"。
3. **产品侧缓解（不依赖上游）**：
   - 桌面客户端插件在启动时清理「无消息且权限默认已过期」的空白会话（archive 语义，可恢复）——需产品确认；
   - e2e-client 补盲区：现有 13 项断言从不真正创建会话（第 12 项匹配到的 input 是侧边栏搜索框
     `input[placeholder]`！），加：新建会话→断言 composer 权限徽标出现、默认权限改动→新建→徽标等于默认值。
4. **OOM 单独排查**（09-04 16:27 崩溃环境与复现方法见诊断包 crash-dumps/reports/）。

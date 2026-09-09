# PicoAide Harness 全项目 Bug 检查报告（2026-09-08）

- 被检代码：本地 `master` HEAD `b9f8df59f6`（v2.6.7-beta.10）。**注意：本地落后 `origin/master` 5 个提交（v2.6.7-beta.11）**，差异见 §5。
- 范围：`server/`（Go + webadmin）、`packages/host/*`、`packages/client/*`、`packages/vendor/*`、`.github/workflows`、根 `scripts/`、`integration-tests/`、`site/`、`docs/`。排除 `deepseek-harness/`（只读上游子模块）。
- 方法：门禁实测（yarn check / make check / 客户端 E2E / 真机浏览器 E2E）+ CodeQL（JS/TS 584 文件、Go 182 文件，security-and-quality）+ 6 路并行深审（上一轮结论复核、浏览器、服务端、桌面/客户端插件、webadmin/CI/文档）+ 主审逐条亲验（源码 + 真实复现）。
- 结论：**门禁全绿，但门禁本身有一条假绿（P0-1）**；共 **4 条 P0、23 条 P1**（其中 11 条为上一轮遗留、12 条新发现，含 §10 浏览器生命周期专项 3 条）、约 60 条 P2/P3。**没有一条被现有自动化测试拦住**——全部是逻辑/安全/计量/体验缺陷。
- 口径说明（2026-09-08 产品定案）：**AI 可操作浏览器的一切内容**，`browser_eval` 放行 fetch/XHR 与任意 JS 执行是预期行为，**不再作为安全边界缺陷**。原先按"只读策略逃逸"记录的 P0-3 已改判（见 §2 #20 与 §3.6）——该区域真正的 bug 是"放行了却读不到结果"。

验证标记：✅ = 主审亲自复现或读码确认；🔬 = 子代理带探针实测（探针路径见 §7）；📖 = 源码定位（未跑复现）。

---

## 0. 门禁与实测结果（2026-09-08 本机）

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区门禁 | `corepack yarn check` | ✅ 通过（layout + 10 包 build/typecheck/test：browser 162、cron 111、desktop 等全绿） |
| 服务端门禁 | `cd server && make check`（PG_DSN_TEST=pg-test:5432） | ✅ 通过（gofmt/vet + Go 测试 + webadmin 109 测试 + vite build） |
| 客户端 E2E | `yarn workspace dsh-plugin-desktop e2e:client`（HEAD 重新打包后） | 13/13 ✅ **但该门禁是假绿**，见 P0-1 |
| 真机浏览器 E2E | `node temp/browser-v4.2-e2e.mjs`（真实测试服务器 + Xvfb 合成截图） | 22/22 ✅（蒙版常驻、overlay z-order、面板/菜单/查看器、快捷键均真实可见） |
| CodeQL JS/TS | security-and-quality，584 文件 | 125 结果，安全类仅 5 条 "Improper code sanitization"（经核为误报：`JSON.stringify` 转义安全，见 §3 误报说明） |
| CodeQL Go | security-and-quality，182 文件 | 2 结果：1 条弱哈希告警（审计链 SHA-256，误报）、1 条无用赋值 |
| 依赖/版本 | `gh run list` | CI 全绿；最新 Release v2.6.5 资产只有 dmg/exe/AppImage/SHA256SUMS（**无 deb**，见 P2-14） |

> 门禁全绿 + 真机 E2E 全绿，说明下面所有缺陷都在测试覆盖之外；其中 P0-1 直接解释了为什么"门禁全绿"不能作为发布依据。

---

## 1. P0 —— 立刻处理

### P0-1 客户端 E2E 门禁假绿：应用完全起不来也打印"全部通过"并 exit 0 ✅ **已修复（2026-09-08，见 §11）**
- 位置：`packages/host/desktop/scripts/e2e-client.mjs:344-370`（`run()` 的 catch 只 `console.error`，`finally` 用 `results.filter(r => !r.ok)` 决定退出码），CI 入口 `.github/workflows/ci.yml:231,241`。
- 机制：`main()` 在第一条断言之前就抛错（例如 CDP 30s 未就绪）时 `results=[]` → `failed.length===0` → 打印 `E2E 结果：全部通过`，`process.exitCode` 保持 0。
- 复现（本机实测）：
  ```
  node scripts/e2e-client.mjs --app /data/picoaide-harness/temp/audit-0908-stub-app.sh --port 19399 --no-screenshot
  → e2e-client fatal: app did not expose CDP within 30s
  → E2E 结果：全部通过     EXIT_CODE=0     报告 0/0 通过
  ```
- 影响：CI `desktop-linux` job 里唯一的客户端门禁形同虚设——打包产物启动即崩溃也能绿。
- 附带缺陷：第 12 项断言用 `document.querySelector('textarea, [contenteditable=true], input[placeholder], [role="textbox"]')`（`e2e-client.mjs:314-330`），命中的可能是侧边栏搜索框而非会话输入框 → 从不真正验证"能发消息"。
- 修复：catch 里 `process.exitCode = 1`（或 `reportStep(..., false)`）；finally 以 fatal 标记判失败；第 12 项锚定 composer。

### P0-2 OIDC 回调限流占用全局用户桶 → 全组织 SSO 每 5 分钟只能登录 10 次 ✅📖
- 位置：`server/internal/serverauth/oidc.go:270` `a.loginAllowed(c, "oidc-callback")`；`ratelimit.go:113-121`：`allow(loginKey(c,username))` 之后还有 `allow("u:"+username)`。
- 机制：固定串 `oidc-callback` 被当作 username 写入账号级桶 `u:oidc-callback` —— **该桶全局共享、跨 IP、跨用户，且成功登录也计数**（`allow()` 末尾无条件 `append(now)`，见 `ratelimit.go:88-93`），窗口 5 分钟、上限 10。
- 影响：启用 OIDC 的组织，第 11 次 SSO 登录（无论谁、从哪）即 429；未认证者只要打 10 个假回调就能持续压制全员 SSO。
- 修复：回调用独立 limiter（仅按 IP、独立阈值），不占用户登录桶。

### P0-3（已改判，非 bug）浏览器 `browser_eval` 的"只读策略"
- 2026-09-08 产品定案：AI 可操作浏览器的一切内容，eval 里的 fetch/任意 JS 都是预期能力，**不是安全边界**。
- 因此 `.constructor` 可绕过 `WRITE_APIS`（实测 ALLOWED）**不再计为缺陷**；该区域真正的问题改列为 §2 #20（放行后读不到结果）与 §3.6（策略文案与定位不一致）。

### P0-4 浏览器 CDP 无超时 + 互斥锁不可取消 → 一次页面卡死永久锁死整个浏览器工具面 ✅ **已修复（2026-09-08，见 §11）**
- 位置：`packages/host/browser/src/cdp.ts:51-54`（`send()` 直接透传 `sendCommand`，无超时）、`pool.ts:55-71`（`await prev` 不接 signal，只有拿到锁之后才检查 `signal.aborted`）、`runtime.ts:895-918/1007-1104/1219-1228`（所有工具经 `agentRun`）。
- 复现（子代理探针 `temp/audit4/probe2.spec.ts`）：一个永不 resolve 的 CDP 调用 → `abort` 后 `isBusy=true`、`busyTool=browser_get_snapshot`；500ms 后 `navigate` 仍 `HUNG`（锁未释放）。
- 影响：渲染进程卡住/崩溃后，`isBusy` 恒 true、蒙版恒显示"AI 正在操作"，**之后所有 browser_* 永久挂起，只能重启应用**。
- 修复：`send` 加超时（如 30s，与页面侧 timeout 分离）；`await prev` 带 signal；超时强制释放锁并记 failed。

### P0-5 下载守卫按 session 去重但 disposer 不计数 → 关掉第一个标签即失去全部下载拦截 ✅ **已修复（2026-09-08，见 §11）**
- 位置：`packages/host/browser/src/guard.ts:130-131`（已守卫的 session 返回空 disposer）、`:203-205`（唯一 listener 的移除函数）、`runtime.ts:404-406`（每个标签都 push 这个 disposer）、`runtime.ts:850-864`（关标签即释放）。
- 复现（子代理探针 `temp/audit4/probe.spec.ts`）：2 标签 → `listeners=1` → `closeTab(1)` 后 `listeners=0`；再触发下载 `downloads=0`、`setSavePath=[]`。
- 影响：beta9 修的"重复记录"换来了"拦截消失"——剩余标签的下载不再记录、不再 `setSavePath`，退回原生保存对话框，`browser_download` 无痕。
- 修复：`WeakMap<session, {count, dispose}>` 引用计数；或每标签独立监听（记录用标签 id 派生）。

---

## 2. P1 —— 高优先（安全/数据正确性/可用性）

| # | 位置 | 问题 | 影响 | 验证 |
|---|---|---|---|---|
| 1 | `server/internal/serverauth/admin.go:1237,1247,1253` | `ldap.bind_password` / `oidc.client_secret` / `openid.client_secret` **明文写入 settings**（同仓 `llmgateway/admin.go:170`、`mfa.go:53` 都走 `util.Encrypt`；GET `/auth` 反而掩码 `:1104`） | 违反 AGENTS.md §3.5「凭证 AES-GCM」；DB 备份/导出即泄露目录服务账号与 IdP 密钥 | ✅ |
| 2 | `server/cmd/server/main.go:117,157-170,379` | `gin.New()` 后**先注册 162 条 API 路由与 /healthz，再 `r.Use(Logger, CustomRecovery)`** → 这些路由不带恢复与访问日志 | 任意 handler panic 不返回 JSON 信封而是断连（违反 §7.0 契约）；全部 API 零访问日志（取证缺口） | ✅（本机 gin 实验：先注册路由 panic 逃逸，后注册返回 500） |
| 3 | `server/internal/serverauth/ratelimit.go:46-93,113-121` + `handler.go:158` | 登录限流在**认证之前**调用，且 `allow()` 无条件把成功尝试也记账 | 未认证者 10 次错密即可把任意账号（含 super_admin）锁死 5 分钟；正常用户 5 分钟内第 11 次登录也被 429 | ✅（代码路径 + 子代理真实登录链实测） |
| 4 | `server/internal/serverauth/dirsync.go:196-215` + `oidc.go:187` | LDAP 每小时同步的 `deactivateMissingExternalUsers` 停用**所有** `Source=="external"` 且不在 LDAP keep 集里的用户，而 OIDC 用户同样是 `external` | 同时启用 LDAP+OIDC 时，每个整点把全部 OIDC 用户置 `status=0` 并吊销 token，再登录 401「账号已禁用」，无自愈 | ✅📖 |
| 5 | `server/internal/serverauth/config.go:71-74` + `handler.go:295` | `local` provider 无条件注册，客户端登录顺序恒为 `ldap → local`，不看 `auth.enabled` | 想用 LDAP/OIDC-only 管控的组织，任何本地账号（含 bootstrap admin）仍可密码登录员工面 | ✅（上一轮 1.4，仍未修） |
| 6 | `server/cmd/server/main.go:289` | 门户页 `<title>` 直接拼 `loginName`（同页正文 `:351` 已 `htmlEscape`；`:359` `_ = payload` 死代码） | 管理员可设品牌名含 `<script>` → `/`、`/portal` 对未认证访客执行存储型 XSS | ✅（上一轮 1.6，仍未修） |
| 7 | `packages/host/enterprise/src/auth-gate.ts:243,246` | `data-method="' + m.name + '"` 与 `label` 未 `esc()`（同文件 `:221-224` 已转义） | 用户配置的（或遭劫持的）网关可注入属性/事件，在本地登录页 origin 执行任意 JS | ✅（上一轮 1.9，仍未修） |
| 8 | `server/internal/serverstore/gateway.go:557-580` + `llmgateway/upstream.go:132` | `DeleteModel` 只删 `models` 行；路由用 `mergeModelNames(provider.models JSON, models 表)` 仍保留该名；`ModelPrices` 查不到行 → (0,0,0) | "删除模型"后模型从 `/v1/models` 消失却仍可调用且 **cost=0**（平台付费、零计量），下架治理被绕过 | ✅📖 |
| 9 | `server/internal/llmgateway/messages.go:60-71` + `serverstore/usage.go:165-176` | Anthropic `/v1/messages` 只取 `CacheReadInputTokens`，`CacheCreationInputTokens` 解析后丢弃；`costOfAt` 又把 `cacheTokens>promptTokens` 夹到 promptTokens | cache_creation 完全不计费、cache_read 被压到 input_tokens → 实测少收 ~99.87%（8e-7 vs 6.14e-4） | ✅📖 |
| 10 | `server/internal/serverstore/usage_ledger.go:220-237,337-349` | 跨保留期时账本查整窗口、明细只查 `[cutoff,to]`，再用 `mergeUsageRows` **按 label 覆盖** | `group=user/dept/provider` 跨保留边界时早于 cutoff 的历史用量整条丢失（实测 330 → 220），与"10 年不丢"相反；月报 TopUsers/Departments 同样少报 | 🔬 |
| 11 | `server/internal/agentshare/routes.go:417,429` + `serverstore/agent_presets.go:64-88` | legacy name 级 approve/reject 用 `GetAgentPreset`（= 最高 **approved** 版本）定位目标 | 已上架 1.0.0 + 待审 2.0.0 时点"拒绝"会把 1.0.0 置 rejected（已上架版本从员工目录消失），2.0.0 仍 pending；"通过"静默无效 | 🔬 |
| 12 | `packages/host/desktop/src/electron-runtime.ts:791-814` | 崩溃回退页 `did-finish-load` 后立刻 `loadURL(current)` 回应用 URL；`crashRetried` 只挡"再重载一次" | 确定性崩溃时"错误页→应用页→再崩"无限循环，承诺的手动重载按钮留不住，CPU/GPU 空转 | 🔬 |
| 13 | `packages/host/enterprise/src/session-service.ts:96`（`persist` :155-169） | `void persist(...)` 无 `.catch`；`writeFileSync` 失败 → unhandledRejection → `dsh-app-boot` fail-loud → `exit(1)` | `$DSH_HOME` 不可写（ENOSPC/EACCES/ROFS）时，一次登录直接终止整个桌面应用 | 🔬 |
| 14 | `server/scripts/deploy.sh:58-70`（另 :252-254,337） | `.env` 复用白名单含 `PG_PASSWORD` 却**不含 `PICOAI_ADMIN_PASSWORD`** | `REINSTALL=yes` 重装（pg-data 已删）写出空超管密码 → `log.Fatalf` → 容器 crash-loop，且末尾仍打印"部署完成" | 📖 |
| 15 | `server/internal/serverstore/usage_dept.go:183` | `seen := map[string]bool{}` 声明在 `for rows.Next()` **循环体内**，每行重置 | 用户属两个子部门且共享祖先时，祖先部门用量被重复累加（实测 200 vs 100）；与预算 enforcement 口径不一致 | ✅🔬（上一轮 1.1） |
| 16 | `server/internal/serverstore/usage_ledger.go:276-313` | 默认分支把 `col` 设为 `"month"`，`case "model"` 生成 `month AS label` + `GROUP BY month` | 账本回退时 `group=model` 把所有模型合并成"每月一行"，`top_models` 同路径出错 | ✅🔬（上一轮 1.2） |
| 17 | `server/internal/serverauth/token.go:56` + `admin.go:845` | `VerifyToken` 只查 `Status`；吊销条件 `demoted := wasRole != RoleUser && u.Role == RoleUser` | `user→auditor`（或 super_admin→auditor）不吊销任何 token，审计角色可继续用旧 token 访问员工面 | ✅（上一轮 1.5） |
| 18 | `packages/host/browser/src/eval-policy.ts:306-313` | `maskString` 只按值内关键词脱敏，cookie 形状（`sid=…; theme=dark`）不匹配 | 设计承诺的"读 cookie 结果脱敏"未达成，明文进模型上下文与 op log | 🔬 |
| 19 | `packages/host/browser/src/runtime.ts:101,584-599,867-889` + `index.ts:235-245` | 切换用户只清 tabs/store/partition，`this.ops` 从不清空 | 新账号的活动面板/`GET ops` 能看到上一账号完整轨迹（主机名、路径、带 token 的 URL） | 🔬 |
| 20 | `packages/host/browser/src/runtime.ts:939`（`awaitPromise: false`）+ `:946`（`serializeEvalResult(evalResult.result?.value)`） | **放行 fetch 后仍读不到响应**：任何 Promise 结果（`fetch/XHR/async` 表达式）被 CDP 序列化成 `{}` | AI 执行 `fetch(url).then(r=>r.text())` 得到 `"{}"`，无法读取网页数据/响应体，与工具描述"returns its JSON result"及"AI 可操作浏览器所有内容"直接矛盾 | ✅（真机 CDP 实测：`Promise.resolve(42)`/`fetch(...).then(r=>r.status)` 在 `awaitPromise:false` 下均返回 `{}`，`awaitPromise:true` 下返回 `42`/`200`） |

---

## 3. P2 —— 重要（按主题分组）

### 3.1 服务端数据/并发/安全
| # | 位置 | 问题 | 验证 |
|---|---|---|---|
| P2-1 | `server/internal/router/router.go:60-163` vs `serverauth/admin.go:94-99` | 1MB 请求体上限只装在测试镜像里；生产 admin 组与 `/auth/login` 无 `MaxBytesReader` → 未认证者可推超大 JSON 致 OOM（实测生产式路由读完 8MB） | 🔬 |
| P2-2 | `serverstore/reports.go:89-96` + `reports/scheduler.go:61` | `MarkReportRun` 失败只写 `last_error` 不写 `last_run_at` → `ShouldRunMonthly` 恒 true，失败 webhook 每小时重算整月报表并重发 | 🔬 |
| P2-3 | `llmgateway/handler.go:89 vs :407` | 配额"先检查后记账"，无预占/在飞计数 → 并发可放大 N 倍突破（实测 1 元配额 + 8 并发 = 8.00 元） | 🔬 |
| P2-4 | `llmgateway/handler.go:659-679` + `serverstore/usage.go:376-386` | 部门成员 id 拼 `IN(?,?,…)`，>65535 触发 PG 参数上限 → fail-closed 后全员 429（实测 7 万用户 + 全员组预算） | 🔬 |
| P2-5 | `serverstore/gateway.go:460-466,446,491` | 价格/参数按模型名单键查询，而唯一键是 `(provider_id,name)` → 跨渠道同名模型取错价（实测 18 倍少收） | 🔬 |
| P2-6 | `serverstore/usage.go:206-223` + `llmgateway/handler.go:592-619` | 上游上报 token 无范围校验 → 负值让 cost/用量倒退，int64 max 让当月永久 429 | 🔬 |
| P2-7 | `llmgateway/handler.go:475,567-580` + `messages.go:155,166` | 流式逐行 `ReadString('\n')` 无行长上限（`maxUpstreamBody` 只保护非流式）→ 一条无换行超长行撑爆内存（实测 24MiB 行 → +18MiB 堆） | 🔬 |
| P2-8 | `serverstore/usage.go:275-278` + `llmgateway/sync.go:144` | `CleanupPendingUsage` 每小时删"0 token 且 >1h"的 pending 行，不区分是否仍在流中 → 长流结束回填 `sql.ErrNoRows`，该请求用量全丢 | 🔬 |
| P2-9 | `serverstore/skills.go:80-94` | 本地 `compareVersionStrings` 前三段相等后按整串比较 → `1.0.0-rc.1 > 1.0.0`，与发布内核 `skillmanifest.CompareVersions` 相反 | 🔬 |
| P2-10 | `sharedskills/routes.go:349` | 版本级 DELETE 按 **name** 清空授权 → 删一个历史版本即静默撤销全员对剩余版本的访问 | 🔬 |
| P2-11 | `server/internal/archiveutil/archive.go:198-208,232` + `packages/host/enterprise/src/archive-util.ts:183-198` | 服务端取**第一个**匹配条目、客户端按序写盘**最后一个**生效 → 审核看到的内容 ≠ 员工安装的内容（双 SKILL.md 可夹带） | 🔬 |
| P2-12 | `serverstore/audit.go:29-43,175` | 哈希链"读最后一行再 INSERT"无锁/事务（并发分叉）；`PurgeOldAuditLogs` 无条件删旧行破坏链锚点；`VerifyAuditChain` 无生产调用点 | ✅📖（上一轮 2-1） |
| P2-13 | `serverstore/migrate.go:100-118` | 迁移逐条 Begin/Commit，无 advisory lock → 多实例并发启动竞态 | 📖（上一轮 2-2） |
| P2-14 | `appstore/publish.go:204,216` | `UpsertApp` 与 `CreateRelease` 之间无事务 → 占名无版本悬挂 App / TOCTOU | 📖（上一轮 2-3） |
| P2-15 | `serverstore/usage.go:611-617` + `dialect.go:31-33` | `created_at AT TIME ZONE 'Asia/Shanghai'` 包裹分区键 → 分区裁剪与索引失效（EXPLAIN 实测全分区扫 32 行 vs 单分区 5 行） | ✅🔬（上一轮 1.3） |
| P2-16 | `serverstore/usage.go:677-682` | "今日/昨日"用服务器本地日界（UTC 容器偏移 8h） | 📖（上一轮 2-5） |
| P2-17 | `server/internal/router/router.go:60-163` | 无统一请求体上限中间件（与 P2-1 同源，生产/测试树漂移） | 🔬 |
| P2-18 | `serverstore/gateway.go:286-290` | 渠道同步覆盖 `default_params`（管理员设的 concurrency_target 被清） | 🔬 |
| P2-19 | `reports/handlers.go:47-55` | 报表 webhook SSRF + 跟随 302 | 🔬 |
| P2-20 | `telemetry/routes.go:58` | 任意登录用户可无限刷 `calls` 刷榜 | 🔬 |
| P2-21 | `appstore/admin.go:82-88`、`appstore/publish.go:196-198` | `{"official":false}` 反被置官方并清空 owner；管理员给官方 App 发版后 owner 变发布者 | 🔬 |

### 3.2 桌面 / 客户端插件
| # | 位置 | 问题 | 验证 |
|---|---|---|---|
| P2-22 | `packages/client/account-card/src/usage-service.ts:89-124` + `src/index.ts:85-91` | `clear()` 不取消 in-flight、快照不绑定会话；`refreshNow` 的 single-flight 会把上一会话结果返回给新会话 | 🔬（探针实测 A 数据泄漏给 B） |
| P2-23 | `packages/host/connectors/src/index.ts:194-227,402-423,288-293` | 两个 restore 入口无互斥；`registerMcp` 覆盖同 key 旧 disposer → fiber/工具重复注册、连接泄漏 | 📖 |
| P2-24 | `packages/host/desktop/src/index.ts:196-199` | 通知点击的跳转请求写入 `loopNotifySession` 后永不消费/清空 | 📖 |
| P2-25 | `packages/client/better-sidebar/src/fs-tree.ts:143-152` | `isWithin` 纯词法前缀比较，不解析符号链接 → 工作区内符号链接可读写工作区外文件 | 🔬（探针实测读到 outside/secret.txt） |
| P2-26 | `packages/host/browser/src/runtime.ts:262-304` + `pool.ts:222-227` | ledger 恢复自称持锁实际不持锁、不 `reserveTab` → 恢复标签超 maxTabs（实测 3 > 1），并记 `actor:'ai'` 抢 activeTab | 🔬 |
| P2-27 | `packages/host/browser/src/store.ts:233-251` | 幂等书签只改内存不落盘 → 重启后标题/actor 回退 | 🔬 |
| P2-28 | `packages/host/browser/src/runtime.ts:1391-1431` | `clearData` 零标签时静默空操作仍返回 ok；`dispose()` 不释放 tab disposer（下载监听泄漏） | 🔬📖 |
| P2-29 | `packages/host/browser/src/tools.ts:91-101` + `index.ts:247` | 工具 disposer 被丢弃（注释称 effect-scoped）→ 插件 dispose 后 32 个工具仍注册指向已 dispose 的 runtime | 📖 |
| P2-30 | `packages/host/browser/src/electron-adapter.ts:217,299` | `setWindowOpenHandler` 一律 deny，无回退、无 op、无错误 → `target=_blank` 静默失效 | 📖 |
| P2-31 | `packages/host/browser/src/runtime.ts:913-921` + `shots.ts:27-30` | 非活动标签/隐藏窗口 `capturePage` 返回空图且不校验 → screenshot 静默 0 字节 | 📖 |
| P2-32 | `packages/host/browser/src/runtime.ts:1070-1093` | `select` 不校验赋值生效，option 不存在时 value 变 `''` 仍报 ok | 📖 |
| P2-33 | `packages/host/desktop/src/desktop-home.ts:95-102` + `main.ts:246` | 护栏 `dshHomeSafe()` 全仓零调用，启动用未校验的 `resolveDshHome()` | 📖 |
| P2-34 | `packages/host/desktop/src/main.ts:235` | `process.cwd() === '/'` 只识别 POSIX 根，Windows 系统目录被当工作区 | 📖 |
| P2-35 | `packages/host/desktop/src/log-files.ts:78,213` | 日志目录/文件未指定 mode（0755/0644），与同产品其他敏感落盘（0600）不一致 | 📖 |
| P2-36 | `packages/host/connectors/src/user-scope.ts:21-60` | 内联复制 DSH home 常量/解析函数（cron 已改 re-export） | 📖（上一轮 2-12） |
| P2-37 | `packages/host/connectors/src/store.ts:27,98-103`、`enterprise/src/session-service.ts:163` | OAuth token / 会话 token 明文落盘（0600，safeStorage 不可用时） | 📖（上一轮 2-20/2-21） |
| P2-38 | `packages/client/better-sidebar/lib/client.js:2152` | 构建产物内嵌构建机绝对路径（`\0dsh-css:/data/picoaide-harness/...`）随安装包分发 | 📖 |
| P2-38b | `packages/host/browser/src/index.ts:198-199` | `userDataDir` 不可用时浏览器数据落 `<cwd>/.browser-store/<user>`（相对路径），且未被 `.gitignore` 覆盖 | ✅（本次跑 `yarn check` 的 `verify:profile` 后，工作区凭空出现未跟踪的 `packages/host/desktop/.browser-store/{anonymous,profile-smoke}/groups.jsonl`） |
| P2-39 | 品牌几何手抄 4 处：`auth-gate.ts:152`、`enterprise/src/client/Brand.tsx:42-44`、`favicon.ts:16-17`、`client/branding/src/client/Brand.tsx:43-45` | 与"唯一权威 `brands/official/logo.svg`"规则冲突（webadmin 已修，这 4 处未跟随） | 📖（上一轮 2-17 PARTIAL） |

### 3.3 webadmin
| # | 位置 | 问题 | 验证 |
|---|---|---|---|
| P2-40 | `server/webadmin/src/pages/Users.tsx:643` | `quotaUser?.effective_quota_tokens ?? 0 === 0 ? '不限' : …` 按 `??`/`===` 优先级恒为"不限"（实测 500000 → "不限"；0 → "0"） | ✅（上一轮 1.7） |
| P2-41 | `server/webadmin/src/components/transfer-owner-dialog.tsx:216` | `disabled={busy \|\| owner === '' \|\| …}` 未按 `toOfficial` 豁免 → "归属官方"恒不可提交（`transfer()` :97 却允许） | ✅（上一轮 1.8） |
| P2-42 | `server/webadmin/src/pages/Connectors.tsx:434` | `save()` 恒发 `enabled: true`，表单无该字段 → 编辑已禁用连接器会静默重新启用 | ✅ |
| P2-43 | `server/webadmin/src/App.tsx:55-57,185-189,331-336` | nav 只按 section 过滤，声明的 `perms` 从未被读 → auditor 看不到 API 允许的用量/用户页，横幅却说可查看 | 📖 |
| P2-44 | `server/webadmin/src/components/transfer-owner-dialog.tsx:72-83` | render 体内 `setState + void loadUsers('')`（StrictMode 双触发） | 📖（上一轮 2-29） |
| P2-45 | `server/webadmin/src/pages/usage/{Members,MemberDetail}.tsx:75,87,89-90` | 用 `quota_money/quota_tokens` 而非服务端下发的 `effective_quota_*` → 默认配额用户被误报"不限" | 📖（上一轮 2-30） |
| P2-46 | `server/webadmin/src/pages/usage/*.tsx` | 全部缺 `loadSeq` 请求序号守卫（Users/Audit 已有） | 📖（上一轮 2-32） |
| P2-47 | `server/webadmin/src/pages/usage/Quota.tsx:53-54,135-153,344-357` | `setBudgetDept` 只以 null 调用，预算弹窗/saveBudget 永不可达（死代码） | 📖 |
| P2-48 | `server/webadmin/src/pages/Auth.tsx:385` | `auth-secret-${Math.random()}` 每次渲染变化 | 📖（上一轮 2-33） |

### 3.4 CI / 脚本 / 文档
| # | 位置 | 问题 | 验证 |
|---|---|---|---|
| P2-49 | `server/Makefile:20-21` | `test-server` 只枚举 9 包，10 个含 `_test.go` 的包（appstore/archiveutil/brand/capabilities/connectors/reports/router/skillmanifest/telemetry/cmd/server）未跑；注释自称"全部包"（CI 用 `go test ./...` 掩盖） | ✅ |
| P2-50 | `.github/workflows/ci.yml:459-460,503,510` | release 只 hash/上传 AppImage/exe/dmg，**deb 被排除**（实测 v2.6.5 Release 无 deb），与官网"AppImage + deb"宣称不符 | ✅（GitHub API 实测） |
| P2-51 | `.github/workflows/ci.yml:234-246` | E2E 报告/截图 copy 与 e2e 同 step 且在其后，`bash -e` 下失败即跳过 → `always()` 上传为空，与决策文档"失败也留证据"矛盾 | 📖 |
| P2-52 | `packages/host/desktop/scripts/verify-packaged-runtime.ts:437-442` | `filter(exists)` 只在一项都不存在时报错，7 条必需项中 3 条路径不存在 → afterPack 门禁空转 | 📖 |
| P2-53 | `integration-tests/dex/dex-sso-test.py:49,81`、`openldap/ldap-rbac-brand-test.py:49-80` | 仍用已删除的旧命名空间 `/api/auth/*`、`/api/admin/*`、`/api/brand` → 必然 404 | 📖 |
| P2-54 | `integration-tests/dex/dex-sso-test.py:52-53`、`run-all.sh:7` | 首失败分支 `return` 跳过 `sys.exit` + `\|\| echo` → 全挂也退出 0 | 📖 |
| P2-55 | `README.md:60-62`、`README.en.md:60-62` | 下载链接硬编码 2.4.6 于 `releases/latest` → curl 实测 **404**（最新 Release 是 v2.6.5） | ✅ |
| P2-56 | `server/scripts/deploy.sh:366-370,295-304,331-332` | `compose pull \|\| warn` 与 `wait_ready` 超时都只 warn → 拉取/启动失败仍打印"升级完成/部署完成" | 📖 |
| P2-57 | `site/src/content/docs/plugin-development.md:24`（en 同） | 平台模块表含 3 个不存在的 specifier、漏 react/cordis/store/ui-slots（权威 `scripts/platform-modules.mjs:13-22`） | 📖 |
| P2-58 | `site/src/content/docs/faq.md:8`、`architecture.md:52`、`desktop.md:157`；`server/docs/08-development.md:47,64`；`server/docs/03-api-reference.md:27`；`server/README.md:26-29,49-57`；`server/AGENTS.md:80` | 文档事实漂移：pin 写 0.1.1-rc.2（实为 0.1.2-rc.1）、迁移号 0001–0048/0057（实为 0059）、"Linux 不自动下载"（实为下载+chmod+弹窗）、管理端 session 24h（实为 12h+60min 空闲）、`corepack yarn ws`（实跑报错）、README 重复段/漏 05-agent-system.md | 📖 |
| P2-59 | `server/scripts/install-server.sh:42` | 默认 `SERVER_IMAGE=…:latest`，生产一键部署未 pin 版本 | 📖（上一轮 2-39） |
| P2-60 | `integration-tests/electron-shots/electron-shots.mjs:15-20` | 硬编码 `/data/picoaide-harness` 绝对路径 | 📖（上一轮 2-38） |
| P2-61 | `packages/host/desktop/package.json:327-328,409,416,428` | electronFuses 仅 `runAsNode:true`；mac 产物 arm64-only 却叫 `-mac.dmg`；顶层 `win.artifactName` 是 `-Portable`（陈旧误导） | 📖（上一轮 2-22/2-23/2-27） |
| P2-62 | `packages/host/desktop/src/main.ts:205,211,232` + `electron-runtime.ts:327` | `picoaide://` 深链只 `startsWith` 前缀校验即原样转发 | 📖（上一轮 2-25） |
| P2-63 | `packages/host/desktop/src/updates.ts:199-200` | 下载失败一律压成 `'network'`，checksum-mismatch/release-missing 诊断丢失 | 📖（上一轮 2-26） |
| P2-64 | 品牌文案未接 `brands/official/brand.json`：`main.ts:55`、`index.ts:104-105`、`update-checker.ts:4`、`update-download.ts:20` | 产品名/更新源/资产名模板仍硬编码（上一轮 2-28） | 📖 |

### 3.6 `browser_eval` 策略定位与文案不一致（P2，非安全边界）
产品定案是"AI 可操作浏览器所有内容"，但代码与文案仍把自己描述成只读沙箱，二者必须对齐：
- **文案残留 "read-only" 7 处**：`eval-policy.ts:17,146,167,170,178,271`、`runtime.ts:7,948`；工具展示名 `tools.ts:655` `presentCall: 'Evaluate JS (read-only)'`；工具分类 `tools.ts:1112` 仍把 `browser_eval` 归为 `'read'`。模型看到的 `BROWSER_GUIDANCE`（`tools.ts:33`）已改，但工具自身的标签没改。
- **校验器已无实际约束力**：`.constructor`/`Object.values(window)` 可绕过（实测 ALLOWED），而 `delete`（写操作）反而放行；`localStorage.setItem` 被拦但 `fetch` 放行，规则自相矛盾。
- 建议二选一：① 既然 AI 全权操作浏览器，删掉 `validateEvalExpression`（或仅保留"单表达式 + 长度上限"的语法校验），并把上述 7 处文案与 `tools.ts:1112` 分类改成 `write`/`eval`；② 若想保留"防手滑"护栏，就在注释与工具描述里明确写"这是防误用的启发式护栏，不是安全边界"，并同步修掉与 fetch 放行矛盾的分支。

### 3.7 CodeQL 误报说明（不列为 bug）
- JS/TS 5 条 "Improper code sanitization"（`snapshot.ts:144`、`runtime.ts:1101` 等）经核为误报：selector 经 `JSON.stringify` 拼进页面表达式，字符串字面量无法逃逸。
- Go 1 条 "weak cryptographic hashing"（`serverstore/audit.go:39`）为误报：SHA-256 用于审计链防篡改（非口令存储），且 taint 路径来自配置字段而非口令。

---

## 4. P3 —— 低优先（简列）

- 死权限点 `PermRoleAssign`/`PermQuotaWrite`/`PermErrorMonRead` 零路由消费；`TestPermissionsOfRoles` 空转。
- 零引用 i18n 键约 79 条（enterprise `skill.*`/`agent.*`/`session.*`/`capability.tabOrg` 等）+ tray/account-card/connectors/cron 若干。
- `appstore/admin.go:82-88` 官方归属可被 `{"official":false}` 反向改写；`brand.go:332` SVG 实体编码绕过（需 brand:write）；`admin.go:1651-1700` LDAP/OIDC 原始错误回传管理端；HTML 面零安全头；`balance.go:66` 无 LimitReader。
- webadmin flash `setTimeout` 未清理、纯图标按钮缺 `aria-label`、`total - 1` 假设仅一名超管、约 166 处 `any`。
- `release-mac.ts:146` `resolve(desktopRoot,'..','..')` 实为 `packages/` 而非注释的仓库根。
- `packages/host/browser/src/tools.ts:238-268,747-753,1047-1056` 单池后残留的 group 死字段；`snapshot.ts:13,118` `snapshotLimit` 被硬编码夹到 200；`shell-pages.ts:561-574` 菜单项连发两个 POST 顺序无保证；`runtime.ts:210-212,366` `noteAgent` 在取锁前写全局 `lastAgentId`。
- `integration-tests/electron-shots.mjs:85-114` 无断言；`server/scripts/mock-upstream.go:5 vs :30` 位置参数不生效；`verify-win-installer.ts:93-95` 硬编码资产名；`notary-probe.yml:33,47` `|| echo` 吞错。

---

## 5. 与 origin/master 的差异（本地落后 5 个提交）

`git fetch` 后本地落后 `origin/master` 5 个提交（v2.6.7-beta.11）：

| 提交 | 内容 | 本次核查结论 |
|---|---|---|
| `4be2da019f` | `feat(browser): allow network-outbound APIs in browser_eval (drop fetch ban)` | 产品决策（commit 记录为用户拍板），**不再算 bug**；但见下方两个技术残留 |
| `9497adb86d` | account-card 用户名/登出移到卡片底部 | 纯布局，未见缺陷 |
| `b81b62d174` | memory-evolve 采纳技能 EBUSY/EPERM/EACCES 回退 + 拒绝覆盖已存在技能 | 逻辑正确；回退路径 `rmSync(to)` 前已校验 `SKILL.md`，未见数据破坏 |
| `11a3e736b0` / `b624840e62` | 版本号 beta.11 + 合并 | — |

**beta.11 之后该区域的两个待办（2026-09-08 按产品定位修正口径）**：
1. **真 bug（已改列 §2 #20）**：`browser_eval` 放开 fetch 后仍是 `awaitPromise: false`（`runtime.ts:939`）。真机 CDP 实测：`fetch(location.href).then(r => r.status)` 在 `awaitPromise:false` 下返回 `{}`，在 `true` 下返回 `200`；`Promise.resolve(42)` 同理（`{}` vs `42`）。也就是说 AI 能发请求但**读不到任何响应**，与"AI 可操作浏览器所有内容"和工具描述"returns its JSON result"矛盾。修：`awaitPromise: true`（配合已有 10s page timeout，另建议给 CDP 传输加超时，见 P0-4）。
2. **定位/文案（§3.6）**：`.constructor` 绕过不再是安全缺陷（产品已定 AI 全权操作浏览器），但校验器与"read-only"文案必须与定位对齐，否则模型与维护者都会被误导。

> 建议先把本地更新到 `origin/master`（`git pull --ff-only`）再开始修，避免在 beta.10 上修完再冲突。

---

## 6. 上一轮审计（docs/AUDIT-2026-09-06-FULL.md）状态复核

- **P1 11/11 全部仍 OPEN**（1.1–1.11）：本报告已逐条纳入 §2（1.1→#15、1.2→#16、1.3→P2-15、1.4→#5、1.5→#17、1.6→#6、1.7→P2-40、1.8→P2-41、1.9→#7、1.10/1.11 见下）。
- 1.10 桌面 CSP 注释夸大（`electron-runtime.ts:632-635` 与 `:653,657`）与 1.11 回环路由只验 Origin 无 Host 校验（`desktop-update-route.ts:22,38`、`loop-notify-route.ts:27`、`directory-picker-route.ts:20`、`renderer-boot.ts:62`）**仍 OPEN**，归入 P2。
- **P2 40 条：36 OPEN、1 PARTIAL（2-17 品牌几何，webadmin 已修/另 4 处未修）、2 FIXED（2-31 用量中心 `?user=` 深链、2-37 CI PG 服务）、1 STALE（2-19 审批 JSDoc 已随 v4 重写删除）**。
- 完整逐条状态表（含 file:line 与证据）见 `docs/AUDIT-2026-09-06-FULL.md` 的复核输出，本次未重复抄录。

---

## 7. 建议修复顺序（Top 12）

1. **P0-1** E2E 假绿（一行修复，立刻恢复门禁可信度）。
2. **P0-2** OIDC 全局限流桶 + P1-#3 登录成功计数（SSO 可用性 / 账号锁死）。
3. **P0-4 + P0-5 + P1-#20 + P1-21/22/23** 浏览器批次（CDP 挂死 / 下载守卫 disposer / eval 放行后读不到结果 / 后台节流 / 关窗后被弹回前台 / 启动即启动），一次提交一起补回归测试。
   - `backgroundThrottling: false` 与 `ensureWindow({show:false})` 是两行级改动，但直接决定"关掉前台后 AI 是否真能正常后台操作"。
4. **P1-#1** IdP 密钥改 `util.Encrypt`（并加迁移解密读取）。
5. **P1-#2** `main.go` 把 `mountAPIGuards`/`r.Use` 提到 `router.Register` 之前。
6. **P1-#4** LDAP 同步停用范围加 provider 归属列。
7. **P1-#8/#9** 模型删除与 Anthropic cache 计费（真金白银）。
8. **P1-#15/#16 + P2-10 的账本口径**（1.1/1.2/跨保留期）——错误报表会误导决策与预算。
9. **P1-#12/#13** 崩溃回退循环 + 会话持久化 fail-loud 退出应用。
10. **P1-#14** deploy.sh 空超管密码（生产重装即挂）。
11. **P1-#6/#7** 两处 XSS（title / auth-gate `m.name`）。
12. **P2 批次**：P2-40/41/42（webadmin 三个小逻辑 bug）、P2-49/50（Makefile 漏包 + deb 不发布）、P2-55（README 404）。

---

## 8. 方法与证据索引

- 门禁：`corepack yarn check`、`cd server && make check`（`GOMODCACHE/GOPATH/GOCACHE` 指向 `temp/`，`PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/picoaide_test`）。
- 客户端 E2E：`DISPLAY=:99 corepack yarn workspace dsh-plugin-desktop e2e:client`（HEAD 重新 `package:dir` 后跑，13/13；假绿复现见 P0-1）。
- 真机浏览器 E2E：`DISPLAY=:99 node temp/browser-v4.2-e2e.mjs`（真实服务器 + `import -window root` 合成截图，22/22）。
- CodeQL：`temp/codeql-0908/run.sh`（JS/TS `js-results.csv` 125 条、Go `go-results.csv` 2 条）。
- 探针：`temp/audit4/`（浏览器：eval 逃逸、CDP 挂死、守卫计数、配额、书签、ops 泄漏）、`temp/audit-electron/`（e2e 假绿、崩溃回退、未捕获 rejection、用量跨会话泄漏、符号链接逃逸、i18n）、`temp/audit-ledger`/`temp/routeaudit`/`temp/audit-sa`/`temp/auditprobe`（服务端 Go overlay 测试）、`temp/audit-verify/`（上一轮 P1/P2 复核）、`temp/e2e-repro/`、`temp/deploy-repro/`。
- 全部探针均在 `temp/`（gitignored），未改动任何受版本控制文件；`git status` 仅原有未跟踪的 `docs/AUDIT-2026-09-06-FULL.md` 与本报告。

---

## 9. 拉取最新代码后的复验（2026-09-08，HEAD `b624840e62` = v2.6.7-beta.11）

**拉取**：`git pull --ff-only`，`b9f8df59f6`（beta.10）→ `b624840e62`（beta.11），5 个提交：
`4be2da019f` browser_eval 放开网络 API（产品决策）· `9497adb86d` account-card 布局 · `b81b62d174` memory-evolve EBUSY 回退 · `11a3e736b0` 版本号 · `b624840e62` 合并。

**新 HEAD 门禁重跑**：`corepack yarn check` ✅（browser 168 测试，比 beta.10 多 6 条；cron 111）· `cd server && make check` ✅（Go 全量 + webadmin 109 + vite build）。

**结论：本次拉取没有修掉任何一条报告中的 bug。** 4 条 P0、20 条 P1（其中 #20 为本次按产品定位重新核实的真 bug）全部仍在；抽查的 P2 全部仍在。逐条复验证据（新 HEAD 行号 + 复现）：

| 编号 | 新 HEAD 状态 | 复验证据 |
|---|---|---|
| P0-1 E2E 假绿 | **仍存在** | `e2e-client.mjs:346`（catch 只 console.error）、`:365-367`（按 `failed.length` 判退出码）；stub app 复现仍为 `E2E 结果：全部通过 / EXIT_CODE=0` |
| P0-2 OIDC 全局限流桶 | **仍存在** | `serverauth/oidc.go:270` `loginAllowed(c, "oidc-callback")`；`ratelimit.go:118` `allow("u:"+username)` |
| P0-3 eval 构造器逃逸 | **已改判（非 bug）** | 产品定案：AI 可操作浏览器一切内容，任意 JS/fetch 为预期能力；`.constructor` 绕过（探针仍 ALLOWED）不再计缺陷。该区域真 bug 见 §2 #20（`runtime.ts:939` `awaitPromise:false` → fetch 结果 `{}`，真机 CDP 实测）与 §3.6（文案/定位） |
| P0-4 CDP 挂死锁死工具面 | **仍存在** | `cdp.ts:53` 无超时透传；`pool.ts:59` `await prev` 不接 signal；探针重跑 `busy flag released after the aborted tool → isBusy=true`、`navigate ... HUNG` |
| P0-5 下载守卫 disposer | **仍存在** | `guard.ts:130` `if (this.guardedSessions.has(session)) return () => {}`；探针重跑 `closing the first tab → listeners=0`、`downloads=0 setSavePath=[]` |
| P1-1 IdP 密钥明文 | **仍存在** | `serverauth/admin.go:1237,1247,1253` 仍直接 `upsert(...)`，无 `util.Encrypt` |
| P1-2 中间件顺序 | **仍存在** | `main.go:117` `gin.New()` → `:157` `router.Register` → `:195` `mountAPIGuards`（`:379` 才 `r.Use`） |
| P1-3 限流成功也计数 | **仍存在** | `ratelimit.go:93` `l.attempts[key] = append(kept, now)`；`handler.go:158` 认证前调用 |
| P1-4 LDAP 同步停用 OIDC 用户 | **仍存在** | `dirsync.go:197,204` + `oidc.go:187` `Source: "external"` |
| P1-5 LDAP-only 可绕过 | **仍存在** | `config.go:72-74` 恒注册 local；`handler.go:295` `order := []string{"ldap", "local"}` |
| P1-6 门户 title XSS | **仍存在** | `main.go:289` `<title>` + loginName |
| P1-7 auth-gate XSS | **仍存在** | `auth-gate.ts:243` `data-method="' + m.name + '"` |
| P1-8 删模型仍可调用 cost=0 | **仍存在** | `gateway.go:557` `DeleteModel` 只删 models 表；`upstream.go:132` `mergeModelNames(u.Models, synced)` |
| P1-9 Anthropic cache 少计费 | **仍存在** | `messages.go:70` `cache = u.CacheReadInputTokens`（`CacheCreationInputTokens` 仍只解析不用）；`usage.go:167` clamp |
| P1-10/#16 账本分组/丢历史 | **仍存在** | `usage_ledger.go:280-281` 默认 `usage_monthly/"month"`、`:287,312` |
| P1-11 agent preset legacy reject | **仍存在** | `agentshare/routes.go:198-199` name 级 approve/reject 仍走 `GetAgentPreset`（`:65,134` = 最高 approved 版本） |
| P1-12 崩溃回退循环 | **仍存在** | `electron-runtime.ts:812` `void window.loadURL(current)` |
| P1-13 persist 无 catch | **仍存在** | `session-service.ts:96` `void persist(this.tokenFile, session)` |
| P1-14 deploy.sh 空超管密码 | **仍存在** | `deploy.sh:64` 白名单仍含 `PG_PASSWORD` 不含 `PICOAI_ADMIN_PASSWORD` |
| P1-15 部门重复计数 | **仍存在** | `usage_dept.go:183` `seen` 仍在 `for rows.Next()` 内 |
| P1-17 auditor 旧 token | **仍存在** | `token.go:56` 仅查 Status；`admin.go:845` 仅 role→user 吊销 |
| P1-18 cookie 未脱敏 | **仍存在** | `eval-policy.ts:313` `maskString`；探针重跑 cookie 原样返回 |
| P1-19 ops 跨用户泄漏 | **仍存在** | `runtime.ts:586,597` 只 push/裁剪，切换用户不清空；探针重跑 `ops=3` |
| P2-40/41/42/49/50/55/38b | **仍存在** | `Users.tsx:643`、`transfer-owner-dialog.tsx:216`、`Connectors.tsx:434`、`Makefile:20-21`、`ci.yml:459,505,510`（release 仍只 AppImage/exe/dmg）、`README*.md` 各 3 处 2.4.6、`browser/src/index.ts:199` 相对 cwd 回退（本次跑 `yarn check` 又生成未跟踪的 `packages/host/desktop/.browser-store/`） |

**唯一的行为变化（预期，不算修复）**：beta.11 把 `fetch/XMLHttpRequest/WebSocket/EventSource/sendBeacon/postMessage` 移出 `WRITE_APIS`，因此探针第一例 `window["fetch"](...)` 从 REJECTED 变 ALLOWED——这是提交说明里的产品决策。按 2026-09-08 产品定案（AI 可操作浏览器所有内容），`.constructor` 绕过随之改判为非缺陷（§3.6），但**"放行了却读不到结果"是真 bug**：`runtime.ts:939` `awaitPromise: false` 让 fetch/async 结果恒为 `{}`（真机 CDP 实测：false→`{}`，true→`200`），见 §2 #20。

---

## 10. 浏览器生命周期专项核查（"客户端启动即启动 / 关窗后 AI 后台仍可操作"）

**目标（用户 2026-09-08 定案）**：CDP 一直监听；客户端启动即启动浏览器；用户点关闭只是关掉前台显示，后台 AI 继续正常操作。

**真机实测**（HEAD `b624840e62`，Electron 43 / Chromium 150，探针 `temp/audit-0908-browser-lifecycle.mjs`、`-lifecycle2.mjs`、`-tab-throttle.mjs`）：

| 场景 | 实测结果 | 与意图 |
|---|---|---|
| 客户端启动后、未做任何浏览器操作 | `window.created=false visible=false tabs=0` | ❌ 浏览器根本没启动（懒启动） |
| AI 首次 `browser_open` | `created=true visible=true tabs=1` | ⚠️ 用时才起，且直接把窗口显示出来 |
| 用户点浏览器窗口的 X | adapter 把 `close` 拦成 `hide`（`electron-adapter.ts:374-380`）：`created=true visible=false tabs=1`，CDP 仍能读到 `document.URL` | ✅ 符合意图（前台关、后台活） |
| 隐藏状态下 AI `navigate` / `eval` | 成功 | ✅ |
| 隐藏状态下 AI 新开标签 | `visible` **false → true**（窗口被强行弹回前台） | ❌ 违背意图 |
| 非活动标签（窗口可见、该 view `setVisible(false)`）页内定时器 | 3s 内 `setInterval(100ms)` 计数 **3**（活动标签 30）；切为活动后恢复 30 | ❌ AI 操作后台标签被限速 10× |
| 隐藏窗口内标签的页内定时器 | 30 → **3**（同样 10× 节流） | ❌ 后台操作被限速 |
| `browser_wait_for` 轮询 | 主进程循环（`runtime.ts:1443-1470`），不经过页面定时器 | ✅ 不受节流影响 |

**新增 P1（3 条）**

| # | 位置 | 问题 | 影响 | 修复 |
|---|---|---|---|---|
| P1-21 | `packages/host/browser/src/electron-adapter.ts:207-215`（`createView`）、`:357-372`（`createBrowserWindow`） | 两处 `webPreferences` 都没有 `backgroundThrottling`，Chromium 默认 `true` → 非活动标签与隐藏窗口的页面定时器被压到 1 次/秒（实测 30→3），长时间后台（约 5 分钟）进一步降到 1 次/分钟 | AI 在后台标签/关窗后驱动的页面（SPA 轮询、防抖、自动保存、动画、长任务）行为变慢或异常；"后台正常操作"实际是"后台降速操作" | 两处 webPreferences 加 `backgroundThrottling: false`（mask 视图可选加）；或运行时 `webContents.setBackgroundThrottling(false)` |
| P1-22 | `packages/host/browser/src/runtime.ts:519-523` | `ensureWindow()` 在窗口已存在时无条件 `this.window.show()`；它被 `createTabReal`（`:371`）与 `showWindow`（`:568`）调用 | 用户刚点 X 关掉浏览器，AI 一开新标签（或重启后物化 ledger 标签）就把窗口弹回前台，抢焦点 | `ensureWindow({ show: false })` 作为 AI 路径默认；只有用户路径（shell `show` 动作、用户 `open`）才 `show()`；窗口可见性持久化进 ledger，重启后恢复原状态 |
| P1-23 | `packages/host/browser/src/index.ts:205-222` | 插件 apply 只 `restoreLedger()`，窗口/视图/CDP 全懒建（`ensureWindow` 仅由 `showWindow`/`createTabReal` 触发） | "客户端启动即启动浏览器"未实现：启动后 `created=false`，直到第一次 AI/用户操作才有浏览器；CDP 自然也没有"一直监听" | apply 末尾预热：创建窗口（不显示）+ 物化 ledger 标签 + attach CDP；新增 `startAtBoot`/`startHidden` 配置（当前 `Config` 无此字段） |

**相关 P2**：CDP 是 per-tab attach（`createTabReal` 内 `cdp.attach()`），标签销毁即 detach；`closeAll()`（登录切换/清除）与真窗口 close（`runtime.dispose()`、系统销毁窗口）会销毁全部标签 → 后台作业中断（用户 X 关窗这条路已正确保留）。重启后 ledger 标签要到首次操作才物化（`resolveTab`→`materializePendingTabs`，`runtime.ts:617,267-304`），而该物化自称"在互斥锁下"实际未持锁、也不 `reserveTab`（见 P2-26），并顺带触发 P1-22 的弹窗。

**✅ P1-21 / P1-22 / P1-23 已于 2026-09-08 修复并真机复验，见 §11。**

---

## 11. 修复记录（2026-09-08）

**用户定案**：① "启动即启动" = 创建窗口但**保持隐藏**；② 登录切换 / 退出登录**允许**销毁后台标签。

**改动（6 文件，+134/−16）**

| 文件 | 改动 |
|---|---|
| `packages/host/browser/src/electron-adapter.ts` | `createView` / `createMaskView` / `createBrowserWindow` 三处 `webPreferences` 加 `backgroundThrottling: false`；`BrowserWindow` 由 `show: true` 改 **`show: false`**；`createRealElectronAdapter(electronModule?)` 支持注入 Electron 以便单测（生产路径仍懒 `require('electron')`） |
| `packages/host/browser/src/runtime.ts` | `ensureWindow(origin?, show = false)` —— 只有显式 `show` 才显示窗口；`createTabReal` 传 `actor === 'user'`（用户建的标签才弹窗）；`showWindow()` 传 `true`；新增 `prewarm()`（建窗+物化恢复标签+CDP，永不显示） |
| `packages/host/browser/src/index.ts` | 插件 apply 末尾 `runtime.prewarm()`（启动即起、隐藏）；`pico/session-changed` 在 `closeAll` → 换 partition/store 后再次 `prewarm()` |
| `packages/host/browser/src/client/BrowserTrigger.tsx` | 注释同步为"启动即创建、隐藏；按钮显示；关窗仅隐藏" |
| `packages/host/browser/tests/runtime.spec.ts` | 3 个生命周期用例：agent open 不弹窗 / 用户 open 弹窗且 hide 保留 / prewarm 隐藏且恢复标签不弹窗 |
| `packages/host/browser/tests/electron-adapter.spec.ts`（新增） | 3 个用例：三个视图/窗口 `backgroundThrottling === false`、窗口 `show === false`、用户 close 被拦成 hide |
| `packages/host/desktop/scripts/e2e-client.mjs` | 修 P0-1：致命错误写入失败步骤并 `exitCode=1`；CDP 目标选择排除 `/browser-shell`、`/browser-overlay`（否则 prewarm 后 e2e 会连到浏览器页面） |

**真机复验（同一打包产物，Electron 43 / Chromium 150）**

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 客户端启动后 | `created=false` | **`created=true visible=false`** |
| 重启后恢复标签 | 首次操作才物化并弹窗 | **`created=true visible=false tabs=1`**（恢复走 AI 路径，不弹窗） |
| 非活动标签 3s 定时器计数 | 3 | **30** |
| 隐藏窗口内 3s 定时器计数 | 3 | **30** |
| 用户点 X 关窗 | hide、标签/CDP 存活 | 不变（hide、标签/CDP 存活） |
| 用户路径 `open` | 弹窗 | 弹窗（预期） |
| `e2e:client` + 假 app | 打印「全部通过」exit 0 | **「1 项失败」exit 1** |
| `e2e:client` + 真 app | 13/13（但目标选择脆弱） | **13/13，exit 0** |
| 真机浏览器 E2E（真实服务端） | 22/22 | **22/22** |
| 门禁 | `yarn check` 绿 | **`yarn check` 绿**（browser 测试 168 → 173） |

**仍开放**：P0-2（OIDC 限流全局桶）、§2 全部 20 条 P1、以及 §3/§4 的 P2/P3。§10 的 P2（CDP per-tab、`closeAll` 销毁标签、`materializePendingTabs` 未持锁/不占配额）按定案②保持不变，仍建议后续加锁与配额。

---

## 12. 修复记录（第二批：P0-4 / P0-5，2026-09-08）

| 文件 | 改动 |
|---|---|
| `packages/host/browser/src/cdp.ts` | 新增 `CDP_CALL_TIMEOUT_MS = 30_000` 与 `CdpSessionOptions.timeoutMs`；`send()` 支持每调用 `{ timeoutMs, signal }`，用 `withTimeout()` 把 transport promise 与超时/abort 竞速 —— 渲染器卡死时**本地拒绝**而不是永远挂着 |
| `packages/host/browser/src/runtime.ts` | `new CdpSession(..., { timeoutMs: this.options.timeoutMs })`（每个 CDP 命令受工具预算约束）；下载 op 归属改为触发时的活动标签（下载本身无标签身份） |
| `packages/host/browser/src/pool.ts` | 互斥锁 `await prev` 改为 `raceAbort(prev, gate, signal)`：排队的操作可被取消；用户接管时 abort 仍报 `window-controlled`，否则报 `interrupted` |
| `packages/host/browser/src/guard.ts` | 下载守卫由 `WeakSet` 改为 **`WeakMap<session, {refs, context, dispose}>` 引用计数**：关掉某个标签只释放它那一份，最后一个标签释放时才摘监听；recorder 上下文（actor/record/dir）取"最近一次注册"，修掉"永远算在第一个标签头上" |
| 测试 | `cdp.spec.ts` +3（超时/abort/迟到回复不重复 settle）、`pool.spec.ts` +2（排队中取消、已 abort 立即拒绝）、`guard.spec.ts` +1（引用计数：关第一个标签后仍拦截，最后一个才摘）、`runtime.spec.ts` +1（挂死 CDP 超时后互斥锁释放、后续操作正常） |

**真机验证（重新打包后）**

| 项 | 结果 |
|---|---|
| 下载守卫（P0-5） | 开 2 标签 → 关掉第 1 个 → 在剩余标签触发下载 → **1 条记录 `status=done`、文件落盘、`actor=user`**（修复前监听被摘、无记录） |
| 正常 CDP 操作无回归（P0-4） | `e2e:client` 13/13、真机浏览器 E2E（真实服务端）22/22 |
| 单元/门禁 | browser 包 173 → **180** 测试；`yarn check` 绿 |

**仍开放**：P0-2（OIDC 回调占全局限流桶，SSO 可用性）、§2 二十条 P1（IdP 密钥明文、gin 中间件顺序、登录限流成功也计数、删模型仍可调用 cost=0、Anthropic cache 少计费、账本口径…）、§3/§4 的 P2/P3。


---

## 13. 全量修复记录（2026-09-08 第二轮：剩余全部条目）

**范围**：本报告 §1 全部 P0、§2 全部 20 条 P1、§3/§4 全部 P2/P3，以及 §6 引用的上一轮审计遗留项。
**规模**：209 文件修改 + 32 新增（+5400/−1257），新增/改写测试约 90 个用例。

### 13.1 安全批次（P0-2 + P1-1/2/3/4/5/6/7/17 + P3）

| 条目 | 改动 | 验证 |
|---|---|---|
| P0-2 OIDC 回调占全局限流桶 | `oidc.go:270` 改用独立 IP 桶 `oidcCallbackAllowed/Failed/Succeeded`（`ratelimit.go`，60 次/5 分钟，仅失败计数） | `TestOIDCCallbackBucketIsIndependent` |
| P1-1 IdP 密钥明文落库 | 新增 `serverauth/secrets.go`（AES-GCM + `enc:v1:` 前缀 + 历史明文兼容）；`admin.go` 写入加密、`ldap.go`/`oidc.go`/测试连接解密 | `TestAdminAuthConfig` 断言落库为密文且可解回；`secrets.go` 单测 |
| P1-2 中间件装在路由之后 | 抽出 `installAPIMiddleware()`，在 `gin.New()` 后、`router.Register` 前调用；`mountAPIGuards` 只留 NoRoute | `TestAPIJSONContract/panic_recovers_to_JSON`（测试改为生产顺序，红→绿） |
| P1-3 登录限流成功也计数 | `loginLimiter` 拆 `allow`（只检查）/`record`（失败）/`reset`（成功）；handler/admin/oidc 三处接线 | `TestLoginLimiterCountsFailuresOnly`、`TestLoginLimiterNoEvictionBelowCapacity`（改写） |
| P1-4 LDAP 同步停用 OIDC 用户 | 新增迁移 `0060_ldap_synced_users.sql` + DAO；同步记录 LDAP 见过用户名，停用只针对该集合 | `TestSyncDirectoryDoesNotDeactivateOIDCUsers` |
| P1-5 LDAP-only 可被本地密码绕过 | `clientPasswordOrder()` 按 `auth.enabled` 决定客户端可用方式（local 仍保留给管理后台） | `TestClientPasswordOrderRespectsEnabled` |
| P1-6 门户 `<title>` XSS | `htmlEscape(loginName)`；删除死 payload；补 CSP/nosniff/Referrer-Policy/X-Frame-Options | `TestPortalEscaping`（品牌名含 `<script>` 时转义 + 安全头） |
| P1-7 auth-gate `m.name` XSS | 方法与文案一律 `esc()`；模板改为插值 `brandMarkSvg` | `auth-gate-login.spec.ts` 新增转义用例 |
| P1-17 角色变更不吊销 token | `demote` 条件改为"任何角色变更" | `TestAdminRoleChangeRevokesTokens`（user↔auditor 两向） |
| P3 | 测试连接错误脱敏（原始 LDAP/OIDC 错误只进日志）、删除零消费权限点 `role:assign`/`quota:write`/`error-monitoring:read`、旧前缀注释全量修正、`server/AGENTS.md` 迁移号 0060 | gofmt/vet/全量 Go 测试 |

### 13.2 服务端数据与计费（P1-8/9/10/11/15/16 + §3.1 全部 P2）

| 条目 | 改动 | 验证 |
|---|---|---|
| P1-8 删模型仍可调用 cost=0 | `DeleteModel` 事务内同步移除 provider JSON 名；**追加**：渠道同步 `RemoveMissingProviderModels` 与 `UpdateModel` 改名同样同步 provider JSON | `TestDeleteModelRemovesUpstreamRoute`、`TestRemoveMissingProviderModelsStripsProviderJSON`、`TestUpdateModelRenameSyncsProviderJSON` |
| P1-9 Anthropic cache 少计费 | prompt = input + cache_read + cache_creation；去掉错误的 clamp | `TestMessagesBillsCacheCreation`（6.14e-4）、`TestRecordUsageAnthropicCacheBilling` |
| P1-10 账本跨保留期丢历史 | 账本段 [from, cutoff) + 明细段 [cutoff, to] **相加** | `TestUsageAggregateWithLedgerSumsAcrossRetention`（330） |
| P1-11 legacy 审核打错版本 | 新增 `GetAgentPresetForReview`（最高非 approved 行） | `TestLegacyRejectTargetsLatestPending` |
| P1-15 祖先重复计数 | `seen` 按 uid 持有 | `TestDeptGroupingSharedAncestorCountedOnce` |
| P1-16 账本 group=model 按月合并 | 统一按 `usage_daily` 归并（model/week/day/month 各自正确） | `TestUsageAggregateWithLedgerModelAndWeek` |
| P2-1 审计链并发分叉/断锚 | 事务 + `pg_advisory_xact_lock`；清理保留锚；Verify 兼容锚起点 | `TestAuditHashChainConcurrent`（去锁即红）、`TestPurgeOldAuditLogsKeepsAnchor` |
| P2-2 迁移无锁 | 专用连接持 `pg_advisory_lock` | `TestApplyMigrationsConcurrent`（去锁即红） |
| P2-3 Publish 无事务 | 新增 `UpsertAppAndCreateRelease` 单事务 | `TestUpsertAppAndCreateReleaseAtomic` |
| P2-4 报表 last_run_at | 失败也写 `last_run_at` | `TestMarkReportRunFailureRecordsLastRunAt` |
| P2-5 日界 | `beijingDay`（UTC+8） | `TestUserDayUsageCostBeijingDayBoundary` |
| P2-7 部门 `IN(?)` 超 6.5 万参数 | 改 `= ANY(?::bigint[])` / 子查询 | `TestUsageAggregateManyMembersArrayParam`（66001 成员） |
| P2-9 版本比较相反 | 统一 `skillmanifest.CompareVersions` | `TestCurrentReleasePrereleaseOrder` |
| P2-10 版本删除清空 name 授权 | 仅当无其它未删版本时清理 | `TestDeleteVersionKeepsGrantsWhileOthersRemain` |
| P2-11 归档重复条目 | 服务端 + 客户端双双拒绝（含大小写碰撞） | `TestRejectsDuplicateEntries`、`archive-util.spec.ts` |
| P2-15 分区裁剪失效 | 去掉 `AT TIME ZONE` 包裹（`DateCompareExpr` 删除） | `TestUsageRangePredicatePrunesPartitions`（EXPLAIN 证据） |
| P2-18 同步覆盖 default_params | ON CONFLICT 只更新 display_name | `TestSyncProviderModelPreservesDefaultParams` |
| P2-21 官方归属被改写 | `{"official":false}` 400；官方 App 发版 owner 恒空 | `TestTransferOwnerOfficialFalseRejected`、`TestPublishKeepsOfficialOwnership` |
| **P2-7(DDL 热路径)** | `ensureUsagePartition` 改为 `to_regclass` 目录探测（仅缺失时建分区），去掉每写 DDL | serverstore 全量测试绿 |
| **P2-10(可见性 N+1)** | 新增 `ListReleasesByKind` 一次取回后分组，替代逐 App 查询 | appstore/serverstore 测试绿 |
| **P2-11(流式正常 EOF)** | 上游正常结束但无 usage 时也清除 pending 行（OpenAI + Anthropic 两路） | `TestProxyStreamNormalEOFWithoutUsageCleansPendingRow` |
| P2-6/8/17/19/20 | 配额成员一次查询、流式 1MB 单行上限、路由统一 1MB 请求体上限（含豁免表）、报表 webhook SSRF 防护+禁 302、遥测双桶限流 | 各自测试（B2 批次报告） |
| P2-13 死字段 | 删除 `/auth/usage` 的 `dept_budgets`（客户端从不渲染，服务端不再白算） | `handler_test.go` 断言已移除 |
| P3 | brand SVG 实体编码绕过、balance 响应 LimitReader、`Makefile test-server` 覆盖全部包、文档漂移（迁移号 0060/README/会话时长/yarn workspace） | 各自测试与 grep 自检 |

### 13.3 桌面 / 浏览器 / 客户端插件（§2 P1-12/13/18/19/20 + §3.2 全部 P2 + §10 P2）

| 条目 | 改动 | 验证 |
|---|---|---|
| P1-12 崩溃回退无限循环 | 删除 did-finish-load 自动回跳，错误页按钮显式跳转 | `electron-runtime.spec.ts` |
| P1-13 persist 无 catch | `.catch(logger.warn)` 降级 | `session-service.spec.ts`（0 unhandledRejection） |
| P1-18 cookie 未脱敏 | `looksLikeCookieString` 整体脱敏 | `audit-0908.spec.ts` |
| P1-19 ops 跨账号泄漏 | `clearOps()` 切用户清空 | 行为测试 |
| P1-20 fetch 读不到结果 | `awaitPromise: true` | mock CDP 断言取到 `42` |
| §3.6 文案/定位 | 移除全部 "read-only" 残留，`browser_eval` 归类 `write`，描述写明"启发式护栏、非安全边界" | grep + 注册表测试 |
| P2-22 账户卡跨会话泄漏 | epoch + AbortController + 路由绑定 username/serverURL | `usage-binding.spec.ts` |
| P2-23 connectors 双 restore | `runLifecycle` 队列 + epoch；`registerMcp` 先释放同 key | `lifecycle.spec.ts`（回退即红） |
| P2-24 通知跳转不消费 | GET 即消费 + sessionStorage | plugin/client spec |
| P2-25 符号链接逃逸 | `isWithinReal`（realpath + 拒绝最终 symlink） | `fs-tree-symlink.spec.ts` |
| P2-26 ledger 恢复 | `withOperation` + `tryReserveTab` + actor `'restore'` | spec（maxTabs=1 只物化 1） |
| P2-27 书签不落盘 | 命中分支 rewrite | spec |
| P2-28 clearData/dispose | 零标签走 `getSession`；dispose 释放 disposer | spec |
| P2-29 工具 disposer | 归入 `ctx.effect` | spec |
| P2-30 window.open | 转新标签 + op 记录 | spec |
| P2-31 空截图 | 空图抛错 + failed op | spec |
| P2-32 select 校验 | 赋值后比对 | spec |
| P2-33/34/35 | `dshHomeSafe()` 接线、Windows 判根 + 系统目录、日志 0700/0600 | desktop-home/log-files spec |
| P2-36 | connectors home 常量改 re-export | 构建内联 + spec |
| P2-38b | 浏览器 store 落 `$DSH_HOME` + `.gitignore` | 源码断言 |
| P2-39 | **branding + enterprise 两侧**均改引用 `brand-geometry.ts` 单一常量 + 解析 `logo.svg` 的漂移测试（favicon/Brand/auth-gate 三处） | `brand-geometry.spec.ts` ×2、favicon/auth-gate spec |
| P2-61/62/63/64 | fuses 补 `onlyLoadAppFromAsar`（`runAsNode` 保留，stdio MCP 需要）、深链严格解析+白名单、下载失败原因细分、更新源常量单点 | deep-link/updates/package spec |
| P3 | browser group 死字段/limit 注入/菜单单次有序 POST/归属还原；i18n 死键清理 26 条 + 断言；better-sidebar 产物绝对路径 + `check:build-paths` | 各包 check |
| **2-14(遗留)** | cron `applyRequest` 指纹缓存移到全部校验之后（越权重试不再被吞） | `records the idempotency fingerprint only after the owner check passes` |
| **2-18(遗留)** | enterprise `startBrandStore` 只调用一次 | enterprise check |
| **2-40(遗留)** | error-reporting 三条 console.log → `ctx.logger.debug` | error-reporting spec |
| **2-24(遗留)** | `mac-runtime.ts` 新增 `resolveNativeEntry`（sharp/libvips 文件名按目录解析，版本升级不再断打包） | 消费者改用 + mac 相关 spec 全绿 |
| **P3(遗留)** | `release-mac.ts` 仓库根上溯 3 级（此前 2 级到 `packages/`） | release-mac spec（期望值同步修正） |

### 13.4 webadmin / CI / 文档（§3.3、§3.4、§4）

- webadmin 20 项：配额显示、归属官方按钮、连接器静默启用、导航按 `permissions` 过滤（新增 `lib/nav.ts`）、render 体副作用、`effective_quota_*`、`loadSeq`、死代码、`useId`、`use-flash` 定时器清理、aria-label、`total-1`、SQLite 死分支、tab 与 URL 同步、静默 catch 等（`npm test` 128 通过）。
- CI：release 补 `*.deb`（含 SHA256SUMS 与上传清单）、E2E 报告/截图拆 `if: always()`、`verify-packaged-runtime` 逐条真实路径断言、集成测试迁移到新命名空间并修正退出码、`deploy.sh` 失败即非零退出、`install-server.sh` 对 `:latest` 显式告警、`mock-upstream` 位置参数生效、`notary-probe` 去吞错。
- 文档：README 下载链接（404→200）、DSH pin 0.1.2-rc.1、Linux 自动下载、deb 资产名、`.env` 6 键、平台模块表、MFA 状态、e2e fixture 路径表、迁移号 0060、`integration-tests/README`、desktop README/THIRD_PARTY_NOTICES。

### 13.5 未修/降级项（附理由，均非缺陷或属特性/契约风险）

| 项 | 处理 |
|---|---|
| mac 资产名 `-mac.dmg`（arm64-only） | 未改名：该名是更新器资产契约（`update-download.ts` + CI release + verify-mac-*），改名会断已发布客户端的升级链 → 需单独发布计划（改产 universal 或双资产名） |
| 品牌参数化（brand.json 驱动 appId/产品名/更新源/资产名） | 未做：`docs/planning/2026-09-04-enterprise-channel-branding.md` 明示"仅规划未实施"，涉及 CI/签名/更新源重构；已做最小一致性（更新源常量单点、README/notices 版本对齐） |
| connectors OAuth token / enterprise session token 明文 0600 | 维持（上一轮审计即标"已知权衡"）；加密需系统钥匙串集成 |
| 报表 webhook 拒绝私网/回环目标 | SSRF 修复的必然结果；内网 webhook 需新增白名单配置面（未做） |
| Anthropic 流式每行 goroutine+timer | 读取已加 1MB 上限（内存风险已消除）；逐行 goroutine 重构留待专用改动 |
| `usage_monthly` 只写不读 | 账本回退统一走 `usage_daily`（P1-10/P1-16 的必然结果），月账仍由 `RebuildUsageLedger` 幂等维护，数据不丢 |
| 跨包 client 常量去重（`dsh-panel-activate`、`encodeSegment`） | 客户端 bundle 禁止跨包 import（AGENTS 客户端插件规范）；`encodeSegment` 两处 fallback 语义本就不同（`~uuid~` vs `anonymous`）且已有注释 + `partition.spec` 锁定 → 评估为有意分离 |
| `MonthUsageByUsers`/`UserMonthlyCostBatch` 合并、webadmin `any` 收敛 | 可选代码质量项，非缺陷 |

### 13.6 最终验证（2026-09-08）

| 检查 | 结果 |
|---|---|
| `corepack yarn check`（10 包 build+typecheck+test） | ✅ exit 0 |
| `cd server && make check`（gofmt + vet + 全量 Go 测试 + webadmin 128 测试 + vite build） | ✅ exit 0 |
| `e2e:client`（重新打包的 HEAD 产物） | ✅ 13/13 exit 0（致命错误现在会正确 exit 1） |
| 真机浏览器 E2E（真实服务端 + 合成截图） | ✅ 22/22 |
| 生命周期/节流探针 | ✅ 启动 `created=true visible=false`；关窗后 CDP 存活；非活动标签与隐藏窗口定时器均 30/30（修复前 3） |
| 下载守卫探针 | ✅ 关掉第一个标签后下载仍被拦截并落盘 |
| 新增/改写测试 | browser 196、desktop 509、enterprise 166、cron 112、account-card 18、branding 11、connectors 34、better-sidebar 通过、webadmin 128、Go 全包绿 |

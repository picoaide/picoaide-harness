# PicoAide Harness 全项目代码与文档审查报告

- 日期：2026-09-06
- 范围：`server/`（Go 服务端 + webadmin）、`packages/host/*`、`packages/client/*`、`packages/vendor/*`、`community/fabric`、`site/`、`docs/`、CI 与根脚本
- 排除：`deepseek-harness/`（只读 pinned 上游子模块，不属产品代码）
- 方法：6 路分区深审（子代理并行）+ 主审对全部 P1/P2 核心结论逐条核验源码 + 全部门禁实测
- 结论：无 P0；10 条 P1（其中 3 条为必现数据/UI 错误）；40 条 P2/SUGG

## 0. 门禁实测结果（2026-09-06 本机执行）

| 检查 | 结果 |
|---|---|
| `corepack yarn check`（layout+build+typecheck+test+license） | ✅ 通过 |
| `go test ./...`（PG_DSN_TEST → 本地 postgres:18，18 个包） | ✅ 全绿 |
| `gofmt -l cmd internal` / `go vet ./...` | ✅ 零输出 |
| Go 覆盖率（语句） | serverstore 73.7% / serverauth 73.5% / llmgateway 69.6% / **reports 55.5%** / appstore 78.8% / capabilities 69.2%，合计 72.3% |
| CI 中 DB 测试 | ❌ 不跑（见 P2-37） |

## 1. P1 —— 必须尽快修复（确定性问题）

### 1.1 部门用量归并对"多部门共享祖先"的用户重复计数
`server/internal/serverstore/usage_dept.go:183`
`userIDToDepts` 里 `seen := map[string]bool{}` 声明在 `for rows.Next()` **循环体内**，每读一行就重置。一个用户属于两个子部门且共享同一祖先部门时，祖先名会 append 两次；`RegroupByDept` 随后按部门名累加 → **共享祖先部门的用量被 double count**。与注释"同一用户对同一部门只计一次(去重)"、与预算 enforcement（`DeptMemberIDs` 用 DISTINCT，budget.go:149）口径均不一致 → 用量中心部门视图与**月报订阅的部门费用高估**。修复：`seen` 提出循环、按 uid 合并。

### 1.2 账本回退路径下 `group=model` 被按"月"分组（聚合结果完全错误）
`server/internal/serverstore/usage_ledger.go:276-277, 288, 313`
`UsageAggregateFromLedger` 的 `default:// month / model` 分支把 `col` 统一设为 `"month"`，于是 `case "model"` 生成 `month AS label` + `GROUP BY month` —— 所有模型被合并成"每月一行"，标签变成日期。只要窗口落到保留期外（或 from 为零）触发账本回退，**模型视图 / 报表 `top_models` 返回的就是按月跨模型合计**。`case "week"` 同样退化为逐日粒度（`usage_daily/day` 直接标日期，非周一桶）。直接违背"10 年数据不丢"的账本承诺。修复：model 分支用 `model AS label` + `GROUP BY model`；week 用月账或按周聚合日账。

### 1.3 聚合 SQL 用 `AT TIME ZONE` 包裹分区键 → 分区裁剪/索引失效
`server/internal/serverstore/usage.go:612,617` + `dialect.go:31-33`
`DateCompareExpr` 生成 `usage.created_at AT TIME ZONE 'Asia/Shanghai' >= ?`。对按月 `RANGE(created_at)` 分区表，PG 无法用派生表达式做分区裁剪、也无法用 `idx_usage_time` —— **每次管理端用量聚合都是全分区扫描**（并发压测已点名 DB 是吞吐瓶颈）。而会话 `TimeZone` 已在 `pg.go:20` 固定为 `Asia/Shanghai`，直接 `created_at >= ?::date` 语义完全相同。`ListUsageRequests`（requests.go:47-52）就是直接比，两者不一致。修复：去掉 `AT TIME ZONE` 包裹。

### 1.4 认证方式强制可绕过：LDAP/OIDC-only 模式下本地密码仍可登录
`server/internal/serverauth/config.go:73-75` + `handler.go:295`
`ConfigureProviders` **无条件**把 `local` provider 注册进去（注释：管理员回退），而客户端 `handleLogin → authenticate` 的尝试顺序固定为 `["ldap","local"]`，**没有任何"仅管理员"限制**。于是 `auth.enabled=ldap` 想做的纯 LDAP/SSO 管控失效：任何本地账号（含 bootstrap 本地 admin）仍可走客户端密码登录。建议：把 local 回退限定到管理面（`AuthenticateConfiguredAdmin`），客户端登录严格按 `auth.enabled` 走。

### 1.5 "auditor 不可登录客户端"不变量可被存量 token 绕过
`server/internal/serverauth/token.go:56` + `admin.go:845-849`
`VerifyToken` 只查 `u.Status != 1`，**不校验 Role**；而 `updateUser` 的吊销条件是 `demoted := wasRole != RoleUser && u.Role == RoleUser` —— 只有"降为 user"才吊销。`user→auditor` 或 `super_admin→auditor` 的降权**不吊销任何 API token**，auditor 用旧 token 继续访问员工面（LLM 网关/用量接口）。修复：`VerifyToken` 拒绝 `RoleAuditor`，或任何角色变更都吊销 token。

### 1.6 门户页 `<title>` 未转义 → 存储型 XSS
`server/cmd/server/main.go:289`
`<title>` + `loginName` 裸拼，而同页正文 `__NAME__` 等都过 `htmlEscape`（:351）。门户 `/`、`/portal` 对未认证用户开放；品牌名（super_admin 可设）含 `<script>` 即在所有访客浏览器执行。修复：title 同样 `htmlEscape`（顺带 :359 `_ = payload` 是死代码可删）。

### 1.7 webadmin 用户详情弹窗：生效 token 配额恒显示"不限"（三元优先级 bug）
`server/webadmin/src/pages/Users.tsx:643`
`quotaUser?.effective_quota_tokens ?? 0 === 0 ? '不限' : ...` 按优先级解析为 `(x ?? true) ? '不限' : ...`（`===` 高于 `??`）→ 任何非空正值（如 500000）都显示"不限"；反而配额=0（不限）时显示"0"。右侧金额框写法正确（`&&`），同一弹窗两种口径。修复：`(effective ?? 0) === 0 ? '不限' : fmtTokens(...)`。

### 1.8 webadmin"归属官方"功能入口恒不可用
`server/webadmin/src/components/transfer-owner-dialog.tsx:216`
勾选"归属官方"只 `setToOfficial(true)`，`owner` 仍为空串 → 确认按钮 `disabled={... || owner === '' || ...}` **恒禁用**，`{official:true}` 永远无法提交；服务端 `transferOwner` 明明支持 official 分支。修复：`disabled` 条件在 toOfficial 时豁免 owner 校验。

### 1.9 登录页方法选择按钮 XSS（与同文件既有加固不一致的遗漏面）
`packages/host/enterprise/src/auth-gate.ts:240-247`
`renderMethodButtons` 把网关返回的 `m.name`（及未知名的 `label`）未转义拼进 `methodsBox.innerHTML` 的 `data-method="..."`。`m.name` 来自登录页转发用户输入网关的 `/api/client/v2/auth/methods` → 恶意网关可注入属性/事件处理器，在**本地登录页 origin（未认证，但可调本地回环接口）执行任意 JS**。同文件对 `logo_url/display_name/tagline/welcome` 的转义加固（2026-09-01）独漏了这一处。修复：`esc(m.name)`/`esc(label)` 或用 `textContent` 构造。

### 1.10 桌面渲染层 CSP 与其宣称的注入隔离不符（纵深缺口）
`packages/host/desktop/src/electron-runtime.ts:651-659`
注释（P1-4）声明该策略"keeps any injected content from reaching out"，实际 `connect-src 'self' ws: wss: http: https:` 放行**任意** http(s) 外联 + `script-src 'unsafe-inline' 'unsafe-eval'`。渲染器在跑 AI/工作区内容且持有令牌时，一旦出现 DOM-XSS 即可外带。说明：放宽 `connect-src` 有功能性原因（客户端要连用户配置的任意网关），但注释夸大了防护效果，且 `'unsafe-eval'`/`'unsafe-inline'` 应逐项论证（能去则去）。

### 1.11 桌面回环管理路由只验 Origin，无 Host/DNS-rebinding 防护
`packages/host/desktop/src/desktop-update-route.ts:22,38`、`packages/host/desktop/src/loop-notify-route.ts:27`、`packages/host/desktop/src/directory-picker-route.ts:20`、`packages/host/desktop/src/renderer-boot.ts:62`
"无 Origin 视为同源放行"可被 DNS rebinding（页面与目标同源后带匹配 Origin/无 Origin）绕过；跨源简单 GET/POST 无预检时请求照常在服务端执行（响应被 CORS 挡，动作已发生）→ 可被恶意站点触发更新检查网络请求、弹原生目录选择器/Recovery 对话框。修复：校验 `Host` 为 `127.0.0.1:<port>` + 一次性会话令牌。

## 2. P2 —— 重要问题

### 服务端数据/并发
1. 审计哈希链并发插入会分叉 + `PurgeOldAuditLogs` 删旧行破坏链锚点 → `VerifyAuditChain` 报断链（serverstore/audit.go:29-43,175）。
2. 迁移应用无 advisory lock，多实例并发启动会竞态（serverstore/migrate.go:99-117；服务端规划 2 实例 + LB 是真实风险）。
3. `appstore.Publish` 无事务：占名/归属检查 TOCTOU + `UpsertApp` 成功而 `CreateRelease` 失败留下"占名无版本"悬挂 App（appstore/publish.go:132-230）。
4. 报表：账本回退路径 `EmbedTokens` 恒 0 → embedding token 未扣除，总 token 高估（reports/reports.go:84）；停机跨月后只补最近一个月，中间月份永久缺失（reports/reports.go:149-154 + scheduler.go:69，且 `tryRun` 用 `context.Background()`）。
5. `今日/昨日` 按服务器本地日界而非北京时间（UTC 容器下偏移 8h，usage.go:679-682）。
6. `quotaBlocked` 步骤 2 已查过 `DeptMemberIDs`，步骤 3 对每个预算**重复查询**（热路径，llmgateway/handler.go:683-688）。
7. 热路径每写执行一次 `CREATE TABLE IF NOT EXISTS ... PARTITION OF` DDL（usage.go:210-214），应内存缓存已建月份（压测点名瓶颈）。
8. Anthropic 流式路径每行 `go func + channel + timer`，`serveStream` 已弃用该模式（高并发长流风险，messages.go:166）。
9. `mergeUsageRows` 结果无序，账本+明细合并路径丢弃 `ORDER BY label`（usage_ledger.go:337-350）。
10. `VisibleReleases` 逐 App 查询 = N+1（appstore/publish.go:261-279）。
11. 正常结束但未回传 usage 的流，pending 行既不回填也不删除（llmgateway/handler.go:525-555）。

### 客户端/插件
12. `connectors/src/user-scope.ts:21-60` **内联复制** DSH home 常量/解析函数（cron 已改为 re-export 共享，此处未跟随 → 多包 home 语义会分裂）。
13. `account-card` 的 `dept_budgets` 死字段：每次刷新服务端都白算 `EffectiveDeptBudget+DeptMonthlyCost`，客户端从不渲染（usage-service.ts:29、AccountCard.tsx:26）。
14. `cron/host-ledger.ts:380-393` `applyRequest` 先写指纹缓存再做 owner 校验，授权失败后重试被吞成"重复请求"。
15. 跨包互斥常量 `'dsh-panel-activate'` 4 处复制（enterprise/connectors/cron 各触发组件 + panel-mount.tsx）。
16. `encodeSegment`/`encodePartitionSegment` 在 connectors 与 browser 两份字节级复制（靠注释约定同步，漂移风险）。
17. 品牌 SVG 几何约 5 处手抄（Brand.tsx×2、favicon.ts、auth-gate、BRACE_MARK）——与"禁止从记忆临摹、单一权威"规则冲突。
18. `enterprise/src/client/index.ts:99,112` `startBrandStore` 被重复调用、首个 disposer 丢弃。
19. `browser/runtime.ts:897-903` `fillCredentials` JSDoc 声称"必须经审批"与 guard.ts"2026-08-26 审批缝已移除、无提示执行"矛盾。
20. `connectors/store.ts:27` OAuth access/refresh token 明文落盘（0600，已知权衡；建议接系统钥匙串/加密）。
21. `enterprise/session-service.ts:163` safeStorage 不可用时 token 明文 0600 落盘（有一次性 warn；建议无 keyring 时提示用户或机器派生密钥）。

### 桌面
22. `package.json:325-326` electronFuses 仅 `runAsNode:true`（应 false + 补 `onlyLoadAppFromAsar`/防 Node CLI/env 注入）。
23. mac 产物 arm64-only 但资产名 `-mac.dmg` 架构中立（package.json:402-414 + verify-mac-smoke.ts:124），Intel Mac 会提示下载但无法运行。
24. `scripts/mac-runtime.ts:12,16` sharp/libvips 精确版本号硬编码在路径里，依赖 patch 升级时发布前静默失败且本地 CI 不触发。
25. `main.ts:205,211,232` `picoaide://` 深链仅 `startsWith` 前缀校验即原样转发。
26. `updates.ts:200` 下载失败一律压成 `'network'`，checksum-mismatch/release-missing 等高价值诊断丢失。
27. `package.json:426` 顶层 `win.artifactName` 是 `-Portable`，NSIS 目标实际不生效（陈旧误导配置）。
28. `main.ts:55,234`、`index.ts:104-105`、tray/崩溃页文案——**brand.json（自封"唯一事实源"）至今未接入**：产品名/AppId/文案/更新源/资产名模板散落 ~10 处硬编码；`DESKTOP_RELEASE_REPOSITORY` 在 update-checker.ts:4 与 update-download.ts:20 各一份；崩溃页中英混排。

### webadmin
29. `transfer-owner-dialog.tsx:72-84` 渲染函数体内直接 `setState + async loadUsers('')`（副作用进 render，StrictMode 下双触发）。
30. `usage/Members.tsx:75,87`、`MemberDetail.tsx:89-90` 用 `quota_money/quota_tokens`（null=跟随默认）而忽略服务端下发的 `effective_quota_*` → 默认配额用户被误报"限额不限"。
31. `Users.tsx:653`"去用量中心调整"深链 `?user=` 在 `Quota.tsx` 无任何消费（死链）。
32. 用量各子页（Overview/Logs/Models/Members/Departments/Reports）缺少 Users/Audit 已有的 `loadSeq` 请求序号守卫。
33. `Auth.tsx:385` SecretField 的 input id 用 `Math.random()` 每次渲染变化。

### 文档/CI/脚本
34. `server/README.md:26-29` 两段多行说明**完全重复**（复制粘贴）。
35. `server/README.md` 文档表漏掉 `05-agent-system.md`，且 `08-agent-share.md` 与 `08-development.md` 编号重复。
36. **迁移号文档漂移两处**：server/docs/06-database.md:6 写"0001–0057"（实为 0059）；server/AGENTS.md §7.1 写"0001–0048"。
37. **CI server job 无 PostgreSQL**（ci.yml:29-31 注释明说；dbtest.go:21/47 无 PG 自动 Skip）→ DB 测试在 CI 中零运行，业务 SQL 正确性完全依赖本地。建议恢复"PG service + PG_DSN_TEST"独立 job。
38. `integration-tests/electron-shots/electron-shots.mjs:8-24` 硬编码绝对路径 `/data/picoaide-harness/...`。
39. `install-server.sh:42`/compose 默认 `SERVER_IMAGE=...:latest`，生产一键部署建议默认 pin 具体版本 tag。
40. `error-reporting.ts:89,95,105` 3 处 `console.log` 调试残留进入发货插件。

## 3. SUGG —— 建议（简列）
- 死权限点：`PermRoleAssign`/`PermQuotaWrite`/`PermErrorMonRead` 声明但零路由消费（rbac.go:25,34,48），`TestPermissionsOfRoles` 断言空转——要么接线要么移除。
- `testAuthConnection` 把 LDAP/OIDC 原始错误回传管理端（admin.go:1651,1662,1700），建议脱敏。
- marketplace/llmgateway 测试路由助手注释仍写旧前缀 `/api/admin/*`（admin.go:25/55）——测试树注释与实现不一致的温床。
- `fall-open` 完整性测试只覆盖 serverauth 自建子树（rbac_test.go:20-49），建议改用 `router.Register` 成品树做全量比对。
- webadmin flash 提示 `setTimeout` 未清理（Gateway/Brand/Auth/ErrorMonitoring 多页）；纯图标按钮缺 `aria-label`；`total - 1` 假设仅一名超管。
- `release-mac.ts:146` `resolve(desktopRoot,'..','..')` 实为 `packages/` 而非注释所写"Repository root"（靠 Yarn 回退侥幸可用），应上溯 3 级并校验。
- `MonthUsageByUsers`/`UserMonthlyCostBatch` 两条几乎相同的批量聚合可合并；`dept_budgets`/`yesterday/total` 等客户端死字段建议与服务端同步清理。
- webadmin 前端 `any` 使用约 166 处，可分期收敛。

## 4. 已知待办（非本次新发现，供排期参考）
- **2000 并发下服务端连接管理崩溃**（temp/perf-2000/PERF-REPORT.md）：单实例安全上限 ≈1500 并发；修复连接管理为 P0，另需 DB 查询链合并/缓存与水平扩容（服务端无状态）。
- **品牌参数化 Phase 0.5**（docs/planning/2026-09-04-enterprise-channel-branding.md）：brand.json 文案/更新源/资产名接入未实施（本次 P2-28 是其证据）。
- 演示环境备注：compose 默认 PG max_connections=100 < Go 连接池 400，生产必须调高。

## 5. 做得好的地方
- 路由集中声明 + `AdminRoute` 权限申报 + fall-open 完整性测试 + 统一 JSON 错误信封 + 统一 CSRF/限流/安全 cookie。
- 桌面：单实例锁、renderer 崩溃自动恢复、权限请求全拒、导航/外链白名单、更新 SHA-256 强校验+原子改名+平台魔数、Windows ACL trampoline 的 `RUN_AS_NODE` 剥离。
- 服务端：审计哈希链+Verify、fail-closed 配额检查、密钥不出服务端、`?→$N` rewrite 层与 PG 分区/日账/月账设计。
- 工程机制：`version.mjs`（tag 单一权威）、`verify-layout.mjs`、`verify-licenses`、双语 i18n hash 一致性记录、决策/规划文档齐全、发布流程 fail-loud（含 mac 公证断连的 resumable 拆分）。

## 6. 建议修复顺序（Top 10）
1. 1.2 账本 `group=model/month` 分组错误、1.1 部门重复计数（产出错误数据，影响报表订阅与用量中心）
2. 1.7 / 1.8 webadmin 两个前端逻辑 bug（改动小、见效快）
3. 1.4 / 1.5 认证强制与审计角色边界（安全不变量）
4. 1.9 auth-gate `m.name` 转义（与既有加固对齐）
5. 1.3 聚合裁剪失效（性能，压测瓶颈之一）
6. 1.6 门户 title 转义
7. 1.11 回环路由 Host/令牌校验、1.10 CSP 注释纠正与逐项收紧
8. P2-37 恢复 CI DB 测试（PG service job）
9. 品牌单一权威落地：main.ts/package.json/update-*/文案接入 `brands/official/brand.json`（P2-28）
10. 共享常量收敛：home 路径、`dsh-panel-activate`、`encodeSegment`、品牌 SVG 几何（P2-12/15/16/17）

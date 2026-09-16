# GlitchTip 错误收集为空 —— 决策记录（D1–D9）

- 日期：2026-09-16
- 分支：`fix/glitchtip-error-collection-20260916`（基点 `master` = `39692cac6e`）
- 状态：**已拍板**（用户经 `ask_user_question` 六问确认，**全部选择推荐项**；D8/D9 为用户追加拍板）
- 性质：本文件**只记录拍板结果与理由**，不是蓝图副本。设计细节见
  [设计蓝图](../planning/2026-09-16-glitchtip-error-collection-design.md)，任务分解见
  [实施计划](../planning/2026-09-16-glitchtip-error-collection-implementation.md)，
  人工运维步骤见 [运维手册](../deploy/2026-09-16-glitchtip-selfhost-operations.md)。
- 输入：需求书 `REQUEST.md`（事实 F1–F9）+ 证据补充 `EVIDENCE-ADDENDUM.md`（实测 F10–F13）
  + 蓝图 `PLAN.md` + 实施计划 `IMPLEMENTATION.md` + 拍板记录 `DECIDED.md` —— 这五份是**本轮编排的
  工作稿文件名**，存放在**未纳入版本库**的黑板目录 `.multiagent/glitchtip-collect-fix/`（故不给链接，
  提交后必然 404）；结论已分别落在本文件、[设计蓝图](../planning/2026-09-16-glitchtip-error-collection-design.md)
  与[实施计划](../planning/2026-09-16-glitchtip-error-collection-implementation.md)。

---

## 1. 问题陈述

用户报告：自托管 GlitchTip（`https://glitchtip.example.com/`，6.2.6，org `picoaide`，
project `picoaide-web`）**收集不到内容**，最新一条 issue 还是 20 天前（2026-08-27，即搭建当天）。

**关键重述（本决策的出发点）**：这不是"最近坏了"，而是**真实客户端错误从上线至今一条都没进来过，
只是一直没人发现**——搭建当天的 9 条 issue 全部是人造联调探针（F5），之后 20 天零真实流量。

---

## 2. 已核实事实（前提，不重新推翻）

| # | 事实 | 证据强度 |
|---|---|---|
| **F1** | GlitchTip 实例本身健康，收包链路完全可用：手工 `POST /api/1/store/` → HTTP 200 + 新 issue 立即出现；`GLITCHTIP_EMBED_WORKER=true` 已开 | 实测 |
| **F2** | 仓库内客户端上报代码用正确 DSN 端到端可用：`initSentry` → `flush=true` → GlitchTip 新增 issue | 实测 |
| **F3** | 生产服务端配置**正确**：`web.error_reporting_dsn` / `enabled=true` / `level=error` / `glitchtip_base_url` / `glitchtip_organization` 五项均为期望值 | 生产只读 SELECT |
| **F4** | 真实客户端**确实在**拉 `GET /api/client/v2/config/bootstrap` 且 200 | 生产容器日志 |
| **F5** | GlitchTip 里**从来没有一条真实客户端错误**：13 条 issue 全是人造探针（标题清单见需求书 §F5） | API 枚举 |
| **F6** | GlitchTip **对外展示的 DSN 本身是坏的**：`GET .../keys/` 返回 `http://<glitchtip-public-key>@localhost:8000/1`；容器 env 只有 `MAIN_URL`，**没有 `GLITCHTIP_DOMAIN`** | API + `docker inspect` |
| **F7** | 产品对坏 DSN **完全静默**：webadmin 只校验 `/^https?:\/\//i`，`http://key@localhost:8000/1` 照收并提示"已保存"；客户端 init 失败只 `console.warn`（GUI 无人可见） | 源码 + 实测 |
| **F8** | 坏 DSN 的真实行为：上层毫无察觉（`initSentry returned`），底层 `connect ECONNREFUSED 127.0.0.1:8000`，GlitchTip 零新增 | 实测 |
| **F9** | `level=error` 让"健康"与"坏掉"在后台**看起来一模一样**（`beforeSend` 把 info 自检丢弃） | 源码 + 后续实测 |
| **F10** | **推翻 H1**：生产正在分发的 2.7.5-beta.2 发布树里 `@sentry/node` 可 `require`（7.120.4）、`error-reporting` 插件可 `import`、真发事件到达 GlitchTip（`PICOAIDE-WEB-D`） | 实测（发布树） |
| **F11** | **F9 升级为实测复现**：`level=error` 下 `captureMessage(info)` **查无此 issue**、`captureMessage(error)` **到达** ⇒ 链路完全健康时后台也一条都没有 | 实测 |
| **F12** | **确认只采主进程**：`error-reporting.ts` 只初始化 `@sentry/node`；全仓无 `window.onerror` / `unhandledrejection` 采集；发布树里没有 `@sentry/browser` ⇒ 用户界面上真实遇到的报错**结构上不会进 GlitchTip**；且 `initSentry` 只在 session 事件之后执行，**启动期/登录流程本身的崩溃永不上报** | 源码 + 发布树 |
| **F13** | GlitchTip 的 DSN 展示与 **issue permalink** 都是 `http://localhost:8000/...`（缺 `GLITCHTIP_DOMAIN`）；且仓库 `e2e-fixture-gateway.mjs:57` 硬编码生产 DSN 又**没开** `error_reporting_enabled` ⇒ E2E 假绿 + 地址泄漏 | 实测 + 源码 |

**由 F1–F4 + F10 得到的排他结论**：配置下发正确、客户端库正确、发布包正确、服务端收包正确
⇒ **不是修一条断线**。任何"改一行就让 GlitchTip 开始收数据"的方案都与证据不符，予以拒绝。

**前置检查结论（PRE-4，编码前已执行，只读）**：生产 `models` 非空且 `default_model` 命中
⇒ `validateBootstrap` 的 `fellBack` 路径**在生产不触发**，H3′ 不升格为 P0；但
`error-reporting.ts:102` 丢弃 `fellBack` 仍是真实健壮性缺口，按 P2 保留。

---

## 3. 根因定调（R1–R5）

编码必须围绕这五条，不得偏离。

| # | 性质 | 机制（已实测） | 优先级 |
|---|---|---|---|
| **R1** | **可观测性缺陷** | `error_reporting_level=error` 的 `beforeSend` 纯等级过滤把**唯一**自检心跳（info）丢弃 ⇒ 健康与坏掉**不可区分**，无任何正向信号（F11 实测：info 查无、error 到达） | P0 |
| **R2** | **校验缺失** | webadmin 与 Go 服务端对 DSN **零连通性校验** ⇒ `localhost:8000` 这类**必然不可达**的 DSN 能保存并提示"已保存"（F7/F8） | P1 |
| **R3** | **采集面缺失** | 只采**主进程**、不采**渲染进程**；登录前不上报 ⇒ 用户真实错误绝大多数收不到（F12 实测） | P1（D8 提级为 P0-6） |
| **R4** | **运维缺陷** | GlitchTip 缺 `GLITCHTIP_DOMAIN` ⇒ 后台展示的 DSN 与 issue permalink 全是 `localhost:8000`，照抄即错（F6/F13） | P1 |
| **R5** | **仓库卫生 / 防线** | `e2e-fixture-gateway.mjs` 硬编码生产 DSN 且未开 `enabled` ⇒ 上报链路**无回归防线** + 地址泄漏（F13） | P2 |

**修复目标**：让"链路活着"**可被证明**（R1/R2）、让真实错误**真的被收到**（R3）、把运维口径
**纠正并写进文档交给人工**（R4）、补上**回归防线**（R5）。

### 3.1 渲染进程缺口与采集现状（R3 的展开）

- 现状：`packages/host/enterprise/src/error-reporting.ts` 只初始化 **主进程** 的
  `@sentry/node`（`uncaughtException` / `unhandledRejection`）；文件内注释自认
  「渲染进程采集（extension 集成）后续阶段接入」——**至今未接入**。
- 全仓 grep 无 `window.onerror` / `unhandledrejection` 采集；`electron-runtime.ts:870` 的
  `render-process-gone` 事件存在但**不走上报**。
- 发布树里**没有 `@sentry/browser`**，也没有任何 `lib/**` 引用 Sentry 的客户端 bundle。
- 结论：界面里的 React 渲染异常、IPC 失败、前端未捕获异常**一条都不会进 GlitchTip**，
  这是"收集不到内容"**最直接的功能性原因**（不是配置问题）。

---

## 4. 拍板结果（D1–D9）

| # | 决策点 | **拍板结果** |
|---|---|---|
| **D1** | 客户端 init 失败如何"不再静默" | **结构化日志（P0）+ 状态上报服务端（P1）两者都做**，分阶段；**不做**"只写日志" |
| **D2** | DSN 校验强度 | **硬拒** loopback / 链路本地 / 云 metadata / unspecified；**私网与 `http://` 只告警不阻断**；"保存前强制真发测试事件"**不采纳**，改为**可点按**的测试按钮 |
| **D3** | 「发送测试事件」由谁发 | **服务端 Go 代发**（复用 `util.SafeOutboundTransport`）；**浏览器直发否决**；UI/返回体**必须**标注"服务端视角" |
| **D4** | 正向心跳方案 | **webadmin 显示「最近一次上报时间」为默认可见性** + **可选独立开关 `web.error_reporting_heartbeat`（默认 off）**；心跳带 tag **定向绕过** `beforeSend` 阈值；**不修改** `error_reporting_level` 语义、不新增等级取值 |
| **D5** | `@sentry/node` 静态 import vs 惰性加载 | **保持静态 external**，靠**打包期 smoke 断言**兜底（照抄 flock smoke 范式）+ `REQUIRED_ASAR_EXPORTS` 补条目；**不改惰性加载** |
| **D6** | 改动范围边界 | 见 §6；desktop 侧**只允许**动 `scripts/verify-packaged-runtime.ts` 与其 spec（属 `AGENTS.md` 允许的 "test adaptations in desktop-owned scripts"） |
| **D7** | 客户端状态上报落库 | **新增 `client_error_reporting_status` 表（迁移 0068，按 `user_id` upsert）**；**否决** settings JSON blob |
| **D8** | **渲染进程采集**（用户追加拍板，原蓝图未含） | **本轮做最小可用版**：主进程侧经 preload/IPC 捕获渲染进程未捕获异常与崩溃并上报。**不含** `@sentry/browser`、**不含** sourcemap 上传链（另开一轮） |
| **D9** | 生产现场运维修复 | **一并修**：GlitchTip 补 `GLITCHTIP_DOMAIN=https://glitchtip.example.com` 并重启该容器；纠正 webadmin/生产 DSN。**由人工执行**（见 §5.9） |

### 4.1 D1 客户端可观测性

- **做法**：先做 P0（把每个静默分支变成"可查状态 + 会落盘的 `warn`"），再做 P1（把状态回传服务端，
  让管理员在 webadmin 一眼看到「N 个客户端已启用 / M 个失败（最近原因）」）。
- **理由**：只写日志解决不了"没人看桌面日志"（这正是缺陷活了 20 天的原因）；只上报状态则在
  "上报自身失败"时仍不可见（鸡生蛋）。两者互补，a 保证单机可诊断，b 保证集中可见。
- **状态机**：`idle` / `disabled` / `ready` / `failed` / `config_unavailable`，其中
  `bootstrap 抛错`、`fellBack=true`、`enabled!==true`、`initSentry 抛错` 四个分支都必须至少一条 warn。
- **隐私**：只记 `new URL(dsn).host` 与 level，**不记录、不打印完整 DSN**、不记录 public key。

### 4.2 D2 DSN 准入校验

- **硬拒绝集合**：`localhost`（含 `*.localhost`）、`127.0.0.0/8`（含 `127.1.2.3` 这类写法）、
  `::1` / `[::1]`、链路本地与云 metadata（`169.254.169.254`、`fd00:ec2::/64`）、unspecified（`0.0.0.0`）。
  这些地址**从客户端视角永远不可能指向真实 GlitchTip**；F6 的 `localhost:8000` 正是这一类。
- **只告警不阻断**：私网（`10/8`、`172.16/12`、`192.168/16`）与 `http://`。
- **理由（为什么私网不拒）**：仓库既有判断明确"企业内网自建 LLM 网关是产品主要场景"
  （`server/internal/util/netguard.go` 包注释、`packages/host/connectors/src/outbound.ts` 模块注释），
  内网自建 GlitchTip 完全合法。**红线**：不得为了让 DSN 拒绝 loopback 去改 `netguard.go`
  （那会同时收紧全部上游/余额/报表出站，属跨需求破坏）——新规则落在**错误上报自己的校验函数**里。
- **两侧都要**：Go 服务端是权威（绕过 webadmin 直接 PUT 也拦得住），webadmin 是体验
  （即时中文报错、不发无谓请求）；两侧规则必须逐字一致并做**跨语言对拍测试**。
- **拒绝时**：HTTP 400 + `{"error":{"code":"VALIDATION","message":"…中文…"}}`，且**不写 settings、不留审计噪音**。

### 4.3 D3 测试事件由服务端代发

- **做法**：新增 `POST /api/server/admin/gateway/error-reporting/test`（`PermGatewayWrite`），
  复用 `util.SafeOutboundTransport()` + `CheckOutboundTarget()`（已有 metadata/DNS-rebinding 复检、代理感知），
  超时 ≤ 8s，请求体固定且不含任何服务端机密。范式照抄既有 `POST /api/server/admin/auth/test`。
  失败必须返回**可读中文原因**并分类 `detail.kind ∈ {DNS, CONNECT, TLS, TIMEOUT, HTTP_4XX, HTTP_5XX}`。
- **否决浏览器直发（3 条理由）**：① webadmin 由服务端同源提供，窗口 CSP `connect-src`
  不应为第三方放开（2026-09-11「CSP 放行」的教训）；② 会把 DSN 交给浏览器网络栈，引入跨域预检 /
  混合内容问题；③ 失败原因（DNS/TLS/连接）在浏览器里被 CORS 抹平，**给不出可读原因**。
- **必须写清的局限**：服务端代发证明的是**服务端视角**的连通性，**不**等于员工桌面的连通性
  （出口防火墙/DNS 可能不同）。UI 文案与返回体必须标注「服务端视角」，客户端侧正面证据由
  D1 的状态上报提供。**这一条审计一定会打，所以自己先写在文档与文案里。**
- **注意**：`SafeOutbound*` **允许私网**（既定策略），所以 R2 会真去连私网地址 —— 这是**有意**的
  （内网自建 GlitchTip），代码注释里要写明"这是管理员显式动作 + 权限受控"，避免审计误判为 SSRF。

### 4.4 D4 正向心跳

- **默认可见性**：webadmin 显示**「最近一次上报时间」**（数据来自 D1 的状态上报）。零噪音、零语义风险，
  且证明的正是**真正出问题的那一段**（配置下发 + 客户端 init）。
- **可选端到端证明**：`web.error_reporting_heartbeat`（布尔，默认 **off**）。为 true 时客户端每次
  进程启动发一条带 tag `picoaide.heartbeat` 的 **info** 事件，`beforeSend` **仅对带该 tag 的事件**
  绕过等级阈值；普通事件仍走原纯等级过滤 ⇒ `error_reporting_level` 语义**未被改变**。
- **落地形态**：复用现有自检消息 + 一个新 tag（不新造文案），加"每进程只发一次"守卫，
  且**不修改** `error_reporting_level` 语义、不新增等级取值（`debug|info|warning|error` 白名单两端已一致）。
- **为什么不做「把现有 info 自检无条件放行」**：等于让 `level=error` 的部署每客户端每次启动都收一条 info，
  悄悄破坏运维的降噪意图。
- **为什么不用 `captureMessage(..., 'error')` 冒充心跳**：污染错误计数与告警规则。

### 4.5 D5 保持静态 import

- **做法**：`@sentry/node` 保持 `tsdown.config.ts` 的 external 与**静态** import；在
  `verify-packaged-runtime.ts` 的 `afterPack` 阶段新增 smoke：用**打包后的 Electron**
  （`ELECTRON_RUN_AS_NODE=1`）`require('@sentry/node')` 并断言 `typeof init === 'function'`，
  同时断言 `@picoaide/dsh-enterprise/error-reporting` 可解析；成功标记 `SENTRY-SMOKE-OK`，
  缺失时**硬失败**（不是警告）。`REQUIRED_ASAR_EXPORTS` 补 `error-reporting` 条目。
- **理由**：源码注释（`error-reporting.ts:6-8`）记录了**实测结论**——动态 import 会被 tsdown 拆 chunk
  导致运行时解析挂起。改成惰性加载属于**重新踩已知的坑**；正确做法是"保持静态 + 打包期断言"。
- **不得**为了 sentry 去改 `desktop/package.json` 的 `build.files` / `asarUnpack`
  （`@sentry/*` 是纯 JS，应留在 asar 内；加 `asarUnpack` 反而会踩 `listUnpackedUnsafeJs`
  的「JS 泄漏到物理树」门禁）。

### 4.6 D7 状态落库

```sql
CREATE TABLE IF NOT EXISTS client_error_reporting_status (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT        NOT NULL,   -- ready|disabled|failed|config_unavailable
  reason      TEXT        NOT NULL DEFAULT '',   -- 服务端截断到 200 字符
  dsn_host    TEXT        NOT NULL DEFAULT '',
  level       TEXT        NOT NULL DEFAULT '',
  release     TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- **上报通道复用既有遥测范式**：`POST /api/client/v2/telemetry/error-reporting`（Bearer），
  失败静默不重试，限流复用 telemetry 的 limiter —— 照抄 `skill-telemetry` 的形态，不另造一套。
- **否决 settings JSON blob**：会把"配置"与"运行时状态"混在一起，且并发 upsert 需要读改写。
- 管理侧读取：`GET /api/server/admin/gateway/error-reporting/clients`
  → `{ready, failed, disabled, config_unavailable, last_report_at, items[]}`。

### 4.7 D8 渲染进程最小可用采集（增量规格）

- **目标**：让界面里用户真实遇到的未捕获错误进入 GlitchTip。最小可用 = **不改前端构建链**。
- **实现要点**：
  1. preload 入口监听 `window.onerror` 与 `window.addEventListener('unhandledrejection')`，
     把 `{message, stack, source, lineno, colno, type, url}` 经**既有 IPC 通道**送到主进程；
  2. 主进程新增 IPC handler，交给 `error-reporting` 新增导出 `captureRendererError(payload)`
     （复用已 init 的实例；**未 init 时静默丢弃，绝不抛**）；
  3. `electron-runtime.ts:870` 的 `render-process-gone` 也接进上报（`reason`/`exitCode` 作为 tag）；
  4. **红线**：渲染进程**不得**直接持有 DSN、**不得**直接发网络请求，一切经主进程；
  5. 测试：preload 的 error/rejection 转发单测 + 主进程 handler 单测（未 init 时不抛）。
- **不在本轮**：`@sentry/browser` 集成、sourcemap 上传链（另开一轮）。
- **登记**：实施计划里以 **P0-6** 登记（与 R3 直接对应，"收集不到内容"的第一性原因）。

### 4.8 D9 生产 GlitchTip 运维修复

- **做法**：给 `glitchtip-web-1` 容器补 `GLITCHTIP_DOMAIN=https://glitchtip.example.com` 并重启该容器；
  随后把 webadmin 的 `web.error_reporting_dsn` 更正为
  `https://<glitchtip-public-key>@glitchtip.example.com/1`。
- **执行主体（硬边界）**：**这是现场运维动作，不是仓库代码**。本轮由**用户本人（人类运维）执行**，
  **不由任何代理执行**（子代理一律禁止；主控亦不得代为改生产配置）。仓库侧只交付：
  ① 运维手册 [docs/deploy/2026-09-16-glitchtip-selfhost-operations.md](../deploy/2026-09-16-glitchtip-selfhost-operations.md)；
  ② 只读核查脚本 `scripts/glitchtip-ops-check.mjs`（默认只读，`--apply` 需 `--yes` 且只打印命令）。
- **验收挂钩**：AC15（修后 `keys/` 返回的 DSN 主机为 `glitchtip.example.com`，permalink 同样正确）。

---

## 5. 明确被**否决**的方案（防复发）

审计与后续轮次请勿重新提出下列方案——它们已经被证据或既有约束否决。

| # | 被否决的方案 | 否决理由 |
|---|---|---|
| **X1** | 修改 `error_reporting_level` 的语义 / 取值范围 / 默认值（例如让它放行 info） | 需求书 §5 硬红线：等级阈值语义不得改动；两端白名单已一致（`""\|error\|warning\|info\|debug`）。放行 info 会悄悄破坏 `level=error` 部署的降噪意图。正向心跳改用 D4 的**独立开关 + tag 定向例外** |
| **X2** | 把 `@sentry/node` 改成惰性 / 动态 import（"fail-soft 加载"） | 源码注释记录了**实测**：动态 import 被 tsdown 拆 chunk 后运行时解析挂起。改为保持静态 external + **打包期 smoke 断言**（D5） |
| **X3** | 让"保存 DSN"依赖一次实时网络连通性测试（保存前强制真发测试事件） | 把"能否保存配置"绑死在网络可用性上（GlitchTip 可能正在部署/重启）会拦住合法保存。改为**显式点按**的测试按钮（D3） |
| **X4** | 由浏览器（webadmin 前端）直发测试事件 / 引入 Sentry browser SDK 做测试 | CSP `connect-src` 不应为第三方放开；DSN 进入浏览器网络栈；CORS 抹平失败原因，给不出 AC3 要求的可读分类（D3） |
| **X5** | 在服务端**硬拒私网** DSN（或为此修改 `netguard.go` 的私网策略） | 企业内网自建是产品主场景（既有模块注释明确写下）；改 `netguard.go` 会波及其他全部出站面。私网/http 只告警（D2） |
| **X6** | 在源码 / e2e fixture 里保留真实 GlitchTip 域名或 public key | 与 `error-reporting.ts` 顶部"DSN 一律由服务端下发，源码与本地配置不含任何上报地址"的自我约束冲突；该域名 2026-08-27 专门做过历史清理。生产地址只允许出现在 `docs/` 的运维手册里（AC11 的要求） |
| **X7** | 把 `@sentry/*` 加进 `asarUnpack` 以求"稳妥" | 纯 JS 应留在 asar 内；加 `asarUnpack` 会踩 `listUnpackedUnsafeJs` 的「JS 泄漏到物理树」门禁 |
| **X8** | 用 `settings` 的 JSON blob 存客户端上报状态 | 混淆"配置"与"运行时状态"，并发 upsert 需读改写（D7 否决） |
| **X9** | 心跳用 `error` 等级冒名上报 | 污染错误计数与告警规则（D4 否决） |
| **X10** | 任何"改一行就让 GlitchTip 开始收数据"的方案 | 与 F1/F2/F3/F4/F10 全部证据不符：链路本身**没坏** |

---

## 6. 改动范围边界（D6）

**必须动（P0/P1）**

| 文件 | 改动性质 |
|---|---|
| `packages/host/enterprise/src/error-reporting.ts` | 状态导出 + 日志升级 + 心跳 + `captureRendererError`（不碰明文 DSN 日志） |
| `packages/host/enterprise/tests/error-reporting.spec.ts` | 用例适配 + 新增 |
| `server/internal/llmgateway/admin.go`（+ 新 `dsn.go` / `dsn_test.go`） | DSN 校验 + 测试事件端点 |
| `server/internal/router/router.go` | 集中声明新路由（唯一真源） |
| `server/webadmin/src/pages/ErrorMonitoring.tsx` + `ErrorMonitoring.test.tsx` | 校验 + 按钮 + 状态卡片 |
| `packages/host/desktop/scripts/verify-packaged-runtime.ts` + 其 spec | 打包断言（**desktop 侧唯一改动点**，属 `AGENTS.md` 允许的 test adaptation） |
| `packages/host/desktop/src/preload` + 主进程 IPC handler | D8 渲染进程采集 |
| `server/internal/bootstrap/bootstrap.go` | 下发心跳开关 |
| `server/internal/telemetry/*`、`server/internal/serverstore/*`、迁移 `0068` | 状态上报通道与落库 |
| `docs/**` | 蓝图 / 实施 / 决策 / 运维手册 / release notes |

**绝不能动（红线，违反即本轮作废）**

1. **不做任何生产写操作**。唯一例外是 D9 —— 且它**由人类运维执行，不是代理**（见 §4.8）。
   代理对生产主机与 GlitchTip 实例只允许**只读**勘察（`SELECT` / `logs` / `inspect` / GET API）。
2. 不碰 `deepseek-harness/`（上游 submodule，pin `dsh-v0.1.5-rc.2` = `fb2c4b9e`）。
3. 不碰 `server/internal/util/netguard.go`（跨需求既定策略）。
4. 不修改 `error_reporting_level` 的既有语义；`error-reporting` 的 DSN 服务端下发契约不变。
5. 源码（`packages/**`、`server/**`）中不得出现真实 GlitchTip 域名 / public key
   （P0-5 就是要移除 e2e fixture 里那份；生产字面量只允许在 `docs/deploy/` 运维手册中）。
6. 其他服务包（connectors/browser/cron/account-card）与品牌素材不动。
7. 提交时只 `git add` 自己改的文件；**禁止** `git add -A` / `git add .`（工作区有大量未跟踪杂项）。

---

## 7. 验收标准（AC1–AC15）

AC1–AC13 来自设计蓝图 §5.2（全部采纳），AC14/AC15 为 D8/D9 追加。

| # | 判定陈述 | 判定命令 / 断言 |
|---|---|---|
| **AC1** | 服务端**拒绝**指向 loopback（`localhost`/`127.0.0.1`/`127.1.2.3`/`::1`/`[::1]`）、链路本地与云 metadata（`169.254.169.254`/`fd00:ec2::/64`）、unspecified（`0.0.0.0`）的 DSN：HTTP 400 + JSON 信封 `{"error":{"code":"VALIDATION","message":"…中文…"}}`，且 **settings 未被写入**；合规公网 DSN 行为与今天完全一致（200 + 写库） | `cd server && go test ./internal/llmgateway/ -run TestValidateErrorReportingDSN -v` 全 PASS；`TestSetGatewayConfigDSNRejected` 断言 400 + 库值不变 |
| **AC2** | webadmin 在**发请求之前**就拦下同类 DSN，给出中文报错且**不产生 PUT**；合规 DSN 仍提交 | `cd server/webadmin && npm test -- ErrorMonitoring` 新增「拒绝指向本机的 DSN 并给出中文提示」用例 + 既有用例不回归 |
| **AC3** | 「发送测试事件」：可达 → 200 `{ok:true,event_id,http_status}` 且 GlitchTip 侧新增 issue；不可达 → 5xx + **可读中文原因**且 `detail.kind ∈ {DNS,CONNECT,TLS,TIMEOUT,HTTP_4XX,HTTP_5XX}` | `cd server && go test ./internal/llmgateway/ -run TestErrorReportingTestEvent -v` |
| **AC4** | 客户端 init 失败**不再静默**：`getErrorReportingStatus().state === 'failed'` 且带 `reason`，同时 `ctx.logger.warn` 被调用；`enabled!==true` / `fellBack=true` / bootstrap 抛错三种情形分别得到 `disabled` / `config_unavailable` / `config_unavailable`，且**都至少一条 warn** | `corepack yarn workspace @picoaide/dsh-enterprise test -- error-reporting` 全 PASS |
| **AC5** | 客户端状态可上报并被 webadmin 看到：`POST /api/client/v2/telemetry/error-reporting` 200 + upsert；`GET .../gateway/error-reporting/clients` 返回统计与 `items[]`；页面渲染「已启用 N / 失败 M」与最近原因 | `go test ./internal/telemetry/ -run TestReportErrorReportingStatus -v`；`PG_DSN_TEST=… go test ./internal/serverstore/ -run ErrorReporting -v`（须见 `--- PASS` 而非 `--- SKIP`）；`cd server/webadmin && npm test -- ErrorMonitoring` |
| **AC6** | 打包产物断言：`afterPack` 阶段用**打包后的 Electron**（`ELECTRON_RUN_AS_NODE=1`）`require('@sentry/node')` 成功且 `error-reporting` 可解析，stdout 出现 `SENTRY-SMOKE-OK`；缺失时 **afterPack 硬失败** | `corepack yarn workspace dsh-plugin-desktop vitest run tests/verify-packaged-runtime.spec.ts` 全 PASS；`REQUIRED_ASAR_EXPORTS` 含 `error-reporting` |
| **AC7** | 正向心跳：`heartbeat=true` 时带 `picoaide.heartbeat` tag 的 info 事件**通过** `beforeSend`；开关 false 时**不发**；开关 true 时**普通** info 事件**仍被**过滤（证明 `error_reporting_level` 语义未变） | `corepack yarn workspace @picoaide/dsh-enterprise test -- error-reporting`；`go test ./internal/llmgateway/ -run TestGatewayHeartbeatSetting -v`；`npm test -- ErrorMonitoring` |
| **AC8** | （条件性，取决于 H5 验证结论）主进程致命异常发生后 GlitchTip **确实**收到该事件；若判定为"丢失"，修复后必须复测通过并在文档中记录修复前后的观测差异 | 打包态 + Xvfb 注入未捕获异常 → issue 计数 +1 |
| **AC9** | 四条命令全绿：`enterprise typecheck` / `enterprise test` / `webadmin npm test` / `go test ./internal/llmgateway/` | 四条 exit code = 0；失败时必须**单独**重跑被改测试文件以区分"与本次无关的既有失败" |
| **AC10** | `corepack yarn check` 全绿；若有既有失败，逐条列出并给出**归属判定**（缺依赖 / `lib/` 比 `src/` 旧 / 与本轮无关） | `corepack yarn check`；时间戳比对 `ls -la --time-style=+%m-%d_%H:%M …/lib/ …/src/` |
| **AC11** | 运维手册落地：`docs/` 下存在文档，写清 `GLITCHTIP_DOMAIN` 与 `MAIN_URL` 的区别、`GLITCHTIP_DOMAIN=https://glitchtip.example.com` 的修法、以及生产 DSN 正确写法 `https://<glitchtip-public-key>@glitchtip.example.com/1`；**不要求也不允许代理执行生产改配置** | `grep -l 'GLITCHTIP_DOMAIN' docs/**/*.md` 命中；文件含上述完整 DSN 字符串 |
| **AC12** | 交付物归位：蓝图/实施/决策按需求书 §8 归入 `docs/planning/`、`docs/decisions/`；若本轮打 tag，`docs/releases/<tag>.md` **必须存在** | `ls docs/planning/2026-09-16-glitchtip-error-collection-*.md docs/decisions/2026-09-16-glitchtip-error-collection.md`；tag 前 `node scripts/check-workflows.mjs` |
| **AC13** | E2E 夹具不再假绿、不再携带生产上报地址：`e2e-fixture-gateway.mjs` 的 `web` 段**不含** `glitchtip.example.com` / 生产 public key 字面量，且 `error_reporting_enabled: true`；`e2e:client` 能**断言上报被触发** | `grep -c 'glitchtip.example.com\|<glitchtip-public-key>' …/e2e-fixture-gateway.mjs` → **0**；`grep -c 'error_reporting_enabled'` → **≥1**；`e2e:client` 报告含上报断言且 pass |
| **AC14**（D8 新增） | 渲染进程未捕获错误（`window.onerror` / `unhandledrejection` / `render-process-gone`）能被主进程捕获并上报到 GlitchTip；渲染进程侧**不出现任何 DSN 或直连流量** | preload 转发单测 + 主进程 handler 单测；发布树/运行时断言渲染侧无 DSN 字面量 |
| **AC15**（D9 新增） | 生产现场修复后，`GET /api/0/projects/picoaide/picoaide-web/keys/` 返回的 DSN 主机为 `glitchtip.example.com`（不再是 `localhost:8000`），且 issue permalink 同样正确 | 修后只读 `curl` 该端点 + 任取一条 issue 看 `permalink` |

---

## 8. 审计策略

**按横切面并行 4 个审计 agent**（`args.auditModules`）—— 每个只审一条纵向切片，避免互相等待：

| 模块 | 范围 |
|---|---|
| `server-validation` | P0-1 / P0-2 / P0-4 / P1-4：Go 侧准入校验、SSRF 护栏（含"私网放行是有意的"这一判据）、错误分类、跨语言规则对拍 |
| `client-observability` | P0-3 / P1-2 / P1-3 / **P0-6(D8)**：客户端状态机、心跳 tag 例外、渲染采集、失败不影响宿主 |
| `packaging-gate` | P1-1 / P1-6：打包 smoke 断言是否真能抓住漏打（**空转反证**）、E2E 是否真断言 |
| `docs-ops` | P2-1 / P2-2 / P2-4 / **D9**：文档归位与准确性、运维手册可执行性、release notes |

**复核阶段（agent-reviewer）必做**（P0 数量 ≥5）。

**审计必须自查的两个方法论盲区**（写进审计报告的"盲区反思"）：
① 只看代码不看产物 —— F10 的教训是"发布树实测"才是否证的权威手段；
② 门禁恒绿 —— 新增断言必须做一次**空转反证**（故意写错包名 → afterEach/afterPack 必须红），
否则断言可能从未真正生效。

---

## 9. 后续轮次登记（本轮不做，避免下次再误判）

| # | 事项 | 处置 |
|---|---|---|
| N-1 | `@sentry/browser` 集成 + sourcemap 上传链 | D8 明确不含，另开一轮 |
| N-2 | 主进程致命异常的**退出竞态**（H5，`uncaughtException` 先于 Sentry 注册，全仓无退出时 `Sentry.close()`） | P1-5 先验证再按结论修；AC8 条件性 |
| N-3 | 启动期 / 登录流程本身的崩溃（无 session 即无 DSN）永不上报 | 设计取舍，本轮不改，写进文档 |
| N-4 | 打包产物含 workspace 包的 `src/`/`tests/`/`docs/`（体积与信息面） | 与本需求无关，登记不动 |
| N-5 | `error_reporting_level` 的 UI 无 `fatal` 选项而 `LEVEL_RANK` 有 | 非缺陷（`fatal` 只能由 SDK 自身产生），登记不改 |

---

## 10. 相关文档

- 设计蓝图：`docs/planning/2026-09-16-glitchtip-error-collection-design.md`
- 实施计划：`docs/planning/2026-09-16-glitchtip-error-collection-implementation.md`
- 运维手册（人工执行，AC11）：`docs/deploy/2026-09-16-glitchtip-selfhost-operations.md`
- 只读核查脚本：`scripts/glitchtip-ops-check.mjs`
- 部署与升级总则：`docs/deploy/AI-DEPLOY.md`

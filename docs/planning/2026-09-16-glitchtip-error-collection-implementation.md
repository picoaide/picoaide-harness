# GlitchTip 错误收集修复 —— 实施计划

> 权威设计：[设计蓝图](2026-09-16-glitchtip-error-collection-design.md)（v1，本目录）
> 拍板结论：[决策记录](../decisions/2026-09-16-glitchtip-error-collection.md)（D1–D9 / AC1–AC15）
> 分支：`fix/glitchtip-error-collection-20260916`（基点 `master` = `39692cac6e`）
> 目标：让「客户端 → GlitchTip」链路**坏得可见、坏得进不去**，并补上打包防线。
>
> **归位说明（P2-1，2026-09-16）**：本文件由本轮编排的 `IMPLEMENTATION.md`（**未经版本库跟踪**的
> 工作稿）**逐字迁入** `docs/` 永久位置（正文未改，只修正跨文件引用并改写本节头部）。
> **修复轮 1（2026-09-16）的追加章节见文末「修复轮 1」**（F-01…F-16 的修复与验证记录）。
> 迁入后**本文件即权威**。
>
> **范围增补（以决策记录为准）**：本计划成文于拍板之前 —— **D8（渲染进程采集）是后续新增范围**，
> 正文里**没有**对应任务号；编码员按决策记录「D8 增量规格」实现，并登记为 **P0-6**。
>
> **本文引用的外部文件（按可点击句柄索引）**：下文 `PLAN.md` / `PLAN §x` =
> [设计蓝图](2026-09-16-glitchtip-error-collection-design.md)（= 本计划成文时的 `PLAN.md`）；
> `REQUEST.md`（§5/§8）、`EVIDENCE-ADDENDUM.md`、`DECIDED.md`、`TASKS.md` 均为本轮编排的
> **工作稿文件名**（在未跟踪的黑板目录里，**故不给链接** —— 提交后必然 404）。
>
> **⚠️ 未跟踪目录说明（修复轮 1，F-16）**：本轮协作黑板 `.multiagent/glitchtip-collect-fix/`
> **不在版本库中**（`git check-ignore` exit 1、未被跟踪），所以本文**不提供**指向它的链接 ——
> 那些链接在提交后必然 404。它在提交前承载 `REQUEST.md`（需求书 + 现场事实 F1–F9）、
> `EVIDENCE-ADDENDUM.md`（实测补充 F10–F13）、`DECIDED.md`（拍板结果）、`TASKS.md`（勾选清单）；
> **结论性内容已分别落在**：[决策记录](../decisions/2026-09-16-glitchtip-error-collection.md)（D1–D9/AC1–AC15）、
> [本文件](2026-09-16-glitchtip-error-collection-implementation.md)（任务分解 + 实际验证记录）、
> [运维手册](../deploy/2026-09-16-glitchtip-selfhost-operations.md)（现场事实与修法）。
> 正文里出现的 `REQUEST.md` / `DECIDED.md` / `TASKS.md` 一律按**当时的黑板文件名**理解。
>
> **行号使用说明**：下表行号均为 **勘察时（HEAD = `39692cac6e`）** 的真实行号。
> 同文件内先完成的任务会使后续行号位移 ⇒ **改动时按锚点定位**（函数名 / 唯一字符串 / 唯一代码片段），
> 不要机械照抄行号。每个任务都给了锚点。

---

## 前置检查（编码前必做，15 分钟）

| # | 动作 | 命令 | 期望 | 为什么 |
|---|---|---|---|---|
| PRE-1 | 确认基点未被推进 | `git fetch origin master && git log --oneline -1 origin/master` | 若已前进，先 `git merge origin/master` 再开工 | 本仓有并行会话，master 常被推进 |
| PRE-2 | 确认构建产物不陈旧 | `ls -la --time-style=+%m-%d_%H:%M packages/host/enterprise/lib/ packages/host/enterprise/src/` | `lib/` 不早于 `src/`；否则 `corepack yarn workspace @picoaide/dsh-enterprise build` | 产物比源码旧是**假红**的头号来源 |
| PRE-3 | 跑一遍基线门禁 | `corepack yarn workspace @picoaide/dsh-enterprise test` / `cd server/webadmin && npm test` / `cd server && go test ./internal/llmgateway/` | 记录**改动前**的通过/失败数量，作为归属基准 | 后续任何红都要能区分"我改坏的"还是"本来就红" |
| PRE-4 | **判定 H3′（§PLAN 2.6）** | 只读：生产 `SELECT value FROM settings WHERE key='gateway.default_model'` + 模型表行数；或带客户端 token 的 `curl .../api/client/v2/config/bootstrap` | `models` **非空** ⇒ H3′ 排除；**为空** ⇒ 升格为 P0 | 只需一次查询，可能直接改变 P0 排序 |
| PRE-5 | 确认 PG 测试库可用 | `psql postgres://postgres:postgres@127.0.0.1:5432/picoaide_test -c 'select 1'` | 成功 ⇒ DB 用例真跑；失败 ⇒ 相关用例会 SKIP，**不能当绿** | DB 用例必须看 `--- PASS` 而非 `--- SKIP` |

---

## 可用的现场产物（编码/验证直接复用，**均未跟踪，不要提交**）

| 路径 | 用途 |
|---|---|
| `.glitchtip-recon/artifact/shipped/` | **生产 2.7.5-beta.2 解包树**（`package.json` version=2.7.5-beta.2）。可直接 `require('@sentry/node')` / `import('@picoaide/dsh-enterprise/error-reporting')`，是 H1 类问题的**权威对照组** |
| `.glitchtip-recon/artifact/shipped/probe.mjs`、`probe2.mjs` | 在发布树里跑的上报探针（`probe2` = `level=error` 盲区复现，对应 F11） |
| `.glitchtip-recon/client-probe.mjs` | 用**仓库内已构建**的 `lib/error-reporting.js` 对真实 GlitchTip 发事件：`node client-probe.mjs <dsn> <label>` |
| `.glitchtip-recon/c.txt` | GlitchTip 管理员 cookie jar（只读 API 复用；**禁止**用它做任何写操作/改远端状态） |
| `packages/host/desktop/dist/linux-unpacked/` | 本地 **2.5.7 旧构建**（`lib/error-reporting.js` 是旧版）——**只能用于对照，不能当结论依据** |

> ⚠️ 一切对 GlitchTip 的写操作（包括发测试事件）只允许发生在**本地验证**时；
> 生产主机与生产 GlitchTip 实例**只读**，本轮禁止 ssh / 改配置 / 重启容器。

---

## P0 —— 不做就没修好

### P0-1 服务端 DSN 准入校验（权威拦截）

- **目标**：任何指向 loopback / 链路本地 / 云 metadata / unspecified 的 DSN 一律 **400 拒绝且不写库**，
  绕过 webadmin 直接 PUT 也拦得住。
- **要改的文件:行号 / 锚点**
  - 新建 `server/internal/llmgateway/dsn.go`
  - `server/internal/llmgateway/admin.go` —— 锚点 `if req.ErrorReportingDSN != nil {`
    （**勘察时行号 `:921-927` 已失准**：复核实测该范围是 `gateway.rate_limit` 写入块；
    校验实现在 `:888-899` 一带，引用时按锚点定位）。要求：校验插在
    `auditSetSetting(db, "web.error_reporting_dsn", …)` **之前**
- **改动要点**
  1. `dsn.go` 导出 `ValidateErrorReportingDSN(raw string) error`：
     - 空串直接放行（= 不启用，允许清空）。
     - `url.Parse` 必须成功、scheme ∈ {`http`,`https`}、`User` 必须含用户名（public key）、
       path 最后一段必须是正整数（project id）。**不引入新的宽松度**：解析失败即拒绝。
     - 主机名判定（**自己实现，不改 `util/netguard.go`**，见 PLAN §2.16 红线）：
       - `localhost`（大小写不敏感，含 `*.localhost`）、`[::1]`、`127.0.0.0/8`（含 `127.1.2.3` 这种非点分标准写法要能被 `net.ParseIP` 归一后识别）
       - 复用 `util.IsBlockedOutboundIP()` 覆盖链路本地 / 云 metadata / unspecified / `fd00:ec2::/64`
       - **私网（10/8、172.16/12、192.168/16）只告警不拒绝**（返回 `warn string`，由 handler 透出）
  2. handler 侧：拒绝时 `serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "错误上报 DSN 不能指向本机或云元数据地址(localhost/127.0.0.1/::1):客户端会把事件发往自己的电脑,永远收不到")`，
     **立即 return**（不落 `changes`、不写 settings）。
  3. 纯函数 + `http.Handler` 无关 ⇒ 单测不需要 DB；handler 级用例复用现有 harness。
- **测试文件与用例名**
  - 新建 `server/internal/llmgateway/dsn_test.go`
    - `TestValidateErrorReportingDSN`（table-driven：accept 6 例 / reject 12 例 / warn 4 例）
    - 必含：`http://key@localhost:8000/1`（F6/F8 的现场值）、`http://key@127.0.0.1/1`、
      `http://key@[::1]/1`、`http://key@127.1.2.3/1`、`http://key@169.254.169.254/1`、
      `http://key@0.0.0.0/1`、`ftp://key@h/1`、`https://h/1`（缺 key）、`https://key@h/abc`（project 非数字）
    - 必含 accept：`https://<glitchtip-public-key>@glitchtip.example.com/1`（**生产真值**）、
      带路径前缀 `https://key@host/prefix/1`、带端口、`https://key@10.0.0.5/1`（私网 → accept + warn）
  - 追加到 `server/internal/llmgateway/admin_test.go`（复用 `adminTestSetup` / `adminReq`）：
    - `TestSetGatewayConfigRejectsLoopbackDSN` —— PUT `{"error_reporting_dsn":"http://key@localhost:8000/1"}`
      → `w.Code == 400`、`out["error"]["code"] == "VALIDATION"`，
      **且** `serverstore.GetSetting(db,"web.error_reporting_dsn")` 的旧值未变
    - `TestSetGatewayConfigAcceptsPublicDSN` —— 生产真值 → 200 + 库值已写入
- **验证方式**
  ```bash
  cd server && go test ./internal/llmgateway/ -run 'ValidateErrorReportingDSN|SetGatewayConfigRejectsLoopbackDSN|SetGatewayConfigAcceptsPublicDSN' -v
  # 期望：逐条 --- PASS（DB 用例须为 PASS 而非 SKIP）
  cd server && gofmt -l internal/llmgateway/     # 期望：无输出
  ```
- **依赖**：无。**阻塞** P0-2 / P0-4 / P1-4。

---

### P0-2 webadmin 保存前拦截 + 中文报错

- **目标**：管理员点「保存」时，坏 DSN 在**发请求之前**就被拒，给出中文提示。
- **要改的文件:行号 / 锚点**
  - `server/webadmin/src/pages/ErrorMonitoring.tsx:55-58` —— 锚点 `if (cfg.error_reporting_dsn && !/^https?:\/\//i.test(...))`
  - 新建 `server/webadmin/src/lib/dsn.ts`
- **改动要点**
  1. `dsn.ts` 导出 `validateErrorReportingDsn(raw: string): { ok: true } | { ok: false; message: string }`，
     规则与 P0-1 **逐字一致**（同一批 accept/reject 语料，见 P1-4 的对拍测试）。
     报错文案与 Go 侧保持同一措辞（便于两侧测试共享语料）。
  2. `ErrorMonitoring.tsx` 的 `save()`：把现有 `:55-58` 的协议检查替换为 `validateErrorReportingDsn()`；
     不通过 → `setError(msg)` + `return`（**不进入 `setBusy(true)` / 不发 PUT**）。
  3. 私网/http 的黄条告警留到 P2-3（P0 只做硬拒绝）。
- **测试文件与用例名**
  - `server/webadmin/src/pages/ErrorMonitoring.test.tsx` 新增：
    - `'拒绝指向本机的 DSN 并给出中文提示(不发 PUT)'` —— 输入 `http://key@localhost:8000/1`，点保存，
      断言页面出现中文提示且 `mockRequest` **没有**被以 PUT 调用
    - `'接受生产形态的公网 DSN'` —— 输入 `https://<glitchtip-public-key>@glitchtip.example.com/1`，
      断言发生 PUT 且 body 中该字段一致
  - 既有 4 个用例（`:24` `:34` `:60` `:69`）**必须保持绿**（`:65` 逐字断言旧文案 ⇒ 若改文案要同步）
- **验证方式**
  ```bash
  cd server/webadmin && npm test -- ErrorMonitoring
  # 期望：Test Files 1 passed；Tests 由 4 → ≥6 passed
  cd server/webadmin && npm run typecheck        # 期望 exit 0
  ```
- **依赖**：P0-1（规则语料同源）。

---

### P0-3 客户端失败可观测（状态机 + warn 落盘）

- **目标**：`initSentry` / `sync` 的每一个静默分支都变成**可查状态 + 会落盘的 warn**，
  且**绝不**影响宿主其它功能。
- **要改的文件:行号 / 锚点**
  - `packages/host/enterprise/src/error-reporting.ts`
    - `:36-37` 模块级 `sentry` → 旁边新增状态变量（锚点 `let sentry: SentryModule | null = null`）
    - `:48` `initSentry` 的签名与返回（锚点 `export async function initSentry(`）
    - `:56-57` 空 DSN 分支 → `disabled`
    - `:79-83` catch 分支 → 记录 `failed` + **warn**（锚点 `console.warn('error-reporting: Sentry init 失败`）
    - `:95-117` `sync()` 的四个分支（锚点 `const sync = async (session: Session | null)`）
    - `:102` `const { config } = await getBootstrap(session)` → **解构出 `fellBack`**
    - `:106` / `:112-116` 日志级别与内容
- **改动要点**
  1. 新增导出（见 PLAN §4.2）：
     ```ts
     export type ErrorReportingState =
       | { state: 'idle' } | { state: 'disabled' }
       | { state: 'ready'; dsnHost: string; level: string }
       | { state: 'failed'; reason: string; dsnHost?: string }
       | { state: 'config_unavailable'; reason: string }
     export function getErrorReportingStatus(): ErrorReportingState
     ```
     模块级 `let status: ErrorReportingState = { state: 'idle' }`，每次 `sync` 结束前更新。
     **导出内联函数而不是导出可变绑定**（tsdown/ESM 下外部拿到的是快照，必须走函数；已有同类教训见仓内 memory-evolve 的 `.events` 踩坑）。为便于测试，同时导出 `resetErrorReportingStatusForTest()`（或让 `initSentry('')` 复位）。
  2. `initSentry` 返回 `Promise<{ ok: true } | { ok: false; reason: string }>`；
     **不再吞异常**（仍不抛出，保证 fail-soft）。
  3. `sync()` 分支映射：
     | 分支 | 状态 | 日志 |
     |---|---|---|
     | `session === null` | `disabled` | 保持 `debug`（登出是常态，不刷屏） |
     | `enabled !== true` 或 dsn 空 | `disabled` | **`logger.warn` 但每进程只一次**（避免每次登录刷屏）；文案含「错误上报未启用(开关关闭或 DSN 为空)」 |
     | `fellBack === true` | `config_unavailable` | **`logger.warn`**：`'错误上报:服务端配置不可用(models 为空,已回退空配置),本次不上报'` ★核心修复 |
     | `getBootstrap` 抛错 | `config_unavailable` | 现有 `:114-116` 的 warn 保留，补进状态与 `reason` |
     | `initSentry` 失败 | `failed` | **`logger.warn`**（含 `reason`），并 `console.warn` 保留 |
     | 成功 | `ready` | **`logger.info`**（默认阈值 `info` ⇒ 会落盘），文案含 `dsnHost` + `release` |
  4. **绝不打印完整 DSN**：只打 `new URL(dsn).host` 与 `level`。
  5. 保持 `inject = ['picoSession']`、`subscribeSession` 用法、`beforeSend` 语义不变。
- **测试文件与用例名**
  - `packages/host/enterprise/tests/error-reporting.spec.ts`
    - **适配**：`:83-88` 「degrades silently when a prior instance is closed」的
      `resolves.toBeUndefined()` → 改为断言 `{ ok: false }` 或 `{ ok: true }`（**必改，否则红**）
    - 新增（用 `vi.mock('../src/server-connector/bootstrap.ts')` 控制 `getBootstrap`）：
      - `'reports failed status and warns when Sentry init throws'`
      - `'reports config_unavailable when bootstrap rejects'`
      - `'reports config_unavailable when bootstrap falls back to EMPTY'` ★（H3′ 的回归防线）
      - `'reports disabled without a DSN and warns only once'`
      - `'reports ready with the dsn host and never logs the full DSN'`（断言 logger 收到的字符串**不含** public key）
- **验证方式**
  ```bash
  corepack yarn workspace @picoaide/dsh-enterprise typecheck   # 期望 exit 0
  corepack yarn workspace @picoaide/dsh-enterprise test        # 期望全绿；error-reporting 由 7 → ≥12
  ```
- **依赖**：无（与 P0-1/P0-2 并行安全）。

---

### P0-4 服务端「发送测试事件」+ webadmin 按钮

- **目标**：管理员点一下就知道链路通不通，失败给**可读原因**（DNS/连接/TLS/超时/HTTP 4xx/5xx）。
- **要改的文件:行号 / 锚点**
  - 新建 `server/internal/llmgateway/errorreporting_test_event.go`（或并入 `dsn.go`，二选一，**建议独立文件**）
  - `server/internal/llmgateway/handlers.go:25-51` `Handlers` 结构 → 加 `TestErrorReporting gin.HandlerFunc`
    （锚点 `ConcurrencyStatus gin.HandlerFunc`）+ `:53+` `NewHandlers` 里接线
  - `server/internal/llmgateway/admin.go:59` `RegisterAdminRoutes` → 加测试辅助路由
  - `server/internal/router/router.go:291-292` 之后 → **生产路由唯一真源**加一行
  - `server/webadmin/src/pages/ErrorMonitoring.tsx`：`:161-163` 保存按钮所在的 footer 区加「发送测试事件」按钮与结果面板
- **改动要点**
  1. Go：`POST {NamespaceServer}/admin/gateway/error-reporting/test`，`PermGatewayWrite`
     （与 `:274` 的 `POST /auth/test` 同权限档）。请求 `{dsn?:string}`，缺省用当前已保存值。
  2. 实现：
     - `ValidateErrorReportingDSN` 先跑一遍（**保存前校验与测试事件共用同一规则**）；
     - 由 DSN 推导 store 端点 `{proto}://{host}[:{port}]{prefix}/api/{project_id}/store/`；
     - **必须**用 `util.SafeOutboundTransport()` 建 client，并在发请求前 `util.CheckOutboundTarget(ctx, host)`；
       `timeout 8s`（`context.WithTimeout`）；`redirect` 不跟随（或跟随但复检）；
     - 请求头 `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<public>, sentry_client=picoaide-server/<BuildVersion>`；body 为最小事件
       （`event_id`(32hex) / `timestamp` / `level:"error"` / `message:"PicoAide 管理端连通性自检"` / `platform:"other"` / `release`），
       **不含任何服务端机密**；
     - 错误分类 → `detail.kind ∈ {DNS, CONNECT, TLS, TIMEOUT, HTTP_4XX, HTTP_5XX}`（`net.DNSError`→DNS、
       `ECONNREFUSED/EHOSTUNREACH/ENETUNREACH`→CONNECT、`x509.*`/`tls:`→TLS、`context.DeadlineExceeded`→TIMEOUT）；
     - 成功 → `200 {"ok":true,"event_id":…,"http_status":…,"endpoint":…,"elapsed_ms":…}`；
       失败 → `502` + 统一错误信封 + `detail`。
  3. **必须在响应体与 UI 文案里写清「服务端视角」**（PLAN §3.3 的局限）：例如
     `detail.note: "本结果由服务端发起,证明服务端到上报地址可达;员工客户端的网络环境可能不同"`。
  4. 代码注释写明：这是**管理员显式动作 + 权限受控**的出站请求，`netguard` 有意允许私网（内网自建 GlitchTip），
     不是 SSRF 漏洞（预防下一轮审计误判）。
  5. webadmin：按钮触发 `request(`${ADMIN_API}/gateway/error-reporting/test`, {method:'POST', body: JSON.stringify({dsn: cfg.error_reporting_dsn.trim()})})`；
     成功显示绿色「测试事件已发送（event_id 前缀…）」；失败显示红字 `detail.kind` + message。
- **测试文件与用例名**
  - 新建 `server/internal/llmgateway/errorreporting_test_event_test.go`
    - `TestErrorReportingTestEventSuccess`（`httptest.NewServer` 假装 GlitchTip：断言收到
      `X-Sentry-Auth` 含正确 key、body 可解析、返回 200 → handler 200 且 `event_id` 是 32 hex）
    - `TestErrorReportingTestEventConnectRefused`（`httptest` 起后**立即 Close** 拿一个死端口 → 502 + `kind=CONNECT`）
    - `TestErrorReportingTestEventHTTP4xx`（mock 返回 403 → `kind=HTTP_4XX`）
    - `TestErrorReportingTestEventTimeout`（mock `time.Sleep(9s)` → `kind=TIMEOUT`）；
      为提速用可注入的超时变量（包级 `var errorReportingTestTimeout = 8*time.Second`，测试里临时调小）
    - `TestErrorReportingTestEventRejectsLoopbackDsn`（不发网络请求，直接 400 VALIDATION）
  - `server/webadmin/src/pages/ErrorMonitoring.test.tsx` 新增
    `'发送测试事件成功时显示成功提示'` / `'发送测试事件失败时显示可读原因'`
- **验证方式**
  ```bash
  cd server && go test ./internal/llmgateway/ -run TestErrorReportingTestEvent -v   # 期望逐条 --- PASS
  cd server/webadmin && npm test -- ErrorMonitoring
  # 真实验证（可选，需真实 GlitchTip 读取权限）：
  #   点一次按钮后 GET /api/0/projects/picoaide/picoaide-web/issues/ 应新增一条
  #   「PicoAide 管理端连通性自检」；用生产 DSN 与坏 DSN 各跑一次
  ```
- **依赖**：P0-1（复用校验器）。**阻塞** P2-3（UI 打磨）。

---

### P0-5 E2E 夹具去硬编码 + 打开上报开关

> 来源：EVIDENCE-ADDENDUM F13 / PLAN §2.19。**不做这条，`e2e:client` 会持续给出"上报面已验证"的假绿，
> 且生产上报地址继续留在受版本控制的源码里**（2026-08-27 已为该域名做过一次历史清理，这是同类复发）。
> **建议与 P0 同批提交**（改动极小）。

- **目标**：E2E mock 网关不再携带任何生产上报地址，并真正打开上报开关。
- **要改的文件:行号 / 锚点**
  - `packages/host/desktop/scripts/e2e-fixture-gateway.mjs:57` —— 锚点
    `web: { error_reporting_dsn: 'https://<glitchtip-public-key>@glitchtip.example.com/1' },`
  - 同文件内检索：`glitchtip.example.com` / `<glitchtip-public-key>` 的**全部**出现点
- **改动要点**
  1. 把 DSN 换成**本地 mock**：`http://e2e-key@127.0.0.1:<mockPort>/1`。
     ⚠️ 注意：`127.0.0.1` 在新规则下属于 **loopback**（P0-1 会拒绝）——所以这里要么
     用 mock 网关自身的**非 loopback 别名**（如容器/主机名），要么在 mock 的 bootstrap 里
     直接用 `error_reporting_enabled: false` + 由 E2E 断言"状态为 disabled"。
     **推荐**：mock 网关新增一个 `POST /api/1/store/` 端点，DSN 用 `http://e2e-key@127.0.0.1:<port>/1`
     并**只在 E2E 进程内**使用（E2E 校验发生在 webadmin，不在客户端），从而可以真正断言"客户端把事件发到了 mock"。
  2. `web` 段补 `error_reporting_enabled: true`、`error_reporting_level: 'debug'`（否则任何断言都会被阈值吃掉）。
  3. `web: {}` 的 `models` 必须保持非空（`e2e-fixture-gateway.mjs:46-52` 已是非空）——**否则会触发 §2.6 的 `EMPTY` 回退**，
     这条要在文件里加一行注释钉住（防止后人删掉 models 造成新的假绿）。
- **测试 / 验证方式**
  ```bash
  grep -c 'glitchtip.example.com\|<glitchtip-public-key>' packages/host/desktop/scripts/e2e-fixture-gateway.mjs
  # 期望输出：0
  grep -c 'error_reporting_enabled' packages/host/desktop/scripts/e2e-fixture-gateway.mjs
  # 期望输出：>= 1
  node --check packages/host/desktop/scripts/e2e-fixture-gateway.mjs   # 语法自检
  # 全仓复查（确认没有别处硬编码）：
  grep -rn '<glitchtip-public-key>' --include='*.mjs' --include='*.ts' --include='*.tsx' --include='*.go' \
    packages/ server/ | grep -v node_modules
  # 期望：除 .multiagent/ 与本任务新增的 mock 值外无命中
  ```
- **依赖**：无。**阻塞** P1-6。

---

## P1 —— 让问题下次能被发现
### P1-1 打包产物断言：`@sentry/node` + `error-reporting` 可解析可 require

- **目标**：把 H1 类故障（SDK 或插件没进包）从"运行期静默"变成"打包期硬失败"。
- **要改的文件:行号 / 锚点**
  - `packages/host/desktop/scripts/verify-packaged-runtime.ts`
    - `:576-596` `REQUIRED_ASAR_EXPORTS` —— 补 `{ specifier: '@picoaide/dsh-enterprise/error-reporting', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/error-reporting.js' }`
      （同批补 `skill-telemetry` / `channel-sync` / `invariant` 三个同样存在的行，见锚点 `REQUIRED_ASAR_EXPORTS`）
    - `:857-1063` flock smoke 区域 —— 照抄范式新增 `SENTRY_SMOKE_SCRIPT` + `smokePackagedErrorReporting()`
      （锚点 `FLOCK_SMOKE_SCRIPT` / `smokePackagedFlockLock`）
    - `:1073-1088` `afterPack()` —— 在 `flockSmoke(context)`（`:1087`）之后加一行调用
  - `packages/host/desktop/tests/verify-packaged-runtime.spec.ts` —— 新增用例
- **改动要点**
  1. `SENTRY_SMOKE_SCRIPT`（跑在**打包后的 Electron** 里，`ELECTRON_RUN_AS_NODE=1`，
     这样才有 Electron 的 asar fs patch；普通 Node 读不了 asar）：
     ```js
     const appRoot = process.argv[2]
     const appRequire = createRequire(join(appRoot, 'package.json'))
     const sentryUrl = appRequire.resolve('@sentry/node')
     const sentry = appRequire('@sentry/node')
     if (typeof sentry.init !== 'function') throw new Error('@sentry/node.init is not a function')
     const plugin = await import(pathToFileURL(appRequire.resolve('@picoaide/dsh-enterprise/error-reporting')).href)
     for (const key of ['apply', 'initSentry', 'name']) {
       if (!(key in plugin)) throw new Error(`error-reporting plugin is missing export ${key}`)
     }
     process.stdout.write('SENTRY-SMOKE-OK\n')
     ```
  2. `smokePackagedErrorReporting(context, launch)`：
     - `win32` **不跳过**（`@sentry/node` 是纯 JS，三平台都要过）；但要用与 flock smoke 相同的方式
       解析 launcher（复用 `resolvePackagedLauncherCandidates`），并在找不到 launcher 时**报错而不是静默跳过**；
     - 超时沿用 `PACKAGED_FLOCK_SMOKE_TIMEOUT_MS`（或新增同名常量）；
     - 退出码 ≠ 0 或 stdout 无 `SENTRY-SMOKE-OK` → **抛错**（fail-loud）。
  3. `REQUIRED_ASAR_EXPORTS` 的补充走 `verifyUnpackedPackageResolution`（`:604-616`）的既有路径 ⇒ 零新逻辑。
  4. **不做**：不往 `files`/`asarUnpack` 加任何 sentry 条目（见 PLAN §3.6 红线）。
- **测试文件与用例名**（`packages/host/desktop/tests/verify-packaged-runtime.spec.ts`）
  - `'requires the enterprise error-reporting export in app.asar'`（缺条目 → `verifyPackagedRuntime` 抛错，错误信息含 `error-reporting`）
  - `'fails the afterPack gate when the sentry smoke reports a missing module'`（注入假 launcher 返回 `status:1` + stderr `Cannot find module '@sentry/node'`）
  - `'fails when the sentry smoke exits 0 without the success marker'`（防"静默成功"空转，照抄 flock smoke 的 `FLOCK-SMOKE-OK` 教训）
  - `'passes when the sentry smoke prints SENTRY-SMOKE-OK'`（注入 `status:0` + stdout 标记）
  - `'does not skip the sentry smoke on win32'`（断言 win32 分支仍调用 launcher）
- **验证方式**
  ```bash
  corepack yarn workspace dsh-plugin-desktop vitest run tests/verify-packaged-runtime.spec.ts
  # 期望：全绿（既有用例 + 新增 5 个）
  # 真机/CI 全链（可选，耗时）：
  corepack yarn workspace dsh-plugin-desktop vitest run tests/package.spec.ts tests/package-win.spec.ts
  # 门禁空转反证（必做一次，做完还原）：
  #   临时把 SENTRY_SMOKE_SCRIPT 里的包名改成 '@sentry/does-not-exist' 跑 afterPack → 必须失败
  ```
- **依赖**：无。**注意**：desktop 侧唯一允许的改动点（AGENTS.md「test adaptations in desktop-owned scripts are allowed」），
  提交信息里写明理由，避免审计判为越界。

---

### P1-2 正向心跳开关（独立于等级阈值）

- **目标**：给管理员一个**显式**手段证明「客户端 → GlitchTip」这一跳活着，且**不改变** `error_reporting_level` 语义。
- **要改的文件:行号 / 锚点**
  - `server/internal/bootstrap/bootstrap.go:20-38` `WebConfig` → 加 `ErrorReportingHeartbeat bool \`json:"error_reporting_heartbeat"\``；
    `:159-176` 组装处加 `web.ErrorReportingHeartbeat = settings["web.error_reporting_heartbeat"] == "true"`
  - `server/internal/llmgateway/admin.go:844-848` 请求结构 → 加 `ErrorReportingHeartbeat *bool`；
    `:771-798` get 回显加一行；`:928-935` 之后加写入块（锚点 `if req.ErrorReportingEnabled != nil`）
  - `packages/host/enterprise/src/error-reporting.ts:65-69` `beforeSend` → 加 tag 例外；
    `:48-84` `initSentry` → 加 `heartbeat` 参数与发送
  - `packages/host/enterprise/src/server-connector/config.ts:31-37` `web` 类型 → 加 `error_reporting_heartbeat?: boolean`
  - `server/webadmin/src/pages/ErrorMonitoring.tsx:104-107` 开关区 → 加第二个 Switch
- **改动要点**
  1. 客户端 `initSentry(dsn, release, level, heartbeat = false)`：
     - `beforeSend: (event) => { if (event.tags?.['picoaide.heartbeat']) return event; …原逻辑… }`
       —— **只对带 tag 的事件例外**，普通事件仍走原 `LEVEL_RANK` 过滤；
     - `heartbeat === true` 时在 init 成功后发
       `captureMessage('客户端错误上报链路自检 (' + release + ')', { level:'info', tags:{ 'picoaide.heartbeat':'1' } })`；
     - **每进程只发一次**（模块级 `let heartbeatSent = false`，重 init 不重发）；
     - 注意 `SentryNode` 的类型 cast（`captureMessage` 第二参从 `string` 变为对象）。
  2. 服务端 settings 键 `web.error_reporting_heartbeat`，默认 `false`（= 与今天行为**完全一致**）。
  3. webadmin 文案必须显式声明例外：
     「开启后,每个客户端每次启动上报一条 info 级「链路心跳」——该条**不受上面的上报等级阈值限制**,仅用于证明链路存活;介意噪音时保持关闭。」
  4. **不做**：不给 `error_reporting_level` 增加取值、不改其默认值、不改 UI 现有 4 个选项。
- **测试文件与用例名**
  - `packages/host/enterprise/tests/error-reporting.spec.ts`
    - `'lets a heartbeat event pass the error threshold'`（`level='error'` + tag → 返回 event）
    - `'still filters ordinary info events when heartbeat is enabled'` ★（**这条是"语义未被破坏"的判据**）
    - `'sends exactly one heartbeat per process when enabled'`
    - `'sends no heartbeat when the switch is off'`
  - `server/internal/llmgateway/admin_test.go`（或新建 `admin_heartbeat_test.go`）：`TestGatewayHeartbeatSetting`
    （PUT true → 库值 `"true"` → GET 回显 `true`；PUT false → `"false"`）
  - `server/internal/bootstrap/bootstrap_test.go`（**已存在**，追加用例）：`TestBootstrapDeliversHeartbeatFlag`
    （settings 有值 → 响应 `web.error_reporting_heartbeat` 正确；无值 → false）
  - `server/webadmin/src/pages/ErrorMonitoring.test.tsx`：`'心跳开关随保存提交'`
- **验证方式**
  ```bash
  corepack yarn workspace @picoaide/dsh-enterprise test
  cd server && go test ./internal/llmgateway/ -run Heartbeat -v && go test ./internal/bootstrap/ -run Heartbeat -v
  cd server/webadmin && npm test -- ErrorMonitoring
  # 真实验证：临时把生产 DSN 配到本地/测试部署，开心跳 → 客户端登录 → GlitchTip 应出现
  #   「客户端错误上报链路自检」；关掉后重启客户端 → 不应再出现（且 info 噪音不回归）
  ```
- **依赖**：P0-3（状态机落地后再加分支更省事）。

---

### P1-3 客户端状态上报服务端 + webadmin 可见

- **目标**：管理员一眼看到「N 个客户端已启用 / M 个失败（最近原因/时间）」，不再靠猜。
- **要改的文件:行号 / 锚点**（**改动面最大，若用户选择最小范围可整条顺延**，见 PLAN R-6）
  - 迁移：新建 `server/internal/serverstore/migrations-pg/0068_client_error_reporting_status.sql`（当前最大号 `0067`）
  - 新建 `server/internal/serverstore/error_reporting_status.go`（DAO：`UpsertErrorReportingStatus` / `ListErrorReportingStatuses` / `CountErrorReportingStatuses`）
  - `server/internal/telemetry/handlers.go:16-27` `Handlers` → 加 `ReportErrorReporting gin.HandlerFunc`；
    `:59+` 区域加 handler；`server/internal/telemetry/routes.go:43-49` `RegisterRoutes` 加一行（测试辅助）
  - `server/internal/router/router.go:194` 之后 → `cli.POST("/telemetry/error-reporting", BearerAuth, d.Telemetry.ReportErrorReporting)`
  - `server/internal/router/router.go:292` 之后 → `serverauth.AdminRoute(authed, "GET", "/gateway/error-reporting/clients", serverauth.PermGatewayRead, d.Gateway.ErrorReportingClients)`
  - `server/internal/llmgateway/handlers.go:25-51` + `NewHandlers` → 加 `ErrorReportingClients`
  - 客户端：`packages/host/enterprise/src/error-reporting.ts` 的 `sync()` 末尾调用上报；
    上报实现放 `packages/host/enterprise/src/skill-telemetry.ts` 同款形态的新函数（可直接写在 `error-reporting.ts` 内，用 `fetchJSON`）
  - `server/webadmin/src/pages/ErrorMonitoring.tsx` → 新增一张 Card
- **改动要点**
  1. 客户端：`sync()` 结束（无论成功失败）后 `void reportStatus(session, status)`：
     - `fetchJSON(session.serverURL, '/api/client/v2/telemetry/error-reporting', { token, method:'POST', body })`；
     - **尽力而为**：catch 后只 `logger.debug`，绝不重试、绝不阻塞、绝不影响宿主（照抄 `skill-telemetry.ts` 的非致命语义）；
     - 每进程对同一状态**只报一次**（去重键 = `state + reason`），避免每次登录重复；
     - 上报体只含 `state/reason(≤200)/dsn_host/level/release`，**不含完整 DSN**。
  2. 服务端：Bearer + 参数上限（`reason` 截断 200、`dsn_host` 校验为合法主机名、state 白名单）
     + 复用 telemetry 的 `callLimiter`（新桶，如 10/min/user）+ 「非法输入静默 ok」的非致命语义 + upsert。
  3. 管理端点返回聚合：`{ready, disabled, failed, config_unavailable, last_report_at, items:[{username, state, reason, dsn_host, level, release, updated_at}]}`（`items` 上限 100，按 `updated_at desc`）。
  4. webadmin：展示「已启用上报客户端 N 台 / 失败 M 台 / 最近上报 <时间>」，失败项列出 `username + reason + 时间`；
     空数据时给出**引导文案**（"尚无客户端上报状态…"），不要把"没有数据"渲染成"一切正常"（这正是本 bug 的教训）。
- **测试文件与用例名**
  - `server/internal/telemetry/` 新增 `error_reporting_status_test.go`：
    `TestReportErrorReportingStatus`（合法 → 200 + 落库）、`TestReportErrorReportingStatusRejectsUnknownState`（静默 ok 或 400，二选一并写明）、`TestReportErrorReportingStatusRateLimited`
  - `server/internal/serverstore/` 新增 `error_reporting_status_test.go`：`TestUpsertErrorReportingStatusIsIdempotent`（**必须见 `--- PASS` 而非 `--- SKIP`**，PG 可用时真跑）
  - `server/internal/serverstore/migrate_test.go` 既有迁移用例应覆盖新迁移（若它按目录扫描，自动纳入；否则补一条）
  - `packages/host/enterprise/tests/error-reporting.spec.ts`：`'reports the status to the server once per state'`、`'never fails the host when the status report rejects'`
  - `server/webadmin/src/pages/ErrorMonitoring.test.tsx`：`'展示客户端上报状态(含失败原因)'`、`'无数据时不显示为正常'`
- **验证方式**
  ```bash
  cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/picoaide_test \
    go test ./internal/serverstore/ -run ErrorReportingStatus -v        # 期望 --- PASS（非 SKIP）
  cd server && go test ./internal/telemetry/ -run ErrorReporting -v
  corepack yarn workspace @picoaide/dsh-enterprise test
  cd server/webadmin && npm test -- ErrorMonitoring
  ```
- **依赖**：P0-3。**与 P0-1/P0-4 无耦合，可并行。**

---

### P1-4 DSN 规则跨语言对拍测试

- **目标**：防止 Go（权威）与 TS（浏览器 + 客户端）两套 DSN 规则漂移——本仓已有同类范式
  （`server/internal/serverstore/audit_r4_url_parity_test.go:232 TestConnectorBlockedNetworksMatchClientOutbound`）。
- **要改的文件:行号 / 锚点**
  - 新建 `server/internal/llmgateway/dsn_parity_test.go`
  - 语料文件：新建 `server/internal/llmgateway/testdata/dsn_corpus.json`（`[{dsn, verdict:"accept"|"reject"|"warn", reason}]`）
  - 可选：让 `server/webadmin/src/lib/dsn.ts` 的测试读同一份语料（webadmin 的 vitest 可 `readFileSync` 相对路径）
- **改动要点**：Go 侧 `TestDSNCorpus` 遍历语料断言 `ValidateErrorReportingDSN` 的结论；
  webadmin 侧 `dsn.corpus.test.ts` 遍历**同一份** JSON 断言 `validateErrorReportingDsn`。
  **两份断言共用同一语料** ⇒ 任一侧规则漂移必然变红。
- **验证方式**
  ```bash
  cd server && go test ./internal/llmgateway/ -run TestDSNCorpus -v
  cd server/webadmin && npm test -- dsn.corpus
  # 反证：临时把 Go 侧的 loopback 判定注释掉 → 必须红
  ```
- **依赖**：P0-1、P0-2。

---

### P1-5（条件性）H5 崩溃退出竞态：先验证，再按结论修

- **目标**：判定「主进程致命异常事件是否真的丢失」，只在**判定为丢失**时才改，避免无证据改动宿主退出路径。
- **验证步骤（先做，不改代码）**
  1. 用打包态产物（`packages/host/desktop/dist/linux-unpacked/dsh-plugin-desktop`）在 Xvfb 下启动，
     `HOME`/`XDG_CONFIG_HOME`/`DSH_HOME` 重定向到临时目录（沙箱内 `/root/.config` 只读），
     `--no-sandbox --remote-debugging-port=9223`，用 mock gateway（`scripts/e2e-fixture-gateway.mjs`）登录；
  2. 通过 CDP 或临时注入触发一次主进程 `uncaughtException`；
  3. 观察 GlitchTip issue 列表是否新增该 release 的事件；
  4. **对照实验**：把 mock 的 bootstrap `web.error_reporting_dsn` 指向一个可观测的本地 HTTP 收包器
     （比 GlitchTip 更可控，能精确看到 request 是否发出）。
- **若判定为丢失，改动点 / 锚点**
  - `packages/host/desktop/src/main.ts:191`（锚点 `exit: code => { app.exit(code) }`）与 `:222-226`：
    给退出协调器加一个**有限等待冲刷**阶段（例如在 `app.exit` 前 `await` 一个由企业插件注册的
    `beforeExit` 钩子）；实现方式二选一：
    (a) 宿主提供通用钩子 `runtime.registerShutdownFlush(fn)`；
    (b) 企业插件在 `apply()` 里 `ctx.on('dispose')`/`ctx.effect` 注册 `Sentry.close(1500)`。
    **优先 (b)**：改动局限在 `packages/host/enterprise/`，不碰 desktop 运行时。
  - `packages/host/enterprise/src/error-reporting.ts:52`：把 `sentry.close(0)` 改为 `sentry.close(1500)`（重 init/登出时也别丢缓冲区）。
- **测试**：`packages/host/enterprise/tests/error-reporting.spec.ts` 新增
  `'flushes the client on dispose'`（mock 记录 `close` 的调用与超时参数）
- **验证方式**
  ```bash
  corepack yarn workspace @picoaide/dsh-enterprise test
  # 复测 V6：注入未捕获异常 → GlitchTip/本地收包器必须收到（issue 计数 +1）
  ```
- **依赖**：P0-3（状态机）。**风险**：改宿主退出路径影响面大，(b) 方案把风险限制在企业包内。

---

### P1-6 让 `e2e:client` 真的断言"上报被触发"

> 来源：EVIDENCE-ADDENDUM F13 / PLAN §2.19。P0-5 只是把假绿拆掉；**这条才让 E2E 具备真正的回归能力**
> ——否则 §PLAN 2.8 的打包门禁缺口 + E2E 的开关缺口，会让"上报链路"这条线继续没有任何自动化防线。

- **目标**：`e2e:client` 的 13 条断言之外，新增一条**错误上报**断言，且它必须能在链路坏掉时变红。
- **要改的文件:行号 / 锚点**
  - `packages/host/desktop/scripts/e2e-client.mjs` —— 锚点：断言列表（现有 13 条，报告写 `.e2e-report.md`）
  - `packages/host/desktop/scripts/e2e-fixture-gateway.mjs` —— 新增 `POST /api/1/store/`（或 `/api/<id>/store/`）
    收包端点，记录收到的请求（写一个临时文件或计数端点供 E2E 查询）
- **改动要点**
  1. mock 网关加一个「收包计数」端点（如 `GET /__e2e/sentry-events`），store 端点收到合法
     `X-Sentry-Auth` 就 +1 并返回 `{"event_id":"…"}`。
  2. E2E 在登录完成后：等待（带超时，≤15s）收包计数 ≥1，或（若 D4 未落地/心跳关闭）断言
     客户端状态为 `ready`（通过 P1-3 的状态端点从 mock 侧观测，最稳）。
  3. 断言失败必须让 `e2e:client` **非零退出**并写进 `.e2e-report.md`（沿用现有断言机制，不另造）。
  4. **反证必做一次**：临时把 mock 的 `error_reporting_enabled` 改回 `false`，跑 E2E，**必须红**；
     然后还原。（这是本仓 P2-52「门禁空转」教训的直接应用。）
- **测试 / 验证方式**
  ```bash
  corepack yarn workspace dsh-plugin-desktop e2e:client
  # 期望：报告断言数由 13 → ≥14，新增「错误上报链路已激活」为 pass，退出码 0
  # 反证：把 fixture 的 error_reporting_enabled 改成 false 再跑 → 必须非零退出（做完还原）
  ```
- **依赖**：P0-5（开关打开）、P1-3（状态端点，用于最稳的观测口径）；若 D4 采纳则更直接。

---

## P2 —— 体验 / 文档

### P2-1 交付物归位
- 按 REQUEST §8：`docs/planning/2026-09-16-glitchtip-error-collection-design.md`（= 本 PLAN）、
  `docs/planning/2026-09-16-glitchtip-error-collection-implementation.md`（= 本 IMPLEMENTATION）、
  `docs/decisions/2026-09-16-glitchtip-error-collection.md`（D1–D7 拍板摘要；
  **决策文件只放拍板结果与理由**，不复制蓝图）。
- 迁移时**更新跨文件相对链接**防断链；黑板目录保留原件直到本轮结束。
- 验证：`ls docs/planning/2026-09-16-glitchtip-error-collection-*.md docs/decisions/2026-09-16-glitchtip-error-collection.md`

### P2-2 运维纠偏文档（AC11）
- 新建 `docs/deploy/` 或 `docs/planning/2026-09-16-glitchtip-selfhost-operations.md`（按 `docs/deploy/` 既有约定选用），
  内容必须含：
  1. `GLITCHTIP_DOMAIN`（决定后台「客户端密钥」页展示的 DSN 主机）与 `MAIN_URL`（只管邮件/绝对链接）的区别；
  2. 现场修法：给 `glitchtip-web-1` 补 `GLITCHTIP_DOMAIN=https://glitchtip.example.com` 并重启该容器
     （**人工操作，本轮禁止代理执行**，只写 runbook）；
  3. 生产正确 DSN 全文 `https://<glitchtip-public-key>@glitchtip.example.com/1`
     与「为什么 `localhost:8000` 一定收不到」（客户端会把事件发往自己的电脑）；
  4. 自检清单：webadmin 点「发送测试事件」+ 看「客户端上报状态」+ 开一次心跳。
- 验证：`grep -l 'GLITCHTIP_DOMAIN' docs/**/*.md` 命中且含完整 DSN 字符串。

### P2-3 webadmin 体验打磨
- `ErrorMonitoring.tsx`：私网 DSN / `http://` DSN 显示**黄色告警条（不阻断保存）**，
  文案说明「内网自建场景合法，请确认客户端能访问该地址」；
- DSN 输入框下方回显解析结果：`主机: xxx / 项目 ID: 1`（**不显示 public key**）；
- 展示 P1-3 的「最近一次上报时间」。
- 验证：`cd server/webadmin && npm test -- ErrorMonitoring`。

### P2-4 发布说明（若本轮打 tag）
- `docs/releases/<tag>.md` **必须存在**（`scripts/check-workflows.mjs` 的静态守卫会拦正式 tag），
  模板见 `docs/releases/TEMPLATE.md`；内容至少覆盖：本次修的是什么盲区、管理员需要做什么（补 `GLITCHTIP_DOMAIN`、点测试事件、按需开心跳）。
- 验证：`node scripts/check-workflows.mjs` → exit 0。

---

## 依赖关系图

```
PRE-4(H3′ 只读判定) ──┐
                      ├─▶ P0-1 ──▶ P0-2 ──▶ P1-4
                      │      └───▶ P0-4 ──▶ P2-3
                      │
        P0-3 ─────────┼─▶ P1-2
                      ├─▶ P1-3 ──▶ P2-3
                      └─▶ P1-5(条件性)
        P0-5 ──▶ P1-6（E2E 回归防线）
        P1-1（独立，可随时做）
        P2-1 / P2-2（可与编码并行）
        P2-4（打 tag 前）
```

**可并行的安全组合**：P0-1 + P0-3 + P0-5 + P1-1（四块互不触碰同一文件）；
**必须串行**：P0-1 → P0-4（共用 `dsn.go`）；P0-3 → P1-3/P1-5（共用 `error-reporting.ts`）；P0-5 → P1-6。
**同一文件的多任务不要并行**：`error-reporting.ts`（P0-3/P1-2/P1-3/P1-5）、
`admin.go`（P0-1/P0-4/P1-2）、`router.go`（P0-4/P1-3）、`ErrorMonitoring.tsx`（P0-2/P0-4/P1-2/P1-3/P2-3）、
`e2e-fixture-gateway.mjs`（P0-5/P1-6）。

---

## 图形门禁的运行条件（`verify:renderer-capture`，主控补充 2026-09-16）

`verify:renderer-capture`（真机 Electron + 页面主世界抛错 → 断言事件到达主进程 sink）
已接入 desktop `check`，因此也在根 `yarn check`（CI `gate` job）里执行。它有**图形前提**：

- 有 `DISPLAY` → 直接跑；
- Linux 无 `DISPLAY` → 自起 `xvfb-run -a`；
- **两者都没有 → 默认 fail-loud（exit 2）**，不静默跳过。
  - 理由：本轮的根因之一就是「门禁假绿」（e2e fixture 没开 `error_reporting_enabled`，
    上报链路从未被验证却一直通过）。一个跑不了就悄悄变绿的门禁属于同一类缺陷。
  - CI：`gate` job 新增 `Ensure xvfb for the graphical gate` 步骤（与 desktop-linux job
    同样防御式 `apt-get install -y xvfb`），所以正常 CI 会真跑这条断言。
  - 逃生口：确实跑不了图形环境的机器可显式设 `RENDERER_CAPTURE_SMOKE_ALLOW_SKIP=1`
    跳过一次（会用 `⚠ ... skipped because ...` 明确打印，不是假装通过）。

---

## 完成定义（DoD，逐条打勾）

- [ ] AC1–AC13 全部可判定地通过（AC8 若判定 H5 不成立，需在 PLAN 里记录"已验证为不丢失"的观测证据）
- [ ] 四条门禁命令全绿（`enterprise typecheck` / `enterprise test` / `webadmin npm test` / `go test ./internal/llmgateway/`）
- [ ] `corepack yarn check` 全绿，或既有失败已逐条归属（缺依赖 / `lib/` 陈旧 / 与本轮无关）
- [ ] P1-1 与 P1-6 的**空转反证**各做过一次（故意写错包名 → afterPack 必须红；把 `error_reporting_enabled` 改回 false → `e2e:client` 必须红）
- [ ] 全仓无生产上报地址字面量：`grep -rn '<glitchtip-public-key>' packages/ server/ --include='*.mjs' --include='*.ts' --include='*.go' | grep -v node_modules` 无命中
- [ ] 每个任务**单独** commit，信息 `fix:|feat:|test:|docs:` 单行 ≤72 字符
- [ ] `git add` 只加自己改的文件（**禁止** `git add -A`；工作区有大量他人未跟踪文件）
- [ ] 未触碰 `deepseek-harness/`、`server/internal/util/netguard.go`、品牌素材、生产环境
- [ ] `docs/` 归位（P2-1/P2-2）完成，跨文件链接可达

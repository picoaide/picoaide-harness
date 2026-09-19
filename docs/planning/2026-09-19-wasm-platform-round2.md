# WASM 应用平台第二轮整改规划（2026-09-19）

> 用户提出的六个问题（原文）：
> 1. 如果是登录可见，会跳转到 `/app-ticket`，然后提示「请求来源校验未通过，请从平台首页重新进入」。根本没有地方输入账号密码。
> 2. `picoaide-app-builder` 这个技能要改名字叫 `app-builder`，然后这个应该是默认放在服务端的技能库里，而不是放在客户端里。我在能力中心里看不到这个。
> 3. 你需要检查一下，wasm 应用怎么支持高并发，不应该是每个请求串行。
> 4. sqlite 应该是支持并发读取的。高并发读取情况下会有问题，写入确实需要串行。我记得 sqlite 是可以配置的。
> 5. 你自己再检查一下性能方面，和流程配置，还有哪些不人性化的地方，只查 wasm 代码就行。
> 6. 应用平台这个并入到应用中心，然后应用中心里增加一个设置页面。并且把应用域名放到设置页面里。
>
> 本文是整体规划与实施记录。执行方式：**并行侦查子代理 → 分批实施子代理 → 独立验证子代理（独立上下文、不看实施过程）**。

## 0. 六个问题的定性（侦查结论）

| # | 定性 | 根因 | 严重度 |
|---|---|---|---|
| 1 | 缺陷 | `Referrer-Policy: no-referrer` ⇒ 浏览器对非 GET 请求发 `Origin: null` ⇒ 来源校验必然失败 | **P0** |
| 2 | 产品/位置 | 技能确实是服务端内置（skillseed + 镜像），但**源码**在客户端 vendored 包目录，且名字带 `picoaide-` 前缀 | P1 |
| 3 | 缺陷 | 同应用请求串行有**四层**叠加（队列 `app_running=1`、句柄池整请求独占、appdb 一把锁、池容量 2） | **P0** |
| 4 | 缺陷 | 应用库**从未开启 WAL**、`busy_timeout=0`，读与写共用一把锁 | **P0** |
| 5 | 质量 | 见 §5（审计子代理产出的分级清单） | P1/P2 |
| 6 | 产品 | 应用域名已在应用中心页一张卡片里；`/app-platform` 是独立页 ⇒ 合并为「应用中心 + 设置页」 | P1 |

## 1. 问题 1：登录可见应用完全无法进入（P0）

### 1.1 根因（已用真实 Chromium 复现 + 微实验证明）

主站 HTML 面（`/login` 登录页、`/app-ticket` 换票页）与应用子域页面都下发
`Referrer-Policy: no-referrer`（页面 `<meta>` + 响应头）。按 WHATWG Fetch 规范的
「append a request `Origin` header」算法：**referrer policy 为 `no-referrer` 时，
navigation 模式（原生表单提交/导航）的非 GET/HEAD 请求的 `Origin` 被写成字面量 `null`**
（同源也一样）。⚠️ **实测口径**（2026-09-19 独立验证代理的真实 Chromium 微实验）：
同源 `fetch()`/XHR **不受影响**（缺省 `mode=cors`，无条件写真实源）；中招的只有原生表单。
证据见 `temp/wasm-verify-indep/probe-micro-referrer.mjs` 的对照表。

证据链：
- 真实 Chromium 探针（`temp/wasm-probe/probe-login-flow.mjs`）：访问
  `https://demo-login.<基域>/` → 302 `/app-ticket` → 自动提交表单，请求头实测
  `origin: "null"` → **403**，页面文案「请求来源校验未通过，请从平台首页重新进入」，
  且 `ShowForm=false` ⇒ 用户「根本没有地方输入账号密码」。
- 同一探针（`probe-login-submit.mjs`）：直接打开 `/login` 填账号密码提交，
  `POST /login` 同样 `origin: "null"` → 403 ⇒ **员工浏览器登录入口 100% 不可用**。
- 应用子域同源写：`curl -X POST .../api/hello -H 'Origin: null'` → 403
  「跨源写请求被拒」，换真实 Origin → 200 ⇒ **应用自己的同源表单 POST
  （演示应用留言墙 `<form action="/note">`）在真实浏览器里必然失败**。
- 微实验（`temp/wasm-probe/micro-referrer.mjs`）对照：
  `no-referrer` → `Origin=null`；`same-origin` → 真实 Origin；
  `strict-origin-when-cross-origin` → 真实 Origin。

### 1.2 修复

1. `session/pages.go`（两个 `<meta>` + `writePage` 响应头）与 `edge/hostgate.go` 的
   `ApplyHostSecurityHeaders` 一律 `no-referrer` → **`same-origin`**
   （同源才发 Referer、跨源完全不发 —— 原有「不向第三方泄漏 URL」意图不变，
   同时恢复真实 `Origin`）。门户页与管理台 SPA 不动（没有同源表单 POST）。
2. 测试把「策略绝不能是 `no-referrer`」钉死，并补行为回归：真实同源 Origin 放行、
   `null` 与跨源仍拒。
3. `checkMainOrigin` / `edge.CheckOrigin` 失败路径补诊断日志（期望源、实际
   Origin/Referer/Host/X-Forwarded-Proto、失败判据）—— 此前完全静默，是本次
   问题长期无法定位的直接原因。
4. 来源校验失败时**保留登录表单**（不再 `ShowForm=false`），并给可操作指引。
5. 文档：更新 `docs/planning/2026-09-17-wasm-app-platform.md` 安全头表格 +
   新增 `docs/decisions/2026-09-19-referrer-policy-origin-null.md`。

## 2. 问题 3 + 4：并发与 SQLite（P0）

### 2.1 串行化点（四层叠加，侦查确认）

| 层 | 位置 | 可配？ |
|---|---|---|
| L1 调度器每应用并发 = 1 | `queue/queue.go:50` + `limits.go:261` | 控制台 `app_running`（但见下） |
| L2 句柄池互斥量覆盖**整个 wasm 执行期** | `appserver/dbpool.go:63` ↔ `serve.go:379`（release 是 defer） | ❌ 硬编码 |
| L3 `appdb.DB.mu`「一次一条语句」，读写共用 | `appdb/appdb.go:139` + `stmt.go:22/138`、`tx.go:36` | ❌ 硬编码 |
| L4 池容量 2、两条连接全程持有 | `appdb/appdb.go:259-272` | ❌ 硬编码 |

⇒ **只调大 `app_running` 无效**：阻塞点只是从队列挪到 L2/L3 的锁上。排队等待
已计入 60 s 端到端墙钟（`serve.go:343`）。

### 2.2 SQLite 现状

| 项 | 实际 |
|---|---|
| journal_mode | **全仓零设置 ⇒ SQLite 默认 `delete`**（不是 WAL） |
| busy_timeout | **零设置 ⇒ 0**（并发即 `SQLITE_BUSY`） |
| 连接 | `SetMaxOpenConns(2)`，`ro`(query_only) + `rw` 各一条全程持有 |
| 读写 | 分层连接，但**共用一把 `d.mu`** ⇒ 读被无谓串行化 |
| 唯一真闸门 | `LIMIT_ATTACHED=0`（连接级、不持久、只能在 `connectLocked` 令牌窗口内设） |

### 2.3 改造方案

1. **WAL + busy_timeout**：在 `connectLocked` 建 `rw` 后先设
   `PRAGMA journal_mode=WAL`（**必须断言返回值为 `wal`**）与 `busy_timeout`
   （建议 3000 ms，硬性 < 单语句 5 s 预算）；`busy_timeout` 加进
   `hardenConnLocked` 的每连接加固清单。
2. **只读连接池**：`ro *sql.Conn` → N 条只读连接（新配置 `appdb_readers`，默认 4），
   在令牌窗口内一次建满并**逐条**跑加固 + 双金丝雀（`LIMIT_ATTACHED` 只能在这里设，
   这正是池不能弹性扩缩的原因）。
3. **锁拆分**：`stateMu`（短临界区：状态/槽位） + `writeMu`（写者独占）；
   读路径取槽后**不持锁执行**；`tx != nil` / `poisoned != nil` 时读退化串行（事务内
   读仍走 `rw`，保证读到未提交写）。
4. **句柄池去整请求独占**：`appDBHandle.mu` 从「覆盖整执行期」降级为「使用中钉住」
   （inflight 已由池的 `p.mu` 维护），并发控制交给第 3 步。
5. **配额与内存记账同步**：句柄记账 `2 MiB` → `(1+N) MiB`；`-wal`/`-shm` 的
   文件权限（0600）与用量口径（`fileSize` 只 stat 主库会低估）一并处理。
6. **关连接路径**：`closeLocked` / `dropPoisonedConnectionsLocked` / `Close` /
   池淘汰 / `Server.Close` 等**八处**都要新增「读者排空」。
7. **配置面**：`appdb_readers`（1–16，默认 4，句柄重建生效）、
   `appdb_busy_timeout_ms`（0–5000，默认 3000，新连接生效）；`limits` 表 +
   `limitsspec` + 生成物（limits.json/md、SKILL references）+ `applimits` +
   webadmin 表单**必须同步**（有逐字节与覆盖性门禁）。
8. **队列/产品面**：`app_running` 默认值与其 hint 文案（当前写「同一应用的请求是
   串行的」）随实现一起改；控制台需说明「4 = 最多 4 个并发读者，写仍串行」。

### 2.4 不可行 / 不做（明确认账）

- ❌ 运行期弹性扩缩只读连接数（会削弱 L3 的连接钩子 fail-closed 不变量）。
- ❌ 多写并发（SQLite 单写者 + `BEGIN IMMEDIATE` + 最多一事务必须保留）。
- ⚠️ 最大新风险是「关连接 vs 在途读者」，必须有 `-race` 下确定性用例。

## 3. 问题 2：技能改名 `app-builder` + 源码归位服务端（P1）

侦查确认（与用户直觉的差异）：
- `picoaide-app-builder` **已经是服务端内置技能**：镜像内 `/opt/picoaide/skills/`，
  由 `skillseed` 打包下发（`GET /api/client/v2/skills/builtin[/:name/archive]`，
  BearerAuth，无授权门）；客户端能力中心已用普通卡片渲染
  （`BuiltinSkillsStrip.tsx`）。实测测试环境下发的清单里就是它。
- 用户「看不到」的最可能原因：**部署/客户端版本**（skillseed 与卡片渲染在
  v2.7.6-beta.1/beta.3 才进），或他看的是 **webadmin**（管理后台当前没有内置技能面）。
- 但**源码**确实在客户端 vendored 包目录
  （`packages/vendor/memory-evolve/skills/picoaide-app-builder/`），服务端镜像只是把它
  当 build context 拷进来 ⇒ 用户的诉求「应该在服务端」在**仓库结构**上仍然成立。

本次要做：
1. 技能源码从客户端 vendored 包**搬到服务端资产目录**，Dockerfile 直接 COPY
   （不再依赖 `skillassets` 指向客户端包）。
2. 改名 `picoaide-app-builder` → `app-builder`，同步所有引用点：SKILL.md
   frontmatter 与正文、Dockerfile、CI 镜像内断言、`verify-packaged-runtime.ts`
   必需条目、客户端/服务端测试夹具、`skills-sync.js` 的排除表、docs/site。
3. 能力中心可见性：确认服务端下发 + 客户端卡片渲染链路，并**在 webadmin 增加
   内置技能可见面**（管理端当前完全看不到平台内置了什么技能）。

## 4. 问题 6：应用平台并入应用中心 + 设置页（P1）

现状：`/app-center`（`AppCenter.tsx`，顶部已有「应用域名」卡片）与 `/app-platform`
（`AppPlatform.tsx`，限制项：并发/内存）是两个独立页面与侧栏条目；后端 API 已同组
（`/api/server/admin/wasm-apps/{domain,limits}`，权限点 capability:read/write），
**合并不需要改后端**。

本次要做：
1. 应用中心改为**分页签**结构：`应用` / `限制项`（原应用平台）/ `设置`（应用域名等）。
2. 侧栏去掉独立的「应用平台」条目，统一从应用中心进入。
3. 同步 `AppCenter.test.tsx` / `AppPlatform.test.tsx` 与导航测试。

## 5. 问题 5：性能与流程人性化审计（P1/P2）

审计范围仅 wasm 代码，产出分级清单（P0/P1/P2）+ 一次应用请求的开销清单 +
常见任务的步骤数与摩擦点。修复按批次并入上面的实施波次。

> 详见 §7 实施记录（审计结论落定后补入）。

## 6. 执行方式与验收

- **波次 1**（P0）：问题 1 修复 + 回归 + 文档。
- **波次 2**（P0）：问题 3+4（SQLite/并发），分两小步：WAL+busy_timeout+只读池+锁拆分
  → 句柄池去独占 + 配置面 + webadmin 表单。
- **波次 3**（P1）：问题 2（技能改名/归位 + webadmin 内置技能面）。
- **波次 4**（P1）：问题 6（页面合并）。
- **波次 5**：问题 5 审计修复批次。
- 每波次结束后由**独立上下文的验证子代理**复验（不看实施过程，直接对证据与判据
  独立判定），P0 项必须有可复跑的端到端判据（真实浏览器/真实服务端）。

## 实施记录（问题 6）：应用平台并入应用中心 + 增加设置页

> 实施范围：`server/webadmin/**` 与 `docs/**`；**后端（Go）零改动**。本节只记录已落地的
> 页面搬家与老路由重定向（问题 1–5 的实施记录见各自章节/后续补充）。

### 结构（前 → 后）

| 前 | 后 |
|---|---|
| 侧栏「应用中心」→ `/app-center`（应用列表 + 页顶「应用域名」卡片） | 侧栏「应用中心」→ `/app-center`；页内子导航**应用**（索引，应用列表） |
| 侧栏「应用平台」→ `/app-platform`（并发/内存限制项） | 同页子导航**限制项** ← 原应用平台主体原样搬入 |
| （无） | 同页子导航**设置** ← 应用域名（泛域名）卡片搬入 |
| 老路径 `/app-platform` | 重定向到 `/app-center/limits`（`replace`，防老书签 404；先例 `/marketplace`→`/capabilities`）。**注（2026-09-19 复核）**：原「应用平台」页本身就是"并发/内存限制项"，所以忠实映射是 `limits` 而不是 `settings`——代码 `server/webadmin/src/App.tsx` 即如此，本文此前写成 `settings` 是笔误 |

侧栏真源 `src/lib/nav.ts` 删掉 `/app-platform` 条目：这两个条目此前**同用 `Boxes` 图标**，
侧栏看起来是两个入口、实际是同一类东西；合并后侧栏只留一条「应用中心」。

### 文件组织

| 文件 | 说明 |
|---|---|
| `src/pages/app-center/AppCenterLayout.tsx` | 新增：NavLink 子导航 + `<Outlet/>`（照 `pages/usage/UsageLayout.tsx` 的形态，不新造范式） |
| `src/pages/app-center/Apps.tsx` | 原 `pages/AppCenter.tsx` 的**列表部分**（机械去掉域名卡片与 `DomainView`/域名状态） |
| `src/pages/app-center/Limits.tsx` | 原 `pages/AppPlatform.tsx` **主体原样搬**（组件名改 `Limits`、页面标题「限制项」、无权限文案随页面改名，其余逐行一致） |
| `src/pages/app-center/Settings.tsx` | 新增：应用域名卡片（原 `AppCenter.tsx` 顶部卡片的完整语义） |

### 保持不变（刻意）

- **后端零改动**：`GET/PUT /wasm-apps`、`/wasm-apps/domain`、`/wasm-apps/limits` 仍在
  `internal/router` 同一组；权限点仍是读 `capability:read` / 写 `capability:write`，**没有新增权限点**。
- **全部 `data-testid` 未动**（`lim-max_*`、`save-limits`、`reset-limits`、`budget-line`、
  `budget-badge`、`restart-pending`、`limits-flash`、`limits-error`）：限制项页只是换了承载路由。
- 侧栏 label「应用中心」与页面数据源（`/wasm-apps*`）均未变。

### 行为变化（有意，仅一处）

应用域名的**读取失败语义**变了：原来它与列表共用一次 load，域名 GET 失败只在卡片里显示一行局部
错误、页面其余部分照常渲染（局部静默）；搬进"只有这一件事"的设置页后改为**页面级错误 + 重试**，
失败时**不渲染**域名卡片——否则"读不到"会被管理员误读成"没配置"。保存失败仍是服务端
`message + hints` 原样拼接显示（口径未变）。

### 测试

- 改渲染目标：`AppCenter.test.tsx`（列表用例渲染 `app-center/Apps`，域名用例渲染
  `app-center/Settings`）、`AppPlatform.test.tsx`（五条渲染 `app-center/Limits`）。
- 改导航断言：`nav.test.ts` 的 `/app-platform` 期望与用例改写为新结构。
- 新增：① `app-center/AppCenterLayout.test.tsx` —— 子导航三项 href、三个子路由深链接各自渲染
  正确组件、点击切换、**`/app-platform` → `/app-center/limits` 重定向**（防老书签 404）；
  ② `nav.test.ts` —— 侧栏不再有两条同图标入口；③ `AppCenter.test.tsx` —— 设置页读取失败的
  页面级错误 + 重试恢复。
- 门禁：`cd server/webadmin && npm test` = **27 个测试文件 / 374 条用例全绿**；`npm run typecheck` 通过。

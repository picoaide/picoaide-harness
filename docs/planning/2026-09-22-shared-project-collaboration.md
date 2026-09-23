# 共享项目（多人协作）方案调研

- 日期：2026-09-22
- 基线：`master` @ `9aeba69ce5`（工作区有其他会话的在途改动，本文档只依据已提交内容做判断）
- 性质：**只读调研 + 方案设计**。未修改任何产品代码；本文档是唯一交付物。
- 需求来源（用户原话）：「共享项目。项目里可以拉同事。然后新建项目的是项目管理员。可以转交管理员。可以删除项目，所有成员的项目要同步删除。然后服务端做网桥，所有成员的会话和文件需要实时同步。实时状态，实时输出都要能看到。用插件的方式去做。服务端也要单独的模块，你先调研方案，比如文件被占用情况怎么办，然后要支持 p2p 的方式互相直连。如果不能直连做中转。你先调研方案要怎么做」
- 调研证据：`temp/shared-project-research/`（P2P、文件同步、会话复制先例、本仓接入面四路调研原始笔记）

---

## 0. 结论摘要

一句话：**这不是"再加一个协作功能"，而是把当前"一台机器 = 一个用户 = 一份本地会话与文件"的产品拓扑，改成"一个项目 = 多台机器 = 一份被复制的会话与文件"。** 能不能做成，取决于三条硬约束能不能被承认下来。

**三条产品级硬约束（先认账，再谈功能）**

1. **会话日志同一时刻只能有一个写者。** 上游会话持久化的写锁（`session.lock`，POSIX `flock` / Windows 命名信号量）与"一个进程一个写句柄"的设计已经把这条写死；更根本的是，agent 事件里带**工具调用副作用**（执行命令、改文件、调外部接口），两条并发时间线**不可合并**。→ 跨成员同步只能是**只追加日志的复制**，接管只能是**显式移交**。
2. **文件不可能真正"两边同时写"。** 两个成员的 agent 各自在本机跑命令改同一份代码，冲突不是"偶发"而是"必然"，且冲突的粒度是语义（一次重构动 200 个文件），不是文本行。→ v1 必须有一个**单一的"驾驶位"（driver）**持有可写副本，其余成员是**跟随副本**；"多人同时写"作为后续能力，不进 v1。
3. **服务端是唯一"一定可达"的节点。** 客户网络里客户端到服务端 443 是通的（登录、模型网关都靠它），P2P 直连不是。→ "不能直连做中转"的正确形态是**应用层中继走同一条 443**（而不是先上 TURN 再发现端口被封），P2P 是加速路径，中继是兜底路径，**兜底路径必须先做**。

**推荐形态（详见 §4）**

- **控制面**：服务端新增独立模块 `internal/projects`（迁移 + 路由 + RBAC + 审计），负责项目/成员/管理员/墓碑/配额/在线状态；客户端用**一条 SSE 长连接**接收控制面事件（断线用 `Last-Event-ID` 补齐），写操作走普通 POST。
- **会话面**：**不要从零设计**——上游已实现 `session/follow`（快照开场 + 严格 seq 增量 + 可选流式旁路）与终端面的「单写者 + 多观察者 + 接管后旧写者变只读」成品语义（`BrowserTerminal.follow()`）。共享项目**平移这两套先例**：会话所有者是唯一写者，同事默认只读跟随，接管 = 显式顶替（旧写者降级为观察者并收到控制权变更事件）；跟随者在本机物化成**镜像会话**（格式合法的 session 产物），直接复用上游会话列表与渲染器显示。
- **文件面**：驾驶位持有者提交**快照（manifest = 路径 → 内容块哈希）**，其他成员增量拉取缺失块并落盘。快照式而不是"逐字节实时双向"是有意的：agent 的改动是**批量语义操作**，快照让冲突、删除传播、回滚三件事同时变简单。
- **连通性三级**：T1 P2P 直连（**首选 WebRTC + 自建 TURN（`pion/turn` 嵌进现有 Go 进程）**，iroh 因 Node 绑定配置面太薄降为备选；**直连只是加速路径**）→ T2 服务端 443 应用层中继（纯 HTTPS POST/SSE，**必做、先做**，任何网络都能用）→ T3 TURN/relay 设施（需额外端口与公网 IP）。**中继是永久兜底，不是最后手段**：实测约 17.7% 的通话需要中继，企业人群按 20–40% 规划。
- **隐私分档（默认 L1）**：同事默认只看到**状态 + 工具时间线 + 计数**（L1）；工具名/摘要为 L2；AI 正文与流式 token 为 L3，必须显式授权且**裁剪在会话所有者本机完成再下发**（客户端隐藏不算权限控制）。
- **内容加密**：项目内容（会话正文、文件内容）**默认端到端加密**，服务端只存密文 + 元数据（成员、大小、序号）。这与本产品既有立场一致（0.1.6 升级时因"会话正文随请求体出境"而关闭 `session-log-deepseek`）。代价是服务端不能做内容审计/搜索，且成员移除要轮换项目密钥。**若采纳 L1 默认档，加密与分档天然一致**：L1/L2 元数据本就不含正文。

**工作量量级（粗估，详见 §8）**：可裁剪的 v1（项目 + 成员 + 会话实时跟随含接管 + 单驾驶位文件同步 + 中继兜底）≈ **71–96 人日**；含 P2P 直连与治理的完整版 ≈ **88–124 人日**。

**必须由用户拍板的问题**（详见 §9）：会话语义与接管模式（Q1）、"实时输出"给同事看到哪一档（Q2）、文件语义（Q3）、内容是否端到端加密（Q4）、删除项目时成员本地副本怎么处置（Q5）、P2P 与合规（Q6）。

---

## 1. 需求拆解与术语

### 1.1 原话拆解成可判定的条目

| # | 需求原话 | 可判定形态 |
| --- | --- | --- |
| R1 | 共享项目 | 服务端有一等资源"项目"，含名称、创建者、成员列表、状态 |
| R2 | 项目里可以拉同事 | 成员管理：加人 / 移除 / 退出，成员列表对所有成员可见 |
| R3 | 新建项目的是项目管理员 | 创建者 = 管理员；项目内角色至少两档：管理员 / 成员 |
| R4 | 可以转交管理员 | 管理员转移是显式动作，有审计，且双方客户端立即生效 |
| R5 | 可以删除项目，所有成员的项目要同步删除 | 删除是服务端权威动作；所有成员（含离线后上线的）最终都必须看到"项目已删除"，且本地不再保留可同步状态 |
| R6 | 服务端做网桥 | 服务端是可选的转发节点：直连不可用时，数据经服务端转发，不依赖任何客户端在线 |
| R7 | 所有成员的会话和文件需要实时同步 | 会话：成员 A 的会话对 B 可见并可实时跟随；文件：成员 A 的改动对 B 可见（时延目标见 §8 验收口径） |
| R8 | 实时状态、实时输出都要能看到 | "状态"= 成员在线/离线、agent 忙闲、当前工具、等待审批；"输出"= 会话事件流（含流式文本）实时可见 |
| R9 | 用插件的方式去做 | 客户端做成 host 插件包 + client 面板包；不改上游 `deepseek-harness/` |
| R10 | 服务端也要单独的模块 | 服务端新增独立包 `internal/projects`（+ 独立迁移 + 独立路由命名空间），不摊进既有业务包 |
| R11 | 文件被占用情况怎么办 | 必须有明确处置清单（见 §4.6、§7.2） |
| R12 | 支持 P2P 互相直连，不能直连做中转 | 连通性分级 + 直连失败自动降级，应用层无感 |

### 1.2 术语（本文档内固定）

- **项目（Project）**：服务端资源 + 每个成员本机的一份项目目录 + 挂在两者之间的会话集合。
- **驾驶位（Driver）**：某一时刻唯一被允许修改项目文件的成员/设备。由服务端租约授予，带**栅栏令牌（fencing token）**。
- **跟随副本（Follower copy）**：非驾驶位成员本机的项目目录副本，只读语义（本地改动视为冲突，见 §4.6）。
- **镜像会话（Mirror session）**：把别的成员的会话事件流在本地物化出来的**只读会话产物**，目的是直接复用上游会话列表与渲染器（可行性见 §2.4）。
- **中继（Relay）**：服务端 443 上的应用层转发（不是 TURN）。
- **项目序号（project seq）**：服务端为每个项目维护的单调递增序号，控制面事件与成员本地状态都用它做增量对齐。

### 1.3 本文档不覆盖（避免范围蔓延）

- 多人**同时**编辑同一会话（S3，见 §4.4）——只给代价评估，不进 v1。
- 服务端托管 agent（把项目变成"云端开发环境"）——架构上可行但等于重做宿主与沙箱，见 §4.3 的选项 C。
- 项目内的权限细分（按目录/按会话授权）、跨组织项目、项目模板市场。
- 移动端。

---

## 2. 现有架构事实（代码级）

> 这一节的每条都是"方案必须迁就的现实"。改动前请自行 `git show` 复核。

### 2.1 客户端

- Electron 桌面壳 + Cordis 插件树。桌面装配在 `packages/host/desktop/cordis.patch.yml`（host 侧 insert 行）与 `packages/host/enterprise/cordis.patch.yml`（企业面行）。
- 自研 host 插件包现有：`packages/host/{enterprise,connectors,cron,browser,wasm-apps-host,desktop}`；自研 client 插件包：`packages/client/{account-card,branding,foot-menu,panel-surface,wasm-apps}`。
- **本地 HTTP 面**：host 插件通过上游 webServer 注册 exact/prefix 路由，客户端页面用 `fetch` 调用；`packages/host/enterprise/src/auth-gate.ts` 是最大的路由表（`/api/pico/*`），并带**持有性证明**（`requireWriteProof`，非 GET 需要浏览器 cookie 证明）。`packages/host/desktop/src/loop-notify-route.ts` 是"单个 GET 路由"的最小样板（同源校验 + JSON 信封）。
- **全页面板**：`packages/client/panel-surface` 提供 `mountPanelSurface()`；面板入口通过 `ctx.slots.inject(...) + ctx.slots.register(...)` 注册（先例 `packages/client/wasm-apps/src/client/index.ts`，`id: 'apps'` 即 panel id，另有 `sidebar.footer.action` 槽）。
- **与服务器的通信**：`packages/host/enterprise/src/server-connector/` 提供会话与服务端地址；登录态落 `$DSH_HOME/session.json`（0600），见 `session-service.ts`；服务端调用一律带员工 Bearer token。**当前没有任何 WebSocket 客户端**（全量 `grep` 为空）。

### 2.2 会话与工作区（上游，只读）

- 会话物理布局：`$DSH_HOME/sessions/<按 cwd 派生的 slug>/<session-id>/session.jsonl.zstd`（实机确认，见 `.dsh-home/sessions/--root--/session-*/`）。
- 写入不变式（`deepseek-harness/packages/session/session-persistence-jsonl/src/`）：
  - `lease.ts`：**跨进程写独占**，POSIX `flock(2)` / Windows 命名信号量；争用报 `SessionAlreadyOwnedError`；**刻意没有过期时间**（不能抢占卡住的写者，否则会撕裂日志）；内核在进程死亡时释放。
  - `generation.ts`：**不可变世代文件 + 独占发布**当前世代；写新世代而不是原地改写。
  - `storage.ts`：每会话一个写句柄 + 句柄内变更链；活写缓冲最大延迟 `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200ms`；撕裂尾巴（torn tail）在首次新追加前截断。
- 会话头 `SessionHeader`（`packages/core/session/src/types.ts:93`）字段**封闭**：`version/id/createdAt/cwd?/parentSession?/isSeeded/origin?/delegationDepth?/agentPreset?`。**没有扩展位**——想给会话挂"属于哪个项目"的元数据，只能放到我们自己的旁路存储，或从 `cwd` 派生。
- 工作区注册表：`$DSH_HOME/storages/workspace.json`，由上游 `packages/workspace/workspace` 的 workspace 服务拥有（`ctx.workspaces.create(path, title)`、`archiveSession()` 等）。**启动时会做一次 reconcile**：`sessionPersistence.list()` 拿全部会话头 → 按 `header.cwd` 分组 → 对未知路径**自动建工作区记录**（`index.ts:452-511`）。
  - ⇒ **可行性结论**：只要我们以合法格式写入一个 `cwd` 指向镜像目录的会话产物，它就会自动出现在上游会话列表里、被上游渲染器渲染。这就是"镜像会话"能落地、且不用改上游 UI 的原因。
  - ⇒ **纪律**：插件**不得**直接写 `workspace.json`，必须走 workspace 服务。

### 2.3 服务端（Go）

- 单进程 gin，PG-only。命名空间唯一真源 `internal/router`：`/api/client/v2/*`（员工面，`BearerAuth`）、`/api/server/admin/*`（管理面，`AdminAuth` + RBAC 申报）、`/v1/*`（模型网关）。**业务包不得自行 `r.Group()` 注册生产路由**，路由集中在 `internal/router/router.go`。
- DAO 在 `internal/serverstore`（`?` 占位经 `$N` 改写层），迁移在 `internal/serverstore/migrations-pg/`（当前最大 `0076_usage_app_id.sql`）。
- 审计：`serverstore/audit.go`（sha256 哈希链），写动作有固定动作名规范。
- 流式输出已有先例：`internal/llmgateway` 的 SSE（含"按 flush 续写截止时间"的修复），但那是**代理上游模型**，不是对客户端的推送通道。
- 反代：Caddy（`server/Caddyfile.autocert|manual|internal`）`reverse_proxy server:8080`。**SSE 需要显式 `flush_interval -1`**，否则缓冲会毁掉实时性（部署侧要改的确定项）。`go.mod` 里**没有** websocket 库；`gin-contrib/sse` 作为 gin 的间接依赖存在。
- 存储能力先例：`app_releases.archive BYTEA`（PG 存二进制），WASM 平台的分片上传路由（`PUT /api/client/v2/apps/wasm/uploads/:upload_id/chunks/:index`）是**大文件分片**的现成模板。
- 员工面**没有**用户目录接口（`registerClientV2` 全表已核对）：拉同事需要一个新端点（见 §5.4）。

### 2.4 可直接复用的既有机制（省工作量的部分）

| 机制 | 位置 | 对本需求的用处 |
| --- | --- | --- |
| 工作区 = 目录 + 会话集合 | 上游 `packages/workspace/workspace` | "项目"的本地形态直接落在它上面，不另造一套分组 |
| 会话按 `cwd` 自动归组 | 同上 `index.ts:452-511` | 镜像会话无需注册，写产物即可显示 |
| 会话服务 `create(header)` | 上游 `dsh-session-persistence` | 可用**指定 id + 指定 cwd**创建镜像会话 |
| **会话跟随流 `sessionController.follow()`** | 上游 `packages/api/session-controller/src/{index.ts:397,types.ts:450,516,history.ts:119}` | **现成的"快照 + 严格 seq 增量 + 可选流式旁路"**；宿主插件可用（先例 `packages/host/cron/src/index.ts:43` 注入 `sessionController`）。不用自己 watch 会话文件 |
| **文件变更流 `workspaceFiles.changes()`** | 上游 `packages/api/workspace-files/src/{index.ts:364,changes.ts}`（`ready`/`change` 帧，含 absolutePath；客户端有多路复用先例 `client/change-feed.ts:118-175`） | **现成的文件监听**，同步引擎不需要自己引 chokidar |
| 会话逐事件 firehose `ctx.on('session/event')` | 上游 `packages/core/session/src/index.ts:61-72`（全局收需 `{global:true}`） | 轻量钩子（状态机派生）；重活走 `follow()` |
| **持有性证明 ticket 模板 `appproof`** | `server/internal/wasmapp/appproof`（Ed25519 + KID 轮换 + 15min TTL + jti 防重放 + TOFU 安装注册表） | **P2P peer ticket 照它的形状重写**（把 `App` 换成 `project_id`） |
| 本地 `/api/pico/*` 路由 + 持有性证明 | `enterprise/src/auth-gate.ts`、`cron/src/write-proof.ts` | 客户端面板读写项目状态的通道 |
| 本地 SSE 先例 | `packages/host/browser/src/index.ts:730-750`、`cron/src/host-routes.ts:108-137` | "signals only + re-pull /state"的现成形态（**尚未**用 `id:`/`Last-Event-ID`） |
| **本地 WebSocket 升级入口** | 上游 `packages/host/webserver/src/index.ts:180-186`（`registerUpgrade`，精确路径，未注册即 `socket.destroy()`） | 若"客户端↔本机宿主"需要双向流，用它；**它不是服务端↔客户端的通道** |
| 分片上传 + 断点续传 | `wasmapp/api` 的上传路由 | 中继上传文件块的模板 |
| 审计哈希链 | `serverstore/audit.go` | 项目生命周期动作全部落审计 |
| 全页面板 + 槽位 | `packages/client/panel-surface`、`ctx.slots` | 新增"项目"面板 |
| 宿主多语言 | `packages/host/host-locale` | 新插件的宿主文案（禁止模块级冻结语言） |
| 客户端默认禁代理 | `packages/host/desktop/src/network-policy.ts` | P2P 不受 HTTP 代理影响，但也意味着**不能借系统代理出网** |

---

## 3. 不可违背的不变量

> 这些如果被破坏，故障形态都是"静默数据损坏"，因此必须写成判据（§8.4），而不是写在文档里。

**I1 · 会话单写者。** 任一时刻，一个会话 id 只允许一个写句柄；跨成员复制只能追加，不能改写已有事件；接管必须显式移交并留下记录。代码级依据（已核对）：

- 写锁是**内核 flock（POSIX）/ 具名内核信号量（Windows）**，锁文件固定 `session.lock` 在会话目录内，**刻意没有过期机制**（`lease.ts:10-13`：不能抢占卡住的写者，否则撕裂日志），持有者进程死亡由内核释放。
- `SessionAlreadyOwnedError` 有四个触发点（同进程 active handle、跨进程争用、inode 复核连续失败、错误定义 `session-persistence/src/errors.ts:31-37`）——它是**设计语义**，不是可重试的偶发错误。
- 新世代的发布用 **`link()` 而不是 `rename()`**（`generation.ts:814-840`；注释：`rename() would silently overwrite`），`EEXIST` 即冲突返回 false，**绝不覆盖**；`README.md:159`：**没有任何 API 会删除会话文件**；迁移是**副本式**（源文件逐字节保留）。
- ⇒ 判据：镜像写入路径永远不申请会话写锁的所有权转移；同一会话在任意两个成员上同时可写必须有用例变红。
- **上游自己的一手证据（最硬的一条）**：`deepseek-harness` **Discussion #3633** 明确「单写者只是**进程内约定**，持久层没有锁、也没有外部写者检测」⇒ **任何多写者拓扑都会产生重复 seq 区间，且日志永久不可读**；官方 release note 已把 `a session is held by at most one process` 写成设计。这句话是我们拒绝 S3、拒绝"共享会话 = 共享写权"的根本依据，也意味着**不能指望持久层去发现第二个写者**——必须由我们的协议层（租约 + 栅栏令牌）来保证。

**I2 · 文件单写者（v1）。** 任一时刻，一个项目只有一个成员处于驾驶位。跟随者的本地改动**不进入**同步链路，而是落 `conflicts/` 并上报。判据：两成员同时提交快照时，服务端必须用栅栏令牌拒绝旧持有者（不是"后写覆盖"）。

**I3 · 服务端是权威，客户端只收敛。** 项目存在性、成员关系、管理员、删除状态由服务端定；客户端任何本地判断都只是缓存。判据：客户端离线期间的任何本地操作（改名、加人、删项目）在重连后必须被服务端结果覆盖，且不产生"幽灵项目"。

**I4 · 授权与审计锚定控制面，数据面才允许直连。** P2P 直连不得绕过授权判定与审计观察点：直连前必须换短时效票据，服务端记录"谁在何时订阅了哪个会话/项目"。判据：把服务端票据校验关掉时，直连必须失败（不是"仍然可用"）。

**I5 · 不碰上游的持久化契约。** 具体三条：①外部 watcher 必须**监听目录而不是 inode**（世代发布用 `link`、`workspace.json` 用 `rename`，都会换 inode）；②会话文件权限 0600 / 目录 0700 不得放宽；③备份与回滚口径是**整目录 `$DSH_HOME`**，不是单个子文件。判据：同步引擎的任何写入路径都不得改变这三条。

### 3.1 同步引擎的禁区清单（会话存储契约，逐条有代码依据）

> 这一节是"照着做就会把整个后端打死"的清单。**违反其中任何一条，故障不是"某个会话坏了"，而是 fail-loud 拒绝启动或历史分叉。**

| # | 禁止 | 依据 |
| --- | --- | --- |
| 1 | 移动/重排会话目录（必须留在 `sessions/<cwd 派生 key>/<id>/` 原位） | `session-persistence-jsonl/src/index.ts:1436-1463` |
| 2 | 同一 session id 出现在两个项目目录 | `index.ts:1418-1420,997-999` |
| 3 | 引入扁平布局 `<id>.jsonl[.zstd]` | `index.ts:1518-1526,1543-1556` |
| 4 | 混入"反后缀"世代文件（压缩后缀只允许一种） | `index.ts:1529-1541,1558-1564` |
| 5 | **新造 `session.vN.jsonl[.zstd]` 之类的名字**——"当前世代 = 目录内编号最大者，无 marker"，抢名字 = 历史分叉 | `index.ts:1369-1405`、`session-format/src/filename.ts:5` |
| 6 | 覆盖/改写/删除**已提交的世代** | `generation.ts:814-840`、上游 `AGENTS.md:7` |
| 7 | 在写者活跃时改写日志；自行截断 torn tail（只在"下一次写"由持有者截断） | `index.ts:1246-1284`、`storage.ts:328-337` |
| 8 | 删除或改写 `session.lock`（它是 inode 级 flock 的载体） | `lease.ts:70-116,118-123` |
| 9 | 同步 `session.lock` 与 `*.tmp` | `index.ts:1194-1196`、`generation.ts:725` |
| 10 | 提高世代号"强制重读" | `index.ts:954-957,791-797` |
| 11 | 放宽文件权限（0600/0700） | `index.ts:1196,1124-1128` |
| 12 | 绕过 `ctx.workspaceRegistry` 直接改 `workspace.json`（上游 invariant 会报 `some write path bypassed ctx.workspaceRegistry`，且**损坏 = 拒绝启动**） | `workspace/src/invariant.ts:30-48` |
| 13 | 默认同步 `$DSH_HOME/session.json`（那是**登录凭据文件**） | `session-service.ts:24-26,205-222` |

跨版本传输会话文件时**按世代文件原样传**，不要试图"归一化"成某一版的字节（上游格式世代前向 only）。

---

## 4. 总体方案

### 4.1 总览

```
                        服务端（新增独立模块 internal/projects）
        ┌───────────────────────────────────────────────────────────────┐
        │ 项目/成员/管理员/墓碑（PG）   SSE 事件流（控制面 + 中继下行）  │
        │ 会话增量日志（密文，保留期）   文件块对象仓（密文，配额）      │
        │ 驾驶位租约（栅栏令牌）        审计（哈希链）                   │
        └───────┬───────────────────────────────────────────┬───────────┘
                │ 443：登录/控制面/中继（一定可达）          │ 信令
     ┌──────────┴───────────┐   P2P 直连（WebRTC/QUIC）  ┌──┴────────────────┐
     │ 成员 A 桌面端         │◄──────────────────────────►│ 成员 B 桌面端      │
     │ 本地 agent + 会话日志 │   （不可直连时自动降级到     │ 本地 agent + 会话  │
     │ 项目目录 / 镜像会话   │     上面的 443 中继）       │ 项目目录 / 镜像会话│
     └──────────────────────┘                            └───────────────────┘
```

角色分工：

- **服务端**：权威元数据、事件流、中继、密文对象仓、配额与审计。**不执行 agent，不解析内容**（内容默认端到端加密）。
- **每个成员客户端**：本地 agent 照旧在本机跑（沙箱、文件访问、模型调用都不变）；新增的同步引擎是**宿主插件**，负责观察本地会话、物化镜像、驱动文件同步、维护 P2P 连接。
- **驾驶位成员**：唯一可写项目目录的成员；其余成员是跟随者。

### 4.2 选项对比：agent 跑在哪里

| 选项 | 内容 | 优点 | 代价 | 判断 |
| --- | --- | --- | --- | --- |
| **A 本地为主 + 复制（推荐）** | 每个成员本机跑 agent，会话与文件在成员间复制 | 复用全部既有能力（沙箱/工具/模型/连接器）；离线可用；P2P 有意义 | 需要同步引擎与冲突策略 | 采纳 |
| B 单机托管 | 项目只在一台"主机"跑 agent，其他成员远程观看 | 无冲突 | 主机必须常开；其他人要远程终端/文件；仍要复制会话 | 作为 A 的退化形态（驾驶位） |
| C 服务端托管 | agent 跑在服务端 | 单一真源、天然多人 | 等于重做宿主 + 沙箱 + 每用户隔离 + 存储，且本仓服务端从未跑过 agent | 明确不做（另立项） |

### 4.3 控制面

- 服务端持有：项目、成员、角色、墓碑、项目序号、配额、在线状态、驾驶位租约。
- 客户端持有：项目绑定（服务端项目 id ↔ 本地目录路径 + 镜像目录）、本地游标（`project seq`、每会话 `last seq`）、同步状态机。
- **实时通道**：一条 SSE（`GET /api/client/v2/projects/stream`，`Last-Event-ID` 断点续传，服务端保留最近事件环形缓冲 + 落库的 `project_events`），写操作走普通 POST。选 SSE 而不是 WebSocket 的理由：零新依赖（`gin-contrib/sse` 已在依赖树）、天然断线重连语义、"服务端→客户端"是主要方向；中继上行用 POST + 分块。
- **在线状态（presence）**：由 SSE 连接存活 + 心跳推导，**不落库**（只在内存 + 广播），避免写放大。

### 4.4 会话语义：三种产品语义与推荐

**先看上游已经有什么（这决定我们是"设计"还是"平移"）**：

| 上游已有 | 位置 | 说明 |
| --- | --- | --- |
| 会话跟随流 `session/follow` | `packages/api/session-controller/src/{types.ts:450,516,history.ts:119}` | **快照开场 + 严格 seq 增量**的成品协议：`{type:'snapshot', cursor, records, hasMore, projections}` → 事件帧；seq 跳号**直接抛错**（`history.ts:225-231` 逐字 `session event stream skipped seq N`）；`assistantStream` 是显式 opt-in |
| 单写者 + 多观察者 + 接管 | `packages/api/terminal-controller/src/terminal.ts:71-102` | `follow()` 的 JSDoc 逐字：`Attach with exclusive input control; an older attachment becomes read-only.`——**这就是 S2**：接管 = 新 attach 顶替、旧者静默降级为只读并**继续收帧**；控制权变化用显式 `state` 帧广播；控制者可空置 |
| 慢消费者策略 | `packages/api/terminal-controller/src/stream.ts`（全文 75 行） | 每个订阅者一个**有界队列**（按 UTF-8 字节计费），超限**显式断开**并提示"重连以恢复当前屏幕"；不阻塞写者、不无限缓冲、不静默丢帧 |
| 本地 SSE 先例 | `packages/host/browser/src/index.ts:730-750`（另有 cron/connectors/wasm-apps-host） | `retry: 1500` + 15s 心跳 + **"signals only; clients re-pull /state"**；**尚未使用 `id:`/`Last-Event-ID`**（带补播的 SSE 是我们要新增的部分） |

| 语义 | 描述 | 实现代价 | 风险 |
| --- | --- | --- | --- |
| S1 只读跟随 | 同事能看到状态/时间线（按档位含正文），不能输入 | 低 | 无 |
| **S2 移交控制（推荐默认）** | 同一时刻一个写者；可显式接管，**原写者降级为观察者**（不报错、不掉线） | 中（平移终端实现） | 需防僵尸写者（见下） |
| S3 并发多写 | 多人同时在一个会话里输入 | **不现实**：工具调用带不可交换的副作用（shell / 写文件 / 外部写接口），绝大多数工具不幂等，副作用去重等于重写整个工具层 | 重复执行命令/重复改文件、审计无法归因。**明确不做** |

**推荐：v1 直接做 S2（S1 是它的退化形态），S3 用"分叉而非合并"替代。** 需要"我也来改这条线"时，从 `fork_seq` 分叉出**新 session id**（上游 header 已有 `parentSession` 字段，零格式破坏），两条线各自单写者，不合并。

S2 的四条实现规则（前两条直接来自终端先例，后两条来自会话流的实测风险）：

1. **写权是一个单调递增的世代号（fencing token），不是布尔标志**：日志/发布路径带世代号，落后的一律拒绝。租约/锁本身不足以防旧写者继续写，必须让被保护的资源能识别并拒绝过期持有者。
2. **接管必须先结算、再转移**：旧写者收到接管请求 → 收尾当前 turn（落盘最后一个事件）→ 发出"我已停写"确认 → 新写者才开始写。**不能"新写者先写、旧写者稍后停"**（那就是双写窗口）。
3. **跟随者必须走只读观测路径**，并**显式避开** `follow()` 里 `source.source === 'prepared'` ⇒ `promote()` 的激活分支（`history.ts:203-211`，JSDoc：`starts ordinary Session activation after snapshot delivery`）。否则**同事来看一眼就会把会话叫醒**——这是可复现的产品事故。
4. **跟随链路的补播锚定在会话所有者本机**，中转只转发、不做权威。判据：任何时刻"这个会话的 seq N 是什么"只有一个权威答案，且它与写者同机。

**跟随侧实现要点**：

1. 写者侧：宿主插件订阅本地会话事件（先例 `packages/host/desktop/src/loop-notify.ts`），把 `(session_id, seq, event)` 批量推送（节奏对齐上游活写批量 200ms）；**不要**自己去 watch 会话文件（世代文件切换 + 批量写会让文件层语义与逻辑事件错位）。
2. 跟随侧：按 seq 严格应用，**缺口不应用**——要么向所有者补播、要么整段回落快照；两者都不可达时显示"等待补齐"。
3. **流式 token 是进程内事件（`process-local`），日志里只有结算**（`assistant/attempt`/`assistant/message`）：因此**状态与工具时间线可补播，token 流不可补播**。token 旁路必须自带 `(attemptId, revision, index)` 三元组做连续性校验（`revision` 在 agent 生命周期变更时**重置为 1**），丢帧即**丢弃累积、重取基线**，UI 要能接受"输出出现一次跳变"。
4. **低频广播 + 高频点播**：状态/时间线对全项目推送；token 流只在"有人正打开该会话"时按需订阅（避免 `成员数 × 会话数 × 帧频` 的放大）。
5. 镜像会话只读：面板禁用"继续对话"，只提供"复制为新会话（分叉）"；镜像写句柄与本地 agent 的 resume 路径隔离（I1 判据）。
6. **去重必须靠 seq，不能靠文件名**：世代发布用 `rename(2)`，存在"两个名字同指一个 inode"的窗口；inotify 事件只是**提示**（手册原文：`the filename may already have been deleted or renamed`，且会 `IN_Q_OVERFLOW`）⇒ 权威状态靠**周期性 stat/reopen + seq 校验**。最佳类比是 SQLite 的 WAL checkpoint：**只要还有旧 tailer，就不能重置**。
7. **背压的现成缺省是 2 MiB/订阅者**（上游 `default(2*1024*1024)`，cordis.yml 可配）。工业界同构做法可作对标：Redis pub/sub 32MB 即断、NATS `max_pending` 64MB 并报 `ErrSlowConsumer`、Kafka 用 `max.poll.interval.ms` 踢慢消费者。

### 4.4.1 观察者侧最小可见状态模型

不要把一个项目的全部原始事件推给所有人（体积与隐私双重风险）。收敛成**一个 `SessionView` + 一个单调 `viewRevision`**，由**会话所有者本机按档位裁剪后**下发：

```
SessionView {
  sessionId, projectId, parentSessionId?, cwdLabel（显示名，非绝对路径）, title?
  asOfSeq, viewRevision            // 新鲜度与乱序丢弃的判据，两者必须同时存在
  activity: idle | thinking | streaming | executing-tool | waiting-approval | waiting-user | error
  activitySince, lastEventAt, lastEventSeq
  streaming?: { attemptId, revision, index, chars, previewBucket, tail? }
  toolCalls: [{ callId, name, phase, startedAt, endedAt?, exitCode?, argDigest?, resultDigest? }]
  pendingApproval?: { requestId, kind, since }
  counters: { turns, toolCalls, tokensIn?, tokensOut? }
}
```

`activity` 的派生表（**唯一真源放在共享项目服务端/所有者本机一份，两端共用**，不能各端各写一份）：`agent/status=idle` → `idle`；`turn/start` → `thinking`；`assistant-stream` chunk → `streaming`；`tools/pre-execute|execute` → `executing-tool`；`approval/asked` 未配对 → `waiting-approval`；有排队输入且空闲 → `waiting-user`；`agent/error` 未被重试消化 → `error`。注意 `waiting-approval` 与 `waiting-user` **必须分开**（同事要采取的动作不同）。

### 4.5 文件同步：路线选择

| 路线 | 机制 | 冲突 | 实时性 | 实现量 | 判断 |
| --- | --- | --- | --- | --- | --- |
| **A 宿主权威 + 远程访问（Live Share 模式）** | 一个成员的机器承载完整目录与该目录上的 agent；其他人**没有本地副本**，通过网桥读文件/列目录/订阅变更 | 结构上不存在 | 读路径实时 | 中（**无需同步引擎**） | 作为"零冲突"退路 |
| **A′ 可转移单写者 + 只读副本（推荐 v1）** | 写者（可移交）本地全量；其他成员持**单向同步**的只读副本（经 `ctx.fs` 远程后端或本地镜像）；要写就申请租约转移 | 结构上不存在（单向） | 秒级 | 中 | **采纳** |
| B 双向块同步 | 各端都写，块级合并，冲突留副本 | 必然发生，靠冲突副本兜 | 秒级 | **大**（自研 ≈6–12 人月起；或集成 Syncthing/Mutagen + 法务评审） | v2/实验；**不在本需求内自研** |
| C git 中心仓 + 自动同步 | 服务端托管裸仓，客户端自动 commit/pull/push | git 原生三方合并 | 分钟级（需人工介入） | 中 | 作为 A′ 的**归档补充**，不是替代 |

选 A′ 的核心理由：

- **业界没有反例**：VS Code Live Share、Zed、Codespaces、Gitpod 这些多人协作开发产品**没有一家做双向文件同步**，全都选"**一份权威副本 + 远端执行 + 瘦客户端**"。这是结构性选择，不是工程偷懒（证据见 `temp/shared-project-research/file-sync.md` §5.3/§7）。
- agent 的改动是**批量语义操作**（一次重构动 200 个文件、`npm install` 动几万个文件），逐文件双向同步会造成同步风暴与无意义冲突；单向复制把"一次 agent 动作"自然聚合成一个版本。
- **与 S2 会话语义对称**：一个项目任一时刻有一个"驾驶位"，会话与文件都是单写者。用户只需理解一个概念。
- **上游有现成接缝**（这条决定了实现量）：`@deepseek-ai/dsh-fs` 是**抽象文件系统接缝**，官方文档原话是"you rarely load `dsh-fs` directly: you **mount a backend** that registers as `ctx.fs`… **swapping backends changes nothing for the policy plugin, the tools, or the tool schemas.**"；而且它**已内建乐观并发版本令牌** `FsVersion`（"Opaque file-version token… a remote backend might use a revision id."）与错误码 `FS_STALE_VERSION`。⇒ "只读远端视图"可以做成一个 **fs backend**，不动工具与策略层。
- **三条必须兑现的硬约束**：①`.git/` 不同步（安全 + 冲突）；②`node_modules/`、`target/`、`.venv/` 等派生目录不同步；③**服务端做网桥 = 同步流量要算账**（长连接 + 大流量，与 LLM 网关抢同一台机器，不能套用"单实例 ≈1500 并发"的短请求结论）。

**必须如实向用户讲清的能力代价**：A′ 下非写者的 agent 只能在**只读副本**上工作（能读、能分析、能生成 patch，但不能直接落盘）。"每个人本地都能跑 agent 改代码"与"零冲突"不可能同时成立——这是产品取舍，不是实现问题（§9-Q3）。

**P0 实现约束（本轮最有价值的发现，必须先定死）**

**路线 A/A′ 只能走 `ctx.fs` 远程后端，绝不能挂 OS 层虚拟盘/网盘目录。** 上游 `deepseek-harness` 的 discussion #3919（2026-08-21）已实测：在 Google Drive 虚拟盘上，本产品的 `write` 报 **EISDIR**（原子发布用 `fs.promises.link` 硬链接）、`edit` 报 **SetFileSecurityW Win32 87**（复制 DACL）、`pwsh` 初始化报 **SetNamedSecurityInfoW Win32 87**（沙箱 `grantWrite`）；只有只读工具与 git 正常。而官方文档保证 `dsh-fs` 换后端对工具/策略/工具 schema **完全透明** ⇒ **挂远程后端是架构正解，挂虚拟盘是自毁**。这一条同时排除了"用 OneDrive/Google Drive/共享盘当项目目录"的所有取巧方案。

**共享项目目录不能被第三方"按需同步"接管**：Resilio 官方明确指向 OneDrive "on demand" 文件夹 "won't work"，Google Drive streaming 官方承认写密集负载更适合 mirroring。⇒ 绑定时必须**检测并警告**（目录位于已知按需同步/云盘挂载点）。

**行业证据（直接引用，用于说服而不是论证）**：VS Code Live Share 官方原话 "all content that is shared is kept on the host's machine and **not synchronized** to the cloud or on the guest's machine"；Zed 是 "edit the code **hosted on your machine**"，guest 默认只读；**VS Code Remote 官方 FAQ 直接把 "network share or synchronizing files" 列为对照，称远端开发 "dramatically better performance"**；反例结局：Atom Teletype 2023-03 归档、SparkleShare（用 git 做 Dropbox）事实停摆、Screenhero 被 Slack 吸收后停用；CRDT 文件系统至今无成熟实现（Cambria 2024-06 停、Upwelling 2022-11 停、Patchwork 仍 0.8.2），唯一做到真·可变 FS 双向同步的 Peergos 靠的恰恰是"单写者密钥 + 服务端全序"。

> ⚠️ **两条不要被沿用的错误前提（本轮调研纠正）**：①**不要拿 Zed 当 P2P/直连先例**——Zed 官方现行说法是协作流量**经 zed.dev 服务器代理**（WebSocket RPC + Postgres 元数据），并明说这比 P2P 更可靠，WebRTC/LiveKit 只承载音视频与屏幕共享；真正的"先试 P2P、失败回落中继"先例是 **VS Code Live Share**（直连端口 5990–5999，回落 `*.servicebus.windows.net:443`）与 tmate/upterm。②**Zed 没有共享终端**（官方逐字 `Following in terminals is not currently supported`，feature request 自 2023-05 仍 open）——共享终端的真先例是 tmux `attach -r` 与 Live Share 的共享终端（读写模式下官方原话 "everyone can type in the terminal, including the host"）。附带的成熟度提示：**Live Share 自 2026-05 起进入维护模式**、来宾上限 30、issue tracker 已关闭——它是**架构**先例，但不是一个仍在投入演进的产品，我们抄的是它的形态而不是它的未来。

**规模与实时性的量级（用于设定上限与默认值）**：`node_modules` **≈10 万文件**；cargo `target/` 单仓 **3151 MiB**；Chromium 一次 tag 切换 **539,180 文件**（Windows 15.75 分钟 vs Linux 22 秒）；Docker 官方给出"需要同步共享"的门槛就是 **100,000 files**；Zed 自述 >10 万文件吃力。实时性默认值谱系：Watchman/webpack 20ms、chokidar 2000ms、**Syncthing 去抖 10s** + 每小时全量重扫 ⇒ **同步层的去抖必须是秒级（建议 200–500ms 去抖 + 1–2s 写入稳定判定），不能抄构建工具的 20ms**。

配套规则（细节见 §5、§7.2）：

- **忽略规则必须是自己的版本化制品，不能直接复用 `.gitignore`**：gitignore 是"最后匹配生效"且"父目录被排除后无法再包含子文件"，Syncthing 是"第一个匹配生效"且支持反选，`.dockerignore` 忽略首尾斜杠，`.npmignore` 总是忽略 `node_modules`——四套语义不同。要求 `syncIgnore ⊇ 硬拒绝清单` 可校验。
- **默认忽略清单**：`.git/`（**含 git hooks 的 RCE 面** + index 每次 `git status` 重写 + gc 抖动）、`node_modules/`（**含平台特定二进制，不是慢是会坏**）、`.venv/`、`target/`、`dist/`、`build/`、`coverage/`、`.next/`、`__pycache__/`、`.DS_Store`、`~$*`、`.~lock.*#`、同步器自己的临时前缀。**要保留**的是 `package-lock.json`/`Cargo.lock`/`go.sum` 与 Go 的 `vendor/`——判据是"**是否含平台特定产物**"，不是"是不是依赖"。
- **不能依赖 IDE 默认值保护**：VS Code **1.94.0 起已把 `**/node_modules/*/**` 移出 `files.watcherExclude` 默认值**。
- **跨平台差异必须显式处理**：APFS 默认大小写不敏感 + Unicode 规范化不敏感；Windows 的大小写敏感是**按目录** flag ⇒ 冲突必须**报错而不是择一**；可执行位 Windows↔Unix **天然有损**，应显式降级为两档并幂等规范化。

**其余配套规则**：

- **块化**（单向复制侧）：内容寻址（FastCDC 或固定 4–8MiB 分块），块哈希即块 id，天然去重与断点续传。
- **块存储**：服务端对象仓（密文）+ PG 元数据；配额按"项目去重后字节数"计。P2P 直连时块可以不走服务端，但**服务端仍记录 manifest**，以便离线成员补齐。
- **监听与写入纪律（上游契约，必须遵守）**：①用 `workspaceFiles.changes()` 拿变更（来源 `fs/observed`），**不要**按 inode 监听——世代发布用 `link()`、`storages/*.json` 用 `rename()`，都会换 inode；②应用快照时写入必须**临时文件 + 原子替换**，**临时文件必须建在目标文件所在目录**（见 §4.6.6 的 Windows ACL 风险）；③**不得改变会话文件 0600 / 目录 0700 权限**；④同步引擎元数据放 `<project>/.picoaide/` 并加进忽略规则。

#### 4.5.1 路径不一致（跨平台必然发生，必须显式设计）

项目在 A 机器上是 `D:\work\acme`，在 B 机器上是 `/home/b/acme`。这不是细节，它影响四处：

1. **会话头 `cwd` 每台机器都不同** ⇒ 会话归属不能用 `cwd` 做跨成员标识，必须用项目 id（服务端权威）；`cwd` 只是本机属性。镜像会话的 `cwd` 指向本机镜像目录。
2. **agent 写进文件的绝对路径会跨机器失效**（配置、脚本、lock 文件内容、`.env`、IDE 配置）。产品上要在项目面板明确提示"避免提交含绝对路径的文件"，并在默认忽略规则里加常见项。
3. **两端换行符/权限位/大小写敏感性差异**：NTFS 大小写不敏感而 ext4 敏感；可执行位在 Windows 上不存在。manifest 里要记录权限位但**跨平台对比时按平台归一**，否则会来回"改动"。
4. **项目绑定表记录本机路径**（`project_bindings.local_path`）：仅用于展示与诊断，**不参与授权**；授权只认 `project_id`。

### 4.6 "文件被占用"与并发写（用户点名的问题）

问题要拆成三层，**混在一起谈必然设计错**：

| 层 | 问题 | 答案 |
| --- | --- | --- |
| L1 本机 OS 层 | Windows 独占句柄 / POSIX advisory 锁 / 应用锁文件 | 把失败面压缩成"一次 rename"，按失败码分流（§4.6.1） |
| L2 跨成员语义 | "同事的 agent 正在改这个文件" | **OS 锁跨机器不存在**，必须用中心服务器上的**应用层租约 + 栅栏令牌**（§4.6.2） |
| L3 内容冲突 | 两边内容都变了 | 不是占用、不是时序问题；走冲突归档（§4.6.3） |

> 判据一句话：**占用是时序问题（等一会儿就好），冲突是语义问题（两份内容都有效）**。把占用记成冲突会在 `conflicts/` 里堆一堆内容相同的副本。

#### 4.6.1 OS 层占用：把失败面压到一个点

**前置（所有主流实现的共同做法）**：**永远不原地改文件**。先写旁路临时文件，再原子就位。临时文件必须建在**目标文件所在目录**（既是"同卷"以保证 rename 原子，也是 Windows ACL 的硬要求——见 §4.6.6）。这样"目标被占用"退化成**只有 rename/replace 失败**这一种失败模式。

| 失败现象 | 判定 | 处置 |
| --- | --- | --- |
| `ERROR_SHARING_VIOLATION`(32) / `ERROR_LOCK_VIOLATION`(33) / `ERROR_ACCESS_DENIED`(5) **且文件存在** | 目标被占用 | 有界重试 + 指数退避；超时进延迟队列 |
| 同上但**目标不存在**、父目录可见同名 | 对方处于 delete-pending | 退避重试，**不要**改判为"文件不存在"（会让同步器以为内容被删） |
| `ERROR_USER_MAPPED_FILE`(1224) / `ETXTBSY` | 正在运行的二进制 / mmap 文件 | 长退避（分钟级）+ UI 明确提示"请关闭正在运行的程序" |
| `ReplaceFile` 返回 1175/1176/1177 | 替换链某步被占用 | 回落 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 再试一次，仍失败则退避 |
| `ERROR_ACCESS_DENIED`(5) **持续失败且 ACL 正常** | 不是锁，是权限/只读 | **降级只读 + 上报**，不要重试 |
| `ENOSPC` / `ERROR_DISK_FULL`(112) | 磁盘满 | 暂停该目录的拉取 + 明确告警（不要无限重试） |
| 路径过长 / 路径非法 | 结构性问题 | 跳过并计数上报（Windows `MAX_PATH`=260） |

**重试参数（建议值，比初稿更细）**：退避 **50ms → 100 → 200 → 400 → 800 → 1600 → 3200**（约 6.35s / 7 次），之后每 30s 一次、上限 10 分钟，超时标记"无法写入"并上报。可重试集合严格限定为 `{32, 33, 5(delete-pending), 1224, EBUSY, ETXTBSY, EAGAIN}`；**只读属性/权限类失败不在集合内**（见下）。**总预算必须显著小于 30s 的工具 deadline**——本仓已踩过"内部真实错误被 deadline 覆盖成笼统 `tool call timed out`"的坑（`packages/host/browser/src/budgets.ts` 的教训）。对标参考：robocopy 官方默认 `/R:1000000 /W:30` 是备份语义，交互场景不可用。

**三条不能错的判断**：

1. **`ReplaceFile` 必须始终传 `lpBackupFileName`**；返回 **1176 要先检查目标是否已不存在**；`REPLACEFILE_WRITE_THROUGH` 官方标注 *"This value is not supported"*，不要依赖。
2. **macOS 没有 `FILE_SHARE_DELETE` 等价物** ⇒ unlink 一个正被打开的文件**会成功且不报错**（= 静默分叉）⇒ **必须比对 inode，不能只听错误码**。
3. **只读属性必须单列一类**：Mutagen issue #573/#574 的反面教材——git loose object 全带 `FILE_ATTRIBUTE_READONLY`，同步器每周期重试、每周期失败。持续 `ACCESS_DENIED` 且 ACL 正常 ⇒ 判定为只读/权限，**降级只读 + 上报，不重试**。

**平台就位方式**：Windows 先 `ReplaceFileW`（**保住 DACL / 创建时间 / EFS / 命名流**）→ 失败回落 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`（代价：新文件用自己的 ACL 与创建时间）；macOS 优先 `renamex_np(..., RENAME_SWAP)`（无"目标短暂消失"窗口）→ 回落 `rename(2)`；Linux `rename(2)`。需要时 `fsync(dirfd)`。

**"谁挡住了"**：Windows 可用 **Restart Manager API**（`RmStartSession`/`RmRegisterResources`/`RmGetList`）查出持有句柄的进程名与 PID——这是 MSI 用来提示"请关闭以下程序"的官方机制，比猜准确得多（Node 绑定与调用成本**未查实**，需在实现期验证）。

**应用层锁文件**：`~$` 前缀临时文件默认不同步；`.git/index.lock` 存在时把该目录视为"事务中"并暂停同步该目录；包管理器缓存锁同理。**POSIX advisory 锁不要拿来当互斥**（跨平台语义不一致，且跨机器不存在）。

#### 4.6.2 跨成员可见性与互斥：应用层租约（唯一可行解）

**为什么不能用 OS 锁**：Windows 的 `FILE_SHARE_*` 只在单机生效；`flock`/`fcntl` 是 advisory 且经 NFS/SMB 语义依实现而变；**任何 OS 锁在同事拔网线时都失效**（锁在他机器上，你的进程永远等不到）。

**设计原则（Kleppmann 的分类，必须先回答）**：这把锁是 **efficiency** 还是 **correctness**？——本项目**几乎一定是 correctness**（两人同时改同一文件 = 丢失改动/半成品合并），所以必须带 **fencing**（下面第 4 条）。原文："you can ask what would happen if the lock failed"。

最小可行设计（服务端**一张表**）：

```
project_locks(project_id, path, holder_user, holder_device, holder_session,
              lease_id, fencing_token, acquired_at, expires_at)
PRIMARY KEY (project_id, path)
```

1. **互斥靠数据库唯一约束**（`INSERT … ON CONFLICT DO NOTHING`），**不要**"先查再写"。
2. **`expires_at` 只在服务端读写**；客户端只收"剩余有效期"，**不做本地过期判断**；需要倒计时用单调时钟（`performance.now()`/`CLOCK_MONOTONIC`），**不要用墙上时钟**。
3. **租期 30s / 心跳 10s**（允许丢 3 次心跳）；范围 15–60s。**长任务（10 分钟构建）不能一次长租约覆盖**——按批次持锁，否则协作完全停摆。
4. **栅栏令牌（fencing token）来自数据库序列**，严格单调递增；**所有写路径必须带它**，接收端记住 `max(token)` 并**拒绝更小的**。这是"防数据损坏的那一半"，也是最容易被省掉、代价最高的一步——省掉它的症状是**偶发、难复现、表现为"某人的改动凭空消失"**。Kleppmann 原文列举了 GC 停顿、页错误、`SIGSTOP`、GitHub 约 90 秒网络延迟事故：**"客户端以为自己还持锁"是常态，不是异常**（原文口径：`rejecting any writes on which the token has gone backwards`）。两条配套纪律：①**fencing 失败必须 fail-closed**——先例 HDFS QJM：fence 不成功就不切主；②**可观测的移交计数**（谁把控制权交给了谁、第几世代）必须落审计，否则线上出问题无法回溯；③别指望"选举"能保证唯一——client-go 官方文档明说 leader election **不保证唯一性**。
5. **粒度**：v1 用**整项目驾驶位**（`path=""`）——与 agent"一次重构动 200 个文件、`npm install` 动几万个文件"的现实契合，**也因为文件级锁挡不住 `bash`（§4.6.7）**；v1.1 再上**路径前缀租约**（`src/api/**`），此时冲突判定 = 两个路径集合有交集，且必须**一次事务全拿**（或按路径字典序申请）防死锁。整项目锁在细粒度模式下仍要保留，留给 `git checkout`/`npm install` 这类全局互斥操作。
6. **断网/崩溃**：短暂断网（< 租期）本地继续持有，直到"剩余租期 < 一个心跳周期"才降级；**长时间断网必须停写**——"本地继续写、服务端已把锁给了别人"是最危险的状态。崩溃后恢复的第一件事是**查自己的租约还在不在**。
7. **服务端故障时 fail-closed 还是 fail-open？必须拍板**：建议**写 fail-closed、读永远可用**（宁可停下，也不要造出两份互不知情的改动）。
8. **先做可见性，再做互斥**：UI 上标"🔒 张三的 AI 正在改 `src/api/*`"（`list` 轮询或 SSE 推送）**成本极低**，能把 80% 的"两人同时改同一文件"变成"其中一个人主动等一下"，是性价比最高的一步。

#### 4.6.3 跟随副本上的本地改动 = 冲突

落 `<project>/.picoaide/conflicts/<member>-<时间戳>/<相对路径>`，原文件恢复为权威版本，面板提示"你的本地改动已保存到 conflicts/，可手工对比"。**绝不**"以本地为准"或"以后写覆盖"——那会在多人场景里丢掉别人的工作。

#### 4.6.4 驾驶位切换时的陈旧副本

切换前要求新驾驶位先完成一次"同步到最新版本"（否则它的本地副本是旧的，一切换就让旧内容回流）。租约应答里带服务端当前版本号，客户端必须 `version == 最新` 才允许接管；服务端用栅栏令牌拒绝陈旧提交。

#### 4.6.5 三类"派生数据"不要同步（否则同步风暴）

1. **`.git/`**：主流同步工具明确不推荐同步它（Mutagen 官方列出多条理由，含安全风险）。git 元数据要么整体排除、要么走"git 中心仓"这条独立路径。
2. **`node_modules/`、`target/`、`.venv/`、构建输出**：同步没有意义，且会打爆文件监视器配额。
3. **同步引擎自己的元数据/临时文件**（`.picoaide/`、`*.picoaide-sync-tmp-*`）：必须在忽略规则里自认，且崩溃后可清理。

⇒ 默认忽略规则 = `.gitignore` 语义 + 上述内置条目，落 `<project>/.picoaideignore`（与服务端分发的默认规则合并，项目内可覆盖）。

#### 4.6.6 Windows 沙箱 ACL 与"搬入文件"的冲突（**P0，需真机验证**）

本产品在 Windows 上给工作区目录**动态加一条可继承的 write ACE**（`dsh-sandbox-windows-acl` 的 `grantWrite`，`SUB_CONTAINERS_AND_OBJECTS_INHERIT`），沙箱内进程靠它才能写文件；而该实现有一条**幂等短路**（`acl.ts:217-224` 注释：目录已有该 ACE 就跳过 `SetNamedSecurityInfoW`，否则整树重推 "minutes on large workspaces"）；上游 `fs-local/src/fsio.ts:574-577` 的不变量也明确写着"**新建 Windows 文件继承目标目录的 DACL**，覆盖时复制目标 DACL 并在发布时保留目标 descriptor"。

与 Windows 的移动语义叠加后就是坑：**同卷跨目录移动会保留原目录的权限**（Microsoft 文档原话："The only exception to this rule occurs when you move an object to a different folder on the same volume. In this case, the original permissions are retained."）。⇒ 同步引擎若把文件暂存在工作区之外再 rename 进工作区，**搬进来的文件带着暂存目录的 ACL，缺工作区的可继承 ACE** ⇒ 沙箱内的 agent 写不了它（`ERROR_ACCESS_DENIED`），而现场极难看出是同步器造成的。

设计规则（四条，必须写进实现）：

1. **同步临时文件创建在【目标文件所在目录】**（Syncthing 就是这么做的：`.syncthing.<name>.tmp` 就在目标目录），**不要**用跨目录/跨卷 staging 目录。
2. **优先 `ReplaceFile`**（Microsoft 文档明确保留被替换文件的 DACL），`MoveFileEx(MOVEFILE_REPLACE_EXISTING)` **不作为默认路径**（搬入文件的 ACL 会被带走）。
3. **同步器写入工作区后触发一次 ACE 复核**（或主动调一次 grant）——幂等短路意味着它**不会**自动补齐新来的文件。
4. **跨卷反而安全**（"moving an object to another volume → inherits the permissions of its new folder"）⇒ **行为依卷而异**，测试矩阵必须同时覆盖"同卷跨目录"与"跨卷"。

> 待验证（真机）：①同卷跨目录 rename 进来的文件是否真的缺 ACE；②缺 ACE 时沙箱内的表现；③`ReplaceFile` 是否真的保住 ACE。判据：`icacls <file>` 前后对比。

#### 4.6.7 agent 的写路径只有一半能被拦（决定锁的粒度）

| 写路径 | 是否经过 `ctx.fs` | 能否强制租约/fencing |
| --- | --- | --- |
| `write` / `edit` / `str_replace_editor` 等工具 | ✅ 经过（带 `FsVersion` 版本守卫） | ✅ 可以 |
| `bash`（`npm install`、`cargo build`、`git checkout`、formatter、codemod） | ❌ 子进程直接写裸文件系统 | ❌ **不能**（执行过程中无法逐文件拦） |

⇒ 三条结论：

1. **整项目锁（`path=""`）是本产品的主锁**，不是文件级锁——文件级锁挡不住 `bash`。
2. 文件级租约的价值是**可见性 + 对工具写路径的互斥**，不是完全互斥。
3. 设计文档里**不要承诺"文件不会被同时修改"**，只能承诺"**冲突可被检测并被可见地处理**"。`bash` 的约束形态是：命令启动前要求持项目互斥锁 → 命令结束后把产生的变更作为**一个整体**对账（带 fencing 检查）。
4. 上游 **hooks 子系统**（`dsh-hooks-claude-code`/`dsh-hooks-codex`/`dsh-hook-protocol`）能在工具调用上 **block**，是租约强制点的现成入口。

#### 4.6.8 批量操作、自激与"防批量误删"（同步引擎最容易被忽略的三个面）

1. **防批量误删安全阀（必须有）**：`git clean -fdx`、`git stash` 会整片删掉 `node_modules`/`target`，同步器极易把它判成"用户删了整个项目"并**把删除传播出去**。照抄 Mutagen 的三道判定：**root deletion**（同步根被删）/ **root emptying**（根目录几乎被清空）/ **root type change**（根从目录变成文件）⇒ 一律**暂停同步并要求人工确认**，不做自动传播。
2. **自激（self-excitation）**：Dropbox 官方承认"杀软/备份软件访问会被当成编辑"；Mutagen 的 `internal` staging 会把临时目录放进同步根。⇒ ①同步临时前缀必须进忽略规则；②本地写入要**标记为自身写入**（不能只靠路径前缀判断，因为写入路径可能与用户路径重合）；③同步器回写后要抑制自己产生的事件，否则两端互刷。
3. **限流/合并顺序（按收益排序，前两项是必做项）**：排除派生目录（降 2–3 个数量级）→ **去抖 200–500ms + 写入稳定判定 1–2s** → **目录级 diff 而非事件回放**（watcher 在四平台都会丢事件，事件流不能当唯一真源）→ **检测"批量操作进行中"**（本产品有信息优势：agent 的命令是宿主发起的，可以在 `bash` 前后发"批量模式开始/结束"信号）→ 对端背压 → 令牌桶（建议起步 **200 ops/s**）→ 块级 delta。
4. **watcher 的容量上限要按机器算**：Linux `inotify.max_user_watches = clamp(内存 1%, 8192, 1048576)`（**不是发行版常量**）；watch 超限报 `ENOSPC`、实例超限报 `EMFILE`、队列溢出报 `IN_Q_OVERFLOW` 且**其余事件永久丢失**。⇒ 溢出必须能被检测（并触发一次全量对账），不能静默。

### 4.7 删除与墓碑（R5）

删除项目 = 服务端写 `deleted_at` + 追加一条 `project.deleted` 事件（带 `seq`）。传播路径三条，缺一不可：

1. **在线成员**：SSE 收到事件即进入删除流程。
2. **离线成员**：上线后 `GET /projects?since=<seq>` 拿不到该项目 → 走 `GET /projects/tombstones?since=` 显式拿到墓碑（**不能只靠"列表里没有"**，那与"被移除成员"无法区分）。
3. **长期离线成员**：墓碑保留期（建议 ≥90 天）+ 客户端本地记录"我加入过 project X" 的绑定表 → 重连时对账，孤儿绑定进入删除流程。

**台账口径的两条先例（可直接抄）**：

- **墓碑保留期 = 你能容忍的最大离线时长**（硬先例：Kafka `delete.retention.ms` 默认 **24h**，官方明说 lag 超过它就会**永远看不到删除标记**）。所以这不是一个随便填的数字，而是产品承诺。
- **防"墓碑杀掉新对象"三解**（务必选一个）：①**不可变 id**（Kafka offset："never changes… permanent identifier"）——我们用的 UUID 已满足；②名字永久退役（GitHub 仓库名被删后不进公共池）；③冻结期后放行（组织名 90 天）。推荐 ①，并在协议里写明"id 永不复用"。

客户端删除流程（**保守是刻意的**）：

0. **"级联删"还是"脱离存活"必须显式二选一**（先例：GitHub 删 private 仓库会把 fork 一起删，删 public 仓库则 fork 脱离存活）——这个选择直接决定我们"成员本地副本"的处置，不能靠默认。
1. 立即停止该项目的同步与订阅；从面板移除。
2. 本地项目目录**归档**而不是硬删：移动到 `<projectsRoot>/.deleted/<project-id>-<时间戳>/`（默认保留 7 天，策略可配），面板给出"已删除项目在本地的归档位置"。
3. 镜像会话与本地镜像工作区记录一并清理。
4. **成员自己的会话不删**（那是他自己的对话记录，不是项目资产）——只解除与项目的绑定。

> 用户说"所有成员的项目要同步删除"，语义上确认的是**项目对象**消失，不是"删掉同事硬盘上的对话记录"。这里必须由用户拍板（§9-Q4），因为默认硬删会造成不可逆的数据损失。
>
> **产品文案纪律**：服务端能做的是**撤销访问 + 删除服务端副本 + 发墓碑让各端收敛**；本机已有的会话日志文件不可能也不应该被远程删除。发布说明里要写清这条边界，不能承诺"远程擦除"。

### 4.8 安全与隐私

**4.8.1 隐私分档（默认 L1）**

| 档 | 同事能看到 | 适用 |
| --- | --- | --- |
| L0 存在性 | 会话存在、所有者、有无活动 | 跨部门只读看板 |
| **L1 状态（默认）** | L0 + `activity`、起止时间、计数器 | 同项目同事 |
| L2 元数据 | L1 + 工具名与成败、命令/参数**摘要或哈希**、工作区**显示名** | 同项目同事 |
| L3 全量 | L2 + 参数原文、命令原文、文件 diff、AI 正文、流式 token | 显式授权的结对场景 |

- **默认 L1**：L2 已足够回答"他是不是卡住了、在干什么"这个真实需求；L3 会把代码、可能出现的密钥、客户数据直接送到别人屏幕上。
- 提升到 L2/L3 必须是**显式且被审计**的动作（按项目或按会话）。
- **裁剪必须在会话所有者本机（或服务端）完成后再下发**，绝不能让客户端拿到全量后自己隐藏——Electron 里一行 devtools 就能看到。
- **由此产生一个实现约束**：由于项目内所有成员共享同一把项目密钥，"按档裁剪"不能靠"广播全量、各自少看"，必须**按订阅者定向下发**——所有者对每个订阅者按其档位生成 `SessionView`，L1 订阅者的链路上**根本不出现**正文（P2P 定向流或服务端按订阅关系转发）。这条要在网桥层写死，不能留给 UI。

**4.8.2 撤销与"只读"的真实边界（两条必须写进产品说明）**

- **成员移除 = 立即吊销访问**（不是等下次登录），先例是 GitHub SAML 的三层撤销（SSO 会话硬上限 24h + 可分别吊销 linked identity / active session / 已授权凭据，且**吊销凭据只撤 SSO 授权、不删底层 token**）。我们对应的形态：票据即时失效 + 项目密钥轮换 + 关闭实时订阅。
- **只读 ≠ 防外带**：Figma 里 can-view 的人可以把文件 duplicate 到自己的 drafts——**可见即已获得内容**。所以"给同事只读"不等于"内容不会流出项目"，产品文案不能这么暗示；同理，**可见性档位的旁路必须显式写明**（Notion 直接把"workspace owner 可访问你存的全部数据含 private pages"写在帮助页上）。我们对应的写法：项目面板明示"本项目成员能看到你的会话状态/工具时间线/正文（按档位）"，以及"管理员/平台管理员能看到什么、看不到什么"。

**4.8.3 加密与身份**

- **内容加密**：项目密钥（32B）由管理员创建项目时生成，按成员设备公钥（X25519）封装后存服务端（`project_key_wraps`）；私钥存本机安全存储（Electron `safeStorage` / 系统钥匙串）。会话增量、文件块、manifest 全部加密，服务端只见密文与大小/哈希。
- **成员移除** ⇒ **密钥轮换**（新版本号，`key_version` 随 manifest/事件走）。已分发过的历史内容无法收回，这是端到端加密的固有边界，必须写进产品说明。
- **P2P 授权**：服务端为"用户 + 设备 + 项目"签发短期 peer ticket（绑定设备公钥与项目 id，5–15 分钟，可续），双方在 DTLS/SASL 层互验 ticket 与 fingerprint，防止未授权 peer 加入与信令伪造（详见 §7.1）。
- **IP 暴露**：P2P 直连会把成员的公网/内网 IP 暴露给同事。产品上需要开关（"仅通过服务器中转"），企业合规场景默认可能是后者（§9-Q5）。
- **审计**：项目创建/删除/成员增删/管理员转移/驾驶位获取/密钥轮换/配额调整全部落 `serverstore` 审计哈希链；**不记录内容**。
- **管理端**：`/api/server/admin/projects` 只读列表（项目名、成员数、占用字节、最近活动）+ super_admin 兜底删除；不给管理员看内容（因为看不到密文内容，这也是加密的收益之一）。

### 4.9 容量与配额

- 服务端对象仓按 `项目去重后字节 + 会话日志字节` 计量，落 PG；配额三层：组织总量、单项目上限、单文件上限。
- 中继带宽是易被忽略的成本：建议对中继做**按月流量计量 + 超限降级**（只保控制面与会话，不转发文件块）。P2P 直连不计服务端流量。
- 保留期：会话增量日志（密文）默认 30 天（用于离线补齐），文件块按"被最新 N 个 manifest 引用"做 mark-sweep GC，未被引用超过 30 天回收。

---

## 5. 服务端模块设计（`internal/projects`）

> 遵守仓库纪律：路由集中在 `internal/router` 声明，DAO 走 `internal/serverstore` 风格，迁移放 `migrations-pg/`，管理面动作申报 RBAC 权限点并写审计。

### 5.1 数据模型（提议迁移 `0077_shared_projects.sql` 起）

```sql
-- 项目
CREATE TABLE projects (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_user_id BIGINT NOT NULL,            -- 管理员（可转移）
  created_by    BIGINT NOT NULL,
  seq           BIGINT NOT NULL DEFAULT 0,  -- 项目事件序号（单调）
  policy        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 内容分享档/中继策略/忽略规则分发
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 成员（含角色）
CREATE TABLE project_members (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','member')),
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','removed')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- 控制面事件（增量同步 + 审计对账；保留期后归档/清理）
CREATE TABLE project_events (
  project_id UUID NOT NULL,
  seq        BIGINT NOT NULL,
  kind       TEXT NOT NULL,     -- created/renamed/member_added/member_removed/admin_transferred/lease/...
  actor      BIGINT,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq)
);

-- 会话登记与增量（内容密文）
CREATE TABLE project_sessions (
  project_id   UUID NOT NULL,
  session_id   TEXT NOT NULL,       -- 原会话 id（写者机器上）
  owner_user_id BIGINT NOT NULL,
  device_id    UUID,
  title        TEXT NOT NULL DEFAULT '',
  header_ct    BYTEA,               -- 加密后的会话头（含 cwd，故必须密文）
  last_seq     INTEGER NOT NULL DEFAULT -1,
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','taken_over')),
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, session_id)
);

CREATE TABLE project_session_events (
  project_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload_ct BYTEA NOT NULL,        -- 加密后的事件（可多条打包）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, session_id, seq)
);

-- 文件对象仓（密文，内容寻址）
CREATE TABLE project_blobs (
  project_id UUID NOT NULL,
  blob_id    TEXT NOT NULL,          -- 明文块哈希（用于去重与完整性）；内容密文
  size       BIGINT NOT NULL,
  payload_ct BYTEA,
  storage    TEXT NOT NULL DEFAULT 'pg',   -- pg | file（大块落盘）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, blob_id)
);

-- 目录快照
CREATE TABLE project_trees (
  project_id  UUID NOT NULL,
  version     BIGINT NOT NULL,
  manifest_ct BYTEA NOT NULL,        -- 加密的 manifest（路径→blob_id + 权限位 + 大小）
  base_version BIGINT,               -- 增量基准（便于只传差异清单）
  created_by  BIGINT NOT NULL,
  device_id   UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);

-- 写租约（驾驶位 / 路径前缀锁；v1 只用 path='' 的整项目驾驶位）
-- 主键即互斥：INSERT ... ON CONFLICT DO NOTHING；fencing_token 取自序列，严格单调
CREATE TABLE project_locks (
  project_id     UUID NOT NULL,
  path           TEXT NOT NULL DEFAULT '',   -- 项目内相对路径前缀；'' = 整项目
  holder_user_id BIGINT NOT NULL,
  holder_device  UUID NOT NULL,
  holder_session TEXT,                        -- 哪个 agent 会话（UI 文案用）
  lease_id       UUID NOT NULL,
  fencing_token  BIGINT NOT NULL,             -- 所有写路径必须携带，接收端拒绝更小的
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,        -- 只在服务端读写的绝对时间
  renewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path)
);

-- 设备（P2P 身份绑定）
CREATE TABLE peer_devices (
  id          UUID PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  platform    TEXT NOT NULL DEFAULT '',
  pubkey      TEXT NOT NULL,          -- 设备公钥（用于 peer ticket 与密钥封装）
  last_seen_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 项目密钥封装（每设备一份）
CREATE TABLE project_key_wraps (
  project_id UUID NOT NULL,
  device_id  UUID NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  wrapped_ct BYTEA NOT NULL,
  PRIMARY KEY (project_id, device_id, key_version)
);

-- 客户端绑定对账（"我加入过哪些项目"，用于墓碑与孤儿清理）
CREATE TABLE project_bindings (
  user_id     BIGINT NOT NULL,
  device_id   UUID NOT NULL,
  project_id  UUID NOT NULL,
  last_seq    BIGINT NOT NULL DEFAULT 0,
  local_path  TEXT,                    -- 由客户端上报（只用于展示，不参与授权）
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id, project_id)
);
```

分区/保留：`project_session_events` 与 `project_blobs` 是体量主项，按项目或按月分区 + 保留期清理（与 `usage` 分区、`app_releases` 保留同风格）。

### 5.2 路由清单（集中声明在 `internal/router`）

客户端面（`BearerAuth` + 模块内成员校验）。声明风格照抄 `internal/router` 现有四种之一——客户端面主力是 **③ 子 Group**（`cli.Group("/projects", serverauth.BearerAuth(d.DB))`），管理面**唯一合法形态是 ④ `serverauth.AdminRoute(authed, "GET", "/projects", serverauth.PermX, handler)`**（权限点随路由一起申报，漏申报会被既有测试拦下）。`router.Register` 在全仓只允许出现在 `cmd/server/main.go` 的 `registerProductionRoutes` 内，由 `cmd/server/routes_source_test.go` 静态钉死——**新模块不得自己 `r.Group()`**，否则"测试绿、生产 404"。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/client/v2/projects` | 列表；`?since=<seq>` 增量 |
| POST | `/api/client/v2/projects` | 创建（创建者=管理员） |
| GET/PATCH/DELETE | `/api/client/v2/projects/:id` | 详情/改名与策略/**删除（仅管理员）** |
| GET | `/api/client/v2/projects/tombstones` | 墓碑列表（`?since=`） |
| POST/DELETE | `/api/client/v2/projects/:id/members[/:username]` | 加人/移除（管理员） |
| POST | `/api/client/v2/projects/:id/admin` | 转交管理员（管理员） |
| POST | `/api/client/v2/projects/:id/leave` | 成员退出 |
| GET | `/api/client/v2/projects/stream` | **SSE**：控制面事件 + presence + 中继下行 |
| POST | `/api/client/v2/projects/:id/relay` | 中继上行（信封，含目标成员/设备） |
| GET/POST | `/api/client/v2/projects/:id/sessions[/:sid/events]` | 会话登记/增量上报与补齐 |
| PUT/GET | `/api/client/v2/projects/:id/blobs/:blob_id` | 文件块上传/下载（分片，模板见 WASM 上传） |
| PUT/GET | `/api/client/v2/projects/:id/trees/:version` | 快照提交/获取 |
| POST | `/api/client/v2/projects/:id/lease` | 获取/续租/释放驾驶位（栅栏令牌） |
| POST | `/api/client/v2/projects/:id/peer-ticket` | 签发 P2P 短期票据 |
| GET | `/api/client/v2/users/lookup` | **员工目录**（加人用，限流 + 最小字段） |

管理面（`AdminAuth` + RBAC 申报）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/server/admin/projects` | 只读列表（成员数/占用/最近活动），权限点 `project:read` |
| DELETE | `/api/server/admin/projects/:id` | 兜底删除，权限点 `project:write` |

新增权限点与审计动作：`project:read` / `project:write`；审计动作 `project_create` / `project_delete` / `project_member_add` / `project_member_remove` / `project_admin_transfer` / `project_lease_acquire` / `project_key_rotate` / `project_quota_change`。

### 5.3 实时通道：服务端→客户端（**这条要从零加**）

现状核实：**服务端零 WebSocket、零推送型 SSE**（全仓 Go 无 `websocket`/`Hijack`/`Upgrade` 命中）；SSE 只出现在 LLM 网关对上游响应的透传。客户端侧的 WS 代码（`RemoteStreamMuxClient`）是**客户端↔本机宿主**方向，不能直接用于服务端。三个硬约束与选择：

| 约束（已核实） | 影响 |
| --- | --- |
| `server/cmd/server/main.go:265-279` 的 `http.Server` 设了 **`WriteTimeout: 5 * time.Minute`** | 任何长连接 5 分钟必断。**必须按 flush 续写截止时间**——项目里已有同款修复（提交 `e64b76d795`，SSE 出口按 flush 续写写截止，活跃流不再被 5 分钟掐断），本项目沿用同一手法 |
| Caddy 侧三个 Caddyfile 都是最朴素的 `reverse_proxy`，**没有任何 timeout / flush 配置** | Caddy v2 原生支持 Upgrade 与流式即时 flush，默认可用；若现场观察到缓冲再加 `flush_interval -1`，不是前置条件 |
| gin 路由无法完成 WS 升级（需要 `Hijack()` 或独立 `http.Server` 的 `upgrade` 监听） | **v1 不引入 WS**：服务端→客户端单向用 SSE，客户端→服务端用普通 POST。需要双向时再评估"独立监听端口 + Caddy 站点段"或复用上游 Remote stream 协议形态（**不要**在客户端另起一套裸 WS + 自定义协议，那会丢掉游标/重连/多路复用/准入围栏） |

**v1 形态**：

- 控制面：`GET /api/client/v2/projects/stream`（SSE）。事件体 `{project_id, seq, kind, payload}`；`id:` 写 seq，服务端读 `Last-Event-ID` 决定补播起点；**明确补播窗口**（窗口内补增量，超窗口回落"全量快照"帧）。参考 Kubernetes `resourceVersion` + `410 Gone` 的语义：太旧就报错让客户端重新 LIST，**不要硬接**。
- 心跳 15–30s（`retry:` 与 `: ping` 形态照抄本仓既有 SSE 先例），**间隔必须小于中间反代的读超时**（nginx 默认 `proxy_read_timeout` 60s），且反代要 `proxy_buffering off`（Caddy 默认即流式，nginx 需显式配）；断开即广播 `presence.offline`。
- **SSE 的 resume 是规范内建的**（`Last-Event-ID` 自动重连 + 自动带头）；WebSocket 则必须自造——RFC 6455 全文没有 resume 概念。这是 v1 选 SSE 的又一条硬理由。
- presence **不落库**：连接表在内存（`map[projectID]map[userID]map[deviceID]*conn`）。
- 中继下行复用这条 SSE，但**只发通知**（"有新的 blob/tree/会话增量"），真实数据走专用 POST/GET 分片接口——避免 SSE 头膨胀与 head-of-line 阻塞。
- 背压：每个订阅者**一个按 UTF-8 字节计费的有界队列**，超限**显式断开**（照抄上游 `TerminalFollower`：不阻塞写者、不无限缓冲、不静默丢帧）；presence 可丢，控制面事件不可丢。

**风险提示（上游实测）**：上游 `session-controller` 的 `follow()` 内部事件缓冲是**无上限 `Deque`**（`history.ts:123-130`），本仓对**终端**用了有界队列、对**会话**没有。共享项目若直接包一层 `follow()` 给远端订阅者，**慢订阅者会撑爆会话所有者进程的内存**——外层必须有界队列，这条要写成判据。

### 5.6 新增 `internal/projects` 的最小改动清单（逐条已核实位置）

1. `server/internal/projects/handlers.go` —— handler 集合（范式见 `server/internal/serverauth/handlers.go:34-71`）。
2. 迁移 `server/internal/serverstore/migrations-pg/0077_projects.sql`（`IF NOT EXISTS` + `DO $$` 自检，与既有迁移同风格）**+ 同步 `server/AGENTS.md` 里的迁移区间行**（`scripts/check-migration-range.mjs:111` 硬判，最新是 `0076`）。
3. `server/internal/router/router.go`：`Deps` 加字段 → 客户端面 ③ 子 Group（`cli.Group("/projects", serverauth.BearerAuth(d.DB))`）→ 管理面 ④ `AdminRoute`。
4. 同提交必须改齐的装配/测试：`cmd/server/main.go`、`cmd/server/main_test.go`，以及四处测试建树（`router_test.go`／`parity_test.go`／`gateway_guard_test.go`／`skillseed_route_test.go`）——漏一处会出现"生产 404 但测试绿"或反之。
5. 权限点四处：`serverauth/rbac.go` + `server/webadmin/src/lib/rbac.ts` + `lib/nav.ts` + `lib/nav.test.ts`。
6. 审计动作标签：`server/webadmin/src/pages/Audit.tsx` 的 `ACTION_LABEL`（与 Go 源码双向对拍，不加即红）。
7. 若新增**非 JSON 响应**端点（SSE）：必须登记 `api_sweep_test.go` 的 `sweepAuthGatedNonJSONSurfaces`，否则门禁红。

### 5.7 实时通道的鉴权细节（已踩过的坑）

- **浏览器 WebSocket 不能带自定义头** ⇒ WS 路径只能用**一次性 ticket**（查询参数或子协议）鉴权；SSE/POST 走 `BearerAuth` 没有这个问题。这是 v1 选 SSE + POST 的又一理由。
- **本地 exact 路由不会被 `/api` 前缀门覆盖** ⇒ 新插件的每条 exact 路由必须**自己挂持有性证明**（复用共享模块 `packages/host/cron/src/write-proof.ts:60-79`，**不要**再抄一份 `auth-gate` 的内联实现）。

### 5.4 员工目录（加人）

现状：员工面**没有任何用户列表接口**（`registerClientV2` 已逐条核对）。加人需要新增：

- `GET /api/client/v2/users/lookup?q=<前缀>`：返回 `{username, display_name, dept}`（**不返回**邮箱/手机号/角色/配额），限流与审计同 `auth` 面口径；可见范围按策略（全组织 / 同部门子树，复用 `internal/serverstore/effective.go` 的部门祖先链口径）。
- 备选：邀请码/链接（不引入目录查询，但需要用户线下沟通），或"管理员代加"（最保守）。

### 5.5 P2P 身份的落法（**照 `appproof` 的形状重写，不直接复用**）

本仓已有现成模板：`server/internal/wasmapp/appproof`（WASM 应用持有性证明）——Ed25519 签名、线格式 `v1.<kid>.<payload>.<sig>`、`DefaultTTL = 15min`、一次性 nonce + `jti` 有界 LRU 防重放、密钥环落 `<dataDir>/app-proof.key` 且 `Rotate` 保留历史密钥至 TTL、安装注册表 TOFU。P2P peer ticket 逐条换成：`App → project_id`、`BH → 会话/成员标识`，其余（Ed25519 + KID 轮换 + TTL + jti + 持久化密钥环）照搬。

落地步骤：

1. 客户端首次使用项目功能时生成**设备密钥对**（X25519，用于密钥封装；另生成 Ed25519 用于 peer 身份或直接复用），公钥注册到 `peer_devices`（私钥进系统安全存储 `safeStorage`）。
2. 客户端 `POST /api/client/v2/projects/:id/peer-ticket` → 服务端签发**短期**票据（含 `project_id`、`user_id`、`device_id`、`pubkey fingerprint`、`exp`、`jti`）。
3. **直连时由对端离线验签**；**中继时由服务端验签**——两种模式共用同一份 `Claims` 校验顺序（先验签，再按"缺什么报什么"判 `exp` / `jti` / 绑定关系），与 `Service.Verify` 同构。
4. 服务端在中继路径上只做**授权转发**（发送方与接收方都在同一项目且 `state='active'`）+ 审计记录（谁在何时订阅/转发了什么项目的数据），**不解析内容**。
5. **不要**拿 `serverstore.CreateToken` 发 ticket：那是长期 bearer 表（90 天语义、`name` 默认 `'desktop'`、**无 project/app 归因列**），发 60 秒票据会污染令牌表与 `idx_tokens_expires` 清理语义。
6. **照形状重写时必须处理的六处缺口**（`appproof` 现状，逐条已核实）：绑定位写死为 `(user, bearerHash, app_id)`（`service.go:229-247`）、强制要求安装签名（`:95-102`）、接口依赖 `*http.Request`（不好在纯 P2P 层复用）、`ReplayGuard` **是进程内存**（多实例部署下不共享）、签名密钥是**本机部署密钥**、**没有「票据 ↔ 连接」消费表**。⇒ 项目票据要么接受同样限制（单实例、票据一次性由中转侧记录），要么把 `ReplayGuard` 落 PG。

---

## 6. 客户端插件设计

### 6.1 包划分与新增包登记（**9 处**）

| 包 | 面 | 职责 |
| --- | --- | --- |
| `packages/host/projects`（新） | host | 控制面客户端（SSE 重连/补齐/游标）、会话观察与复制、镜像会话物化、文件同步引擎、驾驶位状态机、P2P 传输管理（直连 + 中继降级）、本地 `/api/pico/projects/*` 路由 |
| `packages/client/projects`（新） | client | "项目"面板：项目列表/成员/在线状态/同事会话实时视图/文件同步状态/驾驶位操作/冲突提示；侧边栏入口 |

装配与登记（**新增一个包要动 9 处**，漏一处分别对应一种"本地绿、CI/打包红"）：

| # | 位置 | 加什么 |
| --- | --- | --- |
| 1 | `scripts/check-workspaces.mjs` | `PACKAGES`（:102）／`PATH_OWNERS`（:182）／`DEPENDENTS`（:201）**三张表各一条** |
| 2 | `packages/host/desktop/scripts/prebuild-workspace-deps.ts` | `WORKSPACE_PACKAGES`（:61），**按拓扑序**（顺序错 = 本地有 `lib/` 所以绿、CI 干净检出必红） |
| 3 | `scripts/verify-layout.mjs` | `packageNameTable`（:53）目录→包名严格对拍 |
| 4 | `.github/workflows/ci.yml` | `workspace-build.tgz` 归档清单（:150）加 `<新包>/lib` |
| 5 | `packages/host/desktop/scripts/verify-packaged-runtime.ts` | `REQUIRED_PACKAGED_RUNTIME_ENTRIES`（:44）／`REQUIRED_UNPACKED_RUNTIME_ENTRIES`（:217）／`REQUIRED_PROFILE_PATCH_ANCHORS`（:934）**三张表** |
| 6 | `packages/host/desktop/package.json` | `dependencies` 加 `"@picoaide/<pkg>": "workspace:*"`（**必须进 dependencies 才随包**） |
| 7 | `.gitignore` | 逐包列 `lib/`（:50） |
| 8 | `packages/host/desktop/src/profile.ts` | 模块级 `X_PATCH_PATH` 常量（模板 :66-91）+ 循环内 `bundlePatches.push(...)`（模板 :566-579） |
| 9 | 测试断言 | `tests/profile.spec.ts`（新行必须被断言）、`tests/verify-packaged-runtime.spec.ts`（每个 `@picoaide` 依赖必须有必需条目） |

自动兜底门禁：`scripts/verify-inventories.mjs`（有 `build` 脚本但不在 prebuild 表 → fail；不在 PACKAGES → fail；三张包表互为对拍）。**但"漏登记"仍要自己记**，门禁只兜一部分。

### 6.2 宿主插件内部分层

```
projects/
  control/     服务端 API 客户端（Bearer 复用 server-connector）、SSE 连接与游标、增量对账
  session/     本地会话观察（订阅事件）→ 增量上报；远端增量 → 镜像会话写入；接管/分叉
  files/       目录扫描 + 忽略规则 + 分块 + manifest + 快照提交/应用 + 占用处置 + 冲突归档
  transport/   连接管理器：直连（WebRTC/libp2p）↔ 中继（443）；统一信封与去重/序号
  lease/       驾驶位状态机（获取/续租/释放/抢占拒绝）
  routes.ts    本地 /api/pico/projects/*（同源 + 写面持有性证明）
```

### 6.3 与上游的接缝（全部都用上游既有面，不自己造）

1. **会话观察**：宿主侧用 **`ctx.get('sessionController').follow(request, signal)`**（`AsyncIterable<SessionFollowFrame>`：`snapshot` → 逐条事件 → 可选 `assistant-stream`）。它是**现成的 gap-free 增量流**，本地与 Remote-wire 共用同一份实现；宿主插件注入先例见 `packages/host/cron/src/index.ts:43`。**不要**自己 watch 会话文件（世代切换 + 批量写会让文件层语义与逻辑事件错位）。
   - ⚠️ 两条上游实测风险：①`follow()` 内部缓冲**无上限**，外层必须有界；②`follow()` 对"冷会话"存在 `promote()` 激活分支（`history.ts:203-211`），"只看不碰"必须避开——否则同事的观察会把会话叫醒。
   - 轻量钩子（状态机派生）可用 `ctx.on('session/event', (session, event) => …)`，全局收需 `{global:true}`；回调在日志提交**之后**执行、异常被隔离。
2. **文件变更观察**：用 **`ctx.get('workspaceFiles').changes(scope, signal)`**（`WorkspaceFileWatchFrame` = `ready` + `change`，`change` 带 absolutePath；来源是上游 `fs/observed`）。同步引擎不需要引入新的文件监听依赖；按会话复用一条流、最后一个订阅者离开才关（先例 `workspace-files/src/client/change-feed.ts:118-175`）。
3. **镜像会话**：用 `ctx.sessionPersistence.create(header)` 写（`cwd` 指向镜像目录），让 workspace 服务在下一次 reconcile 时自动归组；**绝不直接读写 `workspace.json`**——`storages/*.json` 是整文件原子重写且**没有跨进程锁**，外挂写者会与宿主 last-write-wins 互相抹掉。镜像会话的本地写句柄由镜像写入器独占，且必须与本地 agent 的 resume 路径隔离（面板层禁用"继续对话"）。
4. **项目目录 = 会话工作区**：agent 的沙箱可写面只有**会话工作区 + `/tmp` + `os.tmpdir()`**（`deepseek-harness/packages/sandbox/sandbox/src/roots.ts:52-55`）。共享项目目录若在工作区之外，**agent 根本写不进去**。⇒ 项目目录必须就是该会话的工作区；由此产生的越权面（项目目录被登记为可写根）要在安全评审里过一遍。

---

## 7. 专题调研结论

> 原始笔记（带完整证据与链接）：`temp/shared-project-research/{p2p,file-sync,session-sync,integration-surface}.md`。本节只留结论与依据。

### 7.1 P2P 连通性

**选型结论（2026-09-22 复核后定稿：首选 = WebRTC + 自建 TURN；iroh 因 Node 绑定配置面太薄降为备选）**

| 方案 | 判断 | 理由 |
| --- | --- | --- |
| **WebRTC（渲染进程 `RTCPeerConnection`/`RTCDataChannel`）+ `pion/turn` v5.1.2 嵌入现有 Go 进程** | **首选** | ①企业网边缘情形更稳：Chromium 走**系统证书库**（TLS 中间人下可活），且 **TURN-over-TLS 不是 WebSocket**，"只放行网页浏览"的行为管理拦掉它的概率低；②渲染进程**零原生依赖**；③`iceTransportPolicy:'relay'` 是标准"仅中继"开关，ICE 自动降级（relay 候选偏好 =0，RFC 8445 §5.1.2.2）**不需要写降级逻辑**；④`pion/turn`（MIT、纯 Go）的 `AuthHandler`/`QuotaHandler`/`EventHandler`/`PermissionHandler` 可直连现有 PG 与审计链，**不新增独立组件**；⑤v5 已实现 RFC 6062 TCP relay；⑥协议标准化，日后换 coturn 无感 |
| iroh（Rust/QUIC + 自建 relay） | 备选（有前置条件） | relay 是 **HTTPS→WebSocket on 443、两层都是出站**，对"只出 443"结构性最优，可挂现有 Caddy 后面（没有 TURN 抢 443 的问题）；QUIC 数据面绕开 SCTP 全部限制；EndpointId=Ed25519 身份接缝最干净；自建 relay 的 `access.shared_token` 直接认 `Authorization: Bearer`。**但官方 Node 绑定 `@number0/iroh` 1.1.0 配置面太薄**（源码级实测：`EndpointBuilder` 仅 7 个方法，**无 HTTP 代理、无系统 CA、无法禁 UPnP、无 `clear_ip_transports()`** ⇒ 做不到"仅中继/不泄露 IP"；`iroh-blobs` 明确 out of scope）⇒ 采用前三选一：接受缺失 / 给 iroh-ffi 提 PR / 用 Rust 写薄 sidecar（约 1–2 人月）。另：该 npm 包 `main`/`types` 指向不存在的 `iroh-js/index.js`（可加载但打 `DEP0128`，**TypeScript 类型解析失败**） |
| WebRTC + `werift`（主进程，纯 TS） | 备选 B | 零原生模块 ⇒ 绕开 asarUnpack / electron-rebuild / **嵌套签名与公证**的全部坑。长稳性/性能/与 Chromium 互操作**未查实**，需先 PoC |
| js-libp2p | 不推荐 | `@libp2p/webrtc` 硬依赖 `node-datachannel` 且拉进 `react-native-webrtc`；更致命的是 **Circuit Relay v2 默认是控制面不是数据面：2 分钟 / 128 KiB 每方向**，跑不动文件同步 |
| Tailscale / headscale | 不推荐 | **控制面闭源**；macOS 交付面是要签名的系统扩展；嵌入只有 Go 的 `tsnet` |
| 自研 QUIC/UDP 打洞 | 不推荐 | Node 侧**无生产级 QUIC**（`node:quic` 自 v23.8.0 起 Stability 1.0 Early development 且需 flag，v22 完全没有；不存在 `@nodejs/quic`） |

**三条硬约束**：

1. **中继必须能在 TCP 443 工作，而 `turns:` 与现有 Caddy 抢 443**——需要第二公网 IP / 另一台机器 / `caddy-l4`（**未查实，需做实验**）。备选的 iroh 路径没这个问题（它是 WS on 443），但换来"WS 升级被拦就完全不通"。
2. **直连需要 UDP 到任意目的端口**；只放行"UDP 443"或某个端口段**必然无效**（源端口由本机 OS 临时端口决定、目的端口由对端 OS 决定）；UDP 空闲超时需 ≥30s。
3. **与本产品既有网络策略叠加后，"只有认证代理能出公网"的客户 P2P 三面同时死**：客户端已强制 `--no-proxy-server` + 剥代理环境变量（`network-policy.ts`），而 **Chromium 结构上不能代理 UDP**（Blink `port_allocator.h` 原文：*effectively disables all UDP traffic until UDP-supporting proxy RETURN is available*）⇒ UDP 不可代理、TCP ICE 需直连 TURN、信令也被 no-proxy 掐死。⇒ **服务端 HTTPS 数据面兜底是必需品，不是优化。**

**关键数字（决定容量规划与"中继要预留多少"）**

| 项 | 实测值 | 用途 |
| --- | --- | --- |
| **需要中继的比例** | appear.in **1000 万次** Chrome 通话实测 **17.7%**（TURN/UDP 12.1% + TURN/TCP 5% + **TURN/TLS <0.5%**），ICE 失败率 **0.5%**；Tailscale >90% 直连、iroh 9/10（均无方法学） | **按 10–20% 规划，企业人群按 20–40%**；中继带宽必须算进服务端容量 |
| 打洞条件成功率 | DCUtR 生产测量 **70%±7.1%**（440 万次 / 8.5 万网络），但 **29% 数据点因 relay reservation 或 Identify 前置失败被排除 ⇒ 端到端更低**；ProbeLab 2026：端口受限锥形 82.9%、对称 39.7%、**约 36% 节点拿不到 relay reservation** | 不要假设"大多数能直连" |
| 封锁面 | RFC 9308 §2「**3%–5% 的网络完全封 UDP**」；NDSS 2017「**5%–10% 的连接被 TLS 中间人**」 | 企业专项比例**未查实**，只能按更坏准备 |
| DataChannel 上限 | Chrome `maxMessageSize=262144`、Firefox 初始 65536、**SDP 未声明时默认 64K**（RFC 8841 §6.1）；pion 未声明时退化为 65535 | **必须自己按 ≤16–64 KiB 分片 + 自己做 `bufferedAmount` 背压** |

**两个可抄的设计要点**：①**中继优先、再透明升级**（Tailscale 原文：*all connections start out with DERP preselected… after a few seconds… transparently upgrades*；IMC '25 实测 WhatsApp/Messenger/Meet 都是约 30s 后从中继升到 P2P）——比 ICE 的"探测优先"首屏体验好得多，建议直接采用；②**两端落到同一台 TURN 时，中继流量在服务器内部闭环**（A→TURN 走 TLS/443，TURN→B 的 UDP 段在服务器本机）⇒ 客户端防火墙不参与，"只出 443"因此可行；但 **WebRTC API 触达不到 RFC 6062 TCP allocation**（RFC 8656 §3.1 原文 "*This specification describes only UDP allocations*"），所以 relay↔非 TURN 对端那条路仍要出站 UDP。

**可复用性结论**：`pion/turn` **进程可复用，端口/入口不可复用**（当前 compose 只有 `expose: 8080`）。

**信令**：复用 §5.3 的那条 SSE + POST 通道即可（信令是小消息、低频），不需要为 P2P 另建一套；ICE/打洞的握手轮次由库内部处理。

**身份与授权**：见 §5.5。**`a=fingerprint` 不绑人**（RFC 8844；CVE-2026-14935 是"缺 `a=fingerprint` 校验被 MITM"的实证）⇒ ticket 必须绑**传输层公钥**，并在握手后做**实测公钥恒等比较**；直连默认交换 IP（RFC 8827 §6.4）⇒ "仅中继"与"禁用 P2P"必须是**协议的一部分**，不能只是客户端开关（对端是恶意/被攻破版本时开关无效）。

**Electron 集成：三个安全默认值必须在 v1 就改对（事后改是破坏性变更）**

1. **IP 隐私**：**Electron 默认对所有权限返回 true，使 mDNS 混淆实际失效，真实内网 IP 会直接进 ICE 候选**。本仓已装权限处理器（除剪贴板外全拒），但**实际拿到的是真实内网 IP 还是 `.local` 必须真机抓 SDP 确认**。修法：`webContents.setWebRTCIPHandlingPolicy('default_public_interface_only')` 或 `'disable_non_proxied_udp'`，并叠加 `iceTransportPolicy:'relay'`。注意 **`--force-webrtc-ip-handling-policy` 不在 Electron 文档的命令行开关列表里**（是否生效未查实）⇒ **用 WebContents API，不要用命令行开关**。
2. **渲染进程 vs 主进程**：主进程没有原生 WebRTC ⇒ 要么渲染进程开连接（数据面要处理 `backgroundThrottling`，把数据搬回主进程），要么用原生模块（mac 嵌套签名与公证风险）。
3. **`backgroundThrottling:false` 是否覆盖 Chromium 的 intensive throttling / Worker 节流未查实**；`WebContentsView` 上还有 electron#52865 的**隐藏后空白** bug。

**原生模块与打包**（若最终用 `node-datachannel`/iroh）：本仓已是 `asar.smartUnpack:false` + 显式 `asarUnpack` glob 覆盖 `**/*.node`/`**/*.dylib`/`**/*.dll`/`**/*.so*` ⇒ **不需要新增 asarUnpack 规则**；但因关闭了 smartUnpack **没有兜底**，需确认平台包内**没有无扩展名的辅助二进制**，并同步 `verify-packaged-runtime.ts` 的必需条目表。**mac 上原生模块的嵌套签名+公证必须先跑通 `dist:mac` + notarize 才算数**（本仓有 LibreOffice 嵌套签名失败导致功能 disable 的先例）。

**必须同时做的三件"退路"**（无论选哪条路）：①**服务端 HTTPS 数据面中继**（纯 POST/SSE，任何网络都能用，只是慢）；②**"仅中继"模式**（不暴露 IP，企业合规）；③**管理员一键禁用 P2P**。

**开工前置 PoC（P2P 这条线的第一个任务）**：

1. **真机抓 SDP**：确认本产品实际拿到的 ICE 候选是真实内网 IP 还是 `.local`，以及 `setWebRTCIPHandlingPolicy` 是否生效（判据：候选里的 IP 变化）。
2. **Caddy 443 与 TURN-over-TLS 共存实验**（`caddy-l4` / 第二公网 IP / 另一台机器）。
3. **`pion/turn` 嵌入现有 Go 进程的吞吐自测**（无公开 benchmark；复用 `temp/perf-2000` 方法论）。
4. **渲染进程数据面长稳**：`backgroundThrottling:false` 下隐藏窗口的吞吐，以及 `WebContentsView` 隐藏态行为。

**落地最可能的三个坑（调研结论，务必前置处理）**：

1. **网络面（不是代码）才是主要工作量与失败源**：直连需要 **UDP 到任意目的端口**（白名单端口段无效——源端口由本机 OS 定、目的端口由对端 OS 定），TURN 需要额外宿主机端口段 + **公网可达 IP**，`turns:443` 与 Caddy 冲突，再加云安全组与客户防火墙。⇒ **部署文档必须给出防火墙规则清单**（客户 IT 一定会问的第一个问题），并把网络前置条件做成**部署前 preflight 自检**：**WS 升级是否放行、`turns:443` 是否可达、TLS 检查设备是否打断 relay 连接**——三件事都要在客户真实网络上验。
2. **"只有认证代理能出公网"的客户必须走服务端 HTTPS 数据面**（硬约束 3）：P2P 与它的中继会同时不可用；WS 升级被拦还会让 iroh 类备选"完全不通"。
3. **安全/隐私三件事必须在 v1 定死**：身份绑传输层公钥（不是 `a=fingerprint`）、IP 隐私用 WebContents API 而不是命令行开关、**向 `239.255.255.250:1900` 的 UPnP 组播是常见 IDS 特征**（iroh 默认开启且 Node 绑定关不掉——这也是它降为备选的原因之一）。

### 7.2 文件同步与"被占用"

**结论一：不要做双向同步（业界无反例）。** 多人协作开发产品全部选择"一份权威副本 + 远端执行"，原因是结构性的：agent 的写入是批量语义操作，双向块同步必然产生大量无意义冲突，而冲突的粒度是"半成品代码被合并 / 构建失败 / git 仓库损坏"，不是一行文本。

**结论二：占用与冲突必须分开治理。**

| 现象 | 本质 | 处置位置 |
| --- | --- | --- |
| 目标文件被本机进程独占（Windows 强制锁） | 时序 | §4.6.1 的重试/退避/延迟队列 |
| 目标正在被同事的 agent 改 | 跨机器语义 | §4.6.2 应用层租约（**OS 锁跨机器不存在**） |
| 两边内容都变了 | 语义 | §4.6.3 冲突归档 |
| `.git/index.lock`、Office `~$` 文件、包管理器缓存锁 | 应用事务 | §4.6.1 末段：暂停该目录/该文件 |
| 磁盘满、路径过长、只读 | 资源/结构 | 暂停或跳过 + **上报**，不重试 |

**结论三：把失败面压到一个点。** 所有落盘走"旁路临时文件（同卷）→ 原子就位"，于是只有 rename/replace 会失败；平台各自的正确调用序列见 §4.6.1。**ReplaceFile 保 ACL/创建时间但突破不了独占锁；MoveFileEx 能兜一部分失败但要牺牲 ACL**——两个都要有，按平台分支。

**结论四：栅栏令牌是防数据损坏的唯一手段。** 租约/锁本身不足以防旧持有者写入（GC 停顿、`SIGSTOP`、网络延迟都会让"客户端以为自己还持锁"），必须让**接收端**记住 `max(token)` 并拒绝更小的令牌。Kleppmann 原文与 GitHub 约 90 秒网络延迟事故都证明这是常态而非异常。

**结论五：先做可见性。** "谁正在改什么"的只读提示成本极低、收益极高，应在互斥之前落地。

**结论六：上游 `dsh-fs` 就是那条接缝。** 抽象文件系统（官方文档："mount a backend"）+ 内建乐观并发令牌 `FsVersion` / 错误码 `FS_STALE_VERSION` ⇒ "只读远端视图"可以做成一个 fs backend，**不动工具与策略层**；租约的强制点可挂在 hooks 子系统（能在工具调用上 block）。

**结论七：只能承诺"冲突可检测"，不能承诺"不会被同时改"。** agent 的 `bash` 路径由子进程直写裸文件系统（`npm install`/`codemod`），执行过程中无法逐文件拦截；因此**整项目锁是主锁**，文件级租约只提供可见性与工具写路径的互斥（§4.6.7）。

**结论八：Windows 上有一个本产品特有的 P0 组合风险**——工作区目录的动态可继承 ACE（幂等短路）× Windows"同卷跨目录移动保留原权限" ⇒ 从工作区外搬入的文件会缺 ACE，沙箱内的 agent 写不了它。四条设计规则见 §4.6.6，**必须真机验证**（`icacls` 前后对比）。

**结论九：实现路线有唯一正确解——挂 `ctx.fs` 远程后端，不能挂 OS 层虚拟盘。** 上游 discussion #3919 已在 Google Drive 虚拟盘上实测出真实故障码（`write` → `EISDIR`、`edit`/`pwsh` → Win32 87），而 `dsh-fs` 官方保证换后端对工具/策略/schema 透明。⇒ 这同时排除了"用云盘/网盘目录当项目目录"的所有取巧方案；**绑定时还要检测项目目录是否落在已知的按需同步挂载点上并警告**。

**结论十：批量操作与自激是同步引擎的两个"看不见的坑"**——`git clean -fdx`/`git stash` 的整片删除必须被安全阀拦住（否则删除会被传播出去），同步器自己的回写必须被标记（否则两端互刷），watcher 溢出必须能检测并触发全量对账（四平台都会丢事件）。见 §4.6.8。

**（路线 B 若日后要做）最小版本向量与 LWW 边界**：`{path, version:{deviceId:counter}, contentHash, size, mtimeMs, deleted, modifiedBy}`；并发判定（互有增量）**之后必须再比内容**（两端跑同一个 formatter 是常见情形，不比内容会造出海量假冲突）；**删除必须留墓碑**；需提供已退役设备的向量压缩。**纯 LWW 不可接受**（六类损失：静默丢数据、依赖墙上时钟、删除vs修改二选一必错、重命名+编辑无法表达、批量重构因果断裂、目录级更糟），可接受的是"**冲突副本之上的 LWW**"，冲突副本每文件保留 **5 份**（Syncthing 默认无限是错的默认）。三方合并的 base 三档：只存哈希（MVP）/ 存内容快照 / **借 git 当 base（性价比最高）**。

**与既有产品事实的交叉验证**：团队既然已经在用 git，最自然的组合是"**驾驶位快照同步（实时）+ git 中心仓（资产归档）**"两条并行——快照负责"实时看到"，git 负责"历史与合并"，互不替代。

### 7.3 会话实时同步

**结论一：上游已有成品，不要重造**（详见 §4.4 的对照表）：`session/follow`（快照 + 严格 seq 增量 + 可选流式旁路）与终端面的 `BrowserTerminal.follow()`（单写者 + 多观察者 + 接管后旧者只读）。

**结论二：S2 为默认，S3 明确不做**，需要并行改动时**分叉而非合并**（上游 `parentSession` 字段已留好位置）。

**结论三：三档粒度决定可补播性**：

| 粒度 | 载体 | 持久化 | 跨机可得 |
| --- | --- | --- | --- |
| 状态机（idle/thinking/streaming/executing-tool/waiting-approval/waiting-user/error） | 日志事件派生 | 是 | **可补播** |
| 工具调用时间线 | `tools/pre-execute → execute → post-execute → result`、`approval/{asked,decided}` | 是 | **可补播** |
| AI 流式 token | `agent/assistant-stream`（`process-local`） | **否** | **只能重取基线，不可补播** |

**结论四：seq 是唯一权威，缺口即致命**——落后就丢（去重），跳过就**断开重取快照**，绝不静默续接（上游实现逐字：`session event stream skipped seq N` ⇒ throw）。

**结论五：慢消费者用有界队列 + 显式断开**（照抄 `TerminalFollower`：按 UTF-8 字节计费、超限报 `exceeded its buffer; reconnect to recover`）；**上游对会话没有做这件事**，我们必须在网桥层补。

**结论六：隐私按档裁剪，且裁剪必须发生在会话所有者本机**（§4.8.1），客户端隐藏不算权限控制。

**结论七：观察者不得"叫醒"被观察会话**（`promote()` 分支），这是可复现事故而非理论风险。

---

## 8. 分期与工作量

### 8.1 分期

| 期 | 内容 | 交付判据（可验证） | 人日 |
| --- | --- | --- | --- |
| **P0 地基** | 不变量判据、服务端 `internal/projects` 骨架 + 迁移 + 路由 + 审计、设备密钥与 peer ticket、SSE 通道 | 两条客户端能连上同一条 SSE 并收到同一批事件；栅栏令牌拒绝过期驾驶位 | 12–16 |
| **P1 项目与成员** | 创建/改名/删除、成员增删、管理员转移、员工目录接口、客户端项目面板、删除传播（墓碑 + 归档） | 成员 B 在 A 删除后（含离线再上线）看到项目消失且本地进入归档；管理员转移后双方权限即时生效 | 15–20 |
| **P2 会话实时跟随（S2）** | 会话登记、增量上报（复用 `sessionController.follow()`）、镜像物化、断线补齐（自建 `asOfSeq` 窗口）、presence、只读跟随 UI、接管/移交 | 成员 B 能实时看到 A 的流式输出与工具调用；B 断网 5 分钟再上线能补齐（无缺口应用）；接管后 A 变观察者且世代号使 A 的后续写入被拒 | 18–24 |
| **P3 文件层（可转移单写者 + 只读副本，路线 A′）** | 变更观察（复用 `workspaceFiles.changes()`）、忽略规则、分块、manifest、写者→跟随者的单向应用、**占用处置（§4.6.1）**、**Windows ACE 复核（§4.6.6）**、冲突归档、配额 | A 改 200 个文件后 B 在秒级看到一致目录；B 的本地改动进 `conflicts/`；Windows 上目标文件被独占句柄锁住时同步不失败、面板显示 pending、解锁后自动完成；`icacls` 前后 ACE 不丢 | 18–24 |
| **P4 P2P 直连 + 降级** | **先做 PoC**（真机抓 SDP 确认候选 IP 与 `setWebRTCIPHandlingPolicy` 生效；Caddy 443 与 TURN-over-TLS 共存；`pion/turn` 嵌 Go 的吞吐自测）→ 信令复用 SSE/POST → 直连（**中继优先再透明升级**）→ 自动降级 → 分片与背压（DataChannel ≤16–64 KiB）→ 带宽与流量治理 | PoC 结论先行（共存方案不成立就退 iroh/werift）；同局域网直连成功且不经服务端；模拟直连失败时自动降级且用户无感；"仅中继"与"禁用 P2P"两个开关可用 | 15–25（PoC 3–5，含在区间内） |
| **P5 治理与运营** | webadmin 项目页（容量/删除）、策略（是否允许 P2P、内容分享档 L1/L2/L3）、密钥轮换与成员移除、配额运营、审计动作补齐 | 管理端可见容量并可兜底删除；成员移除后旧票据立即失效且密钥轮换生效；L3 需显式授权且留审计 | 10–15 |

合计 **88–124 人日**（不含运维部署改造）。可裁剪的 v1 = P0–P3 + P4 的"中继"部分（P4 约 8–12 人日）≈ **71–96 人日**。

> 估算依据：会话流送与文件监听两块**复用上游成品**（`follow()` / `workspaceFiles.changes()`），省掉的是"设计一个增量协议"的工作，但**没有**省掉"有界队列、补播窗口、镜像物化、接管防僵尸"这些我们自己必须补的部分（见 §7 的风险项）。P4 的不确定性最大——本仓零 P2P 地基。

### 8.2 里程碑建议

M1（P0+P1）= 可演示的"共享项目"骨架；
M2（P2）= 用户最在意的"看见同事的实时输出"；
M3（P3）= "文件同步"；
M4（P4）= P2P 加速。

### 8.3 验收口径（避免"看起来能跑"）

- **实时**：同城网络下，同事会话事件端到端可见延迟 P95 < 1s；文件快照提交到跟随端可见 P95 < 3s。
- **补齐**：断网 5 分钟后重连，镜像会话与快照最终一致（按 seq/version 逐条断言，不允许"跳号应用"）。
- **删除**：删除后 3 条传播路径各写一条用例（在线/离线重连/长期离线墓碑）。
- **占用**：Windows 上人为用独占句柄锁住目标文件，断言同步不失败、面板显示 pending、解锁后自动完成。
- **不变量**：I1/I2/I3 各有变异验证（拆掉判据必须变红）。

### 8.4 必须同时落地的判据（否则故障是静默的）

1. 会话单写者：镜像写入路径不得获取原会话写锁的"所有权"；同一会话两处可写必须有用例变红。
2. 快照陈旧提交：用旧版本 + 旧栅栏令牌提交必须被拒（服务端拒绝 + 客户端提示"先同步"）。
3. 缺口不应用：人为丢一条增量，跟随端不得继续应用并必须进入"等待补齐"。
4. 墓碑对账：客户端本地绑定表存在但服务端返回墓碑时，必须进入删除流程（不允许静默保留）。

---

## 9. 待拍板问题（按影响面排序）

**Q1（会话语义与接管）**：接管（S2）是否 v1 就做？接管是否需要所有者**在线同意**？
- 推荐：**v1 就做 S2**——上游终端面已有成品语义（`BrowserTerminal.follow()`：`Attach with exclusive input control; an older attachment becomes read-only.`），平移成本低于重新设计；S1 作为它的退化形态天然可得。
- 同意模式推荐**直接接管 + 强审计 + 显著提示**（与上游终端一致，体验顺滑）；"请求—同意"式需要所有者在线，可作为组织策略开关。

**Q2（"实时输出"到哪一档）**：同事默认能看到 AI 正文吗？
- 推荐：默认 **L1（状态 + 工具时间线 + 计数）**，L2（工具名/摘要）同项目可见，L3（正文/流式 token）需显式授权。理由：L2 已能回答"他是不是卡住了"，而 L3 会把代码、可能的密钥、客户数据推到别人屏幕上。
- 若业务上就是要"结对看输出"，则 L3 默认开、但必须配内容加密与明确提示。

**Q3（文件语义，阻塞项）**：非写者（被拉进来的同事）**能不能改文件**？"看到"是否包含"改"？同事本机的 agent 能不能直接改这些文件？
- 只读 ⇒ 路线 A′ 成立，**冲突问题彻底消失**，工作量最小；代价是同事的 agent 只能读/分析/生成 patch。
- 可写 ⇒ 必须引入租约 + fencing + 冲突处置，或直接上路线 B（**量级从"几周"变"几个月"**）。
- **这一条决定整个方案量级**，所以它是阻塞项。

**Q4（内容加密）**：项目内容（会话正文 + 文件内容）默认端到端加密（服务端看不到内容），还是服务端明文存储（可审计/可搜索）？
- 推荐：默认端到端加密，与既有"会话正文不出境"立场一致；若企业要求内容可见，再做组织级开关（代价：密钥托管）。

**Q5（删除语义）**：删除项目时，成员本地的项目目录是**归档保留**（推荐，默认 7 天）还是**立即硬删**？成员自己的会话是否保留（推荐保留）？墓碑保留多久（建议 ≥90 天）？

**Q6（P2P 与合规）**：允许成员之间 P2P 直连（会互相暴露 IP）吗？还是默认全走服务端中继、P2P 需显式开启？
- 推荐：默认允许直连但**授权与审计锚定服务端**（票 + 订阅记录）；合规敏感的组织可一键关成"仅中继"。

**Q7（加人范围）**：新增员工目录接口后，谁可以被拉进项目？全组织可搜 / 仅同部门 / 仅管理员代加？（涉及员工隐私与目录枚举面）

**Q8（部署与网络）**：部署侧能接受哪些网络改动？
- 最小集（推荐默认）：**零新增端口** —— 中继固定走 443 应用层（HTTPS POST/SSE），P2P 只在"双方网络天然允许"时生效（同内网/家庭宽带有 UPnP 等）。
- 增强集：**`pion/turn` 嵌进现有 Go 进程**（需 UDP + relay 端口段 + 公网 IP；"只出 443"的网络还要解决 TURN-over-TLS 与 Caddy 抢 443）或自建 **iroh-relay**（容器，TCP 443 + 证书，但 iroh 的 Node 绑定配置面目前太薄，见 §7.1）。
- 另需拍板：**是否允许成员间直连（会互相暴露 IP）**；企业 IT 是否要求"完全禁用 P2P"（§7.1 退路③）。

**Q9（服务端托管）**：是否需要"项目在服务端常驻（即使没人开机也同步/跑任务）"？如果需要，另立项（等于服务端跑 agent）。

**Q11（共享项目必须是 git 仓库吗）**：是 ⇒ 路线 C（服务端 bare 仓）几乎免费，且三方合并的 base 直接从 git 拿；否 ⇒ 全走我们的对象仓。**建议先问清**，因为它同时影响存储与冲突策略。

**Q12（Windows ACE 复核的成本能否接受）**：为绕开 §4.6.6 的 P0，同步器写入工作区后要跑一次 ACE 复核（或主动 grant）。这在大目录上是可感知的开销，需要你决定是"每次都复核"还是"仅对新出现的文件复核"。

**Q13（部署与合规）**：网桥是否与 LLM 网关同机（当前实测单实例安全上限 ≈1500 并发，且长连接模型不同）；是否需要"同步内容不落服务端磁盘"的**纯中转承诺**（若需要，离线补齐能力要相应降级）。
**Q10（验收数字与规模上限，建议值需确认）**：
- **"实时"的可测数字**：建议 **会话事件 P95 < 1s、文件快照 P95 < 3s**（对照：Syncthing 默认去抖 10s；git 自动同步是分钟级）。若要求 <1s，基本只能走"写者本机推送订阅"这一形态。
- **项目规模**：建议单项目 **5 万文件软 / 20 万硬**、单文件 **50MB 软 / 200MB 硬**；`node_modules`/构建产物**排除不是可选项**。
- **离线要求**：非写者成员是否需要**离线仍能工作**？——**需要** ⇒ 必须给每人完整副本（路线 B，接受冲突，量级最大）；**不需要** ⇒ 路线 A′ 足够。

---

## 10. 风险登记册

> 前 8 条是本次代码勘察**实测得到**的风险（不是你想象出来的理论风险），实现时必须逐条有对策与判据。

| # | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | **观察者 follow 会把冷会话"叫醒"**（`session-controller/src/history.ts:203-211` 的 `promote()`，JSDoc：`starts ordinary Session activation after snapshot delivery`） | 高（可复现产品事故） | 只读观测必须走 `sessionQuery.observeSession()` 并**显式跳过 promote 分支**；写成变异判据 |
| R2 | **上游会话 `follow()` 的事件缓冲无上限**（`Deque` 无容量；上游只给**终端**做了有界队列） | 高（慢订阅者撑爆所有者进程内存） | 外层自己加**按字节计费的有界队列**，超限显式断开；判据：慢订阅者不得让所有者 RSS 增长 |
| R3 | **上游 `follow()` 没有 resume cursor 入参**（`SessionFollowRequest` 只有 `address/maxMessages?/assistantStream?`） | 中 | 语义按"重连 = 重新快照"（与终端同款）；真正的增量补播由**我们自己的网桥层**按 `asOfSeq` 过滤实现，并定义补播窗口 |
| R4 | **流式 token 是 `process-local`，不可跨机补播** | 中（UI 会出现一次跳变） | token 旁路显式 opt-in；丢帧即重取基线；UI 明确"输出可能跳变" |
| R5 | `assistant-stream` 的 `revision` 在 agent 生命周期变更时**重置为 1** | 中 | 连续性校验必须用 `(attemptId, revision, index)` 三元组，不能只比 `index` |
| R6 | **本仓零 P2P / NAT 穿透基础设施**（全仓 `webrtc|stun|ice candidate` 零命中） | 高（是新增地基而非接线） | 见 §7.1 选型（首选 WebRTC + `pion/turn`）；**先做 4 项 PoC** |
| R6b | **`turns:` 与现有 Caddy 抢 443**（中继必须能在 TCP 443 工作）；直连需 **UDP 任意目的端口** | 高 | 第二公网 IP / 另一台机器 / `caddy-l4`；T2 应用层中继（普通 HTTPS）必须先做且独立可用；部署前 preflight 三验（WS 升级、`turns:443`、TLS 检查设备） |
| R6c | P2P 与 **`--no-proxy-server` + 剥代理环境变量**叠加；**Chromium 结构上不能代理 UDP** | 高 | "只有认证代理能出公网"的客户 P2P 三面同时死 ⇒ HTTPS 数据面兜底是**必需品** |
| R6d | 引入原生模块（`node-datachannel`）⇒ **mac 嵌套签名与公证**风险（本仓有 LibreOffice 先例） | 中 | 首选 WebRTC 走**渲染进程（零原生模块）**规避；备选 `werift`（纯 TS）；若必须原生模块先跑 `dist:mac` + notarize |
| R6e | **Electron 默认使 mDNS 混淆失效，真实内网 IP 进 ICE 候选** | 高 | v1 就用 `setWebRTCIPHandlingPolicy` + `iceTransportPolicy:'relay'`（**不要用命令行开关**）；真机抓 SDP 验证 |
| R6f | **`a=fingerprint` 不绑人**：信令被攻破即可 MITM（RFC 8844；CVE-2026-14935 实证） | 高 | ticket 绑传输层公钥 + 握手后**实测公钥恒等比较**（§5.5） |
| R6g | 网络面工作量被低估（UDP 任意目的端口、TURN 端口段与公网 IP、云安全组、客户防火墙、443 冲突） | 中 | 部署文档给防火墙规则清单 + 部署前 preflight 自检 |
| R6h | 直连只覆盖一部分场景：实测 **17.7% 需中继**、DCUtR 条件成功率 70%±7.1% 且 **29% 前置失败被排除**、**3–5% 网络完全封 UDP** | 中 | **中继带宽按 10–20%（企业 20–40%）预留**，并做流量计量与超限降级 |
| R6i | 直连把成员 IP 暴露给同事（RFC 8827 §6.4：直连默认交换 IP） | 中 | "仅中继"与"禁用 P2P"必须是**协议的一部分**（不是客户端开关，对端是恶意版本时开关无效）+ 管理员一键禁用 |
| R7 | **P2P 直连会绕过服务端的授权与审计观察点** | 高（企业合规） | **授权判定与审计锚定在控制面**：直连前必须换短时效票据，服务端记录"谁何时订阅了什么"；数据面才允许直连 |
| R8 | **长连接容量模型与现有 HTTP 并发结论不同**（单实例 ≈1500 并发是短请求结论，会话流是长连接） | 中 | 单独做长连接容量评测，不套用既有数字 |
| R9 | 服务端 `WriteTimeout=5min` + Caddy 默认配置 | 中 | 按 flush 续写写截止（本仓已有同款修复先例）；WS 路径需另行处理 deadline |
| R10 | `storages/*.json` **无跨进程锁**，宿主是唯一写者 | 中（数据互相抹掉） | 同步引擎只读或经上游服务写；绝不直接写 `workspace.json` |
| R11 | 沙箱可写面 = 会话工作区 + temp | 中 | 项目目录必须是会话工作区（否则 agent 写不进去）；越权面进安全评审 |
| R11b | **Windows：从工作区外搬入的文件缺可继承 ACE** ⇒ 沙箱内 agent 写不了它（本产品特有组合风险） | **P0** | §4.6.6 四条规则（临时文件建在目标目录、优先 `ReplaceFile`、写后复核 ACE、覆盖同卷跨目录与跨卷两种矩阵）；**必须真机验证** |
| R11c | **`bash` 写路径不可拦截**（`npm install`/`codemod` 由子进程直写裸 FS） | 高 | 整项目锁为主锁；只承诺"冲突可检测"；命令前后各做一次带 fencing 的对账（§4.6.7） |
| R12 | 孤儿文档锁（`settings.yaml.lock` 之类）会让写入**永久失败且静默** | 中 | 同步引擎引入的任何新 `.lock` 都按 `document-lock-recovery.ts` 同一口径：可诊断、可回收、判据明确 |
| R13 | 同一数据根可能有多实例（渠道包可共用 home） | 中 | 不假设"这台机器只有我一个写者"；设备维度用 `device_id` 区分 |
| R14 | 会话内容出境引发合规问题 | 高 | 默认 L1 隐私档 + 内容端到端加密 + 面板明示"正在共享什么" |
| R15 | 两人同时改文件导致工作丢失 | 高 | 驾驶位 + 冲突归档；I2 判据 |
| R16 | 网盘式同步风暴（`node_modules`/构建产物） | 中 | 忽略规则 + 快照 + 配额；首同步只同步"项目真源" |
| R17 | 中继被当成免费网盘 | 中 | 流量计量 + 超限只保控制面 |
| R18 | 端到端加密下密钥丢失（换机/重装） | 中 | 设备密钥可重新封装（需管理员在场）；历史内容不可恢复要写进说明 |
| R19 | 项目删除后的"幽灵目录" | 中 | 墓碑 + 绑定对账（§4.7）+ 判据 §8.4-4 |
| R20 | 上游升级破坏镜像可行性（`SessionHeader` / workspace reconcile / `follow()` 形状变化） | 中 | 把"镜像会话可显示 + `follow()` 契约"写成升级回归项（数据断言，不是存在性断言） |
| R21 | 服务端路由必须集中声明；新模块自己 `r.Group()` 或漏进 `registerProductionRoutes` | 中 | 会"测试绿、生产 404"；按 §5.2 在 `internal/router` 声明 |
| R22 | **把项目目录挂在 OS 层虚拟盘/云盘上**（本产品实测会坏：`write` → `EISDIR`、`edit`/`pwsh` → Win32 87） | 高 | **必须挂 `ctx.fs` 远程后端**（§4.5 P0 实现约束）；这条同时排除所有"用云盘当项目目录"的取巧方案 |
| R23 | 项目目录落在第三方**按需同步**挂载点（OneDrive on-demand / Google Drive streaming） | 中 | 绑定时检测已知挂载点并警告；厂商自己承认 "won't work" |
| R24 | **批量误删被当成"用户删了项目"并传播出去**（`git clean -fdx` / `git stash`） | 高 | 三道安全阀（root deletion / root emptying / root type change）⇒ 暂停 + 人工确认（§4.6.8） |
| R25 | **自激**：杀软/备份软件访问、同步器自己的回写被当成编辑，两端互刷 | 中 | 标记自身写入（不能只靠路径前缀）+ 临时前缀进忽略规则 |
| R26 | watcher 丢事件/溢出（四平台都会；Linux `IN_Q_OVERFLOW` 后**其余事件永久丢失**） | 中 | 溢出必须可检测并触发一次**全量对账**；事件流不能当唯一真源，要有目录级 diff |
| R27 | macOS 无 `FILE_SHARE_DELETE` 等价物 ⇒ unlink 打开中的文件**静默成功** = 静默分叉 | 中 | 不只比错误码，**比 inode** |
| R28 | 照抄 `.gitignore` 当同步忽略表（语义不同：last-match vs first-match、父目录排除后不可再包含） | 中 | 忽略表是**自己的版本化制品**，并校验 `syncIgnore ⊇ 硬拒绝清单` |

---

## 11. 附录

**调研证据（原始笔记，带完整证据与链接）**

| 文件 | 内容 |
| --- | --- |
| `temp/shared-project-research/p2p.md` | P2P/穿透选型对比（含版本与活跃度实测、**iroh Node 绑定配置面的源码级实测结论**）、中继占比与打洞成功率的真实测量、TURN 落地、信令、身份与攻击面、Electron 集成约束与三个安全默认值、未查实清单 |
| `temp/shared-project-research/file-sync.md` | 文件同步路线谱系与业界反例、**"文件被占用"处置矩阵与重试参数**、落盘形态按平台、应用层租约与 fencing、agent 场景特殊性、**`ctx.fs` 远程后端 vs OS 层虚拟盘的实测故障（discussion #3919）**、Windows ACL 风险、批量/自激/watcher 溢出、版本向量与 LWW 边界、16 条未查实项 |
| `temp/shared-project-research/session-sync.md` | 上游 `session/follow` 与终端接管先例解剖、实时分发机制、S3 代价评估、隐私分档、权限与删除传播先例、8 条新风险 |
| `temp/shared-project-research/integration-surface.md` | 本仓接入面勘察（插件登记 9 处、本地路由与写面证明、会话/文件流、**同步引擎 19 条禁区**、服务端模块改动清单、ticket 模板、推送现状） |

**先例勘误（不要重复踩）**：迁移目录是 `server/internal/serverstore/migrations-pg/`；RBAC 在 `server/internal/serverauth/rbac.go`（**没有** `internal/rbac` 包）；WASM 应用原先的浏览器换票（`internal/wasmapp/session`、`/app-ticket`）**已随 W4 删除**（迁移 `0073_drop_wasm_sessions.sql`），不要再引用。

**相关既有设计**：`docs/planning/2026-09-19-wasm-client-only-design.md`（客户端专属形态与窗口/分区纪律）、`docs/decisions/2026-09-20-dsh-0.1.6-upgrade.md`（会话正文不出境的既有立场）、`packages/host/desktop/src/document-lock-recovery.ts`（孤儿锁回收的三类证据口径）。

**本方案不修改 `deepseek-harness/`（上游 submodule）**；所有客户端改动落在 `packages/host/*`、`packages/client/*`，服务端落在 `server/internal/projects`。

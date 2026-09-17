# WASM 应用平台设计（唯一基线）

- 本文件是**唯一设计基线**：平台侧的完整设计只此一份，不含历史版本、不含分期方案；实现细节以本文为准。
- 状态：**设计定稿**。R1–R42 为已拍板决策；开工前必须钉死/实测的项与已知缺口见 §11；关键数值的实测依据见 §15。
- 术语：**应用** = 员工（或其 AI）编写并上传的单个 `.wasm`；**平台** = 本仓的 Go 服务端 + 桌面客户端。
- 原则：**每个能力都有上限，每个上限都有数值，每个数值都有测试**；**平台只提供运行环境与身份，业务怎么做由应用代码决定**。

---

## 1. 一句话定义

员工（或代表员工的 AI）把一个小应用编译成**单个 `.wasm` 文件**（静态资源、HTML、JS 全部编入），上传到平台；平台在**无网络、无文件系统**的沙箱里运行它，只给它**一个本应用专属的 SQLite 数据库**（100 MB 硬限）和受控的宿主能力；任何员工通过浏览器打开 `<app_id>.<应用基域>` 使用。**应用代表使用者调用平台 AI，费用记在该使用者账上**（走平台既有请求路径，平台不为应用单独设额度，R36）。

**员工只描述"想要什么"，AI 负责写代码、本机编译（含自备开发环境）、上传、自修、发布。** 平台不提供构建服务、不分发工具链、不做本地预览——这些属于 skill 与员工 AI 的职责（R40/R42）。

---

## 2. 需求基线（已拍板，不再讨论）

| # | 决策 | 日期 |
|---|---|---|
| **R1** | **每个应用一个独立数据库**（不是每用户一个） | 2026-09-17 |
| **R2** | **每个应用数据库 100 MB 硬上限**（不可由用户配置） | 2026-09-17 |
| **R3** | 访问标识用**子域名** `<app_id>.<应用基域>`：**`app_id` 本身就是域名标签**，必须符合域名规则（见 §4.1） | 2026-09-17 |
| **R4** | 应用可用**当前登录用户**身份调 AI，费用扣该使用者 | 2026-09-17 |
| **R5** | **无人类运营后台**（日常操作走 API/由 AI 驱动）；保留**最小运维面**（R23） | 2026-09-17 |
| **R6** | **发布者即该应用的管理员**（仅管理平面） | 2026-09-17 |
| **R7** | **无合规限制**；"数据不得离开受控端点"不适用 | 2026-09-17 |
| **R8** | **静态资源/HTML/JS 编译进 WASM**（单文件交付） | 2026-09-17 |
| **R9** | 对外通讯默认全禁（应用无网络能力） | 2026-09-17 |
| **R10** | 接受窄语言面，**维持 wazero** | 2026-09-17 |
| **R11** | **员工本机编译，平台只收 wasm**（不建平台侧构建服务） | 2026-09-17 |
| **R12** | **会话走一次性换票**（主站 302 带 code → 应用子域 host-only Cookie） | 2026-09-17 |
| **R13** | **SQL 护栏 = `SQLITE_LIMIT_*`（挡病态语句）+ 每语句 5 s 的 ctx 硬超时**（实测驱动可被 `sqlite3_interrupt` 中断）| 2026-09-17 |
| **R14** | 每个点都要有护栏，防止被滥用 | 2026-09-17 |
| **R15** | **只提供 `data_scope=shared`**：应用内不做用户级隔离；skill 与作者文档必须写明 | 2026-09-17 |
| **R16** | **保留**主站员工浏览器登录页（账密 + OIDC）与员工会话表；这是 R12 换票的上游 | 2026-09-17 |
| **R17** | **默认不审核 + 事后抽检**；发布强制填写用途 / 数据敏感性 / 负责人；审核开关仍可由管理后台配置（默认关） | 2026-09-17 |
| **R18** | **失败的发布不占版本号**（失败不落 release 行 ⇒ 天然不占） | 2026-09-17 |
| **R19** | **编译在独立进程执行**，并做 **OS 级隔离**（见 R31） | 2026-09-17 |
| **R20** | **单实例部署**（票、执行队列、编译缓存允许进程内存态/本地盘）；部署面禁止多副本 | 2026-09-17 |
| **R21** | **上传走 base64 JSON**：`.wasm ≤ 32 MiB`、请求体 ≤ 48 MiB | 2026-09-17 |
| **R22** | **实例内存 64 MiB / 单响应 8 MiB** | 2026-09-17 |
| **R23** | 最小运维面（webadmin）：应用列表 / 下架 / 转移归属 | 2026-09-17 |
| **R24** | **准入由应用代码控制**：平台只提供经校验的身份，不拦"已登录但未授权"的请求 | 2026-09-17 |
| **R25** | **登录要求、可见性、白名单统一由应用配置文件决定**（随发布提交，见 §4.2）：`login_required`（默认 true）/ `visible`（是否列入应用中心目录）；允许匿名时帧内 `user: null`，身份相关宿主调用 `AUTH_REQUIRED`。**改配置 = 发新版** | 2026-09-17 |
| **R26** | **平台不提供任何员工目录能力**（不列举 / 不搜索 / **不校验账号是否存在**）；名单写在应用配置文件里，由作者手填已知账号 | 2026-09-17 |
| **R27** | 帧内提供 `user.is_publisher`（当前使用者是否为本应用发布者）；应用可选使用（如只给发布者显示设置/统计入口） | 2026-09-17 |
| **R28** | **作者画像 = 全员自助**：不假设作者会写代码或懂运维；门槛由 skill + 员工 AI 承担 | 2026-09-17 |
| **R29** | **部署前置条件**：企业自备通配域名与通配证书、管理员配置 Caddy；**平台不做证书自动化**。**IP / 纯内网地址不提供应用子域能力** | 2026-09-17 |
| **R30** | **同步 publish**：校验与编译在请求内完成，成功才落 release 行，失败同步返回结构化错误（**不落行**） | 2026-09-17 |
| **R31** | **编译进程 = 单进程串行（并发 1）+ `wazero.NewCompilationCacheWithDir` 磁盘缓存**；进程以非特权用户 + bwrap/landlock + seccomp + 无网络 + env 白名单运行 | 2026-09-17 |
| **R32** | **表结构由应用自建**（宿主在 `db.define` 内代执行 `CREATE TABLE IF NOT EXISTS` 并强制上限）；**不做**发布期声明、自动迁移、`db.define` 自省与 `SCHEMA_MISMATCH`；`DROP`/`ALTER` 永久禁 | 2026-09-17 |
| **R33** | 保留 **32 MiB wasm / 48 MiB 请求体**；配套补客户端上传超时、分片/续传与自定义段上限 | 2026-09-17 |
| **R34** | **独立"应用中心"页**（客户端）+ **保留 R16 员工浏览器登录页**；员工从应用中心进入，也可持有 `<app_id>.<应用基域>` 链接 | 2026-09-17 |
| **R35** | 匿名 `public` 与**限流重做**同批上线：可信代理自检（启用子域却未配 `PICOAI_TRUSTED_PROXIES` ⇒ 拒绝启动）+ 全局匿名令牌桶 | 2026-09-17 |
| **R36** | **AI 调用走平台既有请求路径**：应用只是壳子，**谁登录用谁的额度与余额**；平台**不引入应用级配额、不做应用维度归因**（网关已有用户级记录）。调用事件里保留 `app_id` 仅供诊断与追责，不参与计费 | 2026-09-17 |
| **R37** | 应用退役 = **冻结 → 只读快照保留 90 天（管理员可导出）→ 真删并写审计** | 2026-09-17 |
| **R38** | **可见性 = 配置里的 `visible` 布尔**：`true` 列入应用中心目录，`false` 不列入（知道链接仍可打开，**能不能用仍由应用自己判**）；平台只做目录过滤，不做准入拦截 | 2026-09-17 |
| **R39** | **Tier 1 收敛为 Go**（`GOOS=wasip1`）；Rust/Zig 降为"实测可用、不承诺"，白名单与样例只维护一份 | 2026-09-17 |
| **R40** | **工具链分发与本地自测属于 skill / 员工 AI 职责**，平台不提供 | 2026-09-17 |
| **R41** | **不设分期**：设计按终态一次写清；实施顺序由 §11 的依赖与缺口清单驱动 | 2026-09-17 |
| **R42** | skill 的责任边界：安装/探测工具链、本地预览、按导入白名单生成代码、**遵守沙箱可写面**（唯一真源 = 会话工作区 + 临时目录，禁止依赖 `$HOME`） | 2026-09-17 |

---

## 3. 威胁模型

### 3.1 对手与动机

| 对手 | 能力 | 动机 |
|---|---|---|
| **恶意员工** | 可写任意 wasm、可发任意 HTTP 请求、持有自己的合法账号、可开多个浏览器会话 | 读**其他应用**的数据、越权使用未授权应用、薅 AI 额度、探测平台、报复 |
| **被诱导的 AI** | 同上（代表员工操作），可能生成有漏洞或含后门的代码 | 无恶意但会犯系统性错误 |
| **粗心的作者** | 无恶意 | 写出死循环、全表扫、无限递归、把状态放全局变量 |
| **外部攻击者** | 无账号 | 通过应用子域探测平台、走私响应头、跨应用攻击 |
| **匿名访问者**（`public` 应用） | 无账号 | 白嫖 CPU/队列（AI 需身份，拿不到）、探测应用逻辑、把平台域名当免费托管与请求生成器 |

### 3.2 资产

平台凭据与令牌 · 平台数据库（用户/余额/审计/用量） · 各应用的数据 · AI 额度与上游成本 · 服务可用性 · **平台域名与证书声誉** · 审计完整性

### 3.3 六条不可逾越的红线

> 任何设计取舍与此冲突时，以红线为准。

1. **应用读不到平台数据**（用户表、令牌、余额、审计、用量）
2. **应用读不到其他应用的数据**
3. **应用拿不到可用于调平台的凭证**（浏览器侧与沙箱内均不得出现）
4. **应用不能出站**（无网络能力，非策略拦截）
5. **应用不能读宿主文件系统**
6. **单个应用无法拖垮平台**（CPU/内存/磁盘/队列/AI 额度全部有界）

---

## 4. 护栏总表（**唯一真源**）

> 实现要求：所有数值集中在 `limits.go`（Go 侧）与一份机器可读的 `limits.json`（供 SKILL.md 与作者文档生成）。**禁止在别处硬编码任何上限数值**；构建期门禁校验"文档/技能/错误文案里的数字与代码一致"。

### 4.1 命名与标识

| 项 | 值 | 依据 |
|---|---|---|
| **`app_id`** | **既是应用标识、也是域名标签**：基础规则沿用平台既有 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（小写、无连续/首尾连字符）；**wasm 应用额外约束**：长度 ≤ **63**（DNS label 上限）、**不得纯数字**（避免 IP 形态）、**不得以 `xn--` 开头**（punycode）、不得是保留字（下行）、不得与基域下既有 DNS 记录/主机名冲突 | `manifest.go:243/60-61` + 域名规则 |
| `app_id` 唯一性 | **同 kind 内由 `apps` 主键 `(kind, app_id)` 保证** | 一个 `app_id` 只能对应一个域名，因此不需要额外标识列 |
| `app_id` 改名 | **不支持改名**（改名等于换域名）：需要新名字就新建应用，旧应用照 R37 退役 | 版本与域名都是外部契约 |
| 版本号 | 严格 `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$`，必须严格递增；**失败的发布不占号**（R18：失败不落 release 行）；**已落行的版本永久占号**——被拒与软删（`deleted_at`）的版本同样不可复用（`UNIQUE(kind,app_id,version)`）。两者是**两条不同规则**，不得互相推导 | `manifest.go:248` + `appstore/publish.go:221-238` + `0053_apps.sql:50/53` |
| 非首版 changelog | 必填（空即拒，422 `MISSING_FIELD`） | `publish.go:241-244` |
| **app_id 保留字** | `www api admin portal app apps updates static cdn mail ns ns1 ns2 dns ftp vpn sso login auth autodiscover autoconfig mta-sts dmarc acme _acme-challenge` + **部署期可注入的企业已知主机名**（基域是平台资产） |

### 4.2 上传与包

| 项 | 值 | 说明 |
|---|---|---|
| `.wasm` 体积上限 | **32 MiB**（R33） | Go 实测 3.34 MB；余量留给内嵌 HTML/JS/资源 |
| 上传请求体上限 | **48 MiB**（base64 JSON，R21） | 必须进 `largeBodyRoutes` 白名单；**白名单只是豁免** ⇒ handler 内必须自己再套 `http.MaxBytesReader(48<<20)`；先查 `Content-Length` 回 413 |
| **客户端上传超时** | **90 s**（必须 > 服务端 `ReadTimeout 60 s`）；>8 MiB 走**分片 + 续传** | 客户端既有大上传是 `timeoutMs: 30000`（`packages/host/enterprise/src/auth-gate.ts` 两处，`grep -n "timeoutMs: 30000"` 取当前位置——**行号会随提交漂移，文档不写死**），32 MiB 必然超时 |
| 上传时限（服务端） | `http.Server.ReadTimeout = 60 s` | 48 MiB 需 ≈6.7 Mbps 保底；部署文档须写明前置反代不得设更小的 body 上限/超时 |
| 静态资源 | **发布期从 wasm 自定义段抽出**到 `<data_root>/apps/<app_id>/assets/<release_id>/`，宿主直接服务 + 缓存；**抽完立即释放原始字节** | HTML/JS 也走这条（R8/R37）；抽出失败 = 发布失败；缓存键 `app_id + version + path` |
| **自定义段总量上限** | **≤ 4 MiB**（超限 `SECTION_OVERSIZE`） | 实测：自定义段零用途却整体进内存（2.48 MiB→32.48 MiB，RSS +34 MiB、编译 1.78 s） |
| **导入面白名单** | **由参考实现构建期生成、不手写**：每语言一份"读帧 + 调全部宿主函数 + 写帧"的样例，CI 真编译后 dump 导入集写入 `limits.go`；**判据 = 符号 + 类型**（签名不匹配 ⇒ `IMPORT_SIGNATURE_MISMATCH`） | 必须含 `fd_read`（ABI 读 stdin 需要）；Go 实测 17 条 / 16 个不同名（`fd_write`×2） |
| 导出面 | **必须含 `_start` 与 `memory`，额外导出忽略** | Rust 实测多一个 `__main_void` |
| 编译超时 | 60 s | 实测 2.48 MiB 冷编译 1.27–1.69 s |
| **应用配置文件** | `picoaide.app.json`（随 publish 提交，**不计入 32 MiB wasm 上限**，≤64 KiB）：`{visible, login_required, whitelist[], purpose, data_sensitivity, owner}`；发布期随资源一起抽出到 `assets/<release_id>/`，应用用 `assets.read("picoaide.app.json")` 读取 | **平台不校验 whitelist 里的账号是否存在**（否则等于提供账号枚举接口）；`login_required=true` 且名单为空 ⇒ 拒（`APP_CONFIG_INVALID`）；whitelist ≤ 2 000 条；改任何一项都要发新版 |
| 上传期校验（validate） | 导入面（符号+类型）+ 导出面 + **自解析段表**（结构化错误，不把 wazero 裸错误当唯一出口）+ 体积 + **一次真实编译** + **合成帧干跑**（2 s 预算跑 `Instantiate → _start → 响应帧`） | 编译通过 ≠ 能跑（签名不匹配编译期全绿、实例化才炸，实测）；干跑与编译同进程同配额；**validate 不落版本号、不进审计** |
| **publish** | **同步**：校验 → 编译（复用 validate 缓存）→ 落 release 行 → 生效或进待审；失败**不落行** | R30/R18；状态只有"审核态 + 删除态" |

### 4.3 WASM 运行时（全部为**必须显式配置**项）

> 警告：以下多数是"不设置就是危险的默认值"。已实测的默认值陷阱标 ⚠️。

| 项 | 配置 | 依据 |
|---|---|---|
| 上下文取消 | ⚠️ **必须** `WithCloseOnContextDone(true)`（**RuntimeConfig**；编译进程与执行进程必须一致，见 §4.3.1） | 实测：不开则 context 超时完全不生效；该开关经 `wasm.Module.AssignModuleID` 进入 module ID ⇒ 两侧不一致时磁盘缓存**永不命中**（静默） |
| 随机源 | ⚠️ **必须** `WithRandSource(rand.Reader)`（**ModuleConfig**，**每次实例化都要设**） | 默认是 `platform.NewFakeRandSource()` = `rand.New(rand.NewSource(42))`（实现 `internal/platform/crypto.go:12/15-17`，调用点 `internal/sys/sys.go:151-152`）：**固定种子 42 的确定性伪随机，跨独立实例完全一致**（实测三个独立 Runtime 的 guest 首读同为 `dfd79b4d76429b61`）。比"全零"更隐蔽：作者本地看着"每次都在变"，线上每个用户拿到的"随机"值却相同；判据必须是"两次独立实例序列**不同**"（§10.2 第 21 项） |
| 墙钟 / 单调钟 / 睡眠 | ⚠️ **必须** `WithSysWalltime()` + `WithSysNanotime()` + `WithNanosleep(真实实现)` | `config.go:582`：默认不是 `time.Now` |
| 文件系统 | ⚠️ **零 preopen** | 实测：有 preopen ⇒ 挂载点下全部可读 |
| 参数 / 环境变量 | **不传 args、不传任何 env** | 传 env = 把部署环境交进沙箱 |
| stdin / stdout | stdin = 宿主构造的请求帧；stdout/stderr 捕获到内存缓冲，**绝不落宿主 stdout** | §7 帧协议 |
| 实例内存 | `WithMemoryLimitPages(1024)` = **64 MiB/实例**（R22） | 实测：Go 常驻 8 MiB 堆时 16 MiB 上限只剩 ~7 MiB 余量；Zig 初始内存默认 16.4 MiB（工具链决定，平台设不了） |
| 实例策略 | **只缓存编译结果，每请求新实例**；禁止实例复用 | 实测实例化 + `_start` = 10.6 ms（空跑）/ 106.9 ms（8 MiB 堆）⇒ 可行 |
| 编译缓存 | **`wazero.NewCompilationCacheWithDir(<data_root>/apps/_compile-cache)`**（内容寻址 sha256、跨 Runtime/进程/重启）；**不自建 LRU**；配置与目录纪律见 §4.3.1 | wazero `cache.go:34/56`；接口注释明写"for decoupling, not third-party implementations"，编译产物跨不了进程 |
| 编译进程（R31） | **单进程串行（并发 1）** + 队列 64（满则 429）+ CPU 配额 | 实测 2.48 MiB 编译 1.3–1.7 s；32 MiB 极端模块 ~10–20 s |
| 编译进程隔离（R31） | **非特权用户 + bwrap/landlock + seccomp + `--unshare-net` + env 白名单**（不得继承 PG DSN / master key 等） | 唯一"读不可信字节且可能写宿主"的进程；env 纪律与实例同等 |
| 驱动与连接 | **一应用一 driver 实例 + 一应用一连接，不复用** | `vtab` 包级注册是进程全局 |
| **内存四笔账** | 编译缓存驻留 + 32×64 MiB 实例 + 编译峰值 + **上传峰值**（base64 单次 ≈118 MB：32+43+43）**各自设限并联立**；**启动自检：理论峰值 > 可用内存 70% ⇒ 拒绝启动** | 四笔账必须同时设限；峰值超可用内存 70% 时**拒绝启动**而不是等 OOM |
| 上传频率 | 每用户 30 次/小时（validate + publish 合计）+ **同时最多 1 次编译中的上传** | 防"上传即预编译"成为 DoS 面 |

#### 4.3.1 编译缓存：唯一构造函数与信任边界

> 依据 = wazero v1.12.0 源码 + 本机复跑（探针 `docs/evidence/2026-09-17-wasm-app-platform/cache-key/`，2026-09-17）。
> 键 = `sha256(moduleID ‖ magic ‖ CPU features)`，其中 `moduleID = AssignModuleID(binary, listeners, ensureTermination)`（`runtime.go:261`、`internal/wasm/module.go:214-231`、`internal/engine/wazevo/engine_cache.go:29-41`）；目录按 wazero 版本分片（`wazero-v<ver>-<os>-<arch>`）。

| # | 不变量 | 违反时的后果（**全部是静默的**） |
|---|---|---|
| a | **两侧共用一份 `newRuntimeConfig()`**：编译进程与执行进程的 `WithCloseOnContextDone`、`CoreFeatures`、engine 种类必须相同（`WithMemoryLimitPages` **允许不同——它不进键**）；并有测试断言两侧逐字段相等 | 实测：只改内存上限 ⇒ 命中同一键 `429b279e…`；只改 `WithCloseOnContextDone` ⇒ 换键 `68689fd7…`（条目 10.06 → 10.51 MiB）。不一致 ⇒ 发布期编译**暖不到**执行进程 ⇒ 进程重启后每个应用首个请求付一次冷编译（1.9 s），同模块落**两份**条目 |
| b | **键的可复用前提**：同 wazero 版本（目录名分片）、同 CPU features、同 `WithCloseOnContextDone`、同函数监听器配置 | 换 wazero 版本或换 CPU（异构机队）都会复制条目 ⇒ 缓存容量与回收（§11 第 11 项）必须按 `(版本, CPU, flag)` 三元组算 |
| c | **每次实例化新建 ModuleConfig**：`WithRandSource` / `WithSysWalltime` / `WithSysNanotime` / `WithNanosleep` / `WithStdin` / `WithStdout` / `WithStderr` / `WithArgs` / `WithEnv` 都是 **ModuleConfig**（只有 `WithCloseOnContextDone` / `WithMemoryLimitPages` 在 RuntimeConfig 上）；**同一个 ModuleConfig 不得跨请求复用** | 漏设 = 随机源/时钟/stdio 全部回落危险默认值（固定种子伪随机 + 2022-01-01 假时钟）；复用 = 把上一请求的 stdout 缓冲/环境带进下一请求 |
| d | **缓存目录是信任边界**：目录属主 = 编译进程，执行进程只读；不得挂载成任何"外部可写"路径 | wazero 原话 *"The embedder must safeguard this directory from external changes"*（`cache.go:55`）；条目只带**同文件内** CRC32（防损坏、不防篡改），而执行进程会把这些字节 **mmap 成机器码执行** ⇒ 编译进程一旦被攻破（§15.1 第 14 条正是假设它可能被攻破），缓存就是**提权到 server 进程的持久通道**。要么加校验方案，要么在 §12 显式认账（§11 第 24 项） |

### 4.4 宿主能力调用

| 项 | 值 | 说明 |
|---|---|---|
| 硬规则 | **宿主函数不得阻塞超过其预算**；每个宿主函数**必须**使用传入的 `ctx` | 实测：宿主阻塞时 guest 超时完全失效（预算 300 ms 跑满 3 s，且返回 `err=nil`） |
| 宿主调用返回后 | **强制复检** `ctx` 与 module 状态，已取消即按超时处理 | 否则"被杀"会返回成功 |
| `ai.chat` | `http.NewRequestWithContext`；单独预算 30 s；不在 guest 计时内；**走平台既有 `/v1` 请求路径**，按使用者身份计费与限流（R36，无应用级额度） | §7.3 |
| 宿主函数参数 | 任何宿主函数**不得接受文件路径**；`db.*` 只用逻辑标识 | 路径由宿主按 `app_id` 推导 |
| 事务内宿主调用 | **禁止**（`db.tx` 内调 `ai.chat`/`log` 直接报错） | 防事务长期持锁 + 占满执行槽 |
| 兜底 | 每个宿主调用额外包 `recover()` 边界 | wazero 会 recover 宿主 panic，但那是实现细节不是契约 |

### 4.5 SQL / 数据层

| 项 | 值 | 依据 |
|---|---|---|
| 数据库粒度 | 每应用一个 `.db`（`<data_root>/apps/<app_id>/app.db`） | R1 |
| **数据库体积上限** | **100 MB**（`PRAGMA max_page_count = 25600`，页 4096 B） | R2；⚠️ **该 pragma 与全部 `SQLITE_LIMIT_*` 都是连接级且不持久**（实测：重开文件/新连接读回默认值）⇒ **每条连接都要重设**（连接钩子 + 变异测试），漏设即静默失去上限 |
| 单语句 | **强制单语句**：分号须位于字符串字面量之外；其后除空白/注释外有内容即拒 | 实测：多语句让 `db.query`/`db.exec` 区分形同虚设 |
| schema | **仅 `main`**（任何 `ATTACH` 一律拒） | 实测：一条 `ATTACH` 即可跨应用读 |
| 语句种类白名单 | 仅 `SELECT`/`INSERT`/`UPDATE`/`DELETE`；**禁全部 DDL（含 `CREATE`/`DROP`/`ALTER`）**、禁 `ATTACH`/`DETACH`/`VACUUM`/`PRAGMA`/`WITH RECURSIVE` | 建表只经 `db.define`（R32，宿主代执行并强制上限）；`VACUUM INTO` 与 `ATTACH` **同受 `SQLITE_LIMIT_ATTACHED` 约束**（实测 =0 时一起被拒：`too many attached databases - max 0`、目标文件不生成；modernc v1.55.0 / v1.59.0 一致）⇒ 禁它是**纵深**，真正的闸门是下行的连接级限额 |
| 连接级只读分层 | `SELECT` 走 `_pragma=query_only(1)` 连接；写走读写连接且每次调用前重置连接状态 | 防连接级状态粘连 |
| `SQLITE_LIMIT_SQL_LENGTH` / `LENGTH` | 64 KiB / 1 MiB | 单条 SQL / 单值 |
| `SQLITE_LIMIT_COLUMN` | 128 | 结果集列数 |
| `SQLITE_LIMIT_EXPR_DEPTH` / `PARSER_DEPTH` | 32 / 32 | 嵌套与解析栈深 |
| `SQLITE_LIMIT_COMPOUND_SELECT` | 8 | 复合 SELECT |
| `SQLITE_LIMIT_VDBE_OP` | 50 000 | 挡**编译期巨型语句**；⚠️ **不是运行期护栏**（实测无界递归 CTE 只有 32 条指令） |
| `SQLITE_LIMIT_FUNCTION_ARG` / `VARIABLE_NUMBER` | 16 / 128 | |
| `SQLITE_LIMIT_ATTACHED` | **0** | 引擎层否决 ATTACH，**并且是 `VACUUM INTO` 的唯一闸门**（实测见上行）；⚠️ 连接级不持久 ⇒ **每条连接重设**（连接钩子 + 变异测试），漏设即二者同时复活 |
| `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` | 512 | 防 LIKE 模式爆炸 |
| `SQLITE_LIMIT_TRIGGER_DEPTH` / `WORKER_THREADS` | 8 / **0** | 触发深度 / 禁辅助线程 |
| 返回行数 / 字节 | 5 000 行 / 8 MiB | 超出即截断并报错 |
| **单语句时长** | **5 s（独立于 guest 超时）** | `QueryContext` + 每语句 ctx；驱动取消时调 `sqlite3_interrupt`（实测 3.00 s 准时中断）⇒ 挡"合法但很慢"查询的**主闸门** |
| `PRAGMA` | 仅宿主内部可用；应用提交的 PRAGMA 一律拒 | 防 `writable_schema=ON`、`database_list` 探测 |
| 表 / 列上限 | 表 ≤ 16 / 应用，列 ≤ 16 / 表；列类型枚举封闭（`text/int/real/bool/datetime`） | **由 `db.define` 强制**，不依赖发布期声明（R32） |

### 4.6 请求与队列

| 项 | 值 | 说明 |
|---|---|---|
| 请求体上限 | 1 MiB（应用 API，非上传路径） | 子域路由树不在 1 MB 中间件的两个 namespace 分组里 ⇒ **必须自己实现** |
| 响应体上限 | 8 MiB | |
| 协议帧单行上限 | 1 MiB | 超限即 `RUNTIME_OUTPUT_OVERRUN` |
| guest 执行预算 | **10 s**（进入宿主调用时暂停计时） | 防 `ai.chat` 阻塞被误判 |
| 宿主调用预算 | 30 s（`ai.chat`） | |
| 请求端到端墙钟 | **60 s**（含排队等待） | 到点即拒 |
| 每应用队列长度 | **32** | 超出 429 + `Retry-After` |
| 每用户占槽 | **按应用计**：同时最多 1 个在跑、队列中最多 4 个 | 防单用户占满该应用队列 |
| **每用户全局在跑上限** | **4**（跨应用聚合） | 否则单用户 20 个应用可占满全局 32 槽 |
| 每应用并发 | **恒为 1**（串行） | 与"每应用一连接"一致 |
| 全局并发实例 | **32**（配合 64 MiB/实例 ≈ 2 GiB 上界） | 防跨应用耗尽 |
| **匿名限流**（R35） | 全局匿名令牌桶（默认 3000 次/分）+ 每 IP 60 次/分；**启用子域却未显式配置 `PICOAI_TRUSTED_PROXIES` ⇒ 拒绝启动**；⚠️ `docker-compose.yml:98` 默认注入 `172.28.0.2` ⇒ 自检必须能区分"compose 默认值"与"管理员显式配置"，否则要么永远拒启、要么形同虚设 | 缺省只信回环；错配会让全部匿名流量坍缩进同一桶 = 全组织 429（本仓已有同族事故） |
| 响应缓存 | 仅缓存 `assets.read` 的静态资源；键 `app_id + version + path`；动态响应一律不缓存 | 键必须含 `app_id` |

### 4.7 账号、AI 与额度

| 项 | 值 | 说明 |
|---|---|---|
| 应用子域会话 | 一次性换票（code 单次、60 s、绑 `(user, app)`）；Cookie **host-only + HttpOnly + Secure（fail-closed：非 https 不签发）+ SameSite=Strict**，TTL 8 h | R12/R16 |
| 换票端点 | **POST + `Origin == 主站源` + `next` 只接受同基域相对路径**（`/` 开头、不得含 `//`/scheme），非法回落 `/`；签发写审计 | 防登录 CSRF 与开放重定向 |
| 准入（R24） | **应用侧**：平台只注入身份；未授权请求照样进 wasm，由应用读自己配置里的 `whitelist` 判定并返回 403（页面必须显示本人账号） | 名单由作者手填在配置文件里；平台不提供目录、不校验账号存在性 |
| 登录要求（R25） | 由应用配置文件决定：`login_required: true`（默认）时未登录 302 换票；`false` 时帧内 `user: null`，身份相关宿主调用 `AUTH_REQUIRED` | 与 R35 限流同批上线 |
| AI 令牌 | **每个员工浏览器会话铸一张 45 min 用户令牌**（宿主内存持有并按需续期，登出即吊销）；**`api_tokens` 无需加任何列** | 不做应用维度 ⇒ **`api_tokens` 保持现状，不加列、不加唯一约束** |
| **AI 额度与归因**（R36） | **不做应用级额度、不做应用维度归因**：用户级余额 + 网关既有 60 次/分桶 + `InFlightGuard` 是全部边界；网关已有用户级记录 | 语义已定：谁登录用谁的钱；应用只是壳子 |
| **额度可见性**（R36） | **唯一的额度入口是桌面客户端**（余额/用量都在客户端里）；**应用子域、应用中心页、门户都不提供额度或用量页面** | 应用侧不需要知道余额，只需在宿主返回额度错误时给出可读提示 |
| AI 调用边界 | **沿用平台既有用户级边界**（余额闸门 + 每用户 60 次/分 + 在途 32）；不新增应用级日限 | R36；爆炸半径由"使用者自己的额度"天然限定 |
| AI 并发 | 复用既有 `InFlightGuard`（每用户 32），**不新增应用级计数** | R36 |
| **余额预留** | 应用发起的调用必须先预留预估额度再转发；**同一处 handler 建议一次修掉既有桌面路径**（现状只判余额 >0，结算在上游调用之后） | |
| 模型准入 | 服务端按管理员配置 + 用户权限裁决 | |
| 提示隔离 | `ai.chat` 的 messages 由应用自建，平台不注入系统提示；返回体不透出内部错误/上游原文 | |

### 4.8 响应与浏览器侧

| 项 | 值 | 说明 |
|---|---|---|
| **应用响应安全头（宿主独占，含 4xx/5xx）** | 宿主**强制**写 `Content-Security-Policy`（`default-src 'none'` + 自身源 `script`/`style`/`img`；`frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；应用自带的同名头一律剥离 | 应用子域是公司域名下的任意 HTML/JS 宿主（R8/R37）⇒ **"谁写安全头"必须落在宿主**；对照渠道 SVG 的既有口径（`channel/svg_guard.go`） |
| 响应头白名单 | `content-type`（限定集合）、`cache-control`、`content-disposition`（仅 `inline`）、`x-content-type-options` | Cookie 由宿主独占 |
| CR/LF | 头值中出现即拒 | 防响应拆分 |
| 主机名反查 | `Host` 的**第一级标签** → `apps.app_id`（`kind=wasm_app`）；查不到**直接 404**，绝不回落主站 | 域名标签即 `app_id` |
| **host 门控（allow-list）** | 应用子域**只挂应用路由树**——主站路由在子域**一律不注册**，而不是维护一份"禁命中清单"。至少覆盖：`/`、`/portal`、`/admin/*`（webadmin SPA，带账密表单）、`/healthz`、`/models`、`/chat/completions`、`/v1/*`、`/api/server/*`、`/updates/client/*` | 全仓 Go 代码**零 host 维度判断**（`Request.Host` 仅 `clientrelease.go:200` 一处、用于拼下载 URL），`/`、`/portal`、`/admin/*` 都在 NoRoute 分支、`/healthz` 在根引擎上 ⇒ 清单式禁命中必然漏（2026-09-17 复核）；断言见 §10.1 13a–13d |
| 跨应用写防护 | 子域路由树最外层**无条件**校验：非幂等方法要求 `Origin == https://<app_id>.<应用基域>`（无 Origin 校验 Referer 前缀），且**早于**任何重定向/重写 | 同 eTLD+1 下 `SameSite=Strict` 挡不住 `<a>.<基域>` → `<b>.<基域>` 的跨源写 |

### 4.9 审计与可观测

| 项 | 值 | 说明 |
|---|---|---|
| 审计（防篡改链） | 发布结果（成功/失败/被拒）、上下架、**冻结/导出/删除**、令牌铸造与吊销、配额超限、审核开关与可见性变更、换票签发 | 写路径**单 worker 同步阻塞**（最坏 25 s）⇒ 高频项（令牌铸造/吊销、换票签发）**异步 fire-and-forget + 失败计数**；`validate` 不进审计 |
| **审计的 app 维度** | `audit_logs` 加**可空 `app_id` + 索引**（哈希链版本化） | 否则答不出"谁在什么时候用了哪个应用" |
| 调用事件 | 有界环形内存 → 批量落**独立表**（不进哈希链）；字段 `app_id / user_id / outcome / reason_code / cpu_ms / peak_memory_bytes / host_call_count / host_call_ms / queue_wait_ms / response_bytes / db_rows / db_bytes`；**7 天保留 + 丢最旧并计数** | 回答"这个应用刚才为什么被杀"的唯一载体；**必须带 `user_id`**（未授权访问/数据污染追责的底线） |
| 用量归因 | **不改 `usage` 表**：AI 消耗由网关按既有用户维度记录（R36）；"哪个应用花的"不作为平台要求（调用事件里有 `app_id`，仅 7 天诊断用） | 避免了 `usage` 加列、日/月账本 PK 重建与流式回填改造 |
| 诊断 API | 按应用聚合最近 N 条失败与被杀记录，结构化错误码 + hints（第一消费者是 AI）；含 guest exit code 与 stderr 尾巴 | §7.4 |
| 运维面 | `/readyz`：磁盘余量 / 编译队列深度 / 执行队列深度 / 编译缓存大小；低于阈值红灯并**拒绝发布**（fail-closed） | 现网 `healthz` 只 `db.Ping`：磁盘满仍 healthy |

---

## 5. 受控能力面（**不给自由度，只给铺好的路**）

### 5.1 应用能用的全部原语（封闭清单）

| 原语 | 用途 | 固定约束 |
|---|---|---|
| `db.define(table, columns[])` | **建表**（宿主代执行 `CREATE TABLE IF NOT EXISTS` 并做上限检查；重复调用幂等） | 表名/列名 `^[a-z][a-z0-9_]{0,30}$`；列类型枚举封闭；列 ≤ 16；表 ≤ 16；禁止指定主键/外键/索引/触发器；**改结构 = 由应用自己建新表或加列**（R32，无自动迁移） |
| `db.query(sql, args)` | 单条 SELECT | 单语句、参数化、`SQLITE_LIMIT_*`、返回 ≤ 5 000 行 / 8 MiB |
| `db.exec(sql, args)` | 单条写语句 | 仅 INSERT/UPDATE/DELETE；禁 DDL |
| `db.tx(fn)` | 事务（语言侧糖） | ABI 层是 `tx_begin`/`tx_commit`/`tx_rollback`（§7.2）；事务内**禁止**调用任何其他宿主函数；硬超时 5 s 强制回滚 |
| `ai.chat(messages, model?)` | 调 AI | 模型由服务端裁决；预算 30 s；不注入系统提示；匿名调用 ⇒ `AUTH_REQUIRED`；**按使用者身份走平台既有路径计费与限流（R36）** |
| `log(level, msg)` | 写日志 | 单条 ≤ 4 KiB；每请求 ≤ 100 条；超出丢弃并计数 |
| `assets.read(path)` | 读包内资源 | 资源已在发布期抽到宿主磁盘（§4.2），应用与宿主读同一份；无文件系统语义、无路径穿越 |

**没有任何其他能力**——无文件、无网络、无线程、无子进程、无环境变量、无时钟配置、无随机源选择、无 PRAGMA、无 ATTACH、无 DDL、无扩展加载。**也没有任何员工目录能力**（不列举、不搜索、不点查，R26）：应用只知道"当前使用者是谁"，永远拿不到公司名录。

### 5.2 平台保留列

| 列 | 说明 |
|---|---|
| `_row_id` | 平台主键（应用不指定主键，避免自增/冲突语义被滥用） |

**应用侧直接读写自己的表**（R15）：同一应用内所有用户共享数据，平台不做行级过滤，也不提供任何"按用户"语义的假象。表由 `db.define` 建（R32）；应用看不到 `_row_id`（提到即拒）。

### 5.3 容量与配额清单

| 项 | 值 | 归属 |
|---|---|---|
| 数据库体积 | 100 MB / 应用 | R2 |
| 表数 / 列数 | 16 / 应用，16 / 表 | `db.define` 强制 |
| 单值长度 | 1 MiB | `SQLITE_LIMIT_LENGTH` |
| 返回行数 / 字节 | 5 000 行 / 8 MiB | 平台固定 |
| 保留版本数 | 最近 **3 个曾生效**版本（更早的软删 + 归档置空）；失败发布不落行（R18） | 平台固定；清理任务见 §11 |
| **制品总量** | 每用户 **1 GiB**（PG BYTEA 口径，含全部版本） | 反过度设计审计：真实成本在字节不在条数 ⇒ 不设"应用个数"配额 |
| AI 配额 | **无应用级配额**；沿用平台既有用户级余额与限流（R36） | 不新增 |
| 调用事件 / 日志保留 | 7 天 | 平台固定 |
| 退役快照保留 | 90 天（R37） | 平台固定 |

### 5.4 把"会用错"消灭在流程里

| 用户/AI 容易做错的事 | 平台如何让它不可能发生 |
|---|---|
| 以为应用内数据按用户隔离 | R15 ⇒ skill 首屏明写"同一应用内所有用户共享数据" |
| 用全局变量存状态 | 实例每请求新建 ⇒ 用了也不生效；skill 明写无状态 |
| stdout 打日志毁协议 | 非 `RS` 开头的内容一律当日志捕获，不算协议帧 |
| 用错编译目标 | 上传期导入白名单直接拒 + hints 指明 `wasm32-wasip1` |
| 版本号写错 / 忘写 changelog | 预检接口明确拒 + 结构化 hints |
| 写出慢查询 | 每语句 5 s ctx 硬超时 + `SQLITE_LIMIT_*` + 诊断事件 |
| 并发/队列参数想调优 | 没有这类参数——串行执行、队列 32、占槽 4、全局 32 全部平台固定 |

### 5.5 自动化约束（防止"护栏写在文档里但代码里没有"）

| 门禁 | 内容 |
|---|---|
| 能力清单一致性 | `capabilities.go` 注册的宿主函数集合必须与 §5.1 逐项一致；多一个即测试红 |
| **导入面生成** | 白名单从参考实现真编译产物 dump 生成（§4.2），手写清单即测试红 |
| 列类型枚举一致性 | `db.define` 接受的类型集合与文档表格一致 |
| 无路径参数 | 枚举所有宿主函数签名，断言没有任何参数语义是文件路径 |
| 数值单一真源 | `limits.go` 是唯一数值来源；SKILL.md / 作者文档 / 错误文案从它生成，构建期比对 |
| **限额施加** | 每条新连接必须带全套 `SQLITE_LIMIT_*` 与 `max_page_count`（变异测试） |
| 变异验证 | 任一限制改回"无上限"，对应 §10 用例必须变红 |

---

## 6. 系统架构

### 6.1 请求链路

```
员工浏览器 / 客户端"应用中心"页
  │  ① 访问 https://<app_id>.<应用基域>/（R29：企业自备通配域名+证书）
  │     无有效应用子域 Cookie ⇒ 302 到主站换票（login_required；public 允许匿名直入）
  ▼
主站 https://<基域>/app-ticket   ← POST + Origin 校验 + next 白名单（§4.7）
  │  ② 主站员工浏览器会话（R16）→ 生成一次性 code（60s，绑 user+app）
  │  ③ 302 回 https://<app_id>.<应用基域>/?ticket=<code>
  ▼
应用子域（独立路由树 + host 门控 + Origin 校验 + 宿主安全头）
  │  ④ 宿主用 code 换 host-only + HttpOnly + Secure + SameSite=Strict Cookie，再 302 回干净 URL
  │  ⑤ 准入判定在应用代码里（R24）；未授权由应用返回 403（显示本人账号）
  ▼
┌──────────────────────────────────────────────────────────┐
│ 平台主服务（Go 单二进制，CGO_ENABLED=0，单实例 R20）        │
│  会话与票务 · 应用路由 · 静态资源(宿主安全头) · 宿主能力     │
│  护栏(limits.go) · 计量 · 审计(异步) · 队列 · 应用中心 API   │
└───┬───────────────┬───────────────────┬──────────────────┘
    │ stdin/stdout  │ 内部 /v1          │ 上传/校验队列
    │ 帧协议(每请求  │ (BearerAuth +     │
    │ 新实例 64MiB)  │  InFlightGuard +  ▼
    ▼               │  余额预留 + 确认) ┌────────────────────────────┐
┌──────────────────┐│                  │ 编译进程（R31，独立+隔离）  │
│ WASM 实例（沙箱） ││                  │ 单进程串行 + wazero 磁盘缓存│
│ 无网络·无文件系统 ││                  │ 非特权+bwrap+seccomp+无网络 │
└────────┬─────────┘│                  └────────────┬───────────────┘
         │ SQL 闸门：单语句+schema+语句种类+LIMIT_*+每语句 5s ctx
         ▼                                          ▼
/data/apps/<app_id>/app.db（100MB 硬限）      /data/apps/_compile-cache/
（平台自身仍在 PostgreSQL，应用进程无任何可达路径）
```

### 6.2 编译与发布链路（同步，R30）

```
员工 → AI（客户端内；工具链与本地预览由 skill/AI 负责，见 §9）
  ① 员工描述需求
  ② AI 写代码 + 本机编译（Go / wasm32-wasip1）+（可选）本地预览
  ③ AI 调 POST …/wasm/validate     ← 导入面(符号+类型) + 导出面 + 段表 + 体积 + 真编译 + 干跑
       ├─ 通过 → ④                （不落版本号、不进审计）
       └─ 失败 → 结构化 {code, details, hints} → AI 自修 → 回到 ②
  ④ AI 调 POST …/wasm/:app_id/releases（wasm + Manifest{version,title,changelog} + 应用配置文件{visible,login_required,whitelist,用途,敏感性,负责人}）
  ⑤ 平台在 60 s 预算内编译（复用 ③ 的缓存）：
       ├─ 编译/干跑失败 → **不落行**，同步回结构化错误 ⇒ 版本号未被占用（R18），可直接重发
       └─ 成功 → 落 release 行（默认直接生效；若管理员开了审核开关 ⇒ 待审，线上仍旧版本）
  ⑥ 生效后写审计 + 通知发布者
```

**发布状态**：`pending_review`（仅当审核开关开启）/ `approved`（生效）/ `rejected`；下架复用既有 `apps.enabled`（不新增版本级状态）；删除走 R37 冻结流程。**失败发布不产生行**，因此版本唯一约束保持现状。

### 6.3 数据隔离（R1：每应用一个数据库）

**诚实说明**：每应用一个数据库意味着**同一应用内所有用户共享一个库**（R15 已定不隔离），跨应用的边界由文件系统保证；不存在"应用内按用户隔离"的机制。

| 层 | 机制 |
|---|---|
| **应用之间** | 文件边界 + `ATTACH` 被 `SQLITE_LIMIT_ATTACHED=0`（每条连接重设）与语句白名单双重否决 + 数据目录 `0700` + 文件名由宿主推导 |
| **用户之间** | **不隔离**（R15）：同应用全员共享；需要按人区分时由应用自己加业务字段（这不是安全边界） |
| **浏览器层** | 每应用独立源（子域）+ `SameSite=Strict` + `Origin` 校验 + 宿主安全头 |

---

## 7. 应用契约（ABI）

### 7.1 请求帧（宿主 → 应用）

**帧格式（唯一真源）**：`RS(0x1e) + 十进制长度 + '\n' + UTF-8 JSON`（长度前缀，读取方必须**一次读满**，不得用会预读的 JSON 流式解码器——实测会吞掉后续 RPC 应答；Node WASI 管道 stdin 无数据时 `fd_read` 立即 `EAGAIN`，**不得依赖阻塞语义**）。

```json
{"abi":"picoaide-app/1","app_id":"expense-note","version":"1.0.0",
 "auth":{"mode":"login_required","verified":true},
 "user":{"id":10231,"username":"zhangwei","display_name":"张伟",
         "dept":"研发部","is_publisher":false},
 "method":"POST","path":"/api/save","query":{},
 "headers":{"content-type":"application/json"},
 "body":"{\"amount\":100}"}
```

（`auth.mode` 取自应用配置文件：`login_required` 或 `public`；后者且未登录时 `user` 为 `null`。清单本身不进帧——应用用 `assets.read("picoaide.app.json")` 读自己的配置。首帧与后续 RPC 应答共用同一帧格式。）

**身份契约（R24–R27，宿主保证）**：

1. **每请求都带**：实例每请求新建、guest 无状态 ⇒ 身份不是会话状态，必须在**每一帧**里读。
2. **唯一来源**：应用拿不到 Cookie/令牌（R12），帧内 `user` 是唯一路径；帧由**宿主构造**，应用无法伪造。
3. **只给本人信息**：`id` / `username` / `display_name` / `dept` / `is_publisher`；**不含任何名单、不含平台角色**。
4. **匿名**：`user: null`（仅 `mode=public`）；身份相关宿主调用返回 `AUTH_REQUIRED`；**`user: null` 分支不得渲染任何账号信息**（防账号枚举）。
5. **稳定键**：`user.id` 与 `user.username` 都**不可变** ⇒ 名单与业务权限表用这两个键，不要用 `display_name`/`dept`。
6. **准入不在宿主**（R24）：已登录但不在名单里的请求照样进 wasm，由应用返回 403；平台拦的是"未登录"。

**应用侧标准模式（skill 模板强制）**：入口第一件事 = 读帧 → 取 `user` → `assets.read("picoaide.app.json")` 取自己的配置 → 比对 `whitelist` → 不在名单返回 403 页面（**必须显示 `user.username`**）。配置由作者在包里维护，**运行期不可改**（改配置 = 发新版，见 R25）。

### 7.2 协议帧（应用 → 宿主）

- 应用 → 宿主：`RS` + 长度 + 换行 + 一行 JSON-RPC 2.0 请求，或 `RS` + 长度 + 换行 + 最终响应信封
- 宿主 → 应用：同格式的 JSON-RPC 响应
- **非 `RS` 起始的输出一律视为日志**，被宿主捕获（不污染 ABI），并计入"stdout 净化"统计回给作者
- 宿主调用方法：`db.query` / `db.exec` / `tx_begin` / `tx_commit` / `tx_rollback` / `ai.chat` / `log` / `assets.read`

### 7.3 计时规则

```
请求到达 → 端到端墙钟 60 s（含排队）
  进入 guest → guest 预算 10 s
    调宿主函数 → 【暂停 guest 计时】+ 宿主预算（ai.chat 30 s / SQL 语句 5 s）
    宿主返回   → 恢复 guest 计时 + 强制复检 ctx/module 状态
  离开 guest → 停止
上传路径：客户端 90 s > 服务端 ReadTimeout 60 s > 编译 60 s（同步 publish 在 60 s 预算内，含 1 次缓存复用）
```

### 7.4 失败语义（**绝不把失败报成成功**）

| 码 | 触发 | HTTP |
|---|---|---|
| `RUNTIME_TIMEOUT` | guest 预算耗尽 | 504 |
| `RUNTIME_TRAP` | `unreachable`/非法访问 | 500 |
| `RUNTIME_MEMORY` | 内存页超限 | 500 |
| `RUNTIME_OUTPUT_OVERRUN` | 单行/总输出超限 | 500 |
| `RUNTIME_NO_RESPONSE` | 无响应帧即退出 | 502 |
| `RUNTIME_GUEST_EXIT(code)` | guest 非零退出且无响应帧（如 Go 运行时 OOM 走 `proc_exit(2)`） | 500（诊断里回 exit code + stderr 尾巴） |
| `HOST_CALL_OVER_BUDGET` | 宿主调用超预算 | 504 |
| `AUTH_REQUIRED` | 匿名请求调用身份相关宿主能力 | 401 |
| `AI_BALANCE_INSUFFICIENT` | 使用者余额不足（网关既有 `ErrInsufficientBalance` 语义），应用侧不暴露具体余额 | 402 |
| `AI_RATE_LIMITED` | 撞上平台既有用户级限流（60 次/分）或在途上限 | 429 + `Retry-After` |
| `MODULE_KILLED` | 已取消/module 已关闭 | 504 |
| `DB_LIMIT` / `DB_DENIED` | 100 MB 满 / 行数超 / 语句被拒 | 507 / 403 |
| `APP_QUEUE_FULL` | 队列满 | 429 + `Retry-After` |
| `IMPORT_NOT_ALLOWED` | 导入不在白名单 | 422 |
| `IMPORT_SIGNATURE_MISMATCH` | 导入符号在名单内但**类型不符**（编译期不报，实例化才炸） | 422 |
| `COMPONENT_MODEL_UNSUPPORTED` | 组件模型产物（layer=1） | 422 |
| `SECTION_MALFORMED` / `SECTION_OVERRIDE_OVERSIZE` | 段表非法 / 自定义段超 4 MiB | 422 |
| `COMPILE_TIMEOUT` / `COMPILE_OOM` | 编译超 60 s / 编译进程超限被杀 | 504 / 500 |

**硬断言**：`Call` 返回 `err=nil` 但 module 已被关闭或响应帧缺失时，**必须映射为 `MODULE_KILLED`/`RUNTIME_NO_RESPONSE`，绝不返回 200**（实测：超时后宿主函数正常返回时 `Call` 返回 `err=nil`）。

---

## 8. 操作面

| 能力 | 端点（示意） | 要点 |
|---|---|---|
| 预检 | `POST /api/client/v2/apps/wasm/validate` | 静态 + 真编译 + 干跑；不落版本号、不进审计 |
| 提交新版本 | `POST /api/client/v2/apps/wasm/:app_id/releases` | **同步**：成功才落行；失败回结构化错误（R30） |
| 上下架 | `POST …/wasm/:app_id/publish\|unpublish` | 复用 `apps.enabled`；发布者自主，与审核开关无关 |
| 冻结/导出/删除 | `POST …/wasm/:app_id/freeze` · `GET …/export` · `DELETE …/wasm/:app_id` | R37：冻结 → 只读快照 90 天（管理员可导出）→ 真删并审计 |
| 诊断 | `GET …/wasm/:app_id/diagnostics` | 最近失败与被杀记录（含 guest exit code + stderr 尾） |
| 自省 | `GET …/wasm/:app_id/schema` | 表结构与占用（仅发布者 + 审计） |
| **应用中心** | `GET /api/client/v2/apps/wasm/catalog` | R34：按可见性（R38）过滤后的列表（名称/一句话说明/负责人/入口链接）；**不做安装语义，也不显示额度/用量**（额度只在桌面客户端可见） |
| 运维面 | （webadmin）应用列表 / 下架 / 转移归属 / 冻结 | R23；转移归属必须放开 kind 白名单（现硬写 skill/agent ⇒ 400） |

**审核开关（R17）**：管理后台可配，**默认关**（默认不审 + 事后抽检）。开启时发布进待审队列（线上仍旧版本），管理员在 webadmin 审批；开关变更写审计。

**错误响应格式（第一消费者是 AI）**：

```json
{"error":{"code":"IMPORT_SIGNATURE_MISMATCH",
 "message":"导入符号类型不符",
 "details":{"symbol":"wasi_snapshot_preview1.fd_write","expected":"i32i32i32i32_i32","actual":"i32i32_i32"},
 "hints":["按 skill 提供的 read_request()/write_response() 样板生成代码",
          "编译目标必须是 wasm32-wasip1（Go: GOOS=wasip1 GOARCH=wasm）"]}}
```

**身份语义**：AI 只是编辑器，`publisher` 记**发起操作的员工**；禁止 AI 持共享高权限账号代发。

---

## 9. 语言支持与作者侧

### 9.1 语言矩阵（R39：Tier 1 收敛为 Go）

| 档 | 语言 | 判据 |
|---|---|---|
| **Tier 1（官方支持，进 CI）** | **Go（`GOOS=wasip1 GOARCH=wasm`）** | 单 tarball、免管理员、无额外 target；实测 3.34 MB、导入 17 条、冷启 33 MB |
| 实测可用、不承诺 | Rust（`wasm32-wasip1`，37 KB，需 target 下载 92 s + 1.8 GB 工具链 + 额外导出 `__main_void`）、Zig（8 KB，初始内存 16.4 MiB） | 白名单与样例只维护一份（Go）；这两种语言由 skill 明确标注"可用但不承诺" |
| 不支持 | Python / Java / Kotlin / C# / JS-TS / Swift / AssemblyScript | 工具链只出**组件模型**（wazero 不支持）⇒ 回 `COMPONENT_MODEL_UNSUPPORTED` |

**硬判据**：能产出 `wasm32-wasip1` core module 且导入面（符号 + 类型）落在生成的白名单内。

### 9.2 编译器版本矩阵

平台不做构建 ⇒ "本地过 ≠ 线上过"必须靠契约管理：skill 发布受支持的 Go 版本区间；不匹配时**预检直接拒**并给 hints。

### 9.3 SKILL.md（AI 的操作手册）

- 位置：随客户端分发的内置技能（`skills/picoaide-app-builder/`），**按 frontmatter 整目录同步**（沿用 `memory-evolve/skills/` 的既有语义）
- 结构：小 `SKILL.md`（何时用 + 黄金路径 + 硬约束）+ `references/`（ABI、宿主函数、`limits`、发布、诊断）+ `examples/`（Go 一份，进 CI 真编译，白名单由它 dump 生成）
- **单一真源**：约束表与 ABI 参考**从 `limits.go` / 契约定义生成**（`go generate` 出产物并提交，构建期比对），skill 带 `x-abi-version`
- ⚠️ skill 是**客户可见交付物**：不得出现真实客户域名（用占位符）

### 9.4 作者必须知道的十一条（写进 skill 首屏）

1. 编译目标 **`wasm32-wasip1`**；Tier 1 语言是 **Go**
2. **无状态**：不要用全局变量存用户/会话状态——实例每请求新建
3. **同一应用内所有用户共享数据**（R15）；要区分用户请自己加业务字段
4. **stdout 只用于协议帧**（`RS` + 长度 + JSON）；日志走 `log`
5. **`ai.chat` 是阻塞的**（非流式），UI 要显示等待态
6. **不能联网、不能读文件、不能开线程**；外部资源必须内联（HTML/JS 也编进 wasm，R8/R37）
7. **准入由你自己判**（R24）：配置写在 `picoaide.app.json`（`visible` / `login_required` / `whitelist`），入口第一件事就是读它并比对名单；名单用 `username`/`user.id`；无权限页显示"你的账号：xxx"（平台不校验账号是否存在，拼错只能靠这一步发现）
8. **平台不提供员工名录**（R26）：名单只能手填已知账号；改配置 = 发新版（R25）
9. **不依赖 `$HOME`**：编译器状态目录必须落在会话工作区内（R42；否则沙箱下 Go 会报"标准库不存在"这种指错方向的错）
10. **发布前先本地自测**：Node 内置 `node:wasi` 可零依赖跑通产物（读 stdin 帧、写 `RS` 帧），再走 `validate`
11. **应用名就是域名**（`app_id` → `<app_id>.<应用基域>`）：小写字母/数字/连字符、≤63、不能纯数字、不能 `xn--` 开头、不能是保留字；**一经发布不能改名**（改名等于换域名）

---

## 10. 验证矩阵

> 绝大多数是"期望被拒绝/被限制"；标 **成立 / 不是边界** 的是说明项。**变异验证**：把某条限制改回"无上限"，对应用例必须变红。

### 10.1 越权（红线 1/2/3）

```
1. SELECT * FROM public.users                   → 不可达（平台表在 PG，应用进程无路径）
2. ATTACH DATABASE '<别的应用>/app.db' AS b      → 拒（语句白名单 + SQLITE_LIMIT_ATTACHED=0，**每条连接重设**）
3. SELECT v FROM b.secrets（跨应用读）            → 拒（同上）
4. INSERT …; SELECT …（多语句）                  → 拒（单语句闸门）
5. CREATE TABLE leak(x)                         → 拒（语句白名单禁 DDL；建表只经 db.define）
6. DROP TABLE items / ALTER TABLE …             → 拒（永久禁）
7. VACUUM INTO '/tmp/x'                         → 拒（禁 VACUUM）
8. PRAGMA writable_schema=ON                    → 拒（PRAGMA 一律拒）
9. CREATE VIEW v AS SELECT * FROM items         → 拒（禁 DDL）
10. 应用内跨用户读                                 → **不是边界**（R15），文档/skill 不得宣称隔离
11. 应用 A 的 SQL 读应用 B 的库                     → 拒（文件边界 + ATTACH 双重否决）
12. 连接复用后 database_list 只剩 main          → 成立（每应用一连接 + 每次调用重置）
13. 新建连接是否仍带全套限额                        → 成立（连接钩子；变异测试：去掉钩子必红）
13a. 子域 GET / 或 /portal                        → 404（应用路由树不注册主站路由）
13b. 子域 GET /admin/                             → 404（webadmin SPA 不对子域暴露；它带账密表单）
13c. 子域 GET /healthz                            → 404（存活探测面不对子域暴露）
13d. 子域 GET /updates/client/<资产>、/v1/*、/api/server/*  → 404（主站面一律不注册；allow-list 而非清单）
```

### 10.2 沙箱逃逸（红线 4/5）

```
14. os.Open("/etc/passwd") 等全部文件操作         → DENIED（零 preopen）✅ 已实测
15. ReadDir("/")                                → DENIED ✅ 已实测
16. 任意出站（socket/DNS）                         → 不可达（白名单不含 sock_* + preview1 无 sock_open + host 未监听）✅ 已实测
17. 导入面含 env.* / js.*                         → 上传期拒
18. 导入符号类型不符                                → IMPORT_SIGNATURE_MISMATCH（**编译期不报**，实测）
19. 组件模型产物（layer=1）                         → COMPONENT_MODEL_UNSUPPORTED
20. 自定义段超 4 MiB                               → SECTION_OVERRIDE_OVERSIZE
21. random_get 两次结果不同且非全零                  → 成立（WithRandSource(rand.Reader)）
22. clock_time_get 返回真实时间                     → 成立（WithSysWalltime）
23. args_get / environ_get 读到宿主内容             → 空（不传 args/env）
```

### 10.3 资源耗尽（红线 6）

```
24. 死循环                                        → 10s 后 RUNTIME_TIMEOUT ✅ 已实测
25. 无限递归（栈耗尽）                              → stack overflow error，宿主存活 ✅ 已实测
26. 宿主函数不传 ctx、阻塞 3s                        → 预算失效且 err=nil（实测）⇒ 靠"宿主必须用 ctx + 返回后复检"兜底
27. 内存 grow 超 64 MiB                            → RUNTIME_MEMORY
28. Go 运行时 OOM                                  → RUNTIME_GUEST_EXIT(2)（不得报成 RUNTIME_NO_RESPONSE）
29. 单行输出 1 GiB / 响应体超 8 MiB                  → RUNTIME_OUTPUT_OVERRUN / 拒
30. 数据库写满 100 MB                              → SQLITE_FULL → DB_LIMIT（507）
31. 无界递归 CTE                                   → 运行期 5 s ctx 中断（VDBE_OP 拦不住，实测）
32. 同应用 100 并发请求                             → 队列 32，其余 429
33. 单用户占满队列                                  → 每应用上限 4，超出 429
34. 单用户开 20 个应用同时打                            → 每用户全局在跑上限 4，其余排队/429
35. 编译缓存超 512 MiB 或超条数                        → 磁盘缓存按上限回收（真实体积分布下重测）
36. 上传 30 次/小时 + 同时 1 次编译中                   → 第 31 次 429；并发上传第 2 个被拒
37. 自定义段填满 32 MiB 的垃圾包连续上传                  → 单次编译 CPU 与缓存条目受限（防编译池独占）
38. 应用调 ai.chat 死循环刷额度                        → 使用者自己的余额闸门 + 用户级 60 次/分 + 在途 32（R36：无应用级额度）
38b. 使用者余额不足时调 ai.chat                         → AI_BALANCE_INSUFFICIENT（402，不暴露余额数值）+ 提示"请在客户端查看余额"；不得静默失败或返回 200
38c. 任何浏览器侧页面显示额度/用量                       → 不存在（应用子域/应用中心/门户都无此页面，R36）
```

### 10.4 会话、身份与准入

```
39. 未登录访问 login_required 应用子域                → 302 换票 → 主站登录页
40. 重放 ticket（第二次）/跨应用使用 ticket            → 拒（一次性 + 绑 user+app）
41. 第三方页面 iframe/img 触发 /app-ticket           → 拒（POST + Origin 校验 + next 白名单）
42. 应用 JS 读 document.cookie                     → 空（HttpOnly）
43. 恶意应用代用户调 /api/client/v2/*                → 无凭证可用（host-only + HttpOnly）
44. 应用 A 页面跨源 POST 应用 B                       → 403（子域路由树最外层 Origin 校验）
45. 应用试图伪造帧内 user                             → 无效（帧由宿主构造）
46. macro：员工登出后旧应用令牌                       → 立即失效（按 session 批量吊销）
47. 匿名请求任何路径的响应体含 username                → 拒（`user:null` 分支不得渲染账号，防枚举）
48. 匿名请求打满全局桶                                → 429（全局匿名桶 + 每 IP 桶；代理错配时启动即拒绝）
49. HTTP 访问应用子域（非 https）                     → 不签发 Cookie（Secure fail-closed）
51. 未授权员工打开应用                                → **不是边界**（R24）：请求进 wasm，由应用返回 403
```

### 10.5 发布链路

```
52. app_id 含大写/下划线/连续横线                     → 400 INVALID_APP_ID
53. app_id 不符合域名规则（大写/下划线/首尾或连续连字符/超 63/纯数字/`xn--` 前缀） → 400 INVALID_APP_ID
53b. app_id 是保留字 / 与基域既有主机名冲突              → 400（提示换名字，不得占用企业既有域名）
53c. app_id 已被其他 wasm 应用占用                      → 409 NAME_TAKEN（同 kind 主键保证）
53d. 想给已发布应用改名                                 → 不支持（换域名 = 新建应用；旧应用照 R37 退役）
54. 版本号 1.0（非 x.y.z）/ 不递增                    → 拒
55. 非首版缺 changelog                              → 422 MISSING_FIELD
56. 上传 33 MiB wasm（base64 ≈44 MiB）               → 应用层拒（32 MiB 上限）且错误可读
57. 上传 40 MiB wasm（base64 ≈53 MiB，触 48 MiB）     → 中间件拒且错误可读（不得退化成无指向的 400）
56b. 配置文件缺失 / JSON 非法 / 字段越界                  → APP_CONFIG_INVALID（拒发布）
56c. login_required=true 且 whitelist 为空               → 拒（否则应用对所有人不可用）
56d. whitelist 含不存在的账号                            → **允许发布**（平台不校验，避免账号枚举）；由无权限页显示本人账号闭环
56e. visible=false 的应用                                → 不进应用中心目录；URL 直达仍可用（能否用由应用自己判，R24）
56f. 改了配置但版本号没变                                  → 拒（改配置 = 发新版，R25）
58. 客户端上传超时 < 服务端 ReadTimeout                → 配置断言（limits 单一真源）；>8 MiB 必走分片
59. 编译失败重发同一版本号                            → **成功**（失败不落行，R18）
60. 员工 B 更新员工 A 的应用                          → 拒（owner 检查）
61. 管理员未转移归属前，离职员工的应用                   → 冻结/转移提醒（§11 缺口）
```

### 10.6 受控能力面

```
62. 注册不在 §5.1 清单里的宿主函数                     → 能力清单一致性测试红
63. 手写导入白名单（而非从参考实现 dump）                → 门禁测试红
64. db.define 用非法表名/列名 / 第 17 张表 / 第 17 列    → 拒
65. db.define 指定列类型不在枚举内（如 blob）            → 拒
66. db.define 试图指定主键/索引/触发器                   → 拒
67. SQL 中提到 _row_id                                → 拒（保留列）
68. 应用试图调用不存在的宿主函数（如 db.attach）            → 拒（未注册即不存在）
```

---

## 11. 必须实测的假设与未闭合缺口

> 下列清单是**开工前必须钉死/实测**的项与**已知缺口**，按依赖顺序排列（1–10 阻塞实现，11–15 待实测，16–24 缺口）。

**必须先定/先测（阻塞实现）**

1. **导入白名单由参考实现生成**（先写 Go 样例 → CI 真编译 → dump 导入集）；核对含 `fd_read`
2. **帧格式 + 应用配置文件落到示例代码**：长度前缀 + `read_exact` 样板（三处：宿主实现、skill references、validate 判据）；`picoaide.app.json` 的 schema、发布期抽取、`assets.read` 读取路径与校验规则（含 `login_required=true` 空名单即拒）
3. **迁移一件**：`apps.channel` CHECK 放开 + `kind` 白名单放开（**不新增标识列**：域名标签就是 `app_id`；`api_tokens` 保持现状）。`app_releases.status` **无需迁移**——`0053_apps.sql:45` 的 CHECK 已含 `'pending','approved','rejected'`（2026-09-17 复核），只有引入新字面量才需要动
4. **`kind` 影响面审计**：非测试代码 108 处引用 / 13 文件 + webadmin 6 个前端文件（**计数口径见 §15.2 引用纪律**：换 revision 会变）；**两个**未知值回落点都要加 wasm 分支——`channelLabel`（回落"组织共享库"）与 `kindLabelOf`（回落"技能"，用于官方锁定报错）
5. **host 门控 + 子域路由树 + 子域限体 + 413 可读性**（4 个独立实现点；`/` 与 `/portal` 在 NoRoute 分支）
6. **换票端点改造**（POST + Origin + `next` 白名单 + 票原子消费）
7. **限流重做**：可信代理自检（`PICOAI_TRUSTED_PROXIES`）+ 全局匿名桶 + 每 IP 桶
8. **编译进程隔离**（非特权 + bwrap/landlock + seccomp + 无网络 + env 白名单）与 CPU 配额
9. **内存四笔账联立 + 启动自检**（缓存 + 实例 + 编译峰值 + 上传峰值）
10. **客户端创作链路**（编译编排/上传/分片/状态）与**应用中心页**——客户端侧估 8–15 人日

**技术假设待实测**

11. `wazero.NewCompilationCacheWithDir` 跨进程/重启的实际收益与磁盘占用（含回收策略）
12. 32 MiB 模块（含 4 MiB 自定义段）在 60 s 内编译完成的把握；否则回到分片/异步
13. 64 MiB 实例下"8 MiB 结果 + JSON 序列化"的真实余量（Go/Zig 不同基线）
14. `db.define` 运行期建表在 16 表/16 列上限下的幂等与并发行为
15. 应用子域与主站共 eTLD+1 下的 Origin 校验覆盖率（含 302/307/表单提交）

**已知缺口（未闭合，需排期）**

16. **版本 GC**（保留最近 3 个曾生效版本）与**制品总量配额**（每用户 1 GiB）
17. **离职/转移归属**：`appstore/admin.go:49` 硬写 kind 白名单 ⇒ 现在对 wasm 返回 400；离职钩子（`dirsync.go` / `users.go` 级联）完全不动 `apps` ⇒ owner 悬空
18. **可接手材料**：是否强制随包上传源码或最小重建说明（当前只有二进制 + 用途/负责人字段）
19. **备份与恢复口径**：目标态 = 逐库 `VACUUM INTO` + `pg_dump -Fc`；过渡态 = 停服冷备（现在热 tar 只查"非空"；WAL 模式下只拷 `.db` 会丢数据）
20. **部署文档**：`AI-DEPLOY.md` 需新增应用子域章节（通配证书由企业自备）+ 资源规格（含"与另一渠道栈共用宿主机"的最低内存）+ 前置反代要求
21. **可观测**：`/readyz`（磁盘/队列/缓存水位）+ 低水位拒绝发布 + 排障信息面（编译输出归属、失败详单留存、日志落点）
22. **余额预留扩到既有桌面路径**（同一处 handler，一次做掉更省）
23. **证据探针入库**：§15.2 的数字必须可复跑——本轮已把 3 个复跑探针入库（`docs/evidence/2026-09-17-wasm-app-platform/`）；其余本地探针（`temp/wasm-audit2-sql/`、`temp/wasm-audit2-mem/`、`temp/wasm-redteam/`、`temp/wasm-feas/`、`temp/wasm-crash/`）在实现启动前收敛入库（`temp/` 在 `.gitignore:84`，对任何 clone 都不可见），并给每个数字标注测量基线 commit
24. **编译缓存目录的属主与信任边界**（§4.3.1-d）需拍板：接受风险（写进 §12 认账 + 确认 bwrap/landlock 的可写面只有该目录）还是加校验/隔离方案

---

## 12. 风险登记（认账项）

| 风险 | 影响 | 缓解 / 认账 |
|---|---|---|
| **需求证据为零**（R28 全员自助） | 可能做出无人使用的平台 | **已拍板要做**：以"首个真实应用跑通"作为验收口径；§11 第 10 项（客户端链路）优先 |
| **能力面窄**（无网络/文件/定时/目录） | 部分场景表达不出来 | 认账：通用自动化继续走 skill + 连接器 + cron；本平台只做"共享状态 + 自定义界面 + 一条链接" |
| **32 MiB 上传链** | 客户端 30 s 超时 + 单次 ≈118 MB 峰值 | 客户端超时 90 s + 分片续传 + 自定义段 ≤4 MiB + 启动自检内存账 |
| **平台域名声誉** | 子域可托管任意 HTML/JS（R8/R37） | 宿主强制安全头 + `app_id` 保留字（含企业已知主机名）+ 归属可追溯（发布者实名） |
| **准入在应用侧**（R24） | 未授权员工仍可打开应用、占用队列/CPU；其 AI 花费算使用者自己的额度 | 已认账（R36：谁登录用谁的钱）。如需平台层拦截须推翻 R24 |
| **手填名单易写错**（R26） | 写错即静默拒人（平台**不校验**账号是否存在，以免变成账号枚举接口） | 无权限页强制显示本人账号，让员工把账号报给作者；改名单要走一次发版 |
| **匿名应用**（R25） | 白嫖队列/CPU、账号枚举面 | 全局匿名桶 + IP 桶 + 可信代理自检 + `user:null` 分支禁渲染账号 |
| **工具链与本地自测交给 AI**（R40/R42） | 员工机上装不上/装错工具链，报错指错方向 | skill 必须写死"状态目录落在会话工作区内"并给探测/错误码；平台不背这块 |
| **单实例部署**（R20） | 无 HA；重启丢内存态票/队列/编译缓存；不能水平扩容 | 认账：写进部署文档 + 启动自检禁止多副本 |
| **无托管 schema**（R32） | 应用改结构要自己负责（建新表/加列） | 认账：换来的是没有自动迁移与自动删列的数据销毁风险 |
| **平台无人类运营后台**（R5） | 发布者离职后应用无人能改 | R23 最小运维面（转移归属需先修 kind 白名单，§11 第 19 项） |

---

## 13. 与现有系统的对接

| 复用项 | 现状 | 需要新增 |
|---|---|---|
| 应用与版本 | `apps`/`app_releases`（0053） | `kind` CHECK 加 `wasm_app`（**不新增标识列**：域名标签 = `app_id`，同 kind 内已由主键唯一）；**`apps.channel` CHECK 放开**；`app_releases.status` CHECK 放开审核态；**失败发布不落行**（R30）⇒ 版本唯一约束保持现状 |
| 归属与审批 | `appstore.Publish`（owner 首占、锁定名、跨渠道同名、`PendingCap`） | **入口加 kind 白名单**；新增应用级审核开关（R17，默认关）；publish 载荷增加**应用配置文件**（visible / login_required / whitelist / 用途 / 敏感性 / 负责人，见 §4.2） |
| 员工令牌 | `IssueToken`/`VerifyToken`/`CreateToken` | **无需改表**（R36）：宿主为每个浏览器会话铸一张短时用户令牌、内存持有、登出吊销；`VerifyToken` 保持现状 |
| AI 网关 | `/v1` + `BearerAuth` + `InFlightGuard` | **应用侧零改动**（R36）：宿主用会话级用户令牌走既有路径；仅建议把既有"只判余额 >0、结算在后"的缺口一并修掉（平台自身风险，与应用无关） |
| 路由 | `internal/router` 集中声明 | 应用子域**独立路由树** + **host 门控** + 子域限体 + 最外层 Origin 校验；上传路由进 `largeBodyRoutes` 且 handler 自套限体；补"新增大体积路由必须进白名单"的反向断言 |
| 反代与证书 | `Caddyfile.autocert/manual/internal` | **企业自备通配域名与证书 + 管理员配 Caddy（R29）**；部署文档写前置条件；新增应用基域配置面（不要复用单值的 `DOMAIN`） |
| 数据卷 | `picoaide-data` + `entrypoint.sh` 启动 `chown` | 新增 `apps/`（库 + assets + 编译缓存）；`chown -R` 收敛为"只处理新增顶层"或改一次性初始化（失败不得静默 `|| true`） |
| 审计 | `AuditLog(db, username, action, detail)`（单 worker 同步阻塞，最坏 25 s） | 高频项异步化；`audit_logs.app_id` + 索引（哈希链版本化）；调用事件独立表（7 天） |
| RBAC | 资源类别级 | 沿用粗粒度点 + 应用层 owner 比较；不造实例级权限点 |
| **员工浏览器会话**（R16） | **不存在**（`picoaide_session` 是管理员专属；员工只有 Bearer） | 员工会话表 + 登录页（账密 + OIDC）+ 登出 + 会话绑定吊销 + **Origin/CSRF 校验**（员工面现为零）；换票端点按 §4.7 改造 |
| **编译进程**（R19/R31） | 不存在 | 独立进程 + wazero 磁盘缓存 + 队列 + 超时取消 + 结果回传 + **OS 级隔离** |
| **限流** | `callLimiter` 未导出；`PICOAI_TRUSTED_PROXIES` 可选 | 全局匿名桶 + 每 IP 桶 + 启动自检 |
| **客户端** | 无编译/上传/应用中心 | 应用中心页 + 编译编排 + 分片上传 + 状态展示（估 8–15 人日） |
| **运行时依赖** | `server/go.mod` 无 wazero、无纯 Go SQLite 驱动；`CGO_ENABLED=0` 且无 vendor | 新增 `github.com/tetratelabs/wazero` + `modernc.org/sqlite` |

---

## 14. 参考

- 实测探针（**已入库，可直接复跑**）：`docs/evidence/2026-09-17-wasm-app-platform/`——`cache-key/`（缓存键敏感性与命中）、`random-get/`（默认随机源）、`vacuum-into/`（`VACUUM INTO` vs `LIMIT_ATTACHED`），各目录带重跑命令
- 实测探针（**本地，未入库**，收敛要求见 §11 第 23 项）：`temp/wasm-audit2-sql/`（SQLite 隔离与限额语义）、`temp/wasm-audit2-mem/`（wazero 内存与 Go wasip1 导入面，含 `parse-wasm.py`）、`temp/wasm-redteam/`（签名不匹配、自定义段放大、内存声明）、`temp/wasm-feas/`（三语言工具链与 Node WASI 本地预览）
- 权威依据：[SQLite run-time limits](https://www.sqlite.org/c3ref/limit.html) · [wazero CompilationCache](https://github.com/tetratelabs/wazero/blob/v1.12.0/cache.go) · [Cloudflare Durable Objects 规则](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

---

## 15. 设计不变量与实测依据

### 15.1 不可删减项（看着"多余"，实为安全边界或结构性前提）

| # | 不变量 | 一句话理由 |
|---|---|---|
| 1 | wazero 五项显式注入（`WithCloseOnContextDone` / `WithRandSource(rand.Reader)` / `WithSysWalltime` / `WithSysNanotime` / `WithNanosleep`）+ 零 preopen | 默认值就是危险值：随机源是**固定种子 42 的确定性伪随机**（跨独立实例完全一致）、时钟是 2022-01-01、取消不生效、preopen 下挂载点全可读；其中 `WithRandSource`/`WithSysWalltime`/`WithSysNanotime`/`WithNanosleep` 是 **ModuleConfig（每请求设）**，`WithCloseOnContextDone` 是 RuntimeConfig（编译/执行两侧必须一致，§4.3.1） |
| 2 | host 门控 + 应用子域独立路由树（allow-list） | 全仓 Go 代码**零 host 维度判断**、主站路由只按 path 注册（`/`、`/portal`、`/admin/*` 在 NoRoute 分支、`/healthz` 在根引擎）⇒ 没有门控时每个子域都会渲染门户与**管理台登录页** |
| 3 | `SameSite=Strict` + `Origin == 自身源` | `<a>.<基域>` 与 `<b>.<基域>` 同站，Lax 挡不住跨源写（表单 + `text/plain` 免预检） |
| 4 | 每条连接重设 `max_page_count` 与全部 `SQLITE_LIMIT_*` | 二者都是连接级且不持久：新连接读回默认值 ⇒ 漏设即**静默**失去 100 MB 上限与 ATTACH 否决 |
| 5 | 禁 `VACUUM INTO` 与全部 DDL | DDL 会绕过宿主托管的表结构；`VACUUM INTO` 与 `ATTACH` **同受 `SQLITE_LIMIT_ATTACHED` 约束**（实测 =0 时一起被拒）⇒ **真正的闸门是"每条连接重设 `LIMIT_ATTACHED=0`"**（第 4 条），显式禁它是纵深：该限额一旦漏设，两者会同时复活 |
| 6 | 宿主函数必须传 ctx + 返回后强制复检 | 宿主不传 ctx 时 guest 预算完全失效，且 `Call` 返回 `err=nil`（失败被报成成功） |
| 7 | `err=nil` 但 module 已关闭 / 无响应帧 ⇒ 必须映射 `MODULE_KILLED`/`RUNTIME_NO_RESPONSE` | 静默失败的唯一兜底，绝不返回 200 |
| 8 | 帧内 `user` 由宿主构造 + 子域 host-only/HttpOnly Cookie | 红线 3（应用拿不到平台凭证）的落地；身份只有这一条来源 |
| 9 | 单实例启动自检（advisory lock + 内存/磁盘水位） | 多副本的失败形态是静默的（票在 A 签发、B 兑换失败） |
| 10 | `is_publisher` + 无权限页显示本人账号 | 平台不提供员工目录（R26）后，作者校验名单拼写的唯一闭环手段 |
| 11 | 干跑 + 导入签名校验 | **编译通过 ≠ 能跑**：签名不匹配的导入编译期全绿、实例化才炸 |
| 12 | 换票端点 POST + Origin + `next` 白名单 | 否则是登录 CSRF + 开放重定向 |
| 13 | 宿主写 CSP / nosniff / frame-ancestors（含 4xx/5xx） | 应用子域是公司域名下的任意 HTML/JS 宿主（R8/R37） |
| 14 | 编译进程 OS 级隔离 + env 白名单 | 唯一"读不可信字节且能写宿主"的进程，也是唯一可能触碰红线 1/3 的路径 |

### 15.2 关键实测依据（本机，Go 1.26.5 / wazero v1.12.0 / modernc.org/sqlite v1.55.0 / 4 vCPU）

| 项 | 实测值 | 它支撑了哪条设计 |
|---|---|---|
| Go wasip1 模块冷编译 | 2.48 MiB → **1.27–1.69 s**；3.34 MiB → 同量级 | 同步 publish 与 60 s 编译预算（R30/R31） |
| 实例化 + `_start`（含 Go 运行时） | **10.6 ms**（空跑）/ 106.9 ms（8 MiB 堆） | "每请求新实例"可行（§4.3） |
| Go wasip1 导入面 | **17 条 / 16 个不同名**（含 `fd_read`，`fd_write`×2） | 白名单必须由参考实现生成、判据含类型（§4.2） |
| 导入签名不匹配 | `CompileModule err=nil` → `InstantiateModule signature mismatch` | 干跑是必需闭环，不是优化（§4.2/§7.4） |
| 自定义段填充 | 2.48 MiB 模块填到 32.48 MiB 仍编译成功；RSS **+34 MiB**、编译 1.78 s，功能为零 | 自定义段 ≤ 4 MiB（§4.2） |
| `max_page_count` 持久性 | 重开文件/新连接读回 **4294967294**（≈16 TiB） | 每条连接重设（§4.5） |
| `SQLITE_LIMIT_ATTACHED=0` | 生效：`too many attached databases - max 0` | 引擎层否决 ATTACH（§4.5） |
| 无界递归 CTE vs `VDBE_OP` | 递归 CTE 仅 **32 条指令** ⇒ limit 不拦；ctx 取消 **3.00 s 准时中断** | 运行期 ctx 才是主闸门（R13/§4.5） |
| Go 堆与实例上限 | 常驻 8 MiB 堆在 16 MiB 上限下余量仅 ~7 MiB；24 MiB 堆 OOM（`proc_exit(2)`） | 64 MiB/实例（R22）；OOM 映射 `RUNTIME_GUEST_EXIT`（§7.4） |
| Zig 初始内存 | **16.4 MiB**（工具链默认，平台设不了） | 语言差异写进 skill；validate 给软提示（§9） |
| Node 24 内置 `node:wasi` | 零新增依赖跑通 Go/Rust/Zig 产物（读 stdin 帧、写 `RS` 帧） | 本地预览放 skill（R40/R42、§9.4 第 10 条） |
| 既有上传链路 | 客户端大上传 `timeoutMs: 30000`；服务端 `ReadTimeout 60 s`；base64 单次峰值 ≈118 MB | 客户端超时 90 s + 分片 + 内存四笔账（§4.2/§4.3） |
| 部署基线 | AI-DEPLOY 建议 ≥4 核 / 8 GB / 50 GB；内存四笔账峰值须启动自检 | §4.3 启动自检 |
| **编译缓存键敏感性** | 只改 `WithMemoryLimitPages(1024)` ⇒ **同一键命中**（`429b279e…`）；只改 `WithCloseOnContextDone(true)` ⇒ **换键**（`68689fd7…`，条目 10.06 → 10.51 MiB） | §4.3.1-a（两侧 RuntimeConfig 必须一致） |
| **默认随机源** | 三个独立 Runtime 的 guest 首读**完全相同**（`dfd79b4d76429b61`）；注入 `rand.Reader` 后互不相同 | §4.3 随机源；§10.2 第 21 项判据 |
| **`VACUUM INTO` vs `LIMIT_ATTACHED=0`** | 被拒（`too many attached databases - max 0`，目标文件不生成）；去掉限额即可写文件（modernc v1.55.0 / v1.59.0 一致） | §15.1 第 5 条；§4.5 连接级限额 |
| **编译缓存收益与体积** | 冷编译 1.92 s → 命中 **86 ms（22×）**；条目 **10.06 MiB** / 模块 2.76 MB（≈3.7×；开启 `WithCloseOnContextDone` 后 10.51 MiB） | §11 第 11 项（跨进程/重启收益与占用） |

> **测量基线与引用纪律（2026-09-17 复核）**：上表数字在该日的工作区复测，其中带 `file:line` 的引用**会随提交漂移**——同一份文档在 master 与分支上就出现过 `auth-gate.ts`、`router.go`、`AppKind` 计数三处不一致。**以符号/命令为准，不写死行号**；新加数字必须标注测量基线 commit。已入库探针见 §14。

复跑姿势：**已入库** `docs/evidence/2026-09-17-wasm-app-platform/`（`cache-key/`、`random-get/`、`vacuum-into/`，每个目录一条命令）；**本地未入库** `temp/wasm-audit2-sql/`（隔离与限额）、`temp/wasm-audit2-mem/`（内存与导入面，含 `parse-wasm.py`）、`temp/wasm-redteam/`（签名/段/内存声明）、`temp/wasm-feas/`（三语言与 Node WASI）。依赖锚定 Go 1.26.5 / wazero v1.12.0 / modernc.org/sqlite v1.55.0（`VACUUM INTO` 一项另在 v1.59.0 复核）；任一本地 Go 模块缓存都可作 `GOMODCACHE`（例如 `temp/wasm-crash/gomodcache`）。


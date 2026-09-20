# WASM 应用平台：作者指南

> 面向**员工与 AI** 的完整作者指南。设计基线见
> `docs/planning/2026-09-17-wasm-app-platform.md`；AI 的操作手册（随服务端镜像分发）
> 见 `server/skills/app-builder/`。
>
> 平台里的每一个上限数字都来自唯一真源 `server/internal/wasmapp/limits/limits.go`
> （生成物 `limits.md` / `limits.json` 由 `go generate ./internal/wasmapp/limits` 产出，
> 门禁逐字节比对）。本文件不重复抄数字的权威性 —— 有疑问以生成物为准。

## 1. 一句话

**员工写一个小程序，编译成 WebAssembly，上传到平台；应用只在桌面客户端内打开
（应用中心点开，或点开别人分享的深链），由客户端把它转发到平台执行。**

平台的设计原则是**"不给自由度，只给铺好的路"**：能用的能力是一张封闭清单，
超出的部分不是"没开权限"，而是**在平台里不存在**。这样"写错"的形态会被压到很少几种。

两条使用路径：

- **让 AI 写**（推荐）：客户端的 AI 会加载内置技能 `app-builder`，
  按黄金路径生成代码、本机编译、调用平台接口发布。
- **自己写**：照本文件 + 内置技能的 `references/`（ABI、limits、发布、诊断）即可，
  语言是 Go（`wasm32-wasip1`）。

### 1.1 访问方式与两条硬限制（动手之前先读）

- **只在桌面客户端内打开，没有浏览器地址**：平台不再给应用分配任何域名，也不签发
  应用证书 —— `<app_id>.<任何域名>` 这种地址**不存在**。可分享的形态只有**深链**
  `<渠道 deep link scheme>://app/<app_id>`（scheme 由客户端渠道配置决定，同一份应用在不同
  渠道的客户端里可能不同，**不要写死某个 scheme**）。应用在客户端里的 origin 是
  `<渠道 app 源 scheme>://<app_id>`，每个应用一个 origin（official/beta 客户端的取值才是
  `picoaide-app`）；两个 scheme 都能由客户端本机只读路由
  `GET /api/pico/wasm-apps/channel` 得到（`{appOriginScheme, deepLinkScheme, productName}`），
  拿不到时**不要编链接**。
- **一律要求登录**：平台没有匿名面，每个请求都带已登录的使用者身份。
- **不能主动发起网络请求、不能读文件**（⚠️ **不要对外说成"不能联网"**）：沙箱与 CSP
  挡住的是**应用自己发起的 `fetch`/`XHR` 型请求**（`connect-src 'self'` 只允许回自己的
  origin）；但 **CSP 不约束顶层导航与弹窗** —— 应用页可以用 `location.href='https://…'`
  把数据带出去，导航/弹窗由客户端窗口闸门与外链策略兜底（§2.1c 末、总纲 §6/§7.2）。
  也没有文件系统语义；HTML/CSS/JS/图片等外部资源必须编进 wasm（§2.1、§2.1b）。
- **不能用 cookie**（⚠️ 单平台实测）：自定义协议下 cookie **完全不可用** —— 页面的
  `document.cookie` 恒为空、服务端 `Set-Cookie` 不会落盘。要保存状态请放进**应用库**
  （`db.define` / `db.query` / `db.exec`）；登录态由宿主在每一帧里交给你（§3），
  不要自己存会话。存储可用性清单见 §1.2。

### 1.2 存储可用性对照表（**动手选存储之前必读**）

同一份数据放哪里，决定了它**会不会被清掉**。自定义协议 origin 下的浏览器存储**不是全都可用**：

| 存储 | 可用性 | 隔离与生命周期 | 怎么用 |
| --- | --- | --- | --- |
| 服务端**应用库**（`db.define` / `db.query` / `db.exec`） | ✅ **权威状态放这里** | 每应用一个库、按应用隔离；**不会**随客户端清缓存或切换账号被清；跨设备一致（登录同一账号即可见） | 业务数据、名单、用户设置等**一切需要留存的东西** |
| `localStorage` | ✅ 可用 | 按 **origin**（= 每个应用自己的 `<app scheme>://<app_id>`）隔离；**随客户端清缓存 / 切换账号被清** | 可再生的界面偏好（折叠状态、上次筛选） |
| `sessionStorage` | ✅ 可用 | 同上，且随窗口/会话结束消失 | 单次打开的临时态 |
| `IndexedDB` | ✅ 可用 | 按 origin 隔离；**随客户端清缓存 / 切换账号被清** | 体积较大的**可再生素材**缓存（图片、离线数据副本） |
| **`Cache Storage`（`caches.open` / Service Worker 缓存）** | ❌ **不可用，禁止依赖** | — | `caches.open()` 本身会成功，但写入必失败：`cache.put(new Request('<app scheme>://<app_id>/…'), …)` 抛 **`TypeError: Failed to execute 'put' on 'Cache': Request scheme '<app scheme>' is unsupported`** ⇒ 不要在自定义协议 origin 上用 Cache Storage，也不要用它做"离线优先" |
| `document.cookie` / `Set-Cookie` | ❌ **完全不可用** | — | `document.cookie` 恒为空、服务端 `Set-Cookie` 不落盘（§1.1） |

两条硬结论：

- **要留存 → 放应用库**（`db.*`）；浏览器存储只当**可再生的缓存**用，随时可能被清，丢了要能重建。
- **不要写"离线优先"**：没有 Service Worker 缓存这条路（Cache Storage 不可用），外部资源一律编进 wasm 包（§2.1b）。

> ⚠️ **可用性证据强度（如实认账）**：上表结论来自 **Linux / Electron 43.4.0 单平台、单次运行**的实测（`Cache Storage` 的失败形态已最小复现）；**Windows / macOS 尚未复核**（总纲 §17 认账 1）。三平台复核前，不要把"可用"当成跨平台承诺 —— 关键路径请以应用库为准。

## 2. 能做什么 / 不能做什么

### 2.1 全部原语（封闭清单）

| 原语 | 用途 | 固定约束 |
| --- | --- | --- |
| `db.define(table, columns[])` | 建表（平台代执行，重复调用幂等） | 表名/列名 `^[a-z][a-z0-9_]{0,30}$`；列类型枚举 `text/int/real/bool/datetime`；列不超过 16、表不超过 16/应用；**不能指定主键/外键/索引/触发器** |
| `db.query(sql, args)` | 单条 `SELECT` | 单语句；值用 `args` 占位（**平台不检查你是否参数化**，见 §10）、受 `SQLITE_LIMIT_*` 约束、最多返回 5000 行 / 8 MiB |
| `db.exec(sql, args)` | 单条写语句 | 仅 `INSERT`/`UPDATE`/`DELETE`；禁 DDL |
| `db.tx` | 事务 | ABI 层是 `tx_begin`/`tx_commit`/`tx_rollback`；事务内**只允许数据库读写**（`db.query`/`db.exec` + 两个出口），`log`/`assets.read`/`db.define` 与嵌套 `tx_begin` 一律拒；超时 5 秒强制回滚 |
| ~~`ai.chat(messages, model?)`~~ | **已删除（2026-09-19）** | 它从来不是 WASI 导入，而是 stdout 上 JSON-RPC 的宿主方法名（平台也不反编译产物）⇒ 老产物**能通过发布校验**，直到**运行期第一次调用**才失败（`code = "NOT_FOUND"`、message 逐字 `未知的宿主方法: ai.chat`）。应用里的 AI 改走**客户端 AI loop**：应用前端 JS 调保留路径 `POST /__picoaide/ai/chat`（客户端本地处理，不经服务端），再见 §2.1c |
| `log(level, msg)` | 写日志 | 单条不超过 4 KiB；每请求最多 100 条；超出丢弃并计数 |
| `assets.read(path)` | 读随包资源 | 资源 = wasm 的**自定义段**（运行期由宿主解析后常驻内存，不落盘）；无文件系统语义、不能穿越；结果用 `encoding` 判别负载（`text` / `base64` / `empty`） |

**没有任何其他能力**：无文件、无网络、无线程、无子进程、无环境变量、无 `PRAGMA`、
无 `ATTACH`、无 DDL、无扩展加载；**也没有任何 AI 能力**（宿主方法 `ai.chat` 已于 2026-09-19 删除，
要 AI 走 §2.1c 的客户端 AI loop）；**也没有任何员工名录能力**（不列举、不搜索、不点查）。

#### 包内资源的可见性（**写机密之前必读**）

`assets.read` 读到的资源**默认不对外公开** —— 它按包内逻辑路径在宿主内存里查（资源来自
wasm 的自定义段，不落盘），没有文件系统语义，也没人能从外面列目录。

**唯一例外是"非保留资源"**：`picoaide.app.json` 之外的一切包内文件（HTML/JS/CSS/
图片/字体/数据文件）会被宿主**按路径直出给任何能打开应用的人**（这正是"静态资源
编译进 wasm"的用法，也是平台能把静态响应缓存起来的依据，§4.2/§4.6）。

因此：

- **不要把机密、账号名单、内部说明、口令、内网地址写进非保留资源** ——
  `GET /data/users.json` 这类请求，任何能打开这个应用的人都能拿到，与 `access` 无关
  （登录只决定**谁**能打开应用；能打开的人在应用内取非保留资源仍然是直出）。
- **名单放 `picoaide.app.json`**：它是平台保留资源，**不会被直出**；应用自己用
  `assets.read("picoaide.app.json")` 读它，读不到的访问者只会拿到应用自己的
  （404/403）页面。
- 包内资源是**不改名、不发新版就改不掉**的：要改内容必须发新版本（§4.2）。

#### 把静态资源编进包里：用官方打包器

"把 HTML/CSS/JS 编进 wasm"是**一等用法**，但自定义段的二进制格式（段名 = 包内逻辑路径，
段长度前缀是 LEB128 且**必须含段名的长度前缀与段名本身**）不该由作者手拼 —— 技能目录里
带了官方打包脚本：

```bash
node scripts/pack-assets.mjs --in app.wasm --out dist/app-packed.wasm \
  web/index.html=index.html web/app.css=static/app.css
```

- 位置：`server/skills/app-builder/scripts/pack-assets.mjs`（随技能一起分发到
  `<dshHome>/skills/app-builder/scripts/`），用法与全部规则见同目录 `README.md`。
- `SRC=DEST`：`DEST` 就是**包内逻辑路径**（段名）；规则与平台同源（相对、以 `/` 分隔、
  不含 `..` 与 `:`；整条路径不超过 256 字节、单段不超过 255 字节；自定义段总量不超过 4 MiB）。
- **`--out` 必填且必须是新路径**：脚本绝不就地覆盖输入（原模块要留着继续编译/重打包；
  顺带一提，`go build -o 已存在文件` 不截断旧文件、会留尾部垃圾，编译产物也别就地覆盖）。
- **保留资源不能这样加**：`picoaide.app.json` 由平台在发布期写入（内容 = 随包提交的
  `config`），模块里的同名段会被平台忽略 —— 脚本会直接拒绝，别把名单塞进这种会被直出的资源。

### 2.1b 页面怎么产出：静态前端 + JSON API（模板是例外用法）

**默认形态是前后端分离**：`web/index.html` + `web/app.css` + `web/app.js` 打进包里当静态资源，
**宿主按路径直出**（§2.1 的直出规则与 `references/abi.md` §3.7）；wasm 只回 JSON。
入口文档（`/`、`/index.html`）**由 wasm 自己答**（先判名单，再 `assets.read("index.html")`
作为响应体）—— 名单判定在应用手里，宿主对入口一律不直出。

`html/template` / `text/template` **仍然被放行**（导入白名单由参考实现**真编译取并集**生成，
已覆盖模板渲染所需的导入面：`Execute`、`(*os.File).ReadAt/WriteAt` 等），有服务端渲染需求时
（例如导出 HTML 报表）照常用，不需要特批。

注意两点：
- 模板内容与数据都在你的 wasm 里，渲染结果通过响应信封回给宿主 —— **没有**服务器端模板引擎；
- 白名单是 Go 工具链相关的：升级 Go 版本后若出现 `IMPORT_NOT_ALLOWED`，多半是新的运行时导入面，
  按错误里的 `details.symbol` 报给平台管理员（平台会重跑白名单生成器）。

### 2.1c 应用里的 AI：**客户端 AI loop**（wasm 里没有 AI）

**服务端不再向应用提供 AI 能力**（宿主方法 `ai.chat` 已于 2026-09-19 彻底删除）。
它**从来不是 WASI 导入**，而是 stdout 上 JSON-RPC 的宿主方法名；平台也**不做反编译**
⇒ 仍调它的老产物**会通过发布校验**，直到**运行期第一次调用**才失败：
JSON-RPC error `code = "NOT_FOUND"`、message 逐字 **`未知的宿主方法: ai.chat`**
（纵深还有一条 `HOST_METHOD_UNKNOWN`，它的 hints 会列出可用能力）。

要在应用里用 AI，改成「**前端调 AI → 结果回传 wasm 落库**」（权威链路叫 **客户端 AI loop**）：

```
应用页面（前端 JS）                      wasm（后端）
  fetch('/__picoaide/ai/chat')  ─┐
    POST {messages, stream}      │  ①保留路径：宿主协议 handler **本地**处理，绝不转发平台
    ← SSE delta… / done          │  ②首次授权闸门（用户 × 应用）→ 隐藏会话 app:<app_id>
  ───────────────────────────────┘     ③桌面客户端跑一轮 ctx.agentLoop（工具集为空）
  把生成结果 POST 回你自己的页面路由 ──▶ ④wasm 落库（db.exec）
```

冻结契约：

| 项 | 口径 |
| --- | --- |
| 端点 | `POST /__picoaide/ai/chat`（**保留路径**，宿主协议 handler 本地处理，不经服务端） |
| 请求体 | `{messages:[{role, content}], stream:bool}`；未知字段拒；`messages` ≤ 64 条、单条正文 ≤ 16 KiB |
| 非流式响应 | `{content, usage?}` |
| 流式响应 | `text/event-stream`：`delta` 事件增量推送，`done` 收尾（失败给 `error` 事件） |
| 错误 | 一律 JSON 信封：`app_ai_denied`(403) / `app_ai_unavailable`(503 或 401 未登录) / `app_ai_invalid`(400·405·413) / `ai_balance_insufficient`(402) / `ai_rate_limited`(429) / `ai_cancelled`(499) |
| 形态 | **仅对话**：无工具、无文件、无连接器、无记忆、无用户历史；上下文只有你这次传的 messages |
| 会话 | **每应用一个隐藏会话** `app:<app_id>`（支持多轮上下文；不出现在侧边栏，诊断里可查） |
| 系统提示 | **平台统一注入一条固定系统提示**，并且**不注入记忆、不注入用户的历史会话** |
| 计费 | 使用者本人的既有 LLM 链路（扣他自己的余额）+ 平台统一默认模型 |
| 归因 | ⚠️ **应用维度用量归因尚未接通**（客户端不出站 `X-Pico-App-Id`）⇒ 不要承诺"应用详情页能看到 AI 用量"；只有管理端 webadmin 的应用中心看板，且无归因数据时显示「统计尚未上线：暂无应用归因」 |
| 用户授权 | **首次调用授权一次**（按 用户×应用 记录；**撤销入口只有应用详情页的 AI 面板里那个按钮**，设置页里没有） |
| 预设 | **应用不能**声明提示词/模型/温度 —— 平台统一给 |
| 并发与超时 | AI 桥**没有自己的超时预算**（宿主给普通应用请求设的那条预算对它不适用）；唯一边界是页面关闭/导航离开触发的 abort 与下游 LLM 链路；并发按**隐藏会话串行**（第二个请求排队，不是被拒绝） |
| 后台调用 | **仅前台**：应用页面关闭即取消，不存在无人值守跑 AI 的通道 |
| 保留前缀 | 整个 `__picoaide/` 是宿主保留命名空间：其余路径一律 404、**绝不转发平台**；**随包资源不得占用该前缀**（发布期 `ASSET_DENIED` + `details.reason = "reserved_path_prefix"`） |

三条要点：

- **wasm 侧看不到 AI**：帧里没有 AI 方法，也没有 AI 令牌；AI 只在前端发生，结果由前端自己
  传回你的页面路由。别指望在 wasm 里"调一下模型"。
- **不要自己在前端存会话历史**：需要多轮就把历史随 `messages` 一起传（隐藏会话本身也维护上下文，
  但**只有你这次传的 messages 会进模型**）。
- **额度与限流错误要可读地呈现**：`ai_balance_insufficient` / `ai_rate_limited` 给使用者一句
  可读提示（"请在客户端查看余额 / 稍后重试"），不要静默失败，也不要在页面上重试轰炸。

### 2.2 从作者视角看"不能做"

| 想做的事 | 现实 |
| --- | --- |
| 调用外部 API / 抓取网页 / 加载 CDN | 应用自己发起的 `fetch`/`XHR` 一律被拦（`connect-src 'self'`）；**但这不等于"不能联网"** —— 顶层导航/弹窗不受 CSP 约束，别把它当数据外带防线 |
| 在 wasm 里直接调 AI（老写法 `ai.chat`，**该宿主能力已删除**） | 服务端已无 AI 能力，且平台不反编译产物 ⇒ **发布校验不会拒**，运行期第一次调用才失败（`NOT_FOUND` + `未知的宿主方法: ai.chat`）。改走 §2.1c 的客户端 AI loop（前端调 AI → 结果回传 wasm 落库） |
| 读写服务器文件 / 用户磁盘 | 不可能：没有文件系统 |
| 用 Python / Node / Java 写 | 不支持：只产出 `wasm32-wasip1` core module（Go 是 Tier 1） |
| 用 `document.cookie` 保存状态 | 无效：自定义协议下 cookie 完全不可用（`document.cookie` 恒为空、`Set-Cookie` 不落盘）—— 状态请放应用库（`db.*`） |
| 以为应用有一个可以贴到浏览器里的地址 | 没有这种地址：应用只在桌面客户端内打开；可分享的形态是深链 `<渠道 scheme>://app/<app_id>` |
| 用全局变量存会话状态 | 无效：实例每个请求新建 |
| 让每个用户只看自己的数据 | 平台不做行级隔离：同一应用内数据全员共享（要区分就自己加一列存 `user.username`） |
| 运行期改配置 / 改准入名单 | 不行：配置随包，改动 = 发新版本 |
| 给应用调并发 / 加缓存旋钮 | 作者不可调（**运维可在控制台改**）：同一应用默认最多 **4 个请求并发**（读并发；**写仍串行**），但**单个用户在同一应用内默认只有 1 路**（`user_per_app_running=1`，自测时用同一账号看不到 4 路是排队规则、不是平台串行）；队列 32、占槽 4、全局实例 32 都是**默认值不是固定值**（控制台「应用中心 → 限制项」可改，队列上限 4096、全局实例上限 256）；缓存无参数 |
| 指望平台自动迁移表结构 | 没有自动迁移：加字段请用新表名或新列并自己搬数据 |

### 2.3 平台保留列

| 列 | 说明 |
| --- | --- |
| 内部行号列（应用不可见） | 平台主键。**应用提到它即拒**：`db.define` 不接受、SQL 里出现即 `DB_DENIED` |

## 3. 应用契约（ABI）

完整参考（帧格式 / 请求帧字段 / 每个宿主调用的参数与结果 / 响应信封 / 判别规则 /
计时规则 / 失败语义表）在：
`server/skills/app-builder/references/abi.md`

三条最先要记住的：

1. **帧格式**：`RS(0x1e) + 十进制长度 + '\n' + UTF-8 JSON`；长度是 JSON 的**字节数**；
   读取方必须一次读满；**stdout 上非 `RS` 开头的内容一律被当日志**。
2. **身份在每一帧里**：`user` 字段由宿主构造（`id`/`username`/`display_name`/`dept`/
   `is_publisher`），应用拿不到 Cookie、令牌或名单，也无法伪造（自定义协议下
   `document.cookie` 本来就是空的）。
3. **两类帧靠顶层字段判别**：含 `jsonrpc` ⇒ 应用在调宿主；含 `status` ⇒ 最终响应信封。

## 4. 应用配置文件 `picoaide.app.json`

随发布提交（不计入 wasm 体积上限，本身不超过 64 KiB）：

**字段规格（字段名 / 类型 / 必填 / 取值 / 上限）只在生成物里维护，本文件不复制那张表**：

- 机器可读：`server/internal/wasmapp/appcfg/appcfg.json`
- 人读（同一份内容）：`server/skills/app-builder/references/app-config.md`
- 单一真源（改字段只能改这里）：`server/internal/wasmapp/appcfg/appcfgspec.go`

三份由同一个生成器产出（`go generate ./internal/wasmapp/limits`），构建期逐字节比对；
发布载荷（`app_id` / `version` / `title` / `changelog` / `wasm_base64` / `config`）的字段规格
在同一份生成物里。

语义要点（字段表里没有的部分）：

- `access` 写侧两选一：`login`（要求登录，**登录后全员可用**，缺省）/
  `whitelist`（要求登录 + 名单准入）。历史配置里的 `public` 在**读取侧按 `login` 处理**
  （旧应用照常可用，但新版本不得再写 `public`）；平台**没有匿名面** —— 每个请求都带
  已登录的使用者，帧里的 `user` 永远是对象。
- `access="whitelist"` 且 `whitelist` 为空 ⇒ 拒绝发布（那种应用对所有人不可用）；
  `access="login"` 时名单为空是合法的（"登录后全员"）。
- **应用中心只按"冻结/删除"过滤，不按权限、也不按下架过滤**：列出全部**未删除、有生效版本、且未被冻结**的应用
  —— **已下架的应用仍然列在目录里**，只是带「已下架」标记（**冻结不列**）；条目里给出访问级别与上下架状态。
  **没有"隐藏应用"这种模式** —— 不想给人用就设 `whitelist` 并只填该给的人。产品级口径见下节。
- **准入判定在应用自己里做**（平台不比对名单）；改任何一项都要发新版本。
- **打开方式**：发布后没有"应用地址"这种交付物 —— 给同事的是深链
  `<渠道 scheme>://app/<app_id>`，日常使用则在客户端「应用中心」里点开。

#### 员工侧会看到什么（**产品级口径**；作者据此设计文案与排障话术）

| 场景 | 员工看到 |
| --- | --- |
| **应用被冻结**（管理员停用） | **不再出现在应用中心**；但**已有深链/历史记录仍能打开**，此时给的是**可辨文案「已被管理员停用」+ 联系负责人** —— **不是**"应用不存在" |
| **应用被下架**（作者自己下架） | **仍列在目录里**，条目带「已下架」标记；直接打开 ⇒ 「已下架」（与冻结是**两句不同的话**，不得塌缩） |
| **应用被删除** | 直接打开 ⇒ 「应用不存在」 |
| **不在我的权限内**（`whitelist` 未命中） | 应用**照常出现在目录里**（权限不参与目录过滤）；点开由**应用自己**返回 403 |
| **目录没有可用项** | ①**一个应用都没有** ⇒ 引导"让 AI 做一个"；②**列表非空但每一行都是已下架** ⇒ 给"全部已下架"那一档提示（说明原因）。⚠️ "目录里全是冻结"**结构性不可达** —— 冻结不进目录，冻结只在深链/历史入口遇到（那时给「已被管理员停用」页） |
| **应用很多** | 支持按**名称 / 一句话说明 / 负责人**搜索，以及「**我发布的**」筛选；条目多时分批展示，不一次全渲染 |
| **打开计数** | 应用详情/应用中心会显示「**今日已被打开 N 次**」，隐私说明里写明"平台记录打开次数用于运营" —— 这是**运营口径**，不要在自己的页面里重复造计数 |

> 排障提示：员工报"我的应用不见了"时，先分清是**被冻结**（管理端动作，**目录里真的不见了**、深链仍可开、文案是「已被管理员停用」）、
> **被下架**（作者动作，**目录里还在**、只是带「已下架」标记，点开文案「已下架」）还是**权限不符**（应用仍在目录里，点开是 403）—— 这三者的处置完全不同。

#### 窗口字段 `window.*`（**本版新增；字段表真源缺失时以本节为准**）

| 字段 | 类型 | 必填 | 取值与语义 |
| --- | --- | --- | --- |
| `window.ratio` | 字符串 `"W:H"`（如 `"16:9"`）或浮点数（如 `1.7778`） | 否 | **强制锁定**的宽高比：客户端窗口 resize 时按比例约束，用户不能拉成别的形状。**合法区间 `0.25`–`4.0`**；越界（含 `0`、负数、非数字）⇒ **发布期直接拒**，`APP_CONFIG_INVALID`（附 `details` 指名该字段） |
| `window.width` / `window.height` | 数字（像素） | 否 | 首次打开该应用的**默认尺寸**；缺省按 **1280×720**，随后按 `window.ratio` 校正（给定 width 时 height 由 ratio 推出，反之亦然） |

三条口径：

- **`ratio` 是锁定而不是建议**：不要按"用户可能拉成任意比例"设计布局；用相对单位/弹性布局适配同一比例下的不同像素尺寸。
- **窗口尺寸是"首开默认"，不是每次打开都强制**：之后由客户端记忆（按应用、按用户），用户手动调整过就以记忆值为准。
- **字段表真源与本节的关系**（如实说明引用链）：字段规格的机器可读单一真源是
  `server/internal/wasmapp/appcfg/appcfg.json`，人读版是 `server/skills/app-builder/references/app-config.md`，
  两者由 `go generate ./internal/wasmapp/limits` 从 `appcfgspec.go` 生成。**本节写在这里，是为了在生成物尚未包含 `window` 字段时作者仍有可查处**；生成物补齐后两者应一致，若不一致**以生成物为准并报给平台**。

**这份文件是平台保留资源**：宿主**不会**把它当静态资源直出（§4.2）。
它只能由应用自己用 `assets.read("picoaide.app.json")` 读 —— 也就是说
**准入名单放在这里不会被访问者下载到**（见 §2.1「包内资源的可见性」）。

## 5. 本地编译与自测

### 5.1 编译（Go）

```bash
# ⚠️ 状态目录必须落在会话工作区内，不要依赖 $HOME：
# 沙箱只放行工作区可写；指向 $HOME 的缓存会以"标准库不存在"这类完全指错方向的报错出现。
export GOCACHE="$PWD/.gocache" GOMODCACHE="$PWD/.gomodcache" GOPATH="$PWD/.gopath" TMPDIR="$PWD/.tmp"
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOPATH" "$TMPDIR"

GOOS=wasip1 GOARCH=wasm go build -o app.wasm .
```

- 产物（.wasm）不超过 32 MiB；编译超时 60 秒。
- 导入面只允许 `wasi_snapshot_preview1`（Go 运行时的 WASI 符号）；导出面必须含
  `_start` 与 `memory`（额外导出忽略）。
- 组件模型产物不受支持：看到 `COMPONENT_MODEL_UNSUPPORTED` 就是编译目标选错了。

### 5.2 本地自测（零依赖）

Node 自带 `node:wasi`，可以直接把产物跑起来：

```bash
node <技能目录>/examples/go/preview.mjs app.wasm
node <技能目录>/examples/go/preview.mjs app.wasm --method POST --path /api/notes --body 'body=hello'
node <技能目录>/examples/go/preview.mjs app.wasm --user someone-else   # 看无权限页
```

`preview.mjs` 是一个**假宿主**：按 ABI 收发帧，用内存数据应答 `db.*`。它能验证协议层的一切
（帧读写、flush、响应只写一帧、路由与名单分支、失败分支的文案）；验证不了
"真实数据库/真实体积"。**它不提供 AI**（服务端已无 AI 能力）：AI 属于客户端 AI loop（§2.1c），
要在本地验证 AI 交互，请直接对前端页面做联调。

也可以直接用平台预检当"线上体检"：`validate` 不占版本号、不进审计，失败会回
`code` + `details` + `hints`。

## 6. 发布流程

| 步骤 | 端点（管理面只在平台主站：应用在客户端内以 `<渠道 app 源 scheme>://<app_id>` 打开，拿不到管理面） |
| --- | --- |
| 预检 | `POST /api/client/v2/apps/wasm/validate` |
| 提交新版本 | `POST /api/client/v2/apps/wasm/:app_id/releases` |
| 上架 / 下架 | `POST /api/client/v2/apps/wasm/:app_id/publish` · `…/unpublish` |
| 冻结 / 导出 / 删除 | `POST …/wasm/:app_id/freeze` · `GET …/export` · `DELETE …/wasm/:app_id` |
| 诊断 | `GET …/wasm/:app_id/diagnostics`（失败码 + hints + 每次请求的 `db_rows`/`db_bytes`） |
| 自省 | `GET …/wasm/:app_id/schema`（表 / 列 / 行数 / 占用） |
| **数据** | `GET …/wasm/:app_id/rows?table=&limit=&offset=&unmask=`（某张表的一页行；**默认脱敏**） |
| 应用中心 | `GET /api/client/v2/apps/wasm/catalog` |

### 6.1 让 AI 自己发布（**首选路径**）

上面那张表是**平台接口**。日常更省事的做法是让 AI 直接调宿主工具 —— 工具在客户端进程内
执行，用的就是当前登录员工的会话令牌，因此"谁让 AI 发的就记谁"，不需要把任何凭据交给模型：

| 工具 | 作用 |
| --- | --- |
| `wasm_app_list` | 列应用中心（确认 `app_id` 有没有被占用、查当前版本号） |
| `wasm_app_schema` | 读表结构（表/列/行数/占用） |
| `wasm_app_diagnostics` | 读运行诊断（失败码 + hints） |
| `wasm_app_rows` | 读某张表的一页行（**敏感列默认脱敏，工具无法解掉**） |
| `wasm_app_validate` | 预检：静态校验 + 真编译 + 干跑。**不占版本号、不进审计**，失败可反复调 |
| `wasm_app_publish` | 发布新版本：同步执行，>8 MiB 自动分片续传；**失败不占版本号** |

- **不要用 `curl` 直接调服务端接口**：那需要员工的登录令牌，模型既拿不到、也不该持有；
  应用页面（`<渠道 app 源 scheme>://<app_id>`）同样调不到管理面 —— 应用请求只经客户端的协议
  转发走到应用请求端点。工具是唯一走得通的路。
- 工具的参数说明就是**该填什么**的契约（`config` 的字段集合封闭：`access` / `whitelist` /
  `purpose` / `data_sensitivity` / `owner`，多一个未知字段服务端即拒）；字段规格的机器可读
  真源是服务端生成的 `appcfg.json`，与工具参数、客户端表单、技能参考**四处对拍**。
- 作者手册技能（`app-builder`）**随服务端镜像发布**（源码就在服务端仓库的
  `server/skills/app-builder/`），在客户端「能力中心 →
  平台内置技能」**按需安装**（不自动安装）；没装时工具报错会直接给出安装指路。

要点：

- **失败的发布不占版本号**（编译/干跑失败不落版本行，可直接重发同一个号）；
  一旦落了行，版本号**永久占用**（被拒、被软删的也不能复用）。
- 版本号必须严格递增；非首版必须写 `changelog`。
- **谁发布的谁是负责人**：第一个成功发布某 `app_id` 的人永久占有它，只有他能发新版、
  上下架、删除；平台管理员可兜底接管。**AI 只是编辑器，发布者记的是发起操作的员工。**
- 组织可开启"更新审批"：开启后新版本进待审队列，**线上仍是旧版本**（不中断使用）。
  上架/下架/删除不走审批。

### 6.2 发布之后怎么查数据（作者数据面）

应用上线后，"数据到底写进去没有 / 长什么样"不再只能靠猜：

| 想回答的问题 | 用什么 |
| --- | --- |
| `db.define` 生效了吗？列名对不对？ | `wasm_app_schema`（或 `GET …/schema`）：表、列、类型、行数、库体积 |
| 某次请求写了几行？ | `wasm_app_diagnostics` 的单条失败记录里的 `db_rows` / `db_bytes` |
| 这张表里现在有什么？ | `wasm_app_rows`（或客户端「应用中心 → 详情 → 数据」） |
| 为什么员工说打不开 / 报错？ | `wasm_app_diagnostics`：先看 `reasons[0]` 的 hints |

三条边界（**不要越过它们向用户承诺**）：

1. **仅发布者本人**可读（他人一律 404，与"应用不存在"同形）；每次调用都会被平台审计
   （`wasm_app_rows_view`，只记表名与分页，**不记行内容**）。
2. **敏感列默认脱敏**（按列名启发式：`password` / `token` / `secret` / `phone` / `email` /
   `id_card` …）。原值只能由**人**在客户端面板点「显示原值（会记审计）」——
   `wasm_app_rows` 工具没有 `unmask` 参数。看到星号不等于"没写进去"。
3. **不是导出接口**：一页最多 200 行、单值超长会截断、分页不保证稳定排序。
   要做导出/对账请另找管理员走运维路径。

## 7. 容量与配额

| 项 | 值（真源：生成的 limits 表） |
| --- | --- |
| 应用数据库 | 100 MB / 应用（页 4096 字节 × 25600 页），平台不提供扩容旋钮 |
| 表 / 列 | 16 张表 / 应用，16 列 / 表 |
| 单值长度 | 1 MiB |
| 单次查询返回 | 5000 行 / 8 MiB（超出截断并报错） |
| 单条 SQL | 64 KiB；单语句硬超时 5 秒 |
| .wasm 体积 | 32 MiB（上传体 48 MiB，base64 传输） |
| 请求体 / 响应体 | 1 MiB / 8 MiB（协议帧单行 1 MiB） |
| 保留版本 | 最近 3 个曾生效版本 |
| 制品总量 | 每人 1 GiB（含全部版本） |
| 上传频率 | 每人每小时 30 次（预检 + 发布合计）、同时 1 个编译中的上传 |
| 调用事件 / 日志保留 | 7 天（诊断默认返回 50 条、最多 200 条） |
| 退役快照保留 | 90 天 |
| AI 使用 | **无应用级配额**：应用 AI 走使用者自己的 LLM 链路（余额 + 平台既有限流）。⚠️ **不在 wasm 侧**：只在应用前端经 §2.1c 的客户端 AI loop 发生；**应用维度归因尚未接通**（客户端不出站归因头） |

## 8. 十一条硬约束（§9.4）

1. 编译目标 `wasm32-wasip1`；Tier 1 语言是 **Go**。
2. **无状态**：不要用全局变量存用户/会话状态 —— 实例每请求新建。
3. **同一应用内所有用户共享数据**；要区分用户请自己加业务字段。
4. **stdout 只用于协议帧**（`RS` + 长度 + JSON）；日志走 `log`。
5. **wasm 里没有 AI**：宿主方法 `ai.chat` 已删除（它不是 WASI 导入 ⇒ 老产物在**运行期**才失败）。
   要 AI 就在**应用前端**调保留路径 `POST /__picoaide/ai/chat`（客户端本地处理、流式 SSE，
   见 §2.1c），再把结果回传 wasm 落库。
6. **不能主动发起网络请求、不能读文件、不能开线程**（**不要对外说成"不能联网"**：CSP 不管顶层导航与弹窗，见 §1.1 与总纲 §6）；外部资源必须内联（HTML/JS 也编进 wasm）。
7. **准入由你自己判**：配置写在 `picoaide.app.json`（`access` = `login` / `whitelist`
   + `whitelist`），入口第一件事就是读它并比对名单；名单用 `username`/`user.id`；
   无权限页显示"你的账号：xxx"。
8. **平台不提供员工名录**：名单只能手填已知账号；改配置 = 发新版。
9. **不依赖 `$HOME`**：编译器状态目录必须落在会话工作区内。
10. **发布前先本地自测**：Node 内置 `node:wasi` 可零依赖跑通产物，再走 `validate`。
11. **应用名就是标识**（`app_id`，也是应用 origin 的 host 段 `<渠道 app 源 scheme>://<app_id>/`，渠道参数化：official/beta 取值 `picoaide-app`）：
    小写字母/数字/连字符、
    不超过 63 个字符、不能纯数字、不能 `xn--` 开头、不能是保留字；**一经发布不能改名**。

## 9. 容易做错的地方（§5.4）

| 容易做错 | 平台如何让它不可能（或立刻可见） |
| --- | --- |
| 以为应用内数据按用户隔离 | 文档与技能首屏明写"同一应用内所有用户共享数据" |
| 用 `document.cookie` 存状态（或指望 `Set-Cookie` 生效） | 自定义协议下 cookie 完全不可用：`document.cookie` 恒为空、`Set-Cookie` 不落盘 ⇒ 状态只能放应用库（`db.*`） |
| 用全局变量存状态 | 实例每请求新建 ⇒ 用了也不生效 |
| 往 stdout 打日志 | 非 `RS` 开头的内容一律当日志捕获，不污染协议（但也没有级别/条数管理） |
| 编译目标用错 | 上传期导入白名单直接拒，hints 指明 `wasm32-wasip1` |
| 版本号写错 / 忘写 changelog | 预检明确拒 + 结构化 hints |
| 写出慢查询 | 每条语句 5 秒硬超时 + `SQLITE_LIMIT_*` + 诊断事件 |
| 想调并发 / 队列参数 | 作者不可调（运维可在控制台「应用中心 → 限制项」改全局值）：同一应用默认最多 **4 个请求并发**（读并发；**写仍串行**），**单个用户在同一应用内默认只有 1 路**（`user_per_app_running`），超出进队列（默认 32，可调到 4096），队列满 429 |
| 事务里调 `log` / `assets.read` / `db.define` / 再开一个事务 | 直接报错（防事务长期持锁 + 占满执行槽）；事务内**只能做数据库读写**：`db.query` / `db.exec` + `tx_commit` / `tx_rollback` |
| 在 wasm 里找 AI 能力（老代码 `ai.chat`，**该能力已删除**） | 运行期第一层就回 JSON-RPC `NOT_FOUND` + `未知的宿主方法: ai.chat`（导入白名单管不到它 —— 它是 stdout 上的方法名，不是 WASI 导入）；改走 §2.1c 的客户端 AI loop |

## 10. 常见错误与处理（速查）

| 现象 / 错误码 | 大概率原因 | 处理 |
| --- | --- | --- |
| `IMPORT_NOT_ALLOWED` | 引入了平台外的运行时（`env.*` / `js.*`） | 用官方骨架；不要自带 WASI polyfill |
| `IMPORT_SIGNATURE_MISMATCH` | 导入符号在名单内但类型不符（**编译期不报**） | 按骨架的读帧/写帧写法重写；先本地 `preview.mjs` 跑一遍 |
| `SECTION_OVERRIDE_OVERSIZE` | 自定义段（内嵌资源）超过 4 MiB | 精简资源；先 gzip 再内嵌 |
| `WASM_TOO_LARGE` / `BODY_TOO_LARGE` | 产物超过 32 MiB / 上传体超过 48 MiB | 精简依赖与资源 |
| `COMPILE_TIMEOUT` / `COMPILE_OOM` | 依赖过大 | 去掉重型第三方库 |
| `APP_CONFIG_INVALID` | 配置文件缺失/非法/字段越界（含 `access="whitelist"` 但名单为空） | 按 `details` 指名的字段修；字段规格见生成物 `references/app-config.md` |
| `VERSION_NOT_NEWER` | 版本号没递增 | 换成更大的 `x.y.z` |
| `MISSING_FIELD` | 非首版缺 changelog | 补上 |
| `RUNTIME_NO_RESPONSE` | 有分支没写响应帧 | 每个分支都写且只写一帧（`preview.mjs` 能提前发现） |
| `RUNTIME_TIMEOUT` | 单请求里做了整批计算 | 拆成多次请求；检查不收敛的循环 |
| `RUNTIME_MEMORY` | 一次把大结果集读进内存 | 用 `WHERE` 收窄 + `LIMIT` 分页 |
| `DB_DENIED` | 多语句 / DDL / `PRAGMA` / `ATTACH` / `VACUUM` / 提到保留列；**事务内调了被禁能力**（`details.kind` = `nested_tx` / `blocking_capability` / `ddl`） | 建表走 `db.define`；语句只留四个动词；事务里只留 `db.query`/`db.exec` |
| `ASSET_DENIED` | `assets.read` 的包内路径非法，或资源名占用了保留前缀 | 路径用相对、`/` 分隔、不含 `..`；不要读自己没有的资源 |
| `ASSET_OVERSIZE` | 单个随包资源超过 4 MiB（与自定义段总量同源） | 精简资源；HTML/JS 先 gzip 再内嵌 |
| `ASSET_EXISTS` | 同一个包内路径在自定义段里出现了两次（解析层只取第一个，重复的那份会被静默丢弃 ⇒ 平台直接拒） | 打包时不要给两个源文件写同一个目标路径；改内容 = 发新版本 |
| `HOST_METHOD_UNKNOWN` | 调了不存在的宿主函数（拼错方法名、或平台没有的能力） | 只调封闭清单里的宿主方法（见 `references/abi.md` §3）；**AI 不在其中**，走 §2.1c 的客户端 AI loop。注意：**调不存在的宿主方法时第一层先回 JSON-RPC `NOT_FOUND` + `未知的宿主方法: <名字>`**（老应用调 `ai.chat` 撞的就是这一层） |
| `DB_LIMIT` | 库满 100 MB 或返回超行数/字节、语句超时 | 清理历史数据或做汇总表；分页 |
| `APP_QUEUE_FULL` | 用的人多 | 按 `Retry-After` 退避，别立刻重试 |
| `ai_balance_insufficient`（**客户端 AI loop** 错误，不是 wasm 错误码） | 使用者余额不足 | 提示本人去桌面客户端看余额；**不显示金额、不自动重试** |
| `ai_rate_limited` / `app_ai_denied` / `app_ai_unavailable` / `app_ai_invalid` / `ai_cancelled`（**客户端 AI loop** 错误） | 限流 / 用户未授权（或已撤销）/ 客户端 AI 不可用或未登录 / 请求体不合法（条数、单条长度、方法不是 POST）/ 页面关闭导致取消 | 分别提示"稍后重试"、"到应用详情页的 AI 面板授权（撤销入口也在那里）"、"AI 暂不可用"、"检查 messages 条数与长度"、无需提示（是用户主动关闭）；见 §2.1c |
| `FORBIDDEN` | 不是该应用的发布者（或应用已冻结） | 只能改自己发布的应用 |
| `NAME_TAKEN` | 应用名被占用 | 换名字（同名不同人是不同应用） |

> ⚠️ **平台不检查你是否参数化**。`db.query` / `db.exec` 的 SQL 闸门只检查：语句种类
> （四个动词）、单语句、平台保留列、以及 DDL/`PRAGMA`/`ATTACH`/`VACUUM` —— **把字面量
> 拼进 SQL 平台不会拦**（`SELECT … WHERE author='emp1'`、`DELETE … WHERE body='x'` 都会通过）。
> 也就是说 **SQL 注入没有任何平台侧防线**：值一律用 `db.query(sql, args)` / `db.exec(sql, args)`
> 的 `?` 占位参数传，不要用字符串拼接（`"... WHERE author='" + name + "'"` 就是漏洞）。
> 这条只有你自己守；把它当成"平台会替我兜住"，等于没有防线。

更细的读法与处置：`references/diagnostics.md`（在技能目录里）。

## 11. 文档与生成物位置

| 内容 | 位置 |
| --- | --- |
| AI 操作手册（随服务端镜像分发） | `server/skills/app-builder/SKILL.md` |
| ABI 参考 | 同目录 `references/abi.md` |
| 上限表（生成物，勿手改） | 同目录 `references/limits.md`；源码真源 `server/internal/wasmapp/limits/limits.go` |
| 配置字段参考（生成物，勿手改） | 同目录 `references/app-config.md`；源码真源 `server/internal/wasmapp/appcfg/appcfgspec.go` |
| **发布字段规格（机器可读单一真源）** | `server/internal/wasmapp/appcfg/appcfg.json`（`schema=picoaide-app-config/1`）。被四处对拍：服务端解析行为 / 宿主工具参数 / 客户端表单与提交体 / 上面的字段参考 |
| 发布与运维 | 同目录 `references/publishing.md` |
| 静态资源打包器（官方，零依赖） | `server/skills/app-builder/scripts/pack-assets.mjs` + 同目录 `README.md`（随技能分发） |
| 诊断 | 同目录 `references/diagnostics.md` |
| 可编译示例（共享便签） | 同目录 `examples/go/`（`GOOS=wasip1 GOARCH=wasm go build` 通过，门禁真题编译） |
| 上限生成器 | `server/cmd/picoaide-limits-gen`（`-check` 是 CI 门禁入口） |
| 上限门禁测试 | `server/internal/wasmapp/limits/limits_gen_test.go` |

改任何上限数值或配置字段：改 `limits.go` / `appcfgspec.go` → 跑
`go run ./cmd/picoaide-limits-gen` 重新生成**全部**产物 —— 服务端侧
`internal/wasmapp/limits/limits.json`、`internal/wasmapp/limits/limits.md`、
`internal/wasmapp/appcfg/appcfg.json`，以及技能目录下的 `references/limits.md` 与
`references/app-config.md` → 提交生成物（门禁 `-check` 逐字节比对，忘生成即红灯；
改名/搬走 `appcfg.json` 会让客户端与宿主两条对拍**直接失败**，不是静默跳过）。

> 写文档时注意：本文与 SKILL 都受 `limits_gen_test.go` 的 `TestSkillDiscipline` 约束 ——
> 文里出现的**"数字 + 量词"**（如"N 个/条/项"）必须能在 `limits` 表里找到同量纲同值的条目，
> 否则门禁红。要描述"若干个"就写成"全部/若干"或直接点名，不要写数字。

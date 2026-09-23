# ABI 参考（应用契约 `picoaide-app/1`）

> 本文件是**帧协议与宿主调用的唯一参考**。协议版本写在 SKILL 的 `x-abi-version`
> 与请求帧的 `abi` 字段里；平台升级协议时会换版本号，届时预检会直接拒。
>
> 所有上限数字都在 `references/limits.md`（从平台源码生成）里，本文件只引用它。

## 1. 帧格式

宿主与应用之间只有一种传输：**应用的 stdin / stdout**。

```
RS(0x1e) + 十进制长度 + '\n' + UTF-8 JSON
```

- 长度 = 后面 JSON 负载的**字节数**（不是字符数）。
- **必须一次读满**：不要用会预读的 JSON 流式解码器（如 `json.NewDecoder(stdin)`）——
  它会把紧随其后的 RPC 应答一起吞掉，症状是"第二个宿主调用永远等不到响应"。
- 应用输出里**只有以 `RS` 开头的才算帧**；其它内容（含你 `print` 的东西）一律被当日志丢弃。
- stdout 只写帧，stderr 只写调试信息（平台会保留一小段作为诊断尾巴）。
- 每写一帧都要 **flush**，否则它躺在缓冲区里，双方互等 = 死锁。

## 2. 请求帧（宿主 → 应用）

**每个请求都带完整身份**：应用实例每请求新建，身份不是会话状态，必须在每一帧里读。

```json
{"abi":"picoaide-app/1","app_id":"shared-notes","version":"1.2.0",
 "auth":{"mode":"whitelist","verified":true},
 "user":{"id":10231,"username":"zhangwei","display_name":"张伟",
         "dept":"研发部","is_publisher":false},
 "method":"POST","path":"/api/notes","query":{},
 "headers":{"content-type":"application/x-www-form-urlencoded"},
 "body":"text=hello"}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `abi` | string | 协议版本，恒为 `picoaide-app/1` |
| `app_id` | string | 应用标识（也是应用 origin 的 host 段：`<渠道 app 源 scheme>://<app_id>/`，渠道参数化：official/beta 取值 `picoaide-app`） |
| `version` | string | 当前生效版本号 |
| `auth.mode` | string | `login` / `whitelist`（来自 `picoaide.app.json` 的 `access`；历史配置里的 `public` 由读取侧按 `login` 处理，不会以 `public` 出现在帧里） |
| `auth.verified` | bool | 宿主已验证身份；平台一律要求登录，正常路径恒为 `true` |
| `user` | object | 当前使用者（**平台没有匿名面，永远是对象、不会是 `null`**；防御式判空仍建议保留） |
| `user.id` / `user.username` | int / string | **稳定键**：业务名单请用这两个，不要用 `display_name`/`dept` |
| `user.display_name` / `user.dept` | string | 展示用；会变 |
| `user.is_publisher` | bool | 当前使用者是否本应用的发布者（展示用，**不是权限**） |
| `method` | string | HTTP 方法（大写） |
| `path` | string | 应用内路径（如 `/`、`/api/notes`） |
| `query` | object | 查询参数（同名参数取第一个值） |
| `headers` | object | 请求头子集（小写键；Cookie 不在其中 —— 自定义协议下浏览器本来也不带 Cookie，`document.cookie` 恒为空） |
| `body` | string | 原始请求体（上限 1 MiB 原始字节；但整帧（含 JSON 转义）不得超过 1 MiB —— 控制字符/引号/尖括号密集的 1 MiB 请求会因转义膨胀而**整帧被拒**（413 `BODY_TOO_LARGE`），此时应用收不到请求，请改用更小的请求体） |

**身份契约**：应用拿不到 Cookie / 令牌 / 平台角色 / 员工名录。帧里的 `user` 是**唯一**
的身份来源、正常路径恒为对象（客户端专属模型下平台没有匿名面），且由宿主构造，
应用无法伪造。**应用也不能用 cookie 存任何状态** ——
自定义协议下 `document.cookie` 恒为空、`Set-Cookie` 不落盘，状态请放应用库（`db.*`）。

## 3. 宿主调用（应用 → 宿主，JSON-RPC 2.0）

一次调用的往返 = 写一帧 JSON-RPC 请求 + 读一帧 JSON-RPC 响应：

```json
{"jsonrpc":"2.0","id":1,"method":"db.query","params":{"sql":"SELECT ...","args":[]}}
```

```json
{"jsonrpc":"2.0","id":1,"result":{"columns":["author"],"rows":[["zhangwei"]]}}
```

失败时 `result` 换成 `error`（`code` 是下面的失败码，不是 JSON-RPC 数字码）：

```json
{"jsonrpc":"2.0","id":1,"error":{"code":"DB_DENIED","message":"只允许单条 SELECT/INSERT/UPDATE/DELETE"}}
```

**封闭清单**：下面八个方法（作者面六个原语 + `log` / `assets.read`）就是全部能力。
没有文件、网络、线程、子进程、环境变量、`PRAGMA`、`ATTACH`、DDL、扩展加载；
也没有任何员工名录能力、**没有任何 AI 能力**。调用不存在的方法 = 报错（运行期第一层回
`NOT_FOUND` + `未知的宿主方法: <名字>`，见 §7.1）。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `db.define` | `{"table":"notes","columns":[{"name":"body","type":"text"}]}` | `{"created":true,"table":"notes","columns":["body"]}` |
| `db.query` | `{"sql":"SELECT author, body FROM notes WHERE author = ? ORDER BY created_at DESC LIMIT 50","args":["zhangwei"]}` | `{"columns":["author","body"],"rows":[["zhangwei","hello"]]}`（命中返回行数/字节上限时额外带 `"truncated":true`） |
| `db.exec` | `{"sql":"INSERT INTO notes (author, body, created_at) VALUES (?, ?, ?)","args":["zhangwei","hello","2026-01-01T09:00:00Z"]}` | `{"rows_affected":1}` |
| `tx_begin` | `{}` | `{"tx_id":7}` |
| `tx_commit` | `{"tx_id":7}`（`tx_id` 可省：省了就提交当前事务） | `{"committed":true}` |
| `tx_rollback` | `{"tx_id":7}` | `{"committed":false}` |
| `log` | `{"level":"info","message":"便签已保存"}` | `{"accepted":1}` |
| `assets.read` | `{"path":"picoaide.app.json"}` | **必带判别字段 `encoding`**：`"text"` ⇒ 读 `text`（例：`{"content_type":"application/json","size":312,"encoding":"text","text":"{…}"}`）；`"base64"` ⇒ 读 `base64`；`"empty"` ⇒ 零字节资源（`text`/`base64` 都不出现） |

### 3.1 `db.define`（唯一的建表方式）

- 表名/列名规则：`^[a-z][a-z0-9_]{0,30}$`；列类型只能是 `text` / `int` / `real` /
  `bool` / `datetime`（封闭集合）。
- 每个应用最多 16 张表，每张最多 16 列（**平台的 `_row_id` 不占这个配额**）；
  **不能指定主键、外键、索引、触发器**。
- 重复调用幂等（`created:false` 表示表已存在）。**没有自动迁移**：改结构就用新表名或加列，
  自己搬数据。

### 3.2 平台保留列 `_row_id`（**名字在下面，请照它写代码**）

平台的 `db.define` 会为每张表自动追加一列：

```
_row_id INTEGER PRIMARY KEY AUTOINCREMENT
```

它是平台的主键，**应用看不到、也绝不能提到**。规则说全：

- **禁止出现在 SQL 与列名里的标识符**：`_row_id` 本身，以及它在 SQLite 里的三个内建别名
  **`rowid` / `_rowid_` / `oid`**。带引号的形态一视同仁 —— `"rowid"`、`[rowid]`、
  `` `rowid` `` 与裸词走同一个闸门（实测 `SELECT "rowid" AS x FROM items` 与裸词一样能读回
  平台主键，所以引号不是绕过路径）。
- **命中后果**：宿主调用失败，`error.code = "DB_DENIED"`、
  `details.reason = "reserved_column"`、`details.column = "_row_id"`
  （别名命中时 `message` 会点名你写的是别名）。`db.define` 里用这些名字当列名同样被拒。
- **`SELECT *` 不会把它带回来**：结果投影层按列名剥掉保留列（`columns` 与每一行都不含它），
  所以 `SELECT *` 是安全的读法；计量按**剥离后**的行/字节统计。
- ⚠️ **但投影只发生在 `db.query` 上**：`INSERT INTO b SELECT * FROM a` 走 `db.exec`、
  **不经过投影**，两边的列数语义要你自己对齐（`_row_id` 仍是表里真实存在的一列）。
  需要搬数据时把列名逐列写清楚，不要用 `SELECT *` 做插入源。
- 需要"业务序号"（第几条、编号）就**自己建一列**并用 `db.define` 声明，不要指望行号列。

### 3.3 `db.query` / `db.exec`（只能用 SQL 的四个动词）

- 一次**只能一条语句**；分号后还有内容即拒（`INSERT …; SELECT …` 一定失败）。
- 语句种类只允许 `SELECT` / `INSERT` / `UPDATE` / `DELETE`。显式拒绝：
  `CREATE` / `DROP` / `ALTER` / `ATTACH` / `DETACH` / `VACUUM` / `PRAGMA` / `REPLACE` /
  `TRUNCATE` / `GRANT` / `REINDEX` / `ANALYZE` / `SAVEPOINT` / `RELEASE`；另外
  **裸词 `WITH`（含 CTE）、`EXPLAIN`、裸 `VALUES`、以及引擎内建名**
  （`sqlite_*` / `pragma_*` / `readfile` / `writefile` 等）也一律拒。
- 方法分工：`db.query` 只跑 `SELECT`，`db.exec` 只跑 `INSERT` / `UPDATE` / `DELETE`。
- **值一律放在 `args` 里**（`?` 占位），不要把字符串拼进 SQL。注意：**平台不检查你是否
  参数化** —— 字面量拼进 SQL 照样通过闸门（`WHERE author='emp1'`、`DELETE … WHERE body='x'`
  都不会被拒），它只查上面那几条。
  **SQL 注入没有任何平台侧防线，只有你自己用参数占位挡住**。
- 单条 SQL 不超过 64 KiB、单值不超过 1 MiB、绑定参数最多 128 个、返回最多 5000 行 / 168 KiB
  （**行数或字节超限是截断并置 `truncated:true`，不报错** —— 看到它就该分页）。
- 每条语句最长 5 秒，超时会被中断并报 **403 `DB_DENIED`**（`details.reason = "statement_timeout"`）；
  库总量上限 100 MB（**写满**才报 507 `DB_LIMIT`）。

### 3.4 `db.tx`（事务）

语言侧就是 `tx_begin` → 业务 → `tx_commit`（或 `tx_rollback`）。

- **事务内只允许数据库读写**：`db.query` / `db.exec`，加上两个出口 `tx_commit` / `tx_rollback`。
  事务体里就该放 SQL：`begin` → `db.exec`（写）→ `db.query`（读，能看到本事务未提交的写）→ `commit`/`rollback`。
- **事务内禁止**（一律拒，错误码 `DB_DENIED` + `details.reason = host_call_in_tx`，
  `details.kind` 指出属于哪一类）：
  - `log` / `assets.read` ⇒ `kind = "blocking_capability"`（它们会长时间阻塞或占满执行槽）；
  - `db.define`（DDL）⇒ `kind = "ddl"`：建表请在事务外做；
  - 再开一个 `tx_begin` ⇒ `kind = "nested_tx"`：事务不可嵌套。
- 事务有硬超时（5 秒），超时**强制回滚**（事务内所有写入都不生效），错误码同样是 `DB_DENIED`。
- 实践：事务里只包必要的写；把查询与写日志都放到 `commit` 之后。

### 3.5 AI：不在宿主调用里（改走客户端 AI loop）

宿主能力清单里**没有 AI**（八个方法就是全部）。应用里的 AI 走**客户端 AI loop**：

```
应用前端 JS  —— POST /__picoaide/ai/chat（双下划线保留路径）
        ▼  宿主协议 handler 本地处理，绝不转发平台
   ① 首次授权闸门（用户 × 应用）→ ② 隐藏会话 app:<app_id>
   → ③ 桌面客户端跑一轮 ctx.agentLoop（工具集为空）
   → ④ assistant 增量以 SSE 回给应用页
```

请求 / 响应契约、六个错误码、授权与撤销入口、计费与归因口径，全部见 SKILL.md 的
「应用里的 AI：客户端 AI loop」一节（那里是唯一权威口径，本文件不复制一份）。

### 3.6 `log`

单条不超过 4 KiB（**超限截断，不拒绝**），每个请求最多 100 条，超出丢弃并在结果里回
`dropped`；`level` 空串回落 `info`。

⚠️ **`log` 没有查询接口、也没有保留期**：日志只进**服务端运维日志**（`wasm-app[<app_id>] …`，
随宿主日志滚动），平台**不承诺保留多久**，你自己（和平台）都查不回历史。它是给运维定位的
第一手材料，不是应用的审计流水 —— 要可回查的记录，**自己写库**（`db.exec`）。
**保留 7 天的是「调用事件」**（每次请求的 outcome / reason_code / CPU / 内存 …，出口是诊断接口），
两张表别混：见 `references/diagnostics.md`。

### 3.7 `assets.read`

读**随包提交**的资源（= wasm 的**自定义段**，运行期由宿主从制品里解析后常驻内存）：

- 最常见的用法是读应用自己的配置：`assets.read("picoaide.app.json")`。
- 路径是包内相对路径；没有文件系统语义（不能列目录、不能穿越）：路径不超过 256 字节、
  单段不超过 255 字节（平台按逻辑路径校验，不接触宿主文件系统）。
- 资源清单（自省/诊断接口）最多返回 10000 条。
- 结果用**判别字段 `encoding`** 决定读哪个字段（它一定在，不要靠猜）：
  - `"text"` ⇒ 读 `text`：文本类资源（HTML/CSS/JS/JSON）且内容是合法 UTF-8；
  - `"base64"` ⇒ 读 `base64`：二进制资源，或"声明为文本但字节不是合法 UTF-8"的文件（平台
    不会把坏字节替换成乱码，而是原样给字节）；
  - `"empty"` ⇒ **零字节资源**：`text` 与 `base64` 都不会出现，直接按空处理。
- 不要用 `size == 0` 去推断该读哪个字段 —— `encoding` 就是为消灭这个歧义存在的。
- 单个随包资源与自定义段总量**同源上限 4 MiB**（超限 `ASSET_OVERSIZE`）。
- ⚠️ **随包资源不得占用 `__picoaide/` 前缀**：那是宿主保留命名空间，发布期直接拒
  （`ASSET_DENIED` + `details.reason = "reserved_path_prefix"`）。

**可见性（往包里放机密之前必读）**：

- `assets.read` 读到的资源**默认不对外公开** —— 它按包内逻辑路径在宿主内存里查，
  没有文件系统语义，外面也列不了目录。
- **唯一例外是"非保留资源"**：`picoaide.app.json` 之外的一切包内文件
  （HTML/JS/CSS/图片/字体/数据文件）会被宿主**按路径直出给任何能打开应用的人**
  —— 这正是"静态资源编译进 wasm"的用法（也才有 §4.6 的响应缓存收益）。
  所以**不要把机密、账号名单、内部说明、口令、内网地址放进非保留资源**：
  `GET /data/users.json` 任何能打开这个应用的人都能拿到，**与 `access` 无关**
  （登录只决定**谁**能打开应用；能打开的人在应用内取子资源照样直出）。
- **名单放 `picoaide.app.json`**：它是平台保留资源，**不会被直出**；只有应用自己
  用 `assets.read` 读得到它，访问者拿到的是应用自己写的（404/403）页面。

**静态资源的直出规则（决定了你的路由怎么写）**：

| 请求 | 谁来答 |
| --- | --- |
| `GET`/`HEAD` 且路径在包里存在对应资源 | 宿主**直出**（不执行 wasm）；响应带 ETag，命中 `If-None-Match` 时 304（连内容都不重算） |
| `/api` 与 `/api/*` | **一律交给 wasm**（即使包里恰好有 `api/x.json` 也不直出） |
| 非 `GET`/`HEAD` 方法 | 一律交给 wasm（否则 `POST /` 会拿到 index.html） |
| **入口文档**（`/`、`/index.html`、`<目录>/`） | **一律交给 wasm**：名单判定在应用自己手里，入口必须由应用把门（否则不在名单里的人只会看到一个空壳页面） |
| 其它路径 | 资源存在才直出，否则交给 wasm（由应用决定 404 还是别的） |

⇒ 所以入口页要由 wasm `assets.read("index.html")` 读出来再作为响应体返回，而
`/static/app.css`、`/static/app.js` 由宿主直出。子资源仍建议在 wasm 里留一条兜底分支
（宿主没直出时自己读包内资源）。

**怎么把静态资源放进包里**：用官方打包器 `scripts/pack-assets.mjs`（就在技能目录里，
用法见同目录 `README.md`）—— 它把「磁盘文件 → 包内逻辑路径」追加进**已编译好**的 wasm
自定义段，规则与平台同源（路径不超过 256 字节、单段不超过 255 字节、自定义段总量不超过
4 MiB），`--out` 必须给一个新路径（**绝不就地覆盖输入**）：

```bash
node scripts/pack-assets.mjs --in app.wasm --out dist/app-packed.wasm \
  web/index.html=index.html web/app.css=static/app.css web/app.js=static/app.js
```

⚠️ **保留资源不能这样加**：`picoaide.app.json` 由平台在发布期写入（内容 = 随包提交的
`config`），模块里的同名段会被平台忽略；脚本会直接拒绝。名单要放就放 `config` 的
`whitelist`，不要塞进会被直出的非保留资源。

## 4. 最终响应信封（应用 → 宿主）

做完事写**一帧**信封，之后不得再写任何帧：

```json
{"status":200,
 "headers":{"Content-Type":"text/html; charset=utf-8"},
 "body":"<!doctype html>…"}
```

- `headers` 只允许：`Content-Type`（限定集合：HTML / 纯文本 / CSS / JS / JSON / PNG / JPEG /
  GIF / SVG / WebP / ICO / woff2 / woff / 二进制流）、`Cache-Control`、`Content-Disposition`
  （只允许 `inline`）、`X-Content-Type-Options`。头值里出现 CR/LF 会被拒。
- **自定义协议下没有 cookie 语义**：`document.cookie` 恒为空、平台发的 `Set-Cookie`
  也不会落盘，应用设不了、也不该依赖它；安全响应头（CSP、`nosniff`、`Referrer-Policy`）
  由平台强制写入，应用写的同名头会被剥掉。要保存状态就写应用库（`db.*`）。
- 响应体的**保证可交付**上限是 **168 KiB**；协议帧单行上限 1 MiB
  （超了报 `RUNTIME_OUTPUT_OVERRUN`）。两个数的关系：响应帧要和响应头、JSON 信封一起编码，
  而 `<`/`>`/`&`/控制字符在 JSON 里会膨胀到 **6 倍**（`<` → `\u003c`）——168 KiB 是
  "不管内容长什么样都装得下"的数；低转义内容（纯 ASCII、无 `<>"&`）的实测天花板更高，
  但那是实测值、不是承诺，**不要照着它设计**。**超了怎么办**：把响应拆小
  （分页 / 只返回当前页要用的字段），不要把整张表一次渲染进页面。
- 应用必须自己写响应：正常退出但没写帧 = `RUNTIME_NO_RESPONSE`（平台绝不会把它当成功）。

## 5. 判别规则（两类帧共用一种格式）

读到一帧后，按**顶层字段是否存在**判别：

| 帧里有 | 类型 |
| --- | --- |
| `jsonrpc` | JSON-RPC 请求（应用在调宿主，等应答） |
| `status` | 最终响应信封（请求结束） |
| 两个都没有 | 协议错误（宿主按 `RUNTIME_NO_RESPONSE` 处理） |

## 6. 计时规则

```
请求到达 ── 端到端墙钟 60 秒（含排队）
  进入 guest ── guest 预算 10 秒
      调宿主函数 ── 【暂停 guest 计时】+ 宿主预算（单条 SQL 5 秒）
      宿主返回   ── 恢复 guest 计时
  写完响应 ── 结束

上传路径（作者侧）：客户端上传超时 90 秒 > 服务端读取超时 60 秒 > 编译 60 秒
```

推论（写代码时直接照做）：

- **长活儿拆分**：单请求里做整批计算必然撞 10 秒；分成多次请求，每次一小步。
- **慢查询改写**：一条语句 5 秒是硬超时，加索引不存在，请用 `WHERE` 收窄 + `LIMIT` 分页。
- **AI 不在宿主计时里**：AI 由应用前端经客户端 AI loop 调客户端（见 §3.5），不占 guest
  预算，也不该在 wasm 里等它；wasm 只负责回 JSON 与把结果落库。

## 7. 失败语义（平台绝不把失败报成成功）

对**应用**而言，失败要么是宿主调用的 `error.code`（下面这些码），要么是最终响应的 HTTP 状态。
对**打开应用的客户端**而言，看到的还是 `<status>` 与 `body` —— 所以应用要负责把码翻译成人话。

| 码 | HTTP | 触发条件 | 应用该怎么做（hints） |
| --- | --- | --- | --- |
| `RUNTIME_TIMEOUT` | 504 | guest 预算（10 秒）耗尽 | 拆小请求；检查有没有不收敛的循环/重试 |
| `RUNTIME_TRAP` | 500 | wasm trap（越界/除零/`unreachable`） | 先 `recover` 再写错误响应；看 stderr 尾巴 |
| `RUNTIME_MEMORY` | 500 | 线性内存超过 64 MiB | 别把大结果集一次读进内存；用分页 |
| `RUNTIME_OUTPUT_OVERRUN` | 500 | 单帧/总输出超限（1 MiB 级） | 响应分页；不要把大对象塞进一帧 |
| `RUNTIME_NO_RESPONSE` | 502 | 正常退出但没写响应帧 | 每个分支都要写且只写一帧 |
| `RUNTIME_GUEST_EXIT` | 500 | 非零退出且无响应帧（如 Go OOM 走 exit 2） | 诊断里回 exit code + stderr；先加日志定位 |
| `HOST_CALL_OVER_BUDGET` | 504 | 宿主调用超预算 | 拆小单次调用；不要依赖长阻塞 |
| `AUTH_REQUIRED` | 401 | 身份未验证却调用需要身份的能力 | 平台一律要求登录（历史 `public` 配置读取侧按 `login` 处理）：确认请求来自登录态，或引导用户先登录 |
| `MODULE_KILLED` | 504 | 请求被取消 / 实例已关闭 | 同超时处理：拆小、重试前先确认状态 |
| `DB_LIMIT` | 507 | **只有**「库写满」（100 MB 上限）—— 以及单行超过 168 KiB（一行都返回不了；"丢掉全部行仍装不进 1 MiB 帧"也回这一档） | 清理旧数据或做汇总表；别把大对象塞进一行。**行数/字节超限不是这个码**（见 §3.3 的 `truncated`） |
| `RESULT_TOO_LARGE` | 422 | 宿主调用的结果装不进一个协议帧（1 MiB） | 缩小本次调用的返回内容（`db.query` 走分页；`assets.read` 换小资源） |
| `DB_DENIED` | 403 | 语句被拒（DDL / 多语句 / `WITH`·`EXPLAIN` / 保留列 `_row_id` 及其别名 / 类型不符）、**语句超过 5 秒被中断**（`details.reason = "statement_timeout"`），或事务内调了被禁能力 | 建表用 `db.define`，语句只留四个动词，值走 `args`；保留列规则见 §3.2；事务规则见 §3.4；先读 `details.reason` 再决定是改 SQL 还是加 `LIMIT` |
| `APP_QUEUE_FULL` | 429 | 该应用排队已满 | 按 `Retry-After` 退避；合并小请求 |
| `IMPORT_NOT_ALLOWED` | 422 | 导入面不在白名单（`env.*` / `js.*` 等额外的 WASI 模块或符号） | 用官方骨架；不要引入平台外的运行时。**放行清单见 `references/imports.md`**（逐符号 + 签名 + 为什么放行） |
| `IMPORT_SIGNATURE_MISMATCH` | 422 | 导入符号在名单内但类型不符 | 按骨架的读帧/写帧写法重写；目标必须是 `wasm32-wasip1`（签名对照 `references/imports.md`） |
| `COMPONENT_MODEL_UNSUPPORTED` | 422 | 产物是组件模型（不是 core module） | 换回 `wasm32-wasip1` 目标 |
| `SECTION_MALFORMED` | 422 | 自定义段结构非法 | 换官方工具链/骨架重新构建 |
| `SECTION_OVERRIDE_OVERSIZE` | 422 | 自定义段超过 4 MiB | 精简内嵌资源；**HTML/JS 建议 gzip 后再内嵌** |
| `COMPILE_TIMEOUT` | 504 | 编译超过 60 秒 | 精简依赖；不要引入大型第三方库 |
| `COMPILE_OOM` | 500 | 编译所需内存超过平台上限 | 同上：减小模块与依赖 |
| `INVALID_APP_ID` | 400 | 应用名不合法 | 见 SKILL 硬约束第十一条 |
| `NAME_TAKEN` | 409 | 应用名已被占用（**同名即同一个应用**，不是"不同人各有一个"） | 换名字：标识由**首个成功发布者永久占有**（被拒/软删也不释放）；需要接管时请管理员在管理面转移归属 |
| `VERSION_INVALID` / `VERSION_NOT_NEWER` | 400 | 版本号不是 `x.y.z` 或不递增 | 改成比线上更大的 `x.y.z` |
| `MISSING_FIELD` | 422 | 非首版缺少 changelog 等必填项 | 补上再发 |
| `APP_CONFIG_INVALID` | 422 | `picoaide.app.json` 缺失/非法/字段越界 | 按提示字段修（注意 `access="whitelist"` 必须有非空名单；字段规格见 `references/app-config.md`） |
| `WASM_TOO_LARGE` / `BODY_TOO_LARGE` | 413 | wasm 超 32 MiB / 上传体超 48 MiB | 精简资源，或把大资源移出应用 |
| `RATE_LIMITED` / `COMPILE_BUSY` | 429 | 上传过于频繁 / 编译队列忙 | 等一会儿再试 |
| `FORBIDDEN` | 403 | 审计账号调用应用平台；或**跨源写请求**被拒（非幂等方法的 `Origin` 必须等于应用自身源 `<渠道 app 源 scheme>://<app_id>`）——**与"发布者/冻结"无关** | 用发布者本人的登录态操作；写请求带同源来源。**不是发布者**时看到的是 404（见下一行），应用被冻结时看到的是 403 `APP_FROZEN`（见 §7.1） |
| `NOT_FOUND` | 404 | 应用/版本不存在；**或你不是该应用的发布者**（与"不存在"逐字节同形，不泄露存在性）；**或应用调了不存在的宿主方法（见 §7.1）** | 先核对 `app_id` 拼写与当前账号；若来自宿主调用，读 `message`。**不要靠改名绕过**：标识一旦被占就不释放（见 `NAME_TAKEN`） |
| `VALIDATION` | 400 | 请求内容不合法 | 按 `details` 修 |
| `INTERNAL` | 500 | 平台内部错误 | 重试一次；持续失败提工单并附诊断 |

> **AI 相关错误码不在本表**：wasm 侧没有 AI 能力。应用里的 AI 由应用前端经保留路径
> `POST /__picoaide/ai/chat` 调客户端（客户端 AI loop）本地处理，它的六个错误码
> （`app_ai_denied` / `app_ai_unavailable` / `app_ai_invalid` / `ai_balance_insufficient` /
> `ai_rate_limited` / `ai_cancelled`）是另一套，处置见 SKILL.md 的「应用里的 AI：客户端 AI loop」。

### 7.1 补充码（上表之外的实现补充）

下面这些码不在上面的失败语义表里，但平台真的会发出来（它们有独立的错误码与 HTTP
映射）。单列出来是为了让"遇到没见过的码"有据可查 —— 把它们压进 `DB_DENIED` / `VALIDATION`
这类通用码，只会把你指向错误的排查方向：

| 码 | HTTP | 触发条件 | 应用该怎么做 |
| --- | --- | --- | --- |
| `HOST_METHOD_UNKNOWN` | 400 | 调了不存在的宿主函数（方法名拼错，或平台没有这个能力） | 只调上面 §3 表里的八个方法；`details.method` 回显你给的方法名，`hints` 列出可用能力 |
| （第一层，JSON-RPC 的 `code` 就是 `NOT_FOUND`） | — | 方法名不在封闭清单里时，**运行时**先回一条 JSON-RPC error：`code = "NOT_FOUND"`、`message = "未知的宿主方法: <方法名>"` | **老应用（仍调 `ai.chat`）就是撞在这一层**：它**不会**在发布期被拒（`ai.chat` 从来不是 WASI 导入，平台也不反编译产物），而是运行期第一次调用才失败。迁移见 SKILL.md 的「应用里的 AI」 |
| `ASSET_DENIED` | 403 | `assets.read` 的包内路径被拒（绝对路径 / `..` / `\` / 控制字符 / 超长）；**发布期的随包资源名占用 `__picoaide/` 前缀也回这个码**（`details.reason = "reserved_path_prefix"`） | 用相对、以 `/` 分隔的包内逻辑路径；看 `details.reason`（如 `parent_segment`、`not_canonical`、`reserved_path_prefix`） |
| `ASSET_OVERSIZE` | 422 | 单个随包资源超过单文件上限（与自定义段总量同源，见 `references/limits.md`） | 精简资源；HTML/JS 先压缩再内嵌 |
| `ASSET_EXISTS` | 409 | 同一个资源名在自定义段里出现了两次（重名段只认第一个） | 改资源名或删掉重复的那一份；改内容 = 发一个新版本 |
| `APP_FROZEN` | 403 | 应用已被管理员**冻结**，而你在做发布 / 上下架 / 改配置 | 冻结是平台侧处置：**找管理员解冻**，自己重试任何写动作都不会成功（冻结同时会下架，员工侧打开是 404） |
| `VALIDATE_FAILED` | 422 | 产物不满足应用契约：导出面缺 `_start` / `memory`（或导出类型不对），或模块**无法被运行时装载** | 用官方骨架重新构建；确认目标是 `wasm32-wasip1`，且 `_start` 与 `memory` 都是**导出**（额外导出忽略；对照 `references/imports.md`） |

> 失败码是**可操作**的入口：每个码都带 `message`，多数还带 `details` 与 `hints`。
> 遇到没见过的码，先看 `hints`，再看 `references/diagnostics.md`。

## 8. 页面怎么产出：静态前端 + JSON API（模板是例外用法）

**默认形态是前后端分离**：`web/index.html` + `web/app.css` + `web/app.js` 作为随包资源，
由宿主按路径直出（§3.7 的直出规则），wasm 只回 JSON。入口文档（`/`、`/index.html`）
由 wasm 自己答（先判名单，再 `assets.read("index.html")` 作为响应体）——
这样不在名单里的人才会看到应用自己写的 403 错误应答，而不是一个空壳。

`html/template` / `text/template` **仍然被放行**（白名单覆盖 Go 运行时发出的 WASI 导入面，
其中包含模板渲染需要的几条）：有服务端渲染需求时（例如导出 HTML 报表）可以照常用：

```go
var report = template.Must(template.New("report").Parse(`<h1>{{.User}}</h1>`))

var buf bytes.Buffer
if err := report.Execute(&buf, map[string]string{"User": user}); err != nil { /* 500 */ }
// buf.String() 就是渲染好的 HTML
```

但**不要把整页 UI 拼在 wasm 里**：页面与逻辑耦合会让"改一个按钮"变成重新编译 + 重新发布；
加载/空/错三态、表单校验、二次确认在 JS 里是几行，在 Go 里要手写一堆拼接；而宿主直出的
静态资源可以走 ETag / 304，wasm 每次现拼则要跑一遍 guest（guest 预算只有 10 秒，
且每个请求都要新建实例）。

同时可用（同属"应用真的会写的代码"，白名单同样覆盖）：

- `(*os.File).ReadAt` / `WriteAt`：能编译、能上传；运行期在平台的零 preopen 沙箱里**一律失败**
  （拿不到可用文件描述符），所以别把它当"能读文件"用。
- 常见的标准库面：`encoding/json`、`strings` / `strconv` / `sort` / `regexp` / `math` / `errors` /
  `fmt`、`net/url` 解析、`time` 的格式化与 `Parse`、`encoding/base64`、`hash/*`、`io.Copy`、
  `bufio`、`bytes.Buffer`、`unicode/utf8`、`context`、`sync`（`Mutex` / `WaitGroup`）。

仍然**不能**做的事（能力不存在，不是配置问题）：联网（`net` 的错误串是 Go 的假网络栈合成的，
不要据此调网络参数）、读写宿主文件、起线程/子进程；命令行参数与环境变量**读到的是空的**
（平台不传 `args` / `env`，别把配置放进去）。

> 判据来源：白名单由参考程序**真编译**生成（`server/cmd/picoaide-wasm-imports-gen`），
> **放行的全部符号 + 签名 + 逐条"为什么放行"见 `references/imports.md`**（同一生成器产出，
> 与真源逐字节对拍），并且有一条独立的覆盖性门禁真编译"`html/template` 渲染 + `ReadAt`"的最小程序
> 断言它落在白名单内（`server/internal/wasmapp/wasmmod/imports_coverage_test.go`）。

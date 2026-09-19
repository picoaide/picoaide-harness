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
| `app_id` | string | 应用标识（就是域名标签） |
| `version` | string | 当前生效版本号 |
| `auth.mode` | string | `public` / `login` / `whitelist`（来自 `picoaide.app.json` 的 `access`） |
| `auth.verified` | bool | 宿主已验证身份；`login` / `whitelist` 下为 `true` 才会进 wasm |
| `user` | object \| null | 当前使用者（`public` 且未登录时为 `null`） |
| `user.id` / `user.username` | int / string | **稳定键**：业务名单请用这两个，不要用 `display_name`/`dept` |
| `user.display_name` / `user.dept` | string | 展示用；会变 |
| `user.is_publisher` | bool | 当前使用者是否本应用的发布者（展示用，**不是权限**） |
| `method` | string | HTTP 方法（大写） |
| `path` | string | 应用内路径（如 `/`、`/api/notes`） |
| `query` | object | 查询参数（同名参数取第一个值） |
| `headers` | object | 请求头子集（小写键；Cookie 不在其中 —— 应用拿不到凭证） |
| `body` | string | 原始请求体（上限 1 MiB） |

**身份契约**：应用拿不到 Cookie / 令牌 / 平台角色 / 员工名录。帧里的 `user` 是**唯一**
的身份来源，且由宿主构造，应用无法伪造。`user: null` 的分支里不要渲染任何账号信息。

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

**封闭清单**：下面九个方法就是全部能力。没有文件、网络、线程、子进程、环境变量、
`PRAGMA`、`ATTACH`、DDL、扩展加载；也没有任何员工名录能力。调用不存在的方法 = 报错。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `db.define` | `{"table":"notes","columns":[{"name":"body","type":"text"}]}` | `{"created":true,"table":"notes","columns":["body"]}` |
| `db.query` | `{"sql":"SELECT author, body FROM notes WHERE author = ? ORDER BY created_at DESC LIMIT 50","args":["zhangwei"]}` | `{"columns":["author","body"],"rows":[["zhangwei","hello"]]}`（命中返回行数/字节上限时额外带 `"truncated":true`） |
| `db.exec` | `{"sql":"INSERT INTO notes (author, body, created_at) VALUES (?, ?, ?)","args":["zhangwei","hello","2026-01-01T09:00:00Z"]}` | `{"rows_affected":1}` |
| `tx_begin` | `{}` | `{"tx_id":7}` |
| `tx_commit` | `{"tx_id":7}`（`tx_id` 可省：省了就提交当前事务） | `{"committed":true}` |
| `tx_rollback` | `{"tx_id":7}` | `{"committed":false}` |
| `ai.chat` | `{"messages":[{"role":"user","content":"总结这些便签"}],"model":"（可省略，平台裁决）"}` | `{"content":"…","model":"…","usage":{"prompt_tokens":123,"completion_tokens":45,"total_tokens":168}}` |
| `log` | `{"level":"info","message":"便签已保存"}` | `{"accepted":1}` |
| `assets.read` | `{"path":"picoaide.app.json"}` | **必带判别字段 `encoding`**：`"text"` ⇒ 读 `text`（例：`{"content_type":"application/json","size":312,"encoding":"text","text":"{…}"}`）；`"base64"` ⇒ 读 `base64`；`"empty"` ⇒ 零字节资源（`text`/`base64` 都不出现） |

### 3.1 `db.define`（唯一的建表方式）

- 表名/列名规则：`^[a-z][a-z0-9_]{0,30}$`；列类型只能是 `text` / `int` / `real` /
  `bool` / `datetime`（封闭集合）。
- 每个应用最多 16 张表，每张最多 16 列；**不能指定主键、外键、索引、触发器**。
- 重复调用幂等（`created:false` 表示表已存在）。**没有自动迁移**：改结构就用新表名或加列，
  自己搬数据。
- 平台自动维护一个内部行号列，应用**看不到也不能提到它**（提到即拒）。

### 3.2 `db.query` / `db.exec`（只能用 SQL 的四个动词）

- 一次**只能一条语句**；分号后还有内容即拒（`INSERT …; SELECT …` 一定失败）。
- 语句种类只允许 `SELECT` / `INSERT` / `UPDATE` / `DELETE`
  （`CREATE` / `DROP` / `ALTER` / `ATTACH` / `VACUUM` / `PRAGMA` 等一律拒）。
- **必须参数化**：把值放在 `args` 里，不要把字符串拼进 SQL。
- 单条 SQL 不超过 64 KiB、单值不超过 1 MiB、返回最多 5000 行 / 8 MiB
  （超出会截断并置 `truncated`，或被拒）。
- 每条语句最长 5 秒，超时被中断并报 `DB_LIMIT`。

### 3.3 `db.tx`（事务）

语言侧就是 `tx_begin` → 业务 → `tx_commit`（或 `tx_rollback`）。

- **事务内只允许数据库读写**：`db.query` / `db.exec`，加上两个出口 `tx_commit` / `tx_rollback`。
  事务体里就该放 SQL：`begin` → `db.exec`（写）→ `db.query`（读，能看到本事务未提交的写）→ `commit`/`rollback`。
- **事务内禁止**（一律拒，错误码 `DB_DENIED` + `details.reason = host_call_in_tx`，
  `details.kind` 指出属于哪一类）：
  - `ai.chat` / `log` / `assets.read` ⇒ `kind = "blocking_capability"`（它们会长时间阻塞或占满执行槽）；
  - `db.define`（DDL）⇒ `kind = "ddl"`：建表请在事务外做；
  - 再开一个 `tx_begin` ⇒ `kind = "nested_tx"`：事务不可嵌套。
- 事务有硬超时，超时**强制回滚**（事务内所有写入都不生效）。
- 实践：事务里只包必要的写；把查询、AI 调用、写日志都放到 `commit` 之后。

### 3.4 `ai.chat`（用使用者自己的身份与额度）

- **非流式、阻塞**，一次最长 30 秒；界面要有等待态。
- 模型由平台裁决（可以传 `model`，但平台有权不用）；平台**不注入系统提示**。
- 费用记在**当前使用者**头上，扣的是他自己的余额；应用没有独立额度。
- 匿名（`user: null`）调用 ⇒ `AUTH_REQUIRED`；余额不足 ⇒ `AI_BALANCE_INSUFFICIENT`（提示本人
  去桌面客户端看余额，**不要在页面上写具体金额**）；撞限流 ⇒ `AI_RATE_LIMITED`。
- 单次最多 128 条消息、请求体不超过 1 MiB。

### 3.5 `log`

单条不超过 4 KiB，每个请求最多 100 条，超出丢弃并在结果里回 `dropped`。
日志保留 7 天，是排障的第一手材料 —— 关键分支都打一条。

### 3.6 `assets.read`

读**随包提交**的资源（发布时从 wasm 里抽出来放到宿主磁盘）：

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

**可见性（往包里放机密之前必读）**：

- `assets.read` 读到的资源**默认不对外公开** —— 它只在宿主磁盘上，按包内逻辑路径读，
  没有文件系统语义，外面也列不了目录。
- **唯一例外是"非保留资源"**：`picoaide.app.json` 之外的一切包内文件
  （HTML/JS/CSS/图片/字体/数据文件）会被宿主**按路径直出给任何能打开应用的人**
  —— 这正是"静态资源编译进 wasm"的用法（也才有 §4.6 的响应缓存收益）。
  所以**不要把机密、账号名单、内部说明、口令、内网地址放进非保留资源**：
  `GET /data/users.json` 谁都能拿到，**与 `access` 无关**
  （`access` 只决定**入口文档**交给谁：要求登录时未登录先换票；子资源照样直出）。
- **名单放 `picoaide.app.json`**：它是平台保留资源，**不会被直出**；只有应用自己
  用 `assets.read` 读得到它，访问者拿到的是应用自己写的（404/403）页面。

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
- **Cookie 由平台独占**，应用设不了；安全响应头（CSP、`nosniff`、`Referrer-Policy`）
  也由平台强制写入，应用写的同名头会被剥掉。
- 响应体上限 8 MiB；协议帧单行上限 1 MiB（超了报 `RUNTIME_OUTPUT_OVERRUN`）。
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
      调宿主函数 ── 【暂停 guest 计时】+ 宿主预算（ai.chat 30 秒 / 单条 SQL 5 秒）
      宿主返回   ── 恢复 guest 计时
  写完响应 ── 结束

上传路径（作者侧）：客户端上传超时 90 秒 > 服务端读取超时 60 秒 > 编译 60 秒
```

推论（写代码时直接照做）：

- **长活儿拆分**：单请求里做整批计算必然撞 10 秒；分成多次请求，每次一小步。
- **慢查询改写**：一条语句 5 秒是硬超时，加索引不存在，请用 `WHERE` 收窄 + `LIMIT` 分页。
- **AI 调用要放在等待态后面**：30 秒是平台给的预算，用户需要看到进度而不是卡住的页面。

## 7. 失败语义（平台绝不把失败报成成功）

对**应用**而言，失败要么是宿主调用的 `error.code`（下面这些码），要么是最终响应的 HTTP 状态。
对**浏览器**而言，看到的还是 `<status>` 与 `body` —— 所以应用要负责把码翻译成人话。

| 码 | HTTP | 触发条件 | 应用该怎么做（hints） |
| --- | --- | --- | --- |
| `RUNTIME_TIMEOUT` | 504 | guest 预算（10 秒）耗尽 | 拆小请求；检查有没有不收敛的循环/重试 |
| `RUNTIME_TRAP` | 500 | wasm trap（越界/除零/`unreachable`） | 先 `recover` 再写错误响应；看 stderr 尾巴 |
| `RUNTIME_MEMORY` | 500 | 线性内存超过 64 MiB | 别把大结果集一次读进内存；用分页 |
| `RUNTIME_OUTPUT_OVERRUN` | 500 | 单帧/总输出超限（1 MiB 级） | 响应分页；不要把大对象塞进一帧 |
| `RUNTIME_NO_RESPONSE` | 502 | 正常退出但没写响应帧 | 每个分支都要写且只写一帧 |
| `RUNTIME_GUEST_EXIT` | 500 | 非零退出且无响应帧（如 Go OOM 走 exit 2） | 诊断里回 exit code + stderr；先加日志定位 |
| `HOST_CALL_OVER_BUDGET` | 504 | 宿主调用超预算 | 拆小单次调用；不要依赖长阻塞 |
| `AUTH_REQUIRED` | 401 | 匿名请求调用需要身份的能力（如 `ai.chat`） | 把 `access` 改成 `login` / `whitelist`，或引导用户登录 |
| `AI_BALANCE_INSUFFICIENT` | 402 | 使用者余额不足 | 提示"请到桌面客户端查看余额"，**不显示金额、不要重试** |
| `AI_RATE_LIMITED` | 429 | 撞上使用者级限流（每分钟 / 在途上限） | 按提示稍后重试；不要在循环里猛调 |
| `MODULE_KILLED` | 504 | 请求被取消 / 实例已关闭 | 同超时处理：拆小、重试前先确认状态 |
| `DB_LIMIT` | 507 | 库满 100 MB / 返回超行数 / 语句超时 | 清理旧数据或做汇总表；加 `WHERE` + `LIMIT` |
| `DB_DENIED` | 403 | 语句被拒（DDL / 多语句 / `PRAGMA` / 保留列 / 类型不符） | 建表用 `db.define`，语句只留四个动词，值走 `args` |
| `APP_QUEUE_FULL` | 429 | 该应用排队已满 | 按 `Retry-After` 退避；合并小请求 |
| `IMPORT_NOT_ALLOWED` | 422 | 导入面不在白名单（`env.*` / `js.*` 等） | 用官方骨架；不要引入平台外的运行时 |
| `IMPORT_SIGNATURE_MISMATCH` | 422 | 导入符号在名单内但类型不符 | 按骨架的读帧/写帧写法重写；目标必须是 `wasm32-wasip1` |
| `COMPONENT_MODEL_UNSUPPORTED` | 422 | 产物是组件模型（不是 core module） | 换回 `wasm32-wasip1` 目标 |
| `SECTION_MALFORMED` | 422 | 自定义段结构非法 | 换官方工具链/骨架重新构建 |
| `SECTION_OVERRIDE_OVERSIZE` | 422 | 自定义段超过 4 MiB | 精简内嵌资源；**HTML/JS 建议 gzip 后再内嵌** |
| `COMPILE_TIMEOUT` | 504 | 编译超过 60 秒 | 精简依赖；不要引入大型第三方库 |
| `COMPILE_OOM` | 500 | 编译所需内存超过平台上限 | 同上：减小模块与依赖 |
| `INVALID_APP_ID` | 400 | 应用名不合法 | 见 SKILL 硬约束第十一条 |
| `NAME_TAKEN` | 409 | 应用名已被占用 | 换名字（同名不同人是不同的应用） |
| `VERSION_INVALID` / `VERSION_NOT_NEWER` | 400 | 版本号不是 `x.y.z` 或不递增 | 改成比线上更大的 `x.y.z` |
| `MISSING_FIELD` | 422 | 非首版缺少 changelog 等必填项 | 补上再发 |
| `APP_CONFIG_INVALID` | 422 | `picoaide.app.json` 缺失/非法/字段越界 | 按提示字段修（注意 `access="whitelist"` 必须有非空名单；字段规格见 `references/app-config.md`） |
| `WASM_TOO_LARGE` / `BODY_TOO_LARGE` | 413 | wasm 超 32 MiB / 上传体超 48 MiB | 精简资源，或把大资源移出应用 |
| `RATE_LIMITED` / `COMPILE_BUSY` | 429 | 上传过于频繁 / 编译队列忙 | 等一会儿再试 |
| `FORBIDDEN` | 403 | 不是这个应用的发布者（或应用已冻结） | 只能改自己发布的应用；需要接管找管理员 |
| `NOT_FOUND` | 404 | 应用/版本不存在 | 核对 `app_id` |
| `VALIDATION` | 400 | 请求内容不合法 | 按 `details` 修 |
| `INTERNAL` | 500 | 平台内部错误 | 重试一次；持续失败提工单并附诊断 |

### 7.1 补充码（上表之外的实现补充）

下面这些码不在上面的失败语义表里，但平台真的会发出来（它们有独立的错误码与 HTTP
映射）。单列出来是为了让"遇到没见过的码"有据可查 —— 把它们压进 `DB_DENIED` / `VALIDATION`
这类通用码，只会把你指向错误的排查方向：

| 码 | HTTP | 触发条件 | 应用该怎么做 |
| --- | --- | --- | --- |
| `HOST_METHOD_UNKNOWN` | 400 | 调了不存在的宿主函数（方法名拼错，或平台没有这个能力） | 只调上面 §3 表里的九个方法；`details.method` 回显你给的方法名，`hints` 列出可用能力 |
| `ASSET_DENIED` | 403 | `assets.read` 的包内路径被拒（绝对路径 / `..` / `\` / 控制字符 / 超长 / 符号链接逃逸），或抽取目录异常 | 用相对、以 `/` 分隔的包内逻辑路径；看 `details.reason`（如 `parent_segment`、`symlink_escape`） |
| `ASSET_OVERSIZE` | 422 | 单个随包资源超过单文件上限（与自定义段总量同源，见 `references/limits.md`） | 精简资源；HTML/JS 先压缩再内嵌 |
| `ASSET_EXISTS` | 409 | 发布期抽取要写的资源已存在（抽取只写一次） | 改资源 = 发一个新版本，不要指望覆盖 |

> 失败码是**可操作**的入口：每个码都带 `message`，多数还带 `details` 与 `hints`。
> 遇到没见过的码，先看 `hints`，再看 `references/diagnostics.md`。

## 8. 渲染 HTML：**可以直接用 `html/template` / `text/template`**

平台的白名单覆盖 Go 运行时会发出的 WASI 导入面，其中就包含模板渲染需要的那几条，所以
**`html/template` 与 `text/template` 的 `New` / `Parse` / `Execute`（渲染）都是允许的** ——
这是本平台最主要的用法：把页面模板编译进 wasm，用 `Execute` 渲染成 HTML 再写成响应体
（配合 `assets.read` 取 CSS/JS，见 §3.6）。

标准写法（渲染到 `bytes.Buffer`，再作为响应体写出）：

```go
var page = template.Must(template.New("page").Parse(`<h1>{{.User}}</h1>`))

var buf bytes.Buffer
if err := page.Execute(&buf, map[string]string{"User": user}); err != nil { /* 500 */ }
// buf.String() 就是渲染好的 HTML
```

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
> 并且有一条独立的覆盖性门禁真编译"`html/template` 渲染 + `ReadAt`"的最小程序断言它落在白名单内
> （`server/internal/wasmapp/wasmmod/imports_coverage_test.go`）。

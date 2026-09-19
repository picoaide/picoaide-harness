# WASM 应用平台：作者指南

> 面向**员工与 AI** 的完整作者指南。设计基线见
> `docs/planning/2026-09-17-wasm-app-platform.md`；AI 的操作手册（随服务端镜像分发）
> 见 `server/skills/app-builder/`。
>
> 平台里的每一个上限数字都来自唯一真源 `server/internal/wasmapp/limits/limits.go`
> （生成物 `limits.md` / `limits.json` 由 `go generate ./internal/wasmapp/limits` 产出，
> 门禁逐字节比对）。本文件不重复抄数字的权威性 —— 有疑问以生成物为准。

## 1. 一句话

**员工写一个小程序，编译成 WebAssembly，上传到平台；平台把它挂在
`<app_id>.<应用基域>` 上，浏览器打开就是一个应用。**

平台的设计原则是**"不给自由度，只给铺好的路"**：能用的能力是一张封闭清单，
超出的部分不是"没开权限"，而是**在平台里不存在**。这样"写错"的形态会被压到很少几种。

两条使用路径：

- **让 AI 写**（推荐）：客户端的 AI 会加载内置技能 `app-builder`，
  按黄金路径生成代码、本机编译、调用平台接口发布。
- **自己写**：照本文件 + 内置技能的 `references/`（ABI、limits、发布、诊断）即可，
  语言是 Go（`wasm32-wasip1`）。

## 2. 能做什么 / 不能做什么

### 2.1 全部原语（封闭清单）

| 原语 | 用途 | 固定约束 |
| --- | --- | --- |
| `db.define(table, columns[])` | 建表（平台代执行，重复调用幂等） | 表名/列名 `^[a-z][a-z0-9_]{0,30}$`；列类型枚举 `text/int/real/bool/datetime`；列不超过 16、表不超过 16/应用；**不能指定主键/外键/索引/触发器** |
| `db.query(sql, args)` | 单条 `SELECT` | 单语句、必须参数化、受 `SQLITE_LIMIT_*` 约束、最多返回 5000 行 / 8 MiB |
| `db.exec(sql, args)` | 单条写语句 | 仅 `INSERT`/`UPDATE`/`DELETE`；禁 DDL |
| `db.tx` | 事务 | ABI 层是 `tx_begin`/`tx_commit`/`tx_rollback`；事务内**只允许数据库读写**（`db.query`/`db.exec` + 两个出口），`ai.chat`/`log`/`assets.read`/`db.define` 与嵌套 `tx_begin` 一律拒；超时 5 秒强制回滚 |
| `ai.chat(messages, model?)` | 调 AI（阻塞、非流式） | 模型由服务端裁决；预算 30 秒；不注入系统提示；按**使用者**身份计费与限流 |
| `log(level, msg)` | 写日志 | 单条不超过 4 KiB；每请求最多 100 条；超出丢弃并计数 |
| `assets.read(path)` | 读随包资源 | 资源在发布期已被抽到宿主磁盘；无文件系统语义、不能穿越；结果用 `encoding` 判别负载（`text` / `base64` / `empty`） |

**没有任何其他能力**：无文件、无网络、无线程、无子进程、无环境变量、无 `PRAGMA`、
无 `ATTACH`、无 DDL、无扩展加载；**也没有任何员工名录能力**（不列举、不搜索、不点查）。

#### 包内资源的可见性（**写机密之前必读**）

`assets.read` 读到的资源**默认不对外公开** —— 它只存在于宿主磁盘上，按包内逻辑路径
读取，没有文件系统语义，也没人能从外面列目录。

**唯一例外是"非保留资源"**：`picoaide.app.json` 之外的一切包内文件（HTML/JS/CSS/
图片/字体/数据文件）会被宿主**按路径直出给任何能打开应用的人**（这正是"静态资源
编译进 wasm"的用法，也是平台能把静态响应缓存起来的依据，§4.2/§4.6）。

因此：

- **不要把机密、账号名单、内部说明、口令、内网地址写进非保留资源** ——
  `GET /data/users.json` 这类请求谁都能拿到，与 `access` 无关
  （要求登录只决定**入口文档**交给谁，子资源仍然直出）。
- **名单放 `picoaide.app.json`**：它是平台保留资源，**不会被直出**；应用自己用
  `assets.read("picoaide.app.json")` 读它，读不到的访问者只会拿到应用自己的
  （404/403）页面。
- 包内资源是**不改名、不发新版就改不掉**的：要改内容必须发新版本（§4.2）。

### 2.1b 页面渲染：`html/template` / `text/template` 可以直接用

**渲染 HTML 页面的标准做法就是把模板编译进 wasm**（R8：静态资源/HTML/JS 全部编入）。
平台的导入白名单由参考实现**真编译取并集**生成，已覆盖模板渲染所需的导入面
（`text/template` / `html/template` 的 `Execute`、`(*os.File).ReadAt/WriteAt` 等），
因此"用模板渲染页面"是**一等公民用法**，不需要额外的特批。

注意两点：
- 模板内容与数据都在你的 wasm 里，渲染结果通过响应信封回给宿主 —— **没有**服务器端模板引擎；
- 白名单是 Go 工具链相关的：升级 Go 版本后若出现 `IMPORT_NOT_ALLOWED`，多半是新的运行时导入面，
  按错误里的 `details.symbol` 报给平台管理员（平台会重跑白名单生成器）。

### 2.2 从作者视角看"不能做"

| 想做的事 | 现实 |
| --- | --- |
| 调用外部 API / 抓取网页 / 加载 CDN | 不可能：应用跑在零网络沙箱里 |
| 读写服务器文件 / 用户磁盘 | 不可能：没有文件系统 |
| 用 Python / Node / Java 写 | 不支持：只产出 `wasm32-wasip1` core module（Go 是 Tier 1） |
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
   `is_publisher`），应用拿不到 Cookie、令牌或名单，也无法伪造。
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

- `access` 三选一：`public`（允许匿名，帧内 `user` 为 `null`）/ `login`（要求登录，
  **登录后全员可用**，缺省）/ `whitelist`（要求登录 + 名单准入）。
- `access="whitelist"` 且 `whitelist` 为空 ⇒ 拒绝发布（那种应用对所有人不可用）；
  `access="login"` 时名单为空是合法的（"登录后全员"）。
- **应用中心一律展示全部应用**（无论公开与否、有没有权限、是否下架）：条目里给出
  访问级别与上架状态。**没有"隐藏应用"这种模式** —— 不想给人用就设 `whitelist` 并只填该给的人。
- **准入判定在应用自己里做**（平台不比对名单）；改任何一项都要发新版本。
- 旧版本配置里的 `login_required` / `visible` 仍能被平台读懂（兼容 shim：映射规则见
  `appcfg.go` 包注释），但新配置一律写 `access`。

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

`preview.mjs` 是一个**假宿主**：按 ABI 收发帧，用内存数据应答 `db.*`、固定文本应答
`ai.chat`。它能验证协议层的一切（帧读写、flush、响应只写一帧、路由与名单分支、
失败分支的文案）；验证不了"真实数据库/真实 AI/真实体积"。

也可以直接用平台预检当"线上体检"：`validate` 不占版本号、不进审计，失败会回
`code` + `details` + `hints`。

## 6. 发布流程

| 步骤 | 端点（管理面只在主站，应用子域不暴露） |
| --- | --- |
| 预检 | `POST /api/client/v2/apps/wasm/validate` |
| 提交新版本 | `POST /api/client/v2/apps/wasm/:app_id/releases` |
| 上架 / 下架 | `POST /api/client/v2/apps/wasm/:app_id/publish` · `…/unpublish` |
| 冻结 / 导出 / 删除 | `POST …/wasm/:app_id/freeze` · `GET …/export` · `DELETE …/wasm/:app_id` |
| 诊断 | `GET …/wasm/:app_id/diagnostics` |
| 自省 | `GET …/wasm/:app_id/schema` |
| 应用中心 | `GET /api/client/v2/apps/wasm/catalog` |

### 6.1 让 AI 自己发布（**首选路径**）

上面那张表是**平台接口**。日常更省事的做法是让 AI 直接调宿主工具 —— 工具在客户端进程内
执行，用的就是当前登录员工的会话令牌，因此"谁让 AI 发的就记谁"，不需要把任何凭据交给模型：

| 工具 | 作用 |
| --- | --- |
| `wasm_app_list` | 列应用中心（确认 `app_id` 有没有被占用、查当前版本号） |
| `wasm_app_validate` | 预检：静态校验 + 真编译 + 干跑。**不占版本号、不进审计**，失败可反复调 |
| `wasm_app_publish` | 发布新版本：同步执行，>8 MiB 自动分片续传；**失败不占版本号** |

- **不要用 `curl` 直接调服务端接口**：那需要员工的登录令牌，模型既拿不到、也不该持有；
  打本机写面同样过不了浏览器的持有性证明。工具是唯一走得通的路。
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
| AI 配额 | **无应用级配额**：沿用使用者自己的余额 + 平台既有限流 |

## 8. 十一条硬约束（§9.4）

1. 编译目标 `wasm32-wasip1`；Tier 1 语言是 **Go**。
2. **无状态**：不要用全局变量存用户/会话状态 —— 实例每请求新建。
3. **同一应用内所有用户共享数据**；要区分用户请自己加业务字段。
4. **stdout 只用于协议帧**（`RS` + 长度 + JSON）；日志走 `log`。
5. **`ai.chat` 是阻塞的**（非流式），界面要显示等待态。
6. **不能联网、不能读文件、不能开线程**；外部资源必须内联（HTML/JS 也编进 wasm）。
7. **准入由你自己判**：配置写在 `picoaide.app.json`（`access` 三模式 + `whitelist`），
   入口第一件事就是读它并比对名单；名单用 `username`/`user.id`；
   无权限页显示"你的账号：xxx"。
8. **平台不提供员工名录**：名单只能手填已知账号；改配置 = 发新版。
9. **不依赖 `$HOME`**：编译器状态目录必须落在会话工作区内。
10. **发布前先本地自测**：Node 内置 `node:wasi` 可零依赖跑通产物，再走 `validate`。
11. **应用名就是域名**（`app_id` → `<app_id>.<应用基域>`）：小写字母/数字/连字符、
    不超过 63 个字符、不能纯数字、不能 `xn--` 开头、不能是保留字；**一经发布不能改名**。

## 9. 容易做错的地方（§5.4）

| 容易做错 | 平台如何让它不可能（或立刻可见） |
| --- | --- |
| 以为应用内数据按用户隔离 | 文档与技能首屏明写"同一应用内所有用户共享数据" |
| 用全局变量存状态 | 实例每请求新建 ⇒ 用了也不生效 |
| 往 stdout 打日志 | 非 `RS` 开头的内容一律当日志捕获，不污染协议（但也没有级别/条数管理） |
| 编译目标用错 | 上传期导入白名单直接拒，hints 指明 `wasm32-wasip1` |
| 版本号写错 / 忘写 changelog | 预检明确拒 + 结构化 hints |
| 写出慢查询 | 每条语句 5 秒硬超时 + `SQLITE_LIMIT_*` + 诊断事件 |
| 想调并发 / 队列参数 | 作者不可调（运维可在控制台「应用中心 → 限制项」改全局值）：同一应用默认最多 **4 个请求并发**（读并发；**写仍串行**），**单个用户在同一应用内默认只有 1 路**（`user_per_app_running`），超出进队列（默认 32，可调到 4096），队列满 429 |
| 事务里调 `ai.chat` / `log` / `assets.read` / `db.define` / 再开一个事务 | 直接报错（防事务长期持锁 + 占满执行槽）；事务内**只能做数据库读写**：`db.query` / `db.exec` + `tx_commit` / `tx_rollback` |

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
| `DB_DENIED` | 多语句 / DDL / `PRAGMA` / 提到保留列 / 没参数化；**事务内调了被禁能力**（`details.kind` = `nested_tx` / `blocking_capability` / `ddl`） | 建表走 `db.define`；语句只留四个动词；值放 `args`；事务里只留 `db.query`/`db.exec` |
| `ASSET_DENIED` | `assets.read` 的包内路径非法/越界，或抽取目录异常 | 路径用相对、`/` 分隔、不含 `..`；不要读自己没有的资源 |
| `ASSET_OVERSIZE` | 单个随包资源超过 4 MiB（与自定义段总量同源） | 精简资源；HTML/JS 先 gzip 再内嵌 |
| `ASSET_EXISTS` | 发布期抽取要写的资源已存在（抽取只写一次） | 改资源 = 发新版本，不要指望覆盖 |
| `HOST_METHOD_UNKNOWN` | 调了不存在的宿主函数（拼错方法名、或平台没有的能力） | 只调封闭清单里的九个方法（见 `references/abi.md` §3） |
| `DB_LIMIT` | 库满 100 MB 或返回超行数/字节、语句超时 | 清理历史数据或做汇总表；分页 |
| `APP_QUEUE_FULL` | 用的人多 | 按 `Retry-After` 退避，别立刻重试 |
| `AI_BALANCE_INSUFFICIENT` | 使用者余额不足 | 提示本人去桌面客户端看余额；**不显示金额、不重试** |
| `AI_RATE_LIMITED` | 调用过于频繁 | 减少循环内调用，合并提示词 |
| `FORBIDDEN` | 不是该应用的发布者（或应用已冻结） | 只能改自己发布的应用 |
| `NAME_TAKEN` | 应用名被占用 | 换名字（同名不同人是不同应用） |

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

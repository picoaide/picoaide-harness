# 应用作者数据面：只读行浏览（`GET …/wasm/:app_id/rows`）

- 日期：2026-09-21
- 状态：已实施（服务端 + 客户端面板 + AI 工具面）
- 相关：`docs/planning/2026-09-21-wasm-platform-gap-audit-and-plan.md` §5（专项方案）、
  `server/internal/wasmapp/api/rows.go`（实现与安全论证）

## 1. 问题

平台此前只有两种"看得到"的能力：

- `GET …/wasm/:app_id/schema`：表/列/行数/占用（**且客户端与管理端都没有入口**）；
- `GET …/wasm/:app_id/export`：控制面元数据（明确 `database.included=false`）。

**行内容没有任何出口**。作者（尤其是替员工写应用的 AI）在发布之后是盲的：员工报
"数据不对"时无法回答"库里到底有什么"，只能改代码发一版 dump 页。

设计总纲 §3 F1–F16、§17、§21.7、09-17 基线、作者指南与技能文档**都没有承诺过**
行级数据查看 ⇒ 这是一个**未立项的产品空白**，不是漏做的功能（`app-lifecycle.ts` 的
旧注释也写着"自省/导出留给后续波次，无产品决策不暴露"）。

## 2. 决定

1. **新增只读端点** `GET /api/client/v2/apps/wasm/:app_id/rows?table=&limit=&offset=&unmask=`
   （员工面，**仅发布者本人**）与管理面同形端点 `GET /api/server/admin/wasm-apps/:app_id/rows`
   （`capability:read`）。
2. **默认脱敏**：按列名启发式（整词匹配，避免 `total`→`tel` 这类误判）把敏感列渲染成
   `***`；**原值只能由人显式 `unmask=1`**，且该次调用写**另一条**审计动作
   （`wasm_app_rows_view_unmasked`）。AI 工具面**没有** unmask 参数。
3. **每次调用写审计**（`wasm_app_rows_view`），审计**只记表名/分页/行数/脱敏状态**，
   **绝不记行内容**（把行内容写进审计等于把 PII 复制一份到审计表）。
4. **实现只允许一份**：行查询走 `appdb` 的加固连接（语句闸门、单语句 5 s 预算、
   5000 行/8 MiB 上限、`_row_id` 投影剥离、值类型规整全部继承）；连接用**独立句柄**
   （每次请求 Open/Close），避免污染服务请求的 `db_rows/db_bytes` 计量。
5. **只读端点没有写副作用**：先 `appdb.Path` + `os.Stat`，库文件不存在时回 404 并给
   可操作提示，**不**为了读一次就把库建出来。
6. 同时补上管理面的 `GET …/wasm-apps/:app_id/schema`（此前管理端连结构自省都没有）。

## 3. 安全论证（为什么这**不**新开越权面）

- 应用代码是作者写的，而应用对自己的库有**完整读写权**（R15：平台不做行级过滤）
  ⇒ 作者今天已经可以发布一个"把整表渲染到页面"的版本、自己打开看。本端点只是把
  "先发一版调试代码"变成"直接查"，作者对数据的**有效访问没有扩大**。
- 真正的新增面是"**AI 读行内容 ⇒ 使用者 PII 进模型上下文**"。因此：
  - 员工面鉴权 = `ownedApp`（非发布者一律 404，且与"应用不存在"**逐字节同形**）；
  - 默认脱敏 + 显式 unmask 才给原值；AI 工具面连 unmask 参数都没有；
  - 全部调用写审计（操作者账号如实记录，作者看的与管理员看的可事后区分）。
- **认账**：启发式脱敏会漏（列名不含敏感词的真实 PII 列不会被遮），也会误判。
  取舍是"漏判 = 作者看到本就能通过应用代码看到的数据；误判 = 排障变难"。
  更彻底的口径（按 `data_sensitivity` 声明分级、或强制应用声明敏感列）属后续产品决策。

## 4. 判据（施工时落地）

服务端：`server/internal/wasmapp/api/rows_test.go`（8 条）—— 仅发布者/同形 404、
默认脱敏 + 独立审计动作、分页收敛、单值截断、`_row_id` 不出现、库不存在不建库、
管理面可用、表名与参数校验。
客户端：`data-browser.spec.tsx`（8 条）—— 展开才取数、脱敏与 unmask 重新请求、
失败不回落成空表、空表/无表区分、翻页、截断提示。
宿主代理：`tests/wasm-apps.spec.ts` 的"生命周期与只读代理"用例 —— **查询串原样转发**
（该用例实测抓到过一次"代理吞掉查询串"的真实缺陷）。
AI 工具面：`tests/wasm-app-tools.spec.ts` —— 三条工具的出站路径、`rows` **永不带
unmask**、审计账号放行、未登录零出站。

## 5. 未做（明确边界）

- 不提供写入（清理脏数据）与自由 SQL 查询：前者需要新的信任模型，后者需要先证明
  结构化浏览的表达力不够（方案对比见规划 §5.6）。
- 不提供数据导出（`export` 的"不含使用者数据"边界不变）。
- AI 请求原值的授权流（逐次同意卡）未做：当前 AI 只能看脱敏后的数据。

## 6. 规划 §5.9 的 10 个待拍板点：逐条落实（2026-09-21 补记）

规划 §5.9 把这 10 条列为"施工前需要拍板"。首版实现**先落地后补记**，且第 2 点
（是否对 AI 开放）在实现里是**默认开**、而规划推荐的是"默认关 + 显式授权卡" ——
这是一次真实的"实现替产品做了决定"，审计（2026-09-21 独立审计 P1-③）指出后补记如下。
**每条都给出当前事实、依据与判据**；与规划推荐不一致的，如实标注"未采纳推荐"。

| # | 问题 | 落定值 | 与规划推荐 |
| --- | --- | --- | --- |
| 1 | 对**作者本人**开放？ | **开放，只读** | 一致 |
| 2 | 对 **AI** 开放？ | **默认关 + 显式授权卡（2026-09-21 用户拍板落地）**：`wasm_app_rows` **注册但拒绝** —— 未授权时返回结构化 `AI_ROWS_NOT_AUTHORIZED`（含操作指引、**零出站**），不静默给空。授权由**发布者本人**在客户端「应用中心 → 详情 → 数据」的授权卡上开启（逐应用、可撤销、持久化在 `$DSH_HOME/wasm-apps-ai-rows-consent.json`，0600 原子写），宿主本机路由 `GET/POST /api/pico/apps/wasm/:app_id/ai-rows-consent`（**两种方法都要求持有性证明**）读写该状态。工具面**仍然没有** `unmask` 参数：授权只决定"能不能看脱敏后的行"，原值永远只能由人在面板里显式查看。 | ✅ 已采纳推荐 |
| 3 | 对**管理员**开放？ | **开放**，`capability:read`，动作 `wasm_app_rows_view`（unmask 另记一条） | 一致 |
| 4 | 允许**写**？ | **不允许**（首版） | 一致 |
| 5 | 自由 SQL vs 结构化？ | **结构化**（`?table=&limit=&offset=`），语句闸门与 `appdb` 同一份 | 一致 |
| 6 | 审计粒度 | **每次查询一条**，字段只含表名/分页/行数/脱敏状态，**不含行值** | 一致 |
| 7 | 允许导出数据文件？ | **不允许**（`export` 保持"不含使用者数据"） | 一致 |
| 8 | 脱敏策略由谁定？ | **列名启发式（整词匹配）为默认**；作者声明 `sensitive_columns` 未做 | 一致（推荐里的第二半未做） |
| 9 | 退役/冻结/软删后仍可读？ | **当前实现：软删（`deleted_at` 非空）后 `ownedApp` 仍返回该应用 ⇒ 作者仍可读行**。定案：**这是有意的**——保留期内（`retention_days`）作者需要能核对"删之前数据是什么样、导出/迁移是否完整"，而保留期结束后行随库一起消失；冻结（`frozen`）不影响读。真正的边界是**管理员**：管理面同形端点在软删行上仍可用（`capability:read`），合规上可取。 | ⚠️ **与推荐不同**（推荐"软删后仅管理员"）：本版选择"保留期内作者可读"，理由是软删本身可撤销、且作者在此期间仍可能被要求恢复应用 |
| 10 | 给员工看？ | **不给**（R36/R24 口径不变：目录只回答"有什么应用"，行数据只给作者与管理员） | 一致 |

### 第 2 点（AI 默认可读）的依据与风险 —— 必须如实认账

**依据**（为什么这样也能接受）：

1. AI 能读的**只是脱敏面**：`wasm_app_rows` 没有 `unmask` 参数（`wasm-app-tools.ts`
   的入参 schema 里根本不存在这个字段），服务端默认按列名脱敏；
2. 作者本人（也就是 AI 服务的对象）本来就能通过**自己写的应用**看到同一批数据
   （R15：平台不做行级过滤）——AI 若真要绕过，让作者发一版 dump 页即可；
3. 每次调用都写审计（`wasm_app_rows_view`），事后可区分"人看的"与"AI 看的"。

**风险**（为什么不等于规划推荐）：

1. 启发式脱敏**会漏**：列名里没有敏感词的真实 PII 列不会被遮（本文件 §3 已认账）；
   于是"AI 只看脱敏数据"这句承诺的实际强度 = "列名恰好带敏感词的数据不会被 AI 看到"；
2. **默认开**意味着"作者没有做过任何授权动作，AI 就已经能读"——这与规划推荐
   （默认关 + 显式授权卡）在**默认姿态**上相反，而这正是审计 P1-③ 指出的问题；
3. 授权流（逐次同意卡）需要新的交互与状态面，属独立产品决策，本批未做。

**落地口径**：本版维持"默认开 + 只脱敏 + 全审计"，并把上面三点写进文档而不是留在
代码注释里。若后续要转成规划推荐的口径，改动点是**一处**：`wasm-app-tools.ts` 里
`wasm_app_rows` 的 `gate(locale,'read')` 换成"首次调用返回 `AI_ROWS_NOT_AUTHORIZED`
+ 授权卡"，服务端不动（鉴权与脱敏已在服务端）。

## 7a. 只读打开的**残留风险**（如实认账，不假装闭合）

`appdb.SafePath` 在只读端点（`rows`/`schema`）上做了三件事：路径由平台推导（不接受外部
路径）、`Lstat` 拒**符号链接**的应用目录与库文件、库不存在时**不建库**。以下两条**没有**
被覆盖，属于本版认账：

1. **硬链接**：`Lstat` 只能看"这一条路径是不是符号链接"，看不出"这个 inode 还有别的名字"。
   数据根里出现指向别的应用库的**硬链接**时，`SafePath` 放行、`/rows` 会读到那份数据。
   不修的理由：在 `<data_root>/apps/<id>/`（0700、属主 = 服务端用户）里制造硬链接，
   需要的权限**已经等于**直接改写那个库文件 —— 攻击者不需要绕这一圈；而
   `Nlink > 1` 之类判据会在合法的备份/快照工具链上误伤（那些工具正是靠硬链接做增量）。
2. **检查与打开之间的 TOCTOU**：`Lstat` 通过之后到 SQLite `open()` 之间，路径仍可能被
   换成符号链接（竞态窗口极短）。不修的理由同上（需要数据根写权限），且彻底闭合要
   `O_NOFOLLOW` + `openat` 逐段打开（modernc 的 driver 不接受已打开的 fd）。

两条的共同前提是"**攻击者已拥有数据根写权限**"；那个前提下应用库本身（含所有使用者数据）
已经在对方手里，`/rows` 不是额外的越权面。真正要把这两条也闭合，需要的是**把数据根移出
服务端用户的可写范围**（部署面：独立 uid / 只读挂载），不是再加一层路径判据。


## 7b. 持有性证明挡不住"AI 自己开浏览器" —— **已修（两批：先堵导航入口，再把凭据移出模型面）**（三轮审计 P1-①）

### 事实（三个使能条件都实测过）

1. 宿主本机路由 `GET /api/pico/apps/wasm/:app_id/rows` 现在要求**持有性证明**
   （`dsh-auth-*` cookie，见 §2/§7 的判据）—— 这一步是有效的：本机伪造 Origin 的 `curl`
   拿不到 cookie，403。
2. 但**内置浏览器的分区故意镜像了这把 cookie**：`packages/host/browser/src/index.ts:475-505`
   的 `mirrorBrowserAuthCookies` 把 shell origin 的 `dsh-auth-*` 从 defaultSession 复制进
   当前浏览器分区（这是产品需要：`/browser-shell`、`/browser-overlay` 两个页面的写操作
   要靠它过 `requireWriteProof`）。
3. 而导航策略**不拦 shell origin**：`packages/host/browser/src/guard.ts:88` 的
   `ALLOWED_SCHEMES` 对浏览器标签放行一切 `http(s)`，`classifyNavigation`（同文件 `:109-128`）
   只对**应用窗口**（`kind:'app'`）做来源限制。

⇒ 模型用 `browser_navigate('http://127.0.0.1:<port>/api/pico/apps/wasm/<app>/rows?table=…&unmask=1')`
再用 `browser_get_text` 读回，就能拿到**未脱敏**的行数据。宿主侧的持有性证明**无法区分**
"真页面的人"与"模型驱动的标签页"—— 因为那个标签页**就是**一个持有 cookie 的真页面。

### 采用方案 A：把 shell origin 从"浏览器标签可导航目标"里排除（2026-09-21 实施）

**落地**：`BrowserRuntime` 新增 `navigationAllowed(url)`（`runtime.ts:713-745` 附近）——
先判 `isShellOriginUrl(url)`（同文件，`shellOrigin` 未设置时**恒 false**：没有 shell 就没有被
镜像的 cookie，不能退化成"守卫缺席即全拒"），命中即拒；否则委托给既有的
`guard.allowNavigation`（scheme 策略）。**模型可达的三条导航入口全部改用它**：
`browser_navigate`（`navigateInternal`）、`window.open`/`target=_blank`
（`setWindowOpenHandler`）、`browser_download`（`downloadUrl`）。

**为什么只拒这一个 origin，而不是"所有回环地址"**：被镜像 cookie 的作用域就是 shell origin；
`127.0.0.1` 上的**其它端口**是合法的开发目标（作者常让 AI 看自己本地的 dev server），
一并拒掉是"为了安全毁掉功能"。判据里有一条**反向对照**专门钉这个方向。

**第二道闸：`will-navigate` / `will-redirect`**（同批追加，同一族）——
`browser_navigate` 那条闸只罩"模型显式调用的导航"，而以下两种导航**不经过**它：
① 模型先导航到一个**它控制的**外站，再让那个站 302 到 `http://127.0.0.1:<port>/api/pico/...`
（Electron 对重定向**不触发** `will-navigate`）；② 页面自己发起的导航
（`location.href=…`、链接点击、表单提交、meta refresh）。两者都发生在**持有被镜像 cookie
的标签里**，因此同样绕过所有依赖持有性证明的本机守卫。现在建 tab 时装上
`will-navigate` + `will-redirect` 两个监听（`runtime.ts` 的 `refuseShellOriginNavigation`），
命中 shell origin 即 `preventDefault()` 并记一条失败的 op。判据见同一份 spec 的第 4 条
（直接触发两个事件，断言 shell origin 被取消、外站不被取消）：去掉这两行监听 ⇒ 该条必红。

**为什么宿主自己的两个页面不受影响**：`/browser-shell` 与 `/browser-overlay` 由
`ensureWindow` / `mountOverlay` 用 `webContents.loadURL` 直接加载（`runtime.ts:1104/1054` 等），
**不经过**这三条模型入口。

**判据**（`packages/host/browser/tests/audit-0921-shell-origin.spec.ts`，5 条）：
① 三条入口对 shell origin 全部拒绝（含 `rows?unmask=1` 的绕过尝试；断言 `BrowserError.code`
= `navigation-blocked`，不是只比文案）；② 反向对照：`127.0.0.1:<其它端口>`、`localhost`、
外站仍放行；③ `shellOrigin` 未设置时判据不生效（守卫缺席 ≠ 全拒）。
其中 `window.open` 那条的判据是**标签数**而不是 handler 返回值 —— 该 handler 恒返回
`{action:'deny'}`（弹窗由宿主自己 `this.open()` 变成新标签），比返回值会写出恒真断言。

**变异验证**：把 `isShellOriginUrl` 分支关掉（退回三轮审计时的形态）⇒ 三条 ① 用例全红
（`browser_navigate` / `window.open` / `browser_download` 各一条）。

**连带改动**：`tests/audit-r9-chrome-locale.spec.ts` 原来用 `open(SHELL_ORIGIN + "/blank")`
**只为造一个标签**（它钉的是"重载 chrome 页不动标签视图"）；该用例改成开普通外站，
并在注释里写明原因（不是放宽判据，是这条 URL 与它要钉的语义无关）。

### 四轮审计后的收紧：从"拒 shell origin"扩到"**拒一切本机目标**"（P0 + P1）

四轮独立审计用**真机**（Electron 43.4.0 + 真 runtime + 真 `browser_*` 工具）复现了两个绕过：

- **P0（子框架无人管辖）**：Electron 的 `will-navigate` / `will-redirect` **只报主框架**，
  而浏览器包从未注册 `will-frame-navigate`。攻击序列：模型导航到一个**自己控制的本机页面**
  （`127.0.0.1:<其它端口>`，正是本文件上一版"反向对照"明确放行的"合法 dev server"）→
  该页里 `<iframe src="http://127.0.0.1:<shell端口>/api/pico/.../rows?unmask=1">` →
  `browser_eval({frame:1})` 读子框架正文 ⇒ 拿回 `UNMASKED-13800000000`。
- **P1（cookie 不看端口）**：镜像过去的 `dsh-auth-*` 是 **host-only** cookie，而 **cookie
  不区分端口** ⇒ 它会被送到 `127.0.0.1` 的**任意端口**。真机实测：模型在自己端口上起的
  服务收到 `Cookie: dsh-auth-…`（对照：`localhost` 主机收到空）。这把 cookie 就是本机控制面的
  bearer 凭据（可重放 login / 会话切换 / 技能安装 / `rows?unmask=1`，因为 `guard()` 自述
  "伪造 Origin 的 curl 也能过"，只有 cookie 验签是真的）。同 host 不同端口属 **same-site**，
  `SameSite=Strict` **不拦** —— 所以"外部页面 iframe 本机端口"这条也得防。

**收口（本批实施）**：`isForbiddenLocalTarget(url)` = shell origin 精确相等 **∪**
一切本机主机名（`127.0.0.0/8` / `::1` / `localhost` / `0.0.0.0`）；四条路径全部改用它：
`navigateInternal`、`setWindowOpenHandler`、`downloadUrl`，以及新建 tab 时注册的
`will-navigate` + `will-redirect` + **`will-frame-navigate`**（子框架，纵深防御）。
本机 deny 的理由从"那里是 shell"变成"**那里有被镜像的凭据**"，因此 `shellOrigin`
缺席时判据**依然生效**（不再依赖那个字符串存不存在）。
（写第二批之后回看：凭据已不再住进标签分区，这条判据按其后的**纵深防御**口径保留 ——
本机回环面就是宿主控制面，见本节的"第二批"。）

**代价（如实认账）**：AI 浏览器**不能再访问任何本机地址**，包括作者本地的 dev server ——
这是有意的取舍：那类地址就是宿主控制面（登录态、连接器、应用数据与浏览器写面），而
"AI 看本地 dev server"不是产品承诺的能力（平台自己的页面由宿主 `webContents.loadURL`
直接加载，应用走应用窗口面，都不经过这里）。反向对照判据保证不退化：外站 `http(s)` 一律照常放行。

**仍然残留（部署面）**：指向**同一台服务器**的其它主机名（反代/自定义域名）不在本判据内 ——
那些形态下 cookie 是否被镜像取决于部署（镜像只按 `shellOrigin` 取 cookie）；若将来出现
"其它本机 origin 也持有证明"的形态，应把判据改为**按 cookie 作用域**而不是按主机名字符串。
（凭据镜像本身已在下面第二批里删除，所以这条现在只剩"间接形态"的理论面。）

### 第二批：把蒙版挪回默认 session —— 凭据不再住进模型可驱动的 jar（2026-09-21）

**为什么还要修**：第一批只堵住"模型**可达的导航入口**"，根妥协没有动 ——
`src/index.ts` 的 `mirrorBrowserAuthCookies`（约 476-507 行）把默认 session 里回环源的
`dsh-auth-*` **复制进** `persist:agent-browser-<user>`，而那正是 `browser_*` 工具驱动的那批
标签页所在的 cookie jar。导航闸门是**外围**判据：被复制的凭据本身就住在模型面里，
任何一条没被闸门覆盖的取数路径（新窗口、新协议、将来的工具）都会重新变成"持票的真页面"。

**采用方案：把蒙版（overlay）视图挪回默认 session（任务书里的方案 (a)）。
⚠️ 名称消歧：本节第一批的"方案 A"指"拒绝模型导航到本机目标"，两者不是同一件事。**

**为什么不是"给 overlay 一条不依赖 cookie 的证明通道"（任务书方案 (b)）**：
`/browser-overlay` 是本插件自己经回环端口服务的页面，而 `guard()` 的边界（`loopback.ts`
自述）就是"伪造 Origin/头的本机进程也能过"。因此**写在 HTTP 应答里的** token 对"本机任意
进程"没有任何鉴别力 —— 它能自己 GET 一份。要做到至少与 cookie 等强，token 只能走
**Electron 专属通道**（preload + `additionalArguments`/IPC），那要新增一个必须随包构建、
必须进 desktop afterPack 清单的 preload 产物，并给 `proofOfPossession` 加第二套校验；
而方案 (a) 让**已有的** cookie 直接生效：蒙版与 shell 页、主应用窗口同处一个 jar。
少一个凭据面、少一条构建/打包链，收益相同。

**落地**（写此记录时的锚点，均在 `packages/host/browser/`）：
- `runtime.ts:1167` `mountOverlay` 改调 `this.adapter.createMaskView()`（**不传分区**）⇒
  蒙版落在 Electron 默认 session，与 `createBrowserWindow()` 的窗口 webContents 同一个 jar
  —— `dsh-auth-*` 天然在里面（token 换票发生在同一个默认 session）。
- `electron-adapter.ts:417` 的 `createMaskView(partition?)` 在 `partition === undefined` 时
  **根本不写** `webPreferences.partition`（`NativeView.partition` 随之变为可选，
  `electron-adapter.ts:257`）。显式传分区仍然生效（只有测试/将来别的 surface 会用）。
- `runtime.ts:688` `setPartition` 只切标签分区与 store：蒙版**不再跟着分区走**，
  旧的"切账号重建蒙版"路径（`remountOverlay`）整段删除 —— 那本来就是为镜像补的丁。
- `index.ts` 删除 `mirrorBrowserAuthCookies`、`cookie-handoff.ts`（连同其自测）、
  `startCookieHandoff/stopCookieHandoff` 与 `BROWSER_AUTH_COOKIE_PREFIX`；`clear-data`
  分支里"清完再交接一次"的补丁与 `page()` 里"加载页面顺带交接"一并删除（默认 session 的
  票据不在清理范围内）。
- **保留并显式接线**原来寄生在交接函数里的安全副作用：分区权限守卫
  （`ensureSessionGuard`，§16.1 冻结"归属 = 分区初始化"）。新 `index.ts:441`
  `ensureBrowserPartitionGuard(user)` 在**开机**（`ctx.effect`）与**切账号**
  （`applyUserScope`）各调一次，经 `runtime.sessionForPartition`（`runtime.ts:3462`，
  不自己 `require('electron')`）拿到 session 再 `runtime.ensurePartitionGuard`
  （`runtime.ts:3447`）。**不得**把守卫装到默认 session 上 —— 那是主应用窗口所在的 jar。

**判据**（都是行为判据；`packages/host/browser/tests/`）：
- `audit-0914-mask-partition.spec.ts`（2026-09-14 P0 的回归，已按新不变量重写，5 条）：
  ① prewarm 调 `createMaskView` 时**实参个数为 0**；② 切账号**不重建/不销毁**蒙版，
  同时**标签仍落新用户分区**；③ 蒙版与标签在**不同 session**；④ 分区未变不 churn；
  ⑤ 无窗口时切分区不建视图。旧断言（"切分区必须重建蒙版"）在方案 (a) 下已不成立 ——
  它是镜像链路的补丁，不是产品语义；改写而不是删除，并保留了原 P0 的用户可见结果。
- `audit-0921-credential-isolation.spec.ts`（新增，7 条）：① 真实适配器下
  `createMaskView()` 的 webPreferences **没有** `partition` 键（`in` 判据，不是 `undefined` 比较），
  且与 `createBrowserWindow()` 同 jar、`transparent` 未丢；② 显式分区仍写键（标签那条路未改坏）；
  ③ 源码里五条"凭据搬运 API"（`x.cookies`、`x['cookies']`、`defaultSession`、
  `onBeforeSendHeaders`、`requestHeaders`）**零命中**，且 `cookie-handoff.ts` 与其自测文件
  必须不存在；④ shell 页由宿主 `loadURL` 加载、**不在标签台账**里（蒙版同理），
  分区权限守卫装在该分区上、重复调用幂等、**默认 session 未被装**，`index.ts` 的开机/切账号
  两处接线存在且不再有交接表。
- 产品面不被修坏：`audit-r7-write-proof.spec.ts` 的写面矩阵补入蒙版的 `takeover` 与 `hide`
  （无票 ⇒ 403；持票 ⇒ 200 且真的驱动 runtime）；页面行为仍由 `shell-pages.behavior.spec.ts`
  （jsdom 真跑两个页面）覆盖。
- 标签的写面**没有**放宽：`browser_navigate`/`window.open`/`browser_download` 与
  `will-navigate`/`will-redirect`/`will-frame-navigate` 仍一律拒本机目标
  （`audit-0921-shell-origin.spec.ts` 全绿）。

**变异验证**（在包副本 `temp/s7b-scratch/browser/` 里实跑，真树文件 sha256 前后一致）：
`mountOverlay` 改回传分区 ⇒ 0914 ①③⑤ 红；适配器恢复 `partition` 默认值 ⇒ cred-iso ① 红；
把镜像照抄回来（三种写法：`session.cookies?.set` / `session['cookies']?.set` /
`onBeforeSendHeaders` 塞 `Cookie`）⇒ cred-iso ③ 红；`ensurePartitionGuard` 掏空 ⇒
cred-iso ④（守卫）红；删掉开机那次接线 ⇒ cred-iso ④（接线）红；`setPartition` 恢复
"销毁 + 重建蒙版" ⇒ 0914 ② 红；`createView()` 丢掉分区 ⇒ 0914 ② 红。

**认账的边界**：③ 那条是**静态 tripwire，不是形式化证明**（`session['coo'+'kies']` 这类
拼写可绕过；`vi.mock('electron')` 拦不住 `createRequire('electron')`，所以这条只能以源码
扫描形态存在）。真正的保证是三件事叠加：行为判据钉住"蒙版不传分区 / 标签按分区"、
标签分区里的 cookie 只能由**页面自身的网络活动**写入（而本机目标被导航闸门全面禁止）、
以及这把 cookie 是 HMAC 签名（伪造值过不了 `requestRejection`）。


## 7. 与本次修订同时新增的判据（2026-09-21 审计修复批）

- 宿主代理：`tests/wasm-apps.spec.ts` 新增两条 ——
  ① `GET …/rows?unmask=1` **无持有性证明 ⇒ 403 且零出站**，带真页面 cookie ⇒ 200 且
  查询串逐字转发；② **只有白名单后缀转发查询串**（非白名单路由带 `?search=x` 出站
  时 URL 里不得出现 `?`）。两条都做过变异验证（去掉栅栏 / 把 query 扩到写面 ⇒ 必红）。
- 服务端：`rows.go` 的"库不存在 ⇒ 404 且不建库"由 `appdb.SafePath`（`Lstat` 拒符号
  链接 + 不建库）在**helper 层**保证，不再依赖调用方的预检。

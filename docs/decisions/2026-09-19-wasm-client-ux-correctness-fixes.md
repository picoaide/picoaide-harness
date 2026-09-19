# WASM 应用中心客户端面：发布预填 / 错误信封 / 体积闸门 / 契约对拍（2026-09-19）

本文件记录 2026-09-19 只读审计后**客户端侧**七条缺陷的修复决策与边界。改动落在
`packages/client/wasm-apps/**`、`packages/host/enterprise/src/wasm-apps.ts`（以及对应测试）、
`server/internal/wasmapp/api/read.go`、`server/internal/wasmapp/appcfg/appcfg.go`（仅文案）。
设计基线仍是 `docs/planning/2026-09-17-wasm-app-platform.md`（§4.2 / §8）。

七条的共性：它们都不是"服务端裁决错了"，而是**客户端把服务端已经说清的事丢掉了或
替作者做了决定** —— 所以修法一律是"把信息还给作者/模型"，不新增业务规则。

---

## 1. 发布不预填当前配置 ⇒ 一次纯代码更新会静默改写线上 `access`（P1-3）

**问题**：`PublishForm` 的 `access` 初值硬编码 `DEFAULT_ACCESS`（`login`）、
`data_sensitivity` 硬填 `internal`；`buildPublishBody` 提交时**无条件**发送全部五个配置
字段。对 `access=public`（**该取值已删除**，见本段末 ⚠️）的应用发新版，作者不动单选框 ⇒ 新版本变成 `login`（访问范围被
静默改写，服务端还会写一条 `wasm_app_access_change` 审计）；⚠️ **2026-09-19 后**：`public` 已不是可写取值
（写侧只接受 `login` / `whitelist`，存量 `public` 读取侧按 `login`，总纲 §8.4 + 迁移 0074），
本文引用的「公开」形态只存在于该轮审计时的历史数据里；`data_sensitivity` 则被界面
统一抹平成同一个值，而 `appcfg.json` 明写"平台**没有**这个字段的默认值：不要指望界面或
平台替你填"。

**决策一：预填，而不是"改成未选择 + 强制显式选择"。**
目录行是唯一的"当前值"来源，而它本来就有 `access` —— 缺的只是把它交给表单。因此：

- 目录每行给出发新版入口（`is_owner=true` 时），点击进入发布表单时带上
  `PublishTarget`（`appId`/`title`/`access`/`currentVersion`/`owner`/`purpose`/`whitelist`）；
- 首版发布（表头"发布"按钮）不带基线 ⇒ 仍然取 `login` 缺省（与服务端
  `appcfg.json` 的 `access_default` 同源，有对拍守），且**没有**"当前值"因而没有改动判定。

**决策二：`data_sensitivity` 结构性不可预填。** `PublishFormInitial` 类型里**没有**这个键
（不是"填了空串"，是"类型上不存在"），表单初值恒为 `''` 并在字段下方标注"没有平台默认值：
需要你声明"。想给它塞默认值必须先改类型 —— 那时对拍用例会红。

**决策三：改动访问范围必须显式确认。** 选中值与当前值不同时出现确认框，文案是
"访问范围将被修改：公开 → 登录后使用" + 勾选框；未勾选时提交被**本地**拦下
（`access_change_unconfirmed`，不发请求）。换一个取值会**撤销**上一次的勾选 ——
用户确认的是那一对具体取值。成功块额外回显本次提交的 `access`（发布响应里没有这个字段，
所以回显的是提交值；服务端没接受它就不会走到成功块）。

**`purpose` / `whitelist` 按调用者下发（不是无条件下发）。** 这两个字段原先不在目录里，
而发布是**整体替换配置**（`publish.go` 的 `prepare` 不做逐字段合并）：白名单应用若拿不到
原名单，作者只能凭空重填，而 `access=whitelist` + 空名单会被服务端一律拒。同时目录对
全体员工可见（R38），把账号名单下发给所有人等于把每个应用的准入名单摊开。两者同时成立的
唯一形态是"只给发布者本人"（`read.go` 的 `if isOwner`）——发布新版本来也只有发布者能做
（`ownedApp` 对非发布者一律 404）。

**测试**：`app-center-mount.spec.tsx`（真挂载：预填逐字段、data_sensitivity 留空、
改动确认三态、成功块回显）+ `publish-app.spec.ts`（`initialFormState` / `changesAccess`
纯函数）。变异验证：把 `access` 初值改回硬编码、把 `data_sensitivity` 改回 `internal`、
去掉确认闸、换取值不撤销勾选 —— 四条各自变红。

## 2. 目录与 `wasm_app_list` 都不下发"当前版本"（P1-4）

**问题**：工具描述要求模型"发布前先确认 app_id 有没有被占用、以及已有应用的**当前版本号**
（新版本号必须严格大于它）"，而目录行没有版本字段 —— 模型只能猜，猜错的代价是一次完整
上传（≤32 MiB）+ 审计拒绝 + 消耗上传额度。

**决策：复用管理面同一份实现。** `read.go` 的 catalog 用 `serverstore.WasmAppCurrentVersions`
批量取一次（与 `admin.go` 同源，因为它就是同一个问题的答案），行里新增 `current_version`
（版本行被保留策略回收时为空串，客户端按"未知"渲染，**不编造**版本号）。客户端
`AppCenterItem.currentVersion` 在目录行显示"当前版本: X"，发布表单的上下文条也显示它。
工具面不需要改：`wasm_app_list` 输出=目录原样，描述里的承诺随之兑现。

## 3. 加载失败丢弃服务端信封（P1-5）

非 2xx 时面板**丢掉响应体**、只拼 `加载失败 (HTTP 502)`，而宿主给的是可执行的
`{error:{code,message,details,hints}}`（例如 `GATEWAY_UNAVAILABLE` + "检查网络与服务端地址"）。
修法：走包内既有的 `parseErrorEnvelope`，渲染成与发布失败块同一形状（code + message +
hints + 可选原文）。401 仍保持可读的本地文案，但 code/hints 照样显示。
`app-center-mount.spec.tsx` 里原先把旧行为钉死的用例已升级为断言 message/hint 文本 ——
它现在就是这条修复的门禁。

## 4. 页面发布路径没有体积闸门（P1-10）

选文件即 `file.arrayBuffer()` 读全量 → base64 → `JSON.stringify`，超限文件在渲染进程主线程
持 3–4 倍峰值内存（界面先冻一次），最后才拿到 `UPLOAD_TOO_LARGE`；而 32 MiB 上限原先只在
宿主的两条 `wasm_path` 分支上有，**base64 分支没有**。

**决策：三处同源。**
- 客户端选文件时先判 `size > WASM_MAX_BYTES` ⇒ 本地错误项、**不读字节**、不发请求；
- `WASM_MAX_BYTES` 进入 `appcfg-contract.ts`（客户端契约），由
  `appcfg-contract.spec.ts` 与 `server/internal/wasmapp/limits/limits.go` 的
  `WasmMaxBytes`（`32 << 20`，读取时按左移解析）对拍；
- 宿主 `resolveWasmSource` 的 base64 分支补同一条闸门（同一个常量、同一个 `code`），
  避免"同一个超限产物走 HTTP 路径与服务端裁决不一致"。

## 5. 分片 PUT 对确定性 4xx 也重试（P2-8）

原先任何一片非 2xx 都重试最多 3 轮 + 每轮一次额外 GET，最后统一回 `UPLOAD_INCOMPLETE`
+ "带同一个 upload_id 重发"。对服务端的确定性 4xx（`VALIDATION` / 411 / 413）那句建议是
**错的**，而且把服务端的 `code`/`hints` 压没了。

**决策：`isRetryableChunkStatus` 是唯一判据** —— 5xx 与 408/429 可重试；其余 4xx 是终态，
直接原样回服务端信封（不重试、不补 GET、不改写 code）。它独立成导出函数，以便单测钉住
边界（`it('只有可重试的失败才重试')`）与集成用例（假上游对某片回 400 ⇒ 1 次 PUT / 0 次 GET /
返回体是 `VALIDATION`）两处都覆盖。

## 6. `whitelist` 语义文案与 `**` 原样显示（P2-9）

- **服务端 hint**：`appcfg.go` 的 `accessHintValues` 把 `whitelist` 说成"要求登录 + 名单"
  （暗示平台比对），而真实语义是**平台不比对**（R24，`appserver/serve.go`）；客户端的同名
  文案早已是正确口径。改为"要求登录；名单只给应用自己读，平台不比对"，并补
  `TestAccessHintValuesDiscloseWhitelistSemantics`（含"不得再用『名单准入』这种措辞"的反向断言）。
- **客户端字典**：`locales.ts` 的 `whitelistHint` 与 `declarationsHint` 带 `**`，而这些串
  直接进普通文本节点（没有 markdown 渲染），界面上显示成星号。去掉 `**`（不做粗体渲染：
  为一句话引入 markdown 渲染不划算），并加"字典里没有 `**`"的守卫用例。

## 7. 目录解析静默降级成空态 + 该契约无跨端对拍（P2-10）

**问题**：`parseCatalog` 对没有合法 `app_id` 的行直接 `continue`，全部跳过时面板显示
"还没有可用的应用" —— 把契约漂移（`visible`/`login_required` → `access` 那次就是）说成
"你没有应用"。两侧只有各自手写的夹具在守。

**决策两条：**
1. `parseCatalogReport` 统计 `rows` / `skipped` / 原始行样本；面板在
   `rows > 0 && items === 0` 时走**错误态**（`CATALOG_SHAPE_MISMATCH` + 前 400 字节原文进
   details），正常空目录仍然是空态 —— "没有应用"与"解析不出来"必须能区分。
2. `CATALOG_ROW_FIELDS` / `CATALOG_ROW_CONDITIONAL_FIELDS` / `CATALOG_ROW_AUTHOR_FIELDS`
   写进 `appcfg-contract.ts`，`appcfg-contract.spec.ts` 从 `read.go` 的 catalog 函数体里
   抠出键集合做**全集合相等**对拍（`gin.H` 字面量 + `row["…"] =` 赋值），并额外断言
   author 字段不得出现在无条件的字面量里。用例自带"把 `app_id` 改成 `appId` 后必须不等"
   的自证分支 —— 这条闸不会因为抠不出来而假绿。

---

## 未做 / 边界

- **首版发布仍取 `access=login` 缺省**：这不是"静默改写"（首版没有"当前值"），且与服务端
  `appcfg.json` 的 `access_default` 同源并有对拍。若将来要求首版也必须显式选择，判据是
  `initial.currentAccess === undefined` 时同样加确认/必选。
- **部分行解析失败（`skipped > 0 && items > 0`）仍按可用条目渲染**：这种形态只在服务端下发
  混合数据时出现，隐藏可用应用比丢一行更糟；全量跳过才升级为错误态。
- **`appcfg.json` 未改**：`accessHintValues` 只进错误 hints，不是字段表的生成源
  （`appcfgspec.go` 不引用它），因此无需重新生成。
- **`server/docs/03-api-reference.md` 未同步**：它不在本次允许改动的文件清单内
  （该面另有并发改造），catalog 新增字段的文档同步留给合并后的统一整理。

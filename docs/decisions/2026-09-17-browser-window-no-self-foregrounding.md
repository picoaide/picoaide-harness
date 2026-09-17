# 内置浏览器窗口不得自己弹到前台（2026-09-17）

状态：已实施（`packages/host/browser`：焦点闸门 + 去掉冗余原生重排 + 回归测试）

## 问题（用户 2026-09-17 报告）

> 浏览器老是弹出来，我切换到其他窗口，一会儿它又弹出来，相当于它一定要置顶展示那种，
> 导致我没法做其他的事情，最小化会自动弹出。

浏览器是**独立于主窗口的 OS 窗口**，产品决策是「创建即隐藏、只有用户动作才显示」
（2026-09-08），窗口本身没有 `setAlwaysOnTop`，全仓也没有 `moveTop()` 调用。所以症状
不是"置顶"，而是**反复抢焦点**：给一个 WebContents / 子视图抢焦点会激活它的顶层窗口，
Windows 上还会把**最小化**的窗口 `SW_RESTORE` 回来。

## 两条路径（均已在源码级 + 真机级确证）

| # | 路径 | 触发频率 |
|---|---|---|
| 1 | `applyOverlay()` 里蒙版夺键盘（`if (mode === 'mask') overlay.focus?.()`，2026-09-15 审计 P2-7 引入） | 蒙版是**默认状态**（用户没接管时恒为 mask）；`applyOverlay` 被 `busy`（AI 每个操作起止各一次）、`takeover`/`release`、以及**每次 `relayout()`** 触发 |
| 2 | `NativeView.moveToTop()` 用 `removeChildView + addChildView` 实现，`relayout()` 每次对活动标签与蒙版各重排一次 | 切/关标签、窗口 resize、恢复账本、prewarm、**最小化引发的 resize** |

`wc.focus()` 的链路（Electron 43.4.0 源码）：`WebContents::Focus()` →（mac/Linux 显式）
`owner_window()->Focus(true)` → `NativeWindowViews::Focus` → `widget()->Activate()` →
Windows `HWNDMessageHandler::Activate()` = `IsMinimized → ShowWindow(SW_RESTORE)` +
`SetWindowPos(HWND_TOP)` + `SetForegroundWindow`。这解释了"切走一会儿又回来"与
"最小化自动弹回"两种表现。

## 决策

1. **夺焦点只在"用户真的在看这个窗口"时发生**：新增 `windowAttended(win)`（可见 +
   未最小化 + 持有 OS 焦点），蒙版夺键盘与 `capsule` 的 `focusPage()` 都过这道闸。
   P2-7 不退化：`ensureWindow()` 注册 `win.onFocus(...)`，用户把窗口带回前台的那一刻
   补做键盘上锁（真机实测该事件确实触发，且不会自激发成循环）。
2. **`relayout()` 不再重排活动标签视图**：同一时刻只有一个标签 `setVisible(true)`，
   隐藏视图不参与合成、也不改变层序（像素级验证）。原生层序只需两条不变式 ——
   ①新 `attach` 的视图在最上；②蒙版永远在最上（`applyOverlay()` 负责，且已在最上时
   不重复重排）。**任何将来新增的"改变子视图顺序"的入口都必须调用 `applyOverlay()`。**
3. **`actor === 'user'` 不等于"用户此刻在窗口前"**：用户持有控制权时页面自行
   `window.open` 也走 user 路径，此时不再无条件 `show()`（只有窗口不存在或真在前台才显示）。

## 验证

- 真机（Electron 43.4.0 + 真实适配器 + 真实 `BrowserRuntime`）原生调用计数：
  切标签 / 关标签 / resize / 会话重排 **各 2 次 `addChildView` → 0 次**；busy 路径 0 次；
  新开标签仍 2 次（attach 本身 + 蒙版抬回，属固有代价）。
- 焦点对照：窗口在后台/隐藏时蒙版 focus **0 次**且窗口保持 `isFocused=false`；直接调旧的
  `mask.focus()` 则 `false→true`（旧行为确实把窗口抢回前台）；前台时仍 1 次（P2-7 保住）。
- 回归：`packages/host/browser/tests/audit-0917-window-focus.spec.ts`（12 例）。变异验证：
  去前台闸门 5 红、去 z-order 跳过 2 红、去补锁 1 红、去 `focusPage` 闸门 1 红、
  掏空最小化判据 1 红、恢复旧的活动标签重排 1 红。
- 独立 agent 审计（只读、全新上下文，含源码级取证 + 真机探针 + 像素截图 + 变异验证）：
  **未发现新引入的 bug / 未处理拒绝 / 监听器泄漏 / 层序破坏**；报告
  `temp/audit-0917-window-focus/AUDIT.md`。

## 已知边界

- 「Windows 上 `addChildView` 是否也激活顶层窗口」**未在本机复现**：Linux 实测不激活，
  Windows 只有 issue 层面证据（electron#42339，无关闭开关）。判定方法：在 Windows 上跑
  `temp/audit-0917-window-focus/probe6.cjs`，看 `M-ai-open-new-tab` 的 `winFocused` 是否
  翻 true。若成立，残余面只剩"新开标签"，需要另想办法（例如把新视图插到蒙版之下、
  或延后 attach）。
- 「最小化被恢复」只有源码证据（本机 Xvfb 无窗口管理器，最小化是 no-op）。
- 蒙版上锁的键盘语义仍以"窗口在前台"为界：窗口不在前台时按键本来就到不了该窗口。

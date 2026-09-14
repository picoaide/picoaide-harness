# 2026-09-14「我来操作」完全点不动诊断报告（内置浏览器写面证明与蒙版分区）

诊断对象：桌面产品 **PicoAide Harness v2.7.3**（客户渠道客户端，win32，Electron 43.4.0）。
数据源：客户诊断包 `diagnostics-1789381602891-…zip`（含 2 天 dsh 日志）+ 会话内截图 +
**本地打包版真机复现**（`temp/browser-takeover-proof-probe.mjs`，Linux 打包版 + mock gateway 登录 + CDP 读各自 cookie jar）。

## 一句话结论

**不是交互/渲染问题，也不是"点了没反应"：内置浏览器蒙版页（`/browser-overlay`，承载唯一的用户接管入口
「我来操作」胶囊）跑在按用户分的浏览器分区里，而它在开机 prewarm（尚无任何会话）时就被建在
`persist:agent-browser-anonymous`；登录后 `setPartition()` 只改变"新建 tab 用哪个分区"，Electron 的
WebContents 分区创建即固定 ⇒ R7 写面证明要求的 BrowserAuth 票据永远交接不到蒙版所在的 jar ⇒ 蒙版页的
每一次写请求都被 403 拒绝（主机日志记 401），而蒙版模式下它铺满整窗 ⇒ **整轮运行浏览器只剩 AI 能用**。**

已修复（`BrowserRuntime.setPartition` 分区变化时重建蒙版 + `clear-data` 后重跑交接 + 拒绝日志补路由），
真机复现由 403 转 200 验证通过。

## 1. 日志证据

`dsh-2026-09-14.error.log`：进程 17:34:30 启动（run header），**18:23:42 → 18:26:36 共 17 条**：

```
2026-09-14 18:23:42.416 [W] [pico-browser] refused a local write without browser proof (401)
2026-09-14 18:23:43.135 [W] [pico-browser] refused a local write without browser proof (401)
…
2026-09-14 18:26:36.659 [W] [pico-browser] refused a local write without browser proof (401)
```

时间点与用户反复点「我来操作」完全重合；其余日志（`agent/disposed listener`、`session-title-llm`）与本问题无关。
关键判据：**点击送达了主机，是写请求在 `requireWriteProof` 处被拒**——所以既不是按钮被遮挡，也不是蒙版抢了事件。

## 2. 根因链

1. 开机 prewarm（2026-09-08 产品决定：窗口、面板、蒙版开机即建、隐藏）发生在**任何会话存在之前**，
   蒙版视图按当时的 `partition` 创建 = `persist:agent-browser-anonymous`。
2. 登录 / 会话恢复 → `pico/session-changed` → `runtime.setPartition(browserPartitionFor(user))` ——
   注释与实现都只承诺"**新建** tab 视图"使用新分区（`runtime.ts` 原注释：*Swap the partition used by NEW tab views*）。
3. Electron 的 `WebContents` 分区在创建时固定，之后无法改指；窗口在会话切换时只被 `hideWindow()`（不销毁），
   蒙版视图于是**整个进程生命周期**留在旧 jar。
4. `index.ts` 的 cookie 交接（R7-RV-3）把 `dsh-auth-*` 镜像进 `browserPartitionFor(currentUser())` —— 即
   **当前用户分区**，与蒙版所在 jar 不是同一个 ⇒ 蒙版页永远拿不到写面证明 ⇒ 接管/隐藏/书签/下载打开等
   所有 overlay 写按钮全部 403（`proofOfPossession` 记 fence 的 401）。

**触发条件**：会话在浏览器窗口建好之后才到位 —— ① 运行中登录（客户本次即此路径：17:34 起进程，
18:03/18:18 仍在安装技能 = 已登录）；② 重启后持久会话恢复慢于 boot prewarm。两者都是常见路径。

## 3. 真机复现与对照（修复前 → 修复后）

`temp/browser-takeover-proof-probe.mjs`：打包版 + 全新区 `HOME`/`DSH_HOME` + mock gateway 登录，
CDP 分别连 `/browser-shell` 与 `/browser-overlay`，POST `/api/pico/browser/takeover`，并用
`Network.getAllCookies` 读**各自 jar** 对拍。

| 页面 | 修复前 jar | 修复前 POST | 修复后 jar | 修复后 POST |
| --- | --- | --- | --- | --- |
| `/browser-shell`（默认 session） | 有 `dsh-auth-…` | 200 | 有 | 200 |
| 登录后新建 tab（当前用户分区） | 有 `dsh-auth-…` | — | 有 | — |
| `/browser-overlay`（蒙版） | **空** | **403** + 复现出与客户逐字相同的 401 日志行 | 有 `dsh-auth-…` | **200**（`controlled: false → true`） |

## 4. 修复

- `packages/host/browser/src/runtime.ts`
  - 蒙版创建收敛到唯一入口 `mountOverlay(win, origin)`，并记录 `overlayPartition`；
  - `setPartition()` 检测到分区变化且蒙版存在时调用 `remountOverlay()`：销毁旧视图（`detach` + `destroy`）
    并按新分区重新挂载 + 重新加载 overlay 页（页面 GET 会再次触发 cookie 交接）；
  - `dispose()` 清理 `overlayPartition`。
- `packages/host/browser/src/index.ts`
  - `clear-data`（"清除全部数据"会连 cookie 一起清掉）后重新 `startCookieHandoff()`——交接表在首次成功后
    停表，否则票据被清走后按钮全 403；
  - 写面拒绝日志补 `[METHOD pathname]`（只记 pathname，丢 query）：本次排查最费时间的一点就是日志没说清
    是哪个页面被拒（shell 页天然持票，只有 overlay 页会失败）。
- 回归测试 `packages/host/browser/tests/audit-0914-mask-partition.spec.ts`（4 例；反向对照：注释掉
  `setPartition` 里的 `remountOverlay()` 调用后"用户切换重建蒙版"必红）。

门禁：browser 344 测试全绿（含新增 4）、desktop 787 全绿、两个包 typecheck 绿、
根守卫 `check:layout / check:inventories / check:patches / check:patch-resolutions` 绿；真机探针 PASS。

## 5. 影响面与残留

- 已装 **v2.7.3** 的客户机：只要命中上述触发条件，该轮运行的「我来操作」必死；重启客户端只是碰运气
  （取决于恢复会话是否抢在 boot prewarm 之前）。要真正恢复必须换带此修复的客户端。
- 同族已修：`clear-data` 清 cookie 后票据不再补发。
- 同族未修（低优先，非本次现场）：`connectors` / `desktop` / `cron` 三处写面拒绝日志同样只有状态码、没有路由；
  建议后续统一补 `[METHOD pathname]`。
- 设计层面：任何"本地页面 + 写面证明"的组合，都必须保证**该页面的分区 === 交接目标分区**（Electron 分区
  不可改指）——新增此类页面时按这条自检。

# 内置 AI 浏览器审计与修复（2026-09-15）

对象：`packages/host/browser`（含 `src/client/BrowserTrigger.tsx`）、`packages/host/desktop/src/electron-runtime.ts` 的浏览器相关面。

前置事实：客户现场两个 P0（点「我来操作」整轮 401、复制按钮静默失效）已在 #68/#69/#70/#71 修复。
本文件记录的是随后**对整个浏览器包**的审计结论与修复，逐条含「行为变化 / 回归测试 / 反向对照」。

审计方法：4 个只读代理分片（生命周期与闸门 / runtime·window·adapter / tools·eval·snapshot /
pool·store·cdp·shell-pages），发现项先复现再修；每条修复都在**工作区外的冻结副本**里把修复改回旧行为，
证明对应用例会变红（反向对照），再恢复并全绿。

---

## 一、P0

| # | 缺陷 | 行为变化 | 回归测试 |
| --- | --- | --- | --- |
| P0-1 | 用户闸**无上限等待**：用户接管后，模型动作会永久挂起，只能等工具自身超时 | `PoolMutex.run` 新增闸预算（`userGateTimeoutMs`，默认 300s），超时抛 `window-controlled`「等待用户交还浏览器超时（Ns）」 | `tests/pool.spec.ts`（闸预算到点抛错 / 未到点继续等） |
| P0-2 | 标签页预留**重复释放**导致池子超发（实测旧代码只剩 1 个空位时仍放进了第 3、4 个标签页） | 预留改为一次性 token（`TabReservation`），`releaseReservation` 幂等 | `tests/audit-fixes.spec.ts`（重复释放后 `tryReserveTab` 必须拒绝） |

## 二、P1

| # | 缺陷 | 行为变化 | 回归测试 |
| --- | --- | --- | --- |
| P1-1 | 会话切换后 `closeAll(true)` 残留 `controlled=true`，浏览器**永久锁死**在用户手里 | `closeAll` 的 finally 无条件 `setUserControl(false)` | `tests/audit-fixes.spec.ts` |
| P1-2 | materialize 与 epoch 竞态：恢复过程中切换用户，会把新标签页建成旧用户的 | 建/销毁前后各校验 epoch，过期即回滚 | `tests/audit-fixes.spec.ts` |
| P1-3 | 会话切换链**中途失败即中断**（分区没切、store 没切、票据没交接、预热没跑） | `runSessionSwitch()` 固定顺序（分区/store/票据交接 → 关标签 → 清 ops → 预热），单步失败不再吃掉后续步骤 | `tests/plugin-user-scope.spec.ts` |
| P1-4 | 冻结判定与闸门用的**不是同一个谓词**（拿不到 fence 时行为分叉） | 导出 `connectionFenceReady()` 类型谓词，闸门与票据交接共用同一判据 | `tests/plugin-user-scope.spec.ts` |
| P1-5 | 启动预热与实际启动路径错位（恢复型启动下预热过早/空转） | 预热挂 `waitForSessionRestored(15s)` 之后再跑，并放进 `ctx.effect` | `tests/plugin-user-scope.spec.ts` |
| P1-6 | 分区切换后蒙版仍旧 jar（客户 P0 根因之一，已单独合并 #68） | 保留 `remountOverlay()`，本轮补测试 | `tests/audit-fixes.spec.ts` |
| P1-7 | 模型工具 **`browser_release` 能自己把用户闸关掉**（AI 忙时一次调用即可继续点页面） | 从模型工具面移除（32→31 个工具）；`setUserControl` 能力保留给用户按钮；系统提示词同步 | `tests/tools-interaction-verdicts.spec.ts`、`tests/audit-0908.spec.ts` |
| P1-8 | store 读失败（EACCES/EIO/杀软锁）被当成"首次运行"→ 空集合启动，**下一次写入覆盖磁盘上的书签/历史** | 只有 `ENOENT` 算首次运行；其余 errno 进入只读降级（拒绝写 + 告警 + 保持可重试 `load()`） | `tests/store-io-safety.spec.ts`（19 例） |
| P1-9 | 快照 selector 只向上 3 层且**不锚定根**：重复结构页面点错元素，而且照旧报成功 | selector 从文档根锚定且唯一（拼到根 / 停在校验过的唯一 id 祖先）；自身 id 走 `CSS.escape` 并校验唯一 | `tests/snapshot-selector.spec.ts`（17 例）+ 真 Chromium 探针 |
| P1-10 | 跨域子帧凭据读回（`browser_eval(frame:N)`） | 收敛到与主帧同一套掩码口径（文字漏斗统一） | `tests/audit-r7-credential-scope*.spec.ts` 扩展 |
| P1-11 | 散文里的短口令**完全不被擦除**（`your password abc123 is wrong` 原样回给模型） | 新增 `proseKeyBefore()`：散文里紧邻强凭据键名的值同样擦除（词表用强凭据键，避免 `keyboard`/`order code` 误伤） | `tests/audit-fixes.spec.ts`、`tests/sensitive.spec.ts` |
| P1-12 | 超长密钥（>1024）在快照里**先截断后掩码**，泄漏明文片段 | 先掩码后截断（顺序修正） | `tests/snapshot.spec.ts` / `tests/audit-fixes.spec.ts` |

## 三、P2

| 主题 | 行为变化 |
| --- | --- |
| 落盘原子性 | `rewrite` / 账本 / 截断修复一律 `.tmp` + `renameSync`；坏账本改名 `groups.jsonl.corrupt-<ts>` 并告警，不再静默丢弃；JSONL 尾部半行原子修复，中段坏行只读降级并保留可读部分 |
| 脱敏分档 | `url` 字段与 URL/查询串形态文本逐字节不动；标题/摘要的**散文**段只对强凭据键打码（`搜索 “key=value” 的含义` 不再被写坏——写入即不可逆） |
| 下载文件名 | Windows 保留名与尾部点号/空格归一（`NUL`→`_NUL`、`报告.`→`报告`） |
| 窗口/蒙版 | `contentBounds()` 对已销毁窗口判空；蒙版出现时夺键盘焦点（`NativeView.focus?()`）；覆盖层加载失败不再锁死 |
| 页面反馈 | favicon 协议白名单（`http:`/`https:`/`data:image/`，其余不写 `src`）；SSE `sseOk` 单向标志 → `lastSseAt` 超时（静默断流恢复轮询）；活动面板/查看器内容签名不变则不重建（滚动位置保住）；查看器渲染失败可见并可重试 |
| 快照 | 新增 `truncated` / `total` / `note`：命中总数越过上限继续计数，子帧与 shadow root 盲区显式告知模型 |
| 工具语义 | `browser_press` / `browser_scroll` 页内失败不再假成功（`not-found`）；`browser_get_text` 的 `truncated` 用实际生效上限 `min(textLimit, 32KiB)`；`browser_wait_for` 写明实际生效上限 40000ms |
| eval 护栏 | 改为**看接收者**：可证明是字符串的接收者才豁免 `replace`（`String.prototype.replace` 是纯函数），`location.replace` 仍拒绝；常量折叠 `'set'+'Item'`；`Reflect.construct` 一律拒；`Reflect.apply` 目标必须静态可解析且非写 API/写宿主；`Reflect.get` 键动态或折叠出写 API 即拒 |
| 其它 | 点击坐标陈旧、死错误码标注为保留、日志路由缺口（503 分支打印 `[METHOD path]`）、客户端 `BrowserTrigger` 的 `/show` 失败不再静默 |

## 四、写面静默失败（现场 P0 的同族）

overlay / shell 两个页面的**所有**写操作统一走带 `{ok,status}` 的 `request()`，失败就地 toast
（401/403 → 会话凭据未就绪、503 → 服务未就绪、网络错误 → 无法连接，服务端有 `error` 文案则透传）；
调用点一律先看 `ok` 再改本地状态（收藏失败不再点亮星星、删除失败不再假装删掉、菜单失败不关、
`/state` 非 2xx 不再清空标签条）；「我来操作」点击期间 `disabled` + 「正在接管…」防连点；
查看器渲染整体 try/catch 并继续重试；`sseOk` 换 `lastSseAt`。

回归测试：`tests/shell-pages.behavior.spec.ts`（24 例，jsdom 真跑两个页面的内联脚本 +
假 fetch/EventSource，含「每页恰好一个可解析 `<script>`」的守门用例）。

## 五、验证

| 项 | 结果 |
| --- | --- |
| `corepack yarn workspace @picoaide/dsh-browser test` | **465 例 / 29 文件全绿**（本轮起点 349 例） |
| `corepack yarn workspace @picoaide/dsh-browser typecheck` | exit 0 |
| `corepack yarn check`（全仓门禁，14 任务） | 14 通过 / 0 失败 / 0 跳过 |
| 反向对照 | 每条修复都能在工作区外副本里"改回旧行为 → 变红"（9/9、5 组、21 例，见各报告） |
| 真 Chromium（Electron 43.4.0 + 真 CDP + Xvfb） | 快照 selector：旧三层相对路径确实命中**另一个**元素，新路径唯一且命中目标 |
| 真机 E2E（打包版 + 真实服务器 + 真账号 + xdotool 真点击） | 见 PR 描述 |

## 六、残留与未纳入（认账）

1. `browser_fill_credentials` 的站点 origin 绑定只做到**机制层**：需要部署侧在 `index.ts` 给 `resolveCredentials` 挂 `originOf`，并在 connectors 暴露连接器站点 URL（`ConnectorMcp.url` 已是候选）才真正生效；未暴露时维持现状、不误杀。要变成强制闸还需把"未暴露"分支改成拒绝。
2. store 只读降级的恢复入口是下一次 `load()`；本会话若不再调用，该集合本次不落盘（内存 + pending 保留，`degradedCollections()` 可诊断）。降级期间的 rewrite 类操作不重放，恢复后以磁盘为准。
3. `pwd` / `cookie` 只在散文词表里：`?pwd=x` 在 `url` 字段仍不掩码（审计要求 URL 面逐字节不动）；散文里裸写 `code=T14` / `sid=x` 不再打码（审计指定的交换：散文被改坏是确定性损失）。
4. `runtime.scroll` 仍不把页内判定返回给调用方（元素在两次调用之间消失仍会静默成功）——本轮用工具层读回覆盖常见路径。
5. 分区编码里的 `~` 不可逆（与 connectors `encodeSegment` 的跨包一致性约定，属既有残留）。

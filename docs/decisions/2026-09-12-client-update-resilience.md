# 客户端更新链路：有界重试、续传复用与单源状态（2026-09-12）

状态：已实施（`packages/host/desktop`、`packages/host/enterprise`）

## 问题（用户 2026-09-12 反馈）

1. **不健壮**：检查更新或下载安装包只发一次请求，网络抖一下就失败；失败了没有任何提示（后台检查失败完全静默）。
2. **两处显示不同步**：左上角（侧边栏品牌行）与「设置-关于」的更新状态像是两个世界。
3. **下载策略不合理**：先问「要不要下载」再下；下载完的安装包在重启后不被识别，会重新下一遍（几百 MB）。
4. **下载失败要重来**：一次断流丢掉已下载的全部字节。

## 现状取证

| 位置 | 事实 |
|---|---|
| `updates.ts`（协调器） | 一次 `startCheck()` 一次请求；`runBackgroundCheck` 的 `catch {}` 把失败吞掉 |
| `update-checker.ts` | 请求抛错与 5xx 都返回 `{kind:'invalid'}`，与"清单结构不符"同码 → 无法区分可重试与不可重试 |
| `update-download.ts` | 失败即 `unlink(.partial)`，重试从 0 开始；已完成的安装包不被认作"可复用" |
| `updates.ts` + `electron-runtime.ts` | `confirmDownload()` 先弹原生对话框，用户点「Download」才开始；下载完立刻走安装流程 |
| 客户端三个展示面 | `desktop-update.tsx`（header 徽标，30s）、`UpdateIndicator.tsx`（侧边栏，30s）、`UpdateSection.tsx`（关于，5s）各起一个 `setInterval`，各持一份 `useState`；`useUpdateState(pollMs)` 名为共享、实为各自轮询 |

## 框架内的成熟方案（调研结论）

上游 Electron 桌面（`deepseek-harness/apps/desktop`，只读 pin）用 **`electron-updater`**：
- `DesktopUpdateCoordinator` 是一个显式状态机（`checking/idle/available/installing/ready/error`），前台安装会**等待**进行中的后台检查而不是复用其结果。
- 传输层是 `electron-updater` 的 `DownloadedUpdateHelper`：`.partial` + 元数据 sidecar（记录 url/sha512/大小/ETag）、`Range` 续传、`If-Range`、完成后按哈希校验；NSIS/macOS ZIP 带 blockmap 做**差分下载**。
- `builder-util-runtime` 已经以传递依赖存在于本仓（`packages/host/desktop/node_modules/builder-util-runtime`），提供 `retry(task,{retries,interval,backoff,shouldRetry})` 与 `HttpError`。

**不整体改用 `electron-updater`** 的理由：
1. 2026-09-10 定案：更新源 = **用户登录的那台服务端**（`/api/client/v2/updates/manifest` + `/updates/client/<asset>`），而不是静态 generic provider；换源要同时改服务端清单格式（`latest.yml`）与 CI 发布面，并对每个渠道各出一份元数据。
2. macOS 侧 electron-updater 只吃 **ZIP + blockmap** 载荷，而我们对外发布的是**已公证的 DMG**；补 ZIP 载荷等于给三平台各加一条打包/发布路径，还要重新过公证与渠道分发（`docs/planning/2026-09-10-r2-update-server-runbook.md` 的 R2 布局与缓存语义）。
3. 服务端 `/updates/client/*` 走 `http.ServeFile`，**本身自带 Range/断点续传**——续传能力不需要换框架就能拿到；而差分下载（blockmap）对安装在用户机器上的旧包没有稳定基线，收益与事故面不成比例。
4. 本仓与上游是两条独立的发布线：`electron-updater` 会引入第二处需要跟随上游钉版本的运行时依赖。

**采纳它的设计而非它的依赖**：状态机语义、sidecar + Range 续传、失败分类可重试、`retry` 的有界退避（确定性抖动），都由本仓自己的小实现承担。

## 决策

1. **检查与传输各自有界重试**：`Config.checkRetryDelaysMs`（缺省 `[2s,8s,20s]`，共 3 次尝试）与 `Config.transferRetryDelaysMs`（缺省 `[2s,8s,20s,30s,30s]`，共 5 次尝试），`retryJitterRatio`（缺省 0.25）为确定性抖动，避免全部客户端同一毫秒重试。
   - 只重试**瞬时**故障：请求抛错、5xx/408、空体、超长体、哈希不符（=截断）、以及续传时的连接中断。
   - **不重试**：4xx、'release-missing'、'invalid-artifact'、'invalid-options'、用户取消；清单结构/渠道不符同样不重试（重试改变不了结果）。
   - **用户手动点的那次检查不重试**（`startCheck(false)`）：让用户对着"正在检查更新…"等一分半，比直接告诉他"失败了，再点一次"更糟；后台自动检查重试。
   - 退避等待期间把 `retryAttempt/retryMaxAttempts/retryDelayMs` 推给界面，UI 显示"第 n/N 次 / Ns 后重试"，不再静默。
2. **续传**：`downloadDesktopUpdate` 把未完成的字节留在 `<name>.partial` 并写 `<name>.partial.json`（来源 URL、SHA-256、已收字节、ETag/Last-Modified）。重试时带 `Range` + `If-Range`；服务端回 206 且 `Content-Range` 起点与验证器一致才续，否则**关掉这份响应重新整份下载**（CDN 实测会忽略尾段 Range 并回 200 整份）。长度与清单声明一致时不再请求，直接按哈希确认后落地。
3. **下载完成的安装包可复用**：`state.json` 记 `downloadedVersion/downloadedPath`；启动、换源、以及每次"发现可用版本"时先跑 `resolveUpdateInstaller`，按清单 SHA-256 + 平台魔数校验磁盘上的完成件，命中即进入**可安装**状态，不发第二次下载请求（只重新取一次清单确认哈希）。记录指向已装上/更旧的版本时清掉。
4. **后台静默下载 → 下载完才提示**：检查到新版本直接开始传输（`Config.backgroundDownload`，缺省开），全程不弹对话框；下载完成、校验通过后由平台通报一次"已下载可安装"（`announceUpdateReady`，只通报不安装），真正的安装在用户点「安装更新」（设置-关于按钮 / 托盘菜单 / header 徽标）时执行（`installUpdate`）。Windows 启动下载好的 NSIS 并退出、macOS 打开 DMG、Linux 提示替换 AppImage——与既有交付口径一致。
5. **客户端单源状态**：桌面 client 面用 `desktopUpdateService`（`ctx.provide`）提供**窗口级唯一**的快照 store（5 秒单轮询、引用相同时不通知、首个订阅者启动/最后一个订阅者停止）；侧边栏、设置-关于、header 徽标都 `useSyncExternalStore` 读它，动作入口也统一为 `act()`（已下载→POST 安装路由，否则→POST 检查路由）。跨包不 import（client bundle 各自独立），只按服务名 + 契约字段消费，与 `picoSession` 同一套做法。
6. **失败对用户可见**：`lastError` 的每个类别都有明确文案（网络不可达/校验不一致/格式不正确/服务端未配置对外地址/请先登录/缺少安装包）；侧边栏指示器在下载中与可安装时同样显示（橙点/绿点），不再只有"有新版本"才可见。

## 边界（不做）

- 不做差分/块级下载（blockmap）、不引入 `electron-updater`、不改服务端清单格式与 R2 布局。
- 不做"静默重启安装"：安装一律由用户显式触发。
- 不新增更新开关设置项；`backgroundDownload` 是组装期配置（`Config`），与 `enabled/intervalMs` 同级。
- 不改渠道/品牌面：通报与按钮文案走 `productName` 与既有中文文案。

## 验证

- `packages/host/desktop/tests/update-download.spec.ts`：31 例，新增「截断后用 `Range`+`If-Range` 续传并完成」与「已校验的完成件不再传输」，并把"失败即删残留"改为"保留可续传的残留（空响应除外）"。
- `packages/host/desktop/tests/updates.spec.ts`：35 例，覆盖静默下载→完成通报、瞬时失败重试成功、重试预算耗尽后 `lastError` 可见、重启复用已下载安装包（不重下）、Config 缺省重试节奏、手动检查不重试。
- `packages/host/desktop/tests/update-download-integration.spec.ts`：真实 HTTP 服务器（真 socket、真 206/`Content-Range`）—— 第一次写一半就 `socket.destroy()`，断言失败可重试且留下可续传残留；第二次带 `Range` 续传并落到通过哈希与魔数校验的完成件；第三次不再请求安装包。mock 的 `Response` 证明不了这一层。
- `packages/host/desktop/tests/client-desktop-update.spec.ts`：12 例，覆盖单轮询/多订阅、同值不通知、路由 404 时保留快照、动作按状态分派到检查或安装路由、徽标三态与重试文案。
- `packages/host/enterprise/tests/update-status-text.spec.ts`：4 例，钉住"可安装/下载中（含重试）/各类失败"的文案与按钮状态。
- 相关门禁：`corepack yarn workspace dsh-plugin-desktop typecheck|test`、`corepack yarn workspace @picoaide/dsh-enterprise typecheck|test`。

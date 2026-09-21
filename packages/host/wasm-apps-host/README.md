# `@picoaide/dsh-wasm-apps-host`

客户端专属 WASM 应用 origin：把内置浏览器加载的 `picoaide-app://<app_id>/…` 每个请求
转成平台 JSON 信封，带员工令牌 POST 到服务端，再把响应还原成 Chromium `Response`。

契约：`docs/decisions/2026-09-19-wasm-client-internal-origin.md`（冻结）。任务书：
`docs/planning/2026-09-19-wasm-client-only-implementation.md`（C3 格）。

## 它做什么 / 不做什么

```
应用窗口 / 内置浏览器视图（partition: persist:agent-browser-<user>@<server-hash>）
  load picoaide-app://<app_id>/<path>?<query>
        │  Chromium 交给已注册的协议 handler
        ▼
本包 handler（src/handler.ts）
  ① 解析 URL（app_id **只**来自 host 段）      ② 取 ctx.picoSession 的令牌 + serverURL
  ③ 补 Origin: picoaide-app://<app_id>        ④ POST <serverURL>/api/client/v2/apps/wasm/<app_id>/request
  ⑤ {status, headers, body(base64)} → Response（丢 Set-Cookie 与逐跳头）
        ▼
平台（Go）appserver.serveApp —— 准入/静态/执行/计量全在那里
```

**不做**：不判定准入、不读静态、不执行 wasm、不做任何业务规则（`app_id`/版本/配置合法性
全部由服务端裁决）。handler 是本模型的信任边界，因此它 fail-closed：畸形 URL、超限体积、
非信封响应一律给**可读错误页**，绝不"尽力转发"。

## 装配（桌面壳负责）

1. `app.whenReady()` **之前**：`registerAppScheme()`（`@picoaide/dsh-wasm-apps-host/electron-adapter`）
   —— 协议特权注册是启动期 API。权限位与契约 §2 逐字一致：
   `standard / secure / supportFetchAPI / corsEnabled:false / stream / codeCache`。
2. boot 的 prepare 回调里：
   `hostCtx.provide('wasmAppsHostAdapter', createRealElectronAdapter())`
   —— 默认 session + 每个浏览器分区的 `protocol.handle` 与出站 `fetch`（Chromium 栈）。
3. profile 行 `pico-wasm-apps-host`（`cordis.patch.yml`）由 `packages/host/desktop/src/profile.ts`
   注入，config 里带 `deepLinkScheme`（渠道包 `desktop.deep_link_scheme`；官方构建回落
   `DEFAULT_DEEP_LINK_SCHEME`）。

插件主体（`src/index.ts`）**不 import electron**，所以它在纯 Node 下可加载、可单测；只有
`src/electron-adapter.ts` 静态 `import { protocol, session } from 'electron'`（peerDependency）。

## 接口

| 面 | 说明 |
| --- | --- |
| 协议 URL | `picoaide-app://<app_id>/<path>?<query>`；app_id = `^[a-z0-9]+(?:-[a-z0-9]+)*$`（与 `limits.AppIDPattern` 同源） |
| 平台出站 | `POST <serverURL>/api/client/v2/apps/wasm/<app_id>/request`，`Authorization: Bearer <员工令牌>`，`Origin: picoaide-app://<app_id>` |
| 本机路由 | 前缀 `/api/pico/wasm-apps`（handler 内按 pathname 分发）；打开 = `POST /api/pico/wasm-apps/open`，体 `{app_id, path?, window?}` → `{window, app_id, url, opens?, warning?}`；写面**必须过持有性证明**（`connection.requestRejection`，fence 缺席 fail-closed 503） |
| 窗口几何 | `window: {ratio?, width?, height?}`（**形状与目录行的 `window` 逐字相同**，F3/§6）。给了就用它建窗（首次尺寸 + 比例锁）；没给 ⇒ 宿主自己拉一次平台目录 `GET /api/client/v2/apps/wasm/catalog` 兜底（每会话一次，见 `src/window-catalog.ts`）⇒ 详情页显示的比例与真实窗口永远同源 |
| 宿主事件 | `pico/wasm-app-open` `{app_id, url}` —— 客户端面据此在内置浏览器里开标签 |
| 深链 | `<渠道 scheme>://app/<app_id>`（`pico/deep-link` 事件；未知 scheme/host/路径一律丢弃，**不回落**） |

体积上限与服务端 `limits.go` 同源：请求体 1 MiB、信封 `1 MiB*4/3 + 64 KiB`、响应体
权威上限 8 MiB（handler 只做兜底截断）。方法白名单
`GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS`。

错误呈现分两档：**文档导航**（`Accept: text/html`）给可读 HTML（未登录、会话过期、平台
`{error:{code,message,hints}}`、连不上服务端、无法识别的响应）；应用自己的 `fetch()` 拿
JSON 信封（按 code 分流）。未登录**永远**是可读页面，不是空白页。

## 语言

宿主文案按**每次调用**解析：探测到的 `desktopRuntime.locale` → 请求 `Accept-Language`
→ `zh`。权威实现是 `dsh-plugin-desktop/host-locale`；本包 `src/locale.ts` 是它的最小镜像
（本包以 `needs: []` 登记，跨包 import 会绑死构建顺序），两处的优先级与归一化规则必须一致。

## 分区跟随

内置浏览器的分区按用户切换（`persist:agent-browser-<encoded-user>@<server-hash>`，§7.2
冻结：后缀是服务端地址的 sha256 前 32 位 hex —— 同机切服务端时不得跨租户共用持久分区；
未登录的匿名分区**不带**后缀）。本包在装配期注册默认 session + 当前用户分区，并订阅
`pico/session-changed`（订阅 + `isRestored()` 补发，避免"恢复型启动漏掉首个事件"）后补注册
新分区。分区名推导是 `packages/host/browser/src/electron-adapter.ts` 的**镜像**（browser 包
没有导出它），`src/partition.spec.ts` 与 browser 的 `tests/partition.spec.ts` 用同一组例值
钉死 —— **browser 侧必须同批改成同一份公式**（含 `@<server-hash>`），否则登录态下两边的
分区名不同；部署侧若要另一种命名，用 config 的 `partition` 覆盖。

## 应用窗口的 AI（surface）与内容缓存

- **surface 注册**（§16.1 / F7）：建窗即把窗口注册进 browser runtime 的 surface 注册表
  （Cordis 服务 `browserSurface`，`@picoaide/dsh-browser/surface` 的 `BROWSER_SURFACE_SERVICE`），
  载荷是 `{id, appId, appScheme, webContents, scope}`；关窗/登出注销。注册表晚到（profile 里
  browser 行在本插件之后）由 `ctx.inject(['browserSurface'])` + `windows.registerOpenWindows()`
  补齐。`webContents` 是**真实句柄**：browser 侧的 CDP 附着路径要用它才能真正驱动这个窗口
  （见 `src/windows.ts` 的 `AppSurfaceRegistrar`）。
- **内容缓存**（§7.5 / F11）：`handler.ts` 读/写 `WasmAppsCache`，键 =
  `<session-scope> + app_id + version + path`（version 只来自 `X-PicoAide-App-Version`）；
  只有静态子资源可直出，文档导航与 `/api/*` 一律回源；登出清空整根。

## 命令

```bash
corepack yarn workspace @picoaide/dsh-wasm-apps-host check   # build + test
corepack yarn workspace @picoaide/dsh-wasm-apps-host test    # 仅单测
```

## 未闭环（交接给 C4/C5 与真机验证）

- **真机探针**：契约 §6 W2 的判据是"真服务端 + 真 wasm + 真协议页面"。本包单测只覆盖
  handler/装配面；Electron 侧的真机验证（`protocol.handle` 实际加载、分区注册、CSP 放行）
  需要在客户端打包件上跑契约 §6 的探针。
- **客户端面的"打开"**：本机路由与 `pico/wasm-app-open` 事件已就绪，消费方（应用中心
  打开按钮 / 内置浏览器开标签 / 深链跳转）在 C4。
- **Windows / macOS 的协议行为**未实测（契约 §3 只在 Linux 测过，W5 复核）。

> ⚠️ **阅读须知**：本文件里出现的旧机制（**应用子域 / 换票 `/app-ticket` / 基域 / `entry_url` /
> 服务端 `ai.chat` / 匿名面**）一律是**待删除对象或历史推导**，**不是现行处方，不得据此实施**；
> 现行契约以设计总纲为准。

# WASM 应用：客户端专属（自定义协议 `picoaide-app://`）+ 浏览器链路彻底删除

- 决策日期：2026-09-19（初版 loopback 方案已被本版取代）
- 决策人：产品负责人（本会话用户，七项细节逐条拍板）
- 落地分支：`fix/server-p0-audit-2026-09-19`
- 取代：`2026-09-19-wasm-client-only-miniapp.md`（其 §4 第 1 种与"兼容模式"作废；该文件已加勘误行）
- ~~本文件是本次改造的冻结契约。实现与文档冲突时以本文件为准~~ —— **2026-09-19 起本文件已降级为决策推导留痕**（见下行二次修订）：**权威 = 设计总纲 `docs/planning/2026-09-19-wasm-client-only-design.md`**；发现冲突 ⇒ 以总纲为准，停下报告，不要各自解释。
- ⚠️ **2026-09-19 二次修订**：产品负责人两轮共 **41 个细节**拍板后，改造的**完整设计总纲**已落为
  `docs/planning/2026-09-19-wasm-client-only-design.md` —— **该文件是本改造的权威文档**（含功能清单、
  接口契约、窗口模型、渠道 scheme、迁移、验收与决策日志）。本文件中与之冲突的条款（如"固定
  `picoaide-app://` scheme"、"内置浏览器标签承载"、"旧 public 读侧映射 login"、"应用 AI 走服务端
  `ai.chat`"）**以设计总纲为准**；本文件保留为决策推导过程。
  - **本文件中的 `picoaide-app://` 一律应读作 `<渠道 app 源 scheme>://`**（总纲 §10 `desktop.app_origin_scheme`；official/beta 取值才是 `picoaide-app`）。
  - **应用窗口 != 内置浏览器标签**：总纲 §16.1 W-C 已裁决为**独立应用窗口**；本文件 §2 架构图里的「内置浏览器视图」按此读。
  - **服务端 `ai.chat` 已删除**（总纲 §21）：本文件凡把它当平台能力的表述均作废。

## 1. 决定（七项拍板 + 架构）

| # | 决定 |
| --- | --- |
| 1 | 客户端内部 origin 用**自定义协议**：`picoaide-app://<app_id>/`（不用 loopback、不动上游 webServer） |
| 2 | **一律要求登录**：删除匿名面（`access=public` 的匿名语义、匿名入口、匿名限流对应用请求的作用） |
| 3 | **一次性删除**浏览器换票链路（不做过渡版本、不留长期开关） |
| 4 | `app_sessions` / `employee_sessions` **直接 DROP**（新迁移） |
| 5 | 本机代理 + 协议 handler 落**新建独立包**（宿主插件 + desktop 注入 Electron 适配器） |
| 6 | 服务端目录/发布响应**删除 `entry_url` 字段**；可分享形态 = 深链 |
| 7 | **文档先行**：本文件 + 实施任务书先定稿 → 同步基线/作者/部署/发布说明 → 再动代码 |

## 2. 目标架构

```
桌面客户端（Electron 主进程内跑 DSH 宿主，main.ts:329 boot → current = ctx）
  独立应用窗口（**不是内置浏览器标签**，总纲 §16.1 W-C；partition: persist:…）
    加载 picoaide-app://<app_id>/<path>
        │  （Chromium 把该 URL 交给已注册的协议 handler；每个 host 一个 origin）
        ▼
新建包（宿主插件 + desktop 注入的 Electron 协议适配器）
  protocol.registerSchemesAsPrivileged([{ scheme:'picoaide-app', privileges:{
      standard:true, secure:true, supportFetchAPI:true, corsEnabled:false, stream:true, codeCache:true }}])
  session.protocol.handle('picoaide-app', handler)   // 默认 session + 每个应用用的分区
  handler:
    ① 从 URL 取 app_id（host 段）与 path/query
    ② 取员工会话（ctx.picoSession：令牌 + serverURL）；无会话 ⇒ 可读的"请登录"响应
    ③ 补 Origin: picoaide-app://<app_id>（浏览器**不发** Origin，见 §3）
    ④ POST <serverURL>/api/client/v2/apps/wasm/:app_id/request   （BearerAuth）
    ⑤ 把 {status, headers, body} 还原成 Response（丢弃 Set-Cookie 与逐跳头）
        ▼
平台（Go）
  POST /api/client/v2/apps/wasm/:app_id/request  →  appserver.ServeClientRequest
                                                    → serveApp（与旧子域路径共用同一管线）
        ▼
  wasm 实例（wazero）/ 应用 SQLite / assets（全部不变）
  ⚠️ 本图初版在此处还列了 `ai.chat`：该能力**已于 2026-09-19 彻底删除**（总纲 §21）——
  服务端不再具备任何 AI 能力，应用里的 AI 改由**客户端**经保留路径 `POST /__picoaide/ai/chat`
  提供（协议 handler 本地处理、不经服务端）。
```

**为什么这条最省**：`appserver.ServeApp(w,r,appLabel)` 本来就只依赖标准 http 两件套 ⇒ 新出口用**合成请求**复用整条业务管线（准入/资源/静态/执行/计量），不复制任何业务逻辑。旧路径在 W4 波次删除后，`serveApp` 只剩客户端一个调用方。

## 3. 实测约束（W0-C/C2，Electron 43.4.0 + 真实 Chromium；探针 `temp/wasm-local-origin/probe-custom-scheme*.cjs`）

| 判定项 | 结果 |
| --- | --- |
| `protocol.handle` 服务内容 | ✅ `picoaide-app://demo/` 正常加载 |
| origin / 安全上下文 | ✅ `origin = picoaide-app://demo`、`isSecureContext = true` |
| 同源 `fetch` / `XMLHttpRequest` POST | ✅ 可达 handler，方法/体完整 |
| **原生表单 POST** | ✅ 可达 handler（`method=POST`、体完整、无 did-fail-load） |
| 相对路径与子资源（`<img>`） | ✅ 都走 handler |
| 302 重定向 | ✅ 被跟随（`/redirect` → `/after-redirect`） |
| **平台生产 CSP 逐字放行** | ✅ `default-src 'none'; script-src 'self' 'unsafe-inline'; …; form-action 'self'` 下：内联脚本、同源 fetch、fetch POST、原生表单 POST **全部通过，零 CSP 违规**（`'self'` 解析成 `picoaide-app://<app_id>`） |
| 分区（partition）注册 | ✅ `session.fromPartition(…).protocol.handle(…)` 生效，分区内页面照常工作 |
| 跨应用隔离 | ✅ `picoaide-app://demo` → `picoaide-app://other` 的 fetch 被拦（Failed to fetch） |
| 客户端自有 UI 驱动应用 | ✅ 被拦：`http://127.0.0.1:<port>` 页面 fetch 应用 origin 失败 ⇒ 双向隔离 |
| **Cookie** | ❌ **完全不可用**：`document.cookie` 恒为空、`Set-Cookie` 不落盘 ⇒ 应用不得依赖 cookie |
| **`Origin` / `Referer` / `Sec-Fetch-*` 请求头** | ❌ **一个都没有**（fetch 与原生表单 POST 实测均为 null）⇒ 见 §4.3 |
| Windows / macOS 上的同组行为 | ⚠️ 本机只在 Linux 实测；W5 前需各平台复核一次（同一探针） |

## 4. 冻结契约

### 4.1 端点

| 端点 | 认证 | 说明 |
| --- | --- | --- |
| `POST /api/client/v2/apps/wasm/:app_id/request` | `BearerAuth`（**必需**） | 唯一应用请求入口；信封见 4.2 |

**删除**：匿名入口（`…/anon-request`）、`/login`、`/logout`、`/app-ticket`、应用子域路由树。

### 4.2 请求/响应信封

请求（JSON，`DisallowUnknownFields`）：

```json
{"method":"GET","path":"/notes","query":"page=2","host":"picoaide-app://demo",
 "headers":{"origin":"picoaide-app://demo","content-type":"application/json"},
 "body":"<base64，可空>"}
```

响应：`{"status":200,"headers":{"Content-Type":["text/html; charset=utf-8"]},"body":"<base64>","truncated":false}`

不变量：
- `host` 只接受 `picoaide-app://<app_id>`（或裸 `<app_id>`）；app_id 来自路由路径，**绝不从 Host 反解**；其它形态一律 400 VALIDATION。
- 请求体 ≤ `limits.AppRequestBodyMaxBytes`（1 MiB，base64 解码后判）；信封 ≤ `1 MiB*4/3 + 64 KiB`（已入 `largeBodyRoutes`）。
- 响应体权威上限 = `limits.AppResponseBodyMaxBytes`（8 MiB，由 `writeAppResponse` 判定，超限整单失败）；handler 捕获层只做兜底截断（`truncated`）。
- **`Set-Cookie` 整体丢弃**（§3：自定义协议无 cookie 语义）；逐跳头与 `Content-Length` 剔除。
- 方法白名单：GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS。

### 4.3 Origin 判据（本模型最容易做错的一条）

实测：自定义协议下的请求**不带**任何 `Origin`/`Referer`/`Sec-Fetch-*`。因此：

1. **handler 必须补** `Origin: picoaide-app://<app_id>`（它是可信组件，app_id 来自 URL host；不补则平台的非幂等写防护必然全拒）；
2. 服务端的自源判据改为"由 `app_id` 推导的 `picoaide-app://<app_id>`"（`edge.SelfOrigin`/`CheckOrigin` 扩展识别该 scheme 与 `host` 形态），非幂等请求仍要求 `Origin == 自源`；
3. `Referer` 兜底分支在客户端模式下**不可达**（浏览器不发 Referer）⇒ 保持"两者都缺即拒"的判据不变，只是这里由 handler 保证 Origin 存在。

### 4.4 身份与准入

- 身份唯一来源：员工 bearer（`serverauth.BearerAuth`）→ `appserver.clientFrameUser` 投影（username / display_name / 部门 / is_publisher），与旧 Cookie 路径的投影**逐字一致**（对拍用例钉住）。
- **无匿名**：无 bearer ⇒ 401 `AUTH_REQUIRED`；`access=login|whitelist` 且未认证 ⇒ 401（不再是换票 302）。
- `access` 收敛：发布/校验只接受 `login|whitelist`；历史 `public` **读取侧当作 `login`**（不拒绝旧版本应用，但新版本不得再写 `public`）。
- `whitelist` 仍由应用自判（R24 不变，平台不比对名单）。
- 审计与计量不变：每次请求落 `wasm_call_events`（含 user_id）；应用请求不写 `audit_logs`（与现状一致）。

### 4.5 链接与目录

- 服务端目录/发布/上下架响应**不再有 `entry_url`**；webadmin 与客户端应用中心的"入口链接"列/展示同步删除。
- 唯一可分享形态 = 深链 `<channel scheme>://app/<app_id>`（scheme 真源 = `channel.json` 的 `desktop.deep_link_scheme`；未知 app_id 给可读错误，不回落登录页）。可选 `?path=/相对路径`：只接受以 `/` 开头、不含 `..`/`#`/控制字符的相对路径，其余一律丢弃（不拒绝整个链接）。
- 打开路径：客户端"打开"→ 本机路由（新包注册）→ 确保协议 handler 与分区就绪 → **客户端应用窗口加载** `<渠道 app 源 scheme>://<app_id>/`（渠道参数化：总纲 §10；**不是内置浏览器标签**，总纲 §16.1 W-C）。

**本机打开路由（冻结接口；C3 实现、C4 调用，两端不得各写一份路径）**：

| 项 | 值 |
| --- | --- |
| 方法与路径 | `POST /api/pico/wasm-apps/open`（`ctx.webServer.register` 的 prefix 路由 `/api/pico/wasm-apps`，handler 内按 method 分发） |
| 请求体 | `{"app_id":"<app_id>"}`（未知字段一律拒） |
| 前置 | **必须过持有性证明**（`packages/host/desktop/src/write-proof.ts`，与既有 `/api/pico/apps/wasm/*` 同口径） |
| 成功 | `200 {"url":"picoaide-app://<app_id>/"}`（`url` 由本机按 app_id 拼，不接受调用方传入） |
| 失败 | 客户端未登录 ⇒ `401 AUTH_REQUIRED`；app_id 非法 ⇒ `400 VALIDATION`；协议/分区未就绪 ⇒ `503 UNAVAILABLE` + 可读原因（**不得**静默回落到浏览器） |

## 5. 删除清单（W4 集中执行，逐条可 `git grep` 断言零残留）

**服务端**
- `internal/wasmapp/session/**`（非测试 3234 行 + 测试 4859 行）、`internal/wasmapp/edge/**`（738 + 844 行）
- `internal/router`：`/login`、`/logout`、`/app-ticket`、应用子域 HostGate 装配（`cmd/server/wasmapp.go` 的 `newHostGate`/`extraMainHosts`/`HostGate` 字段）
- `wasm.apps_base_domain` 设置项、`PICOAI_APPS_BASE_DOMAIN`、`.env.example` / `docker-compose.yml` / Caddyfile 示例 / `docs/deploy/AI-DEPLOY.md` 的通配证书三项前置
- `internal/wasmapp/anonlimit`（无匿名后无调用方；若确无其它调用方则整包删）
- 新迁移：`DROP TABLE app_sessions, employee_sessions`（及索引）
- `appcfg` 的 `public` 写侧接受面 + `api/appOrigin`/`entry_url` 字段 + 相关测试

**客户端**
- `packages/client/wasm-apps/src/client/open-app.ts` 的"入口 URL + 系统浏览器兜底"路径（改为内部协议 + 本机路由）
- 应用中心/发布成功块的"入口链接"展示与文案（改深链/去字段）
- 内置浏览器 guard 的 scheme 白名单扩展（`packages/host/browser/src/guard.ts:70`）与凭据填充站点判据（自定义协议无 http(s) origin ⇒ 自动填充不适用，需如实降级）

**CI / 门禁**
- 端到端验收脚本（`temp/wasm-e2e-run.sh`：真 TLS 子域 + 换票）整批改写为"真客户端协议 handler + 真 wasm"
- 三条与换票/基域相关的审计回归（nonce 绑定、基域 Cookie 判据、登录 CSRF）随代码一起删

## 6. 波次与判据

| 波次 | 内容 | 判据（必须可复跑） |
| --- | --- | --- |
| **W0** | ✅ 已完成：自定义协议语义、CSP、分区注册、跨应用/跨 UI 隔离、cookie/Origin 缺失 | 探针 3 份（`temp/wasm-local-origin/probe-*` 与 `probe-custom-scheme*`） |
| **W1** | 服务端：`request` 端点 + `ServeClientRequest` + 身份投影 + Origin 自源判据；删除匿名入口；`access` 写侧收敛 | Go 单测：身份可达、无 bearer 401、跨源写 403、`public` 写侧拒绝/读侧兼容、信封全部拒绝分支；`go build ./...` + `make test-server` |
| **W2** | 新包：协议注册/分区注册/信封转发/会话注入/错误呈现；desktop 适配器与装配 | 单测 + 打包后真机：真服务端 + 真 wasm + 真协议页面（真机探针新增） |
| **W3** | 打开路径、深链、目录字段删除、webadmin/客户端 UI 同步 | 应用中心"打开"真的落到 `picoaide-app://<app_id>/`；深链严格校验；两端口径对拍 |
| **W4** | 删除：session/edge/router/设置/anonlimit/迁移 DROP/entry_url/旧测试 | `git grep` 零残留断言 + `yarn check` + `make check` 全绿 |
| **W5** | 文档与发布：基线/作者/app-builder 技能/部署三件套/发布说明；Windows·macOS 复核探针 | 三项部署前置零残留断言；发布说明写明"必须同版本升级"；三平台探针记录 |

## 7. 风险与未决

1. **无 Cookie** ⇒ 依赖 `document.cookie` 的应用会退化（作者文档必须写明；应用状态存应用库）。
2. **无 Origin/Referer** ⇒ 服务端判据依赖 handler 补头（§4.3）；handler 是本模型信任边界，必须 fail-closed。
3. ~~**跨应用顶层导航仍可能**（`<a href="picoaide-app://other/">`）：与旧模型"应用可互相链接"同语义，**接受**~~ —— ⚠️ **已被推翻（2026-09-19，总纲 §23.2 N7 + §22.2 R4）**：闸门**按 app_id 判**，**应用窗口内也不得跨 app 打开**（`window.open`/`browser_navigate` 同路径）；内置浏览器标签**不得**导航到 app scheme。本条原判**已废弃**，现行口径以总纲 §20.2/§22.2/§23.2 为准。
4. `window.open`/外链：应用内跳 http(s) 仍由内置浏览器 guard 决定（现策略允许 http/https，落到内置标签）。
5. Windows/macOS 的自定义协议行为未实测（W5 复核；不一致则回到"协议 + 分区隔离"的替代形态并更新本文件）。
6. 旧客户端在服务端删除换票后彻底无法打开应用 ⇒ 发布说明必须写"同版本升级"，且 CLI/客户端版本校验不得静默降级。

## 8. 文档同步清单（防子代理误判；W0-W5 期间必须与代码同步）

| 文档 | 必须改成 |
| --- | --- |
| 本文件 | ~~唯一契约（已冻结）~~ **已降级为决策推导留痕**；权威 = 设计总纲 |
| `docs/planning/2026-09-19-wasm-client-only-implementation.md` | 子代理任务书（接口/边界/判据） |
| `docs/planning/2026-09-17-wasm-app-platform.md` | 访问模型（R12/R16/R29/§4.7/§4.8/§6.1/§8 全表）就地标注被取代 |
| `docs/wasm-app-authoring.md` + `server/skills/app-builder/**` | "应用地址/浏览器访问/cookie/entry_url" 全部改写为客户端协议语义 |
| `docs/deploy/AI-DEPLOY.md`、`server/.env.example`、`server/docker-compose.yml`、Caddyfile 示例 | 去掉通配域名/通配证书/Caddy 通配站点块三项前置 |
| `docs/releases/*`（模板与当前版本） | 访问模型、升级必读（同版本升级）、已知限制（无 cookie/仅客户端） |

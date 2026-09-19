# WASM 应用平台「客户端专属」改造 · 完整设计文档

- 文档状态：**待多身份审计**（审计轨迹见 §15；未通过审计前不作为施工依据）
- 日期：2026-09-19 ｜ 分支：`fix/server-p0-audit-2026-09-19` ｜ 目标版本：`v2.7.6-beta.5`（一次性，不做降级通道）
- 决策来源：产品负责人两轮逐条拍板（**41 问**，答案全文见 §14 决策日志）
- 权威顺序：**本文档 > 早期契约 `docs/decisions/2026-09-19-wasm-client-internal-origin.md` > 任务书 `docs/planning/2026-09-19-wasm-client-only-implementation.md` > 代码现状**。早期两份保留为推导过程与分工记录，冲突以本文档为准。
- 阅读顺序建议：§1 现状 → §2 目标与不变量 → §3 功能清单 → §5 接口契约 → §7/§8 两端设计 → §9 数据迁移 → §11 安全模型 → §13 验收 → §16 实施波次。

---

## 1. 现状与问题（为什么要改）

**旧模型**：员工用浏览器打开 `https://<app_id>.<应用基域>/`，平台用「一次性换票」把员工身份换成应用子域 Cookie；为此企业必须自备 **通配域名 + 通配证书 + Caddy 通配站点块**（设计基线 R29），平台还必须在公网维护一整套应用 origin。

**四条不能收敛的问题**（均有取证记录）：
1. 浏览器换票链路的攻击面反复加固仍不收敛：登录 CSRF/会话固定（换票链接可转发）、Host 混淆、地址栏粘贴不可区分、兄弟应用同域 Cookie。
2. 部署摩擦高：通配域名与证书是客户落地的硬前置，平台不做证书自动化。
3. SSO（OIDC）组织在浏览器里**无法**登录「登录可见」应用（没有浏览器会话式 OIDC 登录）。
4. `access=public` 的匿名面把应用暴露给公网任意访问者，与"企业内网办公"的产品定位相悖。

**结论**：把应用收进桌面客户端、用**自定义协议**承载应用 origin，整类问题结构性消失（§11）。

---

## 2. 目标形态与不变量

### 2.1 一句话

**应用只在桌面客户端内、每个应用一个独立窗口里以自定义协议打开；身份由客户端注入；浏览器与公网都不再有应用入口。**

### 2.2 六条不变量（任何实现不得违反）

| # | 不变量 | 判据 |
| --- | --- | --- |
| I1 | **公网没有应用 origin**：`<app_id>.<基域>` 不再提供任何应用内容，平台不再需要通配域名/证书/Caddy 通配块 | 仓库零残留（§13 断言）+ 部署文档不再要求 |
| I2 | **身份只能来自员工 bearer**：应用请求由客户端带 `Authorization: Bearer` 发出；没有匿名面、没有应用会话 Cookie、没有换票 | 无 bearer ⇒ 401；`session`/`anonlimit` 包零残留 |
| I3 | **Origin 由客户端合成、服务端逐字校验**：自定义协议下浏览器不发 `Origin`/`Referer`，handler 必须补 `Origin: <app-origin-scheme>://<app_id>`；非幂等请求缺失或不匹配 ⇒ 403。⚠️ **它只拦畸形输入，不构成"客户端专属"的举证** —— 举证责任在 §20 的 `app-proof`（R1-RED-6 订正） | 变异验证：去掉判据 ⇒ 用例必红；无 proof ⇒ 401 |
| I4 | **每个应用一个 origin**：`<渠道 app scheme>://<app_id>` 独立。**读**（fetch/XHR）由 Chromium origin 隔离拦住（实测）；**顶层导航/写**不受 CSP 约束 ⇒ 由**窗口层闸门**（§7.2：只允许同 app origin、外链出窗、浏览器标签不得导航到 app scheme）与 Origin 判据共同拦（R1-RED-1b/8 订正） | 探针：跨应用 fetch 被拦、客户端 UI 驱动应用被拦；用例：跨应用顶层导航被拒、浏览器标签导航/弹窗到 app scheme 被拒 |
| I5 | **应用请求只有一条服务端入口**：`POST /api/client/v2/apps/wasm/:app_id/request`（信封式），业务逻辑复用同一个 `serveApp` 管线，不允许第二份准入/执行实现 | 路由表 + 代码检索断言 |
| I6 | **访问级别只有两值**：写侧只接受 `login`/`whitelist`；`public` 彻底退场（迁移改写存量行）；名单仍由应用自判（R24） | appcfg 写侧拒绝 + 迁移断言 + appseed/示例同步 |

### 2.3 由实测确定的边界（不是选择，是事实）

> **证据强度标注（R1-TST-9 / R2T-8 / R2-SEC-11）**：下表全部"实测"结论**只在 Linux + Electron 43.4.0 上跑过、每条只跑过一次**，探针脚本**尚未入库**（草稿在 `temp/wasm-local-origin/probe-custom-scheme*.cjs`，W6 迁入 `scripts/wasm/probes/` 并产 `PROBE-RESULTS.md`）。**Windows / macOS 未验**；存储类结论**无任何证据**（W0-D 待跑）。**不得**把本表当"三平台通则"引用（§17 认账 1/2）。

| 事实 | 影响 |
| --- | --- |
| 自定义协议下**没有 Cookie**（`document.cookie` 恒空、`Set-Cookie` 不落盘） | 应用状态只能放应用库（`db.*`）；响应侧 `Set-Cookie` 整体丢弃 |
| 自定义协议下**浏览器不发 `Origin`/`Referer`/`Sec-Fetch-\*`** | Origin 由 handler 合成（I3）；头白名单去掉 cookie/referer/sec-fetch |
| 生产 CSP 在自定义协议下**逐字放行**（`'self'` 解析成应用 origin，零违规） | 不改 CSP；`ApplyHostSecurityHeaders` 继续用 |
| 协议 handler **按 session 注册**（默认 + 每个 `persist:` 分区） | 分区变化时必须补注册，否则 `ERR_UNKNOWN_URL_SCHEME` |
| 平台协议 privileges 必须 `standard+secure+supportFetchAPI+corsEnabled:false+stream+codeCache`，且 `registerSchemesAsPrivileged` 必须在 `app.whenReady()` 之前 | 装配时序是硬约束（桌面壳 boot 前调用） |

---

## 3. 支持的功能（用户可见行为清单）

| # | 功能 | 行为 |
| --- | --- | --- |
| F1 | 应用中心 | 列出全部未删除、有生效版本的**且未被冻结**的应用（名称/一句话/负责人/访问级别/上下架状态/是否本人发布）；**冻结应用不进目录**（直接打开/深链命中时给可辨文案「已被管理员停用」= §7.7 的冻结页，不是"应用不存在"）；**不含**任何"入口链接"字段。**可发现性（§19 Q1）**：按名称/一句话/负责人**搜索** + 「**我发布的**」筛选；>20 条**分页或虚拟滚动**。**三种空态各给文案（§19 Q2）**：0 个应用（引导"让 AI 做一个"）/ 全部下架 / 全部冻结（说明原因 + 联系负责人）。**本版不加**分类/标签/置顶（§19 Q14）；**「全部下架」提示由客户端按"非空但全为下架"自行判定**（§19 Q2 裁定），不要求服务端新增信号 |
| F2 | 打开应用 | 点击「打开」→ 客户端**先查会话**：未登录 ⇒ 弹客户端登录（不开窗口）；已登录 ⇒ 打开该应用的**独立窗口**。**打开等待（§19 Q12，冻结）**：**先开窗显示骨架屏** → `open` 校验回来再加载内容；校验失败按闸门强度换错误页（新建）或横幅（聚焦） |
| F3 | 独立窗口 | 每应用**单窗口**；再次打开 ⇒ 聚焦并导航（不新开）；无地址栏，只有标题（应用名）+ 刷新/返回；窗口尺寸**按应用记忆**，**宽高比由作者声明并强制锁定**（大小可调） |
| F4 | 应用内容 | 由服务端 `serveApp` 管线执行 wasm 后返回；客户端协议 handler 原样透传（HTML/JSON/图片/字体…） |
| F5 | 身份 | 客户端注入员工 bearer；应用帧内 `user = {id, username, display_name, dept, is_publisher}`；无匿名 |
| F6 | 分享 | **只有深链**：`<渠道深链 scheme>://app/<app_id>`，可带 `?path=/相对路径` 直达应用内页面；**入口（§19 Q6）**：目录行「复制链接」+ 发布成功块；未拿到渠道 scheme ⇒ **入口不渲染**（fail-closed）；不发任何公网地址 |
| F7 | AI 操作 | AI 可对应用窗口使用现有 `browser_*` 工具面（navigate/snapshot/eval/type…），与内置浏览器同权限；用户可通过控制权胶囊接管/交还 |
| F8 | 会话过期 | 平台 401 ⇒ 应用窗口渲染可读页（"会话已过期"）+ **保留当前路径**，员工在客户端重登后可继续 |
| F9 | 平台不可达 | 客户端本地错误页 + 「重试」按钮（区分网络不可达与平台报错） |
| F10 | 版本切换 | **每次「打开」动作都向服务端校验当前生效版本**（见 F16 与 §5.1b）；已打开窗口**不主动刷新**，下次导航自然生效 |
| F11 | 静态资源缓存 | 客户端按 `app_id + version` 缓存；**每次打开都校验版本，版本变化 ⇒ 立即清掉该应用的客户端缓存**（**绝不动应用数据库**）；下架/冻结/删除时同样清缓存 |
| F12 | 外链与下载 | 应用页内的 http(s) 外链 ⇒ 内置浏览器新标签 + 应用窗口内**提示条**（§19 Q9，说明"已在浏览器窗口打开"）；下载沿用内置浏览器既有策略（原生保存对话框 + 下载审计）+ 应用窗口**最小反馈**「已开始下载，进度见浏览器窗口」 |
| F13 | 浏览器存储 | **实测（2026-09-19 主控最小复现，Linux / Electron 43.4.0 / 默认 session，`origin=picoaide-app://demo-a`、`isSecureContext=true`）**：`localStorage` ✅ 可读写往返；`IndexedDB` ✅ open+upgrade+put+事务完成；**`Cache Storage` ⚠️ 不可用** —— `caches.open()` 成功，但 `cache.put()` 抛 `TypeError: Request scheme 'picoaide-app' is unsupported`（Chromium 只对 http/https 请求 scheme 支持 Cache）。⇒ **允许 `localStorage` 与 `IndexedDB`，禁止依赖 `Cache Storage`**（作者文档与 §19 Q10 对照表必须写明）。**隔离已实测成立**（主控最小复现 `temp/w0d-rootcause/isolation.cjs`，用 `webPreferences.session` 正确绑定分区、以 **session 对象同一性**实证窗口真在目标分区）：**同分区同 origin 重载可读回**（正对照）、**换分区后读不到**、**同分区换 app_id 读不到** ⇒ `localStorage`/`IndexedDB` 均按 origin 与按 `persist:` 分区双重隔离；文档仍**建议**状态放应用库（可迁移、可审计）。**生命周期（§19 Q10）**：作者文档加**对照表**（`db.*` 服务端永不随缓存清理 / 浏览器存储随清缓存与切账号被清）；应用**下架/冻结/删除时同批清浏览器存储**（与 F11 清缓存同一触发） |
| F14 | 管理端 | 应用中心列表/审核/上下架/冻结/归属转移照旧；**删除**访问级别里的 `public` 与"入口链接"展示；历史审计标签保留；**新增打开计数运营视图**（见 F16） |
| F15 | 渠道白标 | 深链 scheme 与 **app origin scheme 均来自渠道包**（`desktop.deep_link_scheme` / `desktop.app_origin_scheme`）；**所有渠道必须显式配置**（含 official/beta；official/beta 取值 = `picoaide-app`，两者**共用同一命名空间**）；取值惯例 = `<深链 scheme>-app`，但**以显式配置为准**（不派生、不回落）；CI 硬校验：必填 + 正则 + 与深链 scheme 不同值 + 跨渠道唯一 |
| F16 | **打开校验与打开计数**（新增，2026-09-19 追加） | 每次打开应用都调一次服务端（§5.1b）：①返回**当前生效版本**并与本地缓存比对，不一致 ⇒ 清该应用客户端缓存后再加载（**不触碰应用数据库**）；②服务端据此**记录一次打开**（**每次打开都 +1**，不做事先去重；去重指标由 UV 承担），供管理端做运营：列表列（今日/7 日 PV+UV）+ 详情页日趋势 + **热门应用 TOP N 看板** + **按部门聚合**；③**对员工可见（§19 Q11）**：应用详情/应用中心展示「**今日已被打开 N 次**」，并在隐私说明里写明"平台记录打开次数用于运营" |

**明确不做**（本版）：浏览器访问入口（含"请用客户端打开"引导页）、匿名访问、应用多开、应用内 Service Worker、应用直连网络（现状即禁止）、降级/兼容通道。

---

## 4. 架构总览

```
┌─ 桌面客户端（Electron 主进程内跑 DSH 宿主）────────────────────────────┐
│  应用中心（client 插件）                                                │
│    「打开」→ 会话闸门 → 本机路由 POST /api/pico/wasm-apps/open          │
│                          │                                             │
│  新包 @picoaide/dsh-wasm-apps-host（宿主插件 + Electron 适配器）        │
│    ├ 窗口管理：单应用单窗口 / 聚焦导航 / 按应用记忆尺寸 / 锁定宽高比      │
│    ├ 协议 handler：<app-scheme>://<app_id>/<path> → 信封 → 平台 API      │
│    └ 深链：<scheme>://app/<app_id>[?path=] → 会话闸门 → 打开/导航窗口    │
│                          │ 复用内置浏览器的 view/分区/CDP 能力           │
│                          ▼                                             │
│  平台 API：POST /api/client/v2/apps/wasm/:app_id/request（Bearer + 信封）│
└────────────────────────────────────────────────────────────────────────┘
                           │
┌─ 服务端（Go）────────────▼─────────────────────────────────────────────┐
│  appserver.serveApp（唯一应用请求管线）                                 │
│   ①应用反查 ②生效版本 ④身份(bearer 注入) ⑤准入(login|whitelist)         │
│   ⑥(匿名限流已删) ⑦跨源写校验(Origin==<app-scheme>://<app_id>)          │
│   ⑧体积 ⑨静态资源 ⑩wasm 执行 → 应用库 / ai.chat / assets                │
│  计量：wasm_call_events（含 user_id）；审计：不写 audit_logs            │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 5. 接口契约（跨端冻结）

### 5.1 服务端：应用请求（唯一入口）

| 项 | 值 |
| --- | --- |
| 方法与路径 | `POST /api/client/v2/apps/wasm/:app_id/request` |
| 认证 | `Authorization: Bearer <员工令牌>`（必需）**＋ `X-Pico-App-Proof`（必需，见 §20）**；审计账号拒绝 |
| 请求体 | `{"method","path","query","host","headers","body"}`，`DisallowUnknownFields`；`body` 为 base64（空体发 `""`，**不省略键**） |
| `host` | 只接受 `<app-scheme>://<app_id>` 或裸 `<app_id>`；app_id 来自**路由路径**，绝不从 host 反解；**scheme/host 归一化（ToLower+TrimSpace）后比较**，端口/路径/凭据等形态不符才 400（"大小写混淆"**不是**拒绝理由 —— R1-SRV-6 订正） |
| `headers` | 白名单：`origin`、`content-type`、`accept`、`accept-language`、`if-none-match`、`if-modified-since`、`user-agent`、`x-requested-with`；条数 ≤24、单值 ≤8 KiB。**客户端必须转发同一份白名单**（现实现是短黑名单 + 无条数/大小闸 ⇒ Chromium 的 `sec-ch-ua*`/`priority` 等头会让整次导航 400；R1-CLI-5 订正：白名单常量单一真源 + 跨包对拍 + 探针枚举真实头集合） |
| 请求体上限 | 解码后 ≤ `limits.AppRequestBodyMaxBytes`（1 MiB）；信封 ≤ `1 MiB×4/3 + 64 KiB`（已入 `largeBodyRoutes`） |
| 响应体 | `{"status","headers","body","truncated"}`；`headers` 为多值 map；`body` base64；权威上限 `AppResponseBodyMaxBytes`（8 MiB，管线判定，超限整单失败）。**版本头（新增，缓存键的唯一来源）**：宿主在成功响应上写 `X-PicoAide-App-Version: <version>`（客户端只剔逐跳头，天然透传）——解决 R1-DAT-12/CLI-3 指出的"缓存键 version 无来源"。**`truncated` 语义（R1-SRV-11/SEC-10 订正）**：兜底截断**不得**当成功——客户端收到 `truncated:true` 一律按 502/`INVALID_PLATFORM_RESPONSE` 处理并渲染错误页；该键**总是出现**（不用 `omitempty`） |
| 响应头处理 | `Set-Cookie` **整条丢弃**、逐跳头与 `Content-Length` 剔除。**缓存命中时也必须重新写入宿主安全头**（CSP/nosniff/XFO/Referrer-Policy —— 否则命中即失去"不能联网"与安全头强制；R1-SEC-4 订正） |
| 失败渲染 | 文档导航（`Accept: text/html`）⇒ 可读 HTML 失败页；应用 fetch（`/api/*` 或 `Accept: application/json`）⇒ JSON 信封 |
| **错误分层·传输层（外层 HTTP）**（R1-SRV-7 订正；同一表内分两层，客户端按"外层优先"分流） | 401 `AUTH_REQUIRED`（缺令牌）/`AUTH_FAILED`（无效/过期/被吊销）、**401 `PROOF_REQUIRED` / `PROOF_EXPIRED` / `PROOF_MISMATCH` / `PROOF_REPLAYED`**（缺 / 过期 / 绑定不符 / **非幂等请求的 jti 重放**，§20/§23.1；第四个码由 L1 实施时提出并经主控裁定保留 —— 重放是"绑定完全正确、只是用过了"，并进 `PROOF_MISMATCH` 会把"客户端在重试同一请求"误诊成"配置/环境不符"）、403（审计账号/权限）、400 `VALIDATION`（信封或 host 形态）、413 `BODY_TOO_LARGE`、429 `RATE_LIMITED`、503（关停中） |
| **错误分层·应用管线（内层信封 `status` + 平台错误信封）** | 200 以外的应用语义都在内层——404 `NOT_FOUND`（应用不存在/未登记/软删/**冻结**；冻结时带 `reason=app_frozen`）、410（已下架，`status=410` 但 **code 复用 `NOT_FOUND`**）、403 `FORBIDDEN`（**跨源写**，与传输层 403 同名不同源）、502/504（运行时 no-response/timeout）、500 `RUNTIME_OUTPUT_OVERRUN` |
| **超时预算序关系（冻结，改任一侧都要保持）** | 客户端出站超时（默认 **30 s**）**>** 服务端 `limits.GuestBudget`（**10 s**）**>** `SQLStatementBudget`（5 s）**>** `AppDBBusyTimeout`（3 s）。理由：任何平台侧超时都必须**先于**客户端超时发生，否则员工只会看到"网络错误"而拿不到带 code/hints 的可读错误（与浏览器工具预算同一条纪律）。 |

### 5.1b 服务端：打开校验与计数（新增，F16）

| 项 | 值 |
| --- | --- |
| 方法与路径 | `POST /api/client/v2/apps/wasm/:app_id/open` |
| 认证 | `Authorization: Bearer <员工令牌>`（必需）**＋ `X-Pico-App-Proof`（必需，见 §20/§23）**；审计账号拒绝。⚠️ **`open` 端点同样要求 proof**（R2S-6 订正：否则被盗 bearer 可刷 open/探版本与标题/刷计数） |
| 请求体 | `{"current_version":"<客户端缓存的版本，可空>"}`（未知字段拒） |
| 成功响应 | `{"version":"1.2.3","release_id":123,"title":"…","changed":true\|false,"opens":{"today":{"pv":N,"uv":M}}}`；`changed=true` ⇔ 服务端版本 ≠ `current_version`（客户端据此清缓存）。**单一权威**：只有 `changed`（`cache` 字段删除 —— R1-CLI-7 订正）。**`opens` 字段（主控 2026-09-19 补齐跨泳道契约空洞，L3-status 提出）**：随本响应回传**当日**计数，供应用页显示「今日已被打开 N 次」（§19 Q11 / F16 ③）——**不额外增加往返**；**计数 best-effort ⇒ 计数失败时 `opens` 缺省（或为 `null`），客户端必须不渲染该行、也不得显示 0**（与"计数失败不影响打开"一致）。**读源（冻结，L1 实施时提出并经主控裁定）**：`opens.today` **读明细表**（`wasm_app_opens`）以保证"**本次调用计数在内**"，**不读日汇总** —— 日汇总由 5 min 定时器刷新，读它会让今天的数字**稳定少 1**；历史窗口与看板（`GET /api/server/admin/wasm-apps/:app_id/opens`）读**日汇总**（明细只保留 90 天）。明细的 90 天保留期保证"今天"的行永远在 |
| **谁调用（冻结，R1-CLI-7）** | **宿主的本机打开路由调用平台 `open`**（客户端半边不持 bearer；面板只调本机路由）；深链打开同样由宿主执行。**登录闸门也在宿主**（客户端半边的"面板层拦截"只是 UX 表现，§16.1/§19 Q4） |
| **闸门强度（冻结）** | **新建窗口=硬闸门**（`open` 失败 ⇒ 本地错误页 + 重试，不用旧缓存）；**聚焦已有窗口=软闸门**（保留内容 + 横幅 + 重试） |
| 失败 | 401 未登录/被吊销（**含 proof 缺失/过期/绑定不符**）；404 应用不存在；**404 `reason=app_frozen` 已冻结**（目录已不列，深链/历史入口给出可辨文案）；410 已下架；503 平台关停中 |
| **调用时机（冻结）** | **每次「打开」动作**（窗口新建或聚焦前）调一次；深链打开同样调用；应用窗口内的后续请求**不再调用**（避免每请求一次往返） |
| 计数（冻结） | 本次调用即记录**一次打开**：**每次调用 +1（PV 式，不去重）**；UV 由"按 user 去重"的聚合查询承担。**计数失败不影响打开**（best-effort：计数异常只记 warn，不阻塞、不改响应） |
| 版本比较（冻结） | 客户端缓存目录名含 version；`changed=true` ⇒ **清掉该应用在当前 `session-scope` 下的全部版本缓存**（不是只清旧版本），然后按新版本重新填充 |
| **明确不动** | 应用数据库（服务端 SQLite，`db.*` 写入的数据）、应用资源抽取目录、平台数据根 —— 清缓存只清客户端内容缓存 |

### 5.1c 服务端：管理端看板两端的响应契约（主控 2026-09-20 补齐文档空洞）

> **为什么补这一节**：§5.1b 只钉了 `open` 的响应，**从未钉过管理端看板的响应键**，于是服务端（L1）与 webadmin（L6）各自钉了自己的字面量（前端把契约写在 `opens-contract.ts` 的注释里、服务端写在 `admin_opens.go` 的 `gin.H{}` 里，两侧都没读到对方）⇒ 真实环境里 **C2 打开概览与 C4 AI 用量出不了数**（A2-L6 第二轮审计 **R2-L6-1/R2-L6-2，P1**；症状是看板「今日 PV/UV」「窗口 UV」与列表「近 N 日」恒显示 `—`）。**本节的键集即权威**：两端逐字一致，并由**跨端对拍用例**守住（读 Go 侧结构体/处理器键 + 前端声明键，集合相等），**禁止再各用各的夹具**（章程 §3「各钉自己的字面量」）。

**A. 打开看板概览 `GET /api/server/admin/wasm-apps/opens/summary?days=&top=`**

```json
{
  "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "days": 7, "top": 10,
  "capped": false, "detail_retention_days": 90,
  "today":  { "day": "YYYY-MM-DD", "pv": 0, "uv": 0 },
  "totals": { "pv": 0, "uv": 0 },
  "trend":  [{ "day": "YYYY-MM-DD", "pv": 0, "uv": 0 }],
  "apps":   [{ "app_id": "…", "title": "…", "today_pv": 0, "today_uv": 0, "window_pv": 0, "window_uv": 0 }],
  "top_apps": [{ "app_id": "…", "title": "…", "pv": 0, "uv": 0 }]
}
```

语义（**冻结，逐条要有判据**）：
- **读源**：`apps[]` / `today` / `totals` 读**明细表** `wasm_app_opens`（与 §5.1b 的 `opens.today` 同源，保证"本次调用计数在内"）；`trend[]` 读**日汇总**（长期保留，明细过期后曲线不断档）。**两个读源并存是有意的，不是 bug**。
- **UV 一律真实去重**：`uv` = `count(DISTINCT user_id)`。**禁止**把日汇总的逐日 `uv` 相加，**禁止**把各应用的 `uv` 相加（同一个人开两个应用会被重复计）⇒ `totals.uv` / `today.uv` 必须是**不带 `GROUP BY app_id` 的一次聚合**。这是 W5 C2 既有禁令的延伸。
- **`capped=true`**：请求窗口长于明细保留期（90 天）时收敛到保留期并**如实回报**，不静默给一个偏小的数。
- **`title`**：来自应用登记表；**查不到就缺省**（前端按缺省渲染），**不得编造**。
- 三个数组与 `today` / `totals` **恒在**（空就空数组/零值）⇒ 前端据此区分"端点不支持"与"确实是 0"。

**B. 应用 AI 用量 `GET /api/server/admin/wasm-apps/:app_id/ai-usage?days=|from=&to=`**

契约以服务端 `WasmAppAIUsage` 为准：`{app_id,from,to,days:[{day,requests,prompt_tokens,completion_tokens,cache_prompt_tokens,cost}],total:{…},attribution_available}`。webadmin **必须**按此形状读取，且**必须消费 `attribution_available`**：`false` ⇒ 渲染"统计尚未上线/无归因"的说明；`true` 且全零 ⇒ 渲染"确实零调用"。**两者在数字上都是 0、含义相反，混淆即违反 §21.4。**

**C. 详情窗口不得静默退化（R2-L6-3）**：`GET …/:app_id/opens` 缺 `from`/`to` 时服务端回落的窗口**必须回显**（`from`/`to`），前端**必须**渲染出来；"全部（长期日汇总）"档必须**显式请求 90 天窗口**，不得让管理员以为看到的是全部历史。

### 5.2 客户端：本机打开路由（冻结）

| 项 | 值 |
| --- | --- |
| 方法与路径 | `POST /api/pico/wasm-apps/open`（prefix 路由，handler 内按 method 分发） |
| 请求体 | `{"app_id":"<app_id>"}`（未知字段拒） |
| 前置 | **持有性证明**（`packages/host/desktop/src/write-proof.ts` 同口径） |
| 成功 | `200 {"window":"opened"\|"focused","url":"<app-scheme>://<app_id>/"}` |
| 失败 | 未登录 ⇒ `401 AUTH_REQUIRED`（**面板层拦截**，客户端弹登录后自动继续）；app_id 非法 ⇒ 400；应用不存在 ⇒ 404；协议/分区未就绪 ⇒ 503（**不得**静默回落浏览器）；已有窗口 ⇒ 返回 `focused` 并导航到目标路径 |
| 事件 | 宿主广播 `pico/wasm-app-open {app_id, url}`（深链路径消费） |

### 5.3 深链

- 形态：`<渠道深链 scheme>://app/<app_id>`，可选 `?path=/相对路径`（只接受 `/` 开头、不含 `..`/`#`/控制字符；非法则丢弃该参数而非拒整条链接）。
- scheme 真源：渠道包 `channel.json` 的 `desktop.deep_link_scheme`（现状）＋**新增** `desktop.app_origin_scheme`（§10）。
- 校验：未知 scheme / host ≠ `app` / 多余段 ⇒ 一律丢弃（不回落官方 scheme）。
- 未登录：主窗口弹登录，**登录成功后自动继续**打开目标窗口与路径。
- 多渠道并存：链接只对所属渠道的 scheme 生效；跨渠道不工作属预期。**载体与文案（§19 Q5，冻结）**：**主窗口一次性 toast**：「这个链接属于另一家企业的客户端，请让对方用你们客户端的『复制链接』重发」（zh/en 两版走 `host-locale`）。
---

## 6. 应用作者契约（`picoaide.app.json` / appcfg）

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `access` | `login` \| `whitelist` | `public` **已作废**（写侧拒绝、存量由迁移改写为 `login`）；`whitelist` 由应用自判（平台只注入身份） |
| `window.ratio`（新增） | `"W:H"` 或浮点（如 `1.7778`） | **强制锁定**的宽高比；客户端窗口 resize 时按比例约束；**合法区间 0.25–4.0**（越界 ⇒ 发布期 `APP_CONFIG_INVALID`） |
| `window.width` / `window.height`（新增） | 像素（可选） | 首次打开的默认尺寸；缺省 1280×720 并按 ratio 校正 |
| `whitelist` | ≤2000 条账号 | 仅 `access=whitelist` 时使用 |
| `purpose` / `data_sensitivity` / `owner` | 照旧 | 审核与合规信息 |

硬限制（不变 + 新增）：不能读文件、不能开线程、不能主动发起网络请求（CSP `connect-src 'self'`）；**不能用 cookie**（状态放应用库 `db.*`）；HTML/JS/资源必须编入 wasm 自定义段；`window.ratio` 非法（0/负/过大/非数字）⇒ 发布期 `APP_CONFIG_INVALID`。
⚠️ **不得对外宣称"不能联网"**（R1-RED-9 / R2S-12 订正）：CSP **不约束顶层导航与弹窗** ⇒ 应用页可用 `location.href='https://…'` 把数据带出去。真实边界 = "**应用不能主动发起 XHR/fetch 型网络请求**"，导航/弹窗由客户端窗口闸门与外链策略兜底（§7.2），作者文档与技能文案必须照此改写。

身份帧：`auth.mode` ∈ `login|whitelist`、`auth.verified` 恒 true、`user` 恒为对象（无匿名）。`is_publisher` 只用于自检与展示，不携带特权。

---

## 7. 客户端设计

### 7.1 新包 `@picoaide/dsh-wasm-apps-host`（已落地为基线）

| 模块 | 职责 | 现状 |
| --- | --- | --- |
| `app-protocol.ts` | 纯原语：URL 解析（app_id 只取 host 段）、信封编解码、头过滤、base64、三档体积闸门、Set-Cookie/逐跳头剔除 | ✅ 落地（本模块单测在包内；**包级用例数见 §16 基线**，不在此按模块标注） |
| `handler.ts` | 五步 handler：合成 Origin → Bearer POST → 还原 Response；401 清会话；错误信封透传；导航 HTML / fetch JSON 分流；出站预算竞速 | ✅ 落地 |
| `session.ts` | `picoSession` 最小接口 + 订阅（含 `isRestored` 补发） | ✅ 落地 |
| `partition.ts` | 浏览器分区名镜像 | ✅ 落地 |
| `deep-link.ts` | `<scheme>://app/<app_id>[?path=]` 严格解析 | ✅ 落地（scheme 注入待接线） |
| `electron-adapter.ts` | 特权 scheme 注册 + 默认/分区 session 注册 + `session.defaultSession.fetch` 出站 | ✅ 落地 |
| `pages.ts` / `locale.ts` | zh/en 可读页；按调用解析 locale（禁模块级冻结） | ✅ 落地 |
| `index.ts` | 插件入口（`inject: ['picoSession','webServer']`）：本机路由、分区跟随、深链监听 | ✅ 落地 |
| **`windows.ts`（待建）** | 窗口管理：单应用单窗口、聚焦导航、尺寸记忆、宽高比锁定、生命周期清理 | ⛔ 本版新增（§7.2） |

### 7.2 窗口管理（本版新增，F3）

- **单应用单窗口**：`app_id → BrowserWindow` 映射；再次打开 ⇒ `focus()` + `loadURL(<app-scheme>://<app_id><path>)`。
- **外观**：无地址栏；标题栏显示应用名（+ 可选"由 <产品名> 打开"）；最小控制：刷新、返回（应用内历史）、关闭。
- **尺寸**：作者声明 `window.ratio` + `width/height`；客户端**强制 ratio**（`setAspectRatio`），大小可调；**按应用记忆**上次尺寸（存 `userData`）；显示器变化时按工作区裁剪。
- **复用内置浏览器能力（含 AI 寻址机制，冻结）**：新窗口内嵌与内置浏览器同款 view（同分区、同 CDP 接通、同权限守卫）。**AI 寻址方式**：应用窗口以 `kind: 'app'` 注册进浏览器插件**同一份标签/目标注册表**（`runtime` 的 tab 表 + CDP 附着），因此 `browser_*` 工具面（navigate/snapshot/eval/type/wait_for…）**零新增工具**即可操作应用窗口；区别只在 UI：应用窗口**不进入**内置浏览器的标签列表与活动面板（用户在浏览器面板里看不到它），浏览器面板的"当前标签"语义也不指向它。工具面按 `app_id` 寻址（`list_tabs` 输出带 `kind` 与 `app_id`），控制权胶囊/接管语义与内置浏览器一致（用户「我来操作」↔「交给 AI」）。
- **窗口标题（防伪装，冻结）**：标题恒为 `<应用名> · <产品名>`（产品名来自渠道配置）；**不采用**应用 HTML `<title>`，避免恶意应用伪装成客户端 UI 或另一个应用。
- **会话/分区切换**：客户端登出、切换账号、切换渠道分区时，**关闭全部应用窗口并清空 `app_id → window` 映射**（与浏览器 `setPartition` 同精神：上一个用户的窗口不得在新用户下复活）。
- **生命周期**：窗口关闭 ⇒ 释放 view 与 CDP 会话；应用下架/冻结/删除 ⇒ 关闭窗口并清缓存（与 F11 同批）。
- **导航约束（冻结，R1-RED-1b/8/9 订正）**：应用窗口必须挂 `will-navigate`/`will-frame-navigate` 闸门 —— **只允许同 app origin**（`<app-scheme>://<同一个 app_id>`）的顶层导航；跨应用导航（`<app-scheme>://<其它 app_id>`）**拒绝并在窗口内提示**；http(s) 外链**一律不在应用窗口导航**（改为内置浏览器新标签 + 应用窗口提示条，见 F12）。理由：CSP 不覆盖顶层导航 ⇒ 不加闸门就存在"换壳钓鱼"与"导航外带数据"（"不能联网"仅为 CSP 语义，不成立的表述已在 §6 订正）。
- **分区与权限守卫（冻结；R1-CLI-2 提出、R2C-2 统一口径）**：应用窗口**复用内置浏览器的按用户分区**（这样 AI 工具面才能经共享 tab 注册表寻址同一批 webContents），但**分区名必须含服务端哈希**（`persist:agent-browser-<user>@<server-hash>`，避免换服务端跨租户串味）；权限守卫的 **request + check 两个 handler** 必须在**分区初始化时**安装（不是"建 tab 时才装"——Electron 缺 check handler 时默认放行 camera/mic/geolocation）；与应用共用分区的代价（浏览器"清除数据"会一并清掉应用页的浏览器存储）已认账（§17），应用持久状态应放应用库。
- **特权注册的取值时序（冻结，R1-CLI-8）**：`registerAppScheme(scheme)` 必须在 `app.whenReady()` **之前**调用，因此 scheme **不得**取自插件 Config（apply 期才可见）——取值来源 = `main.ts` 模块作用域读取的渠道配置（已有 `CHANNEL_PROFILE` 读值），缺省派生 `<deep_link_scheme>-app`；幂等标志按 scheme 记录（不是模块级布尔）。
- **尺寸/比例数值规则（冻结，R1-CLI-11）**：`setAspectRatio(ratio, extraSize)` 的 `extraSize` = 自绘 chrome 的额外高度；**程序化 resize（含恢复记忆尺寸）不受 ratio 约束 ⇒ 恢复路径必须自己按 ratio 校正**；比例极端时以"**先夹到可用区间（0.25–4.0）→ 再按工作区裁剪**"为准；最小尺寸 = `max(320×240, 按 ratio 反算的最小值)`；尺寸/位置记忆文件 = `<userData>/wasm-apps-windows.json`（原子写、按 `app_id` 键、随账号切换清空）。
- **旧账本迁移（冻结，R1-CLI-14）**：内置浏览器的旧标签账本里可能存在 `picoaide-app://…` 条目（基线把应用开在浏览器标签里）⇒ 启动恢复时**丢弃**这些条目并记 warn（避免 W2 后出现浏览器窗口里的孤儿应用标签）。
- **AI 控制权的默认态（冻结，产品第四轮）**：应用窗口**默认由人操作**（胶囊显示「交给 AI」），点击后交给 AI（蒙版 + 胶囊变「我来操作」）；同一个按钮双向，与既有三面可见口径一致（`browser_list_tabs` 的 `kind:'app'` 行 + 侧边栏提示同步）。
- **一次性引导（冻结，产品第四轮）**：首次打开应用中心显示一次性引导卡（应用是什么 / 怎么让 AI 做一个 / 怎么分享），关闭后不再出现（记在 `<userData>`）。

### 7.3 协议注册与分区

- `registerAppScheme(scheme)` 在 `app.whenReady()` **之前**调用（scheme 由渠道注入，§10）。
- `protocol.handle` 注册在**默认 session + 每个应用用到的 `persist:` 分区**；分区切换（`setPartition` 语义）时补注册；缺注册 ⇒ `ERR_UNKNOWN_URL_SCHEME`。

### 7.4 请求转发（信封）

见 §5.1/§5.2；补充：出站超时（默认 30 s，可配）+ 预算竞速防止迟到响应悬挂；`401` ⇒ 清会话 + 会话过期页；平台错误信封原样透传（导航渲染为 HTML 页并展示 `code/message/hints`）。

### 7.5 缓存（F11/F16）

- 键：`app_id + version`；值：响应字节 + 头（ETag/Content-Type/Cache-Control 白名单）。
- **304 的范围（R1-DAT-11/SEC-4/CLI-3 订正，冻结）**：本地缓存命中**只允许宿主直出静态子资源**；**文档导航与 `/api/*` 一律回源**（否则本地缓存成为绕过准入/下架/吊销的第二入口）。服务端 `no-store` 的响应**一律不缓存**；缓存命中后重新叠加宿主安全头。
- **版本来源（冻结）**：`X-PicoAide-App-Version` 响应头（§5.1）；缓存键 = `<session-scope> + app_id + version + path`。客户端不得自行推断版本。
- **每次打开都要校验版本（防缓存，冻结）**：打开动作先调 §5.1b 的 `open` 端点；`changed=true` ⇒ **清该应用在当前 `session-scope` 下的全部版本缓存**再加载；**新建窗口=硬闸门**（失败 ⇒ 本地错误页，不回退旧缓存）；**聚焦已开窗口=软闸门**（保留当前内容 + 顶部横幅提示"无法确认最新版本"+ 重试，**不得**把正常运行的应用打成错误页 —— R1-CLI-7 订正）。
- **安全头的 CSP 不得写死 app scheme（主控 2026-09-20 裁定）**：宿主在缓存命中/回源时叠加的 CSP 用 **`connect-src 'self'`** —— 在应用 origin（`<渠道 scheme>://<app_id>`）下 `'self'` 天然解析为该应用自己的 origin（即协议 handler），既实现"应用不能主动发起 XHR/fetch 型网络请求"（§6），又**不含任何渠道字面量**。任何把 `picoaide-app:` 之类官方 scheme 写进 CSP/安全头的写法都是渠道化缺陷（UX-2/CHN-3 同类）。
- **服务端×账号双作用域（R1-SEC-3 订正）**：`session-scope` = `<serverURL 哈希> + <用户名哈希>`（不只用户名）；跨服务端/跨账号都不得命中彼此的缓存。
- **绝不动应用数据库**：清缓存只删客户端内容缓存目录；服务端 `db.*` 数据、资源抽取目录、平台数据根一律不动（判据见 §13.3）。
- **用户作用域（安全不变量）**：缓存路径必须含**当前员工会话作用域**（`userData/wasm-apps-cache/<session-scope>/<app_id>/<version>/`，`session-scope` = 服务端地址 + 用户名的哈希），并在登出/切换账号/切换渠道时清空——否则同一台机器上换账号登录会读到上一个人的应用页面（数据泄漏）。
- **仅静态子资源**：命中且 `If-None-Match` 一致 ⇒ 宿主直出 304 语义；**文档导航与 `/api/*` 不因 `If-None-Match` 短路，一律回源**（R2C-3 订正：否则本地缓存重开"绕过准入的第二入口"）。应用下架/冻结/删除 ⇒ 清目录。
- 与 Chromium 自身 HTTP 缓存的取舍：**以客户端缓存为唯一权威**（应用协议页面的分区 HTTP 缓存不参与决策），避免两套缓存给出不同内容。
- 落盘位置：`<userData>/wasm-apps-cache/…`，目录权限 0700，容量上限（默认 256 MiB，LRU）。

### 7.6 会话闸门（F2/F6/F8）

- **面板层拦截**：应用中心「打开」先查 `ctx.picoSession.isLoggedIn()`；未登录 ⇒ 弹客户端登录（不开窗口），登录成功后自动继续。
- **深链路径**：同样先过闸门；未登录 ⇒ 主窗口弹登录 + 记住待打开目标（`app_id` + `path`），登录成功后打开。
- **待打开目标队列（冻结）**：深链可在客户端启动早期、甚至在宿主装配完成之前到达 ⇒ 维护一个有界队列（≤8 条，TTL 5 min，按 `app_id + path` 去重）；宿主就绪后按 FIFO 消费；登录闸门未通过时保留队首并在登录成功后自动继续；过期项直接丢弃并记一条 warn（不弹错误）。
- **运行中 401**（令牌过期/吊销）⇒ 应用窗口渲染"会话已过期"+「重新登录」；**保留当前路径**，登录后回到该路径继续。

### 7.7 错误呈现（F9）

本地页（zh/en，按 `desktopRuntime.locale` + `Accept-Language`）：未登录 / 会话过期 / **已被管理员停用（冻结；`reason=app_frozen`，不得与"应用不存在"共用文案）** / 应用不存在 / 应用已下架 / 协议未就绪 / **平台不可达（带「重试」）**；网络错误与平台错误文案区分。

**冻结/下架/删除的三档呈现（冻结，产品第四轮 Q2/Q3）**：①**目录**：**冻结不列**（冻结不进目录，§19 Q3）；**已下架仍列**并带「已下架」标记 —— 与 F1 的"上下架状态"列、§19 Q2② 的"全部下架"提示三者一致；**删除**的既不在目录也无法打开（§19 Q3/§7.7②）。⚠️ **主控 2026-09-20 订正**：本行原写"冻结与已下架**都不列**"，与 F1/§19 Q2 自相矛盾（那是我上一轮把冻结规则错误地扩到了下架），**以本行为准**；②**直接打开**（深链/历史）：冻结 ⇒ 「已被管理员停用」+ 联系负责人；下架 ⇒ 「已下架」；删除 ⇒ 「应用不存在」；③**内层 404 必须带 `reason`**（`app_frozen` / 其它），客户端据此选文案 —— 三档**不得**塌缩成同一句话。

### 7.8 渠道参数注入（§10）

desktop 组装期把 `deepLinkScheme` 与 `appOriginScheme` 注入新包（profile 行 config）；**不得**在包里写死 `picoaide`/`picoaide-app`。

---

## 8. 服务端设计

### 8.1 唯一管线 `appserver.serveApp`（步骤与客户端模式差异）

| 步 | 动作 | 客户端模式差异 |
| --- | --- | --- |
| ① | 应用反查（`GetWasmAppByHost` → registry 规则） | 同（appID 来自路由参数，已过 registry） |
| ② | 生效版本（最新 approved 元数据，冷编译按需取字节） | 同 |
| ③ | 换票兑换 | **删除**（客户端模式跳过；旧路径随 W4 一起删） |
| ④ | 身份 | **注入**：由 handler 的 bearer 解析 + 投影（与旧 Cookie 路径字段逐字一致） |
| ⑤ | 准入 | `RequiresLogin` 恒 true（access 只两值）；未认证 ⇒ 401（不再换票 302） |
| ⑥ | 匿名限流 | **删除**（无匿名请求） |
| ⑦ | 跨源写校验 | `Origin == <app-scheme>://<app_id>`（非幂等；复用 `edge.IsOriginShaped` + 逐字比对） |
| ⑧ | 体积 | 同（1 MiB / MaxBytesReader） |
| ⑨ | 静态资源 | 同（抽取资源直出 + ETag 304） |
| ⑩ | wasm 执行 | 同（实例池 / 应用库 / 能力面 / 计量） |

**保留**：`assets`、`static`、`runtime`、`queue`、`appdb`、`diag`、`events`、内存档位与四笔账、发布/审核/冻结/导出（与访问模型正交）。⚠️ **`aichat` 不在保留清单内**（R2C-4 订正）：服务端 `ai.chat` 由 §21 决定**彻底删除**，AI 改由客户端 AI loop 提供。
**`edge` 包**：保留 HTTP 面原语（安全头/剥离应用头/体积/方法/Origin 形态与规范化/404 页/诊断字段），删除主机名门控（HostGate/MatchHost/IsProbePath/CheckOrigin/SelfOrigin-host 推导）。

### 8.2 身份投影与会话键（R1-SRV-5/SRV-10 订正）

- **投影对拍**：`clientFrameUser` 与旧 `session.resolveAppSession` 的投影逐字段一致（`username`/`display_name`/部门/`is_publisher`），并明确归一化口径：`display_name` **做 TrimSpace**（新实现如此，需把旧实现对齐或在对拍里显式声明差异）；部门取**主部门**（**唯一定义**：`groups` 树中按**组名排序后的第一个组**；无组 ⇒ 空串 —— 与 §8.9 的 `dept_id` 同一定义，R2C-17 订正）。
- **账号可用性**：旧路径有 `checkUsable()`（role/status）闸门，客户端路径由 `serverauth.BearerAuth` 承担 ⇒ **对拍必须覆盖"禁用/删除用户的 bearer ⇒ 401"**，不允许因投影失败而降级放行。
- **会话键（新增，必须落点）**：客户端模式没有应用会话行 ⇒ `sessionKey` 不能为空（空键会让 `aichat` 的"在手令牌"从按（用户,会话）降级为同用户共用一把，且 `RevokeSession` 失去唯一调用方）。冻结：**会话键 = bearer 的 SHA-256（前 16 字节 hex）**，并由 `serverauth` 在**登出/改密/禁用**时回调 `aichat.RevokeSession(key)`；若本期不做回调，则必须在 §17 认账"AI 在手令牌最长存活 `limits.AITokenTTL`（45 min），不再有会话级即时吊销"。
- **登出语义**：bearer 被吊销 ⇒ 应用请求 401（`BearerAuth` 承担，需用例）。

### 8.3 自身源（模式感知）与 **scheme 参数化的唯一落点**（R1-SRV-1/SRV-9 订正）

**scheme 的唯一来源**：渠道包 `desktop.app_origin_scheme`。服务端**不得**用包级常量：

| 项 | 冻结做法 |
| --- | --- |
| 服务端注入 | `setupWasmPlatform` 启动期调用 `channel.AppOriginScheme()`，存入 `Server.appScheme`；**唯一** origin 构造点从包级函数 `PicoaideAppOrigin(appID)` 改为**方法** `(*Server).AppOrigin(appID)`，`api` 层的 host 校验必须经它（否则 api 与管线各持一个 scheme） |
| fail-loud 边界 | **只在"配置存在但字段缺失/非法"时**拒绝启动（与既有 `channel.Load()` 的"目录缺失 ⇒ 中性 fallback"约定不冲突）。**official/beta 不豁免字段**（两者都必须显式写 `picoaide-app`）；仅豁免**跨渠道唯一性**（公共渠道共用 `picoaide-app` 命名空间）（R2I-13 订正） |
| 形状 | 正则与两端既有实现**逐字一致**：`^[a-z][a-z0-9+.-]{1,31}$`（不是无上界版本）；由 CI 三条负例覆盖（缺字段 / 与 `deep_link_scheme` 同值 / 非法格式） |
| 不得一起改 | `abi.ABIVersion = "picoaide-app/1"` 是**独立契约**（帧协议版本），与 origin scheme 无关 |
| 合成请求 | `URL.Scheme = <app-scheme>`、`Host = <app_id>`；`selfOrigin(r)` 客户端模式返回 `<app-scheme>://<app_id>`（**W4 删除旧路径后这是唯一分支** —— W4 前旧路径仍走 `edge.SelfOrigin(r)`，但**W4 必须同批删掉该引用**，不得留下任何对 `SelfOrigin` 的残留调用，R2C-16）；`respond.go`/`static.go`/`WriteAppNotFound` **全部**走它（`edge` 内任何写安全头的函数都必须**接受调用方传入的 selfOrigin**，包内不得自行推导 —— 见 §8.4）。CSP 目前忽略 selfOrigin 参数，但不得依赖这一点 |
| 大小写 | scheme/host **归一化后比较**（`ToLower` + `TrimSpace`）；只有形态或取值不符才 400。**不**把"大小写混淆"当作拒绝理由（R1-SRV-6 订正，与实现一致） |

### 8.4 删除清单（W4 波次；R1-SRV-4/SRV-8/DAT-1 订正：**逐调用点，不是包级**）

**边界铁律**：`edge` 内任何写安全头的函数（`ApplyHostSecurityHeaders`、`WriteAppNotFound`）都必须**接受调用方传入的 selfOrigin**；`SelfOrigin`/`CheckOrigin`/`HostGate`/`MatchHost`/`IsProbePath`/`ServeHTTP` 与 `hostgate_test.go`/`subdomain_test.go` 同批删除。⚠️ `WriteAppNotFound` **现在调用 `SelfOrigin`** ⇒ 必须与 `SelfOrigin` 的删除**同一条改动**，否则编不过（签名改为 `WriteAppNotFound(w, r, appLabel, selfOrigin)`）。

| 删除面 | 具体落点（逐条） |
| --- | --- |
| 整包 | `internal/wasmapp/session/**`、`internal/wasmapp/anonlimit/**` |
| 整包（AI，§21.3 同批） | `internal/wasmapp/aichat/**`（686 + 910 行）、`abi.MethodAIChat` 与 `imports_gen.go` 白名单、`hostcap.callAIChat`、`capapi.AI` 接口与实现、`limits` 的 `AIChat*`/`AITokenTTL`/`AITokenRenewBefore` 及 spec 行、事务内禁用条目、相关测试与技能示例；导入期改判 `IMPORT_NOT_ALLOWED` + 迁移指引（**不静默**） |
| `appserver` | `Options.Sessions`/`Limiter`/`BaseDomain` 字段与 `New()` 的必填校验及 limiter 构造；`legacyAnonymous` 与 ③④⑤⑥⑦ 的 `!id.client` 分支；`writeRedirectPage`/`ticketURL`/`cleanRequestURI`/`secureRequest`/`mainOriginNow`/`trustedProxiesFromEnv`（引用 `anonlimit.EnvTrustedProxies`，删包后编不过）/`clientip.go`；`options.go` 的 `var _ edge.AppHandler` 断言与 `Server.ServeApp` |
| `router` | `WasmSession` 依赖字段、`/login` `/logout` `/app-ticket`（:121-126）、`/domain` |
| `cmd/server` | `EnvAppsBaseDomain`、`wasmapp_domain*.go`、HostGate 装配与 `extraMainHosts`、`main.go` 的相关注入 |
| `api` | `AdminBaseDomain*`、`SettingAppsBaseDomain`、`appOrigin`、`entry_url`（含 `release.go` 的无条件下发）、`ApplyBaseDomain`/`BaseDomain*` 注入面 |
| `limits` | `TicketTTL`/`AppSessionTTL`/`SessionMax*` **＋ 匿名四项 `Anon*`** + `limitsspec.go` 表行 ⇒ 重生成 5 个产物（见 §9） |
| **`legacyAnonymous` 的两段时序（SRV-2 订正）** | **W1 = 清理语义**：客户端模式下一律要求身份（`RequiresLogin` 恒 true），`legacyAnonymous` 分支**不得**再放行匿名请求（I2 由此成立）；**W4 = 随旧路径删除**：`appserver` 的 `legacyAnonymous` 字段与 ③④⑤⑥⑦ 的 `!id.client` 分支整段删除。两段**不得**颠倒，也不得只做其中一段 |
| **服务端 HTML 失败页的语言归属** | 现 `respond.go` 用 `session.PreferredLocale`/`session.RedirectPage`；删 `session` 后**必须**改为 `dsh-plugin-desktop/host-locale` 同款解析（服务端自带 zh/en 词典），客户端自渲染页走 §7.7 —— 不得留下硬编码 `zh-CN` |

### 8.9 打开计数（运营能力，F16）

**目的**：管理员据此做运营（哪些应用真正被用、谁在用、趋势如何），而不是靠"发布数量"猜。

**落点**：`open` 端点（§5.1b）在**同一事务/同一次请求**里完成"取当前版本 + 记一次打开"。

**存储（已定稿，2026-09-19 第三轮 Q1–Q9）**：

| 项 | 定稿 |
| --- | --- |
| 明细表 | `wasm_app_opens(id, app_id, user_id, dept_id, opened_at, client_version)`；索引 `(app_id, opened_at)`、`(user_id, opened_at)`、`(dept_id, opened_at)` |
| 保留 | **明细 90 天**（超期清理），**日汇总长期保留**（趋势不丢） |
| 汇总表 | `wasm_app_opens_daily(app_id, day, dept_id, pv, uv)`（`uv` = 当日去重人数）；主键 `(app_id, day, dept_id)` |
| 计数口径 | **每次打开 +1（PV 式，不去重）**；UV = 当日按 `user_id` 去重 |
| `dept_id` | 打开时用户的**主部门**＝`groups` 树中按**组名排序后的第一个组**（与 §8.2 身份投影的部门**同一定义**，R2C-17 订正；无组记 NULL）；聚合按部门树向上汇总 |
| 匿名 | 不存在（一律登录）⇒ 每条计数都有 `user_id` |
| 管理端出口 | ①列表：每应用今日/近 7 日 PV+UV（读汇总表）②详情：按日趋势（PV/UV 折线）③看板：热门应用 **TOP N**（默认 10）+ 趋势 ④`GET /api/server/admin/wasm-apps/:app_id/opens?from=&to=&granularity=day\|dept`（capability:read） |
| 隐私/合规 | 明细含 `user_id`/部门/时间 ⇒ 仅 capability:read 可见，导出（本期不做 CSV）与保留期写进部署文档合规说明 |
| 失败语义 | 计数失败**不影响打开**（best-effort，只记 warn） |

---

## 9. 数据与迁移

| 迁移 | 内容 | 说明 |
| --- | --- | --- |
| `0073_drop_wasm_sessions` | **停机窗口内**执行：`SET LOCAL lock_timeout='5s';` → `DROP TABLE IF EXISTS app_sessions;` → `DROP TABLE IF EXISTS employee_sessions;`（**不加 CASCADE**；顺序不可颠倒，FK 在 `0070:68`；索引随表消失） | ⚠️ DROP 取 ACCESS EXCLUSIVE，旧实例在跑会挂死部署 ⇒ **先停旧实例**。同批必须删的非 session 包调用点见 §8.4 表（含 `options.go:54`、`serve.go:141-169/347-366`、`cmd/server/wasmapp.go:359`、`main.go:576`、`router.go:76-80/121-126`） |
| `0074_wasm_access_public_to_login` | **按 0071 同款 jsonb 往返改写**（R1-DAT-2/3/4 订正）：限定 `kind='wasm_app'`、`config_json IS JSON OBJECT`、`jsonb_exists(config_json,'access')`、`config_json->>'access'='public'` ⇒ `jsonb_set(...,'{access}','"login"')`；**不得出现半角 `?`**（`rewritePlaceholders` 会改写，用 `jsonb_exists`/`->>`）；结尾 `DO` 段 fail-loud 自检；幂等口径=第二次命中 0 行且字节不变。**磁盘资产改写 = 选项 A（已拍板）**：抄 `appseed.go` 的 temp+fsync+rename 一次性改写 `<data_root>/apps/<app_id>/assets/<release>/picoaide.app.json` | ⚠️ 三条事实订正：①字面 `REPLACE('"access":"public"')` **漏掉 jsonb 形态**（`{"access": "public", …}` 带空格）；②**运行期权威在磁盘资产**，但**读侧已把 public 映射为 login**，因此改写磁盘的**真实意义 = 应用自读配置（`assets.read`）时不再看到 `public`、口径彻底退场**（否则应用可能自行实现"匿名可用"行为）；③必须与 `legacyAnonymous` 的清理同批（W4） |
| 迁移回归测试（必须） | 新增 `migration_0074_test.go`（照 `migration_0071_test.go` 模式）：①紧凑形态改写 ②jsonb 形态改写 ③已含 `login` 行逐字节不变 ④`kind != 'wasm_app'` 行不得被改 ⑤坏 JSON 行跳过且不 panic | 仓库惯例：每条数据迁移都有 `migration_00NN_test.go` |
| 生成物与技能登记（必须，一次跑完） | `go generate ./internal/wasmapp/limits` 重生成 **5 个产物**：`limits/limits.json`、`limits/limits.md`、`appcfg/appcfg.json`、`skills/app-builder/references/limits.md`、`references/app-config.md`；**同时**改 `appcfgspec.go` 的取值来源为 `AccessWritableValues`，并同步 `TestAccessContractMatchesABIAndDesign` 与旧基线 §4.2 行；`SKILL.md` version 提版 + `skillseed/skill_version_test.go:48 seededSkillDigests` 登记新摘要 | 漏任一项：`limits_gen_test.go`/`appcfgspec_gen_test.go` 逐字节门禁红、`TestBuiltinSkillVersionTracksContent` 红 |
| 演示应用存量 | 清单真源 `server/demoapps/demos.json` + `appdemo/**`：**保留 app_id 只改 `access=login`**（改标题去掉"匿名可达"），`appseed` 对已存在行跳过且 heal 不覆盖标题 ⇒ 需一次性改写 DB 行 + 磁盘资产 + 标题 | 只删清单会让 DB 行/磁盘 public 永久残留 |
| `0075_wasm_app_opens` | 新建 `wasm_app_opens`（明细，90 天保留）+ `wasm_app_opens_daily`（日汇总，长期；主键 `(app_id, day, dept_id)`），列集与口径见 §8.9（已定稿） | 与 §5.1b/§8.9 配套；清理作业随迁移落地 |
| `0076_usage_app_dimension` | `usage` 系列表增加**应用维度**（§21.4）：`app_id` 列（默认空）+ 索引 `(app_id, created_at)`；**`usage` 是分区表 ⇒ 必须按 0063 的同款做法递归加列/索引**（`ALTER TABLE ... ADD COLUMN` 对分区父表递归生效，索引需逐分区或建在父表上并确认子分区继承） | ⚠️ W1 与 0075 同批；非应用调用 `app_id` 为空 ⇒ 既有口径不受影响；**只在该请求确属客户端会话链路时才记录 `X-Pico-App-Id`**（§21.4，否则归因可伪造） |

其它：客户端窗口尺寸/缓存写在 `userData`（见 §7.2/§7.5，含用户维度）；**不涉及服务端数据**。
验收 SQL（必须落在 W4 判据里）：`SELECT count(*) FROM apps WHERE kind='wasm_app' AND config_json::jsonb->>'access'='public'` **= 0**；`SELECT to_regclass('public.app_sessions') IS NULL AND to_regclass('public.employee_sessions') IS NULL`；`git grep -nE '"access"\s*:\s*"public"' -- server/demoapps server/skills docs/wasm-app-authoring.md` **零命中**。

---

## 10. 渠道与白标（本版新增字段）

| 项 | 规则 |
| --- | --- |
| `channel.json` 新字段 | `desktop.app_origin_scheme`（**全部渠道必填**，含 official；CI 硬校验） |
| 派生规则 | 缺省（仅本地开发）为 `<deep_link_scheme>-app` |
| 约束 | 必须匹配 **`^[a-z][a-z0-9+.-]{1,31}$`**（与 §8.3 逐字一致，**不是无上界版本**）、不得与 `deep_link_scheme` 相同、不得与其它渠道冲突、不得是 `http/https/file/data/javascript/about` |
| 注入链 | `ci-channels.sh` → `brand-prepare` → `build/channel.json` → desktop 组装期注入 profile 行 config → 新包 `registerAppScheme(appOriginScheme)` |
| **取值时序与三个终点（冻结，R2C-13/CHN-13 订正）** | 同一份真源 `channel.json`，**三个消费者、两个时刻**，不得混为一谈：①**特权注册**（`registerSchemesAsPrivileged`）**必须早于 `app.whenReady()`** ⇒ 取值只能来自 `main.ts` **模块作用域**读取的渠道包（**不能**来自插件 Config、**不能**来自任何运行期路由）；②**宿主/新包的 `config.appOriginScheme`** 在**组装期**由 profile 行注入（apply 期可见）；③**客户端渲染进程**在**运行期**经 §16.1 的本机只读路由 `GET /api/pico/wasm-apps/channel` 取 `{appOriginScheme, deepLinkScheme, productName}`（用于分享链接与文案，**不参与特权注册**）。三处取值必须相等（同一渠道包），**对拍判据**：desktop 组装探针断言 ①=②=③ |
| 服务端 | 服务端镜像内含本渠道配置 ⇒ 以 `channel.AppOriginScheme()` 为**唯一**合法 scheme（不信任客户端声明）；未配置 ⇒ 启动期 fail-loud |
| 同机多渠道 | 官方与渠道客户端 scheme 不同 ⇒ origin 天然隔离；跨渠道深链不工作属预期 |

---

## 11. 安全模型

### 11.1 信任边界

| 边界 | 判据 | 证据 |
| --- | --- | --- |
| 应用页 → 平台 | 只能经客户端协议 handler；handler 持 bearer 且**合成 Origin** | 实测：应用页无法 fetch 平台 origin（跨源被拦） |
| 应用 A → 应用 B | Chromium origin 隔离（不同 host） | 实测：`A://` → `B://` fetch 被拦 |
| 客户端 UI → 应用 | 不同 origin，且 UI 侧有持有性证明 | 实测：`http://127.0.0.1` 页面 fetch 应用 origin 失败 |
| 公网 → 应用 | 不存在应用 origin（无 DNS/证书/路由） | I1 断言 |
| 应用 → 浏览器存储 | 允许但按 origin 隔离；**无 cookie** | 探针（W0-D，**待跑＝当前无证据**） |
| **本机路由 → 平台** | 渲染层持宿主签发的一次性 proof（`X-Pico-Host-Proof`）；**不依赖 Cookie/Host/Origin/端口**（§22.2 R2） | 用例：不带 proof 的本机调用 ⇒ 401 |
| **应用窗口 → 平台（持有性）** | bearer **＋** 安装密钥绑定的 app-proof（`X-Pico-App-Proof`，§23.1）：proof 绑 `(user_id, bearer hash, install_id, serverURL, app_id, exp, jti)` ⇒ **不可跨应用/跨用户搬运**，非幂等请求 jti 去重 ⇒ **不可重放**；**签发要求安装签名 + 一次性 nonce** ⇒ 平台端多了一道"必须是已注册安装"的门与可审计/可吊销的注册表。⚠️ **注册是 TOFU**（见 §17 认账 7）：**仅持 bearer 者仍可为"尚未注册的" install_id 注册自己的公钥并签发** —— 本机制**不**把"bearer 泄露"变成"不可用"，它抬高的是"无法冒充既有安装 + 无法搬运/重放 proof"，真正的边界见 §17 认账 7 | 用例：无/过期/跨应用重放/跨用户/跨安装 ⇒ 401（§13.1 I2）；jti 重放 ⇒ 401 |

> **证据强度（R1-SEC-11 / R2T-8）**：本表"实测"与 §2.3 同一批采集 —— **Linux 单平台、单次运行、证据未入库**；标"待跑"者当前**无证据**，不得作为已成立的安全结论引用。

### 11.2 旧模型威胁 → 本模型处置

| 威胁 | 处置 |
| --- | --- |
| 换票链接转发导致的登录 CSRF/会话固定 | 链路整体删除（无票可转） |
| Host 混淆 / 未识别 Host 回落主站 | 无公网应用 origin；服务端 host 判据由 app_id 推导 |
| 兄弟应用同域 Cookie 串味 | 每应用独立 origin，且**无 cookie** |
| 地址栏粘贴不可区分 | 无地址栏 |
| 匿名薅用量 | 无匿名面；一律登录 |
| 平台凭据泄漏给应用 | 令牌只在主进程内存；应用页拿不到（帧内只给本人身份） |

### 11.3 认账（见 §17）

---

## 12. 部署与发布

- **删除三项前置**：通配域名、通配证书、Caddy 通配站点块；`.env.example`/compose/Caddyfile/部署文档已完成同步（D3）。
- **env 保留**：`PICOAI_TRUSTED_PROXIES`（客户端 IP 归属）、`PICOAI_APPS_EXTRA_RESERVED`（保留字）；**删除** `PICOAI_APPS_BASE_DOMAIN`、`PICOAI_TRUSTED_PROXIES_EXPLICIT`。
- **升级**：服务端与客户端**必须同版本**；旧客户端删除换票后无法打开应用；**不做降级通道**。
- **回滚（R1-OPS-1/DAT-9 订正，必须同步改发布说明）**：`0073` 是 `DROP TABLE`、`0074` 改写配置 ⇒ **回滚 ≠ 只换镜像**。正确口径：**停服 → 恢复升级前 `pg_dump` → 回退镜像 → 客户端重装**；只回退镜像会让旧二进制逐请求 `42P01`（`migrate.go` 只跳过已应用版本，**启动不报错**，症状是运行期 500）。仅 `v2.7.5` 线（不含 0069）可只回退镜像。**发布说明里"回滚不需要数据变换"必须删掉/改写**（`docs/releases/v2.7.6-beta.5.md:16` 的迁移清单要补 0073/0074/0075），并在 AI-DEPLOY 增本版回滚专段。
- **存量部署清理（R1-OPS-2/OPS-9）**：三项前置虽已从仓库删除，但**已上线部署**若配过通配 DNS/证书/反代通配块，升级后仍会把主站铺到任意子域 ⇒ 必须给**可执行清理清单与判据**（例：`curl --resolve x.<DOMAIN>:443:<IP> https://x.<DOMAIN>/` 应失败或非 200）；`.env`/`settings` 里残留的 `PICOAI_APPS_BASE_DOMAIN`/`wasm.apps_base_domain` 现在**静默失效**，启动要 warn 并给清理命令。
- **升级窗口的可诊断性（R1-OPS-5）**：两个方向都要有信号 —— ①服务端先升：旧客户端打不开时，服务端要能记录"旧路径命中"计数/日志（并在可能时给可读提示页）；②客户端先升：命中"路由不存在"的 404 必须与"应用不存在"可区分（能力探针或独立错误码），排障表写进部署文档。
- **发布范围**：`v2.7.6-beta.5` **包含全部内容**（独立窗口 + 渠道 scheme + 基础改进），发布说明按最终落地范围回改（D4 已写一版，需二次回改）。

---

## 13. 验收判据

统一脚本：**必须落在版本库内**（R1-TST-12/OPS-7 订正：不能放 gitignore 的 `temp/`，否则"可复跑"无法被审计者与 CI 复现）——目标位置 `scripts/verify-wasm-client-only.sh`，并接进 `yarn check` 的一个 guard；**已落地（L4 交付）**：`scripts/verify-wasm-client-only.sh`（六组：静态守卫 / 三方对拍+旧模型零残留 / go build+vet+定向测试 / 客户端三包 / webadmin / 协议探针），根 `package.json` 的 `check:wasm-client-only` 与 `scripts/check-workspaces.mjs` 的 `GUARDS` 已接线（W6 前 `advisory:true`，转阻塞是 W6 的收尾动作）；带 `--portable` 模式（1/2/7 组：静态守卫 + 三方对拍 + 残留 + 渠道约束 + HEAD 绑定），PG/探针/包 check 不在该模式并显式说明归属。**探针落点** = `scripts/wasm/probes/*`。`temp/wasm-client-verify/` 只是历史草稿目录，不作为交付物、不得被任何判据引用。

**R1 审计结论（必须照此补强，否则 §13 不具备认证能力）**：
1. **探针自身判定 + 退出码**（已落地）：不得用 `grep VERDICT` 判绿（既可能假红也可能退化成存在性断言）。
2. **禁止静默跳过**（已落地）：`go test -json` 断言 `skipped == 0` 且关键用例（`TestClientRequest_LoginRequiredWithoutIdentityIs401`/`TestCheckClientOrigin`/`TestClientFrameUser_MatchesSessionProjection`）确实 `pass`。
3. **零残留断言三分法**：业务代码必须零命中；测试夹具/历史文档进显式白名单；**未跟踪文件也要查**（`git grep` 只覆盖已跟踪文件）。范围必须含 `server/internal`、`server/cmd`、`server/webadmin/src`、`.env.example`、`docker-compose.yml`、`Caddyfile.*`、`docs/deploy/**`。
4. **补齐 W0-D/W2/W3/W5/W6 的脚本承接**：今天只有 W1 的变异与 W4 的"文件不存在"是机器可判；其余五行既无实现也无脚本。
5. **真机端到端（W6）必须有实体**：真服务端（临时 PG + 真二进制打信封端点）→ 真 wasm 输出 + `wasm_call_events.user_id`；真协议页用真客户端 + CDP 断言（窗口 URL/内容/Set-Cookie 丢弃/401 页/重试页）；三平台参数化并产出 `PROBE-RESULTS.md`；tag 流水线接入。
6. **验收结论绑定 HEAD**：脚本记录 `git rev-parse HEAD` 与工作树脏标记（本仓有并发编辑史，结论不可比）。
7. **补充部署面判据**：渠道 scheme 正负例（用**正式 tag 名**或合成夹具，否则只证明 beta）、打包清单、版本号一致性、`healthz/readyz`、发布说明存在性。

### 13.1 不变量 × 判据覆盖矩阵（每条不变量必须至少一条**行为级**判据 + 一条变异验证）

| 不变量 | 行为级判据 | 变异验证（改坏必红） | 部署级判据 |
| --- | --- | --- | --- |
| I1 公网无应用 origin | 请求 `<app_id>.<基域>`（任意方法）⇒ **404，且不返回应用内容**（不是 200/410/换票 302） | 恢复 HostGate 子域路由 ⇒ 该用例红 | 未配置任何基域变量时，客户端内打开应用仍成功（真机 E2E） |
| I2 身份只来自 bearer **＋客户端持有性证明** | 无 bearer ⇒ 401；伪造 Cookie/Query 身份 ⇒ 仍 401；撤销令牌后 ⇒ 401；**缺 `X-Pico-App-Proof` ⇒ 401 `PROOF_REQUIRED`；过期 ⇒ 401 `PROOF_EXPIRED`；`(user_id, install_id, app_id)` 任一绑定不符/跨应用重放 ⇒ 401 `PROOF_MISMATCH`；非幂等请求同 `jti` 第二次 ⇒ 401**（§23.1） | 让 `clientFrameUser` 回落到 Cookie/参数 ⇒ 对应用例红；**去掉 proof 校验（或只校验签名不校验绑定）⇒ proof 用例红** | 服务端日志/调用事件含 `user_id`，匿名面不存在；**`request` 与 `open` 两个端点都要求 proof**（只挂一个 ⇒ 审计记 P1） |
| I3 Origin 合成与校验 | 非幂等缺 Origin/异源 Origin ⇒ 403；`Origin == <app-scheme>://<app_id>` ⇒ 通过 | 判据改为"缺失即放行" ⇒ 对应用例红 | 客户端 handler 确实补了 Origin（组装探针） |
| I4 每应用独立 origin | 跨应用 fetch 失败；客户端 UI（http 源）fetch 应用失败；cookie 不可用 | 允许跨应用 fetch ⇒ 探针红 | 三平台探针各跑一次（W6） |
| I5 唯一服务端入口 | 路由表里应用请求只有 `…/:app_id/request`（无 anon/login/app-ticket/旧子域树）；信封 6 键解析（`query` 不带 `?`、空体 `""`） | 加回 anon 路由或旧子域路由 ⇒ 路由完整性用例红 | 旧客户端表现为"打不开"（无子域可解析/无换票端点）——这是**有意**的，发布说明写明必须同版本升级；服务端不提供降级页 |
| I6 access 只两值 | 写侧传 `public` ⇒ 拒绝；读侧旧数据改写后按 login 执行；存量行迁移后无 `public` | 写侧接受 `public` ⇒ 用例红 | 迁移后抽样：库内 `access='public'` 计数为 0 |

> 覆盖矩阵是审计入口：任一条不变量缺行为级判据或变异验证 ⇒ 视为 P1。

### 13.2 其它必须有的判据（不在 I1–I6 内，但同等强制）

| 判据 | 内容 | 变异验证 |
| --- | --- | --- |
| 超时预算序关系 | 客户端出站超时 > `GuestBudget`(10s) > `SQLStatementBudget`(5s) > `AppDBBusyTimeout`(3s) | 把客户端超时改成 5 s ⇒ 对应用例/探针必红 |
| 缓存用户作用域 | 切换账号后**读不到**上一账号的缓存（同一 app+version） | 去掉 `session-scope` ⇒ 对应用例红 |
| 窗口标题防伪装 | 应用 HTML `<title>` 不进入窗口标题；标题恒为 `<应用名> · <产品名>` | 改成采用 `<title>` ⇒ 对应用例红 |
| 会话/分区切换清窗 | 登出/切账号/切分区后 `app_id → window` 映射为空且窗口已关 | 去掉清理 ⇒ 对应用例红 |
| 深链待打开队列 | 早到深链在宿主就绪后被消费；未登录时保留并在登录成功后续开；过期项丢弃且不弹错 | 去掉队列 ⇒ 对应用例红 |
| 新字段规格一致 | `window.ratio` 越界（<0.25 / >4.0 / 非数字）⇒ 发布期 `APP_CONFIG_INVALID`；生成物与规格源逐字节一致 | 放宽区间 ⇒ 用例红；手改生成物 ⇒ `TestGeneratedArtifactsAreByteIdentical` 红 |

### 13.3 打开校验与计数（F16）的判据

| 判据 | 内容 | 变异验证 |
| --- | --- | --- |
| 每次打开都校验 | 应用中心「打开」与深链打开**各调一次** `open` 端点（同一窗口内后续请求不再调）；断言调用次数与时机 | 跳过校验直接开窗 ⇒ 用例红 |
| 版本变化即清缓存 | 服务端返回 `changed=true` ⇒ 该应用在 `session-scope` 下的**全部版本缓存目录被清空**，且页面按新版本渲染 | 不清缓存 ⇒ 用例红（断言缓存目录为空 + 内容为新版本） |
| 端点失败不回退旧缓存（**分闸门强度**） | **新建窗口（硬闸门）**：`open` 端点 5xx/超时 ⇒ 本地错误页（F9），**不使用**旧缓存渲染。**聚焦已开窗口（软闸门）**：保留当前内容 + 顶部横幅「无法确认最新版本」+ 重试，**不得**把正在运行的应用打成错误页（§5.1b 闸门强度、§7.5） | 改成回退旧缓存 ⇒ 用例红；**把软闸门写成错误页 ⇒ 对应用例红** |
| **不动应用数据库** | 清缓存前后，应用库 `db.*` 表数据与资源抽取目录**逐字节不变**（同一次打开的两次快照对比） | 让清缓存误删应用库/资源目录 ⇒ 用例红 |
| 计数一次 | 每次打开计数 +1（口径按 §14 第三轮 Q1）；同一打开的后续请求不重复计数 | 计数写在请求路径而非 open ⇒ 用例红 |
| 计数失败不阻塞 | 计数存储异常时接口仍返回版本、窗口正常打开（只记 warn） | 让计数异常冒泡 ⇒ 用例红 |
| 管理端可见 | `GET /wasm-apps/:app_id/opens` 返回按日粒度的 PV/UV 且与明细一致（抽样对账） | 汇总与明细不一致 ⇒ 用例红 |
| **员工可见（§19 Q11）** | `open` 响应带 `opens.today.{pv,uv}`，应用页显示「今日已被打开 N 次」；**计数失败时该行不渲染**（不得显示 0、不得报错） | 去掉 `opens` 回传 ⇒ 用例红；计数失败时显示 0 ⇒ 用例红 |

### 13.4 分波次判据（**可复跑命令**；W6 由 `scripts/verify-wasm-client-only.sh` 承接）

| 波次 | 判据（可复跑） |
| --- | --- |
| W0-D 新增探针 | 自定义协议下 `localStorage`/`sessionStorage`/`IndexedDB`：可用性 + 按 app_id 隔离 + 与客户端 UI 隔离；输出 `VERDICT` |
| W1 服务端收口 | `go test ./internal/wasmapp/... ./internal/router/...`（真 PG）全绿；变异：Origin 判据放开、host 判据放开、public 写侧放开 ⇒ 各自用例必红 |
| W2 客户端窗口化 | `yarn workspace @picoaide/dsh-wasm-apps-host check`、`@picoaide/dsh-wasm-apps check`、`dsh-browser check` 全绿 + 真机：打开/聚焦/尺寸记忆/比例锁定/缓存命中/401/离线 |
| W3 渠道 scheme | `GITHUB_REF_NAME=v2.7.6-beta.5 bash scripts/ci-channels.sh …` 正例通过、缺字段/与深链同值/非法格式负例中止；desktop 组装探针断言注入值 |
| W4 删除波次 | §13 零残留断言 + `make check` 全绿 + `session`/`edge/hostgate.go`/`anonlimit` 路径不存在 |
| W5 文档与发布 | 三项前置零残留、发布说明含"必须同版本升级"、作者文档含 window 字段与"无 cookie" |
| W6 三平台与真机 | Linux/macOS/Windows 跑同一协议探针 + 真服务端 + 真 wasm 端到端（打开→操作→写库→AI 操作） |

---

## 14. 决策日志（两轮 41 问）

**第一轮（24 问）**：①文档形态=单一总纲 ②在跑小步收尾后冻结 ③已落盘代码保留为实现基线 ④审计终止=连续两轮零 P0/P1 且无新增 P2 ⑤审计身份=9 类全选 ⑥文档位置=`docs/planning/2026-09-19-wasm-client-only-design.md` ⑦分享=仅深链+复制 ⑧深链支持 `?path=` ⑨access=login|whitelist ⑩**不需要兼容老版本（从未交付客户）** ⑪**未登录=面板层拦截弹登录** ⑫外链=内置浏览器新标签 ⑬下载=沿用内置浏览器策略 ⑭web 存储=先探针实测 ⑮AI 可操作应用页 ⑯**打开位置=每个应用独立窗口** ⑰会话过期=提示+引导重登+保留路径 ⑱版本切换=下次导航自然生效 ⑲平台不可达=本地错误页+重试 ⑳**scheme 可随渠道自定义** ㉑缓存=客户端按 app+version ㉒体积沿用 1 MiB/8 MiB ㉓应用请求不落 audit_logs ㉔落到 beta.5 且不做降级通道。

**第二轮（17 问）**：①单应用单窗口 ②AI 与现有工具面一致 ③窗口复用内置浏览器 view/分区/CDP ④无地址栏最小 chrome ⑤重复打开=聚焦并导航 ⑥缓存=版本失效+生命周期清理 ⑦**两个 scheme**（深链 `<scheme>`、origin `<scheme>-app`）⑧scheme 来源=渠道包字段 ⑨缺省派生 `<scheme>-app` ⑩**public 彻底退场**（迁移改写+代码只认两值）⑪演示与示例全部改 login ⑫深链未登录=主窗口弹登录后自动继续 ⑬web 存储=允许但建议应用库 ⑭**窗口尺寸按应用记忆、作者声明比例与大小、强制锁比例、大小可调** ⑮**全部等齐再发 beta.5** ⑯发布说明按最终范围回改 ⑰**全部渠道必填 app scheme**。

**第三轮（产品追加需求，2026-09-19 追加，本次）**：①**每次打开都向服务端校验最新版本**（防缓存）②**发现新版本 ⇒ 清本地缓存**③**但绝不清应用数据库**④因为每次打开都会请求服务端，**服务端新增"打开计数"**，供管理端做运营。细节参数见下条（**Q1–Q9 已定稿，结论落在 §5.1b/§8.9**）。

**第三轮问答（Q1–Q9，**已定稿**；结论同 §5.1b/§8.9，问题原文保留作留痕）**：Q1 计数口径（每次/同用户 N 分钟去重/每人每天每应用一次）；Q2 指标集（PV/UV 之外是否要"失败次数/打开时长"）；Q3 明细保留期与汇总粒度；Q4 管理端展示位置与导出；Q5 版本校验端点是否合并计数（现草案=合并）；Q6 清缓存范围（该应用全部版本 vs 仅旧版本）；Q7 离线/端点失败时是否允许用旧缓存（现草案=不允许）；Q8 是否需要"热门应用"实时看板；Q9 计数是否按部门/渠道聚合。

**被本次推翻的早期决策**（记录留痕）：内置浏览器标签承载 → **独立窗口**；固定 `picoaide-app://` → **渠道化 `<scheme>-app`**；`public` 读侧映射 login → **彻底退场**；未登录在标签页内提示 → **面板层拦截**；"版本切换=下次导航自然生效"（无打开期校验）→ **每次打开都校验版本**。

---

## 15. 审计轨迹（多身份循环）

| 轮次 | 身份 | 结论 | 处置 |
| --- | --- | --- | --- |
| **SA-1** | 主控自审（架构 / 安全 / 客户端 / 数据 / 判据五个视角） | **8 条**：P0 无；P1 四条 —— ①缓存跨账号可读（`userData` 路径无用户作用域）②应用 HTML `<title>` 可冒充窗口/客户端 UI ③"AI 工具面可寻址应用窗口"缺机制 ④§13.1 给 I5 写的部署级判据不可实现（旧子域已不存在）；P2 四条 —— ⑤登出/切分区未定义关窗 ⑥深链早到无排队规则 ⑦`window.ratio` 无区间约束 ⑧超时预算无时序纪律 + 新字段生成物链缺失 | **全部已修**：§7.5（缓存作用域 + 唯一权威）、§7.2（标题冻结 + 切窗 + AI 寻址=共享 tab 表 `kind:'app'`）、§7.6（待打开队列）、§6（ratio 0.25–4.0）、§5.1（超时序关系）、§13.1（I5 判据改如实）、§13.2（六条强制判据 + 变异验证）、§9（生成物链） |
| R1-1 | 安全审计员（SEC） | **1×P0 + 4×P1 + 8×P2**：P0=打开路由两端错位（同 CLI-4/CHN-1/UX-1/TST-5）；P1=协议 handler 不绑定发起者、分区/缓存缺"服务端×账号"作用域、缓存命中丢宿主安全头与准入、渠道 scheme 注入只覆盖 1/4 消费者 | 已并入 §18.1/§18.2；发起者绑定见 §20（A/B） |
| R1-2 | 服务端工程师（SRV） | **0×P0 + 7×P1 + 5×P2**：scheme 无服务端落点、`legacyAnonymous` 使 I2 暂时不成立、0074 按字面改写 0 行且漏 `kind`、删除清单自相矛盾（`WriteAppNotFound` 调 `SelfOrigin`）、`sessionKey` 恒空导致 AI 令牌失去会话级吊销、错误分层未定义、大小写判据与实现不符 | 已就地订正 §8.2/§8.3/§8.4/§5.1/§9；其余进 W1/W4 |
| R1-3 | 桌面客户端工程师（CLI） | **4×P0 + 8×P1 + 2×P2**：跨包接线通道不存在（`kind:'app'` 无落地路径）、应用窗口分区**无权限守卫**、§18.1 声称的订正在正文缺失、打开路由三处不一致；P1 含白名单不同构、登录闸门服务不存在、F16 归属未定、特权注册时序、`?path=` 未实现、窗口无脚本导致"重试/重登"无承载、ratio 三项前提缺失 | 已就地订正 §5.1/§5.1b/§7.2/§7.5；接线与窗口契约进 W2 |
| R1-4 | 运维与部署（OPS） | **1×P0 + 5×P1 + 3×P2**：P0=回滚承诺与 0073/0074 矛盾且被发布说明抄成"回滚不需要数据变换"；P1=存量通配面清理无步骤/判据、W3 只证明 beta、fail-loud 与既有兜底约定冲突、升级窗口双向无信号、可观测性整块缺失 | 已就地订正 §12/§13；可观测性与清理清单进 W5/W6 |
| R1-5 | 产品体验（UX） | **3×P0 + 9×P1 + 4×P2**：P0=路由错位（同 SEC/CLI）、渠道 scheme 硬编码、`pico/wasm-app-open` 事件零消费者；P1 含未登录交互未实现、`?path=` 被丢弃、错误文案指错方向、承诺的按钮不存在、目录无分享入口、无搜索、冻结口径、历史 public 无运营路径、AI 控制权落点未定义 | 产品决策已由 §19 落定（15 条）；实现进 W2/W5 |
| R1-6 | 数据与迁移（DAT） | **0×P0 + 8×P1 + 7×P2**：运行期权威是**磁盘资产**而非 DB 列（只改 DB 不兑现 I6）、0074 需 jsonb 往返 + `kind` 限定 + 回归测试、0073 缺停机/锁口径、生成物与 skillseed 登记缺落点、发布说明回滚口径错误、客户端缓存缺用户维度、缓存 304 成第二入口、缓存键版本无来源、缓存路径 Windows 权限无意义 | 已就地订正 §9/§7.5/§12；其余进 W1/W4 |
| R1-7 | 测试与判据（TST） | **7×P0 + 6×P1 + 5×P2**：探针判据双向失效（已修）、`go test` 可被 Skip 吞成零断言绿（已修）、W0-D 探针不存在、W2 真机判据无实现、路由常量分叉、W6 端到端完全缺失、I6 被绿测试钉死；并判定"§13 八行里只有 W1 变异与 W4 文件不存在是真正机器可判" | 已修 §13 前两条 + 补 7 条强制要求（§13 前言）；其余进 W1–W6 |
| R1-8 | 红队对抗（RED） | **11 条攻击判定**：成立 = 拿到 bearer 即可绕开客户端使用任意应用（P1，见 §20）、无地址栏+标题固定+身份预填 ⇒ 钓鱼（P1）、跨应用顶层导航换壳（P1）、"不能联网"为假（导航外带，P1）、任意网页可发起带身份导航型 GET（P2）；不成立 = 跨应用读数据、伪造身份、进程内抢注、直连 handler、服务端缓存投毒；另给"文档过度自信 10 条"（把一次实测当通则） | 窗口闸门/分区守卫已写进 §7.2；§6"不能联网"表述订正；§20 决 A/B |
| R1-9 | 上游与渠道（CHN） | **3×P0 + 9×P1 + 4×P2**：P0=路由错位、渲染进程硬编码 scheme、browser 包 6 处 scheme 写进判定逻辑；P1 含分享注入无调用者、服务端 scheme 与 ABI/schema 标识符混在一起（盲目 sweep 会砸 ABI）、"全部渠道必填"的流水线后果与顺序未写、跨渠道唯一性无实现地点、official/beta 取值未定、渠道仓不 pin 导致两端 scheme 漂移、CI 夹具会红；并附**按渠道改动清单**与 13 条文档缺口 | 已并入 §10 待补（§18.2 W3/W7）；ABI 冻结已在 §8.3 声明 |
| **R2-A** | 安全/红队复验（第二轮） | **3×P0 + 12×P1 + 9×P2**；**总判：安全面不可发布**。P0=①路由仍断且被两端测试钉死②§20.2 发起者绑定与实现方向相反（guard 放行 + 标签无导航闸门，任务书 C4 还要求放行）③app-proof 可由 bearer 自助签发且不绑 app_id/无 nonce。P1 含：proof"登录签发"与恢复型启动冲突（重启后必 401）、`open` 端点漏 proof 要求、子资源/beacon/SW 型 CSRF 未被两个钩子覆盖、按窗口种类而非 app_id 判、深链是第二条免闸门路径、`§7.2` 分区口径自相矛盾、scheme 参数化 0% 落地、"proof 不落盘"扫错根、早期契约"接受跨应用导航"未标注推翻 | 已定案 **A′**（§23.1）并逐条订正（§23.2）；P0-1/P0-2 的代码改动进 W2 |
| **R2-B** | 判据与验收复验（第二轮） | **2×P0 + 9×P1 + 4×P2**；**总判：验收体系不具备认证能力**。P0=我上一轮"修好"的脚本仍有**两处恒不成立断言**（关键用例正则字段序写反、`skip` 把包级 no-test-files 计入）⇒ 从假绿翻成假红；P1 含脚本未入库、零残留三分法未实现（且仓库没有根 `.env.example`）、7 条强制要求 0 条"写清且可执行"、W3 行与"正式 tag 名"自相矛盾、跨源判据缺"请求未到 handler"正向对照、`§2.3/§11.1` 未标注单平台/单次/证据未入库、无 HEAD 绑定、探针只跑 2/4 | 两处恒红**已修**（R2T-1/2）；其余逐条落进 §13 与 §23.2（脚本入库/CI job 归位/三分法/正对照） |
| **R2-C** | 文档自洽核查（第二轮） | **4×P0 + 11×P1 + 7×P2**：R2C-1 §14 仍写 Q1–Q9"待确认"与 §8.9"已定稿"冲突；R2C-2 §7.2 同条内"同分区 vs 专用分区"矛盾；R2C-3 §7.5 残留无条件 304 规则（重开第二入口）；R2C-4 §21 删除 aichat 与 §8.1 保留清单/§4 图/§8.2 会话键论证冲突 | **4 条 P0 已就地订正**（§14 措辞、§7.2 分区统一为"复用按用户分区 + 名称含服务端哈希"、§7.5 304 限定静态子资源、§8.1 删 aichat）；P1 逐条进 §23.2/§18 |
| **R2-I** | 施工就绪复验（第二轮） | **2×P0 + 15×P1 + 4×P2**；**总判：未达到"可直接按文档改代码"**。P0=R2I-2 独立窗口与 browser"单窗口 + 池级控制权"架构不兼容（胶囊/蒙版/寻址无载体）、R2I-6/7 app-proof 与 F16 **不在任何波次**；P1 含 windows.ts 契约缺失、AI 工具寻址 schema、守卫归属、0075 维护者、api 拿不到 `*Server`、会话键接缝、头白名单真源、A/B 未拍板、official/beta 取值、跨渠道唯一性、渲染进程 scheme 注入不存在、渠道仓不 pin、波次表缺输入/产出/判据、W7 无判据 | §16 已重写为**唯一权威波次表**（含输入/产出/判据/依赖，W0-D 前移、W1 收编 app-proof 与 F16、归属冲突消解）；R2I-2 列为**待裁架构分叉**（§16.1） |

终止条件：**连续两轮零 P0/P1 且无新增 P2** —— **尚未满足**（第一轮外部审计未收齐，第二轮复验未开）。在满足之前，本文件不作为施工依据；代码保持冻结（用户 2026-09-19 决策：在跑的小步收尾后冻结）。

### R2（第二轮复验）已到结论：**3×P0（中途预警，完整报告待发）**

| 编号 | 结论 | 处置 |
| --- | --- | --- |
| **R2-P0-1** | 打开路由错位**仍未修**，且**被两端测试各自钉死**（客户端 `open-app.ts:48` + `app-center.spec.tsx:347`/`shipped-bundle.spec.ts:90`；宿主 `index.ts:50` + `index.spec.ts:207`）⇒ 点「打开」100% 404，且改路径会让现有测试变红（假绿锁死） | 已并入 W2 并**明确要求两端 spec 同批改 + 加跨包相等断言**；§13 需新增"打开链路真机判据"（点击后 1 s 内出现窗口或可读错误页） |
| **R2-P0-2** | §20.2「发起者绑定」与已落地实现**方向相反**：`guard.ts` 把 app scheme 加进内置浏览器白名单、浏览器标签无 `will-navigate` 闸门 ⇒ 任意 http(s) 页面可发起带身份的导航；而任务书 C4 条目**明确要求**放行（设计/任务书/代码三方矛盾） | **任务书 C4 已就地勘误**（放行表述作废）；正确口径 = §20.2 + **§22.2 R4**（只有应用窗口可以，浏览器侧拒绝并审计）；代码在 W2 改 |
| **R2-P0-3** | §20 的 app-proof **回答不了 RED-6**：签发端点只要求 BearerAuth ⇒ **任何拿到 bearer 的人可自助签发**（proof 只多一次往返）；且 proof **不绑 app_id、无 nonce/jti** ⇒ 15 min 内可对任意应用重放；§20.3 把边界写成"本机同用户进程"是**低估**（远端窃取/日志/备份同样适用） | **需产品拍板**（见 §23）：A′ 绑**安装密钥**（Electron `safeStorage` 里的设备密钥，proof 由该密钥派生/签名）＋绑 `app_id` ＋一次性 nonce；或 B 承认边界=bearer 并收回对外表述 |

> ⚠️ **审计目标漂移声明（2026-09-19，重要）**：R1-1…R1-9 九路审计**启动后**，产品又追加了 F16（每次打开校验版本 + 清缓存不动应用库 + 服务端打开计数，见 §3/§5.1b/§7.5/§8.9/§9/§13.3/§14）。
> 因此：①第一轮 findings **仍按原文有效**（它们审计的是 v1.1，其余章节未变）；②**第二轮必须覆盖本次增量**（F16 相关章节 + 计数迁移 + 判据），否则终止条件不成立。

---

## 16. 分波次实施计划（**唯一权威波次表**；R2I-17/R2I-18 订正：每波必须给输入/产出/判据/依赖/不可并行原因）

**实现基线（已落盘，保留）**：新包 8 模块 + 63 例；`browser` guard/凭据/地址栏（568 例）；客户端应用中心/打开路径/深链/`access` 文案（179 例）；desktop 11 项登记 + 922 例；webadmin 基域删除（463 例）；服务端 `clientreq.go`/`handlers.go`/`router.go`/`client.go`/`serve.go`（编译通过，appcfg 与测试收尾中）。

| 波次 | 输入 | 产出 | 判据 | 依赖 / 不可并行原因 |
| --- | --- | --- | --- | --- |
| **W0-D**（**前移到 W2 之前**） | 契约 §3/§7.5；探针脚本 | `probe-web-storage.cjs`（localStorage/sessionStorage/IndexedDB 可用性 + 按 origin/分区隔离）+ 输出落盘 `temp/wasm-client-only/` 或 `scripts/wasm/probes/` | 探针自判定 + 退出码；结论写回 §7.5/F13（不可用则改口径） | 无依赖；**必须在 W2 缓存/存储实现之前**，否则 W2 返工 |
| **W1** 服务端收口 | 契约 §5.1/§5.1b/§8.2/§8.3/§8.4/§9/§20/§23 | ①`access` 严格两值 + appcfg 规格收敛 + **生成物重生成（appcfg 侧）**；②**app-proof 服务端侧**（签发端点进 router、校验接进 `request`/`open`、每部署密钥 = 复用 `util.EnsureMasterKey` 或新 `app-proof.key`，**落在 `<dataDir>`**）；③**F16 服务端侧**：`POST …/:app_id/open` + `X-PicoAide-App-Version` 响应头 + 迁移 **0075**（计数表）+ **0076**（`usage` 应用维度）；④`Options.AppOrigin` 注入（api 层拿不到 `*Server`，R2I-9）+ 补 `clientreq.go:225`/`client.go:77` 两处 scheme 常量；⑤`legacyAnonymous` 与 I2 的时序说明 + 用例；⑥头白名单单一真源 = **Go 常量**，产出 `wasm-app-headers.json` 供客户端对拍（R2I-11） | `go test ./internal/wasmapp/... ./internal/router/...`（真 PG，**用例级 0 skip**）+ 变异（Origin/host/public/proof 各一条） | 无；**被 R2I-6/7 阻塞的点已在本行消解**；与 W3 动同一批文件 ⇒ **W3 不得与 W1 并行改 `clientreq.go`/`client.go`** |
| **W2** 客户端窗口化与接线 | W1 端点；§22 seam；**R2I-2 裁决**（见下） | ①`windows.ts`（依赖/inject、建窗适配器签名、状态文件 schema + `@deepseek-ai/dsh-atomic-write`、旧账本丢弃点、下架/冻结/删除关窗的触发源）；②**跨包路由常量单一真源 + 相等断言**（两端 spec 同批改）；③`hostRequestSurface` seam + `X-Pico-Host-Proof`（去 Cookie/Host/Origin/端口）；④缓存（`session-scope`+version+path、304 仅静态、命中重写安全头）；⑤面板层登录拦截 + 深链队列 + 一次性授权（F/AI 桥同族）；⑥guard/导航修正（§22.2 R4 + session 级 `onBeforeRequest`，按 app_id 判）；⑦app-proof **客户端侧**（安装密钥 + 惰性签发 + 续签模块）；⑧AI 工具寻址（`app_id` 参数、id 空间、是否占 maxTabs/写账本） | 三包 `check` + 真机：点击后 **1 s 内出现窗口或可读错误页**；跨包常量断言；缓存隔离（A/B 账号不互读） | 依赖 W1（端点/版本头）；**被 R2I-2（窗口载体）阻塞** |
| **W3** 渠道 scheme | §10；私有渠道仓 | ①`channel.json` 加 `app_origin_scheme`（**全部渠道必填**；official/beta 取值 = `picoaide-app`，公共渠道共用命名空间）；②CI：逐渠道必填校验 + **跨渠道唯一性扫描（只看字段名，不回显品牌）**；③注入链五处（`main.ts` 早期注册取值 + 新包 + browser guard/tools 文案 + client open-app + client 分享 fail-closed）；④渠道仓改动**先 push** 再打 tag；⑤渠道仓 commit pin 或写进产物（R2I-16） | 正式 tag 名（或合成夹具）正负例；`verify-ci-scripts.mjs` 夹具同步；三包用例改造 | 依赖 W1 的 scheme 参数化（同一批文件）；**不可与 W1 并行改 `clientreq.go`/`client.go`** |
| **W4** 删除波次 | §8.4 + §9 | ①删 `session/**`、`anonlimit/**`、`edge` 主机门控、router 旧端点、基域配置面、`entry_url` **三处 emit**（`publish.go:825`/`read.go:512`/`release.go:85`）；②迁移 **0073**（DROP，停服窗口）+ **0074**（jsonb 往返 + kind 限定 + 资产目录改写 = **A**）；③`limits` 匿名四项 + 换票/会话项 ⇒ **生成物第二次重生成**；④`skillseed` 版本登记（重算摘要）；⑤`server/demoapps/**`、`refapp/**`、技能/文档的 `ai.chat` 改写 | `make check` + §9 验收 SQL（`public` 计数=0、`to_regclass IS NULL`）+ 零残留三分法 | 依赖 W1/W2/W3；**删除与 W1 的 `legacyAnonymous` 时序必须一次到位** |
| **W5** 管理端与文档 | §3 F14/F16、§19、§21.1 | ①webadmin：访问级别筛选 + 公告模板 + **F16 视图**（PV/UV 列 + 趋势 + TOP N + 部门聚合）+ **AI 用量面板**；②作者文档/技能：window 字段、无 cookie、无 `ai.chat`、AI 前端桥范例、存储对照表、可发现性/空态/冻结口径 | `npm test`（webadmin）+ 文案存在性 + 生成物一致 | 依赖 W1（字段/接口）；与 W2 的客户端文案需对拍 |
| **W6** 验证 | 全部 | ①`scripts/verify-wasm-client-only.sh` **入库** + `scripts/wasm/probes/*` + `package.json` 的 `check:wasm-client-only` + `check-workspaces.mjs` 的 `GUARDS` 同步（PG 相关 go test 归 **server job**）；②三平台协议探针 + 真机端到端（真 PG + 真 wasm + 真协议页 + CDP 断言）；③`PROBE-RESULTS.md` 落盘；④V1 独立复验（按本文件逐条 + 变异） | 脚本退出码 + 三分表 + 变异矩阵 | 依赖 W1–W5 |
| **W7** 发布 | §12 | `version.mjs set v2.7.6-beta.5` → 发布说明定稿（迁移 0073–0076、回滚口径、访问模型）→ tag → CI → R2 + 测试环境升级 | §13 的 W7 判据（新增）：发布说明含"必须同版本升级"+ 迁移清单 + 回滚步骤；`check-workflows.mjs` 绿 | 依赖 W6；渠道包必须先 push（W3） |

**§16 与 §18.2 的归属冲突已消解**（R2I-18）：0073/0074/0075/0076 与生成物重生成归 **W4**（appcfg 侧规格改动在 W1，但**产物重生成分两次**：W1 一次 appcfg 侧、W4 一次 limits 侧）；`legacyAnonymous` 的**清理**在 W1、**随旧路径删除**在 W4；`scheme` 参数化的**服务端部分在 W1**、**渠道与客户端部分在 W3**，两者不得并行改同一批文件。

### 16.1 架构分叉裁决（**已定：W-C**）与 W2 可施工条款

**R2I-2 裁决 = W-C：独立窗口 + surface 抽象。** 具体条款（W2 按此施工，不再提问）：

| 面 | 冻结内容 |
| --- | --- |
| 窗口 | `windows.ts` 用**独立 `BrowserWindow`** 承载应用（不占用浏览器窗口）；单应用单窗口、聚焦导航、尺寸/比例记忆见 §7.2 |
| **surface 抽象** | 新增 `surface` 概念：`{ kind: 'browser-tab' \| 'app', id, webContents }`。**工具实现只写一份**（navigate/snapshot/eval/get_text/wait_for…），按 surface 分派；browser 包**导出一个 surface seam**（新增 `exports` 子路径，例如 `@picoaide/dsh-browser/surface`），新包通过它注册/取得 surface —— 由此 `packages/host/wasm-apps-host` 的 `needs` 与 `package.json` 依赖要同步登记（`check-workspaces.mjs` 的 `needs: []` 改为 `['@picoaide/dsh-browser']`） |
| AI 寻址 | 工具新增可选 `app_id`；`browser_list_tabs` 输出加 `kind`/`app_id`（**schema 需扩**，`additionalProperties:false`）；**应用窗口不吃 maxTabs=16 配额、不写浏览器标签账本**；无显式目标时的默认寻址**只指向浏览器当前标签**（应用窗口必须显式给 `app_id`，避免误操作） |
| 胶囊/蒙版 | 从 browser 的 shell 页**抽成共享组件**（同一份实现），应用窗口自带一份挂载点；**控制权状态仍按 surface 记**（每个应用窗口独立"人/AI"归属），不再依赖池级 `pool.controlled` |
| 权限守卫 | 归属 = **分区初始化**（不是建 tab 时）；`installPermissionGuard` 提升为分区级 `ensureSessionGuard`，浏览器与应用窗口共用；request + check 两个 handler 都必须装 |
| 导航闸门 | 归属 = **应用窗口模块**（`will-navigate`/`will-frame-navigate`/`setWindowOpenHandler` 判"同 app origin"）+ **session 级 `webRequest.onBeforeRequest`**（按 webContentsId/initiator 判"只有应用窗口能请求 app scheme"）；`classifyNavigation` 要按 surface kind 分流（浏览器标签不得导航到 app scheme，但 AI 对应用窗口的 navigate 必须放行） |
| `windows.ts` 契约 | `inject: ['picoSession','webServer'(seam), 'browserSurface']`；建窗适配器扩 `WasmAppsHostAdapter`（`createAppWindow/openAppWindow/focusAppWindow/closeAppWindow/setAspectRatio` + `onBeforeRequest`/`will-navigate` 钩子）；状态文件 `<userData>/wasm-apps-windows.json`（schema：`{version, apps: {<app_id>: {width,height,x,y,ratio?,lastPath?}}}`，**原子写优先复用 `@deepseek-ai/dsh-atomic-write`**；**原子写已复用上游 `@deepseek-ai/dsh-atomic-write`（2026-09-20，W6/W7 切换完成）**：`dsh-wasm-apps-host` 的 `dependencies` 已声明 `"@deepseek-ai/dsh-atomic-write": "0.1.5-rc.2"`（与 `packages/host/desktop` 同值；`yarn.lock` 仅新增该 workspace 条目、离线 install 7.3 s）；**包内本地 `atomicWriteFile` 助手已删除**，全部写入点（`windows.ts` 窗口状态 / `app-proof.ts` 安装密钥 / `ai-authorization.ts` AI 授权记录）统一走 `writeFileAtomic(path, body, { mode: 0o600, dirMode: 0o700 })`；判据 = `atomic-write.spec.ts`（原子提交 / 失败不留半个文件 / 权限位）+ `atomic-write-wiring.spec.ts`（模块解析到上游包、调用点经替身计数确实调用它、本地同名符号不得复活）。**两处口径勘误**：① **上游与本地助手都不做 fsync**（上游 `.d.ts` 明写 *Crash durability (fsync) is out of scope*）⇒ 原句 `temp + fsync + rename` 与两版实现**均不符**，该持久性缺口**自 W2 起存在、本版未修**（如实认账，未擅自扩大改动）；② 上游权限位**必须逐调用点显式声明**（`mode` 必填、`dirMode` 漏传即回落 mkdir 默认）⇒"唯一实现"的约束从"一份代码"改为「**一处语义 + 每个调用点可见的权限位 + 接线判据**」；旧标签账本迁移 = browser store 的 groups 账本，**丢弃 `url` 以 app scheme 开头的条目并 warn** |
| 生命周期触发源 | 应用下架/冻结/删除 ⇒ 关窗清缓存的触发源 = **下次打开时的 `open` 端点响应**（`enabled=false`/`frozen`）+ 客户端在 `pico/session-changed`/应用中心刷新时按目录对比（**不做服务端推送**，R2I-3 明确） |
| sessionKey 接缝 | `ServeClientRequest(w, r, appID, user, **sessionKey**)` 显式传参（不用 context）；sessionKey = `serverstore.TokenHash(bearer)[:32]`；登出/改密/禁用的回调点 = `serverauth` 的四处（`handler.go:533` 登出、`:370` 改密、`admin.go:551/735/1058` 重置/禁用/删除）——若本期不接回调，按 §17 认账 |
| 0075 维护者 | UV 与日汇总由 **Go 定时器**（照 `internal/balance` 范式）每分钟/每五分钟 upsert（`usage_ledger.go:122` 同款批算）；**明细先汇总后清理**（不得先删后汇，否则 UV 永久丢失）；用户当天换部门 ⇒ 以**打开时刻**的部门为准（同一用户当天可出现在两个部门行，UV 按 `(app_id,day,dept)` 去重） |
| **客户端运行期取 scheme（原称"渲染进程 scheme 注入"）** | 落地形态 = 新增**本机只读路由** `GET /api/pico/wasm-apps/channel`（seam 之内）返回 `{appOriginScheme, deepLinkScheme, productName}`；客户端 `open-app.ts` 的 `APP_PROTOCOL` 常量改为**运行期读取**；`setAppShareScheme()` 由应用中心挂载时调用；未拿到 ⇒ 分享入口不渲染（fail-closed）。⚠️ **本行只是第③个消费者**（运行期），**不参与**特权注册（`registerSchemesAsPrivileged` 的取值时序见 §10"取值时序与三个终点"，R2C-13/CHN-13 订正） |

---

## 17. 认账项与待验证

1. **Windows / macOS 的自定义协议行为未实测**（探针仅在 Linux 跑过）：`registerSchemesAsPrivileged`、分区注册、无 Origin/无 Cookie 四条需三平台复核（W6）。不一致 ⇒ 回退备选形态并修订本文件。
2. **浏览器存储可用性未实测**（W0-D）：若 `localStorage` 不可用或跨应用不隔离，F13 口径改为"禁止依赖"。
3. **下载行为未纳入本版验证范围**（沿用浏览器既有策略，不在应用窗口专项验证）。
4. **`window.ratio` 与客户端记忆的边界**：多显示器/缩放变化时的行为以"裁剪进工作区"为口径，不做逐显示器记忆。
5. **审计明细不含应用请求**（只落 `wasm_call_events`），合规口径已在文档写明。
6. **跨渠道深链不工作**属预期，需在渠道文案说明。
7. **客户端持有性证明不做"设备"绑定，只做"安装"绑定；且安装注册是 TOFU（必须如实认账，不得写成更强）**（§23.1 A′ 取代 §20.1）：proof 由 **Ed25519 安装密钥**签发，private key 存 `safeStorage`（无钥匙串 ⇒ 0600 文件）。**TOFU 的后果**：任何持有效 bearer 的调用方都能为**尚未注册**的 install_id 注册一把自己持有的公钥（注册只需"一个签名 + 一次性 nonce"，攻击者用自己的密钥即可满足）⇒ **仅拿到 bearer 仍能注册新安装并自助签发**（多一次往返）；单个用户的安装密钥数有上限（换机余量），且注册表可审计/可吊销。**因此 R2-P0-3 的闭合口径是**：proof 不再是 bearer 的等价物 —— **绑 app_id（不可跨应用）、绑 install_id（不可冒充既有安装）、一次性 nonce（不可重放）、jti 去重（非幂等不可重复提交）**；**"bearer 泄露即可用任意应用"这一条仍然成立**（在注册新安装之后），真正抬高它需要更强的用户级第二因子（客户端登录态绑定 / 设备指纹 / DPoP / OS keychain 强绑定 / 硬件密钥），本期不做，留待客户要求。另：同机同用户进程若同时拿到 bearer 与该私钥，可直接复用既有安装身份（能读同一用户文件系统的进程即可，含本机恶意软件）。
8. **应用 AI 无归因的老客户端**（§21.4）：老客户端不带 `X-Pico-App-Id` ⇒ 计费正常但应用维度归因缺失。
9. **应用 AI"不限"依赖传输层超时与运维安全阀**（§21.5）：业务层不设上限，传输层默认 30 min idle；卡死会话的风险由安全阀兜底。
10. **应用 AI 无工具≠无风险**（§21.5）：应用可用 messages 诱导模型输出有害/越权内容，或诱导员工手动泄露信息。
11. **服务端 wasm 不再具备任何 AI 能力**（§21.7）：依赖 AI 的应用必须改成"前端调 AI → 结果回传 wasm"；迁移面 = `server/demoapps/appdemo/**`、`server/skills/app-builder/**`（SKILL/示例/references）、`docs/wasm-app-authoring.md`、`server/internal/wasmapp/refapp/**`，全部随 W4 同批改写。
12. **无钥匙串环境下的私钥保护降级**（§23.1）：Linux 上没有可用钥匙串时，安装私钥只能落 0600 文件（启动 warn）；此时"安装绑定"的强度等于"同用户文件系统隔离"。W6 需在目标三平台实测 `safeStorage.isEncryptionAvailable()` 并记录结论。
13. **存储实测的强度与缺口**（F13）：已实测 `localStorage`/`IndexedDB` 可用且**按 origin 与按 `persist:` 分区双重隔离**、`Cache Storage` 不可用（**主控最小复现**，`temp/w0d-rootcause/{storage,isolation}.cjs`；Linux / Electron 43.4.0 / 单次运行 / 未跑三平台）——**在库内探针（W0-D）交付自己的可复跑证据之前，本条只算"机制已验证、制品未入库"**（台账 CTL-1/CTL-4 仍开）。

---

## 18. R1 审计整改决议（第一轮外部审计汇总，2026-09-19）

**汇总（九路全部回报）**：测试与判据 18（7×P0/6×P1/5×P2）、服务端 12（0/7/5）、运维部署 9（1/5/3）、产品体验 16（3/9/4）、数据迁移 15（0/8/7）、上游与渠道 16（3/9/4）、安全 13（1/4/8）、桌面客户端 14（4/8/2）、红队 10 条攻击判定 —— **合计约 124 条**。**同一个"打开路由两端错位"被 5 路独立发现**（SEC-1/CLI-4/CHN-1/UX-1/TST-5），是本轮最高置信度的 P0。

### 18.1 已就地订正（本轮改动，逐条对应 finding）

| 原条款 | 订正 | 对应 finding |
| --- | --- | --- |
| §5.1 host 判据"大小写混淆一律 400" | 改为"归一化后比较；只有形态/取值不符才 400" | SRV-6 |
| §5.1 错误码 | **拆成"传输层（外层 HTTP）"与"应用管线（内层信封 status）"两张表**；410 注明 `status=410 但 code 复用 NOT_FOUND`；403 注明"跨源写 / 审计账号"两个来源 | SRV-7 |
| §5.1 响应体 `truncated` | 明确"兜底截断即按 502/`INVALID_PLATFORM_RESPONSE` 处理，不得把截断字节当成功交给渲染器"；并说明键是否省略 | SRV-11 |
| §7.5 缓存 | 304 **只允许宿主直出静态子资源**；文档导航与 `/api/*` 一律回源（避免成为绕过准入的第二入口）；缓存路径含 `session-scope` + 会话切换清空；**版本来源**改为宿主统一加 `X-PicoAide-App-Version` 响应头（客户端只剔逐跳头） | DAT-10/11/12 |
| §8.2 身份投影 | 补归一化口径（`display_name` trim、部门取第一个组名）+ 账号可用性对拍（禁用/删除 ⇒ 401）+ **会话键替代**（bearer SHA-256 前 16 字节 hex；或认账 45 min 令牌存活） | SRV-5/SRV-10/DAT-13 |
| §8.3 自身源 | 新增"**scheme 参数化的唯一落点**"：`Server.appScheme` 由 `channel.AppOriginScheme()` 注入、`AppOrigin` 改方法、fail-loud 边界、正则与既有实现逐字一致、`abi.ABIVersion` 不得同改 | SRV-1/SRV-9 |
| §8.4 删除清单 | 改为**逐调用点**并修掉自相矛盾：`WriteAppNotFound` 必须与 `SelfOrigin` 同批改签名；补 `options.go`/`serve.go`/`cmd/server`/`router` 具体行；补"服务端 HTML 失败页语言归属"（`session.PreferredLocale` 删除后的落点） | SRV-4/SRV-8/DAT-1 |
| §9 迁移 | 0073 加停机窗口 + `lock_timeout` + 不加 CASCADE + 调用点清单；0074 改 **jsonb 往返 SQL** + `kind` 限定 + `jsonb_exists`（禁 `?`）+ 自检 + **资产目录归一化处置（A/B 二选一）** + 迁移回归测试；新增生成物/技能登记一次跑完清单、演示应用存量处置、验收 SQL | DAT-2/3/4/5/6/7/8、OPS-1 |
| §12 回滚 | 改为"停服 + 恢复 `pg_dump` + 回退镜像 + 客户端重装"，并要求回改发布说明的"回滚不需要数据变换"；补存量部署清理清单与判据、升级窗口双向可诊断性 | OPS-1/2/5/9、DAT-9 |
| §13 验收 | 脚本**必须入库**（`scripts/verify-wasm-client-only.sh` 并接进 `yarn check`）；补 7 条强制要求（探针自判定、禁静默跳过、零残留三分法、W0-D/W2/W3/W5/W6 承接、真机端到端实体、绑定 HEAD、部署面判据） | TST-1..18、OPS-7/8 |
| §7.2/§13.3/§14 | 提前完成自我审计 8 条 + F16 计数定稿（Q1–Q9） | SA-1、产品第三轮 |

### 18.2 进波次整改（不在本轮改文档，属于施工与验收）

| 波次 | 整改项（对应 finding） |
| --- | --- |
| **W1** | `legacyAnonymous` 与 I2 的时序（SRV-2）；迁移 0073/0074 + 回归测试（DAT-1..5）；appcfg 规格收敛 + 5 产物重生成 + skillseed 登记（DAT-7/8）；公开匿名读路径的变异判据 |
| **W2** | 打开链路端到端接通：**路由常量单一真源 + 跨包相等断言**（TST-5/UX-1/R2-P0-1，**两端 spec 都要改，不许各自钉死自己的字符串**）、`windows.ts`（含尺寸/比例/状态文件契约，SRV 缺口 5）、`kind:'app'` tab 注册与控制权 UI（UX-3/UX-12）、缓存实现（含用户维度/版本头/304 限制）、面板层登录拦截与深链队列（UX-4/UX-5/TST-12）；**新增（§22 迁移就绪）**：本机路由的 `hostRequestSurface` seam + `X-Pico-Host-Proof` 请求头授权（去掉 Cookie/Host/Origin/端口耦合）、浏览器标签侧的 app scheme 导航/弹窗拒绝（§22.2 R4，纠 C4 勘误） |
| **W3** | 渠道 scheme 参数化（服务端 `Server.appScheme`、客户端 5 处注入、browser guard、分享 fail-closed）+ CI 三条负例 + **正式 tag 名 dry-run**（SRV-1/9、UX-2、TST-13、OPS-3/4） |
| **W4** | §8.4 全部删除项 + 验后 SQL + `git grep` 三分法（SRV-4、TST-7/10/11、DAT-1） |
| **W5** | 作者文档补 `window.*` 与可发现性口径（UX-13/TST-15）；webadmin 访问级别筛选与历史 public 运营动作（UX-11）；部署文档清理/回滚/排障三节（OPS-2/5/6/9） |
| **W6** | 真机端到端 + 三平台探针 + W0-D 存储探针（TST-3/4/6/9、OPS-6） |
| **W7** | 发布说明二次回改（迁移清单/回滚口径/访问模型）+ 全渠道 dry-run（OPS-1/3、D4） |

### 18.3 产品待定（第三批提问，见 §19；未定前按保守缺省执行）

可发现性（搜索/筛选/分页）、空态与冻结口径、未登录交互是否本版真做、深链异渠道提示载体、分享入口位置、AI 控制权 UI 落点、窗口边界与极端比例、外链/下载落点、存储生命周期对照、计数对员工可见性、打开等待口径、管理员运营动作、目录字段扩展、首次引导。

### 18.4 第二轮复验必查（对 R1 的闭环验证）

1. §13 的 7 条强制要求是否**真的落地**（脚本入库 + 禁跳过 + 三分法 + 六个波次承接 + 端到端实体 + HEAD 绑定 + 部署面判据）。
2. 已就地订正的 **11 组**条款（§18.1 表 11 行）是否**自洽**（尤其 §8.3 的参数化落点与 §8.4 的删除边界是否真的编得过、删得净）。
3. 产品待定项是否已由 §19 的回答落定，且**没有留守旧的相反表述**。
4. 新增/变更的判据是否都带变异验证。

---

## 19. 产品第四轮问答（R1 审计提出的"缺失的产品决策"，2026-09-19）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 可发现性 | **本版加搜索（名称/一句话/负责人）+「我发布的」筛选**；>20 条分页或虚拟滚动 |
| 2 | 空态口径 | **三种空态分别给文案**：①0 个应用（引导让 AI 做一个）；②**全部下架**（列表**非空但每一行都是已下架** —— 由客户端按行状态**自行判定**，不是"空列表"）；③**全部冻结**——⚠️ **主控 2026-09-20 裁定（R1-L3-1 修正）**：冻结应用**不进目录**（F1），因此"目录里全是冻结"**结构性不可达**；冻结只会在**深链/历史入口直接打开**时遇到 ⇒ 那一档由 §7.7 的冻结页（「已被管理员停用」）承担，**不再作为目录空态**。三者**不得塌缩**成同一句文案 |
| 3 | 冻结呈现 | 目录**不列**；直接打开给**可辨文案「已被管理员停用」**（不是"应用不存在"）；内层 404 带 `reason=app_frozen` |
| 4 | 未登录拦截 | **本版真做**：面板层拦截 → 弹客户端登录 → 登录后自动继续（含深链待打开队列；**闸门放宿主**，客户端半边不持 bearer） |
| 5 | 异渠道深链 | **主窗口一次性 toast**：「这个链接属于另一家企业的客户端，请让对方用你们客户端的『复制链接』重发」 |
| 6 | 分享入口 | **目录行「复制链接」+ 发布成功块**；未注入渠道 scheme 时**不渲染**（fail-closed，避免复制出官方 scheme 的错链接） |
| 7 | AI 控制权 | **窗口内常驻胶囊 + 蒙版；默认人操作，点「交给 AI」才交给 AI**（同按钮双向） |
| 8 | 窗口边界 | **min 320×240**；ratio 极端值夹到 0.25–4.0；显示器变化裁进工作区 |
| 9 | 外链/下载 | 外链 ⇒ 内置浏览器新标签 + 应用窗口**提示条**；下载最小反馈「已开始下载，进度见浏览器窗口」 |
| 10 | 存储生命周期 | 作者文档加**对照表**（`db.*` 服务端永不随缓存清理 / 浏览器存储随清缓存与切账号被清）；下架/冻结/删除**同批清浏览器存储**。**对照表必须含可用性列（F13 实测）**：`localStorage` ✅ / `IndexedDB` ✅ / **`Cache Storage` ❌（`cache.put` 抛 `TypeError: Request scheme … is unsupported`）** |
| 11 | 计数告知 | **应用页显示打开次数**（"今日已被打开 N 次"）+ 隐私说明写明"平台记录打开次数用于运营" |
| 12 | 打开等待 | **先开窗骨架屏** → 校验回来再加载；失败换错误页 |
| 13 | 管理员运营 | 应用中心**访问级别筛选**（能筛出历史 public）+ **面向员工的公告模板** |
| 14 | 目录字段 | 本版**不加**分类/标签/置顶 |
| 15 | 首次引导 | **加一次性引导卡**（应用是什么 / 怎么让 AI 做一个 / 怎么分享） |

---

## 20. 客户端持有性证明（**已定案：A**，2026-09-19 产品拍板）

**为什么需要**：R1-RED-6/8/SEC-2 证明 I3 原本是同义反复 —— handler 合成的 `Origin` 与攻击者自报值不可区分，且**任意被浏览的网页**能触发带身份的导航型 GET。⇒ "应用只在客户端内"必须在服务端有**可验证的持有性证明**，而不是靠自报头。

### 20.1 机制（冻结）

| 项 | 定义 |
| --- | --- |
| 凭据 | `app-proof`：服务端签发的**短时**证明（默认 TTL **15 min**，可配），签名密钥随服务端镜像，绑定 `(user_id, bearer token 的 SHA-256, 服务端地址)`；**设备维度本期不做**（见 20.3 认账） |
| 签发 | `POST /api/client/v2/apps/wasm/proof`（BearerAuth）⇒ `{proof, expires_at}`；登录后**惰性**首次签发（宿主在首个应用请求前取一次） |
| 携带 | 宿主在 `open` 与 `request` 上带 `X-Pico-App-Proof: <proof>`（与 Bearer 并列） |
| 服务端强制 | 两个端点都要求：缺失 ⇒ 401 `proof_required`；过期 ⇒ 401 `proof_expired`；绑定不匹配 ⇒ 401 `proof_mismatch`。**`request` 端点的准入顺序：BearerAuth → app-proof → 信封/host 形态 → Origin（非幂等）** |
| 刷新 | 宿主在过期前静默续签（同签发端点）；续签失败 ⇒ 按会话过期流程（§7.6/F8） |
| 吊销 | 登出/改密/禁用 ⇒ bearer 失效 ⇒ proof 同步失效（绑定 token hash，无需额外吊销表） |
| 存放 | **只在宿主内存态**（不落盘；重登即重签） |
| 与 `write-proof` 的分工 | `write-proof` = **本机路由**的持有性证明（防本机其它进程/页面，已有）；`app-proof` = **服务端**的持有性证明（防拿到 bearer 的第三方） |
| I3 的重新定位 | `Origin` 判据**保留**（仍然拦跨源写与畸形输入），但"客户端专属"的举证责任**移交 app-proof**（§11.1 更新） |

### 20.2 发起者绑定（窗口层，冻结）

证明只解决"谁在调用平台"，不解决"这次导航由谁发起"（自定义协议下 `Origin`/`Sec-Fetch-*` 恒为空）。因此再加一层：**只有应用窗口可以导航/弹窗到 app scheme**；浏览器标签与任意网页**不得**导航或 `window.open` 到 app scheme（`setWindowOpenHandler` + `will-navigate`/`will-frame-navigate` 双侧拒绝并记审计）。应用窗口内的同 app origin 导航照常放行（§7.2 导航闸门）。

### 20.3 判据与认账

- **判据**：①无 proof / 过期 / 跨用户重放 ⇒ 401（三种 reason 各一例）；②`request` 去掉 proof 校验 ⇒ 用例必红（变异）；③浏览器标签内的 http(s) 页面导航或弹窗到 app scheme ⇒ **被拒且窗口未创建**（行为级）；④proof 不落盘（断言 `userData` 下无 proof 文件）。
- **认账（写入 §17）**：本期不做设备绑定，且 bearer 在无 keyring 环境落盘为 0600 明文（`session.json`）⇒ **同机同用户进程若已取得 bearer，仍可自行签发 proof**。该残余风险的真实边界是"本机同用户进程"，不是远端攻击者；若客户要求更强，再上设备密钥（DPoP/OS keychain）。

---

## 21. 应用 AI：删除服务端 `ai.chat`，改由客户端 AI loop 提供（2026-09-19 定案）

### 21.1 决定（第五轮 15 问）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 调用位置 | **A：应用前端 JS 调宿主**（协议 handler **本地**处理，不经服务端） |
| 2 | 服务端 `ai.chat` | **彻底删除**（ABI/hostcap/capapi/aichat 包/limits/示例/技能文档） |
| 3 | AI 形态 | **仅对话**：无工具、无文件、无连接器、无记忆、无用户历史 |
| 4 | 工具权限 | 默认无工具；"声明 + 管理员审批"列为未来扩展（本期不实现声明面） |
| 5 | 会话模型 | **每应用一个隐藏会话**（支持多轮上下文；不出现在侧边栏） |
| 6 | 会话可见性 | **隐藏但可查**（应用诊断/历史里能查，便于审计与排障） |
| 7 | 上下文 | **仅本次传入的 messages**（不注入记忆、不注入用户会话历史） |
| 8 | 计费 | 走客户端既有 LLM 链路（**使用者账**）＋**应用维度归因**（本期新增） |
| 9 | 用户授权 | **首次调用授权一次**（按 用户×应用 记录，可在设置里撤销） |
| 10 | 返回形态 | **流式 SSE** |
| 11 | 时间/并发上限 | **业务层不设上限**（产品拍板）；**传输层必须有界** + 管理端可配安全阀（见 21.5） |
| 12 | 运营可见 | 应用详情页加 **AI 用量面板**（次数/token/费用，与打开计数同面板） |
| 13 | 作者迁移 | **硬切 + 迁移指引**（发布校验拒绝仍调用 `ai.chat` 的应用） |
| 14 | 应用预设 | **不允许**应用声明提示/模型/温度（平台统一默认模型与提示） |
| 15 | 后台调用 | **仅前台**：应用页面关闭即取消 |

### 21.2 链路（冻结）

```
应用页（客户端内，<app-scheme>://<app_id>/…）
  fetch('/__picoaide/ai/chat', {method:'POST', body:{messages, stream:true}})
        │  保留路径：协议 handler **本地**处理，绝不转发平台
        ▼
协议 handler（新包）
  ① 首次授权闸门（用户×应用；未授权 ⇒ 一次性说明卡；拒绝 ⇒ 403 app_ai_denied）
  ② 取该应用的**隐藏会话**（"app:<app_id>"，不存在则创建；带 app_id 元数据）
  ③ 在该会话上跑一轮 ctx.agentLoop（**仅对话**：工具集为空、平台给定系统提示、无记忆注入）
  ④ assistant 增量以 SSE 回给应用页；页面关闭/取消 ⇒ ctx.agentLoop.cancel
        ▼
客户端既有 LLM 链路（llm-deepseek → 平台 /v1）＋ 出站头 X-Pico-App-Id（归因）
```

**保留路径（冻结，主控 2026-09-19 订正文档内漂移）**：唯一保留路径 = **`POST /__picoaide/ai/chat`**（**双下划线**；§22.1 曾写成单下划线的 `/_picoaide/ai/*`，以本处为准）。规则：①协议 handler 对 `path` 以 `__picoaide/` 开头的请求**本地处理、绝不转发平台**；②应用不得定义同前缀路由（发布校验拒绝）；③**其余 `__picoaide/*` 路径一律 404**（不做通配转发）。

**请求/响应契约**：请求 `{messages:[{role,content}], stream:bool}`（未知字段拒；`messages` ≤64 条、单条 ≤16 KiB）；非流式返回 `{content, usage?}`；流式 `text/event-stream`，发 `delta` 事件、以 `done` 收尾；错误一律 JSON 信封（`app_ai_denied` / `app_ai_unavailable` / `ai_balance_insufficient` / `ai_rate_limited` / `ai_cancelled`）。

### 21.3 服务端删除清单（与 §8.4 同批）

`abi.MethodAIChat` 与其白名单生成物（`imports_gen.go`、作者文档导入面）、`hostcap.callAIChat`、`capapi.AI` 接口与实现、`internal/wasmapp/aichat/**`（686 + 910 行）、`limits` 的 `AIChat*`/`AITokenTTL`/`AITokenRenewBefore` 及 spec 行、事务内禁用条目、相关测试与技能示例。

**老应用**：导入期即拒（`IMPORT_NOT_ALLOWED` + 迁移指引），**不静默**；发布校验同步拒绝；作者文档与 `app-builder` 技能改写为"用前端桥"，并给出"前端调 AI → 结果回传 wasm 落库"的范例。

### 21.4 应用维度归因（新增）

- 隐藏会话元数据带 `app_id`；该会话产生的 LLM 请求出站带 `X-Pico-App-Id: <app_id>`。
- 服务端只在**该请求确属客户端会话链路**时记录该头（非会话请求带该头一律忽略并记 warn），避免任意调用方伪造归因。
- `usage` 新增应用维度（新迁移 + 索引），管理端 AI 用量面板与打开计数同页展示。
- 老客户端不带该头 ⇒ 归因缺失但计费正常（**认账**）。

### 21.5 风险与安全阀（**必须读**）

- **"不限"的边界**：业务层不设时间/并发上限是产品决定，但**传输层必须有界**（HTTP/SSE 连接、Electron 请求、平台网关各自的 idle 上限），否则一个卡死的会话会永久占住连接与内存。实现口径 = "业务不限 + 传输层有界（默认 30 min idle）"，并保留**管理端可配安全阀**（并发/日次数阈值，默认关闭）。
- **无工具 ≠ 无风险**：应用可用 messages 诱导模型输出有害/越权内容，或诱导员工在应用页里手动泄露信息 ⇒ §17 增列认账。
- **后台调用禁止**：窗口关闭即取消，不存在"无人值守跑 AI"的通道。

### 21.6 判据（全部带变异验证）

| 判据 | 变异（去掉即红） |
| --- | --- |
| 保留路径**不转发平台**（断言平台侧无对应请求） | 改成转发 ⇒ 用例红 |
| 未授权 ⇒ 403 `app_ai_denied`，且**不消耗**任何 token | 去掉授权闸门 ⇒ 用例红 |
| 首次授权后不再弹；设置里可撤销（撤销后再调 ⇒ 403） | 去掉撤销入口 ⇒ 用例红 |
| **工具集为空**：断言该轮 tools 为空、无文件/工作区工具 | 注入工具 ⇒ 用例红 |
| 隐藏会话：侧边栏不出现、诊断可查、元数据含 `app_id` | 列进侧边栏 ⇒ 用例红 |
| 仅本次 messages：请求体不含记忆/历史注入 | 注入记忆 ⇒ 用例红 |
| SSE：增量顺序与 `done` 收尾；页面关闭 ⇒ 该轮被 cancel（无孤儿循环） | 去掉 cancel ⇒ 用例红 |
| 归因：`usage.app_id` 正确；伪造头的**非会话请求**被忽略并 warn | 信任任意头 ⇒ 用例红 |
| 老应用硬切：发布校验拒绝 + 运行期 `IMPORT_NOT_ALLOWED` | 静默保留 ⇒ 用例红 |

### 21.7 认账（写入 §17）

①老客户端无归因；②"不限"依赖传输层超时与运维安全阀；③无工具仍存在内容安全风险；④**服务端 wasm 不再具备任何 AI 能力**（依赖 AI 的应用必须改成"前端调 AI → 结果回传 wasm"的形态）。

---

## 22. 零端口迁移就绪（上游 `apps/desktop` / `apps/desktop-host` 形态，2026-09-19 追加）

**目标**：上游 pin（`dsh-v0.1.5-rc.2`，submodule 内已有 `apps/desktop` + `apps/desktop-host`）提供**不监听端口**的桌面形态：渲染层经 `dsh-app://` 由协议处理器承接，宿主子进程用 fd3/fd4 **帧管道**收发请求/响应。本改造的所有新增面必须能在**不重写业务逻辑**的前提下迁到该形态。

### 22.1 现状盘点：哪些是端口耦合的

| 面 | 今天的形态 | 零端口下的形态 | 迁移成本 |
| --- | --- | --- | --- |
| 应用内容与 AI 桥 | **我们自己的协议 handler**（`<app-scheme>://`）+ 保留路径 **`POST /__picoaide/ai/chat`**（§21.2） | 同（与端口无关） | **零** |
| 平台调用 | HTTPS + Bearer + app-proof，走 Chromium 栈 | 同 | **零** |
| 应用窗口 | Electron `BrowserWindow`/view/分区 | 同 | **零** |
| 客户端 UI → 本机打开路由 | `ctx.webServer.register('/api/pico/wasm-apps/open')`（**loopback 端口**） | 上游零端口的宿主请求通道（帧管道） | **小**（前提是本节的 R1/R2/R3 被遵守） |
| 打开路由的授权 | `connection` 的 BrowserAuth cookie（`dsh-auth-*`）+ Host/Origin 围栏 + `http://127.0.0.1:${ctx.webServer.port}` 期望 Origin（`index.ts:292`） | 无 Cookie/Host/Origin ⇒ 必须换成**传输无关的持有性令牌** | **中**（不换就是重写） |
| 客户端 UI 页面 | loopback HTTP 服务 | `dsh-app://` | 平台级迁移（不属于本次范围） |

### 22.2 四条迁移就绪规则（**冻结，写错就是未来的大改**）

| # | 规则 | 判据（机器可查） |
| --- | --- | --- |
| **R1** | **本机 API 只冻结"路径 + 语义"，不冻结传输**：宿主侧所有本机路由经**唯一 seam**（`hostRequestSurface` 适配器：今天映射到 `ctx.webServer.register`，将来映射到零端口请求通道）注册 | 新包/客户端里 `webServer` 字面量只允许出现在 seam 模块；`grep -rn 'ctx.webServer' packages/host/wasm-apps-host/src` 仅 seam 一处 |
| **R2** | **本机 API 的授权不得依赖 Cookie / Host / Origin / 端口**（零端口下都不存在）：必须用**请求头携带的持有性令牌**（与 §20 的 app-proof 同族；今天由宿主签发一次性 token 给渲染层，渲染层每次带 `X-Pico-Host-Proof`） | `grep -rn 'dsh-auth\|127.0.0.1\|webServer.port' packages/host/wasm-apps-host/src` 在 seam 之外**零命中**；用例：不带 proof 头的本机调用 ⇒ 401 |
| **R3** | **应用侧路径不得触碰本机服务**：应用页只能与「自己的 origin（协议 handler）」和「平台 HTTPS」说话；协议 handler 不得回调 loopback（否则零端口下直接死） | 用例：断言 handler 出站只有平台 URL；`grep -rn '<app-scheme>.*127.0.0.1'` 零命中 |
| **R4** | **浏览器面不得能导航到 app scheme**（这是 §20.2 发起者绑定的另一半）：内置浏览器标签**不**允许 `will-navigate`/`window.open` 到 `<app-scheme>:`；只有应用窗口可以。任务书 C4 里"内置浏览器放行应用协议"的条目**作废**（R2 审计 P0-2 指出设计/任务书/代码三方矛盾） | 用例：http(s) 页面 `location.href='<app-scheme>://x/'` ⇒ **零新窗口、零请求**；`guard.ts` 的白名单只对应用窗口生效 |

### 22.3 零端口迁移清单（将来只做这些，不改业务）

1. 把 seam 的实现从 `ctx.webServer.register` 换成零端口请求通道（**一处**）。
2. 打开路由的 proof 从 Cookie 形态换成/复用 R2 的请求头令牌（**一处**校验点）。
3. `write-proof.ts` 的 `requestRejection` 依赖（Cookie + Host/Origin 围栏）在零端口下换成宿主侧的调用方校验（**一处**）。
4. 客户端 UI 的 `/api/pico/*` 相对路径不变（上游零端口仍以路径路由），无需改调用点。
5. 跑 §13 的六组判据 + 真机探针（**判据不变**）。

> 结论：**按 R1–R4 落地后，迁到零端口 = 换两个 seam 实现 + 跑一遍既有判据**，不需要重写应用协议、AI 桥、窗口管理、服务端或作者契约。

---

## 23. 客户端持有性证明 A′（安装密钥绑定）+ R2 复验订正（2026-09-19 定案）

R2 安全复验证明 §20.1 的原设计**回答不了 RED-6**（签发端点只要求 BearerAuth ⇒ 拿到 bearer 的人可自助签发；且 proof 不绑 app_id、无 nonce ⇒ 15 min 内可跨应用重放）。产品拍板选 **A′**：

### 23.1 A′（**替代 §20.1 的签发与校验部分**，其余条款不变）

| 项 | 冻结 |
| --- | --- |
| 安装密钥 | 客户端首次运行时生成 **Ed25519 密钥对**；私钥存 Electron `safeStorage`（有钥匙串 ⇒ 加密；无钥匙串 ⇒ 0600 文件 + 启动 warn，**写入 §17 认账**）；公钥在首次签发时注册到服务端（绑 `user_id + install_id`） |
| 签发 | `POST /api/client/v2/apps/wasm/proof`：Bearer ＋ **安装签名**（对 `{nonce, ts, serverURL, install_id}` 签名）；服务端校验公钥注册与签名后签发。**nonce 一次性且绑签发请求**，签发重放被拒 |
| proof 绑定 | `(user_id, bearer hash, install_id, serverURL, **app_id**, exp, **jti**)` —— **绑 app_id ⇒ 不可跨应用复用**（R2S-2/N2） |
| 重放 | **非幂等请求做 jti 去重**（TTL 15 min、有界 LRU 10 万条）；幂等请求不查（成本取舍，TLS 下可接受） |
| 服务端签名密钥 | **启动期按部署生成、落数据根（0600）、每部署一份、绝不编进镜像**；支持轮换（新密钥签发，旧密钥在 TTL 内仍可验）（R2S-2 订正） |
| 惰性签发（**关键**） | **不在"登录事件"上签发**：恢复型启动（重启后带有效 bearer）也要能用 ⇒ **首次需要时惰性签发**（R2S-4 订正：否则每次重启后首个应用请求必 401） |
| 切换 | 切账号/切渠道/切服务端 ⇒ 清内存 proof 并重新签发；安装密钥与账号无关，不随切换销毁 |
| 自检 | 启动期自检：私钥可读 + 公钥已注册；失败 ⇒ 应用功能不可用并给出可读原因（不静默降级） |

### 23.2 R2 复验的其余订正（已同步进正文/判据）

| 编号 | 订正 |
| --- | --- |
| R2S-7 / N6 | **发起者绑定下沉到 session 级 `webRequest.onBeforeRequest`**（按 `webContentsId`/initiator 判定）—— `will-navigate`/`setWindowOpenHandler` 覆盖不到 `<img>`/`sendBeacon`/`prefetch`/SW 这类子资源请求 |
| N7 | 闸门**按 app_id 判**：应用窗口内也不得跨 app 打开（`window.open`/`browser_navigate` 同路径） |
| N8 / RED-3 | 深链（OS 级 URL 打开）也必须过闸门：未登录 ⇒ 进待打开队列；`?path` 净化补 `//`、`\`、`%2e`、`@`（拒绝协议相对 URL 形态） |
| R2S-8 | §7.2 分区口径统一：**复用按用户的浏览器分区，但分区名必须含服务端哈希**；**守卫在分区初始化时安装**（不再"建 tab 时才装"）；AI 工具面经共享 tab 注册表寻址 |
| R2S-10 | `truncated:true` 必须按 502/`INVALID_PLATFORM_RESPONSE` 处理（实现待改，W2） |
| R2T-1/2 | 验收脚本两处恒不成立断言已修：关键用例正则字段序（`Action` 在 `Test` 之前）、`skip` 只数**用例级**（包级 "no test files" 不算） |
| R2T-3/12 | 脚本必须迁入 `scripts/verify-wasm-client-only.sh` + `scripts/wasm/probes/*`，加 `package.json` 的 `check:wasm-client-only`，并**同步 `check-workspaces.mjs` 的 GUARDS**；PG 相关 `go test` 归 **server job**（gate job 无 PG）；环境变量参数化、探针产物落盘 |
| R2T-4 | 零残留范围纠正：`server/.env.example`（仓库**没有根 `.env.example`**）、`server/webadmin/src`、配置与文档面、白名单、未跟踪文件；`git grep` 的 rc≥2 不得当通过 |
| R2T-6 | §13 的 W3 行删掉 beta tag 名（统一"正式 tag 名或合成夹具"） |
| R2T-7 | 跨应用/跨 UI 判据补**正向对照**：断言"请求**未到达** handler"（仅"响应被拦"不算），并加 form-encoded 跨应用 POST 用例 |
| R2T-8 | §2.3 与 §11.1 的"实测"全部标注：**单平台（Linux）/ 单次运行 / 证据未入库**；§17 认账同步 |
| R2T-14 | 探针的 CSP 违规监听改用 Electron 43 的 details 对象（位置参数已废弃）+ 违规金丝雀 |
| R2S-20 | §15 攻击条数勘误：红队给出 **10 条**（不是 11） |
| R2S-21 | 早期契约 §7.3"接受跨应用导航"加"已被 §7.2/§23.2 推翻"标注 |




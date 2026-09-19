# 决策：跨源那一跳用「同源跳板页」，而不是 302（CSP `form-action` 会拦跨源重定向）

> ⚠️ **历史记录 · 对象已删除（2026-09-20 追记，W4-12）**：本文件引用的下列对象已随「WASM 应用客户端专属」改造的 **W4 删除波次**（2026-09-19/20）**从源码整体删除** —— `internal/wasmapp/session/**`（应用会话 + 主站登录/换票 HTML 面）、`internal/wasmapp/anonlimit/**`、`internal/wasmapp/edge/hostgate.go`（主机名门控）、`internal/wasmapp/aichat/**`、应用子域与应用基域配置面、`entry_url`。
> **阅读口径**：本文件是**当时的审计/决策记录**，凡出现上述对象一律按历史理解，**不得据此实施、也不得当作现行契约**。现行模型见 `docs/planning/2026-09-19-wasm-client-only-design.md`，接口面见 `server/docs/03-api-reference.md` §11b。

> ⚠️ **状态：`superseded`（已作废，2026-09-19）—— 已废弃，不得据此实施。**
> 本文描述的浏览器访问链路（应用子域 / 换票 / `/app-ticket` / 会话 Cookie / 基域 / 通配证书）
> 已在「客户端专属」改造中**整体删除**；本文仅作历史记录保留，其中的机制、配置、操作步骤与结论
> **均不再适用，也不得作为实施依据**。
> **现行契约（权威）**：`docs/planning/2026-09-19-wasm-client-only-design.md`（设计总纲，§16 是唯一权威波次表）；
> 早期契约：`docs/decisions/2026-09-19-wasm-client-internal-origin.md`。

- 日期：2026-09-19
- 状态：**`superseded`**（原「已实施」；2026-09-19 被「客户端专属」改造整体作废）
- 相关：`docs/decisions/2026-09-19-referrer-policy-origin-null.md`（同一轮 P0 的前一半）
- 证据：`temp/wasm-verify/FIX-REPORT.md`、`temp/wasm-verify/logs/`、探针 `temp/wasm-verify/*.mjs`

## 1. 问题

主站换票端点与登录可见应用都靠**同源表单 POST** 工作：

```
应用子域无 Cookie
  → 302 主站 /app-ticket（GET，渲染自动提交表单，不签发任何东西）
  → 同源 POST /app-ticket（Origin 校验通过）
  → 签发一次性票，旧实现 http.Redirect(302) 到 https://<app_id>.<基域>/?ticket=…
```

最后一跳是**跨源**的。按 CSP3（§6.1.10.3），`form-action` 不只约束"提交到哪"，
它**遍历重定向链上的每一个 URL** —— 浏览器因此把这次提交**整单拦下**：

```
Sending form data to 'https://<基域>/app-ticket' violates the following
Content Security Policy directive: "form-action 'self'". The request has been blocked.
```

服务端**从未收到那次 POST**，用户停在换票页；而换票页在启用 JS 时**没有任何可点元素**
（唯一按钮在 `<noscript>` 里）⇒ 一个无法自救的死页面。

同一个根因在应用子域还有第二个投影（2026-09-19 一并修）：应用**会话失效**时，
appserver 把请求送到主站换票端点；对 GET 是普通导航（不受约束），
对**原生表单 POST** 就是跨源 302 ⇒ 同样被应用子域自己的 CSP 拦掉，
用户表现是"点了提交没反应，只有刷新（GET）才恢复"。

## 2. 决策

**把"POST → 跨源 302"改成"POST → 同源跳板页（200）→ 页面自己完成跨源那一跳"。**

跳板页给出三条出口，一条比一条保守，且都**不经过 `form-action`**：

1. 内联脚本 `location.replace(<兜底链接的 href>)` —— `replace` 不留历史条目；
2. `<meta http-equiv="refresh" content="0;url=…">` —— 无 JS 回退（按 HTML 规范同样是 replace 语义）；
3. 可见的 `<a href="…">` —— 链接导航不受 `form-action` 约束，用户总有能走通的一条路。

实现只有一份：`session.RedirectPage(lang, kind, target, title, product)`
（`server/internal/wasmapp/session/pages.go`）—— ⚠️ **该包已随 W4 整体删除**（连同换票链路，
应用改为客户端自定义协议窗口承载）；本段是**当时**的实现记录，两处使用场景只差文案：

| 场景 | 调用方 | target | 文案 |
|---|---|---|---|
| 换票签发成功 | `session.TicketSubmit`（`RedirectTicketIssued`） | `https://<app>.<基域><next>?ticket=<code>` | "凭证已换好，正在跳转…" |
| 应用会话失效 | `appserver`（`RedirectAppSessionExpired`） | `<主站>/app-ticket?app=…&next=…` | "登录状态已失效，这次提交没有被保存…" |

### 2.1 为什么**不**放宽 CSP

`form-action 'self'` 一个字符都不改（主站 `mainPageCSP` 与应用子域
`limits.AppContentSecurityPolicy` 都是）。表单永远只提交到同源；跨源那一跳是**页面导航**，
本来就不该由 `form-action` 管。放宽 CSP 只是把"提交到哪"的控制权交出去换一个能跑的假象。

### 2.2 方法分流（appserver 侧）

| 请求形态 | 响应 | 理由 |
|---|---|---|
| 幂等（GET/HEAD/OPTIONS/TRACE） | 302 | 导航不受 CSP 约束，302 最省，行为与修复前一致 |
| 非幂等 + 不显式要 JSON | 200 同源跳板页 | 原生表单提交会被 `form-action` 拦跨源 302 |
| 显式要 JSON（`/api/*`、`Accept: application/json`） | 302 | `form-action` 只管原生表单，fetch/XHR 不受约束；给 API 客户端塞 HTML 会破坏 JSON 契约 |

## 3. 票的生命周期（与原 302 等价）

| 属性 | 原 302 | 跳板页 | 说明 |
|---|---|---|---|
| 一次性 | ✔ | ✔ | `ticketStore.consume` 的锁内 CAS，未改 |
| TTL 60 s | ✔ | ✔ | `limits.TicketTTL`，未改 |
| 绑 (user, app) | ✔ | ✔ | 未改 |
| 签发审计 `app_ticket_issue` | ✔ | ✔ | 未改（异步） |
| 不进浏览器历史 | ✔（302 不产生新条目） | ✔ | `location.replace` / meta refresh 同样以 replace 语义导航 |
| 不经 Referer 泄漏 | ✔ | ✔ | 跳板页 `Referrer-Policy: same-origin` ⇒ 跨源跳转**不发 Referer**；本页 URL 本身不含票（票在响应体里） |
| 不落缓存 | ✔ | ✔ | `Cache-Control: no-store` |
| 兑换后不留痕 | ✔ | ✔ | `RedeemTicket` 302 到去掉 `ticket` 的干净 URL |

**刷新的语义变化（要认账）**：旧实现是 302，POST/Redirect/GET 天然成立；现在 POST 返回 200
页面，因此**刷新会重复提交** —— 多签一张票、多一条 `app_ticket_issue` 审计。影响被压到最小
（`no-store` + `location.replace` 让这一页几乎不会成为"用户手动刷新"的对象），且不构成安全
问题：每张票仍是一次性、60 s、绑 (user, app)，POST 本身仍要求有效员工会话 + 同源 Origin。
**因此不引入**额外的"已签发集合/防重放"（那会新增一份带 TTL 的状态，却不改变任何安全属性）。

## 4. 代价与保留项

- **应用会话失效时的表单 POST 体不会重放**（跳板页走 GET 换票）：用户重新登录回来后需要
  再提交一次；跳板页文案已明确写出"这次提交没有被保存"。
- 跨浏览器只在 Chromium 实测；修复方案不依赖"某个浏览器特有的 CSP 行为"（跳板页对任何
  浏览器都成立）。
- 应用作者自己写 `<meta name="referrer" content="no-referrer">` 仍会让应用内表单 POST
  变成 `Origin: null` ⇒ 403，宿主无法阻止（meta 优先于响应头）。

## 5. 判据（改回去必然变红）

- 单测：`session` 的 `TestTicketSubmitRendersSameOriginJumpPage` /
  `TestTicketSubmitJumpPageEscapesHostileNext` / `TestTicketSubmitJumpPageLocalePerRequest`；
  `appserver` 的 `TestServe_LoginRequiredFormPostGetsJumpPage`（含"幂等仍 302"与"JSON 仍 302"
  两条反例）。
- 真实浏览器端到端：`temp/wasm-verify/probe-e2e-login-app.mjs`（未登录 → 登录 → 进入应用，
  零 CSP 违规）、`temp/wasm-verify/probe-app-session-expired-form.mjs`（会话失效 → 表单 POST →
  回到应用并完成写入）。
- 变异验证：`go build -overlay` 把 302 改回来（工作区文件字节不变）⇒ 端到端探针 exit 1
  并复现原始 CSP 报错，单测 10 条红。

# WASM 应用平台：Referrer-Policy `no-referrer` 让登录与换票 100% 失败（2026-09-19）

> ⚠️ **状态：`superseded`（已作废，2026-09-19）—— 已废弃，不得据此实施。**
> 本文描述的浏览器访问链路（应用子域 / 换票 / `/app-ticket` / 会话 Cookie / 基域 / 通配证书）
> 已在「客户端专属」改造中**整体删除**；本文仅作历史记录保留，其中的机制、配置、操作步骤与结论
> **均不再适用，也不得作为实施依据**。
> **现行契约（权威）**：`docs/planning/2026-09-19-wasm-client-only-design.md`（设计总纲，§16 是唯一权威波次表）；
> 早期契约：`docs/decisions/2026-09-19-wasm-client-internal-origin.md`。

> 决策：主站登录页 / 换票页（`session/pages.go`）与应用子域（`edge.ApplyHostSecurityHeaders`）
> 的 `Referrer-Policy` 一律从 `no-referrer` 改为 **`same-origin`**，并把「策略绝不能是
> `no-referrer`」写进测试；同时补上来源校验失败的诊断日志、把来源校验失败页改回**可重试**。
> 影响面：员工浏览器登录入口（`POST /login`）、登录可见应用的进入链路（`POST /app-ticket`）、
> 应用子域内的同源写请求（应用自己的 `<form method="post">`）。

## 1. 结论先写

`Referrer-Policy: no-referrer` **不是"更安全"，而是把登录关掉了**。

按 WHATWG Fetch 的「append a request `Origin` header」算法，请求的 referrer policy 为
`no-referrer` 时，**非 GET/HEAD 请求的 `Origin` 头被写成字面量 `null`** —— 同源请求也一样
（规范里只有 `cors` / `websocket` 模式才无条件写真实源）。而平台所有写请求的判据都是
`Origin == 自身源`：

| 写路径 | `no-referrer` 下的实际请求头 | 服务端判定 | 用户看到 |
|---|---|---|---|
| `POST /login`（登录表单） | `Origin: null` | `checkMainOrigin` ⇒ 403 | 输完账号密码也永远登不进去 |
| `POST /app-ticket`（换票页加载即自动提交） | `Origin: null` | `checkMainOrigin` ⇒ 403 | 「请求来源校验未通过」且**没有输入框** |
| 应用子域同源写（如演示应用留言墙 `POST /note`） | `Origin: null` | `edge.CheckOrigin` ⇒ 403 | 「跨源写请求被拒」，应用功能不可用 |

三条都是**100% 必现**，与浏览器、账号、网络无关。

## 2. 现象与复现

### 2.1 用户报告

> 「如果是登录可见，会跳转到 `/app-ticket`，然后提示『请求来源校验未通过，请从平台首页重新进入』。
> 根本没有地方输入账号密码。」

「没有地方输入」不是文案问题：`TicketSubmit` 与 `LoginSubmit` 在来源校验失败分支里
把 `ShowForm` 置成了 `false`，模板里那段 `<form>` 整块不渲染（见 §5.2）。

### 2.2 真实浏览器探针（改前实测）

- `temp/wasm-probe/probe-login-flow.mjs`：访问 `https://demo-login.<基域>/` → 302 主站
  `/app-ticket` → 换票页自动提交，请求头实测 `origin: "null"` → **403**，页面文案
  「请求来源校验未通过，请从平台首页重新进入」，无账号密码输入框。
- `temp/wasm-probe/probe-login-submit.mjs`：直接打开 `/login`，填账号密码点提交，
  `POST /login` 同样 `origin: "null"` → **403** ⇒ 员工浏览器登录入口 100% 不可用。
- 应用子域同源写：`curl -X POST https://<app>.<基域>/api/hello -H 'Origin: null'` → 403
  「跨源写请求被拒」；把 `Origin` 换成真实源 → 200。

### 2.3 微实验：策略 → `Origin` 头的映射（`temp/wasm-probe/micro-referrer.mjs`）

自造一份带 `<meta name="referrer">` + 同名响应头的页面，真实 Chromium 提交同源表单，
观测 POST 请求头：

| 页面策略 | 实测 `Origin` | 说明 |
|---|---|---|
| `no-referrer` | **`null`** | 就是本次 P0 的形态 |
| `same-origin` | `http://127.0.0.1:<port>`（真实源） | 修复后采用 |
| `strict-origin-when-cross-origin` | 真实源 | 也能用，但在 HTTPS→HTTP 降级时会退化成 `null` |

修复后另用**改后的真实页面字节**跑了一次端到端自证
（`temp/wasm-probe/verify-same-origin.mjs`，见 §6.3）：`same-origin` ⇒ 真实 `Origin`，
`no-referrer` ⇒ `null`，同一份字节只改策略。

## 3. 根因定位为什么拖了这么久（可观测性缺口）

`checkMainOrigin` 当时**只在一种情况下**打日志：配置了 `MainOrigin` 且请求自身源与它不一致。
其余失败分支（`Origin` 形态非法 / 不匹配 / 两者缺失）**全部静默**。于是线上只有 403 页面，
服务端日志里一个字都没有 —— 无法区分"用户从别的域名访问"、"反代没回传 X-Forwarded-Proto"、
"`Origin` 是 `null`"这三种完全不同的原因。

本次一并补齐（见 §5.3）：每次拒绝落**一条**日志，含判据名、期望源、`Origin`、`Referer`、
`Host`、`X-Forwarded-Proto`；**不打 Cookie**（会话明文进日志等于凭证泄漏）。

## 4. 影响面（同一条根因的四个面）

| # | 面 | 位置 | 后果 |
|---|---|---|---|
| 1 | 主站登录页 | `session/pages.go`：`loginTmpl` 的 `<meta>` + `writePage` 响应头 | `POST /login` 必 403 |
| 2 | 主站换票页 | `session/pages.go`：`ticketTmpl` 的 `<meta>` + `writePage` 响应头 | 登录可见应用完全进不去 |
| 3 | 应用子域全部页面 | `edge/hostgate.go`：`ApplyHostSecurityHeaders`（含 4xx/5xx） | 应用内**原生表单 POST** 全 403 |
| 4 | 失败可定位性 | `session.checkMainOrigin` / `edge.CheckOrigin` | 线上 403 无任何日志线索 |

注意第 3 条的普遍性：它不挑应用 —— **任何**在应用里用 `<form method="post">` 做写的应用都中；
应用自己的 HTML 里再写一份 no-referrer 也一样（meta 会覆盖响应头）。

> **实测口径更正（2026-09-19，独立验证代理的真实 Chromium 微实验）**：中招的**只有原生表单提交**。
> 同源 `fetch()`（以及 XHR）**不受影响** —— `fetch()` 缺省 `mode=cors`，按 WHATWG Fetch 的
> "append a request Origin header" 算法**无条件**写真实源（实测 `no-referrer` 下同源 fetch 的
> `Origin` 仍是 `http://127.0.0.1:<port>`，而同一页面的表单 POST 是 `null`）。
> 本文档早前把 `fetch` 一并列入，属**过度声称**，已按实测收窄；
> 证据见 `temp/wasm-verify-indep/probe-micro-referrer.mjs` 的输出表。

## 5. 决策与改动

### 5.1 策略：`same-origin`（唯一改动点）

| 文件 | 位置 | 改动 |
|---|---|---|
| `server/internal/wasmapp/session/pages.go` | `mainPageReferrerPolicy` 常量（新） | `no-referrer` → `same-origin`，两个模板的 `<meta name="referrer">` 与 `writePage` 的响应头都引用**同一个常量** |
| `server/internal/wasmapp/edge/hostgate.go` | `HostReferrerPolicy` 常量（新） | `ApplyHostSecurityHeaders` 写 `same-origin` |

**为什么是 `same-origin` 而不是 `strict-origin-when-cross-origin`**：两者对本平台都可用，
但 `strict-origin-when-cross-origin` 在 HTTPS→HTTP 降级时会把 `Origin` 也写成 `null`
（同一类故障的降级版本），而本平台这两个端点本来就 fail-closed 要求 https；
`same-origin` 语义最窄、最贴合"只在同源发 Referer"的原有意图。

**为什么不用"改判定、放行 `null`"**：`Origin: null` 同样出现在 sandboxed iframe、
`data:` 文档、跨源重定向等**真实跨源**场景 —— 放行它等于把跨源写防护（CSRF）整个拆掉。
策略必须由**我们自己的页面**修正，而不是放宽服务端判据。

**为什么不动门户页与管理台 SPA**（`cmd/server/main.go` 两处保持 `no-referrer`）：
门户是零脚本页面（CSP 里 `form-action 'none'`），管理台 SPA 的 CSRF 靠 token 而非
`Origin`；两处都没有同源表单 POST，改动只会扩大爆炸半径。
⚠️ 但这是**有条件的**：若日后给 `/api/server/admin/*` 加 `Origin` 校验，必须先把管理台
这两处策略一起改掉，否则会踩同一个坑（见 §7）。

### 5.2 来源校验失败页：仍然显示表单

| 端点 | 旧行为 | 新行为 |
|---|---|---|
| `LoginSubmit` 来源校验失败 | `ShowForm=false` + `ErrForbidden` | **`ShowForm=true`** + 专用文案 `ErrOriginRejected`（带可操作指引） |
| `TicketSubmit` 来源校验失败 | `ShowForm=false` + `ErrForbidden` | **`ShowForm=true`** + `next` 指回换票端点（登录后自动把换票走完） |

来源校验失败可能是**瞬态**的（隐私扩展、代理改写、扩展注入的 iframe），表单本身没有安全
价值 —— 它 POST 回 `/login` 时会再走一次同样的校验。文案新增 `ErrOriginRejected`
（中英都给；`pageCopy` 的每个字段在 zh/en 两份都必须非空，由反射断言逐字段钉死）。
`ErrForbidden` 保留给"审计员账号 / 账号禁用"这条**不可重试**的分支。

一致性由一处实现保证：`ticketLoginNext(appID, next)` 同时供未登录 302 与失败页的
`next` 使用（两处各写一遍会出现"302 能回到换票、表单重试却回到首页"的分叉）。

### 5.3 诊断日志（低频、无敏感值）

- `session.checkMainOrigin`：每次拒绝一条 `logError`，字段
  `reason`（`no_expected_origin` / `main_origin_config_mismatch` / `origin_malformed` /
  `origin_unparsable` / `origin_mismatch` / `origin_and_referer_missing` / `referer_mismatch`）
  + `want` + `host` + `origin` + `referer` + `x-forwarded-proto` + 人读 detail。
- `edge.CheckOrigin`：同款（判据名拆在 `checkOriginReason` 里，判定语义与拆之前逐条相同），
  **每个被拒的写请求一条**（低频，不打请求体），并导出 `edge.OriginDiagFields`
  给 session 复用（同一份日志口径，两处各写一遍必然漂移）。
- 两处都**不打 Cookie**：测试里用哨兵值断言日志里不出现会话明文，也不出现 `cookie` 字样。

## 6. 验证方式

### 6.1 Go 门禁（可复跑）

```bash
cd server
go build ./... && go vet ./internal/wasmapp/...
gofmt -l internal/wasmapp cmd/server          # 必须为空
PG_DSN_TEST='postgres://postgres:postgres@127.0.0.1:5432/picoaide_test' \
  go test ./internal/wasmapp/session/... ./internal/wasmapp/edge/... \
          ./internal/wasmapp/appserver/... ./cmd/server/... -count=1
```

### 6.2 行为回归（比字符串断言硬）

`session.TestLoginSubmitOriginMatrix` 直接喂**浏览器在不同策略下真实会发的头**打
`POST /login`：

| 请求头 | 期望 | 含义 |
|---|---|---|
| `Origin: https://harness.example.com` | 303（通行 + 下发 Cookie） | `same-origin` 策略下的真实形态 |
| `Origin: null` | 403（不下发 Cookie、不落库、**页面仍可重试**） | `no-referrer` 策略下的形态 |
| `Origin: https://evil.example.com` | 403 | 安全语义不得为了"让登录能用"而放宽 |
| `Origin: null` + 同源 `Referer` | 403 | **present 的 `Origin` 不得用 Referer 兜底** |
| 无 `Origin` + 同源 `Referer` | 303 | 老浏览器兜底路径仍在 |
| 无 `Origin` + 跨源/缺失 `Referer` | 403 | 两者都缺 ⇒ 拒 |

配套：`TestPageReferrerPolicyIsSameOrigin`（两个页面的 meta + 响应头都必须 `same-origin`，
且断言"不是 `no-referrer`"）、`TestTicketSubmitOriginFailureKeepsLoginForm`、
`TestCheckMainOriginLogsRejectionContext`（日志字段 + 无 Cookie 哨兵）、
`TestPageCopyCoversBothLanguages`（zh/en 键集合逐一非空），
`edge.TestSecurityHeadersIncludeFrameAncestors`、`edge.TestCheckOriginLogsRejectionContext`、
`appserver.TestServe_CrossOriginWriteRejected`（新增 `Origin: null` 必拒）、
`cmd/server` 的安全头用例。

**变异验证**：把 `mainPageReferrerPolicy` / `HostReferrerPolicy` 改回 `no-referrer`
⇒ 策略类用例必红；把"`Origin: null` 也放行"写进判定 ⇒ 矩阵与 appserver 用例必红。

### 6.3 浏览器自证（改后真实页面字节）

一次性导出真实渲染字节（探针文件不随交付物提交）：

```bash
PICOAI_PROBE_DIR=temp/wasm-probe/pages-dump \
  go test ./internal/wasmapp/session/ -run ZZDump -count=1
node temp/wasm-probe/verify-same-origin.mjs temp/wasm-probe/pages-dump
```

探针把 `pages.go` 渲染出的**逐字节登录页**（含真实表单结构）与 `writePage` 的**真实响应头**
放进本地 HTTP 服务，用真实 Chromium 填表提交：同一份字节在 `same-origin` 下 POST 带真实
`Origin`，改回 `no-referrer` 则带 `null`（探针自带"这份字节必须真是登录页"的前置断言，防假绿）。

### 6.4 curl 判据（线上/测试环境可复跑）

```bash
# 策略（必须 same-origin）
curl -sSk -D - -o /dev/null https://harness.example.com/login | grep -i referrer-policy

# 改后的正例：带真实源的 POST 不再 403（认证失败是 401，属预期）
curl -sSk -o /dev/null -w '%{http_code}\n' -X POST https://harness.example.com/login \
  -H 'Origin: https://harness.example.com' \
  -H 'Content-Type: application/x-www-form-urlencoded' --data 'username=x&password=y'

# 安全语义未退化（负例仍 403）
curl -sSk -o /dev/null -w '%{http_code}\n' -X POST https://harness.example.com/login \
  -H 'Origin: null' -H 'Content-Type: application/x-www-form-urlencoded' --data 'username=x&password=y'
curl -sSk -o /dev/null -w '%{http_code}\n' -X POST https://harness.example.com/login \
  -H 'Origin: https://evil.example.com' -H 'Content-Type: application/x-www-form-urlencoded' --data 'username=x&password=y'
```

## 7. 未做与残留风险

- **门户页与管理台 SPA 仍是 `no-referrer`**（有意保留）。管理台若加 `Origin` 校验即踩坑；
  门户若要加同源表单也一样。这条已写进设计文档 §4.8.1 的"不在本次范围"。
- **应用作者自己写 `<meta name="referrer" content="no-referrer">`** 会覆盖宿主响应头，
  再次触发同一故障。宿主无法从响应头层面阻止（meta 优先），只能靠文档/审计提示；
  应用模板与 `app-builder` 技能不应教作者写 referrer meta。
- **其它宿主 HTML 面**（预认证登录页 `LOGIN_HTML`、内置浏览器注入页）走 Electron
  `dsh-app://` / 自建协议，不发 `Origin`，不受本策略影响；但若日后把这些页面搬到 http(s)
  且加 `Origin` 校验，需要重新过一遍这条口径。
- 诊断日志只写"被拒"路径：低频（每个被拒写请求一条），但**恶意构造的跨源写会刷日志**
  （每条一行、无速率限制）。当前接受：它只在 403 时产生，且比"静默失败"更可用。
- 本次未做端到端真机复验（测试环境部署 + 真实域名 Chrome 走完整链路）——
  需要重新构建镜像并升级测试环境，留给主控/发版流程。

## 8. 经验（别再踩）

1. **`no-referrer` 与"同源表单 POST"天生不兼容**：任何"页面自己 POST 回自己、服务端用
   `Origin` 判 CSRF"的设计，都必须用 `same-origin`（或更宽的带源策略）。
2. **meta 与响应头两处都要改**：文档级 referrer 策略取"最后生效的那个"，只改一处等于没改。
3. **测试曾经把错误行为钉死**：`login_test.go` / `hostgate_test.go` / `wasm_test.go`
   原先断言 `Referrer-Policy == "no-referrer"`（门禁全绿 ≠ 功能正确）。现在的断言明确写成
   "必须是 `same-origin`，绝不能是 `no-referrer`"并附根因，防止有人"为了更严"改回去。
4. **`Origin: null` 绝不能靠 `Referer` 兜底**：`null` 是**存在**的 `Origin`，一旦回落到
   Referer，沙箱 iframe / 跨源重定向就能借 `Referer` 绕过 —— 判定必须保持
   "present 即必须匹配"。
5. **静默的安全拒绝是运维事故**：拒绝路径必须留下"期望值 + 实际值 + 判据名"，否则
   下一次同样的 P0 还是要靠用户投诉定位。

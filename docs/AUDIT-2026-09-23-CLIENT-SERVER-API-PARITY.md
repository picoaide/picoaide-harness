# 客户端 ↔ 服务端 API 一一对应审计（2026-09-23）

> 对象：`server/` 的生产路由表（运行时导出）↔ 桌面客户端（`packages/host/*`、`packages/client/*`）
> 与 webadmin（`server/webadmin`）的**全部出站调用点**。
> 基线：`master` @ `ce2139171b`（工作树另有并发会话改动，本次只读，未改任何产品代码）。
> 方法：服务端路由由 `registerProductionRoutes` 运行时导出（非静态抄表）；客户端调用点由
> 脚本抽取 + 逐条人工核对动态拼接；结论全部可复跑（§1）。

---

## 0. 结论（先看这三条）

1. **客户端 → 服务端：零缺失。** 170 处产品代码里的服务端路径字面量 + 36 条动态构造端点，
   **没有一条打到服务端不存在的路由**（`MISS = 0`）。13 处"只写前缀、运行时再拼"的调用
   逐条核对后也都落在真实路由上（§4.1）。
2. **服务端 → 客户端：14 条路由没有任何第一方调用方**（"孤儿端点"）。其中 12 条在管理面
   （webadmin 无 UI 入口）、2 条在员工面。**都不影响功能**（不会被调用 = 不会 404），
   但它们是"契约面比产品面大"的净增量：要么补 UI，要么承认是给第三方/运维的 API 面（§4.2）。
3. **字段级抽查发现 1 处死字段**：客户端 `BootstrapConfig.mcp`（**必填**）服务端从不下发
   （服务端发的是 `connectors`），且全仓无消费方。其余抽查的契约（usage / channel /
   bootstrap / capabilities base_path）**逐字段对齐**（§5）。

---

## 1. 方法与可复跑证据

| 步骤 | 做法 | 复跑命令 |
| --- | --- | --- |
| 服务端路由表 | `git archive HEAD server` 导出干净副本 → 临时 Go 测试调 `registerProductionRoutes`（生产装配真源）导出 `r.Routes()` | `temp/rs-api-audit/server-clean/`；`go test ./cmd/server -run TestZZDumpProductionRoutes`（`ROUTES_DUMP_OUT` 指输出） |
| 客户端调用点 | 扫描 `packages/host/*/src`、`packages/client/*/src`、`server/webadmin/src` 的路径字面量（含模板串中段、`${ADMIN_API}`/`${CLIENT_API}` 常量展开），并标注 test/comment | `node temp/rs-api-audit/extract-client-paths.mjs` |
| 精确对拍 | 段级匹配 + **结尾锚定**（避免 `/skills/:name` 误命中 `/skills/X/archive`）+ 参数段字符集收紧（避免 `${...}` 部分匹配） | `node temp/rs-api-audit/exact-match.mjs` |
| 反向覆盖 | 以路由为索引在客户端源码里找调用方；对"源码里不是连续字面量"的动态构造面（capability-endpoints / opens-contract / wasm 本机代理白名单）**求值后**并入 | `node temp/rs-api-audit/coverage-by-route.mjs`（`ce-mod.ts` 由真实模块改写 import 后 `import()` 求值） |
| 现存守卫 | webadmin 侧已有两份对拍 spec（读服务端源码） | `npx vitest run src/lib/capability-endpoints.spec.ts src/pages/app-center/opens-contract-parity.spec.ts` → **18 passed** |

取证目录：`temp/rs-api-audit/`（gitignored），产物 `routes.json`、`client-paths.json`、
`coverage-by-route.json`、`exact-match.json`、`ce-endpoints.json`。

---

## 2. 服务端路由面：233 条（运行时导出）

| 命名空间 | 条数 | 说明 |
| --- | --- | --- |
| `/api/server/admin/*` | 154 | 管理面（webadmin / 运维 / 审计；会话 + CSRF + RBAC） |
| `/api/client/v2/*` | 55 | 员工面（桌面客户端 Bearer） |
| `/v1/*` | 10 | LLM 网关（OpenAI/Anthropic 兼容 + Files API） |
| 根级网关别名（无 `/v1`） | 10 | 与上一行同 handler 的官方原生形态（`/chat/completions` 等） |
| `GET /healthz`、`GET /readyz` | 2 | 探针 |
| `GET|HEAD /updates/client/*file` | 2 | 客户端安装包下载（`ServeFile`，文件语义） |

> 静态抄表容易漏掉条件注册路由（`registerWasm` 在 `Wasm == nil` 时整片不挂）与
> 静态段/参数段的 gin 优先级，所以本审计**不采信源码 grep 结果**，一律以运行时
> `r.Routes()` 为准。

---

## 3. 客户端调用面

三个消费方（全部纳入扫描）：

1. **桌面客户端 host 侧**：`packages/host/{enterprise,desktop,connectors,wasm-apps-host,cron,browser}`
   —— 企业插件持员工 bearer 调 `/api/client/v2/*`；`llm-deepseek` 适配器按
   `baseURL = <server>/v1` 调网关。
2. **桌面客户端 UI 侧**：`packages/host/enterprise/src/client/*`、`packages/client/*`
   —— 只打**本机** `/api/pico/*`（由 host 注册的 loopback 路由），再由 host 代理到服务端。
   本审计只关心其中"代理到服务端"的那一跳，并已逐条核对。
3. **webadmin**：`server/webadmin/src` —— 打 `/api/server/admin/*` 与公开的
   `/api/client/v2/channel`。

动态构造面（源码里查不到连续字面量，已求值/读码确认）：

- `server/webadmin/src/lib/capability-endpoints.ts`（技能/智能体 × 市场/组织 × 11~12 个动作）
  → 求值得 **36 条**有效端点（其余 7 条按设计为 `null`：组织库没有 新建/改元数据/传新版/规范化）。
- `server/webadmin/src/pages/app-center/opens-contract.ts` → 3 条。
- `packages/host/enterprise/src/wasm-apps.ts` 的本机代理白名单（`/api/pico/apps/wasm/*`
  → 服务端 `/api/client/v2/apps/wasm/*`）→ 17 条。
- 行内 `base_path` / `preview_path` / `grants_base`（服务端下发，见 `internal/capabilities`）
  → 审批页的 approve / reject / quality / 删除 / 授权 / 预览。

---

## 4. 对拍结果

### 4.1 客户端 → 服务端：0 缺失

- 170 条路径字面量按**精确段数**对拍：`exact = 157`、`prefix = 13`、**`miss = 0`**。
- 13 条 prefix 逐条核对（拼接后缀均存在）：

| 调用点 | 运行时拼出的路径 | 服务端 |
| --- | --- | --- |
| `auth-gate.ts:579` `'/api/client/v2/auth/' + name + '/login?server='` | `/auth/{oidc,openid}/login` | ✅ 两条都在（`router.go` 的 for 循环注册） |
| `bootstrap.ts:102`、`gateway-model.ts:45` `baseURL = <server>/v1` | `/v1/{chat/completions,messages,responses,embeddings,completions,models,files,models}` | ✅ 全部存在（上游 `llm-deepseek` 适配器拼路径） |
| `wasm-apps.ts:1062/1496/1531/1570/1773`、`app-protocol.ts:66`、`open-gate.ts:30` | `/apps/wasm/{app_id}/{releases,schema,diagnostics,rows,request,open}` 等 | ✅ 全部存在（`registerWasm`） |
| `transfer-owner-dialog.tsx:102` | `/apps/{kind}/{name}/owner` | ✅ |
| `Users.tsx:243` | `/tokens/{id}/revoke` | ✅ |

- 反向也查了：**没有**"客户端调用了旧命名空间"（`/api/admin/*`、`/api/marketplace/*`、
  `/v2/api/*`）的残留；webadmin 的路径一律经 `lib/api-paths.ts` 常量。

### 4.2 服务端 → 客户端：14 条孤儿端点

**A. 管理面（webadmin 无任何调用方）— 12 条**

| 路由 | 现状判据 |
| --- | --- |
| `GET /api/server/admin/portal`、`PUT …/portal` | webadmin 里 `portal` 只命中 Radix `PopoverPrimitive.Portal` 等 UI Portal；导航表（`lib/nav.ts`）无门户页 ⇒ 门户配置**只能靠 curl** |
| `GET /api/server/admin/auth/methods` | webadmin 登录页只打 `/login`、`/login/mfa`；`auth/methods` 只有员工面同一 handler 被客户端用（`/api/client/v2/auth/methods`） |
| `GET /api/server/admin/users/:id/groups` | Users.tsx 用 `PUT /users/:id/department`，从不读该用户的组列表 |
| `POST /api/server/admin/providers/:id/sync` | Gateway.tsx 只有 `providers/sync-all`，无单渠道同步按钮 |
| `GET …/agent-presets/:name/preview`、`GET …/:name/archive` | 组织智能体的预览/归档，UI 一律走**版本级**（`capability-endpoints` 的 `orgVersioned`） |
| `POST …/agent-presets/:name/approve`、`POST …/:name/reject` | 审批页用 `${row.base_path}/approve|reject`，而 `base_path` 含版本段（`capabilities.go:791`）⇒ 非版本级这两条不可达 |
| `DELETE …/agent-presets/:name` | 删除同样用 `base_path`（含版本段）⇒ 非版本级不可达 |
| `GET …/wasm-apps/:app_id/rows`、`GET …/:app_id/schema` | webadmin 应用中心只调 `/:app_id/diagnostics`；`/rows`、`/schema` 无 UI 入口（管理员只能靠 curl/API） |

**B. 员工面（桌面客户端无调用方）— 2 条**

| 路由 | 现状判据 |
| --- | --- |
| `GET /api/client/v2/agent-presets/:name/:version/archive` | 客户端只拼**非版本级** `/agent-presets/{name}/archive`（`auth-gate.ts:2181/2254`），版本号取自响应头 `x-preset-version` |
| `GET /api/client/v2/marketplace/skills/:name` | 客户端只用 `/marketplace/skills`（列表）与 `/marketplace/skills/{name}/archive`（下载），从不取单个技能详情（详情走 `/api/client/v2/capabilities`） |

**判定**：这 14 条**不是缺陷**（无调用方 = 不会被误用），但它们是"接口面 > 产品面"的净增量，
必须在两者之间做一次显式选择：补 UI 入口、或标注为 API-only（第三方/运维契约）、或下线。

### 4.3 非客户端消费面（预期，不算孤儿）

- `/v1/*` 10 条 + 根级网关别名 10 条：由上游 `llm-deepseek` 适配器按 `baseURL` 拼接调用
  （`files-api.ts:277/287` 等），以及第三方 SDK 直连。
- `GET /healthz`（compose healthcheck 用）、`GET /readyz`（编排/监控探针）。
- `GET|HEAD /updates/client/*file`：下载地址来自 `/api/client/v2/updates/manifest` 的**绝对 URL**，
  客户端不会硬编码路径（正确做法）。

---

## 5. 字段级契约抽查

| 契约 | 结果 |
| --- | --- |
| `GET /api/client/v2/auth/usage` | ✅ 已有跨语言对拍：`serverauth/usage_contract_test.go` ↔ `packages/client/account-card/src/usage-contract.ts` |
| `GET /api/client/v2/channel` | ✅ 字段逐项对齐（`login.logo_url/logo_url_dark`、`client.logo_url/display_name/tagline`、`favicon_url`、`accent`）；`client.short_name` 是**客户端类型独有**（服务端不下发），由随包品牌经 `mergeChannel` 补齐 —— 有注释与测试固定，属设计 |
| `GET /api/client/v2/config/bootstrap` | ⚠️ `skills[]`、`web.error_reporting_*`、`web.default_thinking_level`、`connectors[]` 全部对齐；**`BootstrapConfig.mcp`（必填）是死字段**：服务端只发 `connectors`（`bootstrap.go:60`），全仓无 `.mcp` 消费方（`EMPTY` 里还给它填了 `[]`）。`web.glitchtip_base_url/organization` 是服务端内部用（合成连接器默认值），客户端不需要 |
| `capabilities` 下发路径（`base_path`/`preview_path`/`grants_base`） | ✅ 三段路径与 `internal/router` 声明逐字一致（`/api/server/admin/{shared-skills,agent-presets}/<name>[/<version>]`），且被两个 spec 读源码对拍 |
| `POST /api/client/v2/agent-presets` / `shared-skills`（上传） | ✅ 请求体 `{name, archive}`、响应头 `x-preset-version`/`X-Skill-*` 两端一致 |

---

## 6. 建议（按性价比排序）

1. **补两条管理端 UI 入口**（`wasm-apps/:app_id/rows|schema`）：这两条是 2026-09-21 为"管理员排障/合规"
   加的，现在只有 API 没有入口，管理员只能借员工令牌或 curl —— 与当初加它们的理由相矛盾。
2. **决定门户配置（`/portal` GET/PUT）的去留**：门户页是产品交付面（下载客户端），
   却没有任何配置入口；要么补页面，要么在 `router.go` 注释里显式登记为 API-only。
3. **清理客户端 `BootstrapConfig.mcp`**：删字段 + 从 `EMPTY` 移除（纯死代码，改完 `tsc` 即可验证）。
4. **非版本级组织智能体 5 条**（`preview/archive/approve/reject/DELETE :name`）：
   与版本级并存但无人调用，建议按"API-only"登记或直接下线，避免下一个人误用非版本级路径。
5. **把本次流程落成常驻守卫**（当前只有 webadmin 的两份 spec）：
   在 `yarn check` 里加一条"客户端调用路径必须命中服务端路由"的静态对拍
   （服务端侧可用 `go test ./cmd/server` 导出路由表为 fixture），把"客户端拼错路径"变成 CI 红灯 ——
   本仓历史上已经踩过两次同类（2026-08-30 的能力中心旧前缀、2026-09-23 的市场/组织命名空间串用）。

---

## 7. 本次审计未覆盖（认账）

- **合同运行时行为**（状态码、幂等、错误码语义）不在本次范围：本次只做"存在性 + 方法 + 字段名"层面的对应。
- `packages/vendor/memory-evolve`、`packages/host/browser|cron` 的**本机**路由（`/api/memory/*`、
  `/api/pico/browser/*`、`/api/cron/*`）属客户端进程内 API，不参与"客户端 ↔ 服务端"对拍。
- Electron 内嵌的 `deepseek-harness` 子模块只扫了 `llm-deepseek` 的网关路径构造，
  其余上游出站调用未纳入。

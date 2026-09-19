> ⚠️ **阅读须知**：本文件是**删除施工的指令书**。文中出现的旧机制（应用子域 / 换票 / `/app-ticket` /
> 基域配置 / `entry_url` / 服务端 `ai.chat` / 匿名面）**一律是待删除对象**，出现在删除清单、改造前
> 现状快照或验收断言里，**不是要实现的形态**；任何「把它做回来」的读法都是误读。

# 实施任务书：WASM 应用「客户端专属（自定义协议）」改造（2026-09-19）

> **权威顺序**：`docs/planning/2026-09-19-wasm-client-only-design.md`（**设计总纲，权威**）**>**
> `docs/decisions/2026-09-19-wasm-client-internal-origin.md`（早期契约/推导）**>** 本任务书 **>** 代码现状。
> 三者冲突时**停下并报告**，不要各自解释、不要"照代码改文档"。
>
> 本文件同时是**多子代理并行施工的分工与验收依据**：每个子代理只做自己那一格，改文件不得越出白名单。
> （设计总纲落地后，本文件的波次与附录保留为分工与判据来源；与总纲冲突处按总纲执行。）

## 1. 完成定义（DoD）

1. 应用只在桌面客户端内可访问：**独立应用窗口**加载 `<渠道 app 源 scheme>://<app_id>/`（**W-C 裁决**，总纲 §16.1；**不是**内置浏览器标签，也不是硬编码 `picoaide-app`），由新包的协议 handler 转发到平台执行。
2. 服务端**只有** `POST /api/client/v2/apps/wasm/:app_id/request` 一条应用请求入口（`BearerAuth` 必需），无匿名面。
3. 浏览器换票链路**彻底删除**：`session/**`、`/login`、`/app-ticket`、基域配置面、`app_sessions`/`employee_sessions` 两张表（迁移 DROP）、`anonlimit`。⚠️ **`edge/**` 不整包删除**（总纲 §8.4/本文件 E.2）：它同时装着"主机名门控（删）"与"HTTP 面原语（保留）"。另：服务端 `ai.chat` 宿主能力随 §21 一并删除。
4. `entry_url` 字段从服务端目录/发布响应、webadmin、客户端 UI 中**全部消失**；可分享形态 = 深链 `<scheme>://app/<app_id>`。
5. 三项部署前置（通配域名 / 通配证书 / Caddy 通配站点块）在仓库内**零残留**（`git grep` 断言）。
6. **打开校验与计数（F16）**：`POST /api/client/v2/apps/wasm/:app_id/open` + `X-PicoAide-App-Version` 响应头 + 每次打开计一次（PV，不去重）+ 迁移 0075（计数）/0076（usage 应用维度）。
7. **客户端持有性证明（A′，§23.1）**：`request` 与 `open` **两个端点都**要求 `X-Pico-App-Proof`（Ed25519 安装密钥签发，绑 `(user_id, bearer hash, install_id, serverURL, app_id, exp, jti)`）。
8. **应用 AI（§21）**：服务端 `ai.chat` 彻底删除；应用改由客户端 AI loop 经保留路径 `POST /__picoaide/ai/chat` 提供（仅对话、per-app 隐藏会话、SSE）。
9. **零端口迁移就绪（§22.2 R1–R4）**：本机 API 只冻结路径与语义（单 seam）、授权用请求头持有性令牌（无 Cookie/Host/Origin/端口）、应用侧不触本机服务、**浏览器面不得导航到 app scheme**。
10. 门禁全绿：`yarn check`、`cd server && make check`（含真 PG）、客户端各包单测、真机协议探针、`scripts/verify-wasm-client-only.sh`。

## 2. 现状与草稿处置（**子代理必读**）

工作区已有**未提交的 W1 草稿**（loopback 方案，已被契约取代）：

| 文件 | 处置 |
| --- | --- |
| `server/internal/wasmapp/appserver/serve.go`（拆出 `serveApp` + `identity` 注入） | **保留并沿用**（结构正确，与载体无关） |
| `server/internal/wasmapp/appserver/client.go`（`ServeClientRequest` + 身份投影） | **保留**；投影字段与旧路径一致的要求不变 |
| `server/internal/wasmapp/api/clientreq.go`（信封/合成请求/响应编码） | **保留骨架，必须改**：Host 判据改成 `picoaide-app://<app_id>`；删匿名入口；`Set-Cookie` 改整体丢弃；Origin 由 handler 补 |
| `server/internal/wasmapp/api/handlers.go`、`internal/router/router.go`、`cmd/server/wasmapp.go` | **保留接线**，删 `AnonRequest` 与 `/anon-request` 路由 |
| `server/internal/wasmapp/appserver/client_test.go`（7 例，**未跑过**） | 改写 Host/匿名相关断言后跑通 |

其它已知事实（不要再调研一遍）：
- 宿主跑在 Electron 主进程内（`packages/host/desktop/src/main.ts:329` `boot(...)` → `current = ctx`），因此协议 handler 与 `protocol.registerSchemesAsPrivileged` 都在主进程可用；数据/令牌在 `ctx.picoSession`。
- 内置浏览器 guard 目前只放行 `http/https/about`（`packages/host/browser/src/guard.ts:70`），分区按**用户**（`pool.ts:8`、`runtime.ts:672 setPartition`）。
- 协议实测结论见契约 §3（含"无 Origin、无 Cookie、CSP 逐字放行、分区注册生效、跨应用与跨 UI 均被拦"）。

## 3. 子代理分工

> ⚠️ **本节的分工表已被取代（2026-09-19 主控）**：**唯一权威波次表 = 总纲 §16**；**唯一闭环凭据 = `docs/planning/2026-09-19-wasm-client-only-findings-ledger.md`**（含泳道 L1–L7 的文件边界与逐条 finding 状态）。本节的 D/C/V 编号只作**历史留痕**（当年按"文档波 → 代码波 → 复验波"分工，末轮又追加了 D5/C6 与 **L7 删除波次**）。施工时按下表读，不要按本节的编号理解范围：
>
> | 泳道 | 范围（互不重叠） | 对应总纲波次 |
> | --- | --- | --- |
> | L1 | `server/internal/**`、`server/cmd/**` | W1 |
> | L2 | `packages/host/**`（含 `browser`） | W2/W3 |
> | L3 | `packages/client/**` | W2/W3 |
> | L4 | `scripts/**`、`package.json`、`.github/workflows/**` | W0-D/W6 |
> | L5 | `docs/**`（除三份权威文档）、`site/**`、`README*`、`server/skills/**`（仅文档） | W5/W7 |
> | L6 | `server/webadmin/**` | W5 |
> | L7 | 删除面（§8.4 + §9 的 0073/0074 + `ai.chat` 整包） | **W4** |

### 第一波：文档同步（可并行；C1/C3 可与本波并行——它们只读契约与本任务书，见 §6）

| 编号 | 范围（白名单） | 必须产出 | 判据 |
| --- | --- | --- | --- |
| **D1** | `docs/planning/2026-09-17-wasm-app-platform.md` | 就地勘误：访问模型（R12/R16/R29）、§4.7 换票、§4.8 host 门控与子域路由、§6.1 请求链路、§8 端点全表、§10 验证矩阵、§14/§15 的浏览器链路条目；每条标注"2026-09-19 被客户端协议模型取代"并指向契约 | `git grep -n 'app-ticket\|换票' docs/planning/2026-09-17-wasm-app-platform.md` 的每一处要么已标注、要么带"仅历史"标记 |
| **D2** | `docs/wasm-app-authoring.md`、`server/skills/app-builder/**` | 访问方式（客户端内、`picoaide-app://`）、**无 cookie**、**无 entry_url**、无浏览器地址；示例与提示语同步 | 全文不再出现"浏览器打开/应用基域/通配证书/entry_url"；`server/skills/app-builder` 的 README/参考与文档口径一致 |
| **D3** | `docs/deploy/AI-DEPLOY.md`、`server/.env.example`、`server/docker-compose.yml`、`server/Caddyfile*`（示例）、`server/docs/DEPLOY.md` | 删除通配域名/通配证书/Caddy 通配站点块三项前置；补"应用不再需要任何公网应用 origin" | `git grep -nE 'PICOAI_APPS_BASE_DOMAIN\|通配证书\|wildcard' server docs/deploy` 零残留（历史决策文档除外，且必须标注"已废除"） |
| **D4** | `docs/releases/TEMPLATE.md` + 当前版本说明（`docs/releases/v2.7.6-beta.5.md` 或更新者） | 升级必读：**服务端与客户端必须同版本升级**（旧客户端删除换票后无法打开应用）；访问模型与已知限制（无 cookie/仅客户端） | 发布说明含"必须同版本升级"与"浏览器不再可用"两段；模板含同样的小节 |

### 第二波：代码（依赖关系见 §6）

| 编号 | 范围（白名单） | 必须产出 | 判据 |
| --- | --- | --- | --- |
| **C1** | `server/internal/wasmapp/api/**`（clientreq 等）、`server/internal/wasmapp/appserver/**`、`server/internal/router/router.go`、`server/cmd/server/wasmapp.go` | 契约 §4.1–4.4 全部落地：端点、信封、Origin 自源判据、身份投影、401、`access` 写侧收敛（读侧 `public`→`login`）、删匿名入口 | `PG_DSN_TEST=… go test ./internal/wasmapp/... ./internal/router/...` 全绿；新增/改写用例覆盖：无 bearer 401、跨源写 403、Host 非 `<app_id>` 400、`public` 写侧拒、身份投影对拍、信封体积两档 |
| **C2** | `server/internal/wasmapp/session/**`、`edge/**`、`anonlimit/**`、`server/internal/router/**`、`server/internal/wasmapp/api/{admin,handlers,read,publish}.go`（仅 `entry_url`/基域相关）、`server/internal/wasmapp/limits/**`（仅删除相关常量与 spec）、`server/internal/serverstore/migrations-pg/**`（新迁移） | 契约 §5 删除清单（含 `app_sessions`/`employee_sessions` DROP、基域设置项、`entry_url`、`appOrigin`）；`appcfg` 写侧不再接受 `public` | `git grep -nE 'app-ticket\|/login\|WasmSession\|apps_base_domain\|entry_url' server --  ':!*_test.go'` 零业务残留；`make check` 全绿 |
| **C3** | 新包目录 `packages/host/wasm-apps-host/**`（新建）、`packages/host/desktop/src/**`（仅装配与适配器注入）、根 `package.json`/`scripts/check-workspaces.mjs`/`scripts/verify-layout.mjs`（登记新包） | 协议注册（默认 session + 分区）、handler（取 `ctx.picoSession` → 补 Origin → 调 request 端点 → 还原 Response，丢 Set-Cookie）、深链 `<scheme>://app/<app_id>` 解析、本机路由供"打开"使用、错误呈现（无登录/应用不存在/无权限） | 新包 `yarn workspace <pkg> check` 全绿；真机探针（真服务端 + 真 wasm）通过 |
| **C4** | `packages/host/browser/src/guard.ts`（**撤销**对 app scheme 的放行，见下方勘误）、`packages/client/wasm-apps/src/client/**`、`packages/host/enterprise/src/wasm-apps.ts`（仅"打开"与目录字段相关） | 内置浏览器允许应用协议（且仅应用协议这一个新增 scheme）；应用中心"打开"走本机路由；删除"入口链接"列与文案；分享 = 深链；凭据填充在应用协议下如实降级 | 客户端各包单测全绿；`open-app.ts` 不再有 http(s) 入口与系统浏览器兜底路径 |

> ⚠️ **C4 条目勘误（2026-09-19，R2 安全复验 P0-2）**：上面"内置浏览器允许应用协议"的表述**作废** ——
> 内置浏览器标签**不得**导航或弹窗到 `<app-scheme>:`（否则任意 http(s) 页面都能发起带身份的导航型请求）。
> 正确口径 = 设计总纲 §20.2 + §22.2 R4：**只有应用窗口**可以；`guard.ts` 的白名单只对应用窗口生效，
> 浏览器标签侧要挂 `will-navigate`/`window.open` 拒绝并记审计。
| **C5** | `server/webadmin/src/**`（仅 wasm 应用中心/应用平台页） | 删除"入口链接"列与展示；访问级别枚举同步（`public` 不再出现） | `npm test`（webadmin）全绿；页面不再渲染入口链接 |

### 第三波：独立复验（不看实施过程）

| 编号 | 范围 | 要求 |
| --- | --- | --- |
| **V1** | 只读复核 C1–C5 | 按契约逐条对拍（§4.1–4.5、§5、§6 判据），对**关键闸门做变异验证**（摘掉判据必须变红）；产出 `temp/wasm-client-verify/REPORT.md`：逐条 PASS/FAIL + 复现命令 + 未闭环项 |

## 4. 全局纪律（违反即返工）

1. **不越界**：只改白名单内文件；不改 `deepseek-harness/`（只读上游）；不改 `patches/` 与 `resolutions`（本次不涉及上游补丁）。
2. **不动 git**：禁止 `git checkout/stash/reset/clean/commit/切分支`（工作目录可能被其它会话并发编辑）；提交由主控统一执行。
3. **域名纪律**：不写任何真实客户域名/主机名（用 `harness.example.com` 等占位符）。
4. **文档先行**：D1–D4 完成前不得开始 C1–C5；代码与契约冲突时停下报告。
5. **不复制逻辑**：`serveApp` 是唯一应用请求管线；协议 handler 只做传输与身份注入，不得在客户端重实现准入/静态/执行。
6. **删就得删干净**：删除项必须同时删测试、注释、文档引用与 CI 断言；用 `git grep` 断言零残留。

## 5. 统一验证命令

```bash
# 服务端（本机 GOCACHE/GOMODCACHE 必须落在工作区；/root/.cache 只读）
cd server
export GOCACHE=/data/picoaide-harness/temp/go-build GOMODCACHE=/data/picoaide-harness/temp/gomodcache GOPROXY=off
go build ./... && go vet ./internal/wasmapp/... ./internal/router/...
PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/picoaide_test go test ./internal/wasmapp/... ./internal/router/... -count=1
make check            # gofmt + vet + 全量测试 + webadmin 构建（发布门禁）

# 客户端 / 整仓
corepack yarn check                 # 全量门禁（8 包 build+typecheck+test + 6 个 guard）
corepack yarn workspace <pkg> check # 单包

# 真机探针（自定义协议语义；改了 browser/desktop 后必须复跑）
xvfb-run -a env HOME=/tmp/<dir> XDG_CONFIG_HOME=/tmp/<dir>/.config \
  packages/host/desktop/node_modules/.bin/electron --no-sandbox \
  temp/wasm-local-origin/probe-custom-scheme.cjs
```

## 6. 依赖与并行顺序

```
D1 D2 D3 D4（并行，文档先行）
        │
        ├─→ C1（服务端核心）─┬─→ C2（服务端删除）
        │                     └─→ C5（webadmin 字段）
        └─→ C3（新包 + desktop 适配器）─→ C4（浏览器 guard + 客户端 UI）
                                              │
                          C1..C5 全部完成 ────┴─→ V1（独立复验）
```

- **C1 与 C3 可与 D1–D4 并行**：两者的设计输入**只有**契约与本任务书（不得以设计基线 / 作者文档 / 部署文档为设计输入）⇒ 文档同步不会误导它们。
- C2 必须在 C1 之后（先有替代路径再删旧路径）；C5 的字段删除与 D2/D3 的文档口径必须一致后再收尾。
- 每个子代理完成后先自证判据，再把结果交回主控；主控统一跑整仓门禁再提交。

## 7. 交付物与留痕

- 代码：C1–C5 的改动（一个 PR / 一次提交序列，提交信息 `feat(wasm): …` / `refactor(wasm): …` / `docs(wasm): …`）。
- 文档：契约 + 本任务书 + D1–D4 的同步结果。
- 证据：三份协议探针输出、V1 的 `temp/wasm-client-verify/REPORT.md`、真机端到端探针输出。
- 发布：`docs/releases/<tag>.md` 的升级必读段（同版本升级）。

## 8. 认账项（本版明确不做/暂不确定）

1. Windows / macOS 的自定义协议行为未实测（同一探针在各平台复跑；不一致则改回替代形态并更新契约）。
2. 无 cookie ⇒ 依赖 `document.cookie` 的应用退化（作者文档写明；不提供 cookie 兼容层）。
3. 应用页内的外链仍按内置浏览器 guard 的 http/https 策略处理；下载行为不在本版验证范围。
4. 旧客户端不兼容是**有意**的（一次性删除），不做降级通道。

---

## 附录 A：新包登记清单（C3 必读；**漏一项 `yarn check` 直接红**）

来源：`scripts/verify-inventories.mjs` 的四条硬检查（包表 ↔ 磁盘 ↔ prebuild ↔ CI 归档必须一一对应）+ `verify-layout.mjs` + `.gitignore` 实测枚举。

| # | 文件 | 要做的事 | 不做的后果 |
| --- | --- | --- | --- |
| 1 | `scripts/check-workspaces.mjs` | 把新包加进 `PACKAGES`（约 :72-82）**并**加进 `--changed` 的路径映射（约 :99-106） | 新包的 build/typecheck/test 永不在 CI 跑 |
| 2 | `packages/host/desktop/scripts/prebuild-workspace-deps.ts` | 加进 `WORKSPACE_PACKAGES`（`dir:` 形式；包必须有 `build` 脚本） | 打包/冒烟拿到缺失或过期的 `lib/` |
| 3 | `.github/workflows/ci.yml` | `tar -czf workspace-build.tgz …` 清单加 `packages/host/wasm-apps-host/lib`（:151-155 同族） | 三个平台 job 解压后缺该包，打包用的是旧产物 |
| 4 | `scripts/verify-layout.mjs` | 包表加 `['packages/host/wasm-apps-host', '@picoaide/dsh-wasm-apps-host']`（:54-61 同族） | 布局门禁红 |
| 5 | `.gitignore` | 加 `packages/host/wasm-apps-host/lib/`（:50-56 同族） | 构建产物被误提交 |
| 6 | `packages/host/desktop/package.json` | `dependencies` 加 `"@picoaide/dsh-wasm-apps-host": "workspace:*"` | 运行期解析不到插件 |
| 7 | `packages/host/desktop/src/profile.ts` | 新增 `WASM_APPS_HOST_PATCH_PATH`（`createRequire(...).resolve('@picoaide/dsh-wasm-apps-host/package.json')` 同族，:60-68）并入 profile patch 链 | 插件行不会被装配 |
| 8 | 新包 `cordis.patch.yml` | 照 `packages/host/browser/cordis.patch.yml` 的形态声明插件行 | 同上 |
| 9 | 许可证/声明 | 若引入新的第三方依赖 ⇒ `corepack yarn verify:notices:write` 重生成；`electron` 走 **peerDependency**（照 `packages/host/browser/src/index.ts:86` 的说明与 `electron-adapter.ts` 的 `createRealElectronAdapter` 范式，避免非 Electron 环境加载） | `verify:notices` / `verify:licenses` 红 |
| 10 | `packages/host/desktop/scripts/verify-packaged-runtime.ts` | `REQUIRED_PACKAGED_RUNTIME_ENTRIES` 补新包的随包条目（`node_modules/@picoaide/dsh-wasm-apps-host/{lib/*,package.json,cordis.patch.yml}`，照 :143-147 同族），并同步 `packages/host/desktop/tests/verify-packaged-runtime.spec.ts` 的"清单覆盖源目录"用例 | afterPack 打包门禁红 / 新包没进 asar |
| 11 | `scripts/check-workspaces.mjs` 的 `needs` | 新包保持 `needs: []`：**不要 import `@picoaide/dsh-enterprise` 类型**，`ctx.picoSession` 用本包内最小接口表达 | 构建顺序被绑死、单包 check 无法独立跑 |

**自证命令（C3 完成前必须贴输出）**：
```bash
cd /data/picoaide-harness
node scripts/verify-inventories.mjs && node scripts/verify-layout.mjs && node scripts/verify-check-workspaces.mjs
corepack yarn workspace @picoaide/dsh-wasm-apps-host check
```

**Electron 获取方式（冻结）**：新包 `peerDependencies: { electron: "*" }`，在 `src/electron-adapter.ts` 里 `import { protocol, session } from 'electron'`，并提供 `createRealElectronAdapter()`；插件主体只依赖适配器接口（可单测）。协议注册（`registerSchemesAsPrivileged`）必须在 `app.whenReady()` **之前**执行 ⇒ 由 desktop 壳在 boot 前调用新包导出的注册函数（这一条与 browser 包不同，必须在装配层接线，写进 C3 的产出说明）。

---

## 附录 B：C4 接触面（内置浏览器 + 客户端；**这些点必须逐条覆盖**）

| # | 位置 | 要做的事 |
| --- | --- | --- |
| 1 | `packages/host/browser/src/guard.ts:70` `ALLOWED_SCHEMES` | 增加 `picoaide-app:`（**唯一**新增 scheme）。不要放开 `file:`/`data:`/`javascript:` |
| 2 | `guard.ts:83-105` `classifyNavigation` / `navigationDenyReason` | 拒绝文案要覆盖新 scheme 的存在（现在写死 "http/https only"，会把应用页误诊成"平台不支持"）；allow/deny 判据本身不变 |
| 3 | `packages/host/browser/src/credential-site.ts:74` | 只认 http/https origin ⇒ 应用协议下**自动填充不适用**：如实降级（不报错、不把应用页当可填充站点）；`credentials_list` 等同族工具面同步 |
| 4 | `packages/host/browser/src/shell-pages.ts:363,399` | 查看器资源白名单与地址栏 `secure` 指示：应用协议下地址栏显示 `picoaide-app://<app_id>`，安全指示按"安全上下文"语义处理（不得显示成明文 http） |
| 5 | `packages/client/wasm-apps/src/client/open-app.ts` | 整段重写：不再有 http(s) `entry_url`、不再有系统浏览器兜底；改为调新包的本机路由打开应用（保留"可注入副作用 + 结果可断言"的测试形态） |
| 6 | `AppCenterPanel.tsx:64,264,312-321,939-943,1027-1028` | 删 `entryURL` 字段、`entryHostLabel`、`openable` 的 URL 判据与渲染行；"打开"走本机路由（失败要给出可读原因） |
| 7 | `packages/client/wasm-apps/src/client/appcfg-contract.ts:126-129` | `entry_url` 条件字段常量删除（跨端契约：服务端不再下发） |
| 8 | `packages/client/wasm-apps/src/client/app-lifecycle.ts:126,130,152` | 上下架响应不再含 `entry_url`；返回体只保留 `app_id/enabled/changed` |
| 9 | 分享文案 | 改深链 `<渠道 scheme>://app/<app_id>`；不得写死 `picoaide://`（scheme 真源 = channel.json / desktop 注入） |

## 附录 C：C5 接触面（webadmin）

| # | 位置 | 要做的事 |
| --- | --- | --- |
| 1 | `server/webadmin/src/pages/app-center/Apps.tsx:66` | `access` 类型去掉 `'public'`（或标注为历史值）；发布/审核表单不得再提供 public 选项 |
| 2 | `Apps.tsx:212-213` `accessMeta` | 历史 `public` 行仍要能渲染（不得显示原始字符串）；建议文案"登录（历史 public）" |
| 3 | `server/webadmin/src/pages/AppCenter.test.tsx:40` | 夹具里的 `access:'public'` 保留为**历史值**用例，断言新口径 |
| 4 | 入口链接列 | 页面若展示 `entry_url`/入口链接一律删除（服务端字段已取消） |

判据：`cd server/webadmin && npm test`（全部通过）。

---

## 附录 D：V1 独立复验矩阵（**只看契约与本附录，不看实施过程**）

复验纪律：逐条给 PASS/FAIL + **可复跑命令或代码位置**；**每条关键闸门做一次变异验证**（把判据改坏，确认对应用例变红，再改回）；发现"存在性断言"（只证明字段在、不证明行为）一律判 FAIL。

| # | 契约条款 | 怎么验 | 变异验证（改坏必须变红） |
| --- | --- | --- | --- |
| 1 | §4.1 唯一端点 | 路由表里应用请求只有 `POST /api/client/v2/apps/wasm/:app_id/request`；无 `anon-request`、无 `/login`、无 `/app-ticket` | 加回 anon 路由 ⇒ 路由完整性用例红 |
| 2 | §4.2 信封 Host 判据 | 非法 host（任意域名 / `*.app.localhost` / 带端口路径凭据 / 大小写混淆）逐条 400 | 把 host 判据放宽成"非空即过" ⇒ 对应用例红 |
| 3 | §4.2 体积两档 | 请求体 >1 MiB ⇒ 413；信封 >1 MiB*4/3+64 KiB ⇒ 413；响应 >8 MiB 由管线整单失败 | 去掉解码后的 1 MiB 复检 ⇒ 对应用例红 |
| 4 | §4.2 Set-Cookie | 响应信封里不含 `Set-Cookie`（整条丢弃），逐跳头与 `Content-Length` 也不在 | 恢复透传 Set-Cookie ⇒ 对应用例红 |
| 5 | §4.3 Origin 由 handler 合成 | 客户端模式：非幂等 + 缺 Origin ⇒ 403；`Origin: picoaide-app://<app_id>` ⇒ 通过；异源 Origin ⇒ 403 | 把"缺失即拒"改成"缺失即放行" ⇒ 对应用例红 |
| 6 | §4.4 一律登录 | 无 bearer ⇒ 401 `AUTH_REQUIRED`；`access=login` 未认证 ⇒ 401 且**无** Location | 让 `RequiresLogin` 在客户端模式失效 ⇒ 对应用例红 |
| 7 | §4.4 身份投影 | 客户端路径与旧 Cookie 路径（若仍在）逐字段一致；调用事件带 user_id | 投影少给 display_name/部门 ⇒ 对拍用例红 |
| 8 | §4.4 access 收敛 | 发布/校验传 `public` ⇒ 结构化拒绝；历史 `public` 应用读取按 `login`（要求登录） | 写侧接受 `public` ⇒ 对应用例红 |
| 9 | §4.5 链接 | 服务端目录/发布/上下架响应、webadmin、客户端 UI 均无 `entry_url`；分享为深链且 scheme 不写死 | 任一出口回填 `entry_url` ⇒ 契约断言红 |
| 10 | §5 删除清单 | 对 `session/`、`edge/`、`anonlimit/`、`/login`、`/app-ticket`、`PICOAI_APPS_BASE_DOMAIN`、`wasm.apps_base_domain`、两张表的新迁移（DROP）逐条 `git grep` + 文件存在性 | 恢复任一入口 ⇒ 零残留断言红 |
| 11 | §3 协议实现 | `registerSchemesAsPrivileged` 的 privileges 与契约逐字一致；默认 session 与应用分区**都**注册；`Origin` 由 handler 合成 | 去掉分区注册 ⇒ 真机探针红（分区内页面加载失败） |
| 12 | §6 门禁 | `corepack yarn check`、`cd server && make check`、新包 check、真机协议探针 | ——（记录原始输出） |
| 13 | 反作弊 | 检查是否存在"只测字段存在"的假绿断言、被跳过的用例（`t.Skip` 新增）、被放宽的既有断言 | 逐条列出 |

**报告落点**：`temp/wasm-client-verify/REPORT.md`（逐条 PASS/FAIL + 命令 + 输出摘要 + 未闭环项）。

---

## 附录 E：C2 删除面（主控实测枚举 2026-09-19；**照此逐条删，别整包乱删**）

> ⚠️ **时效声明（主控）**：本附录的行号/文件名是 **2026-09-19 的一次性实测快照**，并行施工期间会漂移 ⇒ **范围以总纲 §8.4 的逐调用点表为准**，本附录只用于"别整包乱删"的判断。另：`ai.chat` 整包（`internal/wasmapp/aichat/**`）的删除见总纲 §21.3 与 §8.4 新增行，本附录未含。

### E.1 可整包删除
- `server/internal/wasmapp/session/**`（`login.go` / `pages.go` / `ticket.go` / `store.go` / `session.go` / `basedomain.go` + 全部 `_test.go`）。
- `server/internal/wasmapp/anonlimit/**`：唯一调用方是 `appserver/options.go` 的匿名限流器（login-only 后无匿名请求）；连 `Options` 字段与 `serveApp` 步骤⑥ 一起删。

### E.2 **不能整包删**：`server/internal/wasmapp/edge/**`
它同时装着"主机名门控（要删）"和"HTTP 面原语（客户端路径仍要用，必须保留）"：

| 保留（客户端路径在用） | 删除（应用子域专有） |
| --- | --- |
| `ApplyHostSecurityHeaders(h, selfOrigin)`（CSP 等安全头，**实测关键不变量**）、`StripAppControlledHeaders`、`MaxBodyBytes`、`IsIdempotent`、`NormalizeOrigin`、`IsOriginShaped`、`WriteAppNotFound`、`OriginDiagFields`（日志口径） | `HostGate` / `MatchHost` / `HostKind` / `IsProbePath` / 主站源与 `CheckOrigin`（含 referer 分支）/ `SelfOrigin`（host 推导）/ `extraMainHosts` 相关；`gate.go`+`hostgate.go` 的对应测试（`hostgate_test.go`）与 `internal/router/subdomain_test.go` |

> 结论：`edge` 保留为"HTTP 面原语"包（改名非必须，可在 C2 汇报里提为后续清理项）；C1 的客户端 Origin 判据复用 `NormalizeOrigin`/`IsOriginShaped`（已下发）。

### E.3 基域配置面（全删）
- `server/cmd/server/wasmapp_domain.go`、`wasmapp_domain_test.go`、`wasmapp_domain_policy_test.go`（整文件删）
- `server/cmd/server/wasmapp.go`：`HostGate` 字段与 `newHostGate`/`extraMainHosts`、`session.ParseBaseDomain` 调用、"基域启用"的启动自检与日志、`WasmSession` 装配
- `server/internal/wasmapp/api/admin.go`：`AdminBaseDomainGet/Put`、`SettingAppsBaseDomain`（`wasm.apps_base_domain`）、`session.ParseBaseDomain` 用法
- `server/internal/wasmapp/api/handlers.go`：`Options.BaseDomain` / `BaseDomainSource` / `ApplyBaseDomain` 三个注入面 + `appOrigin` + `resolveBaseDomain`
- `server/internal/router/router.go`：`/domain` 路由、`WasmSession` 依赖字段、`/login` `/logout` `/app-ticket`（:121-126）
- `server/internal/wasmapp/limits/**`：`TicketTTL`、`AppSessionTTL`、`SessionMaxFormBytes/Username/Password/Next` 及其 `limitsspec.go` 表项（删完用 `go run ./cmd/picoaide-limits-gen` 重生成 `limits.json/limits.md` 与技能引用）

### E.4 迁移
- `0070_employee_sessions.sql` 建立 `employee_sessions` / `app_sessions`；新增紧随其后的编号迁移（当前最新 **0072** ⇒ 新迁移 **0073**）执行 `DROP TABLE IF EXISTS …`（先读 0070 确认表名/索引/外键与依赖顺序）。

### E.5 webadmin 与文档
- `server/webadmin/src/pages/app-center/Settings.tsx`：基域配置整节/整页删除（含子导航与路由入口）；`Audit.tsx:166` 的 `wasm_apps_base_domain_change` 标签**保留为历史值**。
- `docs/03-api-reference.md`（若含 `/domain`、`/login`、`/app-ticket`、`entry_url` 条目）与 `server/docs/**` 同步。

### E.6 判据
```bash
cd /data/picoaide-harness
git grep -nE 'WasmSession|apps_base_domain|PICOAI_APPS_BASE_DOMAIN|app-ticket|TicketTTL|AppSessionTTL|anonlimit|entry_url|appOrigin' -- server ':!server/webadmin/node_modules' | head -40
cd server && export GOCACHE=/data/picoaide-harness/temp/go-build GOMODCACHE=/data/picoaide-harness/temp/gomodcache GOPROXY=off && go build ./... && make check
```
业务代码零命中（历史文档/审计标签/测试夹具里的历史值除外，逐条说明归类）。

### E.7 两条易错点（主控实测澄清 2026-09-19）
1. **`appserver` 的测试夹具必须保留、只裁换票部分**：`helpers_test.go`（`newEnv`/`publishApp`/`newUser`/`serve` 等）、`pipeline_test.go`、`static_test.go`、`units_test.go`、`wasm_test.go` 是**幸存客户端路径**的公共夹具与用例载体。要删的是其中的换票/登录/匿名 helper 与用例（`loginEmployee`/`redeemAppSession`/`loggedInCookie*`、`/app-ticket` 断言、`units_test.go:428` 的 `ticketURL` 用例、匿名限流用例），**不是整文件删除**；`appserver/ticket_nonce_test.go`、`internal/router/subdomain_test.go`、`edge/hostgate_test.go` 才随实现整文件删。
2. **不要误删客户端的 `/login`**：`packages/host/enterprise/src/auth-gate.ts:1474` 的 `path: '/login'` 是**客户端自己的登录页**（企业会话），与本次要删的平台主站 HTML 页（`wasmapp/session` 的 `/login`）无关；`/api/client/v2/auth/login`、`/api/server/admin/login` 同理。删之前先确认引用方是不是 `wasmapp/session`。
3. **`ctx.webServer.register` 的契约**（C3/C4 用）：路由 `{ kind: 'exact' | 'prefix', path, handler }`，**同路径重复注册会 throw** ⇒ 新包的本机路由要选不与既有 `/api/pico/*` 冲突的路径（建议 `/api/pico/wasm-apps/*` 前缀 + handler 内按 method 分发，照 `wasm-apps.ts:1548` 的既有范式，并同样过 `requireWriteProof`）。

### E.8 门禁红点与跨代理移交（2026-09-19 实测；C1/C2 必须一并处理）
1. **测试直读 `.env.example`**：`session/ticket_nonce_host_test.go:390` 的 `TestTicketNoncePromisesStayActionable` 断言基域示例存在 —— D3 删掉示例后**已实测为红**。⇒ 该用例随 §5 一并删除，**不要回填示例**。
2. **生成物由 C2 统一重生成一次**（C1 不要跑生成器，避免并发写同一文件）：`appcfgspec.go` / `limitsspec.go` 改完后执行 `cd server && go run ./cmd/picoaide-limits-gen`，产物含 `internal/wasmapp/{limits/limits.json,limits.md}`、`internal/wasmapp/appcfg/appcfg.json`、`server/skills/app-builder/references/{limits.md,app-config.md}`。D2 已列出需消失的行：`app-config.md` 16/25/50/65/79、`limits.md` 9/84/96-101/106-109。
3. **内置技能版本登记**（D2 已把 `SKILL.md` 改为 1.2.0 ⇒ 现红）：`internal/wasmapp/skillseed/skillseed_test.go:38` 的 `seededSkillVersion` 改 `1.2.0`；`skill_version_test.go:56` 的 `seededSkillDigests` 补新摘要（**必须在生成物重生成之后重算**：`go test ./internal/wasmapp/skillseed -run TestBuiltinSkillVersionTracksContent` 会打印新摘要）。
4. **服务端基域/env 读取点**（D3 枚举，同版本必删）：`cmd/server/wasmapp.go:40 EnvAppsBaseDomain`、`cmd/server/main.go:192`、`cmd/server/wasmapp_domain*.go`、`session/{basedomain.go,ticket.go:762,session.go:151-162}`、`api/admin.go:697-702 SettingAppsBaseDomain`、`anonlimit/anonlimit.go:37 EnvTrustedProxiesExplicit`（compose 侧 D3 已删，**不要回填**）。
5. 注释残留：`cmd/server/wasmapp_hostgate_test.go:8`。
6. 文案残留（C4 范围，已扩展其白名单）：`packages/host/enterprise/src/wasm-app-tools.ts:426-430`、`packages/client/wasm-apps/**`。
7. **env 面保留项（主控复核 D3 产出后确认）**：`PICOAI_TRUSTED_PROXIES` **必须保留**（`server/cmd/server/main.go:138`、`appserver/options.go:527` 仍在读，用于客户端 IP 归属与限流键）；只有 `PICOAI_TRUSTED_PROXIES_EXPLICIT`（anonlimit 专用标记）随 anonlimit 删。`PICOAI_APPS_EXTRA_RESERVED` 保留（`registry.ValidateAppID` 仍读）。Caddyfile 三份本就没有应用站点块 ⇒ C2 无需再改，但必须保留 D3 加的"应用不经反代、无需站点块或证书"注释。
8. **已完成产物的独立复核（主控，2026-09-19）**：D2（作者文档 + 技能）零老口径残留、cookie/access 语义书写正确；D3（env/compose/Caddy/部署文档/站点双语）零 `PICOAI_APPS_BASE_DOMAIN` 残留且保留项正确；D4（发布说明）"必须同版本升级"与"浏览器不再可用"两处齐备、§一/§九 已转为历史短说明。

### E.9 主控裁定（回答 D1 的 7 条待确认；C1/C2/V1 一并遵循）
| # | 问题 | 裁定 |
| --- | --- | --- |
| ① | app_id 的 DNS 约束（≤63 / 非纯数字 / 非 `xn--`） | **保留**；理由改写为"app_id 仍是 URL host 段（`picoaide-app://<app_id>`）与路由标识，host 段必须合法" |
| ② | 保留字表 | **保留**；理由同步为"URL host 段与平台/企业既有标识冲突" |
| ③ | §13"不新增标识列" | **保留**（`apps.channel='wasm'` 现状不变） |
| ④ | §10.4 第 46 条（登出后吊销） | **替换判据**为"登出/改密/禁用后 bearer 被吊销 ⇒ 应用请求 401"，由 `serverauth.BearerAuth` 承担；C1 需有用例 |
| ⑤ | `Referrer-Policy: same-origin` | **保留**（宿主安全头策略不变），但写明"不再是换票正确性的前提，仅保留为响应头策略" |
| ⑥ | 可信代理自检 | **随 `anonlimit` 一起删除**（唯一调用方），无替代者 |
| ⑦ | 深链口径与三平台未实测 | 深链按契约 §4.5；未实测项写成"待各平台复核（W5）" |

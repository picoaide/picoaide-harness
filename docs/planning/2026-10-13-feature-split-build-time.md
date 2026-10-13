# 功能模块的编译期拆分（build-time feature split）

> 状态：**设计稿**（2026-10-13）。P0 三支工作流已在实施中；本文固化范围、机制、判据与决策口径，作为后续各期的执行依据。
> 口径声明：本文只写机制与文件锚点，不写渠道/客户身份（铁律 0）。渠道字段示例一律用占位值。

## 1. 目标与不变量

**目标**：把产品拆成「基础功能恒开 + 三个可选模块」，渠道包在**编译期**决定要哪几块：

| 模块 | token | 内容边界 |
|---|---|---|
| 基础 | `base`（恒定） | 认证/网关/用户/计费/审计/门户/客户端分发/工作区/记忆/定时任务/连接器之外的宿主能力 |
| 技能商店 | `skills` | 能力中心（共享技能 + 智能体预设的上传/审校/授权/安装/统计）与其客户端面板 |
| 应用中心 | `apps` | WASM 应用平台（目录/发布链/运行时/应用 AI/演示应用播种）+ 客户端应用窗口与宿主 |
| 连接器 | `connectors` | MCP 连接器（目录/下发/凭据/本机连接与工具注册） |

**三条硬不变量**：

1. **代码不进产物**：模块关闭时，其代码不得出现在 app.asar / 服务端二进制 / webadmin dist 里 —— 不是"运行期关"，而是编译期真裁剪。
2. **数据库完全一致**：所有变体跑**同一套迁移**、得到**同一套 schema**（不允许任何 DDL 分叉）。
3. **缺省全开**：渠道配置不写 `features` 时四块全开（既有渠道行为逐字节不变），与刚落地的 `desktop.platforms`（不写=三端全要）同口径。

## 2. 开关契约

### 2.1 渠道配置

```json
"features": { "skills": true, "apps": false, "connectors": true }
```

- 只允许出现 `skills` / `apps` / `connectors` 三个键（未知键 fail-loud，**不得**静默丢字段变成"全开"）；值为布尔；
- 缺省（键缺失或整段缺失）= 全 `true`；
- 官方渠道模板键表（`packages/host/desktop/scripts/channel-constants.ts` 的 `CHANNEL_TEMPLATE_KEYS`）必须含 `features`；
- 校验落在 `scripts/ci-channels.sh`，报错**不回显取值**（沿用 `desktop.platforms` 的形态）。

### 2.2 变体标识与哨兵串

- 解析出一个稳定标识：`FEATURES=skills,apps,connectors`（全开）／`FEATURES=none`（只基础），供 Go `-tags`、客户端组装、webadmin build-arg 共用；
- **哨兵串**：每个模块一个唯一常量（形如 `picoaide.feature.<module>.v1`），放在该模块"必被编译"的文件里，用于产物断言（关闭时该串必须**不在**产物中）。哨兵串必须真的会被编译进去，放在死代码里等于没有。

## 3. 机制选型与核证过的限制

| 层 | 交付物 | 机制 | 核证过的限制（改动前必读） |
|---|---|---|---|
| 服务端 | 单个 Go 二进制 | `-tags` 组合 | `-tags` 全仓**零使用**；仓内 14 处 `//go:build` 中只有一处功能标签（`perfprobe`，自述不进常规门禁） |
| 客户端 | app.asar + 安装包 | bundle 列表条件化 + 打包期排除 + 依赖图切断 | 应用根内容由**手写白名单** `PACK_APP_ROOT_ENTRIES`（4 项）决定，`build.files` 只管 node_modules 排除面；node_modules 入包按**生产依赖声明闭包**，不是按 import |
| webadmin | 嵌入二进制的 SPA | 按变体构建（`define` + 动态 import） | `server/Dockerfile:32-41` 的 webadmin stage **零 `ARG`/`ENV`**；`vite.config.ts` 无 `define`/`loadEnv`；`//go:embed dist/*` 空目录即编译失败 |

### 3.1 Go 侧的三条硬约束（审计发现，会改变实现形态）

1. **只允许一个装配入口**：`server/cmd/server/routes_source_test.go:277-330` 断言生产侧**恰好一处** `router.Register(` 调用点（当前 = `server/cmd/server/main.go:751`）。⇒ 变体**不能**各写一份入口，只能"单一入口 + tag 提供的接线提供者"。
2. **`main()` 里的调用必须是字面量**：`server/cmd/server/main_assembly_criteria_test.go:47` 用 AST 要求 `seedDemoApps(wasmCtx, db, *dataDir)` 这一句留在 `main()`。⇒ 装配不能包进不可达构造。
3. **`-tags` 的传参与 flag 顺序被钉住**：`scripts/check-workflows.mjs:3382-3397` 要求 `go vet` 的 `argv[1]` 逐字 `./...` ⇒ 只能写 `go vet ./... -tags=…`。共 14 个构建/测试入口要同改（`server/Makefile` ×6、`server/Dockerfile` ×3、`server/scripts/build-demo-apps.sh`、`.github/workflows/ci.yml` ×3 间接 1）。
4. **tag 组合下的测试会静默不跑**：CI 只有一个 `go test` 步（`ci.yml:1025-1046`），`scripts/wasm/check-go-test-json.mjs` 只判"报告里出现的用例"。⇒ 必须新增"变体矩阵跑测试"的判据，否则减配变体的代码永不被测。

### 3.2 客户端侧的两条硬约束

1. **技能面住在必需包里**：能力中心是 `packages/host/enterprise/src/client/index.ts:34` 的静态 import（→ `capability-surface.tsx` → `CapabilityCenterPanel.tsx`，约 2012 行），而 enterprise 同时承载登录门/品牌/账号设置段/更新/网关/应用本机 API。⇒ **拆包是前置条件**，不是优化项。
2. **打包配置的合法改写通道**：渠道那套生成 `<desktop>/temp/channel-electron-builder.cjs` + `--config` 的先例可以照抄（`scripts/channel-build.ts:341-353`、`:671-701`；官方渠道返回 `[]` 保证零影响）。**不要**把变体差异写进 `package.json` 的 build 块（会被 `tests/package.spec.ts:270-320` 的漂移断言咬住）。

## 4. 数据库一致性口径

### 4.1 好消息：表层面天然而不需分叉

- 技能商店与应用中心**共用** `apps` / `app_releases` / `app_grants`，靠 `kind ∈ {skill, agent, wasm_app}`（迁移 0069:32）与 `channel ∈ {market, org, wasm}`（0069:41）判别；
- **零跨功能外键**：`app_releases` 唯一外键指向 `apps(kind, app_id)`（0053:54）；
- 技能侧真正独占的只有 `capability_locks`（0050:9）；应用侧独占 `wasm_call_events`（0069:102）/ `wasm_app_opens`（0075:35）/ `wasm_app_opens_daily`（0075:56）。

### 4.2 口径：schema + 迁移序列 + 种子一致，但**数据面会分叉**

- 迁移**一律全量保留**，不得放进 build tag；也不得靠删迁移对齐（0083:20-21 明写"只换镜像不删版本行会起不来"= `SchemaMismatchError`）；
- 种子随迁移恒跑（`0042:42` 三条连接器种子、`0045:9`、`0084:29-33`）⇒ 关闭变体里**行仍在**，差异只体现在"下发与否"；
- 但下列行为只存在于模块在场时，关闭后必须回答"谁接管"：`wasm_app_opens` 的 90 天保留（`server/internal/serverstore/wasm_app_opens.go:173` + `internal/wasmapp/opens/scheduler.go:98-128`）、演示应用自愈 `healIncomplete`（`internal/wasmapp/appseed/appseed.go:244-272`）、磁盘侧 `rewritePublicAccessAssets`（`server/cmd/server/wasmapp_demo.go:34-38`，注释明写它与 DB 侧 0074 是成对的）；
- **建议判据**：每个变体各跑一次"空库 + 全量迁移"，对拍 `information_schema` 快照；另加一条结构性判据：`migrations-pg/` 下不得出现 `//go:build`。

## 5. 审计发现的硬耦合与处置

| # | 耦合 | 证据 | 处置口径 |
|---|---|---|---|
| 1 | `/readyz` 是应用中心资产 | `server/cmd/server/main.go:745-747`（`d.Ready == nil` 直接 panic）；唯一生产来源 `main.go:259` 的 `wasmPlat.Checker.Handler()` | 基础侧提供替身探针；`apps` 关闭时不得因此拒启 |
| 2 | 权限点 ↔ 路由双向判据 | `server/cmd/server/audit_r13ge_permset_test.go:72`（`reservedPermissions` 当前空表）；`server/webadmin/src/lib/nav.test.ts:665-678` 四向对拍读 `server/internal/serverauth/rbac.go` | **保留权限点 + 登记**（权限模型不随变体变） |
| 3 | 渠道字段 `app_origin_scheme` 属应用中心 | `scripts/ci-channels.sh:770-772`（必需字段）；服务端 `main.go:463`（fail-loud） | 随 `apps` 变体放宽：关闭时不再强制 |
| 4 | Dockerfile 跨模块取文件 | `server/Dockerfile:88` 把 `skills/app-builder/scripts/pack-assets.mjs` 拷给演示应用构建（:81 注释自陈"是同一个文件"）；`scripts/ci-build-channel-images.sh:228-229` 断言该技能文件存在 | 把该脚本搬到中性位置（演示应用工具链），技能侧引用同一份；四方对拍判据同步 |
| 5 | 演示应用/内置技能播种 | `server/cmd/server/main.go:230`（演示应用）、`:243-251`（内置技能目录） | 分别随 `apps` / `skills` 变体 |
| 6 | 应用归因写 `usage.app_id` | `server/internal/llmgateway/app_attribution.go:29` → `serverstore/wasm_app_opens.go:386-411`（同事务校验 `kind='wasm_app'` 存在） | 关闭 `apps` 后归因恒空是**预期**，需在文档与判据里写死（不是缺陷） |
| 7 | 审计链双版本 | `server/internal/serverstore/audit.go:377-388`、`:684-687`；写入方含 `appstore/admin.go:114/141`（三种 kind 共用） | 链校验两版本都过 ⇒ 不报错；但**链内容不可跨变体比对**，写进口径 |
| 8 | `appstore` 是共享底座 | `internal/wasmapp/api/admin.go:16` import `internal/appstore`（反向不成立） | 两个变体都必须保留 `appstore`，只裁路由与上层 |

## 6. 分期与工作流划分

| 期 | 内容 | 收敛判据 |
|---|---|---|
| **P0**（进行中） | w1 拆 enterprise（技能面搬出）；w2 解耦 `browser → connectors` 的 tsc 边；w3 `features` 契约 + 哨兵串 | 三支各自"实施→独立审计→修复→复审"到 P0/P1 归零 |
| **集成** | 合并三分支、跑全量门禁、对**集成态**再审计一轮 | 门禁全绿 + 集成态审计 P0/P1 归零 |
| **P0.5** | §5 的八条处置（readyz 替身、权限点登记、scheme 放宽、pack-assets 搬家、播种条件化…） | 同上 |
| **P1** | 服务端：单一入口 + tag 接线提供者、②的 nil 守卫（当前 76 处裸引用）、③整块条件化（6 条调度器 / 演示播种 / `publishRouteReservedAppIDs`）、变体矩阵编译与测试 | 四组合 `go build`/`go vet`/`go test` 全绿 + 产物哨兵缺席 + schema 对拍 |
| **P2** | 客户端：bundle 可选集合、`startup-rows`/`foot-menu`/`deep-link` 白名单按变体、打包三处同清、启动 smoke | asar 哨兵缺席 + 基础-only 变体可启动 |
| **P3** | webadmin：Dockerfile build-arg + vite `define` + 模块页动态 import + 对账测试按变体 | dist 哨兵缺席 + 模块路由 404 |
| **P4** | 体积实测（部署机交付件口径）、`channels.md` 文档、tag 期四组合编译 | 数字与文档判据 |

## 7. 判据清单（必须新增或按变体给期望）

**新增**
1. 产物哨兵缺席：服务端二进制（符号/字符串）、app.asar、webadmin dist；
2. 变体矩阵编译与测试（四组合 `go build` / `go vet` / `go test`，且**非缺省 tag 的用例必须真跑**）；
3. schema 快照跨变体逐字节对拍 + `migrations-pg/` 无 `//go:build`；
4. `features` 键的形状/取值/缺省判据（含变异自证）。

**按变体给期望（否则变体一建就红）**
- Go：`server/cmd/server/routes_source_test.go` 的 `wasmGatedRoutes`（42 条，语义上只服务应用中心）、`router/parity_test.go` 的 `productionTestDeps`/`productionOnlyAdminRoutes`、`audit_r13ge_permset_test.go`、`internal/serverstore/audit_r13gh3_searchpath_serverface_test.go:189+` 的包登记表、`scripts/wasm/wasm-gate-inventory.json` 的 33 包子包清单；
- 客户端：`packages/host/desktop/tests/i18n-keys.spec.ts:26-35`（字典包清单 + 死键）、`scripts/verify-packaged-runtime.ts:59-305`（逐文件条目）、`:1411-1437`（每包下限，只许上调）、`:1947-1976`（锚点表）、`tests/prebuild-workspace-deps.spec.ts:351` 与 `scripts/verify-inventories.mjs:161-292`（包表四向对拍，多一条也红）、`tests/package.spec.ts:274-319`（`asarUnpack` 逐字 + `files` 关键项）；
- webadmin：`src/lib/routes.ts` 的 `NON_NAV_ROUTES` 双向判据、`nav.test.ts` 的四向对拍（读 Go 真源）；
- 脚本/守卫：`scripts/verify-ci-scripts.mjs`（实跑体）、`scripts/check-guard-parser-integrity.mjs`（digest 锚定 HEAD 对象）、`scripts/check-workflows.mjs`（argv 白名单）；
- 文档/数字：`AGENTS.md` 的 13 包与 `planned=32` 两条口径、`scripts/check-doc-claims.mjs` 的既有锚点。

## 8. 决策台账

**已定**（用户口径）：三个独立开关、任意组合；服务端不注册路由 ⇒ 统一 404；缺省全开；技能 = 共享技能 + 智能体预设；应用 = 页面 + 发布链 + 客户端宿主 + 应用 AI + 播种；连接器独立成模块。

**本设计采用的默认**（可推翻，推翻需在实施前说）：
1. 权限点保留 + 登记；
2. `/readyz` 由基础侧提供替身；
3. 关闭模块的表保留期清理**留在基础**（否则关掉即无界增长）；
4. `app_origin_scheme` 随 `apps` 变体放宽；
5. `pico-skill-filesystem` / `pico-tool-skill`（模型侧 `skill` 工具与本地技能目录发现）**归基础**；
6. 连接器凭据**不自动删**（明文凭据属用户数据），只做文档与可选清理入口。

**待拍板**：
- 内置技能目录（`/opt/picoaide/skills`，Dockerfile 逐条 COPY）在 `skills` 关闭时是否随包？（决定 §5-4 的搬法是"搬脚本"还是"整目录条件化"）
- webadmin 是否真裁（要真裁必须加 Dockerfile build-arg + vite `define`）；
- P0 的拆包是否作为独立 PR 先合（推荐：是，纯重构、无行为变化，便于回溯）。

## 9. 未核实项（不得当结论用）

- 本轮所有结论来自**静态阅读**：未跑构建、未跑测试；"某判据会不会红"属推断；
- gin 对 nil handler 的确切行为未实跑（推断：注册期不 panic、请求期 panic→Recovery→500，比整片不注册更隐蔽）；
- electron-builder 26 对应用根 matcher 的行为与静态阅读不完全一致 ⇒ 依赖 `files` 排包的人**必须以实测产物为准**；
- `verify-packaged-runtime.ts`（2800+ 行）只核了四张清单表与三处引用点，其余判据群未读；
- `deepseek-harness/` 子模块未做全量扫描。

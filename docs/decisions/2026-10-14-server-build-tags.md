# 服务端可选模块的编译期开关（`-tags`）——接线与变体矩阵判据

**状态**：已实施（第一片：tag 接线 + 判据；**第二片：条件化编译已落地，裁剪断言生效**）
**日期**：2026-10-14（第二片同日续篇，见 §6–§9）
**相关**：[渠道声明功能模块（`features`）——编译期契约](./2026-10-13-channel-feature-modules.md)（P0：字段形态、
唯一真源、变体标识、覆盖表；**本文是它的服务端侧续篇**）、
[功能模块编译期拆分设计稿](../planning/2026-10-13-feature-split-build-time.md)、
[功能模块的 host 面归属](./2026-10-13-module-host-face-ownership.md)

---

## 1. 这一片做了什么（一句话）

**第一片**：把 P0 已经定好的**变体标识**接进服务端**每一条构建入口**，并给"关掉某个模块"
这种构建形态留下第一条可执行的判据 —— 但**不**按开关裁任何东西：开了等于没开，关掉也照样
编出全部包（历史形态，保留在 §3–§5，读的时候记住那是**第一片**的口径）。

**第二片（2026-10-14 同日，本文 §6 起）**：让 tag **真的门控代码** —— 三个模块的路由注册、
`cmd/server` 的装配、以及它们各自依赖的包，全部变成构建期条件注册。验收判据从"只报账"
翻转为**生效**：关掉某模块时，它的整棵包树必须从 `go list -deps ./cmd/server -tags=…` 里消失。

## 2. tag 命名与唯一真源

模块名与渠道契约**逐字一致**（P0 §3 的 `FEATURE_MODULES`）：`skills` / `apps` / `connectors`；
变体标识就是 P0 §5 的 `features_variant`（`channelFeaturesVariant()` 的产物：
`skills,apps,connectors` / `apps` / `none`）。判据与构建入口读的是**同一个串**，不另起一套组合名 ——
P0 §5 的硬约束是"三处只能读同一个串，不得各自按三个布尔重拼"。

**服务端侧的唯一真源 = 包 `server/internal/features`**：

| 文件 | build 约束 | 内容 |
| --- | --- | --- |
| `features.go` | （无 tag） | 模块名常量、`AllModules()` / `Enabled()` / `Has()` / `HasSkills()` / `HasApps()` / `HasConnectors()` |
| `features_skills_apps.go` | `skills && apps` | `skillEnabled` / `appEnabled` |
| `features_skills_only.go` | `skills && !apps` | 同上 |
| `features_apps_only.go` | `apps && !skills` | 同上 |
| `features_neither.go` | `!skills && !apps` | 同上 |
| `features_connectors.go` | `connectors` | `connectorEnabled` |
| `features_no_connectors.go` | `!connectors` | 同上 |

**为什么是"四个互斥且穷尽 + 一对正交"而不是八个**：`connectors` 与 `skills`/`apps` 正交
（任一 skills/apps 组合下它都可以开或关），拆成正交的两对之后，skills/apps 面四个文件里
恰好有一个参与编译 —— **少一个文件就是"常量未定义"的编译失败**，不会静默取零值。
`features.go` 刻意**不带任何 tag**：八种组合（三个独立开关的全部子集）编译的是同一份声明与同一份查询 API
（判据 `features_test.go` 也不带 tag，因此它在每一种组合下都被执行）。

## 3. 四个组合与构建入口接线

判据覆盖的组合（`none` 即空 tag 集）：

| 变体标识 | `-tags=` | 期望被裁掉的模块树 |
| --- | --- | --- |
| `skills,apps,connectors` | `skills,apps,connectors` | （基线：三个树都必须**在**）—— **发布态**，也是所有入口的缺省值 |
| `none` | （空） | skills / apps / connectors |
| `skills` | `skills` | apps / connectors |
| `apps` | `apps` | skills / connectors |
| `skills,apps` | `skills,apps` | connectors |

接线点（全部用**可覆盖变量**，缺省"全开"⇒ 既有行为不变）：

- `server/Makefile`：`GO_TAGS ?= skills,apps,connectors` → `GO_TAG_FLAG`，进 `build-server`（两处
  `go build`）、`test` / `test-server` / `test-server-fast`、`check` / `check-fast`（两处 `go vet`）；
  `docker-image` 把它透传成 `--build-arg GO_TAGS=`；**新增 `check-tags` 目标**跑变体矩阵。
- `server/Dockerfile`：`ARG GO_TAGS=skills,apps,connectors` + 三处 `go build`（server /
  app-compile / 演示应用）都带 `-tags=$GO_TAGS`。不传该 build-arg 时镜像内容与本改造之前同源。
- `server/scripts/build-demo-apps.sh`：`GO_TAGS` 缺省同上，wasm 编译带 `-tags=`。
- `.github/workflows/ci.yml`：`go vet` 与 `go test` 两步都带 `-tags=skills,apps,connectors`
  （字面量与 Makefile 的 `GO_TAGS ?=` 缺省值逐字相同；CI 刻意自持这一份，不随构建脚本的变量
  漂移 —— 与本文件 `go test` 的 `-timeout 15m` 同一口径）。vet 那一步为此改了守卫的一条载荷
  口径，见下。

### `go vet` 那一步怎么拿到 `-tags`（连带改了 `ci-go-vet` 的载荷口径）

> ⚠️ 本节是**第一片**的现场记录（当时 `check-tags` 只是"报账"）。第二片的接线见 §6–§9。

`go` 自带 flag 解析在**第一个非 flag 词处停止** ⇒ `-tags` 只能写在**包面之前**：

```
$ go vet ./... -tags=skills
malformed import path "-tags=skills": leading dash      # 退出码 1，这不是"接受了但忽略"
```

而已有的 `scripts/check-workflows.mjs` 的 `ci-go-vet` 载荷把包面钉成 **argv[1] 逐字 `./...`**
⇒ `go vet -tags=… ./...` 必红。两者相撞时"给 vet 加构建变体"结构上不可能，而那条策略的
**意图**是"包面不许缩到子集"—— 与"包面之前允不允许有 flag"无关。所以 2026-10-14 把它改成
**"第一个不以 `-` 开头的词逐字 `./...`"**，并在**同一个提交**里按纪律重登记了
`scripts/check-root-guards.mjs` 的 `check:workflows` 摘要（`--print-digests` 复算，
有意变更的两半必须同批）。

- 放行：`go vet -tags=skills,apps,connectors ./...`；
- 仍然红（实测）：`go vet ./cmd`、`go vet -tags=skills ./cmd` —— 第一个非 flag 词都不是 `./...`，
  与 E-03 的缩面形态同一判据面；
- 已知边界：`-tags x` 的**分离写法**会让"值"成为第一个非 flag 词 ⇒ 判红。这是刻意的
  （判据不自带 flag 语法表），写法归一到 `-flag=值` 即可。

**没有采用的别名**（都试过/评过，别再走一遍）：

- `GOFLAGS` 环境键（`PINNED_ENV_ALLOWED_KEYS` 是白名单制）——`GOFLAGS` 同时给出 `-toolexec`
  通道 = 在判据步骤里任意执行代码；
- 被钉步骤上的 `env: GO_TAGS:` + `-tags=$GO_TAGS` —— 实测 `[SK-17]` 当场判红：新增一个环境键
  要过白名单，等于让"判据步骤的构建变体由环境决定"。所以 CI 那两处是**字面量**，不是变量。

**改 `ci.yml` 时踩到的两个坑**（都实测过，写给下一个人）：

1. `check-workflows` 的命令位判据读的是 `run:` 的**可执行文本**（注释先被剥掉）—— 注释里写
   历史命令不会误判，可以放心写明"为什么这么写"。
2. 但 `check-install-integrity` 的 `CI_REFERENCED_EXECUTION_REGISTRY` 是拿正则
   `(?:scripts|packages)/…\.(mjs|cjs|js|ts|sh|json)` 扫**整份 workflow 文本**（YAML 注释也算），
   而且扫的是 **HEAD 字节**：在 ci.yml 的注释里写一个 `scripts/*.mjs` 路径，它会被当成
   "CI 引用的执行体"并要求登记（改动没提交时 HEAD 未变，判据照旧用旧字节 ⇒ "我明明删了它还红"）。
   本文提到的 `scripts/check-go-build-tags.mjs` 因此**只出现在 Makefile 与本文档里**，不进 ci.yml。

## 4. 判据在哪

**变体矩阵判据**：`server/scripts/check-go-build-tags.mjs`，入口 `make -C server check-tags`
（`TAGS_ARGS=` 透传参数）。

```bash
make -C server check-tags                      # 全部组合：go build + go vet
node server/scripts/check-go-build-tags.mjs --no-vet        # 只 build
node server/scripts/check-go-build-tags.mjs --only=apps     # 单个组合
node server/scripts/check-go-build-tags.mjs --self-test     # 只自证判据引擎（不碰 go）
```

它每个组合判三件事：① `go build -tags=<组合> ./...` 必须成功；②（缺省）`go vet` 同上；
③ `go list -deps -tags=<组合> ./cmd/server` 里**开着的**模块包树必须在、**关掉的**必须在不。
包树边界（与 P0 §6 纪律 2"承重判据是依赖图/文件清单"同一口径，也是纪律 3 的双侧形态）：

- `apps` → `internal/wasmapp/**`
- `skills` → `internal/{marketplace,sharedskills,agentshare,capabilities}`
- `connectors` → `internal/connectors`

**③ 里"关掉的那一半"现在是生效判据**（第二片翻转，缺省即 `--expect-cut`）：关掉模块时
包树必须不在依赖图里。`make -C server check-tags` 的 `TAGS_ARGS ?= --expect-cut` 就是这次
翻转的落点；`--expect-cut=<模块,…>` 仍是探针形态（对所有组合套一组指定的裁剪集，**必须变红**，
用来证明这条判据不是空转）。

**表面判据**：`server/internal/serverstore/audit_r13gh3_searchpath_serverface_test.go` 的
`searchPathGuardPackages` 登记了新包 `internal/features`（`no-family-sql`：它只有常量与纯函数）。
这条是"新增包必须进判据面"的守卫，**新增 Go 包时同批登记**。

## 5. 本轮**没有**做的事 / 第二片要做什么

1. **没有按 `features.Has*()` 做任何条件编译**：`internal/wasmapp/**`、技能四包与
   `internal/connectors` 仍然无条件进二进制与依赖图（矩阵判据的 `⏳` 行就是这件事的账）。
2. **没有把矩阵判据接进自动门禁**：`check-tags` 刻意不进 `check` / `check-fast`（它是分钟级的
   全仓 build×5），也还没进 `yarn check` / CI。第二片条件化落地后，把它接进 CI（或 `yarn check`）
   并**同时**打开 `--expect-cut` —— 那时它才从"报账"变成"拦门禁"。
3. **没有服务端侧的用户面开关**：本包只回答"编译期开了什么"，不参与路由/接口/装配决策；
   被裁掉的模块该不该注册路由、接口该返回什么，是第二片的接口面决定（P0 §5 的消费契约表）。
4. **没有哨兵串判据**：`picoaide.feature.<module>.v1` 那一族是**端到端副证**（P0 §6），
   承重的依赖图判据是本文 §4 的 ③；产物级双侧判据要等裁剪落地才有"关闭变体"可比。
5. **CI 只覆盖发布态组合**：`go vet` / `go test` 两步都带 `-tags=skills,apps,connectors`（全开），
   其余组合的 build + vet 只在 `make check-tags` 里跑（尚未进 CI）。

---

# 第二片：让 tag 真的门控代码（2026-10-14 同日）

## 6. 一句话

第一片只回答"这个组合能不能编出来"；第二片让**关掉一个模块 = 它的包树从产物依赖里消失**
成为事实，并把矩阵判据里那条一直是 `⏳` 的裁剪断言翻成**拦门禁**。

```bash
make -C server check-tags                    # 8 个组合 × (build + vet + 裁剪断言)，缺省 --expect-cut
make -C server check-tags TAGS_ARGS=         # 只报账形态（显式传空才关掉断言）
```

## 7. 哪些代码被哪些 tag 门控

**门控的实现只有两种形态，不许有第三种**（第二片的硬约束）：

| 形态 | 用在哪 | 为什么 |
| --- | --- | --- |
| **空类型 + 空实现**（一对 build-tag 文件） | `internal/router`、`cmd/server` 的装配面 | 关闭态给同名标识符一个**没有方法**的空类型 ⇒ 引用 handler 的注册代码**编不出来**。这是编译期保证，不依赖任何人守约定 |
| **逐组提前 return** | 每个 `registerXxx` 内部（`if d.Wasm == nil { return }` 一族） | 装配真的漏填 handler 时整组不注册。**绝不把 nil handler 交给 gin**：`addRoute` 只断言 `len(handlers) > 0`，nil 会照常注册、请求期 panic→500 —— 既不是约定的 404，也躲开"路由消失声明表"的视线 |

被门控的代码（逐模块）：

| 模块 | 路由（`internal/router`） | 装配（`cmd/server`） | 包树（`go list -deps ./cmd/server` 里必须消失） |
| --- | --- | --- | --- |
| `apps` | `registerWasm` 全片（`/api/client/v2/apps/wasm/*` + `/api/server/admin/wasm-apps/*`）、`publishWasmReservedAppIDs`（`app_id` 保留字注入） | `setupWasmPlatform`（含调用事件/分片上传/打开计数三条清理调度器与编译缓存回收）、`seedDemoApps`、`validateAppOriginScheme`、`wasmapp_limits.go` 的限制项面 | `internal/wasmapp/**` |
| `skills` | 员工面 `marketplace` / `skills/builtin` / `shared-skills` / `agent-presets` / `capabilities`；管理面 `skills` / `agents` / `shared-skills` / `capability-locks` / `agent-presets` / `capabilities/approvals` | `buildSkillSeedHandlers`（内置技能目录加载）、`applySkillsDeps` | `internal/{marketplace,sharedskills,agentshare,capabilities}` **+ `internal/skillseed`** |
| `connectors` | `/api/server/admin/connectors*`（6 条） | `applyConnectorDeps` | `internal/connectors` |

**刻意留在基础面（不随任何变体裁）**：

- `PUT /api/server/admin/apps/:kind/:app_id/owner`（归属转移）：`kind ∈ {skill, agent, wasm_app}`
  三种共用同一张 `apps` 表与同一套 owner 语义，`appstore` 是共享底座（P0 规划 §5 第 8 条）。
  放进 `skills` 会让"只开 apps"的变体失去**应用**归属转移入口 —— 那是功能缺失，不是裁剪。
- `internal/limits`（上限数值的真源，原 `internal/wasmapp/limits`）：基础面的
  `internal/skillmanifest`（`AppIDPattern`）与 `cmd/server` 的 `http.Server.ReadTimeout`
  （`ServerReadTimeout`）直接依赖它。它落在 apps 树里时，"关掉 apps ⇒ wasmapp 树消失"
  与"基础面照常工作"**结构上不可能同时成立**。
- `internal/skillseed`（平台内置技能下发面，原 `internal/wasmapp/skillseed`）：它服务的是
  `skills`（`/opt/picoaide/skills` 的唯一消费方就是它）。留在 apps 树里会两边都不成立：
  关 apps ⇒ 整棵 wasmapp 消失 ⇒ 技能面拿不到内置技能；关 skills ⇒ 内置技能照样随包。
  两个包都按"**谁真的用它**"归位，而不是按它历史上住在哪。

## 8. 关闭态语义（"少了一条路由"到底是什么）

关闭一个模块，产生的是**编译期缺席**，不是运行期降级：

| 面 | 开启态 | 关闭态 |
| --- | --- | --- |
| 路由 | 整片注册 | **路由树上不存在**（404 由 NoRoute 的 JSON 信封兜底，与"路径写错"同形） |
| handler | 真 handler | 类型是空类型；引用它的注册代码不参与编译（**不存在 nil handler 路径**） |
| 权限点 | 由该片路由消费 | **一个都不删**（`serverauth.AllPermissions` 不随变体变）。`cmd/server/audit_r13ge_permset_test.go` 里由 `features.Has*()` 派生"本变体里哪些权限点没有入口"，理由逐条写明是哪个模块被裁掉 —— 模块编进来时那条登记自动消失，权限点仍无入口就照旧判红 |
| `/readyz` | `wasmPlat.Checker.Handler()` | 替身探针（JSON 200，带 `module_apps=off`），**不是**装配失败也不是 500 |
| 渠道字段 `desktop.app_origin_scheme` | 启动期 fail-loud 强校验 | 不再强制（唯一的消费者是应用中心）。**字段形状写错仍照旧报错** |
| 内置演示应用 | 随启动播种 | 不播种（`seedDemoApps` 走关闭态的 no-op 实现） |
| 内置技能 | 启动加载 + `/skills/builtin*` 下发 | 不加载、不下发 |

`main()` 的装配**字面量形状在八种组合下逐字不变**（`seedDemoApps(wasmCtx, db, *dataDir)` 仍在
静态可达路径上）—— 关闭态换的是被调函数的实现，不是删掉调用。因此
`main_assembly_criteria_test.go` 那条判据**一个字都没有改**（这是刻意的：它防的是"装配被人
悄悄删掉"，而"这个变体不含该模块"是另一件事，两者不该混在一个判据里）。

## 9. DB 为什么不变（一个字都不变）

**不变量**：所有变体跑**同一套迁移**、得到**同一套 schema**。因此：

- 迁移文件里**不允许出现任何 `//go:build`**（迁移不进行 tag 门控）；
- 关闭模块的表**照建**（`apps` / `app_releases` / `app_grants` / `capability_locks` /
  `wasm_call_events` / `wasm_app_opens` / `wasm_app_opens_daily` 一个不少），也**照空着**；
- 种子行照跑（迁移 0042/0045/0084 的连接器种子在关闭 `connectors` 的变体里仍在库里，
  差异只体现在"下发与否"）。

三条理由（P0 规划 §4 的原话，这里只复述结论）：

1. **只有一套 schema 才允许同一个数据库被任意变体的镜像接管** —— 客户换镜像（例如从全开
   换到只开 skills）不该要求数据迁移，更不该因为 `schema_migrations` 对不上而拒绝启动
   （0083 明写"只换镜像不删版本行会起不来"）；
2. **迁移是可回滚的资产，不是代码** —— 把它按 tag 分叉等于给每个变体一条独立的 schema
   演化线，N 个变体 × M 个版本的回滚矩阵不可维护；
3. **数据面本来就会分叉，不需要 schema 跟着分叉** —— 关闭 `apps` 后
   `usage.app_id` 归因恒空、`wasm_app_opens` 的 90 天保留没人跑，这些是**行为**差异，
   已在该变体的文档与判据里写死（属"预期"，不是缺陷）。

**建议判据**（下一片可加，本片未做）：每个变体各跑一次"空库 + 全量迁移"，对拍
`information_schema` 快照；外加一条结构性判据 —— `migrations-pg/` 下不得出现 `//go:build`。

## 10. 第二片改了哪些判据面（会红的都点名了）

| 判据面 | 处理 | 理由 |
| --- | --- | --- |
| `cmd/server/routes_source_test.go` 的 `wasmGatedRoutes`（42 条） | 拆成 `routes_source_wasm_gated_test.go`（`//go:build apps`）/ `..._off_test.go`（`!apps`，空表 + 反向断言） | 声明表**语义上只服务 apps**；关闭态没有 wasm 路由可被门控，"表为空"是正确形态。空表被"清空即变绿"滥用的通道由 off 文件里的反向断言堵住（关闭态若出现可选路由即红） |
| `main_assembly_criteria_test.go`（要求 `main()` 里**字面**保留 `seedDemoApps(...)`） | **未改**（一个字都没动） | 关闭态给 `seedDemoApps` 一个同名同签名的 no-op 实现，`main()` 的装配字面量因此八种组合逐字不变 |
| `audit_r13ge_permset_test.go`（权限点必须有入口） | `reservedPermissions` 改为按 `features.Has*()` 派生 | 保留权限点 + 登记（P0 规划 §5 第 2 条）：权限模型不随变体变，缺的只是本变体里的**入口**。`capability:read` 有 skills（`/skills/builtin`）与 apps（`/admin/wasm-apps/*`）**两个**入口面，只有两面都不在时才登记为保留 |
| `scheduler_registry_reconcile_test.go` | **未改** | 它扫的是 `main()` 里的 `start*Scheduler` 接缝；六条 wasmapp 调度器住在 `setupWasmPlatform` 内（apps 文件整份条件编译），不在它的判据面内 |
| `scripts/wasm/wasm-gate-inventory.json` | `packageInventory` 去掉 `limits` / `skillseed`（30 个包），`why` 里写明归位理由 | 包清单是**双向**断言（登记了但不在 ⇒ 红；在但没登记 ⇒ 红），包搬家必须同批登记 |
| `scripts/wasm/check-go-test-json.mjs` | `OPT_IN_SKIPS` 的 owner 与 `ST_PKG.skillseed` 同步到 `internal/skillseed` | 同上：包搬家，登记面跟着搬 |
| `cmd/server/api_sweep_test.go` 的例外登记表 | 技能面 15 条拆进 `api_sweep_module_surfaces_{on,off}_test.go`，判据改查**并集** | 例外表的判据是"登记了就必须被扫到 ⇒ 否则表在说谎"。表按变体拆开之后这条判据逐字不变地生效，而不是被放宽 |
| `internal/router` 与 `cmd/server` 的若干用例文件 | 按**模块**加 build tag（skills / apps / connectors），基础面用例**不加** | 判据面必须与它断言的对象同变体：断"整张路由表"的用例属全开态；断"命名空间/限体/404/装配入口"的用例八种组合都跑（`TestNamespaces` 还因此**加强**了：模块关闭时反向断言那一片路由**不在**树上） |
| `TestResolveStartupChannelDeepLinkScheme` | `wantErr` 由 `features.HasApps()` 派生 | §8 的"关闭态放宽"是设计决定，判据照实表达，而不是删掉那一条 |

## 11. 本片**没有**做的事（认账）

1. ~~**CI 里还没有这一步**~~ **已闭合（2026-10-14 P1 第三片）**：`scripts/check-go-build-tags.mjs`
   此前只在 `make -C server check-tags` 里跑，而 `server/Makefile` 当时**自称**"CI 侧由
   `.github/workflows/ci.yml` 的 server job 单列一步" —— 实测该文件对 `check-tags` 零命中，
   于是"包树真被裁掉"这条判据不在任何自动化里（独立审计 P1-4 的现场：同一份材料里两处口径
   相反，且 Makefile 那句是假的）。现在 CI 的 server job 在 `go vet` 之后多一步
   `node scripts/check-go-build-tags.mjs --expect-cut`，并按 `check-workflows.mjs` 的步骤策略
   完整登记：`CI_JUDGEMENT_ARGV_PREFIXES`（方向②"未登记的判据步骤"看得见它）、
   `REQUIRED_CI_STEPS`（删步骤/挪 job 即红）、`PINNED_STEP_POLICIES` 的
   `ci-check-go-build-tags`（`if: false` / 换命令 / **去掉 `--expect-cut` 让断言退化成
   "只报告"** 三种形态都红）。成本实测：本机 4 vCPU 暖缓存 8 组合 build+vet ≈ 1m52s，
   排在 `go test` 之前顺带预热发布态组合的编译缓存。
   同批还改对了两处口径：矩阵从"手抄 5 行"改为从 `channelFeaturesVariant()` 的取值域穷尽
   派生（独立审计 P1-2：漏掉的 3/8 组里恰好有一组 `connectors` 自己的判据是红的），
   `server/Makefile` 的组合数与 CI 那句话同步改真。
2. **只有发布态组合跑测试**：其余**七**种组合目前只有 build + vet（矩阵判据），没有 `go test`。
   P0 规划 §3.1 第 4 条点名的"减配变体的代码永不被测"因此只解决了一半 ——
   变体感知的用例（如 `TestNamespaces` 的双向断言）能在任何组合下跑，但**没人**在 CI 上跑它们。
   （2026-10-14 P1 第三片补强了**关闭态**那一半：关闭态的"路由树上不存在"承诺现在有两层
   与变体无关的判据 —— `cmd/server/routes_source_test.go` 的登记级命名空间反向断言（每个
   变体都跑、覆盖全部 method）与 `internal/router/optional_*_off_registration_test.go` 的
   位置级断言（关闭态的注册函数实跑后必须零新增路由）。两层都做过变异验证，见各自注释。）
3. **没有产物级哨兵判据**：P0 §2.2 的 `picoaide.feature.<module>.v1` 哨兵串仍未接入；
   承重判据是依赖图（§7 的包树断言），哨兵是端到端副证，需要真实二进制与 `strings` 双侧比对。
4. **没有变体 schema 对拍**：见 §9 末尾的"建议判据"。
5. **客户端与 webadmin 侧不在本片**：本片只动服务端（`server/`）。

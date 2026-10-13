# 服务端可选模块的编译期开关（`-tags`）——接线与变体矩阵判据

**状态**：已实施（**只做 tag 接线 + 判据**；真正的条件化编译**不在本轮**）
**日期**：2026-10-14
**相关**：[渠道声明功能模块（`features`）——编译期契约](./2026-10-13-channel-feature-modules.md)（P0：字段形态、
唯一真源、变体标识、覆盖表；**本文是它的服务端侧续篇**）、
[功能模块编译期拆分设计稿](../planning/2026-10-13-feature-split-build-time.md)、
[功能模块的 host 面归属](./2026-10-13-module-host-face-ownership.md)

---

## 1. 这一片做了什么（一句话）

把 P0 已经定好的**变体标识**接进服务端**每一条构建入口**，并给"关掉某个模块"这种构建形态
留下第一条可执行的判据 —— 但**不**按开关裁任何东西：开了等于没开，关掉也照样编出全部包。

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
`features.go` 刻意**不带任何 tag**：四种/六种组合编译的是同一份声明与同一份查询 API
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
- `.github/workflows/ci.yml`：`go test` 那一步带 `-tags=skills,apps,connectors`。

### `go vet` 那一步为什么**没有**带 `-tags`（实测结论，别再试一遍）

`go` 自带 flag 解析在**第一个非 flag 词处停止** ⇒ `-tags` 只能写在**包面之前**：

```
$ go vet ./... -tags=skills
malformed import path "-tags=skills": leading dash      # 退出码 1，这不是"接受了但忽略"
```

而 `.github/workflows/ci.yml` 的 `go vet` 步骤的包面被 `scripts/check-workflows.mjs` 的
`ci-go-vet` 策略钉成 **argv[1] 逐字 `./...`**（意图 = 静态分析面必须是整个 module）⇒
`go vet -tags=… ./...` 必红。两条路都不通，因此本片**刻意不动那一步**，缺的那一半由
`make check-tags`（对每个组合真的跑一次 `go vet`）补上。**不要**为了这一步去注册
`GOFLAGS` 之类的环境键（`PINNED_ENV_ALLOWED_KEYS` 是白名单制，而 `GOFLAGS` 同时给出
`-toolexec` 通道 = 在判据步骤里任意执行代码）；也**不要**为此放宽 `ci-go-vet` 的 argv 口径 ——
若确实要让 CI 的 vet 覆盖发布态组合，那是"改守卫口径"这类需要单独评审的动作（一行：把
`argv[1]` 换成"第一个不以 `-` 开头的词"），属于 P1 第二片或更后面的决定。

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

**③ 里"关掉的那一半"现在是显式的预期失败**（`⏳`，不影响退出码）：本片没有条件化编译，
关掉模块时包树照样在。第二片接线完成后用 `--expect-cut` 把它转成拦门禁；`--expect-cut=<模块,…>`
是探针形态（对所有组合套一组指定的裁剪集，**必须变红**，用来证明这条判据不是空转）。

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
5. **CI 的 `go vet` 仍只覆盖"不带 tag"这一种组合**（§3 的原因）；发布态组合的 vet 覆盖
   目前只在 `make check-tags` 里。

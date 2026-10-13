# webadmin 变体：`FEATURES` 构建开关与被关闭模块的页面裁剪

**状态**：已实施（webadmin 侧**真裁剪**：关闭的模块其页面代码不进 `dist`）
**日期**：2026-10-14
**相关**：[渠道声明功能模块（`features`）——编译期契约](./2026-10-13-channel-feature-modules.md)（P0：模块名 / 变体标识 / 哨兵串）、
[服务端可选模块的编译期开关（`-tags`）](./2026-10-14-server-build-tags.md)（P1：Go 侧接线与变体矩阵判据）、
[功能模块编译期拆分设计稿](../planning/2026-10-13-feature-split-build-time.md)

---

## 1. 这一片做了什么（一句话）

webadmin（内嵌进服务端二进制的 shadcn SPA）的构建接受**同一个变体标识** `FEATURES=<变体标识>`
（P0 §5 的 `features_variant`），被关闭模块的**页面代码从 `dist` 里消失**（不是"藏起来"——
chunk 根本不产出、路由与侧栏条目也不注册），并且这件事有**产物级双侧判据**。

P1 只做了 Go 侧的 tag 接线（开了等于没开）；P0 只定了模块名、变体标识与哨兵串。**这一片是
第一个真的按开关裁掉东西的**：管理端不再出现"服务端已经裁掉、页面还在"的运维入口。

## 2. 变体口径（**编码**）与它为什么这么定

| `FEATURES=` | 开启模块 | Go 侧同一变体 |
| --- | --- | --- |
| （环境变量未设置） | 三个全开 | `GO_TAGS` 缺省 = `skills,apps,connectors` |
| `skills,apps,connectors` | 三个全开（**发布态**） | `-tags=skills,apps,connectors` |
| `apps,connectors` / `skills` / … | 逗号分隔的子集，**顺序无关**（输出按契约顺序归一） | `-tags=apps,connectors` |
| `none` | 三个全关（最小内核） | `-tags=`（**空 tag 集**） |
| `''`（空串） | **判据报错**（不是"全关"、也不是"全开"） | `-tags=`（空 = 全关） |

三条硬约束：

1. **同一个串**。`FEATURES` 与 Go 的 `-tags` 是 P0 §5 那个 `features_variant` 的两种编码，
   **不得各自按三个布尔重拼**（重拼就会出现"镜像里有 apps、管理端里没有"这种半通状态）。
   本片把"两种编码的翻译"收敛到**一个位置**：`server/Makefile` 的
   `FEATURES ?= $(if $(strip $(GO_TAGS)),$(GO_TAGS),none)` —— 唯一输入仍是 `GO_TAGS`。
2. **`none` 是显式取值，空串不是**（P0 §5 的原话：空串在 shell/CI 里到处都是"没设置"的歧义）。
   `FEATURES=`（空串）会让构建**当场失败**并提示改用 `none`：把它当"全关"会让
   `--build-arg FEATURES=` 这种手滑静默产出一个空管理端；当成"全开"则与同一行 Go 参数
   的含义相反。两种猜法都会造出半通状态，所以这里要求写清楚。
3. **缺省必须"既有行为不变"**：不设 `FEATURES` ⇒ 三个全开 ⇒ 产物与本改造之前同源。

解析只有一份实现：`server/webadmin/features.mjs`（零依赖）。构建链 `vite.config.ts`、
测试链 `vitest.config.ts` 与产物判据 `scripts/check-feature-chunks.mjs` 都从它派生 ——
三处各写一遍解析就是三套口径，其中一套把 `none` 当成"没设置"时没有任何红灯。

## 3. 机制：为什么逐模块**布尔字面量**（而不是"变体串 + `.includes()`"）

打包器（vite 5 / rollup 4）的分支折叠**只认字面量**。本片实测（同一份入口、只换守卫写法）：

| 守卫写法（`define` 注入的值） | `false` 分支的动态 `import()` |
| --- | --- |
| `__FEATURE_X__ ? () => import('./p') : null`（`__FEATURE_X__='false'`） | chunk **不产出** ✅ |
| `__FEATURES__ === 'x' ? () => import('./p') : null`（`__FEATURES__='y'`） | chunk **不产出** ✅ |
| `__FEATURES__.includes('x') ? () => import('./p') : null`（`__FEATURES__='["y"]'`） | chunk **照样产出** ❌ |
| `{__FEATURE_X__ && <Route … />}`（React JSX，`false`） | 元素与它引用的页面一起消失 ✅ |

所以 `features.mjs` 的 `featureDefines()` 注入的是**每模块一个布尔字面量**
（`__FEATURE_SKILLS__` / `__FEATURE_APPS__` / `__FEATURE_CONNECTORS__`）+ 变体串本身
（`__FEATURES__`，只用于"这份产物是哪个变体"的可观测性），三者来自**同一次解析**。

接线点（三处，缺一处就是半通状态）：

- **页面**：`src/App.tsx` 的模块页懒加载写成 `__FEATURE_X__ ? lazy(() => import(…)) : DisabledPage`；
- **路由**：同一个 `src/App.tsx` 的 `<Route>` 写成 `{__FEATURE_X__ && (<Route … />)}`
  （守卫**同时**包住 `import()` 与 `<Route>`，只守一处会留下"路由在、页面不在"的白屏或"页面在、
  路由不在"的死 chunk）；
- **登记表**：`src/lib/nav.ts` 的侧栏条目与 `src/lib/routes.ts` 的路由登记表按开关过滤
  （模块条目声明在 `FEATURE_NAV_ENTRIES` / `FEATURE_ROUTE_ENTRIES`，用 `module` 字段连接开关）。

模块边界（与 Go 侧的包树一一对应，改一处必须改另一处）：

| 模块 | 侧栏/路由 | 页面源文件 |
| --- | --- | --- |
| `skills` | `/capabilities`（`/marketplace` 老书签重定向） | `src/pages/CapabilityCenter.tsx` |
| `apps` | `/app-center`、`/app-center/opens`、`/app-center/limits`（`/app-platform` 老书签重定向） | `src/pages/app-center/{AppCenterLayout,Apps,OpensBoard,Limits}.tsx` |
| `connectors` | `/connectors` | `src/pages/Connectors.tsx` |

## 4. 判据在哪（三条，独立通道）

| 判据 | 面 | 判什么 |
| --- | --- | --- |
| `src/lib/features.test.ts` | **源码形态**（毫秒级） | 模块名字面量与顺序；开关表三个键全在且是布尔；`FEATURES_VARIANT` ⟺ 逐模块布尔（同一次解析）；**守卫形态**：每个模块页的 `import()` 必须写在 `__FEATURE_<MODULE>__ ? lazy(…) : …` 里，且不得再有静态 import |
| `src/lib/routes.test.ts`、`src/lib/nav.test.ts` | **按变体给期望** | 双向对拍在**两侧**都成立：产物侧 `PARSED`（按开关过滤）↔ `ROUTE_REGISTRY`（同样过滤）；声明侧 `PARSED_ALL` ↔ `DECLARED_ROUTE_REGISTRY`（含关闭模块，**每一种变体下都成立**）。权限点前向守卫读声明表 ⇒ 关掉模块**不会**让它的权限点从闸门视野里消失；同时新增"声明表不是停车场"（开启的模块其条目必须逐条真的进侧栏） |
| `scripts/check-feature-chunks.mjs`（`npm run check:features`） | **产物字节**（分钟级） | 真跑 **5 次** `vite build`：全开 / 全关 / 逐个关闭。每次双侧断言：关闭的模块其**哨兵串**不在 dist、其**页面 chunk 文件名**不产出；开启的模块两侧都必须存在。另有反空转（每次构建必须真的产出核心页 chunk 与 `index.html`）与前置检查（源文件里没有哨兵串 ⇒ 退出码 2，与"产品错了"的 1 分开） |

**为什么产物判据必须真跑构建**：形态对不等于产物对（插件版本、`manualChunks`、新增一条静态
import 都能让"源码看着对、chunk 照样产出"）。**变异证据**（本片实测）：把 `connectors` 的守卫
从 `__FEATURE_CONNECTORS__ ? …` 改成 `__FEATURES__.includes('connectors') ? …`（语义仍正确，
只是折不掉）⇒ `features.test.ts` 红，且 `check:features` 的 `关 connectors` / `全关` 两行红
（哨兵串与 `Connectors-*.js` 都还在），而 `skills` / `apps` 两行照旧绿 —— 逐模块矩阵确实能定位到
"哪一个模块漏了"，不是一刀切。

**哨兵串**（P0 §6 的三条纪律在这里同样适用）：`picoaide.feature.<module>.v1`，写在该模块
**真的会渲染**的那条路径上（页面根元素的 `data-feature-sentinel`），不是躺在常量模块里 ——
没被引用的字符串会被打包器一起丢掉，那样"产物里没有这个串"就既可能是"模块被裁掉了"、
也可能只是"串没了"。判据**必须双侧**：只判"关闭变体里没有"是恒真的（一个空产物也满足）。

## 5. 构建命令

```bash
# 本地：全开（缺省，行为与本改造之前同源）
cd server/webadmin && npm ci && npm test && npm run build

# 本地：某个变体（测试与构建读同一个开关）
cd server/webadmin && FEATURES=apps,connectors npm test && FEATURES=apps,connectors npm run build

# 变体产物双侧判据（5 次构建，约 1 分钟；不开 = 不拦）
cd server/webadmin && npm run check:features

# 服务端 + 管理端**一起**选变体（唯一输入是 GO_TAGS，webadmin 侧自动翻译成 none）
make -C server build-server GO_TAGS=apps,connectors      # 关掉技能面
make -C server build-server GO_TAGS=                      # 三个全关（FEATURES 自动 = none）

# 发布门禁（含变体产物判据）：gofmt + vet + go test + webadmin 单测 + 变体判据 + webadmin 构建
make -C server check

# 服务端侧（Go）变体矩阵，与本片成对
make -C server check-tags

# 镜像：Dockerfile 的 webadmin stage 与前两个 stage 拿的是同一个变体
make -C server docker-image GO_TAGS=apps,connectors
# 等价的手工形态（Dockerfile 头部的示例同样适用）：
#   docker build --build-arg GO_TAGS=apps,connectors --build-arg FEATURES=apps,connectors …
```

`server/Dockerfile` 的 webadmin stage 从本片起有 `ARG FEATURES=skills,apps,connectors` +
`ENV FEATURES=$FEATURES`（用 ENV 而不是把变量写进 `RUN`：`npm run build` 整条链
`tsc -b && vite build` 都要能读到同一个值）。不传该 build-arg ⇒ 缺省全开 ⇒
镜像内容与本改造之前同源。

## 6. **服务端与 webadmin 的变体必须一起选**（否则是"半通"状态）

Go 的 `-tags` 决定**接口在不在**，webadmin 的 `FEATURES` 决定**页面在不在**。两者不一致时：

| 形态 | 现象 |
| --- | --- |
| 服务端裁了、管理端没裁 | 管理员点得进菜单，页面里每个请求 404 —— 看起来像"服务端坏了" |
| 管理端裁了、服务端没裁 | 接口在、页面不在，等于少了个运维入口；排查时会怀疑"功能是不是没实现" |

两种形态**都不会有任何红灯**（两侧各自的判据都只看自己那半边）。所以：

- 构建入口把两者的翻译收敛到**一个变量**（`GO_TAGS`，见 §2 约束 1）；
- 本片**没有**把"服务端变体 == webadmin 变体"做成端到端判据（要等镜像构建期真的从渠道配置
  解析出变体之后 —— 见 §7 第 1 条）。在那之前，这条靠"只覆盖一个变量"的入口纪律。

## 7. 本轮**没有**做的事 / 下一片要做什么

1. **没有接渠道配置 → 构建参数**：`FEATURES` 目前只能由构建方（`make` / `docker build` /
   CI）显式传。P0 §5 已经点明这是"下一轮的显式选择"——镜像里的 `channel.json` **没有**
   `features_variant`（它是私有仓原文），所以要么在镜像构建期用同一个解析器从渠道目录原文算，
   要么先把派生键写进 `channels-context/` 快照。**这一片没有接线**，因此"渠道关掉某模块"
   目前还不会自动改变镜像内容。
2. **没有把产物判据接进 CI**：`npm run check:features` 进了 `make check`（本地发布门禁），
   但 CI 的 `server` job 目前只跑 `npm test`。它是分钟级的（5 次构建），接进 CI 的位置与
   P1 的 `check-tags` 一样需要单独决定（那时两者可以合成一个"变体矩阵"job）。
3. **没有做服务端侧真正的条件编译**：那是 P1 文档 §5 的第二片（本片只动 webadmin 侧）。
   Go 侧仍把三个模块的包编进二进制（`check-tags` 的 `⏳` 行就是这件事的账）。
4. **没有给"非模块页"加开关**：`skills` 面在管理端只有能力中心一条入口（`/capabilities`）；
   技能相关的**子页**（市场 / 智能体 / 审批 / 平台内置）是它的 tab，随它一起进出，
   不单独设开关（单设会让"能力中心在、某个 tab 不在"变成新的半通形态）。

## 8. 已知边界（认账）

- **`FEATURES` 空串 = 报错**（§2 约束 2）：这意味着 `docker build --build-arg FEATURES=`
  会失败。这是刻意的（歧义必须在构建期炸掉，而不是产出一个语义不明的管理端）；
  `make` 入口已经把 Go 的空 tag 集翻译成 `none`，正常路径不会遇到。
- **chunk 文件名是 Vite 的命名约定**（`<模块文件名>-<hash>.js`）。产物判据的结构面依赖它；
  Vite 改命名规则时它会红（红在"反空转 / 结构面"那几条），届时按新规则更新判据即可 ——
  这是**刻意**的选择：宁可红一次并留下一条"口径要跟着改"的记录，也不要一个只在文件名上成立的判据。
- **关闭分支里的 `DisabledPage` 占位组件**：只为了让 JSX 的类型面保持"永远是一个组件"
  （`tsc` 会检查两个分支，死分支也一样）。折叠后它与死分支一起消失，不进产物。
- **判据只覆盖"页面代码不进 dist"**，不覆盖"被裁掉的接口在服务端是否真的 404"
  （那是 P1 第二片的事）。

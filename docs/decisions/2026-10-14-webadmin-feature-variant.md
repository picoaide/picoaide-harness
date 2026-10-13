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
模块页 chunk 根本不产出、`<Route>` 也不注册），并且这件事有**产物级双侧判据**。

> **"消失"的边界（2026-10-14 独立审计 P2-4；口径是实测的，不是推断）**：真裁剪面 = **模块页
> chunk** + **`<Route>` 元素**。侧栏的**声明数据**按设计留在产物里 —— `src/lib/nav.ts` 的
> `FEATURE_NAV_ENTRIES`（每个模块条目的路径 / 标签 / 图标）被 `NAV_ENTRIES` 的
> `FEATURE_NAV_ENTRIES.filter((entry) => isFeatureEnabled(entry.module))` 在**运行期**裁掉，
> 而 `.filter()` 是运行期调用 ⇒ 数据本身必须打进 chunk。所以 `FEATURES=none` 的产物里
> **grep 得到被关模块的路径与标签**（实测：`grep -rl '/connectors'` 命中 `assets/index-*.js`，
> `连接器` 命中 3 个文件，`/capabilities`、`能力中心`、`/app-center`、`应用中心` 各命中 1 个；
> 同一文件里 `FEATURE_ENABLED` 已被折叠成 `{skills:!1,apps:!1,connectors:!1}`），而同一产物里
> 六个模块页 chunk（`CapabilityCenter` / `Connectors` / `AppCenterLayout` / `Apps` /
> `OpensBoard` / `Limits`）**一个都不存在**。也就是说：**`grep 连接器 dist` 是误导性阳性**，
> "这个模块不在产物里"的判据面是"页面代码与路由不在"，不是"模块名一个字节都不在"。要字节级
> 清零就得把声明表也做成编译期条件 —— 代价是权限点前向守卫的声明面必须在别处重建
> （`nav.test.ts` 的"关掉模块不让它的权限点从闸门视野里消失"正是靠这张表成立，见 §4），
> 本片刻意不付这个代价。

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
  **这一处是运行期裁剪，不是编译期裁剪**（与上面两条的差别必须记住）：声明表
  （`FEATURE_NAV_ENTRIES` / `DECLARED_NAV_ENTRIES` / `DECLARED_ROUTE_REGISTRY`）**按设计留在
  产物里**，由 `isFeatureEnabled()` 在运行期把它滤掉 —— 侧栏因此不会出现被关闭模块的条目
  （那是判据 `nav.test.ts` 咬的地方），但**路径 / 标签 / 图标这几个字符串仍在 index chunk 里**
  （见 §1 的边界框）。要"字节级清零"就得把声明表也做成编译期条件，代价是权限点前向守卫
  （`nav.test.ts`）失去声明面 —— 那正是它成立的前提，所以不做。
  真裁剪面（编译期折叠：它们**不进产物**）= **模块页 chunk**（判据在产物字节上）
  + **`<Route>` 与被守卫的 `import()`**（判据在源码图上）。

模块边界（与 Go 侧的包树一一对应，改一处必须改另一处）：

| 模块 | 侧栏/路由 | 页面源文件 |
| --- | --- | --- |
| `skills` | `/capabilities`（`/marketplace` 老书签重定向） | `src/pages/CapabilityCenter.tsx` |
| `apps` | `/app-center`、`/app-center/opens`、`/app-center/limits`（`/app-platform` 老书签重定向） | `src/pages/app-center/{AppCenterLayout,Apps,OpensBoard,Limits}.tsx` |
| `connectors` | `/connectors` | `src/pages/Connectors.tsx` |

## 4. 判据在哪（四条，独立通道）

| 判据 | 面 | 判什么 |
| --- | --- | --- |
| `src/lib/features.test.ts` | **源码形态**（毫秒级） | 模块名字面量与顺序；开关表三个键全在且是布尔；`FEATURES_VARIANT` ⟺ 逐模块布尔（同一次解析）；**守卫形态**：每个模块页的 `import()` 必须写在 `__FEATURE_<MODULE>__ ? lazy(…) : …` 里，且不得再有静态 import |
| `src/lib/features.test.ts`（P3 第三片新增） | **源码图**（毫秒级） | 同一个文件里另有三条，实现共用 `server/webadmin/scripts/feature-page-graph.mjs`：① `App.tsx` 里被守卫的 `import()` ⟺ 本判据的模块页表**双向**对拍；② 页表里**每个**文件都带本模块哨兵并渲染它；③ **模块页 / 模块私有代码只能经守卫的 `import()` 进入**（静态引用、未被守卫的动态 `import()`、跨模块引用、核心页引用全部红） |
| `src/lib/routes.test.ts`、`src/lib/nav.test.ts` | **按变体给期望** | 双向对拍在**两侧**都成立：产物侧 `PARSED`（按开关过滤）↔ `ROUTE_REGISTRY`（同样过滤）；声明侧 `PARSED_ALL` ↔ `DECLARED_ROUTE_REGISTRY`（含关闭模块，**每一种变体下都成立**）。权限点前向守卫读声明表 ⇒ 关掉模块**不会**让它的权限点从闸门视野里消失；同时新增"声明表不是停车场"（开启的模块其条目必须逐条真的进侧栏） |
| `scripts/check-feature-chunks.mjs`（`npm run check:features`） | **产物字节**（分钟级） | 真跑 **5 次** `vite build`：全开 / 全关 / 逐个关闭。每次双侧断言：关闭的模块其**哨兵串**不在 dist、其**页面 chunk 文件名**不产出；开启的模块两侧都必须存在。另有反空转（每次构建必须真的产出核心页 chunk 与 `index.html`）与前置检查：**逐页哨兵 + 页表双向 + 源码图三条**（缺项退出码 2；源码图上就有泄漏时退出码 1，构建之前即红） |

**为什么源码图那三条是必需的**（P3 第三片的直接动因，2026-10-14 独立审计 M6）：模块页被
**静态**引用时，Vite 把它内联进引用方的 chunk —— **结构面**（动态 chunk 名）看不见它，
**内容面**只在这个文件自己带哨兵时才看得见。审计的实测形态：在核心页 `src/pages/Users.tsx`
顶部写 `import AppsProbe from './app-center/Apps'`（外加防 tree-shaking 的 `globalThis` 副作用），
`FEATURES=skills,connectors` 的 `assets/Users-<hash>.js` 里带着应用中心的页面代码，而当时的
5 个变体判据**全绿**（apps 的哨兵当时只在 `AppCenterLayout.tsx` 上，被拉进来的是 `Apps.tsx`）。
所以两条一起补：**哨兵下移到每个模块页**（内容面的覆盖面 = 页表）**+ 源码图判据**（不依赖
打包器的 tree-shaking 行为，边的存在本身就是红灯）。

**为什么产物判据必须真跑构建**：形态对不等于产物对（插件版本、`manualChunks`、新增一条静态
import 都能让"源码看着对、chunk 照样产出"）。**变异证据**（2026-10-14 在 `db0b985e0e` 上实跑，
两个变异各自落在**不同的层**上，退出码与输出都照抄 —— 这条更正来自同日独立审计 P2-2：本节
第一版写的"改守卫 ⇒ `check:features` 两行红"在**第二个提交加上源码图前置检查之后**已经不可能
出现，因为那种写法先在源码图上被拦下、5 次构建一次都没启动）：

| 变异 | 落在哪一层 | `npx vitest run src/lib/features.test.ts` | `npm run check:features` |
| --- | --- | --- | --- |
| ① 守卫写法：`src/App.tsx` 的 `__FEATURE_CONNECTORS__ ? lazy(…) : DisabledPage` → `__FEATURES__.includes('connectors') ? …`（语义仍正确，只是折不掉） | **源码形态** | 红（`3 failed \| 4 passed`：`每个模块页的 import() 都必须写在 __FEATURE_<MODULE>__ ? lazy(…) : … 里` / `App.tsx 里被守卫的 import() ⟺ 本判据的模块页表` / `模块页只能经 __FEATURE_<MODULE>__ 守卫的 import() 进入产物`） | **EXIT=2** —— 5 次构建**一次都没启动**，只打印 `模块 connectors 的页表列了 src/pages/Connectors.tsx，但 src/App.tsx 里没有对应的 __FEATURE_CONNECTORS__ ? lazy(() => import('…')) 守卫` |
| ② 打包期折叠：源码守卫一字不改，只在 `features.mjs` 的 `featureDefines()` 里把 connectors 的 define 换成打包器折不掉的表达式（`globalThis.__AUDIT_PROBE__`） | **产物字节** | 红（`2 failed \| 5 passed`：`开关表三个键全在…` / `变体标识 ⟺ 逐模块布尔…`） | **EXIT=1** —— `关 connectors` / `全关` 两行各 ✗ 2 项（哨兵串 `picoaide.feature.connectors.v1` **与** `Connectors-*.js` 两条通道都点名），`全开` / `关 skills` / `关 apps` 三行照旧 ✓，收尾 `check-feature-chunks: 4 项不符合预期` |

两行的差别就是**判据分层**的价值：形态类变异（①）在毫秒级的源码图上先红，成本最低、定位最准；
只有绕过形态层的变异（②）才走到分钟级的产物面，而那时**内容面（哨兵串）与结构面（chunk 名）
同时点名**，逐模块矩阵能定位到"哪一个模块漏了"，不是一刀切。②里的 `关 connectors`/`全关` 两行
红而 `skills`/`apps` 两行绿，就是这一点。

**哨兵串**（P0 §6 的三条纪律在这里同样适用）：`picoaide.feature.<module>.v1`，写在**该模块
每一个页面文件**里（页面根元素的 `data-feature-sentinel`，落点表 = 本片 §3 的模块边界表与
`check-feature-chunks.mjs` 的 `MODULE_EXPECTATIONS[*].pages`，并由
`scripts/verify-ci-scripts.mjs` 第 19 节登记对拍），不是躺在常量模块里 —— 没被引用的字符串会被
打包器一起丢掉，那样"产物里没有这个串"就既可能是"模块被裁掉了"、也可能只是"串没了"。
判据**必须双侧**：只判"关闭变体里没有"是恒真的（一个空产物也满足）。

**逐页哨兵的覆盖面为什么是页表而不是"每模块一个文件"**：内容面回答的是"这个文件的代码进没进
产物"，而静态引用发生时被拉进来的是**那个具体的文件**（审计 M6 拉进来的是 `Apps.tsx`，而当时
唯一的 apps 哨兵在 `AppCenterLayout.tsx` 上）。所以页表里每个文件各自带串是量具的一部分，
`check-feature-chunks.mjs` 的前置检查与 `features.test.ts` 都会逐页判它。

## 5. 构建命令

```bash
# 本地：全开（缺省，行为与本改造之前同源）
cd server/webadmin && npm ci && npm test && npm run build

# 本地：某个变体（测试与构建读同一个开关）
cd server/webadmin && FEATURES=apps,connectors npm test && FEATURES=apps,connectors npm run build

# 变体产物双侧判据（5 次真构建，实测 51s～1m04s；`make check` 与 CI 的 server job 都跑它）
cd server/webadmin && npm run check:features

# 变体**测试**矩阵：4 个非缺省变体各跑一遍完整单测（实测 4m36s～5m17s；`make check` 与 CI 同一条命令）
make -C server webadmin-variant-tests

# 服务端 + 管理端**一起**选变体（唯一输入是 GO_TAGS，webadmin 侧自动翻译成 none）
make -C server build-server GO_TAGS=apps,connectors      # 关掉技能面
make -C server build-server GO_TAGS=                      # 三个全关（FEATURES 自动 = none）

# 发布门禁（含变体测试矩阵 + 变体产物判据）：gofmt + vet + go test + webadmin 单测/矩阵/产物判据 + webadmin 构建
make -C server check

# 服务端侧（Go）变体矩阵，与本片成对
make -C server check-tags

# 镜像：Dockerfile 的 webadmin stage 与 Go stage 拿的是同一个变体
make -C server docker-image GO_TAGS=apps,connectors
# 等价的手工形态（**必须成对传**；Dockerfile 里有一条 fail-loud 断言，只传一个当场构建失败）：
#   docker build --build-arg GO_TAGS=apps,connectors --build-arg FEATURES=apps,connectors …
# 三个全关时 Go 侧是空 tag 集、webadmin 侧是显式 none：
#   docker build --build-arg GO_TAGS= --build-arg FEATURES=none …
```

`server/Dockerfile` 的 webadmin stage 从本片起有 `ARG FEATURES=skills,apps,connectors` +
`ENV FEATURES=$FEATURES`（用 ENV 而不是把变量写进 `RUN`：`npm run build` 整条链
`tsc -b && vite build` 都要能读到同一个值）。不传该 build-arg ⇒ 缺省全开 ⇒
镜像内容与本改造之前同源。

**两个 build-arg 必须成对**（2026-10-14 独立审计 P2-5 的收口）：同一个 stage 里还有
`ARG GO_TAGS=skills,apps,connectors`，紧跟一条 `RUN` 断言 —— 读了两个 build-arg、做
`none` ⟺ 空 tag 集的翻译、不一致时 `exit 1` 并打印该传什么。实测（BuildKit + 本地缓存
`node:24-alpine`，只把 `npm ci` / `npm run build` 两条网络层替换成占位）：四条路径里
"成对传"与"都不传"通过、"只传 GO_TAGS"与"只传 FEATURES"**当场失败（exit 1）**，且
`npm ci` 层跨变体仍命中缓存（那个坑由 §5 的 `ARG`/`ENV` 位置保证）。判据在
`scripts/verify-ci-scripts.mjs` 第 19 节（要求那条断言存在、完整、且位置在
`ARG FEATURES=` 之后与 `RUN npm run build` 之前；谓词自带 1 正 3 负的量具自检）。

## 6. **服务端与 webadmin 的变体必须一起选**（否则是"半通"状态）

Go 的 `-tags` 决定**接口在不在**，webadmin 的 `FEATURES` 决定**页面在不在**。两者不一致时：

| 形态 | 现象 |
| --- | --- |
| 服务端裁了、管理端没裁 | 管理员点得进菜单，页面里每个请求 404 —— 看起来像"服务端坏了" |
| 管理端裁了、服务端没裁 | 接口在、页面不在，等于少了个运维入口；排查时会怀疑"功能是不是没实现" |

两种形态**都不会有任何红灯**（两侧各自的判据都只看自己那半边）。所以：

- 构建入口把两者的翻译收敛到**一个变量**（`GO_TAGS`，见 §2 约束 1）；
- 本片**没有**把"服务端变体 == webadmin 变体"做成端到端判据（要等镜像构建期真的从渠道配置
  解析出变体之后 —— 见 §7 第 1 条）。在那之前，**镜像这一层**靠 Dockerfile 里那条 fail-loud
  断言（P2-5 收口：两个 build-arg 不一致 ⇒ 构建失败，见 §5）+ `make` 入口把翻译收敛到
  `GO_TAGS` 一处；`make docker-image` 与 `scripts/ci-build-channel-images.sh` 两条入口分别
  成对传值 / 都用缺省，正常路径不受影响。

## 7. 本轮**没有**做的事 / 下一片要做什么

1. **没有接渠道配置 → 构建参数**：`FEATURES` 目前只能由构建方（`make` / `docker build` /
   CI）显式传。P0 §5 已经点明这是"下一轮的显式选择"——镜像里的 `channel.json` **没有**
   `features_variant`（它是私有仓原文），所以要么在镜像构建期用同一个解析器从渠道目录原文算，
   要么先把派生键写进 `channels-context/` 快照。**这一片没有接线**，因此"渠道关掉某模块"
   目前还不会自动改变镜像内容。
2. **变体判据的调度点**（P3 第三片已接线，2026-10-14 独立审计 P1）：本片第一版把
   `npm run check:features` 只放进本地 `make check`，CI 的 `server` job 只跑缺省的 `npm test`
   —— 而 `nav.test.ts` / `routes.test.ts` 是**按变体给期望**的，于是"关闭变体会坏"这一类回归
   （实测 M3：删掉 `nav.ts` 的开关过滤 ⇒ `FEATURES=skills,apps npm test` 红，而全开门禁与产物
   判据全绿）在 CI 上无人拦。现在三处都是调度点：`server/Makefile` 的
   `webadmin-variant-tests`（4 个非缺省变体）+ `webadmin-check-features`，前者被 `make check`
   调用，两者都由 CI 的 `server` job 起（存在性由 `scripts/verify-ci-scripts.mjs` 第 19 节判，
   删任一处即红）。**注意**：这一片**没有**把"服务端变体 == webadmin 变体"做成端到端判据
   （要等镜像构建期真的从渠道配置解析出变体之后，见第 1 条）—— 现在判的是"三处缺省值同源"
   （Dockerfile 两个 ARG ↔ Makefile 的 `GO_TAGS ?=` ↔ `features.mjs` 的缺省变体）。
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
- **源码图判据是文本级扫描，不是 TypeScript 编译器**（`feature-page-graph.mjs`）：为的是跑在
  每次 `npm test` 里（毫秒级）。代价与口径：`import type` / `export type` 被显式排除（编译期
  抹掉，不是运行时边）；只解析相对说明符与 `@/` 别名（其余是外部依赖，不可能是本仓页面）；
  测试文件不入图（它们 import 页面是正常形态）；注释里写的 `import('…')` 会被当成边 ——
  真出现时红灯指向那一行，改注释即可。**不覆盖**的是"同一个文件被复制粘贴成另一份"
  （那属于代码重复，不是变体裁剪面）。
- **变体测试矩阵的成本**：4 个非缺省变体 × 完整套件实测 **4m36s**（2026-10-14 空载 4 vCPU）
  ～ **5m17s**（同日独立审计，load ~3.5）；产物判据 5 次真构建实测 **51s** ～ **1m04s**。
  两条加起来 ≈ 5.5–6.4 min，都算进 `server` job 的预算 —— 该 job 的 `timeout-minutes` 因此
  由 45 抬到 **60**（依据与算式写在 `ci.yml` 那一段注释里，同批更新：happy path 37.4 min ⇒
  1.60× 余量，最坏路径 42.4 min ⇒ 留 17.6 min 让 `-timeout 15m` 的 goroutine dump 一定打得出来；
  `check-workflows.mjs` 的 `[SK-7b]` 固定开销常量也同批由 5 改成 12，否则判据的模型还是旧账）。
  它换来的是"关闭变体会坏"这一类回归第一次有了自动拦截点；
  只跑变体相关的那几个测试文件会便宜得多，但"哪些文件是变体相关的"会变成一张要维护的表
  （少登记一个文件就静默缩面）。矩阵实现在 `server/webadmin/scripts/check-feature-variants.mjs`
  （`VARIANT_MATRIX` 是唯一真源，`scripts/verify-ci-scripts.mjs` 第 19 节真跑它读矩阵）。
- **侧栏声明数据留在产物里**（§1 的边界框，2026-10-14 独立审计 P2-4）：被关闭模块的
  路径 / 标签 / 图标仍进 index chunk，由运行期 `isFeatureEnabled()` 从侧栏里滤掉。
  **不是**缺陷（页面代码与 `<Route>` 是真裁剪），但 `grep 连接器 dist` 是误导性阳性 ——
  判据面与排障口径都要按"页面 chunk + 路由"来读。要字节级清零就得把声明表做成编译期条件，
  代价是权限点前向守卫失去声明面（见 §4），本片刻意不付。
- **两个变体 build-arg 在镜像这一层已经不能只传一个**（§5，2026-10-14 独立审计 P2-5）：
  Dockerfile 里的 fail-loud 断言会把"只覆盖一个变量"的手工形态当场拒掉（实测四条路径）。
  仍未做成端到端判据的是"镜像里服务端与 webadmin 的变体是否**语义**一致"（那要等 §7.1 的
  渠道配置接线）—— 现在保证的是"两个 build-arg 描述同一个串"。
- **判据只覆盖"页面代码不进 dist"**，不覆盖"被裁掉的接口在服务端是否真的 404"
  （那是 P1 第二片的事）。

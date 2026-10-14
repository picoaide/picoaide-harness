# 渠道声明功能模块（`features`）——编译期契约

**状态**：已实施（**只做契约与取值传递**；裁剪实现不在本轮）
**日期**：2026-10-13
**相关**：[渠道包参考](../planning/2026-09-10-channel-package-reference.md)、
[功能模块编译期拆分设计稿](../planning/2026-10-13-feature-split-build-time.md)
（同日设计稿，范围更大；**字段形态以本文为准**：开关是**三个叶键** `features.skills` /
`features.apps` / `features.connectors`，没有裸 `features` 键、也没有 `base` token ——
该稿 §1/§2.1 的措辞已按本文同步，两文冲突时以本文为准）、
官网《渠道与品牌》页（`site/src/content/docs/deployment/channels.md`）、
`desktop.platforms`（同族的"渠道声明 → 构建期收窄"，同一轮加入，无独立决策记录：
契约写在官网那一页与 `CHANNEL_PLATFORMS` 的注释里）

---

## 1. 为什么

有些渠道不需要某个功能模块 —— 客户没有对应的服务端能力、合规上不允许客户端出现某个入口、
或者只是不想为它承担体积与维护面。这类"不要"必须在**构建期**表达，因为：

- 交付物是签名/公证过的安装包与镜像，装到客户机器上之后再"关掉"没有任何机制；
- 模块的可见面（侧边栏入口、模型可见的工具、镜像内的组件）分散在客户端、服务端与
  webadmin 三处，运行期开关会让三处**各自漂移**（"界面里没有、工具却还能调"）；
- 编译期裁剪是唯一能把"客户拿到的东西里根本没有这个模块"讲清楚的口径。

本轮**只建立契约**：字段形态、唯一真源、构建期取值、输出点、哨兵串与文档。
真正按 `features` 裁剪客户端/服务端/webadmin 的实现是后续独立的一轮（见 §7）。

## 2. 字段

`channels/<channel-id>/channel.json` **顶层**新增一个可选键：

```jsonc
{
  "channel_id": "example-brand",
  "features": {
    "skills": true,       // 技能（技能中心 + 随包/下发技能）
    "apps": true,         // WASM 应用平台
    "connectors": false    // 连接器
  }
}
```

| 规则 | 取值 |
| --- | --- |
| **缺省** | **全开** —— 不写 `features` = 三个模块都要（基础功能恒开；既有渠道行为**逐字节不变**） |
| 键集合 | 只有 `skills` / `apps` / `connectors`（唯一真源：`FEATURE_MODULES`） |
| 取值 | 必须是布尔。字符串 `"false"` **不是** `false`（它在 JS 里是真值 ⇒ "以为关了其实没关"） |
| 未知键 | **拒绝**（不静默忽略：忽略的方向恒是"多交付一个模块"，而配置上完全看不出来） |
| 整体形态 | 必须是对象（数组/字符串/`null` 一律拒绝） |

**刻意不提供的语法**：没有"全关"的简写、没有 `features: false`、没有继承/覆盖语法。
少一个模块是**逐模块**的决定，让"忘了写"与"故意关"在配置上长得不一样。

## 3. 唯一真源

`packages/host/desktop/scripts/channel-constants.ts`（**零 import**，见该文件头注释的不变量）：

| 导出 | 作用 |
| --- | --- |
| `FEATURE_MODULES` | 模块清单（顺序即变体标识的顺序）——**唯一一份模块名清单** |
| `normalizeChannelFeatures(raw)` | 规范化：缺省全开；未知键/非法类型 **抛 `ChannelFeaturesError`**（不做"部分通过"，也不静默吞掉） |
| `channelFeaturesVariant(features)` | 规范化结果 → 稳定变体标识（`skills,apps,connectors` / `apps` / `none`） |
| `channelFeaturesVariantAssignment(features)` | 赋值形态 `FEATURES=<变体标识>` |
| `featureSentinel(module)` / `FEATURE_SENTINELS` | 哨兵串（§6） |

**为什么必须零 import**：这个模块要在"只 checkout、不 install 也不 build"的 release job 里
被 `node -e 'import(file://…)'` 读到（2026-09-28 的 tag 事故：常量曾经住在依赖工作区包的
模块里 ⇒ 整条 tag 发布链红在取渠道包那一步，而 PR/分支 CI 全绿）。
`packages/host/desktop/tests/channel-constants.spec.ts` 钉住这条不变量与三个探针的指向。

## 4. 校验层（构建期 fail-loud）

`scripts/ci-channels.sh` 逐渠道校验 `features`（键集合来自 `FEATURE_MODULES`，与
`desktop.platforms` 同一条路径）：

- 形状/取值/未知键任一不符 ⇒ `::error::` + 该渠道**本次没有产物**（不是 warning）；
- **不回显取值、也不回显未知键名**：两者都可能是客户品牌，而这条报错会进公开 Actions 日志
  （与 `assets` 的未知键同一口径：只报数量与合法集合）。

`features` 同时进了官方渠道模板键表 `CHANNEL_TEMPLATE_KEYS`（**逐模块列叶键**
`features.skills` / `features.apps` / `features.connectors`，不写裸 `features`：
只要对象存在就满足裸键，`"features": {}` 会让拷贝模板的新渠道看不到有哪几个模块可关）。
`--require-template` 因此要求官方渠道逐模块显式声明（值 = 现行兜底值 `true`，显式化本身不改变行为）。

> **上线前置（跨仓，且顺序有讲究）**：私有渠道仓的 `channels/official/channel.json` 需要
> 一次可评审的 diff 补上这三个键。四个 `--require-template` 调用点在此之前会以
> 「官方渠道配置缺少模板键: features.skills, features.apps, features.connectors」失败 ——
> 这正是"官方渠道 = 新增渠道的模板"这条判据该有的形态（`desktop.platforms` 加入时同形）。
>
> **红窗落在哪三个 job 上**（2026-10-13 独立审计 P0 的更正）：四个调用点里三个是**非 tag** 的
> 打包 job —— `desktop-linux`（`.github/workflows/ci.yml:1160`）、
> `desktop-windows`（`:1347`）、`desktop-macos`（`:1622`），它们的 `if` 条件使它们
> **非 docs-only 的每次 PR / push 都跑**；只有第四个是 tag 期的 `release`（`:1794`）。
> 也就是说："harness 先合并、私有仓随后补键"会把 **master 上每个 PR / push** 打红，而
> "补键之后才允许打 tag"那条 gate **拦不住**这段窗口 —— 它管的是 tag，管不到这三个 job。
>
> **零红窗的顺序是反过来**：**私有仓先补键 → 再合并本分支**（至少同一窗口完成）。
> 补键对**合并前**的 harness 完全无害，是一个可以先行、且不必与 harness 改动同时上线的动作：
> 那版 `scripts/ci-channels.sh` 里 `features` 零命中，未知顶层键不被拒绝（只有 `assets` 的
> 未知子键告警）。PR 正文与本分支的提交信息都复述这条顺序，审阅者据此推进。

## 5. 构建期取值、变体标识与**输出点**

`resolveChannelBuildContext()` 把渠道声明解析进 `ChannelBuildContext`：

- `features`：规范化后的三键布尔表（缺省全开由 `normalizeChannelFeatures()` 补）；
- `featuresVariant`：`channelFeaturesVariant()` 的派生结果 —— **派生只有这一份实现**。

**输出点（本轮的唯一一处）**：`stageChannelProfile()` 写随包 `build/channel.json` 时追加两个键
（私有仓原文不动，与 `logo_inline` 同一条纪律）：

```jsonc
{
  "features": { "skills": true, "apps": true, "connectors": false },
  "features_variant": "skills,apps"
}
```

`features` 给人读/逐模块判定用（**三个键全在**，下游不必再实现一次"缺省全开"）；
`features_variant` 给机器读（缓存键、变体目录名、`-tags` 列表就是它）。

**这个输出点覆盖到哪、覆盖不到哪**（2026-10-13 独立审计 P1 更正；请照这张表读，**不要**
照"客户端包与镜像都带它"读）:

| 面 | 实际形态 | 依据 |
| --- | --- | --- |
| **品牌渠道的客户端包** | **有**：随包 `build/channel.json` 带 `features` + `features_variant` | `channel-build.ts` 的 `stageChannelProfile()` |
| **官方渠道的客户端包** | **没有**：`official` 走**删除分支**（官方渠道或渠道目录不存在 ⇒ `clearChannelResidue()` 并返回 undefined）—— 官方渠道本来就没有随包 `channel.json` | `stageChannelProfile()` 开头那条分支 |
| **服务端镜像里的渠道内容** | 带的是**私有仓原文**：`ci-build-channel-images.sh` 把 `channels/<channel>/.` 整份拷进 `channels-context/`，Dockerfile 再 `COPY --from=channelassets` 进镜像 —— 里面**没有** `features_variant`；`features` 也只在私有仓自己写了才有（模板只强制 official 渠道） | `scripts/ci-build-channel-images.sh` 的拷贝段 + `server/Dockerfile` 的 `COPY --from=channelassets` |
| **release job（tag 期）** | 不跑 `channel-prepare` / `brand-prepare`，所以镜像这条路上不产生任何随包 profile | `.github/workflows/ci.yml` 的 `release` job |

### 消费契约（后续接线，**本轮不接线**）

| 消费者 | 取什么 | 从哪取 | 为什么必须是同一个串 |
| --- | --- | --- | --- |
| 客户端组装 | `features_variant` + `features` 三个布尔 | **随包 profile**（品牌渠道）；`official` 与"没有渠道目录"的本地构建没有 profile，只能由构建期解析器给 | 界面入口与宿主能力同源 |
| Go 编译（服务端镜像） | `-tags <features_variant>`（`none` 时给空 tag 集） | **不是**镜像里的 `channel.json`（那里没有这个键）—— 必须在镜像构建期由同一个解析器从渠道目录原文算出来 | 镜像里编进了哪个模块，必须与客户端一致 |
| webadmin 构建 | `--build-arg FEATURES=<features_variant>` | 同上（webadmin 在镜像构建期构建，读不到客户端随包 profile） | 管理面不得出现被裁掉模块的运维入口 |

**硬约束**：三处**只能**读同一个串（`FEATURES=<变体标识>`），不得各自按三个布尔重拼 ——
重拼就会出现"镜像里有 apps、客户端里没有"这种**半通状态**，而它不会有任何红灯。

**"这个串从哪来"必须先回答再接线**：唯一真源是 `normalizeChannelFeatures()` +
`channelFeaturesVariant()`（零 import 的常量模块，任何环境都能 `import(file://…)` 读到），
而本轮落地的输出点只是**其中之一**——品牌渠道的随包 profile。因此后续接线时，服务端镜像与
webadmin 这两条路要么由同一个解析器在镜像构建期解析私有仓原文，要么先把派生键写进镜像用的
渠道目录快照（`channels-context/`）—— 这是**下一轮的显式选择**，不是本轮已经实现的事实，
也不是"下游各自从镜像里的 `channel.json` 读现成值"。

## 6. 哨兵串（**端到端副证**，承重判据是依赖图/文件清单）

每个模块一个唯一常量：`picoaide.feature.<module>.v1`（`featureSentinel()` 派生），即
`picoaide.feature.skills.v1` / `picoaide.feature.apps.v1` / `picoaide.feature.connectors.v1`。

| 模块 | 落点（模块**自己的装配点**） |
| --- | --- |
| `skills` | `packages/host/capability-center/src/host/skill-telemetry.ts` 的 `apply()`（技能模块的 loader 行 `picoaide-skill-telemetry`；2026-10-13 P0-b 起随技能面从 `packages/host/enterprise` 搬入，见[功能模块的 host 面归属](./2026-10-13-module-host-face-ownership.md)） |
| `apps` | `packages/host/wasm-apps-host/src/index.ts` 的 `apply()` |
| `connectors` | `packages/host/connectors/src/index.ts` 的 `apply()` |

**webadmin 侧的落点**（同一批串的第二种消费面；2026-10-14 P3 第三片补登记）：管理端的产物裁剪
用**同一个**哨兵串判"关闭的模块其页面代码进没进 dist"，所以它也有落点、也必须由
`featureSentinel(module)` 派生：

| 模块 | webadmin 落点（**每个模块页各自一处**） |
| --- | --- |
| `skills` | `server/webadmin/src/pages/CapabilityCenter.tsx` |
| `apps` | `server/webadmin/src/pages/app-center/{AppCenterLayout,Apps,OpensBoard,Limits}.tsx` |
| `connectors` | `server/webadmin/src/pages/Connectors.tsx` |

两条落点纪律：

1. **逐页**，不是"每个模块一个文件"：内容面判的是"这个文件的代码进没进产物"，而模块页被
   **静态**引用时被拉进产物的是那个具体的文件（2026-10-14 独立审计 M6：apps 的哨兵当时只在
   `AppCenterLayout.tsx` 上，被拉进来的是 `Apps.tsx` ⇒ 关闭变体的产物里带着应用中心代码，
   而当时的 5 个变体判据全绿）。页表 = `server/webadmin/scripts/check-feature-chunks.mjs` 的
   `MODULE_EXPECTATIONS[*].pages`，与 `App.tsx` 被守卫的 `import()` **双向对拍**。
2. **落点表本身有判据**：`scripts/verify-ci-scripts.mjs` 第 19 节把 webadmin 侧每个落点与
   `featureSentinel()` 的返回值对拍（声明 + 真渲染），并扫"哨兵字面量出现在登记表之外的文件"
   ⇒ 命名规则变更时两侧不可能各自自洽地留在旧串上。

三条纪律（**每一条都对应一个已经踩过的失效形态**）：

1. **哨兵必须写在该模块真正被使用的那条路径上**（模块注册/装配时写入日志或登记表的那一处），
   不能只躺在一个常量模块里。未被引用的字符串会被打包器/链接器**一起丢掉** ——
   Go 侧实测：未被引用的函数、以及"被调用但返回值被丢弃"的路径都会掉串。串被优化掉之后，
   "产物里没有这个串"就既可能是"模块被裁掉了"、也可能只是"串没了"，判据失去意义。
2. **哨兵只是副证**。承重判据是**依赖图/文件清单**：模块的包是否真的没被打进产物。
   哨兵只回答"这条链路上我至少还看得见它"这一个更弱的问题。
3. **哨兵判据必须双侧**：只在"关闭变体里**不得出现**"上判是**恒真**的（一个空产物也满足）。
   必须同时判"开启变体里**必须出现**"，这个量具才算数。

## 7. 本轮**没有**做的事

- 没有按 `features` 裁剪任何东西：客户端组装、Go `-tags`、webadmin `--build-arg` 三处
  **一个都没有接线**（改了 `features` 目前不改变任何产物内容 —— 只改变**品牌渠道**随包 profile
  里的两个字段；官方渠道连随包 profile 都没有，见 §5 那张覆盖表）；
- 没有产物级的哨兵判据（要等裁剪实现落地，才有"关闭变体"可比）；
- 没有服务端/webadmin 侧的字段消费（服务端读渠道配置的路径是后续一轮的接口面）。

## 8. 判据在哪

`scripts/verify-ci-scripts.mjs` 第 3c 节，三层：

1. **真跑唯一真源**（`import` 常量模块）：缺省全开 ✅ / 显式关闭 ✅ / 未知键 ❌ / 非法类型 ❌ /
   非对象 ❌ —— 两个方向都判，于是两个典型变异体当场红：
   「缺省全开 → 缺省全关」（正例红）与「解析改成静默丢字段/静默忽略坏键」（负例红）；
2. **真跑 `ci-channels.sh`**：缺省全开的渠道集全绿（含官方渠道）、显式关闭全绿、
   四类坏声明各自红并点名字段，且失败信息不回显取值/未知键名（**合法模块名要打印**：
   官网《渠道与品牌》页承诺"报错点名字段与合法模块名"，模块名是公开常量、不是渠道身份）；
3. **官方模板 + 哨兵串 + 文档**：模板键表逐模块派生（漏一个模块即红）、
   模板缺键的负例真的红、哨兵串的命名从 `FEATURE_MODULES` 派生、并且必须是
   **`apply()` 体内值位置的可执行引用**（判据先扫出"代码位置的标识符"——注释、字符串字面量、
   模板文本里的名字都不算——再括号配对取出 `apply()` 的函数体，要求体内出现 `${IDENT}` /
   `+ IDENT` / `f(IDENT)` / `k: IDENT` 这类**读取**；只声明、只在注释里提一句、体内重声明遮蔽
   都不算）、契约文档必须存在且列出三个哨兵串。

   > **这条判据改过一次，理由必须留在案上**（2026-10-13 独立审计 P1）：第一版判的是
   > "标识符**文本**在 `apply()` 之后出现过"，于是"删掉 `apply()` 里唯一的可执行引用、
   > 只留一行提到它的注释"这个变异体**全绿**（与未变异基线逐条 diff：哨兵相关失败零条）——
   > 而那正是这条判据存在的唯一理由。改成"可执行引用"之后，第 3 层额外带一组**量具自检**：
   > 4 个合成正例（模板插值/拼接/实参/属性值）必须被接受、5 个合成负例（只剩注释 /
   > 只剩字符串里的名字 / 体内不出现 / 体内重声明遮蔽 / 只作属性键）必须被拒绝 ——
   > 判据若退回 `includes()` 式的写法，其它样本不会有任何反应，这一组是唯一的红灯来源。
   >
   > **它证明到哪为止**（别读宽）：它证明"`apply()` 体内存在一处**可执行的值位置读取**"，
   > 因而不属于"只声明过 / 只在注释或字符串里出现过"那一族；它**不**证明那处读取能活过
   > 后续的死代码消除（`if (false) { … }` 这类包裹仍会通过），也**不**证明串在产物里存在 ——
   > 后者是**产物级的双侧判据**（§6 纪律 3：开启变体里必须存在 / 关闭变体里必须缺席），
   > 要等裁剪实现落地才有得判；承重判据始终是依赖图/文件清单（§6 纪律 2）。

单元侧（`packages/host/desktop/tests/`）：`channel-constants.spec.ts` 钉零 import 不变量，
`channel-build.spec.ts` 钉"输出点真的写进了随包 profile"与畸形声明的 fail-loud。

## 9. 渠道 × 模块清单（2026-10-14 更新：单一真源 + 渠道缺省）

### 9.1 三份东西各自是谁

| 东西 | 在哪 | 谁维护 |
| --- | --- | --- |
| **模块清单 + 渠道缺省**（唯一真源） | 仓库根 `module-contract.json`（`id` / `goConst` / `title` / `defaultInChannel`，**顺序=契约**） | 改这里，然后跑生成器 |
| 各端清单**生成物** | `FEATURE_MODULES`（客户端 / webadmin）、`allModules`（Go）、`GO_TAGS ?=`（Makefile）、`ARG GO_TAGS=`/`ARG FEATURES=`（Dockerfile）、`-tags=`（ci.yml）、`features.<m>` 模板键族、**`FEATURE_MODULE_DEFAULTS`**（渠道缺省表） | 只由 `node scripts/gen-module-contract.mjs` 写；手改会被 `--check` 判红 |
| **某渠道的声明** | 私有仓 `channels/<id>/channel.json` 的 `features` | 渠道维护者（本仓看不到渠道身份） |

`defaultInChannel` 的语义：**渠道不写 `features.<m>` 时这个模块算不算要**（唯一真源；
`channel-constants.ts` 的 `normalizeChannelFeatures()` 缺键时**读表**）。纪律（硬约束）：

- 现有模块保持 `true` ⇒ **既有渠道行为零变化**（不声明 `features` 与改前逐字节相同）；
- **新增模块一律先设 `false`**：缺省不进任何渠道；要发给某渠道必须在它自己的
  `channel.json` 里显式写 `true`；
- 缺省 `true` 的模块数被棘轮 `MAX_MODULES_DEFAULT_ON`（`scripts/gen-module-contract.mjs`）
  卡住：想多一个默认开就得**显式改那个常量**，让"悄悄默认全开"出现在 diff 里被评审看见。

### 9.2 操作流程（三条路，都先跑 `--check`）

```bash
node scripts/channel-modules.mjs --list        # 系统有哪些模块、各自的渠道声明键与缺省
node scripts/channel-modules.mjs --template    # 生成可粘贴的 "features" 片段（不含任何渠道身份）
node scripts/channel-modules.mjs --explain <channel.json>   # 人读：声明/缺省/交付/裁掉/变体串
node scripts/channel-modules.mjs --check   <channel.json>   # 机读门禁：非法声明/读不到 ⇒ 非零退出
```

1. **新增渠道**：`node scripts/channel-modules.mjs --template` → 把打印出的 `"features"`
   片段贴进 `channels/<id>/channel.json` 顶层 → 按需把要关的模块改 `false` →
   `--check <那份 channel.json>` 必须 exit 0（私有渠道仓的 CI 用同一条命令）。
   官方渠道是模板：它的 `channel.json` 必须**逐键显式**（`CHANNEL_TEMPLATE_KEYS` 的
   `features.<m>` 族，判据在 `scripts/ci-channels.sh --require-template`）。
2. **给某渠道加/减模块**：只改那份 `channel.json` 的 `features` → `--check`。
   **不要**去改生成物 —— 渠道差异是数据，不是代码。
3. **系统新增模块**（四步，缺一步就有红灯）：
   1. `module-contract.json` 加一条 `{ id, goConst, title, defaultInChannel: false }`
      （**先 false**；要默认开必须同时上调 `MAX_MODULES_DEFAULT_ON`）；
   2. `node scripts/gen-module-contract.mjs` 重新生成（六个端 + 渠道缺省表一次到位）；
   3. **补结构面**（生成器**不**生成它们，`--check` 会逐条点名）：
      `packages/host/desktop/src/channel-features.ts` 的 `module: '<id>'`（按契约顺序追加）、
      `server/internal/router/optional_<id>_on.go`（首行 `//go:build <id>`）与
      `optional_<id>_off.go`（首行 `//go:build !<id>`）；
   4. `node scripts/gen-module-contract.mjs --check` ⇒ 0（真源的棘轮、生成物逐字节、
      结构面三层全过），再跑 `node scripts/verify-ci-scripts.mjs` ⇒ 0。

`--check` 的错误分三桶（`gen-module-contract.mjs --check`）：**真源问题**（改
`module-contract.json`）/ **生成区不一致**（跑生成器）/ **结构面缺失**（跑生成器**不会**修好，
按点名的文件:行人工补齐）。

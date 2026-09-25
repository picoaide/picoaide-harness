#!/usr/bin/env node
/**
 * 门禁**判据执行体**的 install 期完整性前置校验（第十二轮红队 R12-D-01 的 P0 收口）。
 *
 * ## 它防的是什么（现场，不是设想）
 *
 * `.yarnrc.yml` 的 `plugins:` 指向一个**可提交**的插件文件（`.gitignore` 的 `!.yarn/plugins`
 * 放行了它），插件的**顶层模块代码**在任何一次 `yarn` 调用时执行 —— 连 `yarn --version`
 * 都会（真 yarn 4.18.0 实测）。CI 的顺序是 `yarn install --immutable` → 判据步骤，于是：
 *
 *   1. PR 只提交两个文件：`.yarnrc.yml`（加 `plugins:`）与 `.yarn/plugins/<x>.cjs`；
 *   2. `install` 步加载插件 ⇒ 工作树里的 `scripts/check-*.mjs` 被**改写**成
 *      「打印通过凭据 + `process.exit(0)`」；
 *   3. `ci.yml` **一字未改**的三个判定块全部 `EXIT=0`（"17/17 通过"、"32/32 通过"、
 *      "锚定严格"），而**一条判据都没跑**。
 *
 * 同族的第二条通道是**工作区包**的 install 期生命周期钩子：`enableScripts: false` 只挡
 * 依赖的构建脚本，工作区自己的 `postinstall` 照样执行（真 yarn 实测），而当时的登记制
 * 只读根 manifest。
 *
 * ## 为什么必须是"第一个执行体"+ 独立实现
 *
 * 判据的判决只有在"判据本体还没被动过"时才可信。所以本脚本被设计成 CI 里
 * **任何 yarn/corepack 命令之前**的第一个执行体，且**不 import 仓内任何脚本**
 * （`check-workspaces.mjs` / `check-guard-parser-integrity.mjs` 本身就在"可能已被改写"
 * 的集合里）—— 只用 `node:*` 内置模块 + `git`，判据输入全部来自 **git 对象**
 * （`git show HEAD:<path>`），不是工作树里那份可以被 install 期改写的副本。
 *
 * ## 判据（全部 fail-closed；读不出输入 ⇒ 退出码 2，绝不静默通过）
 *
 *   ① **判据执行体逐字节等于 HEAD**：**执行体全集**（见下"执行体全集"）的 HEAD 侧与工作树侧
 *      取并集（检出后才新建的文件也算问题）+ `.yarnrc.yml` + `.gitignore` + 根 `package.json`
 *      + **根与每一个 workspace 包的 `package.json`** + **每一个非 workspace 的 npm 项目
 *      `package.json`**（`server/webadmin` / `site` 这类：CI 的 `npm ci` 在它的目录里跑，
 *      就会执行它声明的 install 期钩子）+ **每一个 `Makefile`**；
 *   ② 根 `.yarnrc.yml` 里**禁键** `yarnPath` / `plugins` 缺席、`enableScripts: false` 与
 *      `nodeLinker: node-modules` 在位，且必须是常规文件（符号链接 = 内容来自仓外）；
 *      **解析面必须覆盖真 YAML 的等价写法**（BOM / 引号键 / 缩进的根映射 / 显式键 `? key`）——
 *      六种形态见 `yarnrcKeyValuePairs()` 与 `temp/r13/…` 的回归用例；
 *   ③ `.yarn/plugins` 与 `.yarn/releases`（"可提交 + 会被 yarn 当代码读"）**工作树与
 *      HEAD 两侧都为空**；
 *   ④ 根、**每一个 workspace manifest** 与**每一个非 workspace 的 npm 项目 manifest** 都没有
 *      **未登记**的 install 期生命周期钩子（登记表 `INSTALL_INTEGRITY_REGISTERED_HOOKS`
 *      当前为空 = 禁新增）；
 *   ⑤ **平台锚**（第十三轮 R13-D-01）：`git rev-parse HEAD` 必须等于 `$GITHUB_SHA`
 *      （CI 上必在场；不等 / 缺失 ⇒ **退出码 2**）。锚在**平台侧不可改写值**上，而不是
 *      "本进程读得到的那个 HEAD" —— 载荷可以改写本地 git 对象库并 `git commit`，让
 *      `git show HEAD:` 与工作树自洽，从而让①②③④全部失效；
 *   ⑥ **执行体全集按"是否被执行"取，不按"目录形状"取**（第十三轮 V13-A §4.4 / §11③ 的
 *      收口）。全集 = **形状族**（`scripts/check-*.mjs`、`scripts/wasm/**`、
 *      `scripts/verify-*.{mjs,sh}`、`scripts/ci-*.sh`、
 *      `packages/<scope>/<pkg>/scripts/**`（**任意深度**；递归时显式跳过
 *      {@link EXCLUDED_JUDGE_TREE_DIRECTORIES} 那几类依赖/构建目录）
 *      —— 这些是"目录形状"看得见的那一半）∪ **执行点推导**（从真实的执行点反推出来的
 *      仓内路径，见 {@link deriveExecutionPoints}）：`.github/workflows/*.yml` 的每个
 *      `run:` 块里**位于命令位/解释器实参位**的路径、根与各工作区 `package.json` 的
 *      scripts 值里的路径、`integration-tests/` 守卫的 spawn 目标 + 它**按目录枚举**的
 *      语法面、各包（含**非 yarn workspace 的 npm 项目**，见
 *      {@link NPM_PROJECT_MANIFEST_REGISTRY}）决定"哪些 spec / 哪些文件被类型检查 /
 *      哪些产物真的进判定"的 `vitest.config.ts` / `tsdown.config.ts` / `tsconfig*.json`
 *      一族（{@link PACKAGE_JUDGE_CONFIG_PATTERNS}）、仓内每一个 `Makefile`
 *      （{@link MAKEFILE_REGISTRY}：CI 的 `make build-server` 读的就是它，它决定构建真的跑什么）。
 *
 *      **为什么按"是否被执行"取**：目录形状是**代理指标**，它只在"执行体恰好都放在
 *      `scripts/` 一族目录里"时才等于真集合 —— V13-A §4.4 实测的五个同类物
 *      （`integration-tests/**`、各包的 `vitest/tsdown.config.ts`、`community/fabric/scripts/`）
 *      **真被执行/真决定判定**却一条都不落在形状里：改写它们，本判据此前照样 EXIT=0。
 *      形状看得见的东西容易再补一条正则，看不见的东西补不出来 —— 所以口径从"目录形状"
 *      换成"从执行点推导"：**执行点在哪里，判据面就延伸到哪里**。
 *
 *      两张登记表（`EXECUTION_FACE_REGISTRY` = 形状族、`EXECUTION_POINT_REGISTRY` =
 *      形状族**之外**的推导结果）与各自的来源**双向**对拍 —— 派生却未登记即红、
 *      登记了却派生不出即红（死条目）。`--restore` 的覆盖集 = 同一份全集；
 *
 *      **语料不进这个集合（口径写死）**：**执行体 = 被执行 / 决定判定的东西；语料 = 被读的
 *      输入**。`packages/<scope>/<pkg>/tests/**`（各包 300+ 个 spec）与 `integration-tests/`
 *      里的图片等 fixture 属于**语料**：改写一份 spec 不会让**别的**判决换结论，它们由各自
 *      包的测试面负责；而 `vitest.config.ts`（决定"哪些 spec 真的会跑"）在**执行面**里 ——
 *      这正是"决定判定"与"被判定"的分界。本判据只管前者；
 *   ⑦ **yarn 入口族的环境面**：`YARN_YARN_PATH` 一族键不得出现在判据进程的环境里
 *      （真 yarn 4.18.0 实测 `YARN_YARN_PATH=<仓内 .cjs>` 会执行仓内代码；文件面的禁键判据
 *      看不见环境面这条输入通道）。
 *
 * ## 用法与退出码
 *
 * ```bash
 * # CI：第一执行体（此后才允许出现 yarn/corepack 命令）
 * node scripts/check-install-integrity.mjs
 * # 判据步骤：探针从 git 对象取出后执行（工作树里那份不可信），先比对、再按 HEAD 恢复
 * git show HEAD:scripts/check-install-integrity.mjs > "$RUNNER_TEMP/probe.mjs"
 * node "$RUNNER_TEMP/probe.mjs" --root "$PWD" --restore
 * ```
 *
 * `--root <dir>`（缺省：cwd 的 git 顶层）、`--restore`（比对后把执行体按 HEAD 重写，
 * 关掉"比对通过→判据启动"之间的改写窗口）、`--json <path>`（落一份摘要封印，供留痕；
 * **带 `verdict` / `ok` / `exitCode` / `problems`** —— 只有判定通过时才写"通过状"内容
 * （`digests` 封印），失败运行写的是**失败形态**：B-05 的现场是"EXIT=1 的那次留下的封印里
 * `headEqualsGithubSha:true`、`digests{…}`，没有任何'这次没通过'的痕迹"）、
 * `--print-execution-face`（打印五张登记表 + 执行点推导的合取结果，供把新的执行体粘回本文件）。
 * 退出码：0 = 全部通过；1 = 有未通过项；2 = 判据自身读不到输入（不在检出里 / HEAD 缺失 /
 * 必需的判据执行体不在 HEAD 里 / **HEAD ≠ `$GITHUB_SHA`** / 参数不合法）。
 *
 * ## 诚实边界（认账）
 *
 *   · **已提交**的改动（把改写后的判据连同登记值一起提交）不在本判据的区分面上 ——
 *     它与"正当改动"在字节上不可区分，唯一的区分机制是**评审**（登记值进 diff）+ 别的
 *     判据（`check-guard-parser-integrity.mjs` 的摘要对拍锚到 git 对象）。本判据收口的是
 *     **install 期改写**这条"ci.yml 一字未改也能全绿"的隐形通道。
 *   · `--restore` 会按 HEAD 重写工作树里的执行体（CI 上是无副作用的：检出树本就等于 HEAD）。
 *     **本地脏树不要不带 `--restore` 就期待它绿** —— 那说明你正在改判据，属正常现象。
 *   · 本脚本只依赖 `node:*` 与 `git`；它**不进** `check-workspaces.mjs` 的 GUARDS 表
 *     （那张表要改不是本泳道的文件），因此 `yarn check` 不会自动跑它 —— 它的调用点写在
 *     `ci.yml`（两个 job 的第一个执行体 + 每个判据步骤前的探针），并由
 *     `check-workflows.mjs` 的静态策略钉住"必须在任何 yarn 调用之前"。
 *   · **平台锚的残余边界（R13-D-01/02 认账）**：`$GITHUB_SHA` 值来自平台，但本进程仍与
 *     被审代码同一个 uid —— 同 job 里的仓内执行点理论上可以改写**本进程的环境**（例如在
 *     更早的步骤里往 `$GITHUB_ENV` 写 `GITHUB_SHA`）。所以第一道网是"**任何仓内执行点之前
 *     的第一个执行体**"这个**位置**（由 `check-workflows.mjs` 的 [SK-14⑨] 钉住）。
 *     第二道网是 `check-guard-parser-integrity.mjs` 的**远端对象库锚**：它按 `$GITHUB_SHA`
 *     从 `origin` 取回同一批判据执行体再复算登记值 —— 那是**另一个域上的独立确认**，
 *     但**不是**一条"字节不符就能红"的判据：它的 `expected` 由 `git show HEAD:` 的字节派生，
 *     远端取的是**同一个 commit** 的 blob，内容寻址下两者必然逐字节相同 ⇒ 产线上它实际
 *     退化成一句**可用性探测**（"这个 job 能不能从 origin 取回 `$GITHUB_SHA`"）；
 *     "字节不符"那条分支只有**合成 `expected`** 的变异才会命中（第十三轮 V13-A §2.3 的
 *     实测：生产同形恒为一致，只有人工构造的 expected 才能触发 mismatch）。
 *     另外它为判定链**新增了一次网络依赖**：取不回（离线 / 凭据抖动 / origin 暂时不可达）
 *     = 严格面红 —— 那是 fail-closed 的设计意图，但属**运维面**而不是内容面。
 *     本脚本自己只做第一道网（纯本地、无网络、无凭据）。
 *   · **启动器（`node`）不在本判据的收口面内**：它由 CI 侧的"冻结启动器"步骤 + 静态判据
 *     收口（`scripts/check-frozen-launchers.mjs`）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 禁止出现在根 `.yarnrc.yml` **顶层**的键（出现即问题）。
 *
 * 与 `check-guard-parser-integrity.mjs` 的 `REGISTERED_YARN_CONFIGURATION.forbiddenKeys`
 * 同源（那边是"登记制"，这边是"install 之前就必须为空"的另一道网）——两侧清单由
 * `check-guard-parser-integrity.mjs` 的交叉判据逐条对拍，漂移即红。
 */
export const INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS = ['plugins', 'yarnPath']

/**
 * **yarn 入口族的环境面**（第十三轮 C-03）：把"解释器入口"从**文件键**搬到**环境变量**
 * 的等价通道。真 yarn 4.18.0 实测：`YARN_YARN_PATH=<仓内 .cjs> yarn --version` 会执行
 * 那个文件（`YARN_RC_FILENAME` 实测不生效，但同族，一并拦）。
 *
 * 判据按**入口族**而不是按已知键名（第十轮 C-01 的教训：黑名单追不上下一层）：
 * `YARN_` 前缀且名字里含 `PLUGIN`，或名字以 `_PATH` 结尾 —— 命中即红（不是 fail-closed
 * 的"读不出"，是**检测到载荷**）。加豁免必须登记进 `INSTALL_INTEGRITY_REGISTERED_YARN_ENV_KEYS`。
 */
export const INSTALL_INTEGRITY_YARN_ENV_ENTRY_PATTERN = /^YARN_(?:.*PLUGIN.*|.*_PATH)$/u

/** 允许存在的 `YARN_*` 入口族环境变量（**空表 = 禁**；加一条要写明理由）。 */
export const INSTALL_INTEGRITY_REGISTERED_YARN_ENV_KEYS = []

/** 必须在根 `.yarnrc.yml` 里保持的标量取值（不只是"键存在"）。 */
export const INSTALL_INTEGRITY_REQUIRED_YARN_SCALARS = [
  ['enableScripts', 'false'],
  ['nodeLinker', 'node-modules'],
]

/**
 * install 期生命周期钩子名（与 `check-guard-parser-integrity.mjs` 的
 * `ROOT_LIFECYCLE_HOOK_NAMES` 对拍；那边管根 manifest 的登记，这边管**全部** manifest）。
 */
export const INSTALL_INTEGRITY_LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
]

/**
 * 已登记的 install 期钩子（**空表 = 禁新增**）。键 = `<manifest 相对路径>#<hook>`。
 * 加一条 = 显式的、可评审的决定（并写清"为什么必须发生在 install 期"）。
 */
export const INSTALL_INTEGRITY_REGISTERED_HOOKS = [
  // 与 `check-guard-parser-integrity.mjs` 的 `REGISTERED_WORKSPACE_LIFECYCLE_HOOKS` **逐条相同**
  // （两侧不一致即红，见那边的 ⑥d）：本脚本在 install **之前**跑，那份在之后跑。
  'packages/host/desktop/package.json#prepack',
  'community/fabric/package.json#prepack',
]

/** 必须存在于 HEAD 的判据执行体（缺失 ⇒ 判据输入缺席 ⇒ 退出码 2）。 */
const REQUIRED_JUDGE_BODIES = [
  'scripts/check-install-integrity.mjs',
  'scripts/check-guard-parser-integrity.mjs',
  'scripts/check-root-guards.mjs',
  'scripts/check-workspaces.mjs',
  'scripts/check-workflows.mjs',
]

/** 除执行体全集之外还必须逐字节等于 HEAD 的执行体入口。 */
const EXTRA_EXECUTION_ENTRY_PATHS = ['.yarnrc.yml', '.gitignore', 'package.json']

/** "可提交 + 会被 yarn 只凭 `.yarnrc.yml` 的引用就当代码读"的目录：两侧都必须为空。 */
const YARN_CODE_DIRECTORIES = ['.yarn/plugins', '.yarn/releases']

/**
 * **形状族**（第十三轮 D-03 / C-P1 / V1 三路独立复现的收口）。
 *
 * 第十二轮只认 `^scripts/check-[^/]*\.mjs$`（`[^/]*` 显式排除子目录）—— 于是把
 * `scripts/wasm/check-deletion-surface.mjs` 换成恒绿空壳即可让**真实错误状态**
 * 由 `group 2 pass=2 fail=1 / EXIT=1` 变成 `pass=3 fail=0 / EXIT=0`，而两道 install 期锚
 * 同时打 `VERDICT PASS judge-bodies=13` 与 OK（审计实测，可复跑）。
 *
 * 这一族覆盖 `scripts/**` 的全部判据执行体与 `packages/<scope>/<pkg>/scripts/**`（desktop
 * 的 `verify-packaged-runtime.ts` 等 afterPack 判据就在这里）。
 *
 * ⚠️ **它只是执行面的一半**：形状是"执行体长在哪些目录里"的**代理指标**，按它取会漏掉
 * "真被执行但不在这些目录里"的东西（第十三轮 V13-A §4.4 实测的五类）。另一半由
 * {@link deriveExecutionPoints} 从**执行点**反推（workflow `run:` 的命令位、manifest
 * scripts、`integration-tests/` 守卫的 spawn 目标与枚举面、包内的 `vitest/tsdown.config.ts`
 * 与 `tsconfig*.json`），登记在 {@link EXECUTION_POINT_REGISTRY}。两张表**互斥**（执行点表
 * 只承载形状族之外的部分），合起来才是完整执行面。
 */
const JUDGE_BODY_PATTERNS = [
  /^scripts\/[^/]+\.(?:mjs|cjs|js|ts|sh)$/u,
  /^scripts\/wasm\/[^/]+\.(?:mjs|cjs|js|ts|sh)$/u,
  /^scripts\/wasm\/probes\/[^/]+\.(?:mjs|cjs|js|ts)$/u,
  // 门禁**清单**（判决的数据面）：`wasm-gate-inventory.json` 的桶资格/预算在这里，
  // 它和判据脚本一样能决定红绿（第三轮审计 W-1 的形态）。
  /^scripts\/wasm\/[^/]+\.json$/u,
  // 包内 `scripts/**`：**任意深度**（第十四轮 E-01 的收口）。上一版是
  // `...\/scripts\/[^/]+\.(mjs|cjs|ts|js)$`（只认**直接子文件**）⇒
  // `packages/host/desktop/scripts/fixtures/renderer-error-capture-main.mjs`
  // （被 `scripts/verify-renderer-error-capture.mjs` 当 Electron 主脚本 spawn，它打印的
  // 那一行就是那条判据的**全部观察输入**）落在面外：掏空它，两道 install 期锚照打
  // `VERDICT PASS … 与 HEAD 逐字节一致`、`--restore` 也不还原（E-01 现场实测）。
  // 递归的形状面与 `scripts/**` 同一口径；构建/依赖目录的排除判据见
  // {@link EXCLUDED_JUDGE_TREE_DIRECTORIES}（HEAD 侧由 `git ls-tree` 天然过滤，
  // 排除只作用于**工作树枚举**，避免把 `lib/`、`dist/` 里的产物变成假红）。
  /^packages\/[^/]+\/[^/]+\/scripts\/.+\.(?:mjs|cjs|ts|js)$/u,
]

/**
 * 工作树**递归枚举**时要显式跳过的目录名（E-01 的排除判据，白名单式：只跳过这些）。
 *
 * 为什么需要它：形状族改成递归之后，`packages/<scope>/<pkg>/scripts/**` 下任何名字命中
 * 扩展名的**构建产物 / 依赖**（`scripts/lib/*.mjs`、`scripts/node_modules/...`）都会被
 * 工作树枚举看见，而它们按定义不在 HEAD 里 ⇒ 判据会**假红**（"不在 HEAD 里（工作树里却有）"）。
 * 排除只影响"形状族"的**工作树侧**枚举：HEAD 侧来自 `git ls-tree`（忽略文件根本不会列出），
 * 所以**递归的 HEAD 面不会因此变小** —— 一条被跟踪的 `scripts/lib/foo.mjs` 仍然进面、
 * 仍然要登记、仍然逐字节对拍。
 */
const EXCLUDED_JUDGE_TREE_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'lib',
  'out',
  'coverage',
  '__pycache__',
  '.cache',
  '.git',
])

/** 判定一个仓库相对路径是否是"形状族"执行体（{@link JUDGE_BODY_PATTERNS} 之一）。 */
export function isExecutionFacePath(path) {
  return JUDGE_BODY_PATTERNS.some(pattern => pattern.test(path))
}

/**
 * **执行体全集的登记表**（HEAD 侧族形态命中的全部文件；双向对拍见 `main()`）。
 *
 * 它同时是 `--restore` 的覆盖集与"工作树 == HEAD"的比对集：任何新增执行体必须在这里
 * 登记（`node scripts/check-install-integrity.mjs --print-execution-face` 打印可粘贴的两张表），
 * 任何删掉的执行体必须从这里移除（死条目即红）。
 */
export const EXECUTION_FACE_REGISTRY = [
  'packages/host/desktop/scripts/asar-bigint-probe.mjs',
  'packages/host/desktop/scripts/asar-entry-path.ts',
  'packages/host/desktop/scripts/brand-prepare.mjs',
  'packages/host/desktop/scripts/channel-build.ts',
  'packages/host/desktop/scripts/channel-prepare.ts',
  'packages/host/desktop/scripts/clean.mjs',
  'packages/host/desktop/scripts/direct-invocation.mjs',
  'packages/host/desktop/scripts/e2e-client.mjs',
  'packages/host/desktop/scripts/e2e-fixture-gateway.mjs',
  'packages/host/desktop/scripts/e2e-foot-lane.mjs',
  'packages/host/desktop/scripts/e2e-right-sidebar.mjs',
  'packages/host/desktop/scripts/e2e-terminal.mjs',
  // 递归形状族新增的那一条（E-01）：`packages/<scope>/<pkg>/scripts/**` 任意深度。
  // 它是 `scripts/verify-renderer-error-capture.mjs` 的 **Electron 主脚本**，那条门禁的
  // 全部观察（`RENDERER_CAPTURE_SMOKE_RESULT` 行）都由它打印 —— 改写它 = 改写判据的观察端。
  'packages/host/desktop/scripts/fixtures/renderer-error-capture-main.mjs',
  'packages/host/desktop/scripts/generate-mac-app-icon.mjs',
  'packages/host/desktop/scripts/generate-tray-icons.mjs',
  'packages/host/desktop/scripts/mac-runtime.ts',
  'packages/host/desktop/scripts/notarize-mac.ts',
  'packages/host/desktop/scripts/pack-app-root.mjs',
  'packages/host/desktop/scripts/package-dir.mjs',
  'packages/host/desktop/scripts/package-linux.mjs',
  'packages/host/desktop/scripts/package-mac.ts',
  'packages/host/desktop/scripts/package-win-portable.ts',
  'packages/host/desktop/scripts/package-win.ts',
  'packages/host/desktop/scripts/prebuild-workspace-deps.ts',
  'packages/host/desktop/scripts/proxy-policy-probe-app.mjs',
  'packages/host/desktop/scripts/proxy-policy-probe.mjs',
  'packages/host/desktop/scripts/real-env-browser-no-approval.mjs',
  'packages/host/desktop/scripts/real-env-cron-audit.mjs',
  'packages/host/desktop/scripts/real-env-cron-flow.mjs',
  'packages/host/desktop/scripts/real-env-verify.mjs',
  'packages/host/desktop/scripts/release-mac.ts',
  'packages/host/desktop/scripts/release-preflight.ts',
  'packages/host/desktop/scripts/runtime-closure.mjs',
  'packages/host/desktop/scripts/runtime-closure.spec.mjs',
  'packages/host/desktop/scripts/verify-channel-package.ts',
  'packages/host/desktop/scripts/verify-licenses.mjs',
  'packages/host/desktop/scripts/verify-loader-boot.mjs',
  'packages/host/desktop/scripts/verify-mac-release.ts',
  'packages/host/desktop/scripts/verify-mac-smoke.ts',
  'packages/host/desktop/scripts/verify-packaged-runtime.ts',
  'packages/host/desktop/scripts/verify-profile-boot.mjs',
  'packages/host/desktop/scripts/verify-renderer-error-capture.mjs',
  'packages/host/desktop/scripts/verify-runtime-closure.mjs',
  'packages/host/desktop/scripts/verify-session-restart.mjs',
  'packages/host/desktop/scripts/verify-win-installer.ts',
  'packages/host/desktop/scripts/verify-win-portable.ts',
  'packages/vendor/memory-evolve/scripts/build.mjs',
  'packages/vendor/memory-evolve/scripts/run-tests.mjs',
  'packages/vendor/memory-evolve/scripts/sync-worker.mjs',
  'scripts/check-doc-claims.mjs',
  'scripts/check-frozen-launchers.mjs',
  'scripts/check-guard-parser-integrity.mjs',
  'scripts/check-install-integrity.mjs',
  'scripts/check-integration-tests.mjs',
  'scripts/check-migration-range.mjs',
  'scripts/check-no-leftover-mutants.mjs',
  'scripts/check-no-real-domains.mjs',
  'scripts/check-patch-pin.mjs',
  'scripts/check-root-guards.mjs',
  'scripts/check-theme-tokens.mjs',
  'scripts/check-verdict-credential.mjs',
  'scripts/check-workflows.mjs',
  'scripts/check-workspaces.mjs',
  'scripts/ci-brand-mask.sh',
  'scripts/ci-build-channel-images.sh',
  'scripts/ci-channel-transfer.sh',
  'scripts/ci-channels.sh',
  'scripts/ci-package-clients.sh',
  'scripts/ci-publish-update-server.sh',
  'scripts/ci-release-policy.sh',
  'scripts/ci-release-topology.sh',
  'scripts/glitchtip-ops-check.mjs',
  'scripts/patch-copy-scan.mjs',
  'scripts/patch-targets.mjs',
  'scripts/platform-modules.mjs',
  'scripts/upgrade-upstream.mjs',
  'scripts/verify-check-workspaces.mjs',
  'scripts/verify-ci-scripts.mjs',
  'scripts/verify-glitchtip-ops-check.mjs',
  'scripts/verify-inventories.mjs',
  'scripts/verify-layout.mjs',
  'scripts/verify-patch-resolutions.mjs',
  'scripts/verify-patches.mjs',
  'scripts/verify-wasm-channels.mjs',
  'scripts/verify-wasm-client-only.sh',
  'scripts/version.mjs',
  'scripts/wasm/check-authoring-claims.mjs',
  'scripts/wasm/check-deletion-surface.mjs',
  'scripts/wasm/check-go-test-json.mjs',
  'scripts/wasm/check-old-model-residue.mjs',
  'scripts/wasm/check-route-parity.mjs',
  'scripts/wasm/probes/probe-app-scheme-gate.cjs',
  'scripts/wasm/probes/probe-attest.cjs',
  'scripts/wasm/probes/probe-custom-scheme-2.cjs',
  'scripts/wasm/probes/probe-custom-scheme.cjs',
  'scripts/wasm/probes/probe-web-storage.cjs',
  'scripts/wasm/wasm-gate-inventory.json',
]

/**
 * **`.github/workflows/*.yml` 里真的被引用的执行体**的登记表（双向对拍的第二条边）。
 *
 * 来源不是手写清单：`ciReferencedExecutionBodies()` 扫 workflow 文本里的族形态路径 token。
 * 双向：扫到却没登记 ⇒ 红（新的执行体悄悄进了 CI）；登记了却没被扫到 ⇒ 红（死条目）。
 */
export const CI_REFERENCED_EXECUTION_REGISTRY = [
  'scripts/check-frozen-launchers.mjs',
  'scripts/check-guard-parser-integrity.mjs',
  'scripts/check-install-integrity.mjs',
  'scripts/check-root-guards.mjs',
  'scripts/check-verdict-credential.mjs',
  'scripts/check-workflows.mjs',
  'scripts/check-workspaces.mjs',
  'scripts/ci-build-channel-images.sh',
  'scripts/ci-channel-transfer.sh',
  'scripts/ci-channels.sh',
  'scripts/ci-package-clients.sh',
  'scripts/ci-publish-update-server.sh',
  'scripts/ci-release-policy.sh',
  'scripts/ci-release-topology.sh',
  'scripts/verify-ci-scripts.mjs',
  'scripts/verify-wasm-client-only.sh',
  'scripts/version.mjs',
  'scripts/wasm/check-go-test-json.mjs',
]


/**
 * **非 yarn workspace 的 npm 项目 manifest** 的登记表（第十四轮 B-02 的收口）。
 *
 * ## 它比"workspace manifest"多管什么
 *
 * 判据此前只认根 + `workspaces` 展开出来的 manifest（本仓 16 个）。`server/webadmin`
 * 与 `site` **不是** yarn workspace（根 `workspaces` 只有 `packages/<scope>/<pkg>` 与
 * `community/<name>` 两张 glob），
 * 于是它们一条都不在比对面、也不进生命周期钩子的扫描集。而 CI 的 `server` job 恰恰在
 * `server/webadmin` 里跑 `npm ci` —— 真 npm 实测**会执行项目自己的 `postinstall`**
 * （`npm ci` 不因 `enableScripts: false` 而豁免：那条只挡 yarn 的依赖构建脚本），
 * 钩子跑在 `go vet` / `go test` / `make build-server` **之前**，可以改写工作树里的
 * `server/**` 源码而没有任何守卫把 `server/**` 与 HEAD 对拍（B-02 现场：提交一条
 * `postinstall` ⇒ 本判据 EXIT=0；只改工作树里的 `server/webadmin/vitest.config.ts`
 * ⇒ 同样 EXIT=0）。
 *
 * ## 派生口径（不手抄名单）
 *
 * 派生 = **HEAD 路径全集里除根 manifest 与 workspace manifest 之外的每一个
 * `package.json`**（见 {@link npmProjectManifestPaths}）—— "每一条 `package.json` 都是
 * 一个 install 期执行面"是结构事实，不是枚举：新加一个 `server/<x>/package.json` 会
 * **派生得出来却没登记 ⇒ 红**，删掉一条 ⇒ 死条目红。
 *
 * ## 它们同时是"包"（判据配置的来源 (d)）
 *
 * 非 workspace 的 npm 项目与 workspace 包一样有自己的 `vitest.config.ts`（决定
 * `npm test` 跑哪些 spec）与 `tsconfig*.json`（决定 `tsc` 判哪些文件），所以它们也进
 * {@link deriveExecutionPoints} 的来源 (d)，而不是只做一次字节对拍。
 *
 * 双向对拍：见 `main()` 的 ②d 段（未登记即红 / 死条目即红）。
 */
export const NPM_PROJECT_MANIFEST_REGISTRY = [
  // 桌面宿主服务的 smoke 夹具包（`yarn check` 之外的 afterPack/冒烟面）。
  'packages/host/desktop/tests/fixtures/desktop-host-services-smoke-plugin/package.json',
  // CI `server` job 的 `npm ci` / `npm test` 就在这个目录里跑：webadmin 的 668 个用例。
  'server/webadmin/package.json',
  // 官网（Astro/Starlight）：本地与部署侧都按 npm 项目装依赖。
  'site/package.json',
]


/**
 * 仓内每一个 `Makefile` 的登记表（第十四轮 B-01 的"同一分界线还能有谁"的第三个答案）。
 *
 * ## 为什么它在执行面里
 *
 * CI 的 `server` job 用 `make build-server` 构建服务端（`server/Makefile` 决定那条构建
 * 真的跑什么：`go build` 的包集合、产物路径、`-ldflags` 注入的版本）。它和
 * `tsdown.config.ts`（决定包的构建入口表）是**同一类东西**，只是长在 Go 侧。
 *
 * ## 派生口径
 *
 * 派生 = **HEAD 路径里基名为 `Makefile` / `makefile` / `GNUmakefile` 的每一个文件**
 * （见 {@link makefilePaths}），双向对拍在 `main()` 的 ②d 段：新增一个 Makefile 未登记即红、
 * 删掉即死条目红。
 *
 * ## 为什么它**不**进"工作树侧的形状面"（这条是踩出来的）
 *
 * 通用做法是从执行点归纳出"父目录 + 同扩展名"的工作树形态 —— 对 `server/Makefile` 就是
 * "`server/` 下所有**无扩展名**文件"。实测那条形态会把 `server/server`（57 MB 的
 * **gitignored 构建产物**，`make build-server` 的产出）与 `server/Dockerfile` 一起枚举进来，
 * 而它们不在 HEAD ⇒ 判据会**假红**。所以 `addFace()` 现在显式跳过"扩展名为空"的形态：
 * Makefile 只由 **HEAD 侧**派生（`git ls-tree`，忽略文件根本不会列出），工作树侧只做
 * 逐字节对拍与 `--restore`。**认账的边界**：检出之后**新建**一个 Makefile 不会被枚举到
 * （它不是"被改写"，而且新文件要被执行还得有人改 CI 或 manifest，那两条都在面内）。
 */
export const MAKEFILE_REGISTRY = [
  // CI `server` job 的 `make build-server`；`server/Makefile check` 也在本地门禁里跑。
  'server/Makefile',
]

/**
 * 从 HEAD 路径全集派生"仓内每一个 Makefile"（{@link MAKEFILE_REGISTRY} 的派生侧）。
 * @param headPaths - HEAD 的路径集合（`Set` 或数组）。
 * @returns 排序后的路径数组。
 */
export function makefilePaths(headPaths) {
  const listed = headPaths instanceof Set ? headPaths : new Set(headPaths ?? [])
  const names = new Set(['Makefile', 'makefile', 'GNUmakefile'])
  return [...listed].filter(path => names.has(String(path).slice(String(path).lastIndexOf('/') + 1))).sort()
}


/**
 * **执行点全集的登记表**（第十三轮 V13-A §4.4 / §11③ 的收口）。
 *
 * ## 它比 `EXECUTION_FACE_REGISTRY` 多管什么
 *
 * 族形态按**目录形状**取（`scripts/**`、`packages/<scope>/<pkg>/scripts/**`），于是
 * "真被执行、真决定判定、但不住在这些目录里"的东西一条都进不了比对面，也不进
 * `--restore` 的覆盖集 —— 改写它们，本判据**照样 EXIT=0**（V13-A §4.4 实测）。
 * 这张表承载的就是那一半：**从执行点推导**（{@link deriveExecutionPoints}）出来、
 * 而形状族看不见的路径。
 *
 * ## 四条来源（每条都只认"执行"这个事实，不认目录名）
 *
 *   · **workflow `run:` 的命令位 / 解释器实参位** —— `node scripts/x.mjs`、`bash y.sh`
 *     里的那个实参。**不是**"文本里提到过"：`git show HEAD:scripts/x.mjs` 这种**实参位**
 *     不算（它是被读的输入），所以本表不会因为 workflow 里多一句注释而漂移；
 *   · **根与各工作区 `package.json` 的 scripts 值** —— 根侧扫全部值（`check:*` 是门禁
 *     的入口表），包侧至少覆盖 `test` / `check`（它们决定"这个包怎么被判"）；
 *   · **`integration-tests/` 守卫**（`scripts/check-integration-tests.mjs`）—— 它 `spawn` /
 *     `spawnSync` 的目标，以及**它按目录枚举的语法面**（扩展名集合是从**它自己的文本**里
 *     抽出来的，不是这里手写的：它改扫描面，本集合跟着变）；
 *   · **包内决定"哪些 spec / 哪些产物真的进判定"的配置** —— `vitest.config.ts`
 *     （哪些 spec 会被 vitest 收进来跑）与 `tsdown.config.ts`（各包 `build` 的入口表，
 *     产物面）。`CODEOWNERS` 也把前者列进"判据面"，此前两边口径不一致。
 *
 * ## 语料不进这张表（口径，别再往回加）
 *
 * **执行体 = 被执行 / 决定判定的东西；语料 = 被读的输入。**
 * `packages/<scope>/<pkg>/tests/**`（300+ 个 spec）与 `integration-tests/electron-shots/*.png`
 * 是**语料**：它们由各自的测试面（`vitest.config.ts` 收哪些 spec、`--self-test` 的夹具）
 * 负责，本判据不把它们拉进比对面 —— 否则每加一个 spec 都要改这张表，而那样得到的
 * "覆盖"只是把语料抄了一遍，并不增加任何"判据本体没被改写"的保证。分界线就是
 * "改它会不会让**别的**判决换一个结论"：改 `vitest.config.ts` 会（少跑一批 spec），
 * 改一份 spec 不会。
 *
 * ## 双向对拍
 *
 * 本表与 `deriveExecutionPoints()` 的结果（**减去形状族已覆盖的部分**）双向相等：
 * 派生却未登记 ⇒ 红；登记了却派生不出 ⇒ 红（死条目 —— 例如那个执行点已经不再被任何
 * workflow / manifest / 守卫引用）。形状族那一半由 `EXECUTION_FACE_REGISTRY` 负责，
 * 两张表互斥、合起来 = 完整执行面（`--print-execution-face` 打印两张表与合取结果）。
 */
export const EXECUTION_POINT_REGISTRY = [
  'community/fabric/scripts/verify-docs.mjs',
  'integration-tests/contractkit.py',
  'integration-tests/dex/config.yaml',
  'integration-tests/dex/dex-sso-test.py',
  'integration-tests/electron-shots/assertions.mjs',
  'integration-tests/electron-shots/electron-shots.mjs',
  'integration-tests/electron-shots/report.mjs',
  'integration-tests/openldap/ldap-rbac-brand-test.py',
  'integration-tests/run-all.sh',
  // ── B-01（第十四轮）：包内 `tsconfig*.json` —— 与 `vitest.config.ts` **同一条分界线**
  //    （一个决定"哪些 spec 跑"、一个决定 `tsc -p` 判哪些文件；改它会让别的判决换结论）。
  //    按基名形态派生（`tsconfig.<面>.json` 自动进面），未登记即红。
  'packages/client/account-card/tsconfig.client.json',
  'packages/client/account-card/tsconfig.json',
  'packages/client/account-card/tsdown.config.ts',
  'packages/client/account-card/vitest.config.ts',
  'packages/client/branding/tsconfig.client.json',
  'packages/client/branding/tsconfig.json',
  'packages/client/branding/tsdown.config.ts',
  'packages/client/foot-menu/tsconfig.client.json',
  'packages/client/foot-menu/tsconfig.json',
  'packages/client/foot-menu/tsdown.config.ts',
  'packages/client/foot-menu/vitest.config.ts',
  'packages/client/panel-surface/tsconfig.client.json',
  'packages/client/panel-surface/tsconfig.json',
  'packages/client/panel-surface/tsdown.config.ts',
  'packages/client/panel-surface/vitest.config.ts',
  'packages/client/wasm-apps/tsconfig.client.json',
  'packages/client/wasm-apps/tsconfig.json',
  'packages/client/wasm-apps/tsdown.config.ts',
  'packages/client/wasm-apps/vitest.config.ts',
  'packages/host/browser/tsconfig.client.json',
  'packages/host/browser/tsconfig.json',
  'packages/host/browser/tsdown.config.ts',
  'packages/host/browser/vitest.config.ts',
  'packages/host/connectors/tsconfig.client.json',
  'packages/host/connectors/tsconfig.json',
  'packages/host/connectors/tsdown.config.ts',
  'packages/host/connectors/vitest.config.ts',
  'packages/host/cron/tsconfig.client.json',
  'packages/host/cron/tsconfig.json',
  'packages/host/cron/tsdown.config.ts',
  'packages/host/cron/vitest.config.ts',
  'packages/host/desktop/tsconfig.client.json',
  'packages/host/desktop/tsconfig.json',
  'packages/host/desktop/tsconfig.tests.client.json',
  'packages/host/desktop/tsconfig.tests.json',
  'packages/host/desktop/tsdown.config.ts',
  'packages/host/desktop/vitest.config.ts',
  'packages/host/enterprise/tsconfig.client.json',
  'packages/host/enterprise/tsconfig.json',
  'packages/host/enterprise/tsdown.config.ts',
  'packages/host/enterprise/vitest.config.ts',
  'packages/host/host-home/tsconfig.json',
  'packages/host/host-home/tsdown.config.ts',
  'packages/host/host-home/vitest.config.ts',
  'packages/host/host-locale/tsconfig.json',
  'packages/host/host-locale/tsdown.config.ts',
  'packages/host/host-locale/vitest.config.ts',
  'packages/host/wasm-apps-host/tsconfig.json',
  'packages/host/wasm-apps-host/tsdown.config.ts',
  'packages/host/wasm-apps-host/vitest.config.ts',
  'packages/vendor/memory-evolve/tsconfig.json',
  // ── B-02（第十四轮）：**非 yarn workspace 的 npm 项目**的判据配置
  //    （CI 的 `npm ci` 在 `server/webadmin` 里跑 ⇒ 它的 manifest 与 vitest/tsc 面
  //    都是执行面；登记表 `NPM_PROJECT_MANIFEST_REGISTRY` 管 manifest 那一半）。
  'server/webadmin/tsconfig.json',
  'server/webadmin/vitest.config.ts',
  'site/tsconfig.json',
]

/**
 * 一段字节的 sha256（小写 hex）。
 * @param data - 文件 / 对象内容。
 * @returns 摘要。
 */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 在指定仓库里跑 git（同步，不抛异常）。
 * @param root - 仓库根。
 * @param args - git 参数。
 * @param encoding - `utf8`（缺省）或 `buffer`。
 * @returns `spawnSync` 的结果。
 */
function git(root, args, encoding = 'utf8') {
  return spawnSync('git', ['-C', root, ...args], { encoding, maxBuffer: 256 * 1024 * 1024 })
}

/**
 * 读 HEAD 里的一个文件（blob）字节。
 * @param root - 仓库根。
 * @param path - 仓库相对路径。
 * @returns `Buffer`；不在 HEAD 里 / 读不出 ⇒ `null`。
 */
function readHeadBlob(root, path) {
  const result = git(root, ['show', `HEAD:${path}`], 'buffer')
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null
}

/**
 * HEAD 里全部**执行体**（族形态过滤）。
 * @param root - 仓库根。
 * @returns 相对路径数组（升序）；读不出 ⇒ `null`。
 */
function listHeadJudgeBodies(root) {
  const result = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'scripts', 'packages'])
  if (result.status !== 0) return null
  return String(result.stdout)
    .split('\0')
    .filter(name => isExecutionFacePath(name))
    .sort()
}

/**
 * 工作树里的执行体（含符号链接：符号链接本身也是问题，交给比对环节报）。
 *
 * 两面合成：
 *   · **形状族**：`scripts/**`（含 `wasm/`、`wasm/probes/`）与
 *     `packages/<scope>/<pkg>/scripts/**`（**任意深度**，跳过
 *     {@link EXCLUDED_JUDGE_TREE_DIRECTORIES}）—— 与 {@link JUDGE_BODY_PATTERNS} 一一对应；
 *   · **执行点形态**（`faces`，由 {@link deriveExecutionPoints} 从 HEAD 归纳）：
 *     `integration-tests/**` 按守卫的扩展名集合递归、以及每个执行点的父目录 + 同扩展名。
 *     没有这一面时，"检出之后才新增的执行点"（新加一个 `integration-tests/*.mjs`、
 *     包根新加一个 `*.config.ts`）在工作树里**枚举不到**，也就不会被"不在 HEAD 里"那条判红。
 *
 * ⚠️ 工作树侧刻意是**超集**（宁可多枚举、不可漏）：多出来的路径只会在比对环节被判
 * "不在 HEAD 里（工作树里却有）"或逐字节一致 —— 两个方向都不产生假绿。
 * @param root - 仓库根。
 * @param faces - 执行点形态（缺省空：只枚举形状族）。
 * @returns 相对路径数组（升序）。
 */
function listWorktreeJudgeBodies(root, faces = []) {
  const found = new Set()
  const walk = (relativeDirectory, recursive) => {
    const absolute = join(root, relativeDirectory)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        // `scripts/**` 与 `packages/<scope>/<pkg>/scripts/**` 都**全深度递归**（E-01）。
        // 递归时跳过 {@link EXCLUDED_JUDGE_TREE_DIRECTORIES}：那些目录里的是依赖与构建
        // 产物（不在 HEAD 里），枚举进来只会制造"不在 HEAD 里（工作树里却有）"的假红。
        if (recursive && !EXCLUDED_JUDGE_TREE_DIRECTORIES.has(entry.name)) walk(path, recursive)
        continue
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && isExecutionFacePath(path)) found.add(path)
    }
  }
  walk('scripts', true)
  const packages = join(root, 'packages')
  if (existsSync(packages)) {
    for (const scope of readdirSync(packages, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue
      const scopeDirectory = join(packages, scope.name)
      for (const pkg of readdirSync(scopeDirectory, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue
        walk(`packages/${scope.name}/${pkg.name}/scripts`, true)
      }
    }
  }
  for (const face of faces) {
    const absolute = join(root, face.dir)
    if (!existsSync(absolute)) continue
    // 与 `scripts/check-integration-tests.mjs` 自己的枚举口径一致：跳过这三个目录
    // （它们不是仓内内容，装了依赖/跑过 python 之后不该把工作树枚举面变成假红）。
    const skipped = new Set(['node_modules', '__pycache__', '.git'])
    const collect = (directory, relativeDirectory, recursive) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (skipped.has(entry.name)) continue
        const path = `${relativeDirectory}/${entry.name}`
        if (entry.isDirectory()) {
          if (recursive) collect(join(directory, entry.name), path, recursive)
          continue
        }
        if (entry.isFile() || entry.isSymbolicLink()) {
          if (face.extensions.includes(extensionOf(entry.name))) found.add(path)
        }
      }
    }
    collect(absolute, face.dir, face.recursive)
  }
  return [...found].sort()
}

/**
 * HEAD 里全部路径（执行点推导的**存在性谓词**来源：workflow / manifest 里提到的相对路径
 * 只有真的在版本库里才算执行点）。
 * @param root - 仓库根。
 * @returns `Set<string>`；读不出 ⇒ `null`。
 */
function listHeadPaths(root) {
  const result = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])
  if (result.status !== 0) return null
  return new Set(String(result.stdout).split('\0').filter(name => name !== ''))
}

/**
 * 展开 `workspaces` 里的目录形态（只支持逐段星号，与本仓的 `packages/<scope>/<pkg>` /
 * `community/<name>` 两张 glob 一致）。
 * @param root - 仓库根。
 * @param patterns - `package.json` 的 `workspaces` 数组。
 * @returns manifest 相对路径数组（升序；只保留真的存在 `package.json` 的目录）。
 */
function expandWorkspaceManifests(root, patterns) {
  const manifests = new Set()
  const walk = (directory, segments) => {
    if (segments.length === 0) {
      if (existsSync(join(root, directory, 'package.json'))) manifests.add(`${directory}/package.json`)
      return
    }
    const [head, ...rest] = segments
    if (head !== '*') {
      walk(directory === '' ? head : `${directory}/${head}`, rest)
      return
    }
    const absolute = directory === '' ? root : join(root, directory)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      walk(directory === '' ? entry.name : `${directory}/${entry.name}`, rest)
    }
  }
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    walk('', pattern.split('/').filter(segment => segment !== ''))
  }
  return [...manifests].sort()
}

/**
 * 根 `.yarnrc.yml` 的**键值对**（严格扫描：容忍真 YAML 的等价写法）。
 *
 * 为什么不复用别处的解析器：本脚本要在"别的脚本可能已被改写"的前提下自立 —— 而且
 * 它只需要"顶层键集合 + 两个标量取值"，多引入一个解析器只会把可信根摊大。
 * 形态不认识的输入按"读不出"处理（调用方 fail-closed）。
 *
 * ## 为什么不能只认"顶格 `key:`"（第十三轮 C-02，真 yarn 4.18.0 实测）
 *
 * 旧实现的正则是 `^([A-Za-z][A-Za-z0-9_.-]*)\s*:` —— 六种等价写法里五种**真 yarn 会执行
 * 仓内代码而旧判据看不见**（探针 `temp/r13/C/probe-c.py`，每行都用真 yarn 跑 `yarn --version`，
 * 插件体在被 `require` 时写 `LOADED.txt`）：
 *
 * | 写法 | 旧判据 | 现在 |
 * |---|---|---|
 * | `plugins:`（控制组） | 看见 | 看见 |
 * | `"plugins":` 双引号键 | **看不见** | 看见 |
 * | `'plugins':` 单引号键 | **看不见** | 看见 |
 * | 缩进的根映射（`  plugins:`） | **看不见** | 看见 |
 * | 显式键（`? plugins`） | **看不见** | 看见 |
 * | 文件首字节 BOM（U+FEFF） | **整份失配** | 看见（剥 BOM） |
 *
 * 归一化：剥 BOM → 逐行去 CR → `trimStart()` → 去掉 YAML 注释 → 去显式键前缀 `? `
 * → 键部分去引号。**多认不算漏**（多认只会让"禁键/必需标量"更容易命中，方向是 fail-closed）；
 * 真正要避免的是"少认"。
 * @param text - `.yarnrc.yml` 文本。
 * @returns `[key, value]` 数组（按出现顺序，可重复；块形态的 value 是 `null`）。
 */
export function yarnrcKeyValuePairs(text) {
  const pairs = []
  const lines = String(text).replace(/^\uFEFF/u, '').split('\n')
  for (const raw of lines) {
    const line = raw.replace(/\r$/u, '')
    if (/^\s*$/u.test(line) || /^\s*#/u.test(line)) continue
    // YAML 的**显式键**形态：`? plugins` 单独一行，值在后面的 `:` 行里（真 yarn 4.18.0
    // 实测接受这一形态并执行仓内代码 —— C-02 的变体 4）。它没有 `:` ⇒ 必须在归一化之前
    // 单独认出来，否则整行被丢掉（禁键判据看不见 = 假绿）。
    const explicit = /^\s*\?\s+(.*)$/u.exec(line)
    if (explicit !== null) {
      const raw = explicit[1].replace(/\s+#.*$/u, '').trim().replace(/^["']|["']$/gu, '')
      if (raw !== '' && !raw.includes(':')) pairs.push([raw, null])
    }
    const body = (explicit === null ? line : explicit[1]).trimStart()
    const match = /^(?:(["'])([^"']+)\1|([^:\s][^:]*?))\s*:(?:\s*(.*))?$/u.exec(body)
    if (match === null) continue
    const key = match[2] ?? match[3]
    if (key === undefined || key === '') continue
    const value = (match[4] ?? '').replace(/\s+#.*$/u, '').trim().replace(/^["']|["']$/gu, '')
    pairs.push([key, value === '' ? null : value])
  }
  return pairs
}

/**
 * 根 `.yarnrc.yml` 的**顶层键**（归一化口径见 {@link yarnrcKeyValuePairs}）。
 * @param text - `.yarnrc.yml` 文本。
 * @returns 键数组（按出现顺序，可重复）。
 */
export function yarnrcTopLevelKeys(text) {
  return yarnrcKeyValuePairs(text).map(([key]) => key)
}

/**
 * 根 `.yarnrc.yml` 里某个标量的取值。
 * @param text - `.yarnrc.yml` 文本。
 * @param key - 键名。
 * @returns 取值字符串；不存在 / 块形态 ⇒ `null`。
 */
export function yarnrcScalar(text, key) {
  for (const [candidate, value] of yarnrcKeyValuePairs(text)) {
    if (candidate === key && value !== null) return value
  }
  return null
}

/**
 * **yarn 入口族的环境面**问题（第十三轮 C-03）。
 *
 * 真 yarn 4.18.0 实测：`YARN_YARN_PATH=<仓内 .cjs> yarn --version` 会执行那个文件；而禁键
 * 判据只读 `.yarnrc.yml` ⇒ **同一件事的第二条输入通道**看不见。按**入口族**收口
 * （第十轮 C-01 的教训：按已知键名收口追不上下一层）。
 * @param env - 源环境（缺省 `process.env`）。
 * @returns 问题清单。
 */
export function yarnEntryEnvironmentProblems(env = process.env) {
  const problems = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string' || value === '') continue
    if (!INSTALL_INTEGRITY_YARN_ENV_ENTRY_PATTERN.test(key)) continue
    if (INSTALL_INTEGRITY_REGISTERED_YARN_ENV_KEYS.includes(key)) continue
    problems.push(`环境里有 **yarn 入口族**的键 \`${key}\`=${JSON.stringify(value)} —— `
      + '真 yarn 4.18.0 实测 `YARN_YARN_PATH=<仓内 .cjs>` 会**执行仓内代码**（`yarn --version` 就够），'
      + '而文件面的禁键判据（`.yarnrc.yml` 的 `yarnPath:`/`plugins:`）**看不见环境面**这条输入通道。'
      + '\n      ⇒ 这一族键不得出现在判据步骤的环境里（含 workflow/job/step 三层 `env:` 与 runner 注入）；'
      + `确实需要时登记进 \`INSTALL_INTEGRITY_REGISTERED_YARN_ENV_KEYS\`（键 \`${key}\`）并写明理由。`)
  }
  return problems
}

/**
 * **平台锚**（第十三轮 R13-D-01）：`git rev-parse HEAD` 必须等于平台侧的 `$GITHUB_SHA`。
 *
 * ## 为什么这一条是结构性的（不是"补一句注释"）
 *
 * R13-D-01 的实测载荷：仓内执行点改写判据执行体**并 `git commit`** ⇒ `git show HEAD:` 与
 * 工作树**自洽**，`--restore` / `--require-clean` / 摘要登记全部失效 —— Full gate **EXIT=0**
 * 且打印**真凭据**（`planned=32 executed=32`），一条测试没跑。根因是"锚"取在**本地 git 对象库**
 * 上，而它与被判对象**同域可写**。平台注入的 `$GITHUB_SHA` 是**另一个域**的值：同一 job 里的
 * 仓内执行点改不了 runner 在 job 启动时定下的那个字符串（要改它得先能写本进程的环境 ——
 * 那正是"本步骤必须是任何仓内执行点之前的第一个执行体"这条**位置**判据的职责）。
 *
 * 判据：
 *   · `$GITHUB_SHA` 是 40 位 hex 且 **≠ HEAD** ⇒ 红（**退出码 2**：锚不一致 ⇒ 判据输入不可信）；
 *   · `$GITHUB_SHA` 在场但形态非法 ⇒ 红（退出码 2）；
 *   · `$GITHUB_SHA` 缺席但**别的 runner 信号在场**（CI 上不该发生）⇒ 红（退出码 2）；
 *   · 全无 runner 信号（本地）⇒ 只记 note（"平台锚未验证"），不拦本地开发。
 * @param options - `{ head, env }`。
 * @returns `{ fatal, note, sha }`。
 */
export function headAnchorProblems(options = {}) {
  const env = options.env ?? {}
  const head = String(options.head ?? '')
  const raw = typeof env.GITHUB_SHA === 'string' ? env.GITHUB_SHA.trim() : ''
  const runnerSignals = ['GITHUB_ACTIONS', 'CI', 'GITHUB_EVENT_PATH', 'GITHUB_RUN_ID', 'GITHUB_WORKFLOW', 'RUNNER_OS', 'RUNNER_TEMP']
    .filter(key => typeof env[key] === 'string' && env[key].trim() !== '')
  if (raw === '') {
    if (runnerSignals.length > 0) {
      return {
        fatal: `**平台锚缺席**：环境里有 runner 信号（${runnerSignals.join('、')}）却没有 \`GITHUB_SHA\`。`
          + '\n      ⇒ `HEAD` 取自**本地 git 对象库**，而载荷可以改写它并 `git commit`（让 `git show HEAD:`'
          + '与工作树自洽）⇒ 本判据的全部比对都会"自洽地通过"。CI 上 `GITHUB_SHA` 必在场，'
          + '读不到就是判据输入缺席（拒绝把"读不到"当成"没问题"）。',
        note: null,
        sha: null,
      }
    }
    return { fatal: null, note: '平台锚（HEAD == $GITHUB_SHA）**未验证**：本地运行且没有 runner 信号', sha: null }
  }
  if (!/^[0-9a-f]{40}$/u.test(raw)) {
    return { fatal: `\`GITHUB_SHA\` 形态非法：${JSON.stringify(raw)}（必须是 40 位小写 hex）`, note: null, sha: null }
  }
  if (raw !== head) {
    return {
      fatal: `**平台锚不一致**：\`git rev-parse HEAD\` = ${head}\n      \`$GITHUB_SHA\`          = ${raw}\n`
        + '      ⇒ 判据比对的是"本地 git 对象库里的 HEAD"，而它**与被审对象同域可写**：载荷改写判据执行体'
        + '并 `git commit` 之后，`git show HEAD:` 与工作树自洽 ⇒ 本判据、`--restore`、`--require-clean`、'
        + '摘要登记**全部失效**而门禁 EXIT=0（第十三轮 R13-D-01 实测）。平台值是**另一个域**的值，'
        + '请以它为准；若这只是本地 checkout 落后/领先，请先 `git fetch` 对齐再跑。',
      note: null,
      sha: raw,
    }
  }
  return { fatal: null, note: `平台锚一致：HEAD == $GITHUB_SHA == ${raw.slice(0, 12)}…`, sha: raw }
}

/**
 * 从 `.github/workflows/*.yml` 的**文本**里抽出被引用的执行体路径（族形态过滤）。
 *
 * 来源不是手写清单：这是"CI 里真被执行的执行体"这一侧的**派生集合**，与
 * `CI_REFERENCED_EXECUTION_REGISTRY` 双向对拍（未登记即红 / 死条目即红）。
 * 扫的是 **HEAD 字节**（工作树里的 workflow 在 install 期同样可被改写）。
 * @param workflowTexts - `[文件名, 文本]` 数组。
 * @returns 排序后的路径数组。
 */
export function ciReferencedExecutionBodies(workflowTexts) {
  const hits = new Set()
  for (const [, text] of workflowTexts) {
    for (const match of String(text).matchAll(/(?:scripts|packages)\/[A-Za-z0-9._@/-]*\.(?:mjs|cjs|js|ts|sh|json)\b/gu)) {
      if (isExecutionFacePath(match[0])) hits.add(match[0])
    }
  }
  return [...hits].sort()
}

/**
 * ===========================================================================
 * 执行点推导（第十三轮 V13-A §4.4 / §11③ 的收口）
 * ===========================================================================
 *
 * ## 为什么要有这一段
 *
 * 族形态（{@link JUDGE_BODY_PATTERNS}）按**目录形状**取执行体 —— 那是个**代理指标**：
 * 只有当"执行体恰好都住在 `scripts/**` 与 `packages/<scope>/<pkg>/scripts/**` 里"时，
 * 它才等于真集合。V13-A §4.4 的实测反例有五类（`integration-tests/**` 的守卫用例、
 * 两个 `.py` 契约脚本与聚合层、各包的 `vitest.config.ts` / `tsdown.config.ts`、
 * `community/fabric/scripts/verify-docs.mjs`）：它们**真被执行 / 真决定判定**，却一条都
 * 不落在形状里 —— 在工作树里改写它们，本判据照样 EXIT=0。
 *
 * 所以这一段**从执行点反推**：谁是执行点，"被执行的东西"就是谁。四条来源：
 *
 *   (a) `.github/workflows/*.yml` 的每个 `run:` 块里**位于命令位 / 解释器实参位**的
 *       仓内路径（`node scripts/x.mjs` 里的那个实参）—— 不是"文本里提到过"：
 *       `git show HEAD:scripts/x.mjs` 是**实参位**（被读的输入），不算：
 *   (b) 根 `package.json` 的全部 scripts 值（`check:*` 是门禁入口表）与各工作区 /
 *       **非 workspace 的 npm 项目** `package.json` 的 `test` / `check` 值里的仓内路径 token
 *       （相对路径按**包目录**解析，因为 yarn/npm 跑这些脚本时的 cwd 就是包目录）；
 *   (c) `scripts/check-integration-tests.mjs`（`yarn check` 里真跑的守卫）的 spawn 目标，
 *       以及**它按目录枚举的语法面** —— 扩展名集合是**从它的文本里抽出来的**
 *       （`INTEGRATION_SCANNED_EXTENSIONS`），它改扫描面本集合跟着变，不在这里手抄；
 *   (d) 各包目录下的 `vitest.config.ts` / `tsdown.config.ts`（
 *       {@link PACKAGE_JUDGE_CONFIG_BASENAMES}）与 `tsconfig*.json` 一族
 *       （{@link PACKAGE_JUDGE_CONFIG_PATTERNS}）—— 前者决定"哪些 spec 真的会跑"，
 *       其次决定各包 `build` 的入口表，最后决定 `tsc -p` **判哪些文件**。
 *       "各包"= yarn workspace 包 ∪ **非 workspace 的 npm 项目**
 *       （{@link NPM_PROJECT_MANIFEST_REGISTRY}：`server/webadmin` 的 `vitest.config.ts`
 *       决定它那 668 个用例跑哪些，「不是 workspace」与「不在判据面」是两件事）。
 *
 * ## 语料不进这里（口径）
 *
 * **执行体 = 被执行 / 决定判定的东西；语料 = 被读的输入。** 判据是"改它会不会让**别的**
 * 判决换一个结论"：改 `vitest.config.ts` 会（少跑一批 spec），改一份 spec 不会 ⇒
 * `packages/<scope>/<pkg>/tests/**` 与 `integration-tests/electron-shots/` 下的截图（图片 fixture）
 * 留在集合外。
 *
 * ## 纯度
 *
 * 全部函数都是**纯函数**（输入是"文本 + 存在性谓词"），便于单独做正/反用例；
 * 读 HEAD 字节这件事只发生在 `main()` 里。判据**不 import 任何仓内模块**，也不联网。
 */

/** 解释器 / 启动器词：出现在命令位时，它的**第一个非 flag 实参**才是被执行的东西。 */
const LAUNCHER_WORDS = new Set([
  'node', 'nodejs', 'tsx', 'ts-node', 'deno', 'bun',
  'bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell',
  'python', 'python3', 'ruby', 'perl',
  'npx', 'corepack', 'yarn', 'pnpm', 'npm',
  'env', 'sudo', 'time', 'exec', 'command', 'nohup', 'xargs', 'systemd-run', 'choco', 'apt-get',
])

/** 仓内路径 token 形态（至少一段 `/`、以扩展名结尾、不含 shell 元字符与变量）。 */
const REPO_PATH_TOKEN = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+$/u

/** 文件扩展名（含点）；没有扩展名 ⇒ `''`。 */
function extensionOf(path) {
  const name = String(path).slice(String(path).lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot)
}

/** POSIX 口径归一化（折叠 `.` / `..` / 重复 `/`；不用 `node:path`，免得被平台分隔符带偏）。 */
export function normalizeRepoPath(path) {
  const segments = []
  for (const segment of String(path).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { segments.pop(); continue }
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * 各包"决定哪些 spec / 哪些产物真的进判定"的配置文件基名（{@link deriveExecutionPoints} 的
 * 来源 (d)）。这是一份**声明式口径**而不是"目录形状"：它说的是"这两个文件决定判定"，
 * 谁在哪个包里都得算；加一个要写明它决定了什么。
 */
export const PACKAGE_JUDGE_CONFIG_BASENAMES = ['vitest.config.ts', 'tsdown.config.ts']

/**
 * 同一分界线上的**同族形态**（第十四轮 B-01 的收口）：`tsconfig.json` /
 * `tsconfig.client.json` / `tsconfig.tests.json` / `tsconfig.tests.client.json` …
 *
 * 为什么它们与 `vitest.config.ts` 是**一对一孪生**：一个决定"哪些 spec 真的会跑"，
 * 一个决定 `tsc -p` **判哪些文件**（`check` 脚本就是 `tsc -p tsconfig.<x>.json`）。
 * 改它会让**别的**判决换一个结论（类型检查面静默变小）⇒ 按本文件自己的分界线，
 * 它在"执行体"一侧。B-01 现场：改 `packages/host/desktop/tsconfig.json`（= install 期
 * 改写）⇒ 本判据 EXIT=0 **并打印真凭据**，而改同族的 `vitest.config.ts` ⇒ EXIT=1。
 *
 * 按**基名形态**取而不是手抄名单：包里新加一个 `tsconfig.<新面>.json` 自动进面
 * （派生结果必须登记，未登记即红）。递归深度不放开 —— 只认包根（`<pkg>/tsconfig*.json`）。
 */
export const PACKAGE_JUDGE_CONFIG_PATTERNS = [
  /^tsconfig(?:\.[A-Za-z0-9_-]+)*\.json$/u,
]

/**
 * **非 yarn workspace 的 npm 项目 manifest**的派生（{@link NPM_PROJECT_MANIFEST_REGISTRY}）。
 *
 * 口径："**每一条 `package.json` 都是一个 install 期执行面**"—— 根 manifest 由
 * {@link EXTRA_EXECUTION_ENTRY_PATHS} 覆盖，workspace manifest 由 `workspaces` 展开覆盖，
 * 剩下的一条不落地全部由这里派生（不手抄名单）。`npm ci` 在某个目录里跑，就会执行那个
 * 目录的 manifest 声明的 install 期钩子（真 npm 实测），所以"是不是 workspace"与
 * "会不会在 install 期执行"是两件事。
 * @param headPaths - HEAD 的路径集合（`Set` 或数组）。
 * @param workspaceManifests - 已由 `workspaces` 展开出来的 manifest 路径。
 * @returns 排序后的路径数组。
 */
export function npmProjectManifestPaths(headPaths, workspaceManifests = []) {
  const listed = headPaths instanceof Set ? headPaths : new Set(headPaths ?? [])
  const covered = new Set(workspaceManifests)
  const found = new Set()
  for (const path of listed) {
    if (path === 'package.json') continue
    if (!String(path).endsWith('/package.json')) continue
    if (covered.has(path)) continue
    found.add(path)
  }
  return [...found].sort()
}

/**
 * 一段 shell 的**命令段**切分（引号感知）。
 *
 * 与 {@link ciReferencedExecutionBodies} 的"整份文本扫 token"不同：这里只认**语法位置**。
 * 切分符 = 换行 / `;` / `&&` / `||` / `|` / `&` / `$(` / `)` / 反引号；`>` `<` 是**词**分隔符
 * （重定向目标不是命令）；`#` 在词首时吃掉该行剩余（shell 注释），于是 workflow 里大段的
 * 中文注释不会贡献任何"命令位"。引号内的切分符不生效（`echo "a) scripts/x.mjs"` 不会把
 * 实参位误判成命令位）。
 * @param text - shell 文本。
 * @returns 命令数组，每条是词数组（引号已去）。
 */
export function shellCommands(text) {
  const commands = []
  let words = []
  let current = ''
  let quote = null
  const flushWord = () => { if (current !== '') { words.push(current); current = '' } }
  const flushCommand = () => { flushWord(); if (words.length > 0) commands.push(words); words = [] }
  const source = String(text)
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== null) {
      if (char === quote) { quote = null; continue }
      if (quote === '"' && char === '\\') { current += source[index + 1] ?? ''; index += 1; continue }
      current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '\\' && source[index + 1] === '\n') { index += 1; continue }
    if (char === '#' && current === '' && words.length === 0) {
      while (index < source.length && source[index] !== '\n') index += 1
      flushCommand()
      continue
    }
    if (char === '\n' || char === ';' || char === '`') { flushCommand(); continue }
    if (char === '&' || char === '|') { flushCommand(); if (source[index + 1] === char) index += 1; continue }
    if (char === '$' && source[index + 1] === '(') { flushCommand(); index += 1; continue }
    if (char === ')') { flushCommand(); continue }
    if (char === ' ' || char === '\t' || char === '\r' || char === '>' || char === '<') { flushWord(); continue }
    current += char
  }
  flushCommand()
  return commands
}

/**
 * 一个词是不是"启动器"（命令位上的解释器）：裸解释器名，或 runner 侧展开出来的
 * `${{ steps.… }}` 表达式（本仓的判据步一律用它取**冻结的绝对路径**启动器）。
 * @param word - 去引号后的词。
 * @returns 是否启动器。
 */
function isLauncherWord(word) {
  if (LAUNCHER_WORDS.has(word)) return true
  return /^\$\{\{[^}]*\}\}$/u.test(word)
}

/**
 * 从 workflow 文本里抽出全部 `run:` 块（块标量 `|` / `>` 与其变体，以及行内形态）。
 * @param text - workflow 文本。
 * @returns 块文本数组（块标量的公共缩进已剥掉）。
 */
export function workflowRunBlocks(text) {
  const lines = String(text).split('\n')
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*)(?:-[ \t]+)?run:[ \t]*(.*)$/u.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const rest = match[2].trim()
    if (rest !== '' && !/^[|>][-+]?[0-9]*$/u.test(rest)) { blocks.push(rest); continue }
    const body = []
    let cursor = index + 1
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') { body.push(''); continue }
      if (line.length - line.trimStart().length <= indent) break
      body.push(line)
    }
    const indents = body.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length)
    const cut = indents.length > 0 ? Math.min(...indents) : 0
    blocks.push(body.map(line => line.slice(cut)).join('\n'))
    index = cursor - 1
  }
  return blocks
}

/**
 * 从一段 shell 文本里抽**位于命令位 / 解释器实参位**的仓内路径。
 *
 * 命令位 = 每条命令的第一个词；解释器实参位 = 启动器词之后**跳过 flag 与 `NAME=VALUE`**
 * 的第一个词（链式：`corepack yarn …` 会继续往下走）。两者之外的词一律不看 ——
 * 这正是"被执行"与"被提到"的分界。
 * @param text - shell 文本。
 * @param exists - 存在性谓词（缺省全真；调用方传 `HEAD` 的路径集合）。
 * @returns 仓内路径数组（升序、去重）。
 */
export function commandPositionPaths(text, exists = () => true) {
  const found = new Set()
  for (const words of shellCommands(text)) {
    const candidates = [words[0]]
    let index = 0
    let hops = 0
    while (index < words.length && hops < 8) {
      hops += 1
      if (!isLauncherWord(words[index])) break
      let next = index + 1
      while (next < words.length
        && (words[next].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[next]))) next += 1
      if (next >= words.length) break
      candidates.push(words[next])
      index = next
    }
    for (const token of candidates) {
      if (!REPO_PATH_TOKEN.test(token) || extensionOf(token) === '') continue
      const path = normalizeRepoPath(token)
      if (exists(path)) found.add(path)
    }
  }
  return [...found].sort()
}

/**
 * 从一段 manifest `scripts` 值里抽仓内路径 token。
 *
 * `baseDir` 非空时按**包目录**解析（yarn 跑包脚本的 cwd 就是包目录：`node scripts/build.mjs`
 * 指的是 `<包>/scripts/build.mjs`），解析不出再退回仓库根口径。
 * @param value - script 值。
 * @param baseDir - 包目录（仓库根传 `''`）。
 * @param exists - 存在性谓词。
 * @returns 仓内路径数组（升序、去重）。
 */
export function manifestScriptPaths(value, baseDir = '', exists = () => true) {
  const found = new Set()
  for (const raw of String(value ?? '').split(/[\s;&|()<>]+/u)) {
    const token = raw.replace(/^["']|["']$/gu, '')
    if (!REPO_PATH_TOKEN.test(token) || extensionOf(token) === '') continue
    const local = normalizeRepoPath(baseDir === '' ? token : `${baseDir}/${token}`)
    if (exists(local)) { found.add(local); continue }
    if (exists(token)) found.add(token)
  }
  return [...found].sort()
}

/**
 * 从 `scripts/check-integration-tests.mjs` 的**文本**里抽"按目录枚举"的扩展名集合。
 *
 * 不在这里手抄 `.py` / `.mjs`：那个守卫自己声明了扫描面（`INTEGRATION_SCANNED_EXTENSIONS`
 * 与两处 `endsWith('…')`），它改口径本集合跟着变 —— 这正是"从执行点推导"而不是
 * "把当前形状抄成常量"的区别。抽不出任何扩展名 ⇒ 返回空数组，调用方按**推导面失效**处理
 * （fail-closed：不把"读不出"当成"没有执行点"）。
 * @param text - 守卫文本。
 * @returns 扩展名数组（含点，升序）。
 */
export function integrationScanExtensions(text) {
  const source = String(text)
  const extensions = new Set()
  const declaration = /INTEGRATION_SCANNED_EXTENSIONS\s*=\s*\[([^\]]*)\]/u.exec(source)
  if (declaration !== null) {
    for (const match of declaration[1].matchAll(/'(\.[A-Za-z0-9]+)'|"(\.[A-Za-z0-9]+)"/gu)) {
      extensions.add(match[1] ?? match[2])
    }
  }
  if (extensions.size === 0) {
    for (const match of source.matchAll(/endsWith\(\s*['"](\.[A-Za-z0-9]+)['"]\s*\)/gu)) extensions.add(match[1])
  }
  return [...extensions].sort()
}

/**
 * 从守卫文本里抽它**引用到**的 `integration-tests/…` 路径（字面量，或 `join(ROOT, 'a','b')`）。
 *
 * 这是"被它读/被它 spawn"的那一面；与 {@link integrationScanExtensions} 的枚举面合起来
 * 才是完整的来源 (c)：枚举面覆盖"按扩展名会被扫到的全部文件"，引用面兜住"枚举面之外的
 * 具名目标"（守卫改写法时不会漏）。
 * @param text - 守卫文本。
 * @returns 路径数组（升序、去重）。
 */
export function integrationReferencedPaths(text) {
  const source = String(text)
  const found = new Set()
  for (const match of source.matchAll(/['"]([A-Za-z0-9_.@/-]*integration-tests\/[A-Za-z0-9_.@/-]+)['"]/gu)) {
    found.add(normalizeRepoPath(match[1]))
  }
  for (const match of source.matchAll(/join\(\s*ROOT\s*,\s*((?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))*)\s*\)/gu)) {
    const parts = [...match[1].matchAll(/'([^']*)'|"([^"]*)"/gu)].map(quote => quote[1] ?? quote[2])
    if (parts.length > 0 && parts[0] === 'integration-tests') found.add(normalizeRepoPath(parts.join('/')))
  }
  return [...found].sort()
}

/**
 * **执行点推导（唯一实现）**：从四条来源算出"被执行 / 决定判定"的仓内路径全集。
 *
 * 纯函数：只吃文本与存在性谓词，不碰文件系统、不跑 git。
 * @param options - `{ workflowTexts, rootManifest, workspaceManifests, npmProjectManifests, guardText, headPaths }`。
 *   `workflowTexts` 是 `[文件名, 文本]`；`workspaceManifests` / `npmProjectManifests` 是
 *   `[{ path, manifest }]`（前者由 `workspaces` 展开、后者由 {@link npmProjectManifestPaths}
 *   从 HEAD 派生）；`headPaths` 是 HEAD 的路径集合（`Set` 或数组）。
 * @returns `{ points, faces, counts, extensions, missingSources }`。
 */
export function deriveExecutionPoints(options = {}) {
  const headPaths = options.headPaths instanceof Set ? options.headPaths : new Set(options.headPaths ?? [])
  const exists = path => headPaths.has(path)
  const points = new Set()
  const counts = { workflow: 0, manifest: 0, 'npm-project': 0, 'integration-guard': 0, 'package-config': 0 }
  const record = (source, paths) => {
    for (const path of paths) { counts[source] += points.has(path) ? 0 : 1; points.add(path) }
  }

  const workflowTexts = options.workflowTexts ?? []
  for (const [, text] of workflowTexts) record('workflow', commandPositionPaths(text, exists))

  for (const value of Object.values(options.rootManifest?.scripts ?? {})) {
    record('manifest', manifestScriptPaths(value, '', exists))
  }

  const guardText = String(options.guardText ?? '')
  const extensions = integrationScanExtensions(guardText)
  if (extensions.length > 0) {
    record('integration-guard', integrationReferencedPaths(guardText)
      .filter(path => exists(path) && extensions.includes(extensionOf(path))))
    record('integration-guard', [...headPaths]
      .filter(path => path.startsWith('integration-tests/') && extensions.includes(extensionOf(path))))
  }

  // 来源 (d) 的**包根**集合 = yarn workspace 包 ∪ 非 workspace 的 npm 项目
  // （`server/webadmin`、`site`、smoke 夹具包）。两者的"判据配置"语义完全一样：
  // 前者由 `workspaces` 展开，后者由 {@link npmProjectManifestPaths} 从 HEAD 派生并双向登记。
  const configurations = new Set()
  const packageRoots = [
    ...(options.workspaceManifests ?? []).map(entry => ({ ...entry, source: 'manifest' })),
    ...(options.npmProjectManifests ?? []).map(entry => ({ ...entry, source: 'npm-project' })),
  ]
  for (const entry of packageRoots) {
    const directory = String(entry.path).replace(/\/package\.json$/u, '')
    const source = entry.source ?? 'manifest'
    for (const key of ['test', 'check']) {
      record(source, manifestScriptPaths(entry.manifest?.scripts?.[key], directory, exists))
    }
    for (const name of PACKAGE_JUDGE_CONFIG_BASENAMES) {
      if (exists(`${directory}/${name}`)) configurations.add(`${directory}/${name}`)
    }
    for (const path of headPaths) {
      if (!String(path).startsWith(`${directory}/`)) continue
      const basename = String(path).slice(directory.length + 1)
      // 非递归：只认**包根**的判据配置（`<pkg>/tsconfig.json`），不认深层同名文件
      // （深层那些是各自的语料/夹具，把它们卷进来等于按目录形状取）。
      if (basename.includes('/')) continue
      if (PACKAGE_JUDGE_CONFIG_PATTERNS.some(pattern => pattern.test(basename))) configurations.add(path)
    }
  }
  record('package-config', [...configurations])

  // 工作树侧的**同类形态**：形状族看不见的那一半也要能在工作树里被枚举到
  // （否则"检出之后才新建的执行点"照旧隐形）。两张形态，都从上面的派生结果归纳：
  //   ① `integration-tests/**` 递归 + 守卫枚举的扩展名集合；
  //   ② 每个执行点的**父目录 + 同扩展名**（非递归）—— 于是包根新加一个
  //      `*.config.ts`、`community/fabric/scripts/` 新加一个 `.mjs` 都会被看见。
  const faces = []
  const seenFaces = new Set()
  const addFace = (directory, recursive, faceExtensions) => {
    if (directory === '' || faceExtensions.length === 0) return
    // 无扩展名的执行点（`Makefile`）**不**归纳成工作树形态：那会退化成"这个目录下所有无
    // 扩展名文件"，把 `server/server`（gitignored 构建产物）这类东西卷成假红（实测）。
    if (faceExtensions.every(extension => extension === '')) return
    const key = `${recursive ? 'recursive' : 'direct'}:${directory}:${[...faceExtensions].sort().join(',')}`
    if (seenFaces.has(key)) return
    seenFaces.add(key)
    faces.push({ dir: directory, recursive, extensions: [...faceExtensions].sort() })
  }
  if (extensions.length > 0 && [...points].some(path => path.startsWith('integration-tests/'))) {
    addFace('integration-tests', true, extensions)
  }
  for (const path of points) {
    addFace(path.slice(0, path.lastIndexOf('/')), false, [extensionOf(path)])
  }

  const sorted = [...points].sort()
  return {
    points: sorted,
    faces,
    counts,
    extensions,
    missingSources: [...(extensions.length === 0 ? ['integration-guard'] : []),
      ...(workflowTexts.length === 0 ? ['workflow'] : [])],
  }
}

/**
 * 双向登记对拍（登记表 vs 派生集合）。
 * @param label - 表名（用于报错）。
 * @param registered - 登记表。
 * @param derived - 派生集合。
 * @param detail - 未登记时的追加说明。
 * @returns 问题清单。
 */
export function bidirectionalRegistryProblems(label, registered, derived, detail) {
  const problems = []
  const registeredSet = new Set(registered)
  const derivedSet = new Set(derived)
  const missing = derived.filter(path => !registeredSet.has(path))
  const dead = registered.filter(path => !derivedSet.has(path))
  if (missing.length > 0) {
    problems.push(`${label} 有 ${missing.length} 条**未登记**的执行体：${missing.slice(0, 8).join('、')}`
      + `${missing.length > 8 ? ' …' : ''}\n      ⇒ ${detail}`)
  }
  if (dead.length > 0) {
    problems.push(`${label} 有 ${dead.length} 条**死条目**（登记了却不在集合里）：${dead.slice(0, 8).join('、')}`
      + `${dead.length > 8 ? ' …' : ''}\n      ⇒ 死条目 = 登记表在长成豁免洞，或者派生集合的取值面被收窄了`
      + '（后者更危险：判据面悄悄变小而登记表看不出来）。')
  }
  return problems
}

/**
 * 一份 manifest 上的未登记钩子（纯函数，便于自检 / 变异验证）。
 * @param path - manifest 的仓库相对路径（用于报错与登记键）。
 * @param manifest - 解析后的 manifest。
 * @returns 问题清单。
 */
export function lifecycleHookProblems(path, manifest) {
  const registered = new Set(INSTALL_INTEGRITY_REGISTERED_HOOKS)
  const problems = []
  for (const hook of INSTALL_INTEGRITY_LIFECYCLE_HOOKS) {
    const body = manifest?.scripts?.[hook]
    if (typeof body !== 'string') continue
    if (registered.has(`${path}#${hook}`)) continue
    problems.push(`${path} 的 \`scripts.${hook}\` 是**安装期生命周期钩子**且没有登记：${JSON.stringify(body)}`
      + '\n      ⇒ `enableScripts: false` 只挡**依赖**的构建脚本 —— 工作区自己的 postinstall'
      + '照样在 install 期执行（真 yarn 4.18.0 实测），而 CI 的 `yarn install --immutable` 排在'
      + '所有判据之前 ⇒ install 期可以改写判据执行体。'
      + `\n      ⇒ 确实需要时登记进 \`INSTALL_INTEGRITY_REGISTERED_HOOKS\`（键 \`${path}#${hook}\`）`
      + '并写清"为什么必须发生在 install 期"。')
  }
  return problems
}

/**
 * 判据主流程。
 * @param argv - 命令行参数（去掉 `node` 与脚本名）。
 * @returns 退出码。
 */
function main(argv) {
  const problems = []
  const notes = []
  const options = { root: null, restore: false, json: null, printExecutionFace: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--restore') { options.restore = true; continue }
    // 打印两张登记表（粘回本文件的 `EXECUTION_FACE_REGISTRY` / `CI_REFERENCED_EXECUTION_REGISTRY`）。
    if (argument === '--print-execution-face') { options.printExecutionFace = true; continue }
    if (argument === '--root' || argument === '--json') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`check-install-integrity: \`${argument}\` 需要一个取值\n`)
        return 2
      }
      if (argument === '--root') options.root = value
      else options.json = value
      index += 1
      continue
    }
    process.stderr.write(`check-install-integrity: 未知参数 ${argument}\n`)
    return 2
  }

  // 仓库根：显式 `--root` > cwd 的 git 顶层（判据输入是 **git 对象**，没有 git 就没得判）。
  const cwd = process.cwd()
  let root = options.root === null ? null : resolve(options.root)
  if (root === null) {
    const top = git(cwd, ['rev-parse', '--show-toplevel'])
    if (top.status !== 0) {
      process.stderr.write('check-install-integrity: 当前目录不在 git 检出里（读不到仓库根）——'
        + '本判据的输入是 HEAD 对象，没有它就无从判起（拒绝把"读不到"当成"没问题"）\n')
      return 2
    }
    root = String(top.stdout).trim()
  }
  if (!existsSync(join(root, 'package.json'))) {
    process.stderr.write(`check-install-integrity: ${root} 下没有 package.json ⇒ 不是仓库根`
      + '（用 `--root <仓库根>` 指定）\n')
    return 2
  }
  const headSha = git(root, ['rev-parse', 'HEAD'])
  if (headSha.status !== 0 || !/^[0-9a-f]{40}$/u.test(String(headSha.stdout).trim())) {
    process.stderr.write('check-install-integrity: 读不到 `git rev-parse HEAD` ⇒ 判据输入缺席\n')
    return 2
  }
  const head = String(headSha.stdout).trim()

  // ⓪ **平台锚**（第十三轮 R13-D-01）：HEAD 必须等于平台侧 `$GITHUB_SHA`。
  //    放在**最前面**：锚不一致时后面所有"HEAD vs 工作树"的比对都可能是自洽的假绿
  //    （载荷改写判据并 `git commit` 之后，"本地 HEAD" 就是载荷自己的那份）。
  const anchor = headAnchorProblems({ head, env: process.env })
  if (anchor.fatal !== null) {
    process.stderr.write(`\ncheck-install-integrity: ${anchor.fatal}\n`)
    process.stderr.write('  ⇒ 退出码 2：判据输入（平台锚）不可信，拒绝在本棵树上作任何判决。\n')
    return 2
  }
  if (anchor.note !== null) notes.push(anchor.note)

  // ① 判据执行体的**形状族**（HEAD 侧）。
  const familyHeadBodies = listHeadJudgeBodies(root)
  if (familyHeadBodies === null) {
    process.stderr.write('check-install-integrity: 读不出 HEAD 的执行体清单\n')
    return 2
  }
  for (const required of REQUIRED_JUDGE_BODIES) {
    if (!familyHeadBodies.includes(required)) {
      process.stderr.write(`check-install-integrity: 必需的判据执行体不在 HEAD 里：${required}\n`
        + '  ⇒ 判据面残缺，拒绝在"少了几份判据"的树上判"通过"。\n')
      return 2
    }
  }

  // ② 根 manifest 的 workspaces（HEAD 侧：登记面按**提交的那份**算，避免被 install 期改动带偏）。
  const headRootManifestBytes = readHeadBlob(root, 'package.json')
  if (headRootManifestBytes === null) {
    process.stderr.write('check-install-integrity: HEAD 里没有 package.json\n')
    return 2
  }
  let headRootManifest
  try {
    headRootManifest = JSON.parse(headRootManifestBytes.toString('utf8'))
  } catch (error) {
    process.stderr.write(`check-install-integrity: 解析 HEAD 的 package.json 失败：${error.message}\n`)
    return 2
  }
  const workspaceManifests = expandWorkspaceManifests(root, headRootManifest?.workspaces ?? [])
  if (workspaceManifests.length === 0) {
    process.stderr.write('check-install-integrity: 从 HEAD 的 `workspaces` 展开出 0 个 manifest ——'
      + '"一个都展开不出来"与"没有工作区"不可区分，按判据输入缺席处理\n')
    return 2
  }

  // ②b **执行点推导**（第十三轮 V13-A §4.4 / §11③ 的收口）：执行体全集不再只按目录形状取，
  //     另一半由"谁真的被执行"反推（{@link deriveExecutionPoints}）。
  const derivation = {
    points: [],
    faces: [],
    counts: { workflow: 0, manifest: 0, 'npm-project': 0, 'integration-guard': 0, 'package-config': 0 },
    extensions: [],
    missingSources: [],
  }
  let ciReferenced = []
  // 非 yarn workspace 的 npm 项目 manifest（B-02）：从 **HEAD 路径全集**派生（不手抄名单）。
  let npmManifestPaths = []
  // 仓内每一个 `Makefile`（CI 的 `make build-server` 读它）—— 同一分界线上的第三个答案。
  let makefiles = []
  {
    // 输入全部取自 **HEAD 字节**（install 期能改写工作树，读工作树那份等于让载荷自己选判据面）。
    const headWorkflowTexts = []
    const workflowNames = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', '.github/workflows'])
    if (workflowNames.status !== 0) {
      process.stderr.write('check-install-integrity: 读不出 HEAD 的 `.github/workflows/` 清单\n')
      return 2
    }
    for (const name of String(workflowNames.stdout).split('\0').filter(entry => /\.ya?ml$/u.test(entry))) {
      const bytes = readHeadBlob(root, name)
      if (bytes === null) continue
      headWorkflowTexts.push([name, bytes.toString('utf8')])
    }
    if (headWorkflowTexts.length === 0) {
      process.stderr.write('check-install-integrity: HEAD 里一份 workflow 都读不到 ⇒'
        + '"CI 里真被执行的执行体"这条来源缺席，拒绝把"读不到"当成"没有"\n')
      return 2
    }
    ciReferenced = ciReferencedExecutionBodies(headWorkflowTexts)

    const headPaths = listHeadPaths(root)
    if (headPaths === null) {
      process.stderr.write('check-install-integrity: 读不出 HEAD 的路径清单（执行点推导的存在性谓词）\n')
      return 2
    }
    const guardBytes = readHeadBlob(root, 'scripts/check-integration-tests.mjs')
    if (guardBytes === null) {
      process.stderr.write('check-install-integrity: HEAD 里没有 scripts/check-integration-tests.mjs ⇒'
        + '"`integration-tests/` 守卫的执行点"这条来源缺席，拒绝把"读不到"当成"没有"\n')
      return 2
    }
    const workspaceManifestData = []
    for (const path of workspaceManifests) {
      const bytes = readHeadBlob(root, path)
      if (bytes === null) continue
      try {
        workspaceManifestData.push({ path, manifest: JSON.parse(bytes.toString('utf8')) })
      } catch {
        // manifest 不是合法 JSON 这件事由 ⑥ 段单独报（那里也要用同一份字节），这里跳过即可。
      }
    }
    // 非 workspace 的 npm 项目（B-02）：派生 → 读 HEAD 字节 → 与 workspace 包同一套口径
    // （判据配置来源 (d) + install 期钩子扫描 + 逐字节对拍）。
    npmManifestPaths = npmProjectManifestPaths(headPaths, workspaceManifests)
    makefiles = makefilePaths(headPaths)
    const npmManifestData = []
    for (const path of npmManifestPaths) {
      const bytes = readHeadBlob(root, path)
      if (bytes === null) continue
      try {
        npmManifestData.push({ path, manifest: JSON.parse(bytes.toString('utf8')) })
      } catch {
        // 同上：非法 JSON 由 ⑥ 段报。
      }
    }
    Object.assign(derivation, deriveExecutionPoints({
      workflowTexts: headWorkflowTexts,
      rootManifest: headRootManifest,
      workspaceManifests: workspaceManifestData,
      npmProjectManifests: npmManifestData,
      guardText: guardBytes.toString('utf8'),
      headPaths,
    }))
    if (derivation.missingSources.length > 0) {
      process.stderr.write(`check-install-integrity: 执行点推导的来源缺席（${derivation.missingSources.join('、')}）⇒`
        + '判据面会静默变小，拒绝把"读不出"当成"没有执行点"\n')
      return 2
    }
  }

  // ②c **执行体全集 = 形状族 ∪ 执行点推导**（两侧都取自 HEAD）。
  const headBodies = [...new Set([...familyHeadBodies, ...derivation.points])].sort()

  if (options.printExecutionFace) {
    const print = (label, paths) => {
      process.stdout.write(`# ${label}（${paths.length} 条）\n`)
      for (const path of paths) process.stdout.write(`  '${path}',\n`)
    }
    const outsideFamily = derivation.points.filter(path => !isExecutionFacePath(path))
    const derivedFamily = derivation.points.filter(path => isExecutionFacePath(path))
    print('EXECUTION_FACE_REGISTRY', familyHeadBodies)
    print('EXECUTION_POINT_REGISTRY', outsideFamily)
    print('CI_REFERENCED_EXECUTION_REGISTRY', ciReferenced)
    print('NPM_PROJECT_MANIFEST_REGISTRY', npmManifestPaths)
    print('MAKEFILE_REGISTRY', makefiles)
    process.stdout.write(`# 执行点推导合计 ${derivation.points.length} 条`
      + `（workflow 命令位 ${derivation.counts.workflow} · manifest scripts ${derivation.counts.manifest}`
      + ` · npm 项目 ${derivation.counts['npm-project']}`
      + ` · integration-tests 守卫 ${derivation.counts['integration-guard']}`
      + ` · 包内判据配置 ${derivation.counts['package-config']}）；`
      + `其中形状族已覆盖 ${derivedFamily.length} 条、EXECUTION_POINT_REGISTRY 承载 ${outsideFamily.length} 条`
      + `（两侧互斥、并集 = 完整执行面 ${headBodies.length} 条）\n`)
    return 0
  }

  // ②d **双向登记**（第十三轮 D-03 / C-P1 / V1 三路独立复现的收口 + V13-A §4.4 的执行点面
  //     + 第十四轮 B-01/B-02 的 tsconfig 族与 npm 项目 manifest）。
  //     五张表各自与"自己的派生来源"双向对拍：派生却未登记 ⇒ 红、登记了却派生不出 ⇒ 红。
  {
    problems.push(...bidirectionalRegistryProblems(
      'EXECUTION_FACE_REGISTRY',
      EXECUTION_FACE_REGISTRY,
      familyHeadBodies,
      '新增执行体必须登记（`node scripts/check-install-integrity.mjs --print-execution-face` 打印可粘贴表）'
      + '—— 未登记的执行体不进"工作树 == HEAD"的比对面，也不进 `--restore` 的覆盖集。',
    ))
    const pointsOutsideFamily = derivation.points.filter(path => !isExecutionFacePath(path))
    problems.push(...bidirectionalRegistryProblems(
      'EXECUTION_POINT_REGISTRY',
      EXECUTION_POINT_REGISTRY,
      pointsOutsideFamily,
      '"被执行 / 决定判定但不在形状族目录里"的执行点必须登记（同一份 `--print-execution-face` 打印）'
      + '—— 它们同样要进"工作树 == HEAD"的比对面与 `--restore` 的覆盖集；'
      + '语料（各包 `tests/**` 的 spec）**不**属于这一面，别把它们加进来。',
    ))
    problems.push(...bidirectionalRegistryProblems(
      'CI_REFERENCED_EXECUTION_REGISTRY',
      CI_REFERENCED_EXECUTION_REGISTRY,
      ciReferenced,
      '`.github/workflows/*.yml` 里被引用的执行体就是"CI 里真在跑的东西"—— 它必须与登记表双向相等'
      + '（未登记 = 新执行体悄悄进了 CI；死条目 = 登记表在长成豁免洞）。',
    ))
    // 第四条边（B-02）：非 workspace 的 npm 项目 manifest。派生 = HEAD 里除根/工作区之外的
    // 每一条 `package.json` —— 未登记 = 新的 npm 项目（它的 install 期钩子与判据配置）悄悄
    // 进了判据面之外；死条目 = 那条 manifest 已经不在了。
    problems.push(...bidirectionalRegistryProblems(
      'MAKEFILE_REGISTRY',
      MAKEFILE_REGISTRY,
      makefiles,
      '仓内每一个 Makefile 都要登记（`--print-execution-face` 打印可粘贴表）—— CI 的'
      + ' `make build-server`（以及 `make check`）读的就是它，改写它 = 改写那条构建真的跑什么。',
    ))
    problems.push(...bidirectionalRegistryProblems(
      'NPM_PROJECT_MANIFEST_REGISTRY',
      NPM_PROJECT_MANIFEST_REGISTRY,
      npmManifestPaths,
      '非 yarn workspace 的 npm 项目 manifest 必须登记（`--print-execution-face` 打印可粘贴表）'
      + '—— CI 的 `npm ci` 在它的目录里跑就会执行它声明的 install 期钩子（真 npm 实测），'
      + '而"不是 workspace"不等于"不在 install 期执行"。',
    ))
    notes.push(`执行体全集：${headBodies.length} 条 = 形状族 ${familyHeadBodies.length} 条`
      + ` + 执行点推导 ${derivation.points.length} 条（workflow 命令位 ${derivation.counts.workflow}`
      + ` · manifest scripts ${derivation.counts.manifest}`
      + ` · npm 项目 ${derivation.counts['npm-project']}`
      + ` · integration-tests 守卫 ${derivation.counts['integration-guard']}`
      + ` · 包内判据配置 ${derivation.counts['package-config']}），五张登记表双向对拍通过`)
  }

  const worktreeBodies = listWorktreeJudgeBodies(root, derivation.faces)
  const bodyPaths = [...new Set([...headBodies, ...worktreeBodies])].sort()

  const entryPaths = [...new Set([
    ...EXTRA_EXECUTION_ENTRY_PATHS,
    ...bodyPaths,
    ...workspaceManifests,
    // B-02：npm 侧 manifest 与执行体同一条纪律 —— 工作树那份必须与 HEAD 逐字节一致。
    ...npmManifestPaths,
    // Makefile 族同理（工作树侧不枚举形态，但已在 HEAD 派生的那些照样逐字节对拍 + `--restore`）。
    ...makefiles,
  ])].sort()

  // ③ 逐字节对拍（两侧都读 git 对象：工作树那份**可能已被 install 期改写**）。
  const digests = {}
  const restored = []
  for (const path of entryPaths) {
    const headBytes = readHeadBlob(root, path)
    const absolute = join(root, path)
    const present = existsSync(absolute)
    const stats = present ? lstatSync(absolute) : null
    if (headBytes === null) {
      if (present) {
        problems.push(`${path} **不在 HEAD 里**（工作树里却有）—— 这正是"检出之后才被创建"的形态`
          + '（install 期的插件/钩子写入），或者是一条没进版本库的登记路径')
      }
      continue
    }
    digests[path] = sha256(headBytes)
    if (!present) {
      problems.push(`${path} 在 HEAD 里存在，工作树里**不存在**（被判据的执行体记录在案）`)
      continue
    }
    if (stats.isSymbolicLink()) {
      problems.push(`${path} 是一个**符号链接** —— 内容来自仓外（同族的投放机制）`)
      continue
    }
    if (!stats.isFile()) {
      problems.push(`${path} 不是一个常规文件`)
      continue
    }
    const worktreeBytes = readFileSync(absolute)
    if (!worktreeBytes.equals(headBytes)) {
      problems.push(`${path} 的**工作树内容与 HEAD 不一致**：\n`
        + `      HEAD    sha256：${sha256(headBytes)}\n`
        + `      工作树 sha256：${sha256(worktreeBytes)}\n`
        + '      ⇒ 判据执行体只在"没有被改写"时才可信；install 期（插件的顶层模块代码 / 工作区'
        + '生命周期钩子）正是改写它的窗口 —— 这一步必须在**任何 yarn 命令之前**跑。')
    }
    if (options.restore && !worktreeBytes.equals(headBytes)) {
      writeFileSync(absolute, headBytes)
      restored.push(path)
    }
  }

  // ④ `.yarnrc.yml` 的禁键 / 必需标量（HEAD 与工作树**两份都判**：任何一份带禁键都红）。
  {
    const path = '.yarnrc.yml'
    const headBytes = readHeadBlob(root, path)
    const absolute = join(root, path)
    const texts = []
    if (headBytes !== null) texts.push(['HEAD', headBytes.toString('utf8')])
    if (existsSync(absolute)) {
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) {
        problems.push(`${path} 是一个**符号链接** —— 入口配置必须来自版本库里的常规文件（HEAD 那份已单独判）`)
      } else if (stats.isFile()) {
        texts.push(['工作树', readFileSync(absolute, 'utf8')])
      } else {
        problems.push(`${path} 不是一个常规文件`)
      }
    }
    for (const [side, text] of texts) {
      const keys = yarnrcTopLevelKeys(text)
      if (keys.length === 0) {
        problems.push(`${path}（${side}）读不出任何顶层键 ⇒ 解析面失效，拒绝把"读不出"当成"没有"`)
        continue
      }
      for (const forbidden of INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS) {
        if (!keys.includes(forbidden)) continue
        problems.push(`${path}（${side}）里有**禁键** \`${forbidden}\` —— 它能在 yarn **启动期**`
          + '执行仓内代码（`plugins:`）/ 换掉整个 yarn 解释器（`yarnPath:`），'
          + '而判据步骤排在 install **之后** ⇒ ci.yml 一字未改也能让全部判定块变绿')
      }
      for (const [key, expected] of INSTALL_INTEGRITY_REQUIRED_YARN_SCALARS) {
        const actual = yarnrcScalar(text, key)
        if (actual !== expected) {
          problems.push(`${path}（${side}）的 \`${key}\` 必须是 \`${expected}\`（实际 ${JSON.stringify(actual)}）`)
        }
      }
    }
    notes.push(`${path}：禁键 ${INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS.join('/')} 缺席（HEAD 与工作树两侧）`)
  }

  // ④b **yarn 入口族的环境面**（第十三轮 C-03）：文件面的键判据看不见环境面这条通道。
  {
    const envProblems = yarnEntryEnvironmentProblems(process.env)
    problems.push(...envProblems)
    if (envProblems.length === 0) {
      notes.push(`yarn 入口族环境面：${INSTALL_INTEGRITY_YARN_ENV_ENTRY_PATTERN.source} 在判据进程环境里零命中`)
    }
  }

  // ⑤ `.yarn/plugins` / `.yarn/releases`：工作树与 HEAD 两侧都必须为空。
  for (const directory of YARN_CODE_DIRECTORIES) {
    const absolute = join(root, directory)
    const files = []
    if (existsSync(absolute)) {
      const walk = current => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name)
          if (entry.isDirectory()) walk(path)
          else files.push(relative(join(root, directory), path))
        }
      }
      walk(absolute)
    }
    const tracked = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', directory])
    const trackedFiles = tracked.status === 0
      ? String(tracked.stdout).split('\0').filter(name => name !== '')
      : []
    if (files.length > 0 || trackedFiles.length > 0) {
      problems.push(`${directory}/ 必须为空（工作树 ${files.length} 个文件、HEAD ${trackedFiles.length} 个）`
        + `：${[...trackedFiles, ...files].slice(0, 3).join('、')}`
        + '\n      ⇒ yarn **只凭 `.yarnrc.yml` 里的引用**就会读这里的文件（`plugins:` → `.cjs` 被'
        + '`require`，`yarnPath:` → `yarn.js` 被当 yarn 本体）—— 放一个文件进去就是完整载荷')
    } else {
      notes.push(`${directory}：空（工作树与 HEAD）`)
    }
  }

  // ⑥ install 期生命周期钩子：根 + **每一个** workspace manifest + **每一个**非 workspace 的
  //     npm 项目 manifest（读 HEAD 那份字节）。B-02：`npm ci` 在 `server/webadmin` 里跑就会
  //     执行它自己的 `postinstall`，而这条通道此前一条判据都没有。
  const manifestPaths = ['package.json', ...workspaceManifests, ...npmManifestPaths]
  for (const path of manifestPaths) {
    const bytes = readHeadBlob(root, path)
    if (bytes === null) {
      problems.push(`${path} 不在 HEAD 里 —— manifest 登记面残缺`)
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      problems.push(`${path} 不是合法 JSON（HEAD 那份）：${error.message}`);
      continue
    }
    problems.push(...lifecycleHookProblems(path, manifest))
  }
  notes.push(`install 期生命周期钩子：根 + ${workspaceManifests.length} 个工作区 manifest`
    + ` + ${npmManifestPaths.length} 个 npm 项目 manifest 全部无未登记钩子`)

  if (options.restore && restored.length > 0) {
    notes.push(`已按 HEAD 重写 ${restored.length} 条执行体：${restored.slice(0, 5).join('、')}${restored.length > 5 ? ' …' : ''}`)
  }

  // **封印（`--json`）必须与判定同形**（第十四轮 B-05 的收口；编号不占前面的 ⑦，那条是
  //  `main()` ④b 段的 yarn 入口族环境面）。
  //
  //    现场：写 json 的语句排在上面的 `if (problems.length > 0) … return 1` **之前**，写出的对象里
  //    没有 `verdict` / `exitCode` / `problems` 任何字段 ⇒ **EXIT=1 的那次运行**留下一枚
  //    `headEqualsGithubSha:true / judgeBodies:… / digests{…}` 的"通过状"封印
  //    （锚致命、退出码 2 时确实不写 —— 那一半是对的）。
  //    全仓当时没有消费者，但"封印"这个词会让人把它当通过记录 ⇒ 现在按**结论分形态**：
  //    通过才写 `digests` 封印；失败写的是失败形态（`verdict/ok/exitCode/problemCount/problems`）。
  if (options.json !== null) {
    const jsonPayload = () => ({
      // 结论三件套（先于任何"通过状"内容）。
      verdict: problems.length > 0 ? 'FAIL' : 'PASS',
      ok: problems.length === 0,
      exitCode: problems.length > 0 ? 1 : 0,
      head,
      // 平台锚（第十三轮 R13-D-01）：CI 侧断言按这个值对拍 `$GITHUB_SHA`。
      githubSha: anchor.sha,
      headEqualsGithubSha: anchor.sha !== null,
      judgeBodies: bodyPaths.length,
      // 执行点推导（第十三轮 V13-A §4.4）：形状族之外那一半的面。
      executionPoints: derivation.points.length,
      executionPointRegistry: EXECUTION_POINT_REGISTRY.length,
      npmProjectManifests: npmManifestPaths.length,
      ciReferencedExecutionBodies: CI_REFERENCED_EXECUTION_REGISTRY.length,
      workspaceManifests: workspaceManifests.length,
      restored,
      // "通过状"内容（逐条执行体的摘要封印）**只在判定通过时**写。
      ...(problems.length === 0
        ? { digests }
        : {
          problemCount: problems.length,
          // 只记每条的首行：够定位，且不把整份 diff 再抄一遍进封印。
          problems: problems.map(detail => String(detail).split('\n')[0]),
        }),
    })
    const writeJson = () => writeFileSync(options.json, `${JSON.stringify(jsonPayload(), null, 2)}\n`)
    try {
      writeJson()
    } catch (error) {
      problems.push(`写不出 --json ${options.json}：${error.message}`)
      // "写不出封印"本身就是一条未通过项 ⇒ 结论从 PASS 变成 FAIL，补写一次失败形态。
      // 仍然写不出去就只在 stderr 上留痕（不吞）。
      try { writeJson() } catch { /* 已在 problems 里 */ }
    }
  }

  if (problems.length > 0) {
    for (const detail of problems) process.stderr.write(`\ncheck-install-integrity: ${detail}\n`)
    process.stderr.write(`\ncheck-install-integrity: ${problems.length} 项未通过`
      + `（判据执行体 ${bodyPaths.length} 条 · manifest ${manifestPaths.length} 个 · HEAD ${head.slice(0, 12)}）\n`)
    // `--restore` 在失败运行里同样有副作用 —— 与 `--json` 同一条纪律：**不许只在通过路径上报**。
    // （此前这条 note 只出现在下面的 OK 凭据行里，于是"失败 + 已还原"的运行对操作者不可见。）
    if (options.restore && restored.length > 0) {
      process.stderr.write(`check-install-integrity: 已按 HEAD 重写 ${restored.length} 条执行体：`
        + `${restored.slice(0, 5).join('、')}${restored.length > 5 ? ' …' : ''}\n`)
    }
    process.stderr.write('  ⇒ 这一步是"判据本体在 install 期有没有被改写"的前置校验，'
      + '**必须在任何 yarn/corepack 命令之前**跑：它一旦红，后面的判定块无论打印什么都不作数。\n')
    return 1
  }

  process.stdout.write(`check-install-integrity: VERDICT PASS judge-bodies=${bodyPaths.length}`
    + ` execution-points=${derivation.points.length}`
    + ` manifests=${manifestPaths.length} head=${head.slice(0, 12)}`
    + ` github-sha=${anchor.sha ?? 'absent'}\n`)
  process.stdout.write(`check-install-integrity: OK — 判据执行体 ${bodyPaths.length} 条（形状族 ${familyHeadBodies.length}`
    + ` + 执行点推导 ${derivation.points.length}：workflow 命令位 / manifest scripts / npm 项目 /`
    + ` integration-tests 守卫 / 包内判据配置（vitest / tsdown / tsconfig*）`
    + ` + .yarnrc.yml + .gitignore + package.json + ${workspaceManifests.length} 个工作区 manifest`
    + ` + ${npmManifestPaths.length} 个 npm 项目 manifest + ${makefiles.length} 个 Makefile）`
    + `与 HEAD(${head.slice(0, 12)}) **逐字节一致**；${notes.join('；')}\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = main(process.argv.slice(2))
  // 与两个 runner 同一套加固：显式退出（只设 `process.exitCode` 会被 `--import` 注入的退出钩子改写）。
  process.removeAllListeners('exit')
  process.removeAllListeners('beforeExit')
  process.exit(code)
}

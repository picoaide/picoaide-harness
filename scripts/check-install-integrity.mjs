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
 *      + **根与每一个 workspace 包的 `package.json`**；
 *   ② 根 `.yarnrc.yml` 里**禁键** `yarnPath` / `plugins` 缺席、`enableScripts: false` 与
 *      `nodeLinker: node-modules` 在位，且必须是常规文件（符号链接 = 内容来自仓外）；
 *      **解析面必须覆盖真 YAML 的等价写法**（BOM / 引号键 / 缩进的根映射 / 显式键 `? key`）——
 *      六种形态见 `yarnrcKeyValuePairs()` 与 `temp/r13/…` 的回归用例；
 *   ③ `.yarn/plugins` 与 `.yarn/releases`（"可提交 + 会被 yarn 当代码读"）**工作树与
 *      HEAD 两侧都为空**；
 *   ④ 根与**每一个 workspace manifest** 都没有**未登记**的 install 期生命周期钩子
 *      （登记表 `INSTALL_INTEGRITY_REGISTERED_HOOKS` 当前为空 = 禁新增）；
 *   ⑤ **平台锚**（第十三轮 R13-D-01）：`git rev-parse HEAD` 必须等于 `$GITHUB_SHA`
 *      （CI 上必在场；不等 / 缺失 ⇒ **退出码 2**）。锚在**平台侧不可改写值**上，而不是
 *      "本进程读得到的那个 HEAD" —— 载荷可以改写本地 git 对象库并 `git commit`，让
 *      `git show HEAD:` 与工作树自洽，从而让①②③④全部失效；
 *   ⑥ **执行体全集的双向登记**：集合来源 = 真实族形态（`scripts/check-*.mjs`、
 *      `scripts/wasm/check-*.mjs`、`scripts/wasm/probes/*.cjs`、`scripts/verify-*.{mjs,sh}`、
 *      `scripts/ci-*.sh`、`packages/<scope>/<pkg>/scripts/**`）∪ **`.github/workflows/*.yml`
 *      里真的被引用的执行体**；登记表 `EXECUTION_FACE_REGISTRY` 与两侧**双向**对拍 ——
 *      未登记即红、登记了却不在集合里也红（死条目）。`--restore` 的覆盖集 = 同一份全集；
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
 * 关掉"比对通过→判据启动"之间的改写窗口）、`--json <path>`（落一份摘要封印，供留痕）、
 * `--print-execution-face`（打印两张登记表，供把新的执行体粘回本文件）。
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
 *     的第一个执行体**"这个**位置**（由 `check-workflows.mjs` 的 [SK-14⑨] 钉住），
 *     第二道网是 `check-guard-parser-integrity.mjs` 的**远端对象库锚**（判据执行体按
 *     `$GITHUB_SHA` 从 `origin` 取回，载荷改不了远端）。本脚本自己只做第一道网。
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
 * **执行体形态**（第十三轮 D-03 / C-P1 / V1 三路独立复现的收口）。
 *
 * 第十二轮只认 `^scripts/check-[^/]*\.mjs$`（`[^/]*` 显式排除子目录）—— 于是把
 * `scripts/wasm/check-deletion-surface.mjs` 换成恒绿空壳即可让**真实错误状态**
 * 由 `group 2 pass=2 fail=1 / EXIT=1` 变成 `pass=3 fail=0 / EXIT=0`，而两道 install 期锚
 * 同时打 `VERDICT PASS judge-bodies=13` 与 OK（审计实测，可复跑）。
 *
 * 现在的形态**按"CI 里真被执行的执行体"取值**（不是手写清单）：六条族形态覆盖
 * `scripts/**` 的全部判据执行体与 `packages/<scope>/<pkg>/scripts/**`（desktop 的
 * `verify-packaged-runtime.ts` 等 afterPack 判据就在这里）。
 */
const JUDGE_BODY_PATTERNS = [
  /^scripts\/[^/]+\.(?:mjs|cjs|js|ts|sh)$/u,
  /^scripts\/wasm\/[^/]+\.(?:mjs|cjs|js|ts|sh)$/u,
  /^scripts\/wasm\/probes\/[^/]+\.(?:mjs|cjs|js|ts)$/u,
  // 门禁**清单**（判决的数据面）：`wasm-gate-inventory.json` 的桶资格/预算在这里，
  // 它和判据脚本一样能决定红绿（第三轮审计 W-1 的形态）。
  /^scripts\/wasm\/[^/]+\.json$/u,
  /^packages\/[^/]+\/[^/]+\/scripts\/[^/]+\.(?:mjs|cjs|ts|js)$/u,
]

/** 判定一个仓库相对路径是否是"执行体形态"（六条族形态之一）。 */
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
 * 递归面 = `scripts/**`（含 `wasm/`、`wasm/probes/`）与 `packages/<scope>/<pkg>/scripts/*`
 * ——与 {@link JUDGE_BODY_PATTERNS} 的族形态一一对应。
 * @param root - 仓库根。
 * @returns 相对路径数组（升序）。
 */
function listWorktreeJudgeBodies(root) {
  const found = new Set()
  const walk = relativeDirectory => {
    const absolute = join(root, relativeDirectory)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        // `scripts/` 全深度递归；`packages/<scope>/<pkg>/scripts/` 只认直接子文件。
        if (relativeDirectory === 'scripts' || relativeDirectory === 'scripts/wasm') walk(path)
        continue
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && isExecutionFacePath(path)) found.add(path)
    }
  }
  walk('scripts')
  const packages = join(root, 'packages')
  if (existsSync(packages)) {
    for (const scope of readdirSync(packages, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue
      const scopeDirectory = join(packages, scope.name)
      for (const pkg of readdirSync(scopeDirectory, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue
        walk(`packages/${scope.name}/${pkg.name}/scripts`)
      }
    }
  }
  return [...found].sort()
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

  // ① 判据执行体集合：HEAD 侧 ∪ 工作树侧（检出后才新建的脚本也必须在集合里报出来）。
  const headBodies = listHeadJudgeBodies(root)
  if (headBodies === null) {
    process.stderr.write('check-install-integrity: 读不出 HEAD 的执行体清单\n')
    return 2
  }
  for (const required of REQUIRED_JUDGE_BODIES) {
    if (!headBodies.includes(required)) {
      process.stderr.write(`check-install-integrity: 必需的判据执行体不在 HEAD 里：${required}\n`
        + '  ⇒ 判据面残缺，拒绝在"少了几份判据"的树上判"通过"。\n')
      return 2
    }
  }
  const worktreeBodies = listWorktreeJudgeBodies(root)
  const bodyPaths = [...new Set([...headBodies, ...worktreeBodies])].sort()

  // ①b **执行体全集的双向登记**（第十三轮 D-03 / C-P1 / V1 三路独立复现的收口）。
  //     集合来源不是手写清单：族形态命中的 HEAD 侧文件 ∪ workflow 文本里被引用的执行体。
  {
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
    const ciReferenced = ciReferencedExecutionBodies(headWorkflowTexts)
    problems.push(...bidirectionalRegistryProblems(
      'EXECUTION_FACE_REGISTRY',
      EXECUTION_FACE_REGISTRY,
      headBodies,
      '新增执行体必须登记（`node scripts/check-install-integrity.mjs --print-execution-face` 打印可粘贴表）'
      + '—— 未登记的执行体不进"工作树 == HEAD"的比对面，也不进 `--restore` 的覆盖集。',
    ))
    problems.push(...bidirectionalRegistryProblems(
      'CI_REFERENCED_EXECUTION_REGISTRY',
      CI_REFERENCED_EXECUTION_REGISTRY,
      ciReferenced,
      '`.github/workflows/*.yml` 里被引用的执行体就是"CI 里真在跑的东西"—— 它必须与登记表双向相等'
      + '（未登记 = 新执行体悄悄进了 CI；死条目 = 登记表在长成豁免洞）。',
    ))
    notes.push(`执行体全集：${headBodies.length} 条（族形态）+ workflow 引用 ${ciReferenced.length} 条，`
      + '两张登记表双向对拍通过')
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

  if (options.printExecutionFace) {
    const headBodiesNow = listHeadJudgeBodies(root) ?? []
    const workflowTexts = []
    const workflowNames = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', '.github/workflows'])
    for (const name of String(workflowNames.stdout).split('\0').filter(entry => /\.ya?ml$/u.test(entry))) {
      const bytes = readHeadBlob(root, name)
      if (bytes !== null) workflowTexts.push([name, bytes.toString('utf8')])
    }
    const print = (label, paths) => {
      process.stdout.write(`# ${label}（${paths.length} 条）\n`)
      for (const path of paths) process.stdout.write(`  '${path}',\n`)
    }
    print('EXECUTION_FACE_REGISTRY', headBodiesNow)
    print('CI_REFERENCED_EXECUTION_REGISTRY', ciReferencedExecutionBodies(workflowTexts))
    return 0
  }

  const entryPaths = [...new Set([
    ...EXTRA_EXECUTION_ENTRY_PATHS,
    ...bodyPaths,
    ...workspaceManifests,
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

  // ⑥ install 期生命周期钩子：根 + **每一个** workspace manifest（读 HEAD 那份字节）。
  const manifestPaths = ['package.json', ...workspaceManifests]
  for (const path of manifestPaths) {
    const bytes = readHeadBlob(root, path)
    if (bytes === null) {
      problems.push(`${path} 不在 HEAD 里 —— 工作区 manifest 登记面残缺`)
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
  notes.push(`install 期生命周期钩子：根 + ${workspaceManifests.length} 个工作区 manifest 全部无未登记钩子`)

  if (options.restore && restored.length > 0) {
    notes.push(`已按 HEAD 重写 ${restored.length} 条执行体：${restored.slice(0, 5).join('、')}${restored.length > 5 ? ' …' : ''}`)
  }

  if (options.json !== null) {
    try {
      writeFileSync(options.json, `${JSON.stringify({
        head,
        // 平台锚（第十三轮 R13-D-01）：CI 侧断言按这个值对拍 `$GITHUB_SHA`。
        githubSha: anchor.sha,
        headEqualsGithubSha: anchor.sha !== null,
        judgeBodies: bodyPaths.length,
        ciReferencedExecutionBodies: CI_REFERENCED_EXECUTION_REGISTRY.length,
        workspaceManifests: workspaceManifests.length,
        restored,
        digests,
      }, null, 2)}\n`)
    } catch (error) {
      problems.push(`写不出 --json ${options.json}：${error.message}`)
    }
  }

  if (problems.length > 0) {
    for (const detail of problems) process.stderr.write(`\ncheck-install-integrity: ${detail}\n`)
    process.stderr.write(`\ncheck-install-integrity: ${problems.length} 项未通过`
      + `（判据执行体 ${bodyPaths.length} 条 · manifest ${manifestPaths.length} 个 · HEAD ${head.slice(0, 12)}）\n`)
    process.stderr.write('  ⇒ 这一步是"判据本体在 install 期有没有被改写"的前置校验，'
      + '**必须在任何 yarn/corepack 命令之前**跑：它一旦红，后面的判定块无论打印什么都不作数。\n')
    return 1
  }

  process.stdout.write(`check-install-integrity: VERDICT PASS judge-bodies=${bodyPaths.length}`
    + ` manifests=${manifestPaths.length} head=${head.slice(0, 12)}`
    + ` github-sha=${anchor.sha ?? 'absent'}\n`)
  process.stdout.write(`check-install-integrity: OK — 判据执行体 ${bodyPaths.length} 条（执行体全集的登记表`
    + ` + .yarnrc.yml + .gitignore + package.json + ${workspaceManifests.length} 个工作区 manifest）`
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

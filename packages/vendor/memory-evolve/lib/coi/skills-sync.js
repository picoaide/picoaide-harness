/**
 * COI 内置技能同步 — 适配器使用指南的"源头"在插件里。
 *
 * 设计（用户拍板）：AI 使用 COI 的指南 = 正常技能（默认启用，可在
 * 「技能管理」Tab 禁用）。插件包内自带内置技能（skills/ 目录），
 * 插件启动时同步到技能库（落点 = `config.skillDir`，桌面端缺省 `<DSH_HOME>/skills`）：
 *   - 目标不存在 → 复制（装上）
 *   - 目标存在且**溯源渠道就是 plugin**，x-version 更低 → 整目录覆盖
 *     （源头在插件，升级随插件更新）——**除非落点已被本地修改**（见下）
 *   - 一致 → 跳过
 *   - 目标存在、**没有**任何溯源，而内容与随包技能**逐字相同** → **采纳**
 *     （补写 `channel:'plugin'`，见 {@link isIdenticalTree}）—— 给 A9 之前
 *     落下的历史副本用的一次性兼容
 *   - 目标存在但是用户自制内容 / 另一条商店渠道的同名技能 → **拒绝**（fail-loud，
 *     `action: 'refused'` + `code`），绝不整树覆盖 —— 见 {@link classifySyncTarget}
 *     与本文档的"来源闸门"段（P1-1/P1-2，2026-09-23 独立审计 W4）
 * 同步以**整目录**为单位（SKILL.md + scripts/ 等辅助文件随技能一起走）；
 * 被禁用的技能文件仍存在，只是不注入模型。
 *
 * **本地改动闸门（独立复审 N1，2026-09-23）**：随包同步是**唯一不需要用户动作
 * 就会覆盖内容的写者**（每次开机自动跑），而它此前结构性不在「用户改过没有」的
 * 判据内——写溯源时刻意不写 `archiveChecksum`，企业侧 `isInstalledSkillDirty`
 * 没有基准就一律返回 `false`。结果是用户改了随包技能（或往里加了自己的文件）之后，
 * 下一次随包升版把它连同用户字节一起整树换掉，全程零提示，能力中心也不显示
 * 「已本地修改」。现在：
 *   - **每次自己写内容**（首次安装 / 升版换入 / 内容同一性采纳）之后都写一份
 *     `archiveChecksum` = {@link skillContentChecksum}（与企业侧
 *     `computeSkillContentHash` 逐字节同源的整树哈希，排除顶层 `.picoaide/`、
 *     含 `.install-version`；两实现的等价性由企业包
 *     `tests/skill-channel-parity.spec.ts` 用真实 fixture 对拍）；
 *   - 整树换入之前比对基准：不一致 ⇒ **如实拒收**（`refused` +
 *     `SKILL_LOCAL_CONTENT`），一个字节都不动 —— 自动路径没有 UI，所以不做"用户
 *     点了才覆盖"的交互式方案，与市场侧"跳过并如实报告"同一口径；
 *   - 未改过 ⇒ 照旧 `synced`（随包技能的主要用途不得退化）。
 *   **兼容边界（认账）**：本闸门之前落下的目录没有基准。它们在"内容与随包技能
 *   逐字相同"时会被补上基准（下一次开机即闭合）；内容已经不同又没有基准时无法
 *   证明是谁写的，只能照旧整树换入并打一行 warn —— 这个窗口只存在于"升级前装的
 *   那一份"，一次同步之后不复存在。
 *
 * **独立复审 r3（2026-09-23）补上的三条硬约束**（都写在各自函数头）：
 *   1. **判定与写溯源不可分割**（{@link isIdenticalTree} 的写后复检）：采纳路径
 *      写完 `channel: 'plugin'` 之后**再复检一次**同一性（把刚写的标记排除在条目
 *      集合之外）；复检不成立就**只收回自己刚写的标记**并 `refused` —— 否则那个窗口
 *      里落进来的用户字节会被盖上 plugin 溯源，下一次随包升版时被整树换入静默删除；
 *   2. **标记读取有类型/体积闸门**（{@link readSmallRegularFile}）：`lstat` 必须是
 *      普通文件 + 64KiB 上限 + `O_NONBLOCK` 按 fd 复验 —— `.picoaide/release.json`
 *      是 FIFO 时裸 `readFileSync` 会让**开机同步永久阻塞**（复审实测 12s 不返回）；
 *   3. **与安装器共用同一把 per-name 文件锁**（{@link SKILL_LOCK_DIR}）：拿到锁才
 *      判定/换入，拿不到就 `refused`（`SKILL_LOCKED`）—— 并发的终态是"内容是插件版 +
 *      溯源是市场版"，且插件此后永久 `SKILL_CHANNEL_CONFLICT` 拒收、**不会自愈**。
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { isSymlinkFreeRepoTarget, openExclusiveSafe, removeCreatedFile, writeFileAtomicSafeAt, writeTargetRefusedError } from '../sync/filesets.js'
import { hasDisableFlag, normalizeSkillManifestBytes, toggleDisableFlag } from '../skill-manifest.js'

/**
 * 换入过程中的两个临时目录名：
 *   - `.staging-<name>-<pid>-<ts>`：新内容先全部写这里，写完整体换入；
 *   - `.old-<name>-<pid>-<ts>`：旧目录先原子改名到这里"旁置"，换入成功后再删。
 * 两个名字都带 pid/时间戳：既是并发同步的隔离（互不覆盖），也是崩溃残留的
 * 清扫判据（见 {@link sweepStaleSwapDirs}）。
 *
 * ⚠️ **落点 = 技能库的第二层私有目录 `<skills>/.skill-tmp/`（R4-B-2 修复，
 * 2026-09-23 第四轮独立审计）**。这两个目录此前直接建在技能库**根**上
 * （先是 `<name>.staging-<pid>-<ts>`，A16 改成前导点形态
 * `.staging-<name>-<pid>-<ts>`）。
 *
 * A16 的前提"上游发现器看不见点号目录"**与 pinned 上游不符**：
 * `deepseek-harness/packages/skill/skill-filesystem/src/index.ts` 的 `discoverRoot`
 * 遍历技能库的**全部直接子目录**、只跳过 `skipSystem && name === '.system'`，
 * 技能名取自 frontmatter（`isSkillName`）—— 它与**目录名**无关；同文件按
 * `entries.sort((a, b) => a.name.localeCompare(b.name))` 排序，`skill/src` 的
 * `compareIndexedCandidates` 对同名候选是"先到先得"，而
 * `'.staging-x'.localeCompare('x') < 0` ⇒ 前导点形态排在真目录**之前**、
 * **赢下注册表**（交付态实测：旧命名 REAL / 新命名 GHOST）；随后同一轮同步删掉
 * 临时目录，本次会话里那个技能的 `path` / `resourceBase` 就指向不存在的目录。
 *
 * 真契约是**只有技能库的直接子目录会被发现**（层数，不是目录名）⇒ 把临时副本
 * 放进第二层即可结构上不可见 —— 与安装器的 `.skill-tmp/install-*` 同形。
 * 判据在 `packages/host/enterprise/tests/skill-staging-invisibility.spec.ts`：
 * **真跑 pinned 上游** `SkillRegistry` + `SkillFileSystem`，并保留"根上就是幽灵"
 * 的反向对照（上游一旦改成递归发现，那条对照即红）。
 *
 * 旧命名（无前导点的 `<name>.staging-…`）与 A16 的根上形态（`.staging-…`）
 * 仍被 {@link parseSwapDirName} 解析并由 {@link sweepStaleSwapDirs} 清扫：
 * 升级后盘上可能还留着旧版本写下的残留，不认它们就等于让这些幽灵目录永久占位。
 */
const STAGING_INFIX = '.staging-'
const ASIDE_INFIX = '.old-'

/**
 * 换入临时区的私有目录名（**跨包契约**，与 enterprise `skill-install.ts` 的
 * `SKILL_TEMP_DIR` 同值；由 `tests/skill-channel-parity.spec.ts` 读源码对拍）。
 *
 * 为什么必须与安装器同值、又各自用自己的前缀：两边都要把"未就位的副本"藏在
 * 技能库第二层（运行时只认直接子目录）；而安装器的清扫只删自己的 `install-*`、
 * 本插件的清扫只删自己的 `<infix><name>-<pid>-<ts>` ⇒ 互不误删对方正在用的副本。
 */
const SKILL_TEMP_DIR = '.skill-tmp'

/**
 * "用户显式卸载随包技能"的墓碑目录（**跨包契约**，与 enterprise `skill-install.ts`
 * 的 `SKILL_REMOVED_DIR` 同值；读对方源码对拍）。
 *
 * 背景（R4-B-4，第四轮独立审计）：能力中心对 `channel === 'plugin'` 的本地行给了
 * 「卸载」入口，而卸载只是纯本地删目录 —— 下次开机本同步看到落点不存在，就走
 * "首次安装"路径原样装回（用户视角：卸载后重启技能又回来了，全程零提示）。墓碑
 * 是"用户已明确移除"的**持久终态**：`<skills>/.skill-removed/<name>.json`。
 *
 * 落点与既有的安装器私有区同源（技能库根下的点号私有目录，读写都不进技能发现
 * 与能力中心列表），与 `.skill-locks` / `.skill-tmp` / `.picoaide` 同类。
 */
const SKILL_REMOVED_DIR = '.skill-removed'

/**
 * 安装器写在技能目录里的**非技能内容**（A9 修复，2026-09-23 独立审计）：
 * 整目录换入时必须从旧目录搬进新内容，否则——
 *   - `.picoaide/release.json`（来源徽章 + 「是否被本地修改」的判据）消失，
 *     同步后该技能在能力中心退回"用户自制"；
 *   - `.install-version`（遥测读的已装版本）消失。
 * 两者都由客户端安装器写，本插件只负责**不丢**它们。
 */
const INSTALLER_MARKERS = ['.picoaide', '.install-version']

/**
 * 本插件写下的溯源目录/文件名，与 enterprise 安装器的
 * `PROVENANCE_DIR` / `release.json` **同值**：跨包 import 禁止（本插件是随包
 * vendored 副本，不依赖企业包），所以这里是本地常量而不是 import。
 *
 * ⚠️ 与 {@link STORE_CHANNELS} / {@link SKILL_LOCK_DIR} 一样属于**跨包契约**：
 * 两侧同值由 enterprise 的 `tests/skill-channel-parity.spec.ts` 读源码文本对拍
 * （找不到字面量即 throw）。
 */
const PROVENANCE_DIR = '.picoaide'
const PROVENANCE_FILE = 'release.json'

/**
 * 安装器标记的体积上限（独立复审 r3 F2 的修复）。
 *
 * 真标记只有 appId/version/channel/server/archiveChecksum/installedAt 几个短字段
 * （几百字节）；64 KiB 是"绝不可能被合法内容触及"的量级。超过它的标记一律按
 * **读不出可用来源**处理 —— 复审实测：512MiB 的符号链接目标会被整份读进内存。
 */
const MARKER_MAX_BYTES = 64 * 1024

/**
 * per-name 锁目录（独立复审 r3 F3 的修复）——**跨包协议**，与 enterprise
 * `packages/host/enterprise/src/skill-install.ts` 的同名常量必须同值：
 *
 *   - 落点：`<userSkillsDir>/.skill-locks/<name>.lock`（与技能库同一文件系统，
 *     且以点开头 ⇒ 既不是技能目录，也不会被 `listInstalledSkills` / 上游
 *     `skill-filesystem` 的发现器看见）；释放后**空目录会留在技能库根上**，
 *     与安装器的 `.skill-tmp` 同类（安装器/插件私有区，`readdir` 看得见但发现器
 *     与清单都看不见），因此它是"允许存在的空私有目录"；
 *   - 创建：`O_CREAT|O_EXCL`（`openExclusiveSafe(..., 'lock')`）—— 预置的符号链接
 *     或文件一律 EEXIST/拒收，**绝不跟随**；
 *   - 内容：`{"pid":<number>,"at":<ms>}`（陈旧判定的依据）；
 *   - 陈旧：持锁 pid **确定已死**（`kill(pid,0)` 抛 ESRCH）⇒ 可抢占；没有可用 pid
 *     （空文件/坏 JSON/旧格式）时按 mtime 超过 {@link SKILL_LOCK_STALE_MS} 判；
 *     `EPERM`（跨 uid 不可探测）一律保守视为"仍被持有"；
 *   - 释放：只删自己创建的那个 inode（dev/ino 比对），不误删别人的锁。
 *
 * 为什么同步侧**零等待**：它跑在启动路径上（`lib/index.js` 的 `apply()`），而且与
 * 安装器在**同一个宿主进程**里 —— 同步忙等会把事件循环占住，异步的持锁者永远拿不到
 * 推进机会（自锁）。所以拿不到锁就**如实拒收**（`SKILL_LOCKED`），下一轮启动再同步。
 * 安装器侧相反：它可以有界等待（`await` + 让出事件循环），见企业包的同名注释。
 */
const SKILL_LOCK_DIR = '.skill-locks'

/** 锁文件名后缀（协议常量，两端同值）。 */
const SKILL_LOCK_SUFFIX = '.lock'

/** 无可用 pid 的锁文件的陈旧阈值（协议常量，两端同值；与 `store.js` 的 `STALE_LOCK_MS` 同量级）。 */
const SKILL_LOCK_STALE_MS = 10_000

/**
 * 本插件来源的渠道取值（A9 修复）：`SkillProvenance.channel` 的取值域由
 * `'market' | 'org' | 'builtin'` 扩展为 `'market' | 'org' | 'builtin' | 'plugin'`
 * （跨泳道契约，由企业包的 `readProvenance` 接受）。装上之后能力中心据此知道
 * 这份技能是**插件随包**装上的，而不是用户自制。
 */
const PLUGIN_CHANNEL = 'plugin'

/**
 * 商店来源渠道（P1-1/P1-2 修复，2026-09-23 独立审计 W4）。
 *
 * ⚠️ 这是**企业包安装器同一判据的本地副本**，真源在
 * `packages/host/enterprise/src/skill-install.ts` 的
 * `STORE_PROVENANCE_CHANNELS`（值 `['market','org','builtin','plugin']`）。
 * 跨包 import 禁止（本插件是随包 vendored 副本，不依赖企业包），所以这里复刻
 * 取值集合，不 import。**改真源必须同步改这里**：两边漂移的后果是"安装器认为
 * 是商店来源、同步器认为是用户内容"（或反过来），也就是本次要修的这类静默覆盖。
 */
const STORE_CHANNELS = ['market', 'org', 'builtin', PLUGIN_CHANNEL]

/**
 * 拒绝码（P1-1 修复）：与安装器一样，**如实报 refused 并点名原因**，绝不静默
 * 覆盖。三者都出现在 `syncBuiltinSkills` 结果的 `code` 字段上：
 *   - {@link SKILL_LOCAL_CONTENT}：目标目录没有可用的安装器溯源、且**不能**用内容
 *     同一性证明它是本插件的副本 ⇒ 按"用户自制"处理（判据与安装器的
 *     `classifyInstalledSkill === 'local'` 同源）；**或者**目标是本插件的落点、
 *     但内容与上次同步写下的基准不一致（用户改过，独立复审 N1）⇒ 同样保留本机内容；
 *   - {@link SKILL_CHANNEL_CONFLICT}：目标目录是**另一条商店渠道**（market /
 *     org / builtin）装进来的 ⇒ 整树换入会把渠道从那条改成 plugin，两边会在
 *     每次开机互相覆盖（P1-2 的乒乓球）；
 *   - {@link SKILL_ADOPT_FAILED}：内容同一性成立（= 已证明是本插件的副本），但
 *     **补写溯源失败** ⇒ 仍然拒绝。这一条必须 fail-loud：否则会出现"内容按 plugin
 *     更新了、溯源却还不是 plugin"的中间态。
 *   - {@link SKILL_LOCKED}：该技能名的 per-name 锁被另一个写者持有（能力中心安装器
 *     正在装/卸同名技能，或另一次同步在跑），或锁落点被符号链接占位 ⇒ 本轮**不碰
 *     这个落点**。宁可少同步一轮，也不与安装器并发换入（复审 r3 F3：并发终态是
 *     "内容是插件版 + 溯源是市场版"，且此后永久 `SKILL_CHANNEL_CONFLICT`、不会自愈）。
 *   - {@link SKILL_USER_REMOVED}：用户**显式卸载过**这个随包技能（技能库里有墓碑，
 *     见 {@link SKILL_REMOVED_DIR}）⇒ 本轮 `action: 'skipped'`、不落盘。这是用户
 *     意图的持久终态，不是失败：**唯一**的解除方式是用户重新安装该技能（安装器会
 *     在成功安装后清掉墓碑），或手工删除墓碑文件。
 */
const SKILL_LOCAL_CONTENT = 'SKILL_LOCAL_CONTENT'
const SKILL_CHANNEL_CONFLICT = 'SKILL_CHANNEL_CONFLICT'
const SKILL_ADOPT_FAILED = 'SKILL_ADOPT_FAILED'
const SKILL_LOCKED = 'SKILL_LOCKED'
const SKILL_USER_REMOVED = 'SKILL_USER_REMOVED'

/**
 * 暂存/旁置目录的"陈旧"年龄上限：超过它一律按崩溃残留清扫（即便 pid 还在
 * 进程表里 —— pid 会被复用，长时间没人管的目录不可能是"正在跑的同步"）。
 */
const STALE_SWAP_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * 插件内置的技能清单（目录名 = 技能名）—— **只含本插件自己的技能**。
 *
 * ⚠️ **平台技能不在这个清单里**（2026-09-18，用户口径 + 独立审计 P1-1 的修复）：
 * 平台内置的 WASM 应用作者手册（原名 `picoaide-app-builder`，2026-09-19 改名
 * `app-builder`）是**平台内置技能**：内容随服务端镜像发布
 * （`GET /api/client/v2/skills/builtin`），由员工在客户端「能力中心 → 平台内置技能」
 * **按需安装**。
 *
 * 为什么会踩：要"内置到服务端 + 按需安装"，就不能有一条开机自动把它写进技能库的
 * 旁路 —— 否则员工什么都没点，面板已经显示"已安装"，安装按钮永远走不到，
 * 「按需」名存实亡（审计实测：apply() 一次之后技能就在 `<DSH_HOME>/skills` 里，
 * 且没有能力中心的溯源信息）。
 *
 * 2026-09-19 起它的**源目录也不在本包了**：真源在服务端仓库的
 * `server/skills/app-builder/`（随镜像分发，见 `server/Dockerfile`）—— 所以本包
 * `skills/` 目录里剩下的**全部**都是本插件自己的技能（{@link BUILTIN_SKILLS} 与
 * 磁盘内容一一对应，回归用例钉住）。
 *
 * 回归门禁：`tests/coi.test.js` 断言本清单里不含任何平台技能、且平台技能目录不在包内；
 * `tests/builtin-skills-decoupled.test.js` 断言 apply() 之后它**没有**被装上。
 */
export const BUILTIN_SKILLS = [
  'kimi-cli-calling',
  'codex-cli-calling',
  'grok-cli-calling',
  'hermes-cli-calling',
  'memory-consolidate',
]

/**
 * 由**服务端**分发、客户端按需安装的技能名（不属于本插件的同步范围）。
 *
 * 单独列出来是为了让"哪些是平台技能"这件事有唯一真源：同步逻辑与回归测试都读它，
 * 而不是各自写一遍字面量（写两处就会漂移，漂移的后果见 {@link BUILTIN_SKILLS}）。
 *
 * ⚠️ **2026-09-19 起清单里的技能已不在本包内**：作者手册改名 `app-builder`，
 * 源目录搬到服务端仓库的 `server/skills/app-builder/`（随服务端镜像发布；
 * `server/Dockerfile` 直接 COPY，不再有 `--build-context skillassets`）。
 *
 * 清单**保留而不是清空**：它挡的从来不是"目录在哪"，而是"**这个技能名永远不许经
 * 开机同步落进用户技能库**"。`syncBuiltinSkills` 里那句守卫与两条回归用例都靠它
 * 承重，清空会让「平台技能不得被自动安装」这条不变量静默失去覆盖 —— 而一旦有人
 * 手滑把 `app-builder` 目录（连同 BUILTIN_SKILLS 里的一行）加回本包，就该由这里拦住。
 */
export const PLATFORM_SKILLS = ['app-builder']

/**
 * 技能名白名单（kebab-case，与 dsh-skill 的公开规则一致）。
 * 技能名直接参与路径拼接（`join(skillDir, name, 'SKILL.md')`），
 * 未校验时 `../../x` 可把读写落点带出技能库。
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * @param {unknown} name
 * @returns {boolean} 是否是合法技能名。
 */
export function isSafeSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name)
}

/** 从 SKILL.md frontmatter 读 x-version；缺省 0。 */
function skillVersion(text) {
  const match = String(text).match(/^---\n[\s\S]*?^x-version:\s*(\d+)\s*$/m)
  return match ? Number(match[1]) : 0
}

/**
 * 读一个"应当是小普通文件"的状态文件 —— **先闸门、后读**（独立复审 r3 F2 的修复）。
 *
 * 三条闸门（缺一条就有真实后果）：
 *   1. `lstat` 必须是**普通文件**（拒 FIFO/目录/符号链接/设备节点）；
 *   2. `size <= maxBytes`（不把任意大的东西读进内存）；
 *   3. 打开用 `O_NONBLOCK` + 按 **fd** 复验一次类型与体积 —— lstat 与 open 之间被
 *      换成 FIFO 时，`open(O_RDONLY)` 会**永久阻塞**（复审实测：FIFO 标记让启动
 *      同步 12s 不返回），`O_NONBLOCK` 让这一步立即返回、由 fd 上的类型复验拒掉。
 *
 * 任何一条不成立都返回 `unreadable`：调用方按"**有标记但读不出可用来源**"处理
 * （fail-safe：绝不覆盖看不懂的标记），而不是当成"没有标记"。
 *
 * @param {string} file - 文件绝对路径。
 * @param {number} maxBytes - 体积上限。
 * @returns {{status:'ok', text:string, bytes:Buffer}|{status:'absent'}|{status:'unreadable'}}
 */
function readSmallRegularFile(file, maxBytes) {
  let stat
  try {
    stat = lstatSync(file)
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable' }
  }
  if (!stat.isFile()) return { status: 'unreadable' }
  if (stat.size > maxBytes) return { status: 'unreadable' }
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > maxBytes) return { status: 'unreadable' }
    // 一次读成 Buffer、再解出文本：`bytes` 供"回滚时逐字节还原"用（R4-B-1），
    // 二次读同一 fd 既慢又可能读到被截断的中间态。
    const bytes = readFileSync(fd)
    return { status: 'ok', text: bytes.toString('utf8'), bytes }
  } catch {
    return { status: 'unreadable' }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已关闭 */ }
    }
  }
}

/**
 * 读目标技能目录的安装器溯源（P1-1 修复，2026-09-23 独立审计 W4）。
 *
 * 判据与企业包安装器的 `isStoreProvenance`（`skill-install.ts:483-485`）
 * **逐条同源**，三件事必须同时成立才算"这份内容不是用户手写的"：
 *   1. `<dir>/.picoaide/release.json` 可读且是 JSON 对象（读取本身先过
 *      {@link readSmallRegularFile} 的类型/体积闸门）；
 *   2. `appId` 是 string 且**等于目录名**（目录被改名/被占用时不算）；
 *   3. `channel` 是已知的商店渠道取值（见 {@link STORE_CHANNELS}；未知取值按
 *      "非商店来源"处理 —— 与安装器"未知渠道不回落成 market"的历史修复同口径）。
 * 任何一条不成立都返回 `channel: undefined` = 按用户自制内容处理（宁可多拒一次，
 * 不可静默覆盖/删除用户内容）。
 *
 * `markerStatus` 如实回报标记的三种形态，调用方据此决定能不能走"内容同一性采纳"：
 * **只有 `absent`（确认没有标记）才可采纳**；`unreadable`（FIFO/目录/符号链接/
 * 设备/超体积/坏 JSON）一律不采纳。
 *
 * @param {string} destDir - 技能库内的目标技能目录。
 * @param {string} name - 期望的技能名（= 目录名）。
 * @returns {{channel:string|undefined, markerStatus:'ok'|'absent'|'unreadable'}}
 */
function readStoreProvenance(destDir, name) {
  const marker = readSmallRegularFile(join(destDir, PROVENANCE_DIR, PROVENANCE_FILE), MARKER_MAX_BYTES)
  if (marker.status !== 'ok') return { channel: undefined, markerStatus: marker.status }
  let parsed
  try {
    parsed = JSON.parse(marker.text)
  } catch {
    return { channel: undefined, markerStatus: 'ok' } // 标记可读但 JSON 坏
  }
  if (parsed === null || typeof parsed !== 'object') return { channel: undefined, markerStatus: 'ok' }
  if (typeof parsed.appId !== 'string' || parsed.appId !== name) return { channel: undefined, markerStatus: 'ok' }
  if (typeof parsed.channel !== 'string' || !STORE_CHANNELS.includes(parsed.channel)) {
    return { channel: undefined, markerStatus: 'ok' }
  }
  return { channel: parsed.channel, markerStatus: 'ok' }
}

/**
 * 整树换入**之前**的来源闸门（P1-1 / P1-2 修复，2026-09-23 独立审计 W4）。
 *
 * 为什么必须有它：本插件的开机同步原先只看 `x-version`（{@link syncBuiltinSkills}
 * 的 `needsCopy`），于是**任何**同名目录都会被整树换入 —— 用户手写的同名技能连同
 * 自己的笔记/脚本一起被删、还被补上 `channel: 'plugin'` 的溯源（能力中心此后按
 * "商店来源"对待）。实测（W4 probe5 情形 1）：用户文件消失、`installedOrigin`
 * 从 `local` 翻 `store`，全程零确认。它同时是 P1-2 的一半：市场装进来的同名技能
 * 会被换回插件版而 `.picoaide` 原样保留 ⇒ 内容与徽章归属不一致。
 *
 * 判据（**同一个函数同时决定覆盖与不覆盖**，不在调用点各写一遍）：
 *   - 目录不存在 → 允许（首次安装，正常路径）；
 *   - 渠道 === `plugin` → 允许（`x-version` 正常更新；安装器标记由 A9 保留）；
 *   - 渠道是**其它**商店渠道（market/org/builtin）→ 拒绝（换渠道 = 两边每次开机
 *     互相覆盖，必须由用户显式处置，见 {@link SKILL_CHANNEL_CONFLICT}）；
 *   - 没有任何 `release.json` → 拒绝，但标 `adoptable: true`：调用方再用**内容同一
 *     性**（{@link isIdenticalTree}）决定能不能"采纳"（成立则补写溯源后报 `adopted`）；
 *   - 有 `release.json` 但读不出可用渠道（JSON 坏 / `appId` 不符 / 未知渠道）→ 拒绝，
 *     且 `adoptable: false` —— **不覆盖看不懂的标记**（宁可多拒一次）。
 *
 * 注意"目录存在但没有 SKILL.md"同样按**存在**处理：那可能是用户自己的目录
 * （只有若干笔记文件），整树换入会把它们删掉。首次安装请让落点不存在。
 *
 * @param {string} destDir - 技能库内的目标技能目录。
 * @param {string} name - 技能名（= 目录名）。
 * @returns {{ok:true}|{ok:false, adoptable:boolean, code:string, message:string}} 判定结果。
 */
function classifySyncTarget(destDir, name) {
  const { channel, markerStatus } = readStoreProvenance(destDir, name)
  if (channel === PLUGIN_CHANNEL) return { ok: true }
  if (channel !== undefined) {
    return {
      ok: false,
      adoptable: false,
      code: SKILL_CHANNEL_CONFLICT,
      message: `${destDir} 是「${channel}」渠道装进来的同名技能 —— 整树换入会把它的来源改成 plugin`
        + '（内容与溯源归属不一致，且两条渠道会在每次开机互相覆盖）；已拒绝。'
        + '若要使用随包内置技能，请先在能力中心卸载该同名技能或改掉它的目录名。',
    }
  }
  // 有没有"看不懂的标记"决定能不能走内容同一性采纳：**只有确认没有标记（absent）
  // 才可采纳**。`unreadable`（FIFO/目录/符号链接/设备/超体积/读失败）与"可读但
  // 内容不可用"（JSON 坏/appId 不符/渠道未知）都一律不采纳 —— 覆盖别人的来源标记
  // 比拒绝危险得多。
  const marked = markerStatus !== 'absent'
  return {
    ok: false,
    adoptable: !marked,
    code: SKILL_LOCAL_CONTENT,
    message: marked
      ? `${destDir} 有安装器溯源标记但读不出可用来源（不是小普通文件 / JSON 坏 / appId 不符 / 渠道未知）—— 不覆盖看不懂的标记；已拒绝。`
      : `${destDir} 已存在，但没有安装器溯源（按"用户自制"处理）—— 整树换入会连同你自己的文件一起删掉；已拒绝。`,
  }
}

/**
 * 目标目录是不是随包技能目录的**逐字副本**（P1-1 兼容路径的判据，内容同一性）。
 *
 * **背景**：写溯源的 A9 修复不在任何已发布版本里 ⇒ 现场存在"旧版插件同步落下、
 * 目录里没有 `.picoaide`"的技能目录。来源闸门会把它们按用户自制拒收：今天无碍
 * （磁盘状态与旧行为相同），但**将来**插件升 `x-version` 时它们不会更新。这个判据
 * 给它们一次自证机会（见 {@link syncBuiltinSkills} 的采纳分支）。
 *
 * 三条同时成立才算（**可验证的同一性，不是启发式**）：
 *   1. 条目集合逐项相同：文件**与目录**都算，相对路径、排序位置、种类（file/dir）
 *      全部一致 —— 多一个、少一个、改名、文件↔目录都判不同；
 *   2. 每个普通文件字节相同（`Buffer.equals`，不做文本解码，避免编码层归一化）；
 *   3. 全程没有任何**符号链接**、FIFO/设备等异常条目，也没有读不出来的条目
 *      （任何一项异常都判不同 —— 宁可拒收）。
 *
 * **为什么可以采纳"用户手工复制的随包技能副本"**：内容既然与随包技能逐字相同，
 * 这份目录里就不存在任何用户创作的字节；采纳只写一个来源标记（不动正文），之后
 * 升级替换掉的也只是随包技能自己的字节。反过来，只要用户改过一个字节、加过一个
 * 文件，判据就不成立 ⇒ 仍然 `refused`，绝不触碰。
 *
 * **为什么不用 mtime/大小做更严的判据**：大小是字节比较的推论，不增加信息；
 * mtime 在真实链路里不可比（随包技能来自安装包/asar 解包，取值由打包工具决定；
 * 旧同步写下的文件 mtime 是同步当时的时间），拿它判等只会造成误拒 —— 即"更严的
 * 判据"实际是"更不可靠的判据"。**字节等同是此处可得的最强证据**。
 *
 * 目录项用 `lstat` 逐个判定（不依赖 `readdirSync(..., {withFileTypes:true})` 的
 * Dirent 合成）：随包技能目录在打包版里位于 asar 内，`lstat` 是 Electron 必然会
 * 补的那一层；任何一步拿不到真实类型都按"不同"处理（fail-safe，不会误采纳）。
 *
 * @param {string} srcDir - 插件包内技能目录。
 * @param {string} destDir - 目标技能目录。
 * @param {{ignoreTopLevel?: string[]}} [options] - 忽略目标目录**根**上的这些条目
 *   （只给"写后复检"用：那时 `.picoaide` / `.install-version` 是**我们自己刚写的**，
 *   它们不属于技能内容；判定前的首次比较必须用完整条目集合）。
 * @returns {boolean} 逐字相同为 true。
 */
function isIdenticalTree(srcDir, destDir, options = {}) {
  const ignore = options.ignoreTopLevel ?? null
  const srcEntries = listEntriesRel(srcDir)
  const destEntries = listEntriesRel(destDir, '', ignore)
  if (srcEntries === null || destEntries === null) return false
  // 条目集合必须逐项相同（多一个 / 少一个 / 改名 / 种类不同都算不同）。
  if (srcEntries.length !== destEntries.length) return false
  for (let i = 0; i < srcEntries.length; i += 1) {
    const src = srcEntries[i]
    const dest = destEntries[i]
    if (src.rel !== dest.rel || src.dir !== dest.dir) return false
    if (src.dir) continue
    const left = readFileOrNull(join(srcDir, src.rel))
    const right = readFileOrNull(join(destDir, dest.rel))
    if (left === null || right === null) return false
    if (!left.equals(right)) return false
  }
  return true
}

/**
 * 列出目录下的条目（相对路径 + 是目录否），按相对路径排序。
 *
 * 只认普通文件与目录；遇到符号链接、FIFO/设备等异常条目、或任一 `lstat`/`readdir`
 * 失败，一律返回 `null`（调用方按"无法证明相同"处理）。
 * @param {string} dir - 目录。
 * @param {string} [prefix] - 递归用前缀。
 * @param {string[]|null} [skipTopLevel] - 只在本层（`prefix === ''`）跳过的条目名。
 * @returns {Array<{rel:string, dir:boolean}>|null} 条目列表；异常为 null。
 */
function listEntriesRel(dir, prefix = '', skipTopLevel = null) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const out = []
  for (const name of names) {
    if (prefix === '' && skipTopLevel !== null && skipTopLevel.includes(name)) continue
    const rel = prefix === '' ? name : `${prefix}/${name}`
    const full = join(dir, name)
    let stat
    try {
      stat = lstatSync(full)
    } catch {
      return null // 悬空符号链接 / 权限 / 竞态删除 —— 都判"不同"
    }
    if (stat.isSymbolicLink()) return null
    if (stat.isDirectory()) {
      out.push({ rel, dir: true })
      const nested = listEntriesRel(full, rel, skipTopLevel)
      if (nested === null) return null
      out.push(...nested)
    } else if (stat.isFile()) {
      out.push({ rel, dir: false })
    } else {
      return null // FIFO / socket / 设备节点
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * 读文件字节；读不出来返回 null（调用方判"不同"）。
 * @param {string} file - 绝对路径。
 * @returns {Buffer|null} 内容。
 */
function readFileOrNull(file) {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

/**
 * 落点是否**已经存在任何东西**（不跟随符号链接，`lstat` 语义）。
 *
 * 与 `existsSync` 的差别正是闸门要的那种：指向不存在目标的悬空符号链接
 * `existsSync` 为假，但它**占着这个落点**，必须交给 {@link syncSkillDirSafe} 的
 * 断言去拒收（预置链接是拒收而不是被换入静默删掉，本地 NF-1 口径）。
 * @param {string} path - 待检查的路径。
 * @returns {boolean} 存在（含符号链接、普通文件）为 true。
 */
function isPresent(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * 校验并规范化一段 SKILL.md 内容（技能格式要求）：
 *   - 空内容 / 超上限 → 抛错
 *   - 已有 frontmatter：必须完整（--- 包裹、含 name 与 description），
 *     缺失必填字段 → 抛错（提示用户补全）
 *   - 无 frontmatter：自动补全 name/description 头部
 * @param {string} raw - 用户输入内容。
 * @param {string} skillName - 技能名（补全 frontmatter 用）。
 * @param {string} displayName - 适配器显示名（补全 description 用）。
 * @returns {string} 规范化后的完整 SKILL.md 文本。
 */
export function normalizeSkillText(raw, skillName, displayName) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('技能内容不能为空')
  if (text.length > 128 * 1024) throw new Error('技能内容超过 128 KiB 上限')
  const lines = text.split('\n')
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end < 0) throw new Error('frontmatter 未闭合：需要以 --- 结尾的 YAML 头')
    const fm = lines.slice(1, end).join('\n')
    const missing = []
    if (!/^name:\s*\S+/m.test(fm)) missing.push('name')
    if (!/^description:\s*\S+/m.test(fm)) missing.push('description')
    if (missing.length > 0) {
      throw new Error(`frontmatter 缺少必填字段：${missing.join('、')}（SKILL.md 必须含 name 与 description）`)
    }
    return text
  }
  return `---\nname: ${skillName}\ndescription: ${displayName} 的 AI 使用指南（由 dsh-memory-evolve COI 适配器创建）。\n---\n${text}`
}

/**
 * 锁文件是否陈旧（{@link SKILL_LOCK_DIR} 的协议判据之一）。
 *
 * 判据与 `store.js` 的 `isStaleLock` 同源（**同一个包里的第二次实现**，因为本锁的
 * 落点/常量属于跨包契约，要与 enterprise 侧的本地实现逐条对齐；那边的对拍用例会
 * 比对 {@link SKILL_LOCK_STALE_MS}）：
 *   - 锁文件里有可用 pid（正整数）时**只看存活**：活着 ⇒ 有效（哪怕持锁很久）；
 *   - `kill(pid,0)` 抛 `ESRCH`（进程确实不存在）⇒ 陈旧，可抢占；
 *   - 抛 `EPERM`/其它（跨 uid、容器、NFS：不可判定）⇒ **保守视为有效**，绝不抢；
 *   - 没有可用 pid（空文件/坏 JSON/旧格式）⇒ 按 mtime 超过阈值判陈旧。
 *
 * 先 `lstat` 要求**普通文件**：符号链接/目录/设备不是我们的锁形态，一律不按陈旧
 * 删除（fail-safe，避免把别人预置的东西删掉）。
 * @param {string} lockPath - 锁文件绝对路径。
 * @returns {boolean} 可抢占为 true。
 */
function isSkillLockStale(lockPath) {
  let stat
  try {
    stat = lstatSync(lockPath)
  } catch {
    return false // 不存在/不可读 ⇒ 不 stale（下一轮重试即可拿到）
  }
  if (!stat.isFile()) return false
  const read = readSmallRegularFile(lockPath, MARKER_MAX_BYTES)
  if (read.status === 'ok') {
    let owner
    try {
      owner = JSON.parse(read.text)
    } catch {
      owner = undefined
    }
    if (owner !== null && typeof owner === 'object' && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0) // 信号 0 = 只探测存活
        return false
      } catch (error) {
        return error?.code === 'ESRCH'
      }
    }
  }
  return Date.now() - stat.mtimeMs > SKILL_LOCK_STALE_MS
}

/**
 * 取一个技能名的 per-name 锁（独立复审 r3 F3 的修复）—— 协议见 {@link SKILL_LOCK_DIR}。
 *
 * **零等待**（有意的，见协议注释）：拿不到就返回 `ok:false`，调用方如实报
 * `SKILL_LOCKED` 并跳过该技能。整个过程有界：最多"试一次 + 抢占一次"。
 *
 * 返回的 `release()` 只删**自己创建的那个 inode**（`removeCreatedFile` 按 dev/ino
 * 比对），祖先目录被换走时不会误删库外同名文件。
 *
 * **导出面（2026-09-25，R18B-03）**：模型面工具 `lib/skills.js` 的
 * `skill_manage create/patch` 与 `approvePendingSkill` 写的是**同一个落点**
 * （`<技能库>/<name>/SKILL.md` 与 `<技能库>/<name>/` 整目录），因此必须取**同一把**
 * 锁。协议实现只有这一份 —— 那边从本文件 import，不再复制常量与判据
 * （本包内部的跨文件 import 是允许的；"不能 import"只针对企业包 ⇄ vendored 包之间）。
 * @param {string} userSkillsDir - 技能库根。
 * @param {string} name - 技能名。
 * @returns {{ok:true, release:()=>void}|{ok:false, message:string}}
 */
export function acquireSkillDirLock(userSkillsDir, name) {
  const lockDir = join(userSkillsDir, SKILL_LOCK_DIR)
  const lockPath = join(lockDir, `${name}${SKILL_LOCK_SUFFIX}`)
  try {
    mkdirSync(lockDir, { recursive: true })
  } catch (error) {
    return { ok: false, message: `技能库的锁目录 ${lockDir} 建不出来（${String(error?.message ?? error)}）—— 拿不到锁就不换入（避免与安装器并发写同一个落点）` }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const opened = openExclusiveSafe(userSkillsDir, lockPath, 'lock')
    if (opened.ok === true) {
      try {
        writeFileSync(opened.fd, JSON.stringify({ pid: process.pid, at: Date.now() })) // 按 fd 写
      } catch (error) {
        removeCreatedFile(lockPath, opened.stat)
        return { ok: false, message: `写锁文件 ${lockPath} 失败（${String(error?.message ?? error)}）` }
      } finally {
        try { closeSync(opened.fd) } catch { /* 已关闭 */ }
      }
      return {
        ok: true,
        release() { removeCreatedFile(lockPath, opened.stat) },
      }
    }
    if (opened.reason === 'unsafe') {
      return { ok: false, message: `锁落点 ${lockPath} 是符号链接或逃出了技能库 —— 拒绝在未持锁的情况下换入（预置链接是拒收，不是静默跳过）` }
    }
    // 已被占用：陈旧（持锁进程已死）就抢占**一次**；抢不掉/不陈旧一律拒收。
    if (attempt === 0 && isSkillLockStale(lockPath) && isSymlinkFreeRepoTarget(userSkillsDir, lockPath)) {
      try {
        rmSync(lockPath, { force: true })
        continue
      } catch { /* 抢不掉（目录/权限）⇒ 走下面的拒收 */ }
    }
    return {
      ok: false,
      message: `技能 ${name} 的 per-name 锁正被另一个写者持有（${lockPath}：能力中心安装器正在装/卸同名技能，或另一次同步在跑）`
        + '—— 本轮不换入，避免并发产出"内容是插件版、溯源是市场版"这种不会自愈的中间态。',
    }
  }
  return { ok: false, message: `技能 ${name} 的锁竞争未收敛（${lockPath}）` }
}

/**
 * 读"用户显式卸载过这个随包技能"的墓碑（R4-B-4 修复，第四轮独立审计）。
 *
 * 落点 `<userSkillsDir>/.skill-removed/<name>.json`（见 {@link SKILL_REMOVED_DIR}），
 * 由能力中心的卸载链路在**删除随包技能成功之后**写（enterprise
 * `skill-install.ts` 的 `uninstallSkill`）。这里只**读**：同步侧绝不创建、也绝不
 * 删除墓碑 —— 解除用户的选择只有两条路（用户重新安装该技能 / 手工删墓碑文件），
 * 都不能由开机同步在背后替他决定。
 *
 * 判据（三个条件同时成立才算墓碑）：文件可读 + 是 JSON 对象 + `appId` 等于技能名
 * 且 `channel === 'plugin'`。**读不出/JSON 坏/appId 不符/渠道不是 plugin 一律按
 * "没有墓碑"处理**（fail-open，回到升级前的行为：装回去），而不是按"有墓碑"处理 ——
 * 反过来会让一个坏文件永久停掉内置技能同步，且用户完全看不出原因。读取本身复用
 * {@link readSmallRegularFile} 的类型/体积闸门（FIFO 不会把开机同步挂住）。
 *
 * @param {string} userSkillsDir - 用户技能库目录。
 * @param {string} name - 技能名。
 * @returns {object|null} 解析出的墓碑对象；不算墓碑时 null。
 */
function readSkillTombstone(userSkillsDir, name) {
  const read = readSmallRegularFile(join(userSkillsDir, SKILL_REMOVED_DIR, `${name}.json`), MARKER_MAX_BYTES)
  if (read.status !== 'ok') return null
  let parsed
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  if (parsed.appId !== name || parsed.channel !== PLUGIN_CHANNEL) return null
  return parsed
}

/**
 * 同步内置技能到用户技能库。
 * 覆盖策略（保护用户内容）：目标缺失 → 复制；目标存在且溯源渠道就是 `plugin`、
 * 且 x-version 更低 → 整目录覆盖（插件升级，SKILL.md 与 scripts/ 等辅助文件一起
 * 更新）；版本一致 → 不动；**目标是用户自制内容或另一条商店渠道的同名技能 →
 * 拒收**（`refused`，见 {@link classifySyncTarget}）；目标没有任何溯源但内容与
 * 随包技能**逐字相同** → 采纳（补写溯源后报 `adopted`）。
 *
 * 逐技能四道闸门、**顺序不可换**：①墓碑（用户显式卸载过 ⇒ `skipped`，
 * {@link readSkillTombstone}）；②来源（目标存在时按 {@link classifySyncTarget} 判定，
 * 另有内容同一性采纳的兼容路径）；③版本（`x-version` 更高才整树换入）；
 * ④**本地改动**（换入前比对 `archiveChecksum` 基准，不一致 ⇒ `refused` +
 * `SKILL_LOCAL_CONTENT`，一个字节都不动 —— 独立复审 N1）。每条出口都在
 * per-name 锁之内，互斥对象是能力中心的安装器（同一把锁、同一落点）。
 *
 * 落点（NF-1，2026-09-13 审计加固；2026-09-16 与上游整目录语义合流）：
 * `<userSkillsDir>/<name>` 是本插件**自有内容**的固定落点，必须先过断言——
 * 从技能库根到落点的整条链没有符号链接、真实路径留在库内。第一轮这里是裸
 * `writeFileSync`：预置一个同名符号链接就能把库外任意文件覆盖成内置技能正文，
 * 而函数仍返回 `action:"synced"`（成功），且这条路径在插件启动时无条件执行，
 * 无需用户动作。上游 v26091501 起改按整目录同步（辅助文件随技能走），落点
 * 依然逐个文件走自锚定原子写，断言不放松。
 * 单个技能落点被拒只记 `refused`，不阻塞其余技能同步。
 *
 * **来源闸门（P1-1 / P1-2 修复，2026-09-23 独立审计 W4）**：覆盖之前先判定目标
 * 目录的安装器溯源（{@link classifySyncTarget}）——用户自制内容与"另一条商店渠道"
 * 的同名技能一律不动、如实记 `refused`（并打日志点名技能与原因）；只有目录不存在
 * 或渠道就是 `plugin` 时才走 `x-version` 更新。这一条与安装器的
 * `classifyInstalledSkill` / `isStoreProvenance` 是同一份判据（本地副本，见
 * {@link STORE_CHANNELS}），不是第二套口径。
 *
 * **兼容路径（P1-1 追加，同轮）**：目录**完全没有** `release.json`、但内容与随包技能
 * **逐字相同**时（{@link isIdenticalTree}）⇒ 内容是随包
 * 技能的副本这一点已被证明，于是补写 `channel: 'plugin'` 溯源并报 `adopted`，
 * 此后走正常更新路径。这是给"旧版插件同步落下、还没写溯源"的目录的一次性兼容；
 * 同一性不成立（多/少文件、任何字节差异、符号链接、读失败）一律照旧 `refused`。
 *
 * **墓碑闸门（R4-B-4 修复，第四轮独立审计）**：技能库里有该技能的墓碑
 * （{@link SKILL_REMOVED_DIR}）⇒ 本轮**一行都不写**、如实记
 * `skipped` + `SKILL_USER_REMOVED`（见 {@link readSkillTombstone}）。
 *
 * @param {string} pluginSkillsDir - 插件包内 skills/ 目录的绝对路径。
 * @param {string} userSkillsDir - 用户技能库目录（`config.skillDir`，桌面端缺省 `<DSH_HOME>/skills`）。
 * @returns {Array<{name:string, action:'synced'|'unchanged'|'adopted'|'missing'|'refused'|'skipped', message?:string, code?:string}>}
 *   `adopted` = 内容与随包技能逐字相同、本次只补写了溯源（未换入）。
 *   `skipped` = 用户**显式卸载过**这个技能（技能库里有墓碑）⇒ 本轮刻意不落盘，
 *   见 {@link SKILL_REMOVED_DIR}；它不是失败，是用户的持久选择。
 *   `code` 只在可区分的失败上出现：换入+回滚双失败的
 *   `SKILL_SWAP_RECOVERY_FAILED`（见 {@link SkillSwapRecoveryError}），以及来源闸门
 *   的 `SKILL_LOCAL_CONTENT` / `SKILL_CHANNEL_CONFLICT` / `SKILL_ADOPT_FAILED`
 *   与墓碑的 `SKILL_USER_REMOVED`。
 *   `SKILL_LOCAL_CONTENT` 现在有**两种**触发形态（都是"保留本机内容、如实拒收"）：
 *   目录没有可用溯源（按用户自制处理），以及**落点已被本地修改**（基准对不上，
 *   独立复审 N1）—— 后者是自动同步路径上唯一会覆盖内容的写者，必须拦。
 */
export function syncBuiltinSkills(pluginSkillsDir, userSkillsDir) {
  const results = []
  // S13-3 复核（2026-09-17）：先清扫上次同步留下的暂存/旁置目录。SIGKILL/断电
  // 不会走 catch，`<name>.staging-<pid>-<ts>` 会永久留在技能库里（它的 SKILL.md
  // 带真实技能的 frontmatter name，是个只会越积越多的幽灵）；清扫放在同步开头，
  // 每次启动都收一遍。
  sweepStaleSwapDirs(userSkillsDir)
  for (const name of BUILTIN_SKILLS) {
    // 纵深防御：平台技能由服务端分发、员工按需安装，任何情况下都不许经这条
    // 开机同步路径落进技能库。清单本身已经把它们排除了，这一条挡的是"将来有人
    // 手滑把平台技能名加回 BUILTIN_SKILLS"——那种回归会让「按需安装」静默失效，
    // 而失效的表现只是"按钮变成已安装"，没有任何报错。
    if (PLATFORM_SKILLS.includes(name)) continue
    const srcDir = join(pluginSkillsDir, name)
    const srcFile = join(srcDir, 'SKILL.md')
    if (!existsSync(srcFile)) {
      results.push({ name, action: 'missing' })
      continue
    }
    const destDir = join(userSkillsDir, name)
    const destFile = join(destDir, 'SKILL.md')
    const srcText = readFileSync(srcFile, 'utf8')
    // per-name 锁（F3 修复）：从"判定来源"到"换入完成"整段与安装器互斥。拿不到锁
    // 就如实拒收（零等待，理由见 {@link SKILL_LOCK_DIR}）——绝不并发写同一个落点。
    // `continue` 写在 try 里也没问题：finally 会先把锁放掉。
    const lock = acquireSkillDirLock(userSkillsDir, name)
    if (lock.ok !== true) {
      console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（${SKILL_LOCKED}）：${lock.message}`)
      results.push({ name, action: 'refused', message: lock.message, code: SKILL_LOCKED })
      continue
    }
    try {
      let action = 'unchanged'
      let message
      let code
      /** 本次是否走了"内容同一性采纳"（决定 unchanged 是否报成 adopted）。 */
      let adopted = false
      // 墓碑闸门（R4-B-4，第四轮独立审计）：用户显式卸载过这个随包技能 ⇒ 本轮
      // 一行都不写。必须放在**最前**（先于"目标是否存在"与来源判定）：卸载之后
      // 落点正是**不存在**的，而那恰恰是"首次安装"的形态 —— 不认墓碑就会原样装回。
      if (readSkillTombstone(userSkillsDir, name) !== null) {
        const reason = `${name} 被用户显式卸载过（技能库里有墓碑 ${join(userSkillsDir, SKILL_REMOVED_DIR, `${name}.json`)}）—— 尊重该选择，`
          + '本次不落盘。重新安装该技能（能力中心/上传同名技能）或删除墓碑文件即可恢复同步。'
        console.log(`[dsh-memory-evolve] 内置技能 ${name} 跳过（${SKILL_USER_REMOVED}）：${reason}`)
        results.push({ name, action: 'skipped', message: reason, code: SKILL_USER_REMOVED })
        continue
      }
      // 来源闸门（P1-1/P1-2）：目标目录存在时，**先**判定它是不是本插件自己的
      // （渠道 = plugin）。用户自制内容与其它商店渠道的同名技能都拒收；这一判定
      // 与 x-version 无关 —— 版本相同也照样如实报 refused，否则"本机是别的东西"
      // 会被 `unchanged` 掩盖成"已经是最新"。
      if (isPresent(destDir)) {
        const verdict = classifySyncTarget(destDir, name)
        if (!verdict.ok) {
          // 兼容路径（P1-1 追加，2026-09-23）：目录**没有任何** `release.json` 时，
          // 允许用"内容与随包技能逐字相同"来自证它确实是一份未经溯源的本插件副本
          // （A9 写溯源的修复不在任何已发布版本里 ⇒ 现场存在这类目录）。同一性
          // 不成立就照旧拒收；证明成立则**先补写溯源**再走正常路径。
          if (verdict.adoptable) {
            if (!isIdenticalTree(srcDir, destDir)) {
              const reason = `${verdict.message} 内容同一性判据不成立：目标目录必须与随包技能逐项相同`
                + '（多一个/少一个条目、改名、文件↔目录、任何字节差异、符号链接或读取失败都算不同）。'
              console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（保留本机内容，${SKILL_LOCAL_CONTENT}）：${reason}`)
              results.push({ name, action: 'refused', message: reason, code: SKILL_LOCAL_CONTENT })
              continue
            }
            // 同一性成立 = 已证明这是随包技能的副本，且目录里没有任何用户字节。
            // **先写溯源再走后面**：写失败即拒（绝不出现"内容换了、溯源没写"）。
            let written
            try {
              written = writePluginProvenance(destDir, name, skillVersion(srcText), userSkillsDir)
            } catch (error) {
              // 失败即拒（不换入、不改内容）。`writePluginProvenance` 自己已经把它
              // 本次写下的标记收回了；这里再收一次**空** `.picoaide/`：同一性检查
              // 刚刚证明它原本不存在，所以只删空目录（`rmdirSync` 非空即失败，绝不
              // 递归删任何东西）—— 否则那个空目录会让下一次开机的同一性判据恒不成立，
              // 把这一份永久挡在门外（无法自愈）。
              discardPluginProvenance(destDir, [])
              const reason = '内容同一性成立（确认是随包技能的逐字副本），但补写溯源（channel: plugin）失败，'
                + `已拒绝（不换入、不改内容）：${String(error?.message ?? error)}`
              console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（保留本机内容，${SKILL_ADOPT_FAILED}）：${reason}`)
              results.push({ name, action: 'refused', message: reason, code: SKILL_ADOPT_FAILED })
              continue
            }
            // F1（独立复审 r3）：**写后复检**——把刚写下的标记排除在条目集合之外，
            // 再证明一次"目标仍与随包技能逐字一致"。同一性判定与写溯源之间那个窗口
            // 里落进来的任何用户字节都会让复检失败，此时**收回自己刚写的标记**并拒收，
            // 绝不把用户内容盖成 plugin（那会在下一次随包升版时被整树换入静默删除）。
            if (!isIdenticalTree(srcDir, destDir, { ignoreTopLevel: INSTALLER_MARKERS })) {
              discardPluginProvenance(destDir, written)
              const reason = '内容同一性在**补写溯源期间**被打破（有别的写者/进程往这个技能目录里'
                + '写了东西）—— 已收回本次写下的溯源标记并拒绝采纳（绝不把用户内容标成 plugin：'
                + '那会让下一次随包升版把它当作本插件内容整树换掉）。'
              console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（保留本机内容，${SKILL_LOCAL_CONTENT}）：${reason}`)
              results.push({ name, action: 'refused', message: reason, code: SKILL_LOCAL_CONTENT })
              continue
            }
            adopted = true
            console.log(`[dsh-memory-evolve] 内置技能 ${name} 已采纳（内容与随包技能逐字一致、原缺溯源，已补写 channel: plugin）：${destDir}`)
          } else {
            // fail-loud：点名技能、原因与落点。整树换入会删掉目标目录里的**全部**
            // 内容（含用户自己的文件），所以这里绝不"尽力而为"。
            console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（保留本机内容，${verdict.code}）：${verdict.message}`)
            results.push({ name, action: 'refused', message: verdict.message, code: verdict.code })
            continue
          }
        }
      }
      const needsCopy = !existsSync(destFile)
        || skillVersion(srcText) > skillVersion(readFileSync(destFile, 'utf8'))
      if (needsCopy) {
        // 本地改动闸门（独立复审 N1）：随包同步是**唯一不需要用户动作**就会覆盖
        // 内容的写者，所以"用户改过的随包技能"必须在这里被拦下。判据 = 落点内容
        // 与上次同步写下的基准（`release.json` 的 `archiveChecksum`）不一致；
        // 自动路径没有 UI ⇒ 只能**如实拒收**（与市场侧"跳过并如实报告"同一口径），
        // 绝不静默整树换入。没有基准（本闸门之前落下的目录）时无从判定 ⇒ 不拦，
        // 但如实打日志（见 §兼容边界的认账口径）。
        const ownProv = readOwnPluginProvenance(destDir, name)
        const dirty = pluginContentDirty(destDir, ownProv)
        if (dirty === true) {
          const reason = `${destDir} 已被本地修改（内容哈希与上次同步写下的基准不一致，`
            + `${PROVENANCE_DIR}/${PROVENANCE_FILE} 的 archiveChecksum 是可比对的证据）—— `
            + '随包同步不覆盖用户内容，本次**不落盘**：技能/你的文件与改动全部原样保留'
            + '（能力中心会把它标成「已本地修改」）。要换回随包版本：删除该技能目录后重启客户端'
            + '（会重新装一份干净的随包技能）；要保留你的改动：什么都不用做。'
          console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（保留本机内容，${SKILL_LOCAL_CONTENT}）：${reason}`)
          results.push({ name, action: 'refused', message: reason, code: SKILL_LOCAL_CONTENT })
          continue
        }
        if (dirty === null && ownProv !== null) {
          // 有我们自己的溯源、但没有基准：本闸门之前落下的目录。无从判定"是不是
          // 用户改的" ⇒ 不误拦（随包升版不得退化），但这一档必须留痕。
          console.warn(`[dsh-memory-evolve] 内置技能 ${name} 缺少内容基准（archiveChecksum），`
            + '无法判断落点是否被本地修改 ⇒ 本次照旧整树换入（换入后会立即建立基准，此后不再有此窗口）。')
        }
        try {
          syncSkillDirSafe(srcDir, destDir, userSkillsDir)
          action = 'synced'
        } catch (error) {
          // fail-loud 但可感知：绝不把"没写成/写到库外"报成 synced。
          action = 'refused'
          message = String(error?.message ?? error)
          if (typeof error?.code === 'string') code = error.code
          if (error?.code === 'SKILL_SWAP_RECOVERY_FAILED') {
            // S13-3 复核（2026-09-17）：换入失败**且**回滚也失败——比普通 refused
            // 严重一级（技能目录当前缺失，新旧两份副本还在盘上）。用 error 级别 +
            // 点名路径，让它在启动日志里不被 warn 洪水淹没。
            console.error(`[dsh-memory-evolve] 内置技能 ${name} 换入失败且未能回滚，需人工恢复：${message}`)
          } else {
            console.warn(`[dsh-memory-evolve] 内置技能 ${name} 落点被拒（跳过）：${message}`)
          }
        }
      } else if (adopted) {
        // 内容既然与随包技能逐字相同，`x-version` 必然相同（同一份 SKILL.md）⇒
        // 不需要换入。本次的唯一动作就是补写溯源，如实报 `adopted`（不是 unchanged：
        // 调用方/日志要能看出"这份目录是被采纳的，不是本来就带溯源的"）。
        action = 'adopted'
      } else {
        // 版本一致（无事可做）的路径上补一次基准（独立复审 N1 的兼容边界）：
        // 本闸门之前落下的目录有 plugin 溯源却没有 `archiveChecksum` ⇒ 我们永远
        // 判不出"有没有被改过"。这里只做**能证明**的那一半：内容与随包技能逐字
        // 相同（`isIdenticalTree`，忽略安装器标记）⇒ 这份目录里没有用户字节，
        // 基准 = 当前内容树哈希，直接写下即可。内容已经不同则**不猜**（不写基准、
        // 不判脏、也不拦），留待下一次随包升版按"无基准"那一档处理并打日志。
        // 失败只记日志：基准是"下一次判定"的依据，写不进去不影响本次（无事可做）。
        if (existsSync(destDir)) {
          const ownProv = readOwnPluginProvenance(destDir, name)
          const missingBaseline = ownProv !== null
            && !(typeof ownProv.archiveChecksum === 'string' && ownProv.archiveChecksum !== '')
          if (missingBaseline && isIdenticalTree(srcDir, destDir, { ignoreTopLevel: INSTALLER_MARKERS })) {
            // 这里写的是**活的**技能目录（不是暂存目录），所以失败时必须把两个标记
            // 逐字节还原：`writePluginProvenance` 失败路径会收回"自己刚写下的文件"，
            // 而它覆盖的可能是原本就在位的 `release.json`（own 非 null 才会有本分支）
            // —— 不还原就等于把用户的溯源标记删掉。
            const snapshot = snapshotInstallerMarkers(destDir)
            try {
              writePluginProvenance(destDir, name, skillVersion(srcText), userSkillsDir)
              console.log(`[dsh-memory-evolve] 内置技能 ${name} 已补写内容基准（archiveChecksum）：`
                + '内容与随包技能逐字一致 ⇒ 此后本地改动可判（随包升版不再无条件整树换入）。')
            } catch (error) {
              restoreInstallerMarkerBytes(destDir, snapshot, userSkillsDir)
              console.warn(`[dsh-memory-evolve] 内置技能 ${name} 补写内容基准失败（忽略，下次同步再试）：${String(error?.message ?? error)}`)
            }
          }
        }
      }
      results.push({
        name,
        action,
        ...(message === undefined ? {} : { message }),
        ...(code === undefined ? {} : { code }),
      })
    } finally {
      // 锁必须在**所有**出口释放（含上面每条 `continue`：JS 会先跑 finally）。
      lock.release()
    }
  }
  // S13-3 三轮复核（2026-09-17）：**收尾再扫一遍**。SIGKILL 落在"改名为 .old-* 之后、
  // 暂存目录换入之前"时（dest 缺失 + .old-* 是旧内容唯一副本），开头的清扫必须留下
  // .old-*；本次同步刚把真目录装回来，这一遍就能立刻收掉它 —— 否则它会以"带真实
  // frontmatter name 的幽灵目录"活到下次启动，被 DSH 技能发现记成重复候选
  // （skill … ignored because a higher-priority skill already exists，整整一个会话）。
  sweepStaleSwapDirs(userSkillsDir)
  return results
}

/**
 * 把旧技能文件里的**禁用标记**带进即将换入的新内容（N1b，独立复审 R5-B-4）。
 *
 * 判据只有一条：旧 `SKILL.md` 带 `disable-model-invocation`（见
 * `../skill-manifest.js` 的 {@link hasDisableFlag}）⇒ 把它按同一份实现
 * （{@link toggleDisableFlag}）写进暂存目录的 `SKILL.md`。因此"换入"对禁用状态
 * 完全透明：文件与插件 state 不会因为一次更新而分叉。
 *
 * 不成立的情形一律**不动作**（首次安装没有旧文件、旧文件不是规范 SKILL.md、新内容
 * 已经带标记、读失败）——本函数只做"保留"，绝不新增/删除禁用状态。
 *
 * @param {string} destDir - 技能库内的旧技能目录。
 * @param {string} stagingDir - 已写好新内容的暂存目录。
 * @param {string} anchorDir - 技能库根（落点断言的基准）。
 * @returns {boolean} 是否真的把标记写进了暂存内容。
 */
function preserveDisableFlag(destDir, stagingDir, anchorDir) {
  let oldText
  try {
    oldText = readFileSync(join(destDir, 'SKILL.md'), 'utf8')
  } catch {
    return false
  }
  if (!hasDisableFlag(oldText)) return false
  const stagedFile = join(stagingDir, 'SKILL.md')
  let stagedText
  try {
    stagedText = readFileSync(stagedFile, 'utf8')
  } catch {
    return false
  }
  const next = toggleDisableFlag(stagedText, true)
  if (next === null || next === stagedText) return false
  writeFileAtomicSafeAt(stagedFile, next, { anchorDir })
  return true
}

/**
 * 整目录落盘（上游 v26091501 的"整目录同步"语义 × 本地 NF-1 落点断言）。
 *
 * 语义：**先写暂存目录、全部写成后整体换入**——用户自加在内置技能目录里的
 * 文件随整目录替换一起消失（上游"整目录覆盖"行为不变）。安全面：
 *   - `<userSkillsDir>/<name>` 存在但不是真实目录（符号链接 / 普通文件）→ 拒收；
 *   - 目标目录内**任何**符号链接条目 → 拒收（换入之前先扫，见下）；
 *   - 逐文件 `writeFileAtomicSafeAt(..., { anchorDir })`：从技能库根到落点整条链
 *     逐层 lstat，任一符号链接或真实路径逃出技能库即拒收（含 TOCTOU 窗口——
 *     断言在原子写内部对写入前的真实路径复检）。
 * 任一文件被拒即抛错，由调用方记 `refused` 并跳过该技能（不静默半写）。
 * S13-3（2026-09-17 审计）：上一版是"先 rm 目标目录再逐文件写"，循环里任何
 * 一次失败（ENOSPC/EACCES/预扫之后才出现的符号链接…）都会把已装好的技能删空
 * 或写一半，而调用方只记 refused——与本函数"不静默半写"的承诺相反（v2.7.4 的
 * 单文件原子写在失败时保留旧文件，属回归）。
 *
 * **换入是三步可恢复的（S13-3 复核，2026-09-17）**（临时副本一律在
 * `<skills>/.skill-tmp/` 这一层，见 {@link STAGING_INFIX}）：
 *   1) `rename(old → .skill-tmp/.old-<name>-<pid>-<ts>)` 把旧目录原子旁置（不再先 rm）；
 *   2) `rename(.skill-tmp/.staging-<name>-<pid>-<ts> → dest)` 让新内容就位；
 *   3) 删除旁置副本（尽力而为，删不掉留给下次同步清扫）。
 * 因此失败面只有两种，且都不丢内容：
 *   - 第 2 步失败 → 先把旁置副本改回原处再抛原始错误（旧技能原封不动，暂存副本
 *     清理掉），调用方记 `refused`；
 *   - 第 2 步失败**且**回滚也失败 → 抛 {@link SkillSwapRecoveryError}
 *     （code=SKILL_SWAP_RECOVERY_FAILED），错误文本点名暂存（新）与旁置（旧）两份
 *     副本路径，调用方按"需要人工恢复"上报，而不是含糊的 refused。
 * 保证的边界要说清：**"旧目录在失败时原样保留"只覆盖到上面这两条路径**；进程被
 * SIGKILL/断电打断（不走 catch）时目录状态取决于断点，残留由下次同步开头的
 * {@link sweepStaleSwapDirs} 收拾。
 *
 * A9（2026-09-23）追加一条：换入前后**安装器标记不丢**——旧目录的
 * `.picoaide/`.install-version 先搬进新内容，再补一份本插件自己的 provenance
 * （channel: 'plugin'），见 {@link stashInstallerMarkers} / {@link writePluginProvenance}。
 *
 * @param {string} srcDir - 插件包内技能目录。
 * @param {string} destDir - 用户技能库内的目标目录。
 * @param {string} anchorDir - 技能库根（落点断言的基准）。
 */
function syncSkillDirSafe(srcDir, destDir, anchorDir) {
  const name = basename(destDir)
  let hadDest = false
  try {
    const stat = lstatSync(destDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw writeTargetRefusedError(destDir)
    hadDest = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // 换入**之前**先扫一遍：目标目录里任何符号链接条目都拒收。上游的整目录语义
  // 是 `rm -rf` 后重铺，遇到预置的 `<name>/SKILL.md` 链接会"顺带删掉链接再写真
  // 文件"——不写穿，但把拒收变成了静默删除（调用方看到 synced，用户预置的链接
  // 却没了）。本地 NF-1 的口径是 fail-loud：不动那个链接、如实报 refused。
  const planted = findSymlinkEntry(destDir)
  if (planted !== null) throw writeTargetRefusedError(join(destDir, planted))
  // 暂存目录建在技能库的**第二层**私有目录里（R4-B-2）：与目标同一文件系统
  // （rename 才能原子换入），而运行时只说"技能库的直接子目录才是技能" ⇒ 第二层
  // 结构上不可能被发现（对照：根上不论叫什么名字都会被 discoverRoot 按 frontmatter
  // 的名字索引，见 {@link STAGING_INFIX} 的头注释）。落点仍在技能库根之下，
  // 逐文件断言（anchorDir）照旧生效。
  const stamp = `${process.pid}-${Date.now()}`
  const stagingDir = join(anchorDir, SKILL_TEMP_DIR, `${STAGING_INFIX}${name}-${stamp}`)
  let asideDir = null
  /** 从旧目录搬进暂存目录的安装器标记（回滚时要搬回去）。 */
  let stashedMarkers = []
  /**
   * 换入前对"我们可能改写其内容"的标记文件做的**原样快照**（R4-B-1 的回滚保真）。
   *
   * 为什么必须有：R4-B-1 让本插件把自己写的那份 `release.json` / `.install-version`
   * 按新 `x-version` 覆写（搬进暂存目录之后写），若换入失败再把它们搬回旧目录，
   * 旧内容就会配上一个**属于新版本**的版本号（界面与遥测都会读错）。快照在
   * {@link stashInstallerMarkers} **之前**取（那时文件还在旧目录里），回滚后逐字节
   * 写回。只还原、**绝不删除**：快照里缺席的文件在回滚时不动作 —— 那个窗口里
   * 别的写者新建的东西不属于我们，不能被"还原"顺手删掉。
   */
  let markerSnapshot = null
  try {
    mkdirSync(stagingDir, { recursive: true })
    const srcText = readFileSync(join(srcDir, 'SKILL.md'), 'utf8')
    for (const rel of listFilesRel(srcDir)) {
      writeFileAtomicSafeAt(join(stagingDir, rel), readFileSync(join(srcDir, rel)), { anchorDir })
    }
    // A9（2026-09-23）：整目录换入**不丢安装器标记**——旧目录里的 `.picoaide/`
    // 与 `.install-version` 先搬进新内容，随同一次原子 rename 回到位；目标没有
    // provenance 时再补一份本插件自己的（channel: 'plugin'），使能力中心不会把
    // 随包装上的技能当成"用户自制"。两步都在换入之前完成，所以没有"换入成功但
    // 溯源丢了"的中间态。
    markerSnapshot = snapshotInstallerMarkers(destDir)
    stashedMarkers = stashInstallerMarkers(destDir, stagingDir)
    // N1b（独立复审 R5-B-4）：**禁用标记随换入保留**。用户在「技能管理」里禁用过这个
    // 技能时，标记写在 SKILL.md frontmatter 里（`disable-model-invocation`，写入端是
    // `skills-manager.js` 的 `applyDisableFlagToFile`）；整树换入会把文件换成随包那一
    // 份（没有标记）⇒ 文件说"启用"、插件 `state.disabled` 说"禁用"，两边各记一份且
    // 无人对账。这里在**换入之前**把旧文件的标记写进新内容，做到零窗口（插件侧还有
    // 一条启动/目录变化时的投影兜底，见 `skills-manager.js` 的 `projectDisableFlags`）。
    preserveDisableFlag(destDir, stagingDir, anchorDir)
    writePluginProvenance(stagingDir, name, skillVersion(srcText), anchorDir)
    // F3 纵深防御（独立复审 r3）：即将换入的这棵树**必须**带着我们自己的溯源。
    // per-name 锁已经把安装器挡在外面；这一条挡的是"标记在锁外被换掉"的其余形态
    // （stash 与 swap 之间落进来的别的写者）——一旦捕捉到的不是 plugin 标记（例如
    // 市场版刚换进来、被我们连同目录一起搬走），就放弃换入，让 catch 里的
    // `restoreInstallerMarkers` 把它原样放回。否则落点会变成"内容是插件版、溯源是
    // 市场版"，而且插件侧此后永久拒收（不会自愈）。
    const stagedChannel = readStoreProvenance(stagingDir, name).channel
    if (stagedChannel !== PLUGIN_CHANNEL) {
      const conflict = new Error(`${destDir} 换入前复检发现暂存目录里的溯源不是 plugin`
        + `（实际：${String(stagedChannel)}）—— 放弃换入：内容与归属必须一致，`
        + '不把别的渠道的溯源连同自己的内容一起换进去。')
      conflict.code = SKILL_CHANNEL_CONFLICT
      throw conflict
    }
    // 1) 旧目录旁置（原子；不再有"rm 之后 rename 失败 ⇒ 技能消失"的窗口）
    if (hadDest) {
      asideDir = join(anchorDir, SKILL_TEMP_DIR, `${ASIDE_INFIX}${name}-${stamp}`)
      renameSync(destDir, asideDir)
    }
    // 2) 新内容就位；失败先把旧目录改回来（回滚再失败 → 抛可恢复错误）
    try {
      renameSync(stagingDir, destDir)
    } catch (error) {
      if (asideDir === null) throw error
      try {
        renameSync(asideDir, destDir)
      } catch (restoreError) {
        throw new SkillSwapRecoveryError(destDir, stagingDir, asideDir, error, restoreError)
      }
      throw error
    }
    // 3) 旁置副本已是垃圾：删除尽力而为，删不掉留给下次同步清扫
    if (asideDir !== null) {
      try { rmSync(asideDir, { recursive: true, force: true }) } catch { /* 留给清扫 */ }
    }
  } catch (error) {
    // 回滚成功（或目标一直都在）时，把搬进暂存目录的安装器标记原样搬回目标目录——
    // 清理暂存副本不能顺手带走用户的溯源。目标缺失（SkillSwapRecoveryError 那一路）
    // 时两份副本刻意保留，标记随暂存副本一起留在盘上，可人工恢复。
    if (existsSync(destDir)) {
      restoreInstallerMarkers(destDir, stagingDir, stashedMarkers)
      // R4-B-1：搬回来的可能已被我们按新 x-version 改写 ⇒ 用换入前的字节还原。
      restoreInstallerMarkerBytes(destDir, markerSnapshot, anchorDir)
    }
    // 只有"目标目录仍然在盘上（旧内容在位 / 回滚成功 / 新内容已就位）"或
    // "本来就没有旧目录"时才删暂存副本；目标缺失时暂存目录是这份内容的唯一
    // 完整副本，必须保留并在错误里点名（S13-3 复核：否则技能将凭空消失）。
    if (!hadDest || existsSync(destDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* 残留由下次同步清扫 */ }
    }
    throw error
  }
}

/**
 * 把旧目标目录里的安装器标记搬进新内容暂存目录（A9 修复，2026-09-23）。
 *
 * 只搬**真实存在的**目录/文件，且暂存目录里已有同名条目时不动（源包自带的
 * 优先）。搬不动（跨设备/权限）就留在旧目录里——随后它会被旁置副本带着走，
 * 内容不丢，只是下一次同步不再被保留。
 *
 * @param {string} destDir - 技能库内的旧技能目录。
 * @param {string} stagingDir - 已写好新内容的暂存目录。
 * @returns {string[]} 实际搬走的条目名（供 {@link restoreInstallerMarkers} 回滚）。
 */
function stashInstallerMarkers(destDir, stagingDir) {
  const moved = []
  for (const marker of INSTALLER_MARKERS) {
    const from = join(destDir, marker)
    const to = join(stagingDir, marker)
    if (existsSync(to) || !existsSync(from)) continue
    try {
      renameSync(from, to)
      moved.push(marker)
    } catch { /* 搬不动：留在旧目录（内容不丢） */ }
  }
  return moved
}

/**
 * 换入失败并回滚后，把搬进暂存目录的安装器标记原样搬回目标目录。
 * @param {string} destDir - 已复原的技能目录。
 * @param {string} stagingDir - 暂存目录（即将被清理）。
 * @param {string[]} moved - {@link stashInstallerMarkers} 的返回值。
 * @returns {void}
 */
function restoreInstallerMarkers(destDir, stagingDir, moved) {
  for (const marker of moved) {
    const back = join(destDir, marker)
    if (existsSync(back)) continue
    try { renameSync(join(stagingDir, marker), back) } catch { /* 尽力；清不掉也不影响同步 */ }
  }
}

/**
 * 换入前对安装器标记里**可能被本插件改写**的那两个文件取原样快照（R4-B-1）。
 *
 * 只在文件确实是"小普通文件"时留下字节（复用 {@link readSmallRegularFile} 的
 * FIFO/体积闸门：宁可没有快照，也不把 FIFO 读成阻塞源）；其余形态一律记为"无快照"。
 *
 * @param {string} destDir - 技能库内的旧技能目录。
 * @returns {Map<string, Buffer>} 相对路径 → 换入前的字节（读不出的条目不进表）。
 */
function snapshotInstallerMarkers(destDir) {
  const snapshot = new Map()
  for (const rel of [join(PROVENANCE_DIR, PROVENANCE_FILE), '.install-version']) {
    const read = readSmallRegularFile(join(destDir, rel), MARKER_MAX_BYTES)
    if (read.status === 'ok') snapshot.set(rel, read.bytes)
  }
  return snapshot
}

/**
 * 回滚后把快照里的标记逐字节写回（R4-B-1 的回滚保真）。
 *
 * 只写快照里**有字节**的条目；快照缺席的一律不动作（绝不"还原"成一个删除 ——
 * 那个窗口里别的写者新建的文件不属于我们）。写失败只忽略：回滚路径的首要目标是
 * 让旧内容在位，标记的最坏情况是被下一次安装/同步修正。
 *
 * 落点用 {@link writeFileAtomicSafeAt}（与换入路径同一个自锚定写原语）：
 * 回滚后的目录里可能被预置了符号链接，裸 `writeFileSync` 会写穿到库外
 * （仓库的结构哨兵 `coi-skill-landing-unasserted-write.test.js` 会直接报红）。
 *
 * @param {string} destDir - 已复原的技能目录。
 * @param {Map<string, Buffer>|null} snapshot - {@link snapshotInstallerMarkers} 的返回值。
 * @param {string} anchorDir - 技能库根（落点断言的基准）。
 * @returns {void}
 */
function restoreInstallerMarkerBytes(destDir, snapshot, anchorDir) {
  if (snapshot === null) return
  for (const [rel, bytes] of snapshot) {
    try { writeFileAtomicSafeAt(join(destDir, rel), bytes, { anchorDir }) } catch { /* 尽力 */ }
  }
}

/**
 * 一份技能目录的内容哈希（**与安装器逐字节同源**的整树哈希，独立复审 N1）。
 *
 * 这是「本机这一份是否被用户改过」的**唯一可比基准**：安装器在装的时候写一份
 * （`computeSkillContentHash`），本插件在每次自己写内容之后写一份（见
 * {@link writePluginProvenance}），两侧此后都用同一算法重算盘上的内容来比对。
 *
 * 算法（与 `packages/host/enterprise/src/skill-install.ts` 的
 * `computeSkillContentHash` 逐字节一致 —— 跨包 import 禁止，所以这里是**本地复刻**
 * 而不是共享模块，等价性由企业包 `tests/skill-channel-parity.spec.ts` 用真实
 * fixture（嵌套目录 / 空目录 / 二进制 / 非 ASCII 名 / 符号链接 / 顶层 `.picoaide`）
 * 对拍，任何一侧漂移都会立刻打红）：
 *   - `sha256`；
 *   - 逐层 `readdir({ withFileTypes: true })` 后按 `name.localeCompare` 排序（两侧
 *     同一个表达式 ⇒ 同一份 Node/ICU 下同序）；
 *   - 目录 → `D:<相对路径>\n`；普通文件 → `F:<相对路径>:` + 原始字节 + `\n`
 *     （不解码、不做编码归一化）；
 *   - **只排除顶层的 `.picoaide/`**（安装器/本插件的溯源目录，写它不得让内容变脏）；
 *     `.install-version` 是内容的一部分，因此它必须在算基准**之前**写到最终字节；
 *   - 符号链接等其它条目两侧都按"不看"处理（既不是目录也不是普通文件）。
 *
 * 相对路径一律用 `/` 连接（与安装器同形），保证 Windows/Linux 同值。
 *
 * @param {string} skillDir - 技能目录。
 * @returns {string} 64 位十六进制的 sha256。
 */
export function skillContentChecksum(skillDir) {
  const hash = createHash('sha256')
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (prefix === '' && entry.name === PROVENANCE_DIR) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`)
        walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        hash.update(`F:${rel}:`)
        // 顶层 SKILL.md 走**规范化**字节（N1b）：本插件管理的 frontmatter 字段
        // （`disable-model-invocation`）不进内容哈希 —— 「禁用」是平台动作，
        // 不是"用户改了内容"。归一化无字段即逐字节原样（老基准不受影响）。
        const bytes = readFileSync(join(dir, entry.name))
        hash.update(rel === 'SKILL.md' ? normalizeSkillManifestBytes(bytes) : bytes)
        hash.update('\n')
      }
    }
  }
  walk(skillDir, '')
  return hash.digest('hex')
}

/**
 * 落点里的内容相对"上次同步写下的基准"是否已变（本地改动闸门，独立复审 N1）。
 *
 * 三态（与企业侧 `isInstalledSkillDirty` 同口径，只是多一档"无从判定"）：
 *   - `true`：有基准且**对不上** ⇒ 用户改过（改过正文、加过/删过文件都算）；
 *   - `false`：有基准且对得上 ⇒ 没改过，可以照常整树换入；
 *   - `null`：**没有基准**（本闸门之前落下的目录）或读不出来 ⇒ 无从判定。调用方
 *     据此**不拦**（宁可少判脏，与安装器既有口径一致）并把这一档如实打日志 ——
 *     凭空判脏会让每一次正常升版都被挡下，那是随包技能的主要用途。
 *
 * 哈希算不出来（权限/IO）同样返回 `null`：不因为算不出来就拦下正常更新。
 *
 * @param {string} destDir - 技能库内的目标技能目录。
 * @param {object|null} own - {@link readOwnPluginProvenance} 的返回值。
 * @returns {boolean|null} 改过 / 没改过 / 无从判定。
 */
function pluginContentDirty(destDir, own) {
  const baseline = typeof own?.archiveChecksum === 'string' && own.archiveChecksum !== '' ? own.archiveChecksum : null
  if (baseline === null) return null
  let now
  try {
    now = skillContentChecksum(destDir)
  } catch {
    return null
  }
  return now !== baseline
}

/**
 * 补齐/刷新本插件自己的来源溯源（A9 + R4-B-1 修复，2026-09-23；
 * `archiveChecksum` 基准为独立复审 N1 追加）。
 *
 * 目标没有 `.picoaide/release.json` 时写一份 `channel: 'plugin'` 的：
 * 字段与 enterprise 安装器 `writeProvenance` 一致（`appId` / `version` /
 * `channel` / `installedAt` / `archiveChecksum`），版本号取 SKILL.md 的
 * `x-version`（没有则 `''`）。
 *
 * **N1：`archiveChecksum` 必须写。** 此前这里刻意不写（"跨包 import 禁止 ⇒ 宁缺
 * 勿错"），而企业侧 `isInstalledSkillDirty` 没有基准就返回 `false` —— 两者互为因果
 * ⇒ 随包技能结构性不在「用户是否改过」的判据内，而**开机自动同步**正是唯一不需要
 * 用户动作就会覆盖内容的写者：用户改了随包技能，下一次升版整树换入、用户字节消失、
 * 零提示。基准的取值 = {@link skillContentChecksum}（与安装器逐字节同源，等价性由
 * 企业包的对拍用例钉住）。
 *
 * **写的顺序不可换**：`.install-version` 先写到最终字节（它是内容树的一部分，被算进
 * 哈希），然后算基准，最后写 `release.json`（顶层 `.picoaide/` 被排除在哈希之外，
 * 写它不影响基准）。顺序反了，基准就会与盘上内容差一个文件 ⇒ 下一次比对恒判"脏"。
 *
 * **R4-B-1（P3，第四轮独立审计）：随包升版后，我们自己写的那份溯源必须跟着换。**
 * `stashInstallerMarkers` 会把旧目录的 `.picoaide/` 与 `.install-version` 搬进新内容
 * （A9），而旧实现的"只在缺失时写"因此对它们全部跳过 ⇒ 整树换入新内容（frontmatter
 * `x-version: 1 → 2`）之后，盘上的 `release.json.version` 与 `.install-version` 仍是
 * **旧值 1**。消费端把它当权威：能力中心显示 `prov.version`、技能调用遥测直接上报
 * `.install-version`（`enterprise/src/auth-gate.ts` / `skill-telemetry.ts`）⇒ 界面与
 * 遥测的版本号与内容不符。判据：升版后再同步一次，两个文件都必须等于新 `x-version`。
 *
 * 只重写**自己写的**那一份（`channel === 'plugin'` 且 `appId` 相符）：
 *   - 别的渠道的标记（market / org / builtin）**一个字都不动** —— 它随后会被
 *     `syncSkillDirSafe` 的换入前复检（stagedChannel !== plugin）拦下并原样搬回，
 *     绝不把别人的归属改写成 plugin；
 *   - 标记可读但不是我们写的那一份（JSON 坏 / appId 不符 / 渠道未知）同样不动；
 *   - 已有标记的其它字段（`server` / `installedAt` 等）原样保留，
 *     只把 `version` 推进到新值、把 `archiveChecksum` 换成当前内容的基准 ——
 *     少写字段会让下游判据静默退化。
 * `x-version` 缺失（`version === ''`）时**不推进版本**（留旧值比写空串诚实），
 * 但基准照写：它与版本号无关，是"这份内容长什么样"的事实。
 * `.install-version` 与 `release.json` 同进同退（我们自己那一份的两处记录必须一致）。
 *
 * @param {string} stagingDir - 暂存目录（换入前）。
 * @param {string} name - 技能名。
 * @param {number} xVersion - SKILL.md 的 `x-version`（缺失为 0）。
 * @param {string} anchorDir - 技能库根（落点断言的基准）。
 * @returns {string[]} 本次**实际写下**的文件绝对路径（写后复检失败时按它精确回收）。
 *   写第二个文件时失败 ⇒ 已写下的第一个也在这里被收回（本函数自己保证不留半个标记）。
 */
function writePluginProvenance(stagingDir, name, xVersion, anchorDir) {
  const version = xVersion > 0 ? String(xVersion) : ''
  const releaseFile = join(stagingDir, PROVENANCE_DIR, PROVENANCE_FILE)
  const versionFile = join(stagingDir, '.install-version')
  const own = readOwnPluginProvenance(stagingDir, name)
  const written = []
  try {
    // 1) 版本文件先写到最终字节（内容树的一部分 ⇒ 必须进基准）。
    let writeVersion = false
    if (version !== '') {
      const current = readSmallRegularFile(versionFile, MARKER_MAX_BYTES)
      writeVersion = own === null ? current.status !== 'ok' : current.status !== 'ok' || current.text !== version
    }
    if (writeVersion) {
      writeFileAtomicSafeAt(versionFile, version, { anchorDir })
      written.push(versionFile)
    }
    // 2) 基准 = 此刻整棵内容树的内容哈希。
    const archiveChecksum = skillContentChecksum(stagingDir)
    // 3) `release.json` 最后写（顶层 `.picoaide/` 被排除在哈希之外，写它不影响基准）。
    if (own !== null) {
      const next = { ...own, archiveChecksum, ...(version === '' ? {} : { version }) }
      writeFileAtomicSafeAt(releaseFile, `${JSON.stringify(next, null, 2)}\n`, { anchorDir })
      written.push(releaseFile)
    } else if (!existsSync(releaseFile)) {
      const info = { appId: name, version, channel: PLUGIN_CHANNEL, installedAt: new Date().toISOString(), archiveChecksum }
      writeFileAtomicSafeAt(releaseFile, `${JSON.stringify(info, null, 2)}\n`, { anchorDir })
      written.push(releaseFile)
    }
  } catch (error) {
    discardPluginProvenance(stagingDir, written)
    throw error
  }
  return written
}

/**
 * 读**本插件自己写的**那一份溯源（R4-B-1 的判据入口）。
 *
 * 只有"可读 + `appId` 相符 + `channel === 'plugin'`"三件同时成立才算自己人；
 * 其余（缺失 / 读不出 / JSON 坏 / appId 不符 / 别的渠道）一律返回 `null` —— 调用方
 * 据此保持"别人的标记一个字都不动"。
 *
 * @param {string} dir - 暂存/技能目录。
 * @param {string} name - 技能名（= 目录名）。
 * @returns {object|null} 解析出的标记对象（原样，供保留其它字段）；不算自己人时 null。
 */
function readOwnPluginProvenance(dir, name) {
  const marker = readSmallRegularFile(join(dir, PROVENANCE_DIR, PROVENANCE_FILE), MARKER_MAX_BYTES)
  if (marker.status !== 'ok') return null
  let parsed
  try {
    parsed = JSON.parse(marker.text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  if (typeof parsed.appId !== 'string' || parsed.appId !== name) return null
  if (parsed.channel !== PLUGIN_CHANNEL) return null
  return parsed
}

/**
 * 收回**自己刚写下**的溯源标记（F1 的写后复检失败路径，独立复审 r3）。
 *
 * 只删 `written` 里点名的文件（逐个 `unlinkSync`），并且只用**非递归** `rmdirSync`
 * 收掉已经空掉的 `.picoaide/`：非空即失败 —— 绝不递归删任何东西，用户在那个窗口里
 * 落进 `.picoaide/` 的字节一个都不会被删。
 *
 * @param {string} dir - 技能目录。
 * @param {string[]} written - {@link writePluginProvenance} 的返回值（可为空数组：
 *   仅尝试收掉空 `.picoaide/`，用于"写失败但可能已建出空目录"的场景）。
 * @returns {void}
 */
function discardPluginProvenance(dir, written) {
  for (const file of written) {
    try { unlinkSync(file) } catch { /* 已经不在了 / 权限：留着由下一次同步按"看不懂的标记"拒 */ }
  }
  try { rmdirSync(join(dir, PROVENANCE_DIR)) } catch { /* 非空/不存在/不是目录：留着 */ }
}

/**
 * 换入失败且旧目录回滚也失败（S13-3 复核，2026-09-17）。
 *
 * 这是"内容还在、但技能目录暂时缺失"的第三态：暂存目录里是完整的新副本，
 * 旁置目录里是完整的旧副本，两者都刻意保留（见 {@link syncSkillDirSafe} 的
 * catch）。调用方（{@link syncBuiltinSkills}）按 `code` 把它与普通 `refused`
 * 区分开，用 error 级别上报路径供人工恢复。
 */
export class SkillSwapRecoveryError extends Error {
  /**
   * @param {string} destDir - 本应就位的技能目录。
   * @param {string} stagingDir - 新内容副本（保留）。
   * @param {string} asideDir - 旧内容副本（保留）。
   * @param {unknown} swapError - 换入 rename 的原始错误。
   * @param {unknown} restoreError - 回滚 rename 的错误。
   */
  constructor(destDir, stagingDir, asideDir, swapError, restoreError) {
    super(`dsh-memory-evolve: 技能目录 ${destDir} 换入失败且旧目录回滚失败 —— 需人工恢复：新副本 ${stagingDir}，旧副本 ${asideDir}（换入错误：${swapError?.message ?? swapError}；回滚错误：${restoreError?.message ?? restoreError}）`)
    this.name = 'SkillSwapRecoveryError'
    this.code = 'SKILL_SWAP_RECOVERY_FAILED'
    this.destDir = destDir
    this.stagingDir = stagingDir
    this.asideDir = asideDir
  }
}

/**
 * 解析换入临时目录名（只看 basename，落点由 {@link sweepStaleSwapDirs} 决定）。
 *
 * **当前命名**（写入时一律用这一种；落在 `<skills>/.skill-tmp/` 里，见
 * {@link SKILL_TEMP_DIR}）：
 *   `.staging-<skill>-<pid>-<ts>` / `.old-<skill>-<pid>-<ts>`
 * **历史命名**（升级前写下的崩溃残留，直接躺在技能库根上；仍要能清掉）：
 *   `<skill>.staging-<pid>-<ts>` / `<skill>.old-<pid>-<ts>`（无前导点）
 *   `.staging-<skill>-<pid>-<ts>` / `.old-<skill>-<pid>-<ts>`（A16 的前导点形态）
 *
 * ⚠️ 前导点**不是**"上游看不见"的判据（A16 的注释曾这么写，与 pinned 上游不符，
 * 见 {@link STAGING_INFIX} 的头注释）：真正的不可见来自**层数** —— 只有技能库的
 * 直接子目录会被 `discoverRoot` 发现。前导点在这里只剩"万一被拿到根上也不会命中
 * 客户端/上游的技能名规则"这一层纵深防御。
 *
 * @param {string} name - 技能库根或 `.skill-tmp/` 下的目录名。
 * @returns {{skillName:string, pid:number, ts:number, aside:boolean}|null}
 */
function parseSwapDirName(name) {
  for (const [infix, aside] of [[STAGING_INFIX, false], [ASIDE_INFIX, true]]) {
    // 带前导点形态：<infix><skill>-<pid>-<ts>。贪婪匹配让技能名里的连字符不被吃进 pid/ts。
    const hidden = new RegExp(`^\\${infix}(.+)-(\\d+)-(\\d+)$`).exec(name)
    if (hidden !== null) {
      return { skillName: hidden[1], pid: Number(hidden[2]), ts: Number(hidden[3]), aside }
    }
    // 旧命名：<skill><infix><pid>-<ts>（无前导点）
    const at = name.lastIndexOf(infix)
    if (at <= 0) continue
    const match = /^(\d+)-(\d+)$/.exec(name.slice(at + infix.length))
    if (match === null) continue
    return { skillName: name.slice(0, at), pid: Number(match[1]), ts: Number(match[2]), aside }
  }
  return null
}

/**
 * pid 是否还活着。唯一用途是判断某个暂存/旁置目录是否属于"正在跑的同步"。
 * ESRCH=不存在；EPERM=存在但无权限（宁可漏扫，不可误扫）；非法 pid 当不存在。
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 清扫上次同步留下的暂存/旁置目录（S13-3 复核，2026-09-17）。
 *
 * 判据三条同时成立才删，且只在本插件自己的命名空间内动手：
 *   - **落点 + 名字形状匹配**：新落点是技能库的私有第二层
 *     `<skills>/.skill-tmp/`（R4-B-2），旧落点是技能库**根**——两种都要扫，因为
 *     升级前写下的残留（`<成员>.staging-<pid>-<ts>` 与 A16 的
 *     `.staging-<成员>-<pid>-<ts>`）就在根上；技能名限定在内置清单里，绝不碰
 *     用户自己的目录，也绝不碰安装器在同一个 `.skill-tmp` 里的 `install-*`；
 *   - **陈旧**：pid 已不存在，或目录年龄超过 {@link STALE_SWAP_MAX_AGE_MS}
 *     （pid 复用兜底）；仍在跑的并发同步（活 pid + 新时间戳）不动；
 *   - **旁置副本额外要求真技能目录还在**：真目录缺失时那个旁置目录是旧内容的
 *     唯一副本（双 rename 失败路径），刻意留给人工恢复，不清。syncBuiltinSkills
 *     在同步循环**之后**会再调用一次本函数（2026-09-17 三轮复核）：本次同步把
 *     真目录装回来时，这个旁置副本立刻被收掉，不再以幽灵技能候选活到下次启动。
 * 删除失败只忽略：残留不影响同步正确性，下次启动再扫。
 *
 * @param {string} userSkillsDir - 用户技能库目录（`config.skillDir`，桌面端缺省 `<DSH_HOME>/skills`）。
 */
function sweepStaleSwapDirs(userSkillsDir) {
  const now = Date.now()
  /** 扫一层目录：`anchor` 是这些名字所在的目录（相对技能库根的可读前缀见下）。 */
  const sweep = (dir, atRoot) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return // 目录还不存在：没有残留可扫
    }
    for (const name of names) {
      const parsed = parseSwapDirName(name)
      if (parsed === null || !BUILTIN_SKILLS.includes(parsed.skillName)) continue
      // 自检：新落点里出现"根上那种无前导点的旧命名"说明有第三方往私有目录里塞东西，
      // 不能按自己的残留删（清单里也没有那种形状）。这里只接受带前导点的形状。
      if (!atRoot && !name.startsWith('.')) continue
      if (parsed.aside && !existsSync(join(userSkillsDir, parsed.skillName))) continue
      if (isPidAlive(parsed.pid) && now - parsed.ts <= STALE_SWAP_MAX_AGE_MS) continue
      try { rmSync(join(dir, name), { recursive: true, force: true }) } catch { /* 清不掉不影响同步 */ }
    }
  }
  // 新落点：技能库的第二层私有目录（运行时看不见的那一层）。
  sweep(join(userSkillsDir, SKILL_TEMP_DIR), false)
  // 旧落点：技能库根（升级前写下的 `<name>.staging-…` 与 A16 的 `.staging-<name>-…`）。
  sweep(userSkillsDir, true)
}

/** 递归列出目录下的普通文件（相对路径，'/'-分隔，供跨平台 join 使用）。 */
function listFilesRel(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...listFilesRel(join(dir, entry.name), rel))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

/**
 * 递归找目录下第一个符号链接条目（**不跟随**，`withFileTypes` 的
 * `isSymbolicLink()` 对"链接到目录"同样为真）。返回相对路径；无则 null。
 * 目录不存在/不可读按"没有"处理（清空前的探测，不制造新的失败面）。
 */
function findSymlinkEntry(dir, prefix = '') {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) return rel
    if (entry.isDirectory()) {
      const found = findSymlinkEntry(join(dir, entry.name), rel)
      if (found !== null) return found
    }
  }
  return null
}

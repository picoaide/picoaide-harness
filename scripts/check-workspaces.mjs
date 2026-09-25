#!/usr/bin/env node
/**
 * 根门禁编排器(2026-09-10):把 `yarn check` 从「10 个包串行 &&」改成
 * 「受依赖约束的两阶段并行」。
 *
 * 动因(实测 4 核):串行门禁 165s,其中大量时间只有一个包在跑,其余核空闲;
 * 且 desktop 的 lib/types 是 enterprise/account-card/branding 的 tsc 输入,
 * 必须先于它们产出——原来靠"在 check 链里排第一个"隐式保证,现在显式建模。
 *
 * 阶段划分:
 *   阶段 1  desktop check(= 产出全仓共用的 lib/types) ∥ 三个根守卫脚本
 *   阶段 2  其余 9 个 workspace 包 check,并发 4
 * 语义与串行版完全一致:跑的仍是每个包自己的 `check`(build+typecheck+test+verify),
 * 只是顺序与并发变了;CI 的 `yarn check` 用的是同一个入口。
 *
 * 用法:
 *   node scripts/check-workspaces.mjs                 # = yarn check
 *   node scripts/check-workspaces.mjs --changed       # 只跑本次改动影响的包(= yarn check:fast)
 *   node scripts/check-workspaces.mjs --changed origin/master
 *   node scripts/check-workspaces.mjs --only dsh-plugin-desktop,@picoaide/dsh-cron
 *   node scripts/check-workspaces.mjs --list          # 只打印将执行的任务
 * 环境变量:CHECK_CONCURRENCY 覆盖并发数(默认 min(4, CPU 数))。
 */

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// **子进程环境清洗 + 守卫执行体入口 = 唯一实现**（2026-09-24 第十一轮审计 I1 泳道）。
//
// 为什么两个 runner 都必须走这一份（P1-2 的现场）：第十轮只给 `check-root-guards.mjs`
// 加了清洗，`yarn check` 这条路径（本编排器）仍然是 `env: { ...process.env, FORCE_COLOR }`
// ⇒ 同一条 `NODE_OPTIONS=--import=<退出钩子>` 注入在 `yarn check` 上仍然 EXIT 1→0
// （审计实测）。清洗实现只有一份（`sanitizeGuardEnvironment`），接线有两处，
// 两处都由 `check-guard-parser-integrity.mjs` 的“两处都清洗”判据看着。
//
// 为什么还要 `spawnRegisteredGuard`（P0-1）：守卫经 `corepack yarn run` 起时，
// `.yarnrc.yml` 的插件钩子能在 **yarn 进程内部**改写脚本子进程的环境（清洗已经跑完），
// ⇒ 根守卫不能再经 yarn。包级 check 仍需 yarn（那是真实构建链），那里改用
// `YARN_IGNORE_PATH=1` + 同一份清洗 + 同一套“经 yarn 可信吗”的入口判据。


const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * "会改变语义"的旗标：出现在守卫 argv 里一律拒（R8-D-22 / R11-I1 接线）。
 *
 * 它们都不是"更强的检查"，而是**让守卫什么都不判**：`--list` / `--help` / `--version`
 * 只打印清单或版本，`--dry-run` 只演算不判定，`--allow-advisory` 则是把 advisory 守卫的
 * 失败降级成告警的开关（运行器的用法注释写着"CI 的任何调用都不得带它"）。
 *
 * 定义放在**编排器**里（唯一真源），`check-root-guards.mjs` 的 `guardArgsProblem()` import 它 ——
 * 两个 runner 对"什么算削弱"必须是同一份表。
 */
export const SEMANTICS_CHANGING_FLAGS = [
  '--list',
  '--help',
  '-h',
  '--version',
  '-V',
  '--dry-run',
  '--allow-advisory',
]

/** 根守卫脚本(与构建产物无关,可与阶段 1 并行)。 */
const GUARDS = [
  { name: 'check:layout', args: ['run', 'check:layout'], path: 'package.json / .agents/notes 布局' },
  { name: 'check:workflows', args: ['run', 'check:workflows'], path: '.github/workflows' },
  { name: 'check:ci-scripts', args: ['run', 'check:ci-scripts'], path: 'CI 脚本' },
  // 2026-09-12 二次审查的清单类不变量(P1-4/P1-6/P2-9):
  // 补丁 resolution 键成对完备、补丁在仓库外对 pristine tarball 干净应用、
  // platform-modules 与 CI 归档清单等手工清单互相对拍。
  { name: 'check:patch-resolutions', args: ['run', 'check:patch-resolutions'], path: 'resolutions ↔ patches/' },
  // 2026-09-20 DSH 0.1.6 升级审计 P0 盲区:补丁 resolution 的版本与 upstream.json 的
  // pin 之间此前**零守卫**,而 yarn 对没命中的 resolution 是静默忽略的 ⇒ 漏改一条
  // 就是"补丁消失但三门禁全绿"。本守卫把两者绑在一起。
  { name: 'check:patch-pin', args: ['run', 'check:patch-pin'], path: 'resolutions ↔ upstream.json pin' },
  { name: 'check:patches', args: ['run', 'check:patches'], path: 'patches/*.patch 仓库外 dry-run' },
  { name: 'check:inventories', args: ['run', 'check:inventories'], path: '平台模块表 / CI 归档 / 包表' },
  // 2026-09-16 真机事故(暗色模式看不清)后的守卫:我们插件里的颜色引用必须是上游
  // **真实存在**的主题 token,否则 CSS 会安静地走 fallback、永远不随主题变化。
  { name: 'check:theme-tokens', args: ['run', 'check:theme-tokens'], path: '客户端主题 token 引用' },
  // 2026-09-17 审计 S15-2/5/7/9:GlitchTip 运维核查脚本是**对着生产跑**的只读工具,
  // fail-open(查不出来却 exit 0)/崩溃(exit 1 与"发现缺陷"同码)/远程命令注入/cookie 越域
  // 都只能在本地用假 keys API + 假 ssh 复现 —— 不进门禁就只能等在现场踩。
  { name: 'check:glitchtip', args: ['run', 'check:glitchtip'], path: 'GlitchTip 运维核查脚本' },
  // 2026-09-17 审计复核 S15-1/S15-3/S15-4：编排器自身的"假绿"（算不出改动当没有改动、
  // --only 打错包名筛出空集）与 .gitignore 的 .glitchtip-recon/ 规则此前**没有任何回归网**
  // —— 一次静默回退就能让 check:fast 重新变成 0 任务 + exit 0。用真脚本副本在合成 git
  // 仓库里跑（corepack 走桩），不联网、不跑真实包。
  { name: 'check:check-workspaces', args: ['run', 'check:check-workspaces'], path: '门禁编排器自身(--changed/--only/.gitignore)' },
  // WASM「客户端专属」改造的验收门禁（docs/planning/2026-09-19-wasm-client-only-design.md §13）：
  // 这里只接**便携子集**（静态守卫 / 三方对拍 / 旧模型零残留 / 渠道约束 / HEAD 绑定）——
  // 需要真 PG 的 go test 与需要显示器的协议探针归 server job 与 W6 三平台（§16 W6）。
  //
  // **已转阻塞 @ 2026-09-20**：W4 删除波次落地、零残留扫描在**修好量具后**达到
  // A=0（B=34 ≤ 预算、ANN=65 ≤ 预算；量具修复=词边界假红 R1-L4-2 / 注释单列 ANN
  // R1-L4-3 / B 扩到 appcfg 包 R1-L4-4）。此前它是 advisory（W1–W5 施工期零残留断言
  // 按设计会如实报出存量命中，只告警不拦门禁）—— 那段历史留在 git 历史里，不再回退。
  // 判据：本 guard 失败 ⇒ `yarn check` 整体失败（本地 `yarn check` 与 CI gate job 同义）。
  // 2026-09-20 真实事故：`git add -A` 把某泳道**正在飞的变异体**提交进了基线
  // （`return '0' // A2-L6 变异 M-D` ⇒ 提交是红的）。本仓把变异验证当一等实践，
  // 所以"变异体残留"是结构性风险 —— 只能靠这条守卫，不能靠人眼。
  { name: 'check:no-leftover-mutants', args: ['run', 'check:no-leftover-mutants'], path: '变异体残留（变异验证必须在临时副本或 trap 还原）' },
  // 2026-09-20 实测漂移：`server/docs/06-database.md` / `08-development.md` 写着「迁移 0001–0060」
  // 而实际已到 0076。文档里的迁移区间此前**没有任何守卫**，只能靠人记得改 —— 这条把它变成判据。
  { name: 'check:migration-range', args: ['run', 'check:migration-range'], path: '文档里的迁移区间 ↔ 实际迁移编号' },
  // 2026-09-23 二轮审计 D-4/D-5：官网 FAQ/理念页写着上游 pin `dsh-v0.1.5-rc.2`（真源已是
  // 0.1.6-alpha.2），插件开发页声称平台模块表「与上游逐字一致」却只列了 8/9 项 —— 两处
  // 「文档引用真源数字」此前同样零守卫。这条把它们绑到 `upstream.json` 与
  // `scripts/platform-modules.mjs` 上（扫描器失效/空扫描一律 fail-loud）。
  { name: 'check:doc-claims', args: ['run', 'check:doc-claims'], path: '文档里的上游 pin / 平台模块表 ↔ 真源' },
  // 2026-09-20 补上的那一环：本仓**公开**，「真实客户/部署域名永不出现」这条规则原先只有
  // 人工 `git grep`，而且规则条文自己把真实域名写进了示例 ⇒ 自检永远命中规则本身，等于没有
  // 守卫（历史提交信息里也真的进过客户域名与预发/生产主机名）。白名单式**前向**守卫：
  // URL host / 裸主机名 / URL 里的公网 IP / **提交信息** 四个判据，未登记的 host 一律失败。
  // 守卫自身的合成负例用运行时拼接（不内嵌客户域名），命中输出默认脱敏（CI 日志公开）。
  { name: 'check:no-real-domains', args: ['run', 'check:no-real-domains'], path: '客户/部署域名（文件内容 + 提交信息）' },
  {
    name: 'check:wasm-client-only',
    args: ['run', 'check:wasm-client-only', '--portable'],
    path: 'WASM 客户端专属（残留/对拍/渠道/W5 文档/HEAD 绑定）；PG 与探针见 §16 W6',
  },
  // 2026-09-23 二轮审计 W3-02/W3-03/W3-04：`integration-tests/` 的两个用例脚本打的是
  // 真实 IdP + 真实服务端（需 Docker/Xvfb），**不进 CI** ⇒ 整块脱离门禁，长期腐烂到
  // "永远不可能通过"也没人发现（深链断言结构上不可达、断言 2026-09-10 已删除的旧 brand
  // 契约、用伪造 cookie 的恒真"非 200"断言）。本守卫把可静态执行的那部分接进来：
  // python 语法、`--self-test` 判据夹具（每条判据都配负例）、以及**进程内假网关**驱动的
  // 正/反例（按真契约应答必须绿 / 破坏契约必须红 / provider 未配置必须 SKIP 且不得报 PASS）。
  { name: 'check:integration-tests', args: ['run', 'check:integration-tests'], path: 'integration-tests/**（语法/判据自检/假网关正反例）' },
  // 2026-09-24 第十轮审计 C-06（P2，F1 泳道新增守卫；编排器侧登记由 F2 泳道同步）：
  // 第九轮把「守卫 → argv → 脚本路径」三者绑在一条链上，但**脚本内容本身仍无判据** ——
  // 把某个守卫的脚本内容掏空（`process.exit(0)`）或换成同名符号链接之后，
  // `check-root-guards.mjs` 照报 `✓ <名字>`（审计在副本里实测：`check:theme-tokens`
  // 从 ✗ 翻成 ✓，两条门禁都看不出区别）。这条守卫把「文件内容」也变成判据：
  // 它读 `check-root-guards.mjs` 的 `REGISTERED_GUARD_ENTRIES`（每条守卫带一个
  // `digest` = 脚本 sha256）并复算真实脚本对拍，第二判据在
  // `scripts/verify-check-workspaces.mjs`（独立复算 + 符号链接断言）。
  { name: 'check:guard-parser-integrity', args: ['run', 'check:guard-parser-integrity'], path: '守卫脚本内容摘要（sha256）↔ 登记表' },
]

/**
 * `advisory` 的**登记制**（2026-09-23 第六轮审计 R6-C-1）。
 *
 * 现场：`advisory: true` 曾是一个**无任何判据**的红→绿开关 —— 给上面 `GUARDS` 表的任一条目
 * 加上这一个词，`yarn check`（= 必需的 `Gate` 检查）与 `scripts/check-root-guards.mjs`
 * （docs-only 的 PR 唯一防线）就都不再因它失败，而 `MINIMUM_REQUIRED_GUARDS` 只断言
 * "这个守卫在表里"。铁律 0 的域名守卫、迁移区间守卫、文档数字守卫、变异体残留守卫
 * 全都挂在这张表上 ⇒ 一行改动即可让它们集体变成"只告警、不拦门禁"，而 CI 全绿。
 *
 * 现在：`advisory` 只能标在**这里逐条登记过**的守卫上，未登记的 advisory 在调度前
 * fail-loud（见 `validateAdvisoryRegistry`）—— advisory 是"经过审批的临时豁免"，
 * 不是"谁都能按一下的静音键"。反方向同样红：登记项对应的守卫不再 advisory（陈旧登记）
 * 或根本不在表里，也必须一起改掉。
 *
 * 登记项形状：`{ name, reason, approvedBy, expiresOn }`
 *   · `reason`     为什么这条守卫可以在施工期不拦门禁；
 *   · `approvedBy` 谁批的（人/角色 —— 进 diff 才会被评审看见）；
 *   · `expiresOn`  `YYYY-MM-DD`（含当天仍有效）—— 豁免必须到期复核，不能永久挂着。
 *
 * **当前为空**：没有任何守卫需要 advisory。历史上唯一的用途是 WASM「客户端专属」验收
 * 门禁（W1–W5 施工期按设计恒红），它自 2026-09-20 起已转阻塞。
 */
const ADVISORY_REGISTRY = []

/**
 * advisory 到期日必须是**真实日历日**（第六轮独立复审 V2 边界②）。
 *
 * 现场：`expiresOn` 此前只被要求"是字符串"，到期比较写成
 * `if (!Number.isNaN(Date.parse(entry.expiresOn ?? '')) && …)` —— 于是**不可解析**的
 * 取值被静默跳过：登记项写 `expiresOn: 'whenever'` 就能让"到期即失效"这条语义永不生效。
 * 实测两条通道都 EXIT=0（`check-workspaces --list` / `check-root-guards --list`）。
 * 这是 R6-C-1 的同一个病：判据看起来在，实际缺一颗牙。
 *
 * 三档一起判（缺任一条都能被绕过）：
 *   ① 形状 `^\d{4}-\d{2}-\d{2}$` —— 挡 `'whenever'`、`'2026-1-1'`、`'2026/10/31'`；
 *   ② `Date.parse` 不是 NaN —— 挡 `'2026-13-45'` 这类越界取值；
 *   ③ UTC 往返逐字回读相等 —— 挡 `'2026-02-31'` 这类"形状合法、但不是那一天"的取值
 *      （Node 的 ISO 解析**会把它滚到 3 月 3 日**：实测
 *      `Date.parse('2026-02-31T00:00:00Z')` ⇒ `2026-03-03T00:00:00.000Z`）。
 *      ③ 判的是日期本身的性质，不是运行时的宽容度。
 *
 * 取向与其它登记字段同档：**非法值不是"没有判据"，而是配置错误 ⇒ fail-loud**。
 * @param value - 登记项上的 `expiresOn`（已归一化成字符串，可能是空串）。
 * @returns 是不是一个可比较的真实日历日。
 */
function isAdvisoryExpiresOn(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed)) return false
  return new Date(parsed).toISOString().slice(0, 10) === value
}

/**
 * 校验 advisory 登记（**双向**）：未登记的 advisory / 陈旧登记 / 缺字段 / 到期日非法 /
 * 已过期一律返回错误清单，调用方据此拒绝调度。
 *
 * 为什么不做成"未登记就降级成阻塞"：那会把配置错误伪装成正常门禁，红点从"配置非法"
 * 漂移成"某条判据失败"，排查成本全落到下一个人身上。配置错误必须报成配置错误。
 *
 * @param guards - `GUARDS` 表（或它的副本）。
 * @param registry - 登记表（测试可注入）。
 * @param today - `YYYY-MM-DD` 口径的"今天"（测试可注入）。
 * @returns 错误信息数组（空 = 合格）。
 */
export function validateAdvisoryRegistry(guards, registry = ADVISORY_REGISTRY, today = new Date()) {
  const errors = []
  const advisories = guards.filter(guard => guard.advisory === true).map(guard => guard.name)
  const registered = registry.map(entry => entry?.name)
  const todayKey = today.toISOString().slice(0, 10)
  for (const name of advisories) {
    if (!registered.includes(name)) {
      errors.push(`守卫 \`${name}\` 被标成 advisory，但它不在 ADVISORY_REGISTRY 里`
        + ' ⇒ advisory 是无判据的红→绿开关（R6-C-1），必须先登记理由/批准人/到期日再标。'
        + '若这条守卫本来就该拦门禁，请删掉条目上的 `advisory: true`。')
    }
  }
  for (const entry of registry) {
    const name = entry?.name
    if (typeof name !== 'string' || name === '') {
      errors.push(`ADVISORY_REGISTRY 有登记项缺 \`name\`：${JSON.stringify(entry)}`)
      continue
    }
    for (const field of ['reason', 'approvedBy', 'expiresOn']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        errors.push(`ADVISORY_REGISTRY 的 \`${name}\` 缺 \`${field}\`（advisory 必须可追溯、可到期复核）`)
      }
    }
    const expiresOn = typeof entry.expiresOn === 'string' ? entry.expiresOn.trim() : ''
    if (expiresOn !== '' && !isAdvisoryExpiresOn(expiresOn)) {
      // 只判"有没有"会让一个乱字符串把"到期即失效"整条语义绕过去（第六轮复审 V2 边界②）。
      errors.push(`ADVISORY_REGISTRY 的 \`${name}\` 的 \`expiresOn\`（${JSON.stringify(entry.expiresOn)}）`
        + '不是 `YYYY-MM-DD` 形式的真实日期'
        + ' ⇒ 到期判据（`expiresOn < 今天`）对不可解析的取值**静默不成立**，豁免会变成"永不过期"。'
        + ' 请写成真实日历日（例：`2026-10-31`）；不确定就给一个**更早**的日期 ——'
        + ' 到期即失效、续期要重新进 diff，这正是这条登记制的全部意义。')
    } else if (expiresOn !== '' && expiresOn < todayKey) {
      errors.push(`ADVISORY_REGISTRY 的 \`${name}\` 已于 ${expiresOn} 到期（今天 ${todayKey}）`
        + ' ⇒ 到期即失效：要么再次登记并写明续期理由，要么把它转回阻塞。')
    }
    if (!advisories.includes(name)) {
      errors.push(`ADVISORY_REGISTRY 里的 \`${name}\` 并不是 advisory 守卫`
        + `（GUARDS 表里${guards.some(guard => guard.name === name) ? '该条目没有 `advisory: true`' : '根本没有这个守卫'}）`
        + ' ⇒ 陈旧登记同样是配置错误（留下它 = 给下一个人一个可以随时按亮的静音键）。')
    }
  }
  return errors
}

/**
 * workspace 包门禁。`needs` 表达"构建期真实依赖":依赖包的 tsdown 会先清空自己的
 * lib/(enterprise clean:true),并发读取其声明文件的包会在那个窗口里报
 * TS7016「Could not find a declaration file」——所以构建依赖必须串起来,不能
 * 只按"能不能同时跑"来排。
 *
 * 依赖来源(2026-09-10 用 git/grep 实测):
 *   enterprise / connectors / cron 的 tsc 读 desktop 的 lib/types;
 *   account-card 读 enterprise 的 lib/types;browser 读 connectors 的 lib/types;
 *   branding / community-fabric 无本地构建依赖。
 * desktop 之外的 devDeps 边(desktop → 六个插件包)是**运行时/profile 依赖**,
 * 由 verify:profile 内部的 prebuild 保证,不作为调度边——否则 desktop ↔ enterprise
 * 成环,且会让 desktop 的 profile 冒烟与那些包的构建互相踩。
 */
const PACKAGES = [
  // 2026-09-20：desktop 的 Electron 引导（`main.ts`）与 App AI 执行面
  // （`app-ai-runner.ts`）**构建期** import 该插件包（协议注册 / 真机适配器 /
  // 安装密钥仓库 / runner 接线）—— 而 desktop 的 tsdown 会把 `@picoaide/*` 内联
  // （`noExternal` 只放行 `@deepseek-ai/*`+react），所以它的 `lib/` 必须先产出。
  // 同日（构建环修复，路线 A）：`src/host-locale.ts` / `src/desktop-home.ts` 改成
  // 两个叶子包的一行 re-export，它的 tsc 因此还读它们的 lib/types ⇒ 那两条边也显式
  // 登记（传递上已由 wasm-apps-host → browser → connectors → 叶子包保证，但真实边
  // 就该写在表里 —— `temp/wasm-client-only/cycle-check.mjs` 会逐条对拍）。
  { name: 'dsh-plugin-desktop', dir: 'packages/host/desktop', needs: ['@picoaide/dsh-wasm-apps-host', '@picoaide/dsh-host-locale', '@picoaide/dsh-host-home'] },
  // 2026-09-23：`loopback.ts` 四份合一（实现落在叶子包 `./loopback` 子路径）后，
  // enterprise / cron 也**直接**读叶子包（不再是"经 desktop 的两条 re-export"）。
  // 两条真实边写进表里 —— `temp/wasm-client-only/cycle-check.mjs` 会逐条对拍。
  { name: '@picoaide/dsh-enterprise', dir: 'packages/host/enterprise', needs: ['dsh-plugin-desktop', '@picoaide/dsh-host-locale', '@picoaide/dsh-panel-surface', '@picoaide/dsh-foot-menu'] },
  // 2026-09-20（路线 A / A 扩展）：`host-copy.ts` 的语言解析直接 import 叶子包
  // `@picoaide/dsh-host-locale`；`user-scope.ts` 的 DSH-home 权威改成
  // `@picoaide/dsh-host-home` ⇒ **connectors 不再 import 桌面包**，
  // 那条 `connectors → dsh-plugin-desktop` 边随之删除（它正是四边环的最后一段）。
  { name: '@picoaide/dsh-connectors', dir: 'packages/host/connectors', needs: ['@picoaide/dsh-host-home', '@picoaide/dsh-host-locale', '@picoaide/dsh-panel-surface', '@picoaide/dsh-foot-menu'] },
  { name: '@picoaide/dsh-cron', dir: 'packages/host/cron', needs: ['dsh-plugin-desktop', '@picoaide/dsh-host-locale', '@picoaide/dsh-panel-surface', '@picoaide/dsh-foot-menu'] },
  { name: '@picoaide/dsh-branding', dir: 'packages/client/branding', needs: [] },
  { name: 'dsh-community-fabric', dir: 'community/fabric', needs: [] },
  // 2026-09-23：账户浮层的 Esc 分层回归（`panel-esc.spec.tsx`）**挂真的装载器**
  // （不是在测试里另写一份"遇到模态就让位"的替身：这条缺陷的全部机制就在装载器认不认
  // 这层模态上）⇒ 该用例 import `@picoaide/dsh-panel-surface/client`，于是多了一条
  // 真实构建边（测试读它的 lib）。`temp/wasm-client-only/cycle-check.mjs` 会逐条对拍。
  { name: '@picoaide/dsh-account-card', dir: 'packages/client/account-card', needs: ['@picoaide/dsh-enterprise', '@picoaide/dsh-panel-surface'] },
  // WASM 应用平台的客户端半边（应用中心 + 发布编排入口）：读 enterprise 的 lib/types。
  { name: '@picoaide/dsh-wasm-apps', dir: 'packages/client/wasm-apps', needs: ['@picoaide/dsh-panel-surface', '@picoaide/dsh-foot-menu'] },
  // 四个客户端面板共用的**中列整页装载器 + 视觉语言**叶子包（2026-09-20）：
  // 它刻意没有任何 `@picoaide/*` 依赖（React 是 peer）⇒ needs 恒空，可以被任何包
  // 先构建；四条出边（enterprise / cron / connectors / wasm-apps）都指向这个没有
  // 出边的节点，故不会引入新的构建环。消费方把它**内联**进 client bundle
  // （不进 tsdown 的 external），因此它不持有任何跨插件共享的可变状态。
  { name: '@picoaide/dsh-panel-surface', dir: 'packages/client/panel-surface', needs: [] },
  // 侧边栏底部**并道行**（2026-09-21）：一个「更多」行 + 向上浮层，条目经客户端
  // Cordis 服务 `picoFootMenu` 从五个面板插件收集。它读 panel-surface 的
  // `activePanelId` / `PANEL_ACTIVE_ATTR`（内联进自己的 client bundle）⇒ 必须排在
  // panel-surface 之后；五个消费方的 tsc 又读它的 `./client` 声明（type-only）⇒
  // 排在它之后。方向单一，故不引入新的构建环。
  { name: '@picoaide/dsh-foot-menu', dir: 'packages/client/foot-menu', needs: ['@picoaide/dsh-panel-surface'] },
  // 宿主侧语言的**零依赖叶子包**（2026-09-20，构建环修复路线 A）：实现自
  // `packages/host/desktop/src/host-locale.ts` 逐字迁入（导出面与语义一字不改）。
  // 它刻意**没有任何 dependencies**（连 `@picoaide/*` 也没有）⇒ needs 恒空，可以被
  // 任何包先构建。断环手段就是这一条：让环上的最后一跳指向一个没有出边的节点。
  // desktop 保留 `./host-locale` 子路径作为 re-export（对外 API 面不变）。
  { name: '@picoaide/dsh-host-locale', dir: 'packages/host/host-locale', needs: [] },
  // 宿主侧**产品数据根**的第二个零依赖叶子包（2026-09-20，路线 A 扩展）：实现自
  // `packages/host/desktop/src/desktop-home.ts` 逐字迁入（只 import `node:os`/
  // `node:path`，与 host-locale 完全同形）。抽它的目的就是删掉
  // `connectors → dsh-plugin-desktop/desktop-home` 那条边 —— 该边与
  // `desktop → wasm-apps-host → browser → connectors` 一起构成四边环。
  // desktop 保留 `./desktop-home` 子路径作为 re-export（对外 API 面不变）。
  { name: '@picoaide/dsh-host-home', dir: 'packages/host/host-home', needs: [] },
  // browser 的两条真实构建边（都实测过，别再凭"看起来是运行期惰性解析"删边）：
  //   1. `@picoaide/dsh-host-locale` —— 5 个文件 import 它（原先是
  //      `dsh-plugin-desktop/host-locale`，那条边正是
  //      `desktop → wasm-apps-host → browser → desktop` 这个真实环的最后一跳）；
  //   2. `@picoaide/dsh-connectors` —— 2026-09-20 曾被当"虚假边"删掉（依据是
  //      `tsdown.config.ts` 把它列为 external + `src/index.ts` 用 `createRequire`
  //      运行期惰性解析）。**那个判断只对"值"成立**：`tsc` 必须读到 connectors 的
  //      lib/types（`src/index.ts:175/190/402` 的 `as typeof import('@picoaide/dsh-connectors/…')`），
  //      `tests/credential-site.spec.ts` 还值导入真实 `ConnectorStore`。干净态实测：
  //      删掉 connectors/lib 后 browser 的 tsc 报 3 条 TS2307 ⇒ 真实边，删掉它就会
  //      "调度器排得下、实际跑不通"（本地有 lib 时全绿，CI 干净检出必红）。
  { name: '@picoaide/dsh-browser', dir: 'packages/host/browser', needs: ['@picoaide/dsh-host-locale', '@picoaide/dsh-connectors', '@picoaide/dsh-foot-menu'] },
  // 客户端专属 WASM 应用 origin（`picoaide-app://` 协议 handler + 本机打开路由）：
  // 2026-09-19 起它经 **browser 包导出的 surface seam**（`@picoaide/dsh-browser/surface`）
  // 取得视图/分区/CDP 能力（设计总纲 §16.1 的 surface 抽象：工具实现只写一份、按 surface
  // 分派）⇒ 构建期依赖 browser 的 lib/types，必须先于它产出。
  // 2026-09-24（R13）：`src/session.ts` 的会话订阅收口到零依赖叶子包
  // `@picoaide/dsh-host-locale/session-events` ⇒ 真实构建边多一条（叶子包无出边，
  // 不会引入新的环；`temp/wasm-client-only/cycle-check.mjs` 会逐条对拍）。
  { name: '@picoaide/dsh-wasm-apps-host', dir: 'packages/host/wasm-apps-host', needs: ['@picoaide/dsh-browser', '@picoaide/dsh-host-locale'] },
  // 2026-09-16:vendored 第三方插件(随三平台安装包分发)的测试此前**不在任何门禁
  // 链里**(verify-inventories 的 CHECK_CHAIN_EXEMPTIONS 显式豁免),本地加固
  // (同源守卫/符号链接写落点断言/失败软着陆)只有"手工跑"这一条保证 —— 升级
  // 上游时一次静默回归就能进产物。这里以 `script: 'test'` 接进来:该包没有
  // build 步骤(lib/ 入库,构建依赖 ~/.dsh/source 的 esbuild),也无构建期依赖,
  // 故 firstWave(与 desktop check、根守卫并发)且不被任何包依赖。
  {
    name: 'dsh-memory-evolve',
    dir: 'packages/vendor/memory-evolve',
    needs: [],
    script: 'test',
    firstWave: true,
  },
]

/**
 * 路径前缀 → 包名(用于 --changed 的改动归属判定)。
 *
 * **匹配语义 = 先声明者胜**(不是"最长前缀优先"):`selectByChanges` 用
 * `PATH_OWNERS.find(([prefix]) => file.startsWith(prefix))` —— `Array.prototype.find`
 * 返回**数组序第一个**命中的条目,与前缀长度无关。
 *
 * 由此推出两条对这张表的要求(2026-09-23 复审 F2,实测过隔离仓库里的顺序翻转):
 *   - **同一路径写两条前缀、后者永不生效**(重复前缀已由自检单独报);
 *   - 一条前缀若是另一条的**严格子路径**且归属不同包,归属结果就**取决于声明顺序**:
 *     窄前缀声明在后 ⇒ 它永远不会命中(名存实亡);声明在前 ⇒ 该子树归窄前缀的包、
 *     其余仍归宽前缀的包(同一个包按目录被劈成两个归属)。
 *     这种歧义由 {@link scheduleTableProblems} 直接判红,**不允许靠顺序约定**。
 *   - 归属相同包的细粒度前缀(如 `packages/host/desktop/` + `packages/host/desktop/src/`)
 *     没有歧义:两条命中结果相同 ⇒ 允许。
 *
 * 改这张表前先看 {@link scheduleTableProblems}:它会把上面两类形态在跑任何任务之前判红。
 */
const PATH_OWNERS = [
  ['packages/host/desktop/', 'dsh-plugin-desktop'],
  ['packages/host/enterprise/', '@picoaide/dsh-enterprise'],
  ['packages/client/account-card/', '@picoaide/dsh-account-card'],
  ['packages/client/wasm-apps/', '@picoaide/dsh-wasm-apps'],
  ['packages/client/branding/', '@picoaide/dsh-branding'],
  ['packages/client/panel-surface/', '@picoaide/dsh-panel-surface'],
  ['packages/client/foot-menu/', '@picoaide/dsh-foot-menu'],
  ['packages/host/connectors/', '@picoaide/dsh-connectors'],
  ['packages/host/host-locale/', '@picoaide/dsh-host-locale'],
  ['packages/host/host-home/', '@picoaide/dsh-host-home'],
  ['packages/host/browser/', '@picoaide/dsh-browser'],
  ['packages/host/wasm-apps-host/', '@picoaide/dsh-wasm-apps-host'],
  ['packages/host/cron/', '@picoaide/dsh-cron'],
  ['packages/vendor/memory-evolve/', 'dsh-memory-evolve'],
  ['community/fabric/', 'dsh-community-fabric'],
]

/**
 * 反向依赖:A 改动会波及 B(desktop 的类型/产物是这些包的输入)。
 *
 * **不变量（2026-09-24 第十轮审计 C-11/F7 起由 {@link scheduleTableProblems} 强制）**：
 * 对 `PACKAGES` 里的每一条 `needs` 边 `A → B`，本字典的 `DEPENDENTS[B]` **必须**含 `A`。
 * 反方向（本字典里多出来的条目）是**允许**的：`--changed` 只按本表展开**一层**，
 * 所以"两跳的消费者"（例如 host-locale 的 consumer 的 consumer）要显式列全
 * —— 宁可多跑几个包，也不能漏跑。
 *
 * 脱钩的后果是静默的：改 `A` 不会重跑 `B`，而 `check:fast` 的语义正是"跑受影响的包"，
 * 于是类型/产物级破坏在 fast 路径上漏检（**同一个改动**在 `yarn check` 上是红的）。
 */
const DEPENDENTS = {
  // 2026-09-24 C-11：`dsh-cron` 的 needs 里有 desktop（它的 tsc 读 desktop 的
  // lib/types，见 PACKAGES 头注释），反向表里此前**没有它** ⇒ 改 desktop 不重跑 cron。
  'dsh-plugin-desktop': ['@picoaide/dsh-enterprise', '@picoaide/dsh-account-card', '@picoaide/dsh-branding', '@picoaide/dsh-cron'],
  // 2026-09-24 C-11：desktop 的 needs 里有 wasm-apps-host（构建期 import 它）——
  // 反向条目此前整条缺失 ⇒ 改 wasm-apps-host 不重跑 desktop，而 desktop 的
  // `lib/` 会把该包内联进产物（真正受影响的那个包反而被漏掉）。
  '@picoaide/dsh-wasm-apps-host': ['dsh-plugin-desktop'],
  // 2026-09-24 C-11：browser 的 needs 里有 connectors（browser 的 tsc 读它的
  // lib/types，见 PACKAGES 里 browser 那条的两条真实边）—— 反向条目此前整条缺失。
  '@picoaide/dsh-connectors': ['@picoaide/dsh-browser'],
  // 2026-09-24 C-11：wasm-apps-host 的 needs 里有 browser（它经 browser 导出的
  // surface seam 取视图/CDP 能力）—— 反向条目此前整条缺失。
  '@picoaide/dsh-browser': ['@picoaide/dsh-wasm-apps-host'],
  // 2026-09-24 C-11：account-card 的 needs 里有 enterprise（读它的 lib/types）——
  // 反向条目此前整条缺失。
  '@picoaide/dsh-enterprise': ['@picoaide/dsh-account-card'],
  // 叶子包是 browser / connectors / desktop 的构建输入，而 desktop 的
  // `lib/types/{host-locale,desktop-home}.d.ts` 又是 enterprise / cron 的输入 ⇒
  // `--changed` 只展开一层，所以这里把两跳的消费者也列全（宁可多跑几个包）。
  '@picoaide/dsh-host-locale': [
    '@picoaide/dsh-browser',
    '@picoaide/dsh-wasm-apps-host',
    '@picoaide/dsh-connectors',
    'dsh-plugin-desktop',
    '@picoaide/dsh-enterprise',
    '@picoaide/dsh-cron',
  ],
  '@picoaide/dsh-host-home': [
    '@picoaide/dsh-connectors',
    'dsh-plugin-desktop',
    '@picoaide/dsh-enterprise',
    '@picoaide/dsh-cron',
  ],
  // 面板叶子包的消费方直接依赖它（都是**一跳**，不需要像 host-locale 那样
  // 展开两跳：没有第二层包再 import 它）。2026-09-21 起 foot-menu 也读它的
  // `activePanelId` / `PANEL_ACTIVE_ATTR`（内联），而 foot-menu 的五个消费方
  // 是本字典里自己的那条（两跳由下面那条展开）。
  '@picoaide/dsh-panel-surface': [
    '@picoaide/dsh-enterprise',
    '@picoaide/dsh-connectors',
    '@picoaide/dsh-cron',
    '@picoaide/dsh-wasm-apps',
    // 2026-09-23：account-card 的 Esc 分层回归挂真的装载器 ⇒ 它也算消费方。
    '@picoaide/dsh-account-card',
    '@picoaide/dsh-foot-menu',
  ],
  // 底部并道行：五个面板插件的 tsc 读它的 `./client` 声明（type-only），
  // desktop 的 profile 组装期解析它的 `cordis.patch.yml`（打包产物也要重建）。
  '@picoaide/dsh-foot-menu': [
    '@picoaide/dsh-enterprise',
    '@picoaide/dsh-connectors',
    '@picoaide/dsh-browser',
    '@picoaide/dsh-cron',
    '@picoaide/dsh-wasm-apps',
    'dsh-plugin-desktop',
  ],
}

/**
 * 在 `needs` 图里找一个环(返回环上的包名序列,首尾同名;无环返回 null)。
 *
 * 只沿"表内存在的名字"走边:不存在的名字由 {@link scheduleTableProblems} 单独报,
 * 否则成环报告会被一串"未知依赖"淹没。
 * @param byName - 包名 → 条目。
 * @returns 环路径或 null。
 */
function findScheduleCycle(byName) {
  const visiting = new Set()
  const settled = new Set()
  const path = []
  let found = null
  const visit = name => {
    if (found !== null || settled.has(name)) return
    if (visiting.has(name)) {
      found = [...path.slice(path.indexOf(name)), name]
      return
    }
    visiting.add(name)
    path.push(name)
    for (const need of byName.get(name)?.needs ?? []) {
      if (byName.has(need)) visit(need)
      if (found !== null) break
    }
    path.pop()
    visiting.delete(name)
    settled.add(name)
  }
  for (const name of byName.keys()) visit(name)
  return found
}

/**
 * 调度表 / 归属表自检（2026-09-23 三轮审计 R3-C C-1/C-2）。
 *
 * 为什么必须在**编排器自己**里做：这三张表是手写的，而名字打错时的失败形态**全是静默的** ——
 *
 *   1. `needs` 里一个不存在的名字：`needs.filter(name => selectedSet.has(name))` 对
 *      "名字不存在"与"没被选中"给出同一结果 ⇒ **边被静默删掉**，调度顺序退化
 *      （本地有 `lib/` 时照绿，干净检出才报 TS2307）；
 *   2. `needs` 成环：环上的包永远停在 `pending`，主循环以 `running.size === 0 &&
 *      !progressed` 退出 ⇒ 这些包**既不跑、也不进 skipped**（runScheduler 末端的
 *      dropped 断言是第二道网）；
 *   3. `PATH_OWNERS` 前缀/包名打错：`check:fast` 把改动判成"0 个包"并 EXIT=0；
 *   4. `DEPENDENTS` 键/值打错：`--changed` 的反向展开静默少跑；
 *   5. `needs ↔ DEPENDENTS` 脱钩（2026-09-24 第十轮审计 C-11/F7）：同一条真实构建边
 *      只在其中一张表里 ⇒ 改依赖方不重跑消费方（fast 路径静默漏跑，全量门禁才是红的）。
 *
 * 判据**不依赖任何具体包名**（名字全部从表里现读、再互相对拍）⇒ 新增包自动被覆盖。
 * @returns 问题描述列表（空 = 通过）。
 */
function scheduleTableProblems() {
  const problems = []
  const byName = new Map()
  for (const pkg of PACKAGES) {
    if (byName.has(pkg.name)) problems.push(`PACKAGES 里有重复的包名:${JSON.stringify(pkg.name)}`)
    byName.set(pkg.name, pkg)
  }
  for (const pkg of PACKAGES) {
    for (const need of pkg.needs ?? []) {
      if (!byName.has(need)) {
        problems.push(`${pkg.name}: needs 里的 ${JSON.stringify(need)} 不在 PACKAGES 表内（这条构建边会被静默丢弃）`)
      }
    }
  }
  const cycle = findScheduleCycle(byName)
  if (cycle !== null) {
    problems.push(`needs 成环:${cycle.join(' → ')}（环上的包永远不会被调度，见 runScheduler 的 dropped 断言）`)
  }
  const prefixes = new Set()
  for (const [prefix, name] of PATH_OWNERS) {
    if (!byName.has(name)) {
      problems.push(`PATH_OWNERS 的 ${JSON.stringify(prefix)} 指向不存在的包 ${JSON.stringify(name)}`)
    }
    if (prefixes.has(prefix)) problems.push(`PATH_OWNERS 里有重复前缀:${JSON.stringify(prefix)}（先声明者胜 ⇒ 后者永不生效）`)
    prefixes.add(prefix)
    // 前缀必须落在某个真实包目录之下：否则它永远匹配不到文件（打错前缀的形态）。
    const inside = PACKAGES.some(pkg => prefix === `${pkg.dir}/` || prefix.startsWith(`${pkg.dir}/`))
    if (!inside) {
      problems.push(`PATH_OWNERS 的前缀 ${JSON.stringify(prefix)} 不在任何 PACKAGES 的 dir 之下（改动会归属不到包）`)
    }
  }
  // 前缀歧义：一条前缀是另一条的**严格子路径**、且两条归属**不同包**（2026-09-23 复审 F2）。
  //
  // 为什么判红而不是"按最长的赢"：匹配语义是**先声明者胜**（`find` 取数组序首个，见
  // PATH_OWNERS 头注释）。隔离仓库实测（复审 §2-F2 证据 B）：把
  // `['packages/client/branding/src/', '<另一个包>']` 加在表**末尾** ⇒ 该条目永不生效
  // （`check:fast` 仍判 `@picoaide/dsh-branding`）；加在表**最前** ⇒ 同一批改动判给
  // 另一个包。也就是说"谁是归属方"取决于书写顺序，且两种写法都静默 —— 正是本仓
  // 反复踩到的那类失败形态（名字打错/静默不生效）。所以**这类声明不允许存在**。
  //
  // 边界：归属**相同包**的细粒度前缀不算歧义（两条命中结果相同），例如
  // `packages/host/desktop/` + `packages/host/desktop/src/` 是允许的。
  for (const [narrow, narrowOwner] of PATH_OWNERS) {
    for (const [wide, wideOwner] of PATH_OWNERS) {
      if (narrow === wide || narrowOwner === wideOwner) continue
      if (!narrow.startsWith(wide)) continue // 只查严格子路径
      problems.push(`PATH_OWNERS 前缀歧义：${JSON.stringify(narrow)}（归属 ${JSON.stringify(narrowOwner)}）`
        + ` 是 ${JSON.stringify(wide)}（归属 ${JSON.stringify(wideOwner)}）的严格子路径，而两条归属不同包`
        + ' —— 匹配语义是**先声明者胜**：窄前缀声明在后 ⇒ 它永不生效；声明在前 ⇒ 按声明顺序翻转归属'
        + '（同一棵树里的文件被劈给两个包）。处置：删掉窄前缀、或让它与宽前缀归属同一个包；'
        + '确实要拆给不同的包，就把宽前缀也一并拆细（让两条互不包含）')
    }
  }
  for (const pkg of PACKAGES) {
    const expected = `${pkg.dir}/`
    // 每个包的**根目录前缀**必须恰好有一条归属条目（可以再有更细的子目录条目）。
    // 这条判据同时挡住两个方向的打错：把 `.../connectors/` 打成 `.../connector/`
    // （不在任何 dir 之下 ⇒ 上面那条报），以及打成 `.../connectors/x`（前缀"看起来"更细、
    // 于是永远匹配不到该包根下的文件 ⇒ 这里报"没有覆盖根目录的条目"）。
    if (!PATH_OWNERS.some(([prefix, name]) => name === pkg.name && prefix === expected)) {
      const declared = PATH_OWNERS.filter(([, name]) => name === pkg.name).map(([prefix]) => JSON.stringify(prefix))
      problems.push(`${pkg.name}: PATH_OWNERS 里没有 ${JSON.stringify(expected)} 这条根前缀`
        + `（它现在的条目:${declared.length > 0 ? declared.join(', ') : '无'}）—— --changed 会把它根下的改动判成 0 个包`)
    }
  }
  for (const [name, dependents] of Object.entries(DEPENDENTS)) {
    if (!byName.has(name)) problems.push(`DEPENDENTS 的键 ${JSON.stringify(name)} 不在 PACKAGES 表内`)
    for (const dependent of dependents) {
      if (!byName.has(dependent)) {
        problems.push(`DEPENDENTS[${JSON.stringify(name)}] 里的 ${JSON.stringify(dependent)} 不在 PACKAGES 表内`)
      }
    }
  }
  // needs ↔ DEPENDENTS **双向一致**（2026-09-24 第十轮审计 C-11/F7）。
  //
  // 现场：两张表各自手写、互不校验，实测四处脱钩（`dsh-cron → dsh-plugin-desktop` 的
  // 反向条目缺失、`connectors`/`browser`/`wasm-apps-host` 三条反向键整条不存在）⇒
  // `--changed` 的反向展开少跑包，而 `check:fast` 的语义就是"跑受影响的包"。
  //
  // 判据只做集合对拍（名字全部从表里现读）⇒ 新增包/新增边自动被覆盖；**单边改表即红**。
  // 反向多出来的条目**不判红**：`--changed` 只展开一层，两跳消费者必须显式列全
  // （见 DEPENDENTS 头注释），"多跑"是安全方向。
  for (const pkg of PACKAGES) {
    for (const need of pkg.needs ?? []) {
      const dependents = DEPENDENTS[need]
      if (dependents === undefined) {
        problems.push(`DEPENDENTS 里没有 ${JSON.stringify(need)} 这条键，而 ${JSON.stringify(pkg.name)} 的 needs 里有它`
          + ' ⇒ 改依赖方不会重跑消费方（反向表半张 ⇒ check:fast 静默漏跑该包）')
      } else if (!dependents.includes(pkg.name)) {
        problems.push(`DEPENDENTS[${JSON.stringify(need)}] 里没有 ${JSON.stringify(pkg.name)}，`
          + `而 ${JSON.stringify(pkg.name)} 的 needs 里声明了它 ⇒ 同一条真实构建边在两张表里不一致`
          + `（改 ${need} 不会重跑 ${pkg.name}；请补进 DEPENDENTS，或删掉这条 needs 边）`)
      }
    }
  }
  return problems
}

/** 影响全仓的顶层文件(改动即视为全量门禁)。 */
const GLOBAL_PREFIXES = [
  'package.json', 'yarn.lock', '.yarnrc.yml', 'patches/', 'scripts/', '.github/',
  'brands/', 'tsconfig', 'deepseek-harness', 'AGENTS.md', 'CLAUDE.md',
  // upstream.json is an input of check:layout (submodule URL/commit/version):
  // without it a pin-only change selected zero packages and the early exit
  // skipped every root guard — a false-green fast gate.
  'upstream.json',
]

function parseArgs(argv) {
  const options = { changed: null, only: null, list: false, concurrency: null, guards: true, help: false, fullOutput: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--changed') {
      // 可选参数:下一个 token 不是 -- 开头就当 ref
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options.changed = next
        i += 1
      } else options.changed = 'HEAD'
    } else if (arg === '--only') {
      // 与 --changed 同款:下一个 token 以 `--` 开头说明值缺失,报用法错误
      // 而不是把 `--no-guards` 当成包名(2026-09-17 审计 S15-4 附带)。
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        console.error('check-workspaces: --only 需要一个包名列表(逗号分隔)')
        process.exitCode = 2
        return null
      }
      options.only = next.split(',').map(s => s.trim()).filter(Boolean)
      i += 1
    } else if (arg === '--concurrency') {
      // A non-numeric value used to reach `Math.min(NaN, …)` → zero workers, so
      // the first wave (every root guard + the desktop check) silently ran
      // NOTHING and the gate still exited 0 — a false green (2026-09-16 R9
      // audit). Reject it like any other bad argument.
      const value = Number(argv[i + 1])
      if (!Number.isSafeInteger(value) || value <= 0) {
        console.error(`check-workspaces: --concurrency 需要正整数,收到 ${JSON.stringify(argv[i + 1])}`)
        process.exitCode = 2
        return null
      }
      options.concurrency = value
      i += 1
    } else if (arg === '--list') options.list = true
    else if (arg === '--no-guards') options.guards = false
    else if (arg === '--full-output') options.fullOutput = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      console.error(`check-workspaces: 未知参数 ${arg}`)
      process.exitCode = 2
      return null
    }
  }
  return options
}

/**
 * 「判定行（verdict line）扫描 + 有界输出」的**唯一实现**。
 *
 * 为什么必须只有一份：这条口径同时被两条门禁用到 —— 本编排器（`yarn check` / `check:fast`）
 * 与 `scripts/check-root-guards.mjs`（docs-only 的 PR 唯一防线）。两份实现必然漂移，
 * 而漂移的代价是"某一条路径上失败详情永远看不到"：
 *   1. **C-08/F1**（2026-09-24 第十轮审计 P1）：根守卫运行器的摘要只有「头 20 + 省略 N 行 +
 *      尾 20」，**没有判定行扫描** ⇒ 判定行落在中段时在 CI 日志里出现 **0 次**；
 *   2. **C-09/F2**（同轮 P1）：本编排器的旧 `FAILURE_LINE` 用**行内任意位置**匹配
 *      （`(?:^|\s)(?:…|×|…)`），于是 `[probe] progress ×0 items scanned` 这类进度噪声
 *      也进判定列表、先到先得吃满 150 行预算 ⇒ 真正的 `AssertionError` 一行不留。
 *
 * 因此判定行的匹配**锚定在行首**（允许前导空白），并把"进度/装饰噪声"单独分类：
 * 噪声**不得占用判定行预算**（它们不是判定行，回显在摘要里只会骗人）。
 *
 * 三类行（`classifyVerdictLine` 的返回值）：
 *   · `'verdict'` —— **锚定**的判定行：失败用例名 / 断言 / 编译错误 / 运行器汇总。
 *     形态表见 {@link VERDICT_LINE}（vitest `×`/`FAIL`/`AssertionError`/`⎯`、
 *     `node --test` 的 `not ok`、tsc `error TS…`、yarn `ELIFECYCLE`、栈首 `Error:`、
 *     go `--- FAIL:`/`panic:`、eslint `12:5  error …`、`--reporter=json` 的单行 JSON…）。
 *   · `'noise'` —— 锚定命中但内容是**进度/装饰**（`× 0 items scanned`）：计数、不占预算。
 *   · `null` —— 不是判定行（含**行内**出现关键字的所有自由文本，例如旧口径会误捕的那些）。
 *
 * **分类前先剥离 ANSI**（见 {@link stripAnsiSequences}）：CI 里 vitest 输出带颜色，
 * 而锚定看的是行首 —— 不归一化的话 `\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m …` 与
 * `\x1b[31m×\x1b[39m …` 一条都不匹配（本地无 TTY ⇒ 无 ANSI ⇒ "本地绿、CI 瞎"）。
 * 归一化**只用于分类**：打印仍是原行（短输出"逐字原样"的字节不许变）。
 *
 * **"栈内"形态的明确策略**（第十轮复审 W1 的 N5）：栈帧/包装/追踪里的行**同样锚定**，
 * 不靠兜底段（兜底段有界：未锚定时 20 行、混合场景 10 行，真判定行一多就被挤出去）。
 * 具体锚进表里的行首前缀：pytest `E   `（`E` + ≥3 空格）、python
 * `Traceback (most recent call last):`、GitHub 注解 `##[error]`、npm `npm error`、
 * node 栈帧 `node:internal/…`、jest `●`、以及 vitest 未处理拒绝的**正文**（`TypeError:` 一类
 * `*Error:` 栈首）与无 `⎯` 装饰的 `Unhandled Rejection`。取舍：这些形态都是**行首可判别**的
 * 固定前缀，锚定它们不会把进度噪声拉进判定段（噪声另有 `VERDICT_NOISE` 一档）；相反，指望
 * "兜底段一定能看见"是**错的** —— 混合场景的兜底只有 10 行，且它在判定段之外。
 *
 * 兜底：一条判定行都没锚到时，**不是**静默给一个空段，而是 fail-loud 打印
 * 「未找到判定行」+ 判定形态可能没登记 + `--full-output` 的出路（见
 * {@link summarizeBoundedFailure} 的 `missingVerdict` / `text`）。**混合**场景（有判定行、
 * 但也有未锚定的疑似错误行）同样不许静默丢：那些行进有界的「其它疑似错误行」段。
 *
 * **每条形态的 `witness`（第十一轮复审 J1 的 N6）**：该形态的**判定词本身**写成的**最小行**，
 * 自检断言"这条正则仍然认得它自己的判定词"（见 {@link selfTestVerdictClassifier} ①f）。
 *
 * 为什么需要它：`VERDICT_FORM_SAMPLES` 只证明"样本能被分类成判定行"，**样本与正则是同一份
 * 改动的两侧** —— 把 `count-failed` 的 `\d+\s+failed\b` 收窄成 `\d+\s+ZZfailed\b`、同时把
 * 它那条样本改成 `3 ZZfailed | 2 passed (5)`，形态数 / 样本数 / 唯一见证数三个棘轮一个都不动，
 * 自检**全绿**，而真实失败行（`3 failed | 2 passed (5)`）从此在 CI 日志里整行消失（J1 实测：
 * `classifyVerdictLine('3 failed | 2 passed (5)')` 从 `verdict` 变 `null`，`--list` 仍 EXIT=0）。
 * `witness` 把"判定词"从样本里**独立**登记出来：收窄正则就得同时改样本、改 witness 三处，
 * 而 witness 的语义是"这条形态的判定词长什么样"，改它等于当场自认在改判定面。
 */
const VERDICT_LINE_FORMS = [
  { id: 'times', label: 'vitest/jest 用例行 `×`/`✗`/`✘`', pattern: String.raw`[×✗✘](?:[ \t]|$)`, witness: '× x' },
  { id: 'heavy-x', label: '重型叉号 `✖`(ava 等运行器)', pattern: String.raw`✖`, witness: '✖ x' },
  { id: 'bullet', label: 'jest 用例行 `●`', pattern: String.raw`●`, witness: '● x' },
  { id: 'fail', label: '`FAIL` / `FAILED`(vitest / pytest 汇总)', pattern: String.raw`FAIL(?:ED)?\b`, witness: 'FAIL x' },
  { id: 'dash-fail', label: 'go 用例级 `--- FAIL:`', pattern: String.raw`-{3,}[ \t]*FAIL\b`, witness: '--- FAIL: x' },
  { id: 'panic', label: 'go `panic:`', pattern: String.raw`panic\b`, witness: 'panic: x' },
  { id: 'not-ok', label: 'node --test / TAP `not ok`', pattern: String.raw`not ok\b`, witness: 'not ok 1 - x' },
  { id: 'assertion-error', label: '`AssertionError`(node/python 断言)', pattern: String.raw`AssertionError\b`, witness: 'AssertionError: x' },
  { id: 'named-error', label: '栈首 `TypeError:` / `RangeError:` 一类', pattern: String.raw`[A-Za-z_$][\w$]*Error\b`, witness: 'TypeError: x' },
  { id: 'bare-error', label: '裸栈首 `Error:`', pattern: String.raw`Error\b`, witness: 'Error: x' },
  { id: 'bare-error-lower', label: '裸 `error:`(yarn/工具链小写形态)', pattern: String.raw`error\b`, witness: 'error x' },
  { id: 'elifecycle', label: 'yarn/npm `ELIFECYCLE`', pattern: String.raw`ELIFECYCLE\b`, witness: 'ELIFECYCLE x' },
  { id: 'tsc-paren', label: 'tsc 括号形态 `a.ts(12,5): error TS2345`', pattern: String.raw`\S+\(\d+,\d+\):\s*error TS\d+`, witness: 'a.ts(1,2): error TS1' },
  { id: 'tsc-pretty', label: 'tsc pretty(TTY)`a.ts:12:5 - error TS2345`', pattern: String.raw`\S+:\d+:\d+[ \t]+-[ \t]+error TS\d+`, witness: 'a.ts:1:2 - error TS1' },
  { id: 'tsc-bare', label: '裸 `error TS2345`', pattern: String.raw`error TS\d+`, witness: 'error TS1' },
  { id: 'lint-position', label: 'eslint `12:5  error …`', pattern: String.raw`\d+:\d+[ \t]+error\b`, witness: '1:2  error x' },
  { id: 'tests-failed', label: 'jest 汇总 `Tests:  1 failed`', pattern: String.raw`Tests?:?[ \t]+\d+[ \t]+failed\b`, witness: 'Tests: 1 failed' },
  { id: 'test-files-failed', label: 'vitest 汇总 `Test Files  1 failed`', pattern: String.raw`Test Files\s+\d+\s+failed\b`, witness: 'Test Files 1 failed' },
  { id: 'count-failed', label: '运行器汇总 `3 failed`', pattern: String.raw`\d+\s+failed\b`, witness: '1 failed' },
  { id: 'rule', label: 'vitest 装饰行 `⎯`', pattern: String.raw`⎯`, witness: '⎯ x' },
  { id: 'gh-annotation', label: 'GitHub 注解 `##[error]`', pattern: String.raw`##\[error\]`, witness: '##[error]x' },
  { id: 'npm-error', label: 'npm `npm error`', pattern: String.raw`npm error\b`, witness: 'npm error x' },
  { id: 'traceback', label: 'python `Traceback (most recent call last):`(栈内)', pattern: String.raw`Traceback \(most recent call last\):`, witness: 'Traceback (most recent call last):' },
  { id: 'pytest-e', label: 'pytest 断言行 `E   …`', pattern: String.raw`E {3,}\S`, witness: 'E   x' },
  { id: 'node-internal', label: 'node 加载器栈帧 `node:internal/…`(栈内)', pattern: String.raw`node:internal\/`, witness: 'node:internal/x' },
  { id: 'unhandled', label: '`Unhandled Rejection` / `Unhandled Error`', pattern: String.raw`Unhandled (?:Rejection|Errors?)\b`, witness: 'Unhandled Rejection: x' },
  {
    id: 'json-counts',
    label: 'jest `--json` 单行计数字段(非 0)',
    pattern: String.raw`(?:\{.*)?"(?:numFailedTests|numFailedTestSuites|numRuntimeErrorTestSuites|errorCount|fatalErrorCount)"\s*:\s*(?!0\b)\d`,
    witness: '{"numFailedTests":1}',
  },
  { id: 'json-success', label: 'eslint `--format=json` / `"success":false`', pattern: String.raw`(?:\{.*)?"success"\s*:\s*false\b`, witness: '{"success":false}' },
  { id: 'go-json-fail', label: 'go `-json` 单行 `{"Action":"fail"}`', pattern: String.raw`(?:\{.*)?"Action"\s*:\s*"fail"`, witness: '{"Action":"fail"}' },
]
/**
 * 判定形态表的**下限**（棘轮:只允许被"变多"越过）。
 *
 * 为什么是硬字面量而不是 `VERDICT_LINE_FORMS.length`:`VERDICT_LINE` **由这张表拼出**
 * (表是唯一真源),用 `length` 当下限等于恒真 —— 删掉一条形态只需要删表里一行。写死之后,
 * 删形态必须**同时**改这个数字与它的样本(一次显式、可评审的 diff),否则自检当场红。
 *
 * 这正是第十一轮审计 C3-02 的现场:29 条形态里有 **10 条没有任何样本**
 * (`✖` / `not ok` / `Error\b` / `error\b` / `ELIFECYCLE` / tsc 括号形态 / `Test Files N failed` /
 * `N failed` / `⎯` / `"success":false`),只改正则、不动任何判据的重构就能让这些真实失败行
 * 在 CI 日志里整行消失,而 `yarn check` 与两条判据全绿。
 */
const SELFTEST_VERDICT_FORMS_FLOOR = 29
/**
 * 判定形态**样本**的下限(棘轮)。
 *
 * 计数口径 = 登记表里**真的被分类过**的样本条数,不是 `check()` 被调用的次数 ——
 * 第十一轮审计 C3-03 点名的可掏空形态正是"对调用次数计数"(把某条判据改成恒真、或整段删掉,
 * 调用次数都能保持不变)。样本条数 + 逐形态覆盖率一起判,才与断言内容绑定。
 */
const SELFTEST_VERDICT_SAMPLES_FLOOR = 29
/**
 * 「**唯一见证样本**」形态数的下限(棘轮)。
 *
 * 形态表里有两条是彼此的子集 —— `AssertionError\b` ⊂ `[A-Za-z_$][\w$]*Error\b` 与
 * `error TS\d+` ⊂ `error\b` —— 它们的样本删掉分支后仍被兄弟命中,所以"去掉即红"只能对
 * **其余 27 条**成立。这个数字钉住"能逐条做接线变异"的形态数:再退化成子集(或有人拿
 * 子集关系当借口往表里塞重复形态)就撞下限。
 */
const SELFTEST_VERDICT_UNIQUE_WITNESS_FLOOR = 27
/**
 * 判定形态的**样本登记**(每条形态 ≥1 条;双向对拍见 `selfTestVerdictClassifier()`)。
 *
 * 每条样本声明它**打在哪个分支上**(`form`):自检除了断言"分类结果是 verdict + 埋行仍可见",
 * 还要用**该分支自己的独立正则**去匹配这条样本 —— 否则 `form` 字段只是一句自述
 * (登记成 A 分支、样本其实靠 B 分支命中),覆盖率就是假的。
 */
const VERDICT_FORM_SAMPLES = [
  { form: 'times', label: 'vitest 用例行 `×`', line: '× tests/x.spec.ts > a > b' },
  { form: 'times', label: 'jest 用例行 `✗`', line: '  ✗ suite › case' },
  { form: 'heavy-x', label: 'ava `✖`', line: '✖ No tests found' },
  { form: 'bullet', label: 'jest 用例行 `●`', line: '  ● suite name › case name' },
  { form: 'fail', label: 'vitest 彩色 ` FAIL `(PR #146 现场)', line: '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m tests/a.spec.ts > s > c' },
  { form: 'fail', label: 'pytest 汇总 `FAILED`', line: 'FAILED tests/test_x.py::test_y - AssertionError' },
  { form: 'dash-fail', label: 'go `--- FAIL:`', line: '--- FAIL: TestFoo (0.01s)' },
  { form: 'panic', label: 'go `panic:`', line: 'panic: test timed out after 10m0s' },
  { form: 'not-ok', label: 'node --test `not ok`', line: 'not ok 3 - suite case' },
  { form: 'assertion-error', label: 'node `AssertionError [ERR_ASSERTION]`', line: 'AssertionError [ERR_ASSERTION]: boom' },
  { form: 'named-error', label: '栈首 `TypeError:`', line: 'TypeError: beta unhandled boom' },
  { form: 'bare-error', label: '裸 `Error:`(F2 形态 A 的原句)', line: 'Error: build step aborted' },
  { form: 'bare-error-lower', label: 'yarn `error Command failed with exit code 1.`', line: 'error Command failed with exit code 1.' },
  { form: 'elifecycle', label: '`ELIFECYCLE`(npm 的 `code ELIFECYCLE` 行首形态)', line: 'ELIFECYCLE Command failed with exit code 1.' },
  { form: 'tsc-paren', label: 'tsc 括号形态', line: 'src/a.ts(12,5): error TS2345: Argument of type …' },
  { form: 'tsc-pretty', label: 'tsc pretty(TTY)', line: 'src/a.ts:12:5 - error TS2345: Argument of type …' },
  { form: 'tsc-bare', label: '裸 `error TS2345`', line: 'error TS2345: Argument of type …' },
  { form: 'lint-position', label: 'eslint `12:5  error`', line: '  12:5  error  Unexpected var  no-var' },
  { form: 'tests-failed', label: 'jest 汇总 `Tests:  1 failed`', line: 'Tests:       1 failed, 2 passed, 3 total' },
  { form: 'test-files-failed', label: 'vitest 汇总 `Test Files  1 failed`', line: ' Test Files  1 failed | 2 passed (3)' },
  { form: 'count-failed', label: '运行器汇总 `3 failed`', line: '3 failed | 2 passed (5)' },
  { form: 'rule', label: 'vitest 装饰行 `⎯`', line: '⎯⎯⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯⎯' },
  { form: 'gh-annotation', label: 'GitHub 注解 `##[error]`', line: '##[error]AssertionError: boom' },
  { form: 'npm-error', label: 'npm `npm error`', line: 'npm error Missing script: "x"' },
  { form: 'traceback', label: 'python `Traceback …`', line: 'Traceback (most recent call last):' },
  { form: 'pytest-e', label: 'pytest 断言行', line: 'E   AssertionError: assert 1 == 2' },
  { form: 'node-internal', label: 'node 加载器栈帧', line: 'node:internal/modules/cjs/loader:1234' },
  { form: 'unhandled', label: '`Unhandled Rejection:`(无 `⎯` 装饰)', line: 'Unhandled Rejection: boom' },
  { form: 'json-counts', label: 'jest `--json` 计数', line: '{"numFailedTests":2,"numTotalTests":10}' },
  { form: 'json-counts', label: 'eslint `--format=json`(靠 `errorCount` 命中)', line: '{"filePath":"a.js","errorCount":1,"messages":[]}' },
  { form: 'json-success', label: '`"success":false`', line: '{"success":false,"reason":"boom"}' },
  { form: 'go-json-fail', label: 'go `-json` `Action:fail`', line: '{"Time":"2026-09-24T00:00:00Z","Action":"fail","Package":"x/y"}' },
]
/**
 * 锚定正则的构造:把形态表按**原顺序**拼回 `^[ \t]*(?:A|B|C|…)`(与拆分前逐字节等价)。
 * 抽成函数是为了让自检能对"注入的形态表"跑同一套判据(变异验证:去掉一条即红)。
 * @param forms - 形态表(缺省 = `VERDICT_LINE_FORMS`)。
 * @returns 锚定判定行的正则。
 */
const verdictLineOf = (forms = VERDICT_LINE_FORMS) =>
  new RegExp(`^[ \\t]*(?:${forms.map(form => form.pattern).join('|')})`, 'u')
const VERDICT_LINE = verdictLineOf()
/**
 * ANSI 控制序列的剥离（**只用于分类，绝不用于打印**）—— 2026-09-24 第十轮复审 V1 的 P1，
 * 由主控从 PR #146 的真实 CI 日志复现：
 *
 * 现场：失败 job 里编排器打印「本次输出里**一条锚定判定行都没有匹配到**」，而同一份输出里
 * 确实有 ` FAIL  tests/audit-r9-connector-headers.spec.ts > …`（vitest 的彩色形态是
 * `\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m …`，用例行是 `\x1b[31m×\x1b[39m`，栈行带
 * `\x1b[90m`）—— 判定词之前先有转义序列，行首锚定就失效。本地无 TTY ⇒ 无 ANSI ⇒
 * 判据"本地绿、CI 瞎"。ANSI 的另一半动机与 C-09 相同：**分类口径必须与真实输出同形**。
 *
 * 覆盖四类：CSI（`ESC [ … 字母`）、OSC（`ESC ] … BEL` 或 `ESC \`；**未闭合的吃到行尾**，
 * 否则一条被截断的进度条能把整行判定词藏起来）、字符集指定（`ESC ( B` 一类）、
 * 两字符转义；C1 的 `0x9b` 是 **CSI 的单字节引导形态**，按同一形态整条剥离（见下）。
 *
 * **C1（`0x9b`）= CSI 的另一种引导字节，必须连同参数字节一起剥离**（第十轮复审 W1 的 N4）：
 * 旧实现只在末尾删掉裸 `0x9b` 引导字节，把**参数字节留在原地** ——
 * `'\u009b31m×\u009b39m name'` 变成 `'31m×39m name'`，判定词不再位于行首 ⇒
 * `classifyVerdictLine` 返回 `null`（注释却声称覆盖了 C1：注释与实现不一致本身就是缺陷）。
 * 正确形态与 `ESC [` 那条同构，只换引导字节：`\u009b <参数字节> <终止字节>`；
 * 这一条必须排在"裸 `ESC`/`0x9b` 兜底"**之前**（否则引导字节先被删掉，参数就永远认不出来了）。
 *
 * 只覆盖这两种引导形态（`ESC [` / `0x9b`）：CSI 的第三种引导（UTF-8 的 `0xC2 0x9B`）在实践中
 * 不会出现在工具输出里，**不做**（这里如实写明，而不是让注释比实现宽）。
 *
 * @param line - 原始输出行。
 * @returns 去掉控制序列之后的文本（**用于分类**；打印请继续用原行）。
 */
export const stripAnsiSequences = line => line
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '') // OSC(规范形态)
  .replace(/\u001b\][^\u0007]*$/gmu, '') // OSC(未闭合:吃到行尾)
  .replace(/\u001b\[[0-9;:?<=>!]*[ -/]*[@-~]/gu, '') // CSI
  .replace(/\u009b[0-9;:?<=>!]*[ -/]*[@-~]/gu, '') // CSI(C1 单字节引导:引导+参数+终止一条剥离)
  .replace(/\u001b[()#%][0-9A-Za-z]?/gu, '') // 字符集指定
  .replace(/\u001b[@-Z\\-_]/gu, '') // 两字符转义
  .replace(/[\u001b\u009b]/gu, '') // 残留的裸 ESC / C1 引导字节(无参形态)
/**
 * 「进度/装饰噪声」谓词 —— 只对**已经锚定命中**的行判，用来把
 * `× 0 items scanned` 这类计数器从判定行里摘出去（审计现场的原句是
 * `[probe] progress ×0 items scanned`，锚定之后它连判定行都不是，这里是第二道）。
 * 刻意只认"扫描计数"这一族形态：把 `progress` 之类的词整族拉黑会误杀
 * 真叫这个名字的失败用例。
 */
const VERDICT_NOISE = /(?:\bitems?|\bfiles?|\bentries|\bpaths?|\bcases?)\s+scanned\b/u
/**
 * 兜底「疑似错误行」谓词：**不锚定**，只在一条判定行都没锚到时使用（有界 20 行）。
 * 审计现场（F2 形态 A）的判定行写成 `MUST-SURVIVE-VERDICT: Error: build step aborted …`
 * —— 它不匹配任何锚定形态，但含 `Error`/`aborted`，靠这一档才不至于"一行都没有"。
 */
const FALLBACK_ERROR_LINE = /(?:^|\s)(?:error|errors|failed|failure|exception|aborted|panic|timed?\s*out|not ok|assertionerror)\b/iu
/** Cap on the verdict lines printed per failed task. */
const MAX_FAILURE_LINES = 150
/** Cap on the trailing context lines printed per failed task. */
const MAX_TAIL_LINES = 200
/** Cap on the unanchored fallback lines (only used when no verdict line was matched). */
const MAX_FALLBACK_LINES = 20
/**
 * Cap on the **mixed-scenario** fallback lines（有判定行、但输出里同时存在未锚定的疑似错误行）。
 *
 * 为什么需要（第十轮复审 V1 的 P3-D1）：`FALLBACK_ERROR_LINE` 那一档此前**只在
 * `missingVerdict === true` 时**才生效 —— 只要输出里锚到了哪怕一条判定行，其余"读不懂形态"
 * 的真失败行就被**静默丢弃**。实测的四种真实形态（go 用例级 `--- FAIL: TestX`、`panic: test
 * timed out`、`--reporter=json` 的单行 JSON、eslint 的 `12:5  error …`）现在已进锚定表，
 * 但"下一个没登记的形态"不该再由"碰巧还有别的锚定行"决定可见性 ⇒ 这一档是**兜底**。
 */
const MAX_MIXED_FALLBACK_LINES = 10
/**
 * `selfTestVerdictClassifier()` 至少执行的断言条数（防"把断言表掏空"）。
 *
 * 与 `check-root-guards.mjs` 的 `SELFTEST_GUARD_ENV_ASSERTIONS` 同一手法：光有
 * `failures.length === 0` 是恒真的 —— 把断言表清空它就永远通过。下限只允许被"变多"越过。
 */
const SELFTEST_VERDICT_ASSERTIONS = 60

/**
 * 把一行分类成 `'verdict'` / `'noise'` / `null`（见上面那段契约）。
 *
 * **分类前剥离 ANSI**（见 {@link stripAnsiSequences}），返回的分类与打印用的原行无关。
 * @param line - 原始输出行（**不要**先 trim：锚定判据看的就是行首）。
 * @returns 分类结果。
 */
export function classifyVerdictLine(line) {
  for (const segment of crSegmentsOf(line)) {
    if (segment === '') continue
    if (!VERDICT_LINE.test(segment)) continue
    return VERDICT_NOISE.test(segment) ? 'noise' : 'verdict'
  }
  return null
}

/**
 * 把一行按 `\r`(CR)切成**段**（先剥离 ANSI/C1）—— 每个段的起点在终端里都是**第 0 列**。
 *
 * 为什么必须有这一步（第十一轮审计 C3-01，**第十轮锚定改造引入的回归**）：
 * 旧判据是 `(?:^|\s)(?:FAIL\b|…)`，JS 的 `\s` **包含 `\r`** ⇒ `progress 100%\rFAIL …` 当时能匹配；
 * 第十轮把锚定换成 `^[ \t]*` 行首，而同时新增的 ANSI 归一**不覆盖 `\r`** ⇒ 判定行从"能看见"
 * 变成**整行不见**：它既不进判定段，也不进 20/10 行兜底段（`FAIL` / `--- FAIL:` / `×` 不含
 * `FALLBACK_ERROR_LINE` 的关键词）。门禁仍然 `EXIT=1`，但 CI 日志里**没有任何失败详情** ——
 * 正是 C-08/C-09 要消灭的那种"红了但不可诊断"。
 *
 * 取值口径（取向 = fail-safe，**只放宽到"每个 CR 段各自的行首"**）：
 *   · `\r` 是"光标回第 0 列"，所以 CR 之后的字符从第 0 列开始写 ⇒ 它是一段新的行首；
 *   · 逐段判、任一段锚定命中即算判定行 —— 宁可多判（多打印一行详情），
 *     也不许把真判定行藏起来（隐藏的代价正是这条缺陷本身）；
 *   · CRLF 的行尾 `\r` 之后是空串，被 `classifyVerdictLine` 跳过，天然不影响整行判定；
 *   · **不是**放宽成"行内任意位置匹配"：只有段首（终端第 0 列 / 物理行首）才算行首，
 *     所以 C-09 形态 B 的进度噪声仍然进不了判定段（噪声另有 `VERDICT_NOISE` 一档）。
 *
 * 归一化**只用于分类**：打印继续用原行（短输出"逐字原样"的字节不许变）。
 * @param line - 原始输出行。
 * @returns 段数组（分类用；`[0]` 之外的段都以 CR 之后的位置开头）。
 */
export const crSegmentsOf = line => stripAnsiSequences(line).split('\r')

/**
 * 有界化一个失败任务的输出，并返回**结构化**摘要（判定行 / 噪声 / 兜底 / 尾窗）。
 *
 * 契约（调用方可以依赖的部分）：
 *   · **纯函数**：不读磁盘、不写 stdout、不抛异常（输入是字符串，输出是对象）。
 *   · 短输出（行数 ≤ `maxVerdictLines + maxTailLines`）**原样返回**（只 `trimEnd`）——
 *     现状不变，不许因为"加了判定行扫描"而改动短输出的字节。
 *   · 长输出：`text` 里判定行在前、尾窗在后，且**判定行一定在尾窗之外也算数**
 *     （这正是 C-08/F2 要修的那条）；进度噪声单独计数、不占判定预算；分类前先剥离 ANSI。
 *   · `missingVerdict === true` 时 `text` 里必定有一段 fail-loud 的「未找到判定行」
 *     （不会是空段），并给出 `--full-output` 的出路。
 *   · **混合场景**（有判定行 + 未锚定的疑似错误行）另行有界回显（`mixedFallbackLines`）。
 *   · `--full-output` 是**调用方**的事：走本函数就直接拿有界结果，不做时间/体积判断。
 * @param output - 任务捕获到的 stdout+stderr。
 * @param options - `maxVerdictLines` / `maxTailLines` / `maxFallbackLines` 可覆盖（测试用）。
 * @returns `{ text, totalLines, truncated, verdictLines, noiseLines, fallbackLines, mixedFallbackLines, budgetExhausted, missingVerdict }`
 */
export function summarizeBoundedFailure(output, options = {}) {
  const maxVerdictLines = options.maxVerdictLines ?? MAX_FAILURE_LINES
  const maxTailLines = options.maxTailLines ?? MAX_TAIL_LINES
  const maxFallbackLines = options.maxFallbackLines ?? MAX_FALLBACK_LINES
  const maxMixedFallbackLines = options.maxMixedFallbackLines ?? MAX_MIXED_FALLBACK_LINES
  // A trailing newline is a separator, not a line: keeping the empty element
  // made exactly-(MAX_FAILURE_LINES + MAX_TAIL_LINES)-line output take the
  // summary branch (off-by-one).
  const body = output.endsWith('\n') ? output.slice(0, -1) : output
  const lines = body.split('\n')
  const budget = maxVerdictLines + maxTailLines
  if (lines.length <= budget) {
    return {
      text: output.trimEnd(),
      totalLines: lines.length,
      truncated: false,
      verdictLines: [],
      noiseLines: [],
      fallbackLines: [],
      mixedFallbackLines: [],
      budgetExhausted: false,
      missingVerdict: false,
    }
  }
  const tailStart = Math.max(0, lines.length - maxTailLines)
  const verdictLines = []
  const noiseLines = []
  for (const line of lines) {
    const kind = classifyVerdictLine(line)
    if (kind === 'verdict') verdictLines.push(line)
    else if (kind === 'noise') noiseLines.push(line)
  }
  // 预算按**出现顺序**给锚定判定行（噪声不参与竞争）。
  const shownIndices = []
  for (let index = 0; index < lines.length && shownIndices.length < maxVerdictLines; index += 1) {
    if (classifyVerdictLine(lines[index]) === 'verdict') shownIndices.push(index)
  }
  const shown = shownIndices.map(index => lines[index])
  // Verdict lines already shown above are not repeated inside the tail.
  const shownSet = new Set(shownIndices)
  const tail = lines.slice(tailStart).filter((_, offset) => !shownSet.has(tailStart + offset))
  const missingVerdict = verdictLines.length === 0
  const fallbackLines = missingVerdict
    ? lines.filter(line => line.trim() !== '' && FALLBACK_ERROR_LINE.test(line)).slice(0, maxFallbackLines)
    : []
  // **混合场景**兜底（第十轮复审 V1 的 P3-D1 后半条）：有判定行可锚，但输出里还有
  // "读不懂形态"的疑似错误行落在尾窗之外 —— 它们此前被静默丢弃。有界回显（不占判定预算），
  // 并明确"这可能是没登记的判定形态"，把口子指向 VERDICT_LINE 而不是"反正看不见"。
  const mixedFallbackLines = missingVerdict
    ? []
    : lines
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => line.trim() !== ''
        && index < tailStart
        && !shownSet.has(index)
        && classifyVerdictLine(line) === null
        && FALLBACK_ERROR_LINE.test(line))
      .slice(0, maxMixedFallbackLines)
      .map(({ line }) => line)
  const budgetExhausted = verdictLines.length > shown.length
  const parts = [`(输出共 ${lines.length} 行;此处只打印判定行与末尾;完整输出用 --full-output 本地重跑)`]
  if (!missingVerdict) {
    parts.push(`--- 失败相关行(最多 ${maxVerdictLines} 行,按出现顺序;判定行**行首锚定**) ---`, ...shown)
    if (mixedFallbackLines.length > 0) {
      // 放在"判定段"之后、噪声计数之前 —— 消费者按 `\n--- ` 切段时判定段仍是纯判定行。
      parts.push(`--- 其它疑似错误行(未锚定;最多 ${maxMixedFallbackLines} 行 —— 若真判定行长这样,`
        + '请把它补进 VERDICT_LINE 的**锚定**形态表,而不是让它在混合输出里被静默丢掉) ---',
      ...mixedFallbackLines)
    }
    if (noiseLines.length > 0) {
      // 审计现场（C-09 形态 B）：这些行曾经先到先得吃满 150 行预算，把真正的
      // `AssertionError` 挤出判定段。现在只计数、不回显 —— 它们不是判定行。
      parts.push(`--- 另有 ${noiseLines.length} 条"进度/装饰噪声"行锚定命中了判定标记，已排除`
        + `（噪声不得占用判定行预算，需要看全文请用 --full-output） ---`)
    }
  } else {
    parts.push('--- 未找到判定行(fail-loud) ---',
      '本次输出里**一条锚定判定行都没有匹配到** —— 这不是"没有失败详情"，而是判定形态没被识别：',
      '  · 判定行可能用了未登记的形态（形态表见 scripts/check-workspaces.mjs 的 VERDICT_LINE），或',
      `  · 判定行落在被省略的中间段（本段只保留锚定判定行与末尾 ${maxTailLines} 行）。`,
      '⇒ 用 `--full-output` 重跑拿完整输出（例如 `node scripts/check-workspaces.mjs --only <包> --full-output`）；',
      '  若那种形态确实合法，请把它补进 VERDICT_LINE 的**锚定**形态表 —— 不要放宽成"行内任意位置匹配"',
      '  （那正是 C-09 形态 B：进度噪声会先到先得吃满判定预算）。')
    if (fallbackLines.length > 0) {
      parts.push(`--- 兜底:未锚定的"疑似错误行"(最多 ${maxFallbackLines} 行;可能含真正的判定行) ---`, ...fallbackLines)
    }
  }
  if (budgetExhausted) {
    parts.push(`--- 判定行预算已用尽（≥${maxVerdictLines} 条判定行;可能还有未打印的 ⇒ 用 --full-output 看全） ---`)
  }
  parts.push(`--- 输出末尾(最后 ${tail.length} 行) ---`, ...tail)
  return {
    text: parts.join('\n'),
    totalLines: lines.length,
    truncated: true,
    verdictLines,
    noiseLines,
    fallbackLines,
    mixedFallbackLines,
    budgetExhausted,
    missingVerdict,
  }
}

/**
 * 有界失败报告（字符串形态）—— 给"只要一段可打印文本"的调用方（如根守卫运行器）。
 * @param output - 任务输出。
 * @param options - 同 {@link summarizeBoundedFailure}。
 * @returns 有界报告文本。
 */
export function formatFailureReport(output, options = {}) {
  return summarizeBoundedFailure(output, options).text
}

/**
 * 「判定形态表 + ANSI 归一 + C1 剥离」的**逐形态自检**（第十轮复审 W1 的 N4/N5）。
 *
 * 为什么要有（而不是只靠 `verify-check-workspaces.mjs` 的那几条断言）：
 * 形态表就是这个门禁的**诊断面本身** —— 少一条形态，那条失败行在 CI 日志里整行消失
 * （PR #146 的现场：彩色 ` FAIL ` 行一条都不匹配，编排器只打「未找到判定行」）。
 * 而"看不见"与"没有失败"在日志里长得几乎一样，**门禁仍然 EXIT=1**，红得看起来很有理由。
 * 所以把它做成纯函数自检，挂到**两个调用方**（`main()` 与 `check-root-guards.mjs`）的
 * 启动路径上：①本编排器 = `yarn check` / CI 的 gate job；②根守卫运行器 = docs-only PR 的
 * **唯一防线**（那条路径上编排器根本不跑）。自检失败按配置错误处理（exit 2），
 * 不退化成"跑一遍门禁然后详情看不见"。
 *
 * 判据三组：①**必须锚定**的形态（含"栈内"形态 —— 见 `VERDICT_LINE` 的取舍说明）；
 * ②**不许误伤**的负例（否则判定预算会被噪声吃满，真判定行反而被挤出去）；
 * ③C1（`0x9b`）与 ESC 两种引导形态**逐字节等价**，且**行埋在尾窗之外**时仍然进判定段。
 *
 * 纯函数：不读磁盘、不写 stdout、不抛异常（`main()` 与 `check-root-guards.mjs` 都直接调它）。
 * @returns `{ failures, assertions }` —— `failures` 为空且 `assertions` ≥
 *   `SELFTEST_VERDICT_ASSERTIONS` 才算通过（条数下限防"把断言表掏空"）。
 */
export function selfTestVerdictClassifier() {
  const failures = []
  let assertions = 0
  const check = (ok, message) => {
    assertions += 1
    if (!ok) failures.push(message)
  }
  const formById = id => VERDICT_LINE_FORMS.find(form => form.id === id)
  // ①a **形态表的覆盖面**（第十一轮审计 C3-02）:每条形态至少 1 条样本,且样本声称的分支必须
  //     真的存在。两个方向都判 —— 少了 = 那条失败行在 CI 日志里整行消失而无人发现;
  //     多了(样本挂在未登记的分支上) = 登记表与正则已经漂移。
  const ownPatternOf = form => new RegExp(`^[ \\t]*(?:${form.pattern})`, 'u')
  const coveredIds = new Set()
  for (const sample of VERDICT_FORM_SAMPLES) {
    const form = formById(sample.form)
    if (form === undefined) {
      failures.push(`[verdict-selftest] 样本「${sample.label}」登记的分支 \`${sample.form}\` 不在 `
        + '`VERDICT_LINE_FORMS` 里 ⇒ 登记表与样本已漂移(该样本在给一个不存在的形态作证)。')
      continue
    }
    // **覆盖率由"匹配"算出来,不是由样本自己声明的 `form` 字段算出来**(事实 vs 自述):
    // 只有"该分支的独立正则真的匹配到这条样本"时才记它被覆盖 —— 于是 `formsCovered`
    // 这条计数不可能靠改一行字段值伪造。
    if (crSegmentsOf(sample.line).some(segment => ownPatternOf(form).test(segment))) coveredIds.add(sample.form)
    // 声明与事实必须一致(逐条给出可读诊断;上一条已经是"事实"口径,这一条是它的诊断面)。
    check(coveredIds.has(sample.form),
      `[verdict-selftest] 样本「${sample.label}」声称打在分支 \`${sample.form}\`(${form.label})上,`
      + `但它并不匹配该分支的独立正则 ⇒ 这条"覆盖"是自述,不是事实:${JSON.stringify(sample.line)}`)
  }
  const uncovered = VERDICT_LINE_FORMS.filter(form => !coveredIds.has(form.id))
  if (uncovered.length > 0) {
    failures.push(`[verdict-selftest] \`VERDICT_LINE_FORMS\` 里有 ${uncovered.length} 条形态**没有任何样本**`
      + `(${uncovered.map(form => `\`${form.id}\`(${form.label})`).join('、')})`
      + '\n  ⇒ 没有样本的形态等于"只改正则、不动任何判据"就能让它下线:那条真实失败行会在 CI 日志里'
      + '整行消失(既不进判定段、也不进兜底段),而门禁仍然 EXIT=1、看起来红得很有理由。'
      + '每条形态至少登记一条样本(`VERDICT_FORM_SAMPLES`)。')
  }
  // ①b 形态表与样本的**数量下限**(棘轮):删形态/删样本必须同时改字面量,是一次显式 diff。
  // ①f **每条形态的判定词(witness)**(第十一轮复审 J1 的 N6):正则必须仍然认得它自己的判定词。
  //     三个棘轮(形态数/样本数/唯一见证数)拦得住"删形态/删样本",拦不住"收窄正则 + 同步改它
  //     那条样本"—— 那时形态数、样本数、覆盖率一个都不动。witness 与样本是**两份独立登记**:
  //     收窄 `count-failed` 之后 `1 failed` 不再匹配 ⇒ 这一条当场红。
  for (const form of VERDICT_LINE_FORMS) {
    check(typeof form.witness === 'string' && form.witness.trim() !== '',
      `[verdict-selftest] 形态 \`${form.id}\`(${form.label})没有登记 \`witness\`(判定词的最小样本行)`
      + ' ⇒ 收窄正则时"同步改样本"这一条路无人拦(N6 的现场)。')
    if (typeof form.witness !== 'string' || form.witness.trim() === '') continue
    check(ownPatternOf(form).test(form.witness),
      `[verdict-selftest] 形态 \`${form.id}\`(${form.label})的正则**认不出它自己的判定词**了:`
      + `witness = ${JSON.stringify(form.witness)} / pattern = ${JSON.stringify(form.pattern)}`
      + '\n  ⇒ 这正是 N6 的形态:正则被收窄(或 witness 被改)而样本同步跟上 —— '
      + '真实失败行会在 CI 日志里整行消失。')
    check(classifyVerdictLine(form.witness) === 'verdict',
      `[verdict-selftest] 形态 \`${form.id}\` 的 witness 必须被判成锚定判定行(verdict),`
      + `实际 ${JSON.stringify(classifyVerdictLine(form.witness))}:${JSON.stringify(form.witness)}`)
  }
  check(VERDICT_LINE_FORMS.length >= SELFTEST_VERDICT_FORMS_FLOOR,
    `[verdict-selftest] 判定形态只剩 ${VERDICT_LINE_FORMS.length} 条(下限 ${SELFTEST_VERDICT_FORMS_FLOOR})`
    + ' ⇒ 形态表被削。要真的删形态,请连同 `SELFTEST_VERDICT_FORMS_FLOOR` 与它的样本一起改成可评审的 diff。')
  check(coveredIds.size >= SELFTEST_VERDICT_SAMPLES_FLOOR,
    `[verdict-selftest] 被样本覆盖的形态只有 ${coveredIds.size} 条(下限 ${SELFTEST_VERDICT_SAMPLES_FLOOR})`
    + ' ⇒ 样本集合被削(计数口径是**样本/形态集合**,不是 `check()` 的调用次数)。')
  // ①c 逐条样本:**必须锚定成 verdict**,并且**埋在尾窗之外仍然可见**(见 ③b 的 body 构造)。
  //     漏掉可见性这一半,"形态表里有正则"与"CI 日志里真能看见"就还是两件事。
  const buried = line => [
    line,
    ...Array.from({ length: MAX_FAILURE_LINES + 50 }, (_, index) => `noise line ${index}`),
    ...Array.from({ length: MAX_TAIL_LINES }, (_, index) => `tail line ${index}`),
  ].join('\n')
  // 判定段的切法必须与 `verify-check-workspaces.mjs` 的 `verdictSectionOf()` 同源：
  // 只按**已知的段头**切，不能按 `\n--- ` 切 —— 判定行本身就可能是 `--- FAIL: …`，
  // 那样会把它自己切掉（第一版自检就是这么假红的）。
  const verdictSectionOf = text => {
    const rest = text.split('--- 失败相关行')[1]
    if (rest === undefined) return ''
    const next = rest.search(/\n--- (?=输出末尾|另有 |其它疑似错误行|兜底:|判定行预算已用尽)/u)
    return next < 0 ? rest : rest.slice(0, next)
  }
  for (const sample of VERDICT_FORM_SAMPLES) {
    const kind = classifyVerdictLine(sample.line)
    check(kind === 'verdict',
      `[verdict-selftest] 样本「${sample.label}」必须被判成锚定判定行(verdict),实际 ${JSON.stringify(kind)}:`
      + `${JSON.stringify(sample.line)}`)
    const summary = summarizeBoundedFailure(buried(sample.line))
    check(summary.truncated === true,
      `[verdict-selftest] 样本「${sample.label}」的埋行用例必须落在**截断分支**(否则测的是另一条路径;`
      + `当前常量 maxVerdict=${MAX_FAILURE_LINES} / maxTail=${MAX_TAIL_LINES})`)
    check(summary.missingVerdict === false && summary.verdictLines.includes(sample.line),
      `[verdict-selftest] 样本「${sample.label}」埋在**尾窗之外**时仍必须被锚定`
      + `(missingVerdict=${summary.missingVerdict})`)
    check(verdictSectionOf(summary.text).includes(sample.line),
      `[verdict-selftest] 样本「${sample.label}」必须落在**判定段**里(不是碰巧落进尾窗):`
      + `${JSON.stringify(verdictSectionOf(summary.text).slice(0, 200))}`)
  }
  // ①d **`\r`(同行进度重写)归一的判据**(第十一轮审计 C3-01,第十轮锚定改造引入的回归)。
  //     终端的 `\r` 把光标送回第 0 列,后面的字符原地覆盖 ⇒ 屏幕上留下的是**最后一段**。
  //     旧行为:判定行整行消失(判定段、兜底段都没有)。三条一起钉:裸 CR / CRLF 行尾 / 覆盖形态。
  for (const [label, line] of [
    ['裸 `\\r` 前缀(判定行在第 0 列之后)', '\rFAIL tests/x.spec.ts > s > c'],
    ['同行进度重写(判定行被 CR 推到行中)', 'progress 100%\rFAIL tests/x.spec.ts > s > c'],
    ['CR 覆盖 + `×` 用例行', 'downloading 55%\r× tests/x.spec.ts > s > c'],
    ['CR 覆盖 + go `--- FAIL:`', 'ok 1/3\r--- FAIL: TestFoo (0.01s)'],
    ['CR 覆盖 + `not ok`', 'collecting 3/10\rnot ok 3 - suite case'],
    ['CRLF 行尾(整行判定)', 'FAIL tests/x.spec.ts > s > c\r'],
  ]) {
    const kind = classifyVerdictLine(line)
    check(kind === 'verdict',
      `[verdict-selftest] ${label} 必须仍被判成锚定判定行(verdict),实际 ${JSON.stringify(kind)}:`
      + `${JSON.stringify(line)}`)
    const summary = summarizeBoundedFailure(buried(line))
    check(summary.missingVerdict === false && summary.verdictLines.includes(line),
      `[verdict-selftest] ${label} 埋在**尾窗之外**时仍必须可见`
      + `(missingVerdict=${summary.missingVerdict})`)
  }
  // ①e `\r` 归一的**边界**(取向 = fail-safe,不许把真判定行藏起来):
  //     · `FAIL …\rprogress 100%`(判定词被 CR 之后的内容覆盖)—— **仍然算判定行**:
  //       CR 之后是"新的一段行首",而隐藏判定行的代价正是 C3-01 这条缺陷本身;
  //     · 但**不是**放宽成"行内任意位置匹配":判定词出现在行中(既不在物理行首、
  //       也不在某个 CR 段首)时仍然不是判定行 —— 那才是 C-09 形态 B 的回归。
  check(classifyVerdictLine('FAIL tests/x.spec.ts\rprogress 100%') === 'verdict',
    '[verdict-selftest] `\\r` 之前那段是判定行时必须仍然算判定行(fail-safe:宁可多打印一行详情,'
    + '也不许把真判定行藏起来)')
  check(classifyVerdictLine('progress 22% FAIL tests/x.spec.ts > s > c') === null,
    '[verdict-selftest] 判定词出现在行中(既不在物理行首、也不在 CR 段首)时不得算判定行'
    + '(否则就是 C-09 形态 B:进度噪声先到先得吃满判定预算)')
  // ② 负例：新形态**不许**把"没有失败"的输出拉进判定段。
  const negativeForms = [
    ['eslint JSON 全 0（通过）', '{"filePath":"a.js","errorCount":0,"messages":[]}'],
    ['go `-json` pass', '{"Time":"2026-09-24T00:00:00Z","Action":"pass","Package":"x/y"}'],
    ['普通说明行', '  note: all packages checked'],
    ['栈帧的普通 `at …` 行', '\u001b[90mat Object.<anonymous> (/x/y.js:1:2)\u001b[39m'],
  ]
  for (const [label, line] of negativeForms) {
    const kind = classifyVerdictLine(line)
    check(kind === null,
      `[verdict-selftest] ${label} 必须仍然分类为 null/noise（收紧过度会把判定预算烧在噪声上），`
      + `实际 ${JSON.stringify(kind)}：${JSON.stringify(line)}`)
  }
  // ②b 噪声形态（**锚定命中但是进度/装饰**）：必须分类成 `noise`（计数、不占判定预算），
  //     不得进判定段 —— 这正是 C-09 形态 B 的现场（噪声先到先得吃满 150 行，真判定行一行不留）。
  for (const [label, line] of [
    ['进度噪声 `× 0 items scanned`', '× 0 items scanned'],
    ['进度噪声 `✗ 3 files scanned`', '  ✗ 3 files scanned'],
  ]) {
    const kind = classifyVerdictLine(line)
    check(kind === 'noise',
      `[verdict-selftest] ${label} 必须分类成 noise（计数不占判定预算），实际 ${JSON.stringify(kind)}：`
      + `${JSON.stringify(line)}`)
  }
  // ③a C1 与 ESC **逐字节等价**（W1 N4：旧实现只删引导字节、把参数字节留在原地 ⇒ 整行失锚）。
  const escForm = '\u001b[31m×\u001b[39m tests/x.spec.ts > a > b'
  const c1Form = '\u009b31m×\u009b39m tests/x.spec.ts > a > b'
  check(stripAnsiSequences(c1Form) === stripAnsiSequences(escForm),
    `[verdict-selftest] C1（0x9b）引导与 ESC 引导必须剥离成同一份文本（只换引导字节），`
    + `实际 C1=${JSON.stringify(stripAnsiSequences(c1Form))} / ESC=${JSON.stringify(stripAnsiSequences(escForm))}`)
  check(stripAnsiSequences(c1Form) === '× tests/x.spec.ts > a > b',
    `[verdict-selftest] C1 序列必须**连同参数字节**一起剥离（不能把 \`31m\` 留在行首），`
    + `实际 ${JSON.stringify(stripAnsiSequences(c1Form))}`)
  // ③b **形态表的接线变异**:把注入的形态表里一条去掉之后,挂在它上面的样本必须**不再**被判成
  //     判定行 —— 证明 ①a/①c 不是恒真断言(表被削 ⇒ 样本当场红)。逐条跑,不抽样。
  //     例外(如实登记,不做假精度):形态表里存在**子集关系**,那两条分支的样本必然被兄弟形态
  //     覆盖(`AssertionError\b` ⊂ `[A-Za-z_$][\w$]*Error\b`;`error TS\d+` ⊂ `error\b`)
  //     —— 对它们改判据为"兄弟形态必须仍覆盖它"(证明确实是子集关系,而不是判据写坏了),
  //     并用 `uniqueWitness` 的下限兜住"大家都退化成子集"的方向。
  const ownMatcher = ownPatternOf
  let wiringChecked = 0
  let uniqueWitness = 0
  for (const form of VERDICT_LINE_FORMS) {
    const sample = VERDICT_FORM_SAMPLES.find(item => item.form === form.id)
    if (sample === undefined) continue
    wiringChecked += 1
    const segments = crSegmentsOf(sample.line).filter(segment => segment !== '')
    const siblings = VERDICT_LINE_FORMS.filter(item => item.id !== form.id)
    const shadowedBy = siblings.find(item => segments.some(segment => ownMatcher(item).test(segment)))
    const mutated = verdictLineOf(siblings)
    const stillMatched = segments.some(segment => mutated.test(segment))
    if (shadowedBy === undefined) {
      uniqueWitness += 1
      check(!stillMatched,
        `[verdict-selftest] 去掉形态 \`${form.id}\`(${form.label})之后,它的样本`
        + `「${sample.label}」必须**不再**被判成判定行 —— 否则这条形态有没有都无所谓`
        + `(接线变异验证:${JSON.stringify(sample.line)})`)
    } else {
      check(stillMatched,
        `[verdict-selftest] 形态 \`${form.id}\` 的样本被兄弟形态 \`${shadowedBy.id}\` 覆盖(子集关系),`
        + '那么去掉它之后兄弟形态必须仍然覆盖这条样本 —— 否则"子集"这个解释是错的,'
        + `两条形态其实都坏了:${JSON.stringify(sample.line)}`)
    }
  }
  check(wiringChecked === VERDICT_LINE_FORMS.length,
    `[verdict-selftest] 接线变异只覆盖了 ${wiringChecked}/${VERDICT_LINE_FORMS.length} 条形态`
    + ' ⇒ 有形态没有"去掉即红"的验证。')
  check(uniqueWitness >= SELFTEST_VERDICT_UNIQUE_WITNESS_FLOOR,
    `[verdict-selftest] 有**唯一见证样本**的形态只剩 ${uniqueWitness} 条`
    + `(下限 ${SELFTEST_VERDICT_UNIQUE_WITNESS_FLOOR}) ⇒ 形态表被削,或大量形态退化成彼此的子集`
    + '(后者的后果:删掉其中一条,那条失败行在 CI 日志里整行消失而没有任何判据变红)。')
  // ④ **自检通道本身**必须被证明"真的会记失败"（第十一轮审计 C3-03 的同族：靠"调用次数"
  //    当判据是可掏空的）。把 `check()` 掏成 no-op（计数照加、`failures.push` 删掉）之后，
  //    上面所有断言全塌也不会有人发现 —— 除非有一条**不经过 check()** 的探针：故意让 check
  //    记一条已知失败，断言它真的进了 `failures`；没进去就直接裸 push 一条失败
  //    （这一条不依赖 check，所以掏空 check 反而会被它抓到）。
  const channelProbe = '[verdict-selftest] 自检通道探针：这条已知为假的断言必须被记录'
  const probeBefore = failures.length
  check(false, channelProbe)
  const probeRecorded = failures.length === probeBefore + 1 && failures[failures.length - 1] === channelProbe
  if (probeRecorded) failures.pop()
  else {
    failures.push('[verdict-selftest] 自检的**失败通道被掏空**：一条已知为假的断言没有进 `failures`'
      + ' ⇒ 形态表/样本表全塌也不会有判据变红（"计数下限"只证明 `check()` 被调用过，'
      + '不证明它记了失败 —— 第十一轮审计 C3-03 点名的正是这种可掏空形态）。')
  }
  return { failures, assertions, forms: VERDICT_LINE_FORMS.length, samples: VERDICT_FORM_SAMPLES.length, formsCovered: coveredIds.size }
}

/**
 * 失败块的标题（**带真实退出码**，2026-09-24 第十轮审计 C-15/F8）。
 *
 * 旧实现把 `code` 在 `runTask` 里丢掉、标题写死"退出码非 0" ⇒ 「测试失败(1)」
 * 「用法错误(2)」「被信号杀(137)」「超时/OOM」在日志里完全同形，而排障方向相反。
 * @param result - `runTask` 的结果（含 `code` / `signal` / `spawnError`）。
 * @returns 形如 `退出码 7` / `信号 SIGKILL（可能是超时/OOM 被杀:128+9=137）` / `启动失败:…`。
 */
export function describeTaskExit(result) {
  if (result.spawnError !== undefined && result.spawnError !== null) return `启动失败:${result.spawnError}`
  if (typeof result.code === 'number') return `退出码 ${result.code}`
  if (typeof result.signal === 'string' && result.signal !== '') {
    const hint = result.signal === 'SIGKILL' || result.signal === 'SIGTERM'
      ? '（可能是超时/OOM 被杀:128+9=137）'
      : ''
    return `信号 ${result.signal}${hint}`
  }
  return '退出码未知（既没有 code 也没有 signal）'
}

/**
 * 「软降级」判定行（2026-09-23 三轮审计 R3-C C-8）。
 *
 * 本仓近三轮的缺陷类别是"守卫静默通过"：守卫自己在 stdout 里说了「跳过 X」
 * 「未检查 Y」「退化为只看 HEAD」，而编排器对**通过**的任务只打一行 `✓ name 时间`，
 * 输出留在 `state.results` 里 ⇒ CI 摘要里永远看不到这些句子（只有失败才 dump 输出），
 * 于是"我跳过了某条判据"这类软降级永远到不了人眼。
 *
 * 判据刻意包含两类：**软跳过**（跳过/未检查/未验证/未覆盖/未证明/降级/退化为/
 * 不可达/advisory/SKIP/skipped/not checked）与**软声明**（`提示:`/`注意:` 开头的
 * 说明行 —— 本仓守卫用这两个前缀承载"本次没证明什么"）。
 * 只回显这些行（**绝不放整份日志**），见 {@link collectDegraded} —— 它的汇总范围是
 * **根守卫**（GUARDS 表），包级 check 的测试运行器噪音不计入。
 *
 * 关键词命中之后还要过一道**成功摘要/规范性表述排除**（{@link isSuccessOrNormativeLine}，
 * 2026-09-23 复审 F1）—— 否则守卫的通过摘要会被误判成降级行（实测 9 条里 5 条）。
 */
const DEGRADED_LINE = /(?:跳过|未检查|未做|未验证|未覆盖|未证明|退化为|降级|不可达|软跳过|提示[:：]|注意[:：]|advisory|\bSKIP\b|\bskipped\b|not checked)/u
/**
 * 「成功摘要」排除谓词（2026-09-23 复审 F1）。
 *
 * 为什么需要：{@link DEGRADED_LINE} 是**关键词**判据，而守卫的**通过摘要**里天然会出现
 * "跳过 / SKIP" 这些词 —— 它们表达的是「这条判据被判过了，且它断言的是'不许静默跳过'」，
 * 与"本次没判"正好相反。复审实测：一次全量 `yarn check` 的 9 条命中里 **5 条**属于这类
 * 假阳性（逐条夹具见 `scripts/verify-check-workspaces.mjs` 的 F1 回归块：日志
 * `temp/verify-guards-final/logs/C-full-check.log` 的 9 行，5 假阳 / 4 真阳）。
 * 假阳性的代价不是刷屏（有界 9 行）而是**摘要自带的话术变成假的** ——
 * "这些行说明某条判据本次没有真的判"长期与事实不符，读者会学会忽略整段，正是 C-8 想避免的事。
 *
 * 三类形态（每类都只匹配"这句话不是在报告某条判据没真的判"）：
 *   1. **成功摘要**：`PASS n ｜ FAIL m ｜ SKIP k ｜ …`（`^PASS \d+`）、计数为 0 的穷尽式
 *      汇总（`SKIP 0` / `skipped 0`）、守卫的收尾行 `OK — …`（`^OK\s*[—–-]`，以及被
 *      守卫名带着前缀的 `<guard>: OK — …`）。刻意**不**写 `^OK\b` —— `OK，但有 3 个
 *      文件未覆盖` 这种句子必须继续收进来。
 *   2. **规范性表述**：`不得跳过` / `必须 SKIP` 这类"规则该怎样"的措辞
 *      （`docs-only 不得跳过根守卫`、`环境缺失必须 SKIP 且不得报 PASS`）。
 *      刻意**不**收 `不静默` / `显式 SKIP`：真降级行的措辞正是
 *      `（可选；未给目录时显式 SKIP，不静默通过）`，收进来会把真信号一起吞掉。
 *   3. **自检注记**：守卫把"我验证过的契约"写成一行 `<期望行为> ⇒ <期望结果> ✓`
 *      （`聚合层：三项全 SKIP ⇒ exit 77 / RESULT: SKIP ✓`）。判据 = 含 `⇒` 且以 `✓`
 *      收尾；真降级行是**陈述事实**（`SKIP 未提供 --channels-repo …`），不写成期望式注记。
 *
 * 边界（认账）：这是**形态**判据，不是语义理解。某个守卫若**真的**要在 `OK —` 摘要里报告一条
 * 降级，那行必须换一种写法（例如 C-8 夹具用的 `· 跳过：…`），否则会被这里排除掉 ——
 * 边界写在此处，避免下一个人把它当缺陷重报。**不得**为了让某条真降级行进来而删谓词：
 * 正确处置是改那行的写法。
 */
const DEGRADED_SUCCESS_SUMMARY = /(?:^PASS \d+|^OK\s*[—–-]|:\s*OK\s*[—–-]|\bSKIP 0\b|\bskipped 0\b)/u
/** 「规范性表述」排除谓词 —— 见 {@link DEGRADED_SUCCESS_SUMMARY} 的第 2 类。 */
const DEGRADED_NORMATIVE = /(?:不得跳过|不得静默跳过|必须\s*SKIP|禁止跳过|不允许跳过)/u
/** 「自检注记」排除谓词 —— 见 {@link DEGRADED_SUCCESS_SUMMARY} 的第 3 类。 */
const DEGRADED_SELFCHECK_NOTE = /⇒[^⇒]*✓\s*$/u

/**
 * 这一行是不是"成功摘要 / 规范性表述 / 自检注记"（⇒ 不是降级报告）。
 * @param text - 已 trim 的输出行。
 * @returns 命中任一排除谓词即 true。
 */
function isSuccessOrNormativeLine(text) {
  return DEGRADED_SUCCESS_SUMMARY.test(text)
    || DEGRADED_NORMATIVE.test(text)
    || DEGRADED_SELFCHECK_NOTE.test(text)
}

/** 每个任务最多回显几条降级行（防某个套件刷屏）。 */
const MAX_DEGRADED_PER_TASK = 8
/** 全局最多回显几条降级行（CI 摘要必须短 —— 长日志会被 GitHub 截断中段）。 */
const MAX_DEGRADED_TOTAL = 60
/**
 * 测试运行器自身的"跳过"噪音行。
 *
 * ⚠️ 汇总范围**只取根守卫**（GUARDS 表条目的 `task.path` 非空；包级 check 没有这个字段）。
 * 实测依据：一次全量 `yarn check` 的 32 条命中里 28 条来自包级输出 —— vitest 的用例名
 * （`✓ … 如实跳过 …`）、`Tests 657 passed | 1 skipped`、`[prebuild] up to date, skipped: …`、
 * `advisor: … skipped` 这些都不是"某条判据没真的判"。把它们刷进 CI 摘要只会重演本仓踩过的
 * "日志刷爆、真信号被挤出 GitHub 截断窗口"。包级 check 的内部跳过仍可在失败路径与
 * `--full-output` 里看到。
 */
const DEGRADED_NOISE = /^(?:[✓×↓✔✗]|Test Files\b|Tests\b|Duration\b|Snapshots\b)/u

/**
 * 把一个**通过**任务（仅根守卫）的输出里的软降级行收进 `state.degraded`（有界）。
 *
 * 命中 {@link DEGRADED_LINE} **且**没有命中 {@link isSuccessOrNormativeLine} 才算降级行
 * —— 后者是 2026-09-23 复审 F1 加的成功摘要/规范性表述排除（实测把 9 条命中里的 5 条
 * 假阳性去掉，4 条真阳性一条不少）。
 * @param result - 已通过的任务结果。
 * @param state - 汇总状态。
 */
function collectDegraded(result, state) {
  if (result.task.path === undefined) return
  let taken = 0
  for (const raw of result.output.split('\n')) {
    const text = raw.trim()
    if (text === '' || DEGRADED_NOISE.test(text) || isSuccessOrNormativeLine(text) || !DEGRADED_LINE.test(text)) continue
    if (state.degraded.length >= MAX_DEGRADED_TOTAL) return
    state.degraded.push({ task: result.task.name, line: text.slice(0, 200) })
    taken += 1
    if (taken >= MAX_DEGRADED_PER_TASK) return
  }
}

/**
 * 失败任务的有界报告 —— 实现已提升为**导出的唯一实现** {@link summarizeBoundedFailure}
 * / {@link formatFailureReport}（2026-09-24 第十轮审计 C-08：`check-root-guards.mjs`
 * 的 `summarize()` 只有「头 20 + 省略 + 尾 20」、没有判定行扫描，两条门禁必须共用
 * 同一份口径）。这里保留薄包装，调用点语义不变。
 * @param output - the task's captured stdout+stderr.
 * @returns the bounded report.
 */
function summarizeFailure(output) {
  return formatFailureReport(output)
}

/**
 * Run git and report **both** its stdout and whether it succeeded.
 *
 * The old version discarded stderr and the exit code and resolved stdout
 * whatever happened, so `git diff --name-only <typo>` (exit 128, empty stdout)
 * was indistinguishable from "nothing changed": `check:fast` then ran zero
 * package checks and exited 0 — a false-green fast gate (2026-09-17 audit
 * S15-1). Callers must treat `ok === false` as a hard error.
 * @param args - git argv (without the leading `git`).
 * @returns `{ ok, out, err }`; `out`/`err` are trimmed of a trailing newline.
 */
function git(args) {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', error => resolve({ ok: false, out: '', err: error.message }))
    child.on('close', code => resolve({ ok: code === 0, out: out.trimEnd(), err: err.trimEnd() }))
  })
}

/** 本次工作区相对 `ref` 的改动文件列表(含未跟踪文件)。 */
async function changedFiles(ref) {
  // 先确认 ref 可解析:`--changed <typo>` / 浅克隆 / detached HEAD 下
  // `git diff` 会失败,失败被当成"没有改动"就是假绿,所以这里 fail loud。
  const resolved = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!resolved.ok) {
    return {
      error: `--changed 的 ref 无法解析:${JSON.stringify(ref)}${resolved.err ? `(${resolved.err})` : ''}` +
        ' —— 请确认它存在于本仓库(例如 origin/master)。拒绝把"算不出改动"当成"没有改动"。',
    }
  }
  const tracked = await git(['diff', '--name-only', ref])
  if (!tracked.ok) return { error: `git diff --name-only ${ref} 失败:${tracked.err || `退出码非 0`}` }
  const untracked = await git(['ls-files', '--others', '--exclude-standard'])
  if (!untracked.ok) return { error: `git ls-files --others 失败:${untracked.err || `退出码非 0`}` }
  const files = [...new Set([...tracked.out.split('\n'), ...untracked.out.split('\n')].map(s => s.trim()).filter(Boolean))]
  return { files }
}

/** 把改动文件映射为需要重跑的包 + 是否需要跑根守卫。 */
function selectByChanges(files) {
  const selected = new Set()
  let global = false
  for (const file of files) {
    const owner = PATH_OWNERS.find(([prefix]) => file.startsWith(prefix))
    if (owner !== undefined) {
      selected.add(owner[1])
      continue
    }
    if (GLOBAL_PREFIXES.some(prefix => file.startsWith(prefix))) global = true
  }
  if (global) {
    for (const pkg of PACKAGES) selected.add(pkg.name)
    return { selected: [...selected], global }
  }
  // 反向依赖:desktop 改动波及依赖其类型的包
  for (const name of [...selected]) {
    for (const dependent of DEPENDENTS[name] ?? []) selected.add(dependent)
  }
  return { selected: [...selected], global }
}

/* ===========================================================================
 * **共享实现**（R11-I1）：守卫子进程环境清洗 + 守卫执行体入口。
 *
 * 为什么放在**编排器**里（而不是运行器）：本文件是两者共同的下游依赖 ——
 * `check-root-guards.mjs` 早就 `import { formatFailureReport } from './check-workspaces.mjs'`，
 * 所以共享实现放这里不会引入新的 import 环；反过来（运行器放实现、编排器 import）会让
 * 任何**只拷贝编排器**的合成树（`verify-check-workspaces.mjs` 的 `buildTree`）加载失败
 * （实测：ERR_MODULE_NOT_FOUND × 87 条断言）。方向是判据逼出来的，不是偏好。
 *
 * 判据面见 `scripts/check-guard-parser-integrity.mjs` 的「执行体入口」段：
 * 两个 runner 都必须走这一份清洗、守卫必须直接 spawn（真子进程 + 必失败的 corepack 桩证明）。
 * ======================================================================== */

/**
 * 交给守卫子进程的**危险键族**（2026-09-24 第十轮审计 D-03 的后半条）。
 *
 * 现场（审计方实跑）：在被钉步骤的**步骤体**里加一行
 * `export NODE_OPTIONS="--import=data:text/javascript,process.on('exit',()=>{process.exitCode=0})"`
 * 之后，`check-workflows` 一个字都不报（它只看 YAML 的 `env:`），而真跑这条命令时
 * 16 个根守卫**全部"跑而恒绿"**：`runGuard()` 的 `env: { ...process.env, FORCE_COLOR: '0' }`
 * 把 `NODE_OPTIONS` **原样透传**给每个守卫子进程，注入的退出钩子在守卫进程退出时把
 * `process.exitCode` 改回 0。实测：同一条命令在有 1 项违规的树上打印「1 项未通过」却 EXIT=0。
 *
 * 这是本文件的第二道收口（第一道在 `scripts/check-workflows.mjs` 的 [SK-17]：被钉步骤的
 * 步骤体/env 键必须登记在白名单里）。为什么"层"之外还要这一道：静态判据总会被推到下一层
 * （第八轮 argv → 第九轮进程环境 → 第十轮步骤体），而**清洗交给子进程的环境**与"层"无关。
 *
 * 语义：**键名在危险族里、又不在 `GUARD_CHILD_ENV_ALLOWED` 登记表里 ⇒ 丢弃**（fail-closed：
 * 认不出的一律丢）。不在危险族里的键照常透传（`CHECK_CONCURRENCY` / `PG_DSN_TEST` /
 * 各种 token 都靠它）。`HOME` / `XDG_CACHE_HOME` 刻意**不**在这里丢：守卫要靠真实 HOME
 * 找到 git/pg 配置与 corepack 缓存，丢掉它们会让门禁在本机直接跑不起来 —— 它们的入口
 * （`COREPACK_HOME` 那条链）由静态白名单封住。
 */
const GUARD_CHILD_ENV_DENIED_PREFIXES = ['NODE_', 'BASH_', 'LD_', 'COREPACK_', 'YARN_', 'NPM_CONFIG_', 'npm_config_']
/** 精确匹配的危险键（不带前缀的形态）。 */
const GUARD_CHILD_ENV_DENIED_KEYS = [
  'ENV', // POSIX sh 的启动文件（与 BASH_ENV 同族）
  'SHELLOPTS',
  'BASHOPTS',
  'PROMPT_COMMAND',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
]
/**
 * 允许**透传**的危险族键（登记制：每条带理由，当前为空）。
 *
 * 加一条 = 明确承认"这个键会被守卫子进程继承"，必须在同一个 PR 里写清为什么它不会
 * 改变判据结论。空表是 fail-closed 的默认形态。
 */
const GUARD_CHILD_ENV_ALLOWED = []

/**
 * 清洗交给守卫子进程的环境（第十轮审计 D-03）：丢弃危险族里未登记的键。
 *
 * @param env - 源环境（缺省 `process.env`）。
 * @returns `{ env, dropped }`（`dropped` = 被丢掉的键名，按字母序；用于打印证据）。
 */
export function sanitizeGuardEnvironment(env = process.env) {
  const allowed = new Set(GUARD_CHILD_ENV_ALLOWED.map(entry => entry.key))
  const cleaned = {}
  const dropped = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== 'string' || key === '') continue
    const risky = GUARD_CHILD_ENV_DENIED_KEYS.includes(key)
      || GUARD_CHILD_ENV_DENIED_PREFIXES.some(prefix => key.startsWith(prefix))
    if (risky && !allowed.has(key)) {
      dropped.push(key)
      continue
    }
    cleaned[key] = value
  }
  dropped.sort()
  return { env: cleaned, dropped }
}

/**
 * 本进程自己的环境里有没有"能改写解释器行为"的键（同族的上游证据）。
 *
 * 只用来**打印警告**：注入的 `--import` 钩子在模块求值之前就已经加载了，任何进程内检查
 * 都无法把它卸载。真正让结论可信的是两件事（都在下面）：
 *   ① 子进程环境清洗 —— 守卫本身跑在干净环境里，它们的判定是真的；
 *   ② 显式且加固的退出路径（`process.removeAllListeners('exit')` + `process.exit(code)`）。
 * 诚实边界：如果钩子**改写了 `process.exit`/`process.reallyExit` 本身**，进程内没有任何
 * 办法自证（实测：`process.exit = () => {}` 之后连 `process.exit(1)` 都是 no-op）——
 * 那正是静态白名单（[SK-17] 判据面）必须存在的原因，不能靠运行期兜。
 *
 * @param env - 源环境（缺省 `process.env`）。
 * @returns 命中的键名（按字母序）。
 */
export function contaminatedRunnerKeys(env = process.env) {
  const { dropped } = sanitizeGuardEnvironment(env)
  return dropped
}

/* ---------------------------------------------------------------------------
 * 执行体入口（2026-09-24 第十一轮审计 I1 泳道 · P0-1）：守卫**不经 yarn** 起，
 * 且"能不能经 yarn"这件事本身有判据。
 *
 * ## 现场（审计方实测，本仓第十轮修复看不见）
 *
 * `.yarnrc.yml` 里加三行 `plugins:` + 一个 `.yarn/plugins/*.cjs`（`.gitignore:4` 的
 * `!.yarn/plugins` 让它可提交），插件钩子 `wrapScriptExecution` 在 **yarn 进程内部**
 * 往每个被 spawn 的脚本环境里塞 `NODE_OPTIONS=--import=<退出钩子>`（+ `BASH_ENV`）：
 * `corepack yarn check` 从 EXIT=1 → **EXIT=0**（「32 通过、0 失败」），
 * `node scripts/check-root-guards.mjs` 从 `3 通过、14 失败` → **`17 通过、0 失败`**，
 * workflow 一个字节都没改。为什么第十轮两道收口都没拦住：
 *   · `[SK-17]` 白名单判的是 **workflow 文本**（这里没改 workflow）；
 *   · `sanitizeGuardEnvironment()` 清洗的是"**runner 交给 `corepack yarn` 的那份环境**"，
 *     而注入发生在 yarn 进程内部、在它 spawn 脚本时才写进子进程环境 ⇒ 清洗已经跑完了
 *     （攻击态日志照样打印「子进程环境已清洗 —— 丢弃 0 个」）。
 *
 * ## 两条收口（缺一条就还有一条通道）
 *
 * ① **不经 yarn**：守卫是仓内脚本（`node scripts/x.mjs` / `bash scripts/x.sh`），
 *    直接 spawn 即可 —— 少一个进程、少一层 shell，也少一个"能改写解释器"的注入点。
 *    `yarn run` 的语义由 `package.json` 的脚本体显式解析（与运行器已有的
 *    `guardScriptProblem` 登记校验同源）。
 * ② **回落路径有判据**：登记脚本文件**不存在**时（合成/探针树：真实实现 + 合成脚本体）
 *    才回落到 `corepack yarn run <name>`，且回落之前必须先过 `yarnEntryTrustProblems()`
 *    —— `.yarnrc.yml` 的 `yarnPath`/`plugins`、`.yarn/plugins/**` 与 `.yarn/releases/**`
 *    的落地文件、`package.json` 的生命周期钩子，任一命中就**当场判这条守卫失败**。
 *    没有这一条，"删掉守卫脚本 + 装插件"就能把守卫换成恒绿的空壳（注入的退出钩子会把
 *    `MODULE_NOT_FOUND` 的退出码改写成 0）。
 * ------------------------------------------------------------------------- */

/**
 * `.yarnrc.yml` 里"谁能解释/执行脚本"的禁键（出现即问题；登记制在 `check-guard-parser-integrity.mjs`）。
 *
 * 导出是为了让两侧**互相**可对拍：本列表是"经 yarn 可信吗"的前置检查用的，
 * `check-guard-parser-integrity.mjs` 的 `REGISTERED_YARN_CONFIGURATION.forbiddenKeys` 是
 * 登记制用的（带理由）—— 两边漂移就会出现"回落被拦、登记制放行"（或反之）的裂缝。
 */
export const YARN_ENTRY_FORBIDDEN_KEYS = [
  'yarnPath', // 换掉整个 yarn（一行 `yarnPath: ./noop.cjs` 就能让 install 与全部门禁空转）
  'plugins', // 插件钩子 `wrapScriptExecution` 在 yarn 进程内部改写脚本环境（本轮 P0-1 的现场）
]
/** 根 `package.json` 里"安装期代码执行"的钩子名（登记制在 `check-guard-parser-integrity.mjs`；导出理由同 `YARN_ENTRY_FORBIDDEN_KEYS`）。 */
export const YARN_LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
]
/** `.yarn/` 下"可提交 + 会被 yarn 当代码读"的目录（`!.yarn/plugins` / `!.yarn/releases` 让它们进得了仓）。 */
const YARN_CODE_DIRECTORIES = ['.yarn/plugins', '.yarn/releases']

/**
 * `.yarnrc.yml` 的**顶级键**（不 import `yaml`：入口判据不能依赖一个可被 `resolutions`
 * 改写的解析器 —— 那正是 `check-guard-parser-integrity.mjs` 登记 `node_modules/yaml` 的理由）。
 *
 * 只认"从第 0 列开始、`key:` 形态"的行：`.yarnrc.yml` 里嵌套键都带缩进，因此顶级键与
 * 嵌套键不会混。解析不出来（不是缩进形态）= 少读一个键，而少读 = 判据静默变窄，
 * 所以调用方要按"键集合必须非空"使用它。
 * @param text - `.yarnrc.yml` 的正文。
 * @returns 顶级键名（按出现顺序，可重复）。
 */
/**
 * 取 `.yarnrc.yml` 里某个**顶级键**的标量取值（`key: value` 形态；取不到返回 `null`）。
 *
 * 只认未加引号的裸标量（`enableScripts: false` / `nodeLinker: node-modules`）：本仓的
 * 入口判据只需要判这两个值，做完整的 YAML 解析会把判据交给可被 `resolutions` 改写的解析器。
 * 解析不出来（带引号/块标量/多行）= `null` ⇒ 取值判据红（fail-closed：认不出不算通过）。
 * @param text - `.yarnrc.yml` 正文。
 * @param key - 顶级键名。
 * @returns 标量字符串或 `null`。
 */
export function yarnrcScalarValue(text, key) {
  for (const line of String(text).split('\n')) {
    const match = new RegExp(`^${key}\\s*:\\s*(\\S+)\\s*$`, 'u').exec(line)
    if (match !== null) return match[1]
  }
  return null
}

export function yarnrcTopLevelKeys(text) {
  const keys = []
  for (const line of String(text).split('\n')) {
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    const match = /^([A-Za-z_][\w-]*)\s*:/u.exec(line)
    if (match !== null) keys.push(match[1])
  }
  return keys
}

/**
 * "经 yarn 起脚本"这条路**可信吗**（R11 P0-1 的回落前置判据）。
 *
 * 只判"谁能解释/执行脚本"这三面：`.yarnrc.yml` 的入口键、`.yarn/**` 下的可提交代码目录、
 * 根 `package.json` 的生命周期钩子。**不判**普通依赖/缓存配置（那些改不了判据结论）。
 *
 * @param rootDir - 仓库根（探针树会传自己的根）。
 * @returns 问题清单（空 = 可信）。
 */
export function yarnEntryTrustProblems(rootDir = ROOT) {
  const problems = []
  const rcPath = join(rootDir, '.yarnrc.yml')
  if (existsSync(rcPath)) {
    const stats = lstatSync(rcPath)
    if (stats.isSymbolicLink()) {
      problems.push('.yarnrc.yml 是一个符号链接（内容来自仓外 ⇒ 入口不可信）')
    } else if (stats.isFile()) {
      const keys = yarnrcTopLevelKeys(readFileSync(rcPath, 'utf8'))
      if (keys.length === 0) {
        problems.push('.yarnrc.yml 读不出任何顶级键（解析面失效 ⇒ 拒绝把"读不出"当成"没有"）')
      }
      for (const key of YARN_ENTRY_FORBIDDEN_KEYS) {
        if (keys.includes(key)) {
          problems.push(`.yarnrc.yml 里有 \`${key}\`（${key === 'yarnPath'
            ? '换掉整个 yarn：一行 diff 就能让 install 与全部门禁空转'
            : '插件钩子：在 yarn 进程内部改写被 spawn 脚本的环境（NODE_OPTIONS/BASH_ENV）'}）`)
        }
      }
    } else {
      problems.push('.yarnrc.yml 不是常规文件')
    }
  }
  for (const relative of YARN_CODE_DIRECTORIES) {
    const directory = join(rootDir, relative)
    if (!existsSync(directory)) continue
    const landed = []
    const walk = current => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) walk(path)
        else landed.push(path)
      }
    }
    walk(directory)
    if (landed.length > 0) {
      problems.push(`${relative}/ 下有 ${landed.length} 个文件（可提交 + 会被 yarn 当代码读）：`
        + landed.slice(0, 3).map(path => path.slice(rootDir.length + 1)).join('、')
        + `${landed.length > 3 ? ' …' : ''}`)
    }
  }
  const manifestPath = join(rootDir, 'package.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const hooks = Object.keys(manifest?.scripts ?? {}).filter(name => YARN_LIFECYCLE_HOOKS.includes(name))
      if (hooks.length > 0) {
        problems.push(`根 package.json 有安装期生命周期钩子：${hooks.join('、')}`
          + '（`enableScripts: false` 只挡依赖的构建脚本，**挡不住根 workspace 自己的 postinstall**'
          + ' —— 它在 `yarn install` 期就能改写守卫脚本与内容摘要登记值）')
      }
    } catch (error) {
      problems.push(`根 package.json 解析失败：${error?.message ?? String(error)}`)
    }
  }
  return problems
}

/**
 * 把登记脚本命令（`node scripts/x.mjs` / `bash scripts/x.sh`）解析成可直接 spawn 的 argv。
 * @param script - `REGISTERED_GUARD_ENTRIES` 里的 `script` 取值。
 * @param rootDir - 仓库根。
 * @returns `{ command, argv, scriptPath, problem }`。
 */
export function resolveGuardCommand(script, rootDir = ROOT) {
  const match = /^(node|bash)\s+(scripts\/\S+)$/u.exec(typeof script === 'string' ? script.trim() : '')
  if (match === null) {
    return {
      command: null,
      argv: [],
      scriptPath: null,
      problem: `登记的脚本命令 ${JSON.stringify(script)} 不是 \`node scripts/…\` / \`bash scripts/…\` 形态`,
    }
  }
  const interpreter = match[1] === 'node' ? process.execPath : 'bash'
  return { command: interpreter, argv: [join(rootDir, match[2])], scriptPath: join(rootDir, match[2]), problem: null }
}

/**
 * **唯一的"经 yarn 起守卫"实现**（窄回落；只给"没有可执行的脚本文件/脚本体"的合成树用）。
 *
 * 为什么回落也要收在一处：它是**唯一**还经 yarn 的守卫通道，所以它的前置判据
 * （`yarnEntryTrustProblems()`）必须与调用方无关地生效 —— 调用方有两条：
 *   · 本文件的 `runTask()`（根 package.json **没有**这条守卫的脚本体：合成/探针树的形态）；
 *   · `check-root-guards.mjs` 的 `spawnRegisteredGuard()`（登记脚本文件不存在）。
 * 两条都必须先过同一个可信检查，否则 `删掉执行体 + 装插件` 就能把守卫换成恒绿的空壳。
 * @param name - 守卫名（`corepack yarn run <name>`）。
 * @param argvTail - 参数尾。
 * @param options - `{ env, cwd, started }`。
 * @returns `{ ok, ms, output, code, signal }`。
 */
export function spawnYarnFallbackGuard(name, argvTail, options = {}) {
  const cwd = options.cwd ?? ROOT
  const trust = yarnEntryTrustProblems(cwd)
  if (trust.length > 0) {
    return Promise.resolve({
      ok: false,
      ms: 0,
      output: `check-workspaces: 「经 yarn 起守卫」这条路不可信（守卫 ${name} 没有可执行的脚本）：\n`
        + trust.map(problem => `      · ${problem}`).join('\n')
        + '\n      ⇒ 拒绝回落。判据来源：R11 审计 I1 泳道 P0-1'
        + '（`yarnPath`/`plugins`/生命周期钩子都能在 yarn 进程内部改写守卫子进程的环境，'
        + '注入的退出钩子会把"跑不起来"的退出码改写成 0）。',
      code: null,
      signal: null,
    })
  }
  return spawnGuardChild('corepack', ['yarn', 'run', name, ...argvTail], {
    cwd,
    env: { ...(options.env ?? {}), FORCE_COLOR: '0', YARN_IGNORE_PATH: '1' },
    started: options.started ?? Date.now(),
  })
}

/**
 * **唯一的"起一条守卫"实现**（本轮 P0-1 ①；两个 runner 共用，见 `check-workspaces.mjs` 的 `runTask`）。
 *
 * @param script - 登记的脚本命令（`node scripts/x.mjs` / `bash scripts/x.sh`）。
 * @param argvTail - 登记的参数尾（`REGISTERED_GUARD_ENTRIES[*].argvTail`）。
 * @param options - `{ env, cwd, name }`（`env` 必须是 `sanitizeGuardEnvironment()` 的结果；
 *   `name` 只用于"脚本文件不存在"时的 yarn 回落）。
 * @returns `{ ok, ms, output, code, signal }`。
 */
export function spawnRegisteredGuard(script, argvTail, options = {}) {
  const cwd = options.cwd ?? ROOT
  const env = { ...(options.env ?? sanitizeGuardEnvironment().env), FORCE_COLOR: '0' }
  const started = Date.now()
  const resolved = resolveGuardCommand(script, cwd)
  if (resolved.problem !== null) {
    return Promise.resolve({
      ok: false,
      ms: 0,
      output: `check-root-guards: ${resolved.problem}`,
      code: null,
      signal: null,
    })
  }
  // 回落（只在登记脚本文件不存在时）：合成/探针树用真实实现 + 合成脚本体（corepack 桩），
  // 那时文件本来就不存在。回落的前置判据与被复用的实现都在 `spawnYarnFallbackGuard()` 里。
  if (!existsSync(resolved.scriptPath)) {
    return spawnYarnFallbackGuard(options.name ?? '', argvTail, { cwd, env, started })
  }
  return spawnGuardChild(resolved.command, [...resolved.argv, ...argvTail], { cwd, env, started })
}

/**
 * 真正 spawn 一个守卫子进程并收集输出。
 * @param command - 可执行文件。
 * @param argv - 参数向量。
 * @param options - `{ cwd, env, started }`。
 * @returns `{ ok, ms, output, code, signal }`。
 */
function spawnGuardChild(command, argv, options) {
  return new Promise(resolveTask => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: options.env,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => {
      resolveTask({
        ok: false,
        ms: Date.now() - options.started,
        output: `${output}\n${String(error)}`,
        code: null,
        signal: null,
      })
    })
    child.on('close', (code, signal) => {
      resolveTask({ ok: code === 0, ms: Date.now() - options.started, output, code, signal })
    })
  })
}

/* ---------------------------------------------------------------------------
 * 运行器**自己**的环境可信吗（R11 P0-1 的第三道收口）。
 *
 * 上面两条关的是"守卫子进程"，这一条关的是"**运行器本身**的判决"：`--import` 注入的
 * 退出钩子在**模块求值之前**就装好了，进程内卸不掉；实测同一个钩子能把
 * `process.exitCode = 0`（EXIT=0）、`process.exit(3)`（EXIT=0）都改写掉 ——
 * 而 `yarn check` 这条路径上的编排器**就是被 yarn spawn 的**，插件注入的首当其冲者正是它。
 *
 * 所以：**自己环境里有"能改写本进程解释器行为"的键 ⇒ 拒绝运行**（fail-closed），结束走
 * `endUninterceptably()`（SIGKILL → abort → reallyExit → **不返回**：结构上不依赖任何
 * "抛异常"，见其注释 —— 第十一轮复审 J1 的 N1 就是旧版那句"以 SIGKILL 兜底"**结构上不可达**：
 * 兜底挂在 `catch` 里，而"被换掉的 `reallyExit`"不抛）。
 *
 * 判定面按**能力**而不是**键名**：`NODE_OPTIONS` 只在内容含未登记旗标时才命中
 * （`--max-old-space-size` 这类正当用法不再被拒跑；J1 的 N3）。
 *
 * 为什么不是"警告后继续"：判决被改写的进程**说不出真话**。第十轮把 `contaminatedRunnerKeys()`
 * 停在 WARNING 是对的（它覆盖的那些键多数只影响子进程），但解释器族（本列表）不同 ——
 * 它们能在本进程里执行任意代码。诚实边界（认账）：钩子若同时改写
 * `process.exit`/`reallyExit`/`kill`/`abort`，**进程内无解**（那时最后一层是"阻塞不返回"）；
 * 所以判定权上移到父进程 —— 只有 `VERDICT PASS（计划 == 实跑 > 0）`那一行才算通过，
 * 而拒绝运行的进程永远不打印它。更外层的静态面是 `check-workflows.mjs` 的 [SK-17] 与
 * `.yarnrc.yml` 登记制（`check-guard-parser-integrity.mjs`）。
 * ------------------------------------------------------------------------- */

/** 能在**本进程内**执行代码/替换解释器的键（命中 ⇒ 拒绝运行；与 `contaminatedRunnerKeys()` 的宽清单不同）。 */
export const RUNNER_TRUST_BREAKING_KEYS = [
  'NODE_OPTIONS', // --import/--require/--loader：模块求值之前执行任意代码（**按内容**判，见下）
  'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD', // 动态链接器：任何二进制（含 node 自己）
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
]

/**
 * `NODE_OPTIONS` 里**允许**留在 runner 自己环境里的旗标（登记制，逐条带理由）。
 *
 * 为什么要有这张表（第十一轮复审 J1 的 N3）：`NODE_OPTIONS` **本身不是代码执行** ——
 * 执行代码的是它携带的 `--import`/`--require`/`--loader` 一类旗标。把整个键一律当
 * "拒绝运行"，会让**正当用法**（`NODE_OPTIONS=--max-old-space-size=8192 corepack yarn check`：
 * 大仓库 / 低内存机器的常规做法）直接变成 EXIT=2，连 `--list` 都跑不了 —— 那是把 fail-closed
 * 用在了**键名**而不是**能力**上，代价是逼着人去掉一个与判据可信度无关的开关。
 *
 * 取向与 [SK-17] 的键白名单一致：**只登记"证明改不了解释器行为"的旗标**，
 * 一条没登记（含拼错、含 `--import=`、含无法识别的取值形态）⇒ 整个 `NODE_OPTIONS` 按危险处理。
 */
export const NODE_OPTIONS_BENIGN_FLAGS = [
  { pattern: /^--max-old-space-size=\d+$/u, why: 'V8 老生代上限（GC 阈值）' },
  { pattern: /^--max-semi-space-size=\d+$/u, why: 'V8 新生代上限（GC 阈值）' },
  { pattern: /^--max-http-header-size=\d+$/u, why: 'HTTP 头大小上限' },
  { pattern: /^--stack-size=\d+$/u, why: 'V8 栈大小' },
  { pattern: /^--stack-trace-limit=\d+$/u, why: '栈帧打印条数' },
  { pattern: /^--heapsnapshot-near-heap-limit=\d+$/u, why: '接近堆上限时导出快照（诊断面）' },
  { pattern: /^--v8-pool-size=\d+$/u, why: 'V8 线程池大小' },
  { pattern: /^--no-warnings$/u, why: '关掉进程警告输出（纯打印面）' },
  { pattern: /^--enable-source-maps$/u, why: '栈帧按 sourcemap 展开（纯打印面）' },
  { pattern: /^--trace-warnings$/u, why: '打印警告栈（纯打印面）' },
  { pattern: /^--disable-warning=[A-Za-z0-9_]+$/u, why: '关掉指定警告码（纯打印面）' },
]

/**
 * `NODE_OPTIONS` 的**内容**判定（第十一轮复审 J1 的 N3）。
 *
 * 按空白切词后逐条比对登记表。诚实边界：Node 自己解析 `NODE_OPTIONS` 时有引号剥离规则，
 * 这里不做同一套解析 —— 含引号/空格的取值会被切成匹配不上任何登记的碎片 ⇒ 落到
 * "未登记 ⇒ 按危险处理"，方向仍是 fail-closed（宁可拒跑，也不放行一个读不懂的取值）。
 * @param value - `NODE_OPTIONS` 的取值。
 * @returns `null` = 每个旗标都在登记表里；否则是"为什么按危险处理"的一句诊断。
 */
export function nodeOptionsTrustProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  for (const flag of value.trim().split(/\s+/u)) {
    if (NODE_OPTIONS_BENIGN_FLAGS.some(entry => entry.pattern.test(flag))) continue
    const benign = NODE_OPTIONS_BENIGN_FLAGS
      .map(entry => entry.pattern.source.replace(/^\^|\$$/gu, ''))
      .join(' / ')
    return `\`NODE_OPTIONS\` 里的 \`${flag}\` 不在登记表里（已登记：${benign}）—— `
      + '`--import`/`--require`/`--loader` 一类旗标在模块求值之前执行任意代码，'
      + '它能改写本进程的退出码与每一条判据的结论'
  }
  return null
}

/**
 * 本进程环境里"能改写本进程解释器行为"的键。
 * @param env - 源环境（缺省 `process.env`）。
 * @returns 命中的键名（按字母序；`NODE_OPTIONS` 只在**内容**含未登记旗标时命中）。
 */
export function runnerTrustProblems(env = process.env) {
  const hits = []
  for (const key of RUNNER_TRUST_BREAKING_KEYS) {
    const value = env[key]
    if (typeof value !== 'string' || value === '') continue
    // `NODE_OPTIONS` 是**唯一**按内容判的键：`--max-old-space-size` 这类旗标改不了解释器行为
    // （N3 的现场），而 `--import=…` 改得了 ⇒ 判据落在旗标上，不落在键名上。
    if (key === 'NODE_OPTIONS' && nodeOptionsTrustProblem(value) === null) continue
    hits.push(key)
  }
  // `BASH_FUNC_<name>%%`：bash 的导出函数。我们（以及 yarn 的 shell）起的 bash 会被
  // 同名函数替换 ⇒ `node` 也可能变成攻击者的壳。
  for (const key of Object.keys(env)) {
    if (key.startsWith('BASH_FUNC_')) hits.push(key)
  }
  return [...new Set(hits)].sort()
}

/**
 * **不可被"抛不抛"决定的**结束路径（第十一轮复审 J1 的 N1，P0）。
 *
 * 旧实现的现场（审计方两行载荷实测）：`process.reallyExit(2)` 放在 `try` 里，而**只有它
 * `throw`** 才走到 `process.kill(pid,'SIGKILL')` 兜底；攻击载荷的 `--import` 钩子同时把
 * `process.reallyExit` 覆写成一个"正常退出 0"的函数（不抛）⇒ 兜底永不执行 ⇒ 判决不可信的
 * 进程说出了"通过"（`corepack yarn check` / `check-root-guards` 实测 EXIT=**0**，日志里
 * 连"计划/实跑 N 个任务"都没有）。
 *
 * 现在的结构：结束路径**不依赖任何"抛异常"**，四层依次尝试，且**永不给调用方返回值**：
 *   ① `SIGKILL` —— 信号处置在**内核**里：没有处理器、不能阻塞、不能忽略，JS 钩子改不了它的
 *      语义（能改的只有"谁来发这个信号"，即下面 ②③ 存在的理由）；
 *   ② `process.abort()` —— 与 `kill` 完全不同的原生入口（SIGABRT + 崩溃报告）；
 *   ③ `process.reallyExit(code)` —— 不触发 `exit` 事件（`process.on('exit', …)` 钩子改不了它）；
 *   ④ **不返回**：前三层若都被换掉，本函数宁可阻塞（`Atomics.wait` 无超时 ⇒ 零 CPU 占用，
 *      父进程/CI 的超时会判红）也绝不回到调用方 —— 回到调用方就意味着进程可能继续跑完并打印
 *      "通过"。**fail-closed 的最后形态是"说不出话"，不是"说不确定"。**
 *
 * 诚实边界（认账，与 J1 的 N1 修法要求一致）：`process.kill`/`process.abort`/`process.reallyExit`
 * 都是 JS 可见属性，同一个钩子理论上能把三个一起换掉 —— **进程内做不到绝对**。所以判定权
 * 必须上移到父进程：编排器的 `main()` 只在"实跑数 == 计划数 > 0"时打印唯一那行
 * `VERDICT PASS`，而被拒绝的进程**在打印它之前**就结束（见 `refuseUntrustedRunner`）。
 * 父进程/CI 只要认那一行（而不是认退出码），这道闸门就不再由被审进程自己说了算。
 * @param code - 期望的退出码（只在 ③ 那一层用得上）。
 */
export function endUninterceptably(code) {
  process.removeAllListeners('exit')
  process.removeAllListeners('beforeExit')
  try {
    // ① 内核发的 SIGKILL：唯一与 JS 钩子无关的一刀。
    process.kill(process.pid, 'SIGKILL')
  } catch {
    // `process.kill` 本身被换掉时会落到 ②。
  }
  try {
    // ② 另一个原生入口（SIGABRT）。只在 ① 没杀死我们时才可达。
    process.abort()
  } catch {
    // 同上，落到 ③。
  }
  try {
    // ③ 不触发 `exit` 事件（`process.on('exit', () => { process.exitCode = 0 })` 改不了它）。
    process.reallyExit(code)
  } catch {
    // 三层都被换掉 ⇒ 落到 ④：不返回。
  }
  // ④ 宁可阻塞也不返回。`Atomics.wait` 无超时参数 ⇒ 永久等待（不烧 CPU），
  //    父进程/CI 的超时会把它判成失败 —— 而它永远不会打印"通过"。
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  } catch {
    // SharedArrayBuffer/Atomics 不可用（理论上不会）：退化成自旋，仍然不返回。
  }
  for (;;) {
    // 有意为空：这是"说不出通过"的最后形态。
  }
}

/**
 * 拒绝运行（判决不可信的进程必须**说不出"通过"**）。
 *
 * 输出用 `writeSync` 同步写（进程会立刻死，异步写会被丢掉 —— 那时日志里只剩一个"被信号杀死"，
 * 指不到病根）；结束走 `endUninterceptably()`（结构上不依赖任何"抛异常"，见其注释）。
 * @param subject - 打印前缀（`check-root-guards` / `check-workspaces`）。
 * @param problems - `runnerTrustProblems()` 的结果。
 * @returns 不返回（进程在此结束；被 import 时同样不返回 —— 调用方只在入口路径上调它）。
 */
export function refuseUntrustedRunner(subject, problems) {
  const message = [
    `${subject}: 拒绝运行 —— 本进程自己的环境里有"能改写解释器/退出码"的键：${problems.join('、')}`,
    '  为什么不是警告后继续：这类键（`--import` 钩子 / 动态链接器预载 / `BASH_FUNC_*`）在**本进程内**',
    '  执行代码，能把下面每一条判据的退出码改写成 0 —— 实测 `NODE_OPTIONS=--import=<exit-hook>` 让',
    '  `corepack yarn check` 从 EXIT=1 变成 EXIT=0（R11 审计 I1 泳道 P0-1）。判决不可信的进程不许说"通过"。',
    '  处置：清掉这些键再跑（例：`env -u NODE_OPTIONS -u BASH_ENV corepack yarn check`）；',
    '  CI 侧由 `scripts/check-workflows.mjs` 的 [SK-17]（被钉单元的 env/步骤体白名单）拦住注入面。',
    '  结束方式（J1 复审的 N1 修复）：SIGKILL → abort → reallyExit → **不返回**，四层依次尝试；',
    '  退出路径不依赖任何"抛异常"（旧的 `try { reallyExit } catch { kill }` 结构可以被"把',
    '  `reallyExit` 换成正常返回"的两行钩子整条绕过，实测 EXIT=0）。',
    '  ⇒ 本进程**不会**打印通过凭据（`main()` 末尾那一行只在"实跑数 == 计划数 > 0"时打印）：',
    '  父进程/CI 侧请以那一行为准，不要以退出码为准。',
  ].join('\n')
  try {
    writeSync(2, `${message}\n`)
  } catch {
    // 同步写失败（fd 2 被关）不改变结论方向：下面照样以不可改写的方式退出。
  }
  endUninterceptably(2)
}

/**
 * 失败详情（**判定行扫描 + 有界输出**）—— 这里**没有**本地实现（第十轮复审 V1 的 P1）。
 *
 * 历史：本文件曾有一份自己的 `summarize()`（"头 20 + `…（省略 N 行）` + 尾 20"），它把
 * 落在中段的真判定行整条丢掉 —— 独立探针实测判定行出现次数 **0**；而同一段输出交给
 * 编排器的共享实现 `formatFailureReport` 时出现 **1** 次。本文件是 docs-only PR 的
 * **唯一**防线，它的失败详情看不见等于那条防线没有诊断面。
 *
 * 唯一实现 `formatFailureReport` 由 `check-workspaces.mjs` 导出（短输出仍然逐字原样）；
 * 它的口径是：判定行（行首锚定、**先剥离 ANSI**）优先、尾窗兜底、进度噪声只计数不占预算。
 */

/**
 * 起一个任务 —— **两条通道**（2026-09-24 第十一轮审计 I1 泳道 P0-1/P1-2）。
 *
 * · 根守卫（`kind: 'guard'`）→ `spawnRegisteredGuard()`：**不经 yarn**。
 *   为什么：`.yarnrc.yml` 的插件钩子 `wrapScriptExecution` 在 **yarn 进程内部**改写被
 *   spawn 脚本的环境（`NODE_OPTIONS=--import=<退出钩子>` / `BASH_ENV`），而第十轮加的
 *   `sanitizeGuardEnvironment()` 清洗的是「交给 `corepack yarn` 的那份环境」 —— 注入发生在
 *   清洗**之后**（实测：`yarn check` EXIT 1→0、`check-root-guards` 3 通过/14 失败 → 17 通过/0 失败）。
 * · 包级 check → 仍走 `corepack yarn`（真实构建链绕不开），环境**原样继承本进程**（第十一轮
 *   复审 J1 的 N3：清洗只作用于守卫通道）+ `YARN_IGNORE_PATH=1`。
 *
 *   **`YARN_IGNORE_PATH=1` 的作用边界**（N4 的订正，旧注释在这里写错过）：它只对"本编排器
 *   已经启动起来、由它 spawn 的那些 `yarn`"生效。`corepack yarn check` **入口的那个 yarn**
 *   读的是仓内 `.yarnrc.yml` —— 一旦那里有 `yarnPath`，整个 yarn 被换掉，**本文件根本不会被
 *   加载**（实测：`corepack yarn check` 只剩假 yarn 的一行输出、零任务、EXIT=0）。拦住那条路
 *   的是另外两条：(a) `gate-guards` 里**直接 spawn** 的根守卫（不经 yarn）；(b) `check-guard-parser-integrity`
 *   的 `.yarnrc.yml` 登记制。而"父进程怎么判"由 `main()` 末尾那行 `VERDICT PASS`（计划 == 实跑 > 0）
 *   兜 —— 被假 yarn 顶掉的进程永远不会打印它。
 *
 * 清洗实现唯一（`sanitizeGuardEnvironment`），接线有两处（本文件与 `check-root-guards.mjs`）——
 * 两处都由 `scripts/check-guard-parser-integrity.mjs` 的「两处都清洗」判据看着（单边拆掉即红）。
 * @param task - 任务条目（`{ name, args, kind, cwd?, path?, needs? }`）。
 * @returns 结果条目（`{ task, ok, ms, output, code, signal, spawnError? }`）。
 */
/**
 * 根 `package.json` 的 `scripts` 表（进程内缓存一次）。
 *
 * 为什么编排器需要它：守卫**不再经 yarn 起**（R11 P0-1），所以"`yarn run <name>` 会跑什么"
 * 必须自己解析 —— 唯一真源就是这一行脚本体（运行器侧的登记表与它的一致性由两条门禁对拍）。
 * @returns `Record<string, string>`（读不到时为空对象 ⇒ 守卫会 fail-loud 而不是静默跳过）。
 */
let ROOT_SCRIPTS_CACHE = null
function rootScripts() {
  if (ROOT_SCRIPTS_CACHE === null) {
    try {
      ROOT_SCRIPTS_CACHE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))?.scripts ?? {}
    } catch {
      ROOT_SCRIPTS_CACHE = {}
    }
  }
  return ROOT_SCRIPTS_CACHE
}

function runTask(task) {
  const started = Date.now()
  if (task.kind === 'guard') {
    // 清洗**只用于守卫子进程**（第十一轮复审 J1 的 N3）。为什么不是"两条通道共用一份"：
    // 清洗拦不住 P0-1 的注入（`.yarnrc.yml` 的插件钩子在 **yarn 进程内部**改写被 spawn 脚本的
    // 环境，发生在清洗**之后**），所以它拦得住的只有"本进程环境里的危险族键" —— 而那一层
    // 已经在 `main()` 的 `runnerTrustProblems()` 里按**能力**判过（含 `NODE_OPTIONS` 的内容）。
    // 把同一份清洗套在包级 check 上，代价却是真实的：`YARN_*`/`npm_config_*`/`COREPACK_*`
    // 与**正当的** `NODE_OPTIONS=--max-old-space-size=…` 一起从构建环境里消失
    // （J1 实测：连 `--list` 都变成 EXIT=2）。包级 check 因此只加 `YARN_IGNORE_PATH=1`。
    const cleaned = sanitizeGuardEnvironment(process.env)
    const script = rootScripts()[task.name]
    const tail = Array.isArray(task.args) ? task.args.slice(2) : []
    // 三条 fail-loud：脚本体缺失 / 参数里出现"会改变语义"的旗标（形态校验由
    // `spawnRegisteredGuard()` 承担）。判据来源是**根 package.json 的脚本体** ——
    // 那正是 `yarn run <name>` 的语义，而它与运行器侧登记表（`REGISTERED_GUARD_ENTRIES`）
    // 的一致性由两条门禁各自对拍：`check-root-guards.mjs`（gate-guards 路径）与
    // `verify-check-workspaces.mjs`（`yarn check` 路径里的 `check:check-workspaces` 守卫）。
    // **不 import 运行器**：合成/探针树可能只拷了本编排器（`verify-check-workspaces.mjs` 的
    // `buildTree`），import 会让那些树直接 ERR_MODULE_NOT_FOUND（实测 87 条断言）。
    const weakening = tail.filter(argument => SEMANTICS_CHANGING_FLAGS.includes(argument))
    if (typeof script !== 'string' || script.trim() === '') {
      // **没有脚本体**：合成/探针树的形态（`verify-check-workspaces.mjs` 的 `buildTree`
      // 只写 name/workspaces，守卫靠 corepack 桩），走与运行器同一条窄回落 ——
      // 回落前必须过 `yarnEntryTrustProblems()`（真实树上"没有脚本体"= yarn 直接报
      // "Couldn't find a script named …" ⇒ 守卫失败，fail-closed）。
      return spawnYarnFallbackGuard(task.name, tail, {
        cwd: task.cwd ?? ROOT,
        env: cleaned.env,
        started,
      }).then(result => ({ ...result, task }))
    }
    const problem = (weakening.length > 0
        ? `守卫 ${task.name} 的参数里有"会改变语义"的旗标 ${weakening.map(flag => `\`${flag}\``).join('、')}`
          + ' ⇒ 拒绝执行（它们让守卫**跑起来却什么都不判**）'
        : null)
    if (problem !== null) {
      return Promise.resolve({
        task,
        ok: false,
        ms: Date.now() - started,
        output: `check-workspaces: ${problem}`,
        code: null,
        signal: null,
      })
    }
    // 守卫**直接 spawn**（`process.execPath` / `bash`，不经 yarn、不经 shell）。
    return spawnRegisteredGuard(script, tail, {
      cwd: task.cwd ?? ROOT,
      env: cleaned.env,
      name: task.name,
    }).then(result => ({ ...result, task }))
  }
  return new Promise(resolve => {
    const child = spawn('corepack', ['yarn', ...task.args], {
      cwd: task.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      // 包级 check：**本进程环境原样透传**（只加 `FORCE_COLOR=0` 与 `YARN_IGNORE_PATH=1`）。
      //
      // 为什么包级仍然安全（N3 的"为什么"）：包级 check 的判据是**子进程的退出码**，而读它的
      // 是**编排器**（本进程）—— 本进程已经在 `main()` 里拒绝过"能在本进程执行代码"的键
      // （`runnerTrustProblems()`，含 `NODE_OPTIONS` 的**内容**判定）。危险族键既然进不了本进程，
      // 也就不会经由这里传给 `corepack yarn`。反过来，清洗会顺手丢掉正当配置
      // （`YARN_NODE_LINKER` / `npm_config_registry` / `COREPACK_*` / `NODE_OPTIONS=--max-old-space-size=…`），
      // 那是把"注入面收口"错做成"构建环境阉割"（J1 的 N3 实测）。
      // `YARN_IGNORE_PATH=1`：让「一行 `yarnPath` 换掉整个 yarn」在**这一层**失效（注意边界：
      // 它只对本编排器真的启动起来之后 spawn 的那些 yarn 生效；`corepack yarn check` 自己的
      // 那个 yarn 由 `.yarnrc.yml` 登记制 + `gate-guards` 的直接 spawn 拦住，见 N4 的订正）。
      env: { ...process.env, FORCE_COLOR: '0', YARN_IGNORE_PATH: '1' },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => {
      // C-15（2026-09-24 第十轮审计）：`code`/`signal` 必须一路带到失败块标题，
      // 否则「测试失败(1)」「用法错误(2)」「被信号杀(超时/OOM)」在日志里同形。
      resolve({
        task,
        ok: false,
        ms: Date.now() - started,
        output: `${output}\n${String(error)}`,
        code: null,
        signal: null,
        spawnError: String(error),
      })
    })
    child.on('close', (code, signal) => {
      resolve({ task, ok: code === 0, ms: Date.now() - started, output, code, signal })
    })
  })
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 记录一个失败任务的归属：`advisory` 任务只告警、不拦门禁。
 *
 * 为什么这个开关存在（2026-09-19）：WASM「客户端专属」的验收门禁（§13）在 W1–W5 波次
 * 落地前**按设计就是红的** —— 它的零残留断言必须如实报出存量命中（旧应用子域/换票/
 * entry_url/access=public/服务端 ai.chat）。若直接接成阻塞，`yarn check` 会在所有泳道
 * 施工期间恒红；若把它改成"没命中才算"，那条判据就退化成了摆设。
 *
 * **2026-09-23 第六轮审计 R6-C-1 起收口**：advisory 不再是条目上的一个自由字段 ——
 * 它必须先在 `ADVISORY_REGISTRY` 里逐条登记（理由/批准人/到期日），否则本编排器
 * 在调度前 exit 2（见 `validateAdvisoryRegistry`）。当时的施工期豁免已随该守卫
 * 转阻塞而清空，登记表当前为空。
 */
function classifyFailure(result, state) {
  if (result.task.advisory === true) state.advisory.push(result)
  else state.failed.push(result)
}

async function runPool(tasks, limit, state) {
  const queue = [...tasks]
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const task = queue.shift()
      if (task === undefined) return
      const result = await runTask(task)
      state.results.push(result)
      if (!result.ok) classifyFailure(result, state)
      else collectDegraded(result, state)
      const mark = result.ok ? '✓' : result.task.advisory === true ? '!' : '✗'
      console.log(`${mark} ${result.task.name.padEnd(28)} ${seconds(result.ms).padStart(8)}`)
    }
  })
  await Promise.all(workers)
}

/**
 * 依赖感知调度:一个包的 `needs` 全部通过后才启动;并发上限为 limit。
 * 依赖失败时,依赖它的包标记为 skipped(不跑)——它们的失败没有信息量
 * (构建产物缺失导致的一连串 TS7016 只会淹没真正的报错)。
 */
async function runScheduler(tasks, limit, state) {
  const pending = new Map(tasks.map(task => [task.name, task]))
  const running = new Map()
  const succeeded = new Set(state.results.filter(r => r.ok).map(r => r.task.name))

  const start = task => {
    const promise = runTask(task).then(result => {
      running.delete(task.name)
      state.results.push(result)
      if (result.ok) {
        succeeded.add(task.name)
        collectDegraded(result, state)
      } else classifyFailure(result, state)
      const mark = result.ok ? '✓' : task.advisory === true ? '!' : '✗'
      console.log(`${mark} ${task.name.padEnd(28)} ${seconds(result.ms).padStart(8)}`)
    })
    running.set(task.name, promise)
  }

  while (pending.size > 0 || running.size > 0) {
    let progressed = false
    for (const task of [...pending.values()]) {
      if (running.size >= limit) break
      const blocked = task.needs.filter(name => !succeeded.has(name))
      if (blocked.length > 0) {
        // 依赖已失败(不在 pending/running 里也永远不会成功)→ 跳过
        const dead = blocked.filter(name => !pending.has(name) && !running.has(name))
        if (dead.length > 0) {
          pending.delete(task.name)
          state.skipped.push({ task, blockedBy: dead })
          console.log(`⊘ ${task.name.padEnd(28)} 跳过(依赖未通过:${dead.join(', ')})`)
          progressed = true
        }
        continue
      }
      pending.delete(task.name)
      start(task)
      progressed = true
    }
    if (running.size === 0) {
      if (!progressed) break
      continue
    }
    await Promise.race(running.values())
  }

  // C-1（2026-09-23 三轮审计 P1）：循环退出前断言 `pending` 清空。
  //
  // 旧实现在这里直接 `break`，而 `pending` 里剩下的任务**既不跑、也不进 skipped**
  // （skipped 只在"阻塞依赖已结束且永远不会成功"时记账；互相等待的包永远停在
  // pending）⇒ 摘要里没有任何一处能看出"少了几个包"：它按 `state.results` 倒算
  // `passed`，于是打印「N 个任务:N 通过、0 失败、0 跳过」并 EXIT=0，而那些包一次
  // 都没跑。审计实测（注入 `A needs B` + `B needs A`）：两个包在输出里出现 0 次，
  // 门禁照绿。现在把它们逐条列出来并**判失败**。
  if (pending.size > 0) {
    for (const task of pending.values()) {
      state.dropped.push({ task, needs: task.needs.filter(name => !succeeded.has(name)) })
      console.error(`✗ ${task.name.padEnd(28)} 未运行（依赖永不满足：${task.needs.join(', ') || '—'}）`)
    }
  }
}


/**
 * 编排器主体（`yarn check` / `check:fast` 的全部行为都在这里）。
 *
 * 为什么是一个函数而不是裸的顶层代码（2026-09-24 第十轮审计 C-08）：本文件同时是
 * 「判定行扫描 + 有界输出」这条口径的**唯一实现**的宿主 —— `scripts/check-root-guards.mjs`
 * 会 `import { formatFailureReport } from './check-workspaces.mjs'`（它自己那份
 * `summarize()` 只有「头 20 + 省略 + 尾 20」，判定行落中段时在 CI 日志里出现 0 次）。
 * **被 import 时必须零副作用**，否则根守卫一 import 就会递归跑一遍全量门禁。
 * @param argv - 参数向量（缺省 = `process.argv.slice(2)`；测试可注入）。
 */
export async function main(argv = process.argv.slice(2)) {
  // R11 P0-1（I1 泳道）：**本进程自己的判决可信吗**。`yarn check` 这条路径上的编排器
  // 就是被 yarn spawn 的 —— `.yarnrc.yml` 的插件钩子能在 **yarn 进程内部**给它塞
  // `NODE_OPTIONS=--import=<退出钩子>`（清洗已经跑完），而那个钩子实测能把
  // `process.exit(1)` / `process.exitCode = 1` 改写成 0（EXIT=0）。判决不可信的进程
  // 不许说「通过」⇒ 直接拒绝运行（`--list` 也一样拒：它正是各判据的输入面）。
  const runnerTrust = runnerTrustProblems()
  if (runnerTrust.length > 0) refuseUntrustedRunner('check-workspaces', runnerTrust)
  // P0-1 的第二道（**静态**面）：本进程环境干净，不代表"经 yarn 起脚本"这条路可信 ——
  // `yarnPath`（换掉整个 yarn）/ `plugins`（钩子在 yarn 进程内部改写脚本子进程的环境）/
  // 根 package.json 的生命周期钩子（install 期可改写判据执行体）命中任一条 ⇒ 包级 check
  // 的判据不可信（它们必须经 yarn）⇒ 拒绝调度，而不是"跑完再报"。
  // 判据与 `check-guard-parser-integrity.mjs` 的登记制同源（两侧清单由该守卫交叉对拍）。
  const yarnTrust = yarnEntryTrustProblems(ROOT)
  if (yarnTrust.length > 0) {
    console.error('check-workspaces: 拒绝调度 —— 「经 yarn 起脚本」这条路不可信（P0-1）：')
    for (const problem of yarnTrust) console.error(`  · ${problem}`)
    console.error('  ⇒ 包级 check 必须经 yarn，所以这类入口配置一旦出现，跑的就不再是我们要判的东西。')
    process.exit(2)
  }

    const options = parseArgs(argv)
  // A usage error sets exitCode 2 in parseArgs; honor it instead of flattening
  // every bad-argument case to 1 (2026-09-16 R9/R2 audit: the assignment was dead
  // code — `process.exit(1)` overrode it).
  if (options === null) process.exit(process.exitCode ?? 1)

  if (options.help) {
    console.log('用法: node scripts/check-workspaces.mjs [--changed [ref]] [--only a,b] [--concurrency N] [--list] [--no-guards] [--full-output]')
    process.exit(0)
  }

  // `advisory` 的登记制（2026-09-23 第六轮审计 R6-C-1）：配置非法时**拒绝调度**，
  // 绝不放行成"某个守卫变成只告警"。这条判据对 `--list` 也生效 —— 清单类判据
  // （`verify-check-workspaces.mjs` 等）正是靠 `--list` 读这张表的。
  {
    const advisoryErrors = validateAdvisoryRegistry(GUARDS)
    if (advisoryErrors.length > 0) {
      for (const error of advisoryErrors) console.error(`check-workspaces: ${error}`)
      console.error('check-workspaces: ADVISORY_REGISTRY 校验未通过 ⇒ 拒绝调度（退出码 2；退出码 0 不得代表一个被静音的门禁）')
      process.exit(2)
    }
  }

  // C-2（2026-09-23 三轮审计 P2）：调度/归属表的名字此前**没有任何校验** —— 打错一字符
  // 就是"静默删掉一条边"或"check:fast 判 0 个包"。放在 `--list` 之前：列计划时就必须拦。
  const scheduleProblems = scheduleTableProblems()
  if (scheduleProblems.length > 0) {
    console.error(`check-workspaces: 调度/归属表自检失败（${scheduleProblems.length} 处）—— 这些名字打错时失败形态全是静默的：`)
    for (const problem of scheduleProblems) console.error(`  - ${problem}`)
    process.exit(2)
  }

  // 判定形态表 / ANSI 归一 / C1 剥离的**逐形态自检**（第十轮复审 W1 的 N4/N5）。
  // 与上面两条同一取向：自检失败是配置错误（exit 2），不得退化成"跑一遍门禁、然后
  // 失败详情整行看不见"—— 那种红在日志里与"没有失败"几乎同形。放在调度之前：
  // 诊断面自己坏了的时候，跑再多任务也只是浪费 CI 分钟。第二个调用方是
  // `check-root-guards.mjs`（docs-only PR 的唯一防线，那条路径上本函数不跑）。
  {
    const verdictSelftest = selfTestVerdictClassifier()
    // 三条**互不相同**的下限（第十一轮审计 C3-02/C3-03）:
    //   ① 形态表的样本覆盖率（`formsCovered === forms`，双向对拍）+ 逐形态"去掉即红"验证；
    //   ② 形态数与样本数（棘轮字面量，不是 `length` 恒真式）；
    //   ③ `check()` 调用数（旧口径，保留作兜底）。
    const formsUncovered = verdictSelftest.formsCovered < verdictSelftest.forms
    if (verdictSelftest.failures.length > 0
      || formsUncovered
      || verdictSelftest.assertions < SELFTEST_VERDICT_ASSERTIONS) {
      for (const detail of verdictSelftest.failures) console.error(`check-workspaces: ${detail}`)
      if (formsUncovered) {
        console.error(`check-workspaces: 判定形态自检只覆盖了 ${verdictSelftest.formsCovered}`
          + `/${verdictSelftest.forms} 条形态（每条形态至少要有 1 条样本 + 一条"去掉即红"验证）。`)
      }
      if (verdictSelftest.assertions < SELFTEST_VERDICT_ASSERTIONS) {
        console.error(`check-workspaces: 判定形态自检只执行了 ${verdictSelftest.assertions} 条断言`
          + `（期望 ≥ ${SELFTEST_VERDICT_ASSERTIONS}）⇒ 断言表被掏空。`)
      }
      console.error('  ⇒ 拒绝在"诊断面自己坏了"的情况下继续（形态表 / ANSI 归一 / C1 剥离失效时，'
        + '失败详情会整行消失，而门禁仍然 EXIT=1）。')
      process.exit(2)
    }
  }

  const envConcurrency = Number(process.env.CHECK_CONCURRENCY ?? '')
  const defaultConcurrency = Math.max(1, Math.min(4, availableParallelism()))
  const concurrency = options.concurrency ??
    (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : defaultConcurrency)

  let selectedNames = null
  if (options.only !== null) {
    // 显式点名必须兑现:名字打错时旧行为是"筛出空集 → 0 个任务 → exit 0",
    // 与"这些包都过了"无法区分(2026-09-17 审计 S15-4)。空值(--only 后面没跟
    // 东西)同样按用法错误处理。
    const known = new Set(PACKAGES.map(pkg => pkg.name))
    const unknown = options.only.filter(name => !known.has(name))
    if (options.only.length === 0) {
      console.error('check-workspaces: --only 需要包名列表(逗号分隔),收到空值')
      process.exit(2)
    }
    if (unknown.length > 0) {
      console.error(`check-workspaces: --only 里有不存在的包:${unknown.join(', ')}`)
      console.error(`可选:${[...known].join(', ')}`)
      process.exit(2)
    }
    selectedNames = new Set(options.only)
  } else if (options.changed !== null) {
    const changed = await changedFiles(options.changed)
    if (changed.error !== undefined) {
      console.error(`check-workspaces: ${changed.error}`)
      process.exit(2)
    }
    const files = changed.files
    const { selected, global } = selectByChanges(files)
    console.log(`check:fast — ${files.length} 个改动文件(相对 ${options.changed})→ ${global ? '全量(顶层文件改动)' : `${selected.length} 个包`}`)
    // A zero-package selection (README / notes / .gitmodules changes) must still
    // run the root guards: they read those very files (check:layout verifies
    // README.i18n.yaml and .gitmodules against upstream.json). Exiting here was a
    // false-green fast gate — CI full runs caught it only after the push.
    if (selected.length === 0) console.log('check:fast — 没有包需要重跑;仍执行根守卫')
    selectedNames = new Set(selected)
  }

  const wantsGuards = options.guards
  // `kind: 'guard'`：根守卫走「直接 spawn」通道（不经 yarn），见 runTask 的头注释。
  const guards = wantsGuards ? GUARDS.map(guard => ({ ...guard, kind: 'guard' })) : []
  const selected = PACKAGES.filter(pkg => selectedNames === null || selectedNames.has(pkg.name))
  const selectedSet = new Set(selected.map(pkg => pkg.name))
  const packages = selected.map(pkg => ({
    name: pkg.name,
    // 未被选中的依赖不参与本轮调度(显式指定子集时,其产物由上一次全量门禁提供)
    needs: pkg.needs.filter(name => selectedSet.has(name)),
    args: ['workspace', pkg.name, 'run', pkg.script ?? 'check'],
    firstWave: pkg.firstWave === true,
  }))

  if (options.list) {
    for (const pkg of selected) {
      console.log(`${pkg.name.padEnd(30)} needs: ${pkg.needs.join(', ') || '—'}`)
    }
    console.log(`guards: ${guards.map(guard => guard.name).join(', ') || '—'}`)
    const advisories = guards.filter(guard => guard.advisory === true).map(guard => guard.name)
    if (advisories.length > 0) console.log(`guards(advisory,只告警不拦门禁): ${advisories.join(', ')}`)
    // 登记表本身也是清单判据的输入（verify-check-workspaces 会与 check-root-guards --list
    // 对拍这条）—— 空表要**显式**说出来，不能靠"没打印那一行"来推断。
    console.log(`guards(advisory 登记制): ${ADVISORY_REGISTRY.length === 0
      ? '无（每条守卫都必须拦门禁）'
      : ADVISORY_REGISTRY.map(entry => `${entry.name}@${entry.expiresOn}`).join(', ')}`)
    process.exit(0)
  }

  // P1-2 的证据（不是存在性断言）：**守卫子进程**真的丢了哪些键，逐条打出来。第十轮只给
  // 运行器加了清洗，`yarn check` 这条路径（本编排器）当时仍然原样透传 `process.env` ⇒ 同一条
  // 注入 EXIT 1→0。第十一轮复审 J1 的 N3 起，清洗**只作用于守卫通道**（包级 check 原样透传本
  // 进程环境 —— 理由见 `runTask()` 里那一段），所以这条证据也按通道分开打印。
  const spawnEnvEvidence = sanitizeGuardEnvironment(process.env)
  console.log(`check-workspaces: 守卫子进程环境已清洗 —— 丢弃 ${spawnEnvEvidence.dropped.length} 个「会改写解释器」的键`
    + `${spawnEnvEvidence.dropped.length > 0 ? `：${spawnEnvEvidence.dropped.join('、')}` : '（本次没有命中危险族键）'}`
    + '（守卫走直接 spawn）；包级 check 仍经 yarn，但**原样继承本进程环境** + `YARN_IGNORE_PATH=1`'
    + '（N3：正当的 `NODE_OPTIONS=--max-old-space-size=…`/`YARN_*`/`npm_config_*` 不再被误清）')

  const state = { results: [], failed: [], skipped: [], advisory: [], dropped: [], degraded: [] }
  const startedAt = Date.now()
  console.log(`check — 并发 ${concurrency};按构建依赖分层(desktop 必须先产出 lib/types)`)

  // 阶段 1:desktop check 与根守卫并行。desktop 内部的 verify:profile 会按需构建
  // 其余插件包的 lib/(增量 prebuild),此刻不跑那些包自己的 check,避免与它的
  // profile 冒烟争抢同一份 lib/。firstWave 标记的包(无构建期依赖,如 vendored
  // 插件的 test)也放在这一波,把它们的耗时藏进 desktop 的长任务里。
  // 2026-09-20：desktop **不再无条件进第一波** —— 它现在依赖 wasm-apps-host（见上），
  // 必须由依赖感知调度排在依赖之后。第一波只剩「无构建期依赖」的包与根守卫。
  const firstWave = [
    ...guards,
    ...packages.filter(task => task.firstWave === true),
  ]
  if (firstWave.length > 0) await runPool(firstWave, concurrency, state)

  // 阶段 2:依赖感知调度(依赖失败的包直接跳过,不产生级联噪音)。
  const rest = packages.filter(task => task.firstWave !== true)
  if (rest.length > 0) await runScheduler(rest, concurrency, state)

  const totalMs = Date.now() - startedAt
  // C-13（2026-09-24 第十轮审计 F6）：`passed` 必须与「失败 / 告警」**互斥**。
  // 旧式 `results.length - failed.length` 把 advisory 失败同时算进"通过"与"告警"
  // （实测：17 个任务的摘要写成「17 通过、0 失败、1 告警」—— 17+1 > 计划 17）。
  const passed = state.results.length - state.failed.length - state.advisory.length
  // 摘要刻意把「计划 / 实跑」两个数都打出来：C-1 的失效形态正是"少跑了任务但计数看不出来"
  // （`passed` 是按实际结果倒算的）。计划数 = 本轮真正排进计划的任务（守卫 + 选中的包）。
  const planned = firstWave.length + rest.length
  // 计数自洽（同一条审计的另一半）：四类归属（通过 / 失败 / 告警 / 跳过 / 未运行）必须
  // 恰好覆盖计划数 —— 只改一侧（例如把某一类漏出摘要）就会在这里露出来。
  const accounted = passed + state.failed.length + state.advisory.length + state.skipped.length + state.dropped.length
  const summaryInconsistent = accounted !== planned
  console.log(`──── 计划 ${planned} / 实跑 ${state.results.length} 个任务:${passed} 通过、${state.failed.length} 失败、${state.skipped.length} 跳过`
    + `${state.dropped.length > 0 ? `、${state.dropped.length} 未运行` : ''}`
    + `${state.advisory.length > 0 ? `、${state.advisory.length} 告警(advisory，**不算通过**)` : ''},总耗时 ${seconds(totalMs)}`)
  if (summaryInconsistent) {
    console.error(`✗ 摘要计数不自洽：通过 ${passed} + 失败 ${state.failed.length} + 告警 ${state.advisory.length}`
      + ` + 跳过 ${state.skipped.length} + 未运行 ${state.dropped.length} = ${accounted} ≠ 计划 ${planned} —— `
      + '计数口径被拆开了（漏掉某一类会让摘要看起来"总数正常"）。判据来源：C-13/C-1（2026-09-24 第十轮审计）。')
  }

  // C-16（2026-09-24 第十轮审计 F9）：`--changed` 零包 + `--no-guards` 曾经是
  // 「计划 0 / 实跑 0 + EXIT=0」—— 与"所有任务都通过"不可区分。CI 侧由
  // `check-workflows.mjs` 的 [SK-8] 静态策略钉住（门禁调用不得带参数），
  // 但本地面会拿到一个绿色退出码 ⇒ 这里把它显式说出来。
  if (planned === 0) {
    console.error('⚠ check-workspaces: 本轮**计划 0 个任务** —— 退出码 0 只说明"没有任何任务失败"，'
      + '**不**说明"门禁跑过了"：')
    console.error('    · 没有包被选中（--changed 的改动集不在任何 PATH_OWNERS 前缀下；改 docs/ 之外的顶层文件会升格为全量），且')
    console.error('    · 根守卫被 `--no-guards` 关掉了（那是本地调试通道：CI 的 `yarn check` 参数向量必须为空，见 [SK-8]）。')
    console.error('    要一次真的门禁：`node scripts/check-workspaces.mjs`（或 `yarn check`）。')
  }

  // R11-J1 N1/N4（把判定权从"被审进程"上移到父进程/CI）：**通过凭据只在真的跑过任务时打印**。
  //
  // 为什么需要它：`refuseUntrustedRunner()` 已经做到"判决不可信的进程说不出通过"，但进程内
  // 做不到绝对（钩子能改写 `kill`/`abort`/`reallyExit` 三个原生入口 ⇒ 最后一层只能是"阻塞不返回"）。
  // 另一条同类路径是 `yarnPath`：`corepack yarn check` 的 yarn 被整条换掉时，**本编排器根本
  // 不会启动**（J1 的 N4 实测：日志只有假 yarn 的一行、EXIT=0、零任务）—— 那一层靠
  // `gate-guards` 的直接 spawn + `.yarnrc.yml` 登记制，但"父进程怎么判"必须有个统一凭据。
  //
  // 凭据的形态：`VERDICT PASS planned=N executed=N`（N>0 且**实跑 == 计划**、零失败/零跳过/
  // 零未运行/零 advisory/计数自洽）。被拒绝的进程、被假 yarn 顶掉的进程、零任务的进程
  // **都打印不出这一行** ⇒ 父进程/CI 只要 grep 它，就不必相信任何退出码。
  // 零任务的退出码**保持 0**（C-16 在 `verify-check-workspaces.mjs` 里钉住了"本地面不改退出码"），
  // 所以它拿到的是**显式的非通过标记** `VERDICT ZERO-TASKS`（与"零包仍跑根守卫"那条口径统一：
  // 零任务必须说出来，不能靠"没打印那一行"来推断）。
  {
    const complete = planned > 0 && state.results.length === planned
      && state.failed.length === 0 && state.dropped.length === 0 && !summaryInconsistent
    if (complete && state.advisory.length === 0) {
      console.log(`check-workspaces: VERDICT PASS planned=${planned} executed=${state.results.length}`
        + '（判定通过的唯一凭据：**实跑 == 计划 > 0**；被拒绝运行 / 被 yarnPath 顶替 / 零任务的进程不会打印这一行）')
    } else if (planned === 0) {
      console.log('check-workspaces: VERDICT ZERO-TASKS planned=0 executed=0'
        + '（**不算通过**：退出码 0 只表示"没有任何任务失败"；CI 侧必须要求上面那行通过凭据）')
    } else {
      console.error(`check-workspaces: VERDICT FAIL planned=${planned} executed=${state.results.length}`
        + ` failed=${state.failed.length} skipped=${state.skipped.length} dropped=${state.dropped.length}`
        + `${state.advisory.length > 0 ? ` advisory=${state.advisory.length}` : ''}`
        + `${summaryInconsistent ? ' summary-inconsistent' : ''}`
        + '（这一行与通过行互斥：唯一的"跑过门禁"凭据是以 `check-workspaces: ` 开头的通过行；'
        + '非通过的行里刻意**不出现**那个词，免得 CI 侧一句朴素 grep 被"提及"满足）')
    }
  }

  // C-8（2026-09-23 三轮审计 P2）：**通过**的守卫里那些"跳过/降级"行必须进摘要。
  // 只回显判定行（有界），绝不放整份日志 —— 本仓踩过"日志刷爆把失败详情挤出 GitHub
  // 截断窗口"的坑。固定前缀 `[DEGRADED]` 供 CI 侧 grep。
  if (state.degraded.length > 0) {
    console.log(`\n[DEGRADED] ${state.degraded.length} 条"跳过/降级"提示（来自**通过**的任务；只回显判定行，不是日志 dump）`)
    for (const entry of state.degraded) console.log(`[DEGRADED] ${entry.task}: ${entry.line}`)
    console.log('[DEGRADED] 处置：这些行说明某条判据本次没有真的判 —— 要么修掉降级路径，要么在守卫里把它改成 fail-loud。')
  }

  if (state.dropped.length > 0) {
    console.error(`\n✗ ${state.dropped.length} 个任务**未运行**（依赖成环 / 依赖永不满足）—— 既不算通过、也不算跳过：`)
    for (const entry of state.dropped) {
      console.error(`  - ${entry.task.name}（未满足的依赖：${entry.needs.join(', ') || '—'}）`)
    }
    console.error('  判据来源：C-1（2026-09-23 三轮审计 P1）。旧实现在此处静默 break，摘要按实际结果倒算')
    console.error('  ⇒ 打印「N 个任务:N 通过、0 失败、0 跳过」并 EXIT=0，而那些包一次都没跑。')
  }

  if (state.advisory.length > 0) {
    // advisory 不等于通过：把失败原文（有界）打出来，并明确它何时必须转阻塞。
    console.error(`\n⚠ ${state.advisory.length} 个 advisory 任务未通过（不拦门禁，但必须处置）：`)
    for (const advisory of state.advisory) {
      console.error(`\n----- ${advisory.task.name}（advisory：${advisory.task.path ?? ''}）-----`)
      console.error(options.fullOutput ? advisory.output.trimEnd() : summarizeFailure(advisory.output))
    }
    console.error('\n提示：advisory 条目必须先在 ADVISORY_REGISTRY 里登记（理由/批准人/到期日），')
    console.error('     且 `scripts/check-root-guards.mjs` 只有在显式传 `--allow-advisory` 时才容忍它。')
    console.error('     到期即失效：要么续期并写明理由，要么把该条目转回阻塞（删掉 `advisory: true`）。')
  }

  if (state.failed.length > 0 || state.dropped.length > 0 || summaryInconsistent) {
    for (const failure of state.failed) {
      // C-15（2026-09-24 第十轮审计 F8）：标题带**真实**退出码 / 信号（旧文案是字面量
      // 「退出码非 0」，而 `code` 在 runTask 里被丢掉 ⇒ 137/2/1 全同形）。
      console.error(`\n===== ${failure.task.name} 失败(${describeTaskExit(failure)}) =====`)
      console.error(options.fullOutput ? failure.output.trimEnd() : summarizeFailure(failure.output))
    }
    process.exit(1)
  }

}

/** 本模块是"被直接执行"还是"被 import"（`check-root-guards.mjs` 只 import 函数）。 */
function isEntryPoint() {
  // Node ≥24.2 的原生判据（本仓 CI 与本地都是 24.x）：精确、无路径形态歧义。
  if (typeof import.meta.main === 'boolean') return import.meta.main
  // 回退（Node 22.19 线）：`process.argv[1]` 是**已解析**的入口绝对路径（Node 会解析
  // 符号链接，除非显式 `--preserve-symlinks-main`）。两条比较都不成立 ⇒ 被 import。
  const entry = process.argv[1]
  if (entry === undefined) return false
  const self = fileURLToPath(import.meta.url)
  try {
    if (resolve(entry) === self) return true
  } catch {
    // 比较失败只会让它落到下面的 realpath 比较，不改变结论方向
  }
  try {
    return realpathSync(entry) === realpathSync(self)
  } catch {
    return false
  }
}

if (isEntryPoint()) await main()

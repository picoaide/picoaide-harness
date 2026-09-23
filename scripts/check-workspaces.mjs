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
import { availableParallelism } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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
  { name: '@picoaide/dsh-wasm-apps-host', dir: 'packages/host/wasm-apps-host', needs: ['@picoaide/dsh-browser'] },
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

/** 反向依赖:A 改动会波及 B(desktop 的类型/产物是这些包的输入)。 */
const DEPENDENTS = {
  'dsh-plugin-desktop': ['@picoaide/dsh-enterprise', '@picoaide/dsh-account-card', '@picoaide/dsh-branding'],
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
 *   4. `DEPENDENTS` 键/值打错：`--changed` 的反向展开静默少跑。
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
 * Lines that carry a test/build verdict, across every runner this gate drives:
 * vitest (`FAIL`, `×`, `AssertionError`, `⎯ Failed Tests`, `Tests 1 failed`),
 * `node --test` (`not ok`), tsc (`error TS…`), and yarn/spawn failures
 * (`ELIFECYCLE`). Deliberately excludes vitest's `Test Files` summary line: it
 * matches on PASSING runs too (`Test Files 16 passed`) and used to consume the
 * bounded verdict budget with noise.
 */
const FAILURE_LINE = /(?:^|\s)(?:FAIL\b|not ok\b|AssertionError|ELIFECYCLE|error TS\d+|\d+\s+failed\b|×|✗|⎯)/u
/** Cap on the verdict lines printed per failed task. */
const MAX_FAILURE_LINES = 150
/** Cap on the trailing context lines printed per failed task. */
const MAX_TAIL_LINES = 200

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
 * Bound a failed task's output to something a CI log can actually carry.
 *
 * The real-socket / real-subprocess suites print tens of thousands of lines, and
 * GitHub **truncates the middle** of a job log — so dumping the whole capture
 * pushed the verdict out of view (2026-09-16: a red Gate on
 * `@picoaide/dsh-connectors` could not be diagnosed from the CI log at all;
 * every rerun "fixed" it and every rerun hid why). Print the verdict lines
 * first, then a bounded tail for context. `--full-output` restores the raw dump.
 * @param output - the task's captured stdout+stderr.
 * @returns the bounded report.
 */
function summarizeFailure(output) {
  // A trailing newline is a separator, not a line: keeping the empty element
  // made exactly-(MAX_FAILURE_LINES + MAX_TAIL_LINES)-line output take the
  // summary branch (off-by-one).
  const body = output.endsWith('\n') ? output.slice(0, -1) : output
  const lines = body.split('\n')
  if (lines.length <= MAX_FAILURE_LINES + MAX_TAIL_LINES) return output.trimEnd()
  const tailStart = Math.max(0, lines.length - MAX_TAIL_LINES)
  const flagged = []
  for (let index = 0; index < lines.length && flagged.length < MAX_FAILURE_LINES; index += 1) {
    if (FAILURE_LINE.test(lines[index])) flagged.push({ index, line: lines[index] })
  }
  // Verdict lines already shown above are not repeated inside the tail.
  const flaggedInTail = new Set(flagged.filter(entry => entry.index >= tailStart).map(entry => entry.index))
  const tail = lines.slice(tailStart).filter((_, offset) => !flaggedInTail.has(tailStart + offset))
  const parts = [`(输出共 ${lines.length} 行;此处只打印判定行与末尾;完整输出用 --full-output 本地重跑)`]
  if (flagged.length > 0) {
    parts.push(`--- 失败相关行(最多 ${MAX_FAILURE_LINES} 行,按出现顺序) ---`, ...flagged.map(entry => entry.line))
  } else {
    parts.push('--- 未匹配到失败标记行(见下方末尾输出) ---')
  }
  parts.push(`--- 输出末尾(最后 ${tail.length} 行) ---`, ...tail)
  return parts.join('\n')
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

function runTask(task) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn('corepack', ['yarn', ...task.args], {
      cwd: task.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => {
      resolve({ task, ok: false, ms: Date.now() - started, output: `${output}\n${String(error)}` })
    })
    child.on('close', code => {
      resolve({ task, ok: code === 0, ms: Date.now() - started, output })
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

const options = parseArgs(process.argv.slice(2))
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
const guards = wantsGuards ? GUARDS.map(guard => ({ ...guard })) : []
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
const passed = state.results.length - state.failed.length
// 摘要刻意把「计划 / 实跑」两个数都打出来：C-1 的失效形态正是"少跑了任务但计数看不出来"
// （`passed` 是按实际结果倒算的）。计划数 = 本轮真正排进计划的任务（守卫 + 选中的包）。
const planned = firstWave.length + rest.length
console.log(`──── 计划 ${planned} / 实跑 ${state.results.length} 个任务:${passed} 通过、${state.failed.length} 失败、${state.skipped.length} 跳过`
  + `${state.dropped.length > 0 ? `、${state.dropped.length} 未运行` : ''}`
  + `${state.advisory.length > 0 ? `、${state.advisory.length} 告警(advisory)` : ''},总耗时 ${seconds(totalMs)}`)

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

if (state.failed.length > 0 || state.dropped.length > 0) {
  for (const failure of state.failed) {
    console.error(`\n===== ${failure.task.name} 失败(退出码非 0) =====`)
    console.error(options.fullOutput ? failure.output.trimEnd() : summarizeFailure(failure.output))
  }
  process.exit(1)
}

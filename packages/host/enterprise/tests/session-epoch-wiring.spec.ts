/**
 * 「会话代际守卫」的**接线判据**（第二十六轮 Z2-01，P1；第二十七轮 ③ 改扫描根）。
 *
 * ## 为什么必须有这一层
 *
 * 行为判据（各 sync 文件里那两条"迟到响应不得落地"）证明的是**今天**这几条守住了。
 * 它挡不住本仓最典型的失效形态：**新增一个投影入口时忘了加守卫** —— Z2-01 本身就是
 * "同一根因只收口了一条路径"的产物，AA3-01 又是同一族的第二次复发（desktop 的
 * `updates.ts` 整条在扫描根之外）。
 *
 * ## 第二十七轮的两处结构性修正
 *
 * 1. **扫描根从"4 个文件名"改成仓库级**（本文件原来的 `GUARDED_FILES` 硬编码四个
 *    enterprise 文件名）—— 判据的**扫描根决定了它能看见什么**：写死文件名的判据
 *    对"新增第五个同族文件"**结构上不可能报警**（AA1 §证伪-1 的 M-A：一个完全无
 *    守卫的新投影文件，判据 6/6 全绿）。现在入口由**发现器**枚举（`packages/<pkg>/src/` 下的全部源码
 *    下的 TS/TSX + 渲染包外的 vendored JS），"新增未守卫入口即红"才对全仓成立。
 * 2. **规则 A 不再被"块尾空后继"空洞满足**（M-B）：原来取 await 所在 block 的
 *    `statements.slice(index+1)`，await 是内层 block（`try { … }`）最后一条时
 *    `rest` 为空数组、`every(...)` 空洞为真 ⇒ 把守卫整段删掉仍然全绿。现在沿**执行序
 *    向外层 block** 继续找后继（含 `try` 的 catch/finally 之后的语句），只在到达
 *    **所在函数体**时才认为"后面没有可落地的语句"。
 * 3. **新增规则 E：promise 回调投影**（M-C3）—— 在 `sync` 首部插一条
 *    `.then((late) => { ctx.settings.update(…) })`，回调里没有 `await` 节点，A/C 两条
 *    规则结构上看不见它，而后果与 Z2-01 完全相同（迟到的旧会话响应改写当前会话的
 *    models/baseURL，凭据却已是新会话的）。规则 E 把"延迟落地"的取值域从"await 节点"
 *    扩到 **`then/catch/finally/new Promise/queueMicrotask` 的函数实参**。
 *
 * ## 第二十八轮（FIX-42①）的取值域修正：**九种真实语法形态**
 *
 * AB1-03 在副本里造真文件 + 跑判据本体验证：6 条正控红、**9 条缺口绿**（其中 F2
 * 最危险：`switch case` 里的写 + switch 之后的守卫 ⇒ 判据被满足、`findings=0`，
 * 函数**读起来有守卫**）。三条根因，全部是"**取值域 ≠ 被守护面**"，逐条修掉：
 *
 * - **①语句容器只认 `Block`**：未加花括号的 `switch case` 里，await 所在语句的父节点是
 *   `CaseClause`（不是 `Block`）⇒ `enclosingStatement` 一路走到整个 `SwitchStatement`，
 *   判据比的是"switch **之后**那条语句"，**同一个 case 里紧跟 await 的写根本不在面内**。
 *   现在 `enclosingStatement` 在 `Block` **或** `CaseClause`/`DefaultClause` 处停，
 *   `afterStatement` 沿执行序继续：case 内后继 → 落穿到下一个子句 → switch 之后。
 * - **②`terminal` 把 `break`/`continue` 当终点**：`await` 后紧跟 `break` 退出循环、
 *   循环之后再落地（F8）完全不可见。现在 `break`/`continue` **不是终点**，而是解析到
 *   真实跳转目标（`break` ⇒ 最近的循环/`switch` 之后；带标签 ⇒ 标签语句之后），
 *   只有 `return`（与不可达）才是终点。
 * - **③延迟面硬编码 5 个名字 + `for await` 不是 `AwaitExpression`**：
 *   `setImmediate`/`setTimeout`/`setInterval`/`process.nextTick`/`emitter.on(...)` 现在都在
 *   回调面内；`for await` 是 `ForOfStatement.awaitModifier`、AST 里**没有**
 *   `AwaitExpression` 节点 ⇒ 现在按"await 点"处理（其后继 = 循环体首句），规则 A/C
 *   因此对它成立。
 * - **④新增规则 F：`try` 的续段是迟到面**（F3）。`finally` 在守卫 `return` 的路径上
 *   **照样执行** ⇒ 块内的落地不是"被守卫之后的代码"，必须自带比对。判据：`try` 块内含
 *   await 面时，`catch`/`finally` 块内的"直接落地"必须在该块内自带代际比对或登记豁免。
 *
 * ## 规则
 *
 * - **A**：被守卫的函数里，每个 **await 面**（`await` 表达式与 `for await`）之后
 *   （按执行序、跨内层 block、含 `try` 续段与 `switch` 落穿、解析 `break`/`continue`
 *   跳转）必须紧跟一次代际比对 `if (!<guard>.isCurrent(<epoch>)) return` /
 *   `if (!<predicate>()) return`；
 * - **B（仓库级）**：**每一个会话入口**（`subscribeSession(s)(…)` /
 *   `subscribePicoSession(…)` / `ctx.on(SESSION_CHANGED_EVENT|'pico/session-changed'|
 *   'session/event', cb)`）都必须抵达一个被守卫的函数；做不到就得登记 ——
 *   `ENTRY_EXEMPTIONS`（有别的判据，写明理由）或 `KNOWN_UNGUARDED_ENTRIES`
 *   （**已知未收口**，写明缺陷编号）。**两张表都双向陈旧检测**：登记项必须仍然存在、
 *   仍然"未守卫"；一旦它被收口，登记项本身变红（不许把豁免表养成免检区）；
 * - **C**：用了代际守卫的文件里，每个 await 面都必须住在被守卫的函数里 ——
 *   新增的未守卫 sync 入口因此当场变红；豁免必须显式登记（`AWAIT_EXEMPTIONS`）；
 * - **D**：被 await 的 `initSentry` 必须收到**第 5 个实参**（代际谓词）——它在自己的
 *   await 之后改模块级 `sentry`/`status`，只在调用点外面补一句比对拦不住；
 * - **E**：用了代际守卫的文件里，`then/catch/finally/new Promise/queueMicrotask/
 *   setTimeout/setImmediate/setInterval/process.nextTick/on/once/addListener(...)` 的
 *   **函数实参**若体内有"非观察型成员调用"（= 延迟落地），必须自己带守卫或登记豁免；
 * - **F**：`try` 块内出现过 await 面时，该 `try` 的 `catch`/`finally` 块内的"直接落地"
 *   必须在该块内自带代际比对或登记豁免（`finally` 走守卫的 `return` 路径照样执行）。
 *
 * 判据自身有**自检**（`analyze()` 对合成源码的判定），并且把 AA1 §证伪-1 的三条
 * 绕过形态（M-A 新文件 / M-B 块尾空后继 / M-C3 `.then()` 投影）**以及 AB1-03 的九种
 * 取值域缺口形态**都做成合成正例 —— "分析器恒真"与"分析器恒红"两个方向都不成立才算过。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** 仓库根（`packages/host/enterprise/tests` 上溯四级）。 */
const REPO_ROOT = join(__dirname, '../../../..')

/** 判据文件里显示用的仓库相对路径（`/` 分隔，跨平台一致）。 */
function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/')
}

/** 只扫源码：`src/` 子树里的 TS/TSX + vendored 渲染包的 JS（见下）。 */
function collectSources(): string[] {
  const files: string[] = []
  const walk = (dir: string, inSource: boolean, extensions: RegExp): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute, inSource || entry.name === 'src', extensions)
        continue
      }
      if (inSource && extensions.test(entry.name)) files.push(absolute)
    }
  }
  walk(join(REPO_ROOT, 'packages'), false, /\.(?:ts|tsx)$/u)
  // vendored 渲染包把 JS 直接写在 `lib/`（没有 `src/`），其中确实有会话订阅
  // （`lib/advisor/index.js` 的 `session/event`）⇒ 单独走一遍，不放进通用扫描根
  // （那会连上游产物 `lib/**` 一起收进来）。
  walk(join(REPO_ROOT, 'packages', 'vendor', 'memory-evolve', 'lib'), true, /\.js$/u)
  return files.sort()
}

/**
 * `ENTRY_EXEMPTIONS`：**有会话入口但不需要代际守卫**的站点（键 = 仓库相对路径）。
 *
 * 每条都要回答两件事：
 *  - `reason`：**为什么不需要**（由谁保证不串味）；
 *  - `witness`：那个"别的机制"在文件里必须仍然存在的**标识**（陈旧即红）。
 *
 * 三条陈旧判据（见 `it('ENTRY_EXEMPTIONS 不得陈旧…')`）：文件必须仍然有会话入口、
 * 必须仍然**没有**代际协议（否则这条豁免就是多余的）、`witness` 必须仍然出现
 * （否则"别的机制"已经没了，豁免就失去依据 —— 这正是豁免表最容易变成免检区的路径）。
 */
interface EntryExemption {
  /** 为什么不需要代际守卫。 */
  readonly reason: string
  /** 见证：这个"别的机制"的标识必须仍然出现在文件里。 */
  readonly witness: string
}

const ENTRY_EXEMPTIONS: Readonly<Record<string, EntryExemption>> = {
  'packages/host/host-locale/src/session-events.ts': {
    reason: '订阅契约的**实现**本身（把调用方传进来的 listener 转交给 ctx.on）：它不投影任何会话派生状态，代际由调用方自己取。',
    witness: 'ctx.on(SESSION_CHANGED_EVENT',
  },
  'packages/host/enterprise/src/session-service.ts': {
    reason: '`subscribeSession(ctx, listener)` 是叶子包订阅契约的**一行转发**：它自己不投影状态，代际由每个调用方的 sync 自己取。',
    witness: 'subscribeSessionChanges',
  },
  'packages/host/wasm-apps-host/src/session.ts': {
    reason: '`subscribePicoSession(ctx, resolve, listener)` 是包内转发层（把调用方的 listener 包一层会话归一化），不投影状态；真正的入口在 `index.ts`（已登记为已知未收口）。',
    witness: 'readAppSession',
  },
  'packages/host/cron/src/index.ts': {
    reason: 'FIX-31 已核干净：`pico/session-changed` 的回调是**纯同步**的，没有任何 await ⇒ 没有可乱序的续体。',
    witness: 'setUsername',
  },
  'packages/host/connectors/src/index.ts': {
    reason: 'FIX-31 已核干净：入口处 `beginCredentialScopeSwitch()` **同步**取代际、`transitionEpoch` 逐次比对，且整个 transition 经 `runLifecycle` 串行化。',
    witness: 'beginCredentialScopeSwitch',
  },
  'packages/client/account-card/src/index.ts': {
    reason: 'R16B-01 已核干净：`UsageService.owns(s)`（键 = serverURL + username + token）逐次判定归属，换号时 `cancelInflight()` 作废在途请求 —— 同一族的另一种实现。',
    witness: 'owns(',
  },
  'packages/host/desktop/src/app-ai-runner.ts': {
    reason: 'Z2 §C 已核干净：会话回调是**同步**的 `releaseAll(...)`，而它递增的 `generation` 就是本族的另一种代际守卫（`startedAt !== generation` 在排队起跑前比对）。',
    witness: 'generation',
  },
  'packages/vendor/memory-evolve/lib/advisor/index.js': {
    reason: 'AA3 普查判定：会话作用域走 `ScopeStore`（`sessionOf/conversationOf` 按 sessionId 取目录），写的是 `writeConversation(dataDir, sessionId, …)` —— **按 sessionId 分目录**，不是"当前会话"的投影，所以不存在"上一代的响应写进当前代"。',
    witness: 'writeConversation',
  },
}

/**
 * `KNOWN_UNGUARDED_ENTRIES`：**已知未收口**的会话入口（键 = 仓库相对路径）。
 *
 * 与 `ENTRY_EXEMPTIONS` 的区别是语义：这些站点**应当**有代际（或等价的并发）守卫，
 * 只是本轮没有在本泳道的所有权内收口。登记它们是为了让判据**如实反映**当前面，
 * 而不是把它们静默塞进豁免表；同时**双向陈旧检测**保证：一旦收口，登记项立刻变红
 * 并要求删除（"已知未收口"不许变成永久免检区）。
 */
const KNOWN_UNGUARDED_ENTRIES: Readonly<Record<string, string>> = {
  'packages/host/browser/src/index.ts':
    'AA3-03（P2，未收口）：`runSessionSwitch` 的第一步 `await steps.closeAll()` 之后才 `applyUserScope()`，而订阅者不串行化 ⇒ A→B 与 B→C 交错时先发起后完成的那次会把作用域退回上一代账号。收口后请删掉本条。',
  'packages/host/wasm-apps-host/src/index.ts':
    'AA3 观察（第二十八轮 FIX-40 ③ **已收口**，登记保留的理由见末尾）：① 窗口侧的"迟到完成"**实测不可达** —— `windows.closeAll()` 体内没有 await，调用点返回时窗口与 surface 映射已同步拆干净（`src/audit-0923-user-scope.spec.ts` 的"不 await 也已经关完"用例钉住）；② 缓存侧是**真异步**（`rm -rf` 整个缓存根 + 重建），修前 `void cache?.clearAll()` 与新作用域的第一个动作并发 ⇒ 新账号刚写下的条目会被上一代的 rm 删掉。修法 = **排序**而不是代际：新增 `src/scope-reset.ts` 的清理链，换代时 `scopeReset.begin(previous)`（关窗同步、清缓存串行），新作用域的动作（消费待打开队列、本机路由的 open）一律 `await scopeReset.settled()`；判据 `src/scope-reset.spec.ts`（8 例，含"接线改回即发即忘"的负向对照 + 5 条变异全红）。**登记保留**：规则 B 只认"代际协议"这一种形态 —— 实测给本文件装上 `createSessionEpoch` 会让它进入 C/E 适用面并立刻产生 **11 条 `await-outside-guard`**（`requestOpen` 的 6 个 await + 两个路由 handler + ai-chat 包装），豁免它们必须新增 `AWAIT_EXEMPTIONS` 行，而本泳道对该文件的改动权限只有"删除登记项"。',
  'packages/host/enterprise/src/skill-telemetry.ts':
    'AA3 观察（P3，第二十八轮 FIX-40 ③ **已按"作用域取自调用时刻"收口**）：两个观察点现在都在**第一个 await 之前**同步取 `ctx.picoSession.getSession()`（修前在 `installedVersion` 的续体里才读 ⇒ 读版本文件期间换账号会把上一账号的技能调用记到新账号名下，作用域与令牌全指向新账号）。判据 `tests/skill-telemetry-session-capture.spec.ts`（3 例：两个观察点各一条 + 修前形状的负向对照；靠可控的 `readFile` 做成确定性，同一份 spec 跑在修前源码上红 2 条）。**这里不用代际**是语义决定的：上报是**事件归属**而不是"当前会话的投影"，代际守卫会把换代窗口里的真实调用整份丢掉，而"取调用时刻的会话"既不错记也不丢（同族先例：`account-card` 的 `owns(s)`）。**登记保留**的理由同 index.ts：装上代际会让规则 C 对 `installedVersion`/`reportSkillCall` 的两个 await 报红（实测 2 条 `await-outside-guard`），而豁免行不在本泳道的改动权限内。',
}

/**
 * `AWAIT_EXEMPTIONS`：`await` **允许**住在未守卫函数里的白名单（键 = `<相对路径>#<函数名>`）。
 *
 * 每一条都要写清"它的 await 之后会不会改状态、由谁保证"—— 登记项必须真的存在且真的
 * 含 await（陈旧登记会让白名单慢慢变成免检区，见 `it('豁免表不得陈旧')`）。
 */
const AWAIT_EXEMPTIONS: Readonly<Record<string, string>> = {
  'packages/host/enterprise/src/error-reporting.ts#initSentry':
    '内部 await（close 冲刷/关闭空 client）之后确实会改模块级 sentry/status ⇒ 由调用方传入第 5 个实参（代际谓词）守卫，见判据 D。',
  'packages/host/enterprise/src/error-reporting.ts#reportErrorReportingStatus':
    '状态回传的 POST（尽力而为）。调用点全部在 sync 内、且都在 `if (!epochs.isCurrent(epoch)) return` 之后；它自己的 await 之后只动"已报键"集合（带去重身份，不投影到当前会话）。',
  // ── desktop 的 `updates.ts`（AA3-01 收口时新增）：下面这些函数**不是**会话投影，
  //    它们的 await 之后不落"属于某个会话"的状态；真正投影会话的那几条
  //    （startCheck / startDownload / reuseDownloadedInstaller / reinstateDownloaded /
  //    reinstateRecordedVersion / readyArtifactOwnedByCurrentSource / installReady /
  //    fetchReusableManifest / rememberDownload / rememberPrompt / admitDownload）
  //    全部带代际，见 `tests/updates-session-epoch.spec.ts` 的行为判据。
  'packages/host/desktop/src/updates.ts#loadState':
    '启动期读一次 `state.json`：此时**还没有任何会话投影在飞**（apply 的第一件事），读到的内容随后由各个带代际的调用点判定能不能用。',
  'packages/host/desktop/src/updates.ts#persistState':
    '把**调用方已经决定好**的 `state` 写盘；写什么由带代际的调用方在上一步定，函数本身不读会话。',
  'packages/host/desktop/src/updates.ts#waitBeforeRetry':
    '只等一个定时器（不触网、不写盘、不改状态）；唤醒后的比对由调用方紧跟其后做。',
  'packages/host/desktop/src/updates.ts#announceReady':
    '一次性系统提示；调用点在上一步刚比对过代际，且提示本身不改任何更新状态。',
  'packages/host/desktop/src/updates.ts#probeChannel':
    '可选渠道探测：它的会话身份判据是 `serverURL === target`（"服务端地址还是不是发起探测时那一台"）—— 比代际号更贴切，因为探测结果只对那一台服务端有意义。',
  'packages/host/desktop/src/updates.ts#runManualCheckTask':
    '用户手动动作的编排层：它 await 的每一条子任务（startCheck / startDownload / 安装交接）自己带代际，编排层自身只写 `manualTask` 占位（非会话派生状态）。',
  'packages/host/desktop/src/updates.ts#runBackgroundCheck':
    '后台轮询的编排层：同上，await 的子任务自带代际；它自己只读 `config` 与局部量。',
  'packages/host/desktop/src/updates.ts#readState':
    '模块级的纯文件读取（`open`/`read`/`close`）：不读会话、不落状态，返回值由带代际的调用方判定。',
  'packages/host/desktop/src/updates.ts#disposeUpdates':
    'effect 收尾（dispose）：先置 `disposed` 再等在飞任务 settle —— 它的"代际判定"就是 `disposed` 本身，且此时任何结果都不该再落地。',
}

/**
 * `DEFERRED_CALLBACK_EXEMPTIONS`：**迟到面**里允许延迟落地的白名单
 * （键 = `<相对路径>#<函数名>`）。
 *
 * 迟到面 = 规则 E 的回调实参（promise 续段 / 定时器 / 事件订阅）**与**规则 F 的
 * `try` 续段（`catch`/`finally` 块）—— 两者是同一件事（"现在还没发生、以后才落地"），
 * 所以共用一张表。
 *
 * 与 `AWAIT_EXEMPTIONS` 同口径：登记项必须真的存在、真的仍然被判据抓到（陈旧即红，
 * 见 `it('DEFERRED_CALLBACK_EXEMPTIONS 不得陈旧…')`）。
 *
 * 第二十八轮 FIX-42① 把延迟面从 5 个硬编码名字扩到"定时器 + 事件订阅 + try 续段"
 * 之后，判据第一次在真实代码上取到了 6 处 —— 其中 5 处是**结构上不可能**是状态投影的
 * 形状（`controller.abort()`、`Date.now()`、`runBackgroundCheck().finally(…)`、
 * `handle.close()`、`sync(session).catch(→ logger)`），已由 `NON_LANDING_METHODS` /
 * `NON_LANDING_RECEIVERS` 这两个**精度旋钮**排除（旋钮写在判据里、有理由，比给它们
 * 逐条开豁免更好：豁免是**函数粒度**的，会连带豁免该回调将来真正的落地）。
 * 剩下这一条是真豁免。
 */
const DEFERRED_CALLBACK_EXEMPTIONS: Readonly<Record<string, string>> = {
  'packages/host/enterprise/src/error-reporting.ts#reportErrorReportingStatus':
    '上报失败分支的 `pendingStatusKeys.delete(key)` 摘的是**在飞键**，而该键 = 服务端地址 + `sessionIdentity(session)` + state/reason/dsn_host/level（`statusReportKey` 逐字）—— **自带去重身份**，不投影到"当前会话"。与同函数在 `AWAIT_EXEMPTIONS` 里的登记同源（那里记的是同一个"已报集合"）。',
}

/** 一条判据违规。 */
interface Finding {
  readonly kind:
    | 'await-without-check'
    | 'await-outside-guard'
    | 'entry-not-guarded'
    | 'initSentry-without-predicate'
    // **迟到面**上的未守卫落地：规则 E（延迟回调实参）与规则 F（`try` 的
    // catch/finally 续段）共用这一个 kind —— 两者是同一件事（"现在还没发生、
    // 以后才落地"），detail 里写明是哪一种。
    | 'deferred-callback-unguarded'
  readonly detail: string
}

/** 判据作用域（自检可注入替身，避免"分析器只对自己那份表成立"）。 */
interface Scope {
  readonly exemptions: Readonly<Record<string, string>>
  /** 仓库级入口登记（豁免 + 已知未收口）。 */
  readonly entryExemptions: Readonly<Record<string, string>>
  /** promise 回调豁免（键 = `<相对路径>#<函数名>`）。 */
  readonly deferredExemptions: Readonly<Record<string, string>>
}

const DEFAULT_SCOPE: Scope = {
  exemptions: AWAIT_EXEMPTIONS,
  entryExemptions: {
    ...Object.fromEntries(Object.entries(ENTRY_EXEMPTIONS).map(([file, entry]) => [file, entry.reason])),
    ...KNOWN_UNGUARDED_ENTRIES,
  },
  deferredExemptions: DEFERRED_CALLBACK_EXEMPTIONS,
}

/** 取一个节点的单行摘要（用于断言/报告可定位）。 */
function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `L${line + 1}: ${node.getText(source).replace(/\s+/gu, ' ').slice(0, 90)}`
}

/** 函数自身的名字（`function f()` / `const f = …` / `{ f: … }` / `class { f() {} }`）。 */
function declaredName(node: ts.FunctionLikeDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText()
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent !== undefined) {
    const parent = node.parent
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    if (ts.isPropertyAssignment(parent)) return parent.name.getText()
  }
  return undefined
}

/**
 * 给每个函数一个**稳定标签**：具名函数用自己的名字，匿名函数用
 * `<最近的外层函数名>$<序号>`（序号只在同一外层内计数）。
 *
 * 为什么要稳定：豁免表按这个名字登记；用行号或全局序号会随无关编辑漂移，
 * 于是"豁免表"要么被噪音淹没、要么变成永久免检区。
 */
function functionLabels(source: ts.SourceFile): Map<ts.FunctionLikeDeclaration, string> {
  const labels = new Map<ts.FunctionLikeDeclaration, string>()
  const walk = (node: ts.Node, prefix: string, counters: Map<string, number>): void => {
    if (ts.isFunctionLike(node)) {
      const own = declaredName(node)
      let label = own
      if (label === undefined) {
        const next = (counters.get(prefix) ?? 0) + 1
        counters.set(prefix, next)
        label = `${prefix}$${next}`
      }
      labels.set(node, label)
      ts.forEachChild(node, child => { walk(child, label!, new Map<string, number>()) })
      return
    }
    ts.forEachChild(node, child => { walk(child, prefix, counters) })
  }
  walk(source, '<module>', new Map<string, number>())
  return labels
}

/**
 * 一个函数里出现的代际守卫名（`X.begin()` 或 `X.isCurrent(...)` 的 `X`）。
 *
 * 取**并集**而不是交集：只 `begin()` 的那一类函数（会话变化的处理器本身）也是守卫
 * 的持有者。而"这个文件用不用代际"另有一条更严的判据（{@link usesEpochProtocol}），
 * 要求同一个接收者同时出现两个方法 —— 否则"别的包恰好也有个叫 begin 的游标"
 * （实测：memory-evolve 客户端视图里的 `tasksSeq.current.begin()`）会被误判成守卫。
 */
function guardReceivers(fn: ts.FunctionLikeDeclaration): Set<string> {
  const begun = new Set<string>()
  const compared = new Set<string>()
  const visit = (node: ts.Node): void => {
    // 不进嵌套函数：守卫必须由本函数自己取（`apply()` 里那个不属于 `sync`）。
    if (node !== fn && ts.isFunctionLike(node)) return
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (method === 'begin') begun.add(node.expression.expression.getText())
      if (method === 'isCurrent') compared.add(node.expression.expression.getText())
    }
    ts.forEachChild(node, visit)
  }
  if (fn.body !== undefined) visit(fn.body)
  return new Set([...begun, ...compared])
}

/** 这个文件用不用代际协议（同一个接收者既有 `begin()` 又有 `isCurrent()`）。 */
function usesEpochProtocol(source: ts.SourceFile): boolean {
  const begun = new Set<string>()
  const compared = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (method === 'begin') begun.add(node.expression.expression.getText())
      if (method === 'isCurrent') compared.add(node.expression.expression.getText())
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...begun].some(name => compared.has(name))
}

/** 函数里"代际谓词"的名字（`StillCurrent` 型的参数或局部量，见 `session-events.ts` 规则 3）。 */
function predicateNames(fn: ts.FunctionLikeDeclaration): Set<string> {
  const names = new Set<string>()
  const typed = (type: ts.TypeNode | undefined): boolean =>
    type !== undefined && type.getText().endsWith('StillCurrent')
  if (ts.isFunctionLike(fn)) {
    for (const parameter of fn.parameters) {
      if (ts.isIdentifier(parameter.name) && typed(parameter.type)) names.add(parameter.name.text)
    }
  }
  if (fn.body !== undefined) {
    const visit = (node: ts.Node): void => {
      if (node !== fn && ts.isFunctionLike(node)) return
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && typed(node.type)) {
        names.add(node.name.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(fn.body)
  }
  return names
}

/** `if (!…) return` 里的条件是不是一次代际比对（含 `a || b` 形态）。 */
function isGuardCondition(
  expression: ts.Expression,
  guards: ReadonlySet<string>,
  predicates: ReadonlySet<string>,
): boolean {
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const call = expression.operand
    if (!ts.isCallExpression(call)) return false
    const callee = call.expression
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'isCurrent') {
      return guards.has(callee.expression.getText())
    }
    if (ts.isIdentifier(callee)) return predicates.has(callee.text)
    return false
  }
  if (
    ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return isGuardCondition(expression.left, guards, predicates)
      || isGuardCondition(expression.right, guards, predicates)
  }
  return false
}

/** `if (!<guard>.isCurrent(…)) return` / `if (!<predicate>()) return` 形状的判定。 */
function guardCheckOf(
  statement: ts.Statement,
  guards: ReadonlySet<string>,
  predicates: ReadonlySet<string>,
): boolean {
  if (!ts.isIfStatement(statement)) return false
  if (!isGuardCondition(statement.expression, guards, predicates)) return false
  const then = statement.thenStatement
  return ts.isReturnStatement(then)
    || (ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0]!))
}

/**
 * 语句直接所属的**语句容器**：块，或 `switch` 的 `case`/`default` 子句。
 *
 * 为什么必须把子句也算容器（AB1-03 根因①）：未加花括号的 `case` 里，语句的父节点是
 * `CaseClause` **不是** `Block`；只认 `Block` 时 `enclosingStatement` 会一路走到整个
 * `SwitchStatement`，于是判据比的是"switch **之后**那条语句"——同一个 case 里紧跟
 * await 的写根本不在取值域内（F2：switch 之后恰好是守卫 ⇒ 判据被满足、findings=0，
 * 而函数**读起来有守卫**）。
 */
type StatementContainer = ts.Block | ts.CaseClause | ts.DefaultClause

/** `statement` 直接挂着的容器（块或 case/default 子句）。 */
function containerOf(statement: ts.Statement): StatementContainer | undefined {
  const parent: ts.Node | undefined = statement.parent
  if (parent === undefined) return undefined
  if (ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return parent
  return undefined
}

/** await 面所在的、直接挂在**块或 case/default 子句**下的那条语句。 */
function enclosingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node
  while (current !== undefined) {
    if (ts.isStatement(current) && containerOf(current) !== undefined) return current
    current = current.parent
  }
  return undefined
}

/** 最近的外层函数（含箭头函数）。 */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return undefined
}

/** `statement` 正常执行完之后，**同容器内**的下一条语句。 */
function nextInContainer(statement: ts.Statement): ts.Statement | undefined {
  const container = containerOf(statement)
  if (container === undefined) return undefined
  return container.statements[container.statements.indexOf(statement) + 1]
}

/** `break`（不带标签）跳出的最近一层循环 / `switch`。 */
function nearestBreakable(statement: ts.Statement): ts.Statement | undefined {
  let current: ts.Node | undefined = statement.parent
  while (current !== undefined) {
    if (ts.isIterationStatement(current, false) || ts.isSwitchStatement(current)) return current
    current = current.parent
  }
  return undefined
}

/** 本函数体里的 `label: <语句>`（带标签的 `break`/`continue` 的落点）。 */
function labelledTarget(
  fn: ts.FunctionLikeDeclaration,
  label: string,
): ts.LabeledStatement | undefined {
  let found: ts.LabeledStatement | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (node !== fn && ts.isFunctionLike(node)) return
    if (ts.isLabeledStatement(node) && node.label.text === label) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  if (fn.body !== undefined) visit(fn.body)
  return found
}

/**
 * 一条语句**正常执行完之后**会执行到的下一条语句：沿容器向外、含 `try` 的续段
 * （`try` 块 ⇒ `catch`/`finally`；`catch` 块 ⇒ `finally`）与 `case` 的落穿。
 *
 * 刻意**不**解析 `break`/`continue`/`return` —— 那三种由 {@link afterStatement} 处理，
 * 这样"跳转语句不是终点"这条口径只有一处定义。
 * @param statement - 起点语句。
 * @param fn - 它所在的函数（不许走出函数体，否则会把"下游语句"当成本次续体的后继）。
 * @returns 下一条语句（没有则 undefined）。
 */
function afterNormal(
  statement: ts.Statement,
  fn: ts.FunctionLikeDeclaration,
): ts.Statement | undefined {
  let current: ts.Statement | undefined = statement
  for (let hops = 0; hops < 64 && current !== undefined; hops += 1) {
    const inContainer = nextInContainer(current)
    if (inContainer !== undefined) return inContainer
    const container = containerOf(current)
    if (container === undefined) return undefined
    if (ts.isCaseClause(container) || ts.isDefaultClause(container)) {
      const last = container.statements[container.statements.length - 1]
      const terminates = last !== undefined
        && (ts.isBreakStatement(last) || ts.isContinueStatement(last)
          || ts.isReturnStatement(last) || ts.isThrowStatement(last))
      // 子句末尾是终结语句 ⇒ 不会落穿，交给跳转解析（`break` ⇒ switch 之后）。
      if (terminates) return afterStatement(last!, fn)
      const clauses = container.parent.clauses
      const next = clauses[clauses.indexOf(container as ts.CaseClause) + 1]
      current = next !== undefined && next.statements.length > 0 ? next.statements[0] : (next ?? container.parent.parent)
      continue
    }
    if (fn.body === undefined || !ts.isBlock(fn.body)) return undefined
    if (container === fn.body) return undefined
    const owner = enclosingStatement(container)
    if (owner === undefined) return undefined
    if (owner.getStart() < fn.body.getStart() || owner.getEnd() > fn.body.getEnd()) return undefined
    if (ts.isTryStatement(owner)) {
      // 正常完成路径**只有** finally：`catch` 是抛出路径，由规则 F 单独覆盖
      // （把 catch 也算成"正常后继"会让 `try { await install() } catch { lastError = … }`
      // 这类形状在 await 之后凭空多出一条"没有代际比对"的误报）。
      const continuation = container === owner.tryBlock
        ? owner.finallyBlock
        : (container === owner.catchClause?.block ? owner.finallyBlock : undefined)
      if (continuation !== undefined) {
        if (continuation.statements.length > 0) return continuation.statements[0]
        current = continuation
        continue
      }
    }
    current = owner
  }
  return undefined
}

/**
 * `statement` 执行完之后**按执行序**会执行到的下一条语句（解析 `break`/`continue`）。
 *
 * 与原实现的关键差别（AB1-03 根因②）：原实现把 `break`/`continue` 也算"之后无可落地
 * 语句"，于是「await 后紧跟 `break` 退出循环，循环之后再写状态」（F8）完全不可见。
 * 现在它们解析到**真实跳转目标**：`break` ⇒ 最近的循环/`switch` 之后（带标签 ⇒ 标签
 * 语句之后），`continue` ⇒ 所在循环之后（循环体的再入由循环体自己的 await 覆盖）。
 * @param statement - 起点语句。
 * @param fn - 它所在的函数。
 * @returns 下一条会执行的语句（没有则 undefined）。
 */
function afterStatement(
  statement: ts.Statement,
  fn: ts.FunctionLikeDeclaration,
): ts.Statement | undefined {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return undefined
  if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
    const label = statement.label?.text
    const target = label === undefined ? nearestBreakable(statement) : labelledTarget(fn, label)
    return target === undefined ? undefined : afterStatement(target, fn)
  }
  return afterNormal(statement, fn)
}

/**
 * await 面（`await` 表达式 / `for await`）**执行序上**的下一条语句。
 *
 * `for await` 在 AST 里**没有** `AwaitExpression` 节点（它挂在 `ForOfStatement.awaitModifier`
 * 上），所以它的"后继"是**循环体首句**（每一轮迭代完成后都会回到这里落地）。
 * @param node - await 表达式或 `for await` 语句。
 * @param fn - 它所在的函数。
 * @returns 下一条会执行的语句（没有则 undefined）。
 */
function successorOf(node: ts.Node, fn: ts.FunctionLikeDeclaration): ts.Statement | undefined {
  if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
    return ts.isBlock(node.statement) ? node.statement.statements[0] : node.statement
  }
  const statement = enclosingStatement(node)
  if (statement === undefined) return undefined
  let next = afterNormal(statement, fn)
  // 后继恰好是一条跳转语句时继续解析（`break`/`continue` 不是终点）。
  for (let hops = 0; hops < 32 && next !== undefined; hops += 1) {
    if (!ts.isBreakStatement(next) && !ts.isContinueStatement(next)) break
    next = afterStatement(next, fn)
  }
  return next
}

/** 一棵（不跨嵌套函数的）子树里有没有 await 面（`await` 或 `for await`）。 */
function containsAwaitSurface(node: ts.Node): boolean {
  let found = false
  const visit = (inner: ts.Node): void => {
    if (found) return
    if (inner !== node && ts.isFunctionLike(inner)) return
    if (ts.isAwaitExpression(inner) || (ts.isForOfStatement(inner) && inner.awaitModifier !== undefined)) {
      found = true
      return
    }
    ts.forEachChild(inner, visit)
  }
  visit(node)
  return found
}

/** 观察型调用（日志）：不算"落地"。 */
const OBSERVER_CALLS = new Set(['error', 'warn', 'info', 'debug', 'log', 'trace'])

/**
 * 「落地」的**精度旋钮**：这些方法名结构上**不是**状态投影的写，因此在延迟面里出现
 * 不算"延迟落地"。
 *
 * 为什么需要它（第二十八轮 FIX-42① 实测）：把延迟面从 5 个名字扩到"定时器 + 事件订阅
 * + promise 续段"之后，若"任何非观察型成员调用"都算落地，判据会在真实代码里对
 * `controller.abort()`、`runBackgroundCheck().finally(…)`、`handle.close()` 这类
 * **与"把上一代的数据写进当前代"毫无关系**的形状报红（实测 6 处，全部是这类）。
 * 逐条塞进豁免表不是好出路：豁免按**函数**粒度给，会连带豁免该回调将来真正的落地
 * —— "登记表变成免检区"正是本仓已登记的反面模式。
 *
 * 刻意**保持小**，只列"结构上不可能是状态投影"的三类：观察/日志（日志不是状态）、
 * promise 组合子（回调的返回值不是状态）、资源收尾与取消（关掉/中止一个东西不是
 * 写状态）。宁可漏报一个恰好叫 `close` 的写方法，也不要把判据埋进噪音 ——
 * 兜底仍是规则 A（await 面）与豁免表。
 */
const NON_LANDING_METHODS = new Set([
  ...OBSERVER_CALLS,
  'then', 'catch', 'finally',
  'abort', 'close', 'destroy', 'dispose', 'unref', 'cancel', 'clearTimeout', 'clearInterval',
])

/** 内置全局：这些接收者上的调用不是"会话派生状态"的写（`Date.now()`、`Math.max()`…）。 */
const NON_LANDING_RECEIVERS = new Set([
  'Date', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean',
  'Promise', 'console', 'performance', 'Reflect', 'Symbol', 'RegExp', 'Error',
])

/**
 * 一棵（不跨嵌套函数的）子树里**直接出现**的"会落地状态"的成员调用
 * （`x.settings.update(…)`、`x.emit(…)` 这类形状）。
 *
 * 刻意不把赋值、标识符调用与日志调用算进来：它们要么只是本文件自己的簿记
 * （`inFlight = undefined`），要么是纯观察（`ctx.logger.error`）—— 把它们算进来只会
 * 逼出一张巨大的豁免表，而"登记表变成免检区"正是本仓已登记的反面模式。真正的兜底是
 * 规则 A（await 面）+ 规则 F + 豁免表。
 * @param node - 待扫描的子树（调用方传函数体/续段块）。
 * @returns 第一处落地调用（没有则 undefined）。
 */
function landingCallIn(node: ts.Node): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined
  const scan = (inner: ts.Node): void => {
    if (found !== undefined) return
    if (inner !== node && ts.isFunctionLike(inner)) return
    if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
      const receiver = inner.expression.expression
      const root = ts.isIdentifier(receiver)
        ? receiver.text
        : (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression) ? receiver.expression.text : undefined)
      const landable = !NON_LANDING_METHODS.has(inner.expression.name.text)
        && (root === undefined || !NON_LANDING_RECEIVERS.has(root))
      if (landable) {
        found = inner
        return
      }
    }
    ts.forEachChild(inner, scan)
  }
  scan(node)
  return found
}

/** 一段（不跨嵌套函数的）代码里有没有"代际比对"（`<guard>.isCurrent(…)` 或谓词调用）。 */
function hasGuardCheckIn(
  node: ts.Node,
  guards: ReadonlySet<string>,
  predicates: ReadonlySet<string>,
): boolean {
  let found = false
  const visit = (inner: ts.Node): void => {
    if (found) return
    if (inner !== node && ts.isFunctionLike(inner)) return
    if (ts.isCallExpression(inner)) {
      const callee = inner.expression
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'isCurrent' && guards.has(callee.expression.getText())) {
        found = true
        return
      }
      if (ts.isIdentifier(callee) && predicates.has(callee.text)) {
        found = true
        return
      }
    }
    ts.forEachChild(inner, visit)
  }
  visit(node)
  return found
}

/** 收集 `subscribeSession*` / `subscribePicoSession` / `ctx.on(<会话事件>, cb)` 的回调。 */
function sessionEntries(source: ts.SourceFile): ts.Expression[] {
  const entries: ts.Expression[] = []
  const SUBSCRIBERS = new Set(['subscribeSession', 'subscribeSessionChanges', 'subscribePicoSession'])
  const EVENTS = ['SESSION_CHANGED_EVENT', 'pico/session-changed', 'session/event']
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && SUBSCRIBERS.has(callee.text) && node.arguments.length >= 2) {
        // `subscribeSession(ctx, cb)` / `subscribeSessionChanges(ctx, cb[, probe])` 的回调
        // 是第 2 个实参；`subscribePicoSession(ctx, resolve, cb)` 的是最后一个。
        entries.push(callee.text === 'subscribePicoSession'
          ? node.arguments[node.arguments.length - 1]!
          : node.arguments[1]!)
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'on' && node.arguments.length >= 2) {
        const first = node.arguments[0]!.getText()
        if (EVENTS.some(event => first.includes(event))) entries.push(node.arguments[1]!)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return entries
}

/** 回调（或它引用的同文件具名函数）里有没有代际守卫。 */
function entryIsGuarded(
  entry: ts.Expression,
  named: ReadonlyMap<string, ts.FunctionLikeDeclaration>,
  labels: ReadonlyMap<ts.FunctionLikeDeclaration, string>,
): boolean {
  const guarded = (fn: ts.FunctionLikeDeclaration): boolean =>
    guardReceivers(fn).size > 0 || predicateNames(fn).size > 0
  if (ts.isFunctionLike(entry) && guarded(entry)) return true
  const referenced: string[] = []
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== entry) return
    if (ts.isIdentifier(node)) referenced.push(node.text)
    ts.forEachChild(node, collect)
  }
  collect(entry)
  void labels
  return referenced.some((name) => {
    const fn = named.get(name)
    return fn !== undefined && guarded(fn)
  })
}

/**
 * 对一个源文件跑完 A–E 五条判据。
 * @param text - 源码正文。
 * @param file - 仓库相对路径（豁免表键与定位）。
 * @param scope - 豁免表（缺省 = 正式表）。
 * @returns 违规清单（空 = 全部通过）。
 */
function analyze(
  text: string,
  file: string,
  scope: Scope = DEFAULT_SCOPE,
): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TSX)
  const findings: Finding[] = []
  const labels = functionLabels(source)
  const named = new Map<string, ts.FunctionLikeDeclaration>()
  for (const [fn, label] of labels) if (declaredName(fn) !== undefined) named.set(label, fn)

  // 该文件是不是"用了代际协议" ⇒ 决定 C/E 两条规则是否适用（见 `fileScope`）。
  const epochGuardedFile = fileScope(source)

  const exempted = (fn: ts.FunctionLikeDeclaration): string | undefined =>
    scope.exemptions[`${file}#${labels.get(fn) ?? '<unknown>'}`]

  const visitAwait = (node: ts.Node): void => {
    // await 面 = `await` 表达式 **或** `for await`（AST 里没有 AwaitExpression 节点）。
    const isForAwait = ts.isForOfStatement(node) && node.awaitModifier !== undefined
    if (ts.isAwaitExpression(node) || isForAwait) {
      const fn = enclosingFunction(node)
      const guards = fn === undefined ? new Set<string>() : guardReceivers(fn)
      const predicates = fn === undefined ? new Set<string>() : predicateNames(fn)
      const guarded = fn !== undefined && (guards.size > 0 || predicates.size > 0)
      const label = `${file}#${fn === undefined ? '<top>' : labels.get(fn) ?? '<anonymous>'}`
      const exempt = fn !== undefined && exempted(fn) !== undefined

      if (epochGuardedFile && !guarded && !exempt) {
        // C：用了守卫的文件里，await 面必须住在被守卫的函数里。
        findings.push({ kind: 'await-outside-guard', detail: `${label} 里的 await 没有代际守卫：${where(source, node)}` })
      }
      if (guarded && !exempt) {
        // A：await 面之后（按执行序、解析跳转与落穿）必须紧跟一次比对。
        const next = fn === undefined ? undefined : successorOf(node, fn)
        // `break`/`continue` 已在 successorOf 里解析成真实后继 ⇒ 这里只剩 `return` 是终点。
        const terminal = next === undefined || (ts.isReturnStatement(next) && next.expression === undefined)
        if (!terminal && !guardCheckOf(next!, guards, predicates)) {
          findings.push({
            kind: 'await-without-check',
            detail: `${label} 的 await 之后没有代际比对：${where(source, node)} → 下一条是 ${where(source, next!)}`,
          })
        }
      }
    }
    ts.forEachChild(node, visitAwait)
  }
  visitAwait(source)

  // B：每个会话入口都要抵达一个被守卫的函数（或按文件登记豁免/已知未收口）。
  for (const entry of sessionEntries(source)) {
    if (entryIsGuarded(entry, named, labels)) continue
    if (scope.entryExemptions[file] !== undefined) continue
    findings.push({
      kind: 'entry-not-guarded',
      detail: `${file} 的会话入口没有抵达任何被守卫的函数，且没有登记：${where(source, entry)}`,
    })
  }

  // D：initSentry 必须收到代际谓词（第 5 个实参）。
  const visitInit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'initSentry') {
      const fn = enclosingFunction(node)
      const guards = fn === undefined ? new Set<string>() : guardReceivers(fn)
      const predicates = fn === undefined ? new Set<string>() : predicateNames(fn)
      if (guards.size > 0) {
        const fifth = node.arguments[4]
        const passesPredicate = fifth !== undefined
          && (fifth.getText().includes('.isCurrent(')
            || [...predicates].some(name => fifth.getText().includes(name)))
        if (!passesPredicate) {
          findings.push({
            kind: 'initSentry-without-predicate',
            detail: `${file} 的 initSentry 缺第 5 个实参（代际谓词）：${where(source, node)}`,
          })
        }
      }
    }
    ts.forEachChild(node, visitInit)
  }
  visitInit(source)

  // E：延迟回调里的延迟落地（M-C3 的形态）。
  //
  // 取值域**不再硬编码 5 个名字**（AB1-03 根因③）：`setImmediate`/`setTimeout`/
  // `setInterval`/`process.nextTick` 与事件订阅（`on`/`once`/`addListener`/
  // `prependListener`）同样是"现在注册、以后才跑"的回调面。刻意**不**收 `.map`/
  // `.forEach`/`.filter` 这类同步回调 —— 它们在当前同步轮次内执行，不是迟到面，
  // 收进来只会逼出一张巨大的豁免表。
  if (epochGuardedFile) {
    const deferredProperties = new Set([
      'then', 'catch', 'finally', 'queueMicrotask',
      'setTimeout', 'setImmediate', 'setInterval', 'nextTick',
      'on', 'once', 'addListener', 'prependListener',
    ])
    const deferredIdentifiers = new Set([
      'queueMicrotask', 'Promise', 'setTimeout', 'setImmediate', 'setInterval',
    ])
    const visitDeferred = (node: ts.Node): void => {
      const callbacks: ts.Expression[] = []
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const isDeferred = (ts.isPropertyAccessExpression(callee) && deferredProperties.has(callee.name.text))
          || (ts.isIdentifier(callee) && deferredIdentifiers.has(callee.text))
        if (isDeferred) callbacks.push(...node.arguments)
        if (ts.isNewExpression(node) && node.expression.getText() === 'Promise') callbacks.push(...node.arguments)
      }
      for (const callback of callbacks) {
        if (!ts.isFunctionLike(callback)) continue
        const fn = callback as ts.FunctionLikeDeclaration
        const guards = guardReceivers(fn)
        const predicates = predicateNames(fn)
        if (guards.size > 0 || predicates.size > 0) continue
        if (fn.body === undefined) continue
        if (landingCallIn(fn.body) === undefined) continue
        const label = `${file}#${labels.get(fn) ?? '<anonymous>'}`
        if (scope.deferredExemptions[label] !== undefined) continue
        findings.push({
          kind: 'deferred-callback-unguarded',
          detail: `${label} 是 promise 回调里的延迟落地，却没有代际守卫：${where(source, callback)}`,
        })
      }
      ts.forEachChild(node, visitDeferred)
    }
    visitDeferred(source)
  }

  // F：`try` 的续段是**迟到面**（AB1-03 的 F3）。
  //
  // `finally` 在守卫 `return` 的路径上**照样执行** ⇒ 块内的落地不是"被守卫之后的
  // 代码"：`try { const d = await load(); if (!epochs.isCurrent(epoch)) return; apply(d) }
  // finally { ctx.settings.update('late', lastSeen) }` 里那个 `return` 根本挡不住
  // finally 的写。判据：try 块内出现过 await 面时，catch/finally 块内的"直接落地"
  // 必须在该块内自带代际比对，或登记豁免（与规则 E 共用同一张表）。
  if (epochGuardedFile) {
    const visitTry = (node: ts.Node): void => {
      if (ts.isTryStatement(node) && containsAwaitSurface(node.tryBlock)) {
        const fn = enclosingFunction(node)
        const guards = fn === undefined ? new Set<string>() : guardReceivers(fn)
        const predicates = fn === undefined ? new Set<string>() : predicateNames(fn)
        for (const continuation of [node.catchClause?.block, node.finallyBlock]) {
          if (continuation === undefined) continue
          if (landingCallIn(continuation) === undefined) continue
          if (hasGuardCheckIn(continuation, guards, predicates)) continue
          const label = `${file}#${fn === undefined ? '<top>' : labels.get(fn) ?? '<anonymous>'}`
          if (scope.deferredExemptions[label] !== undefined) continue
          findings.push({
            kind: 'deferred-callback-unguarded',
            detail: `${label} 的 try 续段（catch/finally）是 await 之后的迟到落地，却没有代际守卫：${where(source, continuation)}`,
          })
        }
      }
      ts.forEachChild(node, visitTry)
    }
    visitTry(source)
  }

  return findings
}

/**
 * 一个源文件在不在代际判据的**适用面**里（C/E 两条规则的取值域）。
 *
 * 判据是两条**或**关系（2026-09-27 修，AA1 §证伪-1 的 M-B）：
 *  1. 文件里出现了代际协议（同一接收者既有 `begin()` 又有 `isCurrent()`）；
 *  2. **或者**文件里某个会话入口抵达了一个带守卫的函数（`begin()` 或 `isCurrent()`）。
 *
 * 为什么必须有第 2 条：M-B 那种"把守卫的**比对**整段删掉、只留 `begin()`"的形态会让
 * 第 1 条不再成立（文件里再没有 `isCurrent`）⇒ 文件整个被判据跳过，而入口又因为
 * `begin()` 还在而"看起来被守卫" —— 两条规则**同时**放过它（旧判据 6/6 全绿）。
 * 反过来，只看 `begin()` 也不行：别的包恰好有个叫 `begin` 的游标（实测 memory-evolve
 * 客户端视图的 `tasksSeq.current.begin()`）会把无关文件拖进适用面。两条或起来才对。
 * @param source - 已解析的源文件。
 * @returns 在适用面里为 true。
 */
function fileScope(source: ts.SourceFile): boolean {
  if (usesEpochProtocol(source)) return true
  const labels = functionLabels(source)
  const named = new Map<string, ts.FunctionLikeDeclaration>()
  for (const [fn, label] of labels) if (declaredName(fn) !== undefined) named.set(label, fn)
  return sessionEntries(source).some(entry => entryIsGuarded(entry, named, labels))
}

/** 一个源文件里"用了代际协议"吗（见 {@link fileScope}）。 */
function isEpochGuardedFile(text: string, file: string): boolean {
  return fileScope(
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TSX),
  )
}

/** 读一个源文件（判据失败时给出可定位的文件名）。 */
function readSource(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
}

describe('接线判据：会话代际守卫（AST，仓库级扫描根）', () => {
  const sources = collectSources().map(repoPath)

  it('扫描根是仓库级的：至少覆盖到 enterprise 的四条 + desktop 的 updates.ts', () => {
    // 前置断言：判据不能空转（扫描根坏了会让下面所有用例"全绿"）。
    expect(sources.length, '扫描根一个源文件都没收到 ⇒ 判据会空转').toBeGreaterThan(50)
    expect(sources).toEqual(expect.arrayContaining([
      'packages/host/enterprise/src/bootstrap.ts',
      'packages/host/desktop/src/updates.ts',
      'packages/host/browser/src/index.ts',
    ]))
  })

  it('用了代际守卫的文件里，A/C/D/E 四条规则全部成立', () => {
    const findings: string[] = []
    for (const file of sources) {
      const text = readSource(file)
      if (!isEpochGuardedFile(text, file)) continue
      for (const finding of analyze(text, file)) findings.push(`${file} [${finding.kind}] ${finding.detail}`)
    }
    expect(findings, '代际守卫的接线不完整').toEqual([])
  })

  it('仓库级入口判据：每个会话入口都被守卫或已登记（新增未守卫入口即红）', () => {
    const findings: string[] = []
    for (const file of sources) {
      const text = readSource(file)
      if (sessionEntries(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)).length === 0) continue
      for (const finding of analyze(text, file)) {
        if (finding.kind === 'entry-not-guarded') findings.push(`${file}: ${finding.detail}`)
      }
    }
    expect(findings, '这些会话入口既没有代际守卫、也没有登记豁免/已知未收口').toEqual([])
  })

  /**
   * 一张入口登记表是不是**仍然被需要**：把该文件从表里临时摘掉之后，判据必须重新
   * 抓到它。这是"不得陈旧"的双向判据 —— 站点一旦被收口，登记项立刻变红并要求删除，
   * 豁免表因此不会慢慢变成免检区（本仓已登记的反面模式）。
   * @param file - 仓库相对路径。
   * @returns 摘掉登记后仍被判为"未守卫入口"时为 true。
   */
  function stillNeedsRegistration(file: string): boolean {
    const scope: Scope = {
      ...DEFAULT_SCOPE,
      entryExemptions: Object.fromEntries(
        Object.entries(DEFAULT_SCOPE.entryExemptions).filter(([key]) => key !== file),
      ),
    }
    return analyze(readSource(file), file, scope).some(f => f.kind === 'entry-not-guarded')
  }

  it('ENTRY_EXEMPTIONS 不得陈旧（入口消失 / 已收口 / 见证机制不见了三向都红）', () => {
    for (const [file, entry] of Object.entries(ENTRY_EXEMPTIONS)) {
      const text = readSource(file)
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      expect(sessionEntries(source).length, `${file} 已经没有任何会话入口了（陈旧登记 = 免检区）`).toBeGreaterThan(0)
      expect(
        isEpochGuardedFile(text, file),
        `${file} 已经有代际守卫了 —— 请把它从 ENTRY_EXEMPTIONS 里删掉（豁免要真的被需要）`,
      ).toBe(false)
      expect(
        text.includes(entry.witness),
        `${file} 的见证机制 \`${entry.witness}\` 已经不在文件里了 —— "别的机制"没了，豁免就失去依据，请收口或改写登记`,
      ).toBe(true)
      expect(entry.reason.length, `${file} 必须写明豁免理由`).toBeGreaterThan(20)
    }
  })

  it('KNOWN_UNGUARDED_ENTRIES 不得陈旧（收口后必须删除登记项）', () => {
    for (const [file, reason] of Object.entries(KNOWN_UNGUARDED_ENTRIES)) {
      const source = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true)
      expect(sessionEntries(source).length, `${file} 已经没有任何会话入口了（陈旧登记）`).toBeGreaterThan(0)
      expect(
        stillNeedsRegistration(file),
        `${file} 已经收口了 —— 请把它从 KNOWN_UNGUARDED_ENTRIES 里删掉（"已知未收口"不许变成永久免检区）`,
      ).toBe(true)
      expect(reason.length, `${file} 必须写明确认事项（缺陷编号/后果）`).toBeGreaterThan(40)
    }
  })

  it('AWAIT_EXEMPTIONS 不得陈旧（登记的函数必须真的存在、真的含 await）', () => {
    for (const [key, reason] of Object.entries(AWAIT_EXEMPTIONS)) {
      const hash = key.indexOf('#')
      const file = key.slice(0, hash)
      const fnName = key.slice(hash + 1)
      const text = readSource(file)
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const fn = [...functionLabels(source)].find(([, label]) => label === fnName)?.[0]
      expect(fn, `豁免表里的 ${key} 已经不存在了（陈旧登记 = 免检区）`).toBeDefined()
      let hasAwait = false
      const scan = (node: ts.Node): void => {
        if (node !== fn && ts.isFunctionLike(node)) return
        if (ts.isAwaitExpression(node)) hasAwait = true
        ts.forEachChild(node, scan)
      }
      scan(fn!)
      expect(hasAwait, `豁免表里的 ${key} 已经没有 await 了`).toBe(true)
      expect(reason.length, `${key} 必须写明豁免理由`).toBeGreaterThan(20)
    }
  })

  /**
   * 一张迟到面登记表是不是**仍然被需要**：把该条从表里临时摘掉之后，判据必须重新抓到
   * 同一个函数。这是"不得陈旧"的双向判据 —— 站点的落地一旦被收口（或整个回调消失），
   * 登记项立刻变红并要求删除（豁免表因此不会慢慢变成免检区）。
   * @param key - `<仓库相对路径>#<函数名>`。
   * @returns 摘掉登记后仍被判为"迟到面未守卫落地"时为 true。
   */
  function deferredStillNeedsRegistration(key: string): boolean {
    const hash = key.indexOf('#')
    const file = key.slice(0, hash)
    const scope: Scope = {
      ...DEFAULT_SCOPE,
      deferredExemptions: Object.fromEntries(
        Object.entries(DEFAULT_SCOPE.deferredExemptions).filter(([entry]) => entry !== key),
      ),
    }
    return analyze(readSource(file), file, scope).some(f => f.kind === 'deferred-callback-unguarded')
  }

  it('DEFERRED_CALLBACK_EXEMPTIONS 不得陈旧（函数消失 / 已收口 / 空理由三向都红）', () => {
    for (const [key, reason] of Object.entries(DEFERRED_CALLBACK_EXEMPTIONS)) {
      const hash = key.indexOf('#')
      expect(hash > 0, `${key} 的键必须写成 <相对路径>#<函数名>`).toBe(true)
      const file = key.slice(0, hash)
      const fnName = key.slice(hash + 1)
      const text = readSource(file)
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const fn = [...functionLabels(source)].find(([, label]) => label === fnName)?.[0]
      expect(fn, `豁免表里的 ${key} 已经不存在了（陈旧登记 = 免检区）`).toBeDefined()
      expect(
        deferredStillNeedsRegistration(key),
        `${key} 已经收口了 —— 请把它从 DEFERRED_CALLBACK_EXEMPTIONS 里删掉（豁免要真的被需要）`,
      ).toBe(true)
      expect(reason.length, `${key} 必须写明豁免理由`).toBeGreaterThan(40)
    }
  })

  it('判据自检：未守卫的 await / 未守卫的新入口 / 漏传谓词 / 三种 AA1 绕过形态都能被抓到', () => {
    const empty: Scope = { exemptions: {}, entryExemptions: {}, deferredExemptions: {} }
    // ① await 之后没有比对 ⇒ await-without-check。
    const base = `
      const epochs = createSessionEpoch()
      const sync = async (s) => {
        const epoch = epochs.begin()
        const x = await load(s)
        doWrite(x)
      }
      subscribeSession(ctx, (s) => { void sync(s) })
    `
    expect(analyze(base, 'synthetic.ts', empty).map(f => f.kind)).toContain('await-without-check')

    // ② 未守卫的新 sync 入口 ⇒ await-outside-guard + entry-not-guarded（C/B 两条）。
    const unguardedEntry = `
      const sync2 = async (s) => { const x = await load(s); doWrite(x) }
      subscribeSession(ctx, (s) => { void sync2(s) })
    `
    const findings2 = analyze(unguardedEntry, 'synthetic.ts', empty).map(f => f.kind)
    expect(findings2).toContain('entry-not-guarded')

    // ③ initSentry 漏传谓词 ⇒ initSentry-without-predicate。
    const missingPredicate = `
      const epochs = createSessionEpoch()
      const sync = async (s) => {
        const epoch = epochs.begin()
        const cfg = await load(s)
        if (!epochs.isCurrent(epoch)) return
        await initSentry(cfg.dsn, 'r1')
      }
      subscribeSession(ctx, (s) => { void sync(s) })
    `
    expect(analyze(missingPredicate, 'synthetic.ts', empty).map(f => f.kind)).toContain('initSentry-without-predicate')

    // ④ 完整形状（含谓词、含比对）⇒ 零违规（正面自检：分析器不是恒红）。
    const sound = `
      const epochs = createSessionEpoch()
      const sync = async (s) => {
        const epoch = epochs.begin()
        const cfg = await load(s)
        if (!epochs.isCurrent(epoch)) return
        await initSentry(cfg.dsn, 'r1', 'error', false, () => epochs.isCurrent(epoch))
      }
      subscribeSession(ctx, (s) => { void sync(s) })
    `
    expect(analyze(sound, 'synthetic.ts', empty)).toEqual([])

    // ── AA1 §证伪-1 的三条绕过形态（旧判据 6/6 全绿，全部必须被抓住）──

    // M-A：**新增第五个同族文件**，完全无守卫 ⇒ 扫描根必须看见它。
    const mutationA = `
      const sync = async (session) => {
        const channel = await fetchJSON(session.serverURL, '/api/client/v2/channel')
        await ctx.settings.update('channel' as SettingsNamespace, channel)
      }
      subscribeSession(ctx, (session) => { void sync(session) })
    `
    const findingsA = analyze(mutationA, 'packages/host/newpkg/src/channel-sync.ts', empty).map(f => f.kind)
    expect(
      findingsA,
      'M-A：新增的未守卫投影文件没有被抓到（旧判据的 GUARDED_FILES 是硬编码表，根本不读新文件）',
    ).toContain('entry-not-guarded')

    // M-A 的第二种形态：同一文件**确实用了**代际协议（规则 C 因此适用），但入口多出
    // 一条没有守卫的 async 投影 ⇒ await-outside-guard。
    const mutationA2 = `
      const epochs = createSessionEpoch()
      const sync = async (s) => {
        const epoch = epochs.begin()
        const x = await load(s)
        if (!epochs.isCurrent(epoch)) return
        apply(x)
      }
      const sync2 = async (s) => { const y = await load(s); writeLate(y) }
      subscribeSession(ctx, (s) => { void sync(s); void sync2(s) })
    `
    expect(
      analyze(mutationA2, 'packages/host/enterprise/src/late.ts', empty).map(f => f.kind),
      'M-A2：同一文件里新增的未守卫 sync 入口没有被抓到',
    ).toContain('await-outside-guard')

    // M-B：守卫**整段删掉**、await 落在 `try` 块尾（空后继）⇒ 规则 A 必须沿执行序向外找。
    const mutationB = `
      const sync = async (session) => {
        const epoch = epochs.begin()
        const builtIn = builtin()
        let channel = null
        try {
          channel = await fetchJSON(session.serverURL, '/api/client/v2/channel')
        } catch {
          channel = null
        }
        ctx.emit('pico/channel-changed', channel ?? builtIn)
      }
      subscribeSession(ctx, (session) => { void sync(session) })
    `
    expect(
      analyze(mutationB, 'packages/host/enterprise/src/channel-sync.ts', empty).map(f => f.kind),
      'M-B：await 在 try 块尾（块尾空后继）时，规则 A 被空洞满足',
    ).toContain('await-without-check')

    // M-C3：`.then()` 回调里的投影（回调内**没有 await 节点**）⇒ 规则 E 必须抓到。
    const mutationC = `
      const epochs = createSessionEpoch()
      const sync = async (session) => {
        const epoch = epochs.begin()
        if (session !== null) {
          void getBootstrap(session).then((late) => {
            ctx.settings.update('late-projection' as SettingsNamespace, {
              baseURL: session.serverURL,
            }).catch(() => undefined)
          })
        }
        const cfg = await load(session)
        if (!epochs.isCurrent(epoch)) return
        ctx.settings.update('gateway' as SettingsNamespace, cfg)
      }
      subscribeSession(ctx, (session) => { void sync(session) })
    `
    expect(
      analyze(mutationC, 'packages/host/enterprise/src/gateway-model.ts', empty).map(f => f.kind),
      'M-C3：`.then()` 回调里的延迟投影没有被抓到',
    ).toContain('deferred-callback-unguarded')
  })

  /**
   * AB1-03 的**九种取值域缺口形态**，每一种都在这里有一条合成正例（第二十八轮 FIX-42①）。
   *
   * 这些形态都是"判据读起来成立、其实看不见"的真实语法：取证方式是在副本里造**真文件**
   * 并跑判据本体（`temp/r21/fix-42/probe/run-forms.mjs`）。修前 9 条全绿，修后 9 条全红。
   * 配套的正控（C1–C6）证明夹具不是恒绿。
   */
  it('判据自检：AB1-03 的九种取值域缺口形态逐个都能被抓到', () => {
    const empty: Scope = { exemptions: {}, entryExemptions: {}, deferredExemptions: {} }
    const preamble = `
      const epochs = createSessionEpoch()
      const markerEpoch = epochs.begin()
      export function scopeMarker(): boolean { return epochs.isCurrent(markerEpoch) }
    `
    // [形态名, 函数体, 期望的 finding kind, 为什么这条形态以前是绿的]
    const forms: readonly (readonly [string, string, string, string])[] = [
      [
        'F1c 未加花括号的 case（switch 是函数尾）',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          switch (session.mode) {
            case 'remote':
              var data = await load(session)
              ctx.settings.update('late', data)
              break
            default:
              break
          }
          void epoch
        }`,
        'await-without-check',
        'enclosingStatement 只沿 Block 上溯 ⇒ 走到整个 SwitchStatement，case 内的写不在面内',
      ],
      [
        'F2 未加花括号的 case + switch 之后放守卫（最重：函数读起来有守卫）',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          switch (session.mode) {
            case 'remote':
              var data = await load(session)
              ctx.settings.update('late', data)
              break
          }
          if (!epochs.isCurrent(epoch)) return
          apply()
        }`,
        'await-without-check',
        '同上；且 switch 之后恰好是守卫 ⇒ 判据被满足、findings=0，写落在守卫之前',
      ],
      [
        'F3 await 之后的 finally 里落地',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          try {
            const data = await load(session)
            if (!epochs.isCurrent(epoch)) return
            apply(data)
          } finally {
            ctx.settings.update('late', lastSeen)
          }
        }`,
        'deferred-callback-unguarded',
        '规则 A 只看 await 的直落后继（这里是守卫）；finally 在守卫 return 的路径上照样执行 ⇒ 无人看',
      ],
      [
        'F4 for await 循环体（AST 里没有 AwaitExpression 节点）',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          for await (const chunk of stream(session)) {
            ctx.settings.update('late', chunk)
          }
          void epoch
        }`,
        'await-without-check',
        'for await 挂在 ForOfStatement.awaitModifier 上，A/C/E 三条同时看不见它',
      ],
      [
        'F5 setImmediate 回调',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          const data = await load(session)
          if (!epochs.isCurrent(epoch)) return
          setImmediate(() => { ctx.settings.update('late', data) })
        }`,
        'deferred-callback-unguarded',
        '规则 E 的延迟面硬编码 then/catch/finally/queueMicrotask/Promise，setImmediate 不在面内',
      ],
      [
        'F6 setTimeout 回调',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          const data = await load(session)
          if (!epochs.isCurrent(epoch)) return
          setTimeout(() => { ctx.settings.update('late', data) }, 0)
        }`,
        'deferred-callback-unguarded',
        '同 F5',
      ],
      [
        'F7 emitter.on 回调',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          const data = await load(session)
          if (!epochs.isCurrent(epoch)) return
          bus.on('ready', () => { ctx.settings.update('late', data) })
        }`,
        'deferred-callback-unguarded',
        '同 F5（事件订阅同样不在面内）',
      ],
      [
        'F8 await 后 break 退出循环、循环之后再写',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          while (true) {
            var data = await load(session)
            break
          }
          ctx.settings.update('late', data)
          void epoch
        }`,
        'await-without-check',
        'terminal 把 break/continue 也算"之后无可落地语句" ⇒ 循环之后的写完全不可见',
      ],
      [
        'F9 守卫之后的 for await 循环体',
        `export async function probe(session: any, ctx: any): Promise<void> {
          const epoch = epochs.begin()
          const stream = await open(session)
          if (!epochs.isCurrent(epoch)) return
          for await (const chunk of stream) { ctx.settings.update('late', chunk) }
        }`,
        'await-without-check',
        '守卫只挡到 for await 开始之前；每一轮迭代之后落地仍属迟到面，而 AST 里没有 AwaitExpression',
      ],
    ]

    for (const [name, body, kind, why] of forms) {
      const findings = analyze(`${preamble}${body}`, 'synthetic.ts', empty)
      expect(
        findings.map(f => f.kind),
        `${name}：这条形态以前是绿的（${why}），现在必须被咬住`,
      ).toContain(kind)
    }

    // 正控：同样的夹具在**有守卫**时不报（分析器不是恒红 —— 否则上面九条就是空断言）。
    const guarded = `
      const epochs = createSessionEpoch()
      const markerEpoch = epochs.begin()
      export function scopeMarker(): boolean { return epochs.isCurrent(markerEpoch) }
      export async function probe(session: any, ctx: any): Promise<void> {
        const epoch = epochs.begin()
        switch (session.mode) {
          case 'remote':
            var data = await load(session)
            if (!epochs.isCurrent(epoch)) return
            ctx.settings.update('late', data)
            break
        }
        if (!epochs.isCurrent(epoch)) return
        apply()
      }
    `
    expect(analyze(guarded, 'synthetic.ts', empty), '加了比对就该零违规（否则九条正例可能是空断言）').toEqual([])
  })
})

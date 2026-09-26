/**
 * tests/read-failure-write-gate.test.js — FIX-47① 的**仓库级判据**（第三十二轮）：
 * `lib/**` 里凡"catch 吞掉读失败 ⇒ 留下空基线 ⇒ 该值进回写路径"的形态，必须
 * **显式登记**（新增未登记即红）。与 FIX-42③ 在 `skills-manager.js` 上做的
 * `REGISTERED_WITHOUT_ANCHOR` 同形：**角色取面 + 逐条登记 + 双向对账**。
 *
 * ## 为什么需要"仓库级"这一条
 *
 * 这个缺陷族在本仓已经复发**四次**（第二十七轮 → 第三十轮 FIX-45③ 收口 6 处 →
 * 第三十一轮 AD1 又找出 2 处）。最刺眼的一次是：`session-overrides.json` 在
 * `temp/r21/fix-44/REPORT.md:397-401` **已被逐字登记为"同族确证点位"**，而下一轮
 * 改了**同一个文件**却既没修也没列进未做项 —— **登记了却不在下一轮的题面里 =
 * 等于没登记**。本文件把"登记"变成**可复算且双向**的判据，任何人再写一个这样的
 * 点位，本用例当场红。
 *
 * ## 面与形态的定义
 *
 * 全部机械定义在 {@link module:tests/helpers/readfail-writeback-scan}（连同**已知的
 * 取值域边界**，都写在那个模块头里，不藏在这里）。要点：
 *
 *  - 候选 = `try { … 读了一个会被回写的路径 … } catch { …吞掉错误且留下空基线… }`；
 *  - 带"记失败标记 / 写前闸门"（`noteLoadFailure` / `loadErrors` / `loadFailed` /
 *    `assert*Writable` / `stateLoadError =` / `quarantineState`）的 catch **不是候选**
 *    —— 那正是 FIX-45③ / FIX-47① 的目标形态。**所以本用例同时是那两处修复的
 *    前向守卫**：谁把闸门拆掉，点位立刻掉回候选并因未登记而红（见文末变异证据）。
 *
 * ## 登记表的判读规则
 *
 * 每条登记必须给出**结论**与**理由**，结论只有两种：
 *  - `not-family`：读失败的返回值**根本不进回写**（写点在 `return` 之前不可能发生，
 *    或该值只决定"要不要跳过这一条"）；
 *  - `defer`：**同族确证**（读失败 ⇒ 空基线 ⇒ 整表/整文件回写），本轮**未修**，
 *    必须同时给出 `fix`（精确改法）—— 缺 `fix` 即红，防止"登记"退化成本轮不做的借口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanLib } from './helpers/readfail-writeback-scan.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 登记表：`<lib 相对路径>#<函数>#<形态>#<共享 token>#<同形序号>` → 结论 + 理由。
 *
 * 键不含行号（行号会漂，登记表就变成噪音）；`<同形序号>` 让"同一个函数里再写一个
 * 一模一样形态的 catch"也会进位 ⇒ 未登记即红。
 *
 * 本轮（第三十二轮 FIX-47①）逐条读过 `lib/**` 的 63 个模块后落定；`defer` 四条是
 * **同族确证但本轮不在修复面内**，各自给了精确改法（见 REPORT 的"筛过的同族点位清单"）。
 */
const SCAN_REGISTRY = new Map([
  // ---- not-family（读失败的返回值不进回写） ----
  ['coi/broadcast.js#read#bare#bodyFile#1', {
    verdict: 'not-family',
    reason: '读的是**消息全文缓存**（`msg.bodyFile`），读失败只是回退到内联预览（`content` 的初值就是 `msg.content`）。`bodyFile` 只在**新消息落盘**时写一次，这条读路径不写它。',
  }],
  ['coi/skills-sync.js#preserveDisableFlag#return-empty#destDir#1', {
    verdict: 'not-family',
    reason: '`return false` 只决定"要不要在**暂存内容**里补禁用标记"，而本函数唯一的写点 `writeFileAtomicSafeAt(stagedFile, …)` 排在两处 `return false` **之后** ⇒ 读失败时一次写都不发生，不存在"以空基线回写"。',
  }],
  ['coi/skills-sync.js#preserveDisableFlag#return-empty#stagedFile#1', {
    verdict: 'not-family',
    reason: '同上：读暂存文件失败 ⇒ `return false`（不补标记、不写），写点在其后。',
  }],
  ['notify-web.js#full#bare#bodyFile#1', {
    verdict: 'not-family',
    reason: '与 `coi/broadcast.js` 同形：纯读展示面（读全文失败退回内联预览），`bodyFile` 的唯一写点在发布路径（新消息落盘）而不在本函数，读值不回写。',
  }],
  ['skills-manager.js#scanSkillFile#return-empty#file#1', {
    verdict: 'not-family',
    reason: '只读扫描：读失败 ⇒ 该候选被跳过（`return null`），调用方把它当作"这个文件不是技能"；本函数只构造候选对象，不写任何文件。',
  }],
  ['skills-manager.js#get#return-empty#file#1', {
    verdict: 'not-family',
    reason: '只读 provider 的 `get()`：读失败 ⇒ `undefined`＝当次取不到内容（面板按"读不到"处理），本函数不写盘，其返回值也没有被任何写路径当基线。',
  }],
  ['skills.js#listSkills#bare#name#1', {
    verdict: 'not-family',
    reason: '列表扫描里的逐个技能读取：读失败 ⇒ 该条目从结果里略过（`catch { /* skip */ }`），返回的数组只用于渲染候选列表，没有任何回写路径消费它。',
  }],
  ['skills.js#listPendingSkills#bare#name#1', {
    verdict: 'not-family',
    reason: '待确认队列的列表扫描：读失败 ⇒ 该条目从结果里略过；返回的列表只喂给面板渲染与审批动作，函数本身不写任何文件。',
  }],
  ['update.js#acquireUpdateLock#bare#lockPath#1', {
    verdict: 'not-family',
    reason: '**不同族**：这里读失败被解释成"锁损坏" ⇒ 走**抢占**（`rename` 搬走再核对内容），是"防死锁优先于防误抢"的**有意**取舍（代码注释逐字写着 `// 损坏锁 → 抢占`），不是"以空基线回写"。',
  }],
  ['update.js#acquireUpdateLock#bare#reaped#1', {
    verdict: 'not-family',
    reason: '不同族：读**已搬走**的锁文件失败 ⇒ 当作"无人能持有的损坏锁"删除（`!reapedInfo` 分支），语义是抢占收尾，不是"以空基线回写"；且搬走前后有内容一致性核对（`same`）。',
  }],
  ['update.js#releaseUpdateLock#bare#lockPath#1', {
    verdict: 'not-family',
    reason: '释放锁：读失败一律不删（`catch { /* 忽略 */ }`，只有 pid+token 都与本进程一致才 `unlinkSync`）—— 保守方向，读失败不会导致任何写入或删除。',
  }],

  // ---- defer（同族确证，本轮不在修复面内；每条都给精确改法） ----
  ['coi/stats.js#loadAdapterStats#return-empty#file#1', {
    verdict: 'defer',
    reason: '同族确证：`recordAdapterStats()` 先 `loadAdapterStats(file)` 再 `writeFileAtomicSafeAt(file, 整表)`，而 `loadAdapterStats` 把**任何**读失败/解析失败都变成 `{}` ⇒ 一次 EACCES 就让**其它适配器**的耗时聚合被整表抹掉，且写路径整体静默（"统计不影响任务"）。本轮未修：影响面仅为派生统计（非用户配置、非用户内容），修它要把 `recordAdapterStats` 的"静默即成功"语义改成可判别失败，属独立泳道。',
    fix: '在 `coi/stats.js` 的 `recordAdapterStats` 里改为严格读：`ENOENT` 才用 `{}`，其余错误（含内容不可解析）直接 `return`（本次不记录、不写盘），并按需补一条"读失败 ⇒ 文件逐字节不变"的用例。',
  }],
  ['coi/stats.js#recordAdapterStats#bare#file#1', {
    verdict: 'not-family',
    reason: '这是 `recordAdapterStats` **外层**的 catch（吞掉写失败本身，代码注释逐字写着"统计写失败不影响任务"）：它不读任何路径，也不回写；真正把读失败固化成写入的是内层 `loadAdapterStats` 的 `return {}`（见上一条 defer）。',
  }],
  ['coi/ws-coord.js#load#bare#file#1', {
    verdict: 'defer',
    reason: '同族确证：`#load()` 的裸 catch 让 `this.locks` 停在与 `[]` 不可区分的状态，而防抖的 `#save()` 会把 `{version:1, locks:this.locks}` **整表回写** ⇒ 一次瞬时读失败后，**其它会话**的文件占用锁全部从盘上消失（跨会话写冲突检测静默失效）。本轮未修：`ws-coord` 的锁语义与清理定时器有自己的不变量面，需连同 `#pruneExpired`/`prune()` 一起验证。',
    fix: '给 `#load()` 加 `this.loadFailed` 标记（只有 `ENOENT` 视为空表），`#save()` 在标记为真时**拒绝写盘**并记一次可检索日志；补"读失败 ⇒ 一次写都不发生、其它会话锁不被抹掉"的用例。',
  }],
  ['skills-manager.js#readStateFile#bare#file#1', {
    verdict: 'defer',
    reason: '同族确证：`readStateFile()` 的裸 catch ⇒ `loadState()` 以 `{disabled:[],customDirs:[]}` 起步，而面板 toggle（`:893`/`:906`）与"投影"（`:749`）都会 `saveState(stateFile, state)` **整表回写** ⇒ 一次 EACCES 就让**其它已禁用技能**被静默重新启用。本轮未修：`skills-manager` 的禁用态同时驱动运行时 shadow 与文件投影（N1b 防抖窗口），改它要与那两处一起验证。',
    fix: '`readStateFile` 区分 `ENOENT`（返回 `null`，照旧走 legacy 迁移）与其余错误（返回/抛出可判别的失败）；`loadState` 把失败标记带到 `saveState` 调用点，在标记为真时拒写并如实回错；补"读失败 ⇒ 禁用列表不被整表换掉"的用例。',
  }],
  ['skills.js#readSkill#return-empty#name#1', {
    verdict: 'defer',
    reason: '同族确证：`readSkill()` 把**任何**读失败都变成 `undefined`，而 `skill_manage` 的三处调用点把 `undefined` 读作"这个技能不存在"——`create` 会因此把**已存在的** SKILL.md 当成新技能覆盖（`:715` 的存在性判定被读失败绕过），`patch` 会回"技能不存在"（保守档）。本轮未修：`skills.js` 的存在性判定服务于 create/patch/read 三条路径与 per-name 锁，改动面比前三条大。',
    fix: '`readSkill` 只把 `ENOENT` 当作"不存在"，其余错误抛出；`skill_manage` 的三个调用点各自 `try/catch` 并回"读不到该技能（拒写）"，补"读失败 ⇒ create 不覆盖既有文件"的用例。',
  }],
])

/** 扫一次 `lib/**`，返回 `[{rel, key, line, shape, body}]`。 */
function scanCandidates() {
  const out = []
  for (const mod of scanLib(PACKAGE_ROOT)) {
    for (const candidate of mod.candidates) {
      out.push({ rel: mod.rel, key: `${mod.rel}#${candidate.key}`, line: candidate.line, shape: candidate.shape, body: candidate.body })
    }
  }
  return out
}

test('FIX-47① 仓库级：`lib/**` 每个"读失败⇒空基线⇒回写"候选都已登记（新增未登记即红）', () => {
  const candidates = scanCandidates()
  const unregistered = candidates.filter((c) => !SCAN_REGISTRY.has(c.key))
  assert.deepEqual(
    unregistered.map((c) => `${c.key}  (lib/${c.rel}:${c.line}, ${c.shape}${c.body === '' ? '' : `, ${c.body}`})`),
    [],
    '新出现（或闸门被拆掉而掉回来）的"读失败⇒空基线⇒回写"点位必须登记：'
    + 'not-family（读值不进回写）或 defer（同族确证 + 精确改法）；'
    + `当前扫到 ${candidates.length} 个候选。`,
  )
})

test('FIX-47① 仓库级：登记表不得留死条目（登记了却不在 ⇒ 红）', () => {
  const live = new Set(scanCandidates().map((c) => c.key))
  const stale = [...SCAN_REGISTRY.keys()].filter((key) => !live.has(key))
  assert.deepEqual(stale, [], '登记的点位已经不在（被修好、被删、或被改名）⇒ 登记表必须同步收口，否则它会烂成免检区')
})

test('FIX-47① 仓库级：每条登记必须给出结论与理由；`defer` 还必须给出精确改法', () => {
  const offenders = []
  for (const [key, entry] of SCAN_REGISTRY) {
    if (entry.verdict !== 'not-family' && entry.verdict !== 'defer') offenders.push(`${key}: 未知结论 ${entry.verdict}`)
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) offenders.push(`${key}: 理由缺失或过短`)
    if (entry.verdict === 'defer' && (typeof entry.fix !== 'string' || entry.fix.trim().length < 20)) {
      offenders.push(`${key}: defer 必须给出精确改法（否则"登记"会退化成本轮不做的借口）`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('FIX-47① 仓库级：本轮修的两处**仍在闸门形态**（拆掉闸门 ⇒ 上一条当场红）', () => {
  // 行为判据在 tests/advisor-session-overrides-failclosed.test.js 与
  // tests/state-read-failure-write-gate.test.js；这里只钉"闸门锚点还在"，
  // 让"闸门被整体删除但行为用例恰好没覆盖到"这种缝也闭上。
  const advisor = readFileSync(join(PACKAGE_ROOT, 'lib/advisor/index.js'), 'utf8')
  assert.match(advisor, /assertOverridesWritable\s*\(\s*\)/u, 'session-overrides 的写前闸门锚点必须还在')
  assert.match(advisor, /refuse to overwrite baseline/u, '读失败必须留下可检索的拒写理由')
  const index = readFileSync(join(PACKAGE_ROOT, 'lib/index.js'), 'utf8')
  assert.match(index, /stateLoadError !== null/u, 'plugin-state 的写前闸门锚点必须还在')
  assert.match(index, /loadError:\s*`不可读/u, '读失败必须被记成可判别的 loadError')
})

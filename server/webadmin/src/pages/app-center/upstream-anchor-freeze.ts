/**
 * 上游锚点②（网关出站头名）的**冻结件 + 活上游判定器**。
 *
 * ## 为什么需要它
 *
 * 本仓有两类 CI job：
 * - `Gate (tests + workspace build)`：`actions/checkout` 带 `submodules: recursive` ⇒
 *   `deepseek-harness/` 真的检出（目录里有源码，且有 `.git`）；
 * - `Go server`：**不检 submodule**（省一次大检出）⇒ `deepseek-harness/` 只是一个
 *   **空目录**（git 对 gitlink 的检出结果：目录在、里面 0 项、无 `.git`）。
 *
 * 而 `opens-contract-parity.spec.ts` 的"归因链路三段锚点齐备"用例会在**两类 job 里都跑**
 * （它是 webadmin 的 vitest 用例）。第一版实现无条件是读活文件 ⇒ 在 `Go server` job 里报
 * `上游出站头名: 文件不存在 deepseek-harness/…/adapter.ts`，把必需的 `Go server` 检查打红
 * （第十三轮 PR #149 首跑实测）。**这是"判据依赖了本 job 不存在的输入"这一类缺陷**，
 * 不是上游问题。
 *
 * ⚠️ 两条都**不能**当在场判据：
 * - `existsSync('deepseek-harness')` —— 那个目录在两类 job 里都存在（未初始化时是空目录）；
 * - `existsSync('deepseek-harness/packages')` —— 那是**上游布局路径**：上游换包名/挪目录，
 *   它就消失，于是"在场但布局变了"与"真缺席"不可分 ⇒ 判据静默退回"冻结件 vs 契约常量"
 *   （与 S5-01 同形的退化），来源行还会**谎称"submodule 缺席"**（S5-01 复审 A2，实测形态：
 *   把 `packages` 改名成 `pkg` + 同时改掉活上游头名 ⇒ 23 passed / exit 0，归因链路其实已断）。
 *
 * 在场判据 = {@link classifyUpstreamPresence}：`deepseek-harness/.git`
 * （{@link UPSTREAM_SUBMODULE_CHECKOUT_MARKER}：**真检出**必有 —— gitlink 未初始化时只有
 * 空目录、没有它；它属于 git 内部约定，**不受上游布局影响**，无法被"上游改布局"硬钉掉）
 * **或**目录非空（内容在 ⇒ 上游在，与布局无关）。只有"目录不存在 / 空目录且无 `.git`"
 * 才算**真缺席**；**其余一律按在场走活文件**，解析不到命中就 fail-loud。
 *
 * ## 口径（三条一起成立才判绿）
 *
 * 1. **submodule 在场**（{@link classifyUpstreamPresence} 判 `live`）：在 `senderDir` 目录下
 *    **逐字**搜 `UPSTREAM_SESSION_HEADER_LINE`，要求**恰好命中 1 个文件**且命中文件是
 *    `senderFile`；**并且**命中文件里必须有**由契约常量派生的头名形状**
 *    （`input.header` ⇒ `'<header>': String(options.sessionId)`）—— 只在活分支比对冻结行
 *    是不够的：契约常量 `ATTRIBUTION_SESSION_HEADER` 漂了而冻结行没漂时，活分支会全绿
 *    （S5-01 复审 A1 实测：常量改 `…-ROTATED` ⇒ app-center 110 例全绿）。命中 0 处 /
 *    多于一处的**任何**形态都判红 —— **绝不**回落冻结件。
 *    （S5-01 的假绿正是"路径写错 ⇒ 必然走兜底 ⇒ 拿常量测常量"；兜底只能由**真的缺席**触发。）
 * 2. **submodule 真缺席**（目录不存在 / 空目录且无 `.git`）：才允许用冻结件判，且**兜底自身
 *    有牙** —— 拿**契约常量**（入参 `header`）派生的形状正则判冻结件，而不是"拿常量测它
 *    自己"；实际依据的那一行原文写进来源说明（可检索、可追溯）。
 * 3. **来源显式且如实**：{@link UpstreamAnchorProbe.source} 会进用例的 `sources` 断言，
 *    任何"用了冻结件"都不许静默发生；来源里必须写明判定的**证据**（`.git` 存在 / 空目录 /
 *    目录不存在）——"读不出 / 判不出"永远不许被说成"submodule 缺席"。
 *
 * ## 更新方式
 *
 * 以下任一情况都必须同步下面的常量（判定器会咬住，不改就红）：
 * - `deepseek-harness` 的 pin 变了；
 * - 该适配器里**那一行本身**改了（换头名、改取值表达式、改缩进/换行）；
 * - 承载目录/文件名变了（同步 `opens-contract.ts` 的
 *   `ATTRIBUTION_CHAIN_ANCHORS.senderDir` / `senderFile`）。
 *
 * 做法：从 `deepseek-harness/packages/llm/llm-deepseek/src/` 下**逐字复制那一行**
 * （含行首缩进与行尾逗号 —— 判据用的是 `String.includes` 逐字比对）替换下面的常量，
 * 并在同一个 PR 里提交。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'

/** 上游 submodule 的根目录名（仓库根之下）。 */
export const UPSTREAM_SUBMODULE_DIR = 'deepseek-harness'

/**
 * 上游 submodule 的**真检出标记**（仓库相对路径）。
 *
 * 用 `deepseek-harness/.git`：gitlink **未初始化**时只有空目录、没有它；真检出一定有
 * （submodule 的 `.git` 是一个 `gitdir: …` 文本文件）。它属于 **git 内部约定**，
 * 不是上游布局路径 ⇒ 上游挪目录/换包名都打不掉它，"在场"与"缺席"因此始终可分。
 *
 * ⚠️ 不要把它换回任何 `deepseek-harness/<上游目录>` 形态的路径（S5-01 复审 A2：旧实现用
 * `deepseek-harness/packages`，改名后判据静默退回冻结件、来源行谎称"submodule 缺席"）。
 */
export const UPSTREAM_SUBMODULE_CHECKOUT_MARKER = `${UPSTREAM_SUBMODULE_DIR}/.git`

/** submodule 在场性判定的三态（`unknown` 一律 fail-loud，不许当成缺席）。 */
export type UpstreamPresence = 'live' | 'absent' | 'unknown'

/** {@link classifyUpstreamPresence} 的结果：判定 + **可写进来源行的证据**。 */
export interface UpstreamPresenceVerdict {
  presence: UpstreamPresence
  /** 证据原文（写进 `source`；"读不出/判不出"必须如实，不许说成"缺席"）。 */
  evidence: string
}

/**
 * 判定上游 submodule 在不在场。
 *
 * 判据只有两条，**都不含上游布局路径**：
 * 1. `deepseek-harness/.git` 存在 ⇒ 真检出（`live`）；
 * 2. 否则看 `deepseek-harness/` 这个目录：不存在或**是空目录** ⇒ 真缺席（`absent`，
 *    即 git 对未初始化 gitlink 的检出结果）；**非空** ⇒ 内容在 ⇒ `live`。
 *    读不出（ENOTDIR/EACCES…）⇒ `unknown`（fail-loud，绝不回落冻结件）。
 *
 * 为什么"非空即在场"是安全的：走到活文件分支本身**不会**造成判据退化 —— 它是**最强**的
 * 证据形态（逐字比对活上游）。退化只发生在"回落冻结件"那一侧，而那一侧现在只由
 * "目录不存在 / 空目录且无 `.git`"触发。
 *
 * @param repoRoot - 仓库根（绝对或相对路径皆可）。
 * @returns 三态判定与证据原文。
 */
export function classifyUpstreamPresence(repoRoot: string): UpstreamPresenceVerdict {
  const root = join(repoRoot, UPSTREAM_SUBMODULE_DIR)
  if (existsSync(join(repoRoot, UPSTREAM_SUBMODULE_CHECKOUT_MARKER))) {
    return { presence: 'live', evidence: `${UPSTREAM_SUBMODULE_CHECKOUT_MARKER} 存在（真检出的 submodule）` }
  }
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return { presence: 'absent', evidence: `${UPSTREAM_SUBMODULE_DIR}/ 不存在` }
    return { presence: 'unknown', evidence: `读不出 ${UPSTREAM_SUBMODULE_DIR}/（${String(err)}）` }
  }
  if (entries.length === 0) {
    return {
      presence: 'absent',
      evidence: `${UPSTREAM_SUBMODULE_DIR}/ 是空目录且无 ${UPSTREAM_SUBMODULE_CHECKOUT_MARKER}（未初始化的 gitlink）`,
    }
  }
  return { presence: 'live', evidence: `${UPSTREAM_SUBMODULE_DIR}/ 非空（${entries.length} 项，与上游布局无关）` }
}

/**
 * 上游发出会话 id 出站头的**那一行原文**（逐字：含行首缩进与行尾逗号）。
 *
 * 2026-10-04 按活文件重新对齐（S5-01）：旧值止于 `? { 'x-deepseek-harness-session-id': … }`，
 * 而活文件是 `...options.sessionId === undefined ? {} : { 'x-…': String(options.sessionId) },`
 * —— 冻结件本身早已过期，逐字比对必然不成立（又一条假绿来源）。
 */
export const UPSTREAM_SESSION_HEADER_LINE =
  "            ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },"

/** 判定结果。 */
export interface UpstreamAnchorProbe {
  /** 判定来源（必须写进用例的 `sources` —— "用了冻结件"不许静默发生；冻结件兜底时带来源行原文）。 */
  source: string
  /** 非空 ⇒ 判红；每条都指名道姓，可直接贴进断言消息。 */
  missing: string[]
  /** 活上游里命中冻结行的文件（仓库相对 POSIX 路径，升序）；冻结件兜底时为空数组。 */
  hits: string[]
}

/** 只有这些扩展名算"上游源码"（其余是产物/资源，不进判据面）。 */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
/** 递归扫描时跳过的目录（依赖/构建产物/测试夹具）。 */
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', 'lib', 'build', 'coverage', 'testdata', 'tests', '__tests__'])

/** 正则元字符转义（出站头名将来含 `.:` 之类字符时，形状正则不能被它带偏）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 由**契约常量**（出站头名）派生的形状正则：`'<header>': String(options.sessionId)`。
 *
 * 两个分支共用同一份形状（活文件分支 A1 的绑定 / 缺席分支的兜底带牙）——否则"契约常量"
 * 与"冻结件"各判一套，又会出现"两侧各钉自己的字面量"。
 */
function sessionHeaderShape(header: string): RegExp {
  return new RegExp(`'${escapeRegExp(header)}':\\s*String\\(options\\.sessionId\\)`, 'u')
}

/** 诊断助手：从文本里取出会话 id 出站头名（判红时告诉人活文件里到底是哪个头名）。 */
function sessionHeaderNameIn(text: string): string | null {
  const found = /'([^']+)':\s*String\(options\.sessionId\)/u.exec(text)
  return found ? found[1]! : null
}

/**
 * 在 `dir` 下**递归**逐字搜 `line`，返回命中文件的绝对路径。
 *
 * 递归而不是只看一层：上游把适配器搬进 `src/protocols/…` 这类子目录时判据仍然成立
 * （S5-01 的旧锚点正是钉死了一条**不存在**的子目录路径）。读不出的文件按"不命中"处理
 * （二进制/权限），但"一处都没命中"由调用方判红。
 */
function scanLiteralFiles(dir: string, line: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SCAN_SKIP_DIRS.has(entry.name)) continue
      scanLiteralFiles(full, line, out)
      continue
    }
    if (!entry.isFile() || !SCAN_EXTENSIONS.has(extname(entry.name))) continue
    let text = ''
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    if (text.includes(line)) out.push(full)
  }
  return out
}

/**
 * 判定锚点②（上游出站头名）在当前仓库里是否成立。
 *
 * **判定权只在这里**：`opens-contract-parity.spec.ts` 只负责把 `missing` 贴进断言，
 * 不做第二套"路径在不在"的判断 —— 于是"解析不到真实命中"这件事**结构上**不可能被
 * 静默兜底（S5-01 的形态）。
 *
 * @param input - 判定输入（全部显式传入，便于用合成夹具做同进程自证）。
 * @returns 判定来源、失败项与活上游命中文件。
 */
export function probeUpstreamSenderAnchor(input: {
  /** 仓库根（活文件与在场标记相对它解析）。 */
  repoRoot: string
  /** 上游适配器所在包的 `src/` 目录（仓库相对）。 */
  senderDir: string
  /** 命中文件必须叫这个基名。 */
  senderFile: string
  /** 契约常量：出站头名（冻结件兜底时用它派生形状判据）。 */
  header: string
  /** 冻结行原文（活上游逐字比对 / 兜底时判它自己与契约常量一致）。 */
  line: string
}): UpstreamAnchorProbe {
  const dir = join(input.repoRoot, input.senderDir)
  const presence = classifyUpstreamPresence(input.repoRoot)

  if (presence.presence === 'unknown') {
    // 判不出在场性 ⇒ fail-loud。既不许回落冻结件（那是"常量测常量"），也不许当成缺席。
    return {
      hits: [],
      source: `上游出站头名: 无法判定 submodule 是否在场（${presence.evidence}）`,
      missing: [
        `上游出站头名: ${presence.evidence} —— 在场性判不出来就是红`
        + '（不许回落冻结件，也不许当成"submodule 缺席"）',
      ],
    }
  }

  let isDirectory = false
  try {
    isDirectory = statSync(dir).isDirectory()
  } catch {
    isDirectory = false
  }

  if (!isDirectory) {
    if (presence.presence === 'live') {
      // submodule 在场 ⇒ 必须读活文件。解析不到一律 fail-loud，绝不回落冻结件。
      return {
        hits: [],
        source: `上游出站头名: 活上游（在场证据: ${presence.evidence}）`,
        missing: [
          `上游出站头名: 锚点②目录不存在 ${input.senderDir}`
          + `（submodule 在场：${presence.evidence} ⇒ 必须读活文件；`
          + '解析不到命中一律判红，**不得**回落冻结件 —— 上游搬目录/换包名就同步 '
          + '`ATTRIBUTION_CHAIN_ANCHORS.senderDir`）',
        ],
      }
    }
    // 只有**真的缺席**（`Go server` job 不检 submodule：只剩一个空目录 / 整棵不存在）
    // 才允许用冻结件。兜底自身必须有牙：拿**契约常量**（header）派生的形状判冻结件，
    // 而不是拿它测它自己。
    const shape = sessionHeaderShape(input.header)
    const source = `上游出站头名: submodule 缺席（${presence.evidence}） ⇒ 按冻结件判定（来源行: ${input.line}）`
    if (!shape.test(input.line)) {
      return {
        hits: [],
        source,
        missing: [
          `上游出站头名: 冻结件与契约常量不一致 —— \`UPSTREAM_SESSION_HEADER_LINE\` 必须含 `
          + `'${input.header}': String(options.sessionId)（否则冻结件是自说自话）。${source}`,
        ],
      }
    }
    return { hits: [], source, missing: [] }
  }

  let hits: string[] = []
  try {
    hits = scanLiteralFiles(dir, input.line)
      .map((p) => relative(input.repoRoot, p).split(sep).join('/'))
      .sort()
  } catch (err) {
    return {
      hits: [],
      source: `上游出站头名: 活文件（在场证据: ${presence.evidence}；在 ${input.senderDir}/ 下逐字搜冻结行）`,
      missing: [`上游出站头名: 扫描 ${input.senderDir}/ 失败（${String(err)}）—— 读不出就是红，不是跳过`],
    }
  }

  const missing: string[] = []
  if (hits.length !== 1) {
    missing.push(
      `上游出站头名: 冻结行在 ${input.senderDir}/ 下命中 ${hits.length} 处（必须恰好 1 处）：`
      + `${hits.length === 0 ? '一处都没有（上游改了这一行 / 换了承载文件？）' : hits.join('、')}`
      + ' —— 同步 `UPSTREAM_SESSION_HEADER_LINE` 或锚点，不得放宽判据',
    )
  } else if (basename(hits[0]!) !== input.senderFile) {
    missing.push(
      `上游出站头名: 冻结行命中 ${hits[0]}（期望文件 ${input.senderFile}）`
      + ' —— 上游换了承载文件就同步 `ATTRIBUTION_CHAIN_ANCHORS.senderFile`，'
      + '**不得**放宽成"任意文件命中即通过"',
    )
  } else {
    // A1（S5-01 复审）：活分支也必须把**契约常量**绑到真源。只比冻结行是不够的 ——
    // 冻结行命中只证明"冻结件 == 活文件"，不证明"契约常量 == 活文件"；契约常量
    // `ATTRIBUTION_SESSION_HEADER` 漂了而冻结行没漂时，整条归因链路其实已断，
    // 判据却全绿（实测：常量改成 `…-ROTATED` ⇒ app-center 110 例全绿）。
    let text: string | null = null
    try {
      text = readFileSync(join(input.repoRoot, hits[0]!), 'utf8')
    } catch (err) {
      missing.push(`上游出站头名: 命中文件 ${hits[0]} 读不出（${String(err)}）—— 读不出就是红，不是跳过`)
    }
    if (text !== null && !sessionHeaderShape(input.header).test(text)) {
      const found = sessionHeaderNameIn(text)
      missing.push(
        `上游出站头名: 契约常量 \`ATTRIBUTION_SESSION_HEADER\` = '${input.header}' 在命中文件 `
        + `${hits[0]} 里找不到（活文件里是 ${found === null ? '没找到任何会话 id 出站头名' : `'${found}'`}）`
        + ' —— 冻结行还在、契约常量已漂移 ⇒ 归因链路已断，'
        + '同步 `opens-contract.ts` 的 `ATTRIBUTION_SESSION_HEADER`（**不得**只改判据或放宽成"只要冻结行在就算过"）',
      )
    }
  }
  return {
    hits,
    missing,
    source: `上游出站头名: 活文件（在场证据: ${presence.evidence}；在 ${input.senderDir}/ 下逐字搜冻结行）`,
  }
}

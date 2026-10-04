/**
 * 上游锚点②判定器的**自证用例**（S5-01 · 2026-10-04）：把"假绿"钉死在这一层。
 *
 * ## 为什么必须有这条用例
 *
 * `opens-contract-parity.spec.ts` 的"三段锚点齐备"在 S5-01 之前是**恒真**的：锚点路径
 * 写错了（指向不存在的 `…/src/protocols/chat-completions/adapter.ts`），于是
 * `if (!existsSync(path))` 兜底**必然**命中，判据退化成
 * `pattern.test(UPSTREAM_SESSION_HEADER_LINE)` —— 拿冻结常量测它自己；同一 `if` 里真正
 * 有牙的那半（活上游必须逐字含冻结行）**结构上不可达**。这类缺陷用"再读一遍源码"是抓不住
 * 的，只能靠**能被打坏的判据**：把判定器（`probeUpstreamSenderAnchor`）当成被测对象，
 * 用合成仓库骨架喂给它"命中 0 处 / 命中多处 / 命中别的文件 / 目录被搬走"这些真实失败形态，
 * 断言它**必须**返回非空 `missing`（= 上层断言必红），且**绝不**把来源说成冻结件。
 *
 * ## 判据边界（如实写清）
 *
 * - 本用例断言的是**判定器的判决**：`missing` 非空 ⇒ `opens-contract-parity.spec.ts` 的
 *   `expect(missing).toEqual([])` 必红（那条用例直接贴的是这里的返回值，不做第二套路径判断）。
 * - 本用例**不**在真实仓库里制造失败（判据在共享工作树里变异会污染工作区）；"真实仓库上
 *   红"由报告里的两处变异实跑给证据（改上游那一行 / 把锚点指回不存在路径）。
 * - 兜底分支（submodule 真的缺席）也在这里判：冻结件与契约常量不一致 ⇒ 红
 *   （"拿契约常量判冻结件"，不是"拿冻结件判它自己"）。
 *
 * ## 复审补的两条（S5-01 verify §3 A1/A2，2026-10-04）
 *
 * - **A2**：在场标记曾是 `deepseek-harness/packages`（**上游布局路径**）⇒ 上游挪目录/换包名
 *   就与"真缺席"不可分，判据静默退回"冻结件 vs 契约常量"、来源行还谎称"submodule 缺席"
 *   （实测：`packages`→`pkg` + 同时改掉活上游头名 ⇒ 23 passed / exit 0）。现在在场判据是
 *   `deepseek-harness/.git`（真检出必有、未初始化的 gitlink 只有空目录）**或**目录非空，
 *   两者都与上游布局无关；**非空内容在却解析不到命中 ⇒ 一律红**，绝不回落。
 * - **A1**：活分支只比冻结行 ⇒ 契约常量 `ATTRIBUTION_SESSION_HEADER` 漂移在"submodule 在场"
 *   的环境里没人判（实测：常量改 `…-ROTATED` ⇒ app-center 110 例全绿）。现在活分支要求
 *   命中文件里存在**由契约常量派生**的头名形状，否则红。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  classifyUpstreamPresence,
  probeUpstreamSenderAnchor,
  UPSTREAM_SESSION_HEADER_LINE,
} from './upstream-anchor-freeze'

const HEADER = 'x-deepseek-harness-session-id'
/** 与生产锚点同形（目录 + 期望文件名）。 */
const SENDER_DIR = 'deepseek-harness/packages/llm/llm-deepseek/src'
const SENDER_FILE = 'adapter.ts'
/** S5-01 里那条**不存在**的路径（锚点②的原始形态，作为负例固定下来）。 */
const STALE_SENDER_DIR = 'deepseek-harness/packages/llm/llm-deepseek/src/protocols/chat-completions'
/** A2 复审的实测形态：上游把 `packages/` 挪成 `pkg/`（布局变了，submodule 其实在场）。 */
const RELAID_OUT_SENDER_DIR = 'deepseek-harness/pkg/llm/llm-deepseek/src'

/** 上游 submodule 在仓库骨架里的三种真实形态。 */
type SubmoduleShape = 'checked-out' | 'empty-dir' | 'absent'

const roots: string[] = []

/**
 * 造一个临时仓库骨架。
 *
 * `checked-out` 会写真检出的 `.git`（submodule 的它是 `gitdir: …` 文本文件），**不再**造
 * `packages/` —— 那个目录是**上游布局**，造出来就把 A2 的形态（布局变了但仍在场）挡住了。
 *
 * @param spec - `submodule` 决定 submodule 形态；`gitMarker` 覆盖真检出标记（缺省：
 *   `checked-out` 写、其余不写）；`files` 是仓库相对路径 → 内容。
 * @returns 仓库根（绝对路径）。
 */
function makeRepo(spec: {
  submodule: SubmoduleShape
  gitMarker?: boolean
  files?: Record<string, string>
}): string {
  const root = mkdtempSync(join(tmpdir(), 'picoaide-anchor-'))
  roots.push(root)
  if (spec.submodule === 'checked-out' || spec.submodule === 'empty-dir') {
    mkdirSync(join(root, 'deepseek-harness'), { recursive: true })
  }
  if (spec.gitMarker ?? spec.submodule === 'checked-out') {
    mkdirSync(join(root, 'deepseek-harness'), { recursive: true })
    writeFileSync(join(root, 'deepseek-harness', '.git'), 'gitdir: ../.git/modules/deepseek-harness\n')
  }
  for (const [rel, text] of Object.entries(spec.files ?? {})) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** 判定入口（生产参数原样）。 */
function probe(
  root: string,
  override: { senderDir?: string; line?: string; header?: string } = {},
): ReturnType<typeof probeUpstreamSenderAnchor> {
  return probeUpstreamSenderAnchor({
    repoRoot: root,
    senderDir: override.senderDir ?? SENDER_DIR,
    senderFile: SENDER_FILE,
    header: override.header ?? HEADER,
    line: override.line ?? UPSTREAM_SESSION_HEADER_LINE,
  })
}

/**
 * 仓库根（从 cwd 上溯找 `server/webadmin/package.json`；与两条对拍 spec 同款做法）。
 *
 * 不写死 `../..`：`vitest` 的 cwd 由调用方式决定（包内 / 仓库根 / CI 步骤），
 * 找不到必须 throw —— 判据读不到真源时不许静默退化。
 */
function findRepoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'server', 'webadmin', 'package.json'))) return dir
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到仓库根（cwd=${process.cwd()}）：本用例读真实仓库对拍，找不到真源必须红`)
}

describe('上游锚点②判定器 · 活上游（submodule 在场）', () => {
  it('冻结行恰好命中 1 个文件且是适配器 ⇒ 绿，来源写明"活文件"', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${SENDER_DIR}/${SENDER_FILE}`]: `const x = 1\n${UPSTREAM_SESSION_HEADER_LINE}\n` },
    })
    const result = probe(root)
    expect(result.missing).toEqual([])
    expect(result.hits).toEqual([`${SENDER_DIR}/${SENDER_FILE}`])
    expect(result.source, '必须写成"活文件"（不是冻结件）').toContain('活文件')
    expect(result.source).not.toContain('冻结件')
  })

  it('上游把适配器搬进子目录 ⇒ 仍然绿（判据搜目录，不钉路径 —— S5-01 的病根）', () => {
    const moved = `${SENDER_DIR}/protocols/chat-completions`
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${moved}/${SENDER_FILE}`]: `const x = 1\n${UPSTREAM_SESSION_HEADER_LINE}\n` },
    })
    const result = probe(root)
    expect(result.missing).toEqual([])
    expect(result.hits).toEqual([`${moved}/${SENDER_FILE}`])
  })

  it('那一行被改掉（命中 0 处）⇒ 红，且来源不得是"冻结件"（不许静默兜底）', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${SENDER_DIR}/${SENDER_FILE}`]: "            'x-deepseek-harness-session-id': String(id),\n" },
    })
    const result = probe(root)
    expect(result.hits).toEqual([])
    expect(result.missing.join('；'), '命中 0 处必须判红').toContain('命中 0 处')
    expect(result.source, 'submodule 在场 ⇒ 不许回落冻结件').not.toContain('冻结件')
  })

  it('同一行出现在**两个**文件 ⇒ 红（必须恰好 1 处，锚点不唯一就不算判据）', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      files: {
        [`${SENDER_DIR}/${SENDER_FILE}`]: `${UPSTREAM_SESSION_HEADER_LINE}\n`,
        [`${SENDER_DIR}/transport.ts`]: `${UPSTREAM_SESSION_HEADER_LINE}\n`,
      },
    })
    const result = probe(root)
    expect(result.hits).toHaveLength(2)
    expect(result.missing.join('；')).toContain('命中 2 处')
  })

  it('命中在别的文件（不是适配器）⇒ 红（不得放宽成"任意文件命中即通过"）', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${SENDER_DIR}/transport.ts`]: `${UPSTREAM_SESSION_HEADER_LINE}\n` },
    })
    const result = probe(root)
    expect(result.hits).toEqual([`${SENDER_DIR}/transport.ts`])
    expect(result.missing.join('；')).toContain(SENDER_FILE)
  })

  it('锚点目录不存在但 submodule 在场（搬走/改名）⇒ 红，且**绝不**回落冻结件', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${SENDER_DIR}/${SENDER_FILE}`]: `${UPSTREAM_SESSION_HEADER_LINE}\n` },
    })
    // 变异②：把锚点指回 S5-01 里那条不存在的路径。
    const result = probe(root, { senderDir: STALE_SENDER_DIR })
    expect(result.hits).toEqual([])
    expect(result.missing.join('；')).toContain('锚点②目录不存在')
    expect(result.source, 'submodule 在场 ⇒ 来源必须是活上游').not.toContain('冻结件')
  })
})

describe('上游锚点②判定器 · submodule 缺席（Go server job 的形态）', () => {
  it('只剩一个**空目录**（git 对 gitlink 的检出结果）⇒ 按冻结件判定，来源显式且带来源行', () => {
    const root = makeRepo({ submodule: 'empty-dir' })
    const result = probe(root)
    expect(result.missing, '冻结件与契约常量一致 ⇒ 兜底判绿').toEqual([])
    expect(result.hits, '兜底时没有活文件命中').toEqual([])
    expect(result.source, '来源必须写明用了冻结件').toContain('冻结件')
    expect(result.source, '来源行必须可检索（把实际依据的那一行原文打出来）').toContain(
      UPSTREAM_SESSION_HEADER_LINE.slice(0, 40),
    )
    // A2：来源必须**如实**——把判定的证据写出来（空目录 / 无 `.git`），不是一句"缺席"了事。
    expect(result.source, '缺席分支必须写明证据（空目录 + 无 .git）').toContain('空目录')
    expect(result.source, '证据里必须点名真检出标记').toContain('.git')
  })

  it('整棵 submodule 不存在 ⇒ 同样走冻结件兜底（不是"扫不到就绿"）', () => {
    const root = makeRepo({ submodule: 'absent' })
    const result = probe(root)
    expect(result.missing).toEqual([])
    expect(result.source).toContain('冻结件')
    expect(result.source, '证据必须如实写成"目录不存在"').toContain('不存在')
    expect(result.hits).toEqual([])
  })

  it('兜底**自身有牙**：冻结件与契约常量（出站头名）不一致 ⇒ 红', () => {
    const root = makeRepo({ submodule: 'empty-dir' })
    // 变异：冻结件被改成另一个头名（拿契约常量判它，而不是拿它判它自己）。
    const drifted = UPSTREAM_SESSION_HEADER_LINE.replace(HEADER, 'x-pico-app-id')
    expect(drifted, '变异必须真的落地（否则这条用例是恒真的）').not.toBe(UPSTREAM_SESSION_HEADER_LINE)
    const result = probe(root, { line: drifted })
    expect(result.missing.join('；')).toContain('冻结件与契约常量不一致')
  })

  it('兜底**自身有牙**：冻结件不再携带 sessionId 取值 ⇒ 红', () => {
    const root = makeRepo({ submodule: 'empty-dir' })
    const drifted = "            'x-deepseek-harness-session-id': String(otherId),"
    const result = probe(root, { line: drifted })
    expect(result.missing.join('；')).toContain('冻结件与契约常量不一致')
  })

  it('兜底只在**真的缺席**时发生：submodule 在场而锚点目录不在 ⇒ 红（对照上一条）', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${SENDER_DIR}/${SENDER_FILE}`]: `${UPSTREAM_SESSION_HEADER_LINE}\n` },
    })
    const absentDirInLiveRepo = probe(root, { senderDir: 'deepseek-harness/packages/llm/llm-deepseek/src/nope' })
    expect(absentDirInLiveRepo.missing.join('；')).toContain('锚点②目录不存在')
    // 同一份冻结件、同一份契约常量：只因为 submodule 在场，判决就从"绿"翻成"红"。
    const emptyRepo = makeRepo({ submodule: 'empty-dir' })
    expect(probe(emptyRepo).missing, '缺席时同一输入是绿的 —— 证明上面那条红来自"在场"这一事实').toEqual([])
  })
})

describe('上游锚点②判定器 · A2：在场判据不可被上游布局硬钉', () => {
  it('上游把 packages/ 挪成 pkg/（布局变了但 submodule 真检出）⇒ 红，来源不得谎称"缺席"', () => {
    // 复审 A2 的实测形态：`packages`→`pkg` 之后旧判据（existsSync('…/packages')）判成"缺席"
    // ⇒ 静默回落冻结件 ⇒ 即使活上游头名同时被改掉也 23 passed / exit 0。
    const root = makeRepo({
      submodule: 'checked-out',
      files: {
        [`${RELAID_OUT_SENDER_DIR}/${SENDER_FILE}`]:
          `${UPSTREAM_SESSION_HEADER_LINE.replace(HEADER, `${HEADER}-ROTATED`)}\n`,
      },
    })
    expect(existsSync(join(root, 'deepseek-harness', 'packages')), '布局必须真的变了').toBe(false)
    const result = probe(root)
    expect(result.hits, '不许回落冻结件 ⇒ 没有活文件命中').toEqual([])
    expect(result.missing.join('；'), '在场 + 解析不到 ⇒ 必须 fail-loud').toContain('锚点②目录不存在')
    expect(result.source, '来源**不得**说成"缺席"（那是假陈述）').not.toContain('缺席')
    expect(result.source, '也不得说成用了冻结件').not.toContain('冻结件')
  })

  it('上游 pkg/ 形态 + 锚点同步过去 ⇒ 绿（换了布局、判据仍然有效）', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${RELAID_OUT_SENDER_DIR}/${SENDER_FILE}`]: `${UPSTREAM_SESSION_HEADER_LINE}\n` },
    })
    const result = probe(root, { senderDir: RELAID_OUT_SENDER_DIR })
    expect(result.missing).toEqual([])
    expect(result.hits).toEqual([`${RELAID_OUT_SENDER_DIR}/${SENDER_FILE}`])
  })

  it('目录非空但没有 .git（tar 包/去 .git 的检出）⇒ 仍按在场处理（内容在就是上游在）', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      gitMarker: false,
      files: { [`${RELAID_OUT_SENDER_DIR}/${SENDER_FILE}`]: `${UPSTREAM_SESSION_HEADER_LINE}\n` },
    })
    expect(existsSync(join(root, 'deepseek-harness', '.git')), '这条形态必须真的没有 .git').toBe(false)
    const result = probe(root)
    expect(result.hits).toEqual([])
    expect(result.missing.join('；'), '非空 ⇒ 在场 ⇒ 解析不到就红，绝不回落').toContain('锚点②目录不存在')
    expect(result.source).not.toContain('冻结件')
  })

  it('空目录但 .git 在（检出过却是空的）⇒ 红：判不出就不许当缺席', () => {
    const root = makeRepo({ submodule: 'empty-dir', gitMarker: true })
    const result = probe(root)
    expect(result.missing.join('；'), '有真检出标记就不许走冻结件兜底').toContain('锚点②目录不存在')
    expect(result.source).not.toContain('冻结件')
  })

  it('submodule 路径被换成**文件**（读不出目录）⇒ 红：判不出在场性，绝不当缺席', () => {
    const root = makeRepo({ submodule: 'absent' })
    writeFileSync(join(root, 'deepseek-harness'), 'not a directory\n')
    const result = probe(root)
    expect(result.source, '不许说成"缺席"').not.toContain('缺席')
    expect(result.missing.join('；')).toContain('在场性判不出来就是红')
  })

  it('在场判据只认 .git / 空目录 / 不存在三种形态（与上游目录名无关）', () => {
    expect(classifyUpstreamPresence(makeRepo({ submodule: 'checked-out' })).presence).toBe('live')
    expect(classifyUpstreamPresence(makeRepo({ submodule: 'empty-dir' })).presence).toBe('absent')
    expect(classifyUpstreamPresence(makeRepo({ submodule: 'absent' })).presence).toBe('absent')
    // 只有 `.git`、没有任何上游目录 ⇒ 仍然是"在场"（判据不依赖任何上游布局路径）。
    const onlyMarker = makeRepo({ submodule: 'checked-out' })
    expect(classifyUpstreamPresence(onlyMarker).presence).toBe('live')
  })
})

describe('上游锚点②判定器 · A1：活分支也必须把契约常量绑到真源', () => {
  it('活文件与冻结行一致，但契约常量漂了 ⇒ 红（旧实现这里全绿）', () => {
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${SENDER_DIR}/${SENDER_FILE}`]: `${UPSTREAM_SESSION_HEADER_LINE}\n` },
    })
    // A/B：同一棵树、同一份冻结件，**只有**入参契约常量不同 ⇒ 判决必须不同。
    const ok = probe(root)
    const drifted = probe(root, { header: `${HEADER}-ROTATED` })
    expect(ok.missing, '契约常量与活文件一致 ⇒ 绿').toEqual([])
    expect(drifted.hits, '红不是来自"命中 0 处"（逐字命中仍是 1 处）').toEqual([`${SENDER_DIR}/${SENDER_FILE}`])
    expect(drifted.missing.join('；'), '契约常量漂移必须判红').toContain('契约常量')
    expect(drifted.missing.join('；'), '判红文案要点名契约常量的当值').toContain(HEADER)
    expect(drifted.source, '契约常量漂移不是"缺席" ⇒ 来源仍必须是活文件').toContain('活文件')
    expect(drifted.source).not.toContain('冻结件')
  })

  it('冻结件与活文件一起换代、契约常量没跟上（真实升级形态）⇒ 红，且点名活文件里的头名', () => {
    const rotated = `${HEADER}-ROTATED`
    const rotatedLine = UPSTREAM_SESSION_HEADER_LINE.replace(HEADER, rotated)
    const root = makeRepo({
      submodule: 'checked-out',
      files: { [`${SENDER_DIR}/${SENDER_FILE}`]: `${rotatedLine}\n` },
    })
    // 冻结件已随 pin 同步（逐字命中 1 处），只有契约常量还停在旧值。
    const result = probe(root, { line: rotatedLine })
    expect(result.hits, '命中正常 ⇒ 红必须来自契约常量的绑定').toEqual([`${SENDER_DIR}/${SENDER_FILE}`])
    expect(result.missing.join('；')).toContain('契约常量')
    expect(result.missing.join('；'), '判红文案要告诉人活文件里到底是什么头名').toContain(rotated)
  })
})

describe('上游锚点②判定器 · 真实仓库（只读）', () => {
  it('本仓锚点②必须解析出唯一活文件，且文件名与锚点声明一致', () => {
    // 与 `opens-contract-parity.spec.ts` 用的是**同一个**判定器：这里再判一次真实仓库，
    // 于是"锚点配置错 / 上游漂移"会同时打红两条独立用例（判据不许只有一条命）。
    // 两态都要接受：submodule 在场 ⇒ 必须命中唯一活文件；缺席（`Go server` job）⇒ 冻结件兜底。
    const result = probe(findRepoRoot())
    expect(result.missing, `真实仓库判定失败：${result.source}`).toEqual([])
    if (result.hits.length > 0) {
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]).toMatch(new RegExp(`/${SENDER_FILE}$`, 'u'))
      // A1：在场时来源必须是"活文件"，且活文件里必须真的有契约常量那个头名（上面的
      // `missing` 已经覆盖后半句，这里把"来源不许是冻结件"也钉住）。
      expect(result.source, 'submodule 在场 ⇒ 来源必须是活文件判定').toContain('活文件')
      expect(result.source).not.toContain('冻结件')
    } else {
      // 缺席时来源必须显式写明证据（不许静默降级成"拿常量测常量"还不说）——
      // 断言消息绿的时候不打印，所以这里直接把来源打进输出。
      expect(result.source, '缺席 ⇒ 来源必须写明用了冻结件 + 证据').toContain('冻结件')
      expect(result.source).toContain('缺席')
      console.info(`[归因锚点②] 未读活文件（submodule 缺席）⇒ 判定来源：${result.source}`)
    }
  })

  it('本仓在场判据的自证：真检出（.git 在）必须判 live，不许因上游布局判成缺席', () => {
    const root = findRepoRoot()
    const verdict = classifyUpstreamPresence(root)
    // 本机/CI（Gate）是真检出；若这里判成 absent/unknown，说明在场判据又依赖了上游布局路径。
    if (existsSync(join(root, 'deepseek-harness', '.git'))) {
      expect(verdict.presence, verdict.evidence).toBe('live')
    }
    expect(verdict.presence, `在场性不许判不出来：${verdict.evidence}`).not.toBe('unknown')
  })
})

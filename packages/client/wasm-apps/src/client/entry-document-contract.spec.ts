/// <reference types="node" />
/**
 * **入口文档的三形态：作者手册 ↔ 实现的对拍**（R3-A A-5 的文档面收尾）。
 *
 * ## 这条闸要拦的缺陷类
 *
 * A-5 的缺陷是"实现与文档不一致"，而它能在仓库里活下来的原因很具体：**入口形态被写在
 * 四处，每一处都只钉自己的字面量**（`static.go` 规则 5 的注释、`references/abi.md` 的
 * 路由表、`SKILL.md` 的直出表、`docs/wasm-app-authoring.md` 的 §2.1b）。四处里三处写
 * 「`/`、`/index.html`、`<目录>/`」，实现只认 `index.html` ⇒ 页面放在子目录的应用，
 * 入口被宿主直出，应用自己的准入页（名单外用户应看到的 403 与本人账号）永远不被调用。
 *
 * 实现已按多数文档修正（`isEntryDocument`）。剩下的风险是**同一句话再次分叉**：
 * 有人改实现（比如只留根入口）或改文档（比如把那句里的 `<目录>/` 删掉），另一侧不动。
 * 本用例把手册那一句与实现那两行**对拍成集合相等**。
 *
 * ## 判据的强度（第三轮独立复审 F2 / F3 的加固）
 *
 * 旧版对拍有两处"看不见"：
 *
 *  - **F2（实现放宽）**：实现侧只按两条固定正则认形态（`rel = "index.html"` /
 *    `rel += "/index.html"`）——"能匹配到就算"，于是 `isEntryDocument` 里再补一条
 *    `strings.HasSuffix(rel, ".htm")` 时**全绿**。现在实现侧的形态是**封闭枚举 + 反向
 *    断言**：`isEntryDocument` 的每个 `||` 析取项、`staticLogicalPath` 的每一处 `rel`
 *    写入，都必须命中一张白名单；多一项、换一种写法、值不是字面量 ⇒ **throw**。
 *  - **F3（文档多列）**：文档侧的枚举行里认不出的 token 会被 `filter` 静默丢掉，于是
 *    多写一个 `/foo` 仍绿。现在**认不出即 throw**（语义与"读不到就 throw"一致）。
 *
 * 红信息带**文件:行 + 原文 + 认得的形态清单**，照抄即可。
 *
 * ## 为什么这条用例住客户端包里
 *
 * `docs/**` 没有自己的测试面，而本包已经是"跨工件对拍"的所在地
 * （`appcfg-contract.spec.ts` 读服务端生成物、`shipped-bundle.spec.ts` 读随包产物）——
 * 加在这里才能被包级 `check`（build + 全量 vitest）真的跑到，而不是成为一条无人执行的
 * 约定。两侧任一缺席（文件改名/句子重写/函数搬走）**直接 throw**，不 skip。
 *
 * ⚠️ 覆盖范围只到 `docs/wasm-app-authoring.md`（本泳道可写面）。同一句话在
 * `server/skills/app-builder/references/abi.md` §8 与 `SKILL.md` / `preview.mjs` 也在
 * （属 `server/**` 泳道，且改 SKILL 资源要提版本号 + 登记摘要），本用例**故意不**把它们
 * 纳入断言：跨泳道的红会把另一个泳道的 PR 打红，而修它的人改不到本文件。那四个契约面由
 * 服务端泳道的 `appserver/entry_contract_test.go` 按"每条枚举行必须列全三形态"守住 ——
 * 两条闸互补：**那条管"少列"，这条管"多列/放宽"**。
 *
 * ---- 变异验证 ----
 *   - 把手册那一句改回 `（`/`、`/index.html`）` ⇒ 集合相等红（缺 `<目录>/`）；
 *   - 把 `static.go` 的 `isEntryDocument` 去掉 `strings.HasSuffix(rel, "/index.html")`
 *     ⇒ 同上红（实现只认根入口）；
 *   - 把两者的句型改得抠不出来 ⇒ "两侧都能抠出来"那一条红（不是静默通过）；
 *   - **实现放宽**（`isEntryDocument` 追加 `strings.HasSuffix(rel, ".htm")`）⇒ throw（F2）；
 *   - **文档多列**（枚举里加一个 `/foo`）⇒ throw（F3）。
 *
 * @module @picoaide/dsh-wasm-apps/client/entry-document-contract.spec
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上走四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/** 作者手册（本泳道可写面）。 */
export const ENTRY_DOC_REPO_PATH = 'docs/wasm-app-authoring.md'
/** 入口判据的实现（宿主静态服务）。 */
export const STATIC_GO_REPO_PATH = 'server/internal/wasmapp/appserver/static.go'

/**
 * 契约的**三形态**（顺序即阅读顺序）。
 *
 * 归一化后的稳定写法：根 `/`、显式根文档 `/index.html`、目录形态 `<dir>/`
 * （目录形态在实现里归一成 `<dir>/index.html`）。文档里的 `<目录>/` 与 `<dir>/`
 * 视为同一形态 —— 手册是中文写的，实现是英文标识符，归一化是这条对拍的前提。
 */
export const ENTRY_DOC_FORMS = ['/', '/index.html', '<dir>/'] as const

/** 目录形态的写法（尖括号占位符 + 斜杠收尾；`<目录>/` 与 `<dir>/` 都认）。 */
const SUBDIR_FORM = /^<[^<>/]+>\/$/u

/** 一次写入点/一个短语在全文里的位置与原文（行号 + 原文都能直接照抄）。 */
interface Point {
  /** 相对全文的起始偏移。 */
  index: number
  /** 1-based 行号。 */
  line: number
  /** 原文（截到行尾、去掉首尾空白）。 */
  raw: string
}

/**
 * 读仓库内文件。**读不到就抛**（真源缺席必须是红的，不是 skip）。
 * @param relative - 仓库内相对路径。
 * @returns 文件全文。
 */
function readRepoFile(relative: string): string {
  try {
    return readFileSync(join(REPO_ROOT, relative), 'utf8')
  } catch (cause) {
    throw new Error(`${relative} 读不到（${cause instanceof Error ? cause.message : String(cause)}）：入口文档对拍的真源缺席`)
  }
}

/**
 * 第 `index` 个字符所在的 1-based 行号（红信息要能照抄，所以必须报真实行号）。
 * @param source - 全文。
 * @param index - 字符偏移。
 * @returns 1-based 行号。
 */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1
  }
  return line
}

/**
 * 行注释擦除：`// …` 换成**等长空格**（偏移量必须保持不变，否则行号会整体位移）。
 * @param source - 全文。
 * @returns 同样长度、注释位置被空格覆盖的文本。
 */
export function blankLineComments(source: string): string {
  return source.replace(/\/\/[^\n]*/gu, comment => ' '.repeat(comment.length))
}

/** 一段 Go 函数体：文本 + 它在**全文**里的起始偏移。 */
interface GoFuncSlice {
  body: string
  start: number
}

/**
 * 取一个 Go 函数的切片（只做 `\nfunc ` 边界切分，不解析 Go）。
 * @param source - 擦除注释后的全文。
 * @param signature - 函数签名前缀。
 * @returns 切片；找不到返回 `null`。
 */
function goFuncSlice(source: string, signature: string): GoFuncSlice | null {
  const start = source.indexOf(signature)
  if (start < 0) return null
  const nextFunc = source.indexOf('\nfunc ', start)
  return { body: source.slice(start, nextFunc < 0 ? undefined : nextFunc), start }
}

/**
 * 在函数体里找**全部**写入点（松匹配：只认"写到了这个变量"，不认右值形态）。
 * @param source - 擦除注释后的全文（用于算行号与原文）。
 * @param slice - 函数切片。
 * @param pattern - 必须带 `g` 标志的松匹配正则。
 * @returns 写入点列表（按原文顺序）。
 */
function findWritePoints(source: string, slice: GoFuncSlice, pattern: RegExp): Point[] {
  const points: Point[] = []
  for (const match of slice.body.matchAll(pattern)) {
    const index = slice.start + match.index
    const end = source.indexOf('\n', index)
    points.push({ index, line: lineAt(source, index), raw: source.slice(index, end < 0 ? undefined : end).trim() })
  }
  return points
}

/** 把一个写入点列表渲染成可照抄的清单（`文件:行 原文`）。 */
function renderPoints(path: string, points: readonly Point[]): string {
  return points.map(point => `  - ${path}:${point.line}  ${point.raw}`).join('\n')
}

/**
 * 把一处写法归一成 {@link ENTRY_DOC_FORMS} 里的形态。
 * @param raw - 原文片段（可含反引号与空白，含形态后面的解释）。
 * @returns 归一化形态；认不出来返回 `null`。
 */
function normalizeEntryForm(raw: string): (typeof ENTRY_DOC_FORMS)[number] | null {
  // 只取片段里的第一个 token：文档会在形态后面补一句解释（如 ` —— 目录形态等价于 …`）。
  const token = raw.trim().split(/[\s—]+/u)[0]?.replace(/[`“”"]/gu, '') ?? ''
  if (token === '/') return '/'
  if (token === '/index.html') return '/index.html'
  if (SUBDIR_FORM.test(token)) return '<dir>/'
  return null
}

/**
 * 从手册里抠出"入口文档（…）"那一句枚举的形态。
 *
 * **认不出的 token 直接 throw**（复审 F3）：旧版把它们 `filter` 掉，于是文档多列一个
 * 实现根本不认的形态（如 `/foo`）时闸门仍然全绿 —— 那正是"文档与实现不一致"这一个
 * 缺陷类的反方向。
 * @param source - 手册全文。
 * @returns 归一化形态集合；找不到那句话时返回 `null`（调用方据此红）。
 */
export function entryFormsFromDoc(source: string): string[] | null {
  const match = /入口文档（([^）]*)）/u.exec(source)
  if (match === null) return null
  const raw = match[1]!
  const base = match.index + '入口文档（'.length
  const forms: string[] = []
  const unrecognized: { token: string, line: number }[] = []
  let cursor = 0
  for (const piece of raw.split('、')) {
    const at = raw.indexOf(piece, cursor)
    cursor = at + piece.length
    const form = normalizeEntryForm(piece)
    if (form === null) {
      unrecognized.push({
        token: (piece.trim().split(/[\s—]+/u)[0] ?? piece.trim()).replace(/[`“”"]/gu, ''),
        line: lineAt(source, base + at),
      })
      continue
    }
    forms.push(form)
  }
  if (unrecognized.length > 0) {
    throw new Error(
      `${ENTRY_DOC_REPO_PATH}:${unrecognized[0]!.line} 的入口形态枚举里出现了实现不认的形态：`
      + unrecognized.map(entry => `\`${entry.token}\`（第 ${entry.line} 行）`).join('、')
      + `。\n实现认得的形态只有：${ENTRY_DOC_FORMS.join(' / ')}（目录形态在实现里归一成 <dir>/index.html）。\n`
      + '文档多列一个不存在的形态会让作者写出宿主根本不当入口的路径（或以为某个形态可用）——'
      + '要么把实现补上（连带同步其它契约面），要么把这个形态从枚举里删掉。',
    )
  }
  return forms.length === 0 ? null : [...new Set(forms)].sort()
}

/**
 * 实现侧**唯一认得**的入口判据形状（**封闭枚举**，复审 F2）。
 *
 * 这不是"正则能匹配到就算"：`isEntryDocument` 的每个 `||` 析取项都必须**逐个**命中
 * 本表；多一项（如 `strings.HasSuffix(rel, ".htm")`）、换一种写法（用变量、用别的
 * 字符串函数）、或值与归一化那侧不成对 ⇒ throw。
 */
const ENTRY_PREDICATE_SHAPES: { key: 'root' | 'subdir', id: string, forms: readonly string[], matches: (disjunct: string) => boolean }[] = [
  {
    key: 'root',
    id: 'rel == "index.html"',
    forms: ['/', '/index.html'],
    matches: disjunct => /^rel\s*==\s*"index\.html"$/u.test(disjunct),
  },
  {
    key: 'subdir',
    id: 'strings.HasSuffix(rel, "/index.html")',
    forms: ['<dir>/'],
    matches: disjunct => /^strings\.HasSuffix\(rel,\s*"\/index\.html"\)$/u.test(disjunct),
  },
]

/** `staticLogicalPath` 里 `rel` 的写入点（松匹配；`(?!=)` 排掉 `rel == ""` 这类比较）。 */
const REL_WRITE = /\brel\s*(\+?=)(?!=)/gu

/** 认得的 `rel` 写入形状：操作符 + 字符串字面量（白名单见 {@link REL_WRITE_SHAPES}）。 */
const REL_WRITE_RECOGNIZED = /^rel\s*(\+?=)(?!=)\s*("(?:[^"\\]|\\.)*")/u

/**
 * `staticLogicalPath` 里允许出现的 `rel` 写入形状（**封闭枚举**）。
 *
 * `= ""` 不是一种入口形态，而是"还没归一"折成空串的中间态（根路径）；另两条分别是
 * 根形态与目录形态的归一化。任何第四条（含"用函数算出来再赋值"）都会让实现侧多出
 * 一条本闸看不见的入口归一化路径 ⇒ throw。
 */
const REL_WRITE_SHAPES: Record<string, string> = {
  '= ""': '把"还没归一"折成空串（根路径）的中间态',
  '= "index.html"': '根形态归一（`/` 与 `/index.html`）',
  '+= "/index.html"': '目录形态归一（`<目录>/`）',
}

/**
 * 抠出 `isEntryDocument` 的 `||` 析取项（只做切分，不判定形态）。
 * @param blanked - 擦除注释后的全文。
 * @param entry - `isEntryDocument` 的切片。
 * @returns 析取项（text + 真实行号）；函数体里没有 `return` 时返回 `null`。
 */
function entryDisjuncts(blanked: string, entry: GoFuncSlice): { text: string, line: number }[] | null {
  const returnIndex = entry.body.lastIndexOf('return')
  if (returnIndex < 0) return null
  const expression = entry.body.slice(returnIndex + 'return'.length).replace(/\}\s*$/u, '')
  const disjuncts: { text: string, line: number }[] = []
  let cursor = 0
  for (const piece of expression.split('||')) {
    const at = expression.indexOf(piece, cursor)
    cursor = at + piece.length
    const index = entry.start + returnIndex + 'return'.length + at
    disjuncts.push({ text: piece.trim(), line: lineAt(blanked, index) })
  }
  return disjuncts
}

/**
 * 从 `static.go` 抠出入口判据支持的三形态（**封闭枚举 + 反向断言**）。
 *
 * 判据分散在两处（这是实现的事实，不是我的取舍）：
 *  - `staticLogicalPath` 负责**归一化**：根路径 → `index.html`（`rel = "index.html"`）、
 *    目录形态 → `<dir>/index.html`（`rel += "/index.html"`）；
 *  - `isEntryDocument` 负责**判定**：`rel == "index.html"` 或 `HasSuffix(rel, "/index.html")`。
 *
 * 前者的归一化只有在后者认它时才算"入口"，所以两个条件必须成对出现才算一个形态；
 * 而两侧的**每一种写法**都必须在白名单里（认不出即 throw，不静默忽略）。
 * @param source - `static.go` 全文。
 * @returns 归一化形态集合；函数被搬走/改名时返回 `null`。
 */
export function entryFormsFromStaticGo(source: string): string[] | null {
  const blanked = blankLineComments(source)
  const logical = goFuncSlice(blanked, 'func staticLogicalPath(')
  const entry = goFuncSlice(blanked, 'func isEntryDocument(')
  if (logical === null || entry === null) return null

  // ---- 归一化侧：每一处 `rel` 写入都必须是白名单里的字面量形态 ----
  const unrecognizedWrites: Point[] = []
  const writeShapes = new Set<string>()
  for (const point of findWritePoints(blanked, logical, REL_WRITE)) {
    const match = REL_WRITE_RECOGNIZED.exec(blanked.slice(point.index))
    if (match === null) {
      unrecognizedWrites.push(point)
      continue
    }
    writeShapes.add(`${match[1]} ${match[2]}`)
  }
  if (unrecognizedWrites.length > 0) {
    throw new Error(
      `${STATIC_GO_REPO_PATH} 的 staticLogicalPath 里有 ${unrecognizedWrites.length} 处认不出形态的 \`rel\` 写入`
      + `（不是"操作符 + 字符串字面量"，或不在白名单里）：\n${renderPoints(STATIC_GO_REPO_PATH, unrecognizedWrites)}\n`
      + `认得的写入形状只有：${Object.keys(REL_WRITE_SHAPES).map(shape => `\`rel ${shape}\``).join(' / ')}。\n`
      + '新增一条归一化路径就等于新增一种入口形态，而入口形态是**跨端契约**（文档/技能/预览宿主都列了它）：'
      + '先补本闸的白名单与 docs/wasm-app-authoring.md 的枚举，再改实现。',
    )
  }

  // ---- 判定侧：`isEntryDocument` 的每个 `||` 析取项都必须在白名单里 ----
  const disjuncts = entryDisjuncts(blanked, entry)
  if (disjuncts === null) return null
  const predicates = new Set<'root' | 'subdir'>()
  const unrecognizedDisjuncts: { text: string, line: number }[] = []
  for (const disjunct of disjuncts) {
    const shape = ENTRY_PREDICATE_SHAPES.find(candidate => candidate.matches(disjunct.text))
    if (shape === undefined) {
      unrecognizedDisjuncts.push(disjunct)
      continue
    }
    predicates.add(shape.key)
  }
  if (unrecognizedDisjuncts.length > 0) {
    const first = unrecognizedDisjuncts[0]!
    throw new Error(
      `${STATIC_GO_REPO_PATH}:${first.line} 的 isEntryDocument 里有 ${unrecognizedDisjuncts.length} 个认不出形态的判据分支：\n`
      + unrecognizedDisjuncts.map(entryPoint => `  - ${STATIC_GO_REPO_PATH}:${entryPoint.line}  ${entryPoint.text}`).join('\n')
      + `\n认得的判据只有：${ENTRY_PREDICATE_SHAPES.map(shape => `\`${shape.id}\``).join(' / ')}。\n`
      + '多一个分支就是**实现放宽了入口形态**（例如把 `.htm` 也算入口），而文档/技能/预览宿主都没跟 —— '
      + '这正是 A-5 那类漂移的反方向。要么把这一分支删掉，要么同步三形态清单与四处契约面。',
    )
  }

  // ---- 归一化与判定必须成对（缺一侧 ⇒ 该形态实际不可达） ----
  const hasRootNorm = writeShapes.has('= "index.html"')
  const hasSubdirNorm = writeShapes.has('+= "/index.html"')
  const missingPairs: string[] = []
  if (predicates.has('root') && !hasRootNorm) missingPairs.push('isEntryDocument 认 `rel == "index.html"`，但 staticLogicalPath 里没有 `rel = "index.html"` 这条归一化')
  if (predicates.has('subdir') && !hasSubdirNorm) missingPairs.push('isEntryDocument 认 `HasSuffix(rel, "/index.html")`，但 staticLogicalPath 里没有 `rel += "/index.html"` 这条归一化')
  if (missingPairs.length > 0) {
    throw new Error(
      `${STATIC_GO_REPO_PATH} 的入口判据与归一化脱节（判据在、归一化不在 ⇒ 该形态实际不可达）：\n`
      + missingPairs.map(line => `  - ${line}`).join('\n')
      + '\n改判据时必须同时改归一化，否则文档列出的形态在实现里永远走不到。',
    )
  }

  const forms: string[] = []
  if (predicates.has('root') && hasRootNorm) forms.push('/', '/index.html')
  if (predicates.has('subdir') && hasSubdirNorm) forms.push('<dir>/')
  return forms.length === 0 ? null : [...new Set(forms)].sort()
}

const doc = readRepoFile(ENTRY_DOC_REPO_PATH)
const staticGo = readRepoFile(STATIC_GO_REPO_PATH)
const docForms = entryFormsFromDoc(doc)
const implForms = entryFormsFromStaticGo(staticGo)

describe('入口文档三形态：作者手册 ↔ static.go 实现', () => {
  it('两侧都抠得出来（句型被改得认不出来 ⇒ 红，不是静默通过）', () => {
    expect(docForms, `${ENTRY_DOC_REPO_PATH} 里找不到「入口文档（…）」那一句枚举`).not.toBeNull()
    expect(implForms, `${STATIC_GO_REPO_PATH} 里找不到 staticLogicalPath / isEntryDocument 的判据`).not.toBeNull()
    expect(docForms).toContain('/')
    expect(implForms).toContain('<dir>/')
  })

  /**
   * 主判据：手册枚举的形态 == 实现支持的形态。
   *
   * A-5 修复前这条是红的：手册只列 `/`、`/index.html`，而实现（修正后）支持三形态；
   * 反过来把实现改回只认根入口，这条同样红。
   */
  it('手册枚举的入口形态与实现判据完全相等（三个形态，不多不少）', () => {
    expect(
      docForms,
      `${ENTRY_DOC_REPO_PATH} 枚举了 ${JSON.stringify(docForms)}，`
      + `而 ${STATIC_GO_REPO_PATH} 的 staticLogicalPath + isEntryDocument 支持 ${JSON.stringify(implForms)}。`
      + '两侧必须同时列全 `/`、`/index.html`、`<dir>/`：只保护根入口会让页面放在子目录的应用'
      + '把入口直出给宿主，应用自己的准入页（名单外用户应看到的 403）永远不被调用。',
    ).toEqual(implForms)
    expect(docForms).toEqual([...ENTRY_DOC_FORMS].sort())
  })

  it('这份对拍真的会红（对手册回退与实现回退两种改写自证）', () => {
    // ① 手册回退成旧的两形态写法（A-5 修复前的原文）。
    const reverted = doc.replace('入口文档（`/`、`/index.html`、`<目录>/`', '入口文档（`/`、`/index.html`')
    expect(reverted, '合成锚点失效（手册里找不到 `入口文档（`/`、`/index.html`、`<目录>/``）：真源被改写了，本自证要跟着改').not.toBe(doc)
    expect(entryFormsFromDoc(reverted)).toEqual(['/', '/index.html'].sort())
    expect(entryFormsFromDoc(reverted)).not.toEqual(implForms)

    // ② 实现回退：`isEntryDocument` 去掉目录形态那一条。
    const shrunk = staticGo.replace(' || strings.HasSuffix(rel, "/index.html")', '')
    expect(shrunk, '合成锚点失效（`isEntryDocument` 里找不到 ` || strings.HasSuffix(rel, "/index.html")`）：真源被改写了，本自证要跟着改').not.toBe(staticGo)
    expect(entryFormsFromStaticGo(shrunk)).toEqual(['/', '/index.html'].sort())
    expect(entryFormsFromStaticGo(shrunk)).not.toEqual(docForms)
  })

  /**
   * 复审 F2 自证：实现**放宽**入口形态时旧判据全绿（"正则能匹配到就算"），现在必须红。
   */
  it('实现放宽入口形态（追加 .htm 也算入口）⇒ 抛错，不是静默匹上两条正则就算过', () => {
    const widened = staticGo.replace(
      ' || strings.HasSuffix(rel, "/index.html")',
      ' || strings.HasSuffix(rel, "/index.html") || strings.HasSuffix(rel, ".htm")',
    )
    expect(widened, '合成锚点失效（`isEntryDocument` 里找不到目录形态那一条判据）：真源被改写了，本自证要跟着改').not.toBe(staticGo)
    expect(() => entryFormsFromStaticGo(widened)).toThrow(/认不出形态的判据分支/u)

    // 反向自证：旧判据只问"白名单里的两条判据匹不匹得上"，多出来的 `.htm` 分支它不看 ⇒
    // 仍然得出三形态（这就是复审实测的"全绿"）。
    const widenedBlanked = blankLineComments(widened)
    const widenedDisjuncts = entryDisjuncts(widenedBlanked, goFuncSlice(widenedBlanked, 'func isEntryDocument(')!)
    expect(widenedDisjuncts, '放宽后的实现仍应能切出析取项').not.toBeNull()
    expect(widenedDisjuncts!.length, '放宽后的实现多了一个判据分支').toBe(3)
    const oldStyleForms = [...new Set(ENTRY_PREDICATE_SHAPES
      .filter(shape => widenedDisjuncts!.some(disjunct => shape.matches(disjunct.text)))
      .flatMap(shape => [...shape.forms]))].sort()
    expect(
      oldStyleForms,
      '旧判据（"正则匹得上就算"）在放宽实现下必须仍然得出三形态（否则这条自证没打在看漏上）',
    ).toEqual(['/', '/index.html', '<dir>/'])

    // 归一化侧同理：多一条 `rel` 写入（哪怕值由函数算出来）也要红。
    const widenedNormalization = staticGo.replace('\t\trel = "index.html"', '\t\trel = entryDocumentName(rel)')
    expect(widenedNormalization, '合成锚点失效（`staticLogicalPath` 里找不到 `\t\trel = "index.html"`）：真源被改写了，本自证要跟着改').not.toBe(staticGo)
    expect(() => entryFormsFromStaticGo(widenedNormalization)).toThrow(/认不出形态的 `rel` 写入/u)

    // 判据与归一化脱节（判据在、归一化不在）也要红，且报文点名是哪一对。
    const unpaired = staticGo.replace('\t\trel = "index.html"\n', '')
    expect(unpaired, '合成锚点失效（`staticLogicalPath` 里找不到 `\t\trel = "index.html"\n`）：真源被改写了，本自证要跟着改').not.toBe(staticGo)
    expect(() => entryFormsFromStaticGo(unpaired)).toThrow(/入口判据与归一化脱节/u)
  })

  /**
   * 复审 F3 自证：文档多列一个实现不认的形态时旧判据全绿（token 被 `filter` 丢掉），
   * 现在必须红。反方向（删掉 `<目录>/`）原本就会红，一并作为对照。
   */
  it('文档多列一个实现不认的形态（/foo）⇒ 抛错，不是把它 filter 掉', () => {
    const extra = doc.replace('入口文档（`/`、`/index.html`、`<目录>/`', '入口文档（`/`、`/index.html`、`<目录>/`、`/foo`')
    expect(extra, '合成锚点失效（手册里找不到三形态那句枚举）：真源被改写了，本自证要跟着改').not.toBe(doc)
    expect(() => entryFormsFromDoc(extra)).toThrow(/实现不认的形态/u)
    expect(() => entryFormsFromDoc(extra)).toThrow(/\/foo/u)

    // 反方向对照：删掉一个真实形态仍然红（集合相等）。
    const dropped = doc.replace('入口文档（`/`、`/index.html`、`<目录>/`', '入口文档（`/`、`/index.html`')
    expect(entryFormsFromDoc(dropped)).toEqual(['/', '/index.html'].sort())
    expect(entryFormsFromDoc(dropped)).not.toEqual(implForms)
  })
})

/**
 * 模型面源码的**注释感知扫描器**（2026-10-04，核验 P13-P1 §8 收口）。
 *
 * ## 为什么要它
 *
 * `tests/shell-pages-locale.spec.ts` 的「模型面零中文」守卫原来用两个朴素正则剥注释：
 * 一条匹配块注释（斜杠星号 … 星号斜杠），一条匹配 `//` 行注释。那套近似会被"**非注释区
 * 里的斜杠 + 星号**"骗成块注释起点，把它到下一个"星号 + 斜杠"之间的**代码整段吞掉**
 * ⇒ 那一段里的中文对守卫不可见（假绿）。已实测的形态（详见 §11 报告）：
 *
 *   - **BV4/BV5**：`/*` 落在**字符串字面量**里（例如 glob `'src/*'`）——把中文 render
 *     或 `description` 包在两串之间，整个 browser 包的 1013 条用例可以**全绿**；
 *   - 更早的一版：`/*` 落在 `//` 行注释里（同一个机制）。
 *
 * ## 这个扫描器怎么做到不看走眼
 *
 * 逐字符状态机（不是正则近似），按 JS/TS 词法把源码切成：
 * **代码 / `//` 行注释 / `/* … *​/` 块注释 / `'…'` / `"…"` / 模板（含 `${}` 子表达式）/
 * 正则字面量**。只有**真的在注释里**的字符才会被抹掉；字符串、模板、正则里的内容
 * 一律保留在 `code` 里（它们就是模型面内容的一部分）。
 *
 * 另外给出两个 fail-loud 面：
 *
 *   - `offenders`：**非注释区**里出现的 `/*` 或 `*​/`（含字符串/模板/正则内部）。
 *     它是"扫描面可能被近似量具吃掉"的结构信号 —— 出现即判红，要求作者改写
 *     （例如把 glob 写成 `src/client 目录`）。这条同时是"扫描器自己看走眼"的第二道网：
 *     任何一处它没认出来的注释形态，都会先在这里以字面量形式暴露出来。
 *   - `unterminated`：未闭合的块注释/字符串/模板（源码本身不合法）—— 同样判红。
 *
 * ## 已知边界（写清楚，不装作全能）
 *
 * 正则字面量靠**上一个有意义字符**的启发式判定（`= /re/`、`( /re/`、`return /re/`
 * 等表达式位置成立；`}` 之后保守按除法处理）。本文件今天**零个正则字面量**（实测），
 * 且即便启发式判错，方向也是"少抹一点"（中文照旧可见）或撞上 `offenders` 判红，
 * 不会静默变成假绿。真正的对抗性写法（故意把中文拼成 `\uXXXX` 转义、运行时
 * `String.fromCharCode` 拼出来）不在本量具的判据面内 —— 能改这个文件的人本来就可以
 * 直接删掉守卫，见仓库既有的"判据能力边界"口径。
 *
 * @module @picoaide/dsh-browser/tests/helpers/model-source-scan
 */

/** 命中位置（1 基行列 + 一截可读上下文）。 */
export interface ScanPosition {
  /** 1 基行号。 */
  readonly line: number
  /** 1 基列号。 */
  readonly column: number
  /** 该行从命中处起的最多 80 个字符（便于报告里直接可读）。 */
  readonly text: string
}

/** 一次扫描的结果。 */
export interface ModelSourceScan {
  /** 抹掉注释后的等价文本（换行原样保留 ⇒ 行号与原文 1:1）。 */
  readonly code: string
  /** 非注释区里出现的 `/*` 或 `*​/`（字符串/模板/正则内部也算）。 */
  readonly offenders: readonly ScanPosition[]
  /** 未闭合的块注释/字符串/模板；源码本身不合法时为非 null。 */
  readonly unterminated: ScanPosition | null
  /** 统计（自检与报告用）。 */
  readonly counts: { readonly lineComments: number; readonly blockComments: number; readonly regexLiterals: number }
}

/** 1 基行号（`index` 处的字符属于哪一行）。 */
export function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1
  }
  return line
}

/** 上一个"有意义"字符是否允许后面跟一个正则字面量（而不是除法）。 */
function regexAllowedAfter(prev: string): boolean {
  if (prev === '') return true
  // 标识符/数字结尾、`)`、`]`、`}`、字符串或模板结尾 ⇒ 那是除法（保守：`}` 一律按除法）。
  return !/[\w$)\]}'"`]/u.test(prev)
}

/**
 * 扫描一段源码，抹掉注释并标出可疑形态。
 * @param source - 源码文本。
 * @returns 扫描结果（见 {@link ModelSourceScan}）。
 */
export function scanModelSource(source: string): ModelSourceScan {
  const chars = [...source]
  const n = chars.length
  let i = 0
  let lineComments = 0
  let blockComments = 0
  let regexLiterals = 0
  let unterminated: ScanPosition | null = null
  /** 上一个有意义的字符（跳过空白与注释后），用于除法/正则判定。 */
  let prev = ''

  const posAt = (index: number): ScanPosition => {
    const lineStart = source.lastIndexOf('\n', index - 1) + 1
    const rest = source.slice(index)
    const newline = rest.indexOf('\n')
    return {
      line: lineOf(source, index),
      column: index - lineStart + 1,
      text: (newline === -1 ? rest : rest.slice(0, newline)).slice(0, 80),
    }
  }
  /** 把 [from, to) 抹成空格（换行保留）。 */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (chars[k] !== '\n') chars[k] = ' '
    }
  }

  /**
   * 模板/子表达式共用的扫描栈：`template` = 模板正文里，`expr` = `${ … }` 的表达式里
   * （`depth` 记录该子表达式内部还没闭合的 `{`）。
   */
  const stack: Array<{ kind: 'template' | 'expr'; depth: number }> = []

  while (i < n) {
    const ch = chars[i] as string
    const next = chars[i + 1]
    const top = stack.at(-1)

    // ------------------------------------------------ 模板正文（必须在注释判断之前！）
    // 模板正文里的 `//`、`/*` 都是**字面文本**（例如 URL、路径），不是注释 ——
    // 先判注释会把模板正文当成注释抹掉，那正是本量具要消灭的假绿形态。
    if (top?.kind === 'template') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') {
        stack.pop()
        i += 1
        prev = '`'
        continue
      }
      if (ch === '$' && next === '{') {
        stack.push({ kind: 'expr', depth: 0 })
        i += 2
        prev = ''
        continue
      }
      i += 1
      continue
    }

    // ------------------------------------------------ 模板子表达式 ${ … } 的花括号簿记
    if (top?.kind === 'expr') {
      if (ch === '{') { top.depth += 1; i += 1; prev = '{'; continue }
      if (ch === '}') {
        if (top.depth === 0) stack.pop()
        else top.depth -= 1
        i += 1
        prev = '}'
        continue
      }
      // 其它字符：子表达式里可以出现注释/字符串/正则 ⇒ 落到下面通用分支。
    }

    // ---------------------------------------------------------------- 注释
    if (ch === '/' && next === '/') {
      lineComments += 1
      let j = i
      while (j < n && chars[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }
    if (ch === '/' && next === '*') {
      blockComments += 1
      let j = i + 2
      let closed = false
      while (j < n) {
        if (chars[j] === '*' && chars[j + 1] === '/') { closed = true; break }
        j += 1
      }
      if (!closed) {
        unterminated = posAt(i)
        blank(i, n)
        i = n
        continue
      }
      blank(i, j + 2)
      i = j + 2
      continue
    }

    // ---------------------------------------------------------------- 字符串
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let closed = false
      while (j < n) {
        if (chars[j] === '\\') { j += 2; continue }
        if (chars[j] === quote) { closed = true; break }
        if (chars[j] === '\n') break
        j += 1
      }
      if (!closed) {
        unterminated = posAt(i)
        i = n
        continue
      }
      i = j + 1
      prev = quote
      continue
    }

    // ---------------------------------------------------------------- 模板开头
    if (ch === '`') {
      stack.push({ kind: 'template', depth: 0 })
      i += 1
      prev = ''
      continue
    }

    // ---------------------------------------------------------------- 正则
    if (ch === '/' && regexAllowedAfter(prev)) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n) {
        const c = chars[j] as string
        if (c === '\\') { j += 2; continue }
        if (c === '\n') break
        if (c === '[') { inClass = true; j += 1; continue }
        if (c === ']') { inClass = false; j += 1; continue }
        if (c === '/' && !inClass) { closed = true; break }
        j += 1
      }
      if (closed) {
        regexLiterals += 1
        j += 1
        while (j < n && /[a-z]/iu.test(chars[j] as string)) j += 1 // flags
        i = j
        prev = '/'
        continue
      }
      // 没闭合就不是正则（按普通字符继续，避免把整段代码吞掉）。
    }

    // ---------------------------------------------------------------- 普通代码
    if (ch !== undefined && !/\s/u.test(ch)) prev = ch
    i += 1
  }

  const code = chars.join('')
  const offenders: ScanPosition[] = []
  for (let k = 0; k + 1 < code.length; k += 1) {
    const pair = code.slice(k, k + 2)
    if (pair === '/*' || pair === '*/') offenders.push(posAt(k))
  }
  return { code, offenders, unterminated, counts: { lineComments, blockComments, regexLiterals } }
}

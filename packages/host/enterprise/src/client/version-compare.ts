/**
 * 版本先后比较（SemVer 2.0.0 §11）—— **与服务端唯一实现
 * `server/internal/util/semver.go` 的 `CompareSemVer` 是同一个算法**，
 * 由**仓内共享语料**逐条对拍：`server/internal/util/testdata/semver-corpus.json`
 * （对拍判据：`tests/version-compare-corpus.spec.ts`；Go 侧由 `internal/util`、
 * `internal/updatecheck`、`internal/skillmanifest`、`internal/wasmapp/registry` 各自读同一份）。
 *
 * 从 CapabilityCenterPanel 抽出（2026-09-18）：内置技能区（BuiltinSkillsStrip）
 * 也要判「更新到 vX」，而 panel 依赖 strip（渲染它），strip 再 import panel 就成环。
 * 抽出后 panel 仍 re-export 这个名字，既有单测与调用方不受影响。
 *
 * ⚠️ 2026-09-23 R4-D-1（P1）：此前的实现是「字母 run / 数字 run 分词 + 数字 run 按数值比」
 * 的 tokenizer，头注释声称"对齐服务端 `util.CompareSemVer` 的语义"，但**无处可验**，
 * 实测与服务端分叉：`1.0.0-rc10` vs `1.0.0-rc2`（客户端 +1 / 服务端 -1 ⇒ 能力中心把降级
 * 当升级）、`1.0.0-rc1` vs `1.0.0-rc.1`（客户端 0 / 服务端 +1 ⇒ 判成相等、漏更新）。
 * 现在逐行照抄 Go 侧规则，并把"对齐服务端"这句话变成**可执行的判据**（共享语料）：
 *   - 第一个 `-` 之后是预发布段（§9）；核心相同时有预发布的一方**更低**（§11.3）；
 *   - 预发布按 `.` 分段逐段比（§11.4）：纯数字段按**数值**（任意长度、前导零按数值）、
 *     字母数字段按 ASCII、数字段 < 字母数字段、前缀相同时**段数多者更大**；
 *   - 核心段按数值感知比较（`1.9.0 < 1.10.0`）；
 *   - build metadata（第一个 `+` 起）**忽略**（§10）；
 *   - 空串或含 `[0-9a-zA-Z._-]` 之外字符的输入 ⇒ 回落**字符串比较**（与 Go 的
 *     `strings.Compare` 同形；允许域是 ASCII，所以 UTF-16 码元序与字节序一致）。
 *
 * 两端一致性由语料钉住，**不要**在这里"顺手"加一条服务端没有的规则：语料里任何一对
 * 给出不同符号，两个包的 vitest 都会红。
 */

interface Token {
  text: string
  numeric: boolean
}

/** 把任意数字压成 -1/0/1（Go 侧同样只承诺符号）。 */
function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0
}

/** 字符串序（与 Go 的 `strings.Compare` 同形；允许域为 ASCII，故码元序 == 字节序）。 */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * 丢弃 §10 的 build metadata（第一个 `+` 及其后内容）。
 *
 * 只有非空且字符集合法的 build 段才剥（`[0-9A-Za-z.-]`，即 §9 允许的标识符字符）；
 * `"1.0.0+"` 这类畸形输入保持原样，交给字符白名单回落字符串序（与 Go 侧逐字一致）。
 */
function stripBuildMetadata(v: string): string {
  const at = v.indexOf('+')
  if (at < 0) return v
  const build = v.slice(at + 1)
  if (build === '') return v
  for (const ch of build) {
    const allowed = (ch >= '0' && ch <= '9')
      || (ch >= 'a' && ch <= 'z')
      || (ch >= 'A' && ch <= 'Z')
      || ch === '.'
      || ch === '-'
    if (!allowed) return v
  }
  return v.slice(0, at)
}

/** 切出核心段与预发布段（无 '-' ⇒ 预发布为空串）。 */
function splitPrerelease(v: string): { core: string; pre: string } {
  const at = v.indexOf('-')
  return at >= 0 ? { core: v.slice(0, at), pre: v.slice(at + 1) } : { core: v, pre: '' }
}

/** 把版本切成交替的字母/数字 run；出现允许集之外的字符时返回 null。 */
function tokenize(v: string): Token[] | null {
  const out: Token[] = []
  let run = ''
  let numeric = false
  let have = false
  const flush = (): void => {
    if (have) { out.push({ text: run, numeric }); run = ''; have = false }
  }
  for (const ch of v) {
    if (ch === '.' || ch === '-' || ch === '_') { flush(); continue }
    if (ch >= '0' && ch <= '9') { if (have && !numeric) flush(); run += ch; numeric = true; have = true; continue }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) { if (have && numeric) flush(); run += ch; numeric = false; have = true; continue }
    return null
  }
  flush()
  return out.length === 0 ? null : out
}

/** 核心段的数值感知比较（两侧都必须已通过 tokenize 校验）。 */
function compareTokenRuns(left: string, right: string): number {
  if (left === right) return 0
  const lt = tokenize(left)
  const rt = tokenize(right)
  if (lt === null || rt === null) return compareStrings(left, right)
  const n = Math.max(lt.length, rt.length)
  for (let i = 0; i < n; i += 1) {
    const l = lt[i]
    const r = rt[i]
    if (l !== undefined && r !== undefined) {
      if (l.numeric === r.numeric && l.text === r.text) continue
      if (l.numeric && r.numeric) {
        const c = compareDigitRuns(normalizeDigits(l.text)!, normalizeDigits(r.text)!)
        if (c !== 0) return c
        continue
      }
      if (l.numeric !== r.numeric) {
        // 同一位置数字 run 排在字母 run 之前（"2" < "rc"），只对 "1.2" vs "1.rc"
        // 这类畸形输入有意义；与 Go 侧同一注释同一条规则。
        return l.numeric ? -1 : 1
      }
      return compareStrings(l.text, r.text)
    }
    // 一侧先耗尽：多出来的 run 是字母 ⇒ 该侧是预发布，排在发布版**之前**
    // （"1.0.0-rc1" < "1.0.0"）；是数字 ⇒ 视为更高的补丁（"1.0" < "1.0.1"）。
    const extra = l ?? r
    if (extra !== undefined && !extra.numeric) return l === undefined ? 1 : -1
    return l === undefined ? -1 : 1
  }
  return 0
}

/** 纯数字串规范化为"无前导零"；非纯数字返回 null。 */
function normalizeDigits(s: string): string | null {
  if (s === '') return null
  for (const ch of s) {
    if (ch < '0' || ch > '9') return null
  }
  const trimmed = s.replace(/^0+/u, '')
  return trimmed === '' ? '0' : trimmed
}

/** 无溢出的数字串数值比较（入参应已去掉前导零；长度优先，再字典序）。 */
function compareDigitRuns(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return compareStrings(a, b)
}

/** 预发布段按 §11.4 逐段比较（点分段）。 */
function comparePrereleaseRuns(a: string, b: string): number {
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < as.length && i < bs.length; i += 1) {
    const xs = normalizeDigits(as[i]!)
    const ys = normalizeDigits(bs[i]!)
    if (xs !== null && ys !== null) {
      const c = compareDigitRuns(xs, ys)
      if (c !== 0) return c
      continue
    }
    // §11.4.3：纯数字标识符优先级**低于**字母数字标识符。
    if (xs !== null) return -1
    if (ys !== null) return 1
    const c = compareStrings(as[i]!, bs[i]!)
    if (c !== 0) return c
  }
  // §11.4.4：前缀相同 ⇒ 标识符多者更大。
  if (as.length !== bs.length) return as.length < bs.length ? -1 : 1
  return 0
}

/**
 * 比较两个版本号。
 * @param left - 左版本。
 * @param right - 右版本。
 * @returns 负数=left 更小，0=相等，正数=left 更大。
 */
export function compareVersions(left: string, right: string): number {
  if (left === right) return 0
  if (left === '' || right === '') return compareStrings(left, right)
  const l = stripBuildMetadata(left)
  const r = stripBuildMetadata(right)
  if (l === r) return 0
  if (tokenize(l) === null || tokenize(r) === null) return compareStrings(l, r)
  const { core: lCore, pre: lPre } = splitPrerelease(l)
  const { core: rCore, pre: rPre } = splitPrerelease(r)
  const core = compareTokenRuns(lCore, rCore)
  if (core !== 0) return core
  if (lPre === '' && rPre === '') return 0
  if (lPre === '') return 1
  if (rPre === '') return -1
  return sign(comparePrereleaseRuns(lPre, rPre))
}

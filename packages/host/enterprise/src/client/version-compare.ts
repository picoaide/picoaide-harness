/**
 * 数值感知的版本比较（`1.9.0 < 1.10.0`，`1.0.0-rc1 < 1.0.0`）。
 *
 * 从 CapabilityCenterPanel 抽出（2026-09-18）：内置技能区（BuiltinSkillsStrip）
 * 也要判「更新到 vX」，而 panel 依赖 strip（渲染它），strip 再 import panel 就成环。
 * 抽出后 panel 仍 re-export 这个名字，既有单测与调用方不受影响。
 *
 * 对齐服务端 `util.CompareSemVer` 的语义：逐段切分（`.`/`-`/`_` 分隔），数字段
 * 与字母段分别比较；解析不出的版本按字符串比较兜底。
 */

interface Token {
  text: string
  numeric: boolean
}

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

/**
 * 比较两个版本号。
 * @param left - 左版本。
 * @param right - 右版本。
 * @returns 负数=left 更小，0=相等，正数=left 更大。
 */
export function compareVersions(left: string, right: string): number {
  if (left === right) return 0
  const lt = tokenize(left)
  const rt = tokenize(right)
  if (lt === null || rt === null) return left < right ? -1 : left > right ? 1 : 0
  const n = Math.max(lt.length, rt.length)
  for (let i = 0; i < n; i += 1) {
    const l = lt[i]
    const r = rt[i]
    if (l !== undefined && r !== undefined) {
      if (l.numeric !== r.numeric) return l.numeric ? -1 : 1
      if (l.numeric) {
        const ln = Number(l.text) || 0
        const rn = Number(r.text) || 0
        if (ln < rn) return -1
        if (ln > rn) return 1
        continue
      }
      if (l.text !== r.text) return l.text < r.text ? -1 : 1
      continue
    }
    const extra = l ?? r
    if (extra !== undefined && !extra.numeric) return l === undefined ? 1 : -1
    return l === undefined ? -1 : 1
  }
  return 0
}

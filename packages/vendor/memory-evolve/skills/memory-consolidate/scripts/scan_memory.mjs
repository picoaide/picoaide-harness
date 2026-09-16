#!/usr/bin/env node
/**
 * memory-consolidate 预扫脚本 — dsh-memory-evolve 内置技能 memory-consolidate 的辅助工具。
 *
 * 零依赖、只读扫描记忆目录，产出「候选簇」JSON 报告（字面重复 / 相近条目 /
 * 覆盖更新线索 / 冲突线索），供 AI 会话按技能内批准的合并标准逐簇裁决。
 * 脚本只做候选发现，不做任何写操作、不做最终裁决——是否合并、怎么合并、
 * 保留哪条，一律由 AI 按标准判定后用 memory 工具（replace/archive/add）执行。
 *
 * 用法：
 *   node scan_memory.mjs [--dir ~/.dsh/memories] [--out report.json] [--threshold 0.42]
 *
 * 扫描范围（与技能的执行边界一致）：
 *   全局  MEMORY.md / USER.md（合并对象）+ *-archive.md（仅作上下文，不进簇）
 *   项目  projects/<hash>/KEY.md / MEMORY.md（合并对象；跨项目合并须到对应项目会话执行）
 *   排除  daily/（编年日志）与 TODOS-*（待办有独立工具）
 *
 * 退出码：0 正常 / 2 参数错误 / 3 目录不可用
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 记忆条目分隔符，与 lib/store.js 的 ENTRY_DELIMITER 字节兼容。 */
export const ENTRY_DELIMITER = '\n§\n'

const USAGE = `usage: node scan_memory.mjs [--dir <memoryDir>] [--out <report.json>] [--threshold <0..1>]
  --dir        memory directory (default: ~/.dsh/memories)
  --out        write JSON report to file (default: stdout)
  --threshold  cosine similarity floor for "similar" candidates (default: 0.42)`

// ── 解析 ────────────────────────────────────────────────────────────────────

/** 去掉文件头部的 HTML 注释块（技能/同步工具写入的说明头），返回正文。 */
export function stripHeaderComment(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/, '')
}

/**
 * 把一个记忆文件文本解析为条目数组。
 * @param {string} text 文件全文
 * @param {{file?:string, track?:string, project?:string|null, archived?:boolean}} meta 来源元数据
 */
export function parseMemoryText(text, meta = {}) {
  const body = stripHeaderComment(text)
  const out = []
  for (const raw of body.split(ENTRY_DELIMITER)) {
    const line = raw.trim()
    if (!line) continue
    // 头部序列兼容：[id:…]（同步回填）→ 日期（纯日期或日期时间）
    const m = line.match(/^(?:\[id:[0-9a-f]+\]\s*)?\[(\d{4}-\d{2}-\d{2})(?:[ \d:]+)?\]\s*/)
    out.push({
      id: fnv1a32(line),
      file: meta.file ?? null,
      track: meta.track ?? null,
      project: meta.project ?? null,
      archived: Boolean(meta.archived),
      date: m ? m[1] : null,
      text: line,
      body: m ? line.slice(m[0].length) : line,
      protected: PROTECTED_RE.test(line),
    })
  }
  return out
}

/** FNV-1a 32 位哈希（条目稳定 id，便于报告交叉引用）。 */
export function fnv1a32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ── 特征与相似度 ────────────────────────────────────────────────────────────

const PROTECTED_RE = /待用户(确认|拍板)|用户确认后|勿动|勿删/
const SUPERSEDE_CUE_RE = /((?:修订|更正|修正)既有|已过时|已经过时|不再准确|不再成立|已取代|取代旧|已被替代|已弃用|已废弃|已作废|以[^，。；;,.]{1,16}为准)/
const QUOTED_RE = /[「『]([^「」『』]{6,80})[」』]/g
/** 冲突极性对（[否定侧, 肯定侧]），精度优先从严。 */
const CONFLICT_POLARITY = [
  ['不可用', '实测可用'],
  ['无法使用', '可正常使用'],
  ['不再支持', '已支持'],
  ['无法启动', '正常启动'],
  ['已失效', '仍有效'],
  ['会崩溃', '无崩溃'],
]

/** 归一化：小写、去空白/标点/符号，保留 CJK 与字母数字。 */
export function normText(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 条目特征：ASCII 词元 + CJK 相邻字二元组。返回 term→tf Map。 */
export function entryTerms(body) {
  const lower = String(body ?? '').toLowerCase()
  const terms = new Map()
  const bump = (t) => terms.set(t, (terms.get(t) || 0) + 1)
  for (const w of lower.match(/[a-z0-9][a-z0-9+#._/-]*/g) || []) bump(w)
  const cjk = lower.match(/[\u4e00-\u9fff]/g) || []
  for (let i = 0; i + 1 < cjk.length; i++) bump(cjk[i] + cjk[i + 1])
  if (cjk.length === 1) bump(cjk[0])
  return terms
}

/** 语料级 IDF（缺省词权重 1）。 */
export function computeIdf(docs) {
  const df = new Map()
  for (const terms of docs) for (const t of terms.keys()) df.set(t, (df.get(t) || 0) + 1)
  const n = docs.length
  const idf = new Map()
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1)
  return idf
}

/** TF-IDF 加权余弦相似度（0..1）。 */
export function cosine(a, b, idf) {
  const w = (terms) => {
    const v = new Map()
    let norm = 0
    for (const [t, c] of terms) {
      const x = c * (idf.get(t) ?? 1)
      v.set(t, x)
      norm += x * x
    }
    return { v, norm: Math.sqrt(norm) }
  }
  const va = w(a)
  const vb = w(b)
  let dot = 0
  for (const [t, x] of va.v) {
    const y = vb.v.get(t)
    if (y) dot += x * y
  }
  if (!va.norm || !vb.norm) return 0
  return dot / (va.norm * vb.norm)
}

/** 字符二元组 Dice 系数（引用片段 vs 条目正文的模糊指认）。 */
export function diceBigrams(s1, s2) {
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const a = grams(s1)
  const b = grams(s2)
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return (2 * inter) / (a.size + b.size)
}

/** 引用指认：cue 条目正文中的「…」片段是否指向 other 的正文。 */
export function quotedRefersTo(cueBody, otherBody) {
  const target = normText(otherBody)
  if (!target) return false
  for (const m of String(cueBody).matchAll(QUOTED_RE)) {
    const span = normText(m[1])
    if (span.length >= 6 && target.includes(span)) return true
    if (span.length >= 8 && diceBigrams(span, target) >= 0.45) return true
  }
  return false
}

/**
 * 一对条目的候选理由。sim 为两正文余弦相似度。
 * 返回 reasons 数组（可能为空），取值：duplicate / similar / supersede / conflict。
 */
export function pairReasons(a, b, sim, opts = {}) {
  const threshold = opts.threshold ?? 0.42
  const reasons = []
  if (sim >= 0.86) reasons.push('duplicate')
  else if (sim >= threshold) reasons.push('similar')
  const cueEntry = SUPERSEDE_CUE_RE.test(a.body) ? a : SUPERSEDE_CUE_RE.test(b.body) ? b : null
  if (cueEntry) {
    const other = cueEntry === a ? b : a
    if (sim >= 0.3 || quotedRefersTo(cueEntry.body, other.body)) reasons.push('supersede')
  }
  for (const [neg, pos] of CONFLICT_POLARITY) {
    const aNeg = a.body.includes(neg)
    const bNeg = b.body.includes(neg)
    if ((aNeg && b.body.includes(pos) && !bNeg) || (bNeg && a.body.includes(pos) && !aNeg)) {
      if (sim >= 0.3) reasons.push('conflict')
      break
    }
  }
  return reasons
}

// ── 聚类 ────────────────────────────────────────────────────────────────────

/**
 * 全对比较 + 并查集聚簇。只收有理由的条目对；无任何候选的条目不进报告。
 * @param {Array} entries 非归档条目（parseMemoryText 的输出）
 * @param {{threshold?:number}} opts
 * @returns {Array<{id:string, hint:string, members:Array, pairs:Array}>}
 */
export function clusterEntries(entries, opts = {}) {
  const threshold = opts.threshold ?? 0.42
  const docs = entries.map((e) => entryTerms(e.body))
  const idf = computeIdf(docs)
  const parent = entries.map((_, i) => i)
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (x, y) => {
    parent[find(x)] = find(y)
  }
  const pairs = []
  const HINT_PRIORITY = ['supersede', 'duplicate', 'conflict', 'similar']
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sim = cosine(docs[i], docs[j], idf)
      // 不做相似度早退：引用指认（supersede via「…」）允许低相似命中，
      // 由 pairReasons 内部按各理由的门槛过滤
      const reasons = pairReasons(entries[i], entries[j], sim, { threshold })
      if (!reasons.length) continue
      pairs.push({ i, j, sim, reasons })
      union(i, j)
    }
  }
  const groups = new Map()
  for (let i = 0; i < entries.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(i)
  }
  const brief = (e) => ({
    id: e.id, file: e.file, track: e.track, project: e.project,
    date: e.date, protected: e.protected, excerpt: e.body.slice(0, 160),
  })
  const clusters = []
  let n = 0
  for (const idx of groups.values()) {
    if (idx.length < 2) continue
    const cpairs = pairs
      .filter((p) => idx.includes(p.i) && idx.includes(p.j))
      .map((p) => ({ a: entries[p.i].id, b: entries[p.j].id, sim: Math.round(p.sim * 1000) / 1000, reasons: p.reasons }))
    const reasons = new Set(cpairs.flatMap((p) => p.reasons))
    const hint = HINT_PRIORITY.find((h) => reasons.has(h)) ?? 'similar'
    clusters.push({
      id: `cluster-${++n}`,
      hint,
      members: idx.map((i) => brief(entries[i])),
      pairs: cpairs,
    })
  }
  clusters.sort((x, y) => Math.max(...y.pairs.map((p) => p.sim)) - Math.max(...x.pairs.map((p) => p.sim)))
  return clusters
}

// ── 目录扫描 ────────────────────────────────────────────────────────────────

/** 扫描记忆目录：全局 + 项目轨为合并对象，归档文件仅作上下文。 */
export function scanDir(dir) {
  const entries = []
  const archivedEntries = []
  const filesScanned = []
  const visit = (rel, track, project, archived) => {
    const p = join(dir, rel)
    if (!existsSync(p)) return
    let text
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      return
    }
    const parsed = parseMemoryText(text, { file: rel, track, project, archived })
    ;(archived ? archivedEntries : entries).push(...parsed)
    filesScanned.push({ file: rel, entries: parsed.length })
  }
  visit('MEMORY.md', 'memory', null, false)
  visit('USER.md', 'user', null, false)
  visit('MEMORY-archive.md', 'memory', null, true)
  visit('USER-archive.md', 'user', null, true)
  const projectsDir = join(dir, 'projects')
  if (existsSync(projectsDir)) {
    for (const ent of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      visit(join('projects', ent.name, 'KEY.md'), 'key', ent.name, false)
      visit(join('projects', ent.name, 'MEMORY.md'), 'project-log', ent.name, false)
      visit(join('projects', ent.name, 'KEY-archive.md'), 'key', ent.name, true)
      visit(join('projects', ent.name, 'MEMORY-archive.md'), 'project-log', ent.name, true)
    }
  }
  return { entries, archivedEntries, filesScanned }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { dir: null, out: null, threshold: 0.42 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') opts.dir = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--threshold') opts.threshold = Number(argv[++i])
    else throw new Error(`unknown arg: ${a}`)
  }
  if (!Number.isFinite(opts.threshold) || opts.threshold <= 0 || opts.threshold >= 1) {
    throw new Error('--threshold must be a number in (0, 1)')
  }
  if (opts.dir != null && typeof opts.dir !== 'string') throw new Error('--dir requires a path')
  if (opts.out != null && typeof opts.out !== 'string') throw new Error('--out requires a path')
  return opts
}

const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

export function main(argv = []) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`[memory-consolidate] ${err.message}`)
    console.error(USAGE)
    return 2
  }
  const dir = opts.dir ? expandHome(opts.dir) : join(homedir(), '.dsh', 'memories')
  if (!existsSync(dir)) {
    console.error(`[memory-consolidate] dir not found: ${dir}`)
    return 3
  }
  const scanned = scanDir(dir)
  const clusters = clusterEntries(scanned.entries, { threshold: opts.threshold })
  const reasonCount = { supersede: 0, duplicate: 0, conflict: 0, similar: 0 }
  for (const c of clusters) reasonCount[c.hint]++
  const report = {
    generatedAt: new Date().toISOString(),
    dir,
    threshold: opts.threshold,
    stats: {
      files: scanned.filesScanned.length,
      entries: scanned.entries.length,
      archivedContext: scanned.archivedEntries.length,
      clusters: clusters.length,
      hints: reasonCount,
    },
    clusters,
  }
  const json = JSON.stringify(report, null, 2)
  if (opts.out) {
    writeFileSync(opts.out, json + '\n', 'utf8')
    console.log('[memory-consolidate] scan complete')
    console.log(`  dir: ${dir}`)
    console.log(`  live entries: ${scanned.entries.length} (archived context: ${scanned.archivedEntries.length})`)
    console.log(`  candidate clusters: ${clusters.length}`)
    console.log(`  hints: supersede=${reasonCount.supersede} duplicate=${reasonCount.duplicate} conflict=${reasonCount.conflict} similar=${reasonCount.similar}`)
    console.log(`  report: ${opts.out}`)
  } else {
    process.stdout.write(json + '\n')
  }
  return 0
}

const isDirectRun = Boolean(process.argv[1]) && (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()
if (isDirectRun) process.exitCode = main(process.argv.slice(2))

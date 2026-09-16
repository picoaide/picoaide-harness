import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENTRY_DELIMITER, clusterEntries, computeIdf, cosine, diceBigrams, entryTerms,
  fnv1a32, main, normText, pairReasons, parseArgs, parseMemoryText, quotedRefersTo, scanDir, stripHeaderComment,
} from '../skills/memory-consolidate/scripts/scan_memory.mjs'

// memory-consolidate 内置技能的预扫脚本：解析 / 相似度 / 候选理由 / 聚类 /
// 目录扫描 / CLI。脚本只做候选发现，写操作由 AI 用 memory 工具执行（不在本文件范围）。

const entriesOf = (texts, meta = {}) =>
  texts.map((t) => parseMemoryText(t, meta)).flat()

test('parseMemoryText：§ 分隔、头部注释剥离、日期与 [id:] 头兼容', () => {
  const text = '<!-- 说明头 -->\n\n[2026-09-01] 第一条内容\n§\n[id:deadbeef] [2026-09-02 08:30] 第二条内容\n§\n没有日期前缀的第三条\n'
  const entries = parseMemoryText(text, { file: 'MEMORY.md', track: 'memory' })
  assert.equal(entries.length, 3)
  assert.equal(entries[0].date, '2026-09-01')
  assert.equal(entries[0].body, '第一条内容')
  assert.equal(entries[0].track, 'memory')
  // [id:…] 回填头不挡日期解析
  assert.equal(entries[1].date, '2026-09-02')
  assert.equal(entries[1].body, '第二条内容')
  assert.equal(entries[2].date, null)
  // 条目 id 稳定且为 8 位十六进制
  assert.match(entries[0].id, /^[0-9a-f]{8}$/)
  assert.equal(entries[0].id, fnv1a32('[2026-09-01] 第一条内容'))
  assert.equal(parseMemoryText('\n§\n  \n', {}).length, 0)
})

test('stripHeaderComment：只剥文件头部注释，正文内注释保留', () => {
  assert.equal(stripHeaderComment('<!-- a -->\n<!-- b -->\n正文'), '正文')
  assert.equal(stripHeaderComment('正文 <!-- 保留 -->'), '正文 <!-- 保留 -->')
})

test('相似度：同文约为 1，近重复高于 0.86，无关文本低于门槛', () => {
  const a = 'ollama 单机 8GB 显存多嵌入模型自动换载：qwen3-embedding:4b batch 32 实测 4.4 块/s，GPU 满载为正常稳态'
  const b = 'ollama 单机 8GB 显存多嵌入模型自动换载：qwen3-embedding:4b batch 32 实测 4.4 块/s，GPU 满载为正常稳态，复记'
  const unrelated = '前端 vite 构建产物部署到静态托管即可，无需后端'
  const docs = [a, b, unrelated].map((x) => entryTerms(x))
  const idf = computeIdf(docs)
  assert.ok(Math.abs(cosine(docs[0], docs[0], idf) - 1) < 1e-9)
  assert.ok(cosine(docs[0], docs[1], idf) >= 0.86, `near-dup sim=${cosine(docs[0], docs[1], idf)}`)
  assert.ok(cosine(docs[0], docs[2], idf) < 0.3)
})

test('pairReasons：字面重复 / 相近 / 覆盖（引用指认与线索词）/ 冲突', () => {
  const mk = (text) => parseMemoryText(text, { file: 'MEMORY.md', track: 'memory' })[0]
  // 字面重复
  const dup1 = mk('[2026-09-09] 广播想唤醒 idle 会话必须带 wake:true，否则只投递不唤醒')
  const dup2 = mk('[2026-09-10] 广播想唤醒 idle 会话必须带 wake:true，否则只投递不唤醒')
  assert.deepEqual(pairOf(dup1, dup2), ['duplicate'])
  // 相近：同主体 + 增量细节，相似度落在 (0.42, 0.86)
  const base = 'skill_manage create 走待确认队列，采纳时整目录 rename 进技能库'
  const sim1 = mk(`[2026-09-05] ${base}`)
  const sim2 = mk(`[2026-09-07] ${base}，另有构建产物需要手动触发`)
  assert.deepEqual(pairOf(sim1, sim2), ['similar'])
  // 低于门槛的弱相关对：不给任何理由（0.24 实测）
  const far1 = mk('[2026-09-05] guji 评测冒烟纪律：全量跑之前先用 --limit 3-5 题小样本冒烟，输出非空再继续，冒烟输出带 SMOKE 标记')
  const far2 = mk('[2026-09-07] guji 评测冒烟纪律补充：换嵌入模型或换向量目录后，必须 --limit 小样本冒烟核对 stderr 再全量跑，避免无效数字')
  assert.deepEqual(pairOf(far1, far2), [])
  // 覆盖更新：引用指认（引用了旧条目原文，即使相似度低也能命中）；
  // 引用片段抬高相似度，理由会复合（similar + supersede + conflict 并存属正常）
  const old1 = mk('[2026-08-01] wego 工具在沙箱内不可用，必须手动下载二进制')
  const new1 = mk('[2026-09-10] 修订既有记忆「wego 工具在沙箱内不可用，必须手动下载二进制」：新版已修复，实测可用')
  assert.ok(pairOf(old1, new1).includes('supersede'))
  assert.equal(quotedRefersTo(new1.body, old1.body), true)
  // 覆盖更新：线索词 + 高相似（无引用；similar 也会并存，supersede 优先级更高）
  const old2 = mk('[2026-09-01] 每日待办截止时间为当天 23:59，过期后从默认列表隐藏')
  const new2 = mk('[2026-09-09] 每日待办截止时间为当天 23:59，过期后从默认列表隐藏，以此说法为准')
  assert.ok(pairOf(old2, new2).includes('supersede'))
  // 冲突：否定侧 vs 肯定侧、主题相近（实测 0.396 ≥ 0.3 门槛）
  const con1 = mk('[2026-09-01] wxauto UIA 方案在微信 4.1 沙箱内不可用，控件树读数全空')
  const con2 = mk('[2026-09-08] wxauto UIA 方案在新版微信实测可用，控件树读数正常')
  assert.deepEqual(pairOf(con1, con2), ['conflict'])
})

function pairOf(a, b) {
  const docs = [a, b].map((e) => entryTerms(e.body))
  const sim = cosine(docs[0], docs[1], computeIdf(docs))
  return pairReasons(a, b, sim, { threshold: 0.42 })
}

test('clusterEntries：传递性聚簇、hint 优先级、protected 标记', () => {
  const X = 'skill_manage create 走待确认队列，采纳时整目录 rename 进技能库'
  const tail = '除此之外 nightly 构建产物需要手动触发流水线，与技能库无关'
  const entries = entriesOf(
    [
      `[2026-09-01] ${X}`,
      `[2026-09-02] ${X}`,
      `[2026-09-03] ${X}，另记：${tail}`,
      `[2026-09-04] 待用户拍板：手册定稿纪律条目是否归档 ${X}`,
    ],
    { file: 'MEMORY.md', track: 'memory' },
  )
  const clusters = clusterEntries(entries, { threshold: 0.42 })
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].members.length, 4)
  // hint 取优先级最高理由（dup+similar 并存 → duplicate）
  assert.equal(clusters[0].hint, 'duplicate')
  assert.equal(clusters[0].members[3].protected, true)
  // 门槛提高 → 相近对散簇，但字面重复对仍在
  const strict = clusterEntries(entries.slice(0, 3), { threshold: 0.95 })
  assert.equal(strict.length, 1)
  assert.equal(strict[0].members.length, 2)
  assert.equal(strict[0].hint, 'duplicate')
})

test('clusterEntries：无关条目不产生簇', () => {
  const clusters = clusterEntries(entriesOf([
    '[2026-09-01] 前端 vite 构建产物部署到静态托管',
    '[2026-09-02] 古籍 FTS 连文查证对简繁标点敏感',
    '[2026-09-03] 微信抓屏要用 windows-capture 按句柄精确捕获',
  ]), { threshold: 0.42 })
  assert.equal(clusters.length, 0)
})

test('scanDir：全局 + 项目轨进合并对象，归档仅作上下文，daily/待办排除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memscan-'))
  try {
    writeFileSync(join(dir, 'MEMORY.md'), `[2026-09-01] 全局甲条目内容\n§\n[2026-09-02] vite 构建产物部署到静态托管即可\n`)
    writeFileSync(join(dir, 'USER.md'), '[2026-09-01] 用户规则甲条目\n')
    writeFileSync(join(dir, 'MEMORY-archive.md'), '[2026-08-01] 已归档的旧条目\n')
    mkdirSync(join(dir, 'projects', 'abc123'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'abc123', 'KEY.md'), '[2026-09-03] 项目 key 条目\n')
    writeFileSync(join(dir, 'projects', 'abc123', 'MEMORY.md'), '[2026-09-03] 项目日志条目\n')
    mkdirSync(join(dir, 'daily'))
    writeFileSync(join(dir, 'daily', '2026-09-10.md'), '[08:30] 每日日志不扫描\n')
    writeFileSync(join(dir, 'TODOS-work.md'), '- [ ] 待办不扫描\n')
    const scanned = scanDir(dir)
    assert.equal(scanned.entries.length, 5)
    assert.equal(scanned.archivedEntries.length, 1)
    assert.equal(scanned.filesScanned.length, 5)
    const tracks = new Set(scanned.entries.map((e) => e.track))
    assert.deepEqual([...tracks].sort(), ['key', 'memory', 'project-log', 'user'])
    assert.equal(scanned.entries.find((e) => e.track === 'key').project, 'abc123')
    // 跨轨重复也能成簇（全局与项目 key 各一条同文）
    writeFileSync(join(dir, 'projects', 'abc123', 'KEY.md'), '[2026-09-03] 全局甲条目内容\n')
    const rescanned = scanDir(dir)
    const cross = clusterEntries(rescanned.entries, { threshold: 0.42 })
    assert.equal(cross.length, 1)
    assert.deepEqual(cross[0].members.map((m) => m.track).sort(), ['key', 'memory'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main CLI：报告落盘、统计正确；参数错误与目录错误有明确退出码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memcli-'))
  const out = join(dir, 'report.json')
  try {
    const text = '[2026-09-01] 重复条目用于 CLI 冒烟\n§\n[2026-09-02] 重复条目用于 CLI 冒烟\n'
    writeFileSync(join(dir, 'MEMORY.md'), text)
    assert.equal(main(['--dir', dir, '--out', out]), 0)
    const report = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(report.stats.entries, 2)
    assert.equal(report.stats.clusters, 1)
    assert.equal(report.clusters[0].hint, 'duplicate')
    assert.ok(report.generatedAt)
    // 参数错误 → 2
    assert.equal(main(['--nope']), 2)
    assert.equal(main(['--threshold', '7']), 2)
    // 目录不存在 → 3
    assert.equal(main(['--dir', join(dir, 'missing')]), 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseArgs：合法参数、缺省值与非法输入', () => {
  assert.deepEqual(parseArgs([]), { dir: null, out: null, threshold: 0.42 })
  assert.deepEqual(parseArgs(['--dir', 'd', '--out', 'o', '--threshold', '0.6']),
    { dir: 'd', out: 'o', threshold: 0.6 })
  assert.throws(() => parseArgs(['--bogus']))
  assert.throws(() => parseArgs(['--threshold', 'abc']))
  assert.throws(() => parseArgs(['--threshold', '1.5']))
})

test('工具函数：normText / diceBigrams 基本行为', () => {
  assert.equal(normText('Hello, 世界！ [2026-09-01] '), 'hello世界20260901')
  assert.ok(diceBigrams('记忆合并梳理标准', '记忆合并梳理标准全文') > 0.8)
  assert.equal(diceBigrams('完全不同', 'xyz'), 0)
  assert.equal(ENTRY_DELIMITER, '\n§\n')
  assert.ok(!existsSync(join(tmpdir(), 'memscan-nonexistent')))
})

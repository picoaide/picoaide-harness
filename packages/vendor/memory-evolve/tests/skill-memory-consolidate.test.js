import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENTRY_DELIMITER, clusterEntries, computeIdf, cosine, diceBigrams, entryTerms,
  fnv1a32, main, normText, pairReasons, parseArgs, parseMemoryText, quotedRefersTo, scanDir, stripHeaderComment,
} from '../skills/memory-consolidate/scripts/scan_memory.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
  // TQ-10（2026-09-17 审计）：原先此处是
  // `assert.ok(!existsSync(join(tmpdir(), 'memscan-nonexistent')))` —— 仓库里
  // 没有任何代码会创建该路径，恒真、测不到任何行为，已删除（"扫描不产生杂散
  // 目录"若真要钉，应由 main CLI 用例按真实产物断言）。这里补 normText 的
  // 幂等性，让本用例名（normText/diceBigrams）对应的覆盖是真的。
  const once = normText('Hello, 世界！ [2026-09-01] ')
  assert.equal(normText(once), once, 'normText 必须幂等（二次归一不再变化）')
})

test('SKILL.md 步骤 5：备份推送只提示用户在「记忆同步」Tab 手动操作，不得留不可执行的 curl', () => {
  // S13-4（2026-09-17 审计）：这一节原先给的是一条 curl（写死 127.0.0.1:3080、
  // 不带 Origin 头）。它在产品里**必然失败**：所有 /memory-evolve 写路由都过同源
  // 守卫（lib/http-guard.js 要求非 GET 带同源 Origin），桌面产品的 Web 端口由
  // 运行时分配（packages/host/desktop/src/profile.ts 的 DEFAULT_DESKTOP_PORT=0），
  // 而且它与「记忆同步无 AI 侧入口，AI 不参与同步执行」的既有决策冲突（lib/sync/
  // index.js:355-359）。文档契约：这一节只能给出用户手动路径，不能把确定性失败
  // 写成「待下次自动备份」。
  const skill = readFileSync(join(PKG_ROOT, 'skills', 'memory-consolidate', 'SKILL.md'), 'utf8')
  const start = skill.indexOf('### 步骤 5')
  const end = skill.indexOf('## 四、何时运行')
  assert.ok(start >= 0 && end > start, '技能必须仍有「步骤 5」与「四、何时运行」两节')
  const step5 = skill.slice(start, end)
  assert.doesNotMatch(step5, /curl\s+-X\s+POST/, '不得再给模型一条必然 400 的 curl 命令')
  assert.doesNotMatch(step5, /127\.0\.0\.1:3080/, '不得写死开发机的 dsh web 端口（桌面端口是运行时分配的）')
  assert.doesNotMatch(step5, /待下次自动备份/, '不得把确定性失败写成"待自动备份"（并没有自动备份兜底）')
  assert.match(step5, /「记忆同步」Tab/, '必须给出真实存在的入口：记忆同步 Tab')
  assert.match(step5, /「共享记忆库」/, '未启用共享记忆库时还要给出启用路径')
  assert.match(step5, /「推送」/, '必须点名用户要点的按钮：推送')
  assert.match(step5, /用户/, '必须写明这一步只能由用户触发')
  assert.match(step5, /不参与同步执行|AI 不执行同步/, '必须与「AI 不参与同步执行」的决策一致')
})

test('SKILL.md 头部：就地记录「提升 x-version 会整目录覆盖本地改动」的维护者提示', () => {
  // S13-4 复核（2026-09-17）：x-version 1→2 让 v2.7.5-beta.2..beta.5 的已装机器
  // 在下次启动时整目录重同步该技能，本地改动被覆盖——这是内置技能同步的既定
  // 语义（要保持"正文改动能送达用户"就必须提升版本号），不是要改掉的行为。
  // 缺口只在**可发现性**：改这个文件的人（下一轮提 x-version 的人）必须看得到。
  // 所以断言这条提示在 SKILL.md 里（放在 frontmatter 紧邻的说明行，与 x-version
  // 同一屏）。删掉提示 → 本用例红。
  const skill = readFileSync(join(PKG_ROOT, 'skills', 'memory-consolidate', 'SKILL.md'), 'utf8')
  const frontmatterEnd = skill.indexOf('\n---\n')
  assert.ok(frontmatterEnd > 0, 'SKILL.md 必须有 frontmatter')
  const header = skill.slice(frontmatterEnd, skill.indexOf('# 记忆合并梳理'))
  assert.match(header, /x-version/, '提示必须点名触发条件：frontmatter 的 x-version')
  assert.match(header, /整目录替换|整目录覆盖/, '必须说明后果是整目录替换/覆盖')
  assert.match(header, /本地改动|自加文件/, '必须说明被覆盖的是本地改动/自加文件')
  assert.match(header, /skills-sync\.js/, '必须指向真正的实现（lib/coi/skills-sync.js）')
})

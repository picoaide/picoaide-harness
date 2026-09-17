/**
 * 客户端硬编码中文的**覆盖守卫**（2026-09-16 i18n 收敛）。
 *
 * 背景：随包客户端里大量用户可见文案此前绕过 `t()` 直接写中文（画板 103 处、
 * 会话评审面板 103 处、CoIView/PromptView 各一份私有字典……）。这一轮把它们
 * 全部并进 `src/client/index.ts` 的 zh/en 注册字典（键前缀 canvas./advisor./
 * coi./prompt./mermaid./version./mobile.）。
 *
 * 本文件钉两件事，防"改回去"：
 *   1. 已迁移文件里**不得再出现代码态中文**（注释不算；白名单只放已核实的
 *      非文案用法：搜索匹配词表 / 过滤哨兵 / mermaid 括号转写表）；
 *   2. 明确**不该翻译**的解析/匹配模式必须原样保留（双语解析、上游 tab 文案
 *      匹配）—— 它们长得像"漏翻"，实际翻了就会坏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_ROOT = join(PACKAGE_ROOT, 'src', 'client')
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u

/**
 * 去过注释的代码：块注释整段删；`//` 注释删到行尾（空白后的 `//` 才算注释
 * 起点 —— 这样 `'https://…'` 这类字符串不会被误删）。
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/[^\n]*/u, '$1'))
    .join('\n')
}

/** 本轮迁移的文件 → 该文件里允许保留的中文行（已核实的非文案用法）。 */
const MIGRATED = {
  'canvas-grok/CanvasView.tsx': [],
  'canvas-grok/CanvasBoard.tsx': [],
  'canvas-grok/CanvasCard.tsx': [],
  'canvas-grok/CanvasDialogs.tsx': [],
  'canvas-grok/constants.ts': [
    // 搜索匹配词表：中文/英文别名同时收录，与界面语言无关（翻了就搜不到）
    /^\s+(folder|markdown|plainText|image|media|file): \[/u,
  ],
  'canvas-grok/helpers.ts': [],
  'canvas-grok/api-client.ts': [],
  'canvas-grok/index.ts': [],
  'canvas-grok/store.ts': [],
  'advisor/AdvisorPanel.tsx': [],
  'advisor/advisor-store.ts': [],
  'CoIView.tsx': [],
  'PromptView.tsx': [
    // 「全部 / 未分类」是内部过滤哨兵（状态值 + 分支比较），显示另有字典键
    /'全部'/u,
    /'未分类'/u,
    // 排序 locale 参数，不是文案
    /localeCompare\([^)]*'zh'\)/u,
    // 标签分隔符：半角/全角逗号都算分隔（解析用）
    /split\(/u,
  ],
  'mobile-input-sheet.ts': [],
  'mermaid-render.ts': [
    // mermaid 语法自动修正：把半角括号转写成全角（解析用，不展示）
    /'\\uff08'|'\\uff09'/u,
    // subgraph 标题的「雷区标点」探测字符类（解析用，不是文案）
    /test\(title\)/u,
  ],
  'VersionTabView.tsx': [],
}

test('迁移后的客户端文件：代码态不得再出现硬编码中文', () => {
  const offenders = []
  for (const [relative, allowed] of Object.entries(MIGRATED)) {
    const code = codeOnly(readFileSync(join(CLIENT_ROOT, relative), 'utf8'))
    for (const [index, line] of code.split('\n').entries()) {
      if (!CJK.test(line)) continue
      if (allowed.some((pattern) => pattern.test(line))) continue
      offenders.push(`${relative}:${index + 1}: ${line.trim().slice(0, 100)}`)
    }
  }
  assert.deepEqual(
    offenders, [],
    `以下硬编码中文必须走字典（t('...')），或加入白名单并说明为何不是文案：\n${offenders.join('\n')}`,
  )
})

test('动态模板键的字典族必须存在（scope.${s} 这类漏改会被抓住）', () => {
  const dictionarySource = readFileSync(join(CLIENT_ROOT, 'index.ts'), 'utf8')
  const keys = new Set([...dictionarySource.matchAll(/'([A-Za-z][\w.]*)':/gu)].map((match) => match[1]))
  const offenders = []
  for (const relative of Object.keys(MIGRATED)) {
    const code = codeOnly(readFileSync(join(CLIENT_ROOT, relative), 'utf8'))
    for (const match of code.matchAll(/t\(`([A-Za-z][\w.]*)\.\$\{/gu)) {
      const family = match[1]
      if (![...keys].some((key) => key.startsWith(`${family}.`))) {
        offenders.push(`${relative}: t(\`${family}.\${...}\`) has no dictionary family`)
      }
    }
  }
  assert.deepEqual(offenders, [], `动态模板键缺少字典族（会渲染出原始键名）：\n${offenders.join('\n')}`)
})

test('非文案的解析/匹配模式必须保留（翻了就会坏）', () => {
  // TQ-2（2026-09-17 审计）：原来这些断言 grep 的是**含注释的原始源码**，而
  // 「在新对话中分支」「主题」「发送人」「对话」等字面量同时活在模块头部注释里
  // —— 把 BRANCH_PATTERNS 清成 `[]`（整个分支接管失效）、把解析正则删掉，断言
  // 照样绿（变异实测 GREEN）。现在一律先剥注释，并且不再找"某个词在不在文件里"，
  // 而是钉住承载行为的**数据结构/匹配表达式本身**。
  const bell = codeOnly(readFileSync(join(CLIENT_ROOT, 'notification-bell.tsx'), 'utf8'))
  const mailField = /const MAIL_FIELD_RE = (\/.*\/[a-z]*)/u.exec(bell)
  assert.ok(mailField !== null, '邮件正文解析必须仍有 MAIL_FIELD_RE（删掉＝邮件式正文不再结构化）')
  for (const needle of ['主题', '发送人', 'Subject', 'Sender']) {
    assert.ok(
      mailField[1].includes(needle),
      `MAIL_FIELD_RE 必须同时认「${needle}」（中英双语解析，翻了就解析不出字段）`,
    )
  }
  // 分支注入器：BRANCH_PATTERNS 的**成员**与**消费点**都要在（空数组＝按钮认不出）
  const bookmark = codeOnly(readFileSync(join(CLIENT_ROOT, 'bookmark-injector.tsx'), 'utf8'))
  const branchPatterns = /const BRANCH_PATTERNS = \[([^\]]*)\]/u.exec(bookmark)
  assert.ok(branchPatterns !== null, '必须仍有 BRANCH_PATTERNS（分支接管的承重件）')
  assert.deepEqual(
    [...branchPatterns[1].matchAll(/'([^']*)'/gu)].map((match) => match[1]),
    ['在新对话中分支', 'Branch into a new conversation'],
    'BRANCH_PATTERNS 必须原样保留上游 zh/en 菜单文本（清空＝分支按钮再也认不出）',
  )
  assert.match(bookmark, /BRANCH_PATTERNS\.some\(/u, 'BRANCH_PATTERNS 必须真的被 isBranchButton 消费')
  // 书签视图：上游 tab 文案匹配（比较表达式本身，不是注释里的词）
  const bookmarks = codeOnly(readFileSync(join(CLIENT_ROOT, 'BookmarksView.tsx'), 'utf8'))
  for (const needle of [
    "text === '对话'",
    "text === 'Chat'",
    "text.includes('更早')",
    "text.includes('加载历史')",
    "text.includes('Load earlier')",
  ]) {
    assert.ok(bookmarks.includes(needle), `上游 tab 文案匹配必须保留：${needle}`)
  }
  assert.doesNotMatch(bell, /t\('.*主题/u, '解析模式不得改成走字典')
})

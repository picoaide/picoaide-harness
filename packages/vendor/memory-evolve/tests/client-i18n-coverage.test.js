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
  // 通知铃铛：解析邮件头，必须同时认中文与英文标签
  const bell = readFileSync(join(CLIENT_ROOT, 'notification-bell.tsx'), 'utf8')
  assert.ok(bell.includes('主题') && bell.includes('Subject'), '邮件头解析必须双语兼容')
  assert.ok(bell.includes('发送人') && bell.includes('Sender'), '邮件头解析必须双语兼容')
  // 分支注入器：识别上游「在新对话中分支」菜单项
  const bookmark = readFileSync(join(CLIENT_ROOT, 'bookmark-injector.tsx'), 'utf8')
  assert.ok(bookmark.includes('在新对话中分支'), 'BRANCH_PATTERNS 必须保留上游中文菜单文本')
  // 书签视图：匹配上游 tab 文案（对话 / 更早 / 加载历史）
  const bookmarks = readFileSync(join(CLIENT_ROOT, 'BookmarksView.tsx'), 'utf8')
  for (const needle of ['对话', '更早', '加载历史']) {
    assert.ok(bookmarks.includes(needle), `上游 tab 文案匹配必须保留「${needle}」`)
  }
  const bellSource = codeOnly(bell)
  assert.doesNotMatch(bellSource, /t\('.*主题/u, '解析模式不得改成走字典')
})

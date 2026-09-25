/**
 * 文案与实现一致性的**源码级判据**（R19B-04 / R19B-10，审计 2026-09-25）。
 *
 * 两条缺陷形态（都是"页面上的字与代码里的行为相反"，用户会把一次真实故障指向错误病因）：
 *  ① 六个位置仍写「未定价模型费用按 0 计」，而实现早已是**缺省拒绝**（429 `MODEL_NOT_PRICED`）；
 *     其中一处就在**新增模型**对话框里 —— 管理员留空价格时看到的说明与实际后果相反；
 *  ② webadmin 的 JSX **文本节点**里残留 Markdown 粗体星号（`**拒绝**`），React 原样渲染，
 *     屏幕上就是两个星号。
 *
 * 判据只有"排除注释后的源码里不得出现这些串"这一条 —— 它不是存在性断言，而是**反向守卫**：
 * 任何一次把旧口径写回去、或新写一段带星号的文案，都会在这里红。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
/** webadmin 根（src/pages → ../..）。 */
const webadminRoot = resolve(here, '..', '..')
/** 仓库根（server/webadmin → ../..）。 */
const repoRoot = resolve(webadminRoot, '..', '..')

/** 去掉块注释与行注释，只留"会参与渲染/求值的代码"（注释里出现这些词是合法的）。 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

const pages = [
  'src/pages/Gateway.tsx',
  'src/pages/usage/Models.tsx',
  'src/pages/usage/Overview.tsx',
  'src/pages/usage/Reports.tsx',
]

describe('webadmin 文案与实现一致', () => {
  it('不再写「未定价模型费用按 0 计」（实现是缺省 429 MODEL_NOT_PRICED）', () => {
    // 旧口径的几种写法（含中英文与空格变体）。
    const stale = [/未定价模型费用按 0 计/, /其费用按 0 计/, /未定价模型计 0/, /未定价模型[^。]{0,10}按 0 记/]
    const hits: string[] = []
    for (const rel of pages) {
      const code = codeOnly(readFileSync(resolve(webadminRoot, rel), 'utf8'))
      for (const re of stale) {
        if (re.test(code)) hits.push(`${rel}: ${re}`)
      }
    }
    expect(hits, `这些位置仍在写「按 0 计」的旧口径：${hits.join(', ')}`).toEqual([])
  })

  it('网关页把「未定价模型策略」的实际后果写清楚（含 allow 的作用范围）', () => {
    const code = codeOnly(readFileSync(resolve(webadminRoot, 'src/pages/Gateway.tsx'), 'utf8'))
    expect(code).toContain('MODEL_NOT_PRICED')
    expect(code).toContain('允许使用')
    // allow 是全局开关这件事必须写在界面上（R19A-S1-04 的判定：保留语义 + 披露）。
    expect(code).toContain('全局')
  })

  it('JSX 文本节点里不残留 Markdown 星号', () => {
    const hits: string[] = []
    for (const rel of pages) {
      const code = codeOnly(readFileSync(resolve(webadminRoot, rel), 'utf8'))
      code.split('\n').forEach((line, i) => {
        // 只查"看起来是文案"的行：含中文且含 **。
        if (/\*\*/.test(line) && /[\u4e00-\u9fa5]/.test(line)) {
          hits.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(hits, `这些行会在页面上原样显示星号：\n${hits.join('\n')}`).toEqual([])
  })

  it('公开站文档同样不得再写「未定价模型…按 0 计」', () => {
    const docs = [
      'site/src/content/docs/admin.md',
      'site/src/content/docs/en/admin.md',
    ]
    const hits: string[] = []
    for (const rel of docs) {
      const raw = readFileSync(resolve(repoRoot, rel), 'utf8')
      if (/未定价模型费用按 0 计/.test(raw) || /unpriced models are charged as 0/.test(raw)) {
        hits.push(rel)
      }
      if (!/MODEL_NOT_PRICED/.test(raw)) {
        hits.push(`${rel}: 没有提到 429 MODEL_NOT_PRICED（口径与实现不一致）`)
      }
    }
    expect(hits, `公开站口径未同步：${hits.join(', ')}`).toEqual([])
  })

  it('公开站错误码表含 MODEL_NOT_PRICED，且 BALANCE_EXHAUSTED 写明三种成因', () => {
    const raw = readFileSync(resolve(repoRoot, 'site/src/content/docs/api-reference.md'), 'utf8')
    expect(raw).toContain('MODEL_NOT_PRICED')
    const row = raw.split('\n').find((l) => l.includes('`BALANCE_EXHAUSTED`'))
    expect(row, '错误码表里找不到 BALANCE_EXHAUSTED 行').toBeTruthy()
    // 修前只写"余额 ≤ 0"，而实现还有"学到的下限"与"最小计费额"两种成因（余额 > 0 也会拒）。
    expect(row).toContain('学到的下限')
    expect(row).toContain('最小计费额')
  })
})

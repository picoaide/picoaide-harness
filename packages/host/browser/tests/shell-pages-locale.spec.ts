/**
 * i18n regression: the injected browser chrome must be served in the host
 * locale, per REQUEST.
 *
 * Two layers, because either alone is a false green:
 *
 *  1. RENDERING — `browserShellHtml(locale)` / `browserOverlayHtml(locale)`
 *     carry the full English copy and drop the Chinese markers (and the other
 *     way round for zh), including the copy the inline script uses at runtime
 *     (the `COPY` table embedded in the page, which is what the toolbar, the
 *     activity timeline, the ⋮ menu and the viewers actually render).
 *  2. RESOLUTION — the real `apply()` + the real `/browser-shell` and
 *     `/browser-overlay` handlers. The locale is resolved when the request is
 *     served, NOT when the plugin is applied: the same plugin instance must
 *     answer `zh` before and `en` after the probed `desktopRuntime.locale`
 *     changes (the frozen-module-constant bug class documented in
 *     `packages/host/connectors/src/client/status-label.ts`).
 *
 * Precedence is pinned too: the in-app runtime choice beats `Accept-Language`,
 * and `Accept-Language` is what a host without `desktopRuntime` falls back to.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserOverlayHtml, browserShellHtml, emptyHtml } from '../src/shell-pages.ts'
import { apply } from '../src/index.ts'
import { scanModelSource } from './helpers/model-source-scan.ts'
import {
  judgeModelSurfaceAnchors,
  MODEL_SURFACE_ANCHORS,
  MODEL_SURFACE_ANCHOR_FLOOR,
  REQUIRED_MODEL_SURFACE_ANCHOR_IDS,
  witnessedModelSurfaceAnchors,
  witnessModelSurfaceAnchor,
} from './helpers/model-source-anchors.ts'

/**
 * Han characters + CJK punctuation. Full-width forms (`＋`, U+FF0B) are NOT
 * included on purpose: `＋` is the toolbar glyph the empty state points at, and
 * it is the same button in both locales.
 */
const HAN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff]/u

/**
 * Strip what is NOT rendered copy: HTML comments, CSS block comments and JS line
 * comments.
 *
 * 2026-09-17: rewritten from regex `.replace()` calls to小 scanners. CodeQL
 * `js/incomplete-multi-character-sanitization` correctly points out that
 * `replace(/<!--…-->/, '')` can be bypassed by nested/malformed markers; this
 * helper is not a security boundary, but the scanner form states the boundary
 * explicitly.
 *
 * Unterminated block ⇒ **throw** (独立复核 2026-09-17：此前是"其后全部视为块内"，
 * 结果是畸形输入会让断言**少扫一段却仍然通过** —— 判别力静默变松。测试助手遇到
 * 未闭合的标记应当响亮地失败，而不是安静地缩小扫描面)。
 */

/** Drop an open/close delimited block (same semantics for `<!-- -->` and `/* *​/`). */
function stripBlock(text: string, open: string, close: string): string {
  let out = ''
  let rest = text
  for (;;) {
    const start = rest.indexOf(open)
    if (start < 0) return out + rest
    out += rest.slice(0, start)
    const end = rest.indexOf(close, start + open.length)
    if (end < 0) throw new Error(`stripBlock: unterminated ${open} — the assertion would silently skip the rest`)
    rest = rest.slice(end + close.length)
  }
}

/**
 * Drop `//` line comments — but only when the `//` starts the line or follows
 * whitespace, so `https://…` inside a literal is never truncated (this mirrors
 * the old `(^|\s)\/\/` behaviour exactly).
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length - 1; i += 1) {
        const prev = i === 0 ? '' : line[i - 1]!
        if (line[i] === '/' && line[i + 1] === '/' && (i === 0 || /\s/u.test(prev))) return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

function renderedSurface(page: string): string {
  return stripLineComments(stripBlock(stripBlock(page, '<!--', '-->'), '/*', '*/'))
}

/** Every marker must be absent from the RENDERED copy (comments are not copy). */
function expectAbsent(page: string, markers: readonly string[]): void {
  const surface = renderedSurface(page)
  for (const marker of markers) expect(surface, marker).not.toContain(marker)
}

/** The `const COPY = {…}` table the page's inline script reads at runtime. */
function pageCopy(page: string): Record<string, unknown> {
  const match = /const COPY = (\{.*\})\n/u.exec(page)
  if (match?.[1] === undefined) throw new Error('the page embeds no COPY table')
  // JSON.parse also proves the embed is valid JS/JSON after the `<` escaping.
  return JSON.parse(match[1]) as Record<string, unknown>
}

const SHELL_ZH_MARKERS = [
  '<title>AI 浏览器</title>',
  'title="新建标签页 (Ctrl+T)"',
  'title="后退 (Alt+←)"',
  'title="前进 (Alt+→)"',
  'title="刷新 (Ctrl+R)"',
  'title="收藏到书签"',
  'title="更多"',
  'aria-label="地址栏"',
  'placeholder="输入网址，回车访问（例如 https://example.com）"',
  '打开浏览器，AI 会在需要时自动打开网页。',
  'aria-label="标签页"',
  '关闭标签',
]

const SHELL_EN_MARKERS = [
  '<title>AI Browser</title>',
  'title="New tab (Ctrl+T)"',
  'title="Back (Alt+←)"',
  'title="Forward (Alt+→)"',
  'title="Reload (Ctrl+R)"',
  'title="Bookmark this page"',
  'title="More"',
  'aria-label="Address bar"',
  'placeholder="Enter a URL and press Enter (for example https://example.com)"',
  'Open the browser: the AI opens pages here automatically when it needs to.',
  'aria-label="Tabs"',
  'Close tab',
]

const OVERLAY_ZH_MARKERS = [
  'title="点击查看 AI 活动"',
  'id="ai-take">我来操作<',
  'id="pill-take" type="button">我来操作<',
  '<h2>AI 活动 <',
  '>隐藏窗口<',
  'placeholder="搜索…"',
  '清除数据…',
  '清除全部浏览数据（含登录状态）？',
  '正在接管…',
  '正在交还…',
  '暂无操作记录',
  '加载失败，请重试',
  '"browser_screenshot":"截图"',
  '"menuHistory":"浏览历史"',
]

const OVERLAY_EN_MARKERS = [
  'title="Click to view AI activity"',
  'id="ai-take">Take over<',
  'id="pill-take" type="button">Take over<',
  '<h2>AI activity <',
  '>Hide window<',
  'placeholder="Search…"',
  'Clear browsing data…',
  'Clear all browsing data (including sign-in state)?',
  'Taking over…',
  'Handing back…',
  'No activity yet',
  'Failed to load, please retry',
  '"browser_screenshot":"Screenshot"',
  '"menuHistory":"History"',
]

describe('injected chrome copy is per locale', () => {
  it('the shell page renders the English toolbar and no Chinese marker', () => {
    const page = browserShellHtml('en')
    expect(page.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true)
    for (const marker of SHELL_EN_MARKERS) expect(page, marker).toContain(marker)
    expectAbsent(page, SHELL_ZH_MARKERS)
    // Nothing user-visible is left in Chinese: comments (HTML/CSS/JS) are not copy.
    expect(renderedSurface(page).match(HAN)).toBeNull()
  })

  it('the shell page renders the Chinese toolbar and no English marker', () => {
    const page = browserShellHtml('zh')
    expect(page.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')).toBe(true)
    for (const marker of SHELL_ZH_MARKERS) expect(page, marker).toContain(marker)
    expectAbsent(page, SHELL_EN_MARKERS)
  })

  it('the overlay page renders the English control/panel/menu/viewer copy', () => {
    const page = browserOverlayHtml('en')
    expect(page.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true)
    for (const marker of OVERLAY_EN_MARKERS) expect(page, marker).toContain(marker)
    expectAbsent(page, OVERLAY_ZH_MARKERS)
    expect(renderedSurface(page).match(HAN)).toBeNull()
  })

  it('the overlay page renders the Chinese control/panel/menu/viewer copy', () => {
    const page = browserOverlayHtml('zh')
    expect(page.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')).toBe(true)
    for (const marker of OVERLAY_ZH_MARKERS) expect(page, marker).toContain(marker)
    expectAbsent(page, OVERLAY_EN_MARKERS)
  })

  it('the inline-script copy table (what the timeline/menu render) follows the locale', () => {
    const zh = pageCopy(browserOverlayHtml('zh'))
    const en = pageCopy(browserOverlayHtml('en'))
    expect(zh.takeOver).toBe('我来操作')
    expect(zh.handBack).toBe('交给 AI')
    expect(en.takeOver).toBe('Take over')
    expect(en.handBack).toBe('Hand back to AI')
    expect((zh.toolLabels as Record<string, string>).browser_click).toBe('点击')
    expect((en.toolLabels as Record<string, string>).browser_click).toBe('Click')
    // 2026-09-21（壳层缺陷 #5a）：宿主自己记的 op id（不是模型工具）也必须在表里。
    // 少一个，labelOf 就会把裸 id 抛到活动面板上；两边一起钉住，防止只补一种语言
    // （en 表整体还受下面 "no HAN" 断言约束）。
    for (const id of ['browser_window_open', 'browser_download_open', 'navigate']) {
      expect((zh.toolLabels as Record<string, string>)[id], `zh ${id}`).toBeTruthy()
      expect((en.toolLabels as Record<string, string>)[id], `en ${id}`).toBeTruthy()
    }
    // Every dynamic string must be locale-consistent: no zh value survives in
    // the English table (this is the table the page reads, not the markup).
    expect(JSON.stringify(en).match(HAN)).toBeNull()
    expect(zh.aiBusyPrefix).toBe('AI 正在操作 · ')
    expect(en.aiBusyPrefix).toBe('AI is working · ')
    expect(en.timeLocale).toBe('en-US')
    // Both pages embed the SAME failure mapper copy (a page missing a field
    // renders `undefined…` in its toast — that regression happened once here).
    const shellZh = pageCopy(browserShellHtml('zh'))
    const shellEn = pageCopy(browserShellHtml('en'))
    for (const table of [zh, shellZh]) {
      expect(table.failCredentials).toBe('操作失败：浏览器会话凭据尚未就绪，请重试')
      expect(table.failPrefix).toBe('操作失败：')
    }
    for (const table of [en, shellEn]) {
      expect(String(table.failCredentials)).toContain('Action failed')
      expect(table.failPrefix).toBe('Action failed: ')
    }
    // The empty state is DATA: the renderer escapes each line and adds the
    // `<br/>` itself, so a translation (the one field a translator rewrites)
    // can neither inject markup nor close the surrounding <script>.
    expect(emptyHtml('a</script><script>window.__pwned=1</script><br/>b'))
      .toBe('a&lt;/script&gt;&lt;script&gt;window.__pwned=1&lt;/script&gt;&lt;br/&gt;b')
    expect(emptyHtml('one\ntwo')).toBe('one<br/>two')
    const shell = browserShellHtml('zh')
    // 2026-09-21（壳层缺陷 #2）：文案必须指向**真实可用**的入口。空闲态蒙版铺满
    // 整窗（含工具栏）且 scrim 是 inert ⇒ 右上角 ＋ 根本点不动，旧文案把第一次
    // 使用的用户送进死路；唯一控制权入口是蒙版上的「我来操作」（2026-09-11 定案）。
    expect(shell).toContain('打开浏览器，AI 会在需要时自动打开网页。<br/>点下方的「我来操作」，你也可以自己先逛起来。')
    expect(shell).not.toContain('右上角 ＋')
    // …and the escaping is why the served page has exactly ONE </script> (its own).
    expect(shell.match(/<\/script>/gu)).toHaveLength(1)
    expect(browserOverlayHtml('en').match(/<\/script>/gu)).toHaveLength(1)
  })

  it('keeps the empty-state copy markup-free (the renderer owns the <br/>)', () => {
    // 渲染层断言无法区分"字典里带 <br/>"与"渲染器插 <br/>"（两者产出的 HTML 逐字节
    // 相同），所以 2026-09-16 R2 复核实测：把 C1 完整回退后上一组断言仍然全绿。
    // 这条直接钉字典是数据 —— 文案里出现 `<`/`>` 即红。
    const source = readFileSync(new URL('../src/shell-pages.ts', import.meta.url), 'utf8')
    const values = [...source.matchAll(/\n\s*empty: '((?:[^'\\]|\\.)*)'/gu)].map((match) => match[1]!)
    expect(values).toHaveLength(2)
    for (const value of values) {
      expect(value, value).not.toMatch(/[<>]/u)
      expect(value, value).toContain('\\n')
    }
  })
})

/* ------------------------------------------------------------------ *
 * Model-facing surface: ONE language (English), pinned here
 * ------------------------------------------------------------------ */

/**
 * Tool descriptions and the system-prompt band are registered ONCE at
 * plugin-apply time, so they cannot follow the request locale. Mixing the
 * languages (the pre-i18n state: English bodies with Chinese `[导航]` tags and
 * hard-coded Chinese button names) is the worst of both worlds, and naming a
 * localized control in a fixed language is wrong for one of the two UIs. This
 * guard keeps the chosen policy — English only, controls named by function —
 * from silently drifting back.
 */
describe('model-facing tool copy is single-language (English)', () => {
  const TOOLS_SOURCE = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const GROUP_IDS = ['navigate', 'interact', 'read', 'write', 'memory', 'artifacts', 'control']
  /**
   * **注释感知**扫描（唯一量具，2026-10-04 核验 P13-P1 §8 收口）。
   *
   * 原来这里用两个朴素正则剥注释；那套近似会被"非注释区里的斜杠 + 星号"（字符串里的
   * glob `'src/*'`、更早的 `//` 行注释）骗成块注释起点，把中间的代码整段吞掉 ⇒ 中文
   * 对守卫不可见（假绿，BV4/BV5 实测整个包 1013 例全绿）。现在改用逐字符状态机
   * （见 `tests/helpers/model-source-scan.ts`）：只有**真的在注释里**的字符才会被抹掉。
   */
  const SCAN = scanModelSource(TOOLS_SOURCE)

  it('every tool description carries an English GROUP_OF tag', () => {
    const tags = [...TOOLS_SOURCE.matchAll(/description: '\[([^\]]+)\]/gu)].map((match) => match[1]!)
    expect(tags.length).toBeGreaterThanOrEqual(30)
    const unknown = tags.filter((tag) => !GROUP_IDS.includes(tag))
    expect(unknown, 'tool description tags must be the English group ids').toEqual([])
  })

  it('no CJK survives outside source comments（注释感知扫描；注释里的中文仍然允许）', () => {
    // 判据面 = 非注释区（字符串/模板/正则都算模型面内容）。注释按本仓惯例是中文，
    // 不在判据面内 —— 所以这里**不**用"整文件 grep 中文"那种口径。
    const hits = SCAN.code
      .split('\n')
      .map((text, index) => ({ line: index + 1, text: text.trim() }))
      .filter((entry) => HAN.test(entry.text))
      .map((entry) => `${entry.line}: ${entry.text.slice(0, 90)}`)
    expect(hits, '模型面非注释区不得出现中文（render/description/系统提示词/错误文案）').toEqual([])
  })

  it('扫描面没有被吃掉：非注释区不得出现斜杠+星号或星号+斜杠（含字符串/模板/正则内部）', () => {
    // 这是"近似量具缩面"的结构信号，也是扫描器自己的第二道网：任何它没认出来的注释
    // 形态都会先在这里以字面量暴露。出现即判红，要求作者改写（例如把 glob 写成
    // `src/client 目录`），而不是让守卫悄悄少看一段代码。
    const offenders = SCAN.offenders.map((found) => `${found.line}:${found.column} ${found.text}`)
    expect(offenders, '非注释区里的斜杠+星号 / 星号+斜杠').toEqual([])
    expect(SCAN.unterminated, '未闭合的块注释/字符串/模板（源码不合法）').toBeNull()
  })

  it('扫描面完整性锚点：几处已知的模型面文案必须留在扫描面内（缩水即红）', () => {
    // 正向对照：如果哪天扫描器（或某个新形态）把大段代码吞出扫描面，这几条会先红 ——
    // 比"零中文判绿"这种否定式判据更容易发现"什么都看不见"的失效。
    //
    // 2026-10-05 最终核验 P15-P1 的 G3：这些锚点此前**没有被任何判据钉住** —— 删掉这一整块
    // `it`，本文件照旧 `EXIT=0 / 22 passed`。现在锚点走 `MODEL_SURFACE_ANCHORS` 登记表，
    // 每条判定都经 `witnessModelSurfaceAnchor(...)`（**写在 `expect` 的实参位里**）：
    // 删掉这条断言 ⇒ 见证一起消失 ⇒ 下面那一格具名红；判定为假 ⇒ 见证函数自己抛错。
    for (const judgment of judgeModelSurfaceAnchors(SCAN)) {
      expect(witnessModelSurfaceAnchor(judgment.id, judgment.ok, judgment.detail), judgment.detail).toBe(true)
    }
  })

  it('锚点判据被真的执行过：登记 ↔ 执行见证双向对账 + 地板 + 判定值对拍', () => {
    // 这一格是"锚点必须存在"的判据本体（G3）。它读的是**执行见证**（模块内账本），
    // 不是"文件里出现过某个字符串" —— 所以 `it.skip` / 整块删除 / 掏空 `expect` 都咬得住，
    // 而等价改写（只要仍逐条经 `witnessModelSurfaceAnchor` 判定）保持绿。
    const witnessedEntries = witnessedModelSurfaceAnchors()
    const witnessedIds = witnessedEntries.map((entry) => entry.id)
    const registeredIds = MODEL_SURFACE_ANCHORS.map((anchor) => anchor.id)
    // ① 逐条点名：登记的必需锚点必须都被判过（删整块 / 删一条 / 改名都落在这一条上）。
    const missingRequired = REQUIRED_MODEL_SURFACE_ANCHOR_IDS.filter((id) => !witnessedIds.includes(id))
    expect(missingRequired, '这些锚点没有被执行见证 —— 锚点块被删 / 被 skip / 断言被掏空（G3）').toEqual([])
    // ② 登记表 ↔ 见证 双向对账：判了却没登记（死条目）同样红。
    expect(witnessedIds.filter((id) => !registeredIds.includes(id)), '判了却未登记的锚点').toEqual([])
    expect(registeredIds.filter((id) => !witnessedIds.includes(id)), '登记了却没被判过的锚点').toEqual([])
    // ③ 地板（ratchet：只能变多 —— 删登记项必须先改这里并进 diff）。锚点今天 4 条。
    expect(registeredIds.length, '锚点登记表地板').toBeGreaterThanOrEqual(MODEL_SURFACE_ANCHOR_FLOOR)
    expect(witnessedIds.length, '锚点执行见证地板').toBeGreaterThanOrEqual(MODEL_SURFACE_ANCHOR_FLOOR)
    // ④ 判定值对拍：见证到的 ok 必须等于**现在重新判一遍**的结果。锚点今天全为真，所以这一条
    //    只在"判定函数被掏空 + 锚点真的破了"时咬得住（休眠牙）；把它变成常亮的牙是下面那一格
    //    的形态判据（g3-m5 实测：只写死真值时这一条是绿的）。
    const recomputed = new Map(judgeModelSurfaceAnchors(SCAN).map((judgment) => [judgment.id, judgment.ok]))
    const mismatched = witnessedEntries.filter((entry) => recomputed.get(entry.id) !== entry.ok).map((entry) => entry.id)
    expect(mismatched, '见证到的判定值与重新判定不一致（判定值被写死）').toEqual([])
    // ⑤ 判定函数不许被掏空：对一份"扫描面被吃光"的合成结果，**每一条**锚点都必须判假
    //    （行为判据，不依赖源码文本；`kind: 'absent'` 那类"必须不存在"的锚点以后新增时，
    //    这一格会响亮地要求同步）。
    const brokenScan = { ...SCAN, code: '' }
    expect(judgeModelSurfaceAnchors(brokenScan).every((judgment) => !judgment.ok),
      '把扫描面掏空之后仍有锚点判定为真 ⇒ 判定函数被掏空了').toBe(true)
  })

  it('锚点判定的形态：`witnessModelSurfaceAnchor` 的判定值必须是表达式（不许写死字面量）', () => {
    // 形态判据（**注释感知**，用同一个扫描器先把注释抹掉）：补的是执行见证的盲区 ——
    // 今天所有锚点都为真时，`witnessModelSurfaceAnchor(id, true, …)` 与 `…(id, judgment.ok, …)`
    // 的**运行时**行为完全一样（变异 g3-m5 实测：写死真值只靠运行时见证是绿的）。
    // 两条判据各管一半：见证管"真的执行过"，这一格管"判定值真的来自判定函数"。
    //
    // 咬得住：锚点块整块删掉（块取不到 ⇒ 具名红）、判定值写成 `true`/`false`/数字/字符串字面量、
    //   `witnessModelSurfaceAnchor` 调用整条删掉、块里连 `expect` 都没有、调用形状读不懂。
    // 咬不住：等价的**重写**只要仍把非字面量的判定值交给见证（反向对照 g3-m7 必须绿）；
    //   以及把判定函数本身掏空 —— 那一半由上一格的 ⑤（合成空扫描面）行为判据接住。
    const own = scanModelSource(readFileSync(new URL(import.meta.url), 'utf8')).code
    const start = own.indexOf("it('扫描面完整性锚点")
    const end = own.indexOf("it('锚点判据被真的执行过")
    expect(start >= 0 && end > start,
      '读不到锚点 it 块（形态判据的锚点失效即红，绝不静默放行）').toBe(true)
    const block = own.slice(start, end).replace(/\s+/gu, ' ')
    expect(block.includes('expect('), '锚点块里必须有 expect 断言').toBe(true)
    expect(block.includes('witnessModelSurfaceAnchor('), '锚点块里必须真的调用 witnessModelSurfaceAnchor').toBe(true)
    // 逐调用取第二实参（允许一层括号）。**读不懂即红**：能被 `includes` 看见、却读不出实参的
    // 调用形状同样判红，否则"把字面量包一层括号"就能让这一格失明。
    const calls = [...block.matchAll(/witnessModelSurfaceAnchor\(((?:[^()]|\([^()]*\))*)\)/gu)]
    const occurrences = block.split('witnessModelSurfaceAnchor(').length - 1
    expect(calls.length, `锚点块里有 ${occurrences} 处 witnessModelSurfaceAnchor 调用，`
      + `形态判据只读得出 ${calls.length} 处 ⇒ 读不懂即红`).toBe(occurrences)
    const literalVerdicts = calls
      .map((match) => (match[1] ?? '').split(',')[1]?.trim() ?? '')
      // 归一：剥掉括号与空白，于是 `(true)` / `(( false ))` 与 `true` 同判（"把字面量包一层括号"
      // 不能成为绕过形态）。
      .map((verdict) => verdict.replace(/[()\s]/gu, ''))
      .filter((verdict) => /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")$/u.test(verdict))
    expect(literalVerdicts, 'witnessModelSurfaceAnchor 的判定值被写死成字面量（判定被绕过）').toEqual([])
  })

  /**
   * 扫描器自检（常驻格）：把"能骗过旧近似量具"的形态固化成夹具。
   *
   * 每条都先断言**旧口径**（`naiveStrip`）确实看不见中文 —— 证明夹具真的能制造假绿 ——
   * 再断言新扫描器看得见（CJK 命中或 offender 命中）。没有前半句，夹具可能根本不复现
   * 缺陷；没有后半句，判据可能只是"看起来更严"。
   */
  describe('扫描器自检：幻影块注释同族（BV4/BV5/BV6）', () => {
    /** 仓库守卫 2026-10-04 之前的实现（仅自检用；它已被 SCAN 取代）。 */
    const naiveStrip = (src: string): string => src
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/(^|\s)\/\/[^\n]*/gu, '$1')

    it('BV4：字符串里的斜杠+星号包住中文 render ⇒ 旧口径判绿、新量具看得见', () => {
      const src = [
        "const open = '/*'",
        "const render = () => '点击下面的按钮'",
        "const close = '*/'",
      ].join('\n')
      expect(HAN.test(naiveStrip(src)), '夹具必须能骗过旧量具（否则不复现缺陷）').toBe(false)
      const scan = scanModelSource(src)
      expect(HAN.test(scan.code)).toBe(true)
      expect(scan.offenders.map((found) => found.line)).toEqual([1, 3])
    })

    it('BV5：glob 开头 + 后面一条真实块注释收尾，把中文 description 吞掉', () => {
      const src = [
        "const glob = 'src/*'",
        "const tool = { description: '点击这里' }",
        '/** 文档 */',
        'const tail = 1',
      ].join('\n')
      expect(HAN.test(naiveStrip(src)), '夹具必须能骗过旧量具').toBe(false)
      const scan = scanModelSource(src)
      expect(HAN.test(scan.code)).toBe(true)
      expect(scan.offenders.map((found) => found.line)).toEqual([1])
    })

    it('BV6：字符串里的双斜杠吞掉同一行后面的中文', () => {
      const src = "const note = 'see // note'; const label = '点击'\n"
      expect(HAN.test(naiveStrip(src)), '夹具必须能骗过旧量具').toBe(false)
      expect(HAN.test(scanModelSource(src).code)).toBe(true)
    })

    it('模板正文里的双斜杠/斜杠+星号不是注释（正文含中文时仍然可见）', () => {
      const src = 'const u = `https://a.test/x`\nconst d = `点击`\n'
      const scan = scanModelSource(src)
      expect(HAN.test(scan.code)).toBe(true)
      expect(scan.offenders).toEqual([])
    })

    it('模板子表达式里的中文可见（`${…}` 之后回到正文，不会被当成代码吞掉）', () => {
      const src = 'const m = `count=${n} 点击`\n'
      expect(HAN.test(scanModelSource(src).code)).toBe(true)
    })

    it('正则字面量里的斜杠+星号不会开出幻影注释（会被 offender 格 fail-loud）', () => {
      const src = 'const re = /[/*]/u\nconst d = 点击\n'
      const scan = scanModelSource(src)
      expect(scan.counts.regexLiterals).toBe(1)
      expect(HAN.test(scan.code)).toBe(true)
      expect(scan.offenders.map((found) => found.line)).toEqual([1])
    })

    it('未闭合的块注释 fail-loud（不许静默把余下代码当注释）', () => {
      const scan = scanModelSource('const a = 1\n/* 没闭合 中文\nconst b = 2\n')
      expect(scan.unterminated?.line).toBe(2)
    })

    it('反向对照：英文 description + 中英文注释 ⇒ 全绿（不误伤注释与本地化面）', () => {
      const src = [
        '/** English docs */',
        '// 注释里的中文是允许的（模型看不到）',
        "const tool = { description: 'Click here' }",
      ].join('\n')
      const scan = scanModelSource(src)
      expect(HAN.test(scan.code)).toBe(false)
      expect(scan.offenders).toEqual([])
      expect(scan.unterminated).toBeNull()
    })
  })

  it('no localized ⋮ menu label leaks into the model copy', () => {
    // 2026-09-17 审计 S01-4：菜单文案是**按请求语言**渲染的（OVERLAY_COPY.zh/en
    // 的 menu* 值），而工具文案在 apply 期固定 —— 写死任一种语言的菜单项名，
    // 对另一种语言的用户就是一条指向不存在控件的指令（`browser_clear_data` 曾
    // 让模型转告用户点 "Clear browsing data"，而默认 UI 里写的是「清除数据…」）。
    // zh 方向已由上面的 CJK 守卫覆盖，这条钉住最容易被抄回来的英文标签。
    const shellSource = readFileSync(new URL('../src/shell-pages.ts', import.meta.url), 'utf8')
    const labels = [...shellSource.matchAll(/\n\s*menuClearData: '((?:[^'\\]|\\.)*)'/gu)].map((match) => match[1]!)
    // 夹具自检：两种语言各取到一条，否则下面的循环是空循环（假绿）。
    expect(labels).toHaveLength(2)
    // 注释不是模型可见文案（本包注释是中文）：用同一份注释感知扫描（SCAN）判。
    for (const label of labels) {
      // 结尾的省略号是菜单自身的排版（表示"打开面板"），不是文案的一部分。
      const text = label.replace(/[….]+$/u, '')
      expect(text.length, label).toBeGreaterThanOrEqual(4)
      expect(SCAN.code, `model copy must not name the localized menu entry ${label}`).not.toContain(text)
    }
  })
})

/* ------------------------------------------------------------------ *
 * Resolution: the real plugin routes, served twice by one plugin instance
 * ------------------------------------------------------------------ */

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/** A request as the shell/overlay webContents sends it (same-origin, loopback). */
function fakeReq(url: string, acceptLanguage?: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      ...(acceptLanguage === undefined ? {} : { 'accept-language': acceptLanguage }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { /* GET: no body */ },
  } as unknown as IncomingMessage
}

/** HTML response capture (the JSON helper in the other specs cannot read HTML). */
function fakeRes(): { res: ServerResponse, read: () => { code: number, body: string } } {
  let code = 0
  let body = ''
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => { body = chunk === undefined ? '' : chunk.toString() },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

let home: string
let routes: Route[]
/** Mutable probed runtime: the test flips `locale` between two requests. */
let runtimeProbe: { locale?: unknown } | undefined

function harness(withRuntime = true): void {
  routes = []
  runtimeProbe = withRuntime ? { locale: 'zh' } : undefined
  const ctx = {
    get: (name: string) => {
      if (name === 'picoSession') return { getSession: () => null }
      if (name === 'desktopRuntime') return runtimeProbe
      if (name === 'connection') return undefined
      return undefined
    },
    on: () => () => {},
    effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    webServer: {
      port: 3080,
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {})
}

async function get(path: string, acceptLanguage?: string): Promise<string> {
  const route = routes.find((r) => r.kind === 'exact' && r.path === path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  const out = fakeRes()
  await route.handler(fakeReq(path, acceptLanguage), out.res)
  const { code, body } = out.read()
  expect(code, path).toBe(200)
  return body
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pico-browser-i18n-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('the served pages follow the locale resolved per request', () => {
  it('the SAME plugin instance serves zh, then en, with no re-apply', async () => {
    harness()
    expect(await get('/browser-shell')).toContain('<html lang="zh-CN">')
    expect(await get('/browser-overlay')).toContain('id="ai-take">我来操作<')

    // The user switches the application language while the browser window is
    // open: only the probed runtime changes, the plugin is NOT re-applied.
    runtimeProbe!.locale = 'en'

    expect(await get('/browser-shell')).toContain('<html lang="en">')
    expect(await get('/browser-overlay')).toContain('id="ai-take">Take over<')
    // …and the flip is not one-way.
    runtimeProbe!.locale = 'zh'
    expect(await get('/browser-shell')).toContain('<html lang="zh-CN">')
  })

  it('the in-app runtime choice beats Accept-Language', async () => {
    harness()
    runtimeProbe!.locale = 'zh'
    expect(await get('/browser-shell', 'en-US,en;q=0.9')).toContain('<html lang="zh-CN">')
    runtimeProbe!.locale = 'en'
    expect(await get('/browser-shell', 'zh-CN,zh;q=0.9')).toContain('<html lang="en">')
  })

  it('the runtime service itself is probed per request (a late-composed launcher is picked up)', async () => {
    harness(false)
    // No launcher yet: the request header decides.
    expect(await get('/browser-shell', 'en-US,en;q=0.9')).toContain('<html lang="en">')
    // The launcher composes later; the same plugin instance must see it without
    // a re-apply, and the runtime value must now win over the header.
    runtimeProbe = { locale: 'en' }
    expect(await get('/browser-shell', 'zh-CN,zh;q=0.9')).toContain('<html lang="en">')
  })

  it('falls back to Accept-Language, then to the product default (zh)', async () => {
    harness(false)
    expect(await get('/browser-overlay', 'en-US,en;q=0.9')).toContain('<html lang="en">')
    expect(await get('/browser-overlay', 'en-US,en;q=0.9')).toContain('id="ai-take">Take over<')
    // No header at all: the product default (same as the client dictionaries).
    expect(await get('/browser-overlay')).toContain('<html lang="zh-CN">')
    // Unsupported languages never win over the default.
    expect(await get('/browser-overlay', 'ja,zh;q=0.8')).toContain('<html lang="zh-CN">')
  })
})

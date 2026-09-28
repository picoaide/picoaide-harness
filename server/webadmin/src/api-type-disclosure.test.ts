import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 第二十二轮复审 V2-B5（P3）：`request<T = any>` **未收口**，本轮采取的是"如实登记"
// 这一支（审计给的 A/B 二选一里的 B）。
//
// 这条用例是**登记锚**，不是类型安全判据：它只保证"缺省泛型仍是 `any`、且未收口"
// 这句声明**留在 `request` 声明正上方的那个注释块里** —— 否则一次"清理注释"就会让这条
// 认账凭空消失，而 89 处无泛型调用照旧（复审实测计数：`await request(` 89 处、
// `await request<` 38 处，与审计基线逐数相同）。**不要**把它读成"泛型问题已经收敛"。
//
// ## R23-V3-B9（复审 2026-09-27，P3）：为什么从"全文 toContain"改成**结构化锚**
//
// 修前的三条断言都是**全文件**文本包含（`expect(apiSource).toContain(…)`），实测两条
// 反例证明它骗得过：
//
//	M-c 把同一段登记文本**整体搬到文件末尾**（登记块已不在 `request` 上方）⇒ 2 passed；
//	M-d 在原处**追加一句语义相反的断言**（"泛型问题已收口"，原文本保留）⇒ 2 passed；
//	另：第 2 条断言里的 `toContain('unknown')` 是**空转** —— `Record<string, unknown>`
//	    在 api.ts 里已出现多次，该断言与登记块无关（真正起作用的只有 `/未做/`）。
//
// 现在改成**结构化**：
//
//	① 取 `request` 声明**正上方连续的注释块**（不是全文件），三条必需声明必须落在块内；
//	② 块内必须出现"收敛路径"的具体词（`unknown` + 编译证据 `typecheck`）—— 空转消掉；
//	③ 块内**不得**出现"已收口/已收敛/已修复"这类相反声明（M-d 形态 ⇒ 红）。
//
// 边界（诚实声明）：它仍然只是"注释文本的形状"，**不保证**注释与代码语义一致
// （真正的收敛判据是缺省泛型本身，见第 1 条断言）；也**不覆盖**把整段登记换成一份
// 说服力更弱但用词不同的说法（那种改动只能靠人评审）。**真正的收敛**（把缺省泛型改成
// `unknown`、逐个消费点补 `<T>`、分批给出 `npm run typecheck` 证据）一旦落地，
// 第 1 条断言会红 —— 那正是它的目的：**先改代码，再改这条锚**。
//
// 变异（必须变红，实跑对照见 temp/r21/fix-21/REPORT.md）：
//   - 缺省泛型改成 `unknown` ⇒ 第 1 条红（真回归）；
//   - 删掉登记注释块 ⇒ 第 2/3 条红；
//   - 把登记文本搬到文件末尾（`request` 上方不再有它）⇒ 红（修前绿）；
//   - 在块内追加"泛型问题已收口" ⇒ 第 3 条红（修前绿）。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const apiSource = readFileSync(resolve(here, 'api.ts'), 'utf8')

const REQUEST_DECL = 'export async function request<T = any>'

/**
 * 取 `marker` 所在行**正上方连续的 `//` 注释块**（逐行上溯，遇到非注释行即停），
 * 返回块内文本（去掉行首的 `//`）。
 *
 * 找不到 `marker`、或上方没有注释块时**抛错**：判据不许静默空转（那正是修前
 * `toContain('unknown')` 的毛病）。
 */
function commentBlockAbove(source: string, marker: string): string {
  const lines = source.split('\n')
  const at = lines.findIndex((l) => l.includes(marker))
  if (at < 0) {
    throw new Error(`判据失效：api.ts 里找不到 ${marker}（锚点被改名或删除）`)
  }
  const block: string[] = []
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.trimStart().startsWith('//')) break
    block.unshift(line.replace(/^\s*\/\/ ?/, ''))
  }
  if (block.length === 0) {
    throw new Error(`判据失效：${marker} 上方没有注释块（登记已消失）`)
  }
  return block.join('\n')
}

describe('api.ts 的缺省泛型现状登记（V2-B5 / R23-V3-B9）', () => {
  it('缺省泛型仍是 `any`（真回归判据：改成 unknown 即红）', () => {
    expect(apiSource).toContain(REQUEST_DECL)
  })

  it('三条必需声明落在 `request` 声明**正上方**的注释块里（不是文件任意位置）', () => {
    const block = commentBlockAbove(apiSource, REQUEST_DECL)
    expect(block).toContain('缺省泛型仍然是 `any`')
    expect(block).toContain('这一轮没有收敛它')
    expect(block).toContain('如实登记')
    // 对照：全文级弱断言（修前形态）—— 它骗得过"把注释搬走"，所以只作对照、不单独用。
    expect(apiSource).toContain('这一轮没有收敛它')
  })

  it('收敛路径写在同一块里（`unknown` + 编译证据），且不得出现"已收口"的相反声明', () => {
    const block = commentBlockAbove(apiSource, REQUEST_DECL)
    expect(block).toContain('unknown')
    expect(block).toContain('typecheck')
    expect(block).toMatch(/未做/)
    // "相反声明" = 一行断言问题已收口、且该行**没有**否定词（原登记里那句
    // 「任何『泛型问题已收口』的读法都不成立」含"不成立"，必须放行）。
    const claims = block
      .split('\n')
      .filter((l) => /已(经)?(收口|收敛|修复|解决)/.test(l))
      .filter((l) => !/(不成立|不得|不要|未|没有|并非|不代表)/.test(l))
    expect(claims, `登记块里出现了"已收口"式的相反声明：${claims.join(' / ')}`).toEqual([])
  })
})

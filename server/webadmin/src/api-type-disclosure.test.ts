import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 第二十二轮复审 V2-B5（P3）：`request<T = any>` **未收口**，本轮采取的是"如实登记"
// 这一支（审计给的 A/B 二选一里的 B）。
//
// 这条用例是**登记锚**，不是类型安全判据：它只保证"缺省泛型仍是 `any`、且未收口"
// 这句声明**留在源码里**——否则一次"清理注释"就会让这条认账凭空消失，而 89 处无泛型
// 调用照旧（复审实测计数：`await request(` 89 处、`await request<` 38 处，与审计基线
// 逐数相同）。**不要**把它读成"泛型问题已经收敛"。
//
// 真正的收敛路径（未做，属独立任务）：把缺省泛型改成 `unknown`，逐个消费点补 `<T>`
// 并分批给出 `npm run typecheck` 证据。
//
// 变异（必须变红）：删掉 `api.ts` 里那段登记注释。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const apiSource = readFileSync(resolve(here, 'api.ts'), 'utf8')

describe('api.ts 的缺省泛型现状登记（V2-B5）', () => {
  it('声明了"缺省泛型仍是 any、本轮未收口"', () => {
    expect(apiSource).toContain('export async function request<T = any>')
    expect(apiSource).toContain('缺省泛型仍然是 `any`')
    expect(apiSource).toContain('这一轮没有收敛它')
  })

  it('登记块同时写明了收敛路径（改成 unknown + 分批补类型 + 编译证据）', () => {
    expect(apiSource).toContain('unknown')
    expect(apiSource).toMatch(/未做/)
  })
})

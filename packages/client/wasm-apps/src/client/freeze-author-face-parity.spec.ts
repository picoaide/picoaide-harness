/**
 * 冻结行的**三面一致性**（2026-09-23 第六轮审计 R6-B-3 的收尾判据）。
 *
 * 这一条 finding 的形状不是"某处代码写错了"，而是**同一件事在三处给了三个答案**：
 *
 *   1. 服务端目录（`server/internal/wasmapp/api/read.go` 的 `catalog`）曾经对**所有人**
 *      跳过 `frozen_at` 非空的行 —— 而目录是客户端应用中心的**唯一**数据源，面板每次
 *      挂载、每次发布之后都会重拉；
 *   2. 客户端字典（`locales.ts` 的 `availabilityFrozenHint`）说"发布者本人在应用中心里
 *      就能解冻"，紧接着又说"如果列表里已经看不到这个应用，请联系平台管理员" ——
 *      前半句承诺一条路，后半句承认它不可达；
 *   3. 作者手册（`server/skills/app-builder/`）说"冻结是平台侧处置：**找管理员解冻**"。
 *
 * 定案语义（三面同一条，与"下架 = 作者仍可见（带标记）"同口径）：
 *   · **归属人本人**：冻结行仍列在他/她自己的目录里、带「已冻结」标记 ⇒ 应用中心里的
 *     「解冻」有依附面；
 *   · **其他人**：看不到冻结的应用（与"不存在"同形，不泄露存在性），要解冻找管理员。
 *
 * 本文件是**防再漂移的闸**：它同时读三面的**真实内容**（手册 markdown、客户端字典、
 * 服务端 Go 源码）并断言三者说的是同一件事。任一面单方面改口径 ⇒ 用例红。
 *
 * ---- 变异验证（每条都能单独点红） ----
 *   - 把 `read.go` 的冻结跳过条件改回 `if a.FrozenAt != nil || a.CurrentReleaseID <= 0`
 *     ⇒ 「目录条件仍带归属人例外」红；
 *   - 把 `read.go` 行里的 `"frozen"` 键删掉 ⇒ 同组红（客户端据此区分冻结与下架）；
 *   - 把 `availabilityFrozenHint` 改回"如果列表里已经看不到这个应用，请联系平台管理员"
 *     ⇒ 「客户端文案与手册同口径」红；
 *   - 把 `abi.md` 的 `APP_FROZEN` 行改回"冻结是平台侧处置：找管理员解冻"
 *     ⇒ 同组红（手册与客户端不再一致）；
 *   - 把 `SKILL.md` 四种状态表里冻结那一行的"发布者本人 / 其他员工"区分去掉
 *     ⇒ 「手册的四种状态表区分两类人」红。
 *
 * @module @picoaide/dsh-wasm-apps/client/freeze-author-face-parity
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, zh } from './locales.ts'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上走四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/** 三面的真实位置（缺席即失败：改名/搬走必须有人看一眼，不是 skip）。 */
const READ_GO = 'server/internal/wasmapp/api/read.go'
const ABI_MD = 'server/skills/app-builder/references/abi.md'
const SKILL_MD = 'server/skills/app-builder/SKILL.md'

function readRepoFile(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
}

/**
 * 取 markdown 表格里**第一列命中**的那一行（返回原文，便于断言）。
 *
 * 只认第一列（`| <第一格> |`）：同一份手册里别的行也会提到 `APP_FROZEN`
 * （例如 `FORBIDDEN` 那一行的"应用被冻结时看到的是 403 `APP_FROZEN`"），
 * 按"行里含这个词"去找会找到错的那一行、让判据看起来是绿的。
 */
function tableRowWithFirstCell(source: string, firstCell: string): string {
  const line = source.split('\n').find(row => row.trimStart().startsWith(`| ${firstCell}`))
  if (line === undefined) throw new Error(`找不到第一格是「${firstCell}」的表格行（手册被改写/搬走了？）`)
  return line
}

describe('冻结行三面一致：服务端目录 · 客户端文案 · 作者手册（R6-B-3）', () => {
  it('服务端的目录条件仍带"归属人例外"，且行里下发 frozen', () => {
    const go = readRepoFile(READ_GO)
    // 目录条件：冻结跳过必须**只在非归属人**时成立（`!ownedByViewer`）。
    const frozenSkip = go.split('\n').find(line => line.includes('a.FrozenAt != nil &&'))
    expect(frozenSkip, `${READ_GO} 里找不到冻结跳过条件（条件被改写/合并了？）`).toBeDefined()
    expect(frozenSkip, '冻结行必须对**归属人本人**保留（这条路径是「解冻」唯一的依附面）')
      .toContain('!ownedByViewer')
    expect(go, '归属判据必须是严格归属（不含超管兜底的 isOwner）：员工面不为管理员扩面')
      .toContain('ownedByViewer := a.Owner != "" && a.Owner == viewer.Username')
    // 行字段：`frozen` 必须是目录行的**无条件**字段（冻结顺带下架，只看 enabled 会
    // 把"冻结"显示成"已下架"，而两者的处置完全不同）。
    expect(go, `${READ_GO} 的目录行必须下发 "frozen"`).toContain('"frozen":')
  })

  it('客户端两条 frozen hint 给的是同一条可达路径（发布者 → 应用中心；其他人 → 管理员）', () => {
    for (const [label, hint] of [
      ['zh availabilityFrozenHint', zh['appCenter.availabilityFrozenHint']],
      ['zh openAppFrozenHint', zh['appCenter.openAppFrozenHint']],
    ] as const) {
      expect(hint, label).toContain('应用中心')
      expect(hint, label).toContain('管理员')
      // 旧文案的自相矛盾句：一边承诺发布者能解冻，一边说"列表里已经看不到"
      // （R6-B-3 的现场就是这个形状 —— 目录对所有人跳过冻结行）。
      expect(hint, label).not.toContain('如果列表里已经看不到')
    }
    for (const [label, hint] of [
      ['en availabilityFrozenHint', en['appCenter.availabilityFrozenHint']],
      ['en openAppFrozenHint', en['appCenter.openAppFrozenHint']],
    ] as const) {
      expect(hint, label).toContain('App Center')
      expect(hint, label).toContain('administrator')
    }
    // 发布者那一条必须说明"他/她自己一直能看到"（这是 R6-B-3 修好的事实）。
    expect(zh['appCenter.availabilityFrozenHint']).toContain('发布者本人')
  })

  it('作者手册的 APP_FROZEN 行与客户端说同一件事（不再只指向管理员）', () => {
    const abi = readRepoFile(ABI_MD)
    const row = tableRowWithFirstCell(abi, '`APP_FROZEN`')
    // 手册必须给出**发布者本人**在应用中心解冻这条路（客户端承诺的那一条）。
    expect(row, 'APP_FROZEN 行必须指明发布者本人的解冻入口').toMatch(/发布者本人|归属人/)
    expect(row, 'APP_FROZEN 行必须点名客户端应用中心').toContain('应用中心')
    // 其他人的出口仍是管理员（两类人不能混成一句）。
    expect(row, 'APP_FROZEN 行必须保留"其他成员找管理员"这条口径').toContain('管理员')
    // 旧口径（"冻结是平台侧处置：找管理员解冻"）不得复活。
    expect(row, 'APP_FROZEN 行不得退回"冻结是平台侧处置：找管理员解冻"').not.toContain('找管理员解冻，自己重试')
  })

  it('作者手册的四种状态表把冻结拆成"发布者本人 / 其他员工"两档', () => {
    const skill = readRepoFile(SKILL_MD)
    const row = tableRowWithFirstCell(skill, '应用**被冻结**')
    expect(row, '冻结那一行必须区分发布者本人').toMatch(/发布者本人|作者本人/)
    expect(row, '冻结那一行必须区分其他员工（他们看不到冻结的应用）').toMatch(/其他员工|其他成员/)
    expect(row, '发布者本人那一档必须说明"仍列在目录里"').toMatch(/仍列在目录|一直能看到/)
    // 排障口诀同理：不能再说"目录里真的不见了"当作所有人的答案。
    const hint = skill.split('\n').find(line => line.includes('排障口诀'))
    expect(hint, 'SKILL.md 里找不到排障口诀').toBeDefined()
    expect(hint, '排障口诀必须点明"非发布者"才看不到冻结的应用').toMatch(/非发布者|发布者自己/)
  })
})

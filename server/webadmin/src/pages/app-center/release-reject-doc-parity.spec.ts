/**
 * 「已通过审核的版本不可拒绝」这条 409 契约的**文档 ↔ 代码**对拍（R4-D-7①）。
 *
 * ## 背景
 *
 * 三个审核面（共享技能 / 组织智能体 / WASM 应用）共用同一个 `error.code`
 * （`serverstore.CodeReleaseNotRejectable = "APPROVED_NOT_REJECTABLE"`），但**提示文案有两套**：
 * 前两面用共享常量 `MsgReleaseNotRejectable + HintReleaseNotRejectable`（含关键事实
 * 「版本号永久占位，不能复用」），WASM 面自带一份字面量且**漏了那条事实**。
 *
 * 收敛 Go 侧文案属服务端泳道（`server/internal/**`）；本用例负责另外两件能立刻做的事：
 *
 *  1. **API 参考必须记载这条 409**（此前只写了 happy path，对接方只能从错误里发现）：
 *     §1 错误码表 + 三个 reject 行都必须出现该 code，且 code 字面量必须与 Go 常量
 *     **逐字一致**（改 Go 常量值而不同步文档 ⇒ 红）；
 *  2. WASM 面的文案分歧必须**登记在案**（`REGISTERED_HINT_DIVERGENCE`），登记的说明里
 *     必须点出它缺的那条事实。服务端收敛之后（改用共享常量）本用例自动不再要求登记。
 *
 * ## 变异验证
 *  - 删掉 §1 里那一行 `APPROVED_NOT_REJECTABLE` ⇒ 红；
 *  - 把 Go 的 `CodeReleaseNotRejectable` 改成别的字符串（文档不同步）⇒ 红；
 *  - 把 WASM 面改回自带字面量且从登记表里删掉 ⇒ 红；
 *  - 把共享 `HintReleaseNotRejectable` 里的「版本号永久占位」删掉（文档仍这么写）⇒ 红。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 定位服务端源码根（与 opens-contract-parity.spec.ts 同款：从 cwd 向上找标记）。 */
function findServerDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'internal', 'serverstore', 'apps.go'))) return dir
    if (existsSync(join(dir, 'server', 'internal', 'serverstore', 'apps.go'))) return join(dir, 'server')
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到服务端源码根（cwd=${process.cwd()}）：本用例读 Go 源码对拍，找不到真源必须红`)
}

const SERVER_DIR = findServerDir()
const APPS_GO_PATH = join(SERVER_DIR, 'internal', 'serverstore', 'apps.go')
const WASM_ADMIN_GO_PATH = join(SERVER_DIR, 'internal', 'wasmapp', 'api', 'admin.go')
const API_REFERENCE_PATH = join(SERVER_DIR, 'docs', '03-api-reference.md')

for (const file of [APPS_GO_PATH, WASM_ADMIN_GO_PATH, API_REFERENCE_PATH]) {
  if (!existsSync(file)) throw new Error(`对拍真源缺失：${file}（缺失是失败，不是跳过）`)
}

const APPS_GO = readFileSync(APPS_GO_PATH, 'utf8')
const WASM_ADMIN_GO = readFileSync(WASM_ADMIN_GO_PATH, 'utf8')
const API_REFERENCE = readFileSync(API_REFERENCE_PATH, 'utf8')

/**
 * 取 Go 字符串常量（`const NAME = "…" + "…"`，逐段拼接）。
 * @param src - Go 源码全文。
 * @param name - 常量名。
 * @returns 常量取值的完整字符串。
 */
function goStringConst(src: string, name: string): string {
  const start = src.indexOf(`${name} = `)
  if (start < 0) throw new Error(`Go 源码里找不到常量 ${name}（改名了？对拍真源必须更新）`)
  const line = src.slice(start, src.indexOf('\n', src.indexOf('"', start)))
  const parts = [...line.matchAll(/"([^"]*)"/gu)].map((m) => m[1]!)
  if (parts.length === 0) throw new Error(`Go 常量 ${name} 里解析不到字符串字面量`)
  return parts.join('')
}

const CODE = goStringConst(APPS_GO, 'CodeReleaseNotRejectable')
const MSG = goStringConst(APPS_GO, 'MsgReleaseNotRejectable')
const HINT = goStringConst(APPS_GO, 'HintReleaseNotRejectable')

/** 三个审核面的 reject 路径（文档里必须逐个标注 409 契约）。 */
const REJECT_PATHS = [
  '/api/server/admin/shared-skills/:name/:version/reject',
  '/api/server/admin/agent-presets/:name/:version/reject',
  '/api/server/admin/wasm-apps/:app_id/releases/:version/reject',
]

/**
 * **已登记的分歧**：某个审核面没有使用共享 hint（附缺哪条事实）。
 *
 * 当前只有 WASM 面。服务端改用共享常量后（判据见下面的 `usesSharedHint`）本表必须清空，
 * 但**不要求**服务端为了本用例改代码 —— 本表的作用是让"两套文案"这件事可见、可判定，
 * 而不是把它藏进注释。
 */
const REGISTERED_HINT_DIVERGENCE: Record<string, string> = {
  'server/internal/wasmapp/api/admin.go':
    'WASM 面自带字面量 `该版本已通过审核，不能审核拒绝` + 自带 hint，缺共享 hint 的关键事实「版本号永久占位，不能复用」；' +
    '收敛属服务端泳道（server/internal/**），登记在此以免"同一个 409 两种提示"被静默继承',
}

describe('409 APPROVED_NOT_REJECTABLE 的文档 ↔ 代码对拍（R4-D-7①）', () => {
  it('共享常量自证：code/msg/hint 都有内容，且 hint 含"版本号永久占位"这条关键事实', () => {
    expect(CODE).not.toBe('')
    expect(MSG).not.toBe('')
    expect(HINT, 'hint 必须点明"版本号永久占位，不能复用"（作者据此才知道要发新版本）').toContain('版本号永久占位')
    expect(HINT, 'hint 必须给出可逆替代动作').toContain('下架')
  })

  it('API 参考：§1 错误码表 + 三个 reject 行都记载了同一个 code（逐字等于 Go 常量）', () => {
    // §1 的错误码表里必须有这一行（含 code 本体与 409）。
    const tableRow = API_REFERENCE.split('\n').find((line) => line.includes(`\`${CODE}\``) && line.includes('| 409 |'))
    expect(tableRow, `03-api-reference.md §1 必须有一行 \`${CODE}\` + 409（对接方要能查到这条契约）`).toBeDefined()
    expect(tableRow, '§1 的说明必须点明"版本号永久占位、不能复用"这条事实').toContain('版本号永久占位')
    // 三个审核面的 reject 行都要标注 409 与 code（否则只有 happy path 被文档化）。
    for (const path of REJECT_PATHS) {
      const row = API_REFERENCE.split('\n').find((line) => line.includes(path))
      expect(row, `03-api-reference.md 里找不到 ${path} 这一行`).toBeDefined()
      expect(row, `${path} 必须标注 409 ${CODE}`).toContain(CODE)
    }
  })

  it('WASM 面的文案分歧已登记（收敛后本表可清空，登记缺失即红）', () => {
    const usesSharedHint = /serverstore\.HintReleaseNotRejectable/u.test(WASM_ADMIN_GO)
    if (usesSharedHint) {
      // 收敛完成：不再要求登记，但登记表里也不该留着陈旧条目。
      expect(
        Object.keys(REGISTERED_HINT_DIVERGENCE),
        'WASM 面已使用共享 hint ⇒ 登记表里的陈旧分歧必须删掉',
      ).toEqual([])
      return
    }
    const entry = REGISTERED_HINT_DIVERGENCE['server/internal/wasmapp/api/admin.go']
    expect(
      entry,
      'WASM 面没有使用共享 hint ⇒ 必须在 REGISTERED_HINT_DIVERGENCE 里登记（同一个 409 两套文案不能静默存在）',
    ).toBeDefined()
    expect(entry, '登记说明必须点出它缺的那条关键事实').toContain('版本号永久占位')
    // 同一个 code 是已收口的部分：WASM 面必须仍引用共享常量（只有文案是分歧）。
    expect(WASM_ADMIN_GO, 'WASM 面必须仍复用共享 error.code').toContain('serverstore.CodeReleaseNotRejectable')
  })
})

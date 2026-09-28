import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// F-03（审计 2026-09-26，P2）的**字段级跨端对拍**：`/api/server/admin/server-info`
// 的 `balance` / `audit` 两块健康面，Go 侧是唯一真源（sysinfo.go 的两个结构体），
// webadmin 侧必须逐个声明。
//
// 为什么需要"读对方源码"的判据（本仓登记过的假绿形态）：两端各钉自己的字面量时，
// 单边改名后两边都绿、运行时字段恒 `undefined`（界面上显示 `—`，与"服务端没这个
// 数据"同形）。这里直接读 Go 源的 json tag 与 TS 接口的键，**任何一侧改名即红**。
//
// 被对拍的三处 Go 结构体：
//   - `internal/serverauth/sysinfo.go` 的 `auditHealth` / `balanceHealth`；
//   - `internal/serverstore/balance_admission.go` 的 `BalanceAdmissionRejection`
//     （`balanceHealth.LastRejection` 的元素类型）；
//   - `internal/serverstore/audit.go` 的 `AuditFailureInfo`
//     （`auditHealth.LastFailure` 的元素类型）。
//
// 变异（必须变红）：把任一 Go json tag 改名，或删掉 TS 接口里的任一字段。

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '../../../') // server/webadmin/src/pages → server/
const pageSource = readFileSync(resolve(here, 'ServerInfo.tsx'), 'utf8')

/** 取 Go 结构体的 json tag（跳过 `json:"-"` 与内嵌无 tag 字段）。 */
function goJSONTags(file: string, structName: string): string[] {
  const src = readFileSync(resolve(serverRoot, file), 'utf8')
  const start = src.indexOf(`type ${structName} struct {`)
  if (start < 0) throw new Error(`在 ${file} 里找不到结构体 ${structName}（判据锚点漂移）`)
  // 括号配对切出结构体正文（字段类型里可能有 struct/interface 字面量）。
  let depth = 0
  let end = -1
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) throw new Error(`${structName} 结构体没闭合`)
  const body = src.slice(start, end)
  const tags: string[] = []
  for (const m of body.matchAll(/json:"([^"]+)"/g)) {
    const name = m[1].split(',')[0]
    if (name && name !== '-') tags.push(name)
  }
  if (tags.length === 0) throw new Error(`${structName} 一个 json tag 都没解析出来（判据失真）`)
  return tags
}

/** 断言某个 Go 侧字段名在 webadmin 页面里以属性键形态出现。 */
function expectTSDeclares(tag: string, where: string) {
  const re = new RegExp(`\\b${tag}\\s*\\??\\s*:`)
  expect(re.test(pageSource), `webadmin 的 ServerInfo.tsx 没有声明 Go 字段 ${tag}（${where}）`).toBe(true)
}

describe('server-info 健康面 · 两端字段对拍(F-03)', () => {
  it('auditHealth 的每个 json tag 都在 webadmin 里声明', () => {
    const tags = goJSONTags('internal/serverauth/sysinfo.go', 'auditHealth')
    expect(tags).toContain('chain_intact')
    expect(tags).toContain('chain_stale')
    expect(tags).toContain('chain_source')
    for (const tag of tags) expectTSDeclares(tag, 'auditHealth')
  })

  it('balanceHealth 的每个 json tag 都在 webadmin 里声明', () => {
    const tags = goJSONTags('internal/serverauth/sysinfo.go', 'balanceHealth')
    expect(tags).toContain('admission_rejections')
    for (const tag of tags) expectTSDeclares(tag, 'balanceHealth')
  })

  it('嵌套结构体（最近一条拒绝 / 最近一次写入失败）的字段也必须声明', () => {
    for (const tag of goJSONTags('internal/serverstore/balance_admission.go', 'BalanceAdmissionRejection')) {
      expectTSDeclares(tag, 'BalanceAdmissionRejection')
    }
    for (const tag of goJSONTags('internal/serverstore/audit.go', 'AuditFailureInfo')) {
      expectTSDeclares(tag, 'AuditFailureInfo')
    }
  })
})

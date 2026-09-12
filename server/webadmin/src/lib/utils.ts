import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 部门树选项(缩进层级):平铺 → "研发部"、"研发部 / 前端组"
export interface DeptOption {
  id: number
  label: string
}

export function deptTreeOptions(depts: { id: number; parent_id: number; name: string }[], parentId = 0, depth = 0): DeptOption[] {
  const out: DeptOption[] = []
  for (const d of depts) {
    if (d.parent_id !== parentId) continue
    const prefix = depth > 0 ? `${'　'.repeat(depth)}↳ ` : ''
    out.push({ id: d.id, label: `${prefix}${d.name}` })
    out.push(...deptTreeOptions(depts, d.id, depth + 1))
  }
  return out
}

// 部门及其全部后代 id(编辑部门时从上级候选里剔除,防把部门挂到自己的子树下)
export function deptSubtreeIds(depts: { id: number; parent_id: number }[], rootId: number): Set<number> {
  const out = new Set<number>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const d of depts) {
      if (out.has(d.parent_id) && !out.has(d.id)) {
        out.add(d.id)
        grew = true
      }
    }
  }
  return out
}

// 行稳定 id(替换 index key,防删除中间行时 DOM/焦点错位)。
//
// 审计 2026-09-12 P1-2:`crypto.randomUUID()` **只在安全上下文存在**
// (https / localhost)。webadmin 的文档化部署形态包含「裸二进制 + 纯 HTTP 内网
// 反代 / LAN IP 直连」——那里 `window.isSecureContext === false`、
// `typeof crypto.randomUUID === 'undefined'`,任何在**渲染期**调用它的页面
// (连接器页 `useState(emptyForm)` 首渲染即调 `uid()`)整页崩成白屏。
// 这里回落到 `Date.now()+Math.random()`:keyId 只需**单页会话内唯一**的 UI 稳定
// 键(不落库、不跨端、不是安全标识),不需要密码学随机性;模块级自增计数保证
// 同一毫秒内多次调用也不撞。
let uidSeq = 0

export function uid(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  uidSeq += 1
  return `uid-${Date.now().toString(36)}-${uidSeq.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

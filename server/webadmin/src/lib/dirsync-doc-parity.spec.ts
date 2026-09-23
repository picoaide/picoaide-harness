/**
 * R5-B-8 的**文档面**判据（2026-09-23，第五轮审计跨泳道尾巴）：官网「LDAP 自动同步」
 * 一节必须与服务端语义一致 —— 目录同步**只自动停用、永不自动启用**，重新启用一律由
 * 管理员显式执行。
 *
 * 为什么要有一条判据看着官网散文：这处文案原本写着「曾被停用回到目录自动重新启用」，
 * 而 R5-B-8 把同步改成单向（`server/internal/serverauth/dirsync.go`：跳过启用 +
 * 写 `directory_enable_skipped` / `directory_user_disabled` 两条审计）之后，官网这句
 * 就成了**对管理员撒谎**：照它操作会以为停用的账号会自己回来。本仓已有同因守卫
 * （`scripts/check-doc-claims.mjs` 就是因为"官网散文漂移没人会想到改"才建的），只是
 * 它今天只看 pin 与平台模块表这两类数字；这条语义漂移没有判据，于是补在这里。
 *
 * 为什么落在 webadmin 包：审计页 `ACTION_LABEL` 正是这两个新动作的展示面（同一次
 * 修复的两半），且本目录既有"跨产物对拍"先例（`Audit.test.tsx` 直接读服务端 Go 源码
 * 做双向对拍、`app-center/opens-contract-parity.spec.ts` 对拍前后端契约）—— 判据必须
 * 与它守的真源同仓可读，不许写成"人工记得改"。
 *
 * 判别力（变异验证：把官网那两行改回旧措辞 ⇒ 对应用例必红；把 dirsync.go 的两个
 * 审计字面量删掉 ⇒ 语义锚那条必红，提示"该来改文档了"）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 仓库根：从 cwd 向上找同时含官网文档与服务端 dirsync 真源的目录（不依赖 cwd）。 */
function findRepoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(join(dir, 'site', 'src', 'content', 'docs', 'admin.md'))
      && existsSync(join(dir, 'server', 'internal', 'serverauth', 'dirsync.go'))
    ) {
      return dir
    }
    dir = resolve(dir, '..')
  }
  return resolve(process.cwd(), '..')
}

const ROOT = findRepoRoot()
const DIRSYNC_GO = join(ROOT, 'server', 'internal', 'serverauth', 'dirsync.go')
const ADMIN_ZH = join(ROOT, 'site', 'src', 'content', 'docs', 'admin.md')
const ADMIN_EN = join(ROOT, 'site', 'src', 'content', 'docs', 'en', 'admin.md')

/**
 * 取含锚点词的那一行。锚点消失 ⇒ 直接失败（判据的扫描面缩水不许静默变绿 ——
 * 删掉整节、改标题、把文档搬走都必须红）。
 */
function anchorLine(file: string, anchor: string): string {
  expect(existsSync(file), `文档真源不可读：${file}`).toBe(true)
  const text = readFileSync(file, 'utf8')
  const line = text.split('\n').find(l => l.includes(anchor))
  expect(line, `${file} 里找不到「${anchor}」那一行（判据锚点消失，不许静默通过）`).toBeDefined()
  return line ?? ''
}

describe('R5-B-8：官网 LDAP 同步说明 = 「只自动停用、永不自动启用」', () => {
  it('服务端语义锚仍在（两个审计动作仍是源码字面量；语义变了就该来改这里与文档）', () => {
    const src = readFileSync(DIRSYNC_GO, 'utf8')
    expect(src).toContain('"directory_enable_skipped"')
    expect(src).toContain('"directory_user_disabled"')
  })

  it('中文页：不再声称"曾被停用回到目录自动重新启用"，并写明只自动停用 + 显式启用', () => {
    const line = anchorLine(ADMIN_ZH, 'LDAP 自动同步')
    // 旧措辞（R5-B-8 的现场）：必须消失。
    expect(line).not.toContain('曾被停用回到目录自动重新启用')
    // 新语义三要素：只自动停用 / 永不自动启用 / 重新启用由管理员显式执行。
    expect(line).toContain('只自动停用')
    expect(line).toContain('永不自动启用')
    expect(line).toContain('显式执行')
  })

  it('英文页同形（两处文案不许各说一套）', () => {
    const line = anchorLine(ADMIN_EN, 'LDAP auto-sync')
    expect(line).not.toContain('reappear when they return to the directory')
    expect(line).toContain('only ever auto-disables')
    expect(line).toContain('explicit admin action')
  })
})
